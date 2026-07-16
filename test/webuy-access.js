// MANUAL / opt-in live check (NOT part of `npm run test:all` — it hits the real
// network and depends on the site). Confirms the app can reach a Cloudflare-
// protected site (uk.webuy.com) instead of getting the "you have been blocked"
// page, now that we present a clean browser User-Agent.
//
//   node test/webuy-access.js  [url]
//
// Use responsibly: real scrapes still need sensible delays / rate limits.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET = process.argv[2] || 'https://uk.webuy.com/';

(async () => {
  const root = path.join(__dirname, '..');
  const tmp = path.join(os.tmpdir(), 'ss-webuy-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);
  let ok = 0, bad = 0;
  const check = (n, c, d) => { (c ? ok++ : bad++); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

  try {
    console.log(`Reaching ${TARGET}\n` + '='.repeat(50));
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'WebuyAccess';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, TARGET);

    // Wait for the page to settle.
    let info = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      info = await R(() => {
        try {
          const v = document.getElementById('view');
          return v.executeJavaScript('({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 300) })');
        } catch (_) { return null; }
      });
      if (info && info.text && info.text.length > 20) break;
    }
    console.log('  page title:', info && info.title);
    console.log('  first text:', JSON.stringify((info && info.text || '').slice(0, 120)));
    const blocked = /you have been blocked|attention required|cloudflare|access denied|unable to access/i.test(
      ((info && info.title) || '') + ' ' + ((info && info.text) || '')
    );
    check('the site did NOT show a Cloudflare / blocked page', !blocked && !!(info && info.text));
    check('we actually loaded content', !!(info && info.text && info.text.length > 20), (info && info.text || '').slice(0, 60));
  } catch (e) {
    bad++; console.log('  ✗ EXCEPTION ' + e.message); console.log(e.stack);
  } finally {
    await app.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nRESULT: ${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
