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
//   {"cmd":"version"}                        the list's current version
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
const { startServer } = await import(path.join(repo, 'src', 'server.js'));
const { createRemote } = await import(path.join(repo, 'src', 'remote.js'));
if (!store.DATA_FILE.startsWith(dir + path.sep)) throw new Error('Refusing to run: the data file is not in the temporary folder.');

// What a device on the tailnet looks like once `tailscale serve` has relayed it.
// Tests send these headers to be treated as the iPhone rather than as a script on the Mac.
const TAILNET = 'test-mac.example.ts.net';
const OWNER = 'owner@example.com';

const remote = createRemote({ tokenFile: path.join(dir, 'token'), enabled: true });
remote.hosts.add(TAILNET);
remote.ownerLogin = OWNER;
remote.deviceName = async () => 'localhost'; // what Tailscale reports for an iPhone
const server = await startServer({ port: 0, remote });

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
say({ ready: true, port: server.port, token: remote.token, tailnet: TAILNET, owner: OWNER });

const commands = {
  'mac.update': ({ id, patch, by = 'me' }) => ({ task: store.updateTodo(id, patch, by).todo }),
  'mac.create': ({ input, by = 'me' }) => ({ task: store.createTodo(input, by) }),
  'mac.delete': ({ id }) => ({ task: store.deleteTodo(id) }),
  rotate: () => ({ token: remote.rotate() }),
  enabled: ({ on }) => {
    remote.setEnabled(on);
    return {};
  },
  version: () => ({ version: store.load().version }),
};

const quit = () => {
  server.close();
  process.exit(0);
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const run = commands[message.cmd];
    if (!run) throw new Error(`Unknown command ${message.cmd}`);
    say({ ok: true, ...run(message) });
  } catch (e) {
    say({ ok: false, error: e.message });
  }
}).on('close', quit);
process.on('SIGTERM', quit);
