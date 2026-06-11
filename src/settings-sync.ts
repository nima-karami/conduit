// Pure decision logic for the renderer's settings provider (K1).
//
// The host echoes its persisted `settings` on EVERY `state` broadcast — including
// activity-driven broadcasts that fire on terminal output (~120ms coalesce), a
// busy/idle sweep (~750ms), and session changes. The renderer applies each echo
// via `hydrate()`. Meanwhile a local toggle flips state immediately but only posts
// the change to the host after a debounce (~250ms). During that window — and during
// the in-flight round-trip after the post — the host's copy is STALE. A broadcast
// landing in that window carries the old value and `hydrate()` would clobber the
// user's optimistic change (the "collapse sidebar flashes open then shut" bug).
//
// This module is the gate: it decides whether an incoming hydrate should be applied
// or ignored, with no React/DOM/timer dependencies so the interleavings are unit
// testable. The provider owns the wall clock and merely calls these transitions.

/** Mutable gate carried in a ref by the provider. */
export interface SyncGate {
  /** A local change is pending (not yet posted) OR an echo of it is still in flight. */
  dirty: boolean;
  /**
   * Monotonic count of local edits. A debounced post captures the epoch it sent;
   * a hydrate is only trusted once we've seen no edits since the last settled post.
   * (Kept for clarity / future protocol echo-matching; the provider uses `dirty`.)
   */
  epoch: number;
}

export function makeGate(): SyncGate {
  return { dirty: false, epoch: 0 };
}

/**
 * A local user edit happened. Marks the gate dirty and bumps the epoch. From this
 * moment until the post round-trip settles, incoming hydrates are stale and ignored.
 */
export function onLocalEdit(gate: SyncGate): void {
  gate.dirty = true;
  gate.epoch += 1;
}

/**
 * The debounced post has fired (the host now has our value). We stay dirty until the
 * echo that carries OUR value comes back, because broadcasts already in flight when we
 * posted still carry the stale value. `settle()` (below) clears dirty once a hydrate
 * matching our posted value arrives, or the provider may call it directly when it can
 * prove no stale echo can still be in flight.
 *
 * Returns the epoch that was posted, so a caller can detect a newer edit landing
 * during the post.
 */
export function onPostFired(gate: SyncGate): number {
  return gate.epoch;
}

/**
 * Decide whether an incoming hydrate should be applied.
 *
 * - While dirty (a local change is pending/unconfirmed) we IGNORE the echo — it is
 *   either the stale pre-change value or a broadcast that raced our post.
 * - Once the echo matches what we last posted, we clear dirty and accept it (this is
 *   the host confirming our change; future echoes are authoritative again).
 * - When not dirty, hydrate always applies (host is the source of truth at idle).
 *
 * `postedEpoch` is the epoch captured at the last post; `incomingMatchesPosted` is
 * true when the hydrated value deep-equals the value we posted (the confirmation).
 */
export function decideHydrate(
  gate: SyncGate,
  opts: { postedEpoch: number; incomingMatchesPosted: boolean },
): { apply: boolean } {
  if (!gate.dirty) return { apply: true };
  // We're dirty. If a newer local edit happened after the post, the gate epoch has
  // moved past postedEpoch — keep ignoring; only the latest edit's confirmation counts.
  if (gate.epoch !== opts.postedEpoch) return { apply: false };
  // Same epoch as the last post: if this echo carries our posted value, it's the
  // confirmation — clear dirty and let subsequent (authoritative) echoes through.
  if (opts.incomingMatchesPosted) {
    gate.dirty = false;
    return { apply: false }; // value already equals local state; no need to re-set
  }
  // Same epoch but value doesn't match yet -> a stale broadcast that raced our post.
  return { apply: false };
}

/** Clear the dirty flag (e.g. provider proved no stale echo can remain). */
export function settle(gate: SyncGate): void {
  gate.dirty = false;
}
