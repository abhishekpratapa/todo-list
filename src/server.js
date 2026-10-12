#!/usr/bin/env node
// Local dashboard server: static UI + JSON API + server-sent events that fire
// whenever the data file changes (including writes from Claude sessions).
// Run directly with `npm start`, or embedded by the Electron app via startServer().

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DATA_FILE, PORT, TodoError,
  load, getTodo, createTodo, updateTodo, deleteTodo, summarize, sortTodos, watchStore,
} from './store.js';
import { parseQuickAdd } from './quickadd.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new TodoError('Expected Content-Type: application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new TodoError('Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new TodoError('Invalid JSON body');
  }
}

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

// Starts the server on 127.0.0.1:port (0 = any free port).
// Resolves to { url, port, close() }; rejects with the listen error (e.g. EADDRINUSE).
//
// `handoff` is supplied by the desktop app: { start(todo, options), info() }. It
// starts a Claude session on a task; without it (plain `npm start`) the dashboard
// hides the button and the endpoint answers 501.
export function startServer({ port = PORT, handoff = null } = {}) {
  let allowedHosts = new Set();
  let lastVersion = load().version;
  const clients = new Set();

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
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ version })}\n\n`);
  }

  const unwatch = watchStore(broadcast);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  // ---------- routes ----------

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/api/health') return json(res, 200, { ok: true, app: 'todos', dataFile: DATA_FILE });

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: lastVersion })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/parse' && req.method === 'POST') return json(res, 200, parseQuickAdd((await readJson(req)).text));

    if (p === '/api/todos') {
      if (req.method === 'GET') return json(res, 200, { ...snapshot(), handoff: handoff ? handoff.info() : null });
      if (req.method === 'POST') return json(res, 201, createTodo(expandQuick(await readJson(req)), 'me'));
    }

    const h = p.match(/^\/api\/todos\/(\d+)\/handoff$/);
    if (h && req.method === 'POST') {
      if (!handoff) return json(res, 501, { error: 'Starting a Claude session is only available in the Todos app.' });
      return json(res, 200, await handoff.start(getTodo(h[1]), await readJson(req)));
    }

    const m = p.match(/^\/api\/todos\/(\d+)$/);
    if (m) {
      if (req.method === 'PATCH') return json(res, 200, updateTodo(m[1], await readJson(req), 'me'));
      if (req.method === 'DELETE') return json(res, 200, deleteTodo(m[1]));
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : path.normalize(p));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Reject DNS-rebinding attempts: only answer requests addressed to localhost.
    if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof TodoError) return json(res, e.message.startsWith('No todo') ? 404 : 400, { error: e.message });
      console.error(e);
      json(res, 500, { error: 'Internal error' });
    }
  });

  function close() {
    unwatch();
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    server.close();
  }

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      close();
      reject(e);
    });
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, close });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(
    ({ url }) => {
      console.log(`Todo dashboard running at ${url}`);
      console.log(`Data file: ${DATA_FILE}`);
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
