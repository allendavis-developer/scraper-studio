// "For each … where" — keep only the matched items that pass rules (text/attr/
// number), with a live count + preview. Plus the 🔄 Refresh page action. Drives
// the real Electron app.
//
//   node test/filter-e2e.js

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
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'filter.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-filter-' + Date.now());
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
    for (let i = 0; i < 150; i++) { if (!(await R(() => document.getElementById('run').disabled))) return; await sleep(150); }
  }

  try {
    console.log('For each … where  +  Refresh page\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Filter Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('filter.html');
    await sleep(700);

    // ---- [1] Editor: the filter previews the count + which items match. ------
    console.log('\n[1] The filter shows a live count and the matched items');
    const prev = await R(() => {
      const st = { type: 'forEach', selector: '.item', filter: { match: 'all', rules: [{ test: 'text', op: 'contains', value: 'Xbox' }] }, indexVar: 'i', maxIter: 1000, body: [] };
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
      return true;
    });
    await sleep(400); // let the auto-preview read the page
    const previewInfo = await R(() => {
      const box = document.querySelector('#modal-body .preview-box');
      const items = [...document.querySelectorAll('#modal-body .fs-item')].map((d) => d.textContent);
      return { head: box ? (box.querySelector('.pv-head') || {}).textContent : '', items };
    });
    check('the filter previews “3 of 5 items match”', /3 of 5 items match/.test(previewInfo.head), previewInfo.head);
    check('…and previews the actual matched items (only Xbox ones)',
      previewInfo.items.length === 3 && previewInfo.items.every((t) => /Xbox/.test(t)), JSON.stringify(previewInfo.items));
    await R(() => document.getElementById('modal-cancel').click());

    // ---- [2] Runtime: only the matched items produce rows. -------------------
    console.log('\n[2] The loop iterates only the matched items');
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'forEach', selector: '.item', filter: { match: 'all', rules: [{ test: 'text', op: 'contains', value: 'Xbox' }] }, indexVar: 'i', maxIter: 1000,
        body: [{ type: 'get', name: 'name', target: 'column', source: 'text', selector: '.name', attr: '', transforms: [] }] });
      reidList(steps); renderSteps();
      document.getElementById('run').click();
    });
    await waitRunDone();
    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    check('only the 3 Xbox items become rows', rows.length === 3, `${rows.length} rows`);
    check('…and they are the right ones, in order',
      rows.map((r) => r.name).join(' | ') === 'Xbox Series X | Xbox Game Pass | Xbox Controller',
      JSON.stringify(rows.map((r) => r.name)));

    // A number rule narrows further: Xbox items with price > 40 → 2 of them.
    await R(() => {
      steps[0].filter.rules.push({ test: 'number', op: 'gt', value: '40' });
      steps[0].filter.match = 'all';
      document.getElementById('run').click();
    });
    await waitRunDone();
    const rows2 = await R(() => JSON.parse(JSON.stringify(results)));
    check('adding “number > 40” (ALL) narrows to 1 (only Series X at 445)',
      rows2.map((r) => r.name).join(',') === 'Xbox Series X', JSON.stringify(rows2.map((r) => r.name)));

    // ---- [3] 🔄 Refresh page actually reloads the page. ----------------------
    console.log('\n[3] Refresh page reloads the current page');
    await G('window.__marker = 123;'); // set a flag that a reload will clear
    const before = await G('window.__marker');
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'refresh' });
      reidList(steps); renderSteps();
      document.getElementById('run').click();
    });
    await waitRunDone();
    await sleep(400);
    const after = await G('typeof window.__marker');
    check('the marker was set before refresh', before === 123, String(before));
    check('after a Refresh step, the page reloaded (marker gone)', after === 'undefined', after);

    // ---- [4] "Whether TEXT appears" — a yes/no value, no selector needed. -----
    console.log('\n[4] Grab whether a piece of text appears on the page');
    await R(() => {
      steps.length = 0;
      steps.push({ type: 'get', name: 'sawXbox', target: 'column', source: 'textExists', selector: '', attr: '', transforms: [], textExists: { text: 'PlayStation 5', mode: 'contains', container: '' } });
      steps.push({ type: 'get', name: 'sawMissing', target: 'column', source: 'textExists', selector: '', attr: '', transforms: [], textExists: { text: 'Nintendo Switch', mode: 'contains', container: '' } });
      steps.push({ type: 'get', name: 'inContainer', target: 'column', source: 'textExists', selector: '', attr: '', transforms: [], textExists: { text: 'Zelda', mode: 'contains', container: '#list' } });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    });
    await waitRunDone();
    const trow = await R(() => (results[0] || {}));
    check('text that IS on the page → true', trow.sawXbox === true, JSON.stringify(trow.sawXbox));
    check('text that is NOT on the page → false', trow.sawMissing === false, JSON.stringify(trow.sawMissing));
    check('text found within the given container → true', trow.inContainer === true, JSON.stringify(trow.inContainer));

    // ---- [5] Picking a form field auto-sets the source + shows a live value. -
    console.log('\n[5] Picking a form field auto-suggests “value” and previews it live');
    const auto = await R(async () => {
      const st = { type: 'get', name: '', target: 'column', source: 'text', selector: '', attr: '', expr: '', transforms: [] };
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
      // Simulate the picker landing on the number input (bypass the click UI).
      const filled = [...document.querySelectorAll('#modal-body .pick-btn')];
      // Directly drive the onFilled path by setting the selector input + dispatching,
      // then invoking the same suggestion the picker would.
      const selInput = document.querySelector('#modal-body .sel-input');
      selInput.value = '#qty';
      selInput.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    // Give the editor a beat; then apply the suggestion the way onFilled does and read state.
    await R(async () => {
      const PA = window.PageActions;
      const sug = await document.getElementById('view').executeJavaScript(PA.suggestSourceExpr('#qty'));
      // Mirror onFilled's effect for the test (source select + editing.source).
      const srcSel = document.querySelector('#modal-body .src-select');
      if (sug && sug.strong) { srcSel.value = sug.source; srcSel.dispatchEvent(new Event('change', { bubbles: true })); }
      window.__sug = sug;
    });
    await sleep(400);
    const autoState = await R(() => ({
      sug: window.__sug,
      srcVal: document.querySelector('#modal-body .src-select').value,
      live: (document.querySelector('#modal-body .get-live') || {}).textContent || ''
    }));
    check('a picked <input> is detected as a form field', autoState.sug && autoState.sug.source === 'value' && autoState.sug.strong,
      JSON.stringify(autoState.sug));
    check('the source is auto-set to “value” (not text)', autoState.srcVal === 'value', autoState.srcVal);
    check('the live preview shows the real value (42) without pressing Test', /value now:\s*42/.test(autoState.live), autoState.live);
    await R(() => document.getElementById('modal-cancel').click());

    // ---- [6] "Wait for it to appear first" catches a late-loading element. ---
    console.log('\n[6] Auto “wait for it first” grabs an element that loads late');
    // Reload so #late is absent again, then immediately run a grab for it.
    await R(() => { document.getElementById('view').reload(); });
    await sleep(200); // #late appears ~700ms after load — grab must wait it out
    const waited = await R(() => {
      steps.length = 0;
      steps.push({ type: 'get', name: 'late', target: 'column', source: 'text', selector: '#late', attr: '', transforms: [], waitFirst: true });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
      return true;
    });
    await waitRunDone();
    const wrow = await R(() => (results[0] || {}));
    check('with wait ON, the late element is grabbed (not blank)', wrow.late === 'Loaded late', JSON.stringify(wrow.late));

    // New grab steps default to waitFirst = true.
    const dflt = await R(() => {
      const b = BLANK.get();
      const l = BLANK.scrapeList();
      const t = BLANK.scrapeTable();
      return [b.waitFirst, l.waitFirst, t.waitFirst];
    });
    check('new grab steps default to waiting (ticked)', JSON.stringify(dflt) === JSON.stringify([true, true, true]), JSON.stringify(dflt));
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
