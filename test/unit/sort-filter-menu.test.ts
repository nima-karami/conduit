import { describe, expect, it } from 'vitest';
import { buildAgentsPaneMenu } from '../../webview/sort-filter-menu';

describe('buildAgentsPaneMenu', () => {
  it('offers New agent then the two bulk closes, behind one divider', () => {
    const items = buildAgentsPaneMenu({ sessionCount: 2, staleCount: 1 });
    expect(items.map((i) => i.action)).toEqual(['new', 'closeAll', 'closeAllStale']);
    expect(items.map((i) => i.label)).toEqual([
      'New agent',
      'Close all sessions',
      'Close all stale sessions',
    ]);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.action)).toEqual(['closeAll']);
    expect(items.filter((i) => i.danger).map((i) => i.action)).toEqual([
      'closeAll',
      'closeAllStale',
    ]);
  });

  it('has no sort or grouping entries any more', () => {
    const labels = buildAgentsPaneMenu({ sessionCount: 1, staleCount: 0 }).map((i) => i.label);
    expect(labels.join(' ')).not.toMatch(/sort|group|manual/i);
  });

  it('disables each close when there is nothing for it to close', () => {
    const none = buildAgentsPaneMenu({ sessionCount: 0, staleCount: 0 });
    expect(none.find((i) => i.action === 'closeAll')?.disabled).toBe(true);
    expect(none.find((i) => i.action === 'closeAllStale')?.disabled).toBe(true);
    expect(none.find((i) => i.action === 'new')?.disabled).toBeFalsy();
    const some = buildAgentsPaneMenu({ sessionCount: 3, staleCount: 2 });
    expect(some.every((i) => !i.disabled)).toBe(true);
  });
});
