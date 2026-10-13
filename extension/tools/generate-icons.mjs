#!/usr/bin/env node
/**
 * Generates the extension icons (icons/icon-{16,32,48,128}.png) from the same design as
 * web/public/favicon.svg: a rounded square with a diagonal #1e3a8a → #6d28d9 gradient and a
 * white house. No dependencies: the shapes are rasterized with 8×8 supersampling and encoded
 * as RGBA PNGs with node:zlib.
 *
 *   node extension/tools/generate-icons.mjs          write the PNGs
 *   node extension/tools/generate-icons.mjs --check  exit 1 if a PNG is missing or out of date
 *
 * The rasterizer is deterministic; the tests compare the committed PNGs' decoded pixels with
 * renderIcon() (not the compressed bytes, which can differ between zlib versions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Design space is 64×64 units, matching favicon.svg's viewBox. */
const UNITS = 64;
const CORNER_RADIUS = 14;
const GRADIENT_FROM = [0x1e, 0x3a, 0x8a];
const GRADIENT_TO = [0x6d, 0x28, 0xd9];
const SUPERSAMPLE = 8;

/** Points along a circular arc (end point included, start point excluded). */
function arc(cx, cy, r, fromDeg, toDeg, steps = 8) {
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return points;
}

/**
 * favicon.svg house: M16 31 32 17l16 14v15a3 3 0 0 1-3 3h-8V37h-10v12h-8a3 3 0 0 1-3-3z
 * (y grows downwards, so the sweep-flag-1 arcs run clockwise on screen).
 */
const HOUSE = Object.freeze([
  [16, 31],
  [32, 17],
  [48, 31],
  [48, 46],
  ...arc(45, 46, 3, 0, 90),
  [37, 49],
  [37, 37],
  [27, 37],
  [27, 49],
  [19, 49],
  ...arc(19, 46, 3, 90, 180),
]);

function inPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x > UNITS || y > UNITS) return false;
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(x, r), UNITS - r);
  const cy = Math.min(Math.max(y, r), UNITS - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Raw RGBA pixels (straight alpha), `size * size * 4` bytes, rows top to bottom. */
export function renderIcon(size) {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new RangeError(`invalid icon size ${size}`);
  const pixels = Buffer.alloc(size * size * 4);
  const scale = UNITS / size;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let square = 0;
      let house = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          if (!inRoundedSquare(x, y)) continue;
          square += 1;
          if (inPolygon(x, y, HOUSE)) house += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (square === 0) continue; // fully transparent
      // SVG objectBoundingBox gradient from (0,0) to (1,1): t is the projection on the diagonal.
      const t = Math.min(Math.max(((px + 0.5) * scale + (py + 0.5) * scale) / (2 * UNITS), 0), 1);
      const coverage = square / samples;
      const white = house / square;
      for (let c = 0; c < 3; c += 1) {
        const gradient = GRADIENT_FROM[c] + (GRADIENT_TO[c] - GRADIENT_FROM[c]) * t;
        pixels[offset + c] = Math.round(gradient * (1 - white) + 255 * white);
      }
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes straight-alpha RGBA pixels as an 8-bit RGBA PNG (filter type 0 on every row). */
export function encodePng(size, rgba) {
  if (rgba.length !== size * size * 4) throw new RangeError('pixel buffer does not match the size');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function iconPath(size) {
  return path.join(EXTENSION_DIR, 'icons', `icon-${size}.png`);
}

/**
 * Minimal decoder for the PNGs this script writes (8-bit RGBA, non-interlaced, filter 0).
 * Validates the signature and every chunk CRC. Returns `{width, height, pixels}`.
 */
export function decodePng(bytes) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let offset = 8;
  let header = null;
  const idat = [];
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`truncated ${type} chunk`);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    if (zlib.crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== crc) throw new Error(`bad CRC in ${type} chunk`);
    if (type === 'IHDR') header = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!header || !ended) throw new Error('PNG is missing IHDR or IEND');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) throw new Error('unsupported PNG format (expected 8-bit RGBA)');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('unexpected PNG data length');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unsupported PNG row filter');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, pixels };
}

/** True when the PNG on disk exists and decodes to exactly renderIcon(size). */
export function iconIsCurrent(size) {
  let bytes;
  try {
    bytes = fs.readFileSync(iconPath(size));
  } catch {
    return false;
  }
  try {
    const png = decodePng(bytes);
    return png.width === size && png.height === size && png.pixels.equals(renderIcon(size));
  } catch {
    return false;
  }
}

function main(argv) {
  const check = argv.includes('--check');
  let stale = 0;
  for (const size of ICON_SIZES) {
    const file = iconPath(size);
    const relative = path.relative(process.cwd(), file);
    if (check) {
      if (!iconIsCurrent(size)) {
        stale += 1;
        process.stderr.write(`out of date: ${relative}\n`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(size, renderIcon(size)));
    process.stdout.write(`wrote ${relative}\n`);
  }
  if (check && stale > 0) {
    process.stderr.write('Run `node extension/tools/generate-icons.mjs` to regenerate the icons.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
