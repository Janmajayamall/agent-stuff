"""Source identity checks using disposable local Git repositories."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from agentloop.workspace import fingerprint, save_snapshot


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-loop-workspace-test-")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.runs = self.workspace / ".agent-loop" / "runs"
        self.git("init", "-q")
        self.git("config", "user.name", "Agent Loop Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.source = self.workspace / "source.txt"
        self.source.write_text("baseline\n")
        self.git("add", "source.txt")
        self.git("commit", "-qm", "baseline")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.workspace, check=True, capture_output=True, text=True).stdout

    def digest(self):
        return fingerprint(self.workspace, self.runs)["sha256"]

    def test_unstaged_and_staged_state_are_distinct(self):
        baseline = self.digest()
        self.source.write_text("changed\n")
        unstaged = self.digest()
        self.assertNotEqual(baseline, unstaged)
        self.git("add", "source.txt")
        staged = self.digest()
        self.assertNotEqual(unstaged, staged)
        self.source.write_text("second change\n")
        self.assertNotEqual(staged, self.digest())

    def test_untracked_bytes_executable_bits_and_symlink_targets_change_identity(self):
        extra = self.workspace / "extra.txt"
        baseline = self.digest()
        extra.write_text("one\n")
        first = self.digest()
        self.assertNotEqual(baseline, first)
        extra.write_text("two\n")
        second = self.digest()
        self.assertNotEqual(first, second)
        extra.chmod(0o755)
        executable = self.digest()
        self.assertNotEqual(second, executable)
        link = self.workspace / "link"
        link.symlink_to("source.txt")
        first_link = self.digest()
        self.assertNotEqual(executable, first_link)
        link.unlink()
        link.symlink_to("extra.txt")
        self.assertNotEqual(first_link, self.digest())

    def test_snapshot_preserves_staged_unstaged_and_untracked_user_work(self):
        self.source.write_text("staged content\n")
        self.git("add", "source.txt")
        self.source.write_text("unstaged content\n")
        extra = self.workspace / "user.bin"
        extra.write_bytes(b"\x00\xfforiginal user bytes")
        before = self.digest()
        snapshot = self.runs / "fixture" / "snapshot"
        manifest = save_snapshot(self.workspace, self.runs, snapshot)
        self.assertEqual(manifest["sha256"], before)
        self.assertEqual(self.digest(), before)
        self.assertEqual(self.source.read_text(), "unstaged content\n")
        self.assertEqual((snapshot / "untracked" / "user.bin").read_bytes(), extra.read_bytes())
        self.assertIn(b"staged content", (snapshot / "staged.patch").read_bytes())
        self.assertIn(b"unstaged content", (snapshot / "unstaged.patch").read_bytes())

    def test_gitlink_is_rejected_instead_of_using_coarse_dirty_status(self):
        # A gitlink fixture requires no clone, fetch, or network. Its object ID
        # can point at any commit already present in this disposable repository.
        commit = self.git("rev-parse", "HEAD").strip()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{commit},submodule")
        (self.workspace / "submodule").mkdir()
        with self.assertRaisesRegex(ValueError, "[Ss]ubmodule"):
            self.digest()


if __name__ == "__main__":
    unittest.main()
