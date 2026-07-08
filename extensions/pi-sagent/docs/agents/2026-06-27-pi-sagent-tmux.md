# pi-sagent tmux implementation plan

## Purpose

Implement `sagent` as a tmux-backed Pi subagent runner.

The extension launches each child Pi agent inside a detached tmux session, waits for normal completion in the foreground, and lets the user inspect the live child by attaching to tmux while the parent tool call is waiting.

If the foreground wait times out softly, the child remains alive in tmux. The parent can later call `sagent_wait` with a new timeout value to resume waiting for that same child.

## Non-negotiable decisions

1. **tmux-only implementation.** Do not add a `backend` parameter. `sagent` always uses tmux.
2. **Completion marker is produced by wrapper code.** The model must not be responsible for writing `done.json`.
3. **Child Pi uses `--no-session`.** Child sessions must not pollute Pi's normal session directory.
4. **tmux is for observability/liveness, not result extraction.** Do not scrape tmux panes for normal model-visible results.
5. **Result source is child JSONL/artifacts.** Parse `child.jsonl` and write/read `result.md`.
6. **Soft timeout only.** `timeoutMs` means “wait this long before returning a running-status response”. It must not kill the tmux session.
7. **Concurrency is capped by live tmux sessions.** The `concurrency` parameter limits the number of child tmux sessions that are alive at the same time, not the number of foreground waits. A soft-timed-out child is still alive and still consumes a concurrency slot.
8. **`sagent_wait` resumes waiting on existing work.** It reuses an existing running/soft-timed-out tmux child or resumes the run scheduler for queued tasks; it applies a new soft timeout and must still respect the live-tmux concurrency cap.
9. **Parent abort kills active child tmux sessions owned by the active tool call.** If an active `sagent` or `sagent_wait` tool call is aborted/Escaped, kill the tmux sessions that tool call is currently waiting on.
10. **No post-completion tmux keepalive.** After child Pi exits and the wrapper finishes, the tmux session may exit. Postmortem inspection uses artifacts.
11. **No raw log/context pollution.** Timeout and failure responses must be compact and path-oriented; full JSONL/stderr remain on disk.

## Public tools

Register these tools:

```ts
sagent(params)
sagent_wait({ id, task?, timeoutMs? })
sagent_status({ id?: string })
```

Do not add public `backend`, `hardTimeoutMs`, or `keepAlive` parameters.

### `sagent` parameters

Preserve the existing shape:

```ts
{
  maxDepth?: number,
  concurrency?: number,
  tasks?: Array<{
    name?: string,
    description?: string,
    prompt: string,
    systemPrompt?: string,
    systemPromptMode?: "append" | "replace",
    tools?: string[],
    model?: string,
    cwd?: string,
    timeoutMs?: number
  }>,

  name?: string,
  description?: string,
  prompt?: string,
  systemPrompt?: string,
  systemPromptMode?: "append" | "replace",
  tools?: string[],
  model?: string,
  cwd?: string,
  timeoutMs?: number
}
```

Update the `timeoutMs` description to say: **soft wait timeout in milliseconds; on timeout the tmux child remains alive and can be inspected, checked later with `sagent_status`, or waited on again with `sagent_wait`.**

### `sagent_wait` parameters

Add a new tool schema:

```ts
{
  id: string,
  task?: number | string,
  timeoutMs?: number
}
```

Parameter semantics:

- `id`: run id, e.g. `run-abc123`.
- `task`: optional task selector. Accept task index number, exact task name, or unique task name prefix.
- `timeoutMs`: new soft wait timeout in milliseconds. If omitted, wait without a soft timeout.

Task selection and scheduler rules:

1. If `task` is provided, select that task as the primary wait target.
2. If `task` is omitted, `sagent_wait` is run-level: it resumes the run scheduler, waits for currently live tasks and any queued tasks it is allowed to launch under the concurrency cap, and returns when the run completes or the new soft timeout expires.
3. If the selected task is already completed/failed/aborted, return its current terminal result/status immediately after reconciling the run.
4. If the selected task is `queued`, `sagent_wait` may launch it only when the run's live tmux session count is below the persisted run concurrency.
5. If the selected task is `running` or `timeout`, `sagent_wait` must wait on that existing tmux session; it must not launch a duplicate child for that task.

