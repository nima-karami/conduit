/**
 * The OS-standard right-click scoping rule for surfaces that have both a multi-selection and a
 * context menu, plus the count↔noun helpers its labels need. Pure, DOM-free and React-free so
 * every such surface inherits one rule instead of re-deriving it (see
 * docs/specs/2026-08-16-selection-aware-context-menus.md §2, §3.1).
 */

export interface MenuTargets<T> {
  /** Everything the selection-scoped items act on, in the order supplied by the caller. */
  targets: T[];
  /** True when the caller must collapse its own selection state to `target` before opening. */
  collapse: boolean;
}

/**
 * `selected` is any iterable of the currently selected keys — an array (arch canvas) or a Set
 * (explorer) both work unchanged. `collapse` is a caller obligation, not a side effect: this
 * module stays pure, so the surface owns its own selection state.
 */
export function resolveMenuTargets<T>(selected: Iterable<T>, target: T): MenuTargets<T> {
  const all = [...selected];
  if (!all.includes(target)) return { targets: [target], collapse: true };
  return { targets: all, collapse: false };
}

/** `1 item` / `3 items` — the one place a count meets a noun (§12: the future i18n seam). */
export function countNoun(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A destructive menu label that grows a count. `single` is the whole existing label, so a
 * surface whose singular label already contains its noun keeps it verbatim (`Delete component`
 * → `Delete 3 components`); see spec §3.1 for why a `(verb, n, plural)` shape cannot.
 */
export function countLabel(
  single: string,
  n: number,
  plural: { verb: string; noun: string },
): string {
  return n > 1 ? `${plural.verb} ${n} ${plural.noun}` : single;
}
