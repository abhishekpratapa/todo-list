// Preload for the quick-capture panel: the only thing the page may ask of the app is to hide the panel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureWindow', {
  hide: () => ipcRenderer.send('capture:hide'),
});
