// Scraping an HTML table must be ONE pick. A generic element picker can't do it
// (clicking a row generalizes to `tr`, which swallows the header row; clicking a
// cell gives `tr > td`, i.e. every cell on the page). So a pick that lands inside
// a <table> reads the table's real structure instead: body rows, one column per
// header, Number clean-ups on money/percent, and Subtotal/Total rows excluded.
//
//   node test/table-e2e.js

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
  const report = pathToFileURL(path.join(__dirname, 'fixtures', 'report.html')).toString();
  const tmpUserData = path.join(os.tmpdir(), 'scrapestudio-table-' + Date.now());
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
  async function waitRunDone() {
    for (let i = 0; i < 150; i++) {
      if (!(await R(() => document.getElementById('run').disabled))) return;
      await sleep(150);
    }
  }
  // Click an element in the guest page by coordinates, like a real user picking.
  async function guestClick(sel) {
    const c = await G(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
    await G(`(() => {
      const x=${c.x}, y=${c.y};
      const el = document.elementFromPoint(x,y);
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    })()`);
  }

  try {
    console.log('Scraping a table — one pick\n' + '='.repeat(50));

    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'Table Job';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, report);
    await waitUrl('report.html');
    await sleep(800);

    // ---- The whole user journey: Add step → Grab a table → Pick ONE cell.
    console.log('\n[1] Add “📊 Grab a table”, then Pick a single cell');
    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="scrapeTable"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click()); // ① Pick the table
    await sleep(250);

    // Hovering a CELL must highlight the WHOLE TABLE — you're choosing a table,
    // so that's what should light up.
    const hover = await G(`(() => {
      const el = document.querySelector('tbody tr:nth-of-type(2) td:nth-of-type(2)');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:Math.round(r.left+r.width/2), clientY:Math.round(r.top+r.height/2)}));
      const ov = [...document.documentElement.children].find(n => n.tagName === 'DIV' && n.style.position === 'fixed' && n.style.zIndex === '2147483646');
      const lb = [...document.documentElement.children].find(n => n.tagName === 'DIV' && n.style.position === 'fixed' && n.style.zIndex === '2147483647');
      const t = document.querySelector('table').getBoundingClientRect();
      return {
        w: ov ? Math.round(parseFloat(ov.style.width)) : 0,
        h: ov ? Math.round(parseFloat(ov.style.height)) : 0,
        tableW: Math.round(t.width), tableH: Math.round(t.height),
        cellW: Math.round(r.width),
        label: lb ? lb.textContent : ''
      };
    })()`);
    check('hovering a cell highlights the WHOLE table, not the cell',
      hover.w === hover.tableW && hover.h === hover.tableH && hover.w > hover.cellW * 2,
      `overlay ${hover.w}×${hover.h} vs table ${hover.tableW}×${hover.tableH}`);
    check('…and the label says what you’re about to grab',
      /This table — 9 rows × 7 columns/.test(hover.label), hover.label);

    const hintText = await R(() => document.getElementById('pick-hint').textContent);
    check('the on-page hint explains that whole tables light up', /whole tables light up/i.test(hintText),
      hintText.trim().slice(0, 50));

    await guestClick('tbody tr:nth-of-type(2) td:nth-of-type(2)'); // click that cell
    await sleep(500);
    // A single-element pick can raise the "which element(s)?" chooser — take
    // whatever it offers; either answer must still resolve to the whole table.
    const hadChooser = await R(() => !!document.querySelector('.choice'));
    if (hadChooser) {
      await R(() => document.querySelector('.choice button').click());
      await sleep(600);
    }
    await sleep(700);

    const after = await R(() => ({
      banner: !!document.querySelector('.table-banner'),
      bannerText: (document.querySelector('.table-banner') || {}).textContent || '',
      rowSel: (document.querySelector('#modal-body .sel-input') || {}).value,
      cols: editing ? editing.fields.map((f) => f.name) : [],
      numeric: editing ? editing.fields.filter((f) => (f.transforms || []).some((t) => t.op === 'number')).map((f) => f.name) : [],
      shaperRows: document.querySelectorAll('#modal-body .tcol-row').length,
      previewCells: document.querySelectorAll('#modal-body .pv-table td').length,
      numCells: document.querySelectorAll('#modal-body .pv-table td.pv-num').length
    }));

    check('one click tells you which table it got',
      after.banner && /Got .*Sales & Income Summary/.test(after.bannerText),
      after.bannerText.slice(0, 60));
    check('it fills in ALL 7 columns, named from the <th> headers',
      JSON.stringify(after.cols) === JSON.stringify(['type', 'gross', 'vat', 'net', 'cost', 'margin', 'percent']),
      JSON.stringify(after.cols));
    check('money / % columns are set to Number automatically',
      JSON.stringify(after.numeric) === JSON.stringify(['gross', 'vat', 'net', 'cost', 'margin', 'percent']),
      JSON.stringify(after.numeric));
    check('the row selector targets real body rows and drops the totals',
      /tbody tr:not\(\.total\)/.test(after.rowSel), after.rowSel);
    check('the banner offers to keep/drop the summary rows',
      /summary row/i.test(after.bannerText), after.bannerText.slice(0, 80));
    check('the column shaper lists every column (rename / reorder / drop / retype)',
      after.shaperRows === 7, `${after.shaperRows} rows`);
    check('a live preview shows the real rows, with numbers marked',
      after.previewCells > 0 && after.numCells > 0, `${after.previewCells} cells, ${after.numCells} numeric`);

    // ---- Shape it: rename a column, drop one, retype one.
    console.log('\n[1b] Shape the columns — rename, drop, retype');
    await R(() => {
      const rows = [...document.querySelectorAll('#modal-body .tcol-row')];
      // rename "type" -> "category"
      const nameInput = rows[0].querySelector('input[type=text], input:not([type=checkbox])');
      nameInput.value = 'category';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      // drop the "percent" column (last)
      rows[6].querySelector('input[type=checkbox]').click();
    });
    await sleep(300);
    const shaped = await R(() => ({
      names: editing.fields.map((f) => f.name),
      included: editing.fields.filter((f) => f.include !== false).map((f) => f.name)
    }));
    check('renaming a column sticks', shaped.names[0] === 'category', shaped.names[0]);
    check('unticking a column drops it', !shaped.included.includes('percent'), JSON.stringify(shaped.included));

    // ---- Run: the CSV must honour the shaping, with no header/total junk.
    console.log('\n[2] Save and run — the CSV matches what you shaped');
    await R(() => document.getElementById('modal-save').click());
    await sleep(200);
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const rows = await R(() => JSON.parse(JSON.stringify(results)));
    check('7 line-item rows (no header row, no Subtotal/Total)', rows.length === 7, `${rows.length} rows`);
    check('the renamed column is the CSV heading', rows[1] && rows[1].category === 'Second Hand Sales',
      rows[1] && rows[1].category);
    check('the dropped column is gone', rows[1] && rows[1].percent === undefined);
    check('money came out as real NUMBERS, not "£511.09" text',
      rows[1] && rows[1].gross === 511.09 && typeof rows[1].gross === 'number',
      JSON.stringify(rows[1] && rows[1].gross));
    check('no row is the header row', !rows.some((r) => r.category === 'Type'));
    check('no Subtotal / Total rows', !rows.some((r) => /total/i.test(r.category || '')),
      JSON.stringify(rows.map((r) => r.category)));

    // ---- Unticking the box brings the summary rows back.
    console.log('\n[3] The summary rows can be kept, with one tick');
    await R(() => document.querySelector('.step button[title="Edit"]').click());
    await sleep(400);
    await R(() => {
      const cb = document.querySelector('.table-banner input[type=checkbox]');
      cb.click(); // untick "leave out the summary rows"
    });
    await sleep(300);
    await R(() => document.getElementById('modal-save').click());
    await sleep(200);
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const all = await R(() => JSON.parse(JSON.stringify(results)));
    check('now all 9 rows come through, incl. Subtotal & Total', all.length === 9, `${all.length} rows`);
    check('…and Total’s margin is right', all.some((r) => r.category === 'Total' && r.margin === 463.74));

    // ---- [4] A page with SEVERAL tables: you get the one you clicked, and the
    //          editor says which one it is.
    console.log('\n[4] Three tables on one page — you get the one you clicked');
    const many = pathToFileURL(path.join(__dirname, 'fixtures', 'tables.html')).toString();
    await R((u) => {
      setStartUrl(u);
      steps.length = 0;
      renderSteps();
      const i = document.getElementById('url');
      i.value = u;
      document.getElementById('go').click();
    }, many);
    await waitUrl('tables.html');
    await sleep(900);

    // Pick a cell in the MIDDLE table (Staff).
    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="scrapeTable"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(250);
    // Hovering a cell of the MIDDLE table must outline exactly THAT table —
    // not the cell, and not one of the other two tables.
    const hi = await G(`(() => {
      const el = document.querySelector('table:nth-of-type(2) tbody tr:nth-of-type(2) td:nth-of-type(1)');
      el.scrollIntoView({block:'center'});
      const rc = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:Math.round(rc.left+rc.width/2),clientY:Math.round(rc.top+rc.height/2)}));
      const ov = [...document.documentElement.children].find(n => n.tagName==='DIV' && n.style.zIndex==='2147483646');
      const o = ov.getBoundingClientRect();
      const ts = [...document.querySelectorAll('table')].map(t => t.getBoundingClientRect());
      // The overlay draws a 2px border AROUND the element, so its border-box is
      // 4px bigger in each axis. Anything within that is an exact hit.
      const near = (a,b) => Math.abs(a-b) <= 5;
      // Size alone can't tell the tables apart (Sales and Staff happen to be the
      // same height) — POSITION is what proves we outlined the right one.
      return {
        matchesMiddle: near(o.width, ts[1].width) && near(o.height, ts[1].height) && near(o.top, ts[1].top),
        matchesOthers: near(o.top, ts[0].top) || near(o.top, ts[2].top),
        ov: [Math.round(o.width), Math.round(o.height), Math.round(o.top)],
        mid: [Math.round(ts[1].width), Math.round(ts[1].height), Math.round(ts[1].top)]
      };
    })()`);
    check('hover outlines exactly the table under the cursor',
      hi.matchesMiddle && !hi.matchesOthers,
      `overlay ${hi.ov.join('×')} vs middle table ${hi.mid.join('×')}`);

    await guestClick('table:nth-of-type(2) tbody tr:nth-of-type(2) td:nth-of-type(1)'); // "Bo"
    await sleep(900);

    const multi = await R(() => ({
      chooser: !!document.querySelector('.choice'), // must NOT appear for a table
      banner: (document.querySelector('.table-banner .tb-title') || {}).textContent || '',
      cols: editing ? editing.fields.map((f) => f.name) : [],
      rowSel: (document.querySelector('#modal-body .sel-input') || {}).value
    }));
    check('no confusing “this one vs all of them” prompt on a table', !multi.chooser);
    check('it names the table you clicked, and says which of the 3 it is',
      /Staff/.test(multi.banner) && /table 2 of 3/i.test(multi.banner), multi.banner);
    check('it takes THAT table’s columns (not the Sales table’s)',
      JSON.stringify(multi.cols) === JSON.stringify(['name', 'role', 'hours', 'rate']),
      JSON.stringify(multi.cols));

    await R(() => document.getElementById('modal-save').click());
    await sleep(200);
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const staff = await R(() => JSON.parse(JSON.stringify(results)));
    check('running it scrapes ONLY that table (3 staff, not the other tables)',
      staff.length === 3 && staff.every((r) => r.name && r.role), `${staff.length} rows`);
    check('…with its own columns and numbers', staff[0].name === 'Ann' && staff[0].rate === 22.5,
      JSON.stringify(staff[0]));

    // ---- [5] Trailing spacer cells must NOT become col4/col5 in the CSV. -----
    console.log('\n[5] Junk spacer columns (col6/col7) are dropped, not dumped in the CSV');
    const junk = pathToFileURL(path.join(__dirname, 'fixtures', 'junkcols.html')).toString();
    await R((u) => {
      setStartUrl(u);
      steps.length = 0;
      renderSteps();
      const i = document.getElementById('url');
      i.value = u;
      document.getElementById('go').click();
    }, junk);
    await waitUrl('junkcols.html');
    await sleep(900);

    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="scrapeTable"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(250);
    await guestClick('table.orders tbody tr:nth-of-type(1) td:nth-of-type(1)');
    await sleep(700);
    if (await R(() => !!document.querySelector('.choice'))) {
      await R(() => document.querySelector('.choice button').click());
      await sleep(500);
    }
    await sleep(500);

    const jf = await R(() => ({
      names: editing.fields.map((f) => f.name),
      included: editing.fields.filter((f) => f.include !== false).map((f) => f.name),
      excluded: editing.fields.filter((f) => f.include === false).map((f) => f.name)
    }));
    check('the reader still SEES the spacer columns (so you could tick them if real)',
      jf.names.some((n) => /^col\d/.test(n)), JSON.stringify(jf.names));
    check('…but they start UNTICKED — only the 3 real columns are on',
      jf.included.join(',') === 'item,qty,price' && jf.excluded.length > 0 && jf.excluded.every((n) => /^col\d/.test(n)),
      JSON.stringify({ on: jf.included, off: jf.excluded }));

    await R(() => document.getElementById('modal-save').click());
    await sleep(200);
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const jrows = await R(() => JSON.parse(JSON.stringify(results)));
    check('the CSV has only the 3 real columns — no col4 / col5',
      jrows.length === 3 && Object.keys(jrows[0]).join(',') === 'item,qty,price', JSON.stringify(jrows[0]));

    // ---- [6] Duplicate headers (Sales block + Refunds block) must NOT clobber
    //          each other — every column gets a unique name AND label so both the
    //          CSV row objects and the Spread pivot keep all the data. -----------
    console.log('\n[6] Duplicate headers — repeated columns each survive, uniquely named');
    const dup = pathToFileURL(path.join(__dirname, 'fixtures', 'dupcols.html')).toString();
    await R((u) => {
      setStartUrl(u);
      steps.length = 0;
      renderSteps();
      const i = document.getElementById('url');
      i.value = u;
      document.getElementById('go').click();
    }, dup);
    await waitUrl('dupcols.html');
    await sleep(900);

    await R(() => document.getElementById('add-step').click());
    await sleep(80);
    await R(() => document.querySelector('#addstep-body [data-add="scrapeTable"]').click());
    await sleep(200);
    await R(() => document.querySelector('#modal-body .pick-btn').click());
    await sleep(250);
    await guestClick('table.table-hover tbody tr:nth-of-type(1) td:nth-of-type(1)'); // "Linds"
    await sleep(700);
    if (await R(() => !!document.querySelector('.choice'))) {
      await R(() => document.querySelector('.choice button').click());
      await sleep(500);
    }
    await sleep(400);

    const df = await R(() => ({
      names: editing.fields.map((f) => f.name),
      labels: editing.fields.map((f) => f.label)
    }));
    check('all 10 column NAMES are unique (the two Qty / Margin columns disambiguated)',
      new Set(df.names).size === df.names.length && df.names.length === 10, JSON.stringify(df.names));
    check('all 10 column LABELS are unique too (so Spread shows/emits them distinctly)',
      new Set(df.labels).size === df.labels.length, JSON.stringify(df.labels));

    await R(() => document.getElementById('modal-save').click());
    await sleep(200);
    await R(() => { results.length = 0; columns.length = 0; columnConfig.length = 0; renderResults(); });
    await R(() => document.getElementById('run').click());
    await waitRunDone();
    const drows = await R(() => JSON.parse(JSON.stringify(results)));
    check('every row keeps all 10 values — the second Qty/Margin set is NOT lost',
      drows.length === 3 && Object.keys(drows[0]).length === 10, JSON.stringify(drows[0]));
    check('the two Qty columns hold their OWN values (Sales 43 vs Refunds 0), not one repeated',
      (() => {
        const r = drows[0] || {};
        const salesQty = r.qty, refundQty = r.qty2;
        return String(salesQty) === '43' && String(refundQty) === '0';
      })(), JSON.stringify(drows[0]));
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
