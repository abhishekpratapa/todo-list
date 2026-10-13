// Start with Claude, in the real app: the button's route and the socket's
// claude-session route are answered by the same running app, and what the app
// would run in Terminal is exactly what the socket tells the command line to run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PORT, ask, sandbox, skip } from './support.js';

// A stand-in for `claude` that writes down where it was run and what it was given.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todos-claude-')));
const stub = path.join(scratch, 'claude-stub');
const ran = path.join(scratch, 'ran');
fs.writeFileSync(stub, `#!/bin/sh\npwd -P > '${ran}.cwd'\n: > '${ran}.args'\nfor a in "$@"; do printf '%s\\0' "$a" >> '${ran}.args'; done\n`, { mode: 0o755 });
const work = path.join(scratch, 'work');
const elsewhere = path.join(scratch, 'elsewhere');
fs.mkdirSync(work);
fs.mkdirSync(elsewhere);

let app;
after(async () => {
  await app?.cleanup();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('the running app gives the command line exactly what its own button would run', { skip }, async () => {
  app = sandbox({
    settings: { handoffTarget: 'terminal', projectFolders: { work } },
    env: { TODOS_CLAUDE_BIN: stub, TODOS_HANDOFF_DRY_RUN: '1' }, // the launcher is written, and Terminal is not opened
  });
  app.open(['-g'], ['--background']);
  await app.started();

  const title = `Ship it: "quotes", $(nothing run) and \`backticks\``;
  const { task } = (await ask(app.socketPath, 'POST', '/api/v1/tasks', { title, project: 'work' })).body;
  const session = (await ask(app.socketPath, 'GET', `/api/v1/tasks/${task.id}/claude-session`)).body;
  assert.equal(session.folder, work);
  assert.equal(session.claude, stub);

  // The button, as the dashboard presses it.
  const pressed = await ask(PORT, 'POST', `/api/todos/${task.id}/handoff`, { target: 'terminal' });
  assert.equal(pressed.status, 200);
  assert.equal(pressed.body.started, true);
  execFileSync('/bin/zsh', [path.join(app.userData, 'handoff', `todo-${task.id}.command`)]);
  assert.equal(fs.readFileSync(`${ran}.cwd`, 'utf8').trimEnd(), session.folder);
  assert.deepEqual(fs.readFileSync(`${ran}.args`, 'utf8').split('\0').slice(0, -1), [...session.args, '--', session.prompt]);

  const afterButton = (await ask(app.socketPath, 'GET', `/api/v1/tasks/${task.id}`)).body.task;
  assert.equal(afterButton.assignee, 'claude');
  assert.match(afterButton.activity.at(-1).text, /^Handed this to Claude in .+ \(Terminal\)\.$/);
  assert.equal((await app.state()).window, 'none', 'none of this opened a window');

  // A start recorded from the command line is remembered by the app itself.
  const recorded = await ask(app.socketPath, 'POST', `/api/v1/tasks/${task.id}/claude-session`, { folder: elsewhere });
  assert.equal(recorded.status, 200);
  assert.match(recorded.body.task.activity.at(-1).text, /^Started with Claude from terminal in .+\.$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8')).projectFolders.work, elsewhere);
  assert.equal((await ask(app.socketPath, 'GET', `/api/v1/tasks/${task.id}/claude-session`)).body.folder, elsewhere);
  assert.equal(Object.values((await ask(PORT, 'GET', '/api/todos')).body.handoff.folders).length, 1, 'the dashboard shows the same folder next to its button');

  // And on the port, the socket's route is not there.
  assert.equal((await ask(PORT, 'GET', `/api/v1/tasks/${task.id}/claude-session`)).status, 404);
});
