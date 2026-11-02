import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONO_FONTS, UI_FONTS } from '../../webview/themes';

// The bundled faces against what they claim: every face the stacks name is local, its weights are
// in the file, its glyph table holds what the terminal relies on, and its license ships
// (spec 2026-11-02 §8). Coverage is read from the files' own cmap, not from document.fonts.check.

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

interface Face {
  family: string;
  file: string;
  weights: [number, number];
}

function faces(): Face[] {
  const css = read('webview', 'fonts.css');
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const family = /font-family:\s*"([^"]+)"/.exec(body)?.[1] ?? '';
    const file = /url\("\.\.\/assets\/fonts\/([^"]+)"\)/.exec(body)?.[1] ?? '';
    const [lo, hi = lo] = (/font-weight:\s*([\d ]+);/.exec(body)?.[1] ?? '').trim().split(/\s+/);
    return { family, file, weights: [Number(lo), Number(hi)] };
  });
}

/** Minimal sfnt reader: the cmap's code points and the OS/2 weight or fvar wght range. */
function inspect(file: string): { cps: Set<number>; wght: [number, number] } {
  const b = readFileSync(join(ROOT, 'assets', 'fonts', file));
  const tables = new Map<string, number>();
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const o = 12 + i * 16;
    tables.set(b.toString('latin1', o, o + 4), b.readUInt32BE(o + 8));
  }
  const cmap = tables.get('cmap') ?? 0;
  let sub = -1;
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const at = cmap + b.readUInt32BE(cmap + 8 + i * 8);
    const fmt = b.readUInt16BE(at);
    if (fmt === 12 || (fmt === 4 && sub < 0)) sub = at;
  }
  const cps = new Set<number>();
  if (b.readUInt16BE(sub) === 12) {
    for (let g = 0; g < b.readUInt32BE(sub + 12); g++) {
      const o = sub + 16 + g * 12;
      for (let c = b.readUInt32BE(o); c <= b.readUInt32BE(o + 4); c++) cps.add(c);
    }
  } else {
    const seg = b.readUInt16BE(sub + 6);
    const ends = sub + 14;
    const starts = ends + seg + 2;
    const deltas = starts + seg;
    const ranges = deltas + seg;
    for (let i = 0; i < seg; i += 2) {
      const end = b.readUInt16BE(ends + i);
      const start = b.readUInt16BE(starts + i);
      const ro = b.readUInt16BE(ranges + i);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        const gid = ro === 0 ? 1 : b.readUInt16BE(ranges + i + ro + (c - start) * 2);
        if (gid !== 0) cps.add(c);
      }
    }
  }
  const fvar = tables.get('fvar');
  if (fvar === undefined) {
    const w = b.readUInt16BE((tables.get('OS/2') ?? 0) + 4);
    return { cps, wght: [w, w] };
  }
  const axes = fvar + b.readUInt16BE(fvar + 4);
  for (let i = 0; i < b.readUInt16BE(fvar + 8); i++) {
    const a = axes + i * 20;
    if (b.toString('latin1', a, a + 4) === 'wght') {
      return { cps, wght: [b.readInt32BE(a + 4) / 65536, b.readInt32BE(a + 12) / 65536] };
    }
  }
  throw new Error(`${file}: variable font without a wght axis`);
}

const has = (cps: Set<number>, chars: string) =>
  [...chars].every((c) => cps.has(c.codePointAt(0) ?? -1));
const count = (cps: Set<number>, lo: number, hi: number) => {
  let n = 0;
  for (let c = lo; c <= hi; c++) if (cps.has(c)) n++;
  return n;
};
const fileOf = (family: string) => faces().filter((f) => f.family === family);

describe('bundled font faces', () => {
  it('every family a stack names has a local face, and every face file exists', () => {
    const families = new Set(faces().map((f) => f.family));
    for (const def of [...UI_FONTS, ...MONO_FONTS].filter((d) => d.bundled)) {
      expect(families, def.label).toContain(def.label);
    }
    expect(families).toContain('Cascadia Mono');
    for (const f of faces())
      expect(existsSync(join(ROOT, 'assets', 'fonts', f.file)), f.file).toBe(true);
  });

  it('IBM Plex Mono, the one static mono family, ships every weight the UI asks for', () => {
    expect(fileOf('IBM Plex Mono').map((f) => f.weights)).toEqual([
      [400, 400],
      [500, 500],
      [600, 600],
      [700, 700],
    ]);
  });

  it('only the platform UI font is unbundled', () => {
    expect(UI_FONTS.filter((d) => !d.bundled).map((d) => d.id)).toEqual(['system']);
    expect(MONO_FONTS.every((d) => d.bundled)).toBe(true);
  });

  it('every family has regular and bold, and each face declares exactly the weights its file has', () => {
    const byFamily = new Map<string, Face[]>();
    for (const f of faces()) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
    for (const [family, list] of byFamily) {
      for (const w of [400, 700]) {
        expect(
          list.some((f) => f.weights[0] <= w && w <= f.weights[1]),
          `${family} ${w}`,
        ).toBe(true);
      }
      for (const f of list) expect(inspect(f.file).wght, f.file).toEqual(f.weights);
    }
  });
});