`sagent_wait` must not send input to the child. It may launch queued tasks only through the shared run scheduler and only while respecting the live-tmux concurrency cap.

## Artifact layout

For each `sagent` run:

```text
~/.pi/agent/pi-sagent/runs/<run-id>/
  status.json
  <task-index>-<safe-name>/
    prompt.md
    run.sh
    command.txt
    child.jsonl
    child.stderr.log
    wrapper.log
    result.md
    done.json
```

Each run in `status.json` must persist the effective concurrency used for scheduling:

```ts
concurrency: number;
```

Each task state in `status.json` must include all important paths and tmux metadata.

Add fields to `SagentTaskState`:

```ts
taskDir: string;
tmuxSession?: string;
attachCommand?: string;
promptPath: string;
wrapperPath: string;
commandPath: string;
stderrPath: string;
donePath: string;
softTimedOutAt?: string;
lastWaitStartedAt?: string;
lastWaitFinishedAt?: string;
```

Existing `logPath`, `jsonlPath`, and `resultPath` can remain, but map them to the new per-task files:

```ts
jsonlPath  -> <taskDir>/child.jsonl
logPath    -> <taskDir>/child.stderr.log or wrapper.log; prefer explicit stderrPath too
resultPath -> <taskDir>/result.md
```

## Wrapper protocol

The extension writes `prompt.md` and `run.sh`. The tmux session runs `bash run.sh`.

`run.sh` must:

1. Record start time.
2. Run child Pi in print JSON mode.
3. Redirect stdout to `child.jsonl`.
4. Redirect stderr to `child.stderr.log`.
5. Record the child exit code.
6. Atomically write `done.json`.
7. Exit with the child exit code.

The child Pi command must use:

```bash
pi -p --mode json --no-session --approve ... @<prompt.md>
```

Preserve existing model/system-prompt/tool behavior:

- If `model` exists, pass `--model <model>`.
- If `systemPrompt` exists and mode is `replace`, pass `--system-prompt <text>`.
- If `systemPrompt` exists and mode is `append`, pass `--append-system-prompt <text>`.
- Always pass `--tools <comma-separated-tools>` using the normalized tool list.
- Always pass the task through `@prompt.md`, never as an inline command argument.

`done.json` shape:

```json
{
  "state": "completed" | "failed",
  "exitCode": 0,
  "startedAt": "2026-06-27T00:00:00.000Z",
  "finishedAt": "2026-06-27T00:00:10.000Z",
  "resultPath": "/abs/path/result.md",
  "jsonlPath": "/abs/path/child.jsonl",
  "stderrPath": "/abs/path/child.stderr.log"
}
```

The wrapper does not need to parse the final result. Parent TypeScript parses `child.jsonl` after it sees `done.json`. If the wrapper writes `done.json` before parent parsing, `result.md` may be created by the parent.

## Tmux protocol

Use env override constants:

```ts
PI_SAGENT_TMUX_BIN // default "tmux"
PI_SAGENT_PI_BIN   // default "pi"
```

Required tmux operations:

```bash
tmux new-session -d -s <session> -c <cwd> 'bash <taskDir>/run.sh'
tmux has-session -t <session>
tmux kill-session -t <session>
tmux attach-session -t <session>
```

Session names must be deterministic and safe, for example:

```text
pi-sagent-<run-id-without-run-prefix>-<task-index>-<safe-name>
```

Store the attach command in task state:

```text
tmux attach-session -t <session>
```

After launching a tmux session, immediately surface the session name and attach command through:

1. `onUpdate(...)` for the active tool row.
2. `ctx.ui.setWidget(...)` via existing widget path.
3. `status.json` for `sagent_status` and `sagent_wait`.

