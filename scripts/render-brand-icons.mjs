#!/usr/bin/env node
/**
 * Renders the PNG icons a phone home screen needs from the same geometry as
 * `apps/web/public/mark.svg`.
 *
 * iOS does not read SVG for `apple-touch-icon`, and Android's maskable icons
 * want a full-bleed raster it can crop its own shape out of — two things the
 * favicon SVG cannot be. Rather than vendoring an image toolchain for one
 * letter made of three straight strokes, this evaluates that geometry per
 * pixel (distance to a butt-capped stroke) and writes the PNGs itself.
 * Deterministic on purpose: the committed icons are reproducible by running
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

// The K of the KUMI wordmark, from mark.svg: a 48-unit box holding a stem and
// two arms that meet it at mid-height, every one of them the same 6.6-wide
// stroke with flat ends.
//
// The arms are given as running to x 9 — past the vertex, into the stem —
// where mark.svg instead stops them at 13.5 and lets a mitred join make the
// point. The two agree everywhere that shows: the stem covers the overshoot,
// and the arms' own edges, not the join, are what the eye reads as the
// letter's notch. Extending them is what lets this file treat each stroke
// independently rather than reproducing SVG's join rules.
const BOX = 48;
const STROKE = 6.6;
const HALF_STROKE = STROKE / 2;
const BACKGROUND = [0x1a, 0x1a, 0x1a];
const INK = [0xed, 0xed, 0xed];

/** Each stroke as the two ends of its centre line. */
const STROKES = [
  [8.3, 8, 8.3, 40],
  [42, 11, 9, 24],
  [42, 37, 9, 24],
];

/**
 * Whether a point lies on one stroke: inside its width, and between its two
 * ends rather than beyond them, which is what a flat end means.
 */
function onStroke(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  // Distance along the stroke, and away from it, in the stroke's own frame.
  const along = ((x - x1) * dx + (y - y1) * dy) / length;
  const across = ((x - x1) * -dy + (y - y1) * dx) / length;
  return along >= 0 && along <= length && Math.abs(across) <= HALF_STROKE;
}

/** The mark's colour at one point of the 48-unit box: ink on any stroke. */
function inkAt(x, y) {
  return STROKES.some((stroke) => onStroke(x, y, stroke));
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
