import type { SessionIconVisualState } from './session-icon';

/**
 * Class names for the status system's two card-level cues: the single state dot and the
 * card itself. There is EXACTLY ONE dot per card — never two side by side.
 *
 * Neither function derives anything. `sessionIconState()` in src/session-icon.ts is the
 * one derivation, shared with the topbar's aggregate chip; these only translate its
 * result into CSS.
 *
 * The dot is the *glyph* half of the design's "glyph and a word" rule — filled for busy
 * and attention, hollow for idle, dashed for stale — so the states stay apart without
 * relying on colour. The word sits beside it (SESSION_STATE_WORD).
 */
export function dotClass(state: SessionIconVisualState): string {
  return `dot dot--${state}`;
}

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
 * Pure: depends only on its arguments.
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

/** Hover title for the dot — the state, spelled out for the pointer. */
export function dotTitle(state: SessionIconVisualState): string {
  switch (state) {
    case 'attention':
      return 'Finished — needs you';
    case 'busy':
      return 'Working';
    case 'review':
      return 'Finished — left changes to review';
    case 'idle':
      return 'Running, idle';
    case 'stale':
      return 'Not running';
  }
}
