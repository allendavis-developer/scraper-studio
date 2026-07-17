// Preload for the control UI (renderer). Exposes a minimal, safe API surface
// over IPC so the renderer never touches Node/fs directly.
//
// NOTE: this runs in a *sandboxed* preload (contextIsolation on, nodeIntegration
// off), so only 'electron' and a tiny module subset are require-able here — do
// NOT require('path')/('fs')/('url'), they throw and would break the bridge.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('harvest', {
  saveCsv: (defaultName, contents, encoding) =>
    ipcRenderer.invoke('save-csv', { defaultName, contents, encoding }),
  // Export / import a portable .job file (whole scrape as one shareable file).
  exportJob: (defaultName, json) =>
    ipcRenderer.invoke('export-job', { defaultName, json }),
  importJob: () => ipcRenderer.invoke('import-job'),
  // Zoom the app's OWN interface (the host frame), independent of the webview.
  setUiZoom: (factor) => {
    if (webFrame && webFrame.setZoomFactor) webFrame.setZoomFactor(factor);
  },
  // Theme changes from the View menu.
  onSetTheme: (cb) => ipcRenderer.on('set-theme', (_e, theme) => cb(theme)),
  // Auto-saved job store (the project dashboard).
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    load: (id) => ipcRenderer.invoke('jobs:load', id),
    save: (job) => ipcRenderer.invoke('jobs:save', job),
    remove: (id) => ipcRenderer.invoke('jobs:delete', id)
  },
  // Reusable task library (saved step subtrees).
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (task) => ipcRenderer.invoke('tasks:save', task),
    remove: (id) => ipcRenderer.invoke('tasks:delete', id)
  },
  // Per-job sign-in sessions.
  auth: {
    clear: (partition) => ipcRenderer.invoke('auth:clear', partition)
  },
  // In-app software updates (the Update button in the sidebar header).
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    version: () => ipcRenderer.invoke('updates:version'),
    onStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s))
  }
});
