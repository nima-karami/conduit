import { allocateHandle, type HandleCounters } from './handles';
import type { Handle } from './types';

export interface HandleAssignment {
  handle: Handle;
  counters: HandleCounters;
  /** true ⇒ the host writes handles.json before Session.mcpHandle (plan ruling 10). */
  allocated: boolean;
}

export function assignHandle(i: {
  current: Handle | undefined;
  prefix: string;
  takenByOthers: ReadonlySet<Handle>;
  counters: HandleCounters;
}): HandleAssignment {
  if (i.current !== undefined && !i.takenByOthers.has(i.current)) {
    return { handle: i.current, counters: i.counters, allocated: false };
  }
  // An unreadable handles.json parses to {}; skipping held numbers keeps two sessions apart.
  let next = allocateHandle(i.counters, i.prefix);
  while (i.takenByOthers.has(next.handle)) next = allocateHandle(next.counters, i.prefix);
  return { ...next, allocated: true };
}

export interface SessionRegistry {
  /** Replaces any previous token for the session. */
  mint(sessionId: string, token: string): void;
  /** The token stops resolving; live connections stay listed until the host closes them. */
  revoke(sessionId: string): void;
  resolve(token: string | null): string | null;
  /** After a successful initialize. */
  connect(connId: number, sessionId: string): void;
  disconnect(connId: number): void;
  isLive(sessionId: string): boolean;
  connectionsOf(sessionId: string): number[];
}

export function createSessionRegistry(): SessionRegistry {
  const sessionOfToken = new Map<string, string>();
  const tokenOfSession = new Map<string, string>();
  const sessionOfConn = new Map<number, string>();

  const revoke = (sessionId: string) => {
    const old = tokenOfSession.get(sessionId);
    if (old !== undefined) sessionOfToken.delete(old);
    tokenOfSession.delete(sessionId);
  };
  const connectionsOf = (sessionId: string) =>
    [...sessionOfConn]
      .filter(([, s]) => s === sessionId)
      .map(([c]) => c)
      .sort((a, b) => a - b);

  return {
    mint(sessionId, token) {
      revoke(sessionId);
      sessionOfToken.set(token, sessionId);
      tokenOfSession.set(sessionId, token);
    },
    revoke,
    resolve: (token) => (token === null ? null : (sessionOfToken.get(token) ?? null)),
    connect(connId, sessionId) {
      sessionOfConn.set(connId, sessionId);
    },
    disconnect(connId) {
      sessionOfConn.delete(connId);
    },
    isLive: (sessionId) => connectionsOf(sessionId).length > 0,
    connectionsOf,
  };
}
