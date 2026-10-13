#!/usr/bin/env node
// Builds the `todos` command-line client and stages it for the app bundle. The
// first step of `npm run dist`: electron-builder then copies build/bin/todos to
// Todos.app/Contents/Resources/bin/todos.
//
// The client is a Go program in cli/ with a build command of its own,
// cli/build.sh, which writes a macOS arm64 binary to cli/dist/todos-darwin-arm64.
// This runs it, checks that the result really is one, and copies it into place.
// Anything missing stops the build with a message saying what to do, rather
// than producing an app with no command inside. Node built-ins only.
//
// TODOS_CLI_DIR builds a client that lives somewhere other than cli/.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Something that stops the build. The message is for the person running it.
export class BuildError extends Error {}

// What a macOS arm64 program starts with: the 64-bit Mach-O magic number, the
// arm64 CPU type, and (at byte 12) the "executable" file type.
function isArm64Executable(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.readUInt32LE(0) === 0xfeedfacf && head.readUInt32LE(4) === 0x0100000c && head.readUInt32LE(12) === 2;
}

// Builds the client in `cliDir` and copies it to `out`. Returns { out, size, go }.
export function buildCli({ cliDir = process.env.TODOS_CLI_DIR || path.join(ROOT, 'cli'), out = path.join(ROOT, 'build', 'bin', 'todos'), env = process.env, quiet = false } = {}) {
  cliDir = path.resolve(cliDir);
  const shown = path.relative(ROOT, cliDir) || cliDir;

  const go = spawnSync('go', ['version'], { env, encoding: 'utf8' });
  if (go.error || go.status !== 0) {
    throw new BuildError('Go was not found. The todos command-line tool is written in Go and is built into the app.\nInstall Go (https://go.dev/dl, or `brew install go`), then run `npm run dist` again.');
  }

  const script = path.join(cliDir, 'build.sh');
  if (!fs.existsSync(script)) {
    throw new BuildError(`${shown}/build.sh was not found. The command-line client's sources are not in this checkout.\n(To build the app with a client kept somewhere else, set TODOS_CLI_DIR to its folder.)`);
  }

  const built = path.join(cliDir, 'dist', 'todos-darwin-arm64');
  // Run as a program in its own right, so its first line chooses the shell; through sh if it isn't marked executable.
  let executable = true;
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    executable = false;
  }
  const run = spawnSync(executable ? script : '/bin/sh', executable ? [] : [script], { cwd: cliDir, env, stdio: quiet ? 'ignore' : 'inherit' });
  if (run.error) throw new BuildError(`${shown}/build.sh could not be run: ${run.error.message}`);
  if (run.status !== 0) throw new BuildError(`${shown}/build.sh failed (exit ${run.status ?? run.signal}). See its output above.`);

  if (!fs.existsSync(built)) throw new BuildError(`${shown}/build.sh finished without writing ${shown}/dist/todos-darwin-arm64.`);
  if (!isArm64Executable(built)) throw new BuildError(`${shown}/dist/todos-darwin-arm64 is not a macOS arm64 program.`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(built, out);
  fs.chmodSync(out, 0o755);
  return { out, size: fs.statSync(out).size, go: go.stdout.trim() };
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const { out, size, go } = buildCli();
    console.log(`Built the todos command-line tool: ${path.relative(ROOT, out)} (${(size / 1e6).toFixed(1)} MB, ${go})`);
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error(`\nCould not build the todos command-line tool.\n${e.message}\n`);
    process.exit(1);
  }
}
