// Authentication for remote access: one access token, signed session cookies,
// and small in-memory rate limiters. Node built-ins only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE = 'todos_session';
const SESSION_DAYS = 90;
const DAY_MS = 864e5;

// Compares two secrets in constant time. Hashing first makes the inputs equal
// length, so neither the content nor the length of the real one leaks.
export function safeEqual(a, b) {
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// ---------- access token ----------

const newToken = () => crypto.randomBytes(32).toString('base64url'); // 256 bits

function writeToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // writeFileSync's mode only applies when it creates the file
  return token;
}

// Reads the access token, creating it on first use. The file is readable by the
// owner only; looser permissions left by something else are tightened.
export function loadToken(file) {
  let token;
  try {
    token = fs.readFileSync(file, 'utf8').trim();
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return token && token.length >= 32 ? token : writeToken(file, newToken());
}

export const rotateToken = (file) => writeToken(file, newToken());

// The token from an `Authorization: Bearer ...` header, or null if there is none.
export function bearerToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

// ---------- session cookies ----------

// Sessions are signed, not stored: `v1.<kind>.<expires>.<id>.<signature>`.
//   r  a browser that signed in with the access token. The signing key is derived
//      from the token, so rotating the token signs every device out.
//   a  the app's own windows. Signed with a key that exists only in the running
//      app's memory, so nothing else can mint one and it dies with the app.
const KINDS = { r: 'remote', a: 'app' };

export function createSigner({ getToken, appKey }) {
  // The remote key is derived on demand, so signing or checking the app's own
  // cookie never needs the access token (which may not have been created yet).
  let derivedFrom = null;
  let remoteKey = null;
  const keyFor = (kind) => {
    if (kind === 'a') return appKey;
    const token = getToken();
    if (token !== derivedFrom) {
      remoteKey = crypto.createHmac('sha256', token).update('todos remote session v1').digest();
      derivedFrom = token;
    }
    return remoteKey;
  };
  const sign = (kind, payload) => crypto.createHmac('sha256', keyFor(kind)).update(payload).digest('base64url');

  return {
    issue(kind, days = SESSION_DAYS) {
      const payload = `v1.${kind}.${(Date.now() + days * DAY_MS).toString(36)}.${crypto.randomBytes(9).toString('base64url')}`;
      return `${payload}.${sign(kind, payload)}`;
    },
    // Returns { kind: 'remote' | 'app', id } for a valid, unexpired cookie, else null.
    verify(value) {
      const parts = String(value || '').split('.');
      if (parts.length !== 5 || parts[0] !== 'v1' || !KINDS[parts[1]]) return null;
      const [, kind, expires, id, signature] = parts;
      if (!safeEqual(signature, sign(kind, parts.slice(0, 4).join('.')))) return null;
      if (!(parseInt(expires, 36) > Date.now())) return null;
      return { kind: KINDS[kind], id };
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Set-Cookie value for a session. `secure` should be true whenever the browser reached us over HTTPS.
export function sessionCookie(value, { secure }) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export function clearedCookie({ secure }) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

// ---------- rate limiting ----------

// Allows `limit` events per `windowMs` for each key. take() returns
// { ok: true } or { ok: false, retryAfter } (seconds until the next slot frees up).
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map(); // key -> timestamps within the window, oldest first
  return {
    take(key, at = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => at - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000)) };
      }
      recent.push(at);
      hits.set(key, recent);
      if (hits.size > 2000) {
        for (const [k, times] of hits) if (at - times[times.length - 1] >= windowMs) hits.delete(k);
      }
      return { ok: true };
    },
  };
}
