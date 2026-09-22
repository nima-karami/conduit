// Crash-restart budget. See docs/specs/2026-09-22-language-server-go.md §2.2.
export const RESTART_DELAYS_MS = [1000, 4000, 16000] as const;
export const RESTART_WINDOW_MS = 300_000;

/** The delay before the next restart and the history to keep, or null once the budget is spent. */
export function nextRestart(
  history: readonly number[],
  now: number,
): { delayMs: number; history: number[] } | null {
  const recent = history.filter((t) => now - t < RESTART_WINDOW_MS);
  const delayMs = RESTART_DELAYS_MS[recent.length];
  return delayMs === undefined ? null : { delayMs, history: [...recent, now] };
}