The parent model only receives the final tool return after completion or soft timeout, but the human must be able to see the tmux id while the child is running.

## Concurrency and scheduling semantics

The `concurrency` parameter caps **live child tmux sessions**, not foreground wait workers.

Definitions:

- **Terminal task:** `completed`, `failed`, or `aborted`.
- **Queued task:** task with no tmux session launched yet.
- **Live task:** a task whose `tmuxSession` still exists and whose `done.json` does not exist. This includes both `running` and soft-timed-out `timeout` tasks.
- **Live count:** number of live tasks in the run.

Scheduling rules:

1. Persist the effective run concurrency in `status.json` (`Math.floor(params.concurrency)` when positive, otherwise `tasks.length`, clamped to at least 1 and at most `tasks.length`).
2. A queued task may launch only when `liveCount < run.concurrency`.
3. A soft-timed-out task remains live and continues to consume one concurrency slot.
4. `waitForTask` returning `soft-timeout` must not free a concurrency slot.
5. A concurrency slot is freed only when reconciliation sees `done.json`, missing tmux with failure, or an explicit abort/kill.
6. The run scheduler must never launch a queued task merely because a foreground wait ended in soft timeout.
7. After any reconciliation that makes a task terminal, the scheduler may launch queued tasks while `liveCount < run.concurrency`.
8. `sagent_status` reconciles state but must not launch queued tasks. Status is observational.
9. `sagent` and run-level `sagent_wait({ id, timeoutMs })` are scheduler-driving calls: they may launch queued tasks while slots are available.
10. Task-level `sagent_wait({ id, task, timeoutMs })` may launch the selected task if it is queued and a slot is available; otherwise it waits for that selected existing live task. It must not launch unrelated queued tasks just because the selected task soft-times out.

Return behavior when soft timeout blocks the queue:

- If `sagent` or run-level `sagent_wait` reaches soft timeout while live tasks still occupy all concurrency slots, return compact running-status responses for live timed-out tasks and compact queued-status responses for any not-yet-launched tasks.
- Queued-status responses must explain that the task has not started because live tmux children still occupy the run's concurrency slots, and that `sagent_wait({ id, timeoutMs: ... })` can resume the run scheduler later.
- This guarantees live tmux sessions never exceed the configured concurrency, even across repeated soft timeouts and waits.

## Shared wait/reconcile routine

Implement shared routines used by `sagent`, `sagent_wait`, and `sagent_status`:

```ts
refreshTaskFromArtifacts(run, taskState): Promise<SagentTaskState>
liveTaskCount(run): Promise<number>
advanceRunQueue(run, options): Promise<SagentTaskState[]>
waitForTask(run, taskState, options): Promise<WaitOutcome>
waitForRun(run, options): Promise<RunWaitOutcome>
```

`refreshTaskFromArtifacts` reconciles task state without blocking:

1. If `done.json` exists, parse result if needed and update task to `completed` or `failed`.
2. Else if `tmuxSession` exists and `tmux has-session` succeeds, keep/report `running` or `timeout`.
3. Else if task was `running`/`timeout` but tmux is gone and `done.json` is missing, mark `failed` with error `tmux session ended without done.json`.

`liveTaskCount` counts only tasks whose tmux session still exists and whose `done.json` does not exist.

`advanceRunQueue` launches queued tasks while `liveTaskCount(run) < run.concurrency`. It returns only the tasks it launched. It must not treat soft-timeout as freeing a slot.

`waitForTask` blocks on one task until one of these outcomes:

- `completed`
- `failed`
- `soft-timeout`
- `aborted`
- `queued-blocked-by-concurrency`

It must be usable both for newly launched tasks and previously soft-timed-out tasks. If called for a queued task while the run is at its live concurrency cap, it returns `queued-blocked-by-concurrency` instead of launching.

`waitForRun` drives the scheduler for a whole run. It repeatedly reconciles tasks, advances the run queue while slots are available, waits on live tasks, and stops when the run is terminal or the call's soft timeout expires.

## `sagent` wait loop

`sagent` is a scheduler-driving call.

