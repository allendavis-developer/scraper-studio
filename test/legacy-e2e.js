// Old jobs must keep working. This drops a job saved in the OLD shape
// (Scrape one + Set var + Add row) into a fresh job store, opens it from the
// dashboard, and checks it migrates to 📥 Get value and still produces the same
// rows — with no duplicate rows from the new auto-commit.
//
//   node test/legacy-e2e.js

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

const root = path.join(__dirname, '..');
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'page.html')).toString();

// A job saved by the previous version: setVar(var) + if + scrape + setVar(column) + emitRow.
const legacyJob = {
  id: 'job-legacy-1',
  name: 'Legacy Job',
  startUrl: fixture,
  steps: [
    {
      id: 3, type: 'forEach', selector: 'li.item', indexVar: 'i', maxIter: 1000,
      body: [
        { id: 4, type: 'setVar', name: 'priceVar', target: 'var', source: 'text',
          selector: '.price', attr: '', expr: '', transforms: [{ op: 'number', a: '', b: '' }] },
        { id: 5, type: 'if',
          condition: { match: 'all', rules: [{ left: 'priceVar', op: 'lt', right: '25' }] },
          then: [
            { id: 13, type: 'scrape', name: 'title', selector: '.name', extract: 'text', attr: '' },
            { id: 15, type: 'setVar', name: 'price', target: 'column', source: 'text',
              selector: '.price', attr: '', expr: '', transforms: [{ op: 'number', a: '', b: '' }] },
            { id: 16, type: 'emitRow' }
          ],
          else: []
        }
      ]
    }
  ],
  columns: [],
  createdAt: 1,
  updatedAt: 1
};

// An even older job that used the pre-clean-up "Convert to number" checkbox.
const legacyClean = {
  id: 'job-legacy-2',
  name: 'Legacy Clean',
  startUrl: fixture,
  steps: [
    { id: 1, type: 'setVar', name: 'p', target: 'column', source: 'text',
      selector: '.price', attr: '', expr: '', clean: true },
    { id: 2, type: 'emitRow' }
  ],
  columns: [],
  createdAt: 1,
  updatedAt: 1
};

(async () => {
  const tmp = path.join(os.tmpdir(), 'ss-legacy-' + Date.now());
  fs.mkdirSync(path.join(tmp, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'jobs', 'job-legacy-1.json'), JSON.stringify(legacyJob));
  fs.writeFileSync(path.join(tmp, 'jobs', 'job-legacy-2.json'), JSON.stringify(legacyClean));

  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(900);
  const R = (fn, arg) => win.evaluate(fn, arg);

  async function openJob(name) {
    await R(() => document.getElementById('show-dashboard').click());
    await sleep(400);
    await R((n) => {
      [...document.querySelectorAll('.job-card')]
        .find((c) => c.querySelector('.jc-name').textContent === n).click();
    }, name);
    await sleep(1600);
  }
  async function run() {
    await R(() => document.getElementById('run').click());
    for (let i = 0; i < 120; i++) {
      if (!(await R(() => document.getElementById('run').disabled))) break;
      await sleep(150);
    }
    await sleep(350);
    return R(() => {
      const headers = [...document.querySelectorAll('#results-table th')].map((t) => t.textContent);
      return {
        headers,
        rows: [...document.querySelectorAll('#results-table tbody tr')].map((tr) =>
          Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [headers[i], td.textContent])))
      };
    });
  }

  try {
    console.log('Legacy job migration\n' + '='.repeat(50));

    console.log('\n[1] old Scrape one / Set var / Add row job');
    await openJob('Legacy Job');
    const steps = await R(() => [...document.querySelectorAll('.step .kind')].map((k) => k.textContent));
    check('old “Scrape one” and “Set var” both become the one Grab-value step',
      steps.filter((s) => /Grab one value/.test(s)).length === 3, JSON.stringify(steps));

    const r1 = await run();
    check('it still produces the same rows', r1.rows.length === 2, `${r1.rows.length} rows`);
    check('no duplicate rows from the new auto-commit',
      r1.rows.map((r) => r.title).join(',') === 'Widget A,Widget B', JSON.stringify(r1.rows));
    check('columns survive', r1.rows.every((r) => r.title && r.price), JSON.stringify(r1.rows));
    check('the old working value stays out of the CSV', !r1.headers.includes('priceVar'), JSON.stringify(r1.headers));

    console.log('\n[2] even older job with the “Convert to number” checkbox');
    await openJob('Legacy Clean');
    const r2 = await run();
    check('clean:true becomes a Number clean-up ("$10.00" → 10)',
      r2.rows.length === 1 && r2.rows[0].p === '10', JSON.stringify(r2.rows));
  } catch (e) {
    FAIL++;
    console.log('  ✗ EXCEPTION: ' + e.message);
    console.log(e.stack);
  } finally {
    await app.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
