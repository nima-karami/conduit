import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTrayIcons } from '../../tools/tray-icons.mjs';

const ROOT = join(__dirname, '..', '..');
const SIZES = [16, 32, 48];
const LIGHT_LEVEL_ICON_FILES = ['normal.ico', 'needs.ico', 'warning.ico'];

interface IcoImage {
  size: number;
  data: Buffer;
}

interface Bitmap {
  width: number;
  rows: number;
  xor: Buffer;
  and: Buffer;
  andStride: number;
}

function parseIco(buf: Buffer): Map<number, IcoImage> {
  const images = new Map<number, IcoImage>();
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const width = buf[entry] === 0 ? 256 : buf[entry];
    const bytes = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    images.set(width, { size: width, data: buf.subarray(offset, offset + bytes) });
  }
  return images;
}

function bitmapOf(data: Buffer): Bitmap {
  const width = data.readInt32LE(4);
  const rows = data.readInt32LE(8) / 2;
  const xorBytes = width * rows * 4;
  const andStride = (data.length - 40 - xorBytes) / rows;
  return {
    width,
    rows,
    xor: data.subarray(40, 40 + xorBytes),
    and: data.subarray(40 + xorBytes),
    andStride,
  };
}

/** Top-down pixel read; ICO bitmaps are stored bottom-up. */
function pixelAt(bitmap: Bitmap, x: number, y: number) {
  const row = bitmap.rows - 1 - y;
  const at = row * bitmap.width * 4 + x * 4;
  const opaque = (bitmap.and[row * bitmap.andStride + (x >> 3)] & (0x80 >> (x & 7))) === 0;
  return {
    b: bitmap.xor[at],
    g: bitmap.xor[at + 1],
    r: bitmap.xor[at + 2],
    a: bitmap.xor[at + 3],
    opaque,
  };
}

function hex(p: { r: number; g: number; b: number }) {
  return [p.r, p.g, p.b]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

describe('tools/tray-icons.mjs', () => {
  let outDir: string;
  let generated: Map<string, Buffer>;
  let appIcon: Map<number, IcoImage>;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'tray-icons-'));
    generateTrayIcons({ outDir });
    generated = new Map(
      LIGHT_LEVEL_ICON_FILES.map((name) => [name, readFileSync(join(outDir, name))]),
    );
    appIcon = parseIco(readFileSync(join(ROOT, 'assets', 'icon.ico')));
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('normal.ico carries the app icon 16, 32 and 48 images byte for byte', () => {
    const normal = parseIco(generated.get('normal.ico') as Buffer);
    expect([...normal.keys()].sort((a, b) => a - b)).toEqual(SIZES);
    for (const size of SIZES) {
      expect(normal.get(size)?.data.equals(appIcon.get(size)?.data as Buffer)).toBe(true);
    }
  });

  it('needs.ico and warning.ico keep the same sizes as normal.ico', () => {
    for (const name of ['needs.ico', 'warning.ico']) {
      const images = parseIco(generated.get(name) as Buffer);
      expect([...images.keys()].sort((a, b) => a - b)).toEqual(SIZES);
    }
  });

  it('status dots change only the bottom-right quadrant', () => {
    for (const name of ['needs.ico', 'warning.ico']) {
      const images = parseIco(generated.get(name) as Buffer);
      for (const size of SIZES) {
        const base = bitmapOf(appIcon.get(size)?.data as Buffer);
        const changed = bitmapOf(images.get(size)?.data as Buffer);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const before = pixelAt(base, x, y);
            const after = pixelAt(changed, x, y);
            if (JSON.stringify(before) === JSON.stringify(after)) continue;
            expect(x >= size / 2 && y >= size / 2, `${name} ${size}px changed at ${x},${y}`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it('the status dot centre has the state colour', () => {
    const expected: Record<string, string> = {
      'needs.ico': 'F5A524',
      'warning.ico': 'E5484D',
    };
    for (const [name, colour] of Object.entries(expected)) {
      const images = parseIco(generated.get(name) as Buffer);
      for (const size of SIZES) {
        const bitmap = bitmapOf(images.get(size)?.data as Buffer);
        const centre = Math.floor(size - 0.5 - 0.225 * size);
        const pixel = pixelAt(bitmap, centre, centre);
        expect(hex(pixel), `${name} ${size}px`).toBe(colour);
        expect(pixel.a).toBe(255);
        expect(pixel.opaque).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    const again = mkdtempSync(join(tmpdir(), 'tray-icons-again-'));
    try {
      generateTrayIcons({ outDir: again });
      for (const name of LIGHT_LEVEL_ICON_FILES) {
        expect(readFileSync(join(again, name)).equals(generated.get(name) as Buffer)).toBe(true);
      }
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });
});
