import { describe, expect, it, vi } from 'vitest';
import { MAX_BYTES } from '../../src/file-service';
import { type HeadBlobDeps, type HeadBlobShow, readHeadBlob } from '../../src/head-blob';

const REPO = '/home/u/repo';
const FILE = '/home/u/repo/src/a.ts';
const SHA = 'a'.repeat(40);

const shown = (bytes: Buffer | string): HeadBlobShow => ({
  ok: true,
  bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'),
  code: 0,
  failed: false,
});

const missing: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: 128, failed: false };
const crashed: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: null, failed: true };
const broke: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: 1, failed: false };

const deps = (over: Partial<HeadBlobDeps> = {}): HeadBlobDeps => ({
  repoRoot: async () => REPO,
  headSha: async () => SHA,
  showBlob: async () => shown('one\r\ntwo\r\n'),
  ...over,
});

describe('readHeadBlob', () => {
  it('returns the LF-normalised blob text and the head sha', async () => {
    expect(await readHeadBlob(FILE, deps())).toEqual({ headSha: SHA, text: 'one\ntwo\n' });
  });

  it('reports notRepo when no toplevel resolves', async () => {
    const d = deps({ repoRoot: async () => '' });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: null, text: null, reason: 'notRepo' });
  });

  it('reports notRepo when the path escapes the resolved root', async () => {
    const d = deps({ repoRoot: async () => '/home/u/other' });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: null, text: null, reason: 'notRepo' });
  });

  it('reports untracked on an unborn HEAD without asking for a blob', async () => {
    const showBlob = vi.fn(async () => shown('x'));
    const d = deps({ headSha: async () => null, showBlob });
    expect(await readHeadBlob(FILE, d)).toEqual({
      headSha: null,
      text: null,
      reason: 'untracked',
    });
    expect(showBlob).not.toHaveBeenCalled();
  });

  it('reads untracked off git exit 128, not a second ls-files spawn', async () => {
    const d = deps({ showBlob: async () => missing });
    expect(await readHeadBlob(FILE, d)).toEqual({
      headSha: SHA,
      text: null,
      reason: 'untracked',
    });
  });

  it('reports error when git could not run or was killed', async () => {
    const d = deps({ showBlob: async () => crashed });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'error' });
  });

  it('reports error for a non-128 failure exit', async () => {
    const d = deps({ showBlob: async () => broke });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'error' });
  });

  it('reports binary when the blob contains a NUL byte', async () => {
    const d = deps({ showBlob: async () => shown(Buffer.from([0x61, 0x00, 0x62])) });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'binary' });
  });

  it('reports oversize past readDiff\u2019s cap without shipping the bytes', async () => {
    const d = deps({ showBlob: async () => shown(Buffer.alloc(MAX_BYTES + 1, 0x61)) });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'oversize' });
  });

  it('passes git a posix rel path even from a windows absolute path', async () => {
    const showBlob = vi.fn(async () => shown('ok\n'));
    const d = deps({ repoRoot: async () => 'C:/work/repo', showBlob });
    const res = await readHeadBlob('C:\\work\\repo\\src\\a.ts', d);
    expect(res).toEqual({ headSha: SHA, text: 'ok\n' });
    expect(showBlob).toHaveBeenCalledWith('C:/work/repo', 'src/a.ts');
  });
});
