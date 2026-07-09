import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countLinesOfFile } from '../../src/project-info';

const MB = 1024 * 1024;
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'clc-')), name);

describe('countLinesOfFile', () => {
  it('counts newlines in a small file', async () => {
    const p = tmp('a.txt');
    writeFileSync(p, 'a\nb\nc\n');
    expect(await countLinesOfFile(p, 2 * MB)).toEqual({ lines: 3, oversize: false });
  });

  it('flags oversize past the cap without reading the whole file', async () => {
    const p = tmp('big.txt');
    writeFileSync(p, `${'x'.repeat(2 * MB + 5)}\n`);
    const r = await countLinesOfFile(p, 2 * MB);
    expect(r.oversize).toBe(true);
  });

  it('treats NUL-containing (binary) files as 0 lines', async () => {
    const p = tmp('bin');
    writeFileSync(p, Buffer.from([1, 0, 2, 0, 3]));
    expect((await countLinesOfFile(p, 2 * MB)).lines).toBe(0);
  });

  it('resolves 0/false for a missing file (never rejects)', async () => {
    expect(await countLinesOfFile(join(tmpdir(), 'does-not-exist-xyz'), 2 * MB)).toEqual({
      lines: 0,
      oversize: false,
    });
  });
});
