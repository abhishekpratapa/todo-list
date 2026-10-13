// The "Pair iPhone" window: shows the QR code from src/pairing.js for the Todos
// iPhone app to scan.
//
// The code is the access token, so it is handled like one: drawn in the main
// process, shown in a window that runs no scripts and loads nothing, never served
// by the HTTP server, left out of screenshots and screen sharing, and closed
// after a minute or as soon as the token changes.

import { BrowserWindow } from 'electron';
import { pairingPage } from '../src/pairing.js';

const PAIR_SECONDS = 60;

let pairWin = null;

// Opens the window (or brings it forward). `remote` is the remote-access state; the
// window closes when its token is rotated or the setting is switched off.
export function showPairing({ url, remote, dark, parent }) {
  if (pairWin && !pairWin.isDestroyed()) return pairWin.focus();
  pairWin = new BrowserWindow({
    width: 380,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Pair iPhone',
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    backgroundColor: dark ? '#1d1d1b' : '#ffffff',
    webPreferences: {
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'pairing', // in memory only: nothing about this page is kept
    },
  });
  pairWin.setContentProtection(true); // not in screenshots, recordings or screen sharing
  pairWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pairWin.webContents.on('will-navigate', (e) => e.preventDefault());
  pairWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pairingPage({ url, token: remote.token, dark }))}`);

  const close = () => pairWin && !pairWin.isDestroyed() && pairWin.close();
  const timer = setTimeout(close, PAIR_SECONDS * 1000);
  const unsubscribe = remote.onChange(close);
  pairWin.on('closed', () => {
    clearTimeout(timer);
    unsubscribe();
    pairWin = null;
  });
}
