import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../../src/protocol';
import {
  acceptHistoryResult,
  type HistoryState,
  historyReducer,
  initialHistoryState,
} from '../../webview/git-history-state';

const commit = (sha: string, refs: CommitNode['refs'] = []): CommitNode => ({
  sha,
  parents: [],
  author: 'a',
  email: 'a@x',
  date: 0,
  subject: sha,
  refs,
});

const view = {
  sessionId: 's1',
  repoRoot: 'C:/w/a',
  latestReqId: 4,
  latestSearchReqId: 7,
};

describe('historyReducer', () => {
  it('retarget clears commits, selection, ref filter, paging; keeps query', () => {
    const loaded: HistoryState = {
      phase: 'ready',
      commits: [commit('aaa', [{ kind: 'branch', name: 'main' }])],
      hasMore: true,
      searchCommits: [commit('bbb')],
      selectedSha: 'aaa',
      query: 'fix',
      refFilter: 'main',
    };
    expect(historyReducer(loaded, { type: 'retarget' })).toEqual({
      phase: 'loading',
      commits: [],
      hasMore: false,
      searchCommits: [],
      selectedSha: null,
      query: 'fix',
      refFilter: null,
    });
  });

  it('unknown-repo result (state error, commits []) for the current repo is accepted → error phase', () => {
    const msg = { sessionId: 's1', repoRoot: 'C:/w/a', requestId: 4 };
    expect(acceptHistoryResult(msg, view)).toBe(true);
    const requested = historyReducer(initialHistoryState, { type: 'request' });
    const next = historyReducer(requested, {
      type: 'result',
      commits: [],
      hasMore: false,
      append: false,
      state: 'error',
    });
    expect(next.phase).toBe('error');
    expect(next.commits).toEqual([]);
  });
});

describe('acceptHistoryResult', () => {
  it('result for another repoRoot is dropped', () => {
    expect(acceptHistoryResult({ sessionId: 's1', repoRoot: 'C:/w/b', requestId: 4 }, view)).toBe(
      false,
    );
    expect(acceptHistoryResult({ sessionId: 's1', requestId: 4 }, view)).toBe(false);
    expect(
      acceptHistoryResult({ sessionId: 's1', requestId: 4 }, { ...view, repoRoot: undefined }),
    ).toBe(true);
  });

  it('another session is dropped', () => {
    expect(acceptHistoryResult({ sessionId: 's2', repoRoot: 'C:/w/a', requestId: 4 }, view)).toBe(
      false,
    );
  });

  it('stale requestId dropped (search and list separately)', () => {
    const base = { sessionId: 's1', repoRoot: 'C:/w/a' };
    expect(acceptHistoryResult({ ...base, requestId: 3 }, view)).toBe(false);
    expect(acceptHistoryResult({ ...base, requestId: 4 }, view)).toBe(true);
    expect(acceptHistoryResult({ ...base, requestId: 7 }, view)).toBe(false);
    expect(acceptHistoryResult({ ...base, requestId: 7, query: 'fix' }, view)).toBe(true);
    expect(acceptHistoryResult({ ...base, requestId: 4, query: 'fix' }, view)).toBe(false);
    expect(acceptHistoryResult({ ...base, requestId: 7, query: '  ' }, view)).toBe(false);
  });
});
