import { describe, expect, it } from 'vitest';
import { acceptsRepoResult, branchChipModel, switchOutcome } from '../../src/branch-chip';

describe('branchChipModel', () => {
  it('undefined → unknown', () => {
    expect(branchChipModel(undefined)).toEqual({ state: 'unknown' });
  });

  it('kind none → none', () => {
    expect(branchChipModel({ kind: 'none' })).toEqual({ state: 'none' });
  });

  it('rebase + worktree + dirty: accessible name "REBASING Branch main, worktree wt, uncommitted changes. Switch branch or view history"', () => {
    const m = branchChipModel({
      kind: 'branch',
      branch: 'main',
      operation: 'rebase',
      isWorktree: true,
      worktreeName: 'wt',
      dirty: true,
    });
    expect(m).toEqual({
      state: 'ready',
      kind: 'branch',
      text: 'main',
      op: 'rebase',
      opLabel: 'REBASING',
      worktree: 'wt',
      dirty: true,
      switchable: true,
      accessibleName:
        'REBASING Branch main, worktree wt, uncommitted changes. Switch branch or view history',
    });
  });

  it('plain branch has no op, worktree or dirty in its name', () => {
    const m = branchChipModel({ kind: 'branch', branch: 'dev', dirty: false });
    expect(m).toMatchObject({ state: 'ready', dirty: false, switchable: true });
    expect(m.state === 'ready' && m.accessibleName).toBe(
      'Branch dev. Switch branch or view history',
    );
  });

  it('detached: 7-char sha, tag detached, switchable', () => {
    const m = branchChipModel({ kind: 'detached', sha: 'abc1234', operation: 'bisect' });
    expect(m).toMatchObject({
      state: 'ready',
      kind: 'detached',
      text: 'abc1234',
      tag: 'detached',
      opLabel: 'BISECTING',
      switchable: true,
      accessibleName: 'BISECTING Detached at abc1234. Switch branch or view history',
    });
  });

  it('unborn: tag no commits, not switchable', () => {
    expect(branchChipModel({ kind: 'branch', branch: 'main', unborn: true })).toMatchObject({
      state: 'ready',
      text: 'main',
      tag: 'no commits',
      switchable: false,
    });
  });

  it('bare: not switchable', () => {
    expect(branchChipModel({ kind: 'bare' })).toEqual({
      state: 'ready',
      kind: 'bare',
      text: 'bare',
      dirty: false,
      switchable: false,
      accessibleName: 'Bare repository. View history',
    });
  });
});

describe('switchOutcome', () => {
  it('switchOutcome ok announces "Switched to feature" (not blank)', () => {
    expect(switchOutcome({ ok: true }, 'feature')).toEqual({ announce: 'Switched to feature' });
  });

  it('switchOutcome unknown repo → "Couldn\'t switch branch: unknown repository", error', () => {
    expect(
      switchOutcome({ ok: false, reason: 'failed', message: 'unknown repo' }, 'feature'),
    ).toEqual({ toast: "Couldn't switch branch: unknown repository", variant: 'error' });
  });

  it("busy/dirty keep today's copy", () => {
    expect(switchOutcome({ ok: false, reason: 'busy' }, 'feature')).toEqual({
      toast: "Can't switch while the terminal is busy.",
      variant: 'info',
    });
    expect(switchOutcome({ ok: false, reason: 'dirty' }, 'feature')).toEqual({
      toast: 'Commit or stash changes first.',
      variant: 'info',
    });
    expect(
      switchOutcome({ ok: false, reason: 'failed', message: 'Unknown branch.' }, 'bogus'),
    ).toEqual({ toast: "Couldn't switch branch: Unknown branch.", variant: 'error' });
  });
});

describe('acceptsRepoResult', () => {
  it('acceptsRepoResult rejects another repoRoot and another session', () => {
    expect(acceptsRepoResult({ sessionId: 's1', repoRoot: '/r/a' }, 's1', '/r/a')).toBe(true);
    expect(acceptsRepoResult({ sessionId: 's1', repoRoot: 'C:/Repo/A/' }, 's1', 'c:/Repo/A')).toBe(
      true,
    );
    expect(acceptsRepoResult({ sessionId: 's1', repoRoot: '/r/b' }, 's1', '/r/a')).toBe(false);
    expect(acceptsRepoResult({ sessionId: 's2', repoRoot: '/r/a' }, 's1', '/r/a')).toBe(false);
    expect(acceptsRepoResult({ sessionId: 's1' }, 's1', '/r/a')).toBe(false);
  });
});
