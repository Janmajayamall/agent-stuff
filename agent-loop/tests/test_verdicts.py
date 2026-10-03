"""Status extraction from completed agent responses, without native CLI calls."""

import json
import unittest

from agentloop.adapters import Invocation, parse_output
from agentloop.runner import validate_status


class VerdictTests(unittest.TestCase):
    def test_plain_statuses_remain_valid_for_their_roles(self):
        statuses = {
            "review": ("CHANGES_REQUIRED", "NO_CHANGES_REQUIRED", "BLOCKED"),
            "implement": ("IMPLEMENTATION_COMPLETE", "BLOCKED"),
            "revise": ("IMPLEMENTATION_COMPLETE", "BLOCKED"),
        }
        for phase, allowed in statuses.items():
            for status in allowed:
                with self.subTest(phase=phase, status=status):
                    self.assertEqual(validate_status(" \n" + status + "\n", phase), status)

    def test_one_whole_status_can_appear_anywhere_in_prose_or_markup(self):
        wrappers = (
            "{}: verification passed.",
            "Review complete. {}. Report saved.",
            "Review complete.\n\n{}",
            "**{}**",
            "`{}`",
            "```text\n{}\n```",
            '{{"status": "{}", "summary": "Review complete."}}',
        )
        for status in ("CHANGES_REQUIRED", "NO_CHANGES_REQUIRED", "BLOCKED"):
            for wrapper in wrappers:
                with self.subTest(status=status, wrapper=wrapper):
                    self.assertEqual(validate_status(wrapper.format(status), "review"), status)

    def test_implementation_and_revision_accept_one_status_in_prose(self):
        for phase in ("implement", "revise"):
            for status in ("IMPLEMENTATION_COMPLETE", "BLOCKED"):
                with self.subTest(phase=phase, status=status):
                    self.assertEqual(validate_status("Result: " + status + ". See report.", phase), status)

    def test_approval_does_not_also_match_embedded_changes_required(self):
        self.assertEqual(validate_status("NO_CHANGES_REQUIRED", "review"), "NO_CHANGES_REQUIRED")

    def test_missing_or_nonstring_status_fails(self):
        for text in (None, True, 1, {}, ["NO_CHANGES_REQUIRED"], b"NO_CHANGES_REQUIRED", "", " \n", "All checks pass."):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "exactly one status token"):
                validate_status(text, "review")

    def test_lowercase_or_embedded_word_is_not_a_status(self):
        for text in (
            "no_changes_required", "No_Changes_Required", "UNBLOCKED", "BLOCKEDNESS",
            "NOT_NO_CHANGES_REQUIRED", "NO_CHANGES_REQUIRED_EXTRA", "NO_CHANGES_REQUIRED2",
            "prefixNO_CHANGES_REQUIRED", "NO_CHANGES_REQUIREDsuffix", "éBLOCKED", "BLOCKEDé",
        ):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "exactly one status token"):
                validate_status(text, "review")

    def test_a_single_wrong_role_status_fails(self):
        for phase, text in (
            ("review", "The work is IMPLEMENTATION_COMPLETE."),
            ("implement", "NO_CHANGES_REQUIRED"),
            ("revise", "CHANGES_REQUIRED"),
        ):
            with self.subTest(phase=phase, text=text), self.assertRaisesRegex(ValueError, "exactly one status token"):
                validate_status(text, phase)

    def test_multiple_status_occurrences_fail_even_when_identical(self):
        for text in (
            "CHANGES_REQUIRED\nNO_CHANGES_REQUIRED",
            "NO_CHANGES_REQUIRED but also BLOCKED",
            "NO_CHANGES_REQUIRED\nNO_CHANGES_REQUIRED",
            "The instructions mention BLOCKED. My verdict is NO_CHANGES_REQUIRED.",
            "NO_CHANGES_REQUIRED\nIMPLEMENTATION_COMPLETE",
            "BLOCKED, BLOCKED",
        ):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "exactly one status token"):
                validate_status(text, "review")
        for phase in ("implement", "revise"):
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                validate_status("IMPLEMENTATION_COMPLETE\nCHANGES_REQUIRED", phase)

    def test_claude_summary_followed_by_verdict_is_accepted(self):
        final = (
            "Review complete. I checked each operation, input rejection, help output, "
            "and exit codes. The automated suite and independent CLI checks passed. "
            "My full review is saved in the report file.\n\nNO_CHANGES_REQUIRED"
        )
        envelope = {
            "type": "result", "subtype": "success", "is_error": False,
            "session_id": "fixture-session", "result": final,
            "structured_output": {"status": "CHANGES_REQUIRED"},
        }
        response = parse_output("claude", Invocation([], ""), json.dumps(envelope), "BLOCKED")
        self.assertEqual(response.text, final)
        self.assertEqual(validate_status(response.text, "review"), "NO_CHANGES_REQUIRED")


if __name__ == "__main__":
    unittest.main()