1. Normalize tasks and persist the run with effective `concurrency`.
2. Create artifact directories, `prompt.md`, and `run.sh` for all tasks, but do not launch all tasks immediately.
3. Call `advanceRunQueue` to launch only up to `run.concurrency` live tmux sessions.
4. For launched tasks, mark `running`, persist, update widget/onUpdate.
5. Call `waitForRun` using the relevant soft timeout behavior.
6. If a live task soft-times out, it remains live and still counts against `run.concurrency`.
7. Launch additional queued tasks only after reconciliation makes a live task terminal and `liveTaskCount < run.concurrency`.
8. Return completed/failed/timeout/queued-blocked content items for all tasks.

Polling interval: small fixed interval, e.g. 1000 ms.

## `sagent_wait` wait loop

`sagent_wait` has two modes.

### Run-level wait: `sagent_wait({ id, timeoutMs })`

1. Load run status from memory or disk.
2. Reconcile all tasks with `refreshTaskFromArtifacts`.
3. Call `advanceRunQueue` to fill available live tmux slots up to `run.concurrency`.
4. Set `lastWaitStartedAt` on live tasks this call is waiting on, persist, update widget/onUpdate.
5. Call `waitForRun` with the new `timeoutMs`.
6. Return completed/failed/soft-timeout/queued-blocked output for all tasks.

### Task-level wait: `sagent_wait({ id, task, timeoutMs })`

1. Load run status from memory or disk.
2. Resolve the selected task by index/name/prefix.
3. Reconcile all tasks with `refreshTaskFromArtifacts`.
4. If the selected task is terminal, return terminal result/status immediately.
5. If the selected task is queued, call `advanceRunQueue` only if `liveTaskCount < run.concurrency`; if no slot is available, return queued-blocked compact status.
6. If the selected task is `running` or `timeout`, wait on its existing tmux session.
7. Set `lastWaitStartedAt`, persist, update widget/onUpdate.
8. Call `waitForTask` with the new `timeoutMs`.
9. Return completed/failed/soft-timeout/queued-blocked output for the selected task.

`sagent_wait` must include the same tmux session and attach command in `onUpdate` and returned `details` when a tmux session exists.

## Soft timeout behavior

This section defines how both `sagent` and `sagent_wait` return a compact running-status response.

When `timeoutMs` expires while the tmux session is still alive:

1. Do **not** kill the tmux session.
2. Set task state to `timeout`.
3. Set/update `softTimedOutAt`.
4. Set `lastWaitFinishedAt`.
5. Keep `tmuxSession`, `attachCommand`, and all artifact paths in task state.
6. Persist `status.json`.
7. Optionally write `result.md` containing only the compact timeout status text if no real result exists yet.
8. Return a normal tool result, not an exception and not a raw log dump.

The model-visible text for that task must be compact and deterministic:

```text
# pi-sagent status: <task-name>

Run: <run-id>
Task selector: <task-index-or-name>
Status: still running after soft timeout
Timeout: <timeoutMs> ms
Tmux session: <tmux-session>
Attach: tmux attach-session -t <tmux-session>
Artifacts: <task-dir>
Result file when ready: <result-path>
JSONL log: <jsonl-path>
Stderr log: <stderr-path>
Check later: sagent_status({ id: "<run-id>" })
Wait again: sagent_wait({ id: "<run-id>", task: <task-index>, timeoutMs: <new-timeout-ms> })

<status>
The subagent is still running in tmux. The soft wait timeout expired, so this tool call is returning control to the parent without killing the child.
</status>
```

The returned `details` must include the run id, selected task, task state, tmux session, attach command, and artifact paths.

Do not mark the tool execution as an error for soft timeout. It is a successful tool return containing a running-status report.

When a task remains queued because live tmux sessions are already at the concurrency cap, return compact queued-status text:

