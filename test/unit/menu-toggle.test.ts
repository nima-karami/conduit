import { describe, expect, it } from 'vitest';
import { menuToggleIntent } from '../../src/menu-toggle';

/**
 * Unit tests for the button-anchored menu toggle helper.
 *
 * Background: ContextMenu dismisses on mousedown (capture phase). When a trigger
 * button is clicked while the menu is open, the sequence is:
 *   1. mousedown → ContextMenu closes (normally)
 *   2. click → trigger's onClick fires
 *
 * With the `triggerRef` fix, step 1 is suppressed for the trigger element, so
 * the menu remains open at step 2. The trigger's onMouseDown snapshots the open
 * state; menuToggleIntent decides what the click should do.
 */
describe('menuToggleIntent', () => {
  it('returns "open" when the menu was closed at mousedown', () => {
    expect(menuToggleIntent(false)).toBe('open');
  });

  it('returns "close" when the menu was open at mousedown', () => {
    expect(menuToggleIntent(true)).toBe('close');
  });

  it('is deterministic for the same input', () => {
    expect(menuToggleIntent(false)).toBe(menuToggleIntent(false));
    expect(menuToggleIntent(true)).toBe(menuToggleIntent(true));
  });

  it('covers both toggle directions', () => {
    const open = menuToggleIntent(false);
    const close = menuToggleIntent(true);
    expect(open).not.toBe(close);
    expect(new Set([open, close])).toEqual(new Set(['open', 'close']));
  });
});
