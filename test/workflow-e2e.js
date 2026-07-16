// End-to-end tests for the "workflow upgrade": Tasks (groups), Try / Recover,
// cross-list drag guards, the reusable task library, and the Map view. Drives
// the REAL Electron app the way the other e2e suites do.
//
//   node test/workflow-e2e.js

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
  const tmpUserData = path.join(os.tmpdir(), 'scrapestudio-wf-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmpUserData] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);

  const R = (fn, arg) => win.evaluate(fn, arg);

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
  async function waitRunDone() {
    for (let i = 0; i < 120; i++) {
      const busy = await R(() => document.getElementById('run').disabled);
      if (!busy) return;
      await sleep(150);
    }
  }
  // Replace the whole program with a given step tree (ids assigned by the app's
  // own reidList, so blocks get their child arrays too).
  const setSteps = (arr) =>
    R((a) => {
      steps.length = 0;
      for (const s of reidList(a)) steps.push(s);
      renderSteps();
    }, arr);
  const clearResults = () =>
    R(() => {
      results.length = 0;
      columns.length = 0;
      columnConfig.length = 0;
      renderResults();
    });
  const getResults = () => R(() => JSON.parse(JSON.stringify(results)));
  const logText = () => R(() => document.getElementById('log').textContent);
  async function runNow() {
    await clearResults();
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    return getResults();
  }

  try {
    console.log('Scrape Studio — workflow upgrade e2e\n' + '='.repeat(50));

    // Create a job pointed at the fixture.
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'WF Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('page.html');
    await sleep(600);

    // ---- [1] Task (group) is transparent: values collected inside it commit
    console.log('\n[1] Task (group) — renders as a folder and runs pass-through');
    await setSteps([
      {
        type: 'group', name: 'Extract', emoji: '📦', collapsed: false,
        body: [{ type: 'get', name: 'title', target: 'column', source: 'text', selector: '.item .name', attr: '', expr: '', transforms: [] }]
      }
    ]);
    const grpDom = await R(() => ({
      isFolder: !!document.querySelector('.group-step'),
      name: (document.querySelector('.grp-name') || {}).textContent,
      bodyShown: !!document.querySelector('.grp-body')
    }));
    check('a Task renders as a collapsible folder', grpDom.isFolder && grpDom.name === 'Extract', grpDom.name);
    check('an expanded Task shows its body', grpDom.bodyShown);
    const r1 = await runNow();
    check('a Grab-value INSIDE a Task still produces its column', r1.length === 1 && r1[0].title === 'Widget A', JSON.stringify(r1));

    // ---- [2] collapse / expand
    console.log('\n[2] Task collapses and expands');
    await R(() => document.querySelector('.grp-row').click());
    const collapsed = await R(() => !document.querySelector('.grp-body') && document.querySelector('.grp-chevron').textContent === '▸');
    check('clicking the header collapses the Task', collapsed);
    await R(() => document.querySelector('.grp-row').click());
    const expanded = await R(() => !!document.querySelector('.grp-body'));
    check('clicking again expands it', expanded);

    // ---- [3] Try / Recover — a failing step diverts to the recovery block
    console.log('\n[3] Try / Recover — failure runs the recovery steps');
    await setSteps([
      {
        type: 'try', retries: 0,
        body: [{ type: 'click', selector: '.does-not-exist-zzz' }],
        onError: [{ type: 'get', name: 'recovered', target: 'column', source: 'expr', expr: '1', selector: '', attr: '', transforms: [] }]
      }
    ]);
    const r3 = await runNow();
    check('when a Try step fails, the recovery block runs', r3.length === 1 && r3[0].recovered === 1, JSON.stringify(r3));

    // ---- [3b] Try success path — recovery is NOT run
    console.log('\n[3b] Try / Recover — success skips the recovery steps');
    await setSteps([
      {
        type: 'try', retries: 0,
        body: [{ type: 'get', name: 'title', target: 'column', source: 'text', selector: '.item .name', attr: '', expr: '', transforms: [] }],
        onError: [{ type: 'get', name: 'recovered', target: 'column', source: 'expr', expr: '1', selector: '', attr: '', transforms: [] }]
      }
    ]);
    const r3b = await runNow();
    check('a successful Try commits its own values and skips recovery',
      r3b.length === 1 && r3b[0].title === 'Widget A' && r3b[0].recovered === undefined, JSON.stringify(r3b));

    // ---- [3c] retries are attempted before recovering
    console.log('\n[3c] Try / Recover — retries the risky steps first');
    await setSteps([
      {
        type: 'try', retries: 2,
        body: [{ type: 'click', selector: '.nope-xyz' }],
        onError: [{ type: 'get', name: 'recovered', target: 'column', source: 'expr', expr: '1', selector: '', attr: '', transforms: [] }]
      }
    ]);
    const r3c = await runNow();
    const lg = await logText();
    check('it still recovers after exhausting retries', r3c.length === 1 && r3c[0].recovered === 1, JSON.stringify(r3c));
    check('the run log shows the retry attempts', /retrying/i.test(lg));

    // ---- [4] cross-list drag guards against cycles
    console.log('\n[4] cross-list drag — cannot drop a block into its own body');
    const guard = await R(() => {
      const g = { type: 'group', body: [] };
      dragStep = g;
      dragList = steps;
      const intoOwnBody = canDropInto(g.body); // illegal (cycle)
      const intoRoot = canDropInto(steps); // legal
      dragStep = null;
      dragList = null;
      return { intoOwnBody, intoRoot, inside: listInsideStep(g, g.body) };
    });
    check('a Task cannot be dropped inside itself', guard.intoOwnBody === false && guard.inside === true);
    check('a step can be dropped into another list', guard.intoRoot === true);

    // ---- [5] Map view renders the program as a flowchart
    console.log('\n[5] Map view — editable canvas: nodes, drill-down, wire, edit, delete');
    await setSteps([
      { type: 'get', name: 'price', target: 'var', source: 'text', selector: '.item .price', attr: '', expr: '', transforms: [{ op: 'number' }] },
      {
        type: 'if', condition: { match: 'all', rules: [{ left: 'price', op: 'gt', right: '10' }] },
        then: [{ type: 'get', name: 'title', target: 'column', source: 'text', selector: '.item .name', attr: '', expr: '', transforms: [] }],
        else: []
      }
    ]);
    await R(() => openMap());
    await sleep(150);
    const map = await R(() => ({
      open: !document.getElementById('map-modal').classList.contains('hidden'),
      nodes: document.querySelectorAll('.mnode:not(.mstart)').length, // top-level only (blocks not expanded)
      topLevel: steps.length,
      hasData: !!document.querySelector('.mnode.cat-data'),
      hasControl: !!document.querySelector('.mnode.cat-control'),
      crumbs: document.querySelectorAll('#map-crumbs .crumb').length
    }));
    check('the map opens on the top-level graph', map.open && map.crumbs === 1);
    check('it draws one node per top-level step (blocks are drilled into)', map.nodes === map.topLevel, `${map.nodes}/${map.topLevel}`);
    check('nodes are colour-coded by category', map.hasData && map.hasControl);

    // data-flow overlay: price (produced by Get) → the If condition (consumer)
    await R(() => {
      document.getElementById('map-dataflow').checked = true;
      document.getElementById('map-dataflow').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(100);
    const links = await R(() => document.querySelectorAll('.mdlink').length);
    check('data-flow overlay links producer → consumer', links >= 1, `${links} link(s)`);

    // wire Start → the If node ⇒ the If becomes the first step (reorder via wire)
    const reordered = await R(() => {
      const startNode = mapModel.nodes.find((n) => n.start);
      const ifNode = mapModel.nodes.find((n) => n.step && n.step.type === 'if');
      mapReorder(startNode, ifNode.step.id);
      return steps[0].type;
    });
    check('wiring Start → a node reorders it to the front', reordered === 'if', reordered);

    // drill into the If (double-click) → its Then/Else become the graph
    await R(() => {
      const ifNode = mapModel.nodes.find((n) => n.step && n.step.type === 'if');
      onNodeActivate(ifNode);
    });
    await sleep(80);
    const drill = await R(() => ({
      crumbs: document.querySelectorAll('#map-crumbs .crumb').length,
      nodes: document.querySelectorAll('.mnode:not(.mstart)').length // Then has 1, Else 0
    }));
    check('double-clicking a block drills into its graph (breadcrumb grows)', drill.crumbs === 2, `${drill.crumbs} crumbs`);
    check('the block graph shows its child steps', drill.nodes === 1, `${drill.nodes} node(s)`);

    // add a node to the current (Then) graph via the palette menu
    await R(() => { const sec = currentFrame().sections[0]; mapAddNode(sec.list, 100, 200); });
    await sleep(60);
    await R(() => {
      const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => /Delay/.test(x.textContent));
      b.click();
    });
    await sleep(120);
    // Delay has an editor; save it
    await R(() => document.getElementById('modal-save').click());
    await sleep(80);
    const added = await R(() => ({
      thenLen: mapStack[mapStack.length - 1].sections[0].list.length,
      hasWait: mapStack[mapStack.length - 1].sections[0].list.some((s) => s.type === 'wait')
    }));
    check('＋ Node adds a step to the current graph', added.thenLen === 2 && added.hasWait, JSON.stringify(added));

    // double-click a leaf node → opens its editor
    await R(() => {
      const leaf = mapModel.nodes.find((n) => n.step && n.step.type === 'get');
      onNodeActivate(leaf);
    });
    await sleep(100);
    const edit = await R(() => !document.getElementById('modal').classList.contains('hidden'));
    check('double-clicking a leaf node opens its editor', edit);
    await R(() => document.getElementById('modal-cancel').click());

    // delete a node from the canvas
    const del = await R(() => {
      const before = mapStack[mapStack.length - 1].sections[0].list.length;
      const leaf = mapModel.nodes.find((n) => n.step && n.step.type === 'wait');
      mapDeleteNode(leaf);
      return { before, after: mapStack[mapStack.length - 1].sections[0].list.length };
    });
    check('deleting a node removes it from the graph', del.after === del.before - 1, `${del.before}→${del.after}`);
    await R(() => closeMap());

    // ---- [6] reusable task library: save then insert
    console.log('\n[6] task library — save a Task, insert it into any job');
    await setSteps([
      {
        type: 'group', name: 'Login', emoji: '🔐', collapsed: false,
        body: [{ type: 'type', selector: '#q', text: 'hello', clear: true, pressEnter: false }]
      }
    ]);
    await R(async () => {
      await saveTaskToLibrary(steps[0]);
    });
    const lib = await R(async () => await window.harvest.tasks.list());
    check('saving adds the Task to the library', lib.length === 1 && lib[0].name === 'Login', JSON.stringify(lib.map((t) => t.name)));
    await R((rec) => insertTaskInto(steps, rec), lib[0]);
    const afterInsert = await R(() => ({
      count: steps.length,
      groups: steps.filter((s) => s.type === 'group').map((s) => s.name)
    }));
    check('inserting from the library adds a fresh copy', afterInsert.count === 2 && afterInsert.groups.filter((n) => n === 'Login').length === 2, JSON.stringify(afterInsert.groups));
    check('the inserted copy has fresh, unique ids', await R(() => {
      const ids = [];
      const walk = (l) => { for (const s of l) { ids.push(s.id); for (const k of ['then', 'else', 'body', 'onError']) if (Array.isArray(s[k])) walk(s[k]); } };
      walk(steps);
      return new Set(ids).size === ids.length;
    }));

    // ---- [7] per-job sign-in: detection + gating + forget + banner
    console.log('\n[7] per-job sign-in — detect sign-outs, gate the run, forget');
    // A "signed-in marker" that IS on the page ⇒ logged in.
    await R(() => { jobAuthCfg = { loginUrl: '', check: '#list' }; });
    const a1 = await R(async () => await detectAuth());
    check('a present “signed-in” marker means we are logged in', a1.loggedIn && a1.byMarker);
    // A marker that is NOT on the page ⇒ signed out, and that gates the run.
    await R(() => { jobAuthCfg = { loginUrl: '', check: '#definitely-not-here-xyz' }; });
    const a2 = await R(async () => { const st = await detectAuth(); return { loggedIn: st.loggedIn, gate: authShouldGate(st) }; });
    check('a missing marker means signed out, and gates the run', !a2.loggedIn && a2.gate, JSON.stringify(a2));
    // With no marker configured, the fixture (no login redirect) reads as logged in.
    await R(() => { jobAuthCfg = { loginUrl: '', check: '' }; });
    const a3 = await R(async () => await detectAuth());
    check('with no marker set, a normal page is treated as logged in', a3.loggedIn);
    // The sign-out banner shows and hides.
    await R(() => showAuthBanner({ url: 'https://example.com/login', reason: 'test' }));
    const shown = await R(() => !document.getElementById('auth-banner').classList.contains('hidden'));
    await R(() => hideAuthBanner());
    const hidden = await R(() => document.getElementById('auth-banner').classList.contains('hidden'));
    check('the re-login banner can be shown and dismissed', shown && hidden);
    // Forgetting a sign-in clears the job's session partition.
    const cleared = await R(async () => (currentJob ? await window.harvest.auth.clear('persist:' + currentJob.id) : false));
    check('a job can forget its sign-in (clears the session partition)', cleared === true);
    // auth config round-trips through save/load.
    const roundTrip = await R(async () => {
      jobAuthCfg = { loginUrl: 'https://x.com/login', check: '.acct' };
      const saved = collectJob();
      return saved.auth && saved.auth.loginUrl === 'https://x.com/login' && saved.auth.check === '.acct';
    });
    check('sign-in settings are saved with the job', roundTrip);
    await R(() => { jobAuthCfg = { loginUrl: '', check: '' }; });

    // ---- [8] Map ↔ Pick: picking from a node editor must reveal the page
    console.log('\n[8] Map + Pick — the Map steps aside so you can point at the page');
    await setSteps([]);
    await R(() => openMap());
    await sleep(80);
    // Add a "Grab a list" node → its editor opens ON TOP of the Map.
    await R(() => { const sec = currentFrame().sections[0]; mapAddNode(sec.list, 100, 60); });
    await sleep(60);
    await R(() => {
      const b = [...document.querySelectorAll('#addstep-body .as-item')].find((x) => /Grab a list/.test(x.textContent));
      b.click();
    });
    await sleep(150);
    const overMap = await R(() => ({
      editor: !document.getElementById('modal').classList.contains('hidden'),
      map: !document.getElementById('map-modal').classList.contains('hidden')
    }));
    check('the node editor opens on top of the Map', overMap.editor && overMap.map);
    // Press Pick inside the editor → BOTH the editor and the Map must hide so the
    // page is clickable, and the pick hint shows.
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(80);
    const picking = await R(() => ({
      editorHidden: document.getElementById('modal').classList.contains('hidden'),
      mapHidden: document.getElementById('map-modal').classList.contains('hidden'),
      hint: !document.getElementById('pick-hint').classList.contains('hidden')
    }));
    check('pressing Pick hides BOTH the editor and the Map (page is visible)',
      picking.editorHidden && picking.mapHidden && picking.hint, JSON.stringify(picking));
    // Cancel the pick → the Map comes back (the unsaved new node is discarded).
    await R(() => cancelPick());
    await sleep(80);
    const afterCancel = await R(() => ({
      mapBack: !document.getElementById('map-modal').classList.contains('hidden'),
      editorGone: document.getElementById('modal').classList.contains('hidden'),
      hintGone: document.getElementById('pick-hint').classList.contains('hidden')
    }));
    check('cancelling the pick restores the Map and closes the editor',
      afterCancel.mapBack && afterCancel.editorGone && afterCancel.hintGone, JSON.stringify(afterCancel));
    await R(() => closeMap());
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
