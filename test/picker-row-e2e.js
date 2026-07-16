// Picking a repeating ROW: in a "For each" (list-mode) pick, hovering a table
// cell must highlight the WHOLE ROW and picking it must select EVERY row — so a
// non-technical user can say "for each row, where a column = X". Drives the real
// Electron app + picker.
//
//   node test/picker-row-e2e.js

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
  const report = pathToFileURL(path.join(__dirname, 'fixtures', 'report.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-pickrow-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);
  const G = (code) => win.evaluate((c) => document.getElementById('view').executeJavaScript(c), code);

  async function waitUrl(match, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const u = await R(() => { try { return document.getElementById('view').getURL(); } catch (_) { return ''; } });
      if (u && u.includes(match)) return u;
      await sleep(200);
    }
    return null;
  }
  async function guestClick(sel, alt = false) {
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => {
      const x=${c.x}, y=${c.y}, alt=${alt ? 'true' : 'false'};
      const el = document.elementFromPoint(x,y);
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y,altKey:alt}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y,altKey:alt}));
    })()`);
  }

  try {
    console.log('Picking a repeating ROW ("For each row")\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Row Pick Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, report);
    await waitUrl('report.html');
    await sleep(800);

    // Add a "For each" step and start its (list-mode) selector pick.
    console.log('\n[1] For each → Pick, then hover a table cell');
    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="forEach"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click()); // start list pick
    await sleep(250);

    // Hovering a CELL in list mode must highlight the WHOLE ROW.
    const hover = await G(`(() => {
      const el = document.querySelector('tbody tr:nth-of-type(2) td:nth-of-type(2)');
      const r = el.getBoundingClientRect();
      const row = el.closest('tr').getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:Math.round(r.left+r.width/2), clientY:Math.round(r.top+r.height/2)}));
      const ov = [...document.documentElement.children].find(n => n.tagName === 'DIV' && n.style.position === 'fixed' && n.style.zIndex === '2147483646');
      const lb = [...document.documentElement.children].find(n => n.tagName === 'DIV' && n.style.position === 'fixed' && n.style.zIndex === '2147483647');
      return {
        w: ov ? Math.round(parseFloat(ov.style.width)) : 0,
        h: ov ? Math.round(parseFloat(ov.style.height)) : 0,
        rowW: Math.round(row.width), rowH: Math.round(row.height),
        cellW: Math.round(r.width),
        label: lb ? lb.textContent : ''
      };
    })()`);
    check('hovering a cell highlights the WHOLE row, not the cell',
      hover.w === hover.rowW && hover.h === hover.rowH && hover.w > hover.cellW * 2,
      `overlay ${hover.w}×${hover.h} vs row ${hover.rowW}×${hover.rowH} (cell ${hover.cellW})`);
    check('…and the label says it picks every row',
      /This row — picks every row/.test(hover.label), hover.label);

    // Click the cell → the row selector must match MANY rows (all body rows).
    console.log('\n[2] Clicking picks EVERY row');
    await guestClick('tbody tr:nth-of-type(2) td:nth-of-type(2)');
    await sleep(500);
    const hadChooser = await R(() => !!document.querySelector('.choice'));
    if (hadChooser) { await R(() => document.querySelector('.choice button.primary, .choice button').click()); await sleep(400); }
    await sleep(400);

    const sel = await R(() => (document.querySelector('#modal-body .sel-input') || {}).value || '');
    check('the picked selector targets rows (a <tr>), not a cell', /\btr\b/.test(sel) && !/\btd\b/.test(sel), sel);
    const count = await G(`(() => { try { return document.querySelectorAll(${JSON.stringify(sel)}).length; } catch(e){ return -1; } })()`);
    check('…and it matches EVERY body row (more than one)', count > 1, `${count} rows match "${sel}"`);

    // And the step being edited really is a For each over that row selector.
    const step = await R(() => (typeof editing !== 'undefined' && editing) ? { type: editing.type, selector: editing.selector } : null);
    check('the For each step now loops that row selector',
      step && step.type === 'forEach' && step.selector === sel && /\btr\b/.test(step.selector), JSON.stringify(step));

    // ---- Alt escape hatch: pick a single cell even in list mode. -------------
    console.log('\n[3] Holding Alt picks a single cell (a column), not the row');
    await R(() => document.querySelector('#modal-body .pick-btn').click()); // re-start list pick
    await sleep(250);
    const altHover = await G(`(() => {
      const el = document.querySelector('tbody tr:nth-of-type(2) td:nth-of-type(2)');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:Math.round(r.left+r.width/2), clientY:Math.round(r.top+r.height/2), altKey:true}));
      const ov = [...document.documentElement.children].find(n => n.tagName === 'DIV' && n.style.position === 'fixed' && n.style.zIndex === '2147483646');
      return { w: ov ? Math.round(parseFloat(ov.style.width)) : 0, cellW: Math.round(r.width) };
    })()`);
    check('with Alt held, the overlay is the CELL width, not the row',
      Math.abs(altHover.w - altHover.cellW) <= 2, `overlay ${altHover.w} vs cell ${altHover.cellW}`);

    await guestClick('tbody tr:nth-of-type(2) td:nth-of-type(2)', true); // Alt+click
    await sleep(500);
    const hadChooser2 = await R(() => !!document.querySelector('.choice'));
    if (hadChooser2) { await R(() => document.querySelector('.choice button.primary, .choice button').click()); await sleep(400); }
    await sleep(400);
    const altSel = await R(() => (document.querySelector('#modal-body .sel-input') || {}).value || '');
    check('Alt+click picked a cell selector (targets td), not the row', /\btd\b/.test(altSel), altSel);
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
