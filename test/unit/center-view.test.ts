import { describe, expect, it } from 'vitest';
import {
  CENTER_VIEWS,
  type CenterView,
  centerViewForAction,
  INITIAL_CENTER_VIEW,
  nextCenterView,
} from '../../webview/center-view';

describe('center-view', () => {
  it('lists exactly editor, review, board, canvas in order', () => {
    expect(CENTER_VIEWS.map((v) => v.id)).toEqual(['editor', 'review', 'board', 'canvas']);
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
    expect(centerViewForAction('openReview')).toBe('review');
  });

  it('returns null for non-view actions', () => {
    expect(centerViewForAction('toggleSidebar')).toBeNull();
    expect(centerViewForAction('openSearch')).toBeNull();
    expect(centerViewForAction('')).toBeNull();
  });

  it('round-trips every CENTER_VIEW id through an action mapping', () => {
    const actionFor: Record<CenterView, string> = {
      editor: 'openEditor',
      review: 'openReview',
      board: 'openBoard',
      canvas: 'openArchitecture',
    };
    for (const v of CENTER_VIEWS) {
      expect(centerViewForAction(actionFor[v.id])).toBe(v.id);
    }
  });

  describe('nextCenterView (transition-to-empty fallback)', () => {
    it('the initial start view is the editor', () => {
      expect(INITIAL_CENTER_VIEW).toBe('editor');
    });

    it('falls every view back to the initial editor when no sessions remain', () => {
      for (const v of CENTER_VIEWS) {
        expect(nextCenterView(v.id, 0)).toBe('editor');
      }
    });

    it('closing the last session (board/canvas open) returns to the editor start state', () => {
      // Reproduces J3: user in Board/Canvas closes the final session -> must land
      // on the same empty editor shown at first launch, not a floating overlay.
      expect(nextCenterView('board', 0)).toBe('editor');
      expect(nextCenterView('canvas', 0)).toBe('editor');
    });

    it('preserves the chosen view while at least one session exists', () => {
      for (const v of CENTER_VIEWS) {
        expect(nextCenterView(v.id, 1)).toBe(v.id);
        expect(nextCenterView(v.id, 5)).toBe(v.id);
      }
    });

    it('is idempotent for the editor view regardless of count', () => {
      expect(nextCenterView('editor', 0)).toBe('editor');
      expect(nextCenterView('editor', 3)).toBe('editor');
    });
  });
});