```text
# pi-sagent status: <task-name>

Run: <run-id>
Task selector: <task-index-or-name>
Status: queued; not launched
Concurrency: <live-count>/<run-concurrency> live tmux sessions
Artifacts: <task-dir>
Check later: sagent_status({ id: "<run-id>" })
Resume scheduler: sagent_wait({ id: "<run-id>", timeoutMs: <new-timeout-ms> })

<status>
This task has not started because live tmux children still occupy the run's concurrency slots. No tmux session exists for this task yet.
</status>
```

Queued-status is also a normal successful tool return, not a tool error.

### Run state after soft timeout

If any task is `running`, `timeout`, or `queued` behind live concurrency slots, the run state should remain `running` in `status.json`. `sagent_status` later reconciles terminal artifacts, and run-level `sagent_wait` can continue scheduling queued tasks as live slots free.

### Multiple tasks

For `tasks[]`, `sagent` returns one content item per task as today:

- completed task -> compact result
- failed task -> compact failure with paths
- soft-timed-out task -> compact running-status response above
- queued task blocked by live concurrency -> compact queued-status response

A task's `timeoutMs` applies to that task's foreground wait only. Do not introduce a separate global run timeout.

Run-level `sagent_wait({ id, timeoutMs })` may continue scheduling queued tasks as live slots free. Task-level `sagent_wait({ id, task, timeoutMs })` focuses on the selected task and must still respect the live-tmux concurrency cap.

## Abort behavior

Abort means Pi cancels the active tool execution through the tool's `AbortSignal`, for example because the user presses Esc/Ctrl-C for the parent turn. Abort is different from soft timeout: timeout returns a normal running-status response and leaves children alive; abort is explicit cancellation and kills the relevant tmux children.

Abort handling must be best-effort but deterministic in persisted state:

1. First reconcile tasks from artifacts. If `done.json` already exists for a task, terminal completion/failure wins and that task is not killed or overwritten.
2. Kill the tmux sessions in the abort scope that still exist.
3. Mark every non-terminal task in the abort scope as `aborted`.
4. Set `finishedAt` and `error: "aborted by parent"` or equivalent on aborted tasks.
5. Persist `status.json`.
6. Clear/update widget.
7. Return/throw according to Pi tool abort conventions. If a result is emitted, it must be compact and must not include logs.

### Abort scope for `sagent`

An active `sagent` call owns the whole run it just created.

If its abort signal fires:

- Kill all live tmux sessions in that run.
- Mark all non-terminal tasks in that run as `aborted`, including queued tasks that were never launched.
- Set the run state to `aborted` unless all tasks had already reached terminal non-aborted states during the pre-abort reconciliation.
- Do not leave queued tasks resumable by `sagent_wait`; the initial run was cancelled.

### Abort scope for run-level `sagent_wait({ id, timeoutMs })`

A run-level `sagent_wait` owns the run's current non-terminal work for the duration of that wait.

If its abort signal fires:

- Kill all live tmux sessions in the run.
- Mark all non-terminal tasks in the run as `aborted`, including queued tasks not yet launched.
- Set the run state to `aborted` unless all tasks had already reached terminal non-aborted states during the pre-abort reconciliation.
- Do not leave queued tasks resumable by another run-level wait; this wait cancelled the resumed run.

### Abort scope for task-level `sagent_wait({ id, task, timeoutMs })`

A task-level `sagent_wait` owns only the selected task.

If its abort signal fires:

- Reconcile the selected task first. If it is already terminal, leave it unchanged.
- If the selected task has a live tmux session, kill only that tmux session.
- Mark only the selected non-terminal task as `aborted`.
- Do not kill or mark unrelated live tasks in the same run.
- Do not launch queued replacement tasks as a side effect of this abort; a later run-level `sagent_wait` may continue scheduling remaining non-terminal tasks if the run itself is not fully aborted.

A child that survived a previous soft timeout is not killed unless a later active `sagent_wait` whose abort scope includes that child is aborted, an active `sagent`/run-level wait for its run is aborted, or the user manually kills it using the recorded tmux command.

## Result parsing

After `done.json` appears:

