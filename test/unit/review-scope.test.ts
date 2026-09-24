import { describe, expect, it } from 'vitest';
import type { ReviewSource } from '../../webview/docs';
import {
  diffKey,
  diffsForScope,
  inScope,
  reviewSourceKey,
  scopeDiffArgs,
  scopeFromDiffArgs,
  scopeOfSource,
  workingSource,
} from '../../webview/review-scope';

describe('scopeOfSource', () => {
  it('defaults an absent source and an unscoped working source to all', () => {
    expect(scopeOfSource(undefined)).toBe('all');
    expect(scopeOfSource({ kind: 'working' })).toBe('all');
  });

  it('reads the working source scope', () => {
    expect(scopeOfSource({ kind: 'working', scope: 'staged' })).toBe('staged');
    expect(scopeOfSource({ kind: 'working', scope: 'unstaged' })).toBe('unstaged');
  });

  it('forces all for commit and range sources', () => {
    const commit: ReviewSource = { kind: 'commit', sha: 'abc' };
    const range: ReviewSource = {
      kind: 'range',
      base: { kind: 'commit', sha: 'a' },
      head: { kind: 'working' },
    };
    expect(scopeOfSource(commit)).toBe('all');
    expect(scopeOfSource(range)).toBe('all');
  });
});

describe('scopeDiffArgs', () => {
  it('sends nothing for all, so the host reproduces today exactly', () => {
    expect(scopeDiffArgs('all')).toEqual({});
  });

  it('maps staged to HEAD→index and unstaged to index→worktree', () => {
    expect(scopeDiffArgs('staged')).toEqual({ base: 'head', side: 'index' });
    expect(scopeDiffArgs('unstaged')).toEqual({ base: 'index', side: 'worktree' });
  });

  it('round-trips through the reply echo', () => {
    for (const s of ['all', 'staged', 'unstaged'] as const) {
      expect(scopeFromDiffArgs(scopeDiffArgs(s))).toBe(s);
    }
  });
});

describe('diffKey / diffsForScope', () => {
  it('leaves the all-scope key as the bare path', () => {
    expect(diffKey('/repo/a.ts', 'all')).toBe('/repo/a.ts');
  });

  it('separates the three scopes for one path', () => {
    const keys = new Set([
      diffKey('/repo/a.ts', 'all'),
      diffKey('/repo/a.ts', 'staged'),
      diffKey('/repo/a.ts', 'unstaged'),
    ]);
    expect(keys.size).toBe(3);
  });

  it('projects a scoped cache back to plain paths and hides other scopes', () => {
    const cache = new Map([
      [diffKey('/repo/a.ts', 'all'), 'A'],
      [diffKey('/repo/a.ts', 'staged'), 'S'],
      [diffKey('/repo/b.ts', 'unstaged'), 'U'],
    ]);
    expect(diffsForScope(cache, 'staged')).toEqual(new Map([['/repo/a.ts', 'S']]));
    expect(diffsForScope(cache, 'unstaged')).toEqual(new Map([['/repo/b.ts', 'U']]));
    expect(diffsForScope(cache, 'all')).toBe(cache);
  });
});

describe('workingSource / reviewSourceKey', () => {
  it('workingSource("all") → {kind:"working"}', () => {
    expect(workingSource('all')).toEqual({ kind: 'working' });
    expect(workingSource('all', '/r')).toEqual({ kind: 'working', repoRoot: '/r' });
  });

  it('workingSource("staged", "/r") → {kind:"working", scope:"staged", repoRoot:"/r"}', () => {
    expect(workingSource('staged', '/r')).toEqual({
      kind: 'working',
      scope: 'staged',
      repoRoot: '/r',
    });
    expect(workingSource('unstaged')).toEqual({ kind: 'working', scope: 'unstaged' });
  });

  it('reviewSourceKey matches today: working | working:staged | commit:<sha> | range:<rangeKey>', () => {
    expect(reviewSourceKey(undefined)).toBe('working');
    expect(reviewSourceKey({ kind: 'working' })).toBe('working');
    expect(reviewSourceKey({ kind: 'working', scope: 'staged' })).toBe('working:staged');
    expect(reviewSourceKey({ kind: 'working', scope: 'unstaged' })).toBe('working:unstaged');
    expect(reviewSourceKey({ kind: 'commit', sha: 'abc123', subject: 's' })).toBe('commit:abc123');
    expect(
      reviewSourceKey({
        kind: 'range',
        base: { kind: 'branch', ref: 'main' },
        head: { kind: 'working' },
      }),
    ).toBe('range:b:main...working');
  });

  it('reviewSourceKey ignores repoRoot', () => {
    expect(reviewSourceKey({ kind: 'working', scope: 'staged', repoRoot: 'C:/r' })).toBe(
      'working:staged',
    );
    expect(reviewSourceKey({ kind: 'commit', sha: 'abc', repoRoot: 'C:/r' })).toBe('commit:abc');
    expect(
      reviewSourceKey({
        kind: 'range',
        base: { kind: 'tag', ref: 'v1' },
        head: { kind: 'commit', sha: 'f' },
        repoRoot: 'C:/r',
      }),
    ).toBe('range:t:v1...c:f');
  });
});

describe('inScope', () => {
  it('all keeps both sides; staged/unstaged keep only their side', () => {
    expect(inScope({ staged: true }, 'all')).toBe(true);
    expect(inScope({ staged: false }, 'all')).toBe(true);
    expect(inScope({ staged: true }, 'staged')).toBe(true);
    expect(inScope({ staged: false }, 'staged')).toBe(false);
    expect(inScope({ staged: false }, 'unstaged')).toBe(true);
    expect(inScope({ staged: true }, 'unstaged')).toBe(false);
  });
});
