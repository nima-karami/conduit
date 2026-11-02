import type { AttentionEntry } from './attention';

export interface AttentionRoutes {
  focusAsk(): void;
  openThread(threadId: string): void;
  focusSession(sessionId: string): void;
}

/** Where activating a need-you entry lands: an ask focuses its card, never the caller's
 *  session (tool-policy spec §2.4); a message opens its thread; a session is selected. Pure. */
export function routeAttention(entry: AttentionEntry, to: AttentionRoutes): void {
  if (entry.kind === 'ask') to.focusAsk();
  else if (entry.kind === 'message' && entry.threadId) to.openThread(entry.threadId);
  else if (entry.sessionId) to.focusSession(entry.sessionId);
}
