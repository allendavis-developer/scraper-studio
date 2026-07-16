// Electron main process.
// Owns the application window and handles privileged operations the renderer
// cannot do directly: showing native save dialogs and writing files to disk.

const { app, BrowserWindow, Menu, nativeTheme, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { cookiePersistDetails } = require('../shared/session-cookies');
const { realisticUserAgent, defaultHeaders } = require('../shared/stealth');

const isDev = process.argv.includes('--dev');

// A clean desktop-Chrome User-Agent (no "Electron/…" / app-name tokens), so
// bot-protection (Cloudflare, etc.) doesn't block us on sight. Derived from
// Electron's own default UA, so it keeps the real platform + Chromium version.
const STEALTH_UA = realisticUserAgent(app.userAgentFallback);
// Make it the default for EVERY web page / <webview>, including ones created
// before a window exists.
app.userAgentFallback = STEALTH_UA;

// Keep sign-ins — including 2FA "remember this device" — across restarts. Sites
// store that token in a SESSION cookie (no expiry), which Chromium drops on quit.
// We re-write each session cookie as a long-lived persistent one so it's written
// to disk and still there next launch (what a browser does via session restore).
// Applied to every session, so each job's persist:<id> partition benefits.
function keepSessionCookies(ses) {
  if (!ses || ses.__cookiePersist) return;
  ses.__cookiePersist = true;
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed) return;
    const details = cookiePersistDetails(cookie); // null unless it's a session cookie
    if (!details) return;
    // Re-setting with an expiry makes it persistent; the resulting cookie is no
    // longer a session cookie, so this doesn't loop.
    ses.cookies.set(details).catch(() => {});
  });
}

// Make each session look like a normal browser: the clean UA, plus the request
// headers a real Chrome sends. Applied to the default session and every job's
// persist:<id> partition as it's created.
function hardenSession(ses) {
  if (!ses || ses.__hardened) return;
  ses.__hardened = true;
  try {
    ses.setUserAgent(STEALTH_UA, 'en-GB');
  } catch (_) {}
  try {
    const extra = defaultHeaders('en-GB,en;q=0.9');
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      // Never override the Electron "Electron" token if it somehow reappears.
      if (/Electron|scrape-?studio/i.test(h['User-Agent'] || '')) h['User-Agent'] = STEALTH_UA;
      for (const k of Object.keys(extra)) {
        if (h[k] == null) h[k] = extra[k]; // fill in without clobbering real values
      }
      cb({ requestHeaders: h });
    });
  } catch (_) {}
}

// Fires for the default session and every partition session as it's created.
app.on('session-created', (ses) => {
  keepSessionCookies(ses);
  hardenSession(ses);
});

// Application menu with a View menu for switching the theme.
function buildMenu(win) {
  const setTheme = (t) => win.webContents.send('set-theme', t);
  const template = [
    { label: 'File', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Appearance',
          submenu: [
            { id: 'theme-light', label: 'Light', type: 'radio', checked: true, click: () => setTheme('light') },
            { id: 'theme-dark', label: 'Dark', type: 'radio', checked: false, click: () => setTheme('dark') }
          ]
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f5f7',
    title: 'Scrape Studio',
    webPreferences: {
      // The control UI runs with node integration off / context isolation on.
      // The <webview> tag must be explicitly enabled here.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  buildMenu(win);

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  // Force visited web pages (and the webview) to report a light color scheme,
  // so sites that honor prefers-color-scheme render in light mode by default.
  // Our own UI theme is driven separately by the data-theme attribute.
  nativeTheme.themeSource = 'light';
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: save CSV to disk via a native dialog -----------------------------

// Encode CSV text to bytes for the chosen encoding. Excel on Windows needs the
// BOM to read UTF-8 correctly (£ / accents), so 'utf8bom' is the default.
function encodeCsv(text, encoding) {
  const s = String(text == null ? '' : text);
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]); // LE BOM
  }
  if (encoding === 'utf8') {
    return Buffer.from(s, 'utf8'); // no BOM
  }
  // Default: UTF-8 with BOM — the reliable "opens cleanly in Excel" choice.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
}

ipcMain.handle('save-csv', async (_event, { defaultName, contents, encoding }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export CSV',
    defaultPath: defaultName || 'webharvest-export.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, encodeCsv(contents, encoding));
  return { saved: true, filePath };
});

// --- IPC: export / import a portable "job" file (.job — JSON inside) --------
// A .job bundles the whole scrape (steps, start URL, column shaping, sign-in
// config) so it can be shared or backed up and re-imported anywhere.

ipcMain.handle('export-job', async (_event, { defaultName, json }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export job',
    defaultPath: defaultName || 'scrape.job',
    filters: [{ name: 'Scrape Studio job', extensions: ['job'] }, { name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, json, 'utf8');
  return { saved: true, filePath };
});

ipcMain.handle('import-job', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import job',
    properties: ['openFile'],
    // Accept .job (new) and .json (old exports) so nothing breaks.
    filters: [{ name: 'Scrape Studio job', extensions: ['job', 'json'] }]
  });
  if (canceled || !filePaths.length) return { loaded: false };
  const json = fs.readFileSync(filePaths[0], 'utf8');
  return { loaded: true, json, filePath: filePaths[0] };
});

