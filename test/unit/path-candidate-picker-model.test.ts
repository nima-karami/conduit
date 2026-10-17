import { describe, expect, it } from 'vitest';
import type { ResolveRoot } from '../../src/path-link-roots';
import type { PathCandidate } from '../../src/path-resolve';
import {
  FILTER_THRESHOLD,
  filterRows,
  pickerHeading,
  pickerRows,
} from '../../webview/components/path-candidate-picker-model';
import { TERM_LINK_STR } from '../../webview/term-link-strings';

const ROOTS: ResolveRoot[] = [
  { abs: '/w', kind: 'home', name: 'w', userChosen: true },
  { abs: '/w/repoA', kind: 'cwd-repo', name: 'repoA', userChosen: true },
  {
    abs: '/w/T-123/repoA-wt',
    kind: 'worktree',
    name: 'repoA-wt',
    branch: 'feat/x',
    userChosen: true,
  },
  { abs: '/w/repoB', kind: 'nested', name: 'repoB', userChosen: true },
  { abs: '/att', kind: 'attached', name: 'att', userChosen: true },
];

const cand = (rootIdx: number, relToRoot: string, repoRoot = '/w/x'): PathCandidate => ({
  absPath: rootIdx >= 0 ? `${ROOTS[rootIdx].abs}/${relToRoot}` : relToRoot,
  rootIdx,
  relToRoot,
  repoRoot,
  relToRepo: relToRoot,
  isDir: false,
  strength: 'exact-root',
});

describe('pickerRows', () => {
  it('names a worktree row with its tag and branch', () => {
    const [row] = pickerRows([cand(2, 'src/index.ts')], ROOTS);
    expect(row).toMatchObject({ tag: 'worktree', branch: 'feat/x', repoName: 'repoA-wt' });
  });

  it('accessibleName is "repo / rel"', () => {
    const [row] = pickerRows([cand(3, 'src/index.ts')], ROOTS);
    expect(row.accessibleName).toBe('repoB / src/index.ts');
    expect(row.tag).toBe('nested');
  });

  it('tags: home and attached named, cwd-repo and outside none', () => {
    const rows = pickerRows(
      [cand(0, 'a'), cand(4, 'a'), cand(1, 'a'), cand(-1, '/far/r/a', '/far/r')],
      ROOTS,
    );
    expect(rows.map((r) => r.tag)).toEqual(['home', 'attached', null, null]);
  });

  it('an outside-root row is named by the last segment of its repoRoot', () => {
    const [row] = pickerRows([cand(-1, '/far/r/a.ts', '/far/r')], ROOTS);
    expect(row.repoName).toBe('r');
    expect(row.accessibleName).toBe('r / /far/r/a.ts');
  });

  it('workingHere marks the context root only', () => {
    const rows = pickerRows([cand(1, 'a'), cand(3, 'a')], ROOTS, 3);
    expect(rows.map((r) => r.workingHere)).toEqual([false, true]);
    expect(pickerRows([cand(1, 'a')], ROOTS).map((r) => r.workingHere)).toEqual([false]);
  });
});

describe('filterRows', () => {
  it('is a case-insensitive substring match on accessibleName', () => {
    const rows = pickerRows([cand(1, 'src/index.ts'), cand(3, 'lib/Index.ts')], ROOTS);
    expect(filterRows(rows, 'REPOB').map((r) => r.repoName)).toEqual(['repoB']);
    expect(filterRows(rows, 'index').map((r) => r.repoName)).toEqual(['repoA', 'repoB']);
    expect(filterRows(rows, '')).toHaveLength(2);
  });
});

describe('pickerHeading and strings', () => {
  it('heading names the token and the count', () => {
    expect(pickerHeading('src/index.ts', 3)).toBe('src/index.ts · 3 matches');
    expect(pickerHeading('a.ts', 1)).toBe('a.ts · 1 match');
  });

  it('an action heading asks to pick a match', () => {
    expect(pickerHeading('x', 3, 'copyPath')).toBe('Copy path — pick a match');
  });

  it(`a ${FILTER_THRESHOLD}-row picker still announces its count through the heading`, () => {
    expect(FILTER_THRESHOLD).toBe(9);
    expect(pickerHeading('index.ts', FILTER_THRESHOLD)).toContain('9 matches');
  });

  it('showingOf formats with Intl.NumberFormat', () => {
    expect(TERM_LINK_STR.showingOf(200, 1234)).toBe('Showing 200 of 1,234');
  });

  it('noMatches and noLongerExists', () => {
    expect(TERM_LINK_STR.noMatches('zz')).toBe('No matches for “zz”');
    expect(TERM_LINK_STR.noLongerExists('a.ts')).toContain('no longer exists');
  });
});
