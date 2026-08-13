# Pi collaboration extension — Sprint 1

This extension adds six provider-safe collaboration tools to Pi 0.84.1. A root
agent can run up to three direct child turns concurrently, exchange messages,
restart a completed child against its own persistent session, interrupt work,
list children, and wait for mailbox activity without polling.

Sprint 1 is deliberately depth-one and fresh-history only. Children cannot load
the collaboration control plane, and `fork_turns` is not an input until Sprint 2.

## Requirements and installation

- Pi coding agent `0.84.1`
- Node.js `22.19.0` or newer (the same minimum required by Pi 0.84.1)
- macOS or Linux

Install dependencies and load the extension directory:

```sh
npm install
pi --extension /absolute/path/to/extensions/collaboration/index.ts
```

Alternatively, add the directory as a Pi local package/resource using Pi's
normal package configuration. The package manifest declares `./index.ts` as its
extension entrypoint.

## Model-facing tools

- `collaboration_spawn_agent`
- `collaboration_send_message`
- `collaboration_followup_task`
- `collaboration_interrupt_agent`
- `collaboration_list_agents`
- `collaboration_wait_agent`

The underscore names are intentional: dotted function names are not portable
across providers. Dotted Codex names appear only in labels. All schemas are
strict, errors throw through Pi's tool path, and successful calls return the same
logical JSON object in both the text content and typed `details`.

`collaboration_spawn_agent` supports optional `gpt-5.6-sol` or
`gpt-5.6-terra` model selection and Pi reasoning levels through `max`. It does
not support Codex's `ultra` level or any `fork_turns` property in Sprint 1.

## Child lifecycle and storage

Each active turn runs in a temporary `pi --mode rpc` subprocess. The controller
waits for exact model/thinking/session verification, prompt acknowledgement, and
`agent_start`. On `agent_settled`, it derives one terminal status, drains already
written RPC responses, closes the process, and retains the logical child for a
future follow-up.

Children share the root working directory and filesystem. There are no branches,
worktrees, locks, transactions, or rollback of file changes.

For a persisted root, child sessions are stored under:

```text
<root-session-directory>/collaboration/<root-session-id>/<task-name>/<child-uuid>.jsonl
```

For a `--no-session` root, Pi's exported agent directory is used:

```text
<pi-agent-dir>/collaboration/sessions/<root-session-id>/<task-name>/<child-uuid>.jsonl
```

The files are created exclusively with owner-only permissions. Successful and
interrupted sessions survive turn completion and root shutdown. A failed
pre-start attempt removes only its own newly allocated JSONL.

## Mailbox and human monitoring

Final child answers enter the root model context once as a dedicated
`collaboration-mailbox` custom message. Delivery never starts a root turn by
itself. `collaboration_wait_agent` consumes short FIFO wake summaries; it does
not receive monitor streams or full child payloads.

The model-facing mailbox envelope is bounded to 64 KiB by UTF-8 bytes. When a
visible completed answer is larger, the full sanitized answer is atomically
written beside the child session as `<child-uuid>.final.txt` with mode `0600`.
The mailbox contains a safe preview and absolute path. Error diagnostics have a
16 KiB payload bound and do not create full-answer artifacts.

In TUI mode, an always-visible widget shows child status, elapsed time, and
observable activity. Run `/agents` to select a live or completed transcript:

- `Esc`, `Ctrl-C`, or `q`: close the transcript without touching the worker
- Up/Down: scroll
- `i`: confirm and interrupt through the same registry path as the tool
- `f`: lazily load a truncated full-answer artifact when one exists

Monitoring retains only visible assistant text, tool names/arguments/output,
errors, usage, and activity. Thinking/reasoning blocks and signatures are
discarded at RPC ingestion. Raw monitor events never enter the root model
context.

## Subprocess inheritance boundary

Built-in and discoverable user/project/package extension tools are rehydrated by
normal Pi discovery. Readable temporary extension entrypoints are forwarded with
`--extension`. SDK/in-memory tools, synthetic sources, and runtime-only
authentication are rejected instead of being silently dropped.

Stored credentials, inherited environment authentication, and discoverable
provider extensions may work normally. Pi 0.84.1 does not expose provenance for
provider-only runtime registrations. The child `get_state` check plus prompt
preflight are therefore authoritative: if the subprocess cannot reconstruct the
selected provider or authentication, spawn fails and rolls back. The extension
never extracts resolved secrets or places them in arguments/session files.

Root-only JavaScript closures, live extension state, and per-turn root system
prompt mutations cannot cross the subprocess boundary.

## Development and verification

```sh
npm run typecheck
npm test
npm run check
```

Tests use fake processes, clocks, filesystems, and Pi extension contexts; they do
not require a paid provider. Required runtime support is macOS/Linux. Windows is
not claimed in Sprint 1.

Handoff verification on 2026-08-13:

- `npm run check`: the complete deterministic test suite passed with a clean
  TypeScript check.
- `npm pack --dry-run`: succeeded and contained only the manifest, README, entrypoint,
  and runtime `src` files.
- Pi RPC startup: the root registered `/agents`; the same launch with
  `PI_COLLABORATION_CHILD=1` did not register it, confirming depth-one suppression.
- A paid-provider two-child TUI run could not be completed in the managed sandbox:
  Pi was prevented from creating its credential-store lock file. No credential data
  was copied or bypassed. Process/RPC concurrency remains covered by deterministic
  fake-transport integration tests.

## Sprint 1 exclusions

- Parent history inheritance / `fork_turns`
- Nested or grandchild agents
- Capacity queues (a fourth active child turn fails immediately)
- Model-facing monitor/read-events or close-agent tools
- Registry restoration after Pi exits
- Windows process/TUI support
