// Using another Mac's list, in the real app: connecting (and being refused with
// a wrong token), the offer to copy this Mac's tasks, the menu bar following the
// host, reminders shown here without being marked delivered there, check-ins from
// the menu bar, staying connected across a restart, reconnecting after the host's
// token changes, and switching back. The host is a server in a process of its own,
// with its own data, reached over plain HTTP on 127.0.0.1. Dialogs are logged and
// answered with their default button; nothing comes to the front.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test, { after } from 'node:test';
import { REPO, ask, sandbox, skip, until } from './support.js';

// ---------- the host ----------

const hostDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todos-host-')));
const hostData = path.join(hostDir, 'data', 'todos.json');
fs.mkdirSync(path.dirname(hostData), { recursive: true });
const runner = path.join(hostDir, 'runner.mjs');
fs.writeFileSync(runner, `
const [root, tokenFile] = process.argv.slice(2);
const { startServer } = await import(root + '/src/server.js');
const { createRemote } = await import(root + '/src/remote.js');
const remote = createRemote({ tokenFile, enabled: true, requireOwner: true });
const server = await startServer({ port: 0, remote });
console.log(JSON.stringify({ port: server.port, token: remote.token }));
for await (const line of (await import('node:readline')).createInterface({ input: process.stdin })) {
  if (line === 'rotate') console.log(JSON.stringify({ token: remote.rotate() }));
}
`);
let hostProc = null;
let hostPort;
let token;
let next;
async function startHost() {
  hostProc = spawn(process.execPath, [runner, REPO, path.join(hostDir, 'token')], { env: { ...process.env, TODO_DATA_FILE: hostData }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: hostProc.stdout });
  next = () => new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));
  ({ port: hostPort, token } = await next());
}

