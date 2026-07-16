// The embedded browser must present a clean, real-looking User-Agent (no
// "Electron" / app-name tokens) so bot-protection doesn't block us. This checks
// the LIVE webview — proving the main-process wiring actually took effect — with
// no network access.
//
//   node test/ua-e2e.js

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
  const page = pathToFileURL(path.join(__dirname, 'fixtures', 'report.html')).toString();
  const tmp = path.join(os.tmpdir(), 'ss-ua-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  const R = (fn, arg) => win.evaluate(fn, arg);

  try {
    console.log('Embedded browser presents a clean UA\n' + '='.repeat(50));
    await R(() => document.getElementById('dash-new').click());
    await sleep(150);
    await R((u) => {
      document.getElementById('newjob-name').value = 'UA';
      document.getElementById('newjob-url').value = u;
      document.getElementById('newjob-create').click();
    }, page);
    await sleep(1200);

    // What the guest page actually sees.
    const ua = await R(() => document.getElementById('view').executeJavaScript('navigator.userAgent'));
    console.log('  webview UA:', ua);
    check('the webview UA has no "Electron" token', !/Electron/i.test(ua), ua);
    check('the webview UA has no app-name token', !/scrape-?studio|webharvest/i.test(ua), ua);
    check('the webview UA declares Chrome + Safari like a real browser',
      /Chrome\/[\d.]+/.test(ua) && /Safari\/537\.36/.test(ua), ua);

    // navigator.languages must be clean codes — regression guard for the CDP
    // acceptLanguage double-encoding bug that produced ["en-GB","en;q=0.9"]
    // (a q-value leaked into a language token), an instant bot tell.
    const langs = await R(() => document.getElementById('view').executeJavaScript('JSON.stringify(navigator.languages)'));
    console.log('  navigator.languages:', langs);
    check('navigator.languages has no q-value leaked into a token', !/;q=/i.test(langs), langs);

    // The main process also exposes the clean UA app-wide (userAgentFallback).
    const fallback = await app.evaluate(({ app: a }) => a.userAgentFallback);
    check('app.userAgentFallback is the clean UA too', !/Electron/i.test(fallback), fallback);
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
