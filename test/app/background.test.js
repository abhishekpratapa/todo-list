// Background launch, in the real app: `open -g -a Todos --args --background`
// starts everything but opens no window and does not come to the front; asking
// again changes nothing; opening the app in the usual way then shows the window.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import test, { after } from 'node:test';
import { PORT, ask, sandbox, skip, sleep, until } from './support.js';

const portOpen = () => new Promise((resolve) => {
  const probe = net.connect(PORT, '127.0.0.1');
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});

let app;
after(() => app?.cleanup());

test('a background launch starts everything, opens no window and stays out of the way', { skip }, async () => {
  assert.equal(await portOpen(), false, `port ${PORT} must be free for these tests`);
  app = sandbox();
  // A reminder that is already due, to show reminders run without a window.
  fs.mkdirSync(`${app.root}/data`);
  const at = '2026-01-01T10:00:00.000Z';
  fs.writeFileSync(app.dataFile, JSON.stringify({ version: 1, nextId: 2, updatedAt: at, todos: [{
    id: 1, title: 'Due reminder', notes: '', status: 'todo', priority: 'medium', due: null, project: null, tags: [], assignee: 'me', subtasks: [],
    repeat: null, remindAt: at, remindedAt: null, rev: 1, createdBy: 'me', createdAt: at, updatedAt: at, completedAt: null, activity: [],
  }] }));

  app.open(['-g'], ['--background']);
  assert.match(await app.started(), /background=true/);

  const state = await app.state();
  assert.equal(state.window, 'none', 'no window was opened');
  assert.equal(state.active, false, 'the app was not brought to the front');
  assert.equal(state.capture, 'hidden', 'quick capture is loaded and waiting, as usual');
  assert.equal(state.tray, true, 'the menu bar item is there');
  assert.equal(state.socket, app.socketPath);
  assert.equal(app.lines().some((l) => l.startsWith('window: shown')), false);

  // The server is up on both listeners, and the socket is the user's alone.
  assert.equal(fs.statSync(app.socketPath).mode & 0o777, 0o600);
  assert.equal(await portOpen(), true);
  assert.equal((await ask(app.socketPath, 'GET', '/api/v1/tasks')).body.tasks.length, 1);

  // Reminders are being delivered (the first check comes three seconds after launch).
  const reminded = await until(async () => (await ask(app.socketPath, 'GET', '/api/v1/tasks/1')).body.task.remindedAt, 8000);
  assert.ok(reminded, 'the due reminder was delivered with no window open');
  assert.equal((await app.state()).window, 'none', 'and delivering it opened nothing');
});

test('asking again while it is running changes nothing', { skip }, async () => {
  app.open(['-g'], ['--background']);
  assert.ok(await until(() => app.lines().some((l) => l.startsWith('reopen: ignored')), 5000), 'macOS did pass the request on, and it was ignored');
  const state = await app.state();
  assert.equal(state.window, 'none');
  assert.equal(state.active, false);
  assert.equal(app.lines().filter((l) => l.startsWith('started: ')).length, 1, 'no second copy was started');
});

test('opening the app normally afterwards shows the window as usual', { skip }, async () => {
  app.open();
  const state = await until(async () => {
    const now = await app.state();
    return now.window === 'visible' && now;
  }, 8000);
  assert.equal(state.window, 'visible');
  assert.equal(state.active, true);

  // With its window open, a background request still changes nothing.
  app.open(['-g'], ['--background']);
  await sleep(1200);
  assert.equal((await app.state()).window, 'visible');
});

test('quitting stops the server and removes the socket', { skip }, async () => {
  assert.equal(await app.quit(), true, 'the app quit when asked');
  assert.equal(fs.existsSync(app.socketPath), false, 'the socket file is gone');
  assert.equal(await portOpen(), false);
});

test('started the usual way, the window opens as it always has', { skip }, async () => {
  const normal = sandbox();
  try {
    normal.open();
    assert.match(await normal.started(), /background=false/);
    const state = await until(async () => {
      const now = await normal.state();
      return now.window === 'visible' && now;
    }, 8000);
    assert.equal(state.window, 'visible');
  } finally {
    await normal.cleanup();
  }
});
