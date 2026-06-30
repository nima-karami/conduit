/**
 * Pure helpers for the Review "compare two refs" source (specs 2026-06-29-review-changes-polish
 * §3 item 4 + 2026-06-30-review-compare-dialog). DOM-free and git-free: the endpoint model, the
 * stable request key, the dot-mode selection, labels, and the validator's ref-namespace mapper.
 * The actual git execution lives host-side (getRangeDiff) and the ref validation in
 * electron/main.ts; this module is what both sides agree on.
 */

/** One side of a comparison. The working tree is a TARGET-only endpoint in MVP (Decision D8):
 *  the base is always committish, so no patch inversion is ever needed. A branch may be a
 *  remote-tracking ref (`remote:true` ⇒ refs/remotes/<ref>, e.g. "origin/main"). */
export type RefEndpoint =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string; subject?: string }
  | { kind: 'branch'; ref: string; remote?: boolean }
  | { kind: 'tag'; ref: string };

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Stable, order-significant token for one endpoint — the building block of {@link rangeKey}. */
export function endpointKey(ep: RefEndpoint): string {
  switch (ep.kind) {
    case 'working':
      return 'working';
    case 'commit':
      return `c:${ep.sha}`;
    // A remote branch's ref ("origin/main") already disambiguates it from a local "main".
    case 'branch':
      return `b:${ep.ref}`;
    case 'tag':
      return `t:${ep.ref}`;
  }
}

/** Stable key identifying a (base, head) comparison; both renderer (loader cache) and host
 *  (reply tag) derive it identically so a reply matches its request. */
export function rangeKey(base: RefEndpoint, head: RefEndpoint): string {
  return `${endpointKey(base)}...${endpointKey(head)}`;
}

/**
 * Which git diff mode a comparison uses (spec §3, Decision D2):
 * - both committish (commit/branch/remote/tag) → `three` (A...B, merge-base);
 * - committish base + working-tree head → `two` (ref ↔ working tree, no merge-base for an
 *   uncommitted tree);
 * - any working-tree base → `working` (degenerate; the dialog forbids base=working and
 *   collapses working-vs-working to the plain working source, so this never reaches git).
 */
export function dotModeFor(base: RefEndpoint, head: RefEndpoint): 'three' | 'two' | 'working' {
  if (base.kind === 'working') return 'working';
  if (head.kind === 'working') return 'two';
  return 'three';
}

/** Short, human label for one endpoint: ref name (branch/remote/tag) · sha7 · "Working tree". */
export function endpointLabel(ep: RefEndpoint): string {
  switch (ep.kind) {
    case 'working':
      return 'Working tree';
    case 'commit':
      return shortSha(ep.sha);
    case 'branch':
    case 'tag':
      return ep.ref;
  }
}

/**
 * The fully-qualified ref path a branch/tag endpoint names, for EXACT host validation
 * (spec 2026-06-30 §3 design-review correction). Validation keys on the ref namespace
 * (`refs/heads` vs `refs/remotes` vs `refs/tags`) — derived here from the endpoint kind +
 * `remote` flag — NOT on list membership, so a mislabeled endpoint maps to a path that simply
 * won't exist. Returns null for a non-ref endpoint (working/commit) or a name beginning with
 * `-` (defensive: such a token must never reach an arg array as an option-like string).
 */
export function fullyQualifiedRef(ep: RefEndpoint): string | null {
  if (ep.kind === 'branch' || ep.kind === 'tag') {
    const name = ep.ref;
    if (!name || name.startsWith('-')) return null;
    if (ep.kind === 'tag') return `refs/tags/${name}`;
    return ep.remote ? `refs/remotes/${name}` : `refs/heads/${name}`;
  }
  return null;
}
