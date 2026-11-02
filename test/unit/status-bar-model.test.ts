import { describe, expect, it } from 'vitest';
import type { AttentionEntry } from '../../src/attention';
import { buildStatusBarModel } from '../../src/status-bar-model';
import type { Session } from '../../src/types';

const S = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});
const entry = (key: string): AttentionEntry => ({
  key,
  kind: 'session',
  sessionId: key,
  threadId: null,
  reason: null,
  handle: null,
});

describe('buildStatusBarModel', () => {
  it("reads the active session's repo branch and its worktree label", () => {
    const active = S('a', {
      activeRepoRoot: '/w',
      repoGit: { '/w': { kind: 'branch', branch: 'feat/x' } },
      worktree: 'wt-1',
    });
    expect(buildStatusBarModel({ sessions: [active], activeId: 'a', entries: [] })).toEqual({
      branch: 'feat/x',
      worktree: 'wt-1',
      liveCount: 1,
      attentionCount: 0,
      firstAttention: null,
      showCommandHint: true,
    });
  });

  it('falls back to a linked git worktree name, and omits what is unknown', () => {
    const linked = S('a', {
      activeRepoRoot: '/w',
      repoGit: { '/w': { kind: 'branch', branch: 'b', isWorktree: true, worktreeName: 'side' } },
    });
    expect(buildStatusBarModel({ sessions: [linked], activeId: 'a', entries: [] })).toMatchObject({
      branch: 'b',
      worktree: 'side',
    });
    const detached = S('d', {
      activeRepoRoot: '/w',
      repoGit: { '/w': { kind: 'detached', sha: 'abc1234' } },
    });
    expect(buildStatusBarModel({ sessions: [detached], activeId: 'd', entries: [] })).toMatchObject(
      {
        branch: null,
        worktree: null,
      },
    );
    expect(buildStatusBarModel({ sessions: [S('n')], activeId: 'n', entries: [] })).toMatchObject({
      branch: null,
      worktree: null,
      showCommandHint: true,
    });
  });

  it('with no active session shows only machine and counts', () => {
    const sessions = [S('a', { worktree: 'w' }), S('b', { status: 'stale' })];
    expect(buildStatusBarModel({ sessions, activeId: undefined, entries: [entry('x')] })).toEqual({
      branch: null,
      worktree: null,
      liveCount: 1,
      attentionCount: 1,
      firstAttention: entry('x'),
      showCommandHint: false,
    });
    expect(buildStatusBarModel({ sessions, activeId: 'gone', entries: [] }).showCommandHint).toBe(
      false,
    );
  });

  it('counts every live session in the window and routes the first entry', () => {
    const sessions = [S('a'), S('b'), S('c', { status: 'exited' })];
    const m = buildStatusBarModel({
      sessions,
      activeId: 'a',
      entries: [entry('first'), entry('second')],
    });
    expect(m).toMatchObject({ liveCount: 2, attentionCount: 2 });
    expect(m.firstAttention?.key).toBe('first');
  });
});
