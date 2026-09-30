import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import {
  mergeCoverageMaps,
  projectSource,
  segmentOffsets,
  sourcesForOffsets,
} from '../e2e/ci-coverage-map.mjs';
import { executedStarts } from '../e2e/coverage-capture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cov-map-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A real esbuild bundle of two modules, as the app's bundles are built (iife + sourcemap). */
async function bundle() {
  writeFileSync(
    join(dir, 'alpha.ts'),
    'export const LIMIT = 3;\nexport function alphaWork(n: number) {\n  return n * LIMIT;\n}\n',
  );
  writeFileSync(
    join(dir, 'beta.ts'),
    "import { alphaWork } from './alpha';\nexport const betaWork = (s: string) => s.length;\n" +
      '(globalThis as any).run = () => alphaWork(2) + betaWork("xy");\n',
  );
  const r = await esbuild.build({
    entryPoints: [join(dir, 'beta.ts')],
    bundle: true,
    format: 'iife',
    sourcemap: 'external',
    write: false,
    outfile: join(dir, 'out', 'b.js'),
  });
  const js = r.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const map = JSON.parse(r.outputFiles.find((f) => f.path.endsWith('.map'))?.text ?? '{}');
  return { js, map };
}

describe('segmentOffsets + sourcesForOffsets', () => {
  it('attributes a function to the file that defines it', async () => {
    const { js, map } = await bundle();
    const index = segmentOffsets(map.mappings, js);
    expect(index.offsets.length).toBeGreaterThan(3);
    expect([...index.offsets]).toEqual([...index.offsets].sort((a, b) => a - b));
    const mapSources = map.sources.map((s: string) => s.replace(/^.*cov-map-[^/]+\//, '../'));
    const at = (needle: string) => js.indexOf(needle);
    expect(at('function alphaWork')).toBeGreaterThan(0);
    expect(sourcesForOffsets([at('function alphaWork')], index, mapSources)).toEqual(
      new Set(['alpha.ts']),
    );
    expect(sourcesForOffsets([at('(s) =>')], index, mapSources)).toEqual(new Set(['beta.ts']));
    expect(sourcesForOffsets([], index, mapSources)).toEqual(new Set());
  });
});

describe('projectSource', () => {
  it.each([
    ['../webview/app.tsx', 'webview/app.tsx'],
    ['../src/a/b.ts', 'src/a/b.ts'],
    ['../node_modules/react/index.js', null],
    ['../../elsewhere.ts', null],
    ['webpack://pdf.js/src/display/api.js', null],
  ])('%s → %s', (source, expected) => {
    expect(projectSource(source)).toBe(expected);
  });
});

describe('mergeCoverageMaps', () => {
  it('replaces the scenarios this nightly covered and keeps the rest', () => {
    const prev = { builtFrom: 'old', scenarios: { a: ['x.ts'], b: ['y.ts'] } };
    expect(mergeCoverageMaps(prev, [{ a: ['z.ts'] }, { c: ['w.ts'] }], 'new')).toEqual({
      builtFrom: 'new',
      scenarios: { a: ['z.ts'], b: ['y.ts'], c: ['w.ts'] },
    });
    expect(mergeCoverageMaps(null, [], 's')).toEqual({ builtFrom: 's', scenarios: {} });
  });
});

describe('executedStarts', () => {
  it('keeps the start of every function that ran in an app bundle, not the script itself', () => {
    const fn = (start: number, count: number) => ({
      ranges: [{ startOffset: start, endOffset: start + 5, count }],
    });
    expect(
      executedStarts([
        { url: 'file:///D:/a/conduit/out/webview.js', functions: [fn(0, 1), fn(10, 2), fn(20, 0)] },
        { url: String.raw`D:\a\conduit\out\main.js`, functions: [fn(30, 1)] },
        { url: String.raw`D:\a\conduit\out\preload.js`, functions: [fn(40, 1)] },
        { url: 'node:events', functions: [fn(50, 1)] },
      ]),
    ).toEqual({ 'webview.js': [10], 'main.js': [30] });
  });
});
