import type { TermStartMode } from '../src/protocol';
import type { SessionStatus } from '../src/types';

interface TerminalPaneMount<S> {
  session: S;
  mode: TermStartMode;
}

/**
 * The sessions the terminal stack gives a pane, and how each pane starts. A running session keeps
 * its pane while hidden, so its stream is never cut. An exited one that ran under its pane key has
 * one only while shown: a `view` start repaints its stored output and exit line without spawning,
 * so a finished session holds no xterm buffer while it is out of sight. One that never ran here
 * keeps the exited card.
 */
export function terminalPaneMounts<S extends { id: string; status: SessionStatus }>(
  sessions: readonly S[],
  o: { shown: ReadonlySet<string>; ran: ReadonlySet<string>; keyOf: (s: S) => string },
): TerminalPaneMount<S>[] {
  return sessions.flatMap((session): TerminalPaneMount<S>[] => {
    if (session.status === 'running') return [{ session, mode: 'run' }];
    if (session.status === 'exited' && o.shown.has(session.id) && o.ran.has(o.keyOf(session)))
      return [{ session, mode: 'view' }];
    return [];
  });
}

/** The pane keys that have mounted, kept only while some session still has that key. */
export function nextRanPaneKeys(
  ran: ReadonlySet<string>,
  mounted: readonly string[],
  current: readonly string[],
): Set<string> {
  const now = new Set(mounted);
  return new Set(current.filter((k) => now.has(k) || ran.has(k)));
}
