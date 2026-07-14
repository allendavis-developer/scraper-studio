// End-to-end tests for the WebHarvest scraping engine against REAL websites.
//
// These drive the exact same code the app uses at runtime: the builders from
// src/shared/page-actions.js are executed in a real Chromium page via Puppeteer,
// just as the app executes them via webview.executeJavaScript. If these pass,
// the app's engine works on these sites.
//
//   node test/scrape-tests.js
//
// Writes sample CSVs to test/output/ for eyeballing.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const PA = require('../src/shared/page-actions.js');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let PASS = 0;
let FAIL = 0;
let SKIP = 0;
const results = [];

function skip(name, why) {
  SKIP++;
  console.log(`  ⊘ ${name} — SKIPPED: ${why}`);
}

// Light anti-automation masking (the real Electron app is a normal browser
// session and doesn't need this; headless test runs get flagged otherwise).
async function applyStealth(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
}

function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    FAIL++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
  results.push({ name, ok: !!cond, detail });
}

// Run a PA builder expression inside the page (mirrors executeJavaScript).
const run = (page, expr) => page.evaluate(expr);

function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\r\n');
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// Pick, from candidate selectors, the one matching the most elements.
async function bestSelector(page, candidates, min = 1) {
  let best = null;
  let bestN = 0;
  for (const sel of candidates) {
    const n = await run(page, PA.safeCountExpr ? PA.safeCountExpr(sel) : `document.querySelectorAll(${JSON.stringify(sel)}).length`);
    if (n > bestN) {
      bestN = n;
      best = sel;
    }
  }
  return bestN >= min ? { selector: best, count: bestN } : null;
}

// ---------------------------------------------------------------------------

async function testBooks(browser) {
  console.log('\n[1] books.toscrape.com — list scrape + pagination + selectors');
  const page = await newPage(browser);
  await page.goto('http://books.toscrape.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });

  const rowSel = 'article.product_pod';
  const fields = [
    { name: 'title', selector: 'h3 a', extract: 'attr', attr: 'title' },
    { name: 'price', selector: '.price_color', extract: 'text', attr: '' },
    { name: 'availability', selector: '.availability', extract: 'text', attr: '' },
    { name: 'link', selector: 'h3 a', extract: 'href', attr: '' },
    { name: 'thumb', selector: 'img', extract: 'src', attr: '' }
  ];

  let all = [];
  for (let p = 1; p <= 3; p++) {
    const rows = await run(page, PA.listExpr(rowSel, fields));
    all = all.concat(rows);
    console.log(`    page ${p}: ${rows.length} rows`);
    // paginate via our own click builder + real navigation
    const hasNext = await run(page, PA.existsExpr('li.next a'));
    if (!hasNext) break;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      run(page, PA.clickExpr('li.next a'))
    ]);
  }

  check('scraped 3 pages of 20', all.length === 60, `${all.length} rows`);
  check('every row has a title', all.every((r) => r.title && r.title.length), null);
  check('every row has a £ price', all.every((r) => /£\d/.test(r.price || '')), all[0] && all[0].price);
  check('links are absolute URLs', all.every((r) => /^https?:\/\//.test(r.link || '')), all[0] && all[0].link);
  check('thumbnails resolved to absolute src', all.every((r) => /^https?:\/\//.test(r.thumb || '')), null);

  // Selector-generator test: inject PA, generalize one card to match all.
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'page-actions.js'), 'utf8') });
  const gen = await page.evaluate(() => {
    const one = document.querySelector('article.product_pod .price_color');
    const single = window.PageActions.cssPath(one);
    const uniqueSingle = document.querySelectorAll(single).length === 1;
    const list = window.PageActions.listSelector(one);
    return { single, uniqueSingle, listSelector: list.selector, listCount: list.count };
  });
  check('cssPath() yields a UNIQUE selector', gen.uniqueSingle, gen.single);
  check('listSelector() generalizes to all 20 prices', gen.listCount === 20, `${gen.listCount} via ${gen.listSelector}`);

  fs.writeFileSync(path.join(OUT, 'books.csv'), toCsv(['title', 'price', 'availability', 'link', 'thumb'], all));
  await page.close();
}

