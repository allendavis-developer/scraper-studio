// 🔗 Join — the general primitive for "I collected these rows one way and that
// data another way; stitch them together on a shared value" (a spreadsheet
// look-up / SQL LEFT JOIN). It's a standalone step, so it works no matter HOW
// either side was produced — a grabbed table, a grabbed list, or a loop.
//
//   • rows ⋈ dataset  → add the dataset's columns onto the rows you collected
//   • dataset ⋈ dataset → emit the combined rows
//   • unmatched left rows keep their columns (looked-up ones come through blank);
//     dataset rows with no left match are never invented into output.
//
//   node test/join-e2e.js

const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    FAIL++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base stock table columns (barserial is the join key).
const STOCK_FIELDS = [
  { name: 'barserial', label: 'Barserial', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
  { name: 'name', label: 'Name', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [] },
  { name: 'cost', label: 'Cost', selector: 'td:nth-child(3)', extract: 'text', include: true, transforms: [{ op: 'number' }] },
  { name: 'retail', label: 'Retail', selector: 'td:nth-child(4)', extract: 'text', include: true, transforms: [{ op: 'number' }] },
  { name: 'qty', label: 'Qty', selector: 'td:nth-child(5)', extract: 'text', include: true, transforms: [{ op: 'number' }] },
  { name: 'created', label: 'Created', selector: 'td:nth-child(6)', extract: 'text', include: true, transforms: [] }
];
const BUYERS_FIELDS = [
  { name: 'barserial', label: 'Barserial', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
  { name: 'boughtBy', label: 'Bought In By', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [] },
  { name: 'supplier', label: 'Supplier', selector: 'td:nth-child(3)', extract: 'text', include: true, transforms: [] }
];

const grabStock = (keep, ds) => ({
  type: 'scrapeTable', rowSelector: 'table.stock tbody tr:not(.total)', skipTotals: true,
  keep, dataset: ds || '', waitFirst: true, fields: JSON.parse(JSON.stringify(STOCK_FIELDS))
});
const grabBuyers = () => ({
  type: 'scrapeTable', rowSelector: 'table.buyers tbody tr', skipTotals: false,
  keep: 'dataset', dataset: 'buyers', waitFirst: true, fields: JSON.parse(JSON.stringify(BUYERS_FIELDS))
});

(async () => {
  const root = path.join(__dirname, '..');
  const stockUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'stock.html')).toString();
  const buyersUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'buyers.html')).toString();
  const tmpUserData = path.join(os.tmpdir(), 'scrapestudio-join-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmpUserData] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);

  const R = (fn, arg) => win.evaluate(fn, arg);
  async function waitUrl(match, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const u = await R(() => {
        try { return document.getElementById('view').getURL(); } catch (_) { return ''; }
      });
      if (u && u.includes(match)) return u;
      await sleep(200);
    }
    return null;
  }
  async function waitRunDone() {
    for (let i = 0; i < 200; i++) {
      if (!(await R(() => document.getElementById('run').disabled))) return;
      await sleep(150);
    }
  }
  async function runRecipe(payload) {
    await R((p) => {
      steps.length = 0;
      for (const st of p) steps.push(st);
      reidList(steps);
      renderSteps();
      results.length = 0;
      columns.length = 0;
      columnConfig.length = 0;
      renderResults();
    }, payload);
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    return R(() => JSON.parse(JSON.stringify(results)));
  }

  try {
    console.log('Join a look-up table into your rows\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Join Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, stockUrl);
    await waitUrl('stock.html');
    await sleep(700);

    // ---- [1] rows ⋈ dataset: grab stock rows, then join in a buy-in report. --
    console.log('\n[1] Grab the stock table as rows, join in the buy-in report by barserial');
    const recipeA = [
      grabStock('rows'),
      { type: 'goto', url: buyersUrl },
      grabBuyers(),
      { type: 'join', leftSource: 'rows', dataset: 'buyers', onLeft: 'barserial', onRight: 'barserial', bring: ['boughtBy', 'supplier'], prefix: '' }
    ];
    const rowsA = await runRecipe(recipeA);
    check('output has one row per stock item (5 — the Total row excluded)', rowsA.length === 5, `${rowsA.length} rows`);
    const byId = {};
    for (const r of rowsA) byId[r.barserial] = r;
    check('each row keeps its own robust table columns (numbers intact)',
      byId.BAR001 && byId.BAR001.name === '9ct Gold Ring' && byId.BAR001.cost === 45 && typeof byId.BAR001.cost === 'number',
      JSON.stringify(byId.BAR001));
    check('the joined-in columns land on the right rows (matched by barserial)',
      byId.BAR001.boughtBy === 'Cerys' && byId.BAR001.supplier === 'Acme Jewellers' &&
        byId.BAR003.boughtBy === 'harmonyA' && byId.BAR004.supplier === 'Pawn Partners',
      JSON.stringify(Object.keys(byId).map((k) => `${k}:${byId[k].boughtBy}`)));
    check('an unmatched row (BAR005 absent from the report) keeps its cols, blank look-up',
      byId.BAR005 && byId.BAR005.name === 'Pearl Earrings' && byId.BAR005.boughtBy === '' && byId.BAR005.supplier === '',
      JSON.stringify(byId.BAR005));
    check('a report row with no stock match (BAR777) is NOT invented into the output',
      !rowsA.some((r) => r.barserial === 'BAR777'));

    // ---- [2] The editor: single-purpose (no confusing mode dropdown), any-table
    //          look-up, ordered attach, live preview, CSV-table keep-for-look-ups.
    console.log('\n[2] The Join editor — one job, any grabbed table, ordered attach');
    await R((u) => { const i = document.getElementById('url'); i.value = u; document.getElementById('go').click(); }, buyersUrl);
    await waitUrl('buyers.html');
    await sleep(500);
    await R(() => openStepEditor(steps[steps.length - 1], steps, false));
    await sleep(500);
    const ed = await R(() => {
      const sels = [...document.querySelectorAll('#modal-body select')];
      const allVals = new Set();
      sels.forEach((s) => [...s.options].forEach((o) => o.value && allVals.add(o.value)));
      const modeSel = sels.find((s) => [...s.options].some((o) => o.value === 'enrich' || o.value === 'combine'));
      const lookupSel = sels.find((s) => [...s.options].some((o) => o.value === 'buyers'));
      return {
        hasModeDropdown: !!modeSel,
        lookupLabels: lookupSel ? [...lookupSel.options].map((o) => o.textContent) : [],
        allVals: [...allVals],
        pvRows: document.querySelectorAll('#modal-body .pv-table tr').length
      };
    });
    check('no confusing enrich/combine mode dropdown — Join has one clear job', !ed.hasModeDropdown);
    check('the look-up offers the kept table AND a CSV table (“keep for look-ups”)',
      ed.lookupLabels.some((l) => /buyers/.test(l)) && ed.lookupLabels.some((l) => /→ CSV/.test(l) && /keep for look-ups/i.test(l)),
      JSON.stringify(ed.lookupLabels));
    check('the match key offers values you grabbed (table columns like barserial, name, cost)',
      ['barserial', 'name', 'cost'].every((v) => ed.allVals.includes(v)), JSON.stringify(ed.allVals));
    check('the preview reads the real look-up table', ed.pvRows >= 5, `${ed.pvRows} rows`);

    // Picking the CSV table for look-ups flips that step to a kept dataset.
    const flipped = await R(() => {
      const sels = [...document.querySelectorAll('#modal-body select')];
      const lookupSel = sels.find((s) => [...s.options].some((o) => /→ CSV/.test(o.textContent)));
      const csvOpt = [...lookupSel.options].find((o) => /→ CSV/.test(o.textContent));
      lookupSel.value = csvOpt.value;
      lookupSel.dispatchEvent(new Event('change', { bubbles: true }));
      const st = steps.find((s) => s.type === 'scrapeTable' && (s.rowSelector || '').includes('stock'));
      return { keep: st.keep, dataset: st.dataset };
    });
    check('picking a CSV table for look-ups keeps it (stable name, out of the CSV)',
      flipped.keep === 'dataset' && !!flipped.dataset, JSON.stringify(flipped));
    await R(() => closeModal());
    await sleep(150);

    // ---- [3] dataset ⋈ dataset: keep BOTH as datasets, emit combined rows. ---
    console.log('\n[3] Join two kept datasets → fresh combined rows (bring ALL columns)');
    await R((u) => { const i = document.getElementById('url'); i.value = u; document.getElementById('go').click(); }, stockUrl);
    await waitUrl('stock.html');
    await sleep(400);
    const recipeB = [
      grabStock('dataset', 'stock'),
      { type: 'goto', url: buyersUrl },
      grabBuyers(),
      { type: 'join', leftSource: 'stock', dataset: 'buyers', onLeft: 'barserial', onRight: 'barserial', bring: [], prefix: '' }
    ];
    const rowsB = await runRecipe(recipeB);
    check('joining two datasets emits one combined row per LEFT row (5)', rowsB.length === 5, `${rowsB.length} rows`);
    const bId = {};
    for (const r of rowsB) bId[r.barserial] = r;
    check('combined rows carry BOTH sides’ columns',
      bId.BAR002 && bId.BAR002.name === 'Silver Bracelet' && bId.BAR002.boughtBy === 'Sobaan' && bId.BAR002.supplier === 'Gold Traders Ltd',
      JSON.stringify(bId.BAR002));
    check('unmatched left row (BAR005) still emitted, look-up columns blank',
      bId.BAR005 && bId.BAR005.name === 'Pearl Earrings' && bId.BAR005.boughtBy === '',
      JSON.stringify(bId.BAR005));

    // ---- [4] A name prefix keeps added columns from clashing. ---------------
    console.log('\n[4] A prefix namespaces the added columns');
    const recipeC = [
      grabStock('rows'),
      { type: 'goto', url: buyersUrl },
      grabBuyers(),
      { type: 'join', leftSource: 'rows', dataset: 'buyers', onLeft: 'barserial', onRight: 'barserial', bring: ['boughtBy'], prefix: 'report_' }
    ];
    const rowsC = await runRecipe(recipeC);
    check('the added column is prefixed (report_boughtBy), original data untouched',
      rowsC[0] && rowsC[0].report_boughtBy !== undefined && rowsC[0].boughtBy === undefined,
      JSON.stringify(Object.keys(rowsC[0] || {})));

    // ---- [4b] Join a single GRABBED VALUE (as the key) to a table. ----------
    console.log('\n[4b] Grab one value as the key, then join a table onto it');
    await R((u) => { const i = document.getElementById('url'); i.value = u; document.getElementById('go').click(); }, stockUrl);
    await waitUrl('stock.html');
    await sleep(400);
    const recipeV = [
      // A single "Grab one value" → the key column, in my head.
      { type: 'get', name: 'barserial', target: 'column', source: 'text',
        selector: 'table.stock tbody tr:nth-of-type(1) td:nth-child(1)', attr: '', transforms: [] },
      { type: 'goto', url: buyersUrl },
      grabBuyers(),
      { type: 'join', leftSource: 'rows', dataset: 'buyers', onLeft: 'barserial', onRight: 'barserial', bring: ['boughtBy', 'supplier'], prefix: '' }
    ];
    const rowsV = await runRecipe(recipeV);
    check('one grabbed value becomes one row, with the table’s columns attached to it',
      rowsV.length === 1 && rowsV[0].barserial === 'BAR001' && rowsV[0].boughtBy === 'Cerys' && rowsV[0].supplier === 'Acme Jewellers',
      JSON.stringify(rowsV[0]));

    // ---- [5] The join config survives a save round-trip. --------------------
    console.log('\n[5] The join config persists with the job');
    const persisted = await R(() => {
      const j = collectJob();
      const st = j.steps.find((s) => s.type === 'join');
      return st ? { left: st.leftSource, ds: st.dataset, onLeft: st.onLeft, onRight: st.onRight, bring: st.bring, prefix: st.prefix } : null;
    });
    check('the saved job keeps the join (sides, keys, attached columns)',
      persisted && persisted.left === 'rows' && persisted.ds === 'buyers' &&
        persisted.onLeft === 'barserial' && persisted.onRight === 'barserial' &&
        JSON.stringify(persisted.bring) === JSON.stringify(['boughtBy', 'supplier']),
      JSON.stringify(persisted));
  } catch (e) {
    FAIL++;
    console.log('  ✗ EXCEPTION: ' + e.message);
    console.log(e.stack);
  } finally {
    await app.close();
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
