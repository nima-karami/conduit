import type { SnoozeMap } from '../src/attention';
import type { McpNotConnected, McpSessionBadge } from '../src/conduit-mcp/ui-types';
import { cardMcpStatus } from './mcp-card-status';
import type { SessionMcpLink } from './session-menu';

/** The session menu's snooze inputs: offered only when there is something to silence. */
export function sessionSnoozeInput(
  session: { id: string; attentionReason?: unknown },
  hasPendingAsk: boolean,
  snoozed: SnoozeMap,
  now: number,
): { snoozable: boolean; snoozedUntil: number | undefined; now: number } {
  const until = snoozed.get(session.id);
  return {
    snoozable: session.attentionReason != null || hasPendingAsk,
    snoozedUntil: until !== undefined && until > now ? until : undefined,
    now,
  };
}

/** The menu's messaging line: the card's status, or the unavailable reason the card warns with
 *  (Cursor's reason is carried by its not-connected status instead). */
export function sessionMcpLink(
  badge: McpSessionBadge | undefined,
  notConnected: McpNotConnected | undefined,
  enabled: boolean,
): SessionMcpLink | null {
  if (enabled && badge?.unavailable && badge.unavailable !== 'cursor-not-connected')
    return { kind: 'unavailable', reason: badge.unavailable };
  return cardMcpStatus(badge, notConnected, enabled);
}
