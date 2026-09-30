import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectAffected } from '../e2e/ci-affected.mjs';
import {
  mergeCoverageMaps,
  mergeSpans,
  projectSource,
  segmentOffsets,
  spansForRanges,
} from '../e2e/ci-coverage-map.mjs';
import { executedRanges } from '../e2e/coverage-capture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cov-map-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Built like the app's renderer (iife + sourcemap; a dynamic import makes esbuild wrap `lazy.ts` in
 * an `__esm` init function), run under the same function-granularity coverage the harness takes.
 */
const FILES = {
  'alpha.ts': [
    'export const LIMIT = 3;',
    'export function alphaWork(n: number) {',
    '  return n * LIMIT;',
    '}',
    'export function neverCalled() {',
    "  return 'x';",
    '}',
  ],
  'lazy.ts': [
    'export const TABLE = [1, 2].map((x) => x * 2);',
    'export function lazyWork() {',
    '  return TABLE.length;',
    '}',
  ],
  'menu.ts': [
    'export const NAV = [',
    "  { id: 'a', run: () => go('a') },",
    "  { id: 'b', run: () => go('b') },",
    '];',
    'function go(x: string) {',
    '  return x;',
    '}',
    'export const make = (n: number) => {',
    '  return n + 1;',
    '};',
  ],
  'entry.ts': [
    "import { alphaWork } from './alpha';",
    "import { make, NAV } from './menu';",
    '(globalThis as any).e2eCovFixture = async () => {',
    '  const a = alphaWork(2);',
    "  const m = await import('./lazy');",
    '  NAV[0].run();',
    '  return a + m.lazyWork() + make(1);',
    '};',
  ],
};

let spans: Record<string, [number, number][]>;

beforeAll(async () => {
  for (const [f, lines] of Object.entries(FILES)) writeFileSync(join(dir, f), lines.join('\n'));
  const r = await esbuild.build({
    entryPoints: [join(dir, 'entry.ts')],
    bundle: true,
    format: 'iife',
    sourcemap: 'external',
    write: false,
    outfile: join(dir, 'out', 'webview.js'),
  });
  const js = r.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const map = JSON.parse(r.outputFiles.find((f) => f.path.endsWith('.map'))?.text ?? '{}');
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  vm.runInThisContext(js, { filename: 'file:///fixture/out/webview.js' });
  await (globalThis as unknown as { e2eCovFixture: () => Promise<number> }).e2eCovFixture();
  const { result } = await session.post('Profiler.takePreciseCoverage');
  await session.post('Profiler.stopPreciseCoverage');
  session.disconnect();
  const ranges = executedRanges(result as Parameters<typeof executedRanges>[0])['webview.js'];
  spans = spansForRanges(ranges, segmentOffsets(map.mappings, js), map.sources);
});

describe('coverage → credited function spans', () => {
  it('credits only the lines of functions that ran, never top-level code or wrappers', () => {
    expect(spans).toEqual({
      'alpha.ts': [[2, 4]],
      'lazy.ts': [[2, 4]],
      'menu.ts': [
        [5, 7],
        [9, 10],
      ],
      'entry.ts': [[4, 8]],
    });
  });

  it('feeds --affected: a change inside a function that ran selects its scenario, anything else is full', () => {
    const map = mergeCoverageMaps(null, [{ fixture: spans }], 'sha', { fixture: 'PASS' });
    const ctx = { map, all: ['fixture', 'other'], core: [], excluded: [] };
    const at = (path: string, line: number) =>
      selectAffected([{ path, status: 'M', hunks: [{ start: line, count: 1 }] }], ctx);
    expect(at('alpha.ts', 3)).toMatchObject({ kind: 'names', names: ['fixture', 'other'] });
    expect(at('lazy.ts', 3).kind).toBe('names');
    // Top-level data, a function no scenario ran, a data row holding a one-line arrow, and the
    // first line of `export const make = (…) => {`, which the declaration shares.
    for (const [path, line] of [
      ['alpha.ts', 1],
      ['lazy.ts', 1],
      ['alpha.ts', 6],
      ['menu.ts', 2],
      ['menu.ts', 8],
    ] as const) {
      expect(at(path, line).kind, `${path}:${line}`).toBe('full');
    }
  });
});

describe('mergeSpans', () => {
  it('merges overlapping and nested spans, keeps touching ones apart', () => {
    expect(
      mergeSpans([
        [10, 20],
        [12, 14],
        [20, 25],
        [26, 30],
        [1, 3],
      ]),
    ).toEqual([
      [1, 3],
      [10, 25],
      [26, 30],
    ]);
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
  const entry = (builtFrom: string, file: string) => ({
    builtFrom,
    files: { [file]: [[1, 2]] as [number, number][] },
  });

  it('replaces the entries of scenarios that ended PASS or FLAKY and keeps every other', () => {
    const prev = {
      schema: 2,
      builtFrom: 'old',
      scenarios: { a: entry('old', 'x.ts'), b: entry('old', 'y.ts'), f: entry('old', 'f.ts') },
    };
    const shard: Record<string, Record<string, [number, number][]>> = {
      a: { 'z.ts': [[3, 4]] },
      c: { 'w.ts': [[5, 6]] },
      f: { 'g.ts': [[7, 8]] },
    };
    expect(mergeCoverageMaps(prev, [shard], 'new', { a: 'PASS', c: 'FLAKY', f: 'FAIL' })).toEqual({
      schema: 2,
      builtFrom: 'new',
      scenarios: {
        a: { builtFrom: 'new', files: { 'z.ts': [[3, 4]] } },
        b: entry('old', 'y.ts'),
        c: { builtFrom: 'new', files: { 'w.ts': [[5, 6]] } },
        f: entry('old', 'f.ts'),
      },
    });
  });

  it.each(['TIMEOUT', 'QUARANTINED-FAIL', 'SKIP', undefined])(
    'a scenario that ended %s adds nothing',
    (status) => {
      const r = mergeCoverageMaps(null, [{ a: { 'x.ts': [[1, 1]] } }], 's', {
        ...(status ? { a: status } : {}),
      });
      expect(r.scenarios).toEqual({});
    },
  );

  it('drops an old-schema map (file lists, no line spans)', () => {
    const old = { builtFrom: 'old', scenarios: { a: ['x.ts'] } };
    expect(mergeCoverageMaps(old, [], 's', {})).toEqual({
      schema: 2,
      builtFrom: 's',
      scenarios: {},
    });
  });
});

describe('executedRanges', () => {
  it('keeps the range of every function that ran in an app bundle, minus scripts and module inits', () => {
    const fn = (start: number, count: number, functionName = 'f') => ({
      functionName,
      ranges: [{ startOffset: start, endOffset: start + 5, count }],
    });
    expect(
      executedRanges([
        {
          url: 'file:///D:/a/conduit/out/webview.js',
          functions: [fn(0, 1), fn(10, 2), fn(20, 0), fn(25, 1, 'webview/lazy.ts')],
        },
        { url: String.raw`D:\a\conduit\out\main.js`, functions: [fn(30, 1)] },
        { url: String.raw`D:\a\conduit\out\preload.js`, functions: [fn(40, 1)] },
        { url: 'node:events', functions: [fn(50, 1)] },
      ]),
    ).toEqual({ 'webview.js': [[10, 15]], 'main.js': [[30, 35]] });
  });
});
