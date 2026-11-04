import { describe, expect, it } from 'vitest';
import type { DocKind } from '../../webview/docs';
import { dropHitZone, type TabDrag, tabTerminalPath } from '../../webview/tab-drag';

const fileDrag = (group: 1 | 2): TabDrag => ({
  id: 'file:/w/a.ts',
  group,
  terminalPath: '/w/a.ts',
});
const diffDrag = (group: 1 | 2): TabDrag => ({ id: 'diff:/w/a.ts', group, terminalPath: null });

describe('tabTerminalPath', () => {
  it('only a file tab carries a path for the terminal', () => {
    expect(tabTerminalPath({ kind: 'file', path: '/w/a.ts' })).toBe('/w/a.ts');
    const others: DocKind[] = ['diff', 'commit-diff', 'review', 'web', 'git-history'];
    for (const kind of others) expect(tabTerminalPath({ kind, path: '/w/a.ts' })).toBeNull();
  });
});

describe('dropHitZone', () => {
  it('takes the whole body when the group is not showing the terminal', () => {
    for (const split of [false, true]) {
      expect(dropHitZone(fileDrag(1), 1, split, false)).toBe('body');
      expect(dropHitZone(fileDrag(2), 1, split, false)).toBe('body');
    }
  });

  it('takes the whole body over the terminal for a tab with no path', () => {
    expect(dropHitZone(diffDrag(2), 1, true, true)).toBe('body');
    expect(dropHitZone(diffDrag(1), 1, false, true)).toBe('body');
  });

  it("keeps only the edge split over the terminal for the group's own file tab", () => {
    expect(dropHitZone(fileDrag(1), 1, false, true)).toBe('edge');
  });

  it('leaves the terminal the whole body when no edge split applies', () => {
    expect(dropHitZone(fileDrag(1), 1, true, true)).toBe('none');
    expect(dropHitZone(fileDrag(2), 1, true, true)).toBe('none');
  });
});
