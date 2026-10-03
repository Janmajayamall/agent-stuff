"""Process lifecycle regressions, using only local Python subprocesses."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agentloop.runner import Processes


RUNNER = Path(__file__).resolve().parents[1] / "agent_loop.py"


def wait_until(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class ProcessLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-loop-process-test-")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)

    def test_timeout_stops_descendant_even_when_leader_exits_on_term(self):
        pid_file = self.workspace / "descendant.pid"
        heartbeat = self.workspace / "heartbeat"
        child = """
import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
while True:
    with open(sys.argv[2], 'ab', buffering=0) as output:
        output.write(b'.')
    time.sleep(0.02)
"""
        leader = """
import subprocess, sys, time
subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2], sys.argv[3]])
while True:
    time.sleep(1)
"""

        def cleanup_descendant():
            if pid_file.exists():
                pid = int(pid_file.read_text())
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        self.addCleanup(cleanup_descendant)
        processes = Processes()
        with self.assertRaises(subprocess.TimeoutExpired):
            processes.run([sys.executable, "-c", leader, child, str(pid_file), str(heartbeat)],
                          None, self.workspace, self.workspace / "attempt", 1)
        self.assertTrue(pid_file.exists(), "Descendant did not start before the timeout")
        # Observe the owned child's activity directly. kill(pid, 0) alone
        # cannot distinguish an executing child from a not-yet-reaped zombie.
        self.assertGreater(heartbeat.stat().st_size, 0)
        size = heartbeat.stat().st_size
        time.sleep(0.2)
        self.assertEqual(heartbeat.stat().st_size, size, "Descendant kept writing after timeout")

    def test_cancelled_process_collection_refuses_later_launches(self):
        processes = Processes()
        processes.stop_all()
        with patch("agentloop.runner.subprocess.Popen") as popen:
            with self.assertRaises((ValueError, RuntimeError, InterruptedError, KeyboardInterrupt)):
                processes.run([sys.executable, "-c", "raise SystemExit(0)"], None,
                              self.workspace, self.workspace / "attempt", None)
        popen.assert_not_called()

    def test_sigterm_supervisor_stops_parallel_reviewers_and_records_interruption(self):
        fake = self.workspace / "fake.py"
        fake.write_text(f"#!{sys.executable}\n" + """
import json, os, sys, time
from pathlib import Path
sys.stdin.read()
output_file = Path(sys.argv[sys.argv.index('-o') + 1])
attempt = output_file.parent
round_dir = next(parent for parent in attempt.parents if parent.parent.name == 'rounds')
phase = 'review' if attempt.parent.parent.name == 'reviews' else 'implement'
agent_id = attempt.parent.name if phase == 'review' else 'implementer'
pids = round_dir.parent.parent / 'test-pids'
pids.mkdir(exist_ok=True)
(pids / (agent_id + '.json')).write_text(json.dumps({'pid': os.getpid(), 'phase': phase}))
if phase == 'review':
    heartbeat = pids / (agent_id + '.heartbeat')
    while True:
        with heartbeat.open('ab', buffering=0) as output:
            output.write(b'.')
        time.sleep(0.02)
(attempt / 'report.txt').write_text('Fixture implementation completed.')
output_file.write_text('IMPLEMENTATION_COMPLETE')
print(json.dumps({'type': 'thread.started', 'thread_id': 'fixture-implementation'}))
print(json.dumps({'type': 'turn.completed', 'usage': {}}))
""", encoding="utf-8")
        fake.chmod(0o755)
        config = {
            "version": 1, "name": "term-test",
            "agents": {
                "implementer": {
                    "id": "implementer", "harness": "codex", "command": str(fake),
                    "instructions": {
                        phase: {"text": "Exercise the local fixture; write your report to {{review_file}}."}
                        for phase in ("implement", "revise")
                    },
                },
                "reviewers": [
                    {"id": name, "harness": "codex", "command": str(fake),
                     "instructions": {"text": "Exercise reviewer shutdown; write your report to {{review_file}}."}}
                    for name in ("one", "two")
                ],
            },
            "parallelReviews": True,
        }
        (self.workspace / "loop.json").write_text(json.dumps(config))
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True, capture_output=True)
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        diagnostic_launcher = """
import faulthandler, runpy, sys
from pathlib import Path
faulthandler.dump_traceback_later(8)
sys.path.insert(0, str(Path(sys.argv[1]).parent))
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""
        supervisor = subprocess.Popen([sys.executable, "-c", diagnostic_launcher, str(RUNNER), "loop.json"], cwd=self.workspace,
                                      env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: self.cleanup_supervisor(supervisor))
        pid_files = lambda: list(self.workspace.glob(".agent-loop/runs/*/test-pids/*.json"))
        self.addCleanup(lambda: self.cleanup_agents(pid_files()))
        self.assertTrue(wait_until(lambda: len(pid_files()) == 3 or supervisor.poll() is not None),
                        "Supervisor did not launch both reviewers")
        if supervisor.poll() is not None:
            stdout, stderr = supervisor.communicate()
            self.fail(f"Supervisor exited before reviewers started:\n{stdout}\n{stderr}")
        reviews = [json.loads(p.read_text()) for p in pid_files() if json.loads(p.read_text())["phase"] == "review"]
        self.assertEqual(len(reviews), 2)
        heartbeat_files = lambda: list(self.workspace.glob(".agent-loop/runs/*/test-pids/*.heartbeat"))
        self.assertTrue(wait_until(lambda: len(heartbeat_files()) == 2 and all(p.stat().st_size > 0 for p in heartbeat_files())),
                        "Both owned reviewers must be active before testing termination")
        supervisor.terminate()
        try:
            stdout, stderr = supervisor.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            supervisor.kill()
            stdout, stderr = supervisor.communicate(timeout=5)
            self.fail(f"Supervisor did not finish SIGTERM cleanup:\n{stdout}\n{stderr}")
        self.assertNotEqual(supervisor.returncode, 0, stdout + stderr)
        state_file = next(self.workspace.glob(".agent-loop/runs/*/state.json"))
        self.assertEqual(json.loads(state_file.read_text())["status"], "INTERRUPTED", stdout + stderr)
        for agent_id in ("one", "two"):
            attempt = state_file.parent / "rounds" / "001" / "reviews" / agent_id / "attempt-01"
            receipt = json.loads((attempt / "process.json").read_text())
            failure = json.loads((attempt / "error.json").read_text())
            self.assertNotEqual(receipt["exitCode"], 0)
            self.assertEqual(failure["failureStage"], "execution")
            self.assertFalse((attempt / "result.json").exists())
        sizes = {p: p.stat().st_size for p in heartbeat_files()}
        time.sleep(0.2)
        for path, size in sizes.items():
            self.assertEqual(path.stat().st_size, size,
                             f"Reviewer {path.stem} kept executing after supervisor SIGTERM")

    @staticmethod
    def cleanup_supervisor(supervisor):
        if supervisor.poll() is None:
            supervisor.kill()
        supervisor.communicate(timeout=5)

    @staticmethod
    def cleanup_agents(files):
        for path in files:
            pid = json.loads(path.read_text())["pid"]
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    unittest.main()
