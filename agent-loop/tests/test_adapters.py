"""Adapter protocol tests; all outputs are fixtures, never live model calls."""

import json
from pathlib import Path
import tempfile
import unittest

from agentloop.adapters import Invocation, build_command, execution_failure, parse_output, session_identity


VERDICT = "NO_CHANGES_REQUIRED"


def jsonl(*events):
    return "\n".join(json.dumps(event) for event in events) + "\n"


def pi_message(text=VERDICT, **overrides):
    return {
        "role": "assistant", "content": [{"type": "text", "text": text}],
        "stopReason": "stop", "model": "test-model", "provider": "test-provider",
        "usage": {"input": 8, "output": 5}, **overrides,
    }


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)

    def build(self, harness, phase="implement", session_id=None, prompt="A bounded task.", attempt_dir=None,
              artifact_prefix="", **agent):
        return build_command(
            {"id": "tester", "harness": harness, **agent}, prompt=prompt,
            workspace=self.workspace, attempt_dir=attempt_dir or self.workspace / "attempt",
            phase=phase, session_id=session_id, artifact_prefix=artifact_prefix,
        )

    def codex_stream(self, *extra):
        return jsonl(
            {"type": "thread.started", "thread_id": "thread-123"},
            {"type": "turn.started"}, *extra,
            {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 4}},
        )

    def test_codex_uses_final_file_not_tool_or_progress_text(self):
        invocation = self.build("codex", model={"id": "requested-model"})
        invocation.final_path.write_text(VERDICT)
        stdout = self.codex_stream({"type": "item.completed", "item": {
            "type": "command_execution", "aggregated_output": '{"status":"CHANGES_REQUIRED"}',
        }})
        response = parse_output("codex", invocation, stdout, "NO_CHANGES_REQUIRED")
        self.assertEqual(response.text, VERDICT)
        self.assertEqual(response.session_id, "thread-123")
        self.assertIsNone(response.model)  # Requested model is not observed model.
        self.assertEqual(response.usage["input_tokens"], 10)
        self.assertEqual(invocation.stdin, "A bounded task.")

    def test_codex_jsonl_accepts_unicode_separators_in_command_output(self):
        invocation = self.build("codex")
        invocation.final_path.write_text(VERDICT)
        # Codex emits these literal characters in tool output. They are valid
        # inside JSON strings, including the U+2028/U+2029 calculator inputs.
        for character in ("\x85", "\u2028", "\u2029"):
            for delimiter in ("\n", "\r\n"):
                for trailing_delimiter in ("", delimiter):
                    events = [
                        {"type": "thread.started", "thread_id": "thread-123"},
                        {"type": "item.completed", "item": {
                            "type": "command_execution",
                            "aggregated_output": f"invalid operand: 1{character}2",
                        }},
                        {"type": "turn.completed", "usage": {"input_tokens": 10}},
                    ]
                    stdout = delimiter.join(json.dumps(event, ensure_ascii=False) for event in events) + trailing_delimiter
                    with self.subTest(character=repr(character), delimiter=repr(delimiter), trailing=bool(trailing_delimiter)):
                        response = parse_output("codex", invocation, stdout, "")
                        self.assertEqual(response.text, VERDICT)
                        self.assertEqual(response.session_id, "thread-123")
                        self.assertEqual(response.usage, {"input_tokens": 10})

    def test_codex_failed_turn_cannot_approve_from_valid_file(self):
        invocation = self.build("codex")
        invocation.final_path.write_text(VERDICT)
        stdout = self.codex_stream() + jsonl({"type": "turn.failed", "error": {"message": "quota"}})
        with self.assertRaisesRegex(ValueError, "successful turn.completed"):
            parse_output("codex", invocation, stdout, "")

    def test_codex_unfinished_next_turn_does_not_reuse_prior_approval(self):
        invocation = self.build("codex")
        invocation.final_path.write_text(VERDICT)
        with self.assertRaisesRegex(ValueError, "successful turn.completed"):
            parse_output("codex", invocation, self.codex_stream() + jsonl({"type": "turn.started"}), "")

    def test_codex_missing_or_empty_final_fails_without_fallback(self):
        invocation = self.build("codex")
        with self.assertRaisesRegex(ValueError, "did not write"):
            parse_output("codex", invocation, self.codex_stream(), VERDICT)
        invocation.final_path.write_text(" \n")
        with self.assertRaisesRegex(ValueError, "nonempty final response"):
            parse_output("codex", invocation, self.codex_stream(), "")

    def test_codex_resume_is_exact_and_review_stays_fresh(self):
        resumed = self.build("codex", phase="revise", session_id="thread-123")
        self.assertEqual(resumed.argv[resumed.argv.index("resume") + 1], "thread-123")
        self.assertLess(resumed.argv.index("--sandbox"), resumed.argv.index("resume"))
        self.assertGreater(resumed.argv.index("-o"), resumed.argv.index("resume"))
        self.assertEqual(resumed.argv[-1], "-")
        reviewed = self.build("codex", phase="review", session_id="thread-123")
        self.assertNotIn("resume", reviewed.argv)
        self.assertNotIn("--yolo", reviewed.argv)
        self.assertIn("workspace-write", reviewed.argv)

    def test_codex_rejects_existing_result_file(self):
        invocation = self.build("codex")
        invocation.final_path.write_text(VERDICT)
        with self.assertRaisesRegex(ValueError, "Refusing to reuse"):
            self.build("codex")

    def test_codex_turn_artifacts_preserve_prior_final_output_on_resume(self):
        first = self.build("codex", artifact_prefix="turn-001.")
        first.final_path.write_text("BLOCKED")
        resumed = self.build("codex", session_id="thread-123", artifact_prefix="turn-002.")
        self.assertEqual(first.final_path.name, "turn-001.harness-result.txt")
        self.assertEqual(resumed.final_path.name, "turn-002.harness-result.txt")
        self.assertEqual(first.final_path.parent, resumed.final_path.parent)
        self.assertEqual(first.final_path.read_text(), "BLOCKED")
        self.assertEqual(resumed.argv[resumed.argv.index("resume") + 1], "thread-123")

    def test_codex_session_identity_survives_invalid_final_and_damaged_other_records(self):
        invocation = self.build("codex")
        stdout = (
            jsonl({"type": "thread.started", "thread_id": "thread-123"})
            + '{"type":"item.completed","item":\n'
            + jsonl({"type": "turn.completed"})
        )
        self.assertEqual(session_identity("codex", invocation, stdout), "thread-123")
        with self.assertRaisesRegex(ValueError, "Invalid JSON"):
            parse_output("codex", invocation, stdout, "")
        # Session recovery does not require any completion event or final file.
        unfinished = jsonl({"type": "thread.started", "thread_id": "thread-123"})
        self.assertEqual(session_identity("codex", invocation, unfinished), "thread-123")

    def test_codex_session_identity_rejects_conflicts_but_accepts_repeated_identity(self):
        invocation = self.build("codex")
        repeated = jsonl(*[{"type": "thread.started", "thread_id": "thread-123"}] * 2)
        self.assertEqual(session_identity("codex", invocation, repeated), "thread-123")
        conflicting = repeated + jsonl({"type": "thread.started", "thread_id": "thread-456"})
        with self.assertRaisesRegex(ValueError, "conflicting session IDs"):
            session_identity("codex", invocation, conflicting)

    def test_codex_session_identity_uses_only_valid_native_metadata(self):
        invocation = self.build("codex")
        outputs = [
            jsonl({"type": "item.completed", "thread_id": "thread-123"}),
            jsonl({"type": "item.completed", "item": {"type": "thread.started", "thread_id": "thread-123"}}),
            '{"type":"thread.started","thread_id":"thread-123",}\n',
            '{"type":"thread.started","thread_id":"one","thread_id":"two"}\n',
            jsonl({"type": "thread.started", "thread_id": " "}),
            jsonl({"type": "thread.started", "thread_id": 1}),
            jsonl([{"type": "thread.started", "thread_id": "thread-123"}]),
        ]
        for stdout in outputs:
            with self.subTest(stdout=stdout):
                self.assertIsNone(session_identity("codex", invocation, stdout))

    def test_native_execution_failure_recovers_explicit_codex_failure_from_damaged_stream(self):
        for event_type in ("turn.failed", "error"):
            stdout = self.codex_stream() + '{"damaged":\n' + jsonl({"type": event_type})
            with self.subTest(event_type=event_type):
                self.assertIn(event_type, execution_failure("codex", stdout))
        # A retry that completed successfully supersedes its transient error.
        self.assertIsNone(execution_failure("codex", jsonl({"type": "error"}) + self.codex_stream()))

    def test_missing_or_malformed_output_is_not_proof_of_native_execution_failure(self):
        for harness in ("codex", "claude", "pi"):
            for stdout in ("", "panic!", '{"type":"error",', '[]',
                           '{"type":[],"message":{"role":"assistant","stopReason":[]}}',
                           '{"type":"turn.failed","type":"turn.completed"}'):
                with self.subTest(harness=harness, stdout=stdout):
                    self.assertIsNone(execution_failure(harness, stdout))
        self.assertIsNone(execution_failure("codex", jsonl({"type": "turn.started"})))
        self.assertIsNone(execution_failure("claude", json.dumps({"type": "result", "subtype": "success"})))
        self.assertIsNone(execution_failure("pi", jsonl({"type": "message_end", "message": pi_message("")})))
        self.assertIsNone(execution_failure("pi", jsonl({"type": "message_end", "message": pi_message(stopReason=[])})))

    def test_native_execution_failure_never_uses_error_words_in_tool_or_agent_text(self):
        self.assertIsNone(execution_failure("codex", jsonl({
            "type": "item.completed", "item": {"type": "error", "message": "panic!"},
        })))
        self.assertIsNone(execution_failure("claude", json.dumps({
            "type": "result", "subtype": "success", "result": "panic!", "is_error": False,
        })))
        self.assertIsNone(execution_failure("pi", jsonl({
            "type": "message_end", "message": {"role": "toolResult", "stopReason": "error"},
        })))

    def test_claude_reads_result_text_not_structured_output(self):
        invocation = self.build("claude", session_id="session-123", args=["--allowedTools", "Bash(pytest *)"])
        stdout = json.dumps({"type": "result", "subtype": "success", "is_error": False,
                             "result": VERDICT, "structured_output": {"status": "CHANGES_REQUIRED"},
                             "session_id": "session-123", "usage": {"input_tokens": 42},
                             "modelUsage": {"actual-model": {"inputTokens": 42}}})
        response = parse_output("claude", invocation, stdout, "")
        self.assertEqual(response.text, VERDICT)
        self.assertEqual(response.session_id, "session-123")
        self.assertEqual(response.model, "actual-model")
        self.assertIn("--resume", invocation.argv)
        self.assertNotIn("--permission-mode", invocation.argv)
        self.assertIn("Bash(pytest *)", invocation.argv)

    def test_claude_missing_text_or_failed_result_is_rejected(self):
        invocation = self.build("claude")
        outputs = [
            {"type": "result", "subtype": "success", "structured_output": {"status": VERDICT}},
            {"type": "result", "subtype": "success", "result": {"status": VERDICT}},
            {"type": "result", "subtype": "success", "result": ""},
            {"type": "result", "subtype": "error_max_turns", "result": VERDICT},
            {"type": "result", "subtype": "success", "is_error": True, "result": VERDICT},
        ]
        for output in outputs:
            with self.subTest(output=output), self.assertRaises(ValueError):
                parse_output("claude", invocation, json.dumps(output), "")

    def test_claude_session_identity_does_not_depend_on_verdict_or_completion(self):
        invocation = self.build("claude")
        for subtype, final in (("success", ""), ("success", None),
                               ("success", "BLOCKED IMPLEMENTATION_COMPLETE"),
                               ("error_max_turns", "unfinished")):
            stdout = json.dumps({"type": "result", "subtype": subtype,
                                 "result": final, "session_id": "session-123"})
            with self.subTest(subtype=subtype, final=final):
                self.assertEqual(session_identity("claude", invocation, stdout), "session-123")

    def test_claude_session_identity_never_extracts_from_malformed_or_other_output(self):
        invocation = self.build("claude")
        for stdout in (
            '{"type":"result","session_id":"session-123",',
            '{"type":"result","session_id":"one","session_id":"two"}',
            json.dumps({"type": "progress", "session_id": "session-123"}),
            json.dumps({"type": "result", "result": '{"session_id":"session-123"}'}),
            json.dumps([{"type": "result", "session_id": "session-123"}]),
            json.dumps({"type": "result", "session_id": ""}),
        ):
            with self.subTest(stdout=stdout):
                self.assertIsNone(session_identity("claude", invocation, stdout))

    def test_native_execution_failure_uses_claude_error_envelope(self):
        for subtype, is_error in (("error_during_execution", False), ("error_max_turns", False),
                                  ("success", True)):
            stdout = json.dumps({"type": "result", "subtype": subtype,
                                 "result": "IMPLEMENTATION_COMPLETE", "is_error": is_error})
            with self.subTest(subtype=subtype, is_error=is_error):
                self.assertIn("Claude reported native execution failure", execution_failure("claude", stdout))
        self.assertIsNone(execution_failure("claude", json.dumps({"type": "result", "subtype": "unknown"})))

    def test_claude_multiple_models_do_not_guess_final_model(self):
        output = {"type": "result", "subtype": "success", "is_error": False,
                  "result": VERDICT, "modelUsage": {"one": {}, "two": {}}}
        response = parse_output("claude", self.build("claude", phase="review", session_id="old"), json.dumps(output), "")
        self.assertIsNone(response.model)

    def test_pi_authoritative_final_message_and_resume_file(self):
        invocation = self.build("pi", model={"provider": "custom-provider", "id": "model-id"})
        session_path = invocation.argv[invocation.argv.index("--session") + 1]
        Path(session_path).write_text('{"type":"session","id":"uuid"}\n')
        message = pi_message()
        stdout = jsonl(
            {"type": "session", "id": "uuid"},
            {"type": "message_end", "message": {"role": "toolResult", "content": [{"type": "text", "text": "BLOCKED"}]}},
            {"type": "message_end", "message": message},
            {"type": "agent_end", "messages": [message], "willRetry": False},
            {"type": "agent_settled"},
        )
        response = parse_output("pi", invocation, stdout, "")
        self.assertEqual(response.text, VERDICT)
        self.assertEqual(response.session_id, session_path)
        self.assertEqual(response.model, "test-provider/test-model")
        self.assertEqual(invocation.stdin, "A bounded task.")
        resumed = self.build("pi", phase="revise", session_id=response.session_id)
        self.assertEqual(resumed.argv[resumed.argv.index("--session") + 1], session_path)

    def test_pi_jsonl_preserves_unicode_separators_in_final_text(self):
        invocation = self.build("pi")
        for character in ("\x85", "\u2028", "\u2029"):
            for delimiter in ("\n", "\r\n"):
                text = f"First{character}Second"
                events = [
                    {"type": "message_end", "message": pi_message(text)},
                    {"type": "agent_end"},
                ]
                stdout = delimiter.join(json.dumps(event, ensure_ascii=False) for event in events) + delimiter
                with self.subTest(character=repr(character), delimiter=repr(delimiter)):
                    response = parse_output("pi", invocation, stdout, "")
                    self.assertEqual(response.text, text)
                    self.assertEqual(response.model, "test-provider/test-model")

    def test_pi_last_message_does_not_fall_back_to_earlier_verdict(self):
        invocation = self.build("pi")
        last = pi_message(content=[{"type": "text", "text": "Everything seems fine."}])
        stdout = jsonl({"type": "message_end", "message": pi_message()},
                       {"type": "message_end", "message": last},
                       {"type": "agent_end", "messages": [last]})
        # The runner, not the transport adapter, rejects an invalid verdict.
        self.assertEqual(parse_output("pi", invocation, stdout, "").text, "Everything seems fine.")

    def test_pi_interrupted_or_retrying_run_cannot_approve(self):
        invocation = self.build("pi")
        for reason, retry, include_end in [("error", False, True), ("length", False, True),
                                           ("stop", True, True), ("stop", False, False)]:
            message = pi_message(stopReason=reason)
            events = [{"type": "message_end", "message": message}]
            if include_end:
                events.append({"type": "agent_end", "messages": [message], "willRetry": retry})
            with self.subTest(reason=reason, retry=retry, include_end=include_end), self.assertRaises(ValueError):
                parse_output("pi", invocation, jsonl(*events), "")

    def test_pi_missing_resume_file_is_explicit_error(self):
        with self.assertRaisesRegex(ValueError, "session file is missing"):
            self.build("pi", phase="revise", session_id=str(self.workspace / "missing.jsonl"))

    def test_pi_turn_artifact_prefix_does_not_change_resumed_session_path(self):
        invocation = self.build("pi", artifact_prefix="turn-001.")
        path = Path(invocation.argv[invocation.argv.index("--session") + 1])
        self.assertEqual(path.name, "turn-001.session.jsonl")
        path.write_text('{"type":"session","id":"uuid"}\n')
        resumed = self.build("pi", session_id=str(path), artifact_prefix="turn-002.")
        self.assertEqual(resumed.argv[resumed.argv.index("--session") + 1], str(path))

    def test_pi_session_identity_requires_existing_explicit_session_file(self):
        invocation = self.build("pi")
        path = Path(invocation.argv[invocation.argv.index("--session") + 1])
        self.assertIsNone(session_identity("pi", invocation, jsonl({"type": "session", "id": "uuid"})))
        path.write_text('{"type":"session","id":"uuid"}\n')
        self.assertEqual(session_identity("pi", invocation, "damaged stream"), str(path))
        self.assertIsNone(session_identity("pi", Invocation(["pi"], None), ""))
        self.assertIsNone(session_identity("pi", Invocation(["pi", "--session"], None), ""))
        directory = Invocation(["pi", "--session", str(path.parent)], None)
        self.assertIsNone(session_identity("pi", directory, ""))

    def test_native_execution_failure_uses_pi_final_assistant_error_or_abort(self):
        for reason in ("error", "aborted"):
            message = pi_message(stopReason=reason)
            for events in ([{"type": "message_end", "message": message}, {"type": "agent_end"}],
                           [{"type": "agent_end", "messages": [message]}]):
                stdout = '{"damaged":\n' + jsonl(*events)
                with self.subTest(reason=reason, events=events):
                    self.assertIn(reason, execution_failure("pi", stdout))
        failed_then_recovered = jsonl(
            {"type": "message_end", "message": pi_message(stopReason="error")},
            {"type": "agent_end", "willRetry": True},
            {"type": "message_end", "message": pi_message()},
            {"type": "agent_end", "willRetry": False},
        )
        self.assertIsNone(execution_failure("pi", failed_then_recovered))

    def test_artifact_prefix_cannot_escape_invocation_directory(self):
        for prefix in ("../", "/tmp/", "turn/001.", "turn\0", None):
            with self.subTest(prefix=prefix), self.assertRaisesRegex(ValueError, "artifact_prefix"):
                self.build("codex", artifact_prefix=prefix)

    def test_unrecognized_or_adapter_owned_options_fail_early(self):
        cases = [
            ("codex", ["--output-schema", "other.json"]),
            ("codex", ["--yolo"]),
            ("codex", ["-c", 'sandbox_mode="danger-full-access"']),
            ("claude", ["--resume", "unrelated-session"]),
            ("claude", ["--permission-mode=bypassPermissions"]),
            ("pi", ["--mode", "text"]),
            ("pi", ["--no-session"]),
        ]
        for harness, args in cases:
            with self.subTest(harness=harness, args=args), self.assertRaises(ValueError):
                self.build(harness, args=args)

    def test_provider_is_not_silently_ignored(self):
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness), self.assertRaisesRegex(ValueError, "does not support agent.model.provider"):
                self.build(harness, model={"id": "model", "provider": "custom"})

    def test_duplicate_json_keys_are_rejected(self):
        invocation = self.build("codex")
        invocation.final_path.write_text(VERDICT)
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            parse_output("codex", invocation, '{"type":"turn.failed","type":"turn.completed"}\n', "")
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            parse_output("claude", self.build("claude"),
                         '{"type":"result","subtype":"success","result":"BLOCKED","result":"NO_CHANGES_REQUIRED"}', "")
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            parse_output("pi", self.build("pi"), '{"type":"agent_start","type":"agent_end"}\n', "")

    def test_jsonl_malformed_records_still_fail_at_physical_line_number(self):
        prefix = json.dumps({"type": "progress", "text": "first\u2028second\u2029third"}, ensure_ascii=False)
        for harness in ("codex", "pi"):
            invocation = self.build(harness)
            if invocation.final_path is not None:
                invocation.final_path.write_text(VERDICT)
            suffix = self.codex_stream() if harness == "codex" else jsonl(
                {"type": "message_end", "message": pi_message()}, {"type": "agent_end"},
            )
            for delimiter in ("\n", "\r\n"):
                for malformed in (
                    '{"type":"progress","text":"unterminated}',
                    '{"type":"progress","text":"raw\x1econtrol"}',
                    '{"type":"progress","text":"raw' + delimiter + 'newline"}',
                ):
                    stdout = prefix + delimiter + malformed + delimiter + suffix
                    with self.subTest(harness=harness, delimiter=repr(delimiter), malformed=repr(malformed)):
                        with self.assertRaisesRegex(ValueError, f"Invalid JSON in {harness} stdout line 2:"):
                            parse_output(harness, invocation, stdout, "")

    def test_all_harnesses_receive_exact_authored_prompt_without_schema(self):
        prompt = "Review only what this prompt asks.\n\nWrite /tmp/report.txt.\nReturn NO_CHANGES_REQUIRED.\n"
        for harness in ("codex", "claude", "pi"):
            with self.subTest(harness=harness):
                invocation = self.build(harness, phase="review", prompt=prompt)
                self.assertEqual(invocation.stdin, prompt)
                self.assertNotIn("--output-schema", invocation.argv)
                self.assertNotIn("--json-schema", invocation.argv)
                self.assertFalse((self.workspace / "attempt" / "output-schema.json").exists())
        self.assertEqual(self.build("codex").final_path.name, "harness-result.txt")

    def test_external_attempt_directory_gets_report_access_without_prompt_changes(self):
        with tempfile.TemporaryDirectory(prefix="agent-loop-external-attempt-") as external:
            attempt = Path(external) / "attempt"
            prompt = "Write your report to an external directory.\n"
            for harness in ("codex", "claude"):
                with self.subTest(harness=harness):
                    invocation = self.build(harness, attempt_dir=attempt, prompt=prompt)
                    index = invocation.argv.index("--add-dir")
                    self.assertEqual(invocation.argv[index + 1], str(attempt.resolve()))
                    self.assertEqual(invocation.stdin, prompt)
            resumed = self.build("codex", phase="revise", session_id="thread-123", attempt_dir=attempt)
            self.assertLess(resumed.argv.index("--add-dir"), resumed.argv.index("resume"))
            pi = self.build("pi", attempt_dir=attempt, prompt=prompt)
            self.assertNotIn("--add-dir", pi.argv)
            self.assertEqual(pi.stdin, prompt)

    def test_workspace_attempt_directory_needs_no_extra_access(self):
        for harness in ("codex", "claude", "pi"):
            with self.subTest(harness=harness):
                invocation = self.build(harness)
                self.assertNotIn("--add-dir", invocation.argv)

    def test_plain_final_text_is_preserved_without_inner_json_parsing(self):
        text = ' {"status":"BLOCKED","status":"NO_CHANGES_REQUIRED"}\n'
        codex = self.build("codex")
        codex.final_path.write_text(text)
        self.assertEqual(parse_output("codex", codex, self.codex_stream(), "").text, text)
        envelope = {"type": "result", "subtype": "success", "result": text}
        self.assertEqual(parse_output("claude", self.build("claude"), json.dumps(envelope), "").text, text)
        message = pi_message(text)
        stream = jsonl({"type": "message_end", "message": message}, {"type": "agent_end"})
        self.assertEqual(parse_output("pi", self.build("pi"), stream, "").text, text)

    def test_pi_empty_malformed_or_pending_final_content_is_rejected(self):
        invocation = self.build("pi")
        for content in ([], [{"type": "text", "text": 42}], [None],
                        [{"type": "text", "text": VERDICT}, {"type": "toolCall"}]):
            message = pi_message(content=content)
            stream = jsonl({"type": "message_end", "message": message}, {"type": "agent_end"})
            with self.subTest(content=content), self.assertRaises(ValueError):
                parse_output("pi", invocation, stream, "")


if __name__ == "__main__":
    unittest.main()
