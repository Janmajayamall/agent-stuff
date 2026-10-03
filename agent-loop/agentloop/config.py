"""Configuration validation and explicit, one-pass prompt file expansion."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
FILE_REFERENCE = re.compile(r'(?<![\w@])@(?:"([^"\n]+)"|([^\s`<>"\'\[\]{}(),;]+))')
VARIABLE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
TEMPLATE_VARIABLES = {"workspace", "review_file", "reviewDetails"}


def absolute(path: str, cwd: Path) -> Path:
    p = Path(path).expanduser()
    return (cwd / p).resolve() if not p.is_absolute() else p.resolve()


def _keys(value: object, allowed: set[str], label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    extra = value.keys() - allowed
    if extra:
        raise ValueError(f"Unknown {label} fields: {', '.join(sorted(extra))}")
    return value


def _positive(value: object, label: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{label} must be a positive integer; omit a timeout for unlimited")


def _instruction(value: object, label: str) -> dict:
    instruction = _keys(value, {"file", "text"}, label)
    if len(instruction) != 1:
        raise ValueError(f"{label} must contain exactly one of file or text")
    content = next(iter(instruction.values()))
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"{label} text/path must be nonempty")
    return instruction


def load_config(path: Path, cwd: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    if type(config.get("version")) is not int or config["version"] != 1:
        raise ValueError("version must be 1")
    _keys(config, {"version", "name", "agents", "parallelReviews", "limits", "runsDirectory", "checks"}, "config")
    if not isinstance(config.get("name"), str) or not IDENTIFIER.fullmatch(config["name"]):
        raise ValueError("name must be a filename-safe identifier (letters, digits, _ and -)")
    agents = _keys(config.get("agents"), {"implementer", "reviewers"}, "agents")
    if not isinstance(agents.get("reviewers"), list) or not agents["reviewers"]:
        raise ValueError("agents.reviewers must be a nonempty list")
    ids = set()
    for position, agent in enumerate([agents.get("implementer"), *agents["reviewers"]]):
        _keys(agent, {"id", "harness", "model", "command", "args", "instructions"}, "agent")
        ident = agent.get("id")
        if not isinstance(ident, str) or not IDENTIFIER.fullmatch(ident) or ident in ids:
            raise ValueError("Agent IDs must be unique filename-safe identifiers")
        ids.add(ident)
        label = f"agents.{ident}.instructions"
        if position == 0:
            instructions = _keys(agent.get("instructions"), {"implement", "revise"}, label)
            if set(instructions) != {"implement", "revise"}:
                raise ValueError(f"{label} must define implement and revise")
            for phase, instruction in instructions.items():
                _instruction(instruction, f"{label}.{phase}")
        else:
            _instruction(agent.get("instructions"), label)
        if agent.get("harness") not in {"codex", "claude", "pi"}:
            raise ValueError(f"Unsupported harness for {ident}: {agent.get('harness')!r}")
        if "model" in agent:
            model = _keys(agent["model"], {"id", "provider"}, "model")
            if not isinstance(model.get("id"), str) or not model["id"].strip():
                raise ValueError(f"model.id is required for {ident}; omit model to use the default")
            if "provider" in model and (not isinstance(model["provider"], str) or not model["provider"].strip()):
                raise ValueError("model.provider must be a nonempty string")
        command = agent.get("command", agent["harness"])
        if not isinstance(command, str) or not command:
            raise ValueError("command must be one executable name/path; use args for arguments")
        if "/" in command or command.startswith("~"):
            command = str(absolute(command, cwd))
        resolved = shutil.which(command)
        if not resolved:
            raise ValueError(f"Executable unavailable for {ident}: {command}")
        agent["command"] = str(Path(resolved).absolute())
        if "args" in agent and (not isinstance(agent["args"], list) or not all(isinstance(a, str) for a in agent["args"])):
            raise ValueError("agent.args must be a list of strings")
    parallel = config.setdefault("parallelReviews", True)
    if type(parallel) is not bool:
        raise ValueError("parallelReviews must be a boolean")
    limits = config.setdefault("limits", {})
    _keys(limits, {"maxRounds", "agentTimeoutSeconds", "checkTimeoutSeconds"}, "limits")
    _positive(limits.setdefault("maxRounds", 5), "limits.maxRounds")
    for key in ("agentTimeoutSeconds", "checkTimeoutSeconds"):
        if key in limits:
            _positive(limits[key], f"limits.{key}")
    runs = config.setdefault("runsDirectory", ".agent-loop/runs")
    if not isinstance(runs, str) or not runs:
        raise ValueError("runsDirectory must be a nonempty path")
    runs_path = absolute(runs, cwd)
    if runs_path == cwd or runs_path in cwd.parents or ".git" in runs_path.parts:
        raise ValueError("runsDirectory must not contain the workspace or be inside .git")
    config["runsDirectory"] = str(runs_path)
    checks = config.setdefault("checks", [])
    if not isinstance(checks, list):
        raise ValueError("checks must be a list")
    check_ids = set()
    for check in checks:
        _keys(check, {"id", "command"}, "check")
        ident = check.get("id")
        if not isinstance(ident, str) or not IDENTIFIER.fullmatch(ident) or ident in check_ids:
            raise ValueError("Check IDs must be unique filename-safe identifiers")
        check_ids.add(ident)
        command = check.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(a, str) for a in command) or not command[0]:
            raise ValueError("check.command must be a nonempty argv array (no shell)")
        if "/" in command[0] or command[0].startswith("~"):
            command[0] = str(absolute(command[0], cwd))
        executable = shutil.which(command[0])
        if not executable:
            raise ValueError(f"Check executable unavailable: {command[0]}")
        command[0] = str(Path(executable).absolute())
    return config


def prepare_prompts(config: dict, cwd: Path) -> tuple[dict, dict]:
    """Freeze templates, resolve file references to paths, and archive input bytes.

    Referenced document contents never enter the prompt. Resolved paths and
    runtime variable values are literal data and are never parsed as templates.
    """
    inputs: dict[str, dict] = {}

    def snapshot(path: str) -> tuple[Path, bytes]:
        source = absolute(path, cwd)
        data = source.read_bytes()
        inputs[str(source)] = {"sha256": hashlib.sha256(data).hexdigest(), "data": data}
        return source, data

    def parse_text(text: str, phase: str, label: str) -> list[dict[str, str]]:
        segments = []
        cursor = 0
        allowed = TEMPLATE_VARIABLES if phase == "revise" else TEMPLATE_VARIABLES - {"reviewDetails"}
        while cursor < len(text):
            opening = text.find("{{", cursor)
            closing = text.find("}}", cursor)
            if closing != -1 and (opening == -1 or closing < opening):
                raise ValueError(f"Malformed template variable in {label}: unmatched '}}}}'")
            if opening == -1:
                segments.append({"text": text[cursor:]})
                break
            if opening > cursor:
                segments.append({"text": text[cursor:opening]})
            closing = text.find("}}", opening + 2)
            if closing == -1:
                raise ValueError(f"Malformed template variable in {label}: unmatched '{{{{'")
            name = text[opening + 2:closing].strip()
            if (
                not VARIABLE_NAME.fullmatch(name)
                or (opening > 0 and text[opening - 1] == "{")
                or (closing + 2 < len(text) and text[closing + 2] == "}")
            ):
                raise ValueError(f"Malformed template variable in {label}: {text[opening:closing + 2]!r}")
            if name not in allowed:
                if name == "reviewDetails":
                    raise ValueError(f"{{{{reviewDetails}}}} is available only in revise instructions ({label})")
                raise ValueError(f"Unknown template variable in {label}: {name}")
            segments.append({"variable": name})
            cursor = closing + 2
        return segments

    def prepare(prompt: object, phase: str, label: str) -> list[dict[str, str]]:
        prompt = _instruction(prompt, label)
        key = next(iter(prompt))
        text = snapshot(prompt["file"])[1].decode("utf-8") if key == "file" else prompt["text"]
        segments = []
        cursor = 0
        for match in FILE_REFERENCE.finditer(text):
            segments.extend(parse_text(text[cursor:match.start()], phase, label))
            path = match.group(1) or match.group(2)
            source, _ = snapshot(path)
            # Drop @ so a harness cannot treat it as its own attachment syntax.
            segments.append({"text": json.dumps(str(source), ensure_ascii=False)})
            cursor = match.end()
        segments.extend(parse_text(text[cursor:], phase, label))
        return segments

    resolved = {}
    implementer = config["agents"]["implementer"]
    resolved[implementer["id"]] = {
        phase: prepare(prompt, phase, f"{implementer['id']}.instructions.{phase}")
        for phase, prompt in implementer["instructions"].items()
    }
    for agent in config["agents"]["reviewers"]:
        resolved[agent["id"]] = {
            "review": prepare(agent["instructions"], "review", f"{agent['id']}.instructions")
        }
    return resolved, inputs


def render_instructions(template: list[dict[str, str]], variables: dict[str, str]) -> str:
    """Substitute frozen variables once; inserted values are never parsed again."""
    if not isinstance(template, list):
        raise ValueError("Instruction template must be a list of frozen segments")
    parts = []
    for segment in template:
        _keys(segment, {"text", "variable"}, "instruction segment")
        if len(segment) != 1:
            raise ValueError("Instruction segment must contain exactly one of text or variable")
        if "text" in segment:
            value = segment["text"]
        else:
            name = segment["variable"]
            if not isinstance(name, str) or name not in TEMPLATE_VARIABLES:
                raise ValueError(f"Unknown frozen template variable: {name!r}")
            if name not in variables:
                raise ValueError(f"Missing value for template variable: {name}")
            value = variables[name]
        if not isinstance(value, str):
            raise ValueError("Instruction segment and variable values must be strings")
        parts.append(value)
    return "".join(parts)