1. Read `child.jsonl`.
2. Prefer final assistant text from the latest `agent_end` event with assistant messages.
3. Fallback to accumulated `message_update` text deltas.
4. If exit code is nonzero or no result text is found, create a compact failure diagnostic with paths.
5. Write `result.md`.
6. Set task state:
   - `completed` when exit code is 0 and result extraction succeeds.
   - `failed` otherwise.

Failure text must not include full `child.jsonl` or full stderr. Include paths instead.

## `sagent_status` reconciliation

When `sagent_status` reads a run, call `refreshTaskFromArtifacts` for each task and persist the reconciled run.

Status output must include:

- run id and run state
- task state
- tmux session if known
- attach command if tmux is still alive
- result path
- JSONL path
- stderr path
- `sagent_wait` hint for running/timeout/queued tasks

`sagent_status` must not launch queued tasks. It only reports that run-level `sagent_wait` can resume scheduling.

Do not capture pane output in `sagent_status`.

## Widget behavior

Widget remains status-only.

While a task is running, soft-timed-out, or queued behind live concurrency slots, show:

```text
pi-sagent
<run-id>: running <completed>/<total> live <live-count>/<concurrency>
  ● <task-name>: running <tmux-session>
  ◌ <task-name>: timeout <tmux-session>
  ○ <task-name>: queued (waiting for live slot)
```

Do not show child text deltas, tool events, JSONL contents, or stderr in the widget.

## Implementation tasks

Each task below is intended for a separate implementation agent. Each task must include tests or update existing tests where practical.

### Task 1 — State, schemas, and artifact layout

Files: `index.ts`, tests if needed.

Implement:

- Register the new `sagent_wait` tool and schema.
- New per-task artifact directories.
- Persist effective run `concurrency` in `status.json`.
- New task-state fields listed above.
- Safe tmux session name generation.
- Updated `timeoutMs` schema descriptions.
- Env constants for tmux and pi binary names.

Acceptance:

- `status.json` contains run concurrency plus task dir, prompt path, wrapper path, JSONL path, stderr path, result path, done path.
- `sagent_wait` exists with parameters `id`, optional `task`, optional `timeoutMs`.
- No `backend` parameter is added.

Review checklist:

- Public API changes are limited to adding `sagent_wait` and updating descriptions.
- Paths are absolute.
- Session names are safe for tmux.

### Task 2 — Tmux helper layer

Files: `index.ts`.

Implement:

- `execTmux(args)` using `execFile`.
- `assertTmuxAvailable()`.
- `newTmuxSession(...)`.
- `tmuxSessionExists(...)`.
- `killTmuxSession(...)`.
- Safe shell quoting for the tmux command string.

Acceptance:

- Missing tmux gives a clear error before launch.
- Tmux command never embeds raw prompt text.

Review checklist:

- Uses `execFile`, not shell, for tmux invocation.
- Shell quoting is only for the command passed to tmux.
- Helper uses `PI_SAGENT_TMUX_BIN` override.

### Task 3 — Wrapper script generation

Files: `index.ts`.

Implement:

- Write `prompt.md`.
- Build child Pi args with `-p --mode json --no-session --approve` plus existing model/system/tool behavior.
- Use `@prompt.md` as the final prompt argument.
- Write `run.sh` and `command.txt`.
- Wrapper redirects stdout/stderr and writes `done.json` atomically.

Acceptance:

- Child task prompt is not visible in process args except as `@prompt.md` path.
- `done.json` is produced for exit code 0 and nonzero exit.

Review checklist:

- Wrapper is deterministic and path-safe.
- Uses `PI_SAGENT_PI_BIN` override.
- Wrapper does not rely on the model to signal done.

### Task 4 — Shared wait and reconciliation routines

Files: `index.ts`.

Implement:

- `refreshTaskFromArtifacts`.
- `liveTaskCount`.
- `advanceRunQueue`.
- `waitForTask`.
- `waitForRun`.
- Shared soft-timeout outcome object.
- Shared queued-blocked outcome object.
- Shared terminal result outcome object.

Acceptance:

