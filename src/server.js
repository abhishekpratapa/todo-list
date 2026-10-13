#!/usr/bin/env node
// Local dashboard server: static UI + JSON API + server-sent events that fire
// whenever the data file changes (including writes from Claude sessions).
// Run directly with `npm start`, or embedded by the Electron app via startServer().
//
// The server always listens on 127.0.0.1 only. With remote access off it behaves
// as it did in 1.3.0: no sign-in, local requests only. With remote access on
// (see remote.js), `tailscale serve` can relay requests from the user's other
// devices, and then every request must be authenticated, including local ones,
// because relayed requests also arrive from 127.0.0.1.
//
// Given a `socketPath`, it also listens on a Unix domain socket that only the
// user can open (see socket.js). That listener serves /health and /api/v1, with
// no sign-in, whether remote access is on or off. It is how the `todos` command
// reaches the app on this Mac, and the only place local-only routes are served.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DATA_FILE, PORT, TodoError, NotFoundError, ConflictError,
  load, getTodo, createTodo, updateTodo, deleteTodo, summarize, sortTodos, watchStore,
} from './store.js';
import { parseQuickAdd } from './quickadd.js';
import { habitsState, watchHabits } from './habits.js';
import { COOKIE, bearerToken, parseCookies, rateLimiter } from './auth.js';
import { json, readJson } from './http.js';
import { createV1, health } from './api-v1.js';
import { createSessions } from './claude-session.js';
import { listenOnSocket, socketPath as defaultSocketPath } from './socket.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Headers a reverse proxy adds. `tailscale serve` sets the first three and the Tailscale ones.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-funnel-request'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// What someone who has not signed in may fetch while remote access is on: the
// sign-in page and its assets, and the icons a phone needs to show a home-screen app.
const PUBLIC_FILES = new Set(['/login', '/login.js', '/styles.css', '/login.css', '/manifest.webmanifest', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']);
const isPublic = (method, p) =>
  (method === 'GET' && (PUBLIC_FILES.has(p) || p === '/health' || p === '/api/v1/health')) || (method === 'POST' && p === '/api/v1/session');

// Sent on every response while remote access is on.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const MAX_STREAMS = 32; // live-update connections, across all devices

// A body with `quick: "Renew passport fri !high #personal"` is parsed as one-line
// entry. Whatever the line specifies wins over the other fields in the body.
function expandQuick(body) {
  if (typeof body.quick !== 'string') return body;
  const { quick, ...rest } = body;
  const { title, fields } = parseQuickAdd(quick);
  return { ...rest, ...fields, title };
}

function snapshot() {
  const db = load();
  return { version: db.version, updatedAt: db.updatedAt, todos: sortTodos(db.todos), summary: summarize(db.todos) };
}

const withoutPort = (host) => host.replace(/:\d+$/, '');
const cleanLabel = (v) => String(v || '').replace(/[^\w .,()'’-]/g, '').trim().slice(0, 40);

// Starts the server on 127.0.0.1:port (0 = any free port).
// Resolves to { url, port, socket, socketProblem, close() }; rejects with the
// listen error (e.g. EADDRINUSE).
//
// `socketPath` is where to open the local socket; leave it out for none. Failing
// to open it does not stop the server: `socket` is then null and `socketProblem`
// is a SocketError saying why.
//
// `handoff` is supplied by the desktop app: { start(todo, options), info() }. It
// starts a Claude session on a task; without it (plain `npm start`) the dashboard
// hides the button and the endpoint answers 501. It also carries { session(todo),
// started(todo, options) } for the socket's claude-session routes (see
// claude-session.js); without the app those work too, with no folder to suggest.
//
// `remote` is the remote-access state from createRemote(). Without it, or while
// it is disabled, there is no sign-in and nothing new is served.
export function startServer({ port = PORT, handoff = null, remote = null, socketPath = null } = {}) {
  let localHosts = new Set();
  let lastVersion = load().version;
  const streams = new Map(); // open live-update responses -> kind of session that opened them

  const authFailures = rateLimiter({ limit: 10, windowMs: 5 * 60_000 }); // wrong tokens, per client
  const writes = rateLimiter({ limit: 120, windowMs: 60_000 }); // changes, per signed-in client

  // ---------- live updates ----------

  function broadcast() {
    let version;
    try {
      version = load().version;
    } catch {
      return; // unreadable right now; the next change event will catch up
    }
    if (version === lastVersion) return;
    lastVersion = version;
    for (const res of streams.keys()) res.write(`event: change\ndata: ${JSON.stringify({ version })}\n\n`);
  }

  const unwatch = watchStore(broadcast);

  // Habits change on their own, in their own file, and are announced under their
  // own name, so a client that knows nothing of habits never reloads the todo
  // list for one. `version` is still the todo list's, unchanged, for clients that
  // read that number from every event.
  let lastHabits = habitsState();
  const unwatchHabits = watchHabits(() => {
    const habits = habitsState();
    if (!habits || (habits.version === lastHabits?.version && habits.updatedAt === lastHabits?.updatedAt)) return;
    lastHabits = habits;
    for (const res of streams.keys()) res.write(`event: habits\ndata: ${JSON.stringify({ version: lastVersion, habits: habits.version })}\n\n`);
  });
  const heartbeat = setInterval(() => {
    for (const res of streams.keys()) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  function openStream(req, res, ctx) {
    if (ctx.remote && streams.size >= MAX_STREAMS) {
      return refuse(req, res, 503, 'busy', 'Too many live connections. Close a Todos tab on another device and try again.');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: lastVersion })}\n\n`);
    streams.set(res, ctx.session.kind);
    req.on('close', () => streams.delete(res));
  }

  // ---------- admission ----------

  // A refusal in the shape the caller expects: /api/v1 uses { error: { code, message } },
  // the dashboard's own routes use { error: message, code }.
  function refuse(req, res, status, code, message, headers = {}) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    json(res, status, req.url.startsWith('/api/v1/') ? { error: { code, message } } : { error: message, code });
    return null;
  }

  // Counts a wrong token against the client and answers 401, or 429 once it has sent too many.
  function refuseBadToken(req, res, ip) {
    const slot = authFailures.take(ip);
    if (!slot.ok) return refuse(req, res, 429, 'rate_limited', 'Too many failed attempts. Try again later.', { 'Retry-After': slot.retryAfter });
    return refuse(req, res, 401, 'unauthorized', 'That access token is not valid.');
  }

  // Decides whether a request may proceed. Returns its context, or null after
  // answering it with a refusal.
  function admit(req, res, p) {
    const host = String(req.headers.host || '').toLowerCase();
    const proxied = PROXY_HEADERS.some((h) => h in req.headers);

    if (!remote?.enabled) {
      // The 1.3.0 rules, plus one: nothing relayed by a proxy is answered, so a leftover
      // `tailscale serve` mapping can never reach the server while it has no sign-in.
      if (proxied || !localHosts.has(req.headers.host)) {
        json(res, 403, { error: 'Forbidden host' });
        return null;
      }
      return { remote: false, session: { kind: 'app', id: 'local' }, proxied: false, secure: false, ip: 'local', bodyLimit: 1_000_000 };
    }

    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    // Tailscale Funnel would mean the public internet. Todos is for the tailnet only.
    if ('tailscale-funnel-request' in req.headers) return refuse(req, res, 403, 'forbidden', 'Todos is not available over Tailscale Funnel.');

    // The Host must be this machine: localhost for direct requests, the Mac's tailnet
    // name for relayed ones. Anything else is DNS rebinding or a misrouted request.
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').toLowerCase();
    const publicHost = forwardedHost || host;
    const hostOk = proxied
      ? remote.hosts.has(withoutPort(publicHost)) && (localHosts.has(host) || remote.hosts.has(withoutPort(host)))
      : localHosts.has(host);
    if (!hostOk) return refuse(req, res, 403, 'forbidden_host', 'Forbidden host');

    // Optionally, relayed requests must come from the Mac owner's own Tailscale account.
    // Tailscale sets this header itself and overwrites anything a client sends.
    if (proxied && remote.requireOwner) {
      const login = String(req.headers['tailscale-user-login'] || '').toLowerCase();
      if (!remote.ownerLogin || login !== remote.ownerLogin.toLowerCase()) {
        return refuse(req, res, 403, 'forbidden_user', 'This Tailscale account is not allowed to use Todos on this Mac.');
      }
    }

    const secure = req.headers['x-forwarded-proto'] === 'https';
    const ctx = {
      remote: true,
      session: null,
      proxied,
      secure,
      ip: proxied ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'tailnet' : 'local',
      origin: `${secure ? 'https' : 'http'}://${publicHost}`,
      bodyLimit: 256_000,
      refuseBadToken: () => refuseBadToken(req, res, ctx.ip),
    };

    // Who is asking? API clients send the token; browsers send the cookie they got at sign-in.
    const bearer = bearerToken(req);
    if (bearer !== null) {
      if (!remote.checkToken(bearer)) return ctx.refuseBadToken();
      ctx.session = { kind: 'api', id: `api:${ctx.ip}` };
    } else {
      const session = remote.verify(parseCookies(req.headers.cookie)[COOKIE]);
      // The app's own cookie only counts for requests made directly on this Mac.
      if (session && !(session.kind === 'app' && proxied)) ctx.session = session;
    }

    // Cross-site protection for anything that changes state: a browser must be on our
    // own origin. Only token-bearing API clients (and a sign-in from a script) may omit Origin.
    if (!SAFE_METHODS.has(req.method)) {
      const { origin } = req.headers;
      const site = req.headers['sec-fetch-site'];
      const mayOmitOrigin = ctx.session?.kind === 'api' || (!ctx.session && isPublic(req.method, p));
      if ((origin ? origin !== ctx.origin : !mayOmitOrigin) || (site && site !== 'same-origin' && site !== 'none')) {
        return refuse(req, res, 403, 'forbidden_origin', 'Cross-site requests are not allowed.');
      }
    }

    if (!ctx.session && !isPublic(req.method, p)) {
      if (p.startsWith('/api/')) return refuse(req, res, 401, 'unauthorized', 'Sign in required.');
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); // a page: go sign in
      res.end();
      return null;
    }

    // Changes are rate limited per signed-in client. The app's own windows are exempt.
    if (ctx.session && ctx.session.kind !== 'app' && !SAFE_METHODS.has(req.method)) {
      const slot = writes.take(ctx.session.id);
      if (!slot.ok) return refuse(req, res, 429, 'rate_limited', 'Too many changes in a short time. Try again shortly.', { 'Retry-After': slot.retryAfter });
    }
    return ctx;
  }

  // The same decision for the socket. Whoever could open the file is the user, so
  // there is no sign-in, no Host to check and no browser to guard against. Nothing
  // relayed is answered here either: if a proxy is ever pointed at the socket
  // file, what it forwards still gets nothing.
  function admitLocal(req, res) {
    if (PROXY_HEADERS.some((h) => h in req.headers)) {
      json(res, 403, { error: { code: 'forbidden', message: 'Relayed requests are not answered on the local socket.' } });
      return null;
    }
    return { local: true, remote: false, session: { kind: 'local', id: 'socket' }, proxied: false, secure: false, ip: 'local', bodyLimit: 1_000_000 };
  }

  // The label recorded with a change so the activity log can say where it came
  // from. Undefined for the Mac app itself, which stays unlabelled as before.
  async function viaLabel(req, ctx) {
    if (ctx.local) return cleanLabel(req.headers['x-todos-client']) || 'command line';
    if (!ctx.remote || ctx.session.kind === 'app') return undefined;
    const named = cleanLabel(req.headers['x-todos-client']); // API clients may name themselves
    if (named) return named;
    if (ctx.proxied) {
      const device = await Promise.resolve(remote.deviceName(ctx.ip)).catch(() => null);
      return cleanLabel(device) || cleanLabel(req.headers['tailscale-user-name']) || 'another device';
    }
    return ctx.session.kind === 'api' ? 'API on this Mac' : 'browser on this Mac';
  }

  const v1 = createV1({ remote, openStream, viaLabel, sessions: handoff?.session && handoff?.started ? handoff : createSessions() });

  // ---------- routes ----------

  function sendFile(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  async function route(req, res, ctx, url) {
    const p = url.pathname;
    const isApp = ctx.session?.kind === 'app'; // the Mac app's own windows (or anything local while remote access is off)

    // Says the server is up and what it speaks, to anyone admit() let through. It
    // needs no sign-in and says nothing about the list. The one route added to what
    // 1.3.0 served while remote access is off.
    if (p === '/health' && req.method === 'GET') return json(res, 200, health());

    if (ctx.remote) {
      if (p.startsWith('/api/v1/')) return v1(req, res, ctx, url);
      if (p === '/login') {
        if (ctx.session) {
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
      }
    }

    // The dashboard's own API. Unchanged since 1.3.0 except for additions: a todo's
    // `rev`, an optional `rev` on PATCH/DELETE, and labels on changes from other devices.

    if (p === '/api/health') return json(res, 200, isApp ? { ok: true, app: 'todos', dataFile: DATA_FILE } : { ok: true, app: 'todos' });

    if (p === '/api/events') return openStream(req, res, ctx);

    if (p === '/api/parse' && req.method === 'POST') return json(res, 200, parseQuickAdd((await readJson(req, ctx.bodyLimit)).text));

    if (p === '/api/todos') {
      if (req.method === 'GET') {
        const body = { ...snapshot(), handoff: handoff && isApp ? handoff.info() : null };
        if (ctx.remote) body.session = ctx.session.kind;
        return json(res, 200, body);
      }
      if (req.method === 'POST') {
        const input = expandQuick(await readJson(req, ctx.bodyLimit));
        return json(res, 201, createTodo(input, 'me', { via: await viaLabel(req, ctx) }));
      }
    }

    // Starting a Claude session runs programs on this Mac, so only the app itself may ask for it.
    const h = p.match(/^\/api\/todos\/(\d+)\/handoff$/);
    if (h && req.method === 'POST') {
      if (!handoff) return json(res, 501, { error: 'Starting a Claude session is only available in the Todos app.' });
      if (!isApp) return refuse(req, res, 403, 'local_only', 'Starting a Claude session is only possible in the Todos app on the Mac itself.');
      return json(res, 200, await handoff.start(getTodo(h[1]), await readJson(req, ctx.bodyLimit)));
    }

    const m = p.match(/^\/api\/todos\/(\d+)$/);
    if (m) {
      if (req.method === 'PATCH') {
        const { rev, ...patch } = await readJson(req, ctx.bodyLimit);
        return json(res, 200, updateTodo(m[1], patch, 'me', { ifRev: rev, via: await viaLabel(req, ctx) }));
      }
      if (req.method === 'DELETE') return json(res, 200, deleteTodo(m[1], { ifRev: url.searchParams.get('rev') }));
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : path.normalize(p));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
    sendFile(res, file);
  }

  // The socket serves the health check and the versioned API, and nothing else:
  // no dashboard pages, and none of the dashboard's own routes.
  async function routeLocal(req, res, ctx, url) {
    const p = url.pathname;
    if (p === '/health' && req.method === 'GET') return json(res, 200, health());
    if (p.startsWith('/api/v1/')) return v1(req, res, ctx, url);
    return json(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
  }

  // Answers one request. The two listeners differ only in who they let in
  // (`admitting`) and what they serve (`routing`).
  const answer = (admitting, routing) => async (req, res) => {
    let url = null;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // answered below, after the same checks every request gets
    }
    const ctx = admitting(req, res, url ? url.pathname : '');
    if (!ctx) return;
    if (!url && ctx.local) return json(res, 400, { error: { code: 'bad_request', message: 'Bad request' } });
    if (!url) return json(res, ctx.remote ? 400 : 500, { error: ctx.remote ? 'Bad request' : 'Internal error' });
    try {
      await routing(req, res, ctx, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      if ((ctx.remote || ctx.local) && e.code === 'too_large') {
        // We stopped reading partway through the upload: answer, then hang up rather
        // than leave a half-read request on a connection that might be reused.
        const { socket } = req;
        res.setHeader('Connection', 'close');
        res.once('finish', () => socket?.destroy());
      }
      if (ctx.local || url.pathname.startsWith('/api/v1/')) return v1.fail(res, e);
      if (e instanceof ConflictError) return json(res, 409, { error: e.message, code: 'conflict', current: e.current });
      if (e instanceof NotFoundError) return json(res, 404, { error: e.message });
      if (e instanceof TodoError) return json(res, 400, { error: e.message });
      console.error(e);
      json(res, 500, { error: 'Internal error' });
    }
  };

  const server = http.createServer(answer(admit, route));
  const local = socketPath ? http.createServer(answer(admitLocal, routeLocal)) : null;

  // Tighter time limits while other devices can connect; Node's defaults otherwise.
  function applyLimits() {
    const on = !!remote?.enabled;
    server.headersTimeout = on ? 15_000 : 60_000;
    server.requestTimeout = on ? 30_000 : 300_000;
  }

  // When the setting is switched or the token rotated, live connections from other
  // devices are dropped. Their pages reconnect and are checked again. Ones on the
  // socket never depended on either, so they stay.
  const unsubscribe = remote?.onChange(() => {
    applyLimits();
    for (const [res, kind] of streams) {
      if (kind !== 'app' && kind !== 'local') {
        streams.delete(res);
        res.end();
      }
    }
  });

  function close() {
    unwatch();
    unwatchHabits();
    unsubscribe?.();
    clearInterval(heartbeat);
    for (const res of streams.keys()) res.end();
    streams.clear();
    for (const listener of [server, local]) {
      listener?.close(); // for the socket, this also removes its file
      listener?.closeAllConnections?.();
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      close();
      reject(e);
    });
    server.listen(port, '127.0.0.1', async () => {
      const actual = server.address().port;
      localHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
      applyLimits();
      // The socket comes second, so a copy that could not get its port never touches it.
      const socketProblem = local ? await listenOnSocket(local, socketPath).then(() => null, (e) => e) : null;
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, socket: local && !socketProblem ? socketPath : null, socketProblem, close });
    });
  });
}

// Started directly (`node src/server.js`), as opposed to imported. Symlinks are
// resolved first, so it also works when reached through a linked folder.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  // Run this way, the local socket is only opened when TODOS_SOCKET says where, so
  // a development server never takes the app's own socket by accident.
  startServer({ socketPath: process.env.TODOS_SOCKET ? defaultSocketPath() : null }).then(
    ({ url, socket, socketProblem, close }) => {
      console.log(`Todo dashboard running at ${url}`);
      console.log(`Data file: ${DATA_FILE}`);
      if (socket) console.log(`Local socket: ${socket}`);
      if (socketProblem) console.error(`No local socket: ${socketProblem.message}`);
      // Closing removes the socket file, so stopping with Ctrl-C leaves nothing behind.
      const stop = () => {
        close();
        process.exit(0);
      };
      if (socket) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    },
    (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Is the Todos app (or another dashboard server) already running?`);
        process.exit(1);
      }
      throw e;
    },
  );
}
