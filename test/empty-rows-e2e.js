// Empty spacer <tr></tr> rows between real rows must NOT become blank output
// rows. Two defences, both proven here on a table that interleaves real rows
// with empty <tr></tr> spacers (exactly like the site the user hit):
//   [1] the picker generalizes a row pick to `tr:has(td)` — spacers aren't even
//       iterated (so no wasted "wait for it" timeouts, right count).
//   [2] the run engine skips any loop pass that collected only blanks — a safety
//       net if a spacer is matched anyway (e.g. a hand-typed selector).
//
//   node test/empty-rows-e2e.js

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
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'spacer-table.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-empty-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);
  const G = (code) => win.evaluate((c) => document.getElementById('view').executeJavaScript(c), code);

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
  async function guestClick(sel) {
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => {
      const x=${c.x}, y=${c.y};
      const el = document.elementFromPoint(x,y);
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    })()`);
  }

  try {
    console.log('Empty spacer rows never become blank output rows\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Spacer Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('spacer-table.html');
    await sleep(700);

    const matchCount = await G("document.querySelectorAll('#t tbody tr').length");
    check('the table has real + spacer rows (8 <tr> total)', matchCount === 8, `${matchCount} tr`);

    // ---- [1] Picker: a row pick skips the spacers via :has(td). --------------
    console.log('\n[1] Picking a row generalizes to real rows only (:has(td))');
    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="forEach"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(250);
    await guestClick('#t tbody tr:nth-of-type(1) td:nth-of-type(2)'); // a real (data) row
    await sleep(500);
    const hadChooser = await R(() => !!document.querySelector('.choice'));
    if (hadChooser) { await R(() => document.querySelector('.choice button.primary, .choice button').click()); await sleep(400); }
    await sleep(300);
    const sel = await R(() => (document.querySelector('#modal-body .sel-input') || {}).value || '');
    check('the row selector excludes empty spacers (uses :has)', /:has\(/.test(sel), sel);
    const picked = await G(`(() => { try { return document.querySelectorAll(${JSON.stringify(sel)}).length; } catch(e){ return -1; } })()`);
    check('…and it matches only the 4 real rows, not all 8', picked === 4, `${picked} rows match "${sel}"`);
    await R(() => document.getElementById('modal-cancel').click());
    await sleep(150);

    // ---- [2] Engine safety net: a matched spacer still produces no blank. -----
    console.log('\n[2] Even a broad "tbody tr" selector yields no blank rows');
    await R(() => {
      steps.length = 0;
      steps.push({
        type: 'forEach', selector: '#t tbody tr', filter: { match: 'all', rules: [] },
        indexVar: 'i', maxIter: 1000, startAt: 0,
        body: [
          { type: 'get', name: 'sku', target: 'column', source: 'text', selector: 'td:nth-of-type(2)', attr: '', transforms: [], waitFirst: false },
          { type: 'get', name: 'amount', target: 'column', source: 'text', selector: 'td:nth-of-type(4)', attr: '', transforms: [], waitFirst: false }
        ]
      });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    });
    await waitRunDone();
    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    check('only the 4 real rows become output rows (spacers skipped)', rows.length === 4, `${rows.length} rows`);
    check('…every output row has data (no blank rows)',
      rows.every((r) => String(r.sku || '').trim() && String(r.amount || '').trim()),
      JSON.stringify(rows.map((r) => r.sku)));
    check('…in order, with the right SKUs',
      rows.map((r) => r.sku).join(',') === 'BBWGAB214CA6F,BBWGOVN8OX9TL,BBWGO2GDHMPZ7,BBWGQM0R7EBIR',
      rows.map((r) => r.sku).join(','));
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
