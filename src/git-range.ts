/**
 * Pure helpers for the Review "compare two refs" source (spec 2026-06-29-review-changes-polish
 * §3, item 4). DOM-free and git-free: just the endpoint model, the stable request key, the
 * dot-mode selection, and labels. The actual git execution lives host-side (getRangeDiff) and
 * the ref validation in electron/main.ts; this module is what both sides agree on.
 */

/** One side of a comparison. The working tree is a TARGET-only endpoint in MVP (Decision D8):
 *  the base is always committish, so no patch inversion is ever needed. */
export type RefEndpoint =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string; subject?: string }
  | { kind: 'branch'; ref: string };

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Stable, order-significant token for one endpoint — the building block of {@link rangeKey}. */
export function endpointKey(ep: RefEndpoint): string {
  switch (ep.kind) {
    case 'working':
      return 'working';
    case 'commit':
      return `c:${ep.sha}`;
    case 'branch':
      return `b:${ep.ref}`;
  }
}

/** Stable key identifying a (base, head) comparison; both renderer (loader cache) and host
 *  (reply tag) derive it identically so a reply matches its request. */
export function rangeKey(base: RefEndpoint, head: RefEndpoint): string {
  return `${endpointKey(base)}...${endpointKey(head)}`;
}

/**
 * Which git diff mode a comparison uses (spec §3, Decision D2):
 * - both committish → `three` (A...B, merge-base);
 * - committish base + working-tree head → `two` (ref ↔ working tree, no merge-base for an
 *   uncommitted tree);
 * - any working-tree base → `working` (degenerate; the builder forbids base=working and
 *   collapses working-vs-working to the plain working source, so this never reaches git).
 */
export function dotModeFor(base: RefEndpoint, head: RefEndpoint): 'three' | 'two' | 'working' {
  if (base.kind === 'working') return 'working';
  if (head.kind === 'working') return 'two';
  return 'three';
}

/** Short, human label for one endpoint: branch ref · sha7 · "Working tree". */
export function endpointLabel(ep: RefEndpoint): string {
  switch (ep.kind) {
    case 'working':
      return 'Working tree';
    case 'commit':
      return shortSha(ep.sha);
    case 'branch':
      return ep.ref;
  }
}
