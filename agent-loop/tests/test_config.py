"""Validate configuration and prompt inputs without launching any processes."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from agentloop.config import load_config, prepare_prompts, render_instructions


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-loop-config-test-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = (Path(self.temporary.name) / "workspace").resolve()
        self.workspace.mkdir()
        (self.workspace / "config").mkdir()
        self.config_file = self.workspace / "config" / "loop.json"

    @staticmethod
    def valid_config():
        return {
            "version": 1,
            "name": "configuration-test",
            "agents": {
                "implementer": {
                    "id": "implementer", "harness": "codex", "command": sys.executable,
                    "instructions": {
                        "implement": {"text": "Implement the specification."},
                        "revise": {"text": "Address the review feedback: {{reviewDetails}}"},
                    },
                },
                "reviewers": [
                    {
                        "id": "correctness", "harness": "codex", "command": sys.executable,
                        "instructions": {"text": "Review correctness in {{workspace}}; write {{review_file}}."},
                    },
                    {
                        "id": "edge-cases", "harness": "codex", "command": sys.executable,
                        "instructions": {"text": "Review edge cases."},
                    },
                ],
            },
            "runsDirectory": ".agent-loop/runs",
        }

    def load(self, config):
        self.config_file.write_text(json.dumps(config), encoding="utf-8")
        return load_config(self.config_file, self.workspace)

    @staticmethod
    def set_instruction(config, phase, prompt):
        if phase == "review":
            config["agents"]["reviewers"][0]["instructions"] = prompt
        else:
            config["agents"]["implementer"]["instructions"][phase] = prompt

    def implementation_text(self, resolved):
        return render_instructions(resolved["implementer"]["implement"], {})

    def test_agent_ids_are_unique_across_roles_and_reviewers(self):
        for duplicate in ("implementer", "correctness"):
            with self.subTest(duplicate=duplicate):
                config = self.valid_config()
                config["agents"]["reviewers"][1]["id"] = duplicate
                with self.assertRaisesRegex(ValueError, "unique"):
                    self.load(config)

    def test_optional_timeouts_reject_nonpositive_and_noninteger_values(self):
        for field in ("agentTimeoutSeconds", "checkTimeoutSeconds"):
            for value in (0, -1, True, False, None, "30", 1.5):
                with self.subTest(field=field, value=value):
                    config = self.valid_config()
                    config["limits"] = {field: value}
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        self.load(config)

    def test_omitted_timeouts_remain_unlimited(self):
        config = self.load(self.valid_config())
        self.assertEqual(config["limits"]["maxRounds"], 5)
        self.assertNotIn("agentTimeoutSeconds", config["limits"])
        self.assertNotIn("checkTimeoutSeconds", config["limits"])

    def test_missing_prompt_files_and_references_fail_without_starting_processes(self):
        missing_inputs = (
            {"file": "missing-prompt.md"},
            {"text": "Read @missing-spec.md before implementation."},
        )
        for prompt in missing_inputs:
            with self.subTest(prompt=prompt):
                config = self.valid_config()
                self.set_instruction(config, "implement", prompt)
                with patch("subprocess.Popen", side_effect=AssertionError("Input validation must not launch agents")) as spawn:
                    loaded = self.load(config)
                    with self.assertRaises(FileNotFoundError):
                        prepare_prompts(loaded, self.workspace)
                    spawn.assert_not_called()

    def test_quoted_file_reference_accepts_spaces_and_unicode_without_inlining_content(self):
        source = self.workspace / "reference docs" / "spec with spaces δ.md"
        source.parent.mkdir()
        content = "Specification with Unicode: δ.\n"
        source.write_text(content, encoding="utf-8")
        config = self.valid_config()
        self.set_instruction(config, "implement", {
            "text": 'Implement this specification: @"reference docs/spec with spaces δ.md"',
        })
        resolved, inputs = prepare_prompts(self.load(config), self.workspace)
        actual = self.implementation_text(resolved)
        self.assertEqual(actual, f"Implement this specification: {json.dumps(str(source), ensure_ascii=False)}")
        self.assertNotIn(content, actual)
        self.assertNotIn("@", actual)
        self.assertEqual(set(inputs), {str(source)})
        self.assertEqual(inputs[str(source)]["data"], content.encode("utf-8"))
        self.assertEqual(inputs[str(source)]["sha256"], hashlib.sha256(content.encode("utf-8")).hexdigest())

    def test_references_and_variables_inside_referenced_files_are_not_parsed(self):
        source = self.workspace / "spec.md"
        content = "Keep @missing-second-file.md, {{unknown}}, {{reviewDetails}}, and malformed {{ literal.\n"
        source.write_text(content, encoding="utf-8")
        config = self.valid_config()
        self.set_instruction(config, "implement", {"text": "Read @spec.md"})
        resolved, inputs = prepare_prompts(self.load(config), self.workspace)
        actual = self.implementation_text(resolved)
        self.assertEqual(actual, f"Read {json.dumps(str(source))}")
        self.assertNotIn(content, actual)
        self.assertEqual(set(inputs), {str(source)})
        self.assertEqual(inputs[str(source)]["data"], content.encode("utf-8"))

    def test_non_utf8_instruction_files_are_rejected(self):
        binary = self.workspace / "binary.dat"
        binary.write_bytes(b"\x89PNG\r\n\x1a\n\xff")
        config = self.valid_config()
        self.set_instruction(config, "implement", {"file": "binary.dat"})
        with self.assertRaises(UnicodeDecodeError):
            prepare_prompts(self.load(config), self.workspace)

    def test_binary_references_are_paths_and_snapshot_exact_bytes(self):
        binary = self.workspace / "binary.dat"
        data = b"\x89PNG\r\n\x1a\n\xff\x00{{unknown}}@missing.md"
        binary.write_bytes(data)
        config = self.valid_config()
        self.set_instruction(config, "implement", {"text": "Inspect @binary.dat"})
        resolved, inputs = prepare_prompts(self.load(config), self.workspace)
        self.assertEqual(self.implementation_text(resolved), f"Inspect {json.dumps(str(binary))}")
        self.assertEqual(inputs, {
            str(binary): {"data": data, "sha256": hashlib.sha256(data).hexdigest()},
        })

    def test_template_syntax_inside_referenced_path_stays_literal(self):
        source = self.workspace / "spec {{unknown}} {{reviewDetails}}.md"
        source.write_text("A specification the agent must read.", encoding="utf-8")
        config = self.valid_config()
        self.set_instruction(config, "implement", {
            "text": 'Read @"spec {{unknown}} {{reviewDetails}}.md" in {{workspace}}.',
        })
        resolved, inputs = prepare_prompts(self.load(config), self.workspace)
        actual = render_instructions(resolved["implementer"]["implement"], {"workspace": str(self.workspace)})
        self.assertEqual(actual, f"Read {json.dumps(str(source))} in {self.workspace}.")
        self.assertNotIn("@", actual)
        self.assertEqual(set(inputs), {str(source)})

    def test_storage_cannot_be_workspace_parent_or_git_metadata(self):
        for path in (".", "..", str(self.workspace), str(self.workspace.parent), ".git/runs"):
            with self.subTest(path=path):
                config = self.valid_config()
                config["runsDirectory"] = path
                with self.assertRaisesRegex(ValueError, "runsDirectory"):
                    self.load(config)

    def test_unknown_top_level_fields_rejected(self):
        for key in ("prompts", "documents", "executionProfiles"):
            with self.subTest(key=key):
                config = self.valid_config()
                config[key] = {}
                with self.assertRaisesRegex(ValueError, f"Unknown config fields: {key}"):
                    self.load(config)

    def test_instruction_definitions_are_required_and_exclusive(self):
        invalid = ({}, {"text": "x", "file": "x.md"}, {"other": "x"}, {"text": ""}, {"text": None}, "raw")
        for phase in ("implement", "revise", "review"):
            for definition in invalid:
                with self.subTest(phase=phase, definition=definition):
                    config = self.valid_config()
                    self.set_instruction(config, phase, definition)
                    with self.assertRaises(ValueError):
                        self.load(config)
        for position in ("implementer", "reviewer"):
            with self.subTest(position=position):
                config = self.valid_config()
                agent = config["agents"]["implementer"] if position == "implementer" else config["agents"]["reviewers"][0]
                del agent["instructions"]
                with self.assertRaisesRegex(ValueError, "instructions must be an object"):
                    self.load(config)
        for phase in ("implement", "revise"):
            config = self.valid_config()
            del config["agents"]["implementer"]["instructions"][phase]
            with self.assertRaisesRegex(ValueError, "must define implement and revise"):
                self.load(config)

    def test_paths_resolve_from_invocation_directory_and_prompts_are_frozen(self):
        prompts = self.workspace / "prompts"
        prompts.mkdir()
        prompt = prompts / "implementation.md"
        prompt.write_text("Implement @spec.md in {{workspace}}.", encoding="utf-8")
        spec = self.workspace / "spec.md"
        spec.write_text("Use whole numbers.", encoding="utf-8")
        # These differently located files must never be used.
        (prompts / "spec.md").write_text("WRONG prompt-relative specification", encoding="utf-8")
        (self.config_file.parent / "spec.md").write_text("WRONG config-relative specification", encoding="utf-8")
        config = self.valid_config()
        self.set_instruction(config, "implement", {"file": "prompts/implementation.md"})
        resolved, inputs = prepare_prompts(self.load(config), self.workspace)
        frozen = json.loads(json.dumps(resolved))
        prompt.write_text("Changed prompt", encoding="utf-8")
        spec.write_text("Changed specification", encoding="utf-8")
        actual = render_instructions(frozen["implementer"]["implement"], {"workspace": str(self.workspace)})
        self.assertEqual(actual, f"Implement {json.dumps(str(spec))} in {self.workspace}.")
        self.assertNotIn("Use whole numbers.", actual)
        self.assertNotIn("WRONG", actual)
        self.assertNotIn("Changed", actual)
        self.assertTrue(actual.endswith(f" in {self.workspace}."))
        self.assertEqual(set(inputs), {str(prompt), str(spec)})
        self.assertEqual(inputs[str(prompt)]["data"], b"Implement @spec.md in {{workspace}}.")
        self.assertEqual(inputs[str(spec)]["data"], b"Use whole numbers.")

    def test_review_instructions_are_the_whole_prompt_with_no_appended_text(self):
        config = self.valid_config()
        self.set_instruction(config, "review", {"text": "Inspect {{workspace}}; report to {{review_file}}."})
        resolved, _ = prepare_prompts(self.load(config), self.workspace)
        actual = render_instructions(resolved["correctness"]["review"], {"workspace": "/repo", "review_file": "/run/report.txt"})
        self.assertEqual(actual, "Inspect /repo; report to /run/report.txt.")
        self.assertEqual(set(resolved), {"implementer", "correctness", "edge-cases"})
        self.assertEqual(set(resolved["implementer"]), {"implement", "revise"})

    def test_continuation_instruction_is_rejected(self):
        config = self.valid_config()
        self.set_instruction(config, "continuation", {"text": "Continue."})
        with self.assertRaisesRegex(ValueError, "Unknown .*instructions fields: continuation"):
            self.load(config)

    def test_variable_values_are_inserted_once_and_remain_literal(self):
        config = self.valid_config()
        self.set_instruction(config, "revise", {"text": "{{workspace}}\n{{reviewDetails}}\n{{review_file}}"})
        resolved, _ = prepare_prompts(self.load(config), self.workspace)
        variables = {
            "workspace": "/repo/{{reviewDetails}}/@missing.md",
            "reviewDetails": "Reviews:\n- /run/{{workspace}}/@other.md — CHANGES_REQUIRED",
            "review_file": "/run/{{unknown}}/report.txt",
        }
        actual = render_instructions(resolved["implementer"]["revise"], variables)
        self.assertEqual(actual, "\n".join(variables.values()))

    def test_common_variables_work_in_all_phases_and_review_details_only_in_revise(self):
        for phase in ("implement", "revise", "review"):
            with self.subTest(phase=phase):
                config = self.valid_config()
                self.set_instruction(config, phase, {"text": "{{workspace}} {{review_file}}"})
                resolved, _ = prepare_prompts(self.load(config), self.workspace)
                ident = "correctness" if phase == "review" else "implementer"
                self.assertEqual(render_instructions(resolved[ident][phase], {"workspace": "one", "review_file": "two"}), "one two")
                self.set_instruction(config, phase, {"text": "{{reviewDetails}}"})
                if phase == "revise":
                    resolved, _ = prepare_prompts(self.load(config), self.workspace)
                    self.assertEqual(render_instructions(resolved[ident][phase], {"reviewDetails": "latest reviews"}), "latest reviews")
                else:
                    with self.assertRaisesRegex(ValueError, "only in revise"):
                        prepare_prompts(self.load(config), self.workspace)

    def test_unknown_and_malformed_variables_fail_before_any_process_launch(self):
        invalid = (
            ("{{unknown}}", "Unknown template variable"),
            ("{{round}}", "Unknown template variable"),
            ("{{workspace}", "Malformed template variable"),
            ("workspace}}", "Malformed template variable"),
            ("{{}}", "Malformed template variable"),
            ("{{review file}}", "Malformed template variable"),
            ("{{workspace {{review_file}}", "Malformed template variable"),
            ("{{{workspace}}}", "Malformed template variable"),
            ("{{workspace}}}", "Malformed template variable"),
        )
        for text, message in invalid:
            with self.subTest(text=text):
                config = self.valid_config()
                self.set_instruction(config, "review", {"text": text})
                with patch("subprocess.Popen", side_effect=AssertionError("No processes during validation")) as spawn:
                    with self.assertRaisesRegex(ValueError, message):
                        prepare_prompts(self.load(config), self.workspace)
                    spawn.assert_not_called()

    def test_variable_validation_applies_to_authored_instruction_files(self):
        prompt = self.workspace / "review.md"
        prompt.write_text("Review {{reviewDetails}}", encoding="utf-8")
        config = self.valid_config()
        self.set_instruction(config, "review", {"file": "review.md"})
        with self.assertRaisesRegex(ValueError, "only in revise"):
            prepare_prompts(self.load(config), self.workspace)

    def test_missing_runtime_variable_fails_instead_of_rendering_unresolved_placeholder(self):
        config = self.valid_config()
        resolved, _ = prepare_prompts(self.load(config), self.workspace)
        with self.assertRaisesRegex(ValueError, "Missing value.*workspace"):
            render_instructions(resolved["correctness"]["review"], {"review_file": "/run/report.txt"})

    def test_literal_single_braces_and_spaced_variable_syntax(self):
        config = self.valid_config()
        self.set_instruction(config, "implement", {"text": 'Return {"example": 1} in {{ workspace }}.'})
        resolved, _ = prepare_prompts(self.load(config), self.workspace)
        self.assertEqual(render_instructions(resolved["implementer"]["implement"], {"workspace": "/repo"}), 'Return {"example": 1} in /repo.')


if __name__ == "__main__":
    unittest.main()
