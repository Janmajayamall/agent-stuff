"""Headless CLI adapters. Only authoritative final outputs become loop verdicts.

Wire formats follow Codex non-interactive mode, Claude Code headless JSON, and
Pi's JSON event stream. Authentication and provider configuration stay in each
installed CLI. This module never starts a process or invokes a model itself.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re


@dataclass
class Invocation:
    argv: list[str]
    stdin: str | None
    final_path: Path | None = None


@dataclass
class AgentResponse:
    text: str
    session_id: str | None = None
    model: str | None = None
    usage: dict | None = None


# Extras cannot replace the adapter's prompt, final-result channel, session, or
# working directory. Options taking several values use a single comma-separated
# value here, which the supported CLIs also accept.
_EXTRA_VALUES = {
    "codex": {"--add-dir", "--config", "-c", "--enable", "--disable"},
    "claude": {
        "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
        "--add-dir", "--effort", "--max-budget-usd", "--tools",
        "--append-system-prompt", "--permission-mode", "--mcp-config", "--settings",
    },
    "pi": {
        "--thinking", "--tools", "-t", "--exclude-tools", "-xt",
        "--extension", "-e", "--skill", "--append-system-prompt",
    },
}
_EXTRA_SWITCHES = {
    "codex": {"--skip-git-repo-check", "--ignore-rules"},
    "claude": {"--strict-mcp-config", "--no-chrome", "--disable-slash-commands"},
    "pi": {
        "--offline", "--no-extensions", "-ne", "--no-skills", "-ns",
        "--no-prompt-templates", "-np", "--no-context-files", "-nc",
        "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-approve", "-na",
    },
}
_CLAUDE_MODES = {"acceptEdits", "auto", "manual", "dontAsk", "plan"}
_RESERVED_CODEX_CONFIG = {
    "model", "model_provider", "sandbox_mode", "approval_policy", "permissions",
    "cwd", "output_schema", "output_last_message", "ephemeral",
}


def _extras(agent: dict, harness: str) -> list[str]:
    args = agent.get("args", [])
    if not isinstance(args, list) or any(not isinstance(a, str) or "\0" in a for a in args):
        raise ValueError("agent.args must be an array of strings without NUL characters")
    i = 0
    while i < len(args):
        raw = args[i]
        option, equal, value = raw.partition("=")
        if option in _EXTRA_SWITCHES[harness] and not equal:
            i += 1
            continue
        if option not in _EXTRA_VALUES[harness]:
            raise ValueError(f"Unsupported {harness} adapter option {raw!r}; output, session, model, and sandbox flags are adapter-managed")
        if not equal:
            i += 1
            if i >= len(args) or args[i].startswith("--"):
                raise ValueError(f"{harness} option {option} requires one value")
            value = args[i]
        if harness == "claude" and option == "--permission-mode" and value not in _CLAUDE_MODES:
            raise ValueError(f"Unsupported Claude permission mode {value!r}; permission bypass is not supported")
        if harness == "codex" and option in {"-c", "--config"}:
            key, separator, _ = value.partition("=")
            if not separator or not key.strip():
                raise ValueError("Codex --config requires key=value")
            if key.strip().split(".")[0] in _RESERVED_CODEX_CONFIG:
                raise ValueError(f"Codex config key {key.strip()!r} is adapter-managed; use agent.model for model selection")
        i += 1
    return list(args)


def _model_flags(agent: dict, harness: str) -> list[str]:
    model = agent.get("model")
    if model is None:
        return []
    if not isinstance(model, dict) or set(model) - {"id", "provider"}:
        raise ValueError("agent.model must contain id and optionally provider")
    identifier = model.get("id")
    provider = model.get("provider")
    if not isinstance(identifier, str) or not identifier.strip() or "\0" in identifier or identifier.startswith("-"):
        raise ValueError("agent.model.id must be a nonempty model name")
    if provider is not None and (not isinstance(provider, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", provider)):
        raise ValueError("agent.model.provider must be a provider name")
    if harness != "pi" and provider is not None:
        raise ValueError(f"{harness} does not support agent.model.provider; configure the CLI backend in its own environment/settings")
    flags = ["--model", identifier]
    # Pi permits both built-in and user-registered providers. Its own model
    # registry is the authority for whether a syntactically valid name exists.
    if harness == "pi" and provider:
        flags = ["--provider", provider, *flags]
    return flags


def build_command(
    agent: dict, *, prompt: str, workspace: Path, attempt_dir: Path,
    phase: str, session_id: str | None, artifact_prefix: str = "",
) -> Invocation:
    """Prepare one invocation; the caller launches it with cwd=workspace.

    A Pi session token is the explicit JSONL path, whereas Codex and Claude use
    their emitted session IDs. Review invocations are always fresh sessions.
    """
    harness = agent.get("harness")
    if harness not in _EXTRA_VALUES:
        raise ValueError(f"Unsupported agent harness {harness!r}; choose codex, claude, or pi")
    command = agent.get("command", harness)
    if not isinstance(command, str) or not command.strip() or "\0" in command:
        raise ValueError("agent.command must be one executable name or path")
    if not isinstance(prompt, str):
        raise ValueError("prompt must be text")
    if not isinstance(artifact_prefix, str) or not re.fullmatch(r"[A-Za-z0-9_.-]*", artifact_prefix):
        raise ValueError("artifact_prefix must be a filename prefix without path separators")
    extras = _extras(agent, harness)
    model = _model_flags(agent, harness)
    if session_id is not None and (not isinstance(session_id, str) or not session_id.strip() or session_id.startswith("-") or "\0" in session_id):
        raise ValueError("session_id must be a nonempty session ID or Pi session path")
    is_review = phase in {"review", "reviewer"}
    resume = None if is_review else session_id
    attempt_dir = attempt_dir.resolve()
    attempt_dir.mkdir(parents=True, exist_ok=True)
    report_access = [] if attempt_dir.is_relative_to(workspace.resolve()) else ["--add-dir", str(attempt_dir)]
    if harness == "codex":
        final_path = attempt_dir / f"{artifact_prefix}harness-result.txt"
        if final_path.exists():
            raise ValueError(f"Refusing to reuse existing final-result file: {final_path}; use a new invocation artifact path")
        # exec-level options precede the resume subcommand: resume has no
        # --sandbox option of its own in the supported Codex CLI.
        argv = [command, "exec", "--sandbox", "workspace-write", *report_access, *extras]
        if resume:
            argv += ["resume", resume]
        argv += [*model, "--json", "-o", str(final_path)]
        return Invocation([*argv, "-"], prompt, final_path)
    if harness == "claude":
        argv = [command, "--print", "--output-format", "json",
                "--permission-prompts", "none", *report_access, *model, *extras]
        if resume:
            argv += ["--resume", resume]
        return Invocation(argv, prompt)
    session_path = Path(resume).resolve() if resume else attempt_dir / f"{artifact_prefix}session.jsonl"
    if resume and not session_path.is_file():
        raise ValueError(f"Pi session file is missing: {session_path}; cannot resume this implementation")
    if not resume and session_path.exists():
        raise ValueError(f"Refusing to reuse existing Pi session file: {session_path}")
    argv = [command, "--print", "--mode", "json", "--session", str(session_path), *model, *extras]
    return Invocation(argv, prompt)


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _json(text: str, source: str) -> object:
    try:
        return json.loads(text, object_pairs_hook=_unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"non-JSON number {value}")))
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Invalid JSON in {source}: {exc}") from exc


def _events(stdout: str, harness: str) -> list[dict]:
    result = []
    # JSONL records end at LF (with optional CR), not Unicode separators that
    # may legally occur inside JSON strings in tool output or agent messages.
    for index, line in enumerate(stdout.split("\n"), 1):
        if not line.strip():
            continue
        event = _json(line, f"{harness} stdout line {index}")
        if not isinstance(event, dict):
            raise ValueError(f"{harness} stdout line {index} is not an event object")
        result.append(event)
    return result


def _recover_events(stdout: str, harness: str) -> list[dict]:
    """Read valid native metadata records without accepting damaged results."""
    result = []
    for index, line in enumerate(stdout.split("\n"), 1):
        if not line.strip():
            continue
        try:
            event = _json(line, f"{harness} stdout line {index}")
        except ValueError:
            continue
        if isinstance(event, dict):
            result.append(event)
    return result


def _object(value: object, source: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{source} must be a JSON object")
    return value


def _final_text(value: object, source: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{source} must contain nonempty final response text")
    return value


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _dict(value: object) -> dict | None:
    return value if isinstance(value, dict) else None


def session_identity(harness: str, invocation: Invocation, stdout: str) -> str | None:
    """Recover a resumable conversation independently of final-result parsing.

    A malformed final response must not erase the implementer's conversation.
    Only native session metadata (or Pi's explicit existing session file) is
    authoritative; message text, tool output, and verdicts are never consulted.
    """
    def token(value: object) -> str | None:
        if not isinstance(value, str) or not value.strip() or value.startswith("-") or "\0" in value:
            return None
        return value

    if harness == "codex":
        identities = set()
        # Recover independently from valid records even when another JSONL
        # record is damaged. Never extract an ID from a malformed record.
        for event in _recover_events(stdout, harness):
            if event.get("type") == "thread.started":
                identity = token(event.get("thread_id"))
                if identity is not None:
                    identities.add(identity)
        if len(identities) > 1:
            raise ValueError("Codex emitted conflicting session IDs; cannot identify the implementation session")
        return next(iter(identities), None)
    if harness == "claude":
        try:
            envelope = _json(stdout, "Claude stdout")
        except ValueError:
            return None
        if not isinstance(envelope, dict) or envelope.get("type") != "result":
            return None
        return token(envelope.get("session_id"))
    if harness == "pi":
        try:
            session_path = Path(invocation.argv[invocation.argv.index("--session") + 1])
        except (ValueError, IndexError):
            return None
        return str(session_path) if session_path.is_file() else None
    raise ValueError(f"Unsupported agent harness {harness!r}")


def execution_failure(harness: str, stdout: str) -> str | None:
    """Identify positively reported native failures, even after a zero exit.

    Missing or malformed output is a result-processing failure, not proof of
    an execution failure. Transient native failures superseded by a completed
    retry also do not make an otherwise completed invocation a panic.
    """
    if harness == "codex":
        terminal = next((event for event in reversed(_recover_events(stdout, harness))
                         if event.get("type") in ("turn.completed", "turn.failed", "error")), None)
        if terminal is not None and terminal["type"] in {"turn.failed", "error"}:
            return f"Codex reported native execution failure: {terminal['type']}"
        return None
    if harness == "claude":
        try:
            envelope = _json(stdout, "Claude stdout")
        except ValueError:
            return None
        if not isinstance(envelope, dict) or envelope.get("type") != "result":
            return None
        subtype = envelope.get("subtype")
        if envelope.get("is_error") is True or (isinstance(subtype, str) and subtype.startswith("error")):
            return f"Claude reported native execution failure: {subtype or 'is_error'}"
        return None
    if harness == "pi":
        message = None
        for event in _recover_events(stdout, harness):
            candidates = []
            if event.get("type") == "message_end":
                candidates = [event.get("message")]
            elif event.get("type") == "agent_end" and isinstance(event.get("messages"), list):
                candidates = event["messages"]
            for candidate in candidates:
                if isinstance(candidate, dict) and candidate.get("role") == "assistant":
                    message = candidate
        if message is not None and message.get("stopReason") in ("error", "aborted"):
            return f"Pi reported native execution failure: {message['stopReason']}"
        return None
    raise ValueError(f"Unsupported agent harness {harness!r}")


def parse_output(harness: str, invocation: Invocation, stdout: str, stderr: str) -> AgentResponse:
    """Extract completed final text. The caller validates the exact verdict.

    stderr is retained by the caller for diagnostics; it never supplies a
    verdict. A success phrase in a tool result or progress event is irrelevant.
    """
    if harness == "codex":
        events = _events(stdout, harness)
        terminal = next((e for e in reversed(events) if e.get("type") in {"turn.started", "turn.completed", "turn.failed", "error"}), None)
        if not terminal or terminal.get("type") != "turn.completed":
            raise ValueError("Codex did not emit a successful turn.completed event; inspect stdout.log and stderr.log")
        if invocation.final_path is None:
            raise ValueError("Codex invocation is missing its final-result path")
        try:
            final = invocation.final_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ValueError(f"Codex did not write readable final response text to {invocation.final_path}") from exc
        session = next((_string(e.get("thread_id")) for e in reversed(events) if e.get("type") == "thread.started"), None)
        return AgentResponse(_final_text(final, "Codex final-result file"), session_id=session, usage=_dict(terminal.get("usage")))
    if harness == "claude":
        envelope = _object(_json(stdout, "Claude stdout"), "Claude result envelope")
        if envelope.get("type") != "result" or envelope.get("subtype") != "success" or envelope.get("is_error") is True:
            raise ValueError(f"Claude did not produce a successful result envelope ({envelope.get('subtype', 'missing subtype')}); inspect stderr.log")
        final = _final_text(envelope.get("result"), "Claude result")
        model = _string(envelope.get("model"))
        models = envelope.get("modelUsage")
        if model is None and isinstance(models, dict) and len(models) == 1:
            model = _string(next(iter(models)))
        return AgentResponse(final, session_id=_string(envelope.get("session_id")), model=model, usage=_dict(envelope.get("usage")))
    if harness == "pi":
        events = _events(stdout, harness)
        final_index = None
        message = None
        for index, event in enumerate(events):
            if event.get("type") == "message_end" and isinstance(event.get("message"), dict) and event["message"].get("role") == "assistant":
                final_index, message = index, event["message"]
        if message is None or final_index is None:
            raise ValueError("Pi did not emit a final assistant message_end event")
        if message.get("stopReason") != "stop":
            raise ValueError(f"Pi final assistant message stopped with {message.get('stopReason')!r}, not 'stop'")
        lifecycle = [e for e in events[final_index + 1:] if e.get("type") in {"agent_start", "agent_end"}]
        if not lifecycle or lifecycle[-1].get("type") != "agent_end" or lifecycle[-1].get("willRetry") is True:
            raise ValueError("Pi stream ended before the final agent run completed")
        content = message.get("content")
        if not isinstance(content, list):
            raise ValueError("Pi final assistant content must be an array of content blocks")
        if any(isinstance(block, dict) and block.get("type") == "toolCall" for block in content):
            raise ValueError("Pi final assistant message still contains a pending tool call")
        if any(not isinstance(block, dict) or (block.get("type") == "text" and not isinstance(block.get("text"), str)) for block in content):
            raise ValueError("Pi final assistant message contains malformed content blocks")
        text = "".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str))
        try:
            session_path = invocation.argv[invocation.argv.index("--session") + 1]
        except (ValueError, IndexError) as exc:
            raise ValueError("Pi invocation is missing its explicit session path") from exc
        model = _string(message.get("model"))
        provider = _string(message.get("provider"))
        if model and provider:
            model = f"{provider}/{model}"
        return AgentResponse(_final_text(text, "Pi final assistant message"), session_id=session_path, model=model, usage=_dict(message.get("usage")))
    raise ValueError(f"Unsupported agent harness {harness!r}")
