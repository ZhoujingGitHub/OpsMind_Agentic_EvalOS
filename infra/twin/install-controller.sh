#!/usr/bin/env bash
set -euo pipefail
# Fixed installer entry: never execute the installer from a rollback payload.
exec python3 - "$0" "$@" <<'PY'
from __future__ import annotations

import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import tempfile

CONTROLLER_ROOT = Path("/opt/opsmind-twin-controller")
CURRENT_LINK = CONTROLLER_ROOT / "current"
PREVIOUS_LINK = CONTROLLER_ROOT / "previous"
RELEASES_ROOT = CONTROLLER_ROOT / "releases"
LEASE_FILE = Path("/srv/opsmind-twin/physical-lease.json")
BOOT_FILE = Path("/proc/sys/kernel/random/boot_id")
LOCK_FILE = Path("/run/lock/opsmind-twin.lock")
LIVE_FILES = {
    "opsmind_twinctl.py": Path("/usr/local/sbin/opsmind-twinctl"),
    "opsmind_eval_manager.py": Path("/usr/local/sbin/opsmind-eval-manager"),
    "ssh_gateway.sh": Path("/usr/local/sbin/opsmind-twin-ssh-gateway"),
    "dns_responder.py": Path("/usr/local/libexec/opsmind-twin-dns.py"),
    "dns_probe.py": Path("/usr/local/libexec/opsmind-twin-dns-probe.py"),
    "stack.manifest.json": Path("/etc/opsmind-twin/stack.manifest.json"),
    "config/gnb.yaml": Path("/srv/opsmind-twin/config/baseline/gnb.yaml"),
    "config/ue.yaml": Path("/srv/opsmind-twin/config/baseline/ue.yaml"),
}
LEGACY_PAYLOAD_FILES = set(LIVE_FILES) | {"install-controller.sh"}
LIVE_FILES.update({
    "opsmind_harness_labctl.py": Path("/usr/local/sbin/opsmind-harness-labctl"),
    "opsmind-harness-lab-topology": Path("/usr/local/sbin/opsmind-harness-lab-topology"),
    "opsmind-harness-ssh-shim": Path("/usr/local/sbin/opsmind-harness-ssh-shim"),
    "opsmind-harness-mec-http.py": Path("/usr/local/libexec/opsmind-harness-mec-http.py"),
})
ADOPTION_PAYLOAD_FILES = set(LIVE_FILES) | {"install-controller.sh", "harness-source-lineage.json"}
PAYLOAD_FILES = ADOPTION_PAYLOAD_FILES | {"harness_probes.py"}


def payload_names(metadata):
    inventory = metadata.get("files")
    if not isinstance(inventory, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in inventory):
        raise ValueError("controller release inventory mismatch")
    names = {item.get("path") for item in inventory}
    if len(inventory) != len(names) or names not in (LEGACY_PAYLOAD_FILES, ADOPTION_PAYLOAD_FILES, PAYLOAD_FILES):
        raise ValueError("controller release inventory mismatch")
    return names

RELEASE_ID = re.compile(r"twin-controller-[0-9]{8}-[a-f0-9]{10}")
SHA256 = re.compile(r"[a-f0-9]{64}")


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def validate_payload(files, expected_id):
    metadata = json.loads(files["RELEASE.json"])
    names = payload_names(metadata)
    if not RELEASE_ID.fullmatch(expected_id) or set(files) != names | {"RELEASE.json"}:
        raise ValueError("controller release file list or id mismatch")
    if metadata.get("contract") != "opsmind-twin-controller-release/1.0" or metadata.get("release_id") != expected_id:
        raise ValueError("controller release contract or identity mismatch")
    if not re.fullmatch(r"[a-f0-9]{40}", str(metadata.get("source_revision", ""))):
        raise ValueError("invalid controller source revision")
    inventory = metadata["files"]
    for item in inventory:
        payload = files[item["path"]]
        if digest(payload) != item.get("sha256") or len(payload) != item.get("bytes"):
            raise ValueError("controller release file digest mismatch: " + item["path"])
    content_hash = digest(canonical(inventory))
    if metadata.get("content_digest") != "sha256:" + content_hash or not expected_id.endswith(content_hash[:10]):
        raise ValueError("controller release content digest mismatch")
    if metadata.get("component_manifest_digest") != "sha256:" + digest(files["stack.manifest.json"]):
        raise ValueError("controller component manifest digest mismatch")
    return metadata


