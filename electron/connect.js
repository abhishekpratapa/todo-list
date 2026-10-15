// The "Use Another Mac's List" window (public/connect.html). It asks for the
// other Mac's address and access token and passes them to `onConnect`, which
// checks them and resolves to { error } to show in the window, or to nothing,
// once this Mac uses that list. The window then closes.

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

let connectWin = null;
let handler = null;

// Only the window itself may hand over an address and a token.
const fromWindow = (event) => connectWin && !connectWin.isDestroyed() && event.sender === connectWin.webContents;

ipcMain.handle('host:connect', async (event, { address, token }) => {
  if (!fromWindow(event) || !handler) return { error: 'This window is no longer in use.' };
  const answer = await handler(address, token);
  if (answer?.error) return answer;
  connectWin.close();
  return {};
});
ipcMain.on('host:cancel', (event) => {
  if (fromWindow(event)) connectWin.close();
});

// Whether the window is open: 'none', 'visible' or 'hidden'.
export const connectWindowState = () => (!connectWin || connectWin.isDestroyed() ? 'none' : connectWin.isVisible() ? 'visible' : 'hidden');

// Opens the window (or brings it forward).
//   url        where the page is served (the app's own server)
//   address    filled in already, when reconnecting to the same Mac
//   root       the app's folder, for the preload script
export function showConnect({ url, address, root, dark, parent, onConnect }) {
  handler = onConnect;
  if (connectWin && !connectWin.isDestroyed()) return connectWin.focus();
  connectWin = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Use Another Mac’s List',
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    backgroundColor: dark ? '#131312' : '#f5f5f2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(root, 'electron', 'connect-preload.cjs'),
    },
  });
  connectWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWin.webContents.on('will-navigate', (e) => e.preventDefault());
  connectWin.on('closed', () => {
    connectWin = null;
    handler = null;
  });
  // For the app's own tests: that the page loaded, and that it can reach the app.
  if (process.env.TODOS_DEBUG) {
    connectWin.webContents.once('did-finish-load', () => {
      connectWin?.webContents.executeJavaScript('`${typeof window.todosConnect?.connect} ${document.title}`')
        .then((seen) => console.log(`connect window: ${seen}`), () => {});
    });
  }
  connectWin.loadURL(`${url}/connect.html${address ? `?address=${encodeURIComponent(address)}` : ''}`);
}
