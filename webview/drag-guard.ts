// Decides whether a `dragstart` that began on a panel's bar should move the whole
// panel, or be ignored because it landed on an in-bar control / a child that owns its
// own drag (a tab, a session card, the rename input). Kept pure + DOM-read-only so it
// is unit-testable in a `node` env without a DOM library: it only relies on the two
// standard `Element` reads modeled by `ElementLike`.

/**
 * The slice of `Element` this guard reads — a real DOM `Element` satisfies it. `contains`
 * takes `unknown` (not `ElementLike`) so the real `Node.contains(other: Node | null)` is
 * assignable here (parameter contravariance); `closest` is the standard signature.
 */
export interface ElementLike {
  closest(selectors: string): ElementLike | null;
  contains(other: unknown): boolean;
}

// Controls / own-draggable children that must NEVER trigger a panel-move drag.
// `.tab` and `.session` are listed explicitly: a session card that is not currently
// draggable (manual sort off, or a filter active) loses its `[draggable="true"]`
// attribute, so its class is the only thing that still excludes it from "background".
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label,' +
  ' [role="button"], [role="menuitem"], [draggable="true"],' +
  ' [contenteditable="true"], .tab, .session';

/**
 * True only when a drag starting on `target` should move the whole panel: the pointer
 * is on the bar (`barEl`) background, not on an interactive control or a child that
 * owns its own drag. False for null/outside targets and for anything matching
 * `INTERACTIVE_SELECTOR` strictly *between* `target` and `barEl`.
 *
 * The bar itself carries `draggable="true"` (it is the drag source), so a naive
 * `closest(INTERACTIVE_SELECTOR)` would match the bar and wrongly reject a drag from
 * the bar's own background. We therefore treat a `closest` match that *is* `barEl` as
 * background — only an interactive element strictly inside the bar disqualifies it.
 */
export function isPanelDragTarget(target: ElementLike | null, barEl: ElementLike): boolean {
  if (!target || !barEl.contains(target)) return false;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  return hit === null || hit === barEl;
}
