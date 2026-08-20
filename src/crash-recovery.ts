/**
 * Decide what to do when a window's renderer process dies.
 *
 * See docs/specs/2026-08-20-renderer-crash-recovery.md.
 */

/** Reasons Electron reports that are ordinary teardown, not a crash. */
const NON_CRASH_REASONS: ReadonlySet<string> = new Set(['clean-exit', 'killed']);

/** Sliding window the reload budget is measured over. */
export const RELOAD_WINDOW_MS = 5 * 60 * 1000;

/** Reloads allowed per window inside `RELOAD_WINDOW_MS`. */
export const MAX_RELOADS = 3;

export type CrashAction = 'reload' | 'give-up' | 'ignore';

export interface CrashDecision {
  action: CrashAction;
  /** `priorReloads` pruned to the window, plus `now` when the action is `reload`. */
  reloads: number[];
}

/**
 * Pure decision for one `render-process-gone` event.
 *
 * An unrecognised reason reloads: a black window is the worst outcome, so an unknown
 * future reason must not be treated as "nothing to do".
 */
export function decideCrashRecovery(
  reason: string,
  priorReloads: readonly number[],
  now: number,
): CrashDecision {
  if (NON_CRASH_REASONS.has(reason)) return { action: 'ignore', reloads: [...priorReloads] };
  const recent = priorReloads.filter((t) => now - t < RELOAD_WINDOW_MS);
  if (recent.length >= MAX_RELOADS) return { action: 'give-up', reloads: recent };
  return { action: 'reload', reloads: [...recent, now] };
}
