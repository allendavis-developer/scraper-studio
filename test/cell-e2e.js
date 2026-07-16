// "Place this value at row X, column Y" — cell placement with upsert. Lets you
// normalize differently-shaped blocks (gold has rows, silver has one, each with
// its own unit) into ONE table: for each value you grab (or compute), say which
// row (by a key column's value) and which column it belongs to. New row/column
// created on demand; an existing cell updated.
//
//   node test/cell-e2e.js

const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Grab-a-value that PLACES its result at a cell (row key = value, column).
const cell = (selector, matchVal, setCol, number) => ({
  type: 'get', name: '', target: 'cell', source: 'text', selector, attr: '',
  matchCol: 'metal', matchVal, setCol, transforms: number ? [{ op: 'number' }] : []
});

(async () => {
  const root = path.join(__dirname, '..');
  const url = pathToFileURL(path.join(__dirname, 'fixtures', 'metals.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-cell-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);
  async function waitUrl(m, t = 60) {
    for (let i = 0; i < t; i++) {
      const u = await R(() => { try { return document.getElementById('view').getURL(); } catch (_) { return ''; } });
      if (u && u.includes(m)) return u;
      await sleep(200);
    }
  }
  async function waitRunDone() {
    for (let i = 0; i < 200; i++) { if (!(await R(() => document.getElementById('run').disabled))) return; await sleep(150); }
  }

  try {
    console.log('Place values at row × column (upsert)\n' + '='.repeat(50));
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Cell Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, url);
    await waitUrl('metals.html');
    await sleep(700);

    const recipe = [
      // Silver (one row, Per KG) — price then unit into the SAME row.
      cell('table.silver td.price', 'Silver', 'price', true),
      cell('table.silver td.unit', 'Silver', 'unit', false),
      // Gold 9ct (from the multi-row gold block).
      cell('table.gold tr:nth-of-type(1) td.price', 'Gold 9ct', 'price', true),
      cell('table.gold tr:nth-of-type(1) td.unit', 'Gold 9ct', 'unit', false),
      // Platinum, addressed by a {{grabbed value}} as the row key.
      { type: 'get', name: 'm', target: 'var', source: 'text', selector: '.plat-h', attr: '', transforms: [] },
      { type: 'get', name: '', target: 'cell', source: 'text', selector: 'table.platinum td.price', attr: '',
        matchCol: 'metal', matchVal: '{{m}}', setCol: 'price', transforms: [{ op: 'number' }] },
      // A Formula placed into an EXISTING row (updates the Silver row, new column).
      { type: 'formula', target: 'cell', matchCol: 'metal', matchVal: 'Silver', setCol: 'flag',
        formula: { kind: 'value', v: { type: 'num', v: '42' } } }
    ];

    await R((p) => {
      steps.length = 0;
      for (const st of p) steps.push(st);
      reidList(steps);
      renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
    }, recipe);
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const rows = await R(() => JSON.parse(JSON.stringify(results)));

    check('one row per distinct key value (Silver, Gold 9ct, Platinum)', rows.length === 3, `${rows.length} rows`);
    const by = {};
    for (const r of rows) by[r.metal] = r;
    check('two values placed on the SAME key land on one row (price + unit)',
      by.Silver && by.Silver.price === 1156.19 && typeof by.Silver.price === 'number' && by.Silver.unit === 'Per KG',
      JSON.stringify(by.Silver));
    check('a value from a different block lands on its own row',
      by['Gold 9ct'] && by['Gold 9ct'].price === 35.15 && by['Gold 9ct'].unit === 'Per GM',
      JSON.stringify(by['Gold 9ct']));
    check('the row key can be a {{grabbed value}} ({{m}} → Platinum)',
      by.Platinum && by.Platinum.price === 33.81, JSON.stringify(by.Platinum));
    check('a Formula can UPDATE an existing row (new flag column on Silver only)',
      by.Silver.flag === 42 && by['Gold 9ct'].flag === undefined, JSON.stringify({ s: by.Silver.flag, g: by['Gold 9ct'].flag }));
    check('rows come out in the order their keys first appeared',
      rows[0].metal === 'Silver' && rows[1].metal === 'Gold 9ct' && rows[2].metal === 'Platinum',
      rows.map((r) => r.metal).join(', '));

    // The step summary reads as a placement.
    const summary = await R(() => {
      const s = steps.find((x) => x.type === 'get' && x.target === 'cell');
      return stepDetail(s);
    });
    check('the step list shows it as a cell placement', /cell \[metal = /.test(summary), summary);

    // ---- [B] Placement onto an EXISTING grabbed-table row (the reported bug):
    //          it must PATCH that row, not append a duplicate. ----------------
    console.log('\n[B] Place a value onto a row that a Grab-a-table already made');
    const stockUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'stock.html')).toString();
    await R((u) => { setStartUrl(u); const i = document.getElementById('url'); i.value = u; document.getElementById('go').click(); }, stockUrl);
    await waitUrl('stock.html');
    await sleep(500);
    const recipeB = [
      { type: 'scrapeTable', rowSelector: 'table.stock tbody tr:not(.total)', skipTotals: true, keep: 'rows', dataset: '', waitFirst: true,
        fields: [
          { name: 'barserial', label: 'Barserial', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
          { name: 'name', label: 'Name', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [] },
          { name: 'cost', label: 'Cost', selector: 'td:nth-child(3)', extract: 'text', include: true, transforms: [{ op: 'number' }] }
        ] },
      // Add an 8th-column-style value onto the EXISTING BAR003 row.
      { type: 'formula', target: 'cell', matchCol: 'barserial', matchVal: 'BAR003', setCol: 'stockQuantity',
        formula: { kind: 'value', v: { type: 'num', v: '7' } } }
    ];
    await R((p) => {
      steps.length = 0;
      for (const st of p) steps.push(st);
      reidList(steps);
      renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
    }, recipeB);
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const rowsB = await R(() => JSON.parse(JSON.stringify(results)));
    check('no duplicate row is appended — the table still has 5 rows', rowsB.length === 5, `${rowsB.length} rows`);
    const bar003 = rowsB.find((r) => r.barserial === 'BAR003');
    check('the placed value patches the EXISTING BAR003 row (keeps its own columns)',
      bar003 && bar003.stockQuantity === 7 && bar003.name === 'Diamond Pendant' && bar003.cost === 380,
      JSON.stringify(bar003));
    check('other rows are untouched (no stray stockQuantity)',
      rowsB.filter((r) => r.stockQuantity !== undefined).length === 1,
      JSON.stringify(rowsB.map((r) => r.barserial + ':' + (r.stockQuantity === undefined ? '-' : r.stockQuantity))));
  } catch (e) {
    FAIL++;
    console.log('  ✗ EXCEPTION: ' + e.message);
    console.log(e.stack);
  } finally {
    await app.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
