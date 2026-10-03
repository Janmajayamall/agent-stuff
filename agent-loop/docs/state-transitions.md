# Loop states and recovery

A run contains numbered rounds, starting at `001`. A round consists of an
implementation invocation, required checks, and reviews. The first round uses
`instructions.implement`; subsequent rounds use `instructions.revise`.

## One implementer session

The first implementation establishes the run's only implementer session. The
runner saves its native session identifier before validating the final verdict
and report whenever that identifier is recoverable from the CLI output. Every
later implementation invocation must resume that exact session.

An invocation is a new CLI process; a session is its persistent conversation.
Changing the round or starting a CLI process does not create another conversation:

```text
Round 001: implement, session S, turn 001 → BLOCKED
Round 001: resume,    session S, turn 002 → BLOCKED
Round 001: resume,    session S, turn 003 → IMPLEMENTATION_COMPLETE
Round 001: checks and reviews             → CHANGES_REQUIRED
Round 002: revise,    session S, turn 001 → IMPLEMENTATION_COMPLETE
Round 002: checks and reviews             → NO_CHANGES_REQUIRED
Run: COMPLETED
```

The runner never substitutes a fresh implementer session to recover a missing,
unavailable, or mismatched session. Such a run becomes `TERMINAL` with
`terminalReason: SESSION_UNAVAILABLE`. A launch failure before a session exists
does not create an exception to this rule: recovery requires a new run.

Reviewer sessions are independent. Each reviewer invocation, including a retry,
starts a fresh session.

## States and transitions

`state.json` records the status, current round, phase, and implementer session.
Phases are `implementation`, `checks`, and `review`. `BLOCKED`, `FAILED`, and
`INTERRUPTED` halt the runner rather than retrying automatically.

| Current work or event | Saved status / next work | What `--resume` does |
| --- | --- | --- |
| New run | `RUNNING`, round 1 implementation | Not needed during active work. |
| Implementer returns `IMPLEMENTATION_COMPLETE` and a valid report | Checks, then review | Continues the unfinished phase if the runner was interrupted. |
| Implementer returns `BLOCKED` and a valid report | `BLOCKED`, same round | Continues the same implementer session with a follow-up message. |
| Implementer exits successfully but has invalid final output or report | `FAILED`, same round | Continues the same implementer session; if that session is unrecoverable, becomes terminal. |
| Implementer crashes, exits unsuccessfully, cannot launch, times out, or emits an explicit native failure event | `TERMINAL`, `IMPLEMENTER_PANIC` | Rejected. Start a new run, even if a native failure was returned with CLI exit code 0. |
| Implementer session is lost or changes unexpectedly | `TERMINAL`, `SESSION_UNAVAILABLE` | Rejected. Start a new run. |
| User interrupts with Ctrl-C or SIGTERM | `INTERRUPTED`, or `TERMINAL` / `SESSION_UNAVAILABLE` when implementation's session cannot be recovered | Continues unfinished work only when the run is not terminal. |
| Required check fails | Reviews, followed by revision if review is resolved | Failure remains feedback and prevents completion. |
| Reviewer returns `BLOCKED` | `BLOCKED`, review phase | Retries that reviewer unless explicitly skipped. |
| Reviewer crashes, times out, or produces invalid output/report | `FAILED`, review phase | Retries failed or unfinished reviewers unless explicitly skipped. |
| All reviewers are accepted or explicitly skipped, and an accepted review requests changes or a required check failed | Next round's implementation | Normal operation sends `instructions.revise` to the same session. |
| All reviewers are accepted or explicitly skipped, no accepted review requests changes, and checks pass | `COMPLETED` | Reports completion without launching agents. |
| Changes/check failures remain at `maxRounds` | `ROUND_LIMIT` | Requires a new run with a different limit. |
| Original configuration bytes changed or its file is missing | `TERMINAL`, `CONFIG_CHANGED` | Rejected; remains terminal even if the file is later restored. |

