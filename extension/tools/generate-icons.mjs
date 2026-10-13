#!/usr/bin/env node
/**
 * Generates the extension icons (icons/icon-{16,32,48,128}.png) and the site icon
 * (site/icon-128.png) from the Portly "Beacon" lighthouse (docs/brand/). Smaller sizes use
 * simplified drawings, as the brand rules ask: 16 matches web/public/favicon.svg, 32 drops the
 * gallery and one band, 48 drops the door and the sea line, 128 is the full icon.
 * No dependencies: the shapes are rasterized with 8×8 supersampling and encoded as RGBA PNGs
 * with node:zlib.
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
const SITE_ICON = path.resolve(EXTENSION_DIR, '..', 'site', 'icon-128.png');

/** Design space is 64×64 units, matching the SVGs' viewBox. */
const UNITS = 64;
const CORNER_RADIUS = 14;
const SUPERSAMPLE = 8;

const HARBOR = [0x0b, 0x4f, 0x63];
const TIDE = [0x13, 0x7a, 0x85];
const SKY = [0xa6, 0xde, 0xdb];
const BRASS = [0xe3, 0xa8, 0x2b];
const SUN = [0xff, 0xd1, 0x66];
const WHITE = [0xff, 0xff, 0xff];

function inPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, left, top, width, height, r) {
  if (x < left || y < top || x > left + width || y > top + height) return false;
  const cx = Math.min(Math.max(x, left + r), left + width - r);
  const cy = Math.min(Math.max(y, top + r), top + height - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0), 1);
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Points along quadratic Béziers: `start`, then [control, end] pairs (SVG Q/T, controls explicit). */
function quadratics(start, ...curves) {
  const points = [start];
  let from = start;
  for (const [control, end] of curves) {
    for (let i = 1; i <= 8; i += 1) {
      const t = i / 8;
      const u = 1 - t;
      points.push([u * u * from[0] + 2 * u * t * control[0] + t * t * end[0], u * u * from[1] + 2 * u * t * control[1] + t * t * end[1]]);
    }
    from = end;
  }
  return points;
}

const polygon = (color, points, alpha = 1) => ({ color, alpha, hit: (x, y) => inPolygon(x, y, points) });
const rect = (color, left, top, width, height, r) => ({ color, alpha: 1, hit: (x, y) => inRoundedRect(x, y, left, top, width, height, r) });
const circle = (color, cx, cy, r) => ({ color, alpha: 1, hit: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r });
const stroke = (color, points, width) => ({
  color,
  alpha: 1,
  hit: (x, y) => points.some((p, i) => i > 0 && distanceToSegment(x, y, points[i - 1], p) <= width / 2),
});

/** Layers back to front, on top of the Harbor tile. Mirrors docs/brand/portly-icon.svg. */
const FULL = Object.freeze([
  polygon(SUN, [[29, 19], [6, 11], [6, 27]], 0.3),
  polygon(SUN, [[35, 19], [58, 11], [58, 27]], 0.3),
  polygon(WHITE, [[25.5, 52], [28.5, 24], [35.5, 24], [38.5, 52]]),
  polygon(BRASS, [[27.75, 31], [36.25, 31], [36.68, 35], [27.32, 35]]),
  polygon(BRASS, [[26.68, 41], [37.32, 41], [37.75, 45], [26.25, 45]]),
  rect(HARBOR, 30.5, 47, 3, 5, 1.5),
  rect(BRASS, 26.5, 22.5, 11, 2.5, 1),
  rect(SUN, 29, 16, 6, 6.5, 1),
  polygon(BRASS, [[28, 16], [32, 11], [36, 16]]),
  circle(BRASS, 32, 10.5, 1.2),
  rect(TIDE, 16, 52, 32, 3.5, 1.75),
  stroke(SKY, quadratics([12, 58], [[17, 56], [22, 58]], [[27, 60], [32, 58]], [[37, 56], [42, 58]], [[47, 60], [52, 58]]), 2),
]);

/** 48 px: no door, finial or sea line. */
const MEDIUM = Object.freeze(FULL.filter((_, i) => ![5, 9, 11].includes(i)));

/** 32 px: one band, bigger lantern, brighter beams. */
const SMALL = Object.freeze([
  polygon(SUN, [[29, 19], [5, 10], [5, 28]], 0.4),
  polygon(SUN, [[35, 19], [59, 10], [59, 28]], 0.4),
  polygon(WHITE, [[25, 53], [28.5, 24], [35.5, 24], [39, 53]]),
  polygon(BRASS, [[27.4, 37], [36.6, 37], [37.1, 42], [26.9, 42]]),
  rect(SUN, 28.5, 15, 7, 9, 1),
  polygon(BRASS, [[27, 15], [32, 9.5], [37, 15]]),
]);

/** 16 px (and favicon.svg): tower, lantern, roof and beams only. */
const TINY = Object.freeze([
  polygon(SUN, [[29, 19], [5, 10], [5, 28]], 0.45),
  polygon(SUN, [[35, 19], [59, 10], [59, 28]], 0.45),
  polygon(WHITE, [[24, 54], [28, 24], [36, 24], [40, 54]]),
  rect(SUN, 28, 14, 8, 10, 1.5),
  polygon(BRASS, [[26.5, 14], [32, 8], [37.5, 14]]),
]);

function layersFor(size) {
  if (size <= 16) return TINY;
  if (size <= 32) return SMALL;
  if (size <= 48) return MEDIUM;
  return FULL;
}

/** Raw RGBA pixels (straight alpha), `size * size * 4` bytes, rows top to bottom. */
export function renderIcon(size) {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new RangeError(`invalid icon size ${size}`);
  const layers = layersFor(size);
  const pixels = Buffer.alloc(size * size * 4);
  const scale = UNITS / size;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let square = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          if (!inRoundedRect(x, y, 0, 0, UNITS, UNITS, CORNER_RADIUS)) continue;
          square += 1;
          const color = [...HARBOR];
          for (const layer of layers) {
            if (!layer.hit(x, y)) continue;
            for (let c = 0; c < 3; c += 1) color[c] += (layer.color[c] - color[c]) * layer.alpha;
          }
          for (let c = 0; c < 3; c += 1) sum[c] += color[c];
        }
      }
      if (square === 0) continue; // fully transparent
      const offset = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.round(sum[c] / square);
      pixels[offset + 3] = Math.round((square / samples) * 255);
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

/** Every PNG this script owns: the extension icons plus the site's copy of the 128 px one. */
export const ICON_FILES = Object.freeze([
  ...ICON_SIZES.map((size) => ({ size, file: iconPath(size) })),
  { size: 128, file: SITE_ICON },
]);

/** True when the PNG on disk exists and decodes to exactly renderIcon(size). */
export function iconIsCurrent(size, file = iconPath(size)) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
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
  for (const { size, file } of ICON_FILES) {
    const relative = path.relative(process.cwd(), file);
    if (check) {
      if (!iconIsCurrent(size, file)) {
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
