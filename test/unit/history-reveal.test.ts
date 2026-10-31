import { describe, expect, it, vi } from 'vitest';
import type { CommitNode } from '../../src/protocol';
import {
  requestHistoryReveal,
  subscribeHistoryReveal,
  takeHistoryReveal,
} from '../../webview/history-reveal';

const commit = (sha: string): CommitNode => ({
  sha,
  parents: [],
  author: 'a',
  email: 'a@x',
  date: 0,
  subject: sha,
  refs: [],
});

describe('history reveal store', () => {
  it('take returns the commit once for the same session and repo (folderKey)', () => {
    requestHistoryReveal('s1', 'C:\\w\\Repo\\', commit('aaa'));
    expect(takeHistoryReveal('s1', 'c:/w/repo')).toStrictEqual(commit('aaa'));
    expect(takeHistoryReveal('s1', 'c:/w/repo')).toBeNull();
  });

  it('a different session or repo gets null and leaves the slot', () => {
    requestHistoryReveal('s1', '/w/repo', commit('aaa'));
    expect(takeHistoryReveal('s2', '/w/repo')).toBeNull();
    expect(takeHistoryReveal('s1', '/w/other')).toBeNull();
    expect(takeHistoryReveal(undefined, '/w/repo')).toBeNull();
    expect(takeHistoryReveal('s1', undefined)).toBeNull();
    expect(takeHistoryReveal('s1', '/w/repo')?.sha).toBe('aaa');
  });

  it('newest request wins', () => {
    requestHistoryReveal('s1', '/w/repo', commit('aaa'));
    requestHistoryReveal('s2', '/w/repo', commit('bbb'));
    expect(takeHistoryReveal('s1', '/w/repo')).toBeNull();
    expect(takeHistoryReveal('s2', '/w/repo')?.sha).toBe('bbb');
  });

  it('subscribers are notified', () => {
    const cb = vi.fn();
    const off = subscribeHistoryReveal(cb);
    requestHistoryReveal('s1', '/w/repo', commit('aaa'));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    requestHistoryReveal('s1', '/w/repo', commit('bbb'));
    expect(cb).toHaveBeenCalledTimes(1);
    takeHistoryReveal('s1', '/w/repo');
  });
});
