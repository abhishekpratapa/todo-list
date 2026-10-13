#!/usr/bin/env node
// A real Todos server for the iPhone app's integration tests.
//
// It runs the same server code as the Mac app, with remote access on, against a
// data directory created fresh in the system's temporary folder and deleted on
// exit. It never reads or writes the real data file or the real access token.
//
// It prints one line of JSON when ready ({ ready, port, token }), then answers
// one line of JSON for each line of JSON on standard input:
//
//   {"cmd":"mac.update","id":1,"patch":{...},"by":"Claude Code · repo"}   a change made on the Mac
//   {"cmd":"mac.create","input":{...}}       {"cmd":"mac.delete","id":1}
//   {"cmd":"rotate"}                         a new access token, as Rotate Access Token does
//   {"cmd":"enabled","on":false}             the remote access switch
//   {"cmd":"listening","on":false}           stop answering altogether, as when the Mac is asleep
//   {"cmd":"version"}                        the list's current version
//   {"cmd":"habits.create","input":{...}}    {"cmd":"habits.update","id":1,"patch":{...}}
//   {"cmd":"habits.checkin","id":1,"input":{...},"by":"Claude Code · repo"}   a check-in made on the Mac
//   {"cmd":"habits.list"}                    {"cmd":"habits.zone","zone":"America/Chicago"}
//
// The habits commands take "at": a timestamp to pin the clock to, so a test can
// make something have happened days ago, or ask what the Mac would have said then.
//
// It exits when standard input closes, so a test run that dies takes it along.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todos-ios-test-')));
process.env.TODO_DATA_FILE = path.join(dir, 'data', 'todos.json'); // must be set before the store module loads
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const store = await import(path.join(repo, 'src', 'store.js'));
const habits = await import(path.join(repo, 'src', 'habits.js'));
const { startServer } = await import(path.join(repo, 'src', 'server.js'));
const { createRemote } = await import(path.join(repo, 'src', 'remote.js'));
if (!store.DATA_FILE.startsWith(dir + path.sep)) throw new Error('Refusing to run: the data file is not in the temporary folder.');
if (!habits.HABITS_FILE.startsWith(dir + path.sep)) throw new Error('Refusing to run: the habits file is not in the temporary folder.');

// What a device on the tailnet looks like once `tailscale serve` has relayed it.
// Tests send these headers to be treated as the iPhone rather than as a script on the Mac.
const TAILNET = 'test-mac.example.ts.net';
const OWNER = 'owner@example.com';

const remote = createRemote({ tokenFile: path.join(dir, 'token'), enabled: true });
remote.hosts.add(TAILNET);
remote.ownerLogin = OWNER;
remote.deviceName = async () => 'localhost'; // what Tailscale reports for an iPhone
let server = await startServer({ port: 0, remote });
const { port } = server;

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
say({ ready: true, port, token: remote.token, tailnet: TAILNET, owner: OWNER });

// Runs fn as if it were the moment the command names, or now.
const at = (message, fn) => (message.at ? store.withClock(Date.parse(message.at), fn) : fn());

const commands = {
  'habits.create': (m) => ({ habit: at(m, () => habits.createHabit(m.input, m.by ?? 'me')) }),
  'habits.update': (m) => ({ habit: at(m, () => habits.updateHabit(m.id, m.patch)) }),
  'habits.checkin': (m) => at(m, () => habits.checkIn(m.id, m.input ?? {}, m.by ?? 'me', { via: m.via })),
  'habits.list': (m) => at(m, () => habits.listHabits()),
  'habits.zone': (m) => at(m, () => habits.setZone(m.zone)),
  'mac.update': ({ id, patch, by = 'me' }) => ({ task: store.updateTodo(id, patch, by).todo }),
  'mac.create': ({ input, by = 'me' }) => ({ task: store.createTodo(input, by) }),
  'mac.delete': ({ id }) => ({ task: store.deleteTodo(id) }),
  rotate: () => ({ token: remote.rotate() }),
  enabled: ({ on }) => {
    remote.setEnabled(on);
    return {};
  },
  version: () => ({ version: store.load().version }),
  // Changes made with mac.* commands still happen while it is not listening, as they
  // would on a Mac whose Todos is running but which the phone can't reach.
  listening: async ({ on }) => {
    if (on && !server) server = await startServer({ port, remote });
    if (!on && server) {
      server.close();
      server = null;
    }
    return {};
  },
};

const quit = () => {
  server?.close();
  process.exit(0);
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  try {
    const message = JSON.parse(line);
    const run = commands[message.cmd];
    if (!run) throw new Error(`Unknown command ${message.cmd}`);
    say({ ok: true, ...(await run(message)) });
  } catch (e) {
    say({ ok: false, error: e.message });
  }
}).on('close', quit);
process.on('SIGTERM', quit);