- The same wait logic can serve initial `sagent` waits and later `sagent_wait` waits.
- A task can move from `timeout` to `completed` when `done.json` appears.
- A soft-timed-out live tmux task continues to count against `run.concurrency`.
- `advanceRunQueue` never launches a queued task when `liveTaskCount >= run.concurrency`.

Review checklist:

- Reconciliation does not capture tmux pane output.
- Missing tmux + missing done is treated as compact failure.
- Foreground wait outcomes are not used as concurrency slots; live tmux sessions are.

### Task 5 — Launch, initial wait, soft timeout, abort for `sagent`

Files: `index.ts`.

Implement:

- Replace direct `spawn("pi", ...)` with tmux launch through `advanceRunQueue`.
- Call shared `waitForRun` for the initial `sagent` call.
- Implement exact soft timeout behavior and response state.
- Return queued-blocked compact status for queued tasks that could not launch because live tasks occupy all concurrency slots.
- Implement abort handler that kills active tmux sessions launched by this `sagent` call.
- Use `onUpdate` immediately after each launch to surface tmux session and attach command.

Acceptance:

- Successful task waits and returns final result.
- Soft timeout returns compact running-status response and leaves tmux alive.
- Soft-timed-out tasks keep occupying concurrency slots; no replacement task launches until a live task becomes terminal.
- Abort kills active tmux sessions launched by the active `sagent` call.

Review checklist:

- Timeout path does not call `kill-session`.
- Abort path does call `kill-session`.
- Soft timeout is returned as normal tool content, not thrown error.
- The scheduler never exceeds `run.concurrency` live tmux sessions.

### Task 6 — `sagent_wait` implementation

Files: `index.ts`.

Implement:

- Load run by id from memory or disk.
- Support run-level wait when `task` is omitted.
- Support task-level wait by index/name/prefix when `task` is provided.
- Reconcile all tasks before waiting.
- Return immediately for terminal selected tasks.
- For run-level wait, use `advanceRunQueue` and `waitForRun` to resume queued work under the live concurrency cap.
- For task-level wait, launch the selected task only if it is queued and `liveTaskCount < run.concurrency`; otherwise return queued-blocked compact status.
- Wait on existing tmux sessions with new `timeoutMs` for non-terminal tasks.
- On soft timeout, return the same compact running-status response with a new `sagent_wait` hint.
- On abort, kill only the tmux sessions this `sagent_wait` call is actively waiting on and mark those tasks aborted.

Acceptance:

- `sagent_wait({ id, task, timeoutMs })` can turn a previous timeout into a completed result when the child finishes.
- `sagent_wait` with another too-short timeout returns compact status and leaves tmux alive.
- `sagent_wait({ id, timeoutMs })` resumes the run scheduler and can launch queued tasks only when live slots are free.
- `sagent_wait` never exceeds persisted run concurrency.

Review checklist:

- `sagent_wait` never launches a duplicate child for an already launched task.
- `sagent_wait` never sends input to the child.
- Queued task launches happen only through `advanceRunQueue` and only under the live-tmux concurrency cap.
- Selector errors are compact and include valid task choices.

### Task 7 — Result extraction and compact failure output

Files: `index.ts`.

Implement:

- Parse `child.jsonl` after `done.json`.
- Extract latest final assistant text from `agent_end`.
- Fallback to text deltas.
- Write `result.md`.
- Compact failure diagnostics with artifact paths only.

Acceptance:

- Completed child returns only final assistant text.
- Failed child does not dump full JSONL/stderr into model context.

Review checklist:

- Existing extraction logic is reused where possible.
- All model-visible output is bounded/compact.

### Task 8 — `sagent_status`, widget, and formatting polish

Files: `index.ts`, tests if relevant.

Implement:

- `sagent_status` uses `refreshTaskFromArtifacts` for reconciliation.
- `sagent_status` must not call `advanceRunQueue` or launch queued tasks.
- Status output includes `sagent_wait` hints for running/timeout/queued tasks.
- Widget includes live count/concurrency plus tmux session names for running/timeout tasks and queued markers for blocked queued tasks.
- `formatSingleResultText` has explicit branches for completed, failed, timeout, queued-blocked, and aborted.
- Timeout formatting exactly follows the compact running-status response shape.
- Queued-blocked formatting exactly follows the compact queued-status response shape.

