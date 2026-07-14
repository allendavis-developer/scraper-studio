// Electron main process.
// Owns the application window and handles privileged operations the renderer
// cannot do directly: showing native save dialogs and writing files to disk.

const { app, BrowserWindow, Menu, nativeTheme, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev');

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

ipcMain.handle('save-csv', async (_event, { defaultName, contents }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export CSV',
    defaultPath: defaultName || 'webharvest-export.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, contents, 'utf8');
  return { saved: true, filePath };
});

// --- IPC: save / load a scrape "recipe" (the list of steps) ----------------

ipcMain.handle('save-recipe', async (_event, { defaultName, json }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save recipe',
    defaultPath: defaultName || 'recipe.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, json, 'utf8');
  return { saved: true, filePath };
});

ipcMain.handle('load-recipe', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Load recipe',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
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
