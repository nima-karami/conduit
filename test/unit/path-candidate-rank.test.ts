import { describe, expect, it } from 'vitest';
import type { ResolveRoot } from '../../src/path-link-roots';
import type { PathCandidate } from '../../src/path-resolve';
import { pickerRows } from '../../webview/components/path-candidate-picker-model';
import { chooseClickAction, RANK_KEYS, rankCandidates } from '../../webview/path-candidate-rank';
import { lastPick, notePick } from '../../webview/terminal-link-picks';

const root = (abs: string, kind: ResolveRoot['kind']): ResolveRoot => ({
  abs,
  kind,
  name: abs.split('/').pop() ?? abs,
  userChosen: true,
});
const ROOTS = [
  root('/w', 'home'),
  root('/w/repoA', 'nested'),
  root('/w/T-123/repoA-wt', 'worktree'),
  root('/w/repoB', 'nested'),
  root('/att', 'attached'),
];

const cand = (
  rootIdx: number,
  relToRoot: string,
  over: Partial<PathCandidate> = {},
): PathCandidate => {
  const base = rootIdx >= 0 ? ROOTS[rootIdx].abs : '';
  return {
    absPath: rootIdx >= 0 ? `${base}/${relToRoot}` : relToRoot,
    rootIdx,
    relToRoot,
    repoRoot: base || '/elsewhere',
    relToRepo: relToRoot,
    isDir: false,
    strength: 'exact-root',
    ...over,
  };
};
const names = (cs: PathCandidate[]) => cs.map((c) => (c.rootIdx < 0 ? '-' : ROOTS[c.rootIdx].name));

describe('rankCandidates', () => {
  it('strength first: an exact-root beats a suffix with a shorter rel', () => {
    const ranked = rankCandidates(
      [cand(1, 'a.ts', { strength: 'suffix' }), cand(3, 'deep/er/a.ts')],
      { roots: ROOTS },
    );
    expect(names(ranked)).toEqual(['repoB', 'repoA']);
  });

  it('last pick beats root order (the MVP Gherkin)', () => {
    const cs = [cand(1, 'src/index.ts'), cand(2, 'src/index.ts'), cand(3, 'src/index.ts')];
    expect(names(rankCandidates(cs, { roots: ROOTS }))).toEqual(['repoA', 'repoA-wt', 'repoB']);
    expect(names(rankCandidates(cs, { roots: ROOTS, lastPickRepoRoot: '/w/repoB' }))).toEqual([
      'repoB',
      'repoA',
      'repoA-wt',
    ]);
  });

  it('last pick compares folder keys (win32 case and separators)', () => {
    const roots = [root('G:/w/repoA', 'nested'), root('G:/w/repoB', 'nested')];
    const cs = [
      { ...cand(1, 'x.ts'), rootIdx: 0, repoRoot: 'G:/w/repoA' },
      { ...cand(1, 'x.ts'), rootIdx: 1, repoRoot: 'G:/w/repoB' },
    ];
    const ranked = rankCandidates(cs, { roots, lastPickRepoRoot: 'g:\\w\\REPOB'.toLowerCase() });
    expect(ranked[0].repoRoot).toBe('G:/w/repoB');
  });

  it('home group before attached before nested/worktree', () => {
    const cs = [cand(3, 'x.ts'), cand(4, 'x.ts'), cand(0, 'x.ts')];
    expect(names(rankCandidates(cs, { roots: ROOTS }))).toEqual(['w', 'att', 'repoB']);
  });

  it('nested and worktree by host order (name)', () => {
    const cs = [cand(3, 'x.ts'), cand(2, 'x.ts'), cand(1, 'x.ts')];
    expect(names(rankCandidates(cs, { roots: ROOTS }))).toEqual(['repoA', 'repoA-wt', 'repoB']);
  });

  it('shorter relToRoot, then localeCompare', () => {
    const cs = [cand(1, 'b/x.ts'), cand(1, 'long/x.ts'), cand(1, 'a/x.ts')];
    expect(rankCandidates(cs, { roots: ROOTS }).map((c) => c.relToRoot)).toEqual([
      'a/x.ts',
      'b/x.ts',
      'long/x.ts',
    ]);
  });

  it('outside-root (-1) last', () => {
    const cs = [cand(-1, '/elsewhere/x.ts'), cand(3, 'x.ts')];
    expect(names(rankCandidates(cs, { roots: ROOTS }))).toEqual(['repoB', '-']);
  });

  // T7.2 failed the bar, so the context root is a label only: see
  // docs/runs/2026-10-16-terminal-path-links/report.md "Context-root measurement (T7.2)".
  it('the context root is not a rank key', () => {
    expect(RANK_KEYS).toEqual(['strength', 'lastPick', 'rootGroup', 'rootOrder', 'shorter']);
  });

  it('does not mutate its input', () => {
    const cs = [cand(3, 'x.ts'), cand(1, 'x.ts')];
    const copy = structuredClone(cs);
    rankCandidates(cs, { roots: ROOTS });
    expect(cs).toEqual(copy);
  });
});

describe('pickerRows — the context root labels, never reorders', () => {
  it('keeps the ranked order and flags only the context root row as working here', () => {
    const ranked = rankCandidates([cand(3, 'x.ts'), cand(2, 'x.ts'), cand(1, 'x.ts')], {
      roots: ROOTS,
    });
    const rows = pickerRows(ranked, ROOTS, 3);
    expect(rows.map((r) => r.repoName)).toEqual(['repoA', 'repoA-wt', 'repoB']);
    expect(rows.map((r) => r.workingHere)).toEqual([false, false, true]);
    expect(pickerRows(ranked, ROOTS).some((r) => r.workingHere)).toBe(false);
  });
});

describe('chooseClickAction', () => {
  it('0 → none; 1 → open; an exact-cwd among 3 → open it; 3 exact-root → pick', () => {
    expect(chooseClickAction([])).toEqual({ kind: 'none' });
    const one = cand(1, 'x.ts');
    expect(chooseClickAction([one])).toEqual({ kind: 'open', cand: one });
    const cwd = cand(2, 'x.ts', { strength: 'exact-cwd' });
    expect(chooseClickAction([cand(1, 'x.ts'), cwd, cand(3, 'x.ts')])).toEqual({
      kind: 'open',
      cand: cwd,
    });
    expect(chooseClickAction([cand(1, 'x.ts'), cand(2, 'x.ts'), cand(3, 'x.ts')])).toEqual({
      kind: 'pick',
    });
  });
});

describe('notePick / lastPick', () => {
  it('is keyed by session', () => {
    expect(lastPick('s-none')).toBeUndefined();
    notePick('s1', '/w/repoB');
    notePick('s2', '/w/repoA');
    expect(lastPick('s1')).toBe('/w/repoB');
    expect(lastPick('s2')).toBe('/w/repoA');
    notePick('s1', '/w/repoA');
    expect(lastPick('s1')).toBe('/w/repoA');
  });
});
