// Seeds a handful of realistic, RUNNABLE scrape jobs into Scrape Studio's real
// job store (the same one `npm start` reads), so you can open the app and see
// the new graph interface across different combinations: a flat list, modules +
// For-each + If + Skip, modules + Login + Try/Recover, and a While-loop
// pagination. Each is verified to actually produce rows before we finish.
//
//   node test/seed-jobs.js
//
// Uses stable ids, so re-running overwrites the same seed jobs (no duplicates)
// and never touches your own jobs.

const path = require('path');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A local copy of a real "Sales & Income Summary" report table.
const REPORT = pathToFileURL(path.join(__dirname, 'fixtures', 'report.html')).toString();

// --- helpers to keep the job definitions readable -------------------------
const L = (rowSelector, fields) => ({ type: 'scrapeList', rowSelector, fields });
const F = (name, selector, extract = 'text', extra = {}) => ({ name, selector, extract, attr: extra.attr || '', transforms: extra.tf || [] });
const num = [{ op: 'number' }];
const get = (name, o) => ({ type: 'get', name, target: o.target || 'column', source: o.source || 'text', selector: o.selector || '', attr: o.attr || '', expr: o.expr || '', transforms: o.tf || [] });
const grp = (name, emoji, body, note = '') => ({ type: 'group', name, emoji, note, collapsed: false, body });
const rule = (left, op, right = '') => ({ left, op, right });
const cond = (rules, match = 'all') => ({ match, rules });

// Exactly what "📊 Grab a table" builds for you after ONE pick: a column per
// <th>, positional cell selectors, and Number on the money / % columns.
const TCOL = (name, label, i, numeric) => ({
  name,
  label,
  selector: `td:nth-child(${i})`,
  extract: 'text',
  attr: '',
  include: true,
  transforms: numeric ? num : []
});
const REPORT_COLS = [
  TCOL('type', 'Type', 1, false),
  TCOL('gross', 'Gross', 2, true),
  TCOL('vat', 'VAT', 3, true),
  TCOL('net', 'Net', 4, true),
  TCOL('cost', 'Cost', 5, true),
  TCOL('margin', 'Margin', 6, true),
  TCOL('percent', 'Percent', 7, true)
];
const TABLE_ROWS = 'table.table.table-compressed.table-hover tbody tr';

