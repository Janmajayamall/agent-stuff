"""Capture reviewable Git state, excluding only runner-owned runtime files."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


def git(cwd: Path, *args: str) -> bytes:
    process = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    if process.returncode:
        raise ValueError(f"Git workspace required: {process.stderr.decode(errors='replace').strip()}")
    return process.stdout


def fingerprint(cwd: Path, runs: Path) -> dict:
    root = Path(os.fsdecode(git(cwd, "rev-parse", "--show-toplevel").strip())).resolve()
    head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=cwd, capture_output=True)
    head_id = head.stdout.decode().strip() if head.returncode == 0 else None
    staged_entries = git(cwd, "ls-files", "--stage", "-z").split(b"\0")
    for entry in staged_entries:
        if entry.startswith(b"160000 "):
            name = os.fsdecode(entry.split(b"\t", 1)[1])
            raise ValueError(f"Git submodules are not supported in the review workspace: {name}. Run from a directory without submodules.")
    names = git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")

    def excluded(relative: str) -> bool:
        # Do not resolve symlinks here: hash links themselves, not their targets.
        full = cwd / relative
        return full == runs or runs in full.parents or relative == ".agent-loop/workspace.lock"

    files = {}
    for raw in sorted(set(names)):
        if not raw:
            continue
        name = os.fsdecode(raw)
        if excluded(name):
            continue
        path = cwd / name
        if path.is_symlink():
            files[name] = {"type": "symlink", "target": os.readlink(path)}
        elif path.is_file():
            files[name] = {"type": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "executable": bool(path.stat().st_mode & 0o111)}
        elif not path.exists():
            files[name] = {"type": "deleted"}
        else:
            raise ValueError(f"Cannot snapshot non-file workspace entry: {name}")
    index = []
    for entry in staged_entries:
        if entry:
            metadata, raw = entry.split(b"\t", 1)
            if not excluded(os.fsdecode(raw)):
                index.append([metadata.decode(), os.fsdecode(raw)])
    content = {"gitRoot": str(root), "head": head_id, "files": files, "index": index}
    content["sha256"] = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    return content


def save_snapshot(cwd: Path, runs: Path, destination: Path) -> dict:
    before = fingerprint(cwd, runs)
    destination.mkdir(parents=True, exist_ok=True)
    # Pathspec exclusions ensure runtime logs never appear in a review patch.
    exclusions = [":(exclude).agent-loop/workspace.lock"]
    if runs.is_relative_to(cwd):
        exclusions.append(":(exclude)" + runs.relative_to(cwd).as_posix() + "/**")
    (destination / "staged.patch").write_bytes(git(cwd, "diff", "--binary", "--cached", "--", ".", *exclusions))
    (destination / "unstaged.patch").write_bytes(git(cwd, "diff", "--binary", "--", ".", *exclusions))
    for raw in git(cwd, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
        if not raw:
            continue
        name = os.fsdecode(raw)
        if name not in before["files"]:
            continue
        source = cwd / name
        target = destination / "untracked" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            # The manifest preserves the target. Do not materialize live links
            # or generate sidecar filenames that can collide with real files.
            continue
        elif source.is_file():
            shutil.copy2(source, target)
    after = fingerprint(cwd, runs)
    if before["sha256"] != after["sha256"]:
        raise ValueError("Workspace changed while the candidate snapshot was being captured")
    (destination / "manifest.json").write_text(json.dumps(before, indent=2) + "\n")
    return before
