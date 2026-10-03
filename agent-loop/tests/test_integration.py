"""Exercise the real runner with a deterministic local fake Codex process."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNNER = PROJECT_ROOT / "agent_loop.py"
FAKE_AGENT = Path(__file__).with_name("fake_agent.py")


class LoopIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-loop-test-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name) / "workspace"
        self.workspace.mkdir()
        (self.workspace / "config").mkdir()
        (self.workspace / "prompts").mkdir()
        (self.workspace / ".gitignore").write_text(".agent-loop/\n", encoding="utf-8")
        (self.workspace / "implementation.txt").write_text("Original implementation.\n", encoding="utf-8")
        (self.workspace / "spec.md").write_text("INVOCATION_CWD_SPEC\n", encoding="utf-8")
        for phase in ("implement", "review", "revise"):
            (self.workspace / "prompts" / f"{phase}.md").write_text(
                f"Complete the {phase} phase.\n@spec.md\n"
                "Workspace: {{workspace}}\nWrite notes to {{review_file}}.\n"
                + ("Consider these reports:\n{{reviewDetails}}\n" if phase == "revise" else ""), encoding="utf-8"
            )
        self.config = {
            "version": 1,
            "name": "integration-fixture",
            "agents": {
                "implementer": {"id": "implementer", "harness": "codex", "command": str(FAKE_AGENT),
                                "instructions": {phase: {"file": f"prompts/{phase}.md"} for phase in ("implement", "revise")}},
                "reviewers": [
                    {"id": "correctness", "harness": "codex", "command": str(FAKE_AGENT), "instructions": {"file": "prompts/review.md"}},
                    {"id": "edge-cases", "harness": "codex", "command": str(FAKE_AGENT), "instructions": {"file": "prompts/review.md"}},
                ],
            },
            "parallelReviews": True,
            "limits": {"maxRounds": 3},
            "runsDirectory": ".agent-loop/runs",
        }
        self.config_file = self.workspace / "config" / "loop.json"
        self.write_config()
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Agent Loop Tests", "-c", "user.email=tests@example.invalid", "commit", "-qm", "Initial fixture")

    def git(self, *arguments):
        return subprocess.run(
            ["git", *arguments], cwd=self.workspace, check=True,
            capture_output=True, text=True,
        )

    def write_config(self):
        self.config_file.write_text(json.dumps(self.config, indent=2) + "\n", encoding="utf-8")

    def invoke(self, *arguments, mode="three-rounds"):
        environment = os.environ.copy()
        environment["FAKE_AGENT_MODE"] = mode
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            [sys.executable, str(RUNNER), *map(str, arguments)],
            cwd=self.workspace, env=environment, capture_output=True,
            text=True, timeout=30,
        )

    def start(self, *, mode="three-rounds"):
        self.write_config()
        completed = self.invoke("config/loop.json", mode=mode)
        self.assertTrue(
            any(self.workspace.glob(".agent-loop/runs/*/state.json")),
            "Runner did not create a durable run:\n" + completed.stdout + completed.stderr,
        )
        return completed, self.only_run()

    def only_run(self):
        root = self.workspace / ".agent-loop" / "runs"
        runs = list(root.glob("*/state.json"))
        self.assertEqual(len(runs), 1, f"Expected one durable run under {root}; got {runs}")
        return runs[0].parent

    @staticmethod
    def read_json(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def state(self, run):
        return self.read_json(run / "state.json")

    def calls(self, run):
        return [self.read_json(path) for path in sorted((run / "fake-calls").glob("*.json"))]

    def assert_succeeded(self, completed, run):
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(self.state(run)["status"], "COMPLETED")

    def assert_not_approved(self, completed, run):
        self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertNotEqual(self.state(run)["status"], "COMPLETED")

    def test_three_rounds_aggregate_feedback_and_rerun_every_reviewer(self):
        completed, run = self.start()
        self.assert_succeeded(completed, run)
        self.assertEqual(self.state(run)["round"], 3)
        calls = self.calls(run)
        self.assertEqual(len(calls), 9)
        implementer_calls = sorted(
            (call for call in calls if call["context"]["phase"] != "review"),
            key=lambda call: call["context"]["round"],
        )
        self.assertEqual([call["context"]["phase"] for call in implementer_calls], ["implement", "revise", "revise"])
        self.assertNotIn("resume", implementer_calls[0]["arguments"])
        first_session = implementer_calls[0]["session"]
        for call in implementer_calls[1:]:
            self.assertIn("resume", call["arguments"])
            self.assertEqual(call["session"], first_session)
            feedback_file = Path(call["context"]["feedbackFile"])
            self.assertTrue(feedback_file.is_absolute())
            feedback = self.read_json(feedback_file)
            round_number = call["context"]["round"]
            self.assertEqual(feedback["reviewedRound"], round_number - 1)
            self.assertEqual(feedback["revisionRound"], round_number)
            self.assertEqual({review["agentId"] for review in feedback["reviews"]}, {"correctness", "edge-cases"})
            self.assertEqual({review["status"] for review in feedback["reviews"]}, {"NO_CHANGES_REQUIRED", "CHANGES_REQUIRED"})
            self.assertIn(f"Reviews from round {round_number - 1}:", call["prompt"])
            self.assertNotIn("{{reviewDetails}}", call["prompt"])
            for review in feedback["reviews"]:
                for key in ("reportFile", "resultFile"):
                    path = Path(review[key])
                    self.assertTrue(path.is_file(), f"Feedback references missing {key}: {path}")
                self.assertIn(review["reportFile"], call["prompt"])
                self.assertIn(f"{review['agentId']} — {review['status']}", call["prompt"])
                self.assertNotIn(Path(review["reportFile"]).read_text(), call["prompt"])
            if round_number == 3:
                self.assertNotIn("/rounds/001/reviews/", call["prompt"])
        for round_number in (1, 2, 3):
            reviews = [call for call in calls if call["context"]["phase"] == "review" and call["context"]["round"] == round_number]
            self.assertEqual({call["context"]["agentId"] for call in reviews}, {"correctness", "edge-cases"})
            for review in reviews:
                self.assertNotIn("resume", review["arguments"])
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Implemented round 3.\n")
        self.assertIn("implementation.txt", self.git("status", "--porcelain").stdout)

    def test_nested_config_paths_resolve_from_invocation_cwd_and_timeout_is_optional(self):
        self.assertNotIn("agentTimeoutSeconds", self.config["limits"])
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        for call in self.calls(run):
            self.assertEqual(Path(call["cwd"]).resolve(), self.workspace.resolve())
            self.assertIn(json.dumps(str((self.workspace / "spec.md").resolve())), call["prompt"])
            self.assertNotIn("INVOCATION_CWD_SPEC", call["prompt"])
            self.assertNotIn("@spec.md", call["prompt"])
        self.assertFalse((self.workspace / "config" / ".agent-loop").exists())

    def test_inline_prompts_resolve_file_paths_without_inserting_contents(self):
        self.config["agents"]["implementer"]["instructions"] = {
            phase: {"text": f"Inline {phase} prompt.\n@spec.md\n"}
            for phase in ("implement", "revise")
        }
        for agent in self.config["agents"]["reviewers"]:
            agent["instructions"] = {"text": "Inline review prompt.\n@spec.md\n"}
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        for call in self.calls(run):
            self.assertIn(json.dumps(str((self.workspace / "spec.md").resolve())), call["prompt"])
            self.assertNotIn("INVOCATION_CWD_SPEC", call["prompt"])
            self.assertNotIn("<referenced-file", call["prompt"])
        manifest = self.read_json(run / "inputs" / "manifest.json")
        saved = next(item for item in manifest if Path(item["source"]).name == "spec.md")
        self.assertEqual(Path(saved["snapshot"]).read_bytes(), b"INVOCATION_CWD_SPEC\n")

    def test_binary_references_are_paths_and_snapshots_preserve_bytes(self):
        data = b"\x89PNG\r\n\x1a\n\xff"
        (self.workspace / "reference.png").write_bytes(data)
        self.config["agents"]["implementer"]["instructions"]["implement"] = {"text": "Read @reference.png"}
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        call = next(call for call in self.calls(run) if call["context"]["phase"] == "implement")
        self.assertEqual(call["prompt"], "Read " + json.dumps(str((self.workspace / "reference.png").resolve())))
        manifest = self.read_json(run / "inputs" / "manifest.json")
        saved = next(item for item in manifest if Path(item["source"]).name == "reference.png")
        self.assertEqual(Path(saved["snapshot"]).read_bytes(), data)

    def test_every_phase_receives_only_its_authored_instructions(self):
        for phase in ("implement", "revise"):
            self.config["agents"]["implementer"]["instructions"][phase] = {
                "text": f"Only {phase}.\nWorkspace: {{{{workspace}}}}\nReport: {{{{review_file}}}}"
                + ("\n{{reviewDetails}}" if phase == "revise" else "")
            }
        for agent in self.config["agents"]["reviewers"]:
            agent["instructions"] = {"text": "Only review.\nWorkspace: {{workspace}}\nReport: {{review_file}}"}
        completed, run = self.start()
        self.assert_succeeded(completed, run)
        for call in self.calls(run):
            context = call["context"]
            expected = f"Only {context['phase']}.\nWorkspace: {self.workspace.resolve()}\nReport: {context['reportFile']}"
            if context["phase"] == "revise":
                feedback = self.read_json(context["feedbackFile"])
                expected += f"\nReviews from round {context['round'] - 1}:"
                for review in feedback["reviews"]:
                    expected += f"\n\n- {review['agentId']} — {review['status']}\n  {review['reportFile']}"
            self.assertEqual(call["prompt"], expected)
            saved = Path(context["promptFile"]).read_text()
            self.assertEqual(saved, expected)
            self.assertNotIn("--output-schema", call["arguments"])
            self.assertNotIn("AGENT_LOOP_CONTEXT", call["prompt"])

    def test_unknown_revision_variable_fails_before_first_agent(self):
        self.config["agents"]["implementer"]["instructions"]["revise"] = {"text": "Read {{feedback_file}}"}
        self.write_config()
        completed = self.invoke("config/loop.json")
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
        self.assertIn("Unknown template variable", completed.stderr)
        self.assertFalse((self.workspace / ".agent-loop" / "runs").exists())

    def test_external_run_directory_supports_agent_written_reports(self):
        external = (self.workspace.parent / "external-runs").resolve()
        self.config["runsDirectory"] = str(external)
        self.write_config()
        completed = self.invoke("config/loop.json", mode="approve")
        run = next(external.glob("*/state.json")).parent
        self.assert_succeeded(completed, run)
        for call in self.calls(run):
            report = Path(call["context"]["reportFile"])
            self.assertTrue(report.is_file())
            self.assertTrue(report.is_relative_to(external))
            self.assertIn(str(report.parent), call["arguments"])
            self.assertIn("--add-dir", call["arguments"])

    def test_advisory_findings_do_not_block_completion(self):
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        self.assertEqual(self.state(run)["round"], 1)
        results = list((run / "rounds" / "001" / "reviews").glob("*/attempt-01/result.json"))
        self.assertEqual(len(results), 2)
        for result_file in results:
            result = self.read_json(result_file)
            self.assertEqual(result["status"], "NO_CHANGES_REQUIRED")
            self.assertIn("Advisory:", result["report"])
            self.assertEqual(Path(result["reportFile"]).read_text(), result["report"])

    def test_reviewers_can_run_sequentially(self):
        self.config["parallelReviews"] = False
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        self.assertEqual(len(self.calls(run)), 3)

    def test_reviewer_crash_is_not_approval(self):
        completed, run = self.start(mode="crash-review")
        self.assert_not_approved(completed, run)

    def test_malformed_reviewer_result_is_not_approval(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)

    def test_multiple_final_verdicts_are_not_approval(self):
        completed, run = self.start(mode="mixed-verdict-review")
        self.assert_not_approved(completed, run)

    def test_repeated_final_verdict_is_not_approval(self):
        completed, run = self.start(mode="repeated-verdict-review")
        self.assert_not_approved(completed, run)

    def test_prose_containing_one_verdict_is_accepted(self):
        completed, run = self.start(mode="prose-verdict-review")
        self.assert_succeeded(completed, run)
        result = self.read_json(run / "rounds" / "001" / "reviews" / "correctness" / "attempt-01" / "result.json")
        self.assertEqual(result["status"], "NO_CHANGES_REQUIRED")

    def test_wrong_role_verdict_is_not_approval(self):
        completed, run = self.start(mode="wrong-role-review")
        self.assert_not_approved(completed, run)

    def test_final_json_text_containing_one_verdict_is_accepted(self):
        completed, run = self.start(mode="old-json-review")
        self.assert_succeeded(completed, run)

    def test_missing_report_is_not_approval(self):
        completed, run = self.start(mode="missing-report")
        self.assert_not_approved(completed, run)
        self.assertIn("report file", self.state(run)["reason"])

    def test_empty_report_is_not_approval(self):
        completed, run = self.start(mode="empty-report")
        self.assert_not_approved(completed, run)
        self.assertIn("report is empty", self.state(run)["reason"])

    def test_symlink_report_is_not_approval(self):
        completed, run = self.start(mode="symlink-report")
        self.assert_not_approved(completed, run)

    def test_directory_report_is_not_approval(self):
        completed, run = self.start(mode="directory-report")
        self.assert_not_approved(completed, run)

    def test_non_utf8_report_is_not_approval(self):
        completed, run = self.start(mode="nonutf8-report")
        self.assert_not_approved(completed, run)

    def test_crash_with_report_and_verdict_is_not_approval(self):
        completed, run = self.start(mode="crash-after-report")
        self.assert_not_approved(completed, run)

    def test_implementation_also_requires_its_report(self):
        completed, run = self.start(mode="missing-implementation-report")
        self.assert_not_approved(completed, run)
        self.assertEqual(len(self.calls(run)), 1)

    def assert_implementation_result_failure_resumes_same_session(self, mode):
        completed, run = self.start(mode=mode)
        self.assert_not_approved(completed, run)
        self.assertEqual(len(self.calls(run)), 1, "Result failure must halt before checks or reviews")
        directory = run / "rounds" / "001" / "implementation"
        self.assertEqual(self.read_json(directory / "turn-001.process.json")["exitCode"], 0)
        self.assertEqual(self.read_json(directory / "turn-001.error.json")["failureStage"], "result")
        first = self.calls(run)[0]
        self.assertEqual(self.state(run)["implementerSessionId"], first["session"])
        earlier_files = {path.name: path.read_bytes() for path in directory.glob("turn-001.*")}
        (self.workspace / "spec.md").write_text("Clarified plan after the halt.\n")

        resumed = self.invoke("--resume", run, "--prompt", "Read the clarified plan and continue.", mode="approve")
        self.assert_succeeded(resumed, run)
        calls = self.calls(run)
        implementations = sorted(
            (call for call in calls if call["context"]["phase"] == "implement"),
            key=lambda call: call["context"]["turn"],
        )
        self.assertEqual(len(implementations), 2)
        first, retry = implementations
        self.assertEqual(retry["prompt"], "Read the clarified plan and continue.")
        self.assertIn("resume", retry["arguments"])
        self.assertEqual(retry["session"], first["session"])
        self.assertEqual(retry["context"]["reportFile"], first["context"]["reportFile"])
        self.assertEqual(len([call for call in calls if call["context"]["phase"] == "review"]), 2)
        for name, data in earlier_files.items():
            self.assertEqual((directory / name).read_bytes(), data, f"Resume rewrote {name}")

    def test_resume_after_implementation_output_processing_failure_keeps_session(self):
        self.assert_implementation_result_failure_resumes_same_session("malformed-implementation")

    def test_resume_after_missing_implementation_report_keeps_session(self):
        self.assert_implementation_result_failure_resumes_same_session("missing-implementation-report")

    def test_resume_after_invalid_implementation_verdict_keeps_session(self):
        self.assert_implementation_result_failure_resumes_same_session("invalid-implementation-status")

    def test_resume_after_conflicting_implementation_verdict_keeps_session(self):
        self.assert_implementation_result_failure_resumes_same_session("conflicting-implementation-status")

    def test_revision_result_failure_resumes_same_session_without_repeating_feedback(self):
        completed, run = self.start(mode="malformed-revision")
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["round"], 2)
        self.assertEqual(len(self.calls(run)), 4)
        failed = run / "rounds" / "002" / "implementation"
        self.assertEqual(self.read_json(failed / "turn-001.error.json")["failureStage"], "result")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        revisions = sorted(
            (call for call in self.calls(run) if call["context"]["phase"] == "revise"),
            key=lambda call: call["context"]["turn"],
        )
        self.assertEqual(len(revisions), 2)
        first, retry = revisions
        self.assertIn("resume", first["arguments"])
        self.assertIn("resume", retry["arguments"])
        self.assertEqual(retry["session"], first["session"])
        self.assertIn("Reviews from round 1:", first["prompt"])
        self.assertEqual(retry["prompt"], "Continue")
        self.assertEqual(self.state(run)["implementerSessionId"], retry["session"])

    def test_implementation_execution_failure_is_terminal(self):
        completed, run = self.start(mode="crash-implementation")
        self.assert_not_approved(completed, run)
        self.assertEqual(len(self.calls(run)), 1)
        failed = run / "rounds" / "001" / "implementation"
        self.assertEqual(self.read_json(failed / "turn-001.error.json")["failureStage"], "execution")
        self.assertEqual(self.read_json(failed / "turn-001.process.json")["exitCode"], 19)
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Implemented round 1.\n")
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "IMPLEMENTER_PANIC")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1, "Terminal failure must never launch a replacement implementer")

    def test_implementation_timeout_is_terminal(self):
        self.config["limits"]["agentTimeoutSeconds"] = 1
        completed, run = self.start(mode="sleep-implementation")
        self.assert_not_approved(completed, run)
        failed = run / "rounds" / "001" / "implementation"
        self.assertEqual(self.read_json(failed / "turn-001.error.json")["failureStage"], "execution")
        self.assertNotEqual(self.read_json(failed / "turn-001.process.json")["exitCode"], 0)
        self.assertFalse((failed / "turn-001.result.json").exists())
        self.assertEqual(self.state(run)["terminalReason"], "IMPLEMENTER_PANIC")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1)

    def test_blocked_implementer_stops_before_review(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["status"], "BLOCKED")
        self.assertEqual(len(self.calls(run)), 1)

    def test_implementer_commit_stops_before_review_and_preserves_committed_work(self):
        original_head = self.git("rev-parse", "HEAD").stdout.strip()
        completed, run = self.start(mode="commit-implementer")
        self.assert_not_approved(completed, run)
        committed_head = self.git("rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(committed_head, original_head)
        self.assertEqual(self.git("show", "HEAD:implementation.txt").stdout, "Implemented round 1.\n")
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Implemented round 1.\n")
        self.assertEqual(self.git("diff", "--name-only", original_head, committed_head).stdout.strip(), "implementation.txt")
        calls = self.calls(run)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["context"]["phase"], "implement")

    def test_blocked_reviewer_is_not_approval(self):
        completed, run = self.start(mode="blocked-review")
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["status"], "BLOCKED")

    def test_reviewer_source_mutation_invalidates_review(self):
        completed, run = self.start(mode="mutate-review")
        self.assert_not_approved(completed, run)
        self.assertIn("Reviewer illegally", (self.workspace / "implementation.txt").read_text())

    def test_active_review_invalidation_does_not_discard_later_successful_retry(self):
        completed, run = self.start(mode="mutate-review")
        self.assert_not_approved(completed, run)
        reviews = run / "rounds" / "001" / "reviews"
        for agent in ("correctness", "edge-cases"):
            self.assertTrue((reviews / agent / "attempt-01" / "invalidated.json").is_file())
        resumed = self.invoke("--resume", run, mode="crash-review")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 5, "Both invalidated reviewers must run again")
        saved = reviews / "edge-cases" / "attempt-02"
        self.assertEqual(self.read_json(saved / "result.json")["status"], "NO_CHANGES_REQUIRED")
        self.assertFalse((saved / "invalidated.json").exists())
        saved_files = {path.name: path.read_bytes() for path in saved.iterdir() if path.is_file()}
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(len(self.calls(run)), 6, "Only the still-failed reviewer should retry")
        self.assertTrue((reviews / "correctness" / "attempt-03" / "result.json").is_file())
        self.assertFalse((reviews / "edge-cases" / "attempt-03").exists())
        for name, data in saved_files.items():
            self.assertEqual((saved / name).read_bytes(), data)

    def test_followup_prompt_is_rejected_before_queued_round_first_turn(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        # Simulate the durable state immediately after queuing a new round but
        # before starting its first invocation. The session already exists.
        state = self.state(run)
        state.update(round=2, phase="implementation", status="INTERRUPTED",
                     candidateSha256=None, candidateManifestFile=None)
        (run / "state.json").write_text(json.dumps(state))
        resumed = self.invoke("--resume", run, "--prompt", "Continue", mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertIn("has not started", resumed.stdout + resumed.stderr)
        self.assertEqual(len(self.calls(run)), 1)
        self.assertFalse((run / "rounds" / "002" / "implementation").exists())

    def test_round_limit_stops_without_approval(self):
        self.config["limits"]["maxRounds"] = 2
        completed, run = self.start()
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["status"], "ROUND_LIMIT")
        self.assertEqual(self.state(run)["round"], 2)
        self.assertEqual(len(self.calls(run)), 6)

    def test_explicit_agent_timeout_stops_without_approval(self):
        self.config["limits"]["agentTimeoutSeconds"] = 1
        completed, run = self.start(mode="sleep-review")
        self.assert_not_approved(completed, run)

    def test_resume_reuses_run_and_retains_failed_review_history(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        calls_before = self.calls(run)
        self.assertEqual(len(calls_before), 3, "All parallel reviewers should finish before the halt")
        failure = run / "rounds" / "001" / "reviews" / "correctness" / "attempt-01"
        saved = run / "rounds" / "001" / "reviews" / "edge-cases" / "attempt-01"
        self.assertEqual(self.read_json(failure / "process.json")["exitCode"], 0)
        self.assertEqual(self.read_json(failure / "error.json")["failureStage"], "result")
        saved_files = {path.name: path.read_bytes() for path in saved.iterdir() if path.is_file()}
        earlier_files = {path.relative_to(run) for path in run.rglob("*") if path.is_file()}
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(self.only_run(), run)
        later_files = {path.relative_to(run) for path in run.rglob("*") if path.is_file()}
        self.assertTrue(earlier_files.issubset(later_files))
        calls = self.calls(run)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len([call for call in calls if call["context"]["phase"] == "implement"]), 1)
        self.assertEqual(len([call for call in calls if call["context"]["agentId"] == "edge-cases"]), 1)
        retry = next(call for call in calls if call["mode"] == "approve")
        first = next(call for call in calls_before if call["context"]["agentId"] == "correctness")
        self.assertEqual(retry["context"]["agentId"], "correctness")
        self.assertNotIn("resume", retry["arguments"])
        self.assertNotEqual(retry["session"], first["session"])
        self.assertEqual(retry["prompt"], first["prompt"].replace(
            first["context"]["reportFile"], retry["context"]["reportFile"]
        ))
        for name, data in saved_files.items():
            self.assertEqual((saved / name).read_bytes(), data)

    def test_resume_does_not_reuse_reviewer_result_when_latest_attempt_has_error(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        location = run / "rounds" / "001" / "reviews" / "edge-cases"
        old = self.read_json(location / "attempt-01" / "result.json")
        latest = location / "attempt-02"
        latest.mkdir()
        (latest / "report.txt").write_bytes(Path(old["reportFile"]).read_bytes())
        # Simulate a result saved before a later metadata/logging failure. Neither
        # this result nor the older successful attempt can satisfy the reviewer.
        stale = dict(old, reportFile=str(latest / "report.txt"), resultFile=str(latest / "result.json"))
        (latest / "result.json").write_text(json.dumps(stale))
        (latest / "process.json").write_text(json.dumps({"status": "exited", "exitCode": 0}))
        (latest / "error.json").write_text(json.dumps({"failureStage": "result", "error": "Late persistence failure"}))
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        calls = self.calls(run)
        self.assertEqual(len([call for call in calls if call["context"]["phase"] == "implement"]), 1)
        for agent in ("correctness", "edge-cases"):
            self.assertEqual(len([call for call in calls if call["context"]["agentId"] == agent]), 2)
        self.assertTrue((location / "attempt-03" / "result.json").is_file())

    def test_sequential_review_result_failure_keeps_other_completed_review(self):
        self.config["parallelReviews"] = False
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        self.assertEqual(len(self.calls(run)), 3)
        other = run / "rounds" / "001" / "reviews" / "edge-cases" / "attempt-01" / "result.json"
        self.assertEqual(self.read_json(other)["status"], "NO_CHANGES_REQUIRED")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(len(self.calls(run)), 4)
        self.assertEqual(len([call for call in self.calls(run)
                              if call["context"]["agentId"] == "edge-cases"]), 1)

    def test_resume_does_not_reuse_report_from_failed_attempt(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        old_report = run / "rounds" / "001" / "reviews" / "correctness" / "attempt-01" / "report.txt"
        old_report.write_text("A report from a failed attempt must not satisfy a new attempt.")
        resumed = self.invoke("--resume", run, mode="missing-report")
        self.assert_not_approved(resumed, run)
        self.assertIn("attempt-02/report.txt", self.state(run)["reason"])

    def test_resume_rejects_changed_saved_reviewer_report(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        saved = run / "rounds" / "001" / "reviews" / "edge-cases" / "attempt-01" / "report.txt"
        saved.write_text("Changed after the reviewer completed.")
        calls_before = len(self.calls(run))
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), calls_before)
        self.assertIn("report changed", self.state(run)["reason"])

    def test_partial_revision_resumes_same_session_with_only_followup(self):
        completed, run = self.start(mode="blocked-revision")
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertEqual(self.state(run)["round"], 2)
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Implemented round 2.\n")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        revisions = sorted((c for c in self.calls(run) if c["context"]["phase"] == "revise"),
                           key=lambda call: call["context"]["turn"])
        self.assertEqual(len(revisions), 2)
        self.assertIn("Reviews from round 1:", revisions[0]["prompt"])
        self.assertIn("/rounds/001/reviews/", revisions[0]["prompt"])
        self.assertEqual(revisions[1]["prompt"], "Continue")
        self.assertEqual(revisions[0]["session"], revisions[1]["session"])
        self.assertEqual(revisions[0]["context"]["reportFile"], revisions[1]["context"]["reportFile"])

    def test_resume_allows_workspace_changes_and_keeps_successful_reviews(self):
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        saved = run / "rounds" / "001" / "reviews" / "edge-cases" / "attempt-01" / "result.json"
        saved_bytes = saved.read_bytes()
        (self.workspace / "implementation.txt").write_text("Outside edit after failed review.\n", encoding="utf-8")
        (self.workspace / "spec.md").write_text("A clarified plan.\n", encoding="utf-8")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(len(self.calls(run)), 4)
        self.assertEqual(saved.read_bytes(), saved_bytes)
        self.assertEqual(len([call for call in self.calls(run) if call["context"]["agentId"] == "edge-cases"]), 1)
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Outside edit after failed review.\n")

    def test_required_check_failure_prevents_completion(self):
        self.config["limits"]["maxRounds"] = 1
        self.config["checks"] = [{
            "id": "required-test",
            "command": [sys.executable, "-c", "raise SystemExit(9)"],
        }]
        completed, run = self.start(mode="approve")
        self.assert_not_approved(completed, run)

    def test_required_check_success_allows_completion(self):
        self.config["checks"] = [{
            "id": "required-test",
            "command": [sys.executable, "-c", "from pathlib import Path; assert Path('implementation.txt').read_text() == 'Implemented round 1.\\n'"],
        }]
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)

    def test_check_failure_reaches_implementer_even_when_reviewers_approve(self):
        self.config["checks"] = [{
            "id": "required-test",
            "command": [sys.executable, "-c", "from pathlib import Path; assert Path('implementation.txt').read_text() == 'Implemented round 2.\\n'"],
        }]
        completed, run = self.start(mode="approve")
        self.assert_succeeded(completed, run)
        self.assertEqual(self.state(run)["round"], 2)
        revisions = [call for call in self.calls(run) if call["context"]["phase"] == "revise"]
        self.assertEqual(len(revisions), 1)
        feedback = self.read_json(revisions[0]["context"]["feedbackFile"])
        self.assertTrue(feedback["checks"])
        self.assertEqual({review["status"] for review in feedback["reviews"]}, {"NO_CHANGES_REQUIRED"})
        self.assertIn(feedback["checksReportFile"], revisions[0]["prompt"])
        self.assertIn("Required checks — FAILED", revisions[0]["prompt"])
        self.assertIn("required-test: FAILED", Path(feedback["checksReportFile"]).read_text())

    def test_blocked_twice_then_two_review_rounds_share_one_implementer_session(self):
        completed, run = self.start(mode="blocked-twice-two-rounds")
        self.assertEqual(self.state(run)["status"], "BLOCKED")
        self.assertEqual(self.state(run)["round"], 1)
        first_report = run / "rounds" / "001" / "implementation" / "report.txt"
        first_report_text = first_report.read_text()
        (self.workspace / "spec.md").write_text("First blocker clarified.\n")
        resumed = self.invoke("--resume", run, "--prompt", "First blocker is resolved.", mode="blocked-twice-two-rounds")
        self.assertEqual(resumed.returncode, 3, resumed.stdout + resumed.stderr)
        self.assertEqual(self.state(run)["round"], 1)
        notes = self.workspace / "resume-notes.md"
        notes.write_text("Both blockers are resolved.\nRead spec.md and continue.\n")
        (self.workspace / "spec.md").write_text("Both blockers clarified.\n")
        resumed = self.invoke("--resume", run, "--prompt-file", "resume-notes.md", mode="blocked-twice-two-rounds")
        self.assert_succeeded(resumed, run)
        self.assertEqual(self.state(run)["round"], 2)
        implementations = sorted((c for c in self.calls(run) if c["context"]["phase"] != "review"),
                                 key=lambda c: (c["context"]["round"], c["context"]["turn"]))
        self.assertEqual(len(implementations), 4)
        self.assertEqual(len({c["session"] for c in implementations}), 1)
        self.assertEqual([c["context"]["turn"] for c in implementations], [1, 2, 3, 1])
        self.assertEqual(implementations[1]["prompt"], "First blocker is resolved.")
        self.assertEqual(implementations[2]["prompt"], notes.read_text())
        self.assertIn("Reviews from round 1:", implementations[3]["prompt"])
        self.assertEqual(len({c["context"]["reportFile"] for c in implementations[:3]}), 1)
        self.assertNotEqual(implementations[2]["context"]["reportFile"], implementations[3]["context"]["reportFile"])
        self.assertEqual(first_report.with_name("turn-001.report.txt").read_text(), first_report_text)
        self.assertEqual(first_report.with_name("turn-002.report.txt").read_text(), first_report_text)
        self.assertEqual(first_report.read_text(), first_report.with_name("turn-003.report.txt").read_text())
        for call in implementations:
            self.assertEqual(Path(call["context"]["promptFile"]).read_text(), call["prompt"])
        for round_number in (1, 2):
            reviews = [c for c in self.calls(run) if c["context"]["phase"] == "review" and c["context"]["round"] == round_number]
            self.assertEqual({c["context"]["agentId"] for c in reviews}, {"correctness", "edge-cases"})

    def test_native_implementer_failure_with_zero_exit_is_terminal(self):
        completed, run = self.start(mode="native-turn-failed")
        self.assert_not_approved(completed, run)
        directory = run / "rounds" / "001" / "implementation"
        self.assertEqual(self.read_json(directory / "turn-001.process.json")["exitCode"], 0)
        self.assertEqual(self.read_json(directory / "turn-001.error.json")["failureStage"], "execution")
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "IMPLEMENTER_PANIC")
        self.assertTrue((directory / "report.txt").is_file())
        self.assertFalse((directory / "turn-001.result.json").exists())
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1)

    def test_implementer_session_mismatch_on_resume_is_terminal(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        original_session = self.state(run)["implementerSessionId"]
        resumed = self.invoke("--resume", run, mode="session-mismatch")
        self.assert_not_approved(resumed, run)
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "SESSION_UNAVAILABLE")
        self.assertEqual(self.state(run)["implementerSessionId"], original_session)
        self.assertEqual(len(self.calls(run)), 2)
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 2)

    def test_config_mutation_during_implementer_is_terminal_before_reviews(self):
        original = self.config_file.read_bytes()
        completed, run = self.start(mode="modify-config")
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "CONFIG_CHANGED")
        self.assertEqual(len(self.calls(run)), 1)
        self.assertFalse((run / "rounds" / "001" / "reviews").exists())
        self.config_file.write_bytes(original)
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1)
        self.assertEqual(self.state(run)["terminalReason"], "CONFIG_CHANGED")

    def test_workspace_edit_during_review_halt_refreshes_checks_and_revision_snapshot(self):
        self.config["checks"] = [{
            "id": "required-test",
            "command": [sys.executable, "-c", "from pathlib import Path; assert Path('implementation.txt').read_text() in ('Implemented round 1.\\n', 'Implemented round 2.\\n')"],
        }]
        completed, run = self.start(mode="malformed-review")
        self.assert_not_approved(completed, run)
        directory = run / "rounds" / "001"
        saved = directory / "reviews" / "edge-cases" / "attempt-01" / "result.json"
        saved_bytes = saved.read_bytes()
        old_candidate = self.read_json(saved)["candidateSha256"]
        (self.workspace / "implementation.txt").write_text("User resolved blocker but introduced a regression.\n")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(self.state(run)["round"], 2)
        self.assertEqual(saved.read_bytes(), saved_bytes)
        first_check = self.read_json(directory / "checks" / "required-test" / "attempt-01" / "result.json")
        refreshed_check = self.read_json(directory / "checks" / "required-test" / "attempt-02" / "result.json")
        self.assertTrue(first_check["passed"])
        self.assertFalse(refreshed_check["passed"])
        feedback = self.read_json(directory / "feedback.json")
        self.assertNotEqual(feedback["candidateSha256"], old_candidate)
        self.assertTrue(Path(feedback["candidateManifestFile"]).is_relative_to((run / "resumes").resolve()))
        self.assertEqual(self.read_json(feedback["candidateManifestFile"])["sha256"], feedback["candidateSha256"])
        original_review = next(review for review in feedback["reviews"] if review["agentId"] == "edge-cases")
        self.assertEqual(original_review["candidateSha256"], old_candidate)
        self.assertEqual(len([c for c in self.calls(run) if c["context"]["phase"] == "review"
                              and c["context"]["round"] == 1 and c["context"]["agentId"] == "edge-cases"]), 1)
        revision = next(c for c in self.calls(run) if c["context"]["phase"] == "revise")
        self.assertIn("Required checks — FAILED", revision["prompt"])
        self.assertIn(str(saved.with_name("report.txt").resolve()), revision["prompt"])

    def test_missing_implementer_session_is_terminal_without_fresh_fallback(self):
        completed, run = self.start(mode="missing-session")
        self.assert_not_approved(completed, run)
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "SESSION_UNAVAILABLE")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1)

    def test_config_byte_change_is_terminal_even_after_restoring_original(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        original = self.config_file.read_bytes()
        # Formatting alone changes the frozen source configuration.
        self.config_file.write_bytes(original + b"\n")
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(self.state(run)["status"], "TERMINAL")
        self.assertEqual(self.state(run)["terminalReason"], "CONFIG_CHANGED")
        self.config_file.write_bytes(original)
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(self.state(run)["terminalReason"], "CONFIG_CHANGED")
        self.assertEqual(len(self.calls(run)), 1)

    def test_deleted_config_is_terminal_before_any_reviewer_retry(self):
        completed, run = self.start(mode="crash-review")
        self.assert_not_approved(completed, run)
        self.config_file.unlink()
        resumed = self.invoke("--resume", run, mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(self.state(run)["terminalReason"], "CONFIG_CHANGED")
        self.assertEqual(len(self.calls(run)), 3)

    def test_skip_failed_reviewer_preserves_success_and_avoids_retry(self):
        completed, run = self.start(mode="blocked-review")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(len(self.calls(run)), 3)
        feedback = self.read_json(run / "rounds" / "001" / "feedback.json")
        statuses = {review["agentId"]: review["status"] for review in feedback["reviews"]}
        self.assertEqual(statuses, {"correctness": "SKIPPED", "edge-cases": "NO_CHANGES_REQUIRED"})

    def test_skip_all_failed_reviewers_can_complete_without_review_approval(self):
        completed, run = self.start(mode="crash-all-reviewers")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", "--skip-reviewer", "edge-cases", mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(len(self.calls(run)), 3)
        feedback = self.read_json(run / "rounds" / "001" / "feedback.json")
        self.assertEqual({review["status"] for review in feedback["reviews"]}, {"SKIPPED"})

    def test_skip_only_selected_failed_reviewer_retries_the_other(self):
        completed, run = self.start(mode="crash-all-reviewers")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", mode="approve")
        self.assert_succeeded(resumed, run)
        calls = self.calls(run)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len([c for c in calls if c["context"]["agentId"] == "correctness"]), 1)
        self.assertEqual(len([c for c in calls if c["context"]["agentId"] == "edge-cases"]), 2)

    def test_skips_apply_only_to_current_round_and_do_not_block_required_revision(self):
        completed, run = self.start(mode="blocked-review-with-changes")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(self.state(run)["round"], 2)
        calls = self.calls(run)
        round_two = [c for c in calls if c["context"]["phase"] == "review" and c["context"]["round"] == 2]
        self.assertEqual({c["context"]["agentId"] for c in round_two}, {"correctness", "edge-cases"})
        revision = next(c for c in calls if c["context"]["phase"] == "revise")
        self.assertIn("edge-cases", revision["prompt"])

    def test_skipping_all_reviewers_cannot_override_failed_required_checks(self):
        self.config["checks"] = [{
            "id": "required-test", "command": [sys.executable, "-c", "from pathlib import Path; assert Path('implementation.txt').read_text() == 'Implemented round 2.\\n'"],
        }]
        completed, run = self.start(mode="crash-all-reviewers")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", "--skip-reviewer", "edge-cases", mode="approve")
        self.assert_succeeded(resumed, run)
        self.assertEqual(self.state(run)["round"], 2)
        revision = next(c for c in self.calls(run) if c["context"]["phase"] == "revise")
        self.assertIn("Required checks — FAILED", revision["prompt"])

    def test_unknown_or_successful_reviewer_cannot_be_skipped(self):
        completed, run = self.start(mode="crash-review")
        self.assert_not_approved(completed, run)
        for agent in ("unknown-agent", "edge-cases"):
            with self.subTest(agent=agent):
                resumed = self.invoke("--resume", run, "--skip-reviewer", agent, mode="approve")
                self.assert_not_approved(resumed, run)
                self.assertEqual(len(self.calls(run)), 3)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", mode="approve")
        self.assert_succeeded(resumed, run)

    def test_resume_prompt_options_are_mutually_exclusive(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        notes = self.workspace / "resume-notes.md"
        notes.write_text("Continue from the resolved blocker.")
        resumed = self.invoke("--resume", run, "--prompt", "Continue", "--prompt-file", str(notes), mode="approve")
        self.assertEqual(resumed.returncode, 2, resumed.stdout + resumed.stderr)
        self.assertEqual(len(self.calls(run)), 1)

    def test_resume_only_flags_are_rejected_before_starting_a_run(self):
        for flags in (("--prompt", "A message"), ("--prompt-file", "spec.md"), ("--skip-reviewer", "correctness")):
            with self.subTest(flags=flags):
                completed = self.invoke("config/loop.json", *flags, mode="approve")
                self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
                self.assertFalse(any(self.workspace.glob(".agent-loop/runs/*/fake-calls/*")))

    def test_prompt_is_rejected_on_review_resume_and_skip_on_implementation_resume(self):
        completed, run = self.start(mode="blocked-implementer")
        self.assert_not_approved(completed, run)
        resumed = self.invoke("--resume", run, "--skip-reviewer", "correctness", mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 1)
        resumed = self.invoke("--resume", run, mode="crash-review")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 4)
        resumed = self.invoke("--resume", run, "--prompt", "Not a reviewer message", mode="approve")
        self.assert_not_approved(resumed, run)
        self.assertEqual(len(self.calls(run)), 4)

    def test_validate_does_not_start_agents(self):
        completed = self.invoke("--validate", "config/loop.json")
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertFalse(any(self.workspace.glob(".agent-loop/runs/*/fake-calls/*")))
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Original implementation.\n")

    def test_run_storage_cannot_hide_existing_tracked_source(self):
        self.config["runsDirectory"] = "prompts"
        self.write_config()
        original_head = self.git("rev-parse", "HEAD").stdout.strip()
        original_prompts = {
            path.name: path.read_bytes() for path in (self.workspace / "prompts").iterdir()
        }
        completed = self.invoke("config/loop.json", mode="approve")
        self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertFalse(any(self.workspace.rglob("fake-calls/*.json")))
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), original_head)
        self.assertEqual((self.workspace / "implementation.txt").read_text(), "Original implementation.\n")
        for name, content in original_prompts.items():
            self.assertEqual((self.workspace / "prompts" / name).read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
