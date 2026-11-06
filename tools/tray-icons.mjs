import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets', 'icon.ico');
const OUT_DIR = join(ROOT, 'native', 'tray', 'res');

// Only the sizes the taskbar asks for at 100-300% DPI; the 256px entry is never shown here.
const KEEP_SIZES = [16, 32, 48];
// Matches the app icon's visual weight in the taskbar; the dot must stay in the bottom-right quadrant.
const DOT_DIAMETER = 0.45;
const RING_PX = 1;
const WHITE = [255, 255, 255];
const STATES = [
  { file: 'normal.ico', colour: null },
  { file: 'needs.ico', colour: 'F5A524' },
  { file: 'warning.ico', colour: 'E5484D' },
];
const SUBSAMPLES = 4;

/** @param {string} hex */
function bgr(hex) {
  const v = Number.parseInt(hex, 16);
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/** @param {Buffer} buf */
function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('tray-icons: source is not an .ico file');
  }
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const width = buf[at] === 0 ? 256 : buf[at];
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.push({
      width,
      directory: buf.subarray(at, at + 16),
      data: buf.subarray(offset, offset + bytes),
    });
  }
  return entries;
}

/** Stamps an anti-aliased status dot with a 1px white ring into a BMP icon image. */
function stampDot(bmp, colourHex) {
  const out = Buffer.from(bmp);
  if (out.readUInt32LE(0) !== 40) throw new Error('tray-icons: expected a BITMAPINFOHEADER image');
  const size = out.readInt32LE(4);
  const rows = out.readInt32LE(8) / 2;
  const andOffset = 40 + size * rows * 4;
  const andStride = (out.length - andOffset) / rows;

  const colour = bgr(colourHex);
  const radius = (DOT_DIAMETER / 2) * size;
  const centre = size - 0.5 - radius;
  const samples = SUBSAMPLES * SUBSAMPLES;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inColour = 0;
      let inRing = 0;
      for (let j = 0; j < SUBSAMPLES; j++) {
        for (let i = 0; i < SUBSAMPLES; i++) {
          const dist = Math.hypot(
            x + (i + 0.5) / SUBSAMPLES - centre,
            y + (j + 0.5) / SUBSAMPLES - centre,
          );
          if (dist <= radius - RING_PX) inColour++;
          else if (dist <= radius) inRing++;
        }
      }
      const covered = inColour + inRing;
      if (covered === 0) continue;

      const coverage = covered / samples;
      const weight = inColour / covered;
      const src = colour.map((c, k) => Math.round(c * weight + WHITE[k] * (1 - weight)));
      const row = rows - 1 - y;
      const at = 40 + row * size * 4 + x * 4;
      const dstAlpha = out[at + 3] / 255;
      const outAlpha = coverage + dstAlpha * (1 - coverage);
      for (let k = 0; k < 3; k++) {
        out[at + k] = Math.round(
          (src[k] * coverage + out[at + k] * dstAlpha * (1 - coverage)) / outAlpha,
        );
      }
      out[at + 3] = Math.round(outAlpha * 255);
      out[andOffset + row * andStride + (x >> 3)] &= ~(0x80 >> (x & 7)) & 0xff;
    }
  }
  return out;
}

/** @param {{ directory: Buffer; data: Buffer }[]} entries */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const directories = [];
  for (const entry of entries) {
    const directory = Buffer.from(entry.directory);
    directory.writeUInt32LE(entry.data.length, 8);
    directory.writeUInt32LE(offset, 12);
    directories.push(directory);
    offset += entry.data.length;
  }
  return Buffer.concat([header, ...directories, ...entries.map((entry) => entry.data)]);
}

/**
 * Writes normal.ico, needs.ico and warning.ico built from the app icon's 16/32/48 images.
 * @param {{ source?: string; outDir?: string }} [options]
 * @returns {string[]} written file paths
 */
export function generateTrayIcons({ source = SOURCE, outDir = OUT_DIR } = {}) {
  const parsed = parseIco(readFileSync(source));
  const base = KEEP_SIZES.map((size) => {
    const entry = parsed.find((candidate) => candidate.width === size);
    if (!entry) throw new Error(`tray-icons: ${source} has no ${size}px image`);
    return entry;
  });

  mkdirSync(outDir, { recursive: true });
  return STATES.map(({ file, colour }) => {
    const entries =
      colour === null
        ? base
        : base.map((entry) => ({ ...entry, data: stampDot(entry.data, colour) }));
    const target = join(outDir, file);
    writeFileSync(target, buildIco(entries));
    return target;
  });
}

function main() {
  for (const file of generateTrayIcons()) console.log(relative(ROOT, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
