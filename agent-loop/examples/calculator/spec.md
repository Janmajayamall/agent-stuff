# CLI calculator

Build a small, dependency-free command-line calculator using Node.js 18 or newer
and its standard library. This directory is the agent loop's working directory.
Perform one calculation per invocation, with no interactive input, browser,
server, network requests, package installation, or build step.

## Deliverables and scope

- Put the application in `app/`, with `app/calculator.mjs` as the CLI entry point.
- Put meaningful automated tests in `tests/calculator.test.mjs`, using Node's
  built-in `node:test` and `node:assert/strict`. The required command is
  `node --test tests/calculator.test.mjs`; it must pass without installing packages.
- Test the actual CLI as a subprocess using argument arrays, for example with
  `spawnSync` or `execFileSync`, and assert its exit status, stdout, and stderr.
  Direct tests of importable arithmetic functions are optional supplements, not
  a substitute for exercising the CLI. No particular internal API is required.
- Document exact invocation, help, examples, and test commands in `app/README.md`.
- Change only `app/` and `tests/`. Keep changes uncommitted; do not create commits.
  Leave this example's configuration, specification, review criteria, prompts,
  and root README unchanged. Preserve unrelated work, including any preexisting
  uncommitted changes. Reports and temporary evidence belong only in the current
  agent attempt's ignored run directory at the locations given in the instructions.

## Command contract

```text
node app/calculator.mjs <operation> <left> <right>
node app/calculator.mjs --help
```

The operation is exactly one of the lowercase words `add`, `subtract`, `multiply`,
or `divide`. Do not add aliases or expression parsing. Subtraction is left minus
right; division is left divided by right. Do not use `eval`, `Function`, external
packages, or expression-evaluation libraries.

Each operand must be a finite signed decimal token. An optional leading `+` or
`-` is allowed, and at least one decimal digit is required. A decimal point may
appear at most once. Examples of valid operands are `2`, `+2`, `-2.5`, `.5`,
`-.5`, `2.`, and `0002.50`. Reject empty tokens, any whitespace, hexadecimal,
scientific notation, `NaN`, `Infinity`, and trailing junk. Also reject decimal
tokens whose numeric conversion is not finite. Ordinary JavaScript `Number`
arithmetic is sufficient; arbitrary-precision arithmetic is outside scope.

For a successful calculation:

- Write only the formatted result followed by one newline to stdout.
- Leave stderr empty and exit with status `0`.
- Format the result to at most 12 significant digits, rounding when needed,
  removing unnecessary fractional trailing zeroes, and rendering negative zero
  as `0`. Scientific notation is allowed for results. In particular,
  `add 0.1 0.2` must print `0.3`, not a floating-point precision artifact.

For an unknown operation, wrong number of arguments, invalid operand, division
by positive or negative zero, or non-finite arithmetic result, leave stdout
empty, print a helpful error message to stderr, and exit with status `1`.
Do not expose an uncaught exception or stack trace for these expected errors.
The exact wording of the error message is not prescribed, but it must identify
the problem; argument-count and unknown-operation errors should show the usage.

`--help` as the only argument prints usage, the supported operations, and at
least one example to stdout, leaves stderr empty, and exits with status `0`.
Combining `--help` with other arguments is an error. No arguments is an error.

## Examples

| Arguments after `app/calculator.mjs` | stdout |
|---|---|
| `add 2 3` | `5` followed by a newline |
| `subtract 2 5` | `-3` followed by a newline |
| `multiply -2.5 4` | `-10` followed by a newline |
| `divide 7 2` | `3.5` followed by a newline |
| `add 0.1 0.2` | `0.3` followed by a newline |
| `add .5 2.` | `2.5` followed by a newline |
| `multiply -0 4` | `0` followed by a newline |

## Required verification

Run the automated suite and independently invoke the CLI for representative
success, error, and help cases. Cover all four operations, accepted operand
forms, result precision and zero formatting, every rejected operand category,
argument count, unknown operation, both signs of division by zero, and arithmetic
overflow from otherwise finite decimal operands. Check all three observable
outputs: exit status, stdout, and stderr. Tests must exercise actual behavior
and contain real assertions; an empty passing suite is insufficient.

Record the runtime version, exact commands or argument arrays, and observed
outcomes in the report. Browser checks and browser capabilities are unnecessary.
If Node.js itself is unavailable, report `BLOCKED` with the missing runtime.
An application defect or failing test is a finding to fix, not a missing runtime.

Reviewers may run concurrently. Run checks without editing source or tests, and
write reports or temporary evidence only inside your own attempt directory. No
shared ports, server processes, or other external services are needed.
