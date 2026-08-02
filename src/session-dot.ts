import type { SessionIconVisualState } from './session-icon';

/**
 * Build the class string for a session card. The cues are deliberately SEPARATE classes
 * so the CSS can render them distinctly (R4.4):
 *   - `session--active`  — the selection cue. Driven by a single `selected` boolean derived
 *     upstream from `id === activeId`, so by construction at most one card is ever active.
 *   - `session--<state>` — the status cue, one of the five. The CSS resolves the cases
 *     where the two would compete.
 *
 * A selected card always carries `session--active`, and an unselected card never does — so
 * the selection border can't get stuck on a deselected card or appear on two at once.
 *
 * The card carries no state *dot*: it already shows the session's own icon, and a second
 * glyph beside it read as two icons on one row. The state's WORD (SESSION_STATE_WORD) is
 * what keeps the states apart without relying on colour.
 *
 * Nothing here derives anything. `sessionIconState()` in src/session-icon.ts is the one
 * derivation, shared with the topbar's aggregate chip; this only translates its result.
 */
export function sessionRowClass(opts: {
  selected: boolean;
  state: SessionIconVisualState;
  dropTarget: boolean;
}): string {
  const classes = ['session', `session--${opts.state}`];
  if (opts.selected) classes.push('session--active');
  if (opts.dropTarget) classes.push('session--dropbefore');
  return classes.join(' ');
}
