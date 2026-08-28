import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitActionRequest, GitActionResult } from '../../src/git-actions';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  CONFLICT_TOAST,
  discardConfirm,
  getHunkActionHost,
  type HunkActionHost,
  type HunkActionRequest,
  hunkButtonMode,
  setHunkActionHost,
  subscribeHunkActionHost,
} from '../../webview/hunk-actions';

describe('hunkButtonMode', () => {
  it('offers Stage under the Unstaged scope, always', () => {
    expect(hunkButtonMode('unstaged', false)).toBe('stage');
    expect(hunkButtonMode('unstaged', true)).toBe('stage');
  });

  it('offers Unstage under the Staged scope, always', () => {
    expect(hunkButtonMode('staged', false)).toBe('unstage');
    expect(hunkButtonMode('staged', true)).toBe('unstage');
  });

  it('offers Stage under All only while the file has no staged side', () => {
    expect(hunkButtonMode('all', false)).toBe('stage');
    expect(hunkButtonMode('all', true)).toBe('blocked');
  });

  it('offers nothing on a conflicted file, whatever the scope', () => {
    for (const scope of ['all', 'staged', 'unstaged'] as const) {
      expect(hunkButtonMode(scope, false, true)).toBe('unmerged');
      expect(hunkButtonMode(scope, true, true)).toBe('unmerged');
    }
  });

  it('refuses while Ignore whitespace is on, whatever the scope', () => {
    // The displayed hunks came from a whitespace-collapsed diff; git applies whitespace
    // sensitively, so the range would revert re-indents the reader was never shown.
    for (const scope of ['all', 'staged', 'unstaged'] as const) {
      expect(hunkButtonMode(scope, false, false, true)).toBe('whitespace');
    }
  });

  it('reports a conflict ahead of a whitespace block — it is the harder no', () => {
    expect(hunkButtonMode('all', false, true, true)).toBe('unmerged');
  });

  it('names the scope to switch to when it blocks', () => {
    expect(BLOCKED_TOOLTIP).toBe('Switch to Unstaged scope to stage hunks');
  });
});

describe('discardConfirm', () => {
  it('quotes the line count, the path and the index as the target', () => {
    const c = discardConfirm('src/foo.ts', 12);
    expect(c.title).toBe('Discard this change?');
    expect(c.message).toBe(
      "12 lines in src/foo.ts will be reverted to the index. This can't be undone.",
    );
    expect(c.confirmLabel).toBe('Discard');
    expect(c.danger).toBe(true);
    // An accidental Enter must not discard work.
    expect(c.focusCancel).toBe(true);
  });

  it('says "1 line" for a one-line change', () => {
    expect(discardConfirm('a.ts', 1).message).toContain('1 line in a.ts');
  });
});

const REQ: HunkActionRequest = {
  op: 'stageHunk',
  absPath: '/repo/src/foo.ts',
  relPath: 'src/foo.ts',
  range: { new: [10, 12], old: [10, 11] },
  lineCount: 5,
  untracked: false,
};

function makeHost(over: Partial<HunkActionHost> = {}): HunkActionHost {
  return {
    root: '/repo',
    stagedPaths: new Set<string>(),
    conflictedPaths: new Set<string>(),
    confirmDiscard: async () => true,
    refreshChanges: () => {},
    invalidateDiff: () => {},
    ...over,
  };
}

function makeDeps(result: GitActionResult = { ok: true }, hostOver: Partial<HunkActionHost> = {}) {
  const calls: GitActionRequest[] = [];
  const toasts: { message: string; variant: string }[] = [];
  const announced: string[] = [];
  const host = makeHost(hostOver);
  return {
    calls,
    toasts,
    announced,
    host,
    deps: {
      host,
      gitAction: async (r: GitActionRequest) => {
        calls.push(r);
        return result;
      },
      toast: (t: { message: string; variant: 'error' | 'info' }) => {
        toasts.push(t);
      },
      announce: (t: string) => {
        announced.push(t);
      },
    },
  };
}

