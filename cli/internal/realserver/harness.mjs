// Starts the real Todos server (src/server.js in the repository this client
// lives in) for the command-line client's tests: on its own port, with its own
// data file, token file and socket, and with Remote Access on so the port
// serves /api/v1 the way it does behind `tailscale serve`.
//
// The first line it prints says where it is listening. After that it takes one
// command a line on standard input: "rotate" (replace the access token, and
// print the new one), "off" and "on" (Remote Access), "quit".

import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const src = (file) => import(pathToFileURL(path.join(process.env.TODOS_REPO, 'src', file)).href);
const { startServer } = await src('server.js');
const { createRemote } = await src('remote.js');

const remote = createRemote({ tokenFile: process.env.TODOS_TOKEN_FILE, enabled: true, requireOwner: true });
remote.hosts.add(process.env.TODOS_TAILNET_HOST);
remote.ownerLogin = process.env.TODOS_OWNER;
remote.deviceName = async () => 'test-box';

const server = await startServer({ port: Number(process.env.TODO_PORT), remote, socketPath: process.env.TODOS_SOCKET });
const say = (value) => console.log(JSON.stringify(value));
say({ port: server.port, socket: server.socket, socketProblem: server.socketProblem?.message ?? null, token: remote.token });

const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  switch (line.trim()) {
    case 'rotate': return say({ token: remote.rotate() });
    case 'off': remote.setEnabled(false); return say({ enabled: false });
    case 'on': remote.setEnabled(true); return say({ enabled: true });
    case 'quit': return stop();
    default: return say({ error: `unknown command: ${line}` });
  }
}).on('close', stop);