def read_archive(archive, expected_id, expected_hash):
    archive = Path(archive)
    if not SHA256.fullmatch(expected_hash):
        raise ValueError("invalid archive checksum")
    with archive.open("rb") as stream:
        payload = stream.read(32 * 1024 * 1024 + 1)
    if len(payload) > 32 * 1024 * 1024:
        raise ValueError("invalid archive checksum or size")
    if digest(payload) != expected_hash:
        raise ValueError("release archive checksum mismatch")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as bundle:
        for member in bundle:
            if member.isdir() and member.name.rstrip("/") in {"controller", "controller/config"}:
                continue
            name = member.name.removeprefix("controller/")
            if (member.name != "controller/" + name or name not in PAYLOAD_FILES | {"RELEASE.json"}
                    or not member.isfile() or member.size > 8 * 1024 * 1024 or name in files):
                raise ValueError("unsafe or duplicate controller archive member")
            files[name] = bundle.extractfile(member).read()
    return files, validate_payload(files, expected_id)


def release_files(root):
    files = {}
    metadata_path = root / "RELEASE.json"
    if metadata_path.is_symlink() or not metadata_path.is_file():
        raise ValueError("controller release metadata missing or linked")
    names = payload_names(json.loads(metadata_path.read_bytes()))
    for name in names | {"RELEASE.json"}:
        file = root / name
        if file.is_symlink() or not file.is_file():
            raise ValueError("controller release file missing or linked: " + name)
        files[name] = file.read_bytes()
    return files


def release_target(link):
    if not link.is_symlink():
        if link.exists():
            raise ValueError("controller version pointer is not a link")
        return None
    target = link.resolve(strict=True)
    if target.parent != RELEASES_ROOT.resolve() or not RELEASE_ID.fullmatch(target.name):
        raise ValueError("controller version pointer is outside releases")
    validate_payload(release_files(target), target.name)
    return target


