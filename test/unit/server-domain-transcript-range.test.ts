import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTranscriptRange } from '../../server/domain/index';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'con24-range-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fifoSupported = (): boolean => {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('readTranscriptRange', () => {
  it('reads exactly the requested bytes of a regular file', async () => {
    const file = join(scratch(), 'a.jsonl');
    writeFileSync(file, 'abcdefghij');
    expect((await readTranscriptRange(file, 2, 6)).toString('utf8')).toBe('cdef');
  });

  it('reads nothing for an empty range, without opening the file', async () => {
    const missing = join(scratch(), 'never-created.jsonl');
    expect((await readTranscriptRange(missing, 4, 4)).length).toBe(0);
  });

  it('refuses a path that is not a regular file', async () => {
    const dir = scratch();
    await expect(readTranscriptRange(dir, 0, 1)).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(!fifoSupported())(
    'refuses a FIFO without blocking on a writer that never comes',
    async () => {
      const fifo = join(scratch(), 'pipe.jsonl');
      execFileSync('mkfifo', [fifo]);
      await expect(readTranscriptRange(fifo, 0, 1)).rejects.toThrow(/not a regular file/);
    },
  );
});