describe('glyph coverage of the terminal faces (measured upstream cmaps)', () => {
  const mono = ['JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Cascadia Mono'];

  it('every mono face draws the full box-drawing and block ranges', () => {
    for (const family of mono) {
      for (const f of fileOf(family)) {
        const { cps } = inspect(f.file);
        expect(count(cps, 0x2500, 0x257f), f.file).toBe(128);
        expect(count(cps, 0x2580, 0x259f), f.file).toBe(32);
        expect(has(cps, '·…│─'), f.file).toBe(true);
      }
    }
  });

  it('Cascadia Mono, the first fallback, adds ❯ ● and full braille', () => {
    const { cps } = inspect(fileOf('Cascadia Mono')[0].file);
    expect(has(cps, '❯●')).toBe(true);
    expect(count(cps, 0x2800, 0x28ff)).toBe(256);
  });

  it('no bundled mono face has ✔ ⏺ ⎿ ✻, which is why the stack names Segoe UI Symbol next', () => {
    for (const family of mono) {
      for (const f of fileOf(family)) {
        const { cps } = inspect(f.file);
        for (const ch of '✔⏺⎿✻')
          expect(cps.has(ch.codePointAt(0) ?? -1), `${f.file} ${ch}`).toBe(false);
      }
    }
  });
});

describe('font licenses and packaging', () => {
  const notices = read('THIRD_PARTY_NOTICES.txt');

  it('names every bundled family in the notices with an OFL text that exists', () => {
    for (const family of new Set(faces().map((f) => f.family))) expect(notices).toContain(family);
    const licenses = [...notices.matchAll(/([a-z-]+-OFL\.txt)/g)].map((m) => m[1]);
    expect(new Set(licenses).size).toBe(9);
    for (const name of licenses) {
      expect(read('assets', 'fonts', 'licenses', name)).toContain(
        'SIL Open Font License, Version 1.1',
      );
    }
  });

  it('package installs the font licenses under resources', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.build.extraResources).toContainEqual({
      from: 'assets/fonts/licenses',
      to: 'licenses/fonts',
    });
  });

  it('the entry imports the faces itself, and the font service does not', () => {
    expect(read('webview', 'index.tsx')).toMatch(/import '\.\/fonts';/);
    expect(read('webview', 'fonts.ts')).toMatch(/import '\.\/fonts\.css';/);
    expect(read('webview', 'terminal-fonts.ts')).not.toMatch(/from '\.\/fonts'|\.\/fonts\.css/);
  });
});

describe('the built renderer bundle', () => {
  // The real esbuild renderer build into a temp dir: what ships, not what the sources say.
  let out = '';
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'conduit-font-bundle-'));
    const { webBuild, writeHtml } = await import('../../esbuild.mjs');
    await esbuild.build({ ...webBuild(out), logLevel: 'silent', sourcemap: false });
    writeHtml(out);
  }, 120_000);
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('emits every bundled face byte-identical, referenced from webview.css', () => {
    const css = readFileSync(join(out, 'webview.css'), 'utf8');
    for (const f of faces()) {
      const stem = f.file.replace(/\.ttf$/, '');
      const ref = new RegExp(`url\\("\\./(${stem}-[A-Z0-9]+\\.ttf)"\\)`).exec(css);
      expect(ref, f.file).not.toBeNull();
      const emitted = readFileSync(join(out, ref?.[1] ?? ''));
      expect(emitted.equals(readFileSync(join(ROOT, 'assets', 'fonts', f.file))), f.file).toBe(
        true,
      );
    }
  });

  it('the page allows fonts and styles from itself only', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(
      readFileSync(join(out, 'index.html'), 'utf8'),
    )?.[1];
    expect(csp).toContain("font-src 'self';");
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).not.toMatch(/https:/);
  });

  it('ships the notices and every font license beside the fonts', () => {
    expect(readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(
      read('THIRD_PARTY_NOTICES.txt'),
    );
    const names = readdirSync(join(ROOT, 'assets', 'fonts', 'licenses'));
    expect(names).toHaveLength(9);
    for (const name of names) {
      expect(readFileSync(join(out, 'licenses', 'fonts', name), 'utf8')).toBe(
        read('assets', 'fonts', 'licenses', name),
      );
    }
  });
});
