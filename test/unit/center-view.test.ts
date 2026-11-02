import { describe, expect, it } from 'vitest';
import {
  type CenterView,
  centerViewForAction,
  INITIAL_CENTER_VIEW,
  nextCenterView,
} from '../../webview/center-view';

const VIEWS: readonly CenterView[] = ['editor', 'board', 'canvas'];

describe('center-view', () => {
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

  it('openReview is NOT a center view — it opens an editor tab (R5.5)', () => {
    expect(centerViewForAction('openReview')).toBeNull();
  });

  it('round-trips every center view through an action mapping', () => {
    const actionFor: Record<CenterView, string> = {
      editor: 'openEditor',
      board: 'openBoard',
      canvas: 'openArchitecture',
    };
    for (const v of VIEWS) {
      expect(centerViewForAction(actionFor[v])).toBe(v);
    }
  });

  describe('nextCenterView (transition-to-empty fallback)', () => {
    it('the initial start view is the editor', () => {
      expect(INITIAL_CENTER_VIEW).toBe('editor');
    });

    it('falls every view back to the initial editor when no sessions remain', () => {
      for (const v of VIEWS) {
        expect(nextCenterView(v, 0)).toBe('editor');
      }
    });

    it('closing the last session (board/canvas open) returns to the editor start state', () => {
      // Reproduces J3: user in Board/Canvas closes the final session -> must land
      // on the same empty editor shown at first launch, not a floating overlay.
      expect(nextCenterView('board', 0)).toBe('editor');
      expect(nextCenterView('canvas', 0)).toBe('editor');
    });

    it('preserves the chosen view while at least one session exists', () => {
      for (const v of VIEWS) {
        expect(nextCenterView(v, 1)).toBe(v);
        expect(nextCenterView(v, 5)).toBe(v);
      }
    });

    it('is idempotent for the editor view regardless of count', () => {
      expect(nextCenterView('editor', 0)).toBe('editor');
      expect(nextCenterView('editor', 3)).toBe('editor');
    });
  });
});
