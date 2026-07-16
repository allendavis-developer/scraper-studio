// Grabbing an attribute is now CODELESS: instead of typing an attribute name,
// the editor shows the element's real attributes as a clickable list, each with
// the value it would grab. Drives the real app.
//
//   node test/attr-picker-e2e.js

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
  const tmp = path.join(os.tmpdir(), 'scrapestudio-attr-' + Date.now());
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
  const readOpts = () => R(() => [...document.querySelectorAll('#modal-body .attr-list .attr-opt')].map((b) => ({
    name: b.querySelector('.attr-name').textContent,
    val: b.querySelector('.attr-val').textContent,
    active: b.classList.contains('active')
  })));

  try {
    console.log('Codeless attribute picker\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Attr';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('filter.html');
    await sleep(700);

    // A "Grab one value" reading an ATTRIBUTE off the first .item (class="item"
    // data-cat="console"). Open the editor with source already = attr.
    console.log('\n[1] The editor lists the element’s real attributes + values');
    await R(() => {
      const st = { type: 'get', name: 'cat', target: 'column', source: 'attr', selector: '.item', attr: '', transforms: [] };
      steps.length = 0; steps.push(st); reidList(steps); renderSteps();
      openStepEditor(steps[0], steps, false);
    });
    await sleep(600); // let refreshAttrList read the page

    const opts = await readOpts();
    check('the attribute list is populated (not a blank text box)', opts.length >= 2, JSON.stringify(opts));
    const dataCat = opts.find((o) => o.name === 'data-cat');
    const cls = opts.find((o) => o.name === 'class');
    check('shows the data-cat attribute with its real value “console”', dataCat && /console/.test(dataCat.val), JSON.stringify(dataCat));
    check('shows the class attribute with its value “item”', cls && /item/.test(cls.val), JSON.stringify(cls));

    // [2] Clicking an attribute selects it (no typing) and previews the value.
    console.log('\n[2] Clicking an attribute selects it + previews the value');
    await R(() => {
      const b = [...document.querySelectorAll('#modal-body .attr-list .attr-opt')].find((x) => x.dataset.attr === 'data-cat');
      b.click();
    });
    await sleep(400);
    const after = await R(() => ({
      attr: (typeof editing !== 'undefined' && editing) ? editing.attr : null,
      live: (document.querySelector('#modal-body .get-live') || {}).textContent || '',
      activeName: (() => { const a = document.querySelector('#modal-body .attr-list .attr-opt.active'); return a ? a.dataset.attr : null; })()
    }));
    check('clicking sets the chosen attribute (no typing)', after.attr === 'data-cat', JSON.stringify(after.attr));
    check('the chosen attribute is highlighted', after.activeName === 'data-cat', JSON.stringify(after.activeName));
    check('the live preview shows the value it would grab (console)', /console/.test(after.live), JSON.stringify(after.live));
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
