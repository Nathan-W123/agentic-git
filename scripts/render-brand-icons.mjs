#!/usr/bin/env node
/**
 * Renders the PNG icons a phone home screen needs from the same geometry as
 * `apps/web/public/mark.svg`.
 *
 * iOS does not read SVG for `apple-touch-icon`, and Android's maskable icons
 * want a full-bleed raster it can crop its own shape out of — two things the
 * favicon SVG cannot be. Rather than vendoring an image toolchain for one
 * mark made of two rounded-rectangle strokes, this evaluates that geometry
 * per pixel (signed distance to a rounded rectangle, the same weave mask the
 * SVG applies) and writes the PNGs itself. Deterministic on purpose: the
 * committed icons are reproducible by running
 *
 *     node scripts/render-brand-icons.mjs
 *
 * and any change to the mark belongs in mark.svg, ui.js's brandMark, and
 * here together.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "web",
  "public",
);

/* ------------------------------------------------ the mark, in numbers --- */

// From mark.svg: a 48-unit box; one rounded rect (x 9, y 17.5, w 30, h 13,
// rx 6.5) stroked at 3.2, drawn twice — rotated +45° and −45° about the
// centre — with the +45 bar erased where the −45 bar's 7-wide mask stroke
// crosses it, which is what makes the two read as woven.
const BOX = 48;
const CENTER = BOX / 2;
const HALF_W = 15;
const HALF_H = 6.5;
const CORNER = 6.5;
const STROKE = 3.2;
const MASK_STROKE = 7;
const BACKGROUND = [0x1a, 0x1a, 0x1a];
const INK = [0xed, 0xed, 0xed];

/** Signed distance from a point (in the rect's own frame) to its outline. */
function roundedRectDistance(x, y) {
  const qx = Math.abs(x) - (HALF_W - CORNER);
  const qy = Math.abs(y) - (HALF_H - CORNER);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - CORNER;
}

/** Distance in the frame of the bar rotated by `degrees` about the centre. */
function barDistance(x, y, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const dx = x - CENTER;
  const dy = y - CENTER;
  // Inverse rotation: the sample moves into the bar's local frame.
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return roundedRectDistance(localX, localY);
}

/**
 * The mark's colour at one point of the 48-unit box: ink on either bar,
 * except where the weave mask hides the +45 bar under the −45 one.
 */
function inkAt(x, y) {
  const over = Math.abs(barDistance(x, y, -45)) <= STROKE / 2;
  if (over) {
    return true;
  }
  const under = Math.abs(barDistance(x, y, 45)) <= STROKE / 2;
  const cut = Math.abs(barDistance(x, y, -45)) <= MASK_STROKE / 2;
  return under && !cut;
}

/* --------------------------------------------------------- rasterising --- */

/**
 * Full-bleed square: the platforms these are for round the corners
 * themselves (iOS masks the whole tile; Android crops maskable icons), so
 * baking mark.svg's own corner radius in would leave visible dark notches
 * inside the platform's shape.
 */
function renderSquare(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const sub = 4; // 4×4 supersampling keeps the thin strokes smooth.
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverage = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const x = ((px + (sx + 0.5) / sub) / size) * BOX;
          const y = ((py + (sy + 0.5) / sub) / size) * BOX;
          if (inkAt(x, y)) {
            coverage += 1;
          }
        }
      }
      const t = coverage / (sub * sub);
      const at = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[at + channel] = Math.round(
          BACKGROUND[channel] + (INK[channel] - BACKGROUND[channel]) * t,
        );
      }
      pixels[at + 3] = 0xff;
    }
  }
  return pixels;
}

/* -------------------------------------------------------- PNG plumbing --- */

const CRC_TABLE = new Int32Array(256).map((_ignored, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // Filter byte 0 (None) ahead of every scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    pixels.copy(
      raw,
      row * (size * 4 + 1) + 1,
      row * size * 4,
      (row + 1) * size * 4,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  // What iOS reads for the home screen; 180 covers every current device.
  ["apple-touch-icon.png", 180],
  // What the manifest offers Android — one small, one splash-sized.
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  const file = path.join(PUBLIC_DIR, name);
  writeFileSync(file, encodePng(size, renderSquare(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
