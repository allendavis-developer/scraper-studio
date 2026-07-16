// Scoped picking: when you pick a value/column INSIDE a container (a grab-a-list
// row, or a step nested in a "For each"), the picker pops a DIALOG containing a
// styled copy of that item and only lets you click inside the copy — so you
// can't roam the whole page and pick something that fails later, and it works no
// matter where the page is scrolled. Normal grabs (no container) stay page-wide.
// Drives the real Electron app + picker.
//
//   node test/scoped-pick-e2e.js

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

const BACKDROP_Z = '2147483640';

(async () => {
  const root = path.join(__dirname, '..');
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'cards.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-scoped-' + Date.now());
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
  // Is the scoped-pick dialog open? Return a snapshot of its clone contents.
  async function dialogState() {
    return G(`(() => {
      const bd = [...document.documentElement.children].find(n => n.tagName==='DIV' && n.style.position==='fixed' && n.style.zIndex==='${BACKDROP_Z}');
      if (!bd) return { open:false };
      const clone = bd.querySelector('.wrapper-box');
      return {
        open: true,
        hasClone: !!clone,
        title: clone ? (clone.querySelector('.card-title')||{}).textContent : '',
        price: clone ? (clone.querySelector('.product-main-price')||{}).textContent : ''
      };
    })()`);
  }
  // Click at explicit guest coordinates (a mousemove then click).
  async function guestClickXY(x, y) {
    await G(`(() => { const el=document.elementFromPoint(${x},${y}); if(!el) return; el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${x},clientY:${y}})); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:${x},clientY:${y}})); })()`);
  }
  // Move/click the centre of a clone element (inside the dialog) by selector.
  async function cloneCentre(sel) {
    return G(`(() => {
      const bd = [...document.documentElement.children].find(n => n.tagName==='DIV' && n.style.position==='fixed' && n.style.zIndex==='${BACKDROP_Z}');
      const el = bd && bd.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
    })()`);
  }
  async function highlightOn() {
    return G(`(() => { const ov=[...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='2147483646'); return !!(ov&&ov.style.display!=='none'); })()`);
  }
  // The scaled content footprint (the sizedBox) inside the dialog.
  async function scaledSize() {
    return G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='${BACKDROP_Z}');
      if (!bd) return { w:0, h:0 };
      const stage = bd.firstElementChild.children[1];
      const sized = stage.firstElementChild;
      const r = sized.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
  }
  // Make the dialog bigger (as a user would drag its resize grip).
  async function growDialog(dw, dh) {
    await G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='${BACKDROP_Z}');
      const dlg = bd.firstElementChild;
      const r = dlg.getBoundingClientRect();
      dlg.style.width = (r.width + ${dw}) + 'px';
      dlg.style.height = (r.height + ${dh}) + 'px';
    })()`);
  }
  // Does the dialog fit on screen with no scrolling, at a bounded size?
  async function fitState() {
    return G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='${BACKDROP_Z}');
      if (!bd) return { open:false };
      const dlg = bd.firstElementChild;
      const stage = dlg.children[1];
      const dr = dlg.getBoundingClientRect();
      return {
        open: true,
        dialogInView: dr.left >= -1 && dr.top >= -1 && dr.right <= innerWidth + 1 && dr.bottom <= innerHeight + 1,
        noInnerScroll: stage.scrollWidth <= stage.clientWidth + 1 && stage.scrollHeight <= stage.clientHeight + 1,
        wPct: Math.round(dr.width / innerWidth * 100),
        hPct: Math.round(dr.height / innerHeight * 100)
      };
    })()`);
  }

  try {
    console.log('Scoped picking (copy the item into a dialog)\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Scoped';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('cards.html');
    await sleep(700);

    // Scroll the page DOWN first — the dialog must still show a card (the whole
    // point vs. spotlighting an instance that may be scrolled out of view).
    await G('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(150);

    // A grab-a-list with the card as the row; add one (empty) column, then Pick it.
    // That column pick is RELATIVE to '.wrapper-box' → scoped.
    console.log('\n[1] A column pick inside a list opens a dialog with a card copy');
    await R(() => {
      const st = { ...BLANK.scrapeList(), rowSelector: '.wrapper-box' };
      st.fields = [{ name: '', selector: '', extract: 'text', attr: '' }];
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
    });
    await sleep(200);
    await R(() => document.querySelector('#modal-body .field-list .mini-pick').click());
    await sleep(300);

    const dlg = await dialogState();
    check('a dialog opens (independent of scroll position)', dlg.open === true, JSON.stringify(dlg));
    check('it contains a COPY of the card', dlg.hasClone === true, JSON.stringify(dlg));
    check('the copy shows the real, styled content (title + price)',
      /Super Mario Sunshine/.test(dlg.title || '') && /£20\.00/.test(dlg.price || ''), JSON.stringify(dlg));

    // The dialog must fit fully on screen with no scrolling, at a bounded size.
    const fit = await fitState();
    check('the dialog fits fully on screen (no page scroll)', fit.dialogInView === true, JSON.stringify(fit));
    check('the item fits inside the dialog (no inner scroll)', fit.noInnerScroll === true, JSON.stringify(fit));
    check('the dialog is a bounded, sensible size (≤ ~65% each dimension)',
      fit.wPct <= 68 && fit.hPct <= 68, JSON.stringify(fit));

    // [2] Clicking the dimmed backdrop (outside the copy) is rejected.
    console.log('\n[2] Outside the copy is not pickable');
    await guestClickXY(4, 4); // top-left corner → backdrop, not the centered card
    await sleep(300);
    const afterOutside = await R(() => ({
      modalHidden: document.getElementById('modal').classList.contains('hidden'),
      val: (document.querySelector('#modal-body .field-list .sel-input') || {}).value || ''
    }));
    check('clicking the backdrop does NOT pick (still picking, nothing filled)',
      afterOutside.modalHidden === true && afterOutside.val === '', JSON.stringify(afterOutside));

    // [3] Clicking a value INSIDE the copy picks it, relative to the card.
    console.log('\n[3] Inside the copy picks a value, relative to the card');
    const sub = await cloneCentre('.card-subtitle');
    await guestClickXY(sub.x, sub.y);
    await sleep(500);
    const afterInside = await R(() => ({
      modalBack: !document.getElementById('modal').classList.contains('hidden'),
      dialogGone: ![...document.querySelectorAll('*')].some((n) => n.style && n.style.zIndex === '2147483640'),
      val: (document.querySelector('#modal-body .field-list .sel-input') || {}).value || ''
    }));
    check('the editor returned after picking', afterInside.modalBack === true, JSON.stringify(afterInside));
    check('the dialog closed after the pick', afterInside.dialogGone === true, JSON.stringify(afterInside));
    const resolvesInRealCard = await G(`(() => {
      try { const sel=${JSON.stringify(afterInside.val)}; const card=document.querySelector('.wrapper-box'); const el=card.querySelector(sel); return !!el && card.contains(el); } catch(e){ return false; }
    })()`);
    check('the selector is relative to the card and resolves on the REAL page',
      resolvesInRealCard && !/wrapper-box/.test(afterInside.val) && afterInside.val.trim() !== '', afterInside.val);
    await R(() => document.getElementById('modal-cancel').click());
    await sleep(150);

    // [4] A NORMAL grab-a-value pick (no container) opens NO dialog — page-wide.
    console.log('\n[4] A normal grab-a-value pick stays page-wide (no dialog)');
    await R(() => {
      const st = { ...BLANK.get(), name: 'x' };
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
    });
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(300);
    const noDlg = await dialogState();
    check('no dialog for an unscoped pick', noDlg.open === false, JSON.stringify(noDlg));
    const c = await G(`(() => { const el=document.querySelector('#page-heading'); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => { const el=document.elementFromPoint(${c.x},${c.y}); el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${c.x},clientY:${c.y}})); })()`);
    await sleep(120);
    check('the whole page is pickable (the heading highlights)', await highlightOn(), '');
    await G(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(200);

    // [5] A very WIDE item is scaled DOWN to fit — no horizontal scroll.
    console.log('\n[5] A very wide item is scaled to fit (no horizontal scroll)');
    await R(() => {
      const st = { ...BLANK.scrapeList(), rowSelector: '#wide-item' };
      st.fields = [{ name: '', selector: '', extract: 'text', attr: '' }];
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
    });
    await sleep(200);
    await R(() => document.querySelector('#modal-body .field-list .mini-pick').click());
    await sleep(300);
    const wideFit = await fitState();
    check('the wide item is opened in a dialog', wideFit.open === true, JSON.stringify(wideFit));
    check('…that still fits on screen (scaled down, no horizontal scroll)',
      wideFit.dialogInView === true && wideFit.noInnerScroll === true, JSON.stringify(wideFit));
    check('…at a bounded size (≤ ~65% width)', wideFit.wPct <= 66, JSON.stringify(wideFit));
    // And a value inside it is still pickable → a relative selector.
    const wn = await cloneCentre('.w-price');
    await guestClickXY(wn.x, wn.y);
    await sleep(400);
    const wideSel = await R(() => (document.querySelector('#modal-body .field-list .sel-input') || {}).value || '');
    check('picking inside the scaled copy still returns a relative selector', /w-price/.test(wideSel), wideSel);
    await R(() => document.getElementById('modal-cancel').click());
    await sleep(150);

    // [6] The copy's width is capped at the card width (not a broad inner image),
    // and the dialog is resizable — dragging it bigger scales the card up.
    console.log('\n[6] Width-capped copy + resizable dialog (card grows to fill)');
    await R(() => {
      const st = { ...BLANK.scrapeList(), rowSelector: '#broad-card' };
      st.fields = [{ name: '', selector: '', extract: 'text', attr: '' }];
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
    });
    await sleep(200);
    await R(() => document.querySelector('#modal-body .field-list .mini-pick').click());
    await sleep(300);
    const bcFit = await fitState();
    check('broad-image card fits with no scrolling', bcFit.dialogInView === true && bcFit.noInnerScroll === true, JSON.stringify(bcFit));
    const cloneW = await G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='${'2147483640'}');
      const el = bd && bd.querySelector('#broad-card');
      return el ? Math.round(el.offsetWidth) : -1;
    })()`);
    check('the copy is capped at the card width (~220), NOT the 1200px image', cloneW > 0 && cloneW <= 240, cloneW + 'px');
    const before = await scaledSize();
    await growDialog(180, 140);
    await sleep(250); // ResizeObserver → re-fit
    const after = await scaledSize();
    check('dragging the dialog bigger scales the card up to fill',
      after.w > before.w + 15 || after.h > before.h + 15, `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`);
    check('…and it still fits with no scrolling after resize', (await fitState()).noInnerScroll === true, '');
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
