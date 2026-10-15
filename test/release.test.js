// The release build (npm run dist:release): which certificate it signs with,
// what it asks the hardened runtime for, and that it stops before building
// anything when the certificate or the notarization credentials are missing.
// The build itself needs Apple's servers, so it is not run here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmp } from './support/helpers.js';

const { BuildError } = await import('../scripts/build-cli.js');
const { chooseIdentity, developerIds } = await import('../scripts/release.js');
const REPO = path.resolve(import.meta.dirname, '..');

const FOUND = `  1) 1111111111111111111111111111111111111111 "Apple Development: Some One (DEVTEAM001)"
  2) 2222222222222222222222222222222222222222 "Developer ID Application: Some One (TEAM123456)"
     2 valid identities found
`;

test('the Developer ID Application certificate is the one used, never a development one', () => {
  assert.deepEqual(developerIds(FOUND), [{ name: 'Developer ID Application: Some One (TEAM123456)', team: 'TEAM123456' }]);
  assert.equal(chooseIdentity(developerIds(FOUND)).team, 'TEAM123456');
  assert.deepEqual(developerIds('     0 valid identities found\n'), []);
});

test('with several certificates, TODOS_SIGN_IDENTITY picks one; with none, it says how to get one', () => {
  const two = developerIds(`${FOUND}  3) 3333333333333333333333333333333333333333 "Developer ID Application: Other Team (OTHER98765)"\n`);
  assert.throws(() => chooseIdentity(two), (e) => e instanceof BuildError && /more than one[\s\S]*TODOS_SIGN_IDENTITY[\s\S]*OTHER98765/.test(e.message));
  assert.equal(chooseIdentity(two, 'OTHER98765').name, 'Developer ID Application: Other Team (OTHER98765)');
  assert.equal(chooseIdentity(two, 'Some One').team, 'TEAM123456');
  assert.throws(() => chooseIdentity(two, 'Nobody'), (e) => e instanceof BuildError && /No Developer ID certificate matches/.test(e.message));
  assert.throws(() => chooseIdentity([]), (e) => e instanceof BuildError && /developer\.apple\.com/.test(e.message));
});

test('the hardened runtime is asked for JIT compilation only', () => {
  const plist = fs.readFileSync(path.join(REPO, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.deepEqual([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]), ['com.apple.security.cs.allow-jit']);
});

test('plain `npm run dist` is unchanged: ad-hoc signed, for this Mac', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dist, 'node scripts/build-cli.js && electron-builder --mac');
  assert.equal(pkg.scripts['dist:release'], 'node scripts/release.js');
  assert.equal(pkg.build.mac.identity, '-');
  assert.equal(pkg.build.mac.hardenedRuntime, false);
});

// Runs the release script with stand-ins for `security` and `xcrun`, so nothing real is asked.
function releaseWith({ security, xcrun }) {
  const bin = fs.mkdtempSync(path.join(tmp, 'release-bin-'));
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\ncat <<'END'\n${security}END\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'xcrun'), `#!/bin/sh\n${xcrun}\n`, { mode: 0o755 });
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'release.js')], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TODOS_CLI_DIR: path.join(tmp, 'must-not-be-built') },
    encoding: 'utf8',
  });
}

test('without a certificate, it stops before building anything', () => {
  const run = releaseWith({ security: '     0 valid identities found\n', xcrun: 'exit 0' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The release build stopped\.\nNo "Developer ID Application" certificate/);
  assert.doesNotMatch(run.stdout + run.stderr, /The todos command|build\.sh/);
});

test('without notarization credentials, it says exactly what to run, and stops before building anything', () => {
  const run = releaseWith({ security: FOUND, xcrun: 'echo "Error: No Keychain password item found for profile: todos-notary" >&2; exit 69' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No working notarization credentials are saved as "todos-notary"/);
  assert.match(run.stderr, /xcrun notarytool store-credentials todos-notary --team-id TEAM123456/);
  assert.match(run.stderr, /--sign-only/);
  assert.doesNotMatch(run.stdout + run.stderr, /== The todos command/);
});
