import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testTempDir } from '../helpers/temp-roots';

describe('testTempDir', () => {
  const fixtures: string[] = [];

  afterAll(() => {
    for (const dir of fixtures) expect(existsSync(dir), dir).toBe(false);
  });

  it('removes all fixtures after the test', () => {
    const first = testTempDir('temp-roots-');
    const second = testTempDir('temp-roots-');
    fixtures.push(first, second);
    const child = join(first, 'child');
    mkdirSync(child);
    writeFileSync(join(child, 'fixture.txt'), 'fixture');
    expect(first).not.toBe(second);
    expect(existsSync(second)).toBe(true);
  });

  it.fails('removes the fixture after an assertion fails', () => {
    const dir = testTempDir('temp-roots-');
    fixtures.push(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
