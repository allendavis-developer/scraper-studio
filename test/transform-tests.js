// Clean-up / extraction pipeline tests (headless).
//   node test/transform-tests.js

const T = require('../src/shared/transform.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const run = (v, ...tf) => T.apply(v, tf);

// --- numbers ---------------------------------------------------------------
eq('number strips currency + commas', run('£1,299.99', { op: 'number' }), 1299.99);
eq('number on plain price', run('$10.00', { op: 'number' }), 10);
eq('number of empty is 0', run('', { op: 'number' }), 0);
eq('first number in messy text', run('In stock: 5 left', { op: 'firstNumber' }), 5);
eq('first number ignores later ones', run('3 of 12 left (£4.50)', { op: 'firstNumber' }), 3);
eq('last number', run('3 of 12 left', { op: 'lastNumber' }), 12);
eq('whole number drops decimals', run('19.99 USD', { op: 'int' }), 19);
eq('round to 2dp', run('3.14159', { op: 'round', a: '2' }), 3.14);
eq('digits only', run('SKU-1234/A', { op: 'digits' }), '1234');

// --- pulling a piece out ---------------------------------------------------
eq('text between', run('Price: £24.99 (inc VAT)', { op: 'between', a: '£', b: '(' }), '24.99');
eq('text between → number (a pipeline)',
  run('Price: £1,024.50 (inc VAT)', { op: 'between', a: '£', b: '(' }, { op: 'number' }), 1024.5);
eq('text between with missing marker is empty',
  run('no price here', { op: 'between', a: '£', b: '(' }), '');
eq('text after', run('Posted on 14 July 2026', { op: 'after', a: 'Posted on' }), '14 July 2026');
eq('text before', run('Widget A — in stock', { op: 'before', a: '—' }), 'Widget A');
eq('split and take part 2', run('Red | Large | Cotton', { op: 'part', a: '|', b: '2' }), 'Large');
eq('split out of range is empty', run('a|b', { op: 'part', a: '|', b: '9' }), '');

// --- rewrite ---------------------------------------------------------------
eq('replace', run('1 234 units', { op: 'replace', a: ' ', b: '' }), '1234units');
eq('prepend builds an absolute URL',
  run('/p/12', { op: 'prepend', a: 'https://site.com' }), 'https://site.com/p/12');
eq('append', run('42', { op: 'append', a: ' GBP' }), '42 GBP');
eq('pad to width', run('7', { op: 'pad', a: '2' }), '07');
eq('default fills an empty value', run('   ', { op: 'default', a: 'n/a' }), 'n/a');
eq('default leaves a real value alone', run('x', { op: 'default', a: 'n/a' }), 'x');
eq('tidy spaces', run('  Widget   A \n', { op: 'trim' }), 'Widget A');

// --- dates -----------------------------------------------------------------
eq('date day-first', run('14/07/2026', { op: 'dateDMY' }), '2026-07-14');
eq('date month-first', run('07/14/2026', { op: 'dateMDY' }), '2026-07-14');
eq('date 2-digit year', run('14-07-26', { op: 'dateDMY' }), '2026-07-14');
eq('date from prose', run('Posted on 14 July 2026 by Ann', { op: 'dateDMY' }), '2026-07-14');
eq('date US prose', run('July 14, 2026', { op: 'dateMDY' }), '2026-07-14');
eq('date ISO passes through', run('2026-7-4', { op: 'dateDMY' }), '2026-07-04');
eq('unparseable date is empty', run('sometime', { op: 'dateDMY' }), '');
eq('date after a text-cut', run('Updated: 01/02/2026', { op: 'after', a: ':' }, { op: 'dateDMY' }), '2026-02-01');

// --- regex (power users) ---------------------------------------------------
eq('pattern whole match', run('/product/1234-abc', { op: 'pattern', a: '[0-9]+' }), '1234');
eq('pattern capture group',
  run('/product/1234-abc', { op: 'pattern', a: '/product/([0-9]+)', b: '1' }), '1234');
eq('bad pattern does not throw', run('x', { op: 'pattern', a: '([' }), '');

// --- pipeline behaviour ----------------------------------------------------
eq('no transforms leaves the value alone', T.apply('as-is', []), 'as-is');
eq('unknown op is skipped', run('keep', { op: 'nope' }), 'keep');
eq('summary reads like the UI',
  T.summary([{ op: 'between', a: '£', b: '(' }, { op: 'number' }]),
  'Text between(£, () → Number');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
