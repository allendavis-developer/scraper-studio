// Arbitrary-depth recursion with the NEW general primitives (no bespoke crawler):
//   • get source "collect"  → gather all child link hrefs into a LIST variable
//   • list expr helpers      → listLen / listFirst / listRest / listConcat
//   • existing While + If + Go to URL + Grab a table
// This drives a work-queue crawl over an UNEVEN category tree (leaves at depths
// 1, 2 and 3) and proves every leaf's products are collected, whatever the depth.
//
//   node test/crawl-e2e.js

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
  const start = pathToFileURL(path.join(__dirname, 'fixtures', 'tree', 'root.html')).toString();
  const tmp = path.join(os.tmpdir(), 'scrapestudio-crawl-' + Date.now());
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
  async function waitRunDone() {
    for (let i = 0; i < 300; i++) { if (!(await R(() => document.getElementById('run').disabled))) return; await sleep(150); }
  }

  try {
    console.log('Arbitrary-depth crawl via work-queue primitives\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Crawl';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, start);
    await waitUrl('root.html');
    await sleep(700);

    // Built entirely from VISUAL builders — no typed list expressions:
    //   • get "collect"                        → seed / gather child links
    //   • While  [queue] is not empty          → condition builder (nempty op)
    //   • Formula "first thing in [queue]"      → next item to visit
    //   • Formula "[queue] without its first"   → pop
    //   • Formula "[queue] plus [kids]"         → grow the queue
    //   • If [isLeaf] is true → Grab a table, else collect + append
    await R(() => {
      steps.length = 0;
      steps.push(
        { type: 'get', name: 'queue', target: 'var', source: 'collect', selector: 'a.crawl', attr: 'href', transforms: [] },
        {
          type: 'while',
          condition: { match: 'all', rules: [{ left: 'queue', op: 'nempty' }] },
          maxIter: 100,
          body: [
            { type: 'formula', name: 'current', target: 'var', formula: { kind: 'listFirst', v: { type: 'col', v: 'queue' } } },
            { type: 'formula', name: 'queue', target: 'var', formula: { kind: 'listRest', v: { type: 'col', v: 'queue' } } },
            { type: 'goto', url: '{{current}}' },
            { type: 'get', name: 'isLeaf', target: 'var', source: 'exists', selector: 'table.products', attr: '', transforms: [] },
            {
              type: 'if',
              condition: { match: 'all', rules: [{ left: 'isLeaf', op: 'true' }] },
              then: [
                { type: 'scrapeTable', rowSelector: 'table.products tbody tr', keep: 'rows', dataset: '', skipTotals: false,
                  fields: [{ name: 'barserial', label: 'Barserial', selector: 'td:nth-child(1)', extract: 'text', include: true, transforms: [] }] }
              ],
              else: [
                { type: 'get', name: 'kids', target: 'var', source: 'collect', selector: 'a.crawl', attr: 'href', transforms: [] },
                { type: 'formula', name: 'queue', target: 'var', formula: { kind: 'listAppend', a: { type: 'col', v: 'queue' }, b: { type: 'col', v: 'kids' } } }
              ]
            }
          ]
        }
      );
      reidList(steps); renderSteps();
      results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults();
      document.getElementById('run').click();
    });
    await waitRunDone();

    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    const got = rows.map((r) => r.barserial).sort();
    const want = ['A1-1', 'A2X-1', 'A2X-2', 'A2X-3', 'B-1', 'B-2'];
    check('collected every leaf’s products across depths 1, 2 and 3', rows.length === 6, `${rows.length} rows`);
    check('…and they are exactly the right barserials',
      JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    check('…includes the DEEPEST leaf (depth 3: A2x)',
      got.includes('A2X-1') && got.includes('A2X-3'), JSON.stringify(got));
    check('…and the shallow leaf (depth 1: B)', got.includes('B-1') && got.includes('B-2'), JSON.stringify(got));
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
