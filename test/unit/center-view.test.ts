import { describe, expect, it } from 'vitest';
import { CENTER_VIEWS, type CenterView, centerViewForAction } from '../../webview/center-view';

describe('center-view', () => {
  it('lists exactly editor, board, canvas in order', () => {
    expect(CENTER_VIEWS.map((v) => v.id)).toEqual(['editor', 'board', 'canvas']);
  });

  it('every view has a human label', () => {
    for (const v of CENTER_VIEWS) {
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('maps view-switch actions to their center view', () => {
    expect(centerViewForAction('openEditor')).toBe('editor');
    expect(centerViewForAction('openBoard')).toBe('board');
    expect(centerViewForAction('openArchitecture')).toBe('canvas');
  });

  it('returns null for non-view actions', () => {
    expect(centerViewForAction('toggleSidebar')).toBeNull();
    expect(centerViewForAction('openSearch')).toBeNull();
    expect(centerViewForAction('')).toBeNull();
  });

  it('round-trips every CENTER_VIEW id through an action mapping', () => {
    const actionFor: Record<CenterView, string> = {
      editor: 'openEditor',
      board: 'openBoard',
      canvas: 'openArchitecture',
    };
    for (const v of CENTER_VIEWS) {
      expect(centerViewForAction(actionFor[v.id])).toBe(v.id);
    }
  });
});
