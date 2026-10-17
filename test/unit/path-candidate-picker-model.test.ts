import { describe, expect, it } from 'vitest';
import type { ResolveRoot } from '../../src/path-link-roots';
import type { PathCandidate } from '../../src/path-resolve';
import {
  detectedLinkRow,
  FILTER_THRESHOLD,
  filterRows,
  pickerCount,
  pickerFooter,
  pickerHeading,
  pickerRows,
  searchQueryOf,
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

  it('accessibleName is "repo (tag) / rel": the aria-label replaces the pill’s text', () => {
    const [row] = pickerRows([cand(3, 'src/index.ts')], ROOTS);
    expect(row.accessibleName).toBe('repoB (Nested) / src/index.ts');
    expect(row.tag).toBe('nested');
  });

  it('a worktree row’s accessible name carries its tag and branch (QA r1 Q4)', () => {
    const [row] = pickerRows([cand(2, 'src/index.ts')], ROOTS);
    expect(row.accessibleName).toBe('repoA-wt (Worktree, feat/x) / src/index.ts');
  });

  it('an untagged row is "repo / rel"; working here is announced too', () => {
    const [plain] = pickerRows([cand(1, 'a.ts')], ROOTS);
    expect(plain.accessibleName).toBe('repoA / a.ts');
    const [here] = pickerRows([cand(1, 'a.ts')], ROOTS, 1);
    expect(here.accessibleName).toBe('repoA (working here) / a.ts');
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

  it('the second column is the path relative to its root', () => {
    expect(pickerRows([cand(1, 'src/a.ts')], ROOTS)[0].detail).toBe('src/a.ts');
    expect(pickerRows([cand(-1, '/far/r/a.ts', '/far/r')], ROOTS)[0].detail).toBe('/far/r/a.ts');
  });

  it('workingHere marks the context root only', () => {
    const rows = pickerRows([cand(1, 'a'), cand(3, 'a')], ROOTS, 3);
    expect(rows.map((r) => r.workingHere)).toEqual([false, true]);
    expect(pickerRows([cand(1, 'a')], ROOTS).map((r) => r.workingHere)).toEqual([false]);
  });
});

// v1 QA r2 Q2: the row is titled by the link's token, so the second column names where it
// resolved instead of repeating the token.
describe('detectedLinkRow', () => {
  it('title = the token, second column = its root name', () => {
    const row = detectedLinkRow('k1', 'src/index.ts', cand(3, 'src/index.ts'), ROOTS);
    expect(row).toMatchObject({ key: 'k1', repoName: 'src/index.ts', detail: 'repoB' });
    expect(row.accessibleName).toBe('src/index.ts');
  });

  it('outside every root: the last segment of its repoRoot', () => {
    const row = detectedLinkRow('k', '/far/r/a.ts', cand(-1, '/far/r/a.ts', '/far/r'), ROOTS);
    expect(row.detail).toBe('r');
  });

  it('a second column equal to the title is omitted', () => {
    expect(detectedLinkRow('k', 'repoB', cand(3, ''), ROOTS).detail).toBeNull();
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

  // v1 review r2 SF-a: the token cap counts unresolved tokens, so a total would claim them.
  it('footer: links say how many newest, files how many of the total', () => {
    expect(pickerFooter('links', 10, 37)).toBe('Showing the 10 newest');
    expect(pickerFooter('files', 200, 1234)).toBe('Showing 200 of 1,234');
  });

  // v1 review r3 SF-1: a filtered heading counts what the filter left, not the unfiltered list.
  it('count follows the filter; unfiltered, links count rows and files the total', () => {
    const three = [1, 2, 3];
    expect(pickerCount('files', 'ab', [1], three, 1234)).toBe(1);
    expect(pickerCount('links', 'ab', [], three, 37)).toBe(0);
    expect(pickerCount('files', '', three, three, 1234)).toBe(1234);
    expect(pickerCount('links', '', three, three, 37)).toBe(3);
    expect(pickerCount('files', '  ', three, three, 1234)).toBe(1234);
  });

  it('the links list counts links; file lists count matches', () => {
    expect(pickerHeading('Links on screen', 2, undefined, 'links')).toBe(
      'Links on screen · 2 links',
    );
    expect(pickerHeading('Links on screen', 1, undefined, 'links')).toBe(
      'Links on screen · 1 link',
    );
    expect(pickerHeading('a.ts', 2, undefined, 'files')).toBe('a.ts · 2 matches');
  });

  it('noMatches and noLongerExists', () => {
    expect(TERM_LINK_STR.noMatches('zz')).toBe('No matches for “zz”');
    expect(TERM_LINK_STR.noLongerExists('a.ts')).toContain('no longer exists');
  });
});

describe('searchQueryOf', () => {
  it('an elided token searches its concrete tail; any other token as-is', () => {
    expect(searchQueryOf('…/src/index.ts')).toBe('src/index.ts');
    expect(searchQueryOf('C:\\a\\...\\b\\c.ts')).toBe('b/c.ts');
    expect(searchQueryOf('src/index.ts')).toBe('src/index.ts');
  });
});
