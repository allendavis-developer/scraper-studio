// Widen-to-parent: a card whose children fill it can't be hovered directly, so
// ↑ walks the highlight out to the whole card (and ↓ back in). Proves you can
// grab the .wrapper-box and then pull columns from BOTH sections in one list.
// Drives the real Electron app + picker.
//
//   node test/widen-pick-e2e.js

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
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'cards.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-widen-' + Date.now());
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
  // Move the cursor to an element's centre (highlights it in the picker).
  async function guestHover(sel) {
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => { const el=document.elementFromPoint(${c.x},${c.y}); el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${c.x},clientY:${c.y}})); })()`);
    return c;
  }
  // Read the overlay's current size + label.
  async function overlayState() {
    return G(`(() => {
      const ov = [...document.documentElement.children].find(n => n.tagName==='DIV' && n.style.position==='fixed' && n.style.zIndex==='2147483646');
      const lb = [...document.documentElement.children].find(n => n.tagName==='DIV' && n.style.position==='fixed' && n.style.zIndex==='2147483647');
      return { w: ov?Math.round(parseFloat(ov.style.width)):0, h: ov?Math.round(parseFloat(ov.style.height)):0, label: lb?lb.textContent:'' };
    })()`);
  }
  // Press an arrow key the way a real user does DURING a pick: keyboard focus is
  // on the HOST window (not the webview), so the host forwards it to the guest.
  // Dispatching on the host window exercises that real forwarding path (a guest-
  // only dispatch would hide the focus bug this very test caught).
  async function hostKey(key) {
    await R((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), key);
  }

  try {
    console.log('Widen-to-parent picking (grab a whole card)\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Cards';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('cards.html');
    await sleep(700);

    // Grab a list → Pick the row (list mode).
    console.log('\n[1] Hover a section, then ↑ to widen to the whole card');
    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="scrapeList"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(250);

    // Hover the .content section — the highlight starts on the section.
    await guestHover('.wrapper-box:nth-of-type(1) .content');
    await sleep(120);
    const start = await overlayState();
    const dims = await G(`(() => { const c=document.querySelector('.wrapper-box:nth-of-type(1) .content').getBoundingClientRect(); const w=document.querySelector('.wrapper-box:nth-of-type(1)').getBoundingClientRect(); return {contentH:Math.round(c.height), cardH:Math.round(w.height), cardW:Math.round(w.width)}; })()`);
    check('starts on the inner section (.content), not the card',
      Math.abs(start.h - dims.contentH) <= 2 && start.h < dims.cardH, `overlay ${start.h} vs content ${dims.contentH} / card ${dims.cardH}`);

    // Press ↑ once: thumbnail+content → .content's parent is .wrapper-box already?
    // .content's parent IS .wrapper-box, so one ↑ reaches the whole card.
    await hostKey('ArrowUp');
    await sleep(120);
    const widened = await overlayState();
    check('after ↑ the highlight is the whole card (.wrapper-box)',
      widened.h === dims.cardH && widened.w === dims.cardW, `overlay ${widened.w}×${widened.h} vs card ${dims.cardW}×${dims.cardH}`);
    check('…and the label names the box', /wrapper-box/.test(widened.label), widened.label);

    // ↓ walks back in to the section.
    await hostKey('ArrowDown');
    await sleep(120);
    const back = await overlayState();
    check('↓ walks back in to the section', Math.abs(back.h - dims.contentH) <= 2, `overlay ${back.h} vs content ${dims.contentH}`);

    // RESET the widen level deterministically: hover a different element first
    // (the heading), then back to .content — moving to a new base element
    // restarts widening at 0. Then ↑ once → whole card, and click.
    console.log('\n[2] Clicking the widened card picks every card');
    await guestHover('#page-heading');
    await sleep(60);
    await guestHover('.wrapper-box:nth-of-type(1) .content');
    await sleep(120);
    await hostKey('ArrowUp');
    await sleep(120);
    const upd = await overlayState();
    check('re-hover + ↑ lands on the whole card again', upd.h === dims.cardH, `overlay ${upd.h} vs card ${dims.cardH}`);
    const c = await G(`(() => { const el=document.querySelector('.wrapper-box:nth-of-type(1) .content'); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => { const el=document.elementFromPoint(${c.x},${c.y}); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:${c.x},clientY:${c.y}})); })()`);
    await sleep(500);
    const hadChooser = await R(() => !!document.querySelector('.choice'));
    if (hadChooser) { await R(() => document.querySelector('.choice button.primary, .choice button').click()); await sleep(400); }
    await sleep(300);
    const sel = await R(() => (document.querySelector('#modal-body .sel-input') || {}).value || '');
    check('the row selector is the card container', /wrapper-box/.test(sel), sel);
    const count = await G(`(() => { try { return document.querySelectorAll(${JSON.stringify(sel)}).length; } catch(e){ return -1; } })()`);
    check('…and it matches all 3 cards', count === 3, `${count} match "${sel}"`);

    // [3] BOTH sections are now reachable as columns (relative to the card):
    //     `warranty` comes from the .thumbnail section, title/price from .content.
    console.log('\n[3] Columns from BOTH sections land on one row');
    await R((rowSel) => {
      steps.length = 0;
      steps.push({
        type: 'scrapeList', rowSelector: rowSel, waitFirst: false, keep: 'rows', dataset: '',
        fields: [
          { name: 'warranty', selector: '.cx-warranty-badge', extract: 'text', attr: '' }, // thumbnail section
          { name: 'title', selector: '.card-title', extract: 'text', attr: '' },            // content section
          { name: 'price', selector: '.product-main-price', extract: 'text', attr: '' }      // content section
        ]
      });
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
      return null;
    }, sel);
    for (let i = 0; i < 120; i++) { if (!(await R(() => document.getElementById('run').disabled))) break; await sleep(150); }
    const out = await R(() => JSON.parse(JSON.stringify(results)));
    check('3 cards → 3 rows', out.length === 3, JSON.stringify(out.map((r) => r.title)));
    check('…each row pairs the thumbnail section (warranty) WITH the content (title, price)',
      out[0] && out[0].warranty === '5 Year Warranty' && out[0].title === 'Super Mario Sunshine' && out[0].price === '£20.00',
      JSON.stringify(out[0]));
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
