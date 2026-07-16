const Expr = require('../src/shared/expr.js');

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const V = { count: 3, total: 10, name: 'Widget', price: '19.99', flag: true, n10: '10', n9: '9' };

eq('number', Expr.evaluate('1 + 2 * 3', {}), 7);
eq('parens', Expr.evaluate('(1 + 2) * 3', {}), 9);
eq('var math', Expr.evaluate('count + 1', V), 4);
eq('comparison numeric', Expr.evaluate('total > count', V), true);
eq('numeric-string compare', Expr.evaluate('n10 > n9', V), true); // 10 > 9, not lexical
eq('lte', Expr.evaluate('count <= 3', V), true);
eq('equality num', Expr.evaluate('count == 3', V), true);
eq('equality str-num', Expr.evaluate('price == "19.99"', V), true);
eq('logical and', Expr.evaluate('count < 5 && flag', V), true);
eq('logical or', Expr.evaluate('count > 5 || total == 10', V), true);
eq('not', Expr.evaluate('!false', {}), true);
eq('string concat', Expr.evaluate('name + " A"', V), 'Widget A');
eq('number() add', Expr.evaluate('number(price) + 1', V), 20.99);
eq('len', Expr.evaluate('len(name)', V), 6);
eq('lower/contains', Expr.evaluate('contains(lower(name), "widg")', V), true);
eq('round', Expr.evaluate('round(number(price))', V), 20);
eq('int div', Expr.evaluate('int(total / count)', V), 3);
eq('unary minus', Expr.evaluate('-count + 5', V), 2);
eq('undefined var falsy', Expr.evaluate('missing == ""', V), false); // undefined -> "undefined"

eq('pad', Expr.evaluate('pad(7, 2)', {}), '07');
eq('match number in text', Expr.evaluate('match("In stock: 5 left", "[0-9]+")', {}), '5');
eq('match capture group', Expr.evaluate('match("/product/1234-abc", "/product/([0-9]+)", 1)', {}), '1234');
eq('test regex', Expr.evaluate('test("SKU-99", "^SKU-")', {}), true);
eq('regexReplace', Expr.evaluate('regexReplace("a1b2c3", "[0-9]", "")', {}), 'abc');

// --- Table helpers: lookup / sumcol / countrows over a "dataset" ------------
// A dataset is an array of {column: value} row objects (a grabbed table kept
// whole). This is what powers click-built Formula "look-up" columns and pivots.
const SALES = [
  { user: 'Cerys', total: 110, margin: 40.98 },
  { user: 'Charlie2', total: 12.99, margin: -105.62 },
  { user: 'Sobaan', total: 130, margin: 57.14 },
  { user: 'harmonyA', total: 511, margin: 30.08 }
];
const D = { sales: SALES };
eq('lookup basic', Expr.evaluate('lookup(sales, "user", "Cerys", "total")', D), 110);
eq('lookup case/space-insensitive key', Expr.evaluate('lookup(sales, "user", " charlie2 ", "total")', D), 12.99);
eq('lookup miss → ""', Expr.evaluate('lookup(sales, "user", "Nobody", "total")', D), '');
eq('lookup bad dataset → ""', Expr.evaluate('lookup(missing, "user", "Cerys", "total")', D), '');
eq('lookup feeds maths', Expr.evaluate('number(lookup(sales, "user", "Sobaan", "total")) + 1', D), 131);
eq('sumcol total', Expr.evaluate('round(sumcol(sales, "total"), 2)', D), 763.99);
eq('countrows', Expr.evaluate('countrows(sales)', D), 4);

// --- Dates: rollover-safe maths + formatting --------------------------------
eq('dateAdd same month', Expr.evaluate('dateAdd("2026-07-07", 3)', {}), '2026-07-10');
eq('dateAdd month rollover', Expr.evaluate('dateAdd("2026-07-30", 5)', {}), '2026-08-04');
eq('dateAdd year rollover', Expr.evaluate('dateAdd("2026-12-30", 3)', {}), '2027-01-02');
eq('dateAdd negative', Expr.evaluate('dateAdd("2026-07-01", -1)', {}), '2026-06-30');
eq('dateAdd zero normalizes', Expr.evaluate('dateAdd("2026-7-7", 0)', {}), '2026-07-07');
eq('dateFmt DD/MM/YYYY', Expr.evaluate('dateFmt("2026-07-07", "DD/MM/YYYY")', {}), '07/07/2026');
eq('dateFmt long', Expr.evaluate('dateFmt("2026-07-07", "D MMM YYYY")', {}), '7 Jul 2026');
eq('dateFmt month-name has no false M', Expr.evaluate('dateFmt("2026-03-05", "MMMM D")', {}), 'March 5');
eq('dateDiff whole days', Expr.evaluate('dateDiff("2026-07-01", "2026-07-31")', {}), 30);
eq('date via DD/MM/YYYY input', Expr.evaluate('dateAdd("07/07/2026", 1)', {}), '2026-07-08');
eq('direct export dateAdd', Expr.dateAdd('2026-07-07', 1), '2026-07-08');
eq('today() shape', /^\d{4}-\d{2}-\d{2}$/.test(Expr.today()), true);

// --- List helpers: the work-queue primitives (drive arbitrary-depth crawls) --
const Q = { q: ['a', 'b', 'c'], one: 'x', empty2: [] };
eq('listLen of array', Expr.evaluate('listLen(q)', Q), 3);
eq('listLen of empty', Expr.evaluate('listLen(empty2)', Q), 0);
eq('listLen of scalar counts as 1', Expr.evaluate('listLen(one)', Q), 1);
eq('listLen of missing is 0', Expr.evaluate('listLen(nope)', Q), 0);
eq('listFirst', Expr.evaluate('listFirst(q)', Q), 'a');
eq('listFirst of empty → ""', Expr.evaluate('listFirst(empty2)', Q), '');
eq('listRest pops the front', Expr.evaluate('listRest(q)', Q), ['b', 'c']);
eq('listRest of empty → []', Expr.evaluate('listRest(empty2)', Q), []);
eq('listConcat two lists', Expr.evaluate('listConcat(q, listRest(q))', Q), ['a', 'b', 'c', 'b', 'c']);
eq('listConcat appends a scalar', Expr.evaluate('listConcat(q, one)', Q), ['a', 'b', 'c', 'x']);
eq('listConcat onto empty', Expr.evaluate('listConcat(empty2, one)', Q), ['x']);
eq('listHas present', Expr.evaluate('listHas(q, "b")', Q), true);
eq('listHas absent', Expr.evaluate('listHas(q, "z")', Q), false);
// The queue-drain shape: front item + remaining, and the terminate check.
eq('drain: len>0 gate', Expr.evaluate('listLen(q) > 0', Q), true);
eq('drain: emptied gate', Expr.evaluate('listLen(listRest(listRest(listRest(q)))) > 0', Q), false);

eq('interp var', Expr.interpolate('page {{count}} of {{total}}', V), 'page 3 of 10');
eq('interp expr', Expr.interpolate('next={{count + 1}}', V), 'next=4');
eq('interp plain', Expr.interpolate('no braces', V), 'no braces');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
