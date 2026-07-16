// Auto-save + Export/Import (.job) — end to end against the real app.
//   • auto-save: edits persist to the job store, survive a reopen
//   • export: writes a portable .job file (JSON) with the whole scrape
//   • import: round-trips every step kind back, identical
//
//   node test/job-io-e2e.js

const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A job that exercises many step kinds — grabs, formula, spread, date loop,
// filtered for-each, control flow, actions — so import/export fidelity is real.
const STEPS = [
  { type: 'goto', url: 'https://example.com/{{i}}' },
  { type: 'forDates', from: '2026-07-01', to: '2026-07-03', stepDays: 1, var: 'date', format: 'YYYY-MM-DD', asColumn: true, maxIter: 1000, body: [
    { type: 'scrapeTable', rowSelector: 'table tbody tr', skipTotals: true, keep: 'dataset', dataset: 'byUser', waitFirst: true,
      fields: [
        { name: 'user', label: 'User', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] },
        { name: 'total', label: 'Total', selector: 'td:nth-child(2)', extract: 'text', include: true, transforms: [{ op: 'number' }] }
      ] },
    { type: 'spread', dataset: 'byUser', keyCol: 'user', valCols: ['total'], namePattern: 'Sales ({})' },
    { type: 'formula', name: 'cerys', target: 'column', formula: { kind: 'lookup', dataset: 'byUser', keyCol: 'user', keyVal: 'Cerys', valCol: 'total' } }
  ] },
  { type: 'forEach', selector: '.card', filter: { match: 'all', rules: [{ test: 'text', op: 'contains', value: 'Xbox' }] }, indexVar: 'i', maxIter: 500, body: [
    { type: 'get', name: 'title', target: 'column', source: 'text', selector: '.name', attr: '', transforms: [], waitFirst: true },
    { type: 'if', condition: { match: 'all', rules: [{ left: 'title', op: 'nempty', right: '' }] }, then: [{ type: 'refresh' }], else: [] }
  ] },
  { type: 'get', name: 'saved', target: 'var', source: 'textExists', selector: '', attr: '', transforms: [], textExists: { text: 'Saved', mode: 'contains', container: '#msg' } }
];