Acceptance:

- Status can reconcile a timed-out task to completed.
- Status reports queued tasks without launching them.
- Widget remains status-only.
- Timeout and queued-blocked output give enough information to attach/check/wait later.

Review checklist:

- No child streamed text appears in widget.
- Timeout/status output contains run id, task selector, tmux session when available, attach command when available, artifact paths, `sagent_status` hint, and `sagent_wait` hint.
- Queued tasks explicitly state that no tmux session exists yet.

### Task 9 — Tests with fake tmux and fake pi

Files: `tests/`, test helpers.

Implement tests using env overrides:

- fake tmux records `new-session`, `has-session`, and `kill-session` calls.
- fake pi emits controlled JSONL and exits with controlled code/sleep.

Required cases:

1. Wrapper command includes `--no-session`, `--approve`, and `@prompt.md`.
2. Successful run produces/reads `result.md`.
3. Soft timeout returns compact status and does not call `kill-session`.
4. Soft timeout does not free a concurrency slot; queued tasks are not launched while live timed-out tasks occupy all slots.
5. When a live timed-out task later completes, run-level `sagent_wait` can launch the next queued task without exceeding concurrency.
6. Abort of active `sagent` calls `kill-session` for sessions launched by that call.
7. `sagent_status` reconciles a timeout to completed after `done.json` exists and does not launch queued tasks.
8. `sagent_wait` waits on a previous timeout and returns completed result.
9. `sagent_wait` times out again without killing tmux.
10. Run-level `sagent_wait` resumes queued scheduling only up to live concurrency.
11. Task-level `sagent_wait` for a queued task returns queued-blocked when no live slot is available.
12. Abort of active `sagent_wait` kills only the tmux sessions that call is waiting on.
13. Failure output is compact and includes paths, not full logs.

Acceptance:

- Tests do not require real tmux or model calls.

Review checklist:

- Tests verify the key decisions, not implementation trivia.

## Implementation/review cycle

Use this cycle for each implementation task:

1. Implement only the task's scope.
2. Run targeted tests.
3. Review against the task's review checklist and the non-negotiable decisions.
4. Fix any Critical/Important review findings before moving to the next task.
5. After all tasks, run the full test suite and perform the manual acceptance checks below.

## Manual acceptance checks

1. Start a short `sagent` task. Verify tmux session is visible while running and final result returns.
2. During a longer task, attach manually with the reported command:

```bash
tmux attach-session -t <tmux-session>
```

3. Run a task with small `timeoutMs`. Verify `sagent` returns compact running-status response and the tmux session remains alive.
4. Call `sagent_wait({ id: "<run-id>", task: 0, timeoutMs: <larger-ms> })` while the child is still running. Verify it resumes waiting on the same tmux session.
5. If the child finishes during `sagent_wait`, verify the final result returns and `status.json` becomes completed.
6. If `sagent_wait` times out again, verify it returns compact running-status response and tmux remains alive.
7. Start three tasks with `concurrency: 1` and a small timeout on the first task. Verify only one tmux session exists after soft timeout and later tasks are queued, not launched.
8. After the first task finishes, call run-level `sagent_wait({ id: "<run-id>", timeoutMs: <larger-ms> })`. Verify the second task launches and live tmux sessions never exceed one.
9. After a timed-out task finishes without an active wait, call `sagent_status({ id: "<run-id>" })`. Verify it reconciles terminal state but does not launch queued tasks.
10. Abort/Esc a running `sagent`. Verify launched tmux sessions are killed and task state is aborted.
11. Abort/Esc a running `sagent_wait`. Verify only the sessions that call is waiting on are killed and task state is aborted.
12. Verify child Pi used `--no-session` and did not create normal Pi session-file pollution.
