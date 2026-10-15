// Preload for the "Use Another Mac's List" window: all the page may ask of the app
// is to try an address and a token, or to close.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todosConnect', {
  connect: (address, token) => ipcRenderer.invoke('host:connect', { address: String(address), token: String(token) }),
  cancel: () => ipcRenderer.send('host:cancel'),
});