def fsync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_replace(path, *, target=None, payload=None, mode=0o640):
    descriptor, temporary = tempfile.mkstemp(prefix=".controller-", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            if payload is not None:
                stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if target is not None:
            temporary.unlink()
            temporary.symlink_to(target)
        else:
            temporary.chmod(mode)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def preserve_release(files, metadata):
    RELEASES_ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    fsync_directory(CONTROLLER_ROOT.parent)
    fsync_directory(CONTROLLER_ROOT)
    target = RELEASES_ROOT / metadata["release_id"]
    if target.exists():
        existing = release_files(target)
        validate_payload(existing, target.name)
        if existing != files:
            raise ValueError("immutable controller release already exists with different content")
        return target
    with tempfile.TemporaryDirectory(prefix="staging-", dir=CONTROLLER_ROOT) as temporary:
        staging = Path(temporary)
        staging.chmod(0o755)
        for name, payload in files.items():
            file = staging / name
            file.parent.mkdir(parents=True, exist_ok=True)
            mode = 0o755 if name in {"install-controller.sh", "ssh_gateway.sh",
                                     "opsmind-harness-ssh-shim"} else 0o750 if (
                name.endswith(".py") or name == "opsmind-harness-lab-topology") else 0o640
            atomic_replace(file, payload=payload, mode=mode)
        os.replace(staging, target)
        fsync_directory(RELEASES_ROOT)
        fsync_directory(CONTROLLER_ROOT)
    return target


@contextmanager
def idle_lab_lock():
    # Share the core's existing lock; do not create another lease or supervisor.
    with LOCK_FILE.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        lease = json.loads(LEASE_FILE.read_text())
        required = {"contract_version", "status", "owner_mode", "candidate_ref", "trial_id",
                    "runtime_trial_id", "lease_id", "expires_at", "boot_id", "updated_at"}
        if not isinstance(lease, dict) or set(lease) != required or lease.get("contract_version") != "opsmind-physical-lab-lease/1.0":
            raise ValueError("physical lab lease is invalid; recover explicitly before upgrading")
        boot = BOOT_FILE.read_text().strip()
        updated = lease.get("updated_at")
        if not isinstance(updated, str) or not updated.endswith("Z"):
            raise ValueError("physical lab lease timestamp is invalid")
        dt.datetime.fromisoformat(updated[:-1] + "+00:00")
        owners = ("owner_mode", "candidate_ref", "trial_id", "runtime_trial_id", "lease_id", "expires_at")
        if not boot or lease.get("boot_id") != boot or lease.get("status") != "idle" or any(lease.get(key) is not None for key in owners):
            raise ValueError("physical lab is busy or has a stale boot identity; version was not changed")
        yield


def verify_live_files(release):
    names = payload_names(json.loads((release / "RELEASE.json").read_bytes()))
    for name, path in LIVE_FILES.items():
        if name not in names:
            continue
        if not path.is_file() or digest(path.read_bytes()) != digest((release / name).read_bytes()):
            raise ValueError("installed controller differs from approved baseline: " + name)


def snapshot(path):
    if path.is_symlink():
        return ("link", os.readlink(path), None)
    if path.is_file():
        return ("file", path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
    if path.exists():
        raise ValueError("unexpected directory at controller entry")
    return ("absent", None, None)


def switch_release(target, old_current):
    # Bind the reviewed entries to one immutable release, then switch current.
    paths = [CURRENT_LINK, *LIVE_FILES.values(), PREVIOUS_LINK]
    before = {path: snapshot(path) for path in paths}
    try:
        if not CURRENT_LINK.is_symlink():
            atomic_replace(CURRENT_LINK, target=old_current)
        target_names = payload_names(json.loads((target / "RELEASE.json").read_bytes()))
        for name, path in LIVE_FILES.items():
            if name not in target_names:
                continue
            expected = CURRENT_LINK / name
            if not path.is_symlink() or Path(os.readlink(path)) != expected:
                atomic_replace(path, target=expected)
        if target != old_current:
            atomic_replace(PREVIOUS_LINK, target=old_current)
            atomic_replace(CURRENT_LINK, target=target)
        verify_live_files(target)
    except Exception as original:
        restore_paths(before, original)
        raise


def restore_paths(before, original):
    failed = []
    for path, (kind, value, mode) in before.items():
        try:
            if snapshot(path) == (kind, value, mode):
                continue
            if kind == "absent":
                path.unlink(missing_ok=True)
                fsync_directory(path.parent)
            elif kind == "link":
                atomic_replace(path, target=Path(value))
            else:
                atomic_replace(path, payload=value, mode=mode)
        except Exception:
            failed.append(str(path))
    if failed:
        raise RuntimeError("controller recovery incomplete; manual attention required: " + ", ".join(failed)) from original



def adopt_harness_release(current, adoption_payload):
    files, metadata = adoption_payload
    if payload_names(metadata) != ADOPTION_PAYLOAD_FILES:
        raise ValueError("adoption requires the complete unchanged harness inventory")
    current_files = release_files(current)
    current_names = payload_names(json.loads(current_files["RELEASE.json"]))
    if current_names != LEGACY_PAYLOAD_FILES and current_files != files:
        raise ValueError("harness adoption requires legacy files or the same interrupted adoption")
    # Verify all base and formerly unmanaged AH bytes before adopting their identity.
    for name, path in LIVE_FILES.items():
        if not path.is_file() or digest(path.read_bytes()) != digest(files[name]):
            raise ValueError("adoption differs from installed component: " + name)
    adopted = preserve_release(files, metadata)
    pointers = {p: snapshot(p) for p in (CURRENT_LINK, PREVIOUS_LINK)}
    try:
        atomic_replace(CURRENT_LINK, target=adopted)
        atomic_replace(PREVIOUS_LINK, target=adopted)
    except Exception as original:
        restore_paths(pointers, original)
        raise
    return adopted


def install_release(archive, release_id, archive_hash, baseline=None, adoption=None):
    files, metadata = read_archive(archive, release_id, archive_hash)
    baseline_payload = read_archive(*baseline) if baseline else None
    adoption_payload = read_archive(*adoption) if adoption else None
    if payload_names(metadata) != PAYLOAD_FILES:
        raise ValueError("new installation requires the full current controller inventory")
    with idle_lab_lock():
        current = release_target(CURRENT_LINK)
        previous = release_target(PREVIOUS_LINK)
        if current is None:
            if previous is not None or baseline_payload is None:
                raise ValueError("first registration requires an explicit approved baseline archive")
            baseline_files, baseline_metadata = baseline_payload
            baseline_names = payload_names(baseline_metadata)
            if baseline_names == LEGACY_PAYLOAD_FILES and adoption_payload is None:
                raise ValueError("legacy installation requires explicit harness adoption")
            for name, path in LIVE_FILES.items():
                if name not in baseline_names:
                    continue
                if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != digest(baseline_files[name]):
                    raise ValueError("installed controller differs from approved baseline: " + name)
            current = preserve_release(baseline_files, baseline_metadata)
        elif baseline is not None:
            raise ValueError("baseline option is only allowed for first registration")
        verify_live_files(current)
        if adoption_payload:
            current = adopt_harness_release(current, adoption_payload)
        elif payload_names(json.loads((current / "RELEASE.json").read_bytes())) == LEGACY_PAYLOAD_FILES:
            raise ValueError("legacy installation requires explicit harness adoption")
        target = preserve_release(files, metadata)
        switch_release(target, current)


def rollback_release():
    with idle_lab_lock():
        current = release_target(CURRENT_LINK)
        previous = release_target(PREVIOUS_LINK)
        if current is None or previous is None or current == previous:
            raise ValueError("two distinct verified controller versions are required")
        verify_live_files(current)
        if any(payload_names(json.loads((release / "RELEASE.json").read_bytes())) == LEGACY_PAYLOAD_FILES
               for release in (current, previous)):
            raise ValueError("rollback requires complete harness ownership in both versions")
        switch_release(previous, current)


def show_status(entry):
    result = {}
    complete_versions = True
    for name, link in (("current", CURRENT_LINK), ("previous", PREVIOUS_LINK)):
        target = release_target(link)
        if name == "current" and target:
            verify_live_files(target)
        metadata = json.loads((target / "RELEASE.json").read_text()) if target else None
        if metadata and payload_names(metadata) == LEGACY_PAYLOAD_FILES:
            complete_versions = False
        result[name] = ({key: metadata[key] for key in ("release_id", "source_revision", "content_digest", "component_manifest_digest")} if metadata else None)
    result["rollback_ready"] = bool(complete_versions and result["current"] and result["previous"]
                                    and result["current"] != result["previous"])
    result["installer_sha256"] = digest(entry.read_bytes())
    print(json.dumps(result, separators=(",", ":")))


def main(argv):
    if os.geteuid() != 0:
        raise PermissionError("controller version management must run as root")
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    commands.add_parser("rollback")
    install = commands.add_parser("install")
    install.add_argument("archive")
    install.add_argument("release_id")
    install.add_argument("archive_hash")
    install.add_argument("--baseline", nargs=3, metavar=("ARCHIVE", "RELEASE_ID", "SHA256"))
    install.add_argument("--adopt-harness", nargs=3, metavar=("ARCHIVE", "RELEASE_ID", "SHA256"))
    args = parser.parse_args(argv[1:])
    if args.command == "install":
        install_release(args.archive, args.release_id, args.archive_hash, args.baseline, args.adopt_harness)
    elif args.command == "rollback":
        rollback_release()
    show_status(Path(argv[0]))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        print("OPSMIND_TWIN_CONTROLLER_ERROR: " + str(error), file=sys.stderr)
        raise SystemExit(2)
PY
