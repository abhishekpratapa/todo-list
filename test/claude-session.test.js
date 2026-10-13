// Start with Claude from the command line: the socket's claude-session routes
// give out exactly what the app's own button starts a session with, record a
// start the way the app does, and are served on the socket only.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { boot, store, tmp } from './support/helpers.js';

// A stand-in for `claude` that writes down where it was run and what it was given.
const STUB = path.join(tmp, 'claude-stub');
const RAN = path.join(tmp, 'claude-ran');
fs.writeFileSync(STUB, `#!/bin/sh\npwd -P > '${RAN}.cwd'\n: > '${RAN}.args'\nfor a in "$@"; do printf '%s\\0' "$a" >> '${RAN}.args'; done\n`, { mode: 0o755 });
process.env.TODOS_CLAUDE_BIN = STUB;
process.env.TODOS_HANDOFF_DRY_RUN = '1'; // launchers are written, never opened

const { createHandoff, startInDesktop } = await import('../electron/handoff.js');
const { tildify } = await import('../src/claude-session.js');
const { createV1 } = await import('../src/api-v1.js');
const REPO = path.resolve(import.meta.dirname, '..');

// The desktop app's side of Start with Claude, with its settings and its folder
// dialog replaced by ones the tests control.
const settings = { handoffTarget: 'terminal', projectFolders: {}, lastFolder: null };
const asked = []; // where the folder dialog was opened, each time it was
let answer = null; // what the "user" picks in it
let saves = 0;
const handoff = createHandoff({
  settings,
  saveSettings: () => { saves += 1; },
  pickFolder: async (todo, startAt) => {
    asked.push(startAt);
    return answer;
  },
  workDir: () => path.join(tmp, 'handoff'),
});
// Counts every use of the shared implementation, to show the port never reaches it.
const used = { session: 0, started: 0 };
const watched = {
  ...handoff,
  session: (...args) => { used.session += 1; return handoff.session(...args); },
  started: (...args) => { used.started += 1; return handoff.started(...args); },
};

