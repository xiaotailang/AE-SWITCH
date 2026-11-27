"""Focused tests for safe cleanup of current, isolated Windows fixtures."""
import os
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import owned_python_fixture as fixtures


PURPOSE = "local-synthetic-cli-fixtures"


@unittest.skipUnless(os.name == "nt" and fixtures.WORKSPACE.drive.lower() == "g:",
                     "requires the Windows G: acceptance workspace")
class OwnedFixtureCleanupTests(unittest.TestCase):
    def make_fixture(self):
        root, owner_id = fixtures.create_owned_fixture(fixtures.WORKSPACE, PURPOSE)
        def ensure_cleanup():
            if root.exists():
                fixtures.cleanup_owned_fixture(root, owner_id, PURPOSE)
        self.addCleanup(ensure_cleanup)
        return root, owner_id

    def test_removes_read_only_ordinary_single_link_file(self):
        root, owner = self.make_fixture()
        directory = root / ".git" / "objects"
        directory.mkdir(parents=True)
        read_only = directory / "owned.pack"
        read_only.write_bytes(b"current synthetic fixture")
        os.chmod(read_only, stat.S_IREAD)
        self.assertTrue(read_only.stat().st_file_attributes & stat.FILE_ATTRIBUTE_READONLY)

        fixtures.cleanup_owned_fixture(root, owner, PURPOSE)

        self.assertFalse(root.exists())

    def test_refuses_hard_link_and_preserves_external_file(self):
        outside, _ = self.make_fixture()
        root, owner = self.make_fixture()
        target = outside / "external.bin"
        target.write_bytes(b"separately owned synthetic fixture")
        os.chmod(target, stat.S_IREAD)
        link = root / "fixture-link.bin"
        os.link(target, link)
        def unlink_owned_link():
            # NTFS requires making the shared synthetic file writable to remove
            # the test-created link. Production cleanup never does this.
            os.chmod(target, stat.S_IWRITE)
            link.unlink()
        self.addCleanup(unlink_owned_link)

        with self.assertRaisesRegex(ValueError, "fixture_path_not_ordinary"):
            fixtures.cleanup_owned_fixture(root, owner, PURPOSE)
        self.assertEqual(target.read_bytes(), b"separately owned synthetic fixture")
        self.assertTrue(target.stat().st_file_attributes & stat.FILE_ATTRIBUTE_READONLY)
        self.assertTrue(link.exists())

    def test_refuses_symbolic_link_without_touching_target(self):
        outside, _ = self.make_fixture()
        root, owner = self.make_fixture()
        target = outside / "external.bin"
        target.write_bytes(b"separately owned synthetic fixture")
        link = root / "fixture-link.bin"
        try:
            link.symlink_to(target)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows symbolic-link privilege is unavailable")
            raise
        self.addCleanup(link.unlink)

        with self.assertRaisesRegex(ValueError, "fixture_path_not_ordinary"):
            fixtures.cleanup_owned_fixture(root, owner, PURPOSE)
        self.assertEqual(target.read_bytes(), b"separately owned synthetic fixture")
        self.assertTrue(link.is_symlink())

    def test_refuses_directory_junction_without_touching_target(self):
        outside, _ = self.make_fixture()
        root, owner = self.make_fixture()
        target = outside / "external.bin"
        target.write_bytes(b"separately owned synthetic fixture")
        link = root / "reparse-point"
        env = {**os.environ, "AE_FIXTURE_TEST_LINK": str(link),
               "AE_FIXTURE_TEST_LINK_TARGET": str(outside),
               "PSModuleAnalysisCachePath": str(root / "ps-analysis")}
        shell = fixtures.WORKSPACE / ".tools/pwsh/pwsh.exe"
        self.assertTrue(shell.is_file())
        subprocess.run(
            [str(shell), "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference='Stop'; $null = New-Item -ItemType Junction "
             "-Path $env:AE_FIXTURE_TEST_LINK -Target $env:AE_FIXTURE_TEST_LINK_TARGET"],
            check=True, capture_output=True, env=env, cwd=root, timeout=15,
        )
        self.addCleanup(link.rmdir)

        with self.assertRaisesRegex(ValueError, "fixture_path_not_ordinary"):
            fixtures.cleanup_owned_fixture(root, owner, PURPOSE)
        self.assertEqual(target.read_bytes(), b"separately owned synthetic fixture")
        self.assertTrue(link.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)

    def test_rejects_unregistered_owner_and_wrong_marker(self):
        root, owner = self.make_fixture()
        read_only = root / "pack.bin"
        read_only.write_bytes(b"current synthetic fixture")
        os.chmod(read_only, stat.S_IREAD)
        with patch.object(fixtures, "_owned", {}):
            with self.assertRaisesRegex(ValueError, "fixture_owner_mismatch"):
                fixtures.cleanup_owned_fixture(root, owner, PURPOSE)
        marker = root / "owner.json"
        original = marker.read_bytes()
        marker.write_bytes(original + b"\n")
        self.addCleanup(marker.write_bytes, original)

        with self.assertRaisesRegex(ValueError, "fixture_owner_marker_changed"):
            fixtures.cleanup_owned_fixture(root, owner, PURPOSE)
        self.assertTrue(read_only.stat().st_file_attributes & stat.FILE_ATTRIBUTE_READONLY)


if __name__ == "__main__":
    unittest.main()
