#!/usr/bin/env node
// Builds Todos for installing on other Macs: `npm run dist:release`. The app and
// its DMG are signed with the Developer ID certificate in this Mac's keychain,
// notarized by Apple and stapled, so they open on any Mac without a warning,
// online or not. Plain `npm run dist` is unchanged: an ad-hoc signed build that
// opens without a warning only on the Mac that built it.
//
// What it needs, once:
//   - a "Developer ID Application" certificate in the keychain (with its key)
//   - notarization credentials saved in the keychain under a profile name:
//       xcrun notarytool store-credentials todos-notary --team-id <team id>
//
// TODOS_SIGN_IDENTITY picks a certificate when there is more than one;
// TODOS_NOTARY_PROFILE names a different profile. `--sign-only` signs but does
// not notarize, for trying the signed build on this Mac first.
//
// Order matters: the app is signed, notarized and stapled first; the DMG is
// then made from the stapled app, signed, notarized and stapled itself. So the
// app carries its ticket even once it has been copied out of the DMG.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildError, buildCli } from './build-cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTITLEMENTS = 'build/entitlements.mac.plist';
const DEFAULT_PROFILE = 'todos-notary';

// The Developer ID Application certificates in `security find-identity` output:
// [{ name: 'Developer ID Application: Someone (TEAM123456)', team: 'TEAM123456' }].
export function developerIds(output) {
  return [...String(output).matchAll(/"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"/g)].map(([, name, team]) => ({ name, team }));
}

// The certificate to sign with: the one `wanted` names (any part of its name or
// its team), or the only one there is.
export function chooseIdentity(ids, wanted) {
  const matching = wanted ? ids.filter((id) => id.name.includes(wanted)) : ids;
  if (matching.length === 1) return matching[0];
  if (!ids.length) {
    throw new BuildError('No "Developer ID Application" certificate was found in the keychain. Create one at developer.apple.com (Certificates, Identifiers & Profiles) or in Xcode (Settings > Accounts > Manage Certificates), then run this again.');
  }
  const listed = ids.map((id) => `  ${id.name}`).join('\n');
  if (!matching.length) throw new BuildError(`No Developer ID certificate matches TODOS_SIGN_IDENTITY="${wanted}". There is:\n${listed}`);
  throw new BuildError(`There is more than one Developer ID certificate. Set TODOS_SIGN_IDENTITY to part of the one to use:\n${listed}`);
}