In parallel review mode, other reviewers finish before the review phase halts.
Their accepted results are saved. `CHANGES_REQUIRED` is a completed review, not
a failed reviewer invocation.

The configuration check compares the original file against the exact bytes saved
at run creation. Whitespace-only changes also count. A change becomes terminal
when the runner detects it; this is not a background file watcher. Once recorded,
the terminal state cannot be cleared by restoring the configuration.

Saved run format version 2 is required. Older saved runs are explicitly rejected;
there is no migration. The input configuration's version is still `1`.

## Resuming implementation

Fix the blocker in the workspace, then optionally tell the same agent what
changed:

```sh
python3 /path/to/agent-loop/agent_loop.py --resume /path/to/RUN_ID \
  --prompt "The retry policy in docs/plan.md is now explicit. Read it again and continue."
```

For a longer message:

```sh
python3 /path/to/agent-loop/agent_loop.py --resume /path/to/RUN_ID \
  --prompt-file ./resume-notes.md
```

`--prompt` and `--prompt-file` are mutually exclusive and only valid when
resuming an existing implementation turn in the current round. The file must contain UTF-8 text; its path resolves
from the directory where this resume command was invoked. Its contents become
the message. If neither is provided, the message is exactly `Continue`.

The runner sends only that message. It does not resend the implementation or
revision prompt, substitute variables into the message, expand `@` references,
or prepend continuation instructions. The session already contains the task and
the current round's report path. The exact submitted message is stored with the
new turn's logs. `instructions.continuation` is not a configuration field.

If the runner was interrupted after queuing a round but before its first
implementation turn, there is no same-round turn to continue. Resume without a
message sends that round's original implementation or revision prompt, using the
existing implementer session for a revision. A supplied `--prompt` or
`--prompt-file` is rejected in this case rather than discarded.

Same-round resume preserves the round number and report destination:

```text
rounds/001/implementation/report.txt
```

Each nonempty regular UTF-8 report is copied to `turn-NNN.report.txt`, including
reports written by a turn whose verdict failed validation. Before the next
invocation, the live report is moved to that next turn's `turn-NNN.previous-report`
file. This also preserves any report edits made during the halt. The new turn
must write a new `report.txt`. Starting a new revision round sends the
authored revision template with that new round's report path and
`{{reviewDetails}}`. Review details identify accepted reviews, their statuses and
report paths, explicit skips, and failed-check report paths. Report contents are
never inserted into the prompt.

## Resuming reviews and skipping reviewers

Ordinary review resume reruns only failed, blocked, or unfinished reviewers in
the current round. Successful `CHANGES_REQUIRED` and `NO_CHANGES_REQUIRED`
results are retained. Their saved reports must still match their recorded
hashes.

Use a repeatable option to skip selected failed reviewers:

```sh
python3 /path/to/agent-loop/agent_loop.py --resume /path/to/RUN_ID \
  --skip-reviewer opus-reviewer \
  --skip-reviewer astra-reviewer
```

This option is valid only for a review-phase resume. Unknown IDs and requests to
skip an already successful reviewer are rejected. There is no blanket skip
flag; list every failed ID to skip them all.

The runner records `SKIPPED` for each selected reviewer in the round's
`skipped-reviewers.json` and feedback, and names skipped reviewers in the
completion summary for that round. A skip is not an approval. There is no minimum
number of accepted reviews: explicitly skipping all failed reviewers can permit
completion, but required checks must still pass. An accepted
`CHANGES_REQUIRED` result still causes revision. Skips apply only to the current
round; all configured reviewers participate again after a new revision.

## Workspace edits during a halt

Editing workspace files, PLAN documents, or other referenced documents during a
halt is allowed. The implementer resumes the same session against the current
files. Saved instruction templates remain frozen, while paths in those prompts
still point to live documents. Use a follow-up message to direct the implementer
to an updated plan when helpful.

