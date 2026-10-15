// Using another Mac's list: the connection to the Todos app on that Mac (the
// host), over Tailscale, with its access token. While this Mac uses a host, its
// own server passes the window's and the `todos` command's requests on through
// this (see server.js), and the desktop app reads the host's list through it.
// This Mac's own list is left alone meanwhile. Node built-ins only.

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

// The oldest API a host may speak: revision 6 accepts X-Todos-Claude-Session, so a
// Claude session on this Mac is credited with its changes there.
export const MIN_HOST_REVISION = 6;

// Why a host can't be used, or turned a change down. `code` is one of: bad_address,
// unreachable, not_todos, remote_off, not_allowed, unauthorized, too_old, refused,
// token_refused (the host's token changed since this Mac connected).
export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The address as typed ("my-mac.tail1234.ts.net:10000", with or without https://)
// as a URL with nothing after the port. Only HTTPS, as `tailscale serve` provides;
// plain HTTP only for a host on this machine, which is how the tests run one.
export function hostAddress(input) {
  const typed = String(input || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new HostError('bad_address', `"${typed}" is not an address. It looks like https://your-mac.your-tailnet.ts.net, as Remote Access → Copy Address gives it.`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new HostError('bad_address', 'The address is just the Mac\'s name, and its port if it has one, with nothing after it.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new HostError('bad_address', 'The address has to start with https://.');
  }
  return new URL(url.origin);
}

// A short name for the host, for menus and messages: "my-mac" for my-mac.tail1234.ts.net.
export const hostName = (url) => (LOOPBACK.has(url.hostname) ? `localhost:${url.port}` : url.hostname.split('.')[0]);

// What this Mac calls itself in the host's activity log, as its owner named it.
export const thisMac = () => os.hostname().replace(/\.local$/, '');

const REQUEST_HEADERS = ['content-type', 'accept', 'if-match', 'idempotency-key', 'x-todos-claude-session'];
const RESPONSE_HEADERS = ['content-type', 'etag', 'location', 'retry-after', 'allow', 'cache-control'];
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'timeout']);

// The connection to one host.
//   url      from hostAddress()
//   token    the host's access token
//   label    how changes from here are labelled there (this Mac's name)
export function createHost({ url, token, label = thisMac() }) {
  const lib = url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 16 });
  const name = hostName(url);
  const listeners = new Set();
  let state = 'unknown'; // 'ok', 'unreachable' or 'unauthorized': how the last answer went

  const unreachable = () => new HostError('unreachable', `Can't reach Todos on ${name}. Check that the Mac is awake, on Tailscale, and running Todos.`);
  const tokenRefused = () => new HostError('token_refused', `Todos on ${name} no longer accepts this Mac's access token. On this Mac, choose Todos → Reconnect to ${name}… and enter its new one.`);

  function settle(next) {
    if (next === state) return;
    state = next;
    for (const fn of listeners) fn(next);
  }

  // Starts one request to the host. `headers` are the caller's, of which only the
  // ones in REQUEST_HEADERS go on; `as` is added to the label, e.g. "command line".
  function open(method, path, { headers = {}, body = null, as = null, timeout = 30_000 } = {}) {
    const sent = { host: url.host, authorization: `Bearer ${token}`, 'x-todos-client': as ? `${label} (${as})` : label };
    for (const h of REQUEST_HEADERS) if (headers[h] !== undefined) sent[h] = headers[h];
    if (body !== null) sent['content-length'] = Buffer.byteLength(body);
    const req = lib.request({ protocol: url.protocol, hostname: url.hostname, port: url.port, method, path, headers: sent, agent, timeout });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.end(body ?? undefined);
    return req;
  }

  // Notes how an answer went: a refused token means the user has to pair again.
  function noted(res) {
    settle(res.statusCode === 401 ? 'unauthorized' : 'ok');
    return res;
  }

  const host = {
    url,
    name,
    get state() {
      return state;
    },
    // The error for a token the host no longer accepts.
    tokenRefused,
    // Called with the new state whenever it changes.
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // One request, answered as { status, headers, body } with a JSON body parsed.
    // Rejects with a HostError when the host can't be reached.
    request(method, path, { body, headers = {}, as, timeout } = {}) {
      const payload = body === undefined ? null : JSON.stringify(body);
      const all = payload === null ? headers : { 'content-type': 'application/json', ...headers };
      return new Promise((resolve, reject) => {
        const req = open(method, path, { headers: all, body: payload, as, timeout });
        req.on('response', (res) => {
          noted(res);
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = text;
            if (String(res.headers['content-type'] || '').includes('json') && text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                // left as text
              }
            }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          });
          res.on('error', () => reject(unreachable()));
        });
        req.on('error', (e) => {
          if (UNREACHABLE.has(e.code) || /certificate|SSL|TLS/i.test(e.message)) settle('unreachable');
          reject(UNREACHABLE.has(e.code) ? unreachable() : new HostError('unreachable', `Can't reach Todos on ${name}: ${e.message}`));
        });
      });
    },

    // Passes a request on to the host and the host's answer back, as it arrives:
    // a live-update stream stays open until either side closes it. `body` is the
    // request's body, already read. Calls `refuse(status, code, message)` instead
    // of answering when the host can't be reached.
    forward(req, res, { path, body = null, as = null, refuse }) {
      const live = path.endsWith('/events');
      const upstream = open(req.method, path, { headers: req.headers, body: body?.length ? body : null, as, timeout: live ? 60_000 : 30_000 });
      let finished = false;
      upstream.on('response', (answer) => {
        noted(answer);
        // Not passed on as 401: the page would go looking for a sign-in page, and the
        // todos command would ask to be paired. Reconnecting is done here, in the app.
        if (answer.statusCode === 401) {
          answer.resume();
          finished = true;
          return refuse(502, 'host_token_refused', tokenRefused().message);
        }
        const headers = {};
        for (const h of RESPONSE_HEADERS) if (answer.headers[h] !== undefined) headers[h] = answer.headers[h];
        if (live) headers.connection = 'keep-alive';
        res.writeHead(answer.statusCode, headers);
        if (live) res.flushHeaders();
        answer.pipe(res);
        answer.on('end', () => { finished = true; });
        answer.on('error', () => res.destroy());
      });
      upstream.on('error', (e) => {
        if (UNREACHABLE.has(e.code) || /certificate|SSL|TLS/i.test(e.message)) settle('unreachable');
        if (res.headersSent) return res.destroy(); // a live stream that dropped: the page reconnects by itself
        refuse(502, 'host_unreachable', unreachable().message);
      });
      // The page or the command went away before the answer was over: so does the request to the host.
      res.on('close', () => {
        if (!finished) upstream.destroy();
      });
    },

    // Makes sure this really is Todos, new enough, sharing its list with this Mac,
    // and that the token is right. Resolves to the host's /api/v1/info, or rejects
    // with a HostError saying what to do.
    async check() {
      const health = await host.request('GET', '/health', { timeout: 10_000 });
      // A token the host doesn't know is refused before anything else, even here.
      if (health.status === 401) throw new HostError('unauthorized', `${name} didn't accept that access token. Copy it again on that Mac (Remote Access → Copy Access Token).`);
      if (health.status === 403) {
        throw new HostError('remote_off', `Todos on ${name} isn't letting other devices in. On that Mac, turn on Todos → Remote Access → Allow Access from My Other Devices.`);
      }
      if (health.status !== 200 || health.body?.status !== 'ok' || !health.body.apiVersion) {
        throw new HostError('not_todos', `What answers at ${url.origin} isn't Todos. Check the address, including its port (Remote Access → Copy Address on that Mac).`);
      }
      const info = await host.request('GET', '/api/v1/info', { timeout: 10_000 });
      if (info.status === 401) throw new HostError('unauthorized', `${name} didn't accept that access token. Copy it again on that Mac (Remote Access → Copy Access Token).`);
      if (info.status === 403) throw new HostError('not_allowed', `${name} isn't letting this Mac in: ${info.body?.error?.message || 'refused'}`);
      if (info.status !== 200) throw new HostError('not_todos', `${name} answered ${info.status} where Todos would answer 200.`);
      const { version, revision } = info.body.apiVersion;
      if (version !== 1 || revision < MIN_HOST_REVISION) {
        throw new HostError('too_old', `Todos on ${name} is version ${info.body.appVersion}, too old to share its list with this Mac. Update it to the same version as this one.`);
      }
      return info.body;
    },

    // Follows the host's live updates, calling onEvent(name) for each ("hello" on
    // every connection, then "change" or "habits"). Reconnects by itself while the
    // host can't be reached. Returns a function that stops it.
    follow(onEvent) {
      let stopped = false;
      let current = null;
      let wait = 2000;
      let retry = null;
      const again = () => {
        current = null;
        if (stopped) return;
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 60_000);
      };
      function connect() {
        if (stopped) return;
        // However this connection ends (closed, dropped, timed out, refused), try again once.
        let over = false;
        const done = () => {
          if (over) return;
          over = true;
          again();
        };
        current = open('GET', '/api/v1/events', { headers: { accept: 'text/event-stream' }, timeout: 60_000 });
        current.on('response', (res) => {
          noted(res);
          res.on('close', done);
          if (res.statusCode !== 200) return res.resume();
          wait = 2000;
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
              const event = buffer.slice(0, i).match(/^event: (.+)$/m);
              if (event) onEvent(event[1]);
            }
          });
          res.on('error', () => {}); // a dropped stream: 'close' follows
        });
        current.on('error', (e) => {
          if (UNREACHABLE.has(e.code) || /certificate|SSL|TLS/i.test(e.message)) settle('unreachable');
          done();
        });
      }
      connect();
      return () => {
        stopped = true;
        clearTimeout(retry);
        current?.destroy();
      };
    },

    close() {
      listeners.clear();
      agent.destroy();
    },
  };
  return host;
}

// Start with Claude's record of a start (see claude-session.js), written to the
// host: the task becomes Claude's and gets the note, as it would on that Mac. The
// two changes carry keys derived from one, so a retry repeats neither.
export function recordOnHost(host) {
  return async (todo, { comment, key, as }) => {
    const keyed = (suffix) => (key ? { 'idempotency-key': `${key}-${suffix}` } : {});
    const assigned = await host.request('PATCH', `/api/v1/tasks/${todo.id}`, { body: { assignee: 'claude' }, headers: { 'if-match': '*', ...keyed('a') }, as });
    if (assigned.status !== 200) throw new HostError('refused', `${host.name} turned the change down: ${assigned.body?.error?.message || assigned.status}`);
    const noted = await host.request('POST', `/api/v1/tasks/${todo.id}/comments`, { body: { text: comment }, headers: keyed('c'), as });
    if (noted.status !== 201) throw new HostError('refused', `${host.name} turned the note down: ${noted.body?.error?.message || noted.status}`);
    return { todo: noted.body.task, next: null };
  };
}
