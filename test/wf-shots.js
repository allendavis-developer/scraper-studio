// Screenshots of the workflow-upgrade features (sidebar with Tasks/Try + Map).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');

const root = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'ss-wf-shots');
const fixture = pathToFileURL(path.join(__dirname, 'fixtures', 'page.html')).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(os.tmpdir(), 'ss-wfshot-' + Date.now());
  const app = await electron.launch({ args: [root, '--user-data-dir=' + tmp] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1500, height: 950 });
  await sleep(700);
  const R = (fn, a) => win.evaluate(fn, a);
  const shot = async (n) => {
    await win.screenshot({ path: path.join(OUT, n + '.png') });
    console.log('shot:', path.join(OUT, n + '.png'));
  };

  await R(() => document.getElementById('dash-new').click());
  await sleep(200);
  await R((u) => {
    document.getElementById('newjob-name').value = 'Inventory sync';
    document.getElementById('newjob-url').value = u;
    document.getElementById('newjob-create').click();
  }, fixture);
  await sleep(1800);

  // A realistic nested program showcasing Tasks, For each, If, Try/Recover.
  await R(() => {
    const prog = [
      {
        type: 'group', name: 'Log in', emoji: '🔐', collapsed: true,
        body: [
          { type: 'type', selector: '#q', text: 'admin', clear: true, pressEnter: false },
          { type: 'click', selector: '#searchBtn' }
        ]
      },
      {
        type: 'group', name: 'Scrape products', emoji: '🛒', collapsed: false,
        body: [
          {
            type: 'forEach', selector: 'li.item', indexVar: 'i', maxIter: 1000, body: [
              { type: 'get', name: 'price', target: 'var', source: 'text', selector: '.price', attr: '', expr: '', transforms: [{ op: 'number' }] },
              {
                type: 'if', condition: { match: 'all', rules: [{ left: 'price', op: 'ge', right: '20' }] },
                then: [{ type: 'skip' }], else: []
              },
              {
                type: 'try', retries: 2,
                body: [
                  { type: 'click', selector: '.more' },
                  { type: 'get', name: 'title', target: 'column', source: 'text', selector: '.name', attr: '', expr: '', transforms: [] },
                  { type: 'back' }
                ],
                onError: [{ type: 'get', name: 'title', target: 'column', source: 'expr', expr: '"(unavailable)"', selector: '', attr: '', transforms: [] }]
              }
            ]
          }
        ]
      },
      { type: 'group', name: 'Export report', emoji: '📤', collapsed: true, body: [] }
    ];
    steps.length = 0;
    for (const s of reidList(prog)) steps.push(s);
    renderSteps();
  });
  await sleep(300);
  await shot('wf-1-sidebar-tasks');

  // the Add-step directory
  await R(() => document.getElementById('add-step').click());
  await sleep(250);
  await shot('wf-1b-add-step-directory');
  await R(() => document.getElementById('addstep-close').click());
  await sleep(150);

  // Map view — top-level graph (modules wired in sequence)
  await R(() => openMap());
  await sleep(400);
  await shot('wf-2-map-toplevel');

  // Drill into the "Scrape products" module
  await R(() => {
    const n = mapModel.nodes.find((x) => x.step && x.step.name === 'Scrape products');
    onNodeActivate(n);
  });
  await sleep(300);
  await shot('wf-3-map-module');

  // Drill into the For each inside it, with data flow on
  await R(() => {
    const n = mapModel.nodes.find((x) => x.step && x.step.type === 'forEach');
    if (n) onNodeActivate(n);
    const c = document.getElementById('map-dataflow');
    c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  await shot('wf-4-map-foreach-dataflow');

  // Dark theme
  await R(() => applyTheme('dark'));
  await sleep(200);
  await shot('wf-5-map-dark');

  await app.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log('\nScreenshots in:', OUT);
})();
