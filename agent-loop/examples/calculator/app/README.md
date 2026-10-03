# CLI calculator

A dependency-free calculator for Node.js 18 or newer. Run these commands from
the repository root. Each invocation performs one calculation; no installation
or build step is needed.

```sh
node app/calculator.mjs <operation> <left> <right>
node app/calculator.mjs --help
```

The operation must be exactly `add`, `subtract`, `multiply`, or `divide` in
lowercase. Subtraction computes left minus right; division computes left divided
by right. Supply exactly two operands. Use `--help` alone to print usage,
operations, and an example.

Operands are finite decimal numbers with an optional leading `+` or `-` and at
least one digit. Forms such as `2`, `+2`, `-2.5`, `.5`, `-.5`, `2.`, and
`0002.50` are accepted. Empty values, whitespace, hexadecimal, scientific
notation, `NaN`, `Infinity`, trailing junk, and decimals outside the finite
JavaScript `Number` range are rejected. Operands use ordinary JavaScript
`Number` precision, including its rounding and underflow behavior.

```sh
node app/calculator.mjs add 2 3          # 5
node app/calculator.mjs subtract 2 5     # -3
node app/calculator.mjs multiply -2.5 4  # -10
node app/calculator.mjs divide 7 2       # 3.5
node app/calculator.mjs add 0.1 0.2      # 0.3
node app/calculator.mjs add .5 2.       # 2.5
node app/calculator.mjs add +2 0002.50   # 4.5
node app/calculator.mjs subtract -.5 2  # -2.5
node app/calculator.mjs multiply -0 4   # 0
node app/calculator.mjs divide 1 3      # 0.333333333333
```

Success prints only the result and one newline to stdout, leaves stderr empty,
and exits with status `0`. Results are rounded to at most 12 significant digits
with unnecessary fractional zeroes removed; negative zero prints as `0`.
Scientific notation may appear in results even though operands cannot use it.

Unknown operations, incorrect argument counts, invalid operands, division by
either sign of zero, and non-finite results exit with status `1`, leave stdout
empty, and print a helpful error to stderr. For example:

```sh
node app/calculator.mjs divide 1 -0
node app/calculator.mjs add 1e3 2
```

Run the automated tests with Node's built-in test runner:

```sh
node --test tests/calculator.test.mjs
```

The tests launch the actual CLI as a subprocess and check exit status, stdout,
and stderr for successful calculations, help, and errors.
