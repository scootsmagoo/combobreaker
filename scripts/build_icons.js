#!/usr/bin/env node
// Generates ComboBreaker icons (16/32/48/128) as PNG using only Node built-ins.
// Run: `node scripts/build_icons.js`
// Design: dark navy square, rounded corners, a magenta diagonal "break" slash.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "icons");
fs.mkdirSync(OUT, { recursive: true });

const COLORS = {
  bg: [16, 20, 32, 255],
  accent: [236, 72, 153, 255],
  ring: [56, 189, 248, 255],
  void: [0, 0, 0, 0],
};

function makePixels(size) {
  const px = new Uint8Array(size * size * 4);
  const r = size / 2;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.46;
  const cornerR = size * 0.22;

  function set(x, y, c) {
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let inSquare = true;
      if (dx < cornerR && dy < cornerR) {
        const ex = cornerR - dx;
        const ey = cornerR - dy;
        if (Math.sqrt(ex * ex + ey * ey) > cornerR) inSquare = false;
      }
      if (!inSquare) {
        set(x, y, COLORS.void);
        continue;
      }

      const ringDx = x - cx;
      const ringDy = y - cy;
      const dist = Math.sqrt(ringDx * ringDx + ringDy * ringDy);
      const ringOuter = radius;
      const ringInner = radius - Math.max(2, size * 0.09);

      const slashDist = Math.abs(ringDx + ringDy) / Math.SQRT2;
      const slashHalfWidth = Math.max(1.5, size * 0.07);
      const inSlash = slashDist <= slashHalfWidth && dist <= radius - 1;

      if (inSlash) {
        set(x, y, COLORS.accent);
      } else if (dist <= ringOuter && dist >= ringInner) {
        set(x, y, COLORS.ring);
      } else {
        set(x, y, COLORS.bg);
      }
    }
  }
  return px;
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
  for (let i = 0; i < buf.length; i++)
    c = (crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const pixels = makePixels(size);
  const png = encodePng(size, pixels);
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
