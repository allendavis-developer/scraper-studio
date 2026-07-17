// The example ("seed") jobs that ship with Scrape Studio so new operators have
// runnable, studyable jobs on their dashboard the first time they open the app.
//
// This is the SINGLE source of truth for those jobs, shared by:
//   - the app's first-run seeding (src/main/main.js),
//   - the screenshot/capture tooling (build/capture-help-shots.js),
//   - the dev seeder (test/seed-jobs.js).
//
// `buildSeedJobs(reportUrl)` returns the job objects. `reportUrl` is a file://
// URL to the bundled "Sales & Income Summary" table fixture — it differs between
// a dev checkout and the packaged app, so the caller resolves and passes it in.

// --- tiny builders to keep the job definitions readable --------------------
const L = (rowSelector, fields) => ({ type: 'scrapeList', rowSelector, fields });
const F = (name, selector, extract = 'text', extra = {}) => ({ name, selector, extract, attr: extra.attr || '', transforms: extra.tf || [] });
const num = [{ op: 'number' }];
const get = (name, o) => ({ type: 'get', name, target: o.target || 'column', source: o.source || 'text', selector: o.selector || '', attr: o.attr || '', expr: o.expr || '', transforms: o.tf || [] });
const grp = (name, emoji, body, note = '') => ({ type: 'group', name, emoji, note, collapsed: false, body });
const rule = (left, op, right = '') => ({ left, op, right });
const cond = (rules, match = 'all') => ({ match, rules });

// Exactly what "📊 Grab a table" builds after ONE pick: a column per <th>,
// positional cell selectors, and Number on the money / % columns.
const TCOL = (name, label, i, numeric) => ({
  name, label, selector: `td:nth-child(${i})`, extract: 'text', attr: '', include: true,
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

// Stable ids so re-seeding overwrites the same jobs rather than duplicating.
function buildSeedJobs(reportUrl) {
  return [
    {
      id: 'seed-report-lines',
      name: '📊 Report table — line items only',
      startUrl: reportUrl,
      steps: [
        { type: 'scrapeTable', rowSelector: TABLE_ROWS + ':not(.total)', skipTotals: true, fields: REPORT_COLS }
      ]
    },
    {
      id: 'seed-report-all',
      name: '📊 Report table — every row (incl. Subtotal & Total)',
      startUrl: reportUrl,
      steps: [
        { type: 'scrapeTable', rowSelector: TABLE_ROWS, skipTotals: false, fields: REPORT_COLS }
      ]
    },
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
    {
      id: 'seed-quotes-login',
      name: '💬 Quotes — Log in, then scrape (Try/Recover)',
      startUrl: 'https://quotes.toscrape.com/',
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
}

module.exports = { buildSeedJobs };
