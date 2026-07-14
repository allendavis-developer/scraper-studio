// Preload for the control UI (renderer). Exposes a minimal, safe API surface
// over IPC so the renderer never touches Node/fs directly.
//
// NOTE: this runs in a *sandboxed* preload (contextIsolation on, nodeIntegration
// off), so only 'electron' and a tiny module subset are require-able here — do
// NOT require('path')/('fs')/('url'), they throw and would break the bridge.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('harvest', {
  saveCsv: (defaultName, contents) =>
    ipcRenderer.invoke('save-csv', { defaultName, contents }),
  saveRecipe: (defaultName, json) =>
    ipcRenderer.invoke('save-recipe', { defaultName, json }),
  loadRecipe: () => ipcRenderer.invoke('load-recipe'),
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
  }
});
