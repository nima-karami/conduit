import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BRANCH_REFS,
  type RangePresetDeps,
  resolveRangePreset,
} from '../../src/range-preset';

const HEAD = 'h'.repeat(40);
const UP = 'u'.repeat(40);
const MAIN = 'm'.repeat(40);
const BASE = 'b'.repeat(40);

const deps = (over: Partial<RangePresetDeps> = {}): RangePresetDeps => ({
  upstreamRef: async () => 'origin/feature',
  revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/feature' ? UP : null),
  mergeBase: async () => BASE,
  ...over,
});

describe('resolveRangePreset — unpushed', () => {
  it('resolves upstream…HEAD as two sha endpoints', async () => {
    expect(await resolveRangePreset('unpushed', deps())).toEqual({
      base: { kind: 'commit', sha: UP },
      head: { kind: 'commit', sha: HEAD },
    });
  });

  it('errors when the branch has no upstream', async () => {
    const r = await resolveRangePreset('unpushed', deps({ upstreamRef: async () => null }));
    expect(r).toEqual({ error: 'This branch has no upstream' });
  });

  it('errors when the upstream ref name does not resolve to a commit', async () => {
    const r = await resolveRangePreset(
      'unpushed',
      deps({ revParse: async (ref) => (ref === 'HEAD' ? HEAD : null) }),
    );
    expect(r).toEqual({ error: 'This branch has no upstream' });
  });

  it('errors when everything is already pushed', async () => {
    const r = await resolveRangePreset('unpushed', deps({ revParse: async () => HEAD }));
    expect(r).toEqual({ error: 'Nothing unpushed' });
  });

  it('errors on an unborn HEAD without asking for an upstream', async () => {
    const upstreamRef = vi.fn(async () => 'origin/feature');
    const r = await resolveRangePreset(
      'unpushed',
      deps({ revParse: async () => null, upstreamRef }),
    );
    expect(r).toEqual({ error: 'This branch has no commits yet' });
    expect(upstreamRef).not.toHaveBeenCalled();
  });
});

describe('resolveRangePreset — branchPoint', () => {
  it('resolves merge-base(default, HEAD)…HEAD', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/HEAD' ? MAIN : null),
      }),
    );
    expect(r).toEqual({
      base: { kind: 'commit', sha: BASE },
      head: { kind: 'commit', sha: HEAD },
    });
  });

  it('prefers origin/HEAD, then main, then master', async () => {
    expect([...DEFAULT_BRANCH_REFS]).toEqual(['origin/HEAD', 'main', 'master']);
    const seen: string[] = [];
    await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) => {
          if (ref === 'HEAD') return HEAD;
          seen.push(ref);
          return ref === 'master' ? MAIN : null;
        },
      }),
    );
    expect(seen).toEqual(['origin/HEAD', 'main', 'master']);
  });

  it('errors when no default branch exists at all', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({ revParse: async (ref) => (ref === 'HEAD' ? HEAD : null) }),
    );
    expect(r).toEqual({ error: 'No default branch to compare against' });
  });

  it('falls through to the next candidate when merge-base finds no common ancestor', async () => {
    const mergeBase = vi.fn(async (a: string) => (a === MAIN ? BASE : null));
    const r = await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) =>
          ref === 'HEAD'
            ? HEAD
            : ref === 'origin/HEAD'
              ? 'o'.repeat(40)
              : ref === 'main'
                ? MAIN
                : null,
        mergeBase,
      }),
    );
    expect(r).toEqual({ base: { kind: 'commit', sha: BASE }, head: { kind: 'commit', sha: HEAD } });
    expect(mergeBase).toHaveBeenCalledTimes(2);
  });

  it('errors when HEAD IS the default branch — the comparison would be empty', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/HEAD' ? HEAD : null),
        mergeBase: async () => HEAD,
      }),
    );
    expect(r).toEqual({ error: 'This branch has no commits of its own' });
  });
});
