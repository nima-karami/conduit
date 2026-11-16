import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confineTranscriptPath, readTranscriptRange } from '../../server/domain/transcript-range';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'con24-range-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Probed by making a FIFO rather than by asking for mkfifo's version: a shell that has the tool
// but cannot make a pipe in this directory must still skip the FIFO case, not fail it.
const fifoSupported = (): boolean => {
  const dir = scratch();
  try {
    execFileSync('mkfifo', [join(dir, 'probe')], { stdio: 'ignore' });
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

describe('confineTranscriptPath', () => {
  const claudeHome = join('/home', 'u', '.claude');
  const projects = join(claudeHome, 'projects');

  it('accepts a transcript nested under the projects dir, normalised', () => {
    const nested = join(projects, 'p', 's.jsonl');
    expect(confineTranscriptPath(nested, claudeHome)).toBe(resolve(nested));
  });

  it.each([
    ['a relative path', join('projects', 'p', 's.jsonl')],
    ['a dot-dot escape out of projects', join(projects, '..', '..', 'x.jsonl')],
    ['a sibling that shares the prefix', join(claudeHome, 'projects-evil', 'x.jsonl')],
    ['the projects dir itself', projects],
    ['a path outside claude home', join('/home', 'u', 'other', 'x.jsonl')],
    ['a forward-slash UNC path under a UNC home', '//server/share/.claude/projects/p/s.jsonl'],
  ])('rejects %s on posix', (_label, p) => {
    expect(confineTranscriptPath(p, '//server/share/.claude')).toBeNull();
    expect(confineTranscriptPath(p, claudeHome)).toBeNull();
  });

  // Each row is contained by its own claude home, so only the raw-prefix check can refuse it.
  const winHome = 'C:\\Users\\u\\.claude';
  it('accepts a nested win32 transcript, normalised with path.win32', () => {
    const nested = win32.join(winHome, 'projects', 'p', 's.jsonl');
    expect(confineTranscriptPath(nested, winHome, win32)).toBe(win32.resolve(nested));
  });

  it.each([
    [
      'a UNC path under a UNC home',
      '\\\\server\\share\\.claude\\projects\\p\\s.jsonl',
      '\\\\server\\share\\.claude',
    ],
    [
      'a forward-slash UNC path under a UNC home',
      '//server/share/.claude/projects/p/s.jsonl',
      '//server/share/.claude',
    ],
    [
      'a long-path device prefix under its own home',
      '\\\\?\\C:\\Users\\u\\.claude\\projects\\p\\s.jsonl',
      '\\\\?\\C:\\Users\\u\\.claude',
    ],
    ['a device pipe under its own home', '\\\\.\\pipe\\projects\\x', '\\\\.\\pipe'],
    [
      'a device-prefixed transcript under its own home',
      '\\\\.\\C:\\Users\\u\\.claude\\projects\\p\\s.jsonl',
      '\\\\.\\C:\\Users\\u\\.claude',
    ],
    [
      'a win32 sibling that shares the prefix',
      win32.join(winHome, 'projects-evil', 'x.jsonl'),
      winHome,
    ],
    ['a win32 path on another drive', 'D:\\x\\s.jsonl', winHome],
  ])('rejects %s on win32', (_label, p, home) => {
    expect(confineTranscriptPath(p, home, win32)).toBeNull();
  });
});
