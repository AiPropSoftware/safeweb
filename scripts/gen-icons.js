// Generate SafeWeb extension icons (a white shield on a brand-blue rounded
// square) as valid PNGs — no image libraries, just zlib. Run: node scripts/gen-icons.js
// Output is committed so the unpacked extension loads without a build step.

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const BRAND = [47, 109, 240]; // #2f6df0
const WHITE = [255, 255, 255];

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// Is normalized point (nx,ny) in [-1,1] inside a shield silhouette?
function inShield(nx, ny) {
  const halfTop = 0.62;
  if (ny < -0.78 || ny > 0.9) return false;
  let hw;
  if (ny <= 0.15) {
    hw = halfTop;
    // round the top corners
    if (ny < -0.5) {
      const dy = (ny + 0.5) / 0.28; // 0..-1
      hw = halfTop * Math.sqrt(Math.max(0, 1 - dy * dy));
    }
  } else {
    // taper to a point at the bottom
    hw = halfTop * Math.max(0, 1 - (ny - 0.15) / 0.75);
  }
  return Math.abs(nx) <= hw;
}

// Rounded-square background mask.
function inRounded(nx, ny, r = 0.82) {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  if (ax <= r || ay <= r) return ax <= 1 && ay <= 1;
  const dx = ax - r;
  const dy = ay - r;
  return dx * dx + dy * dy <= (1 - r) * (1 - r);
}

function makePng(size) {
  const bytesPerPixel = 4;
  const stride = size * bytesPerPixel + 1; // +1 filter byte per row
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      let rgba;
      if (!inRounded(nx, ny)) {
        rgba = [0, 0, 0, 0]; // transparent outside the rounded square
      } else if (inShield(nx, ny * 1.02)) {
        rgba = [...WHITE, 255];
      } else {
        rgba = [...BRAND, 255];
      }
      const off = y * stride + 1 + x * bytesPerPixel;
      raw[off] = rgba[0];
      raw[off + 1] = rgba[1];
      raw[off + 2] = rgba[2];
      raw[off + 3] = rgba[3];
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
  const png = makePng(size);
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  console.log(`wrote extension/icons/icon-${size}.png (${png.length} bytes)`);
}
