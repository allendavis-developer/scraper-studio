// Screenshots of the states a first-time user actually hits.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');

const root = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'ss-shots');
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'page.html')).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(os.tmpdir(), 'ss-shot-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1500, height: 950 });
  await sleep(800);
  const R = (fn, a) => win.evaluate(fn, a);
  const shot = async (n) => {
    await win.screenshot({ path: path.join(OUT, n + '.png') });
    console.log('shot:', n);
  };

  await shot('1-dashboard');

  await R(() => document.getElementById('dash-new').click());
  await sleep(250);
  await shot('2-newjob');

  await R((u) => {
    document.getElementById('newjob-name').value = 'Demo';
    document.getElementById('newjob-url').value = u;
    document.getElementById('newjob-create').click();
  }, fixture);
  await sleep(2000);
  await shot('3-empty-editor');

  // the Get value editor — the step everyone will use
  await R(() => document.querySelector('#sidebar .step-palette [data-add="get"]').click());
  await sleep(300);
  await shot('4-get-value-editor');
  await R(() => document.getElementById('modal-cancel').click());

  // For each editor
  await R(() => document.querySelector('#sidebar .step-palette [data-add="forEach"]').click());
  await sleep(250);
  await shot('5-foreach-editor');
  await R(() => {
    const s = document.querySelector('#modal-body .sel-input');
    s.value = 'li.item'; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await R(() => document.getElementById('modal-save').click());
  await sleep(200);

  // Get value INSIDE the for each (scope banner)
  await R(() => document.querySelector('.add-in-block').click());
  await sleep(250);
  await shot('6-type-menu');
  await R(() => {
    [...document.querySelectorAll('.type-menu button')].find((b) => /Grab one value/.test(b.textContent)).click();
  });
  await sleep(300);
  await R(() => {
    document.querySelector('#modal-body .name-input').value = 'price';
    document.querySelector('#modal-body .name-input').dispatchEvent(new Event('input', { bubbles: true }));
    const s = document.querySelector('#modal-body .sel-input');
    s.value = '.price'; s.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#modal-body button')].find((b) => /Add clean-up/.test(b.textContent)).click();
  });
  await sleep(250);
  await shot('7-get-in-foreach-scoped');
  await R(() => document.getElementById('modal-save').click());
  await sleep(200);

  // If editor
  await R(() => document.querySelector('#sidebar .step-palette [data-add="if"]').click());
  await sleep(250);
  await shot('8-if-editor');
  await R(() => document.getElementById('modal-cancel').click());

  // Scrape list editor
  await R(() => document.querySelector('#sidebar .step-palette [data-add="scrapeList"]').click());
  await sleep(250);
  await shot('9-scrapelist-editor');
  await R(() => document.getElementById('modal-cancel').click());

  console.log('\nOUT=' + OUT);
  await app.close();
})();
