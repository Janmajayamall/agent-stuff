# CLI calculator example

This example asks the agents to build a command-line calculator in
`app/calculator.mjs`, with automated tests in `tests/calculator.test.mjs`.
The calculator has not been implemented in this fixture; it is the work assigned
by the prompts. It uses Node's standard library and requires no package installs.

The intended interface is:

```sh
node app/calculator.mjs add 2 3
node app/calculator.mjs subtract 2 5
node app/calculator.mjs multiply -2.5 4
node app/calculator.mjs divide 7 2
node app/calculator.mjs --help
```

Successful calculations print just the result and exit with code 0. Invalid input
and division by zero produce an error on stderr and exit with code 1. Agents must
test the actual CLI's output and exit codes using subprocesses.

| Role | CLI | Model | Reasoning effort |
| --- | --- | --- | --- |
| Implementer | Codex | `gpt-6-astra` | `xhigh` |
| Reviewer | Claude Code | `claude-opus-5` | `xhigh` |
| Reviewer | Codex | `gpt-6-astra` | `xhigh` |

All three prompt templates are in `prompts/`. The implementer has separate
`implement` and `revise` instructions; both reviewers use the same complete `review.md`
instructions. The runner replaces `@spec.md` and `@review-criteria.md` with quoted
absolute paths, without a leading `@`, and substitutes the supported variables.
The agents read those files themselves; their contents are not inserted into the
prompts. The implementer uses one session for the entire run, including revisions
and recoverable resumes. A same-round resume sends only your optional follow-up
message, or `Continue`. The reviewers run in parallel.
The limit is five rounds, with no agent or check timeout.

Every agent writes its report to `{{review_file}}` and returns only its final
verdict. `{{workspace}}` is the absolute working directory. The revision prompt's
`{{reviewDetails}}` lists the preceding round's reviewer identities, verdicts,
and report paths, plus any failed-check report paths. The implementer reads those
files to address blocking findings and failed checks.

The runner saves copies of the referenced files for audit, but the prompt paths
still point to the original files. Agents read their current contents when they
execute. Each `instructions.file` is loaded as the authored prompt template.

## Run from this directory

You need Python 3.11+, Node.js 18+ with `node:test`, Git, and authenticated `codex`
and `claude` CLIs with access to the selected models. Put those executables on
`PATH`. Use a recent Claude Code version supporting `--effort xhigh` and
`--permission-prompts none`.

From the `pac` directory:

```sh
cd agent-loop/examples/calculator
python3 ../../agent_loop.py --validate loop.json
```

All paths resolve from this `calculator` working directory. Validation checks the
configuration, input files, executable availability, and supported adapter
options. It does not call the models or verify account access.

The loop requires a Git workspace. This existing example directory already has
one. For a fresh standalone copy outside another repository, initialize it once:

```sh
git init
```

An initial fixture commit is optional. Agents must leave all implementation and
revision changes uncommitted. Start a new run with:

```sh
python3 ../../agent_loop.py loop.json
```

For a recoverable failed or blocked run, resume using its saved directory:

```sh
python3 ../../agent_loop.py --resume .agent-loop/runs/RUN_ID
```

For `BLOCKED` or invalid implementer output, resume continues the same session
within the same round. You may edit the plan or workspace while halted, then
explain the resolution:

```sh
python3 ../../agent_loop.py --resume .agent-loop/runs/RUN_ID \
  --prompt "I clarified spec.md. Read it again and continue."
```

Use `--prompt-file ./resume-notes.md` for a longer UTF-8 message instead. The
implementer's report path remains `rounds/001/implementation/report.txt` during
round 1; separate `turn-001.*`, `turn-002.*` artifacts preserve invocation history.
An implementer panic, crash, unsuccessful exit, or timeout is terminal and
requires a new run.

Failed reviewers rerun on resume; their successful peers' results remain valid
even if you edited the workspace during the halt. To skip a failed reviewer for
the current round, add `--skip-reviewer opus-reviewer`. Repeat that option for
other failed IDs, including every failed reviewer if desired. Required checks
must still pass, and all configured reviewers run again after a revision.
Workspace edits before a review resume rerun required checks against those new
files while retaining the accepted reviewer results.

Resume uses frozen templates stored with the run. Referenced specification and
rubric files remain live. Changing `loop.json`, including whitespace, makes the
run terminal when detected; restoring it afterward does not revive the run.
See [Loop states and recovery](../../docs/state-transitions.md) for the full rules.
Only current-format saved runs (version 2) can be resumed. Older saved runs stay
available as logs, but require a new run rather than migration.

Generated app and test changes stay uncommitted. Runs, reports, and the exact
submitted prompts are saved under `.agent-loop/runs/`. The fixed check command is
`node --test tests/calculator.test.mjs`; it fails if the implementer omits that
file. Both reviewers also run the tests and independently check CLI behavior.

Claude is allowed to read files, write its report, and execute tests through Bash.
The review prompt prohibits source edits and the runner rejects approvals if the
workspace changes during review. Native CLI permissions still apply.

## Model settings

Codex receives `--model gpt-6-astra` and
`-c 'model_reasoning_effort="xhigh"'`. See the
[Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Claude receives `--model claude-opus-5 --effort xhigh`; see the
[Opus 5 model and effort documentation](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5).
The model identifiers are explicit, so this example does not follow a changing
`opus` alias or silently substitute a different model.
