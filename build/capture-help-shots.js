// Capture REAL screenshots of Scrape Studio for the in-app Help center.
//
// Launches the actual app (fresh data dir → it self-seeds the example jobs),
// drives it to each state a tutorial needs, and saves full-window PNGs (the
// embedded browser is included, via BrowserWindow.capturePage) to
// build/help-shots/raw/. build/annotate-help-shots.js then crops + annotates.
//
//   node build/capture-help-shots.js
//
// Each shot is wrapped so one failure (e.g. a live site being slow) doesn't
// abort the whole run — it logs and continues.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const OUT = path.join(__dirname, 'help-shots', 'raw');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const root = path.join(__dirname, '..');
  const tmp = path.join(os.tmpdir(), 'ss-help-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(1200); // let first-run seeding + dashboard render

  const R = (fn, arg) => win.evaluate(fn, arg);
  const G = (code) => win.evaluate((c) => document.getElementById('view').executeJavaScript(c), code);

  async function shot(name) {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const img = await w.capturePage();
      return img.toPNG().toString('base64');
    });
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, name + '.png'), buf);
    console.log('  shot:', name, `(${buf.length} bytes)`);
  }

  // Wait until a run finishes (Run button re-enabled), or time out.
  async function waitRun(maxMs = 45000) {
    for (let i = 0; i < maxMs / 200; i++) {
      const busy = await R(() => document.getElementById('run').disabled);
      if (!busy) return true;
      await sleep(200);
    }
    return false;
  }
  // Wait for the embedded browser to land on a URL containing `frag`.
  async function waitUrl(frag, tries = 80) {
    for (let i = 0; i < tries; i++) {
      const u = await R(() => { try { return document.getElementById('view').getURL(); } catch (_) { return ''; } });
      if (u && u.includes(frag)) return u;
      await sleep(200);
    }
    return null;
  }
  async function openJobAnd(id, urlFrag, extraWaitMs = 0) {
    await R((jid) => showDashboard().then(() => openJob(jid)).catch(() => openJob(jid)), id).catch(async () => {
      await R((jid) => openJob(jid), id);
    });
    if (urlFrag) await waitUrl(urlFrag);
    await sleep(1200 + extraWaitMs);
  }
  const safe = async (name, fn) => {
    try { await fn(); } catch (e) { console.log('  !! skipped', name, '-', e.message); }
  };

  console.log('Job store (temp):', tmp);
  const dims = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.capturePage();
    const s = img.getSize();
    return s;
  });
  console.log('capture size:', dims.width + 'x' + dims.height);

  // 1) Dashboard with the seeded example jobs.
  await safe('dashboard', async () => {
    await R(() => showDashboard());
    await sleep(700);
    await shot('dashboard');
  });

  // 2) New-job modal, filled with a realistic example.
  await safe('newjob', async () => {
    await R(() => document.getElementById('dash-new').click());
    await sleep(300);
    await R(() => {
      document.getElementById('newjob-name').value = 'Cash Converters — laptops';
      document.getElementById('newjob-url').value = 'https://www.cashconverters.co.uk/';
    });
    await sleep(150);
    await shot('newjob');
    await R(() => document.getElementById('newjob-cancel').click());
  });

  // 3) Simple list job: workspace (steps + live books site).
  await openJobAnd('seed-books-list', 'books.toscrape.com', 800);
  await safe('workspace-list', async () => { await shot('workspace-list'); });

  // 4) Add-step directory.
  await safe('addstep', async () => {
    await R(() => document.getElementById('add-step').click());
    await sleep(400);
    await shot('addstep');
    await R(() => document.getElementById('addstep-close').click());
  });

  // 5) Step editor (the Grab-a-list step).
  await safe('step-editor', async () => {
    await R(() => {
      const b = document.querySelector('#steps .step button[title="Edit"]');
      if (!b) throw new Error('no edit button'); b.click();
    });
    await sleep(500);
    await shot('step-editor');
    await R(() => { const m = document.getElementById('modal-cancel'); if (m) m.click(); });
  });

  // 6) Picker highlighting a product card on the live site.
  await safe('picker', async () => {
    await R(() => startPick('list', { type: 'input', input: document.getElementById('url') }));
    await sleep(500);
    await G(`(() => {
      const el = document.querySelector('article.product_pod');
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      ['mousemove','mouseover'].forEach(t => document.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y })));
    })()`);
    await sleep(500);
    await shot('picker');
    await G(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`).catch(() => {});
  });

  // 7) Results after running the simple list job.
  await safe('results-list', async () => {
    await openJobAnd('seed-books-list', 'books.toscrape.com', 800);
    await R(() => { results.length = 0; columns.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRun();
    await sleep(600);
    await shot('results-list');
  });

  // 8) Column shaping modal (columns exist after the run above).
  await safe('columns', async () => {
    await R(() => document.getElementById('shape-cols').click());
    await sleep(500);
    await shot('columns');
    await R(() => { const c = document.getElementById('cols-cancel'); if (c) c.click(); });
  });

  // 9) Report-table job → results with real numbers (local fixture, deterministic).
  await safe('results-table', async () => {
    await openJobAnd('seed-report-lines', 'report.html', 300);
    await R(() => { results.length = 0; columns.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRun();
    await sleep(500);
    await shot('results-table');
  });

  // 10) Filter job (module · For-each · If · Skip) — the steps list shape.
  await safe('workspace-filter', async () => {
    await openJobAnd('seed-books-cheap', 'books.toscrape.com', 500);
    await shot('workspace-filter');
  });

  // 11) The Map (graph). Two shots: the top level (modules as nodes), and drilled
  //     into the loop with Data flow on (green producer ▸ consumer wires).
  // Double-click a node to drill into a container's own graph.
  const drill = (substr) => R((s) => {
    const nodes = Array.from(document.querySelectorAll('#map-canvas *'))
      .filter((el) => (el.textContent || '').includes(s) && !/\bstart\b/i.test(el.className || ''));
    // smallest element containing the text (the label), then bubble a dblclick to its node
    const t = nodes.sort((a, b) => (a.textContent.length - b.textContent.length))[0];
    if (!t) throw new Error('map node not found: ' + s);
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, substr);

  await safe('map-top', async () => {
    await R(() => openMap());
    await sleep(700);
    await R(() => { const f = document.getElementById('map-fit'); if (f) f.click(); });
    await sleep(400);
    await shot('map-top');
  });
  await safe('map', async () => {
    await drill('Scrape cheap books'); // into the module
    await sleep(500);
    await drill('For each');           // into the loop
    await sleep(500);
    await R(() => { const c = document.getElementById('map-dataflow'); if (c && !c.checked) c.click(); });
    await sleep(300);
    await R(() => { const f = document.getElementById('map-fit'); if (f) f.click(); });
    await sleep(500);
    await shot('map');
    await R(() => { const c = document.getElementById('map-close'); if (c) c.click(); });
  });

  // 12) Paginated job (While loop) — steps list shape.
  await safe('workspace-paginated', async () => {
    await openJobAnd('seed-books-paginated', 'books.toscrape.com', 500);
    await shot('workspace-paginated');
  });

  // 13) Sign-in panel expanded (on the quotes job).
  await safe('signin', async () => {
    await openJobAnd('seed-quotes-login', 'quotes.toscrape.com', 300);
    await R(() => { const d = document.querySelector('details.signin'); if (d) d.open = true; });
    await sleep(400);
    await shot('signin');
  });

  // 14) Record mode hint.
  await safe('record', async () => {
    await openJobAnd('seed-books-list', 'books.toscrape.com', 500);
    await R(() => document.getElementById('record').click());
    await sleep(600);
    await shot('record');
    await R(() => { const s = document.getElementById('record'); if (s) s.click(); }).catch(() => {});
  });

  // 15) Quotes results (login-then-scrape with Try/Recover).
  await safe('results-quotes', async () => {
    await openJobAnd('seed-quotes-login', 'quotes.toscrape.com', 500);
    await R(() => { results.length = 0; columns.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRun();
    await sleep(600);
    await shot('results-quotes');
  });

  await app.close();
  console.log('\nDone. Raw shots in', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
