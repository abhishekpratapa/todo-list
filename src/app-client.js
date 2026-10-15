// How the MCP server reaches the list when this Mac uses another Mac's: through
// the Todos app on this Mac, over its local socket. The app passes everything on
// to that Mac (see server.js and host.js) and holds its access token, so the MCP
// server never needs it. Node built-ins only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { socketPath } from './socket.js';
import { DATA_FILE } from './store.js';

// Where the desktop app keeps its settings: TODOS_USER_DATA, or the folder its data
// folder is in (~/Library/Application Support/Todos, holding data/todos.json). A
// copy run with a data file of its own (TODO_DATA_FILE) so never reads the app's.
export const appSettingsFile = () => path.join(process.env.TODOS_USER_DATA || path.dirname(path.dirname(DATA_FILE)), 'settings.json');

// The other Mac whose list this Mac uses ({ url, name }), or null for this Mac's own.
// Read each time, so a switch in the app takes effect without restarting Claude.
export function hostInUse() {
  try {
    return JSON.parse(fs.readFileSync(appSettingsFile(), 'utf8')).host || null;
  } catch {
    return null;
  }
}

// The app this program is part of, when it runs from inside Todos.app (as the MCP
// server does, run by the app's own binary), or null.
function ownBundle() {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `headers` go with every request: who is asking.
export function createAppClient({ socket = socketPath(), headers = {} } = {}) {
  function request(method, p, body, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('This Mac has no place for the Todos app\'s socket.'));
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const sent = { host: 'todos', ...headers, ...extra, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) };
      const req = http.request({ socketPath: socket, method, path: p, headers: sent, agent: false, timeout: 30_000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { error: { message: text } };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error('The Todos app took too long to answer.')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  const answering = () => request('GET', '/health').then((r) => r.status === 200, () => false);

  return {
    request,
    // Makes sure the app is running, starting it in the background if it isn't
    // (as the todos command does). Resolves to whether it is answering.
    async ready() {
      if (await answering()) return true;
      const bundle = ownBundle();
      if (!bundle) return false;
      await new Promise((resolve) => execFile('/usr/bin/open', ['-g', '-a', bundle, '--args', '--background'], () => resolve()));
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (await answering()) return true;
      }
      return false;
    },
  };
}