describe('the hunk-action host store', () => {
  beforeEach(() => setHunkActionHost(null));

  it('starts empty', () => {
    expect(getHunkActionHost()).toBeNull();
  });

  it('publishes a host and notifies subscribers', () => {
    const seen = vi.fn();
    const off = subscribeHunkActionHost(seen);
    const host = makeHost();
    setHunkActionHost(host);
    expect(getHunkActionHost()).toBe(host);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('a teardown only clears the host it published', () => {
    const first = makeHost();
    const clearFirst = setHunkActionHost(first);
    const second = makeHost();
    setHunkActionHost(second);
    clearFirst();
    expect(getHunkActionHost()).toBe(second);
  });
});

describe('applyHunkAction', () => {
  it('sends the op, the root, the repo-relative path and the range', async () => {
    const { deps, calls } = makeDeps();
    expect(await applyHunkAction(deps, REQ)).toEqual({ kind: 'done', op: 'stageHunk' });
    expect(calls).toEqual([
      { root: '/repo', op: 'stageHunk', path: 'src/foo.ts', range: REQ.range },
    ]);
  });

  it('announces, invalidates the cached diff and refreshes after a success', async () => {
    const invalidateDiff = vi.fn();
    const refreshChanges = vi.fn();
    const { deps, announced } = makeDeps({ ok: true }, { invalidateDiff, refreshChanges });
    await applyHunkAction(deps, REQ);
    expect(announced).toEqual(['Staged hunk']);
    expect(invalidateDiff).toHaveBeenCalledWith('/repo/src/foo.ts');
    expect(refreshChanges).toHaveBeenCalledTimes(1);
  });

  it('announces the right verb per op', async () => {
    for (const [op, said] of [
      ['unstageHunk', 'Unstaged hunk'],
      ['discardHunk', 'Discarded hunk'],
    ] as const) {
      const { deps, announced } = makeDeps();
      await applyHunkAction(deps, { ...REQ, op });
      expect(announced).toEqual([said]);
    }
  });

  it('does not confirm a stage or an unstage', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { deps } = makeDeps({ ok: true }, { confirmDiscard });
    await applyHunkAction(deps, REQ);
    await applyHunkAction(deps, { ...REQ, op: 'unstageHunk' });
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('confirms a discard with the spec copy and runs it on accept', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { deps, calls } = makeDeps({ ok: true }, { confirmDiscard });
    const out = await applyHunkAction(deps, { ...REQ, op: 'discardHunk', lineCount: 12 });
    expect(confirmDiscard).toHaveBeenCalledWith(discardConfirm('src/foo.ts', 12));
    expect(out).toEqual({ kind: 'done', op: 'discardHunk' });
    expect(calls).toHaveLength(1);
  });

  it('runs nothing when the discard is cancelled', async () => {
    const { deps, calls, toasts } = makeDeps({ ok: true }, { confirmDiscard: async () => false });
    expect(await applyHunkAction(deps, { ...REQ, op: 'discardHunk' })).toEqual({
      kind: 'cancelled',
    });
    expect(calls).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('maps Stage on an untracked file onto the whole-file stageFile op', async () => {
    const { deps, calls } = makeDeps();
    await applyHunkAction(deps, { ...REQ, untracked: true });
    expect(calls).toEqual([{ root: '/repo', op: 'stageFile', path: 'src/foo.ts' }]);
  });

  it('refuses to discard a hunk of an untracked file — there is no index to revert to', async () => {
    const { deps, calls } = makeDeps();
    const out = await applyHunkAction(deps, { ...REQ, op: 'discardHunk', untracked: true });
    expect(out).toEqual({ kind: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('shows the conflict copy and reloads the card on apply-failed', async () => {
    const invalidateDiff = vi.fn();
    const refreshChanges = vi.fn();
    const { deps, toasts } = makeDeps(
      { ok: false, error: 'apply-failed', message: 'patch does not apply' },
      { invalidateDiff, refreshChanges },
    );
    expect(await applyHunkAction(deps, REQ)).toEqual({
      kind: 'failed',
      reason: 'apply-failed',
      message: 'patch does not apply',
    });
    expect(toasts).toEqual([{ message: CONFLICT_TOAST, variant: 'error' }]);
    expect(invalidateDiff).toHaveBeenCalledWith('/repo/src/foo.ts');
    expect(refreshChanges).toHaveBeenCalledTimes(1);
  });

  it('shows the same copy for no-hunk — the cause and the fix are identical', async () => {
    const { deps, toasts } = makeDeps({ ok: false, error: 'no-hunk' });
    expect(await applyHunkAction(deps, REQ)).toMatchObject({ kind: 'failed', reason: 'no-hunk' });
    expect(toasts).toEqual([{ message: CONFLICT_TOAST, variant: 'error' }]);
  });

  it('passes any other host error through verbatim', async () => {
    const { deps, toasts } = makeDeps({
      ok: false,
      error: 'Unknown or untrusted repository root.',
    });
    expect(await applyHunkAction(deps, REQ)).toMatchObject({ kind: 'failed', reason: 'other' });
    expect(toasts).toEqual([
      { message: 'Git: Unknown or untrusted repository root.', variant: 'error' },
    ]);
  });

  it('does nothing without a host', async () => {
    const { deps, calls } = makeDeps();
    expect(await applyHunkAction({ ...deps, host: null }, REQ)).toEqual({ kind: 'noHost' });
    expect(calls).toEqual([]);
  });

  it('does nothing without a repo root', async () => {
    const { deps, calls } = makeDeps({ ok: true }, { root: '' });
    expect(await applyHunkAction(deps, REQ)).toEqual({ kind: 'noHost' });
    expect(calls).toEqual([]);
  });
});
