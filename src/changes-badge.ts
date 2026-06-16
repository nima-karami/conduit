/**
 * Pure helpers for the Changes-tab count badge (D8).
 * Kept outside the renderer so they can be unit-tested without a DOM.
 */

/**
 * Returns the CSS class string for the badge element, or null when no badge
 * should be rendered (count is zero).
 *
 * @param count   Number of changed files (changes.length).
 * @param active  Whether the Changes tab is currently the active tab.
 */
export function changesBadgeClass(count: number, active: boolean): string | null {
  if (count === 0) return null;
  return active ? 'rtab__badge' : 'rtab__badge rtab__badge--attention';
}
