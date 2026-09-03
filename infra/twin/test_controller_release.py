from __future__ import annotations

from contextlib import redirect_stdout
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("install-controller.sh")
SOURCE = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]


class ControllerReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="twin-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.module = types.ModuleType("isolated_controller_installer")
        exec(compile(SOURCE, str(SCRIPT), "exec"), self.module.__dict__)
        m = self.module
        m.CONTROLLER_ROOT = self.root / "controller"
        m.RELEASES_ROOT = m.CONTROLLER_ROOT / "releases"
        m.CURRENT_LINK = m.CONTROLLER_ROOT / "current"
        m.PREVIOUS_LINK = m.CONTROLLER_ROOT / "previous"
        m.LOCK_FILE = self.root / "lab.lock"
        m.LEASE_FILE = self.root / "lease.json"
        m.BOOT_FILE = self.root / "boot_id"
        m.BOOT_FILE.write_text("test-boot")
        m.LIVE_FILES = {name: self.root / "live" / name for name in m.LIVE_FILES}
        self.lease = {"contract_version": "opsmind-physical-lab-lease/1.0", "status": "idle",
                      "owner_mode": None, "candidate_ref": None, "trial_id": None,
                      "runtime_trial_id": None, "lease_id": None, "expires_at": None,
                      "boot_id": "test-boot", "updated_at": "2026-09-03T10:00:00.000Z"}
        m.LEASE_FILE.write_text(json.dumps(self.lease))
        self.entry = self.root / "fixed-installer"
        self.entry.write_bytes(SCRIPT.read_bytes())
        self.old = self.make_archive("old")
        self.new = self.make_archive("new")
        self.third = self.make_archive("third")
        old_files, _ = m.read_archive(*self.old)
        for name, path in m.LIVE_FILES.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(old_files[name])
            path.chmod(0o750 if name.endswith((".py", ".sh")) else 0o640)
        self.original = {p: m.snapshot(p) for p in m.LIVE_FILES.values()}

    def make_archive(self, label, files=None, extra=None):
        m = self.module
        if files is None:
            files = {name: (label + "-" + name + "\n").encode() for name in m.PAYLOAD_FILES}
            inventory = sorted([{"path": name, "bytes": len(body), "sha256": m.digest(body)}
                                for name, body in files.items()], key=lambda item: item["path"])
            content = m.digest(m.canonical(inventory))
            release_id = "twin-controller-20260903-" + content[:10]
            metadata = {"contract": "opsmind-twin-controller-release/1.0", "release_id": release_id,
                        "source_revision": ("a" if label == "old" else "b") * 40,
                        "content_digest": "sha256:" + content,
                        "component_manifest_digest": "sha256:" + m.digest(files["stack.manifest.json"]),
                        "files": inventory}
            files["RELEASE.json"] = json.dumps(metadata).encode()
        else:
            release_id = json.loads(files["RELEASE.json"])["release_id"]
        archive = self.root / (label + ".tar.gz")
        with tarfile.open(archive, "w:gz") as bundle:
            for name, body in files.items():
                member = tarfile.TarInfo("controller/" + name)
                member.size = len(body)
                bundle.addfile(member, io.BytesIO(body))
            if extra:
                member = tarfile.TarInfo(extra[0])
                member.type = extra[1]
                member.linkname = "/outside"
                bundle.addfile(member, io.BytesIO())
        return str(archive), release_id, m.digest(archive.read_bytes())

    def adopt(self):
        self.module.install_release(*self.new, baseline=self.old)

    def assert_original(self):
        m = self.module
        self.assertEqual({p: m.snapshot(p) for p in m.LIVE_FILES.values()}, self.original)
        self.assertFalse(m.CURRENT_LINK.exists())
        self.assertFalse(m.PREVIOUS_LINK.exists())
        self.assertEqual(self.entry.read_bytes(), SCRIPT.read_bytes())
        self.assertEqual(json.loads(m.LEASE_FILE.read_text()), self.lease)

    def assert_version(self, current, previous):
        m = self.module
        self.assertEqual(m.release_target(m.CURRENT_LINK).name, current[1])
        self.assertEqual(m.release_target(m.PREVIOUS_LINK).name, previous[1])
        m.verify_live_files(m.CURRENT_LINK.resolve())
        self.assertTrue(all(path.is_symlink() for path in m.LIVE_FILES.values()))
        self.assertEqual(self.entry.read_bytes(), SCRIPT.read_bytes())
        self.assertEqual(json.loads(m.LEASE_FILE.read_text()), self.lease)

    def test_first_registration_requires_explicit_accepted_baseline(self):
        with self.assertRaisesRegex(ValueError, "explicit approved baseline"):
            self.module.install_release(*self.new)
        self.assert_original()

    def test_first_registration_preserves_exact_source_and_keeps_installer_fixed(self):
        with mock.patch.object(self.module, "fsync_directory", wraps=self.module.fsync_directory) as sync:
            self.adopt()
        sync.assert_any_call(self.module.CONTROLLER_ROOT.parent)
        sync.assert_any_call(self.module.CONTROLLER_ROOT)
        self.assert_version(self.new, self.old)
        metadata = json.loads((self.module.PREVIOUS_LINK / "RELEASE.json").read_text())
        self.assertEqual(metadata["source_revision"], "a" * 40)
        self.module.rollback_release()
        self.assert_version(self.old, self.new)

    def test_upgrade_and_repeated_rollback_keep_two_real_versions(self):
        self.adopt()
        self.module.install_release(*self.third)
        self.assert_version(self.third, self.new)
        self.module.rollback_release()
        self.assert_version(self.new, self.third)
        self.module.rollback_release()
        self.assert_version(self.third, self.new)

    def test_repeated_install_keeps_previous_and_refuses_baseline_option(self):
        self.adopt()
        self.module.install_release(*self.new)
        self.assert_version(self.new, self.old)
        with self.assertRaisesRegex(ValueError, "only allowed for first"):
            self.module.install_release(*self.new, baseline=self.old)

    def test_live_drift_cannot_be_labelled_as_the_accepted_baseline(self):
        next(iter(self.module.LIVE_FILES.values())).write_bytes(b"unapproved")
        with self.assertRaisesRegex(ValueError, "differs from approved baseline"):
            self.adopt()
        self.assertFalse(self.module.CONTROLLER_ROOT.exists())

    def test_bad_archive_is_rejected_before_lock_or_live_changes(self):
        with mock.patch.object(fcntl, "flock") as lock:
            with self.assertRaisesRegex(ValueError, "checksum"):
                self.module.install_release(self.new[0], self.new[1], "0" * 64, self.old)
            lock.assert_not_called()
        self.assert_original()

    def test_archive_rejects_paths_links_duplicates_and_unlisted_files(self):
        for name, kind in [("../outside", tarfile.REGTYPE),
                           ("controller/ssh_gateway.sh", tarfile.SYMTYPE),
                           ("controller/ssh_gateway.sh", tarfile.REGTYPE),
                           ("controller/unknown", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                archive = self.make_archive("unsafe", extra=(name, kind))
                with self.assertRaisesRegex(ValueError, "unsafe or duplicate"):
                    self.module.install_release(*archive, baseline=self.old)
                self.assert_original()

    def test_changed_payload_with_valid_outer_hash_is_rejected(self):
        files, _ = self.module.read_archive(*self.new)
        files["opsmind_twinctl.py"] = b"unapproved"
        bad = self.make_archive("bad-content", files)
        with self.assertRaisesRegex(ValueError, "file digest mismatch"):
            self.module.install_release(*bad, baseline=self.old)
        self.assert_original()

    def test_unpacking_uses_the_same_bytes_that_passed_checksum(self):
        m = self.module
        original = m.digest
        replaced = False
        def replace_after_checksum(payload):
            nonlocal replaced
            value = original(payload)
            if not replaced:
                replaced = True
                Path(self.new[0]).write_bytes(Path(self.third[0]).read_bytes())
            return value
        with mock.patch.object(m, "digest", side_effect=replace_after_checksum):
            _, metadata = m.read_archive(*self.new)
        self.assertEqual(metadata["release_id"], self.new[1])
        self.assert_original()

    def test_busy_stale_or_malformed_lease_is_rejected_without_repairing_it(self):
        for change in [{"status": "in_use"}, {"boot_id": "previous-boot"},
                       {"lease_id": "still-owned"}, {"contract_version": "wrong"},
                       {"updated_at": "bad"}, {"status": "quarantined"}]:
            with self.subTest(change=change):
                payload = json.dumps({**self.lease, **change})
                self.module.LEASE_FILE.write_text(payload)
                with self.assertRaises(ValueError):
                    self.adopt()
                self.assertEqual(self.module.LEASE_FILE.read_text(), payload)
                self.assertFalse(self.module.CURRENT_LINK.exists())

    def test_existing_core_lock_prevents_installation_race(self):
        with self.module.LOCK_FILE.open("a+") as owner:
            fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.adopt()
        self.assert_original()

    def test_first_entry_link_failure_restores_plain_files_and_modes(self):
        m = self.module
        original = m.atomic_replace
        failed = False
        entry = list(m.LIVE_FILES.values())[2]
        def interrupted(path, **kwargs):
            nonlocal failed
            original(path, **kwargs)
            if path == entry and not failed:
                failed = True
                raise OSError("injected link failure")
        with mock.patch.object(m, "atomic_replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected link failure"):
                self.adopt()
        self.assert_original()

    def test_cutover_failure_restores_initial_plain_installation(self):
        m = self.module
        original = m.atomic_replace
        failed = False
        def interrupted(path, **kwargs):
            nonlocal failed
            original(path, **kwargs)
            if path == m.CURRENT_LINK and Path(kwargs.get("target", ".")).name == self.new[1] and not failed:
                failed = True
                raise OSError("injected cutover failure")
        with mock.patch.object(m, "atomic_replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected cutover failure"):
                self.adopt()
        self.assert_original()

    def test_upgrade_failure_restores_both_version_pointers(self):
        self.adopt()
        m = self.module
        original = m.atomic_replace
        def interrupted(path, **kwargs):
            if path == m.CURRENT_LINK and Path(kwargs.get("target", ".")).name == self.third[1]:
                raise OSError("injected upgrade failure")
            return original(path, **kwargs)
        with mock.patch.object(m, "atomic_replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected upgrade failure"):
                m.install_release(*self.third)
        self.assert_version(self.new, self.old)

    def test_recovery_failure_is_explicit_and_preserves_original_cause(self):
        self.adopt()
        m = self.module
        original = m.atomic_replace
        failed = False
        def interrupted(path, **kwargs):
            nonlocal failed
            if path == m.CURRENT_LINK:
                if failed:
                    raise OSError("injected recovery failure")
                original(path, **kwargs)
                failed = True
                raise OSError("original cutover failure")
            return original(path, **kwargs)
        with mock.patch.object(m, "atomic_replace", side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, "recovery incomplete") as raised:
                m.install_release(*self.third)
        self.assertIn("original cutover failure", str(raised.exception.__cause__))
        self.assertEqual(self.entry.read_bytes(), SCRIPT.read_bytes())

    def test_failed_rollback_restores_both_version_pointers(self):
        self.adopt()
        m = self.module
        original = m.atomic_replace
        failed = False
        def interrupted(path, **kwargs):
            nonlocal failed
            original(path, **kwargs)
            if path == m.CURRENT_LINK and not failed:
                failed = True
                raise OSError("injected rollback failure")
        with mock.patch.object(m, "atomic_replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected rollback failure"):
                m.rollback_release()
        self.assert_version(self.new, self.old)

    def test_rollback_revalidates_previous_files(self):
        self.adopt()
        (self.module.PREVIOUS_LINK / "opsmind_twinctl.py").write_bytes(b"corrupt")
        before = os.readlink(self.module.CURRENT_LINK)
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.module.rollback_release()
        self.assertEqual(os.readlink(self.module.CURRENT_LINK), before)

    def test_rollback_pointer_cannot_escape_release_directory(self):
        self.adopt()
        self.module.atomic_replace(self.module.PREVIOUS_LINK, target=self.root)
        with self.assertRaisesRegex(ValueError, "outside releases"):
            self.module.rollback_release()

    def test_release_identity_collision_is_not_overwritten(self):
        self.adopt()
        files, metadata = self.module.read_archive(*self.new)
        metadata["source_revision"] = "c" * 40
        files["RELEASE.json"] = json.dumps(metadata).encode()
        conflicting = self.make_archive("collision", files)
        with self.assertRaisesRegex(ValueError, "immutable controller release"):
            self.module.install_release(*conflicting)
        self.assert_version(self.new, self.old)

    def test_interrupted_first_linking_can_resume_without_mixed_runtime_bytes(self):
        m = self.module
        original = m.atomic_replace
        def abrupt_exit(path, **kwargs):
            original(path, **kwargs)
            if path == next(iter(m.LIVE_FILES.values())):
                raise KeyboardInterrupt("simulated process death")
        with mock.patch.object(m, "atomic_replace", side_effect=abrupt_exit):
            with self.assertRaises(KeyboardInterrupt):
                self.adopt()
        m.verify_live_files(m.CURRENT_LINK.resolve())
        self.assertEqual(m.CURRENT_LINK.resolve().name, self.old[1])
        m.install_release(*self.new)
        self.assert_version(self.new, self.old)

    def test_interrupted_pointer_pair_is_not_claimed_as_rollback_ready(self):
        m = self.module
        original = m.atomic_replace
        def abrupt_exit(path, **kwargs):
            original(path, **kwargs)
            if path == m.PREVIOUS_LINK:
                raise KeyboardInterrupt("simulated process death")
        with mock.patch.object(m, "atomic_replace", side_effect=abrupt_exit):
            with self.assertRaises(KeyboardInterrupt):
                self.adopt()
        output = io.StringIO()
        with redirect_stdout(output):
            m.show_status(self.entry)
        self.assertFalse(json.loads(output.getvalue())["rollback_ready"])
        m.install_release(*self.new)
        self.assert_version(self.new, self.old)

    def test_status_is_readonly_and_reports_fixed_installer_hash(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.module.show_status(self.entry)
        value = json.loads(output.getvalue())
        self.assertIsNone(value["current"])
        self.assertFalse(value["rollback_ready"])
        self.assertEqual(value["installer_sha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest())
        self.assertFalse(self.module.CONTROLLER_ROOT.exists())

    def test_status_rejects_live_files_that_do_not_match_current(self):
        self.adopt()
        path = next(iter(self.module.LIVE_FILES.values()))
        path.unlink()
        path.write_bytes(b"unapproved")
        with self.assertRaisesRegex(ValueError, "differs from approved baseline"):
            self.module.show_status(self.entry)

    def test_command_interface_installs_and_rolls_back_only_inside_fixture(self):
        with mock.patch.object(self.module.os, "geteuid", return_value=0):
            with redirect_stdout(io.StringIO()) as output:
                self.module.main([str(self.entry), "install", *self.new, "--baseline", *self.old])
            self.assertTrue(json.loads(output.getvalue())["rollback_ready"])
            self.assert_version(self.new, self.old)
            with redirect_stdout(io.StringIO()):
                self.module.main([str(self.entry), "rollback"])
            self.assert_version(self.old, self.new)


class ControllerBuilderTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("test_builder", SCRIPT.with_name("build-controller-release.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_dirty_checkout_is_rejected(self):
        with mock.patch.object(self.module, "git", side_effect=["a" * 40, " M file"]):
            with self.assertRaisesRegex(RuntimeError, "uncommitted tracked"):
                self.module.main([])

    def test_old_work_branch_cannot_be_a_baseline_archive(self):
        for name in ["main", "codex/old-work", "prod-twin-temporary-recovery", "accepted-twin-controller-abandoned"]:
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError, "accepted/prod Twin tag"):
                    self.module.main(["--baseline-ref", name])

    def test_baseline_outside_candidate_ancestry_is_rejected_before_packaging(self):
        with mock.patch.object(self.module, "git", side_effect=[
            "a" * 40, "", subprocess.CalledProcessError(1, "git merge-base")
        ]), mock.patch.object(self.module.subprocess, "check_output") as read_source:
            with self.assertRaises(subprocess.CalledProcessError):
                self.module.main(["--baseline-ref", "accepted-twin-controller-test"])
            read_source.assert_not_called()

    def test_baseline_archive_reads_exact_accepted_commit_without_checkout(self):
        revision = "a" * 40
        def git(*args):
            if args[0] == "rev-parse":
                self.assertEqual(args[-1], "refs/tags/accepted-twin-controller-test^{commit}")
                return revision
            if args[0] in {"status", "merge-base"}:
                if args[0] == "merge-base":
                    self.assertEqual(args, ("merge-base", "--is-ancestor", revision, "HEAD"))
                return ""
            return "1788400800" if "--format=%ct" in args else "20260903"
        def source(command, **_):
            self.assertEqual(command[:2], ["git", "show"])
            self.assertTrue(command[2].startswith(revision + ":infra/twin/"))
            return ("accepted-" + command[2] + "\r\n").encode()
        with tempfile.TemporaryDirectory(prefix="twin-builder-test-") as directory:
            with (mock.patch.object(self.module, "DEPLOY_ROOT", Path(directory)),
                  mock.patch.object(self.module, "git", side_effect=git),
                  mock.patch.object(self.module.subprocess, "check_output", side_effect=source),
                  redirect_stdout(io.StringIO()) as output):
                self.assertEqual(self.module.main(["--baseline-ref", "accepted-twin-controller-test"]), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result["source_revision"], revision)
            with tarfile.open(result["archive"]) as archive:
                metadata = json.loads(archive.extractfile("controller/RELEASE.json").read())
                self.assertTrue(metadata["baseline_archive"])
                payload = archive.extractfile("controller/opsmind_twinctl.py").read()
                self.assertNotIn(b"\r\n", payload)
                self.assertTrue(payload.startswith(b"accepted-"))


if __name__ == "__main__":
    unittest.main()
