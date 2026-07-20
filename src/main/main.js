// Electron main process.
// Owns the application window and handles privileged operations the renderer
// cannot do directly: showing native save dialogs and writing files to disk.

const { app, BrowserWindow, Menu, nativeTheme, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const { cookiePersistDetails } = require('../shared/session-cookies');
const { realisticUserAgent, userAgentMetadata } = require('../shared/stealth');
const { buildSeedJobs } = require('../shared/seed-jobs');

const isDev = process.argv.includes('--dev');

// Auto-update from GitHub Releases. On launch (packaged builds only) we check
// the project's latest release; if a newer version is published, electron-updater
// downloads it in the background and prompts the user to restart into it.
//
// Everything the updater does is written to a log file in userData so a failed
// or stuck update can actually be diagnosed — the previous version swallowed all
// errors to an invisible console, which made "it didn't update" impossible to
// debug. The window that owns the update prompts is tracked in `updaterWin`.
let updaterWin = null;
let updaterReady = false;      // handlers wired?
let interactiveCheck = false;  // true while a user-triggered "Check for updates" runs

function updaterLogPath() {
  return path.join(app.getPath('userData'), 'updater.log');
}

function updLog(level, msg) {
  let text = msg && msg.stack ? msg.stack : (typeof msg === 'object' ? JSON.stringify(msg) : String(msg));
  // Keep the log readable: GitHub error responses embed a multi-KB HTML page,
  // and electron-updater logs the same error again internally — truncate so a
  // single failure can't bloat the log to tens of KB.
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 400) text = text.slice(0, 400) + '...';
  const line = `[${new Date().toISOString()}] ${level} ${text}\n`;
  try { fs.appendFileSync(updaterLogPath(), line); } catch (_) {}
  try { console.log('[auto-update]', level, text); } catch (_) {}
}

// Minimal logger in electron-updater's expected shape (no extra dependency).
const updaterLogger = {
  info: (m) => updLog('INFO', m),
  warn: (m) => updLog('WARN', m),
  error: (m) => updLog('ERROR', m),
  debug: (m) => updLog('DEBUG', m),
};

function notifyRenderer(state, extra) {
  if (updaterWin && !updaterWin.isDestroyed()) {
    updaterWin.webContents.send('update-status', Object.assign({ state }, extra || {}));
  }
}

const isRateLimit = (err) => /\b429\b|too many requests|rate limit/i.test(String((err && err.message) || err || ''));

// Turn an electron-updater error into ONE friendly line. Update errors from
// GitHub embed the entire HTML response (kilobytes) in .message — never surface
// that raw. The common case by far is a transient 429 rate-limit.
function describeUpdateError(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  if (isRateLimit(err)) {
    return 'GitHub declined the update check (HTTP 429). The app keeps working. If this keeps happening, ' +
      'download the latest installer manually from ' +
      'https://github.com/allendavis-developer/scraper-studio/releases/latest and run it once.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|net::|getaddrinfo/i.test(raw)) {
    return 'Could not reach the update server — check your internet connection and try again.';
  }
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
}

