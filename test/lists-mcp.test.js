// Sorting, filters with several values and the Today view through Claude: the
// todo_list arguments and the todo_today tool, in a Claude session's own MCP
// process on the same data file. The rules themselves are tested in query.test.js;
// another Mac's list in client-mode.test.js.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import test, { after, before } from 'node:test';
import { store, tmp } from './support/helpers.js';

const REPO = path.resolve(import.meta.dirname, '..');

// A Claude session's MCP server: its own process, on the same data file.
function claude() {
  const cwd = path.join(tmp, 'my-repo');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp.js')], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    // A tool's answer: { text, error }.
    async call(name, args = {}) {
      const { result } = await request('tools/call', { name, arguments: args });
      return { text: result.content[0].text, error: !!result.isError };
    },
    close: () => child.kill(),
  };
}

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return store.ymd(d);
};

let mcp;
let hello;
const ids = {};
before(async () => {
  for (const [name, fields] of Object.entries({
    rent: { title: 'Pay rent', priority: 'high', due: day(0), tags: ['money'] },
    mom: { title: 'Call mom', due: day(-2) },
    passport: { title: 'Renew passport', priority: 'high', due: day(-6), project: 'Home' },
    groceries: { title: 'Order groceries', due: day(0), tags: ['errands', 'money'] },
    photos: { title: 'Archive photos', priority: 'low', project: 'home' },
    report: { title: 'Write report', due: day(1), project: 'Work' },
    shipped: { title: 'Ship notes', status: 'done', due: day(-1) },
  })) ids[name] = store.createTodo(fields, 'me').id;
  mcp = claude();
  hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
});
after(() => mcp.close());

// The ids todo_list printed, in order.
const listed = (text) => [...text.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
const want = (...names) => names.map((n) => ids[n]);

test('Claude is told to start with todo_today when asked what to do today', async () => {
  assert.match(hello.result.instructions, /what to work on today[^\n]+todo_today/);
  const { result } = await mcp.request('tools/list', {});
  const today = result.tools.find((t) => t.name === 'todo_today');
  assert.match(today.description, /what to work on today/);
  assert.deepEqual(today.annotations, { readOnlyHint: true });
  const list = result.tools.find((t) => t.name === 'todo_list');
  for (const name of ['sort', 'due', 'priority', 'tag_mode']) assert.ok(list.inputSchema.properties[name], name);
  assert.deepEqual(list.inputSchema.properties.project.type, ['string', 'array']);
  assert.match(list.inputSchema.properties.sort.description, /default, status, priority, due, created, updated, completed, title, project, id/);
});

test('todo_list sorts, and takes several projects, tags and priorities', async () => {
  const cases = [
    [{}, want('passport', 'rent', 'mom', 'groceries', 'report', 'photos')],
    [{ sort: 'due,-priority' }, want('passport', 'mom', 'groceries', 'rent', 'report', 'photos')],
    [{ sort: '-title' }, want('report', 'passport', 'rent', 'groceries', 'mom', 'photos')],
    [{ project: ['Home', 'work'] }, want('passport', 'report', 'photos')],
    [{ project: 'home' }, want('passport', 'photos')],
    [{ project: ['', 'Work'] }, want('rent', 'mom', 'groceries', 'report')],
    [{ tag: ['money', 'errands'] }, want('rent', 'groceries')],
    [{ tag: ['money', 'errands'], tag_mode: 'all' }, want('groceries')],
    [{ priority: ['high', 'low'] }, want('passport', 'rent', 'photos')],
    [{ priority: 'high' }, want('passport', 'rent')],
    [{ due: 'tomorrow' }, want('report')],
    [{ due: `before:${day(0)}` }, want('passport', 'mom')],
    [{ overdue: true }, want('passport', 'mom')],
    [{ status: 'all', due: `after:${day(-3)}` }, want('rent', 'mom', 'groceries', 'report', 'shipped')],
    [{ query: 'money pay' }, want('rent')],
  ];
  for (const [args, expected] of cases) {
    const { text, error } = await mcp.call('todo_list', args);
    assert.equal(error, false, `${JSON.stringify(args)}: ${text}`);
    assert.deepEqual(listed(text), expected, JSON.stringify(args));
  }
});

test('a sort or filter it can\'t read is refused, saying what it would take', async () => {
  const sort = await mcp.call('todo_list', { sort: 'due,urgency' });
  assert.equal(sort.error, true);
  assert.match(sort.text, /Unknown sort key "urgency"\. Sort by any of: default, status/);
  for (const args of [{ due: 'soon' }, { priority: ['urgent'] }, { tag: 'money', tag_mode: 'some' }]) {
    const refused = await mcp.call('todo_list', args);
    assert.equal(refused.error, true, JSON.stringify(args));
  }
});

test('todo_today: overdue, then due today, each most important first', async () => {
  const { text, error } = await mcp.call('todo_today');
  assert.equal(error, false, text);
  assert.match(text, new RegExp(`^2 overdue · 2 due today  \\(today is ${store.today()}\\)`));
  const [overdue, dueToday] = text.split('\n\nDue today:\n');
  assert.deepEqual(listed(overdue), want('passport', 'mom'));
  assert.deepEqual(listed(dueToday), want('rent', 'groceries'));
  // The count is the one the Dock badge shows.
  const s = store.summarize(store.load().todos);
  assert.equal(s.overdue + s.due_today, 4);
});
