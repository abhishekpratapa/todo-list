// Pairing the iPhone app: the QR encoder, the link the code carries, and the page
// that shows it.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { boot } from './support/helpers.js';

const qr = await import('../src/qr.js');
const { pairingLink, pairingPage } = await import('../src/pairing.js');

const rows = (code) => code.modules.map((row) => row.map((on) => (on ? 1 : 0)).join(''));
const fingerprint = (code) => crypto.createHash('sha256').update(rows(code).join('\n')).digest('hex').slice(0, 16);
// Text that exactly fills a code of the given version.
const filling = (version) => Array.from({ length: qr.capacity(version) }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + version) % 36]).join('');

// Each of these codes was drawn and read back correctly by Apple's Vision framework
// (VNDetectBarcodesRequest) when the encoder was written. The fingerprints pin
// them, so a change to the encoder can't quietly produce a code that doesn't scan.
// There is one at the full capacity of every version, since each has its own layout.
const VERIFIED = [
  ['Todos', 1, '0e9a9b0f34bb84a4'],
  ['héllo wörld ✓', 2, '6cf98500e9c5b526'],
  [`todos-pair:?v=1&u=https%3A%2F%2Ftest-mac.example.ts.net&t=${'A'.repeat(43)}`, 6, '74349b4e161ca619'],
  [filling(1), 1, 'c88abd5c6e933207'],
  [filling(2), 2, '1495e56cb1ac2d2b'],
  [filling(3), 3, '232675295dc1c0c7'],
  [filling(4), 4, '882a28b913c29bb1'],
  [filling(5), 5, '13f6d5127bc15245'],
  [filling(6), 6, 'f6cd2ae4bd0e2066'],
  [filling(7), 7, 'c05c3d6dea4d96a1'],
  [filling(8), 8, '833e969f4e95dd8d'],
  [filling(9), 9, '18e95951fd466803'],
  [filling(10), 10, '068ab58057e37d81'],
];

test('codes match the ones a real decoder has read back', () => {
  for (const [text, version, expected] of VERIFIED) {
    const code = qr.encode(text);
    assert.equal(code.version, version, `version for ${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(code.size, version * 4 + 17);
    assert.equal(fingerprint(code), expected, `code for ${JSON.stringify(text.slice(0, 20))}`);
  }
});

test('the smallest version that fits is used, and text that cannot fit is refused', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(qr.capacity), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213], 'byte capacities at level M, from the standard');
  assert.equal(qr.encode('x'.repeat(14)).version, 1);
  assert.equal(qr.encode('x'.repeat(15)).version, 2);
  assert.equal(qr.encode('é'.repeat(7)).version, 1, 'length is counted in UTF-8 bytes');
  assert.equal(qr.encode('é'.repeat(8)).version, 2);
  assert.equal(qr.encode('x'.repeat(213)).version, 10);
  assert.throws(() => qr.encode('x'.repeat(214)), RangeError);
});

// The 15 format bits say which mask and error-correction level a scanner should
// assume. Checked here with arithmetic independent of the encoder's.
test('every code carries valid format information, twice, saying level M', () => {
  for (let version = 1; version <= qr.MAX_VERSION; version++) {
    const { size, modules } = qr.encode(filling(version));
    const at = (x, y) => (modules[y][x] ? 1 : 0);
    const first = [];
    const second = [];
    for (let i = 0; i < 15; i++) {
      first.push(i <= 5 ? at(8, i) : i === 6 ? at(8, 7) : i === 7 ? at(8, 8) : i === 8 ? at(7, 8) : at(14 - i, 8));
      second.push(i <= 7 ? at(size - 1 - i, 8) : at(8, size - 15 + i));
    }
    assert.deepEqual(first, second, `version ${version}: both copies agree`);
    let word = first.reduce((n, bit, i) => n | (bit << i), 0) ^ 0x5412;
    assert.equal(word >>> 13, 0, `version ${version}: level M`);
    for (let bit = 14; bit >= 10; bit--) if (word & (1 << bit)) word ^= 0x537 << (bit - 10);
    assert.equal(word, 0, `version ${version}: the check bits are right`);
    assert.equal(at(8, size - 8), 1, 'the module that is always dark');
  }
});

test('the three finder patterns and the timing patterns are in place', () => {
  const { size, modules } = qr.encode(filling(7));
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.deepEqual(finder.map((_, y) => modules[y0 + y].slice(x0, x0 + 7).map((on) => (on ? 1 : 0)).join('')), finder);
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
});

test('the picture is a plain SVG with a quiet zone', () => {
  const code = qr.encode('Todos');
  const svg = qr.toSvg(code);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/, '21 modules plus 4 on each side');
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
  // The dark area drawn equals the number of dark modules.
  const drawn = [...svg.matchAll(/M\d+ \d+h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.equal(drawn, code.modules.flat().filter(Boolean).length);
  assert.equal(/<script|href|on\w+=/i.test(svg), false);
});

test('the pairing link carries the address and the token, and is not a web address', () => {
  const token = 'aB3_-xYz'.repeat(5) + 'abc'; // base64url, like a real token
  const link = pairingLink('https://my-mac.tail1234.ts.net:8443', token);
  const parsed = new URL(link);
  assert.equal(parsed.protocol, 'todos-pair:');
  assert.equal(parsed.searchParams.get('v'), '1');
  assert.equal(parsed.searchParams.get('u'), 'https://my-mac.tail1234.ts.net:8443');
  assert.equal(parsed.searchParams.get('t'), token);
  assert.ok(Buffer.byteLength(pairingLink(`https://${'a'.repeat(63)}.tail1234.ts.net:10000`, token)) <= qr.capacity(qr.MAX_VERSION), 'the longest name Tailscale allows still fits');
});

test('the pairing page is self-contained and runs nothing', async () => {
  const s = await boot();
  try {
    const url = 'https://my-mac.tail1234.ts.net';
    const page = pairingPage({ url, token: s.remote.token });
    assert.ok(page.includes(qr.toSvg(qr.encode(pairingLink(url, s.remote.token)))), 'shows the code for this address and token');
    assert.ok(page.includes('my-mac.tail1234.ts.net'));
    assert.equal(page.includes(s.remote.token), false, 'the token is not written out as text');
    assert.equal(/<script|<link|<img|<iframe|src=|href=|url\(/i.test(page), false, 'no scripts and nothing fetched');
    assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
    assert.notEqual(pairingPage({ url, token: s.remote.token, dark: true }), page, 'follows Dark Mode');
    assert.ok(pairingPage({ url, token: s.remote.token, dark: true }).includes('fill="#fff"'), 'but the code itself stays black on white');

    // The server offers no way to fetch the code or the link.
    for (const p of ['/pair', '/pairing', '/api/v1/pair', '/api/v1/pairing', '/api/v1/qr']) {
      const res = await s.tailnet('GET', p, { headers: s.bearer() });
      assert.equal(res.status, 404, p);
    }
  } finally {
    s.close();
  }
});