function wireUpdaterEvents() {
  if (updaterReady) return;
  updaterReady = true;

  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = true;          // fetch the update in the background
  autoUpdater.autoInstallOnAppQuit = true;  // fallback: apply it on next normal quit

  // electron-updater makes its HTTP calls through Electron's DEFAULT session — the
  // same session our stealth layer rewrites to a fake desktop-Chrome User-Agent
  // (app.userAgentFallback + hardenSession, further down). That disguise is for
  // scraping target sites; it must NOT bleed into our own calls to GitHub. A
  // browser-UA'd process pulling release binaries looks like abuse to GitHub, which
  // answers with a sticky HTTP 429 (an HTML error page) — the exact failure users
  // saw on every launch. Send an honest, non-browser updater UA instead so GitHub
  // treats us as a normal update client. Only the updater's requests are affected;
  // the scraping <webview> partitions keep their disguise.
  autoUpdater.requestHeaders = {
    'User-Agent': `Scrape-Studio/${app.getVersion()} (auto-updater; +https://github.com/allendavis-developer/scraper-studio)`
  };

  autoUpdater.on('checking-for-update', () => {
    updLog('INFO', 'checking for update');
    notifyRenderer('checking');
  });

  autoUpdater.on('update-available', (info) => {
    updLog('INFO', 'update available: ' + (info && info.version) + ' (downloading…)');
    notifyRenderer('available', { version: info && info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    updLog('INFO', 'no update; on latest ' + (info && info.version));
    notifyRenderer('not-available', { version: info && info.version });
    if (interactiveCheck) {
      interactiveCheck = false;
      dialog.showMessageBox(updaterWin, {
        type: 'info',
        title: 'Scrape Studio',
        message: `You’re on the latest version (${app.getVersion()}).`,
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    updLog('INFO', `downloading ${Math.round(p.percent)}% (${Math.round(p.bytesPerSecond / 1024)} KB/s)`);
    notifyRenderer('downloading', { percent: p.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updLog('INFO', 'update downloaded: ' + (info && info.version) + ' — prompting to restart');
    notifyRenderer('downloaded', { version: info && info.version });
    interactiveCheck = false;
    // Prompt rather than force-quit at launch: forcing quitAndInstall from the
    // download event proved unreliable (the update stayed un-applied). Letting
    // the user restart — or fall back to autoInstallOnAppQuit — is robust.
    const choice = dialog.showMessageBoxSync(updaterWin, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Scrape Studio ${info && info.version} has been downloaded.`,
      detail: 'Restart now to finish updating. Otherwise it will be applied next time you quit.',
    });
    if (choice === 0) {
      setImmediate(() => {
        try { autoUpdater.quitAndInstall(false, true); }
        catch (e) { updLog('ERROR', e); }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    updLog('ERROR', err == null ? 'unknown error' : (err.stack || err.message || err));
    notifyRenderer('error', { message: describeUpdateError(err), rateLimited: isRateLimit(err) });
    if (interactiveCheck) {
      interactiveCheck = false;
      dialog.showMessageBox(updaterWin, {
        type: isRateLimit(err) ? 'info' : 'error',
        title: isRateLimit(err) ? 'Try again shortly' : 'Update check failed',
        message: isRateLimit(err) ? 'Update check is rate-limited right now.' : 'Could not check for updates.',
        detail: describeUpdateError(err) + `\n\nDetails are in the update log (Help ▸ Open Update Log).`,
      });
    }
  });
}

function initAutoUpdate(win) {
  updaterWin = win;
  if (isDev || !app.isPackaged) return; // nothing to update in a dev checkout
  wireUpdaterEvents();
  // Throttle the automatic launch check: at most once every few hours. Rapid
  // restarts (or a burst of launches) must not hammer GitHub into a 429
  // secondary rate-limit. The manual "Check for updates" button is never
  // throttled — an explicit click always checks.
  const THROTTLE_MS = 3 * 60 * 60 * 1000; // 3 hours
  const stamp = path.join(app.getPath('userData'), '.last-update-check');
  let last = 0;
  try { last = Number(fs.readFileSync(stamp, 'utf8')) || 0; } catch (_) {}
  if (Date.now() - last < THROTTLE_MS) {
    updLog('INFO', 'launch check skipped — checked within the last few hours');
    return;
  }
  try { fs.writeFileSync(stamp, String(Date.now())); } catch (_) {}
  updLog('INFO', `launch check - current version ${app.getVersion()}`);
  autoUpdater.checkForUpdates().catch((e) => updLog('ERROR', e));
}

// User-triggered check (Help ▸ Check for Updates…). Reports the outcome in a
// dialog so the result is never silent, even in a dev checkout.
function checkForUpdatesInteractive() {
  if (isDev || !app.isPackaged) {
    dialog.showMessageBox(updaterWin, {
      type: 'info',
      title: 'Scrape Studio',
      message: 'Updates are only available in the installed app.',
      detail: `This is a development build (v${app.getVersion()}).`,
    });
    return;
  }
  wireUpdaterEvents();
  interactiveCheck = true;
  updLog('INFO', 'manual update check requested');
  autoUpdater.checkForUpdates().catch((e) => {
    updLog('ERROR', e);
    if (!interactiveCheck) return; // the 'error' event already showed the dialog
    interactiveCheck = false;
    dialog.showMessageBox(updaterWin, {
      type: isRateLimit(e) ? 'info' : 'error',
      title: isRateLimit(e) ? 'Try again shortly' : 'Update check failed',
      message: isRateLimit(e) ? 'Update check is rate-limited right now.' : 'Could not check for updates.',
      detail: describeUpdateError(e) + `\n\nDetails are in the update log (Help ▸ Open Update Log).`,
    });
  });
}

// IPC for the in-app Update button (sidebar header). Unlike the Help-menu check,
// this reports status purely through 'update-status' events so a button can
// reflect it (checking → downloading → ready), with no modal on the common
// paths. The auto/launch flow still posts the same events, so the button shows
// "Restart to update" even for an update found automatically.
ipcMain.handle('updates:check', () => {
  if (isDev || !app.isPackaged) { notifyRenderer('dev', { version: app.getVersion() }); return { dev: true }; }
  wireUpdaterEvents();
  updLog('INFO', 'manual update check (button)');
  autoUpdater.checkForUpdates().catch((e) => {
    updLog('ERROR', e);
    notifyRenderer('error', { message: describeUpdateError(e), rateLimited: isRateLimit(e) });
  });
  return { ok: true };
});
ipcMain.handle('updates:install', () => {
  updLog('INFO', 'user chose Restart to update (button)');
  setImmediate(() => { try { autoUpdater.quitAndInstall(false, true); } catch (e) { updLog('ERROR', e); } });
  return { ok: true };
});
ipcMain.handle('updates:version', () => app.getVersion());

// Remove the "controlled by automation" tell: this makes navigator.webdriver
// undefined and drops the automation banner, so pages don't see us as a bot.
// (Must be set before the app is ready.)
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// THE big anti-block lever: force HTTP/1.1 (disable HTTP/2). Electron's HTTP/2
// SETTINGS frame differs from real Chrome's (e.g. it omits MAX_CONCURRENT_STREAMS
// 3:1000), so Cloudflare's HTTP/2 ("Akamai") fingerprinting spots the mismatch
// and hard-blocks — even with a perfect UA + client hints, and even for a plain
// Electron webview. Measured: over HTTP/2 uk.webuy.com blocks every time; over
// HTTP/1.1 it passes every time. HTTP/1.1 has no such fingerprint to mismatch.
// (Must be set before the app is ready.)
app.commandLine.appendSwitch('disable-http2');

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

// Make each session look like a normal browser: set the clean UA (and the
// Accept-Language) via setUserAgent. We deliberately DON'T touch headers with
// webRequest.onBeforeSendHeaders — modifying any header there makes Chromium
// re-emit them ALPHABETICALLY, which never matches Chrome's fixed header order
// and is itself a strong bot signal. Leaving them alone preserves the real
// Chrome header order + client hints that the engine already produces.
function hardenSession(ses) {
  if (!ses || ses.__hardened) return;
  ses.__hardened = true;
  try {
    // Second arg is a comma-separated language LIST; Electron appends the q-values
    // itself, so pass bare codes (not "en;q=0.9") or you get a doubled "q=0.9;q=0.9".
    ses.setUserAgent(STEALTH_UA, 'en-GB,en');
  } catch (_) {}
}

// Fires for the default session and every partition session as it's created.
app.on('session-created', (ses) => {
  keepSessionCookies(ses);
  hardenSession(ses);
});

// The metadata that makes Chromium emit a clean UA + matching Sec-CH-UA client
// hints, in Chrome's real header order.
const UA_METADATA = userAgentMetadata(STEALTH_UA);

// Apply the clean UA + client-hint metadata natively, via CDP. This is the ONLY
// way to get a consistent UA string AND Sec-CH-UA headers in Chrome's natural
// order — plain setUserAgent drops the client hints, and a webRequest rewrite
// re-sorts headers alphabetically (both are bot tells). Applied to every guest
// page (each job's <webview>) as it's created.
function applyUaOverride(contents) {
  try {
    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    dbg.sendCommand('Network.enable').catch(() => {});
    dbg.sendCommand('Network.setUserAgentOverride', {
      userAgent: STEALTH_UA,
      // BARE language codes only — Chromium appends the q-values itself. Passing
      // 'en-GB,en;q=0.9' here double-encoded it: the header became
      // 'en-GB,en;q=0.9;q=0.9' and navigator.languages became ["en-GB","en;q=0.9"],
      // both impossible for a real browser and an instant bot tell.
      acceptLanguage: 'en-GB,en',
      platform: UA_METADATA.platform,
      userAgentMetadata: UA_METADATA
    }).catch(() => {});
  } catch (_) {}
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    // Re-assert on each navigation — a cross-origin nav can reset the override.
    applyUaOverride(contents);
    contents.on('did-start-navigation', () => applyUaOverride(contents));
  }
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
    },
    {
      label: 'Help',
      submenu: [
        { label: 'User Guide & Tutorials', accelerator: 'F1', click: () => openHelpWindow() },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdatesInteractive() },
        {
          label: 'Open Update Log',
          click: () => { require('electron').shell.openPath(updaterLogPath()); },
        },
        { type: 'separator' },
        { label: `Scrape Studio ${app.getVersion()}`, enabled: false },
      ],
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  // In a dev checkout, give the window/taskbar our app icon. In packaged
  // builds Windows uses the icon embedded in the .exe (from build/icon.ico),
  // so a missing file here is fine — we just skip the option.
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f5f7',
    title: 'Scrape Studio',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
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
  return win;
}

// The bundled "Sales & Income Summary" table used by the seeded report jobs.
function reportFixtureUrl() {
  return pathToFileURL(path.join(__dirname, '..', 'renderer', 'examples', 'report.html')).toString();
}

// Seed the example jobs into the job store on first launch, so a new operator
// opens the app to a dashboard of runnable, studyable examples. A marker file
// means we only do this once — if they delete the examples, they stay deleted.
function seedExamplesOnce() {
  try {
    const marker = path.join(app.getPath('userData'), '.examples-seeded');
    if (fs.existsSync(marker)) return;
    const dir = jobsDir();
    const now = Date.now();
    for (const j of buildSeedJobs(reportFixtureUrl())) {
      const p = path.join(dir, j.id + '.json');
      if (fs.existsSync(p)) continue; // never clobber a job the user already has
      fs.writeFileSync(p, JSON.stringify({ ...j, columns: [], createdAt: now, updatedAt: now }, null, 2), 'utf8');
    }
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch (e) {
    try { console.error('[seed]', e && e.message ? e.message : e); } catch (_) {}
  }
}

// The Help & Tutorials window — a large, standalone reference window opened from
// the Help menu. Loads the self-contained guide in src/help. Single instance:
// if it's already open we just focus it.
let helpWin = null;
function openHelpWindow() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.focus(); return; }
  helpWin = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: 'Scrape Studio — Help & Tutorials',
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  helpWin.setMenuBarVisibility(false);
  // External links open in the user's real browser, not inside the help window.
  helpWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { require('electron').shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  helpWin.loadFile(path.join(__dirname, '..', 'help', 'index.html'));
  helpWin.on('closed', () => { helpWin = null; });
}

app.whenReady().then(() => {
  // Force visited web pages (and the webview) to report a light color scheme,
  // so sites that honor prefers-color-scheme render in light mode by default.
  // Our own UI theme is driven separately by the data-theme attribute.
  nativeTheme.themeSource = 'light';
  seedExamplesOnce();
  const win = createWindow();
  initAutoUpdate(win);

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
