// Pure helpers for the Messages tab (docs/specs/2026-10-25-conduit-mcp-server.md §8–§10): what
// the list shows, what a row is called, what the tab badge and the live region say.
import { type Handle, HUMAN_HANDLE, THREAD_AGENT_LIMIT } from '../src/conduit-mcp/types';
import type { McpThreadSummary, McpUiState } from '../src/conduit-mcp/ui-types';
import type { Session } from '../src/types';
import { MCP_STR } from './conduit-mcp-strings';

export interface ThreadFilter {
  unreadOnly: boolean;
  handle: Handle | null;
}

/** Newest first; ISO-8601 UTC sorts as text. */
export function visibleThreads(
  threads: readonly McpThreadSummary[],
  f: ThreadFilter,
): McpThreadSummary[] {
  return threads
    .filter(
      (t) => (!f.unreadOnly || t.unreadForYou) && (!f.handle || t.participants.includes(f.handle)),
    )
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

export function threadTitle(t: McpThreadSummary): string {
  return t.subject || t.firstLine || MCP_STR.noSubject;
}

/** Unread and priority are in the name, never colour alone (§9, §10). */
export function threadAccessibleName(t: McpThreadSummary): string {
  const parts = [threadTitle(t), t.participants.join(', ')];
  if (t.unreadForYou) parts.push('unread');
  if (t.topPriority === 'urgent') parts.push('urgent');
  if (t.paused) parts.push(MCP_STR.paused(THREAD_AGENT_LIMIT).toLowerCase());
  return parts.join(', ');
}

/**
 * Messages that are news to the human since the previous broadcast: every message of a thread
 * that is new, plus growth in a thread that is unread for you. The first state is the restore,
 * not news.
 */
export function newMessageCount(prev: McpUiState | null, next: McpUiState): number {
  if (!prev) return 0;
  const before = new Map(prev.threads.map((t) => [t.threadId, t]));
  let n = 0;
  for (const t of next.threads) {
    const was = before.get(t.threadId);
    if (!was) n += t.messageCount;
    else if (t.unreadForYou && t.messageCount > was.messageCount) {
      n += t.messageCount - was.messageCount;
    }
  }
  return n;
}

export function tabBadge(state: McpUiState): { count: number; urgent: boolean } | null {
  if (state.youUnread <= 0) return null;
  return { count: state.youUnread, urgent: state.youUrgent > 0 };
}

/** Sessions the human can write to: those with a handle, in rail order. */
export function composeTargets(
  sessions: readonly Session[],
  state: McpUiState,
): Array<{ handle: Handle; label: string }> {
  const out: Array<{ handle: Handle; label: string }> = [];
  for (const s of sessions) {
    const handle = state.sessions[s.id]?.handle;
    if (!handle || handle === HUMAN_HANDLE) continue;
    out.push({ handle, label: s.name });
  }
  return out;
}
