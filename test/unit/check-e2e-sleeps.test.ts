import { describe, expect, it } from 'vitest';
import { compareToBaseline, countSleeps } from '../../tools/check-e2e-sleeps.mjs';

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