// --- IPC: auto-saved scrape "jobs" (the project store) ---------------------
// Each job is a JSON file under userData/jobs. The renderer auto-saves on every
// change, and the launch dashboard lists them.

function jobsDir() {
  const dir = path.join(app.getPath('userData'), 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const safeId = (id) => (/^[\w-]+$/.test(id || '') ? id : null);

ipcMain.handle('jobs:list', () => {
  const dir = jobsDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: j.id,
        name: j.name || '(untitled)',
        startUrl: j.startUrl || '',
        steps: Array.isArray(j.steps) ? j.steps.length : 0,
        updatedAt: j.updatedAt || 0
      });
    } catch (_) {}
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
});

ipcMain.handle('jobs:load', (_e, id) => {
  const sid = safeId(id);
  if (!sid) return null;
  const p = path.join(jobsDir(), sid + '.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
});

ipcMain.handle('jobs:save', (_e, job) => {
  const sid = job && safeId(job.id);
  if (!sid) return false;
  fs.writeFileSync(path.join(jobsDir(), sid + '.json'), JSON.stringify(job, null, 2), 'utf8');
  return true;
});

ipcMain.handle('jobs:delete', (_e, id) => {
  const sid = safeId(id);
  if (!sid) return false;
  const p = path.join(jobsDir(), sid + '.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

// --- IPC: reusable "task" library ------------------------------------------
// A saved task is a named, self-contained step subtree (usually a Task/group)
// the user can drop into any job. Stored as JSON files under userData/tasks.

function tasksDir() {
  const dir = path.join(app.getPath('userData'), 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('tasks:list', () => {
  const dir = tasksDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push(t);
    } catch (_) {}
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
});

ipcMain.handle('tasks:save', (_e, task) => {
  const sid = task && safeId(task.id);
  if (!sid) return false;
  fs.writeFileSync(path.join(tasksDir(), sid + '.json'), JSON.stringify(task, null, 2), 'utf8');
  return true;
});

ipcMain.handle('tasks:delete', (_e, id) => {
  const sid = safeId(id);
  if (!sid) return false;
  const p = path.join(tasksDir(), sid + '.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

// --- IPC: forget a job's saved sign-in (clear its browser session) ---------
// Each job runs in its own persistent <webview> partition ("persist:<jobId>"),
// so a login done once survives restarts. This wipes that partition's cookies /
// storage so the user can sign out or switch accounts.
ipcMain.handle('auth:clear', async (_e, partition) => {
  if (!partition || typeof partition !== 'string' || !partition.startsWith('persist:')) return false;
  try {
    await session.fromPartition(partition).clearStorageData();
    return true;
  } catch (_) {
    return false;
  }
});
