// QR code generator for the "Pair iPhone" window. Node built-ins only.
//
// It covers what a pairing link needs and no more: byte mode, error correction
// level M, versions 1 to 10 (up to 213 bytes). Follows ISO/IEC 18004.
// test/qr.test.js checks the output against codes that Apple's decoder reads back.

// Per version: [error-correction codewords per block, [blocks, data codewords in each], ...].
const BLOCKS = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
// Centres of the alignment patterns, per version.
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_VERSION = BLOCKS.length - 1;

const dataCodewords = (version) => BLOCKS[version].slice(1).reduce((n, [count, size]) => n + count * size, 0);
const lengthBits = (version) => (version < 10 ? 8 : 16);

// How many bytes of text fit in a code of this version.
export const capacity = (version) => Math.floor((dataCodewords(version) * 8 - 4 - lengthBits(version)) / 8);

// ---------- Reed-Solomon over GF(256) ----------

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// The `count` error-correction codewords for one block of data.
function errorCorrection(data, count) {
  // Generator polynomial (x - 2^0)(x - 2^1)...(x - 2^(count-1)), highest power first, leading 1 left out.
  const generator = new Uint8Array(count);
  generator[count - 1] = 1;
  for (let i = 0, root = 1; i < count; i++) {
    for (let j = 0; j < count; j++) {
      generator[j] = mul(generator[j], root);
      if (j + 1 < count) generator[j] ^= generator[j + 1];
    }
    root = mul(root, 2);
  }
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    for (let j = 0; j < count; j++) remainder[j] ^= mul(generator[j], factor);
  }
  return remainder;
}

// ---------- data ----------

// The full sequence of codewords for the symbol: data split into blocks, each with
// its error correction, interleaved the way the standard lays them out.
function codewords(bytes, version) {
  const [ecCount, ...groups] = BLOCKS[version];
  const total = dataCodewords(version);

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, lengthBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, total * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++, at += size) {
      const block = data.slice(at, at + size);
      blocks.push({ data: block, ec: errorCorrection(block, ecCount) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecCount; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---------- the symbol ----------

// Appends the remainder of dividing `value` (shifted up) by `poly`: a BCH code.
function withBch(value, bits, poly) {
  let rem = value;
  for (let i = 0; i < bits; i++) rem = (rem << 1) ^ ((rem >>> (bits - 1)) * poly);
  return (value << bits) | rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The fixed parts of a symbol (finder, timing and alignment patterns, and the
// places reserved for format and version information) plus the data, unmasked.
function layout(version, words) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => {
    dark[y][x] = on;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns, with their light separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  centres.forEach((cy, i) => centres.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // a finder is there
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  // Reserve the format information; format() fills it in once the mask is chosen.
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue; // the timing patterns pass through here
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true); // always dark

  if (version >= 7) {
    const info = withBch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const on = ((info >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // Data runs in two-module columns from the bottom right, snaking up and down.
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern takes a whole column
    for (let step = 0; step < size; step++) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (fixed[y][x] || bit >= words.length * 8) continue;
        dark[y][x] = ((words[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
        bit += 1;
      }
    }
  }
  return { size, dark, fixed };
}

// Writes the format information (error correction level M, and which mask) in both of its places.
function format(dark, size, mask) {
  const info = withBch(mask, 10, 0x537) ^ 0x5412; // level M is 00, so the five data bits are just the mask
  const on = (i) => ((info >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) dark[i][8] = on(i);
  dark[7][8] = on(6);
  dark[8][8] = on(7);
  dark[8][7] = on(8);
  for (let i = 9; i < 15; i++) dark[8][14 - i] = on(i);
  for (let i = 0; i < 8; i++) dark[8][size - 1 - i] = on(i);
  for (let i = 8; i < 15; i++) dark[size - 15 + i][8] = on(i);
}

// How hard a symbol is to scan, by the standard's four rules. Lower is better.
function penalty(dark, size) {
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  for (const line of lines) {
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i + 1 < size && line[i + 1] === line[i]) continue;
      if (run >= 5) score += run - 2; // long runs of one colour
      run = 0;
    }
    const text = line.map((on) => (on ? '1' : '0')).join('');
    for (const lookalike of ['10111010000', '00001011101']) { // looks like a finder pattern
      for (let at = text.indexOf(lookalike); at >= 0; at = text.indexOf(lookalike, at + 1)) score += 40;
    }
  }
  let total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) total += 1;
      if (x + 1 < size && y + 1 < size && dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) score += 3; // 2x2 blocks
    }
  }
  return score + Math.floor(Math.abs((total * 100) / (size * size) - 50) / 5) * 10; // far from half dark
}

// Encodes text as a QR code. Returns { version, size, modules }, where
// modules[y][x] is true for a dark module. Throws if the text is too long.
export function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 1;
  while (version <= MAX_VERSION && bytes.length > capacity(version)) version += 1;
  if (version > MAX_VERSION) throw new RangeError(`Too long for a QR code here: ${bytes.length} bytes, and the limit is ${capacity(MAX_VERSION)}.`);

  const { size, dark, fixed } = layout(version, codewords(bytes, version));
  let best = null;
  MASKS.forEach((flips, mask) => {
    const modules = dark.map((row, y) => row.map((on, x) => (fixed[y][x] ? on : on !== flips(x, y))));
    format(modules, size, mask);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, modules };
  });
  return { version, size, modules: best.modules };
}

// An SVG picture of a code: dark modules on white, with the quiet zone scanners need.
export function toSvg({ size, modules }, { margin = 4 } = {}) {
  const span = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      let run = 1;
      while (x + run < size && modules[y][x + run]) run += 1;
      path += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges"><rect width="${span}" height="${span}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
