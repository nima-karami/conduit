import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHeadBlobCache,
  getHeadBlob,
  getLatestHeadBlob,
  HEAD_BLOB_CACHE_MAX,
  invalidateHeadBlob,
  putHeadBlob,
} from '../../webview/head-blob-cache';

describe('head blob cache', () => {
  beforeEach(() => clearHeadBlobCache());

  it('returns a blob under its own path + sha', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', 'sha1')).toEqual({ headSha: 'sha1', text: 'x' });
  });

  it('misses on a different sha for the same path', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', 'sha2')).toBeUndefined();
  });

  it('keys an untracked (null-sha) entry separately from a tracked one', () => {
    putHeadBlob('/r/a.ts', { headSha: null, text: null, reason: 'untracked' });
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', null)?.reason).toBe('untracked');
    expect(getHeadBlob('/r/a.ts', 'sha1')?.text).toBe('x');
  });

  it('serves the most recent blob for a path without knowing its sha', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'old' });
    putHeadBlob('/r/a.ts', { headSha: 'sha2', text: 'new' });
    expect(getLatestHeadBlob('/r/a.ts')).toEqual({ headSha: 'sha2', text: 'new' });
  });

  it('invalidate drops the latest pointer but keeps the keyed entry', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    invalidateHeadBlob('/r/a.ts');
    expect(getLatestHeadBlob('/r/a.ts')).toBeUndefined();
    expect(getHeadBlob('/r/a.ts', 'sha1')).toEqual({ headSha: 'sha1', text: 'x' });
  });

  it('evicts the oldest entry past the bound', () => {
    for (let i = 0; i <= HEAD_BLOB_CACHE_MAX; i++) {
      putHeadBlob(`/r/f${i}.ts`, { headSha: 's', text: `t${i}` });
    }
    expect(getHeadBlob('/r/f0.ts', 's')).toBeUndefined();
    expect(getHeadBlob(`/r/f${HEAD_BLOB_CACHE_MAX}.ts`, 's')?.text).toBe(`t${HEAD_BLOB_CACHE_MAX}`);
  });
});
