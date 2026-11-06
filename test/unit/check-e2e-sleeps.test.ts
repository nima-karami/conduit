import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, countSleeps, run, toPosixRel } from '../../tools/check-e2e-sleeps.mjs';

describe('countSleeps', () => {
  it('counts page and win receivers', () => {
    const source = `
      await page.waitForTimeout(100);
      await win.waitForTimeout(5);
    `;
    expect(countSleeps(source)).toBe(2);
  });

  it('ignores line and block comments', () => {
    const source = `
      // await page.waitForTimeout(1)
      /* p.waitForTimeout(9) */
      await page.waitForTimeout(2);
    `;
    expect(countSleeps(source)).toBe(1);
  });

  it('counts multiple on one line', () => {
    expect(countSleeps('page.waitForTimeout(1); win.waitForTimeout(2);')).toBe(2);
  });

  it('counts waitForTimeout inside template interpolation', () => {
    expect(countSleeps('const s = `$' + '{await page.waitForTimeout(1)}`;')).toBe(1);
  });

  it('ignores waitForTimeout in template literal text without interpolation', () => {
    expect(countSleeps('const s = `waitForTimeout(1)`;')).toBe(0);
  });

  it('does not treat // inside strings as comments', () => {
    expect(countSleeps("'http://x'; page.waitForTimeout(1)")).toBe(1);
    expect(countSleeps('"// not a comment"; page.waitForTimeout(1)')).toBe(1);
  });

  it('counts sleep in nested template inside interpolation', () => {
    expect(countSleeps('const s = `$' + '{ `x $' + '{ page.waitForTimeout(2) }` }`;')).toBe(1);
  });
});

describe('compareToBaseline', () => {
  it('ok when counts match baseline', () => {
    expect(compareToBaseline({ 'test/e2e/a.e2e.mjs': 3 }, { 'test/e2e/a.e2e.mjs': 3 })).toEqual({
      ok: true,
      over: [],
      under: [],
    });
  });

  it('reports one over', () => {
    const r = compareToBaseline({ 'test/e2e/a.e2e.mjs': 4 }, { 'test/e2e/a.e2e.mjs': 3 });
    expect(r.ok).toBe(false);
    expect(r.over).toEqual([{ file: 'test/e2e/a.e2e.mjs', count: 4, allowed: 3 }]);
    expect(r.under).toEqual([]);
  });

  it('reports one under', () => {
    const r = compareToBaseline({ 'test/e2e/a.e2e.mjs': 2 }, { 'test/e2e/a.e2e.mjs': 3 });
    expect(r.ok).toBe(false);
    expect(r.under).toEqual([{ file: 'test/e2e/a.e2e.mjs', count: 2, allowed: 3 }]);
    expect(r.over).toEqual([]);
  });

  it('treats a new file with sleeps as over (baseline allows 0)', () => {
    const r = compareToBaseline({ 'test/e2e/new.e2e.mjs': 1 }, {});
    expect(r.ok).toBe(false);
    expect(r.over).toEqual([{ file: 'test/e2e/new.e2e.mjs', count: 1, allowed: 0 }]);
  });

  it('treats a removed baseline file as under', () => {
    const r = compareToBaseline({}, { 'test/e2e/gone.e2e.mjs': 2 });
    expect(r.ok).toBe(false);
    expect(r.under).toEqual([{ file: 'test/e2e/gone.e2e.mjs', count: 0, allowed: 2 }]);
  });
});

describe('toPosixRel', () => {
  it('normalizes win32-style segments to posix', () => {
    expect(toPosixRel(win32.join('test', 'e2e', 'a.e2e.mjs'))).toBe('test/e2e/a.e2e.mjs');
  });
});

function tempFixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'check-e2e-sleeps-'));
}

function writeE2eFile(root: string, relPosix: string, source: string) {
  const abs = join(root, ...relPosix.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, source, 'utf8');
}

describe('run', () => {
  it('exit 1 with over message when count exceeds baseline', () => {
    const root = tempFixtureRoot();
    writeE2eFile(
      root,
      'test/e2e/a.e2e.mjs',
      'await page.waitForTimeout(1);\nawait page.waitForTimeout(2);\n',
    );
    const baselinePath = join(root, 'baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify({ 'test/e2e/a.e2e.mjs': 1 }, null, 2)}\n`);
    const lines: string[] = [];
    const { exitCode } = run({ root, baselinePath, log: (m) => lines.push(m) });
    expect(exitCode).toBe(1);
    expect(lines).toEqual([
      'test/e2e/a.e2e.mjs: 2 fixed sleeps, baseline 1 — wait on a real condition instead (CON-134)',
    ]);
  });

  it('exit 1 with under message when count is below baseline', () => {
    const root = tempFixtureRoot();
    writeE2eFile(root, 'test/e2e/a.e2e.mjs', 'await page.waitForTimeout(1);\n');
    const baselinePath = join(root, 'baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify({ 'test/e2e/a.e2e.mjs': 3 }, null, 2)}\n`);
    const lines: string[] = [];
    const { exitCode } = run({ root, baselinePath, log: (m) => lines.push(m) });
    expect(exitCode).toBe(1);
    expect(lines).toEqual([
      'test/e2e/a.e2e.mjs: 1 fixed sleeps, baseline 3 — lower the baseline: npm run check:e2e-sleeps -- --update',
    ]);
  });

  it('exit 0 when counts match baseline', () => {
    const root = tempFixtureRoot();
    writeE2eFile(root, 'test/e2e/a.e2e.mjs', 'await page.waitForTimeout(1);\n');
    const baselinePath = join(root, 'baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify({ 'test/e2e/a.e2e.mjs': 1 }, null, 2)}\n`);
    const lines: string[] = [];
    const { exitCode } = run({ root, baselinePath, log: (m) => lines.push(m) });
    expect(exitCode).toBe(0);
    expect(lines).toEqual([]);
  });

  it('update writes sorted posix keys, 2-space JSON, trailing newline, omits zero-count files', () => {
    const root = tempFixtureRoot();
    writeE2eFile(root, 'test/e2e/b.e2e.mjs', 'await page.waitForTimeout(1);\n');
    writeE2eFile(root, 'test/e2e/a.e2e.mjs', 'await page.waitForTimeout(2);\n');
    writeE2eFile(root, 'test/e2e/empty.e2e.mjs', '// no sleeps\n');
    const baselinePath = join(root, 'baseline.json');
    const win32Key = win32.join('test', 'e2e', 'a.e2e.mjs');
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ [win32Key]: 99, 'test/e2e/b.e2e.mjs': 99 }, null, 2)}\n`,
    );

    const { exitCode } = run({ root, baselinePath, update: true });
    expect(exitCode).toBe(0);

    const written = readFileSync(baselinePath, 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toBe(
      `${JSON.stringify(
        {
          'test/e2e/a.e2e.mjs': 1,
          'test/e2e/b.e2e.mjs': 1,
        },
        null,
        2,
      )}\n`,
    );
    expect(written).not.toContain('empty.e2e.mjs');
    expect(Object.keys(JSON.parse(written))).toEqual(['test/e2e/a.e2e.mjs', 'test/e2e/b.e2e.mjs']);
  });
});