const folder = (name) => {
  const dir = path.join(tmp, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Runs the launcher the app wrote for a task, with the stand-in as `claude`.
// Returns what would have been run: { cwd, argv }.
function launched(id, dir = path.join(tmp, 'handoff')) {
  fs.rmSync(`${RAN}.cwd`, { force: true });
  execFileSync('/bin/zsh', [path.join(dir, `todo-${id}.command`)]);
  return { cwd: fs.readFileSync(`${RAN}.cwd`, 'utf8').replace(/\n$/, ''), argv: fs.readFileSync(`${RAN}.args`, 'utf8').split('\0').slice(0, -1) };
}

// What the command-line client would run, from the route's answer.
const fromRoute = (session) => ({ cwd: session.folder, argv: [...session.args, '--', session.prompt] });

let on; // remote access on
let off; // remote access off
before(async () => {
  on = await boot({ handoff: watched, socket: true });
  off = await boot({ handoff: watched, socket: true, enabled: false });
});
after(() => {
  on.close();
  off.close();
});

const claudeSession = (id) => `/api/v1/tasks/${id}/claude-session`;

// ---------- the same thing as the app's button ----------

test('the app\'s button and the socket route start a session with exactly the same things', async () => {
  settings.projectFolders.alpha = folder('alpha');
  const todo = store.createTodo({ title: 'Fix the login page', project: 'alpha' }, 'me');

  const res = await on.sock('GET', claudeSession(todo.id));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['prompt', 'folder', 'args', 'claude']);
  assert.equal(res.body.folder, settings.projectFolders.alpha);
  assert.equal(res.body.claude, STUB);
  assert.deepEqual(res.body.args, ['--name', `Todo #${todo.id}: Fix the login page`, '--allowedTools', 'mcp__todolist']);
  assert.match(res.body.prompt, new RegExp(`^Work on task #${todo.id} from my todo list: Fix the login page\\n\\nStart by calling todo_get`));
  assert.deepEqual((await off.sock('GET', claudeSession(todo.id))).body, res.body, 'the same with remote access off');

  // In Terminal: run the launcher the app writes, and see what `claude` gets.
  assert.deepEqual(await handoff.start(todo, { target: 'terminal' }), { started: true, target: 'terminal', folder: tildify(settings.projectFolders.alpha) });
  assert.deepEqual(launched(todo.id), fromRoute(res.body));

  // In the Claude app: the link carries the same folder and the same prompt.
  const link = new URL((await startInDesktop({ session: handoff.session(todo) })).url);
  assert.equal(link.searchParams.get('folder'), res.body.folder);
  assert.equal(link.searchParams.get('q'), res.body.prompt);
});

test('awkward titles reach claude intact, the same both ways, and never reach the shell', async () => {
  settings.projectFolders.beta = folder('be\'ta "quoted" $HOME');
  const canary = path.join(tmp, 'shell-ran-this');
  const nextId = store.load().nextId;
  const cutAtLineBreak = `${'a'.repeat(79 - `Todo #${nextId + 5}: `.length)}\nrest of the title`; // the 80-character name ends on the line break
  const titles = [
    `Use "double" and 'single' quotes`,
    `$(touch ${canary}) and \`touch ${canary}\``,
    `; touch ${canary} #`,
    `--dangerously-skip-permissions`,
    `Two lines\nin a title, with a trailing \\ backslash \\`,
    cutAtLineBreak,
    'Ünïcödé and 日本語 and 🙂',
    'x'.repeat(300),
  ];
  for (const title of titles) {
    const todo = store.createTodo({ title, project: 'beta' }, 'me');
    const session = (await on.sock('GET', claudeSession(todo.id))).body;
    await handoff.start(todo, { target: 'terminal' });
    assert.deepEqual(launched(todo.id), fromRoute(session), JSON.stringify(title));
    assert.equal(session.args[1].length <= 80, true);
    assert.equal(session.prompt.includes(title), true, 'the whole title is in the prompt');
  }
  assert.equal(fs.existsSync(canary), false, 'nothing in a title was run');
});

const hasBaseline = (() => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v1.6.1'], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('the app\'s button starts exactly what it did in 1.6.1', { skip: !hasBaseline && 'needs the v1.6.1 git tag' }, async () => {
  // 1.6.1's own Start with Claude code, as it was.
  const dir = path.join(tmp, 'v1.6.1');
  fs.mkdirSync(dir);
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', 'v1.6.1', 'electron/handoff.js'], { cwd: REPO }) });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const before = await import(path.join(dir, 'electron', 'handoff.js'));

  settings.projectFolders.gamma = folder('gamma');
  for (const title of ['An ordinary task', `It's "quoted" $(and) \`this\``, 'Two\nlines', 'y'.repeat(200)]) {
    const todo = store.createTodo({ title, project: 'gamma' }, 'me');
    const oldDir = path.join(tmp, 'handoff-1.6.1');
    await before.startInTerminal({ todo, folder: settings.projectFolders.gamma, workDir: oldDir });
    const was = launched(todo.id, oldDir);
    await handoff.start(todo, { target: 'terminal' });
    assert.deepEqual(launched(todo.id), was, JSON.stringify(title));
    assert.equal((await startInDesktop({ session: handoff.session(todo) })).url, (await before.startInDesktop({ todo, folder: settings.projectFolders.gamma })).url);
  }
});

test('after the app starts a session, the task and the settings say what they always said', async () => {
  const dir = folder('delta');
  const todo = store.createTodo({ title: 'Started from the app', project: 'delta' }, 'me');
  const savesBefore = saves;

  // No folder is remembered for the project yet, so the app asks, starting from the last one used.
  settings.lastFolder = folder('gamma');
  answer = dir;
  asked.length = 0;
  assert.deepEqual(await handoff.start(todo, { target: 'desktop' }), { started: true, target: 'desktop', folder: tildify(dir) });
  assert.deepEqual(asked, [settings.projectFolders.gamma]);
  assert.deepEqual([settings.projectFolders.delta, settings.lastFolder, settings.handoffTarget], [dir, dir, 'desktop']);
  assert.equal(saves, savesBefore + 1);

  const after = store.getTodo(todo.id);
  assert.equal(after.assignee, 'claude');
  assert.deepEqual(after.activity.slice(1).map((a) => [a.by, a.kind, a.text, a.via]), [
    ['me', 'event', 'assigned to Claude', undefined],
    ['me', 'comment', `Handed this to Claude in ${tildify(dir)} (the Claude app).`, undefined],
  ]);

  // The second time it does not ask; "Change folder" does; cancelling starts nothing.
  asked.length = 0;
  await handoff.start(todo, { target: 'terminal' });
  assert.equal(asked.length, 0);
  assert.equal(store.getTodo(todo.id).activity.at(-1).text, `Handed this to Claude in ${tildify(dir)} (Terminal).`);
  answer = null;
  assert.deepEqual(await handoff.start(todo, { chooseFolder: true }), { started: false });
  assert.deepEqual(asked, [dir]);
});

// ---------- recording a start from the command line ----------

test('recording a start does what the app does after its own button', async () => {
  const dir = folder('epsilon');
  const todo = store.createTodo({ title: 'Started from a terminal', project: 'epsilon' }, 'me');
  assert.equal((await on.sock('GET', claudeSession(todo.id))).body.folder, null, 'nothing remembered for this project yet');

  const res = await on.sock('POST', claudeSession(todo.id), { body: { folder: dir } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.etag, `"${res.body.task.rev}"`);
  assert.equal(res.body.task.assignee, 'claude');
  assert.deepEqual(res.body.task.activity.slice(1).map((a) => [a.by, a.kind, a.text, a.via]), [
    ['me', 'event', 'assigned to Claude', 'command line'],
    ['me', 'comment', `Started with Claude from terminal in ${tildify(dir)}.`, 'command line'],
  ]);

  // The folder is remembered for the project: the route suggests it, and so does the app.
  assert.deepEqual([settings.projectFolders.epsilon, settings.lastFolder], [dir, dir]);
  assert.equal((await on.sock('GET', claudeSession(todo.id))).body.folder, dir);
  assert.equal(handoff.info().folders.epsilon, tildify(dir));
  asked.length = 0;
  await handoff.start(todo, { target: 'terminal' });
  assert.equal(asked.length, 0, 'the app no longer asks for this project');
  assert.equal(launched(todo.id).cwd, dir);
});

test('a start can be recorded without a folder, and a folder under home is written with a tilde', async () => {
  const plain = store.createTodo({ title: 'No folder given' }, 'me');
  const savesBefore = saves;
  const res = await off.sock('POST', claudeSession(plain.id));
  assert.equal(res.status, 200);
  assert.equal(res.body.task.activity.at(-1).text, 'Started with Claude from terminal.');
  assert.equal(saves, savesBefore, 'nothing to remember');

  // Already Claude's: only the note is added. No project: only the last folder is remembered.
  const again = await on.sock('POST', claudeSession(plain.id), { body: { folder: os.homedir() }, headers: { 'x-todos-client': 'todos 0.1.0' } });
  assert.deepEqual(again.body.task.activity.slice(-1).map((a) => [a.kind, a.text, a.via]), [['comment', 'Started with Claude from terminal in ~.', 'todos 0.1.0']]);
  assert.equal(again.body.task.activity.length, res.body.task.activity.length + 1);
  assert.equal(settings.lastFolder, os.homedir());
  assert.equal(Object.values(settings.projectFolders).includes(os.homedir()), false);
});

test('a start sent twice with the same key is recorded once', async () => {
  const todo = store.createTodo({ title: 'Retried' }, 'me');
  const key = { 'idempotency-key': 'claude-start-0001' };
  const first = await on.sock('POST', claudeSession(todo.id), { headers: key });
  const second = await on.sock('POST', claudeSession(todo.id), { headers: key });
  assert.equal(second.status, 200);
  assert.equal(second.body.task.rev, first.body.task.rev);
  assert.equal(store.getTodo(todo.id).activity.filter((a) => a.text.startsWith('Started with Claude')).length, 1);
});

test('a folder that is not the full path of an existing folder is refused, and nothing is recorded', async () => {
  const todo = store.createTodo({ title: 'Careful', project: 'zeta' }, 'me');
  const file = path.join(tmp, 'a-file');
  fs.writeFileSync(file, '');
  for (const bad of ['work/zeta', '~/zeta', '', '/no/such/folder', file, 7, ['/tmp'], { path: '/tmp' }]) {
    const res = await on.sock('POST', claudeSession(todo.id), { body: { folder: bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, 'invalid');
  }
  assert.equal((await on.sock('POST', claudeSession(todo.id), { body: { folder: tmp, target: 'terminal' } })).body.error.code, 'unknown_field');
  assert.equal((await on.sock('POST', claudeSession(todo.id), { body: '{broken', headers: { 'content-type': 'application/json' } })).body.error.code, 'invalid_json');

  const after = store.getTodo(todo.id);
  assert.equal(after.assignee, 'me');
  assert.equal(after.activity.length, 1);
  assert.equal('zeta' in settings.projectFolders, false);

  for (const method of ['GET', 'POST']) {
    const missing = await on.sock(method, claudeSession(999999));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  }
  const wrongMethod = await on.sock('DELETE', claudeSession(todo.id));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');
});

test('no folder is suggested when none is remembered, or when the remembered one is gone', async () => {
  const noProject = store.createTodo({ title: 'No project' }, 'me');
  assert.equal((await on.sock('GET', claudeSession(noProject.id))).body.folder, null);

  const gone = folder('eta');
  settings.projectFolders.eta = gone;
  const todo = store.createTodo({ title: 'Folder was deleted', project: 'eta' }, 'me');
  assert.equal((await on.sock('GET', claudeSession(todo.id))).body.folder, gone);
  fs.rmdirSync(gone);
  assert.equal((await on.sock('GET', claudeSession(todo.id))).body.folder, null, 'where the app would ask instead');
  asked.length = 0;
  answer = null;
  await handoff.start(todo);
  assert.deepEqual(asked, [gone], 'and the app does ask');
});

test('without the app (npm start) the routes still work, with no folder to suggest', async () => {
  const s = await boot({ socket: true, enabled: false });
  try {
    const todo = store.createTodo({ title: 'No app running', project: 'alpha' }, 'me');
    const session = (await s.sock('GET', claudeSession(todo.id))).body;
    assert.equal(session.folder, null);
    assert.deepEqual(session.args, ['--name', `Todo #${todo.id}: No app running`, '--allowedTools', 'mcp__todolist']);
    const res = await s.sock('POST', claudeSession(todo.id), { body: { folder: tmp } });
    assert.equal(res.body.task.activity.at(-1).text, `Started with Claude from terminal in ${tmp}.`);
  } finally {
    s.close();
  }
});

// ---------- served on the socket only ----------

test('on the port these routes do not exist, for anyone, by any road', async () => {
  settings.projectFolders.alpha = folder('alpha');
  const todo = store.createTodo({ title: 'Only from this Mac', project: 'alpha' }, 'me');
  const usedBefore = { ...used };
  const activityBefore = store.getTodo(todo.id).activity.length;

  const cookie = await on.signIn();
  const localBrowser = await on.signIn(on.local);
  const device = { origin: undefined }; // an API client sends no Origin
  // [who, how they ask, whether they are let in at all]
  const callers = [
    ['another device, not signed in', (m, p, o) => on.tailnet(m, p, o), false],
    ['another device, wrong token', (m, p, o) => on.tailnet(m, p, { ...o, headers: { authorization: 'Bearer wrong', 'x-forwarded-for': '100.64.9.9', ...device } }), false],
    ['another device, with the token', (m, p, o) => on.tailnet(m, p, { ...o, headers: { ...on.bearer(), ...device } }), true],
    ['another device, signed-in browser', (m, p, o) => on.tailnet(m, p, { ...o, headers: { cookie } }), true],
    ['this Mac, not signed in', (m, p, o) => on.local(m, p, o), false],
    ['this Mac, with the token', (m, p, o) => on.local(m, p, { ...o, headers: { ...on.bearer(), ...device } }), true],
    ['this Mac, signed-in browser', (m, p, o) => on.local(m, p, { ...o, headers: { cookie: localBrowser } }), true],
    ['this Mac, the app\'s own window', (m, p, o) => on.local(m, p, { ...o, headers: { cookie: on.appCookie() } }), true],
    ['remote access off, this Mac', (m, p, o) => off.local(m, p, o), true],
    ['remote access off, the app\'s own window', (m, p, o) => off.local(m, p, { ...o, headers: { cookie: off.appCookie() } }), true],
    ['remote access off, relayed by tailscale serve', (m, p, o) => off.tailnet(m, p, { ...o, headers: off.bearer() }), false],
  ];
  for (const [who, ask, letIn] of callers) {
    for (const method of ['GET', 'POST']) {
      const options = method === 'POST' ? { body: { folder: settings.projectFolders.alpha } } : {};
      const res = await ask(method, claudeSession(todo.id), options);
      // A path that has never existed, of the same shape, asked for the same way.
      const nowhere = await ask(method, `/api/v1/tasks/${todo.id}/no-such-thing`, options);
      assert.equal(res.status, nowhere.status, `${who}: ${method}`);
      assert.deepEqual(res.body, nowhere.body, `${who}: ${method}`);
      assert.equal(res.status, letIn ? 404 : nowhere.status, `${who}: ${method}`);
      if (letIn) assert.equal(res.status, 404, `${who}: ${method}`);
      else assert.ok([401, 403].includes(res.status), `${who}: ${method} was refused before any route`);
      const raw = JSON.stringify([res.body, res.headers]);
      assert.equal(raw.includes(settings.projectFolders.alpha) || raw.includes('claude-stub') || raw.includes('Work on task'), false, `${who}: nothing leaks`);
    }
  }
  assert.deepEqual(used, usedBefore, 'Start with Claude was never reached through the port');
  assert.equal(store.getTodo(todo.id).activity.length, activityBefore, 'and nothing was recorded');
  assert.equal(store.getTodo(todo.id).assignee, 'me');

  // The very same requests on the socket are answered.
  assert.equal((await on.sock('GET', claudeSession(todo.id))).status, 200);
  assert.equal((await off.sock('GET', claudeSession(todo.id))).status, 200);
  assert.equal(used.session, usedBefore.session + 2);

  // The dashboard's own button is unchanged: only the app's window may use it.
  assert.equal((await on.tailnet('POST', `/api/todos/${todo.id}/handoff`, { body: {}, headers: { cookie } })).body.code, 'local_only');
});

test('the document marks where each route is served, and matches the server', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'openapi.json'), 'utf8'));
  const routes = createV1({}).routes;
  for (const { method, path: p, where } of routes) {
    assert.equal(doc.paths[p][method.toLowerCase()]['x-todos-only-on'], where, `${method} ${p}`);
  }
  assert.deepEqual(routes.filter((r) => r.where === 'socket').map((r) => `${r.method} ${r.path}`), ['GET /tasks/{id}/claude-session', 'POST /tasks/{id}/claude-session']);
  assert.deepEqual(routes.filter((r) => r.where === 'port').map((r) => `${r.method} ${r.path}`), ['POST /session', 'DELETE /session']);
});
