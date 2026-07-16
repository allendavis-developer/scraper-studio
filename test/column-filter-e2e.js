// Filter rows by a SPECIFIC column, not the whole row's text — the case where
// several columns share a selector (bare <td>s) and a value appears in more than
// one column. Proves the "a specific column…" filter rule (runtime + UI wiring),
// driving the real Electron app.
//
//   node test/column-filter-e2e.js

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
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'column-filter.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-colfilter-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);
  const G = (code) => win.evaluate((c) => document.getElementById('view').executeJavaScript(c), code);
  async function guestClick(sel) {
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => {
      const x=${c.x}, y=${c.y};
      const el = document.elementFromPoint(x,y);
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    })()`);
  }

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

  // Build a For each over the rows, grab Type + Item, apply a filter, return rows.
  async function runWith(filter) {
    await R((flt) => {
      steps.length = 0;
      steps.push({
        type: 'forEach', selector: '#t tbody tr', filter: flt, indexVar: 'i', maxIter: 1000, startAt: 0,
        body: [
          { type: 'get', name: 'type', target: 'column', source: 'text', selector: 'td:nth-of-type(1)', attr: '', transforms: [], waitFirst: false },
          { type: 'get', name: 'item', target: 'column', source: 'text', selector: 'td:nth-of-type(2)', attr: '', transforms: [], waitFirst: false }
        ]
      });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    }, filter);
    await waitRunDone();
    return R(() => JSON.parse(JSON.stringify(results)));
  }

  try {
    console.log('Filter by a SPECIFIC column\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Col Filter';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('column-filter.html');
    await sleep(700);

    // [1] Whole-row text "contains Sale" is AMBIGUOUS — matches 3 (incl. row 2).
    console.log('\n[1] Whole-row text is ambiguous (the problem)');
    const byText = await runWith({ match: 'all', rules: [{ test: 'text', op: 'contains', value: 'Sale' }] });
    check('text contains “Sale” wrongly matches 3 rows', byText.length === 3, JSON.stringify(byText.map((r) => r.item)));

    // [2] A specific column: td:nth-of-type(1) (Type) is exactly "Sale" → 2 rows.
    console.log('\n[2] A specific column is precise (the fix)');
    const byCol = await runWith({ match: 'all', rules: [{ test: 'cell', selector: 'td:nth-of-type(1)', op: 'eq', value: 'Sale' }] });
    check('column Type is exactly “Sale” matches only the 2 real Sales', byCol.length === 2, JSON.stringify(byCol.map((r) => r.item)));
    check('…and they are the right rows (Widget, Gizmo)',
      byCol.map((r) => r.item).join(',') === 'Widget,Gizmo', JSON.stringify(byCol.map((r) => r.item)));

    // [3] Combine with another column: Type = Sale AND Status (col 3) = In Stock → 1.
    console.log('\n[3] Combine per-column rules with ALL');
    const byTwo = await runWith({ match: 'all', rules: [
      { test: 'cell', selector: 'td:nth-of-type(1)', op: 'eq', value: 'Sale' },
      { test: 'cell', selector: 'td:nth-of-type(3)', op: 'eq', value: 'In Stock' }
    ] });
    check('Type=Sale AND Status=In Stock narrows to 1 (Widget)',
      byTwo.map((r) => r.item).join(',') === 'Widget', JSON.stringify(byTwo.map((r) => r.item)));

    // [4] UI: choosing "a specific column…" reveals the column Pick field.
    console.log('\n[4] The editor exposes the column picker intuitively');
    const ui = await R(() => {
      const st = { type: 'forEach', selector: '#t tbody tr', filter: { match: 'all', rules: [{ test: 'cell', selector: '', op: 'eq', value: '' }] }, indexVar: 'i', maxIter: 1000, body: [] };
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
      const rows = [...document.querySelectorAll('#modal-body .formula-row')];
      const row = rows[rows.length - 1];
      const testSel = row ? row.querySelector('select') : null;
      const cellPick = row ? row.querySelector('.mini-pick') : null;
      const cellInp = row ? row.querySelector('input[placeholder="pick a column →"]') : null;
      return {
        testVal: testSel ? testSel.value : '',
        hasPick: !!cellPick && cellPick.offsetParent !== null,
        hasInput: !!cellInp && cellInp.offsetParent !== null
      };
    });
    check('the rule type is set to “a specific column…”', ui.testVal === 'cell', ui.testVal);
    check('a column Pick button is shown for it', ui.hasPick, JSON.stringify(ui));
    check('…and a field to hold the picked column', ui.hasInput, JSON.stringify(ui));

    // [5] A REAL column pick: click the Pick, click a cell, get a row-relative
    // selector back, and the editor returns. The column pick is scoped to the
    // row, so it opens a dialog with a COPY of the row — click the column there.
    console.log('\n[5] Picking a column returns a row-relative selector');
    await R(() => {
      const rows = [...document.querySelectorAll('#modal-body .formula-row')];
      rows[rows.length - 1].querySelector('.mini-pick').click();
    });
    await sleep(300);
    const modalHidden = await R(() => document.getElementById('modal').classList.contains('hidden'));
    check('the editor steps aside so you can see the item', modalHidden === true, `hidden=${modalHidden}`);
    // Click the Status column (3rd td) inside the dialog copy of the row.
    const cc = await G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='2147483640');
      const el = bd && bd.querySelector('td:nth-of-type(3)');
      if(!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
    })()`);
    if (!cc) throw new Error('dialog row clone missing td:nth-of-type(3)');
    await G(`(() => { const el=document.elementFromPoint(${cc.x},${cc.y}); el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${cc.x},clientY:${cc.y}})); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:${cc.x},clientY:${cc.y}})); })()`);
    await sleep(500);
    const picked = await R(() => {
      const inp = document.querySelector('#modal-body input[placeholder="pick a column →"]');
      return { val: inp ? inp.value : '(gone)', modalBack: !document.getElementById('modal').classList.contains('hidden') };
    });
    check('the editor came back after picking', picked.modalBack === true, JSON.stringify(picked));
    check('the picked column selector is row-relative (targets a td, not the table id)',
      /\btd\b/.test(picked.val) && !/#t\b/.test(picked.val), picked.val);
    await R(() => document.getElementById('modal-cancel').click());
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
