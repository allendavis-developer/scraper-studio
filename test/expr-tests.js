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

eq('interp var', Expr.interpolate('page {{count}} of {{total}}', V), 'page 3 of 10');
eq('interp expr', Expr.interpolate('next={{count + 1}}', V), 'next=4');
eq('interp plain', Expr.interpolate('no braces', V), 'no braces');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
