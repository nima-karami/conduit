import { describe, expect, it } from 'vitest';
import { EMPTY_NAV, type NavState, nextLanding, record } from '../../src/nav-history';
import {
  absorbEntry,
  clampPos,
  coalescesEntries,
  EDITOR_NAV_OPS,
  findOpenDoc,
  isSignificantJump,
  type NavEntry,
  navAnnouncement,
  navEntryFor,
} from '../../webview/editor-nav';

const at = (path: string, line?: number, sessionId = 's1'): NavEntry =>
  navEntryFor(
    { kind: 'file', path, sessionId },
    line === undefined ? undefined : { line, column: 1 },
  );

describe('editor-nav entry model', () => {
  it('coalesces within 10 lines', () => {
    expect(coalescesEntries(at('/a.ts', 5), at('/a.ts', 15))).toBe(true);
    expect(coalescesEntries(at('/a.ts', 5), at('/a.ts', 16))).toBe(false);
    expect(coalescesEntries(at('/a.ts', 16), at('/a.ts', 5))).toBe(false);
  });

  it('a pos-less side always coalesces in the same doc', () => {
    expect(coalescesEntries(at('/a.ts'), at('/a.ts', 90))).toBe(true);
    expect(coalescesEntries(at('/a.ts', 90), at('/a.ts'))).toBe(true);
    expect(coalescesEntries(at('/a.ts'), at('/a.ts'))).toBe(true);
  });

  it('a different kind or path never coalesces', () => {
    expect(coalescesEntries(at('/a.ts', 5), at('/b.ts', 5))).toBe(false);
    const diff = navEntryFor({ kind: 'diff', path: '/a.ts', sessionId: 's1' });
    expect(coalescesEntries(at('/a.ts'), diff)).toBe(false);
  });

  // A doc has one owner and moves to whichever session reopens it (docs.ts), so a doc's identity is
  // {kind, path}; the recorded session only says where to reopen a closed file.
  it('the same doc under another session is the same place', () => {
    expect(coalescesEntries(at('/a.ts', 5), at('/a.ts', 5, 's2'))).toBe(true);
    expect(EDITOR_NAV_OPS.sameTarget(at('/a.ts', 5), at('/a.ts', 40, 's2'))).toBe(true);
    expect(absorbEntry(at('/a.ts', 5), at('/a.ts', undefined, 's2'))).toEqual(at('/a.ts', 5, 's2'));
  });

  it('Back never re-lands on a doc that moved to the session showing it', () => {
    const s: NavState<NavEntry> = {
      stack: [at('/a.ts', undefined, 's1'), at('/a.ts', undefined, 's2'), at('/b.ts', 1, 's2')],
      index: 1,
    };
    const live = at('/a.ts', 1, 's2');
    const onScreen = (e: NavEntry) => coalescesEntries(live, e);
    expect(nextLanding(s, -1, () => true, onScreen)).toBe(-1);
  });

  it('absorbEntry keeps the old pos when the new entry has none', () => {
    expect(absorbEntry(at('/a.ts', 7), at('/a.ts'))).toEqual(at('/a.ts', 7));
    expect(absorbEntry(at('/a.ts', 7), at('/a.ts', 9))).toEqual(at('/a.ts', 9));
    expect(absorbEntry(at('/a.ts'), at('/a.ts', 9))).toEqual(at('/a.ts', 9));
  });

  it('clampPos clamps past-EOF line and past-EOL column', () => {
    const maxColumn = (line: number) => (line === 20 ? 5 : 40);
    expect(clampPos({ line: 99, column: 30 }, 20, maxColumn)).toEqual({ line: 20, column: 5 });
    expect(clampPos({ line: 3, column: 99 }, 20, maxColumn)).toEqual({ line: 3, column: 40 });
    expect(clampPos({ line: 0, column: 0 }, 20, maxColumn)).toEqual({ line: 1, column: 1 });
    expect(clampPos({ line: 4, column: 2 }, 20, maxColumn)).toEqual({ line: 4, column: 2 });
  });

  it('navAnnouncement with and without a line', () => {
    expect(navAnnouncement('a.ts', { line: 12, column: 3 })).toBe('Editor: a.ts, line 12');
    expect(navAnnouncement('Review Changes')).toBe('Editor: Review Changes');
  });

  it('findOpenDoc matches a pinned commit-diff by kind+path', () => {
    const docs = [
      { id: 'commit-diff:@preview', kind: 'commit-diff' as const, path: 'abc x.ts' },
      { id: 'commit-diff:def y.ts', kind: 'commit-diff' as const, path: 'def y.ts' },
      { id: 'file:/y.ts', kind: 'file' as const, path: 'def y.ts' },
    ];
    expect(findOpenDoc(docs, { kind: 'commit-diff', path: 'def y.ts' })?.id).toBe(
      'commit-diff:def y.ts',
    );
    expect(findOpenDoc(docs, { kind: 'commit-diff', path: 'zzz y.ts' })).toBeUndefined();
  });

  it('isSignificantJump', () => {
    const move = { fromLine: 5, edited: false, tagged: false };
    expect(isSignificantJump({ ...move, toLine: 16 })).toBe(true);
    expect(isSignificantJump({ ...move, toLine: 15 })).toBe(false);
    expect(isSignificantJump({ ...move, fromLine: 16, toLine: 5 })).toBe(true);
    expect(isSignificantJump({ ...move, toLine: 90, edited: true })).toBe(false);
    expect(isSignificantJump({ ...move, toLine: 90, tagged: true })).toBe(false);
  });

  it('record with EDITOR_NAV_OPS: F1/F2/F3', () => {
    const empty: NavState<NavEntry> = EMPTY_NAV;
    const f3 = record(empty, null, at('/a.ts'), EDITOR_NAV_OPS);
    expect(f3.stack).toEqual([at('/a.ts')]);

    const f1 = record(f3, at('/a.ts', 12), at('/b.ts', 40), EDITOR_NAV_OPS);
    expect(f1.stack).toEqual([at('/a.ts', 12), at('/b.ts', 40)]);
    expect(f1.index).toBe(1);

    const f2 = record(f1, at('/x.ts', 3), at('/c.ts'), EDITOR_NAV_OPS);
    expect(f2.stack).toEqual([at('/a.ts', 12), at('/b.ts', 40), at('/x.ts', 3), at('/c.ts')]);
    expect(f2.index).toBe(3);
  });
});