const JOBS = [
  // 0a) 📊 Grab a table — one step, one pick. Summary rows left out.
  {
    id: 'seed-report-lines',
    name: '📊 Report table — line items only',
    startUrl: REPORT,
    steps: [
      { type: 'scrapeTable', rowSelector: TABLE_ROWS + ':not(.total)', skipTotals: true, fields: REPORT_COLS }
    ]
  },

  // 0b) The same table with the Subtotal / Total rows kept (just untick the box).
  {
    id: 'seed-report-all',
    name: '📊 Report table — every row (incl. Subtotal & Total)',
    startUrl: REPORT,
    steps: [
      { type: 'scrapeTable', rowSelector: TABLE_ROWS, skipTotals: false, fields: REPORT_COLS }
    ]
  },

  // 1) Simplest possible: one Grab-a-list node.
  {
    id: 'seed-books-list',
    name: '📚 Books — simple list',
    startUrl: 'https://books.toscrape.com/',
    steps: [
      L('article.product_pod', [
        F('title', 'h3 a', 'attr', { attr: 'title' }),
        F('price', '.price_color', 'text', { tf: num }),
        F('stock', '.instock.availability', 'text')
      ])
    ]
  },

  // 2) Module + For each + If + Skip + a data-flow (price → the If).
  {
    id: 'seed-books-cheap',
    name: '📚 Books — only under £20 (module · loop · rule)',
    startUrl: 'https://books.toscrape.com/',
    steps: [
      grp('Scrape cheap books', '🛒', [
        {
          type: 'forEach', selector: 'article.product_pod', indexVar: 'i', maxIter: 1000, body: [
            get('price', { source: 'text', selector: '.price_color', tf: num }),
            { type: 'if', condition: cond([rule('price', 'ge', '20')]), then: [{ type: 'skip' }], else: [] },
            get('title', { source: 'attr', selector: 'h3 a', attr: 'title' })
          ]
        }
      ], 'keep only the books cheaper than £20')
    ]
  },

  // 3) Two modules wired Login → Scrape, with Try/Recover around the scrape.
  {
    id: 'seed-quotes-login',
    name: '💬 Quotes — Log in, then scrape (Try/Recover)',
    startUrl: 'https://quotes.toscrape.com/',
    // This job logs in as part of its OWN steps, so it does NOT set a "signed-in
    // marker" (that's for sites where you log in by hand and the job assumes it —
    // otherwise the pre-run auth gate would block the job's own login steps).
    steps: [
      grp('Log in', '🔐', [
        { type: 'goto', url: 'https://quotes.toscrape.com/login' },
        { type: 'type', selector: '#username', text: 'admin', clear: true, pressEnter: false },
        { type: 'type', selector: '#password', text: 'admin', clear: true, pressEnter: false },
        { type: 'click', selector: 'input[type=submit]' }
      ], 'quotes.toscrape accepts any credentials'),
      grp('Scrape quotes', '💬', [
        {
          type: 'try', retries: 1,
          body: [
            L('.quote', [
              F('text', '.text', 'text'),
              F('author', '.author', 'text'),
              F('tag', '.tag', 'text')
            ])
          ],
          onError: [get('status', { source: 'expr', expr: '"scrape failed — recovered"' })]
        }
      ])
    ]
  },

  // 4) While-loop pagination (data value `more` drives the loop).
  {
    id: 'seed-books-paginated',
    name: '📚 Books — paginated (While loop, 5 pages)',
    startUrl: 'https://books.toscrape.com/catalogue/page-1.html',
    steps: [
      get('more', { target: 'var', source: 'exists', selector: '.next a' }),
      {
        type: 'while', condition: cond([rule('more', 'true')]), maxIter: 5, body: [
          L('article.product_pod', [
            F('title', 'h3 a', 'attr', { attr: 'title' }),
            F('price', '.price_color', 'text', { tf: num })
          ]),
          { type: 'click', selector: '.next a' },
          get('more', { target: 'var', source: 'exists', selector: '.next a' })
        ]
      }
    ]
  }
];

(async () => {
  const root = path.join(__dirname, '..');
  const app = await electron.launch({ args: [root] }); // DEFAULT userData → the real store
  const dir = await app.evaluate(({ app }) => app.getPath('userData'));
  console.log('Job store:', path.join(dir, 'jobs'));

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(600);
  const R = (fn, arg) => win.evaluate(fn, arg);

  // Save all seed jobs.
  for (const j of JOBS) {
    const now = Date.now();
    await R((job) => window.harvest.jobs.save(job), { ...j, columns: [], createdAt: now, updatedAt: now });
    console.log('seeded:', j.name);
  }

  // Verify each one actually runs and produces rows.
  async function waitRunDone() {
    for (let i = 0; i < 300; i++) {
      const busy = await R(() => document.getElementById('run').disabled);
      if (!busy) return;
      await sleep(200);
    }
  }
  console.log('\nVerifying (each job is opened and run against the live site)…');
  let ok = 0;
  for (const j of JOBS) {
    try {
      await R((id) => openJob(id), j.id);
      await sleep(2500); // let the start URL load
      await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); });
      await R(() => document.getElementById('run').click());
      await waitRunDone();
      const n = await R(() => results.length);
      const status = n > 0 ? '✓' : '✗';
      if (n > 0) ok++;
      console.log(`  ${status} ${j.name} → ${n} row(s)`);
    } catch (e) {
      console.log(`  ✗ ${j.name} → ${e.message}`);
    }
  }

  await app.close();
  console.log(`\nDone. ${ok}/${JOBS.length} seed jobs produced rows.`);
  console.log('Run `npm start`, and they will be waiting on the dashboard. Open one and press 🗺 Map.');
  process.exit(0);
})();
