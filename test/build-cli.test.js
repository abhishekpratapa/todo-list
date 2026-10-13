// Building the command-line tool into the app: `npm run dist` first runs
// scripts/build-cli.js, which must stop with a clear message when something is
// missing, and must only ever stage a real macOS arm64 program.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmp } from './support/helpers.js';

const { BuildError, buildCli } = await import('../scripts/build-cli.js');
const REPO = path.resolve(import.meta.dirname, '..');
const STANDIN = path.join(REPO, 'test', 'fixtures', 'cli-standin');

// A `go` that only answers `go version`, so most of these don't need Go installed.
const fakeBin = path.join(tmp, 'fake-bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'go'), '#!/bin/sh\necho "go version go0.0 test/arm64"\n', { mode: 0o755 });
const withGo = { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` };
const withoutGo = { ...process.env, PATH: '/usr/bin:/bin' };

// The first 16 bytes of a Mach-O file: magic, CPU type, CPU subtype, file type.
const machO = ({ magic = 0xfeedfacf, cpu = 0x0100000c, type = 2 } = {}) => {
  const head = Buffer.alloc(64);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(cpu, 4);
  head.writeUInt32LE(type, 12);
  return head;
};

// A client folder whose build.sh does `script`. `product`, if given, is written to
// a file that the script can copy into place.
let n = 0;
function client(script, product) {
  const dir = path.join(tmp, `cli-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'build.sh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  if (product) fs.writeFileSync(path.join(dir, 'product'), product);
  return dir;
}
const COPY = 'mkdir -p dist && cp product dist/todos-darwin-arm64';
const out = () => path.join(tmp, `staged-${n}`, 'bin', 'todos');
const build = (cliDir, env = withGo) => buildCli({ cliDir, out: out(), env, quiet: true });
const stops = (fn, pattern) => assert.throws(fn, (e) => e instanceof BuildError && pattern.test(e.message));

test('without Go the build stops and says to install it', () => {
  stops(() => build(client(COPY, machO()), withoutGo), /Go was not found[\s\S]*Install Go[\s\S]*npm run dist/);
  assert.equal(fs.existsSync(out()), false);
});

test('without the client\'s sources the build stops and says so', () => {
  stops(() => build(path.join(tmp, 'no-such-cli')), /build\.sh was not found[\s\S]*TODOS_CLI_DIR/);
});

test('a failed build, or one that produces nothing, stops the build', () => {
  stops(() => build(client('echo "compile error" >&2; exit 3')), /build\.sh failed \(exit 3\)/);
  stops(() => build(client('exit 0')), /finished without writing .*dist\/todos-darwin-arm64/);
  assert.equal(fs.existsSync(out()), false);
});

test('only a macOS arm64 program is ever staged', () => {
  const wrong = [
    ['a shell script', Buffer.from('#!/bin/sh\necho todos\n')],
    ['an Intel program', machO({ cpu: 0x01000007 })],
    ['an arm64 library', machO({ type: 6 })],
    ['a universal binary', machO({ magic: 0xbebafeca })],
    ['an empty file', Buffer.alloc(0)],
  ];
  for (const [what, bytes] of wrong) {
    stops(() => build(client(COPY, bytes)), /is not a macOS arm64 program/);
    assert.equal(fs.existsSync(out()), false, what);
  }
  const good = build(client(COPY, machO()));
  assert.equal(good.out, out());
  assert.deepEqual(fs.readFileSync(out()), machO());
  assert.equal(fs.statSync(out()).mode & 0o777, 0o755);
  assert.equal(good.go, 'go version go0.0 test/arm64');
});

test('a build.sh that is not marked executable is still run', () => {
  const dir = client(COPY, machO());
  fs.chmodSync(path.join(dir, 'build.sh'), 0o644);
  assert.equal(build(dir).size, 64);
});

test('the client\'s folder may be given relative to where the build is run', () => {
  const dir = client(COPY, machO());
  const staged = out();
  const here = process.cwd();
  process.chdir(tmp);
  try {
    assert.equal(buildCli({ cliDir: path.relative(tmp, dir), out: staged, env: withGo, quiet: true }).size, 64);
  } finally {
    process.chdir(here);
  }
});

test('run as a command, it exits 1 with the reason and stages nothing', () => {
  const run = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-cli.js')], { env: { ...withGo, TODOS_CLI_DIR: path.join(tmp, 'no-such-cli') }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Could not build the todos command-line tool\.\n.*build\.sh was not found/);
  assert.equal(run.stdout, '');
});

test('npm run dist builds the client first and puts it in the bundle at Contents/Resources/bin/todos', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dist, 'node scripts/build-cli.js && electron-builder --mac');
  assert.deepEqual(pkg.build.extraResources, [{ from: 'build/bin/todos', to: 'bin/todos' }]);
  assert.equal(pkg.build.files.some((f) => f.startsWith('cli') || f.startsWith('build')), false, 'the app\'s own files are unchanged');
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], 'still no runtime dependencies');
});

const hasGo = spawnSync('go', ['version']).status === 0;
test('with Go, a real client is compiled, staged and runs', { skip: !hasGo && 'needs Go' }, () => {
  const staged = path.join(tmp, 'real', 'bin', 'todos');
  const result = buildCli({ cliDir: STANDIN, out: staged, quiet: true });
  assert.match(result.go, /^go version go\d/);
  assert.ok(result.size > 100_000);
  assert.match(execFileSync('/usr/bin/file', [staged], { encoding: 'utf8' }), /Mach-O 64-bit executable arm64/);
  assert.match(execFileSync(staged, { encoding: 'utf8' }), /^todos stand-in/);
});
