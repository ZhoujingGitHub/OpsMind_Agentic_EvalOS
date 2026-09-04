#!/usr/bin/env python3
"""Build one traceable OpsMind Twin controller release.

The release contains a fixed, reviewed file list. It records the exact Git
revision and hashes every payload file, so a deployed controller can identify
the source it came from without contacting Git or EvalOS.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile


TWIN_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = TWIN_ROOT.parents[1]
DEPLOY_ROOT = REPOSITORY_ROOT / ".deploy" / "twin-controller"
CONTRACT = "opsmind-twin-controller-release/1.0"
BASE_RELEASE_FILES = (
    "install-controller.sh",
    "opsmind_twinctl.py",
    "opsmind_eval_manager.py",
    "ssh_gateway.sh",
    "dns_responder.py",
    "dns_probe.py",
    "stack.manifest.json",
    "config/gnb.yaml",
    "config/ue.yaml",
)

HARNESS_RELEASE_FILES = (
    "opsmind_harness_labctl.py", "opsmind-harness-lab-topology",
    "opsmind-harness-ssh-shim", "opsmind-harness-mec-http.py",
    "harness-source-lineage.json",
)
RELEASE_FILES = BASE_RELEASE_FILES + HARNESS_RELEASE_FILES + ("harness_probes.py",)


def git(*arguments: str) -> str:
    return subprocess.check_output(
        ["git", *arguments], cwd=REPOSITORY_ROOT, text=True, encoding="utf-8"
    ).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", help="accepted/prod Twin tag for the first-registration recovery archive only")
    parser.add_argument("--adoption-ref", help="exact remote migration commit for byte-identical AH adoption")
    arguments = parser.parse_args(argv)
    if arguments.baseline_ref and arguments.adoption_ref:
        raise RuntimeError("choose only one recovery source")
    source_ref = "HEAD"
    release_files = RELEASE_FILES
    if arguments.adoption_ref:
        ref = arguments.adoption_ref
        if len(ref) != 40 or any(c not in "0123456789abcdef" for c in ref):
            raise RuntimeError("adoption requires an exact migration commit")
        source_ref = ref
        release_files = BASE_RELEASE_FILES + HARNESS_RELEASE_FILES
    if arguments.baseline_ref:
        tag = arguments.baseline_ref
        if not tag.startswith(("accepted-twin-controller-", "prod-twin-")) or any(word in tag for word in ("abandoned", "temporary")):
            raise RuntimeError("baseline archive requires a readable accepted/prod Twin tag")
        source_ref = "refs/tags/" + tag
        release_files = BASE_RELEASE_FILES
    source_revision = git("rev-parse", "--verify", source_ref + "^{commit}")
    if len(source_revision) != 40 or any(character not in "0123456789abcdef" for character in source_revision):
        raise RuntimeError("controller release requires a full Git revision")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("controller release refuses uncommitted tracked changes")
    if arguments.baseline_ref or arguments.adoption_ref:
        git("merge-base", "--is-ancestor", source_revision, "HEAD")
    if arguments.adoption_ref and not git("branch", "-r", "--contains", source_revision):
        raise RuntimeError("adoption source is not on a remote branch")

    commit_time = git("show", "-s", "--format=%ct", source_revision)
    commit_day = git("show", "-s", "--format=%cd", "--date=format:%Y%m%d", source_revision)

    DEPLOY_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="staging-", dir=DEPLOY_ROOT) as temporary:
        payload_root = Path(temporary) / "controller"
        payload_root.mkdir(parents=True)
        for relative in release_files:
            payload = subprocess.check_output(
                ["git", "show", f"{source_revision}:infra/twin/{relative}"], cwd=REPOSITORY_ROOT
            )
            target = payload_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload.replace(b"\r\n", b"\n"))

        component_manifest_digest = f"sha256:{sha256(payload_root / 'stack.manifest.json')}"

        inventory = [
            {
                "path": relative,
                "bytes": (payload_root / relative).stat().st_size,
                "sha256": sha256(payload_root / relative),
            }
            for relative in release_files
        ]
        inventory.sort(key=lambda item: item["path"])
        content_digest = f"sha256:{canonical_digest(inventory)}"
        release_id = f"twin-controller-{commit_day}-{content_digest[7:17]}"
        metadata = {
            "contract": CONTRACT,
            "release_id": release_id,
            "source_revision": source_revision,
            "content_digest": content_digest,
            "component_manifest_digest": component_manifest_digest,
            "built_from_commit_time": int(commit_time),
            "baseline_archive": arguments.baseline_ref is not None,
            "adoption_archive": arguments.adoption_ref is not None,
            "files": inventory,
        }
        (payload_root / "RELEASE.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
        )

        archive = DEPLOY_ROOT / f"{release_id}.tar.gz"
        with archive.open("wb") as raw_stream:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw_stream, mtime=int(commit_time)) as gzip_stream:
                with tarfile.open(fileobj=gzip_stream, mode="w") as bundle:
                    for path in sorted(payload_root.rglob("*")):
                        archive_name = Path("controller") / path.relative_to(payload_root)
                        information = bundle.gettarinfo(str(path), arcname=archive_name.as_posix())
                        information.uid = 0
                        information.gid = 0
                        information.uname = "root"
                        information.gname = "root"
                        information.mtime = int(commit_time)
                        if path.is_file():
                            with path.open("rb") as source_stream:
                                bundle.addfile(information, source_stream)
                        else:
                            bundle.addfile(information)

    result = {
        "status": "BUILT",
        **{key: metadata[key] for key in (
            "release_id", "source_revision", "content_digest", "component_manifest_digest"
        )},
        "archive": str(archive),
        "archive_sha256": sha256(archive),
        "bytes": archive.stat().st_size,
    }
    (DEPLOY_ROOT / "controller-release.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
