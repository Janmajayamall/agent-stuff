# Required subagent results and timeout semantics

## Problem

When a parent agent launches `pi-sagent` tasks with a soft timeout, the tool returns control while child agents continue running. This is useful for detached/background work, but it is easy for the parent agent to accidentally proceed, complete the task independently, and produce a final answer without incorporating the subagent results.

This happened during a code review: subagents were launched for parallel review, the soft timeout expired, and the parent continued with its own review instead of waiting for the subagents to finish.

## Goal

Make it harder for callers to accidentally ignore subagent results when those results are intended to be part of the final answer.

## Recommendations

### 1. Separate blocking and detached modes

Make the caller explicitly choose whether subagents are required or detached.

Suggested API:

```ts
sagent({
  mode: "blocking",
  hardTimeoutMs: 120000,
  tasks: [...]
})
```

```ts
sagent({
  mode: "detached",
  softTimeoutMs: 15000,
  tasks: [...]
})
```

Recommended default: `mode: "blocking"`.

Detached mode should be opt-in because it is the risky mode for required review/research tasks.

### 2. Add `required: true`

Allow the caller to mark a subagent run as required for final output.

```ts
sagent({
  required: true,
  tasks: [...]
})
```

If a parent agent attempts to produce a final answer while any required run is still active, the harness should block or warn loudly:

```text
Required subagent run run-abc123 is still running.
Call sagent_wait({ id: "run-abc123" }) or explicitly abandon the run before finalizing.
```

### 3. Add final-answer guardrails

The harness should track required active subagent runs per parent session.

Before allowing a final response, check whether required runs are unresolved.

Allowed finalization states:

- all required subagent tasks completed successfully;
- required run failed with hard timeout/error and caller acknowledges it;
- caller explicitly abandons the run with a reason.

### 4. Add explicit abandon

Ignoring a required subagent run should be deliberate.

Suggested API:

```ts
sagent_abandon({
  id: "run-abc123",
  reason: "No longer needed because scope changed"
})
```

The final answer can then mention that a subagent run was abandoned, if relevant.

### 5. Rename timeout fields

Avoid ambiguous `timeoutMs`.

Suggested names:

- `softTimeoutMs`: return control while children keep running;
- `hardTimeoutMs`: wait until completion or fail/kill at timeout;
- `wait`: `"all" | "any" | "none"`.

Example:

```ts
sagent({
  wait: "all",
  hardTimeoutMs: 120000,
  tasks: [...]
})
```

```ts
sagent({
  wait: "none",
  softTimeoutMs: 1000,
  tasks: [...]
})
```

### 6. Hard timeout behavior

A hard timeout should fail loudly. It should not look like a successful partial result.

Suggested behavior:

```text
Required subagent run timed out before completion.
No complete result is available.
```

For required runs, the parent should not silently continue. It should either retry/wait longer or explicitly acknowledge the missing result.

### 7. Return completed result contents directly

When `sagent` or `sagent_wait` completes, return each child `result.md` content inline in the tool output, not only artifact paths.

Artifact paths are useful for inspection, but inline results reduce the chance that the parent forgets to read them.

Suggested output shape:

```json
{
  "id": "run-abc123",
  "status": "completed",
  "tasks": [
    {
      "name": "api-review",
      "status": "completed",
      "result": "...contents of result.md...",
      "artifactsPath": "..."
    }
  ]
}
```

### 8. Add status hints after soft timeout

If soft timeout returns, the tool output should be prescriptive:

```text
This run is still active. If these results are required, do not finalize yet.
Wait with: sagent_wait({ id: "run-abc123", timeoutMs: ... })
```

If `required: true`, the message should be stronger:

```text
Required run is still active. Final response is blocked until completion, failure acknowledgement, or abandon.
```

## Suggested default behavior

For most parent-agent use cases:

```ts
sagent({
  required: true,
  wait: "all",
  hardTimeoutMs: 120000,
  tasks: [...]
})
```

Use detached mode only for long-running exploratory work that is explicitly not needed for the current final answer.

## Summary

Hard timeouts help only if they block and fail loudly. The more robust solution is to model subagent runs as either required or detached, default to blocking required behavior, return completed results inline, and prevent final answers while required subagent work is still unresolved.
