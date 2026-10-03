const usage = `Usage:
  node app/calculator.mjs <operation> <left> <right>
  node app/calculator.mjs --help

Operations: add, subtract, multiply, divide
Operands: finite signed decimals, such as -2.5, +2, .5, or 2.

Example:
  node app/calculator.mjs add 0.1 0.2
  0.3
`;

const operations = new Map([
  ['add', (left, right) => left + right],
  ['subtract', (left, right) => left - right],
  ['multiply', (left, right) => left * right],
  ['divide', (left, right) => left / right],
]);

// The final assertion requires the actual end of input, including after newlines.
const decimalToken = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?![\s\S])/;

function fail(message, includeUsage = false) {
  process.stderr.write(`Error: ${message}\n${includeUsage ? usage : ''}`);
  process.exitCode = 1;
}

function formatResult(result) {
  if (result === 0) return '0';

  const [mantissa, exponent] = result.toPrecision(12).split('e');
  const trimmed = mantissa.includes('.')
    ? mantissa.replace(/0+$/, '').replace(/\.$/, '')
    : mantissa;
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }

  if (args.includes('--help')) {
    return fail('--help must be used alone.', true);
  }
  if (args.length !== 3) {
    return fail('Expected exactly three arguments: an operation and two operands.', true);
  }

  const [operation, ...tokens] = args;
  if (!operations.has(operation)) {
    return fail(`Unknown operation ${JSON.stringify(operation)}.`, true);
  }

  const operands = [];
  for (const [index, token] of tokens.entries()) {
    const value = Number(token);
    if (!decimalToken.test(token) || !Number.isFinite(value)) {
      const side = index === 0 ? 'left' : 'right';
      return fail(`Invalid ${side} operand ${JSON.stringify(token)}: expected a finite signed decimal.`);
    }
    operands.push(value);
  }

  const [left, right] = operands;
  if (operation === 'divide' && right === 0) {
    return fail('Division by zero is not allowed.');
  }

  const result = operations.get(operation)(left, right);
  if (!Number.isFinite(result)) {
    return fail('The arithmetic result is not finite (overflow).');
  }

  process.stdout.write(`${formatResult(result)}\n`);
}

main(process.argv.slice(2));