function atHost(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${hostPort}`, authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: hostPort, method, path: p, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const hostTodos = () => JSON.parse(fs.readFileSync(hostData, 'utf8')).todos;
const address = () => `http://127.0.0.1:${hostPort}`;

// ---------- this Mac ----------

let app;
let ownBefore;
const ownList = () => fs.readFileSync(app.dataFile, 'utf8');
const dialogs = () => app.lines().filter((l) => l.startsWith('dialog: ')).map((l) => JSON.parse(l.slice('dialog: '.length)));
const logged = (prefix, ms = 15_000) => until(() => app.lines().find((l) => l.startsWith(prefix)), ms);
// Tries an address and a token as the "Use Another Mac's List" window would, and resolves to what the app said.
async function connect(addr, key) {
  const before = app.lines().filter((l) => l.startsWith('connect: ')).length;
  fs.writeFileSync(path.join(app.userData, 'debug-connect'), JSON.stringify({ address: addr, token: key }));
  await app.state();
  return until(() => app.lines().filter((l) => l.startsWith('connect: '))[before], 20_000);
}
const settingsNow = () => JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8'));

after(async () => {
  await app?.cleanup();
  hostProc?.kill();
  fs.rmSync(hostDir, { recursive: true, force: true });
});

const at = '2026-10-01T10:00:00.000Z';
const todo = (id, extra) => ({
  id, title: `Task ${id}`, notes: '', status: 'todo', priority: 'medium', due: null, project: null, tags: [], assignee: 'me', subtasks: [],
  repeat: null, remindAt: null, remindedAt: null, rev: 1, createdBy: 'me', createdAt: at, updatedAt: at, completedAt: null, activity: [], ...extra,
});

test('connecting: a wrong token is refused; the right one is checked, used, and this Mac\'s tasks are offered to copy', { skip }, async () => {
  await startHost();
  await atHost('POST', '/api/v1/tasks', { title: 'Already on the host' });

  app = sandbox({ env: { TODOS_DEBUG_DIALOGS: '1' } });
  fs.mkdirSync(path.dirname(app.dataFile), { recursive: true });
  fs.writeFileSync(app.dataFile, JSON.stringify({ version: 1, nextId: 4, updatedAt: at, todos: [
    todo(1, { title: 'Mine, open', subtasks: [{ id: 1, title: 'step', done: true }] }),
    todo(2, { title: 'Mine, in progress', status: 'in_progress' }),
    todo(3, { title: 'Mine, done', status: 'done', completedAt: at }),
  ] }, null, 2));
  ownBefore = ownList();
  app.open(['-g'], ['--background']);
  await app.started();
  const first = await app.state();
  assert.equal(first.host, null);
  assert.equal(first.listMenu.useHost, true);

  assert.match(await connect(address(), 'not-the-token'), /^connect: error .*didn.t accept that access token/);
  assert.equal((await app.state()).host, null, 'nothing changed');

  assert.equal(await connect(address(), token), 'connect: ok');
  const offer = await until(() => dialogs().find((d) => /^Copy this Mac/.test(d.message)));
  assert.match(offer.message, /Copy this Mac’s 2 open tasks to /, 'the done one is not offered');
  assert.ok(await logged('copied: 2, failed: 0'));
  const titles = hostTodos().map((t) => t.title);
  assert.ok(titles.includes('Mine, open') && titles.includes('Mine, in progress') && !titles.includes('Mine, done'));
  assert.deepEqual(hostTodos().find((t) => t.title === 'Mine, open').subtasks.map((s) => s.done), [true]);
  assert.equal(ownList(), ownBefore, 'this Mac\'s own list keeps its tasks, unchanged');

  const state = await until(async () => {
    const s = await app.state();
    return s.host?.todos >= 3 && s;
  });
  assert.equal(state.host.state, 'ok');
  assert.equal(state.listMenu.useOwn, true);
  assert.ok(state.trayLabels.some((l) => /^List on /.test(l)), 'the menu bar says whose list it is');
  assert.ok(state.trayLabels.some((l) => l.startsWith('Already on the host')));
  // The window's server and the todos command answer from the host's list.
  assert.deepEqual((await ask(app.socketPath, 'GET', '/api/v1/tasks')).body.tasks.map((t) => t.title).sort(), hostTodos().filter((t) => t.status !== 'done').map((t) => t.title).sort());
  assert.equal(fs.statSync(path.join(app.userData, 'host-access-token')).mode & 0o777, 0o600, 'its token is kept for the owner only');
});

test('the host\'s changes reach the menu bar, and a reminder there is shown here once without being marked delivered there', { skip }, async () => {
  const remindAt = new Date(Date.now() + 2000).toISOString();
  const { task } = (await atHost('POST', '/api/v1/tasks', { title: 'Reminder from the host', remindAt })).body;
  assert.ok(await until(async () => (await app.state()).trayLabels.some((l) => l.startsWith('Reminder from the host'))), 'a change there shows up here by itself');
  // Reminders are looked at every 20 seconds.
  assert.ok(await until(() => settingsNow().hostReminded.includes(`${task.id}@${task.remindAt}`), 30_000), 'shown here');
  assert.equal(hostTodos().find((t) => t.id === task.id).remindedAt, null, 'and left for the host to mark as delivered');
});

test('a habit checked in from the menu bar is checked in on the host', { skip }, async () => {
  const { habit } = (await atHost('POST', '/api/v1/habits', { name: 'Water the plants', schedule: { kind: 'daily', slots: [{ name: '' }] } })).body;
  assert.ok(await until(async () => (await app.state()).trayLabels.some((l) => l.startsWith('Water the plants'))));
  await app.click(`habit-${habit.id}`);
  assert.ok(await until(async () => (await atHost('GET', `/api/v1/habits/${habit.id}`)).body.habit.today.state === 'done', 10_000), 'checked in on the host');
  assert.ok(await until(async () => !(await app.state()).trayLabels.some((l) => l.startsWith('Water the plants'))), 'and no longer listed as left to do');
});

test('after a restart it is still on the host\'s list', { skip }, async () => {
  assert.equal(await app.quit(), true);
  app.open(['-g'], ['--background']);
  await app.started();
  const state = await until(async () => {
    const s = await app.state();
    return s.host?.reached && s;
  });
  assert.equal(state.host.state, 'ok');
  assert.ok((await ask(app.socketPath, 'GET', '/api/v1/tasks')).body.tasks.some((t) => t.title === 'Already on the host'));
});

test('when the host\'s token changes, this Mac says so, and reconnecting is not offered the copy again', { skip }, async () => {
  hostProc.stdin.write('rotate\n');
  ({ token } = await next());
  const refused = await until(async () => {
    const s = await app.state();
    return s.host?.state === 'unauthorized' && s;
  }, 20_000);
  assert.ok(refused, 'it noticed');
  assert.ok(refused.trayLabels.some((l) => /needs its new access token/.test(l)));
  const offers = dialogs().filter((d) => /^Copy this Mac/.test(d.message)).length;

  assert.equal(await connect(address(), token), 'connect: ok');
  assert.ok(await until(async () => (await app.state()).host?.state === 'ok'));
  assert.equal(dialogs().filter((d) => /^Copy this Mac/.test(d.message)).length, offers, 'asked only once');
});

test('switching back to this Mac\'s own list', { skip }, async () => {
  await app.click('use-own-list');
  const state = await until(async () => {
    const s = await app.state();
    return s.host === null && s;
  });
  assert.equal(state.listMenu.useHost, true);
  assert.equal(fs.existsSync(path.join(app.userData, 'host-access-token')), false, 'the other Mac\'s token is gone');
  assert.equal(settingsNow().host, null);
  const mine = (await ask(app.socketPath, 'GET', '/api/v1/tasks?status=all')).body.tasks.map((t) => t.title).sort();
  assert.deepEqual(mine, ['Mine, done', 'Mine, in progress', 'Mine, open']);
  assert.equal(ownList(), ownBefore, 'this Mac\'s own list is as it was');
});

test('Use Another Mac\u2019s List opens its window, whose page can hand the app an address and a token', { skip }, async () => {
  await app.click('use-host'); // this brings the copy to the front, as opening a window does
  assert.equal(await logged('connect window: '), 'connect window: function Use Another Mac’s List');
  assert.equal((await app.state()).connect, 'visible');
});
