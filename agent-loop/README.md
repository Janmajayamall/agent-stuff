# agent-loop

A small JSON-driven CLI that runs one implementation agent and multiple independent reviewers. Supports Codex, Claude Code, and pi through their installed CLIs. Python 3.11+ and Git are required; there are no Python package dependencies. Supported operating systems: macOS and Linux.

To inspect saved commands, model settings, prompts, outputs, and session histories, see [Auditing a run](#auditing-a-run).

## Run

From the **Git workspace you want the agents to work in**:

```sh
python3 /path/to/agent-loop/agent_loop.py ./configs/loop.json
```

The executable `agent-loop` in this directory provides the same interface. All relative paths—including the config, prompt files, `@file` references, command paths, and run storage—resolve from the **directory where you invoke the CLI**, not from the config file or program directory. Bare executable names resolve through `PATH`. Every child process uses the recorded workspace as its current directory. Explicit command paths can contain spaces; commands are launched as argument arrays without a shell.

Validate configuration and inputs without invoking agents:

```sh
python3 /path/to/agent-loop/agent_loop.py --validate ./configs/loop.json
```

Resume a recoverable failed, blocked, or interrupted run:

```sh
python3 /path/to/agent-loop/agent_loop.py --resume /absolute/path/to/.agent-loop/runs/RUN_ID
```

Resume uses the saved configuration, instruction templates, and originally recorded workspace, even when invoked from another directory. You may edit the workspace and PLAN documents while the run is halted. Referenced documents are read live by the agents; audit copies do not replace them. The original JSON configuration must retain its exact bytes: a changed or missing configuration makes the run `TERMINAL`, and reverting the file afterward does not make that run resumable. An implementer panic is also terminal. A completed run simply reports its completed status; a run stopped at its round limit requires a new run.

To continue a blocked implementer, optionally supply a message:

```sh
python3 /path/to/agent-loop/agent_loop.py --resume /path/to/RUN_ID \
  --prompt "I clarified docs/plan.md. Read it again and continue."
```

Use `--prompt-file ./resume-notes.md` instead for UTF-8 text loaded from a file relative to your invocation directory. The options are mutually exclusive and require an implementation turn in the current round to continue. The runner sends only your message, or the literal `Continue` when neither option is given. It resumes the same session without repeating the original task prompt. If interruption occurred before this round's first implementation turn, resume without a message sends the original implementation or revision prompt; supplying a follow-up message in that case is rejected.

To skip a failed reviewer instead of retrying it, repeat `--skip-reviewer REVIEWER_ID` on review resume. You may select every failed reviewer. Skips last for the current round and are recorded explicitly; they are not approvals. See [Loop states and recovery](docs/state-transitions.md) for the full transition table and storage layout.

Saved runs use format version 2. Older saved runs cannot be resumed and are not migrated. Start a new run with the current configuration format, which still uses `"version": 1`.

## Configuration

```json
{
  "version": 1,
  "name": "my-feature",
  "agents": {
    "implementer": {
      "id": "implementer",
      "harness": "codex",
      "instructions": {
        "implement": { "file": "prompts/implement.md" },
        "revise": { "file": "prompts/revise.md" }
      }
    },
    "reviewers": [
      {
        "id": "correctness",
        "harness": "claude",
        "args": ["--allowedTools", "Read,Grep,Glob,Write,Bash(python3 -m unittest *)"],
        "instructions": { "file": "prompts/review.md" }
      },
      {
        "id": "independent-review",
        "harness": "pi",
        "instructions": { "file": "prompts/review.md" }
      }
    ]
  },
  "parallelReviews": true,
  "limits": { "maxRounds": 5 },
  "runsDirectory": ".agent-loop/runs",
  "checks": [
    { "id": "unit", "command": ["python3", "-m", "unittest", "-v"] }
  ]
}
```

Agent IDs must be unique filename-safe names. `name` follows the same naming rule. The optional `model` object takes `id`; pi also supports `provider`. For example: `"model": {"provider": "your-provider", "id": "your-model"}`. Omitting `model` retains the installed harness's configured default. Codex and Claude backend/provider configuration stays in their native configuration files.

An optional `command` replaces the executable, such as `"command": "./tools/codex-wrapper"`. `args` accepts supported harness-specific options. The adapters validate these options and reject unknown or conflicting output, session, model, and working-directory flags. See `agentloop/adapters.py` for the current accepted options. Wrappers must preserve the selected harness's command-line and output protocol.

`parallelReviews` defaults to true. `limits.maxRounds` defaults to 5 and counts complete implementation/review cycles. **Omitting `limits.agentTimeoutSeconds` means unlimited time per agent invocation.** A supplied timeout must be a positive integer; zero and null are rejected. Optional `limits.checkTimeoutSeconds` behaves the same way for required checks. Ctrl-C or SIGTERM stops active agent/check process groups and records an interrupted run.

`checks` is optional. Each check runs after implementation and before review. A failed check prevents completion even if all reviewers approve or are explicitly skipped, and its report is included in `{{reviewDetails}}` for the next revision. Checks must not change source or Git state; build outputs should be Git-ignored. Reviewers should run the relevant tests themselves as directed by their instructions. The runner does not invent project-specific test requirements. With no checks and all failed reviewers explicitly skipped, completion can occur without an accepted review.

## Instructions and file references

The implementer requires two instruction templates: `implement` and `revise`. Each reviewer has one complete `instructions` template. Every template contains exactly one of `file` or `text`:

```json
{
  "text": "Read @docs/spec.md and @docs/review-criteria.md . Review the uncommitted changes in {{workspace}} against those requirements. Write your review to {{review_file}}. Return exactly CHANGES_REQUIRED for blocking defects, NO_CHANGES_REQUIRED otherwise, or BLOCKED if verification cannot be completed."
}
```

**Authored templates supply the whole initial implementation, revision, or review prompt.** The runner resolves explicit file references to paths and substitutes variables, but appends no role instructions, result schema, or runtime context. Same-round implementation resumes send only the optional user message described above, without template substitution or file-reference expansion. The selected CLI can still supply its own system instructions and project context. Put the task, verification requirements, report path, final verdict, and any stop conditions in the templates themselves.

The runner replaces an explicit `@path` reference with the original file's absolute path, quoted as a JSON string and without the leading `@`. For example, `Read @docs/spec.md` becomes `Read "/workspace/docs/spec.md"`. The agent reads that file using its own tools; the runner never inserts its contents into the prompt. Use `@"docs/file with spaces.md"` for spaces, and keep bare references separated from surrounding punctuation. Relative template paths and references resolve from the invocation working directory. Ordinary paths without `@` are left as authored.

Missing referenced files fail validation before agents launch. Referenced files may contain binary data; the runner records their source paths and content hashes and saves byte-for-byte audit copies. These copies do not redirect the agent's reads or freeze the live contents of the referenced files. An `instructions.file` is different: it supplies the authored prompt template, so the runner reads that file as UTF-8 text.

Exactly three template variables are supported:

| Variable | Available in | Replacement |
| --- | --- | --- |
| `{{workspace}}` | Every template | Absolute path to the recorded working directory. |
| `{{review_file}}` | Every template | Absolute report path. Stable within an implementation round; separate for each reviewer attempt. |
| `{{reviewDetails}}` | Revision only | The immediately preceding round's reviewer identities, verdicts, and absolute report paths, plus failed required-check report paths when applicable. |

Unknown variables and use of `{{reviewDetails}}` outside revision instructions fail validation before any agents launch. Variables are expanded only in authored instruction text, whether inline or loaded through `instructions.file`. The runner does not parse `@` references or `{{...}}` text inside referenced documents. Instruction templates and resolved reference paths are saved for the run; invocation-specific values are substituted when each agent starts. Inserted variable values are not recursively expanded.

A revision template could contain:

```text
Read @docs/spec.md . Revise its implementation in {{workspace}} using these reviews:

{{reviewDetails}}

Address blocking findings and failed checks. Keep changes uncommitted. Stop if
reviews conflict or require substantial undocumented deviations. Write a summary
and verification results, or the reason you stopped, to {{review_file}}.
Return exactly IMPLEMENTATION_COMPLETE when done, or BLOCKED if you stopped.
```

If round 3 requests changes, `{{reviewDetails}}` lists accepted reviews from round 3, including approving reviews, and records any explicit skips. It inserts paths and verdicts, not report contents. The implementer reads those files. After revision, all configured reviewers review again, including reviewers skipped in the preceding round.

There is exactly one implementer session per run once it has been established. Revisions and same-round resumes continue that session; the runner never falls back to starting another implementer session. An unavailable or mismatched session makes the run terminal. Reviewers start fresh sessions for each invocation. Instruction templates are frozen when the run starts; changing a template file does not replace the saved prompt. Referenced documents remain live, and you can direct the implementer to reread an edited plan using a resume message.

## Failure recovery

Failures halt the run; agents are not automatically retried. Every completed process gets a process record before output parsing. Error records distinguish `execution` from `result` failures:

- **Implementer panic or unsuccessful execution:** a crash, unsuccessful exit, launch failure, timeout, or explicit native failure event makes the run `TERMINAL`. A native failure counts even if the CLI process exits with code 0. Partial work and logs remain available; start a new run to continue.
- **Implementer `BLOCKED` or invalid result:** resume continues the same session and round. The report path remains unchanged, while separate turn logs and report copies preserve history. If the session cannot be recovered, the run becomes terminal.
- **Reviewer failure or `BLOCKED`:** resume reruns only affected reviewers in fresh sessions, unless the user skips them by ID. Accepted results are retained even when workspace files were edited during the halt, provided their saved reports are intact. This intentionally permits an accepted review to describe an older workspace.
- **Configuration change:** changing or removing the original JSON file makes the run terminal when detected, even if the new JSON is semantically equivalent. That state is permanent for the run.

An explicit Ctrl-C or SIGTERM records `INTERRUPTED` when implementation's original session can be recovered; otherwise that implementation run becomes terminal. Review interruption is recoverable. The detailed [state-transition document](docs/state-transitions.md) distinguishes active work, recoverable halts, and terminal states. Skipped reviewers are listed in the completion summary for that round and never converted to approvals.

## Reports and verdicts

Each implementation, revision, and review template must direct the agent to write a nonempty UTF-8 report to `{{review_file}}`, then finish with exactly one permitted token:

| Phase | Final response |
| --- | --- |
| Implement or revise | `IMPLEMENTATION_COMPLETE` or `BLOCKED` |
| Review | `CHANGES_REQUIRED`, `NO_CHANGES_REQUIRED`, or `BLOCKED` |

Keep asking agents to return only the token and put findings, test evidence, advisory suggestions, and explanations in the report file. The parser also accepts surrounding prose or formatting when the final response contains exactly one occurrence of a whole, case-sensitive status token permitted for that phase. For example, `Review complete. NO_CHANGES_REQUIRED` is accepted. Missing tokens, multiple occurrences (including repeats of the same token), conflicting tokens, and tokens belonging to the wrong phase fail validation. `NO_CHANGES_REQUIRED` is one token; its embedded `CHANGES_REQUIRED` is not a second match. Tokens embedded in longer words or identifiers are not matched.

The runner accepts a result only after successful CLI completion, a valid final verdict, and a newly written nonempty report at the assigned path. It preserves the agent's report and writes normalized `result.json` metadata, including agent/harness identity, configured model, reported model when available, session token, and usage when available. It never guesses an unavailable model name. Ask for identity within the authored instructions if you also want it in the report text.

Codex verdicts come from its final response file after a successful completion event; Claude uses its completed result envelope; pi uses its final completed assistant message. Status words in progress messages or tool output never count as verdicts. Each reviewer attempt gets a separate report path. The implementer keeps one report path per round; the runner archives and removes the previous report before a follow-up so a new turn must write its own report.

## Run storage and source protection

```text
.agent-loop/runs/RUN_ID/
  run.json                       resolved config and absolute workspace
  state.json                     phase, round, status, session, source identity
  events.jsonl                   chronological runner events
  summary.txt                    terminal status and reason
  inputs/
    config.json                  original config
    resolved-prompts.json         frozen instruction templates
    manifest.json                source paths, hashes, copied input paths
    files/                       original input files copied for audit
  initial-workspace/              starting Git state and uncommitted changes
  resumes/resume-001/
    resume.json                  follow-up, skip IDs, workspace identities
    workspace/                   snapshot when files changed during the halt
  rounds/001/
    implementation/
      report.txt                 stable report path throughout this round
      turn-001.prompt.txt
      turn-001.invocation.json
      turn-001.stdout.log
      turn-001.stderr.log
      turn-001.process.json      completion, before result processing
      turn-001.result.json
      turn-001.report.txt        report copy for this turn
      turn-001.error.json        failureStage, when processing fails
      turn-002.*                 same session after a recoverable halt
      turn-002.previous-report   previous live report moved aside before turn 2
    candidate/
      manifest.json              HEAD, index, file hashes, modes, symlinks
      staged.patch
      unstaged.patch
      untracked/
    checks/CHECK_ID/attempt-01/
      stdout.log
      stderr.log
      result.json
    checks.json
    checks-report.txt              check outcomes and log paths for revision
    reviews/REVIEWER_ID/attempt-01/
      prompt.txt, invocation.json, stdout.log, stderr.log
      process.json, report.txt, result.json, error.json (when failed)
      invalidated.json           present if active source changes invalidated this attempt
    feedback.json
    skipped-reviewers.json       explicit skip decisions, when present
  rounds/002/
    ...
```

Storage defaults to `.agent-loop/runs` and can be moved outside the workspace. The storage directory must not contain tracked source files. Add the runtime directory and `.agent-loop/workspace.lock` to `.gitignore`. The runner explicitly excludes these locations from its snapshots. Keep prompt files version-controlled separately. It never commits, resets, stashes, or restores source automatically. If an implementation agent changes Git HEAD, the run fails and preserves that work for inspection.

For external run storage, the Codex and Claude adapters add the report directory to the CLI's permitted working directories so the agent can write its report.

The reviewed candidate includes staged, unstaged, and nonignored untracked files. The runner fingerprints contents, executable bits, symlink targets, Git HEAD, and the index. Source changes during an active review invalidate that review batch, with an `invalidated.json` marker in each affected attempt. Successful later retries can be reused if another retry fails. Changes made while halted are allowed and do not invalidate previously accepted reviews; recorded report hashes must still match. If files changed before a checks/review resume, required checks rerun on the new workspace. The resume snapshot becomes the current candidate, while retained reviews keep their own original candidate identities. After a new implementation revision, every reviewer runs again. A workspace lock prevents two runner processes from owning the same workspace.

Git submodules are explicitly unsupported in the review workspace because parent diffs do not identify their changing contents reliably. Run within an appropriate directory without submodules. Snapshots preserve changes relative to the recorded base commit; they are not a complete Git repository backup. File access permissions and credentials are governed by each harness and the operating system. Authored instructions and source-change detection are coordination controls, not an isolation boundary against a malicious agent with filesystem access.

Exit codes: `0` completed/validated; `2` failure or terminal state; `3` blocked; `4` round limit; `130` interrupted. Failed, unfinished, or explicitly skipped output never counts as approval.

## Auditing a run

Use the absolute `Run: ...` directory printed by the runner. The examples below read saved artifacts; they do not launch or resume agents. They describe saved-run format 2.

### Start with the run and its history

Set the path once in your terminal:

```sh
AUDIT_RUN='/absolute/path/to/.agent-loop/runs/RUN_ID'
python3 -m json.tool "$AUDIT_RUN/state.json"
python3 -m json.tool "$AUDIT_RUN/run.json"
tail -n 40 "$AUDIT_RUN/events.jsonl"
```

| Question | Where to look |
| --- | --- |
| What is happening now, or why did it stop? | `state.json`: `status`, `phase`, `round`, `reason`, and `terminalReason` when applicable. |
| What was the most recent outcome? | `summary.txt`. This is written at a halt or completion; while resuming, it can still describe the previous halt. Use `state.json` for current status. |
| Which workspace, agents, models, instructions, and checks were configured? | `run.json`: `workspace`, `configPath`, `configSha256`, and the resolved `config`. `inputs/config.json` preserves the original JSON bytes. |
| In what order did work happen? | `events.jsonl`: timestamped agent starts, finishes, failures, checks, queued revisions, resumes, and run outcomes. Parallel reviewers' events can interleave. |
| What did the user supply on resume? | `resumes/resume-NNN/resume.json`: message, skip IDs, round, phase, and workspace identities. The actual implementer message is also saved in that turn's `prompt.txt`. |
| Which input documents were originally supplied? | `inputs/manifest.json` maps source files to audit copies and hashes; `inputs/files/` contains those original bytes. Agents read live referenced documents, so these are not necessarily the bytes read during later turns. |

To follow orchestration while a run is active, use `tail -f "$AUDIT_RUN/events.jsonl"`. Agent activity is in each invocation's stdout/stderr logs, described below.

### Follow a round and its decisions

A **run** is the entire loop. A **round** is one implementation/revision phase followed by checks and review. The implementation phase can contain several **turns** after recoverable halts. Each turn is one CLI invocation in the same implementer session. A reviewer **attempt** is one CLI invocation in a fresh reviewer session. Turn and attempt numbering restart within each round.

For example, select the first round below; change `001` to inspect a later round:

```sh
AUDIT_ROUND="$AUDIT_RUN/rounds/001"
python3 -m json.tool "$AUDIT_ROUND/feedback.json"
```

`feedback.json` records the round's review statuses, exact `resultFile`/`reportFile` paths, required-check outcomes, and the candidate used for the round decision. It is written after review processing succeeds, including when a reviewer returns `BLOCKED`. It can be absent after an execution or parsing failure, or still describe an earlier pass through that round. In that case, use the latest invocation records and events to investigate.

| Round artifact | What it tells you |
| --- | --- |
| `implementation/turn-NNN.*` | Every implementation invocation, including same-round resumes. Round 1 begins with implementation; later rounds begin with revision. |
| `reviews/REVIEWER_ID/attempt-NN/` | Each review invocation. A retry creates another directory; reusing an accepted review creates no new attempt. Follow the `resultFile` in feedback to identify the result used. |
| `checks.json` and `checks-report.txt` | Latest required-check outcomes and paths to their logs. Each `checks/CHECK_ID/attempt-NN/result.json` retains its command, exit code, timeout flag, and pass/fail result. Earlier check attempts remain available. |
| `skipped-reviewers.json` | Explicit user skips for this round. `SKIPPED` is not approval, and completion can occur with every reviewer skipped. |
| `reviews/REVIEWER_ID/attempt-NN/invalidated.json` | That attempt was invalidated by source changes during active review. Its old verdict is retained as history but cannot be reused. |
| `candidate/` | The original round candidate: manifest, staged/unstaged patches, and untracked-file copies. |

For the candidate actually used after a resume, follow `feedback.json.candidateManifestFile`; it can point to `resumes/resume-NNN/workspace/manifest.json`. Compare the feedback's `candidateSha256` with each retained review's `candidateSha256`. They can differ because halt-time workspace edits intentionally preserve earlier successful reviews. To understand a revision, read its `turn-001.prompt.txt`: it contains the precise review-file paths supplied to the implementer, without inserting the reports' contents.

### Inspect one implementation turn or reviewer attempt

Use a filename prefix so the same commands work for both layouts. For implementation turn 1 in the selected round (change `001` for a later turn):

```sh
AUDIT_PREFIX="$AUDIT_ROUND/implementation/turn-001."
```

For a review instead, replace that assignment with the reviewer ID and attempt you want:

```sh
AUDIT_PREFIX="$AUDIT_ROUND/reviews/opus-reviewer/attempt-01/"
```

Print the recorded command and launch settings:

```sh
python3 - "${AUDIT_PREFIX}invocation.json" <<'PY'
import json
import shlex
import sys
from pathlib import Path

record = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print("Command:", shlex.join(record["argv"]))
print("Working directory:", record["cwd"])
print("Requested session:", record["sessionId"])
print("Timeout seconds:", record["timeoutSeconds"])
print("Same-round follow-up:", record["followup"])
PY
```

`argv` is the exact argument array submitted to the process launcher. The snippet formats it with shell quoting for reading; the runner itself does not use a shell. The command does not contain the prompt because the runner supplies `prompt.txt` through standard input. `invocation.json` is written before launch, so use `process.json` and any `error.json` to distinguish a launch failure from a process that ran. A null timeout means unlimited.

Read the prompt and process outcome, then inspect the raw logs:

```sh
cat "${AUDIT_PREFIX}prompt.txt"
python3 -m json.tool "${AUDIT_PREFIX}process.json"
tail -n 80 "${AUDIT_PREFIX}stdout.log"
tail -n 80 "${AUDIT_PREFIX}stderr.log"
```

| File suffix, appended to `AUDIT_PREFIX` | Contents |
| --- | --- |
| `prompt.txt` | Exact submitted user message. On same-round implementation resume, this is just the follow-up message or `Continue`; earlier instructions remain in the session context. Native system instructions and project context are not included in this file. |
| `invocation.json` | Executable and arguments, working directory, requested session, timeout, turn number, and whether this was a follow-up. |
| `process.json` | Process status, exit code, available start/finish timestamps, and timeout information when applicable. Exit code 0 alone does not establish a valid agent result. |
| `stdout.log` / `stderr.log` | Raw output captured from that CLI invocation. Stdout is native JSON/JSONL rather than necessarily a plain conversation transcript. Use `tail -f` to watch either file while the invocation runs. |
| `result.json` | Validated verdict, report body/hash, agent/harness identity, configured/reported model, session ID, usage when available, and artifact paths. `BLOCKED` is a valid result too. |
| `error.json` | Failure message and `failureStage`: `execution` or `result`. For example, exit code 0 plus a result-stage error means the process exited successfully but its output could not be accepted. |
| `report.txt` | Reviewer report, or the archived report for that implementation turn. In the implementation layout, the prefix makes this `turn-NNN.report.txt`. |

Files appear as the invocation progresses. A failed invocation may have no `result.json` or valid report. For an implementation's historical report, use `turn-NNN.report.txt` or `result.json.archivedReportFile`: the unprefixed `implementation/report.txt` is the latest live report for that round, and an older result's `reportFile` still points there. `turn-NNN.previous-report` preserves the prior live report moved aside before that turn, including any halt-time edits.

The final response is distinct from the report and the normalized verdict:

| Harness | Where to read the actual final response |
| --- | --- |
| Codex | `${AUDIT_PREFIX}harness-result.txt`. Stdout separately contains native events. |
| Claude Code | The `result` text field in the JSON envelope in `${AUDIT_PREFIX}stdout.log`. |
| pi | Text blocks in the final assistant `message_end` event in `${AUDIT_PREFIX}stdout.log`, followed by the completed `agent_end` event. Earlier messages and tool output are not the final response. |

`result.json.status` stores the extracted verdict, not the full final response. Inspect the original final response when diagnosing missing or multiple status tokens. If an invocation failed before completion, there may be no final response at all.

### Verify model and thinking settings

Check `run.json.config.agents` for the frozen request and the specific `invocation.json.argv` for what was passed to that CLI. When result validation succeeded, `result.json.configuredModel` repeats the configured model object and `reportedModel` records the model returned by the adapter when available.

| Harness | Model argument | Thinking/effort argument to look for |
| --- | --- | --- |
| Codex | `--model MODEL` | `-c 'model_reasoning_effort="xhigh"'` (or `--config` with that setting). |
| Claude Code | `--model MODEL` | `--effort xhigh`. |
| pi | `--model MODEL`, optionally `--provider PROVIDER` | `--thinking xhigh`. |

For example, the calculator configuration requests `gpt-6-astra` with `xhigh` for its implementer and Codex reviewer, and `claude-opus-5` with `xhigh` for its Claude reviewer. Confirm those requests in each invocation's saved arguments; an agent ID such as `astra-reviewer` is only a label.

**Requested settings and reported settings are different evidence.** The current Codex adapter leaves `reportedModel` null; Claude and pi fill it only when their output supplies it. No normalized field records or verifies the effective thinking level. If model/effort arguments are absent, CLI defaults may apply and these artifacts may not establish which settings were used. Native CLI versions, environment variables, and effective native configuration are not snapshotted. A report's self-described model name is agent-authored text, not independent confirmation.

### Trace the native agent sessions

The run's implementer session is recorded in `state.json.implementerSessionId` and the `implementer.session` event. Its first invocation has `invocation.json.sessionId: null` because the session is discovered after launch. Its validated result records the resulting ID. Later turns and revision rounds request that same ID in `invocation.json`; they are new processes continuing the same conversation. A recoverable invalid result can still leave the session ID saved in `state.json` even though no `result.json` exists.

Reviewer invocations always have `invocation.json.sessionId: null`, meaning a fresh session was requested. Their validated `result.json.sessionId` identifies the resulting conversation when the harness supplies it. For failed attempts without a result, native session metadata may still be present in stdout; do not infer an ID from the reviewer name or attempt number.

For Codex and Claude, the native conversation history remains in the CLI's own storage; the runner saves the session ID and captured output, not a complete copy of that history. Use the recorded ID to locate that conversation in the harness's history. For pi, the session identity is the explicit JSONL path passed with `--session`. The first implementation turn normally creates `turn-001.session.jsonl`; later turns append to that same file, while per-turn stdout logs remain separate. Reviewer pi sessions live in their individual attempt directories.

## Harness setup

- **Codex:** Uses `codex exec`, JSON events, its final-response file, and explicit `workspace-write`. It does not enable approval/sandbox bypass. Persistent sessions require the CLI's normal local session storage to be writable. Headless commands that need fresh approval can fail; configure the required access before an unattended run. [Official noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
- **Claude Code:** Uses print mode, native JSON result envelopes, and exact session resumption. The adapter retains configured permission mode and disables interactive permission prompts with `--permission-prompts none`; use a version supporting this option (2.1.259+), and allow the tools the task requires through native settings or `args`. Denied tools must be reported as blocked verification. [Official headless documentation](https://code.claude.com/docs/en/headless).
- **pi:** Uses print/JSON mode and explicit session files. Its final assistant text is validated by the runner. For the installed pi 0.85.0, Node 22.19+ is required. On this Mac, putting `/opt/homebrew/opt/node/bin` first in `PATH` selects a compatible existing Node installation. [pi documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs).

All agents inherit the runner's environment. Configure GCP credentials, Tailscale/SSH, toolchains, and harness authentication on that execution host. This runner does not provision credentials, remotely host agents, or serialize arbitrary cloud deployments. For tests sharing a mutable VM, use `parallelReviews: false` or provide deployment commands that take an external lock.

## Test without models

From this implementation directory:

```sh
python3 -m unittest discover -s tests -v
```

The integration suite launches an executable fake Codex CLI against temporary Git repositories. It tests a predictable three-round sequence: reviewer A requests changes in round 1, reviewer B requests changes in round 2, and both approve round 3. It also exercises blocked/crashed/malformed reviewers, stale review detection, timeouts, required checks, and resume. Adapter tests cover native output envelopes for Codex, Claude, and pi; these tests do not consume model tokens.

## Disposable live smoke test

`examples/smoke` contains a deliberately buggy tag-normalization function, eight unit tests, specification, review rubric, prompts, and a Codex-only config with two independent reviewers. Copy it to a new directory; leave the original fixture unchanged:

```sh
cp -R /path/to/agent-loop/examples/smoke /tmp/my-agent-loop-smoke
cd /tmp/my-agent-loop-smoke
git init
git add .
git -c user.name='Agent Loop Smoke' -c user.email='smoke@example.invalid' commit -m 'Initial fixture'
python3 /path/to/agent-loop/agent_loop.py --validate loop.json
python3 /path/to/agent-loop/agent_loop.py loop.json
```

The destination must not already exist. Six fixture tests fail initially. A correct implementation passes all eight, and both reviewers must approve. A real model may fix everything in one round; the scripted tests cover predictable revision routing. This example performs no GCP operations and does not use the TEE project.

Live verification in the current Codex desktop environment was attempted and failed before a model turn: the nested Codex CLI could not write its local state database or initialize its app-server, including after a permission retry. The run retained both failed attempts. Run the smoke command from a normal authenticated terminal with writable Codex session storage to complete live verification. Claude/pi adapters have protocol tests but have not been exercised against live models here.
