import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../app/calculator.mjs', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function expectSuccess(args, expected) {
  const result = run(args);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(result.stderr, '');
}

function expectFailure(args, message, needsUsage = false) {
  const result = run(args);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
  assert.ok(result.stderr.endsWith('\n'));
  assert.doesNotMatch(result.stderr, /\n\s+at\s|file:\/\//);
  if (needsUsage) assert.match(result.stderr, /Usage:/);
}

const successCases = [
  ['addition', ['add', '2', '3'], '5'],
  ['subtraction order', ['subtract', '2', '5'], '-3'],
  ['signed multiplication', ['multiply', '-2.5', '4'], '-10'],
  ['division order', ['divide', '7', '2'], '3.5'],
  ['negative divisor', ['divide', '7', '-2'], '-3.5'],
  ['two negative operands', ['multiply', '-2', '-3'], '6'],
  ['signed addition', ['add', '-2.5', '+.5'], '-2'],
  ['negative subtrahend', ['subtract', '2', '-.5'], '2.5'],
  ['leading plus and zeros', ['add', '+2', '0002.50'], '4.5'],
  ['omitted integer and fractional digits', ['add', '.5', '2.'], '2.5'],
  ['negative fraction', ['add', '-.5', '0'], '-0.5'],
  ['signed trailing decimal point', ['add', '-2.', '+2.'], '0'],
  ['positive zero', ['add', '0', '+0'], '0'],
  ['negative product zero', ['multiply', '-0', '4'], '0'],
  ['negative quotient zero', ['divide', '0', '-4'], '0'],
  ['two negative zeros', ['add', '-0', '-0.0'], '0'],
  ['zero subtraction', ['subtract', '-0', '+0'], '0'],
  ['floating point artifact', ['add', '0.1', '0.2'], '0.3'],
  ['twelve significant digits', ['divide', '1', '3'], '0.333333333333'],
  ['rounding upward', ['divide', '2', '3'], '0.666666666667'],
  ['large decimal rounding', ['add', '12345.67890126', '0'], '12345.6789013'],
  ['negative rounding', ['add', '-12345.67890126', '0'], '-12345.6789013'],
  ['rounding carries into integer', ['add', '9.999999999999', '0'], '10'],
  ['fractional trailing zeros', ['divide', '5.000', '4'], '1.25'],
  ['integer trailing zeros', ['multiply', '100', '10'], '1000'],
  ['large scientific result', ['multiply', '1000000000000', '10'], '1e+13'],
  ['small scientific result', ['divide', '.000001', '10'], '1e-7'],
  ['scientific mantissa rounding', ['add', '12345678901260', '0'], '1.23456789013e+13'],
  ['scientific trailing zeros', ['divide', '.0000012', '10'], '1.2e-7'],
  ['smallest positive Number', ['add', `0.${'0'.repeat(323)}5`, '0'], '4.94065645841e-324'],
  ['negative underflow zero', ['multiply', `-0.${'0'.repeat(323)}5`, '.1'], '0'],
];

for (const [name, args, expected] of successCases) {
  test(name, () => expectSuccess(args, expected));
}

const invalidTokens = [
  '', ' ', ' 2', '2 ', '2\t', '\t2', '2\n', '2\r', '2\r\n', '2\u2028',
  '2\u2029', '2\u00a0', '2 3', '2\n3', '0x10', '-0x10', '0XFF', '0b10',
  '0o10', '1e3', '1E+3', '-2e-2', 'NaN', 'Infinity', '+Infinity', '-Infinity',
  '2abc', '2.5x', '1_000', '1,000', '.', '+', '-', '+.', '-.', '1.2.3', '..5',
  '2..', '--2', '++2', '+-2', '-+2', '１２', '٢', '9'.repeat(309),
  `-${'9'.repeat(309)}`,
];

for (const token of invalidTokens) {
  for (const [side, args] of [
    ['left', ['add', token, '1']],
    ['right', ['add', '1', token]],
  ]) {
    test(`reject invalid ${side} operand ${JSON.stringify(token)}`, () => {
      expectFailure(args, new RegExp(`Invalid ${side} operand.*finite signed decimal`, 's'));
    });
  }
}

for (const args of [[], ['add'], ['add', '1'], ['add', '1', '2', '3']]) {
  test(`reject argument count ${JSON.stringify(args)}`, () => {
    expectFailure(args, /exactly three arguments/i, true);
  });
}

for (const operation of ['ADD', 'Subtract', 'sum', '+', 'modulo', 'toString', 'constructor', '__proto__', ' add', 'add ', '']) {
  test(`reject unknown operation ${JSON.stringify(operation)}`, () => {
    expectFailure([operation, '2', '3'], /unknown operation/i, true);
  });
}

for (const args of [
  ['--help', 'add'], ['--help', '1', '2'], ['add', '--help', '2'],
  ['add', '1', '--help'], ['add', '1', '2', '--help'], ['--help', '--help'],
]) {
  test(`reject mixed help ${JSON.stringify(args)}`, () => {
    expectFailure(args, /--help must be used alone/i, true);
  });
}

for (const zero of ['0', '+0', '-0', '0.0', '-0.0', '+.0', '-.0', '000.', '-000.']) {
  test(`reject division by ${zero}`, () => {
    expectFailure(['divide', '1', zero], /division by zero/i);
  });
}

test('reject zero divided by zero', () => {
  expectFailure(['divide', '0', '0'], /division by zero/i);
});

const large = `1${'0'.repeat(308)}`;
const tiny = `0.${'0'.repeat(307)}1`;
for (const args of [
  ['add', large, large], ['subtract', `-${large}`, large],
  ['multiply', large, '10'], ['divide', large, tiny],
]) {
  test(`reject finite-operand overflow for ${args[0]}`, () => {
    assert.ok(args.slice(1).every(token => Number.isFinite(Number(token))));
    expectFailure(args, /result.*not finite.*overflow/i);
  });
}

test('help alone provides usage, operations, and an example', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /node app\/calculator\.mjs <operation> <left> <right>/);
  for (const operation of ['add', 'subtract', 'multiply', 'divide']) {
    assert.match(result.stdout, new RegExp(`\\b${operation}\\b`));
  }
  assert.match(result.stdout, /Example:[\s\S]*node app\/calculator\.mjs add 0\.1 0\.2/);
  assert.ok(result.stdout.endsWith('\n'));
});
