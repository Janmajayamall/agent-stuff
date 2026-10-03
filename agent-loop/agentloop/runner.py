"""Deterministic orchestration; agents supply work and findings, not control flow."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from .adapters import build_command, execution_failure, parse_output, session_identity
from .config import absolute, load_config, prepare_prompts, render_instructions
from .workspace import fingerprint, git, save_snapshot

def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class AgentFailure(ValueError):
    def __init__(self, message: str, stage: str):
        super().__init__(message)
        self.stage = stage


class TerminalFailure(ValueError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


STATUS_TOKEN = re.compile(r"\b(?:IMPLEMENTATION_COMPLETE|NO_CHANGES_REQUIRED|CHANGES_REQUIRED|BLOCKED)\b")


def validate_status(text: object, phase: str) -> str:
    """Extract one whole status token from the authoritative final response."""
    allowed = {"CHANGES_REQUIRED", "NO_CHANGES_REQUIRED", "BLOCKED"} if phase == "review" else {"IMPLEMENTATION_COMPLETE", "BLOCKED"}
    matches = STATUS_TOKEN.findall(text) if isinstance(text, str) else []
    if len(matches) != 1 or matches[0] not in allowed:
        raise ValueError(f"Final {phase} response must contain exactly one status token ({', '.join(sorted(allowed))}); found {len(matches)} known status tokens")
    return matches[0]


def read_report(path: Path) -> tuple[str, str]:
    """Only accept a nonempty, independently authored regular report file."""
    if not path.exists() or not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_nlink != 1:
        raise ValueError(f"Agent must write a new regular report file at {path}")
    data = path.read_bytes()
    report = data.decode("utf-8")
    if not report.strip():
        raise ValueError(f"Agent report is empty: {path}")
    return report, hashlib.sha256(data).hexdigest()


@contextlib.contextmanager
def workspace_lock(workspace: Path):
    directory = workspace / ".agent-loop"
    directory.mkdir(exist_ok=True)
    with (directory / "workspace.lock").open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another agent-loop process already owns this workspace") from None
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()) + "\n")
        handle.flush()
        yield


class Processes:
    def __init__(self):
        self.active: set[subprocess.Popen] = set()
        self.lock = threading.Lock()
        self.cancelled = False

    @staticmethod
    def stop(process: subprocess.Popen) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        # A leader can exit while a descendant ignores TERM. Inspect the group,
        # not just Popen.returncode, before releasing the workspace lock.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

    def stop_all(self) -> None:
        with self.lock:
            self.cancelled = True
            active = list(self.active)
        errors = []
        for process in active:
            try:
                self.stop(process)
            except Exception as error:
                errors.append(error)
        if errors:
            raise ValueError("Could not stop every child process: " + "; ".join(map(str, errors)))

    def run(self, argv: list[str], stdin: str | None, cwd: Path, directory: Path, timeout: int | None,
            *, log_prefix: str = "") -> int:
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / f"{log_prefix}stdout.log").open("wb") as stdout, (directory / f"{log_prefix}stderr.log").open("wb") as stderr:
            process = None
            try:
                with self.lock:
                    if self.cancelled:
                        raise ValueError("Run cancelled before process launch")
                    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, start_new_session=True)
                    self.active.add(process)
            except BaseException:
                if process is not None:
                    self.stop(process)
                raise
            try:
                process.communicate(None if stdin is None else stdin.encode(), timeout=timeout)
                return process.returncode
            except BaseException:
                self.stop(process)
                raise
            finally:
                with self.lock:
                    self.active.discard(process)


class Runner:
    def __init__(self, run: Path, manifest: dict, state: dict):
        self.run = run
        self.manifest = manifest
        self.config = manifest["config"]
        self.workspace = Path(manifest["workspace"])
        self.runs = Path(self.config["runsDirectory"])
        self.prompts = read_json(run / "inputs" / "resolved-prompts.json")
        self.state = state
        self.processes = Processes()
        self.events_lock = threading.Lock()

    def save(self, **updates) -> None:
        self.state.update(updates, updatedAt=now())
        write_json(self.run / "state.json", self.state)

    def event(self, kind: str, **data) -> None:
        with self.events_lock:
            with (self.run / "events.jsonl").open("a", encoding="utf-8") as output:
                output.write(json.dumps({"time": now(), "event": kind, **data}) + "\n")

    def finish(self, status: str, reason: str, code: int) -> int:
        self.save(status=status, reason=reason)
        self.event("run.finished", status=status, reason=reason)
        (self.run / "summary.txt").write_text(f"{status}\n{reason}\nRound: {self.state['round']}\nRun: {self.run}\n", encoding="utf-8")
        print(f"{status}: {reason}\nRun: {self.run}", flush=True)
        return code

    def assert_workspace(self, expected: str) -> None:
        if fingerprint(self.workspace, self.runs)["sha256"] != expected:
            raise ValueError("Workspace changed during active checks or review")

    def assert_config(self) -> None:
        try:
            digest = hashlib.sha256(Path(self.manifest["configPath"]).read_bytes()).hexdigest()
        except OSError:
            digest = None
        if digest != self.manifest["configSha256"]:
            raise TerminalFailure("CONFIG_CHANGED", "Original loop configuration changed or is missing. This run cannot resume; start a new run.")

    @staticmethod
    def latest_attempt(directory: Path) -> Path | None:
        attempts = [p for p in directory.glob("attempt-*") if p.is_dir()]
        return max(attempts, key=lambda p: int(p.name.split("-")[1]), default=None)

    @staticmethod
    def attempt(directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        number = 1 + max([int(p.name.split("-")[1]) for p in directory.glob("attempt-*") if p.is_dir()] or [0])
        attempt = directory / f"attempt-{number:02d}"
        attempt.mkdir()
        return attempt

    def review_details(self) -> str:
        number = self.state["round"] - 1
        feedback = read_json(self.run / "rounds" / f"{number:03d}" / "feedback.json")
        candidate = read_json(Path(feedback["candidateManifestFile"]))
        if feedback["reviewedRound"] != number or feedback["candidateSha256"] != candidate["sha256"]:
            raise ValueError("Revision feedback does not match the preceding candidate")
        lines = [f"Reviews from round {number}:"]
        for review in feedback["reviews"]:
            if review["status"] == "SKIPPED":
                lines.extend(["", f"- {review['agentId']} — SKIPPED by user"])
                continue
            _, digest = read_report(Path(review["reportFile"]))
            if digest != review["reportSha256"]:
                raise ValueError(f"Review report changed after validation: {review['reportFile']}")
            lines.extend(["", f"- {review['agentId']} — {review['status']}", f"  {review['reportFile']}"])
        if any(not check["passed"] for check in feedback["checks"]):
            lines.extend(["", "- Required checks — FAILED", f"  {feedback['checksReportFile']}"])
        return "\n".join(lines)

    def remember_session(self, identity: str | None) -> None:
        previous = self.state.get("implementerSessionId")
        if identity and previous and identity != previous:
            raise TerminalFailure("SESSION_UNAVAILABLE", "Implementer returned a different session ID; refusing to replace the run's original session.")
        if identity and not previous:
            self.save(implementerSessionId=identity)
            self.event("implementer.session", sessionId=identity)

    @staticmethod
    def last_turn(directory: Path) -> int:
        return max((int(p.name.split(".")[0].split("-")[1])
                    for p in directory.glob("turn-*.prompt.txt")), default=0)

    def invoke(self, agent: dict, phase: str, directory: Path, *, candidate: str | None = None,
               followup: str | None = None) -> dict:
        implementing = phase != "review"
        round_number = self.state["round"]
        directory.mkdir(parents=True, exist_ok=True)
        turn = self.last_turn(directory) + 1 if implementing else None
        attempt = directory if implementing else self.attempt(directory)
        prefix = f"turn-{turn:03d}." if implementing else ""
        def artifact(name: str) -> Path:
            return attempt / (prefix + name)

        session = self.state.get("implementerSessionId") if implementing else None
        if implementing and (round_number > 1 or turn > 1) and not session:
            raise TerminalFailure("SESSION_UNAVAILABLE", "Original implementer session is unavailable; a new conversation cannot be substituted.")
        if implementing and agent["harness"] == "pi" and session and not Path(session).is_file():
            raise TerminalFailure("SESSION_UNAVAILABLE", f"Original Pi session file is missing: {session}")
        report_file = attempt / "report.txt"
        if implementing and (report_file.exists() or report_file.is_symlink()):
            # Keep an immutable copy of the prior turn, including any report the
            # user edited during the halt. Do not follow an invalid symlink.
            report_file.rename(artifact("previous-report"))
        if followup is None:
            values = {"workspace": str(self.workspace), "review_file": str(report_file)}
            if phase == "revise":
                values["reviewDetails"] = self.review_details()
            prompt = render_instructions(self.prompts[agent["id"]][phase], values)
        else:
            prompt = followup
        artifact("prompt.txt").write_text(prompt, encoding="utf-8")
        self.assert_config()
        self.event("agent.started", agentId=agent["id"], phase=phase, round=round_number,
                   attempt=str(attempt), turn=turn, sessionId=session)
        print(f"Round {round_number}: {phase} / {agent['id']}", flush=True)
        failure_stage = "execution"
        process = {"status": "starting", "exitCode": None}
        invocation = None
        try:
            invocation = build_command(agent, prompt=prompt, workspace=self.workspace, attempt_dir=attempt,
                                       phase=phase, session_id=session, artifact_prefix=prefix)
            write_json(artifact("invocation.json"), {"argv": invocation.argv, "cwd": str(self.workspace),
                       "sessionId": session, "timeoutSeconds": self.config["limits"].get("agentTimeoutSeconds"),
                       "turn": turn, "followup": followup is not None})
            process.update(status="running", startedAt=now())
            write_json(artifact("process.json"), process)
            code = self.processes.run(invocation.argv, invocation.stdin, self.workspace, attempt,
                                      self.config["limits"].get("agentTimeoutSeconds"), log_prefix=prefix)
            process.update(status="exited", exitCode=code, finishedAt=now())
            failure_stage = "result" if code == 0 else "execution"
            write_json(artifact("process.json"), process)
            if code:
                raise AgentFailure(f"Agent {agent['id']} exited {code}; see {artifact('stderr.log')}", "execution")
            stdout = artifact("stdout.log").read_text(errors="replace")
            panic = execution_failure(agent["harness"], stdout)
            if panic:
                failure_stage = "execution"
                raise AgentFailure(panic, "execution")
            if implementing:
                try:
                    self.remember_session(session_identity(agent["harness"], invocation, stdout))
                except ValueError as error:
                    raise TerminalFailure("SESSION_UNAVAILABLE", str(error)) from error
                if not self.state.get("implementerSessionId"):
                    raise TerminalFailure("SESSION_UNAVAILABLE", "Agent exited without a recoverable implementer session; cannot resume this run.")
            self.assert_config()
            response = parse_output(agent["harness"], invocation, stdout, artifact("stderr.log").read_text(errors="replace"))
            if implementing:
                self.remember_session(response.session_id)
            status = validate_status(response.text, phase)
            report, digest = read_report(report_file)
            result = {"status": status, "report": report, "reportSha256": digest,
                      "agentId": agent["id"], "harness": agent["harness"], "configuredModel": agent.get("model"),
                      "reportedModel": response.model,
                      "sessionId": self.state.get("implementerSessionId") if implementing else response.session_id,
                      "usage": response.usage, "round": round_number, "phase": phase, "candidateSha256": candidate,
                      "reportFile": str(report_file), "resultFile": str(artifact("result.json"))}
            if implementing:
                result["archivedReportFile"] = str(artifact("report.txt"))
            write_json(artifact("result.json"), result)
            self.event("agent.finished", agentId=agent["id"], phase=phase, round=round_number, status=result["status"], resultFile=result["resultFile"])
            return result
        except (Exception, KeyboardInterrupt) as error:
            interrupted = isinstance(error, KeyboardInterrupt)
            timed_out = isinstance(error, subprocess.TimeoutExpired)
            if implementing and invocation and artifact("stdout.log").exists() and not isinstance(error, TerminalFailure):
                try:
                    self.remember_session(session_identity(agent["harness"], invocation, artifact("stdout.log").read_text(errors="replace")))
                except ValueError as session_error:
                    if failure_stage == "result":
                        error = TerminalFailure("SESSION_UNAVAILABLE", str(session_error))
            if process["status"] != "exited":
                process.update(status="interrupted" if interrupted else "failed", finishedAt=now(), timedOut=timed_out)
                write_json(artifact("process.json"), process)
            message = f"Agent {agent['id']} exceeded its timeout" if timed_out else ("Agent interrupted" if interrupted else str(error))
            write_json(artifact("error.json"), {"error": message, "time": now(), "failureStage": failure_stage})
            self.event("agent.failed", agentId=agent["id"], phase=phase, round=round_number, error=message, failureStage=failure_stage)
            if interrupted:
                raise KeyboardInterrupt from error
            if isinstance(error, TerminalFailure):
                raise error
            raise AgentFailure(message, failure_stage) from error
        finally:
            if implementing:
                try:
                    read_report(report_file)
                except (ValueError, OSError, UnicodeError):
                    pass
                else:
                    artifact("report.txt").write_bytes(report_file.read_bytes())

    def checks(self, directory: Path) -> list[dict]:
        results = []
        for check in self.config["checks"]:
            attempt = self.attempt(directory / "checks" / check["id"])
            self.event("check.started", checkId=check["id"], round=self.state["round"])
            timed_out = False
            try:
                code = self.processes.run(check["command"], None, self.workspace, attempt, self.config["limits"].get("checkTimeoutSeconds"))
            except subprocess.TimeoutExpired:
                code, timed_out = None, True
            result = {"id": check["id"], "command": check["command"], "passed": code == 0,
                      "exitCode": code, "timedOut": timed_out, "stdoutFile": str(attempt / "stdout.log"), "stderrFile": str(attempt / "stderr.log")}
            write_json(attempt / "result.json", result)
            results.append(result)
            self.event("check.finished", checkId=check["id"], round=self.state["round"], passed=result["passed"])
        write_json(directory / "checks.json", results)
        lines = [f"Required checks for round {self.state['round']}:"]
        for result in results:
            lines.extend(["", f"{result['id']}: {'PASSED' if result['passed'] else 'FAILED'}",
                          "Command: " + json.dumps(result["command"]),
                          f"Exit code: {result['exitCode']}; timed out: {result['timedOut']}",
                          f"stdout: {result['stdoutFile']}", f"stderr: {result['stderrFile']}"])
        (directory / "checks-report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        return results

    def accepted_reviews(self, directory: Path) -> dict[str, dict]:
        results = {}
        for agent in self.config["agents"]["reviewers"]:
            location = directory / "reviews" / agent["id"]
            latest = self.latest_attempt(location)
            previous = None
            if (latest and not (latest / "error.json").exists() and not (latest / "invalidated.json").exists()
                    and (latest / "result.json").exists() and (latest / "process.json").exists()):
                process = read_json(latest / "process.json")
                if process.get("status") == "exited" and process.get("exitCode") == 0:
                    previous = read_json(latest / "result.json")
            if previous and previous.get("status") in {"CHANGES_REQUIRED", "NO_CHANGES_REQUIRED"}:
                validate_status(previous["status"], "review")
                _, digest = read_report(Path(previous["reportFile"]))
                if digest != previous["reportSha256"]:
                    raise ValueError(f"Saved reviewer report changed: {previous['reportFile']}")
                results[agent["id"]] = previous
        return results

    def invalidate_reviews(self, directory: Path) -> None:
        # Mark only attempts from the affected batch. A later successful retry
        # remains reusable even when another retry fails again.
        for agent in self.config["agents"]["reviewers"]:
            latest = self.latest_attempt(directory / "reviews" / agent["id"])
            if latest and not (latest / "invalidated.json").exists():
                write_json(latest / "invalidated.json", {"time": now(), "reason": "Workspace changed during active review"})
        self.save(invalidatedReviews=True)

    def validate_skips(self, directory: Path, skip_reviewers: list[str]) -> None:
        known = {agent["id"] for agent in self.config["agents"]["reviewers"]}
        unknown = set(skip_reviewers) - known
        if unknown:
            raise ValueError("Unknown reviewer IDs: " + ", ".join(sorted(unknown)))
        successful = set(skip_reviewers) & self.accepted_reviews(directory).keys()
        if successful:
            raise ValueError("Cannot skip successful reviewers: " + ", ".join(sorted(successful)))

    def reviews(self, directory: Path, candidate: str) -> list[dict]:
        results = self.accepted_reviews(directory)
        skips_file = directory / "skipped-reviewers.json"
        skipped = read_json(skips_file) if skips_file.exists() else {}
        results.update(skipped)
        pending = [(agent, directory / "reviews" / agent["id"])
                   for agent in self.config["agents"]["reviewers"] if agent["id"] not in results]
        errors = []
        if pending and self.config["parallelReviews"]:
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(pending))
            futures = {}
            try:
                for agent, path in pending:
                    futures[pool.submit(self.invoke, agent, "review", path, candidate=candidate)] = agent
                for future in concurrent.futures.as_completed(futures):
                    try:
                        results[futures[future]["id"]] = future.result()
                    except Exception as error:
                        if not isinstance(error, AgentFailure):
                            raise
                        errors.append(str(error))
            except BaseException:
                self.processes.stop_all()
                raise
            finally:
                if any(not future.done() for future in futures):
                    self.processes.stop_all()
                pool.shutdown(wait=True, cancel_futures=True)
        else:
            for agent, path in pending:
                try:
                    results[agent["id"]] = self.invoke(agent, "review", path, candidate=candidate)
                except Exception as error:
                    if not isinstance(error, AgentFailure):
                        raise
                    errors.append(str(error))
        try:
            self.assert_workspace(candidate)
        except ValueError:
            self.invalidate_reviews(directory)
            raise ValueError("A reviewer or another process modified the frozen workspace. All reviews are invalidated; no approval was accepted.") from None
        if errors:
            raise ValueError("; ".join(errors))
        for result in results.values():
            if result["status"] == "SKIPPED":
                continue
            _, digest = read_report(Path(result["reportFile"]))
            if digest != result["reportSha256"]:
                raise ValueError(f"Reviewer report changed during review: {result['reportFile']}")
        self.save(invalidatedReviews=False)
        return [results[agent["id"]] for agent in self.config["agents"]["reviewers"]]

    def prepare_resume(self, resume_prompt: str | None, skip_reviewers: list[str]) -> None:
        phase = self.state["phase"]
        directory = self.run / "rounds" / f"{self.state['round']:03d}"
        if resume_prompt is not None and phase != "implementation":
            raise ValueError("--prompt and --prompt-file are only valid when resuming implementation")
        if skip_reviewers and phase != "review":
            raise ValueError("--skip-reviewer is only valid when resuming reviews")
        self.validate_skips(directory, skip_reviewers)
        if phase == "implementation":
            implementation = directory / "implementation"
            turn = self.last_turn(implementation)
            if resume_prompt is not None and not turn:
                raise ValueError("The current round's implementation has not started; resume without --prompt to send its original instructions first")
            if turn:
                receipt_file = implementation / f"turn-{turn:03d}.process.json"
                receipt = read_json(receipt_file) if receipt_file.exists() else {}
                if receipt.get("status") not in {"exited", "interrupted"} or (
                        receipt.get("status") == "exited" and receipt.get("exitCode") != 0):
                    raise TerminalFailure("IMPLEMENTER_PANIC", "The prior implementer invocation did not exit cleanly; this run cannot resume.")
                error_file = implementation / f"turn-{turn:03d}.error.json"
                if receipt.get("status") != "interrupted" and error_file.exists() and read_json(error_file).get("failureStage") == "execution":
                    raise TerminalFailure("IMPLEMENTER_PANIC", "The prior implementer invocation failed during execution; this run cannot resume.")
                if not self.state.get("implementerSessionId"):
                    raise TerminalFailure("SESSION_UNAVAILABLE", "Original implementer session is unavailable; start a new run.")
        current = fingerprint(self.workspace, self.runs)
        changed = current["sha256"] != self.state["expectedWorkspace"]
        resumes = self.run / "resumes"
        number = 1 + len(list(resumes.glob("resume-*")))
        resume_dir = resumes / f"resume-{number:03d}"
        resume_dir.mkdir(parents=True)
        write_json(resume_dir / "resume.json", {"time": now(), "round": self.state["round"], "phase": phase,
                   "workspaceChanged": changed, "previousWorkspace": self.state["expectedWorkspace"],
                   "workspace": current["sha256"], "prompt": resume_prompt, "skipReviewers": skip_reviewers})
        if changed:
            snapshot = save_snapshot(self.workspace, self.runs, resume_dir / "workspace")
            updates = {"expectedWorkspace": snapshot["sha256"]}
            if phase in {"checks", "review"}:
                # Halt-time edits are permitted without revoking earlier reviews.
                # Required commands must nevertheless run on the new workspace.
                updates.update(candidateSha256=snapshot["sha256"], candidateManifestFile=str(resume_dir / "workspace" / "manifest.json"),
                               refreshChecks=True)
            self.save(**updates)
        if skip_reviewers:
            skips_file = directory / "skipped-reviewers.json"
            skipped = read_json(skips_file) if skips_file.exists() else {}
            for identifier in skip_reviewers:
                skipped.setdefault(identifier, {"agentId": identifier, "status": "SKIPPED", "round": self.state["round"], "time": now()})
            write_json(skips_file, skipped)
        self.event("run.resumed", round=self.state["round"], phase=phase, workspaceChanged=changed, skipReviewers=skip_reviewers)

    def execute(self, *, resuming: bool = False, resume_prompt: str | None = None,
                skip_reviewers: list[str] | None = None) -> int:
        if self.state["status"] == "TERMINAL":
            print(f"TERMINAL ({self.state.get('terminalReason')}): {self.state['reason']}\nRun: {self.run}", flush=True)
            return 2
        review_active = False
        try:
            self.assert_config()
            if self.state["status"] == "COMPLETED":
                print(f"Already COMPLETED. Run: {self.run}")
                return 0
            if self.state["status"] == "ROUND_LIMIT":
                print(f"Round limit reached. Start a new run with a revised limit. Run: {self.run}")
                return 4
            if resuming:
                self.prepare_resume(resume_prompt, skip_reviewers or [])
            self.save(status="RUNNING", reason=None)
            while True:
                self.assert_config()
                number = self.state["round"]
                directory = self.run / "rounds" / f"{number:03d}"
                directory.mkdir(parents=True, exist_ok=True)
                if self.state["phase"] == "implementation":
                    implementation = directory / "implementation"
                    followup = (resume_prompt if resume_prompt is not None else "Continue") if self.last_turn(implementation) else None
                    before = fingerprint(self.workspace, self.runs)
                    result = self.invoke(self.config["agents"]["implementer"], "implement" if number == 1 else "revise",
                                         implementation, followup=followup)
                    current = fingerprint(self.workspace, self.runs)
                    self.save(expectedWorkspace=current["sha256"])
                    self.assert_config()
                    if current["head"] != before["head"]:
                        raise ValueError("Implementer changed Git HEAD; this loop reviews uncommitted changes. Work was preserved without resetting Git.")
                    if result["status"] == "BLOCKED":
                        return self.finish("BLOCKED", f"Implementer blocked; read {result['reportFile']}", 3)
                    candidate = save_snapshot(self.workspace, self.runs, directory / "candidate")
                    self.save(phase="checks", expectedWorkspace=candidate["sha256"], candidateSha256=candidate["sha256"],
                              candidateManifestFile=str(directory / "candidate" / "manifest.json"), invalidatedReviews=False)
                if self.state["phase"] == "checks" or self.state.get("refreshChecks"):
                    self.assert_workspace(self.state["candidateSha256"])
                    checks = self.checks(directory)
                    self.assert_workspace(self.state["candidateSha256"])
                    self.assert_config()
                    self.save(phase="review", refreshChecks=False)
                else:
                    checks = read_json(directory / "checks.json")
                review_active = True
                reviews = self.reviews(directory, self.state["candidateSha256"])
                review_active = False
                self.assert_config()
                feedback = {
                    "reviewedRound": number, "revisionRound": number + 1, "candidateSha256": self.state["candidateSha256"],
                    "candidateManifestFile": self.state["candidateManifestFile"],
                    "reviews": [{key: result[key] for key in ("agentId", "status", "reportFile", "resultFile", "reportSha256", "candidateSha256")
                                 if key in result} for result in reviews],
                    "checks": checks, "checksReportFile": str(directory / "checks-report.txt")
                }
                write_json(directory / "feedback.json", feedback)
                blocked = [r for r in reviews if r["status"] == "BLOCKED"]
                if blocked:
                    return self.finish("BLOCKED", "Review incomplete: " + ", ".join(r["agentId"] for r in blocked), 3)
                if all(r["status"] in {"NO_CHANGES_REQUIRED", "SKIPPED"} for r in reviews) and all(c["passed"] for c in checks):
                    skipped = [r["agentId"] for r in reviews if r["status"] == "SKIPPED"]
                    reason = "Required checks passed; accepted reviews request no changes."
                    if len(skipped) == len(reviews):
                        reason = "Required checks passed; all reviewers explicitly skipped: " + ", ".join(skipped) + "."
                    elif skipped:
                        reason += " Reviewers explicitly skipped: " + ", ".join(skipped) + "."
                    return self.finish("COMPLETED", reason, 0)
                if number >= self.config["limits"]["maxRounds"]:
                    return self.finish("ROUND_LIMIT", "Unresolved changes or failed checks remain; see the last feedback.json.", 4)
                self.save(round=number + 1, phase="implementation", candidateSha256=None, candidateManifestFile=None)
                resume_prompt = None
                self.event("revision.queued", round=number + 1, feedbackFile=str(directory / "feedback.json"))
        except (Exception, KeyboardInterrupt) as error:
            self.processes.stop_all()
            if review_active:
                try:
                    self.assert_workspace(self.state["candidateSha256"])
                except (ValueError, OSError):
                    self.invalidate_reviews(directory)
            # Configuration changes always take precedence and remain terminal.
            try:
                self.assert_config()
            except TerminalFailure as config_error:
                error = config_error
            if self.state["phase"] == "implementation":
                try:
                    self.save(expectedWorkspace=fingerprint(self.workspace, self.runs)["sha256"])
                except (ValueError, OSError):
                    pass
                if isinstance(error, AgentFailure) and error.stage == "execution":
                    error = TerminalFailure("IMPLEMENTER_PANIC", str(error))
                elif isinstance(error, KeyboardInterrupt) and not self.state.get("implementerSessionId"):
                    error = TerminalFailure("SESSION_UNAVAILABLE", "Interrupted without a recoverable implementer session; start a new run.")
            if isinstance(error, TerminalFailure):
                self.save(status="TERMINAL", terminalReason=error.reason, reason=str(error))
                return self.finish("TERMINAL", str(error), 2)
            if isinstance(error, KeyboardInterrupt):
                return self.finish("INTERRUPTED", "Interrupted; partial work and logs retained. Resume explicitly.", 130)
            return self.finish("FAILED", str(error), 2)


def start(config_path: Path, workspace: Path, validate: bool) -> int:
    config_bytes = config_path.read_bytes()
    config = load_config(config_path, workspace)
    prompts, inputs = prepare_prompts(config, workspace)
    # Validate harness-specific options before allocating a run or launching anything.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="agent-loop-validate-") as temporary:
        for agent in [config["agents"]["implementer"], *config["agents"]["reviewers"]]:
            phase = "implement" if agent is config["agents"]["implementer"] else "review"
            build_command(agent, prompt="validation only", workspace=workspace, attempt_dir=Path(temporary), phase=phase, session_id=None)
    if validate:
        print(f"Valid configuration: {config_path}\nWorkspace: {workspace}\nNo agents were launched.")
        return 0
    runs = Path(config["runsDirectory"])
    if runs.is_relative_to(workspace):
        for name in git(workspace, "ls-files", "-z").split(b"\0"):
            if name:
                tracked = workspace / os.fsdecode(name)
                if tracked == runs or runs in tracked.parents:
                    raise ValueError("runsDirectory contains tracked source files; choose a dedicated untracked runtime directory")
    # Fail before creating runtime files when cwd is not in Git.
    fingerprint(workspace, runs)
    with workspace_lock(workspace):
        if config_path.read_bytes() != config_bytes:
            raise ValueError("Configuration changed while preparing the run; try again")
        run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
        run = runs / run_id
        run.mkdir(parents=True)
        (run / "inputs").mkdir()
        (run / "inputs" / "config.json").write_bytes(config_bytes)
        write_json(run / "inputs" / "resolved-prompts.json", prompts)
        source_manifest = []
        for index, (source, details) in enumerate(inputs.items(), 1):
            target = run / "inputs" / "files" / f"{index:03d}-{Path(source).name}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(details["data"])
            source_manifest.append({"source": source, "snapshot": str(target), "sha256": details["sha256"]})
        write_json(run / "inputs" / "manifest.json", source_manifest)
        initial = save_snapshot(workspace, runs, run / "initial-workspace")
        manifest = {"version": 2, "createdAt": now(), "workspace": str(workspace), "configPath": str(config_path),
                    "configSha256": hashlib.sha256(config_bytes).hexdigest(), "config": config}
        state = {"status": "RUNNING", "round": 1, "phase": "implementation", "expectedWorkspace": initial["sha256"], "implementerSessionId": None}
        write_json(run / "run.json", manifest)
        write_json(run / "state.json", state)
        runner = Runner(run, manifest, state)
        runner.event("run.created", workspace=str(workspace))
        print(f"Run: {run}", flush=True)
        return runner.execute()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a JSON-defined local implementation/review loop (Python 3.11+, macOS/Linux).")
    parser.add_argument("--version", action="version", version="agent-loop 0.2.0")
    parser.add_argument("config", nargs="?", help="JSON config, resolved from the invocation directory")
    parser.add_argument("--validate", action="store_true", help="Check config, prompt inputs, and executable paths without launching agents")
    parser.add_argument("--resume", metavar="RUN_DIRECTORY", help="Resume using frozen instructions and the recorded workspace")
    prompts = parser.add_mutually_exclusive_group()
    prompts.add_argument("--prompt", help="Follow-up message for the existing implementer session on resume")
    prompts.add_argument("--prompt-file", metavar="FILE", help="Read the implementer follow-up message from a UTF-8 file")
    parser.add_argument("--skip-reviewer", action="append", default=[], metavar="ID",
                        help="Skip this failed reviewer in the current round on resume; repeat for additional IDs")
    options = parser.parse_args(argv)
    if (bool(options.config) + bool(options.resume)) != 1 or (options.resume and options.validate):
        parser.error("provide CONFIG (optionally --validate), or --resume RUN_DIRECTORY")
    if not options.resume and (options.prompt is not None or options.prompt_file is not None or options.skip_reviewer):
        parser.error("--prompt, --prompt-file, and --skip-reviewer require --resume")
    def terminate(signum, frame):
        raise KeyboardInterrupt

    original_termination = signal.signal(signal.SIGTERM, terminate)
    try:
        if options.resume:
            run = absolute(options.resume, Path.cwd())
            manifest = read_json(run / "run.json")
            if manifest.get("version") != 2:
                raise ValueError("Unsupported saved run format; start a new run with the current configuration format")
            workspace = Path(manifest["workspace"])
            prompt = options.prompt
            if options.prompt_file is not None:
                prompt = absolute(options.prompt_file, Path.cwd()).read_text(encoding="utf-8")
            if prompt is not None and not prompt.strip():
                raise ValueError("Resume prompt must contain nonempty text")
            with workspace_lock(workspace):
                # The previous owner can finish between locating the workspace
                # and acquiring its lock. Only now is mutable run state current.
                state = read_json(run / "state.json")
                runner = Runner(run, manifest, state)
                return runner.execute(resuming=True, resume_prompt=prompt, skip_reviewers=options.skip_reviewer)
        return start(absolute(options.config, Path.cwd()), Path.cwd().resolve(), options.validate)
    except KeyboardInterrupt:
        return 130
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"agent-loop: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, original_termination)


if __name__ == "__main__":
    raise SystemExit(main())