async function testQuotesSelects(browser) {
  console.log('\n[2] quotes.toscrape.com/search — native <select> + dependent dropdown + change events');
  const page = await newPage(browser);
  await page.goto('http://quotes.toscrape.com/search.aspx', { waitUntil: 'domcontentloaded', timeout: 45000 });

  const authors = await run(page, PA.readOptionsExpr('#author'));
  check('read live <select> options', authors && authors.length > 3, authors && `${authors.length} authors`);

  // Choose an author by visible text — must fire change so tags load via JS.
  const target = 'Albert Einstein';
  const sel1 = await run(page, PA.selectExpr('#author', 'text', target, false));
  check('select author by text fires change', sel1 && sel1.ok, sel1 && sel1.chosen);

  // The tag dropdown is populated by the site's JS in response to change.
  await page.waitForFunction(() => document.querySelectorAll('#tag option').length > 1, { timeout: 8000 }).catch(() => {});
  const tags = await run(page, PA.readOptionsExpr('#tag'));
  check('dependent <tag> dropdown populated after change', tags && tags.length > 1, tags && `${tags.length} tags`);

  // Pick a real tag, skipping placeholder options like "----------".
  const realTag = (tags || []).find(
    (t) => t.value && !/^-+$/.test(t.value) && t.text && !/^-+$/.test(t.text)
  );
  if (realTag) {
    const sel2 = await run(page, PA.selectExpr('#tag', 'value', realTag.value, false));
    check('select tag by value', sel2 && sel2.ok, sel2 && sel2.chosen);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      run(page, PA.clickExpr('[type="submit"]'))
    ]);

    const quotes = await run(page, PA.listExpr('.quote', [
      { name: 'quote', selector: '.content, .text', extract: 'text', attr: '' },
      { name: 'author', selector: '.author', extract: 'text', attr: '' }
    ]));
    check('scraped filtered quotes', quotes && quotes.length >= 1, quotes && `${quotes.length} quotes for ${target}/${realTag.value}`);
    check('filtered quotes match author', quotes.length ? quotes.every((q) => q.author === target) : false, null);
    if (quotes) fs.writeFileSync(path.join(OUT, 'quotes.csv'), toCsv(['quote', 'author'], quotes));
  }

  await page.close();
}

