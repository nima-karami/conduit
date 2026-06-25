import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFileSync } from '../../src/atomic-write';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'atomicw-'));
}

describe('atomicWriteFileSync', () => {
  it('writes content to a new path', () => {
    const f = join(tmp(), 'a.json');
    atomicWriteFileSync(f, '{"x":1}');
    expect(fs.readFileSync(f, 'utf8')).toBe('{"x":1}');
  });

  it('overwrites an existing file', () => {
    const f = join(tmp(), 'a.json');
    fs.writeFileSync(f, 'OLD');
    atomicWriteFileSync(f, 'NEW');
    expect(fs.readFileSync(f, 'utf8')).toBe('NEW');
  });

  it('leaves no temp sibling behind on success', () => {
    const dir = tmp();
    const f = join(dir, 'a.json');
    atomicWriteFileSync(f, 'data');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('preserves the existing file if the rename fails (no truncation)', () => {
    const dir = tmp();
    const f = join(dir, 'a.json');
    fs.writeFileSync(f, 'OLD');
    // A plain fs.writeFile(f, …) truncates `f` BEFORE writing — so an interrupted write
    // would leave it empty. The atomic write must keep the old content intact instead.
    // Inject an fs whose rename throws (the real renameSync can't be spied on under ESM).
    const io = {
      writeFileSync: fs.writeFileSync,
      unlinkSync: fs.unlinkSync,
      renameSync: () => {
        throw new Error('boom');
      },
    } as unknown as Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'unlinkSync'>;
    expect(() => atomicWriteFileSync(f, 'NEW', io)).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('OLD');
    // and the temp file is cleaned up, not orphaned
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });
});
