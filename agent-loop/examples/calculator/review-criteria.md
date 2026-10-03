# CLI calculator review criteria

Review the complete uncommitted implementation against the specification. Run
`node --test tests/calculator.test.mjs` yourself and confirm that the suite has
meaningful assertions against the actual CLI. Independently invoke the CLI for
representative valid inputs, invalid inputs, and help. Inspect subprocess exit
status, stdout, and stderr; passing arithmetic-only unit tests is insufficient.

Check these areas:

- Arithmetic: all four operations, operand order, signed and fractional values,
  zero, division by either sign of zero, and overflow from finite operands.
- Parsing: exact lowercase operation names and argument count; accepted decimal
  forms, including leading signs and missing digits on one side of a decimal
  point; rejection of whitespace, empty values, hexadecimal, exponent notation,
  non-finite values, and partially parsed junk.
- Output: result-only stdout with one newline on success, at most 12 significant
  digits, no redundant fractional trailing zeroes, `0` for negative zero, and
  `0.3` for `add 0.1 0.2`. Failures leave stdout empty, give a useful stderr
  message without a stack trace, and exit `1`. Help alone exits `0`, includes
  usage and an example, and leaves stderr empty.
- Constraints: Node.js 18+ standard library only, no dynamic evaluation,
  dependencies, network access, browser, or interactive input. Entry point and
  test command match the specification. Documentation gives usable commands.
  Changes stay within `app/` and `tests/` and remain uncommitted.
- Evidence: a meaningful passing test suite plus independently reproduced CLI
  cases, including concrete commands or argument arrays and observed outputs.
  Browser verification is not required. A missing Node.js runtime is a blocker;
  an application defect or test failure is a review finding.

Report concrete, reproducible defects as blocking findings. Include affected
files, relevant locations, failing arguments, expected versus observed behavior,
and the specification requirement violated. Keep purely stylistic preferences,
speculative extensions, and low-value suggestions advisory.

Return `CHANGES_REQUIRED` when at least one blocking defect remains. Return
`NO_CHANGES_REQUIRED` when required verification is complete and only advisory
findings or no findings remain. Use `BLOCKED` if the necessary runtime is missing
or material ambiguity prevents review, and explain the exact issue. Write the
report at the path given in the instructions before returning the exact verdict.

Do not edit application, tests, configuration, or prompts, create commits, or
repair defects yourself. Reviewers may run concurrently. Write your report and
any temporary evidence only in your own attempt directory.
