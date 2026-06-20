/**
 * Pure decision/validation helpers for the branch switcher (Slice B). Kept free of any
 * IO so the refuse-rule and the host-side allow-list check are unit-tested without
 * spawning git. The host (electron/main.ts) and the e2e harness drive these directly.
 *
 * The switch is a STATE-CHANGING action against a working tree that may have a live PTY,
 * so it is gated by `decideSwitch`: refuse while the session is busy (a child process is
 * running against the tree — swapping files under it can corrupt its view) and refuse
 * while the tree is dirty (a checkout can fail or carry changes across branches). The
 * renderer's `ref` is never trusted: `isKnownRef` re-checks it against the branch set the
 * host itself enumerated before it can reach `execFile`.
 */

export type SwitchRefusal = 'busy' | 'dirty';

export type SwitchDecision = { ok: true } | { ok: false; reason: SwitchRefusal };

/**
 * Decide whether a branch switch may proceed given the session's runtime state. Busy
 * takes precedence over dirty: a running process is the more dangerous condition (it
 * holds the working tree open), so we report it first even when the tree is also dirty.
 */
export function decideSwitch({ busy, dirty }: { busy: boolean; dirty: boolean }): SwitchDecision {
  if (busy) return { ok: false, reason: 'busy' };
  if (dirty) return { ok: false, reason: 'dirty' };
  return { ok: true };
}

/**
 * True when `ref` is one of the host-enumerated branch names. The host re-lists branches
 * for the cwd and validates here so a renderer cannot smuggle an arbitrary string (e.g. a
 * flag-like `--upload-pack=…`) into the git arg array. An empty list rejects everything.
 */
export function isKnownRef(ref: string, branches: readonly string[]): boolean {
  if (!ref) return false;
  return branches.includes(ref);
}
