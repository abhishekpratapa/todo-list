// The local socket: a Unix domain socket for programs running as the user on this
// Mac (the `todos` command). There is no sign-in on it. Being able to open the
// file is what proves who is asking, so everything here is about making sure
// nobody else ever can. Node built-ins only.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A socket's path has to fit in 104 bytes on macOS. Go, which the command-line
// client is written in, stops at 103, so that is the limit on both sides. Node
// can't be left to find out for itself: some versions quietly cut a longer path
// short and listen on a different file.
export const SOCKET_PATH_MAX = 103;

const fits = (file) => Buffer.byteLength(file) <= SOCKET_PATH_MAX;

// Where the socket goes: TODOS_SOCKET if set; otherwise next to the app's data;
// otherwise, when a long home folder pushes that past the limit, ~/.todos/todos.sock.
// Null when nothing fits. The command-line client works it out the same way.
export function socketPath({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.TODOS_SOCKET) {
    const chosen = path.resolve(env.TODOS_SOCKET);
    return fits(chosen) ? chosen : null;
  }
  const candidates = [path.join(home, '.todos', 'todos.sock')];
  if (platform === 'darwin') candidates.unshift(path.join(home, 'Library', 'Application Support', 'Todos', 'todos.sock'));
  return candidates.find(fits) ?? null;
}

// Why the socket could not be opened. `code` is one of: too_long, unsafe_folder,
// in_the_way, in_use, failed.
export class SocketError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// What is behind the socket file at `file`: 'live' if something accepts
// connections there, 'stale' if nothing does, 'unknown' if we can't tell.
function probe(file) {
  return new Promise((resolve) => {
    const client = net.connect(file);
    const done = (state) => {
      client.destroy();
      resolve(state);
    };
    client.setTimeout(1000, () => done('unknown'));
    client.once('connect', () => done('live'));
    client.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'stale' : 'unknown'));
  });
}

// Starts `server` listening on the socket at `file`, which only the user can
// open (mode 0600, in a folder nobody else can write to). Resolves once it is
// listening; rejects with a SocketError saying why not.
//
// A socket left behind by a copy that did not exit cleanly is replaced. One that
// still answers belongs to another running copy and is left alone, as is anything
// at that path that is not a socket. Closing the server removes the file.
export async function listenOnSocket(server, file) {
  if (!fits(file)) throw new SocketError('too_long', `The socket path is longer than ${SOCKET_PATH_MAX} bytes: ${file}`);

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = fs.statSync(dir);
  if (folder.uid !== process.getuid() || (folder.mode & 0o022) !== 0) {
    throw new SocketError('unsafe_folder', `Other users can change ${dir}, so a socket there could be swapped for theirs.`);
  }

  let existing = null;
  try {
    existing = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SocketError('failed', e.message);
  }
  if (existing) {
    if (!existing.isSocket()) throw new SocketError('in_the_way', `${file} exists and is not a socket.`);
    const state = await probe(file);
    if (state !== 'stale') throw new SocketError('in_use', `Another copy of Todos is already answering on ${file}.`);
    fs.unlinkSync(file);
  }

  // The file is created by listen(), with whatever the umask allows. Tightening
  // the umask first means it is never, even for a moment, open to anyone else.
  await new Promise((resolve, reject) => {
    const onError = (e) => reject(new SocketError(e.code === 'EADDRINUSE' ? 'in_use' : 'failed', e.message));
    server.once('error', onError);
    const before = process.umask(0o177);
    try {
      server.listen(file, () => {
        server.removeListener('error', onError);
        resolve();
      });
    } finally {
      process.umask(before);
    }
  });
  fs.chmodSync(file, 0o600);
  return file;
}
