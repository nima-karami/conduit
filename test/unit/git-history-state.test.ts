import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../../src/protocol';
import {
  acceptHistoryResult,
  displayCommits,
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
      revealed: commit('ddd'),
    };
    expect(historyReducer(loaded, { type: 'retarget' })).toEqual({
      phase: 'loading',
      commits: [],
      hasMore: false,
      searchCommits: [],
      selectedSha: null,
      query: 'fix',
      refFilter: null,
      revealed: null,
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

describe('historyReducer — reveal (spec 2026-10-30-conduit-mcp-app-control §2.1)', () => {
  const loaded = (): HistoryState => ({
    ...initialHistoryState,
    phase: 'ready',
    commits: [
      { ...commit('ccc'), date: 3 },
      { ...commit('bbb'), date: 2 },
    ],
    hasMore: true,
  });
  const deep = { ...commit('aaa'), date: 1 };

  it('reveal selects and displays a commit outside the loaded set', () => {
    const s = historyReducer(loaded(), { type: 'reveal', commit: deep });
    expect(s.selectedSha).toBe('aaa');
    expect(s.revealed).toStrictEqual(deep);
    expect(displayCommits(s).map((c) => c.sha)).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('displayCommits is the loaded set itself with no query and nothing revealed', () => {
    const s = loaded();
    expect(displayCommits(s)).toBe(s.commits);
  });

  it('a revealed commit already loaded is shown once', () => {
    const s = historyReducer(loaded(), { type: 'reveal', commit: { ...commit('bbb'), date: 2 } });
    expect(displayCommits(s).map((c) => c.sha)).toEqual(['ccc', 'bbb']);
  });

  it('a refresh result keeps a revealed selection', () => {
    let s = historyReducer(loaded(), { type: 'reveal', commit: deep });
    s = historyReducer(s, { type: 'request' });
    expect(s.revealed).toStrictEqual(deep);
    s = historyReducer(s, {
      type: 'result',
      commits: [{ ...commit('ccc'), date: 3 }],
      hasMore: true,
      append: false,
      state: 'ok',
    });
    expect(s.selectedSha).toBe('aaa');
    expect(displayCommits(s).map((c) => c.sha)).toEqual(['ccc', 'aaa']);
  });

  it('retarget clears revealed', () => {
    const s = historyReducer(historyReducer(loaded(), { type: 'reveal', commit: deep }), {
      type: 'retarget',
    });
    expect(s.revealed).toBeNull();
    expect(s.selectedSha).toBeNull();
  });
});
