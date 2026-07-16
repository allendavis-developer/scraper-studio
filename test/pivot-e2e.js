// Shaping the output freely: keep a rows-down table as a DATASET, then
//   • ⚡ Spread it into one column per row  (Sales by User → a column per person)
//   • pull single cells with a click-built Formula "look-up"
//   • keep an ordinary single value alongside
// …all landing on ONE output row. This is the "shape the data however you want"
// feature, driven through the real renderer.
//
//   node test/pivot-e2e.js

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

// The "Sales by User" table, kept whole as a dataset called salesByUser.
const SALES_TABLE = {
  type: 'scrapeTable',
  rowSelector: 'table.by-user tbody tr:not(.total)',
  skipTotals: true,
  keep: 'dataset',
  dataset: 'salesByUser',
  fields: [
    { name: 'user', label: 'User', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
    { name: 'refunds', label: 'Refunds', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [{ op: 'number' }] },
    { name: 'total', label: 'Total', selector: 'td:nth-child(3)', extract: 'text', include: true, transforms: [{ op: 'number' }] },
    { name: 'margin', label: 'Margin', selector: 'td:nth-child(4)', extract: 'text', include: true, transforms: [{ op: 'number' }] }
  ]
};

const RECIPE = [
  SALES_TABLE,
  // ⚡ one column per user, filled with their Total (legacy valCol/prefix shape).
  { type: 'spread', dataset: 'salesByUser', keyCol: 'user', valCol: 'total', prefix: 'Sales by ' },
  // ⚡ per user, BOTH Total and Margin, named "Sales ({user}) <measure>".
  { type: 'spread', dataset: 'salesByUser', keyCol: 'user', valCols: ['total', 'margin'], namePattern: 'Sales ({})' },
  // A click-built Formula "look-up": Cerys's total, straight off the dataset.
  { type: 'formula', name: 'cerysTotal', target: 'column',
    formula: { kind: 'lookup', dataset: 'salesByUser', keyCol: 'user', keyVal: 'Cerys', valCol: 'total' } },
  // A Formula "maths" column: cerysTotal − 10, proving cross-value maths.
  { type: 'formula', name: 'gap', target: 'column',
    formula: { kind: 'math', a: { type: 'col', v: 'cerysTotal' }, op: '-', b: { type: 'num', v: '10' } } },
  // An ordinary single value sitting on the same row.
  { type: 'get', name: 'reportName', target: 'column', source: 'text', selector: 'h5', attr: '', transforms: [] }
];

(async () => {
  const root = path.join(__dirname, '..');
  const report = pathToFileURL(path.join(__dirname, 'fixtures', 'report.html')).toString();
  const tmpUserData = path.join(os.tmpdir(), 'scrapestudio-pivot-' + Date.now());
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
    for (let i = 0; i < 150; i++) {
      if (!(await R(() => document.getElementById('run').disabled))) return;
      await sleep(150);
    }
  }

  try {
    console.log('Shape the output freely — keep + spread + formula\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Pivot Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, report);
    await waitUrl('report.html');
    await sleep(800);

    // ---- [1] The runtime: build the recipe and run it. -----------------------
    console.log('\n[1] Keep the “Sales by User” table, spread it, add formulas — one row');
    await R((payload) => {
      steps.length = 0;
      for (const st of payload) steps.push(st);
      reidList(steps);
      renderSteps();
      results.length = 0;
      columns.length = 0;
      columnConfig.length = 0;
      renderResults();
    }, RECIPE);
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();

    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    check('the whole scrape produces exactly ONE output row', rows.length === 1, `${rows.length} rows`);
    const r = rows[0] || {};

    check('one column per user — Sales by Cerys', r['Sales by Cerys'] === 110, JSON.stringify(r['Sales by Cerys']));
    check('one column per user — Sales by Charlie2', r['Sales by Charlie2'] === 12.99, JSON.stringify(r['Sales by Charlie2']));
    check('one column per user — Sales by Sobaan', r['Sales by Sobaan'] === 130, JSON.stringify(r['Sales by Sobaan']));
    check('one column per user — Sales by harmonyA', r['Sales by harmonyA'] === 511, JSON.stringify(r['Sales by harmonyA']));
    check('the Totals summary row was NOT spread into a column', r['Sales by Totals'] === undefined);
    check('spread values are real NUMBERS (sum in Excel)', typeof r['Sales by Cerys'] === 'number');

    // Multi-value spread: Total AND Margin per user, named with the {user} value.
    check('multi-value spread — “Sales (Cerys) Total”', r['Sales (Cerys) Total'] === 110, JSON.stringify(r['Sales (Cerys) Total']));
    check('multi-value spread — “Sales (Cerys) Margin”', r['Sales (Cerys) Margin'] === 40.98, JSON.stringify(r['Sales (Cerys) Margin']));
    check('multi-value spread — “Sales (harmonyA) Total”', r['Sales (harmonyA) Total'] === 511, JSON.stringify(r['Sales (harmonyA) Total']));

    check('Formula look-up column pulled Cerys’s total off the dataset', r.cerysTotal === 110, JSON.stringify(r.cerysTotal));
    check('Formula maths column computed cerysTotal − 10', r.gap === 100, JSON.stringify(r.gap));
    check('an ordinary single value rides on the same row', r.reportName === 'Sales & Income Summary', JSON.stringify(r.reportName));

    // ---- [2] The editors render (UI smoke): keep control, formula, spread. ----
    console.log('\n[2] The new editors open and wire up');
    // Grab-a-table keep control shows a dataset name once switched. Opening the
    // editor re-reads the table from the page (async), so wait before reading.
    await R(() => openStepEditor(steps[0], steps, false));
    await sleep(500);
    const keepUI = await R(() => {
      const sel = [...document.querySelectorAll('#modal-body .keep-control select')][0];
      return {
        hasControl: !!sel,
        options: sel ? [...sel.options].map((o) => o.value) : [],
        datasetName: (document.querySelector('#modal-body .keep-control input') || {}).value || ''
      };
    });
    check('Grab-a-table offers “rows vs. keep as dataset”',
      keepUI.hasControl && keepUI.options.includes('dataset') && keepUI.options.includes('rows'),
      JSON.stringify(keepUI.options));
    await R(() => document.getElementById('modal-cancel').click());
    await sleep(50);

    // The dedicated Formula step renders the builder + a live preview.
    const formulaUI = await R(() => {
      const f = { id: 999, type: 'formula', name: 'x', target: 'column', formula: { kind: 'math', a: { type: 'col', v: '' }, op: '-', b: { type: 'col', v: '' } } };
      openStepEditor(f, steps, true);
      const host = document.querySelector('#modal-body .formula-host');
      const preview = host && host.querySelector('.formula-preview');
      const title = document.getElementById('modal-title').textContent;
      return { hasHost: !!host, previewText: preview ? preview.textContent : '', title };
    });
    check('the 🧮 Formula step is its OWN step (not under Grab one value)', /Formula/.test(formulaUI.title), formulaUI.title);
    check('…it shows the builder', formulaUI.hasHost);
    check('…with a live compiled-formula preview', /number\(/.test(formulaUI.previewText),
      formulaUI.previewText);
    await R(() => document.getElementById('modal-cancel').click());
    await sleep(50);

    // The Spread editor lists the kept dataset.
    const spreadUI = await R(() => {
      const sp = { id: 998, type: 'spread', dataset: '', keyCol: '', valCol: '', prefix: '' };
      openStepEditor(sp, steps, true);
      const sel = document.querySelector('#modal-body select');
      return { datasetOptions: sel ? [...sel.options].map((o) => o.value) : [] };
    });
    check('the Spread editor lists the kept dataset to pivot',
      spreadUI.datasetOptions.includes('salesByUser'), JSON.stringify(spreadUI.datasetOptions));
    await R(() => document.getElementById('modal-cancel').click());

    // The editor can be dragged aside by its header (so you can read the page).
    await R(() => openStepEditor(steps[0], steps, false));
    await sleep(100);
    const dragged = await R(() => {
      const head = document.querySelector('#modal .modal-head');
      const card = document.querySelector('#modal .modal-card');
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 180 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return card.style.transform;
    });
    check('dragging the header moves the editor card', /translate\(160px, 80px\)/.test(dragged), dragged);
    const recentred = await R(() => {
      document.getElementById('modal-cancel').click();
      openStepEditor(steps[1], steps, false);
      const t = document.querySelector('#modal .modal-card').style.transform;
      document.getElementById('modal-cancel').click();
      return t;
    });
    check('a freshly opened editor re-centres (no leftover offset)', recentred === '', JSON.stringify(recentred));

    // ---- [3] The CSV carries the pivoted headings. ---------------------------
    console.log('\n[3] The exported CSV has a column per user');
    const csv = await R(() => toCsv());
    check('CSV header row has the per-user columns',
      /Sales by Cerys/.test(csv) && /Sales by harmonyA/.test(csv), csv.split('\r\n')[0]);
    check('CSV data row carries the numbers', /110/.test(csv) && /12\.99/.test(csv));

    // ---- [4] A "For each date" loop makes one dated row per day. -------------
    console.log('\n[4] A date-range loop makes one dated row per day');
    // Editor smoke: native date pickers + a live "runs N times" preview.
    const fdUI = await R(() => {
      openStepEditor({ id: 900, type: 'forDates', from: '2026-07-07', to: '2026-07-09', stepDays: 1, var: 'date', format: 'YYYY-MM-DD', asColumn: true, body: [], maxIter: 1000 }, steps, true);
      const hints = [...document.querySelectorAll('#modal-body .hint')].map((h) => h.textContent);
      const dateInputs = document.querySelectorAll('#modal-body input[type=date]').length;
      const ref = document.querySelector('#modal-body .date-ref');
      const refText = ref ? ref.textContent : '';
      document.getElementById('modal-cancel').click();
      return { hints, dateInputs, refText };
    });
    check('For-each-date editor has two native date pickers', fdUI.dateInputs === 2, String(fdUI.dateInputs));
    check('…and previews the dates it will run', fdUI.hints.some((t) => /Runs 3 times/.test(t)), JSON.stringify(fdUI.hints));
    check('…and documents the date functions as a reference',
      /dateAdd/.test(fdUI.refText) && /dateFmt/.test(fdUI.refText) && /Format tokens/.test(fdUI.refText),
      fdUI.refText.slice(0, 60));

    await R(() => {
      steps.length = 0;
      steps.push({
        type: 'forDates', from: '2026-07-07', to: '2026-07-09', stepDays: 1, var: 'date',
        format: 'YYYY-MM-DD', asColumn: true, maxIter: 1000,
        body: [{ type: 'formula', name: 'note', target: 'column', formula: { kind: 'combine', sep: '', parts: [{ type: 'text', v: 'day' }] } }]
      });
      reidList(steps);
      renderSteps();
      results.length = 0;
      columns.length = 0;
      columnConfig.length = 0;
      renderResults();
    });
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const drows = await R(() => JSON.parse(JSON.stringify(results)));
    check('one row per date in the range (rollover-safe)', drows.length === 3, `${drows.length} rows`);
    check('each row is dated via the {{date}} column',
      drows.map((r) => r.date).join(',') === '2026-07-07,2026-07-08,2026-07-09', JSON.stringify(drows.map((r) => r.date)));
    check('the body ran for each date', drows.every((r) => r.note === 'day'));

    // The reported bug: even when the data steps find NOTHING, a date loop must
    // still produce one dated row per date (not 0 rows).
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'forDates', from: '2026-07-07', to: '2026-07-09', stepDays: 1, var: 'date', format: 'YYYY-MM-DD', asColumn: true, maxIter: 1000, body: [] });
      reidList(steps);
      renderSteps();
      results.length = 0;
      columns.length = 0;
      columnConfig.length = 0;
      renderResults();
    });
    await sleep(150);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const erows = await R(() => JSON.parse(JSON.stringify(results)));
    check('a date loop with no data steps STILL yields one dated row per date',
      erows.length === 3 && erows.map((r) => r.date).join(',') === '2026-07-07,2026-07-08,2026-07-09',
      JSON.stringify(erows.map((r) => r.date)));

    // A 🧮 Formula "Just use a value" copies the loop's {{date}} into its own
    // column — no maths — and the date var IS offered in the value picker.
    const valUI = await R(() => {
      steps.length = 0;
      steps.push({ type: 'forDates', from: '2026-07-07', to: '2026-07-08', stepDays: 1, var: 'date', format: 'YYYY-MM-DD', asColumn: false, maxIter: 1000,
        body: [{ type: 'formula', name: 'reportDate', target: 'column', formula: { kind: 'value', v: { type: 'col', v: 'date' } } }] });
      reidList(steps);
      renderSteps();
      // Open the formula step's editor and read which value names are offered.
      const fstep = steps[0].body[0];
      openStepEditor(fstep, steps[0].body, false);
      const opts = [...document.querySelectorAll('#modal-body .operand select')].map((sel) => [...sel.options].map((o) => o.value));
      document.getElementById('modal-cancel').click();
      return { offered: opts.flat() };
    });
    check('the date loop variable is offered in the value picker', valUI.offered.includes('date'), JSON.stringify(valUI.offered));

    // Run the valUI steps (still current) so "Just use a value" is exercised.
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); document.getElementById('run').click(); });
    await waitRunDone();
    const vrows = await R(() => JSON.parse(JSON.stringify(results)));
    check('“Just use a value” copies {{date}} into a column (no maths)',
      vrows.length === 2 && vrows.map((r) => r.reportDate).join(',') === '2026-07-07,2026-07-08',
      JSON.stringify(vrows.map((r) => r.reportDate)));

    // Scope: a Formula OUTSIDE the date loop must NOT offer `date` (it only
    // exists inside the loop); one INSIDE must. (Reported leak.)
    const scopeUI = await R(() => {
      steps.length = 0;
      steps.push({ type: 'forDates', from: '2026-07-07', to: '2026-07-08', stepDays: 1, var: 'date', format: 'YYYY-MM-DD', asColumn: false, maxIter: 1000,
        body: [{ type: 'formula', name: 'inside', target: 'column', formula: { kind: 'value', v: { type: 'col', v: '' } } }] });
      steps.push({ type: 'formula', name: 'outside', target: 'column', formula: { kind: 'value', v: { type: 'col', v: '' } } });
      reidList(steps);
      renderSteps();
      const read = (step, list) => {
        openStepEditor(step, list, false);
        const o = [...document.querySelectorAll('#modal-body .operand select')].map((sel) => [...sel.options].map((x) => x.value)).flat();
        document.getElementById('modal-cancel').click();
        return o;
      };
      const inside = read(steps[0].body[0], steps[0].body);
      const outside = read(steps[1], steps);
      return { inside: inside.includes('date'), outside: outside.includes('date') };
    });
    check('date IS offered to a step inside the loop', scopeUI.inside);
    check('date is NOT offered to a step outside the loop', !scopeUI.outside);

    // ---- [5] "Run up to here" runs earlier steps then stops before the target.
    console.log('\n[5] Run up to here — earlier steps run, target and after do not');
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'formula', name: 'first', target: 'column', formula: { kind: 'value', v: { type: 'text', v: 'A' } } });
      steps.push({ type: 'formula', name: 'target', target: 'column', formula: { kind: 'value', v: { type: 'text', v: 'B' } } });
      steps.push({ type: 'formula', name: 'after', target: 'column', formula: { kind: 'value', v: { type: 'text', v: 'C' } } });
      reidList(steps);
      renderSteps();
    });
    // A right-click on the middle step offers "Run up to here".
    const menuText = await R(() => {
      const row = document.querySelectorAll('#steps .step .step-row')[1];
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }));
      const m = document.querySelector('.ctx-menu');
      const t = m ? m.textContent : '';
      if (m) document.body.click();
      return t;
    });
    check('right-click offers “Run up to here”', /Run up to here/.test(menuText), menuText.slice(0, 40));

    // Trigger it on the 2nd step (id known via reidList → order preserved).
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); runToHere(steps[1]); });
    await waitRunDone();
    const partial = await R(() => JSON.parse(JSON.stringify(results)));
    check('it committed the row built BEFORE the target only', partial.length === 0 || (partial.length === 1 && partial[0].after === undefined),
      JSON.stringify(partial));
    const logHas = await R(() => [...document.querySelectorAll('#log > div')].some((d) => /Stopped before the selected step/.test(d.textContent)));
    check('…and the log says the page is positioned for editing', logHas);

    // ---- [6] A loop counter can start at a chosen value (e.g. 1, not 0). -----
    console.log('\n[6] Repeat counter can start at a chosen value');
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'repeat', count: '3', indexVar: 'n', startAt: 1, body: [
        { type: 'formula', name: 'n', target: 'column', formula: { kind: 'value', v: { type: 'col', v: 'n' } } }
      ] });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    });
    await waitRunDone();
    const counters = await R(() => JSON.parse(JSON.stringify(results)).map((r) => r.n));
    check('the counter runs 1,2,3 (startAt = 1), not 0,1,2', counters.join(',') === '1,2,3', JSON.stringify(counters));
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
