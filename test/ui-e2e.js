// End-to-end UI test: launches the REAL Electron app and drives it the way a
// user would — the start-URL prompt, the element picker (used from inside a step
// editor), building/running steps, column shaping, and recording.
//
//   node test/ui-e2e.js

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

(async () => {
  const root = path.join(__dirname, '..');
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'page.html')).toString();

  // Isolate the job store in a temp userData dir so tests never touch real jobs.
  const tmpUserData = path.join(os.tmpdir(), 'scrapestudio-e2e-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmpUserData] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);

  const R = (fn, arg) => win.evaluate(fn, arg);
  const G = (code) => win.evaluate((c) => document.getElementById('view').executeJavaScript(c), code);

  async function waitUrl(match, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const u = await R(() => {
        try {
          return document.getElementById('view').getURL();
        } catch (_) {
          return '';
        }
      });
      if (u && u.includes(match)) return u;
      await sleep(200);
    }
    return null;
  }
  async function loadFixture() {
    await R((u) => {
      const i = document.getElementById('url');
      i.value = u;
      document.getElementById('go').click();
    }, fixture);
    await waitUrl('page.html');
    await sleep(600);
  }
  // Steps are added from the single "＋ Add step" directory (the old wall of
  // palette buttons is gone), so every test goes through it, like a user would.
  async function addStepViaDirectory(type) {
    await R(() => document.getElementById('add-step').click());
    await sleep(60);
    await R((t) => {
      const b = document.querySelector(`#addstep-body [data-add="${t}"]`);
      if (!b) throw new Error('no directory entry for step type: ' + t);
      b.click();
    }, type);
    await sleep(120);
  }
  async function clearSteps() {
    await R(() => {
      let b;
      while ((b = document.querySelector('.step button[title="Delete"]'))) b.click();
    });
  }
  async function guestClickAt(sel, fx, fy) {
    // Scroll it into view first: a previous run may have left the page scrolled,
    // and we click by coordinates (a real user would just scroll to it).
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width*${fx}), y:Math.round(r.top+r.height*${fy})}; })()`);
    await G(`(() => {
      const x=${c.x}, y=${c.y};
      const el = document.elementFromPoint(x,y) || document.querySelector(${JSON.stringify(sel)});
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    })()`);
  }
  const simulateGuestClick = (sel) => guestClickAt(sel, 0.5, 0.5);
  // A SCOPED pick (a column/value relative to a For-each item or grab-a-list row)
  // opens a dialog holding a COPY of the item; the value is picked by clicking it
  // inside that copy. Click by the inner selector, within the dialog backdrop.
  async function clickInScopeClone(innerSel) {
    const c = await G(`(() => {
      const bd = [...document.documentElement.children].find(n=>n.tagName==='DIV'&&n.style.position==='fixed'&&n.style.zIndex==='2147483640');
      const el = bd && bd.querySelector(${JSON.stringify(innerSel)});
      if(!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
    })()`);
    if (!c) throw new Error('scoped dialog clone missing: ' + innerSel);
    await G(`(() => { const el=document.elementFromPoint(${c.x},${c.y}); el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${c.x},clientY:${c.y}})); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:${c.x},clientY:${c.y}})); })()`);
  }
  async function waitRunDone() {
    for (let i = 0; i < 100; i++) {
      const busy = await R(() => document.getElementById('run').disabled);
      if (!busy) return;
      await sleep(150);
    }
  }
  // Append a clean-up ("Number", "Text between …") to the open editor's pipeline.
  const addCleanup = (op, a, b) =>
    R((args) => {
      [...document.querySelectorAll('#modal-body button')]
        .find((x) => /Add clean-up/.test(x.textContent)).click();
      const rows = [...document.querySelectorAll('#modal-body .tf-row')];
      const row = rows[rows.length - 1];
      const sel = row.querySelector('select');
      sel.value = args.op; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const ins = row.querySelectorAll('input');
      if (args.a != null) { ins[0].value = args.a; ins[0].dispatchEvent(new Event('input', { bubbles: true })); }
      if (args.b != null) { ins[1].value = args.b; ins[1].dispatchEvent(new Event('input', { bubbles: true })); }
    }, { op, a, b });

  try {
    console.log('WebHarvest UI end-to-end\n' + '='.repeat(50));

    // ---- launch dashboard + create a job ------------------------------
    console.log('\n[0] launch dashboard, create a job (own session)');
    const dashShown = await R(() => !document.getElementById('dashboard').classList.contains('hidden'));
    check('dashboard shows on launch', dashShown);
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'E2E Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('page.html');
    await sleep(700);
    const afterCreate = await R(() => ({
      dashHidden: document.getElementById('dashboard').classList.contains('hidden'),
      url: (() => { try { return document.getElementById('view').getURL(); } catch (_) { return ''; } })(),
      startField: document.getElementById('start-url').value
    }));
    check('creating a job opens the editor', afterCreate.dashHidden);
    check('job navigates to its start URL', /page\.html$/.test(afterCreate.url), afterCreate.url);
    check('start URL saved into the job', /page\.html$/.test(afterCreate.startField), afterCreate.startField);

    // ---- picker used from INSIDE a step editor ------------------------
    console.log('\n[1] picker from inside a step editor (editor hides, then reopens filled)');
    await clearSteps();
    await addStepViaDirectory('get');
    await sleep(150);
    await R(() => document.querySelector('#modal-body .mini-pick').click()); // click Pick
    await sleep(250);
    const mid = await R(() => ({
      modalHidden: document.getElementById('modal').classList.contains('hidden'),
      hint: !document.getElementById('pick-hint').classList.contains('hidden')
    }));
    check('editor hides so you can see the page', mid.modalHidden, null);
    check('pick hint is shown', mid.hint, null);

    await simulateGuestClick('.item .price');
    await sleep(400);
    // A single-element pick where the generalized selector matches many shows the
    // "you clicked one of N similar things" chooser. It must describe the OUTCOME
    // ("All 3 like it" / "Only the one I clicked"), not the selector. Take "all".
    const chooser = await R(() => {
      const c = document.querySelector('.choice');
      return c ? c.textContent : null;
    });
    check('the post-pick chooser explains the outcome (all of them vs just this one)',
      chooser && /All 3 like it/.test(chooser) && /Only the one I clicked/.test(chooser), chooser);
    await R(() => [...document.querySelectorAll('.choice button')].find((b) => /All \d+ like it/.test(b.textContent)).click());
    await sleep(300);
    const after = await R(() => {
      const open = !document.getElementById('modal').classList.contains('hidden');
      const sel = document.querySelector('#modal-body .sel-input');
      return { open, selector: sel ? sel.value : null };
    });
    check('editor reopens after choosing', after.open, null);
    check('"any matching" gives a generalized selector (no nth-of-type)',
      /price/.test(after.selector || '') && !/nth-of-type/.test(after.selector || ''), after.selector);
    await R(() => document.getElementById('modal-cancel').click());

    // ---- Esc cancels a pick, closes the editor, discards the step -----
    console.log('\n[2] Esc cancels the pick, discards the step, back to normal');
    await clearSteps();
    await addStepViaDirectory('get');
    await sleep(150);
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(200);
    // Esc from the host side (page doesn't have focus after clicking Pick).
    await R(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await sleep(300);
    const esc = await R(() => ({
      hintHidden: document.getElementById('pick-hint').classList.contains('hidden'),
      modalClosed: document.getElementById('modal').classList.contains('hidden'),
      steps: document.querySelectorAll('.step').length
    }));
    check('Esc hides the pick hint', esc.hintHidden, null);
    check('Esc closes the editor (normal mode)', esc.modalClosed, null);
    check('Esc discards the unsaved step', esc.steps === 0, `${esc.steps} steps`);

    // ---- scrape list + run (from start URL) ---------------------------
    console.log('\n[3] build Scrape-list and Run (run opens the start URL first)');
    await clearSteps();
    await addStepViaDirectory('scrapeList');
    await sleep(150);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
      const r0 = document.querySelectorAll('.field-row')[0];
      const ins = r0.querySelectorAll('input');
      ins[0].value = 'name'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins[1].value = '.name'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#modal-body button')].find((b) => /Add column/.test(b.textContent)).click();
      const r1 = document.querySelectorAll('.field-row')[1];
      const ins1 = r1.querySelectorAll('input');
      ins1[0].value = 'price'; ins1[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins1[1].value = '.price'; ins1[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const table = await R(() => ({
      headers: [...document.querySelectorAll('#results-table th')].map((t) => t.textContent),
      rows: [...document.querySelectorAll('#results-table tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent)
      )
    }));
    check('run produced 3 rows', table.rows.length === 3, `${table.rows.length} rows`);
    check('first row correct', table.rows[0] && table.rows[0][0] === 'Widget A' && table.rows[0][1] === '$10.00', JSON.stringify(table.rows[0]));

    // ---- column shaping -----------------------------------------------
    console.log('\n[3b] shape the CSV columns (rename + drop + reorder)');
    await R(() => document.getElementById('shape-cols').click());
    await sleep(150);
    await R(() => {
      const rows = [...document.querySelectorAll('.col-row')];
      const nameRow = rows.find((r) => r.querySelector('.src').textContent === 'name');
      const priceRow = rows.find((r) => r.querySelector('.src').textContent === 'price');
      const nameIns = nameRow.querySelectorAll('input'); // [checkbox, label]
      nameIns[1].value = 'Product'; nameIns[1].dispatchEvent(new Event('input', { bubbles: true }));
      const priceIns = priceRow.querySelectorAll('input');
      priceIns[0].checked = false; priceIns[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    await R(() => document.getElementById('cols-save').click());
    await sleep(200);
    const headers2 = await R(() => [...document.querySelectorAll('#results-table th')].map((t) => t.textContent));
    check('rename + drop applied to table', JSON.stringify(headers2) === JSON.stringify(['Product']), headers2.join(','));

    // ---- a since-removed column drops out of the persistent shape ------
    console.log('\n[3c] removing a column from the steps prunes it from the saved shape');
    // 'price' is still in columnConfig (dropped, not deleted). Remove the field
    // that produced it, then re-run: the column is no longer produced, so it must
    // fall out of columnConfig — while the rename kept for 'name' still survives.
    const beforePrune = await R(() => columnConfig.map((c) => c.key));
    check('price is still in the saved shape before the step changes', beforePrune.includes('price'), JSON.stringify(beforePrune));
    await R(() => {
      const st = steps.find((s) => s.type === 'scrapeList');
      st.fields = st.fields.filter((f) => f.name !== 'price');
      renderSteps();
    });
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const afterPrune = await R(() => ({
      keys: columnConfig.map((c) => c.key),
      nameLabel: (columnConfig.find((c) => c.key === 'name') || {}).label
    }));
    check('the removed column is pruned from the saved shape', !afterPrune.keys.includes('price'), JSON.stringify(afterPrune.keys));
    check('shaping for a surviving column is kept (name still “Product”)', afterPrune.nameLabel === 'Product', afterPrune.nameLabel);

    // ---- action steps drive real controls -----------------------------
    console.log('\n[4] action steps drive real controls');
    async function runSingle(makeStep) {
      await clearSteps();
      await R(() => document.getElementById('clear-results').click());
      await makeStep();
      await R(() => document.getElementById('run').click());
      await waitRunDone();
      await sleep(150);
    }

    await runSingle(async () => {
      await addStepViaDirectory('select');
      await sleep(120);
      await R(() => {
        const sel = document.querySelector('#modal-body .sel-input');
        sel.value = '#sel'; sel.dispatchEvent(new Event('input', { bubbles: true }));
        const by = document.querySelector('#modal-body select');
        by.value = 'value'; by.dispatchEvent(new Event('change', { bubbles: true }));
        const val = document.querySelector('#modal-body input[placeholder="the option to choose"]');
        val.value = 'blue'; val.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await R(() => document.getElementById('modal-save').click());
    });
    check('Select option set <select> to blue', (await G(`document.querySelector('#sel').value`)) === 'blue');

    await runSingle(async () => {
      await addStepViaDirectory('check');
      await sleep(120);
      await R(() => {
        const sel = document.querySelector('#modal-body .sel-input');
        sel.value = '#chk'; sel.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await R(() => document.getElementById('modal-save').click());
    });
    check('Check step ticked the checkbox', (await G(`document.querySelector('#chk').checked`)) === true);

    await runSingle(async () => {
      await addStepViaDirectory('hover');
      await sleep(120);
      await R(() => {
        const sel = document.querySelector('#modal-body .sel-input');
        sel.value = '#hoverbox'; sel.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await R(() => document.getElementById('modal-save').click());
    });
    check('Hover fired mouseenter', (await G(`document.querySelector('#hoverbox').textContent`)).includes('on'));

    await runSingle(async () => {
      await addStepViaDirectory('clickText');
      await sleep(120);
      await R(() => {
        const txt = document.querySelector('#modal-body input');
        txt.value = 'Beta'; txt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await R(() => document.getElementById('modal-save').click());
    });
    check('Click-text clicked the "Beta" item', (await G(`document.querySelector('#status').textContent`)).includes('Beta'));

    await runSingle(async () => {
      await addStepViaDirectory('type');
      await sleep(120);
      await R(() => {
        const sel = document.querySelector('#modal-body .sel-input');
        sel.value = '#q'; sel.dispatchEvent(new Event('input', { bubbles: true }));
        const val = document.querySelectorAll('#modal-body input')[1];
        val.value = 'laptop'; val.dispatchEvent(new Event('input', { bubbles: true }));
        const boxes = document.querySelectorAll('#modal-body input[type="checkbox"]');
        boxes[boxes.length - 1].click(); // press Enter after
      });
      await R(() => document.getElementById('modal-save').click());
    });
    check('Fill typed into the field', (await G(`document.querySelector('#q').value`)) === 'laptop');
    check('Press-Enter triggered the handler', (await G(`document.querySelector('#status').textContent`)).includes('entered'));

    // Framework-controlled input (the Cash Converters bug): the value must
    // survive the component's re-render instead of being cleared.
    await runSingle(async () => {
      await addStepViaDirectory('type');
      await sleep(120);
      await R(() => {
        const sel = document.querySelector('#modal-body .sel-input');
        sel.value = '#ctrl'; sel.dispatchEvent(new Event('input', { bubbles: true }));
        const val = document.querySelectorAll('#modal-body input')[1];
        val.value = 'persist-me'; val.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await R(() => document.getElementById('modal-save').click());
    });
    await sleep(500); // let the component's re-render interval try to reset it
    check('Fill persists in a framework-controlled input', (await G(`document.querySelector('#ctrl').value`)) === 'persist-me');

    // ---- recorder -----------------------------------------------------
    console.log('\n[5] recorder — drive the page, get step blocks back');
    await clearSteps();
    await loadFixture();
    await R(() => document.getElementById('record').click());
    await sleep(300);
    await G(`(() => { const q=document.querySelector('#q'); q.value='abc'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(250);
    await G(`(() => { const s=document.querySelector('#sel'); s.value='green'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(250);
    await G(`document.querySelector('#chk').click()`);
    await sleep(250);
    await G(`document.querySelector('#searchBtn').click()`);
    await sleep(300);
    await R(() => document.getElementById('record').click());
    await sleep(300);

    const recSteps = await R(() =>
      [...document.querySelectorAll('.step .kind')].map((k) => k.textContent.replace(/^[^ ]+ /, ''))
    );
    check('recording created steps', recSteps.length >= 3, JSON.stringify(recSteps));
    check('recorded a Fill field', recSteps.includes('Fill field'));
    check('recorded a Select option', recSteps.includes('Select option'));
    check('recorded a Check', recSteps.includes('Check'));
    check('recorded a Click', recSteps.some((s) => s.startsWith('Click')));

    // ---- recorder does not double-count (Enter cascade) ---------------
    console.log('\n[5b] recorder collapses the input+Enter+change cascade');
    await clearSteps();
    await loadFixture();
    await R(() => document.getElementById('record').click());
    await sleep(300);
    await G(`(() => { const q=document.querySelector('#q'); q.focus(); q.value='abc'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(150);
    // pressing Enter fires keydown AND the input's change with the same value
    await G(`(() => { const q=document.querySelector('#q'); q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); q.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(300);
    await R(() => document.getElementById('record').click());
    await sleep(300);
    const kinds = await R(() => [...document.querySelectorAll('.step .kind')].map((k) => k.textContent.replace(/^[^ ]+ /, '')));
    const fillCount = kinds.filter((k) => k === 'Fill field').length;
    check('exactly one Fill recorded (no duplicate)', fillCount === 1, JSON.stringify(kinds));

    // ---- zoom ---------------------------------------------------------
    console.log('\n[6] zoom controls (page + interface)');
    await R(() => { document.getElementById('pz-in').click(); document.getElementById('pz-in').click(); });
    await sleep(200);
    const pz = await R(() => { try { return document.getElementById('view').getZoomFactor(); } catch (_) { return null; } });
    check('page zoom increases the webview', pz && pz > 1.1, 'factor=' + pz);
    await R(() => document.getElementById('pz-reset').click());
    await sleep(150);
    const pz0 = await R(() => document.getElementById('view').getZoomFactor());
    check('page zoom resets to 100%', Math.abs(pz0 - 1) < 0.001, 'factor=' + pz0);
    await R(() => document.getElementById('uz-in').click());
    await sleep(120);
    const uzLabel = await R(() => document.getElementById('uz-reset').textContent);
    check('interface zoom control responds', uzLabel !== '100%', uzLabel);
    await R(() => document.getElementById('uz-reset').click());

    // ---- jobs dashboard persists work (auto-save) ---------------------
    console.log('\n[7] dashboard lists jobs and reopening restores them');
    // Give the current job some steps, then open the dashboard.
    await clearSteps();
    await addStepViaDirectory('scrapeList');
    await sleep(150);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await sleep(700); // let autosave flush
    await R(() => document.getElementById('show-dashboard').click());
    await sleep(500);
    const jobsList = await R(() => [...document.querySelectorAll('.job-card .jc-name')].map((n) => n.textContent));
    check('created job appears in the dashboard', jobsList.includes('E2E Job'), JSON.stringify(jobsList));

    await R(() => {
      const card = [...document.querySelectorAll('.job-card')].find(
        (c) => c.querySelector('.jc-name').textContent === 'E2E Job'
      );
      card.click();
    });
    await sleep(800);
    const reopened = await R(() => ({
      dashHidden: document.getElementById('dashboard').classList.contains('hidden'),
      steps: document.querySelectorAll('.step').length
    }));
    check('reopening the job restores its steps (auto-saved)', reopened.dashHidden && reopened.steps >= 1, `${reopened.steps} steps`);

    // ---- control flow: working values + if + nested block --------------
    console.log('\n[8] control flow — working values, if, and nested blocks');
    await clearSteps();
    // Get value: n = how many .item elements (a WORKING value — not a CSV column)
    await addStepViaDirectory('get');
    await sleep(120);
    await R(() => {
      const name = document.querySelector('#modal-body .name-input');
      name.value = 'n'; name.dispatchEvent(new Event('input', { bubbles: true }));
      const tgt = document.querySelector('#modal-body .target-select');
      tgt.value = 'var'; tgt.dispatchEvent(new Event('change', { bubbles: true }));
      const src = document.querySelector('#modal-body .src-select');
      src.value = 'count'; src.dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.item'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    // if (n is equal to 3) — built with the VISUAL condition builder (no typing operators)
    await addStepViaDirectory('if');
    await sleep(120);
    await R(() => {
      // left is a DROPDOWN of the values you've grabbed; op defaults to "is equal to"
      const left = document.querySelector('.cond-rule select');
      left.value = 'n'; left.dispatchEvent(new Event('change', { bubbles: true }));
      const right = document.querySelector('.cond-rule input');
      right.value = '3'; right.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    // into the Then block: add a Scrape list
    await R(() => document.querySelector('.add-in-block').click());
    await sleep(200);
    await R(() => {
      const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => /Grab a list/.test(x.textContent));
      b.click();
    });
    await sleep(200);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
      const r0 = document.querySelectorAll('.field-row')[0];
      const ins = r0.querySelectorAll('input');
      ins[0].value = 'name'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins[1].value = '.name'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    const nested = await R(() => ({
      total: document.querySelectorAll('.step').length,
      nestedScrape: !!document.querySelector('.blocks .step')
    }));
    check('if-block renders a nested step', nested.nestedScrape && nested.total === 3, JSON.stringify(nested));

    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const cf = await R(() => ({
      rows: document.querySelectorAll('#results-table tbody tr').length,
      log: [...document.querySelectorAll('#log div')].map((d) => d.textContent).join('\n')
    }));
    check('setVar(count) computed n = 3', /n = 3/.test(cf.log), null);
    check('if(true) ran the nested scrape (3 rows)', cf.rows === 3, `${cf.rows} rows`);

    // repeat loop runs its body N times (2 × 3 items = 6 rows)
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await addStepViaDirectory('repeat');
    await sleep(120);
    await R(() => {
      const c = document.querySelector('#modal-body input'); // repeat count
      c.value = '2'; c.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.querySelector('.add-in-block').click());
    await sleep(200);
    await R(() => {
      const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => /Grab a list/.test(x.textContent));
      b.click();
    });
    await sleep(200);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
      const r0 = document.querySelectorAll('.field-row')[0];
      const ins = r0.querySelectorAll('input');
      ins[0].value = 'name'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins[1].value = '.name'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const rep = await R(() => document.querySelectorAll('#results-table tbody tr').length);
    check('repeat 2× ran its body (6 rows)', rep === 6, `${rep} rows`);

    // ---- picking aligned columns (name + price on the same row) -------
    console.log('\n[9] Scrape list — PICK row then PICK columns (relative + aligned)');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await loadFixture();
    await addStepViaDirectory('scrapeList');
    await sleep(150);
    // ① Pick the repeating row (list mode) — click near the top of a card
    await R(() => document.querySelectorAll('#modal-body .mini-pick')[0].click());
    await sleep(250);
    await guestClickAt('#list li.item', 0.5, 0.12);
    await sleep(450);
    const rowSel = await R(() => document.querySelector('#modal-body .sel-input').value);
    check('row selector picked matches many rows', /item/.test(rowSel), rowSel);
    // ② Pick the name column (relative to the row)
    await R(() => document.querySelector('.field-row .mini-pick').click());
    await sleep(250);
    await clickInScopeClone('.name');
    await sleep(450);
    const nameSel = await R(() => document.querySelectorAll('.field-row')[0].querySelectorAll('input')[1].value);
    check('column pick is RELATIVE (not absolute)', nameSel === '.name' || (!/>/.test(nameSel) && /name/.test(nameSel)), nameSel);
    await R(() => {
      const r0 = document.querySelectorAll('.field-row')[0];
      r0.querySelectorAll('input')[0].value = 'name';
      r0.querySelectorAll('input')[0].dispatchEvent(new Event('input', { bubbles: true }));
    });
    // add a price column and pick it
    await R(() => [...document.querySelectorAll('#modal-body button')].find((b) => /Add column/.test(b.textContent)).click());
    await R(() => [...document.querySelectorAll('.field-row .mini-pick')][1].click());
    await sleep(250);
    await clickInScopeClone('.price');
    await sleep(450);
    await R(() => {
      const r1 = document.querySelectorAll('.field-row')[1];
      r1.querySelectorAll('input')[0].value = 'price';
      r1.querySelectorAll('input')[0].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const aligned = await R(() => {
      const trs = [...document.querySelectorAll('#results-table tbody tr')];
      return {
        headers: [...document.querySelectorAll('#results-table th')].map((t) => t.textContent),
        rows: trs.length,
        first: trs[0] ? [...trs[0].querySelectorAll('td')].map((td) => td.textContent) : []
      };
    });
    check('picked columns produce aligned rows', aligned.rows === 3, `${aligned.rows} rows`);
    check('name & price aligned on the same row', aligned.first[0] === 'Widget A' && aligned.first[1] === '$10.00', JSON.stringify(aligned.first));

    // ---- pad() for date-range building --------------------------------
    console.log('\n[10] pad() enables zero-padded dates for range loops');
    const padOk = await R(() => window.Expr.interpolate('{{pad(6+1,2)}}/07/2026', {}) === '07/07/2026');
    check('pad() builds zero-padded date via interpolation', padOk, null);

    // ---- expression column tags each loop iteration -------------------
    console.log('\n[11] expression column tags loop rows (the date-range pattern)');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await addStepViaDirectory('repeat');
    await sleep(120);
    await R(() => {
      const c = document.querySelector('#modal-body input');
      c.value = '2'; c.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.querySelector('.add-in-block').click());
    await sleep(200);
    await R(() => {
      const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => /Grab a list/.test(x.textContent));
      b.click();
    });
    await sleep(200);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
      const r0 = document.querySelectorAll('.field-row')[0];
      const ins = r0.querySelectorAll('input');
      ins[0].value = 'name'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins[1].value = '.name'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#modal-body button')].find((b) => /Add column/.test(b.textContent)).click();
    });
    // second column: day = expression i + 1
    await R(() => {
      const r1 = document.querySelectorAll('.field-row')[1];
      r1.querySelectorAll('input')[0].value = 'day';
      r1.querySelectorAll('input')[0].dispatchEvent(new Event('input', { bubbles: true }));
      const exSel = r1.querySelector('select');
      exSel.value = 'expr';
      exSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(100);
    await R(() => {
      const r1 = document.querySelectorAll('.field-row')[1];
      const exprInput = r1.querySelectorAll('input')[1];
      exprInput.value = 'i + 1';
      exprInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const tagged = await R(() => {
      const trs = [...document.querySelectorAll('#results-table tbody tr')];
      const headers = [...document.querySelectorAll('#results-table th')].map((t) => t.textContent);
      const di = headers.indexOf('day');
      return { rows: trs.length, days: trs.map((tr) => [...tr.querySelectorAll('td')][di].textContent) };
    });
    check('expr column tags each iteration (1,1,1,2,2,2)',
      tagged.rows === 6 && JSON.stringify(tagged.days) === JSON.stringify(['1', '1', '1', '2', '2', '2']),
      JSON.stringify(tagged));

    // ---- Get value → column, and the row commits ITSELF (no Add row) ---
    console.log('\n[12] Get value → a column; the row commits itself (no Add row step)');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    // column p = clean number of the first .price ("$10.00" → 10)
    await addStepViaDirectory('get');
    await sleep(120);
    const getDefaults = await R(() => ({
      target: document.querySelector('#modal-body .target-select').value,
      source: document.querySelector('#modal-body .src-select').value
    }));
    check('Get value defaults to a COLUMN (what people actually want)', getDefaults.target === 'column', getDefaults.target);
    await R(() => {
      const name = document.querySelector('#modal-body .name-input');
      name.value = 'p'; name.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.price'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await addCleanup('number', null, null);
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(200);
    const built = await R(() => {
      const trs = [...document.querySelectorAll('#results-table tbody tr')];
      return { rows: trs.length, first: trs[0] ? [...trs[0].querySelectorAll('td')].map((td) => td.textContent) : [] };
    });
    check('one row appears with NO Add row step', built.rows === 1, `${built.rows} rows`);
    check('clean-up turned "$10.00" into 10', built.first[0] === '10', JSON.stringify(built.first));

    // ---- For each: scoped fields + click into detail + go back --------
    console.log('\n[13] For each card → scrape name (scoped), open detail, scrape it, go back');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await loadFixture();
    // For each  li.item
    await addStepViaDirectory('forEach');
    await sleep(150);
    await R(() => {
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = 'li.item'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    // helper: add a step of a given type into the For-each body via the menu
    async function addInBlock(matchLabel) {
      await R(() => document.querySelector('.add-in-block').click());
      await sleep(200);
      await R((lbl) => {
        const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => x.textContent.includes(lbl));
        b.click();
      }, matchLabel);
      await sleep(200);
    }

    // Set column name = THIS card's .name (scoped, relative selector)
    await addInBlock('Grab one value');
    await R(() => {
      document.querySelector('#modal-body .target-select').value = 'column';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .name-input').value = 'name';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.name'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    // Click THIS card's detail link (scoped) → navigates to detail.html
    await addInBlock('Click'); // first match is "Click" (not Click text)
    await R(() => {
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = 'a.more'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    // On the detail page, scrape .detail-value into a column (scope no longer applies)
    await addInBlock('Grab one value');
    await R(() => {
      document.querySelector('#modal-body .target-select').value = 'column';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .name-input').value = 'detail';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.detail-value'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    await addInBlock('Go back'); // no Add row — one pass of the loop = one row

    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(300);
    const fe = await R(() => {
      const trs = [...document.querySelectorAll('#results-table tbody tr')];
      const headers = [...document.querySelectorAll('#results-table th')].map((t) => t.textContent);
      return { headers, rows: trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)) };
    });
    check('For each produced a row per card (auto-committed)', fe.rows.length === 3, JSON.stringify(fe.rows));
    check('scoped .name captured each card name', fe.rows.map((r) => r[0]).join(',') === 'Widget A,Widget B,Widget C', JSON.stringify(fe.rows.map((r) => r[0])));
    check('detail page value scraped after navigating in', fe.rows.every((r) => r[1] === 'DETAIL-42'), JSON.stringify(fe.rows.map((r) => r[1])));

    // ---- For each: PICK relative inside the loop, then branch on a comparison
    // between TWO elements of the SAME card (price vs was) --------------------
    console.log('\n[14] For each — Pick is relative to the item; compare two values inside one card');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await loadFixture();

    // Add a step of `typeLabel` into the block whose label is `blockLabel`.
    async function addInto(blockLabel, typeLabel) {
      await R((lbl) => {
        const block = [...document.querySelectorAll('.block')].find(
          (b) => b.querySelector('.block-label').textContent === lbl
        );
        block.querySelector(':scope > .add-in-block').click();
      }, blockLabel);
      await sleep(200);
      await R((lbl) => {
        [...document.querySelectorAll('#addstep-body .as-item')].find((x) => x.textContent.includes(lbl)).click();
      }, typeLabel);
      await sleep(220);
    }
    // For each  li.item
    await addStepViaDirectory('forEach');
    await sleep(150);
    await R(() => {
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = 'li.item'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    // price = THIS card's .price — selected with the PICKER (the regression:
    // before the fix this returned an ABSOLUTE selector and matched nothing).
    await addInto('For each', 'Grab one value');
    const banner = await R(() => {
      const b = document.querySelector('#modal-body .scope-banner');
      return b ? b.textContent : null;
    });
    check('editor tells you it is inside the For each', !!banner && /For each li\.item/.test(banner), banner);
    await R(() => {
      document.querySelector('#modal-body .name-input').value = 'price';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(250);
    await clickInScopeClone('.price');
    await sleep(450);
    const pickedInLoop = await R(() => ({
      selector: document.querySelector('#modal-body .sel-input').value,
      source: document.querySelector('#modal-body .src-select').value,
      absTicked: [...document.querySelectorAll('#modal-body .check-row')]
        .find((r) => /somewhere else/.test(r.textContent)).querySelector('input').checked
    }));
    check('PICK inside a For each returns a RELATIVE selector',
      pickedInLoop.selector === '.price', pickedInLoop.selector);
    check('picking an element auto-selects the "element text" source',
      pickedInLoop.source === 'text', pickedInLoop.source);
    check('"somewhere else on the page" stays unticked for an in-item pick', pickedInLoop.absTicked === false);
    await addCleanup('number', null, null);
    await R(() => document.getElementById('modal-save').click());

    // was = THIS card's "was" price — a WORKING value (used for the rule, not in the CSV)
    await addInto('For each', 'Grab one value');
    await R(() => {
      document.querySelector('#modal-body .name-input').value = 'was';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .target-select').value = 'var'; // working value
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.was'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await addCleanup('number', null, null);
    await R(() => document.getElementById('modal-save').click());

    // If NOT discounted (price ≥ was) → Skip item. No row for it, next card.
    await addInto('For each', 'If');
    await R(() => {
      const sels = document.querySelectorAll('.cond-rule select'); // [left, operator]
      sels[0].value = 'price'; sels[0].dispatchEvent(new Event('change', { bubbles: true }));
      sels[1].value = 'ge'; sels[1].dispatchEvent(new Event('change', { bubbles: true }));
      const right = document.querySelector('.cond-rule input');
      right.value = 'was'; right.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await addInto('Then', 'Skip item');

    // Survivors: also take the name. The row commits itself at the end of the pass.
    await addInto('For each', 'Grab one value');
    await R(() => {
      document.querySelector('#modal-body .name-input').value = 'name';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.name'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(300);
    const disc = await R(() => {
      const headers = [...document.querySelectorAll('#results-table th')].map((t) => t.textContent);
      const trs = [...document.querySelectorAll('#results-table tbody tr')];
      return {
        headers,
        rows: trs.map((tr) => Object.fromEntries(
          [...tr.querySelectorAll('td')].map((td, i) => [headers[i], td.textContent]))),
        log: [...document.querySelectorAll('#log div')].map((d) => d.textContent).join('\n')
      };
    });
    check('per-item values read THIS item (10/20/30, not the first card 3×)',
      /price = 10\b/.test(disc.log) && /price = 20\b/.test(disc.log) && /price = 30\b/.test(disc.log), null);
    check('the rule compared two elements of the SAME card (price vs was)',
      disc.rows.length === 2, `${disc.rows.length} rows (want 2: A and C)`);
    check('“Skip item” dropped the card that did not match (no half-row)',
      disc.rows.map((r) => r.name).join(',') === 'Widget A,Widget C', JSON.stringify(disc.rows));
    check('the row committed itself with BOTH columns, no Add row step',
      disc.rows.every((r) => r.name && r.price), JSON.stringify(disc.rows));
    check('the working value “was” stayed OUT of the CSV',
      !disc.headers.includes('was'), JSON.stringify(disc.headers));

    // ---- scoped pick BLOCKS outside the item; the escape hatch is opt-in ----
    // A pick inside a "For each" is scoped to the item (the page is dimmed, only
    // the item is clickable), so a click outside is rejected rather than silently
    // producing a page-wide selector. To pick something page-wide on purpose you
    // first tick "somewhere else on the page", which unscopes the pick.
    console.log('\n[15] scoped pick blocks outside the item; opt-in for page-wide');
    await addInto('For each', 'Grab one value');
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(250);
    await simulateGuestClick('#q'); // the search box — NOT inside a card → blocked
    await sleep(450);
    const blocked = await R(() => ({
      // The editor is still hidden because the pick is still active (nothing picked).
      modalHidden: document.getElementById('modal').classList.contains('hidden'),
      picking: typeof pickActive !== 'undefined' ? pickActive : null
    }));
    check('clicking outside the item does NOT complete the pick (still picking)',
      blocked.modalHidden === true && blocked.picking === true, JSON.stringify(blocked));
    // Cancel the pick (Esc in the page) — this discards the unsaved new step.
    await G(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await sleep(300);

    // Now the escape hatch: tick "somewhere else on the page" FIRST, which
    // unscopes the pick, then pick the page-level search box.
    await addInto('For each', 'Grab one value');
    await R(() => {
      const row = [...document.querySelectorAll('#modal-body .check-row')].find((r) => /somewhere else/.test(r.textContent));
      row.querySelector('input').click(); // tick → editing.abs = true → unscoped
    });
    await sleep(150);
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(250);
    await simulateGuestClick('#q'); // now page-wide → allowed
    await sleep(450);
    const outside = await R(() => ({
      selector: document.querySelector('#modal-body .sel-input').value,
      absTicked: [...document.querySelectorAll('#modal-body .check-row')]
        .find((r) => /somewhere else/.test(r.textContent)).querySelector('input').checked
    }));
    check('with "somewhere else" ticked, a page-wide pick is allowed', /#q/.test(outside.selector), JSON.stringify(outside));
    check('…and the escape-hatch box stays ticked', outside.absTicked === true, JSON.stringify(outside));
    await R(() => document.getElementById('modal-cancel').click());

    // ---- text clean-up pipeline (no regex) -----------------------------
    console.log('\n[16] clean-up pipeline — pull a value out of messy text, no regex');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await loadFixture();

    // The fixture's .messy reads: "Price: £1,024.50 (inc VAT) · SKU-8871 · Posted on 14 July 2026"
    // Column 1: price   = Text between "£" and "(" → Number   → 1024.5
    await addStepViaDirectory('get');
    await sleep(150);
    await R(() => {
      document.querySelector('#modal-body .target-select').value = 'column';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .name-input').value = 'price';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '#messy'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // add two clean-ups: Text between (£, () then Number
    await addCleanup('between', '£', '(');
    await addCleanup('number', null, null);

    // the live preview shows raw → cleaned BEFORE running anything
    await R(() => [...document.querySelectorAll('#modal-body button')].find((b) => /Test on the page/.test(b.textContent)).click());
    await sleep(500);
    const preview = await R(() => {
      const p = document.querySelector('#modal-body .tf-preview');
      return p ? p.textContent : null;
    });
    check('“Test on the page” previews raw → cleaned',
      !!preview && /£1,024\.50/.test(preview) && /you get:\s*1024\.5/.test(preview), preview);
    check('preview says the result is a number (comparable)', /a number/.test(preview || ''), null);
    await R(() => document.getElementById('modal-save').click());

    // Column 2: sku = Digits only  → "8871"
    await addStepViaDirectory('get');
    await sleep(150);
    await R(() => {
      document.querySelector('#modal-body .target-select').value = 'column';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .name-input').value = 'sku';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '#sku'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await addCleanup('digits', null, null);
    await R(() => document.getElementById('modal-save').click());

    // Column 3: posted = Text after "Posted on" → Date (day first) → "2026-07-14"
    await addStepViaDirectory('get');
    await sleep(150);
    await R(() => {
      document.querySelector('#modal-body .target-select').value = 'column';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .name-input').value = 'posted';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '#posted'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await addCleanup('after', 'Posted on', null);
    await addCleanup('dateDMY', null, null);
    await R(() => document.getElementById('modal-save').click());

    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(250);
    const cleaned = await R(() => {
      const headers = [...document.querySelectorAll('#results-table th')].map((t) => t.textContent);
      const tr = document.querySelector('#results-table tbody tr');
      const cells = tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent) : [];
      return { row: Object.fromEntries(headers.map((h, i) => [h, cells[i]])) };
    });
    check('“Text between” + “Number” → 1024.5', cleaned.row.price === '1024.5', JSON.stringify(cleaned.row));
    check('“Digits only” → 8871', cleaned.row.sku === '8871', cleaned.row.sku);
    check('“Text after” + “Date (day first)” → 2026-07-14', cleaned.row.posted === '2026-07-14', cleaned.row.posted);

    // clean-ups also work per-column in Scrape list (the 🧹 panel)
    console.log('\n[17] per-column clean-ups in Scrape list');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await addStepViaDirectory('scrapeList');
    await sleep(150);
    await R(() => {
      const rs = document.querySelector('#modal-body .sel-input');
      rs.value = 'li.item'; rs.dispatchEvent(new Event('input', { bubbles: true }));
      const r0 = document.querySelectorAll('.field-row')[0];
      const ins = r0.querySelectorAll('input');
      ins[0].value = 'price'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
      ins[1].value = '.price'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    // open the column's clean-up panel and add "Number"
    await R(() => document.querySelector('.field-row .tf-toggle').click());
    await sleep(150);
    await addCleanup('number', null, null);
    await R(() => document.getElementById('modal-save').click());
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(250);
    const listClean = await R(() => ({
      cells: [...document.querySelectorAll('#results-table tbody tr')].map((tr) => tr.querySelector('td').textContent),
      detail: document.querySelector('.step .detail').textContent
    }));
    check('per-column clean-up turned "$10.00" into 10',
      JSON.stringify(listClean.cells) === JSON.stringify(['10', '20', '30']), JSON.stringify(listClean.cells));
    check('the step list shows a column is cleaned', /🧹/.test(listClean.detail), listClean.detail);

    // ---- a run that collects nothing must say WHY ----------------------
    console.log('\n[18] an If that is false every time explains the 0-row result');
    await clearSteps();
    await R(() => document.getElementById('clear-results').click());
    await loadFixture();
    // For each item: if price >= 200 (never true — they are 10/20/30) → collect
    await addStepViaDirectory('forEach');
    await sleep(150);
    await R(() => {
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = 'li.item'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    // priceVar as a WORKING value, so nothing lands in the row before the If
    await addInto('For each', 'Grab one value');
    await R(() => {
      document.querySelector('#modal-body .name-input').value = 'priceVar';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-body .target-select').value = 'var';
      document.querySelector('#modal-body .target-select').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#modal-body .src-select').value = 'text';
      document.querySelector('#modal-body .src-select').dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.price'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await addCleanup('number', null, null);
    await R(() => document.getElementById('modal-save').click());

    await addInto('For each', 'If');
    await R(() => {
      const sels = document.querySelectorAll('.cond-rule select'); // [left, operator]
      sels[0].value = 'priceVar'; sels[0].dispatchEvent(new Event('change', { bubbles: true }));
      sels[1].value = 'ge'; sels[1].dispatchEvent(new Event('change', { bubbles: true }));
      const right = document.querySelector('.cond-rule input');
      right.value = '200'; right.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());
    await addInto('Then', 'Grab one value'); // never runs — nothing is ≥ 200
    await R(() => {
      document.querySelector('#modal-body .name-input').value = 'name';
      document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
      const sel = document.querySelector('#modal-body .sel-input');
      sel.value = '.name'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await R(() => document.getElementById('modal-save').click());

    await R(() => document.getElementById('run').click());
    await waitRunDone();
    await sleep(250);
    const why = await R(() => ({
      rows: document.querySelectorAll('#results-table tbody tr').length,
      log: [...document.querySelectorAll('#log div')].map((d) => d.textContent).join('\n')
    }));
    check('the If logs its decision with the real values', /priceVar \(10\) ≥ 200\) → no/.test(why.log), null);
    check('0 rows is explained ("If was false every time")',
      why.rows === 0 && /false every time \(3×\)/.test(why.log), `${why.rows} rows`);

    // ---- the guidance a first-timer actually needs ---------------------
    console.log('\n[19] a beginner is told what to do, and shown what they picked');
    await clearSteps();
    await loadFixture();

    // The empty step list points you at "＋ Add step" rather than being a void.
    const start = await R(() => {
      const c = document.getElementById('steps-empty');
      return {
        visible: !c.classList.contains('hidden'),
        text: c.textContent.replace(/\s+/g, ' ').trim()
      };
    });
    check('the empty step list tells you where to start',
      start.visible && /Add step/.test(start.text) && /Record/.test(start.text), start.text);

    // Adding a step goes through the "＋ Add step" directory.
    await addStepViaDirectory('scrapeList');
    await sleep(200);
    const openedList = await R(() => document.getElementById('modal-title').textContent);
    check('“A list of things” opens the Grab-a-list editor', /Grab a list/.test(openedList), openedList);

    // Pick a row → the field CONFIRMS what it found, in plain words.
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(250);
    await guestClickAt('#list li.item', 0.5, 0.12);
    await sleep(700);
    const rowStatus = await R(() => document.querySelector('#modal-body .sel-status').textContent);
    check('picking a row says how many it matched, with a sample',
      /3 rows on this page/.test(rowStatus) && /Widget A/.test(rowStatus), rowStatus);

    // The editor starts with ONE EMPTY column — not a junk "text" column that
    // silently dumps the whole row into the CSV. Pick the name into it.
    const cols0 = await R(() => [...document.querySelectorAll('.field-row')].map((r) => r.querySelectorAll('input')[0].value));
    check('no junk default column (you fill the first one in)',
      cols0.length === 1 && cols0[0] === '', JSON.stringify(cols0));

    await R(() => document.querySelector('.field-row .mini-pick').click());
    await sleep(250);
    await clickInScopeClone('.name');
    await sleep(500);
    const colName = await R(() => document.querySelector('.field-row input').value);
    check('a column pick auto-names itself too', colName === 'name', colName);

    await R(() => [...document.querySelectorAll('#modal-body button')].find((b) => /Preview the rows/.test(b.textContent)).click());
    await sleep(700);
    const pv = await R(() => {
      const box = document.querySelector('#modal-body .preview-box');
      return {
        head: box.querySelector('.pv-head') ? box.querySelector('.pv-head').textContent : '',
        headers: [...box.querySelectorAll('th')].map((th) => th.textContent),
        cells: [...box.querySelectorAll('td')].map((td) => td.textContent)
      };
    });
    check('“Preview the rows” shows the real rows BEFORE running',
      /3 rows/.test(pv.head) && pv.cells.join(',') === 'Widget A,Widget B,Widget C',
      JSON.stringify(pv));
    await R(() => document.getElementById('modal-cancel').click());

    // Grab one value: picking auto-suggests the name, so there's nothing to type.
    await clearSteps();
    await addStepViaDirectory('get');
    await sleep(200);
    await R(() => document.querySelector('#modal-body .mini-pick').click());
    await sleep(250);
    await simulateGuestClick('#list li.item .price'); // unscoped grab-a-value → real page
    await sleep(500);
    await R(() => {
      const b = [...document.querySelectorAll('.choice button')].find((x) => /All \d+ like it/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(400);
    const auto = await R(() => ({
      name: document.querySelector('#modal-body .name-input').value,
      status: document.querySelector('#modal-body .sel-status').textContent
    }));
    check('picking auto-names the column from what you clicked', auto.name === 'price', auto.name);
    check('…and confirms what it found', /3 matches on this page/.test(auto.status) && /\$10\.00/.test(auto.status), auto.status);
    await R(() => document.getElementById('modal-save').click());

    // An If can't point at a value that doesn't exist — you PICK the value from
    // a dropdown of what you've actually grabbed. (A typo'd name is silently
    // false forever, which is the worst failure mode in the app.)
    await addStepViaDirectory('if');
    await sleep(200);
    const cond = await R(() => {
      const left = document.querySelector('.cond-rule select');
      return {
        isDropdown: left.tagName === 'SELECT',
        options: [...left.options].map((o) => o.value),
        matchHidden: document.querySelector('#modal-body .field').style.display === 'none'
      };
    });
    check('the If rule picks its value from a dropdown (no typing a name)', cond.isDropdown);
    check('…listing the values you actually grabbed', cond.options.includes('price'), JSON.stringify(cond.options));
    check('ALL/ANY is hidden until there are 2+ rules', cond.matchHidden);
    await R(() => document.getElementById('modal-cancel').click());

    // With nothing grabbed yet, the If tells you to go grab something first.
    await clearSteps();
    await addStepViaDirectory('if');
    await sleep(200);
    const noVals = await R(() => {
      const w = document.querySelector('#modal-body .warn-box');
      return w ? w.textContent : null;
    });
    check('an If with nothing to test says so, and what to do',
      !!noVals && /Grab one value/.test(noVals), noVals);
    await R(() => document.getElementById('modal-cancel').click());
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
