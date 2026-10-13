// Pairing the iPhone app: what the "Pair iPhone" QR code says, and the page that
// shows it. The window itself is electron/pairing.js. Nothing here is reachable
// through the HTTP server.

import * as qr from './qr.js';

// This Mac's address and the access token, for the Todos iPhone app to read. It is
// not a web address, so a phone's camera has nothing to open if it scans the code.
export const pairingLink = (url, token) => `todos-pair:?v=1&u=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The whole page, as one self-contained document. The code stays black on white in Dark Mode: scanners need the contrast.
export function pairingPage({ url, token, dark = false }) {
  const svg = qr.toSvg(qr.encode(pairingLink(url, token)));
  const [bg, fg, muted] = dark ? ['#1d1d1b', '#f2f2f0', '#a3a39e'] : ['#ffffff', '#1d1d1b', '#6b6b66'];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Pair iPhone</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: ${bg}; color: ${fg}; font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 28px; box-sizing: border-box; -webkit-user-select: none; cursor: default; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; }
  .code { width: 248px; height: 248px; margin: 18px 0 16px; border-radius: 12px; overflow: hidden; background: #fff; }
  .code svg { display: block; width: 100%; height: 100%; }
  .where { font-weight: 500; overflow-wrap: anywhere; }
  .note { color: ${muted}; font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<h1>Pair iPhone</h1>
<p>In Todos on your iPhone, tap <b>Scan Code</b> and point the camera here.</p>
<div class="code" role="img" aria-label="Pairing code">${svg}</div>
<p class="where">${esc(url.replace(/^https:\/\//, ''))}</p>
<p class="note">This code contains your access token, so don’t share a picture of it. The window closes after a minute.</p>
</body>
</html>`;
}
