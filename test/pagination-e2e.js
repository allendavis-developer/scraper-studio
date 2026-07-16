// Pagination "until the last page" with EXISTING primitives — no bespoke step.
// The pattern: While(true) → Grab a table → check "is there an ENABLED next"
// (get: exists, on a `:not(.disabled)` selector) → If not, Break → else Click
// Next + Wait. The `:not(.disabled)` selector is what makes the "button is there
// but not clickable" case a reliable stop signal. Drives the real app.
//
//   node test/pagination-e2e.js

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

(async () => {
  const root = path.join(__dirname, '..');
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'paged.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-paged-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);

  async function waitUrl(m, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const u = await R(() => { try { return document.getElementById('view').getURL(); } catch (_) { return ''; } });
      if (u && u.includes(m)) return u;
      await sleep(200);
    }
    return null;
  }
  async function waitRunDone() {
    for (let i = 0; i < 200; i++) { if (!(await R(() => document.getElementById('run').disabled))) return; await sleep(150); }
  }

  try {
    console.log('Paginate to the last page (existing primitives)\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Paged';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('paged.html');
    await sleep(700);

    // While(true, capped): grab this page's table, then stop if there's no
    // ENABLED next (button gone OR present-but-.disabled), else click + wait.
    const NEXT = '#next:not(.disabled):not([aria-disabled="true"])';
    await R((nextSel) => {
      steps.length = 0;
      steps.push({
        type: 'while',
        condition: { match: 'all', rules: [{ left: '1', op: 'eq', right: '1' }] }, // while true
        maxIter: 50,
        body: [
          // Grab the current page's table (rows accumulate across passes).
          { type: 'scrapeTable', rowSelector: '#t tbody tr', keep: 'rows', dataset: '', skipTotals: false,
            fields: [
              { name: 'barserial', label: 'Barserial', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
              { name: 'name', label: 'Name', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [] }
            ] },
          // Is there an ENABLED "next"?  (yes/no)
          { type: 'get', name: 'hasNext', target: 'var', source: 'exists', selector: nextSel, attr: '', transforms: [] },
          // No enabled next → we're on the last page → stop.
          { type: 'if', condition: { match: 'all', rules: [{ left: 'hasNext', op: 'false' }] },
            then: [{ type: 'break' }], else: [] },
          // Otherwise advance and wait for the page to change.
          { type: 'click', selector: '#next', text: '' },
          { type: 'wait', ms: 250 }
        ]
      });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    }, NEXT);
    await waitRunDone();

    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    check('collected every row across all 3 pages (6 rows)', rows.length === 6, `${rows.length} rows`);
    check('…in order, first and last are right',
      rows.length === 6 && rows[0].barserial === 'BSER-001' && rows[5].barserial === 'BSER-006',
      JSON.stringify(rows.map((r) => r.barserial)));
    check('…no duplicate rows (didn’t re-grab a page)',
      new Set(rows.map((r) => r.barserial)).size === 6, JSON.stringify(rows.map((r) => r.barserial)));
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
