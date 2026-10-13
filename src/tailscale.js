// Talks to the Tailscale CLI: reads this Mac's place on the tailnet, and sets up
// or removes the `tailscale serve` mapping that relays the user's other devices
// to the local server. Nothing here runs unless remote access is being used.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
// HTTPS ports `tailscale serve` can listen on, in order of preference.
const SERVE_PORTS = [443, 8443, 10000];

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Set TODOS_TAILSCALE_BIN to use a specific CLI (the tests point it at a stand-in).
export const findCli = () => process.env.TODOS_TAILSCALE_BIN || CANDIDATES.find(isExecutable) || null;

function run(args, timeout = 8000) {
  return new Promise((resolve) => {
    const cli = findCli();
    if (!cli) return resolve({ ok: false, stdout: '', stderr: 'The tailscale command was not found.' });
    execFile(cli, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// This Mac on the tailnet: { installed, running, dnsName, ownerLogin, httpsEnabled }.
export async function status() {
  if (!findCli()) return { installed: false, running: false };
  const d = parse((await run(['status', '--json'])).stdout);
  if (!d) return { installed: true, running: false };
  const self = d.Self || {};
  const owner = (d.User || {})[String(self.UserID)] || {};
  return {
    installed: true,
    running: d.BackendState === 'Running',
    dnsName: String(self.DNSName || '').replace(/\.$/, '').toLowerCase() || null,
    ownerLogin: owner.LoginName || null,
    httpsEnabled: (d.CertDomains || []).length > 0,
  };
}

// What `tailscale serve` is doing with the local server on `port`:
// { mapped, httpsPort, funnel, taken } where `taken` lists HTTPS ports already in use by any mapping.
export async function serveStatus(port) {
  const cfg = parse((await run(['serve', 'status', '--json'])).stdout) || {};
  const target = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`);
  const out = { mapped: false, httpsPort: null, funnel: false, taken: [] };
  for (const [hostPort, site] of Object.entries(cfg.Web || {})) {
    const httpsPort = Number(hostPort.split(':').pop());
    out.taken.push(httpsPort);
    if (target.test(site?.Handlers?.['/']?.Proxy || '')) {
      out.mapped = true;
      out.httpsPort = httpsPort;
      out.funnel = !!(cfg.AllowFunnel || {})[hostPort]; // Funnel would publish it to the internet
    }
  }
  for (const tcpPort of Object.keys(cfg.TCP || {})) {
    if (!out.taken.includes(Number(tcpPort))) out.taken.push(Number(tcpPort));
  }
  return out;
}

const lastLine = (text) => String(text).trim().split('\n').filter(Boolean).slice(-3).join(' ').trim();

// The exact command serveOn() would run, for showing to the user first.
export const serveCommand = (port, httpsPort = 443) => `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`;

// Picks the HTTPS port a new mapping would use, leaving any existing mapping alone.
export async function planServe(port) {
  const current = await serveStatus(port);
  if (current.mapped) return { ...current, already: true };
  const httpsPort = SERVE_PORTS.find((p) => !current.taken.includes(p)) ?? null;
  return { ...current, already: false, httpsPort };
}

// Relays https://<this-mac>.<tailnet>.ts.net[:httpsPort] to http://127.0.0.1:port,
// for devices on the tailnet only. Resolves to { ok, httpsPort } or { ok: false, error }.
export async function serveOn(port) {
  const plan = await planServe(port);
  if (plan.already) return { ok: true, httpsPort: plan.httpsPort };
  if (!plan.httpsPort) return { ok: false, error: 'Tailscale Serve is already using ports 443, 8443 and 10000 for other things.' };
  const r = await run(['serve', '--bg', '--yes', `--https=${plan.httpsPort}`, `http://127.0.0.1:${port}`], 30_000);
  return r.ok ? { ok: true, httpsPort: plan.httpsPort } : { ok: false, error: lastLine(r.stderr || r.stdout) };
}

// Removes only the mapping that points at our port.
export async function serveOff(port) {
  const current = await serveStatus(port);
  if (!current.mapped) return { ok: true };
  const r = await run(['serve', '--yes', `--https=${current.httpsPort}`, 'off'], 30_000);
  return r.ok ? { ok: true } : { ok: false, error: lastLine(r.stderr || r.stdout) };
}

// Device name for a tailnet address ("iPhone", "work-laptop"), or null. Cached,
// since every change from another device asks for it.
const names = new Map(); // ip -> { name, at }
export async function deviceName(ip) {
  if (!/^[0-9a-f.:]+$/i.test(String(ip))) return null; // only ever pass an address to the CLI
  const hit = names.get(ip);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  const d = parse((await run(['whois', '--json', ip])).stdout);
  const node = d?.Node || {};
  const name = node.ComputedName || node.Hostinfo?.Hostname || String(node.Name || '').split('.')[0] || null;
  names.set(ip, { name, at: Date.now() });
  return name;
}
