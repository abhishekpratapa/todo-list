// Test support: a throwaway data directory, and helpers that talk to a server the
// way a client on this Mac would, or a device relayed by `tailscale serve` would.
// Nothing here touches the real data file.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// realpath: on macOS the temp folder is reached through a symlink (/var -> /private/var).
export const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todos-test-')));
process.env.TODO_DATA_FILE = path.join(tmp, 'data', 'todos.json'); // must be set before the store module loads
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

export const store = await import('../../src/store.js');
const { startServer } = await import('../../src/server.js');
const { createRemote } = await import('../../src/remote.js');

export const TAILNET = 'test-mac.example.ts.net';
export const OWNER = 'owner@example.com';
export const PHONE_IP = '100.64.0.2';

const isWrite = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
let counter = 0;

// Sends one HTTP request to 127.0.0.1:port with exactly the given headers.
// Resolves to { status, headers, body } where body is parsed JSON when the response is JSON.
export function send(port, method, pathname, { headers = {}, body } = {}) {
  const sent = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  let payload = body;
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    sent['content-type'] ??= 'application/json';
  }
  if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    // agent: false gives every request its own connection, so one test's leftovers can't affect the next.
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = String(res.headers['content-type'] || '').includes('json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && text ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Starts a server on a free port. With `remote: false` it gets no remote-access
// state at all, like plain `npm start`.
export async function boot({ enabled = true, requireOwner = true, handoff = null, remote: withRemote = true } = {}) {
  const tokenFile = path.join(tmp, `token-${++counter}`);
  const remote = withRemote ? createRemote({ tokenFile, enabled, requireOwner }) : null;
  if (remote) {
    remote.hosts.add(TAILNET);
    remote.ownerLogin = OWNER;
    remote.deviceName = async (ip) => (ip === PHONE_IP ? 'Test iPhone' : null);
  }
  const server = await startServer({ port: 0, handoff, remote });
  const { port } = server;
  const localHost = `127.0.0.1:${port}`;

  // A client on this Mac. Writes carry the Origin a same-origin browser page would send.
  const local = (method, p, { headers = {}, ...rest } = {}) =>
    send(port, method, p, { ...rest, headers: { host: localHost, ...(isWrite(method) ? { origin: `http://${localHost}` } : {}), ...headers } });

  // A device on the tailnet, as relayed by `tailscale serve`: the request arrives
  // from 127.0.0.1 with the tailnet Host, forwarding headers, and Tailscale identity.
  const tailnet = (method, p, { headers = {}, ...rest } = {}) =>
    send(port, method, p, {
      ...rest,
      headers: {
        host: TAILNET,
        'x-forwarded-host': TAILNET,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': PHONE_IP,
        'tailscale-user-login': OWNER,
        'tailscale-user-name': 'Owner Name',
        ...(isWrite(method) ? { origin: `https://${TAILNET}` } : {}),
        ...headers,
      },
    });

  // Signs in with the access token and returns the Cookie header value to send back.
  async function signIn(as = tailnet) {
    const res = await as('POST', '/api/v1/session', { body: { token: remote.token } });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
    return String(res.headers['set-cookie'][0]).split(';')[0];
  }

  const bearer = () => ({ authorization: `Bearer ${remote.token}` });
  // The cookie the desktop app gives its own windows.
  const appCookie = () => `todos_session=${remote.appCookie()}`;

  // Opens a live-update stream. Resolves once the response starts.
  function stream(as, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
      const base = as === tailnet
        ? { host: TAILNET, 'x-forwarded-host': TAILNET, 'x-forwarded-proto': 'https', 'x-forwarded-for': PHONE_IP, 'tailscale-user-login': OWNER }
        : { host: localHost };
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { ...base, ...headers }, setHost: false, agent: false }, (res) => {
        const events = [];
        let ended = false;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
            const name = buffer.slice(0, i).match(/^event: (.+)$/m);
            if (name) events.push(name[1]);
          }
        });
        res.on('end', () => { ended = true; });
        res.on('close', () => { ended = true; });
        const until = async (check, ms = 2000) => {
          for (const start = Date.now(); Date.now() - start < ms;) {
            if (check()) return true;
            await new Promise((r) => setTimeout(r, 20));
          }
          return check();
        };
        resolve({
          status: res.statusCode,
          events,
          sawEvent: (name, ms) => until(() => events.includes(name), ms),
          closedByServer: (ms) => until(() => ended, ms),
          close: () => req.destroy(),
        });
        if (res.statusCode !== 200) res.resume();
      });
      req.on('error', reject);
      req.end();
    });
  }

  return { remote, tokenFile, port, localHost, local, tailnet, signIn, bearer, appCookie, stream, close: () => server.close() };
}