(async () => {
  const root = path.join(__dirname, '..');
  const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'filter.html')).toString();
  const userDir = path.join(os.tmpdir(), 'scrapestudio-jobio-' + Date.now());
  const jobFile = path.join(os.tmpdir(), 'exported-' + Date.now() + '.job');
  const app = await electron.launch({ args: [root, '--user-data-dir=' + userDir] });
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

  try {
    console.log('Auto-save + Export/Import (.job)\n' + '='.repeat(50));

    // Make a job and load a program into it.
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'IO Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, fixture);
    await waitUrl('filter.html');
    await sleep(500);

    const jobId = await R((payload) => {
      steps.length = 0;
      for (const st of payload) steps.push(st);
      reidList(steps);
      renderSteps();
      markDirty();
      return currentJob.id;
    }, STEPS);

    // ---- [1] Auto-save: the edit persists to the store and reopens intact. ---
    console.log('\n[1] Auto-save persists edits across a reopen');
    await sleep(900); // let the 500ms debounce fire
    const stored = await R(async (id) => {
      const j = await window.harvest.jobs.load(id);
      return { steps: j ? countSteps(j.steps) : -1, startUrl: j && j.startUrl, hasAuth: !!(j && j.auth) };
    }, jobId);
    check('auto-save wrote the job to the store', stored.steps > 0, JSON.stringify(stored));

    const total = await R(() => countSteps(steps));
    // Reopen from the store (simulates closing/reopening the app) and compare.
    await R(async (id) => { await openJob(id); }, jobId);
    await sleep(400);
    const reopened = await R(() => countSteps(steps));
    check('reopening the job restores every step', reopened === total, `${reopened} vs ${total}`);

    // ---- [2] Export writes a real .job file with the whole scrape. -----------
    console.log('\n[2] Export writes a .job file');
    // Stub the native dialogs so the export/import run headless to our temp path.
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, jobFile);

    await R(() => document.getElementById('export-job').click());
    await sleep(400);
    check('the .job file exists on disk', fs.existsSync(jobFile));
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (_) {}
    check('…and it is valid JSON with the job payload',
      parsed && parsed.kind === 'scrape-studio-job' && Array.isArray(parsed.steps) && parsed.startUrl,
      parsed ? `${parsed.steps.length} top-level steps, name=${parsed.name}` : 'unparseable');
    check('…carrying the start URL and auth config', parsed && /filter\.html/.test(parsed.startUrl) && parsed.auth !== undefined);

    // ---- [3] Import round-trips every step kind back identically. ------------
    console.log('\n[3] Import round-trips the whole scrape');
    // Snapshot the structure (types + key fields), stripping session-only ids.
    const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'id' || k.charAt(0) === '_' ? undefined : v)));
    const before = await R(() => JSON.parse(JSON.stringify(steps, (k, v) => (k === 'id' || k.charAt(0) === '_' ? undefined : v))));

    // Wipe the workspace, then import from the file.
    await R(() => { steps.length = 0; renderSteps(); });
    await R(() => document.getElementById('import-job').click());
    await sleep(500);
    const after = await R(() => JSON.parse(JSON.stringify(steps, (k, v) => (k === 'id' || k.charAt(0) === '_' ? undefined : v))));

    check('imported step tree is byte-identical to the exported one',
      JSON.stringify(after) === JSON.stringify(before),
      `after=${after.length} top-level`);
    check('a deep field survived (spread namePattern)',
      JSON.stringify(after).includes('Sales ({})'));
    check('a nested filter rule survived (contains Xbox)',
      JSON.stringify(after).includes('"value":"Xbox"'));
    check('waitFirst flags survived on grab steps',
      (JSON.stringify(after).match(/"waitFirst":true/g) || []).length >= 2);

    // ---- [4] Import also persisted (was a bug: import didn't auto-save). -----
    console.log('\n[4] An import is itself auto-saved');
    await sleep(900);
    const afterImportStored = await R(async (id) => {
      const j = await window.harvest.jobs.load(id);
      return j ? countSteps(j.steps) : -1;
    }, jobId);
    check('the imported program is persisted to the store', afterImportStored === total, `${afterImportStored} vs ${total}`);

    // ---- [5] A junk file is rejected cleanly. --------------------------------
    console.log('\n[5] A bad file is rejected without crashing');
    const rejected = await R(() => {
      try { applyImportedJob(JSON.parse('{"nope":1}')); return 'no-throw'; }
      catch (e) { return e.message; }
    });
    check('importing a file with no steps throws a clear error', /no steps/.test(rejected), rejected);

    // ---- [6] CSV export encoding — the bytes on disk match the choice. -------
    console.log('\n[6] CSV export writes the chosen encoding (Excel-ready BOM by default)');
    const csvFile = path.join(os.tmpdir(), 'enc-' + Date.now() + '.csv');
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, csvFile);
    // Put a row with a £ sign (the classic Excel-mangles-it character) in results.
    async function exportWith(enc) {
      await R((e) => {
        results.length = 0; columns.length = 0; columnConfig.length = 0;
        addRow({ item: 'Café £5' });
        csvEncoding = e;
        document.getElementById('export-csv').click();
      }, enc);
      await sleep(300);
      return fs.readFileSync(csvFile);
    }
    const bom8 = await exportWith('utf8bom');
    check('UTF-8 (Excel-ready) starts with the UTF-8 BOM EF BB BF',
      bom8[0] === 0xef && bom8[1] === 0xbb && bom8[2] === 0xbf, [bom8[0], bom8[1], bom8[2]].join(','));
    check('…and the £ round-trips as UTF-8', bom8.slice(3).toString('utf8').includes('£5'));

    const u16 = await exportWith('utf16le');
    check('UTF-16 starts with the LE BOM FF FE', u16[0] === 0xff && u16[1] === 0xfe, [u16[0], u16[1]].join(','));
    check('…and decodes as UTF-16 LE', u16.slice(2).toString('utf16le').includes('Café £5'));

    const plain = await exportWith('utf8');
    check('UTF-8 without BOM has no BOM bytes', !(plain[0] === 0xef && plain[1] === 0xbb), [plain[0], plain[1]].join(','));
    try { fs.rmSync(csvFile, { force: true }); } catch (_) {}
  } catch (e) {
    FAIL++;
    console.log('  ✗ EXCEPTION: ' + e.message);
    console.log(e.stack);
  } finally {
    await app.close();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(jobFile, { force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
