import type { Session } from './types';

/**
 * The single status dot shown on a session card. There is EXACTLY ONE dot per
 * card — never two side by side. Its tone is derived, by strict precedence, from
 * the session's lifecycle `status` plus the two runtime-only activity flags
 * (`busy`, `needsAttention`). See `SessionActivity` for how those flags arise.
 *
 * Mental model (the user's words): "active = vibrant dot, inactive = off". So a
 * dot is either VIBRANT (the session is doing something or wants you) or OFF (a
 * dim, low-emphasis dot for a session that is not active).
 *
 * Tones:
 * - `attention` — a background task finished while unfocused and wants input.
 * - `busy`      — produced output within the busy window (working right now).
 * - `running`   — alive but quiet.
 * - `off`       — not active (exited / stale).
 */
export type DotTone = 'attention' | 'busy' | 'running' | 'off';

export interface DotState {
  /** Which single dot to render. */
  tone: DotTone;
  /** True when the dot should read as a vibrant/lit status; false = dimmed/off. */
  vibrant: boolean;
  /** True when the dot should pulse (busy = recent PTY output). */
  pulse: boolean;
}

/**
 * Derive the single dot state for a session. Total and deterministic: always
 * returns a value, never throws, depends only on its argument.
 *
 * Precedence (highest first) — only ONE tone wins, so only ONE dot is ever
 * rendered:
 *   1. needsAttention -> 'attention' (vibrant)  [a finished task wants input]
 *   2. busy           -> 'busy'      (vibrant, pulsing)
 *   3. running        -> 'running'   (vibrant)
 *   4. otherwise      -> 'off'       (dimmed)    [exited / stale]
 *
 * Note `needsAttention`/`busy` are only ever set on a running session by the host
 * activity tracker, but we still gate on the live `status` first for the running
 * tone so an exited-but-stale flag can never light the dot.
 */
export function dotState(session: Pick<Session, 'status' | 'busy' | 'needsAttention'>): DotState {
  const running = session.status === 'running';

  if (running && session.needsAttention) {
    return { tone: 'attention', vibrant: true, pulse: false };
  }
  if (running && session.busy) {
    return { tone: 'busy', vibrant: true, pulse: true };
  }
  if (running) {
    return { tone: 'running', vibrant: true, pulse: false };
  }
  return { tone: 'off', vibrant: false, pulse: false };
}

/**
 * The single CSS class for the dot tone. Pairs with `.dot` in styles.css; the
 * class fully determines color/glow so the markup stays a single element.
 */
export function dotClass(state: DotState): string {
  return `dot dot--${state.tone}${state.pulse ? ' dot--pulse' : ''}`;
}

/** Human-readable hover title for the dot, or undefined when there's nothing to say. */
export function dotTitle(state: DotState): string | undefined {
  switch (state.tone) {
    case 'attention':
      return 'Finished — needs attention';
    case 'busy':
      return 'Busy';
    case 'running':
      return 'Running';
    case 'off':
      return undefined;
  }
}
