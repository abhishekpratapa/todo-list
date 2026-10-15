// Support for the tests that run the real app (`npm run test:app`). They start
// it the way the command-line client does, through `open`, as a copy of its own:
// its own settings folder, data file, socket, and port 7441. The installed app,
// its port and its socket are never touched.
//
// The copy runs from a temporary folder, sources included. An app started through
// `open` answers to macOS for itself, and macOS would stop to ask whether this
// unfamiliar app may read the folder the checkout is in (Documents, Desktop...).
//
// These tests put an icon in the Dock for a few seconds, and one of them brings
// the app to the front on purpose. That is why they are not part of `npm test`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const PORT = 7441;

// The Electron this checkout would run, or null if it isn't installed.
const electronBundle = (() => {
  try {
    const binary = createRequire(import.meta.url)('electron'); // .../Electron.app/Contents/MacOS/Electron
    const bundle = path.resolve(binary, '..', '..', '..');
    return bundle.endsWith('.app') && fs.existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
})();
export const skip = process.platform !== 'darwin' ? 'only on a Mac' : !electronBundle && 'needs Electron (npm install)';

// The app as `npm run dist` last packaged it, or null if it hasn't been built here.
export const packagedApp = (() => {
  const built = path.join(REPO, 'dist', 'mac-arm64', 'Todos.app');
  return fs.existsSync(built) ? built : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(check, ms = 15_000) {
  for (const start = Date.now(); Date.now() - start < ms;) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  return check();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// One request to the app: over its socket, given the socket's path, or to its port,
// given PORT. Resolves to { status, body }, or null if nothing answers.
export function ask(to, method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const where = typeof to === 'number' ? { host: '127.0.0.1', port: to } : { socketPath: to, headers: { host: 'todos', ...headers } };
    const req = http.request({ headers, ...where, method, path: pathname, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

// The name of the app in front, or null if it can't be told.
function frontApp() {
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' });
    return (info.match(/"LSDisplayName"="(.+)"/) || info.match(/^"([^"]+)"/))?.[1] ?? null; // the answer comes in either form
  } catch {
    return null;
  }
}

// A place for one copy of the app to live, and the ways to drive it.
//   settings   written to its settings.json before it starts
//   env        extra environment for the app
//   packaged   an app bundle to run instead of this checkout's sources (see packagedApp)
export function sandbox({ settings = {}, env = {}, packaged = null } = {}) {
  // realpath, and kept short: the socket's path has to fit in 103 bytes.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todos-app-')));
  const userData = path.join(root, 'user');
  const dataFile = path.join(root, 'data', 'todos.json');
  const socketPath = path.join(root, 't.sock');
  const log = path.join(root, 'app.log');
  fs.mkdirSync(userData);
  const sources = packaged ? null : path.join(root, 'app');
  if (sources) for (const part of ['electron', 'src', 'public', 'package.json']) fs.cpSync(path.join(REPO, part), path.join(sources, part), { recursive: true });
  // Quiet by default: no global shortcut to fight over, and nothing that pops up.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ captureShortcut: null, dailySummary: false, reminderNotifications: false, claudeNotifications: false, ...settings }));

  // A copy of the bundle with a path of its own, so `open` can never mistake some
  // other running Electron for this one. On APFS the copy is a clone and takes no space.
  const bundle = path.join(root, packaged ? 'Todos.app' : 'Electron.app');
  try {
    execFileSync('/bin/cp', ['-Rc', packaged || electronBundle, bundle], { stdio: 'ignore' });
  } catch {
    execFileSync('/bin/cp', ['-R', packaged || electronBundle, bundle]);
  }

  const inFront = frontApp(); // put back in front at the end, since some tests take its place
  const environment = { TODOS_USER_DATA: userData, TODO_DATA_FILE: dataFile, TODO_PORT: String(PORT), TODOS_SOCKET: socketPath, TODOS_DEBUG: '1', ...env };
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []);
  // Every process of this copy, found by the folder it runs from: a copy that
  // never reported its pid can still be stopped.
  const processes = () => {
    try {
      return execFileSync('/usr/bin/pgrep', ['-f', `${root}/`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
    } catch {
      return []; // pgrep exits 1 when there are none
    }
  };
  let pid = null;
  let launched = false;
  let startsBefore = 0; // "started:" lines already in the log when this copy was last opened

  const app = {
    root, userData, dataFile, socketPath, log, lines, sources, bundle,
    get pid() {
      return pid;
    },

    // Runs `open` for this copy. `flags` go to open itself (e.g. ['-g']), `args` to the app.
    // The environment and the log can only be given to a copy that is being started.
    open(flags = [], args = []) {
      // -n for a packaged copy: the installed app has the same identifier, and must never be taken for this one.
      const setup = launched ? [] : [...(packaged ? ['-n'] : []), ...Object.entries(environment).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--stdout', log, '--stderr', log];
      if (!launched) startsBefore = lines().filter((l) => l.startsWith('started: ')).length;
      launched = true;
      execFileSync('/usr/bin/open', [...flags, '-a', bundle, ...setup, '--args', ...(sources ? [sources] : []), ...args]);
    },

    // Waits until the app answers its health check on the socket, and learns its pid.
    async started() {
      const health = await until(async () => (await ask(socketPath, 'GET', '/health'))?.status === 200);
      if (!health) throw new Error(`the app did not start:\n${lines().join('\n')}`);
      // The log is kept across restarts: the line wanted is the one this start wrote.
      const line = await until(() => lines().filter((l) => l.startsWith('started: '))[startsBefore]);
      pid = Number(line.match(/pid=(\d+)/)[1]);
      return line;
    },

    // What the app says is open right now: { active, window, capture, tray, socket }.
    async state() {
      const seen = lines().filter((l) => l.startsWith('state: ')).length;
      process.kill(pid, 'SIGUSR2');
      const all = await until(() => {
        const found = lines().filter((l) => l.startsWith('state: '));
        return found.length > seen && found;
      }, 5000);
      if (!all) throw new Error('the app did not report its state');
      return JSON.parse(all.at(-1).slice('state: '.length));
    },

    // Chooses a menu item by its id, as if from the menu. Resolves to the app's state
    // right afterwards; what the item goes on to do shows up in the log.
    click(id) {
      fs.writeFileSync(path.join(userData, 'debug-click'), id);
      return app.state();
    },

    // Asks the app to quit and waits until it has. Resolves to whether it went by itself.
    async quit() {
      if (!pid || !alive(pid)) return true;
      process.kill(pid, 'SIGTERM');
      const gone = await until(() => !alive(pid), 10_000);
      if (!gone) process.kill(pid, 'SIGKILL');
      launched = false; // a later open() starts a fresh copy, which must be given its environment again
      return gone;
    },

    async cleanup() {
      await app.quit();
      for (const stray of processes()) {
        try {
          process.kill(stray, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (inFront && frontApp() !== inFront) {
        try {
          execFileSync('/usr/bin/open', ['-a', inFront], { stdio: 'ignore' });
        } catch {
          // a courtesy only
        }
      }
    },
  };
  return app;
}

export { sleep };