// Runs a command, failing the build with its output if it fails. Returns its stdout.
function run(command, args, { quiet = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new BuildError(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${[command, ...args].join(' ')} failed (exit ${result.status}).${quiet ? `\n${result.stdout}${result.stderr}` : ''}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

const step = (text) => console.log(`\n== ${text}`);

// What `codesign -dvv` says about something signed: its authority chain, team, flags and timestamp.
function signature(target) {
  const details = run('codesign', ['-dvv', target], { quiet: true });
  return {
    authority: details.match(/^Authority=(.+)$/m)?.[1] || null,
    team: details.match(/^TeamIdentifier=(.+)$/m)?.[1] || null,
    runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(details),
    timestamp: details.match(/^Timestamp=(.+)$/m)?.[1] || null,
  };
}

// Checks that `target` is signed with our certificate, with the hardened runtime and a secure timestamp.
function expectSigned(target, identity, { runtime = true } = {}) {
  const got = signature(target);
  const shown = path.relative(ROOT, target);
  if (got.authority !== identity.name) throw new BuildError(`${shown} is signed by ${got.authority || 'nobody'}, not ${identity.name}.`);
  if (got.team !== identity.team) throw new BuildError(`${shown} has team ${got.team}, not ${identity.team}.`);
  if (runtime && !got.runtime) throw new BuildError(`${shown} is not signed with the hardened runtime, which notarization requires.`);
  if (!got.timestamp) throw new BuildError(`${shown} has no secure timestamp, which notarization requires.`);
  console.log(`   ${shown}: ${got.authority}${runtime ? ', hardened runtime' : ''}, timestamped ${got.timestamp}`);
}

// Submits a file to Apple's notary service and waits for the answer. Fails with
// Apple's own list of problems if it is not accepted.
function notarize(file, profile) {
  const answer = JSON.parse(run('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { quiet: true }));
  console.log(`   ${path.basename(file)}: ${answer.status} (submission ${answer.id})`);
  if (answer.status !== 'Accepted') {
    const log = run('xcrun', ['notarytool', 'log', answer.id, '--keychain-profile', profile], { quiet: true });
    throw new BuildError(`Apple did not accept ${path.basename(file)}: ${answer.status}.\n${log}`);
  }
}

function release({ signOnly = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dmg = path.join(ROOT, 'dist', `${pkg.build.productName}-${pkg.version}-arm64.dmg`);
  const app = path.join(ROOT, 'dist', 'mac-arm64', `${pkg.build.productName}.app`);
  const profile = process.env.TODOS_NOTARY_PROFILE || DEFAULT_PROFILE;

  step('Signing certificate');
  const identity = chooseIdentity(developerIds(run('security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true })), process.env.TODOS_SIGN_IDENTITY);
  console.log(`   ${identity.name}`);

  if (!signOnly) {
    step(`Notarization credentials (keychain profile "${profile}")`);
    const check = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'], { encoding: 'utf8' });
    if (check.status !== 0) {
      throw new BuildError(`No working notarization credentials are saved as "${profile}". Save them once with:\n\n  xcrun notarytool store-credentials ${profile} --team-id ${identity.team}\n\nIt asks for your Apple ID and an app-specific password (account.apple.com > Sign-In and Security > App-Specific Passwords). Or run with --sign-only to sign without notarizing.`);
    }
    console.log('   found');
  }

  step('The todos command');
  const cli = buildCli();
  console.log(`   ${path.relative(ROOT, cli.out)} (${cli.go})`);

  step(signOnly ? 'The app and its DMG, signed' : 'The app and its DMG, signed; the app notarized and stapled');
  fs.rmSync(path.join(ROOT, 'dist', 'mac-arm64'), { recursive: true, force: true });
  fs.rmSync(dmg, { force: true });
  const builder = path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
  // With APPLE_KEYCHAIN_PROFILE set, electron-builder notarizes and staples the app before it makes the DMG.
  const env = { ...process.env };
  delete env.APPLE_KEYCHAIN_PROFILE;
  if (!signOnly) env.APPLE_KEYCHAIN_PROFILE = profile;
  run(builder, [
    '--mac', '--publish', 'never',
    `-c.mac.identity=${identity.name.replace(/^Developer ID Application: /, '')}`,
    '-c.mac.hardenedRuntime=true',
    `-c.mac.entitlements=${ENTITLEMENTS}`,
    `-c.mac.entitlementsInherit=${ENTITLEMENTS}`,
    '-c.dmg.sign=true',
  ], { env });

  step('Signatures');
  run('codesign', ['--verify', '--deep', '--strict', app], { quiet: true });
  expectSigned(app, identity);
  expectSigned(path.join(app, 'Contents', 'Resources', 'bin', 'todos'), identity);
  run('codesign', ['--verify', '--strict', dmg], { quiet: true });
  expectSigned(dmg, identity, { runtime: false });

  if (!signOnly) {
    step('The DMG, notarized and stapled');
    notarize(dmg, profile);
    run('xcrun', ['stapler', 'staple', dmg], { quiet: true });

    step('What Gatekeeper on another Mac will see');
    run('xcrun', ['stapler', 'validate', app], { quiet: true });
    run('xcrun', ['stapler', 'validate', dmg], { quiet: true });
    for (const [target, args] of [[app, ['-t', 'exec']], [dmg, ['-t', 'open', '--context', 'context:primary-signature']]]) {
      const verdict = run('spctl', ['--assess', '-vv', ...args, target], { quiet: true });
      if (!/source=Notarized Developer ID/.test(verdict)) throw new BuildError(`Gatekeeper does not accept ${path.basename(target)} as notarized:\n${verdict}`);
      console.log(`   ${path.basename(target)}: accepted, notarized Developer ID, ticket stapled`);
    }
    // The app inside the DMG is the stapled one, so it keeps its ticket once copied out.
    const mount = fs.mkdtempSync(path.join(ROOT, 'dist', '.verify-'));
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg], { quiet: true });
    try {
      const inside = path.join(mount, `${pkg.build.productName}.app`);
      run('codesign', ['--verify', '--deep', '--strict', inside], { quiet: true });
      run('xcrun', ['stapler', 'validate', inside], { quiet: true });
      console.log(`   the app inside the DMG: signed, ticket stapled`);
    } finally {
      run('hdiutil', ['detach', mount], { quiet: true });
      fs.rmSync(mount, { recursive: true, force: true });
    }
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  step('Done');
  console.log(`   ${path.relative(ROOT, dmg)}  (${(fs.statSync(dmg).size / 1e6).toFixed(0)} MB, sha256 ${sha256})`);
  if (signOnly) console.log('   Signed only: another Mac will still warn about it until it is notarized. Run without --sign-only for that.');
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
    release({ signOnly: process.argv.includes('--sign-only') });
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error(`\nThe release build stopped.\n${e.message}\n`);
    process.exit(1);
  }
}
