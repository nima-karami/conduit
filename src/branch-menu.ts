/**
 * Row derivation for the branch switcher menu — pure, so the one rule that keeps getting
 * inverted is testable without a DOM.
 *
 * That rule: the branch you are ON is *current*, not unavailable. It is non-actionable
 * (switching to it is a no-op), but "non-actionable" and "disabled" are different states in
 * the interaction vocabulary (docs/specs/2026-08-01-interaction-state-vocabulary.md) and the
 * menu shipped conflating them — the current branch rendered `disabled`, so the row the menu
 * exists to confirm was the faintest thing in it.
 */

export interface BranchRow {
  branch: string;
  /** The branch HEAD is on. Reads as selected: tinted fill, accent spine, accent check. */
  current: boolean;
  /** Clicking switches. False for the current branch, and for every row mid-switch. */
  actionable: boolean;
  /** Reserved for "the menu is busy". Never for "this is the branch you are on". */
  disabled: boolean;
}

/** Current branch first, then the rest in the order given (the host already sorts). */
export function orderBranches(branches: string[], current: string | null): string[] {
  if (!current) return branches;
  return [current, ...branches.filter((b) => b !== current)];
}

export function branchRow(branch: string, current: string | null, switching: boolean): BranchRow {
  const isCurrent = branch === current;
  return { branch, current: isCurrent, actionable: !isCurrent && !switching, disabled: switching };
}
