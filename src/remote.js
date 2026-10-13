// Remote-access state, shared by whoever owns the setting (the desktop app, or a
// test) and the server that enforces it. Everything here can change while the
// server is running; the server reads it on every request.

import crypto from 'node:crypto';
import { createSigner, loadToken, rotateToken, safeEqual } from './auth.js';

export function createRemote({ tokenFile, enabled = false, requireOwner = true } = {}) {
  const appKey = crypto.randomBytes(32); // never leaves this process
  const listeners = new Set();
  let token = null;

  // The token file is only created once something actually needs the token.
  const getToken = () => {
    token ??= loadToken(tokenFile);
    return token;
  };
  const signer = createSigner({ getToken, appKey });

  const remote = {
    enabled,
    // When on, a request relayed by Tailscale must come from `ownerLogin`.
    requireOwner,
    ownerLogin: null,
    // Tailnet names this Mac answers to (lowercase, no port), e.g. "my-mac.tailnet.ts.net".
    hosts: new Set(),
    // Looks up a device name for a tailnet address, for the activity log. Set by the app.
    deviceName: async () => null,

    get token() {
      return getToken();
    },
    checkToken: (candidate) => safeEqual(candidate, getToken()),
    // Cookie value for the app's own windows.
    appCookie: () => signer.issue('a', 3650),
    // Cookie value for a browser that just signed in with the token.
    issueSession: () => signer.issue('r'),
    verify: (value) => signer.verify(value),

    // New token: every signed-in browser and API client has to authenticate again.
    rotate() {
      token = rotateToken(tokenFile);
      remote.changed();
      return token;
    },
    setEnabled(on) {
      remote.enabled = !!on;
      remote.changed();
    },
    // The server listens for this to drop live connections that are no longer allowed.
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    changed() {
      for (const fn of listeners) fn();
    },
  };
  return remote;
}
