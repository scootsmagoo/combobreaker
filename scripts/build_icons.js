#!/usr/bin/env node
// Generates ComboBreaker icons (16/32/48/128) as PNG using only Node built-ins.
// Run: `node scripts/build_icons.js`
//
// Design: dark navy rounded square, a cyan ring, a magenta diagonal "break"
// slash. Laid out to the Chrome Web Store rules for the 128 px icon:
//   - the artwork is 96x96 with 16 px of transparent padding on every side;
//   - a subtle white outer glow (the icon is mostly dark) so it reads on dark
//     backgrounds too; it fades out inside the padding;
//   - no edge, no perspective, no big drop shadow.
// The smaller sizes (toolbar, extensions page) keep less padding because Chrome
// draws them at their natural size.
//
// Edges are anti-aliased by 4x4 supersampling.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "icons");
fs.mkdirSync(OUT, { recursive: true });

const COLORS = {
  bg: [16, 20, 32],
  accent: [236, 72, 153],
  ring: [56, 189, 248],
};

// size -> { pad, glow } ; glow = peak alpha (0..1) of the white halo
const LAYOUT = {
  128: { pad: 16, glow: 0.42 },
  48: { pad: 4, glow: 0.3 },
  32: { pad: 2, glow: 0 },
  16: { pad: 0, glow: 0 },
};

const SS = 4; // supersampling factor per axis

// Returns [r, g, b, coverage] for a point (x, y) in artwork coordinates where
// the artwork spans [0, A) on both axes. coverage is 0 or 1 here; the
// supersampling turns that into a smooth edge.
function sample(x, y, A) {
  const cornerR = A * 0.22;
  const dx = Math.min(x, A - x);
  const dy = Math.min(y, A - y);
  if (dx < 0 || dy < 0) return null;
  if (dx < cornerR && dy < cornerR) {
    const ex = cornerR - dx;
    const ey = cornerR - dy;
    if (ex * ex + ey * ey > cornerR * cornerR) return null;
  }
  const cx = A / 2;
  const cy = A / 2;
  const rx = x - cx;
  const ry = y - cy;
  const dist = Math.sqrt(rx * rx + ry * ry);
  const radius = A * 0.46;
  const ringInner = radius - A * 0.09;
  const slashDist = Math.abs(rx + ry) / Math.SQRT2;
  const slashHalfWidth = A * 0.07;
  if (slashDist <= slashHalfWidth && dist <= radius - A * 0.01) return COLORS.accent;
  if (dist <= radius && dist >= ringInner) return COLORS.ring;
  return COLORS.bg;
}

// Separable box blur, repeated so it approximates a Gaussian.
function blur(src, size, radius, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(size * size);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= size) continue;
          s += a[y * size + xx];
          n++;
        }
        b[y * size + x] = s / n;
      }
    }
    // vertical
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= size) continue;
          s += b[yy * size + x];
          n++;
        }
        a[y * size + x] = s / n;
      }
    }
  }
  return a;
}

function makePixels(size) {
  const { pad, glow } = LAYOUT[size];
  const A = size - 2 * pad;
  const n = size * size;
  const art = new Float32Array(n * 4); // straight rgb (0..255) + alpha (0..1)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - pad;
          const py = y + (sy + 0.5) / SS - pad;
          const c = sample(px, py, A);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          cov++;
        }
      }
      const i = (y * size + x) * 4;
      if (cov) {
        art[i] = r / cov;
        art[i + 1] = g / cov;
        art[i + 2] = b / cov;
        art[i + 3] = cov / (SS * SS);
      }
    }
  }

  // White halo under the artwork: blurred coverage, scaled by `glow`, fading
  // to nothing well inside the padding.
  let halo = null;
  if (glow > 0) {
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = art[i * 4 + 3];
    const radius = Math.max(1, Math.round(A * 0.03));
    halo = blur(mask, size, radius, 3);
  }

  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = art[i * 4 + 3];
    const h = halo ? Math.min(1, halo[i] * (1 - a)) * glow : 0; // only outside the artwork
    const alpha = a + h * (1 - a);
    if (alpha <= 0) continue;
    // straight-alpha compositing: art over white halo
    const r = (art[i * 4] * a + 255 * h * (1 - a)) / alpha;
    const g = (art[i * 4 + 1] * a + 255 * h * (1 - a)) / alpha;
    const b = (art[i * 4 + 2] * a + 255 * h * (1 - a)) / alpha;
    out[i * 4] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = Math.round(alpha * 255);
  }
  return out;
}

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, makePixels(size));
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