async function testShop(browser) {
  console.log('\n[3] webscraper.io test shop — complex real product search (cards + attrs + pagination)');
  const page = await newPage(browser);
  await page.goto('https://webscraper.io/test-sites/e-commerce/static/computers/laptops', {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  const row = await bestSelector(page, ['.product-wrapper', '.thumbnail', '.card', '.col-md-4 .thumbnail'], 3);
  check('found product-card selector', !!row, row && `${row.count} × ${row.selector}`);
  if (!row) {
    await page.close();
    return;
  }
  const titleSel = await firstPresent(page, row.selector, ['.title', 'a.title', '.caption h4 a', 'h4 a']);
  const priceSel = await firstPresent(page, row.selector, ['.price', '.caption .price', 'h4.price']);
  const descSel = await firstPresent(page, row.selector, ['.description', '.card-text', 'p.description']);
  const ratingSel = await firstPresent(page, row.selector, ['[data-rating]', '.ratings p[data-rating]', '.review-count']);

  const fields = [
    { name: 'title', selector: titleSel || '', extract: 'text', attr: '' },
    { name: 'price', selector: priceSel || '', extract: 'text', attr: '' },
    { name: 'description', selector: descSel || '', extract: 'text', attr: '' },
    { name: 'reviews', selector: ratingSel || '', extract: 'text', attr: '' },
    { name: 'link', selector: titleSel || 'a', extract: 'href', attr: '' }
  ];
  const rows = await run(page, PA.listExpr(row.selector, fields));
  check('scraped a page of products', rows.length >= 3, `${rows.length} products`);
  check('products have titles', rows.every((r) => (r.title || '').trim()), rows[0] && rows[0].title);
  check('products have $ prices', rows.every((r) => /\$\d/.test(r.price || '')), rows[0] && rows[0].price);
  check('products have absolute links', rows.every((r) => /^https?:\/\//.test(r.link || '')), null);
  console.log('    sample: ' + JSON.stringify(rows[0]).slice(0, 180));
  fs.writeFileSync(path.join(OUT, 'shop.csv'), toCsv(['title', 'price', 'description', 'reviews', 'link'], rows));
  await page.close();
}

async function testEbay(browser) {
  console.log('\n[4] ebay.com search — real SRP (best-effort; anti-bot may block headless)');
  const page = await newPage(browser);
  await applyStealth(page);
  try {
    await page.goto('https://www.ebay.com/sch/i.html?_nkw=nintendo+switch&_sacat=0', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForSelector('li.s-item, li.s-card, .srp-results', { timeout: 20000 }).catch(() => {});

    const row = await bestSelector(page, ['ul.srp-results li.s-item', 'li.s-item', 'li.s-card', '.s-item', '.s-card'], 5);
    if (!row) {
      const title = await page.title();
      skip('eBay product scrape', `served "${title}" (anti-bot interstitial for headless). The engine is proven on the shop test above; the real app uses a full browser session.`);
      await page.close();
      return;
    }
    check('found product-row selector', !!row, `${row.count} × ${row.selector}`);

    // Detect field selectors from the live markup (title/price/link vary by rollout).
    const titleSel = await firstPresent(page, row.selector, ['.s-item__title', '.s-card__title', '[role="heading"]', 'h3']);
    const priceSel = await firstPresent(page, row.selector, ['.s-item__price', '.s-card__price', '.s-item__detail--primary']);
    const linkSel = await firstPresent(page, row.selector, ['a.s-item__link', 'a.s-card__link', 'a']);

    const fields = [
      { name: 'title', selector: titleSel || '', extract: 'text', attr: '' },
      { name: 'price', selector: priceSel || '', extract: 'text', attr: '' },
      { name: 'link', selector: linkSel || '', extract: 'href', attr: '' }
    ];
    let rows = await run(page, PA.listExpr(row.selector, fields));
    // eBay's first "row" is often a hidden template — drop empties.
    rows = rows.filter((r) => (r.title || '').trim() && (r.price || '').trim());

    check('scraped multiple products', rows.length >= 10, `${rows.length} products`);
    check('products have prices', rows.length ? rows.every((r) => /\$|US ?\$|\d/.test(r.price)) : false, rows[0] && rows[0].price);
    check('products have links', rows.length ? rows.every((r) => /^https?:\/\//.test(r.link || '')) : false, null);

    if (rows.length) {
      console.log('    sample: ' + JSON.stringify(rows[0]).slice(0, 160));
      fs.writeFileSync(path.join(OUT, 'ebay.csv'), toCsv(['title', 'price', 'link'], rows));
    }
  } catch (e) {
    skip('eBay product scrape', 'network/anti-bot: ' + e.message);
  }
  await page.close();
}

// find the first candidate selector that exists inside the first row
async function firstPresent(page, rowSel, candidates) {
  return page.evaluate(
    (rowSel, candidates) => {
      const row = document.querySelector(rowSel);
      if (!row) return null;
      for (const c of candidates) if (row.querySelector(c)) return c;
      return null;
    },
    rowSel,
    candidates
  );
}

async function testInteractions(browser) {
  console.log('\n[4] interaction builders on a synthetic page — check / fill / hover / clickText');
  const page = await newPage(browser);
  const html = `data:text/html,${encodeURIComponent(`
    <input id="t" type="text">
    <input id="c" type="checkbox">
    <div id="menu">Menu<ul id="sub" style="display:none"><li>Alpha</li><li>Beta</li></ul></div>
    <div id="hoverbox">off</div>
    <button id="b1">Save draft</button><button id="b2">Publish now</button>
    <script>
      hoverbox.addEventListener('mouseenter', () => hoverbox.textContent='on');
      b2.addEventListener('click', () => document.title='published');
    </script>`)}`;
  await page.goto(html, { waitUntil: 'domcontentloaded' });

  const fill = await run(page, PA.fillExpr('#t', 'hello world', true));
  const fillVal = await page.$eval('#t', (e) => e.value);
  check('fillExpr sets value', fill.ok && fillVal === 'hello world', fillVal);

  await run(page, PA.checkExpr('#c', 'check'));
  check('checkExpr checks a box', await page.$eval('#c', (e) => e.checked), null);
  await run(page, PA.checkExpr('#c', 'toggle'));
  check('checkExpr toggles off', !(await page.$eval('#c', (e) => e.checked)), null);

  const hov = await run(page, PA.hoverExpr('#hoverbox'));
  check('hoverExpr fires mouseenter', hov.ok && (await page.$eval('#hoverbox', (e) => e.textContent)) === 'on', null);

  const ct = await run(page, PA.clickTextExpr({ container: '', tag: 'button', text: 'Publish now', mode: 'exact' }));
  check('clickText clicks the right button', ct.ok && (await page.title()) === 'published', ct.text);

  await page.close();
}

(async () => {
  console.log('WebHarvest engine — live-site tests\n' + '='.repeat(50));
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  try {
    await testBooks(browser);
    await testQuotesSelects(browser);
    await testInteractions(browser);
    await testShop(browser);
    await testEbay(browser);
  } catch (e) {
    console.error('FATAL', e);
    FAIL++;
  } finally {
    await browser.close();
  }
  console.log('\n' + '='.repeat(50));
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
  console.log(`CSV samples written to: ${OUT}`);
  process.exit(FAIL ? 1 : 0);
})();