On review resume, workspace edits made during the halt **do not invalidate
successful earlier reviews**. This is an explicit policy choice: reused review
reports can describe an older version of the workspace. Report-integrity checks
still apply. Required checks rerun if the workspace changed before resuming the
checks or review phase, even when no reviewer needs to rerun. The resume snapshot
becomes the current candidate; each accepted review retains its original
candidate identity for audit. Source changes during an actively running review invalidate that
review batch; affected attempts receive a persistent `invalidated.json` marker.
Later successful retries are separate attempts and remain reusable if another
reviewer's retry fails. Halt-time editing is not permission for reviewers to edit source.

Changing the original loop configuration is different: it makes the run
terminal when detected. Start a new run for different agents, models, checks,
limits, or instruction definitions in that JSON file. The runner does not commit
implementation work, and an implementer must not change Git HEAD.

## Run directory example

This example has two implementation blockers in round 1 and two completed review
phases. All four implementer invocations use the same native session.

```text
RUN_ID/
├── run.json                         # Original configuration path/hash, resolved configuration
├── state.json                       # COMPLETED; round 2; implementer session S
├── events.jsonl                     # Runner transitions and agent events
├── summary.txt
├── inputs/
│   ├── config.json                  # Original configuration bytes
│   ├── resolved-prompts.json        # Frozen implement/revise/review templates
│   ├── manifest.json
│   └── files/                       # Original prompt/reference bytes for audit
├── initial-workspace/
├── resumes/
│   ├── resume-001/
│   │   ├── resume.json             # Message, skip IDs, before/after workspace identities
│   │   └── workspace/              # Present when files changed during the halt
│   └── resume-002/
│       └── resume.json
└── rounds/
    ├── 001/
    │   ├── implementation/
    │   │   ├── report.txt           # Stable current report path for round 1
    │   │   ├── turn-001.*           # Initial implementation → BLOCKED
    │   │   ├── turn-002.*           # First resume → BLOCKED
    │   │   ├── turn-002.previous-report # Prior live report moved before first resume
    │   │   └── turn-003.*           # Second resume → IMPLEMENTATION_COMPLETE
    │   ├── candidate/              # Recorded candidate and Git changes
    │   ├── checks/CHECK_ID/attempt-01/
    │   ├── checks.json
    │   ├── checks-report.txt
    │   ├── reviews/
    │   │   ├── opus-reviewer/attempt-01/   # CHANGES_REQUIRED
    │   │   └── astra-reviewer/attempt-01/  # NO_CHANGES_REQUIRED
    │   └── feedback.json
    └── 002/
        ├── implementation/
        │   ├── report.txt           # Stable current report path for round 2
        │   └── turn-001.*           # Revision → IMPLEMENTATION_COMPLETE
        ├── candidate/
        ├── checks/CHECK_ID/attempt-01/
        ├── checks.json
        ├── checks-report.txt
        ├── reviews/
        │   ├── opus-reviewer/attempt-01/   # NO_CHANGES_REQUIRED
        │   └── astra-reviewer/attempt-01/  # NO_CHANGES_REQUIRED
        └── feedback.json
```

`turn-001.*` represents `turn-001.prompt.txt`, `turn-001.invocation.json`,
`turn-001.stdout.log`, `turn-001.stderr.log`, `turn-001.process.json`,
`turn-001.result.json` for accepted results, and `turn-001.report.txt` when a valid
report file was written. A failure adds
`turn-001.error.json`; a harness may also write `turn-001.harness-result.txt`.
The turn number identifies a CLI invocation, not a new session.

Reviewer attempts retain subdirectories containing `prompt.txt`,
`invocation.json`, `stdout.log`, `stderr.log`, `process.json`, `report.txt`, and
`result.json`, with `error.json` on failure and harness artifacts when present.
Retrying a reviewer creates `attempt-02/` without replacing `attempt-01/`.
The result file exists only when result validation succeeds. A round with
explicit skips also contains `skipped-reviewers.json`.
An attempt invalidated by source changes during active review also contains
`invalidated.json`; that marker remains with the old attempt after a retry.

Run artifacts are retained; recovery does not reset, stash, or restore source
files. A new run is a new orchestration history and a new implementer session,
not an automatic rollback of earlier work.
