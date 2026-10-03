#!/usr/bin/env python3
"""Deterministic Codex-shaped process used only by integration tests."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    arguments = sys.argv[1:]
    if arguments == ["--version"]:
        print("codex fake-agent-1.0")
        return 0
    prompt = sys.stdin.read()
    output = Path(arguments[arguments.index("-o") + 1])
    round_directory = next(path for path in output.parents if path.parent.name == "rounds")
    run = round_directory.parent.parent
    round_number = int(round_directory.name)
    implementation = output.parent.name == "implementation"
    turn_number = int(output.name.split("-")[1].split(".")[0]) if implementation else None
    phase = ("implement" if round_number == 1 else "revise") if implementation else "review"
    agent_id = "implementer" if implementation else output.parent.parent.name
    report_file = output.parent / "report.txt"
    # Test-only metadata is derived from CLI output paths, never injected into prompts.
    context = {"phase": phase, "round": round_number, "agentId": agent_id,
               "runDirectory": str(run), "reportFile": str(report_file), "turn": turn_number,
               "promptFile": str(output.parent / (f"turn-{turn_number:03d}.prompt.txt" if implementation else "prompt.txt"))}
    if phase == "revise":
        context["feedbackFile"] = str(run / "rounds" / f"{round_number - 1:03d}" / "feedback.json")
    mode = os.environ.get("FAKE_AGENT_MODE", "three-rounds")
    phase = context["phase"]
    round_number = context["round"]
    agent_id = context["agentId"]
    session = (
        arguments[arguments.index("resume") + 1]
        if "resume" in arguments
        else "fake-session-" + uuid.uuid4().hex
    )
    calls = Path(context["runDirectory"]) / "fake-calls"
    calls.mkdir(parents=True, exist_ok=True)
    call = {
        "context": context,
        "arguments": arguments,
        "prompt": prompt,
        "cwd": str(Path.cwd()),
        "mode": mode,
        "session": session,
    }
    call_file = calls / (
        f"{phase}-{round_number}-{agent_id}-{time.time_ns()}-{uuid.uuid4().hex}.json"
    )
    call_file.write_text(json.dumps(call, indent=2) + "\n", encoding="utf-8")
    if mode != "missing-session":
        reported_session = "unexpected-replacement-session" if mode == "session-mismatch" and "resume" in arguments else session
        emit({"type": "thread.started", "thread_id": reported_session})

    is_first_reviewer = agent_id == "correctness"
    if phase == "review" and (is_first_reviewer or mode == "crash-all-reviewers"):
        if mode in {"crash-review", "crash-all-reviewers"}:
            print("Fake reviewer process crashed", file=sys.stderr)
            return 17
        if mode == "malformed-review":
            output.write_text('{"status":', encoding="utf-8")
            emit({"type": "turn.completed", "usage": {}})
            return 0
        if mode == "sleep-review":
            time.sleep(5)
        if mode == "mutate-review":
            Path("implementation.txt").write_text(
                "Reviewer illegally changed source.\n", encoding="utf-8"
            )

    if phase in ("implement", "revise"):
        if mode == "blocked-implementer" or (mode == "blocked-twice-two-rounds" and round_number == 1 and turn_number <= 2):
            status = "BLOCKED"
            report = "Specification is ambiguous; user input is required."
        else:
            Path("implementation.txt").write_text(
                f"Implemented round {round_number}.\n", encoding="utf-8"
            )
            if mode == "crash-implementation":
                print("Fake implementer process crashed after saving partial work", file=sys.stderr)
                return 19
            if mode == "sleep-implementation":
                time.sleep(5)
            if mode == "commit-implementer" and phase == "implement":
                git_environment = os.environ.copy()
                git_environment["GIT_CONFIG_GLOBAL"] = os.devnull
                git_environment["GIT_CONFIG_NOSYSTEM"] = "1"
                subprocess.run(
                    [
                        "git", "-c", "user.name=Fake Implementer",
                        "-c", "user.email=fake-implementer@example.invalid",
                        "-c", "commit.gpgsign=false",
                        "-c", f"core.hooksPath={os.devnull}",
                        "commit", "--only", "-qm", "Fake implementer committed work",
                        "--", "implementation.txt",
                    ],
                    env=git_environment, check=True, capture_output=True, text=True,
                )
            status = "IMPLEMENTATION_COMPLETE"
            report = f"Implementation completed for round {round_number}."
            if mode == "blocked-revision" and phase == "revise":
                status = "BLOCKED"
                report = "Partial revision saved; required verification is unavailable."
    elif mode in {"blocked-review", "blocked-review-with-changes"} and is_first_reviewer:
        status = "BLOCKED"
        report = "Required review environment is unavailable."
    elif (mode in {"blocked-twice-two-rounds", "blocked-review-with-changes"} and round_number == 1 and (is_first_reviewer or mode == "blocked-review-with-changes")) or mode in {"three-rounds", "blocked-revision", "malformed-revision"} and (
        (round_number == 1 and is_first_reviewer)
        or (round_number == 2 and agent_id == "edge-cases")
    ):
        status = "CHANGES_REQUIRED"
        report = f"A blocking defect remains in round {round_number}."
        report += "\nBlocking: resolve the fixture defect reproduced by the test."
    else:
        status = "NO_CHANGES_REQUIRED"
        report = "Review completed; no blocking defects were found."
        report += "\nAdvisory: optional wording improvement; existing behavior satisfies the specification."

    if phase == "review" and is_first_reviewer:
        if mode == "mixed-verdict-review":
            status = "CHANGES_REQUIRED\nNO_CHANGES_REQUIRED"
        if mode == "repeated-verdict-review":
            status = "Verdict: NO_CHANGES_REQUIRED\nNO_CHANGES_REQUIRED"
        if mode == "prose-verdict-review":
            status = "Review complete. Tests and independent CLI checks passed.\n\nNO_CHANGES_REQUIRED"
        if mode == "wrong-role-review":
            status = "IMPLEMENTATION_COMPLETE"
        if mode == "old-json-review":
            status = json.dumps({"status": status, "report": report, "findings": []})
        if mode == "empty-report":
            report = "  \n"
        if mode == "symlink-report":
            report_file.symlink_to(Path.cwd() / "spec.md")
        elif mode == "directory-report":
            report_file.mkdir()
        elif mode == "nonutf8-report":
            report_file.write_bytes(b"\xff")
        elif mode != "missing-report":
            report_file.write_text(report, encoding="utf-8")
        if mode == "crash-after-report":
            output.write_text(status, encoding="utf-8")
            return 23
    elif mode != "missing-implementation-report" or phase == "review":
        report_file.write_text(report, encoding="utf-8")
    if phase in ("implement", "revise") and mode == "modify-config":
        configuration = Path("config/loop.json")
        configuration.write_bytes(configuration.read_bytes() + b"\n")
    if phase in ("implement", "revise") and mode == "invalid-implementation-status":
        status = "The work looks good to me."
    if phase in ("implement", "revise") and mode == "conflicting-implementation-status":
        status = "BLOCKED\nIMPLEMENTATION_COMPLETE"
    if (mode == "malformed-implementation" and phase == "implement") or (
        mode == "malformed-revision" and phase == "revise"
    ):
        # A successfully exited CLI can still leave an invalid event stream.
        # Its authored report and final output should not turn that into success.
        print('{"type":"item.completed","item":', flush=True)
    output.write_text(status + "\n", encoding="utf-8")
    emit({
        "type": "item.completed",
        "item": {"id": "fake-final", "type": "agent_message", "text": status},
    })
    if phase in ("implement", "revise") and mode == "native-turn-failed":
        emit({"type": "turn.failed", "error": {"message": "Native implementation panic despite zero CLI exit"}})
        return 0
    emit({
        "type": "turn.completed",
        "usage": {"input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1},
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
