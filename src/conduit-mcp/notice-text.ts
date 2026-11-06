import type { Handle, StoredMessage } from './types';

// Fixed ASCII with no digits and no peer text: docs/specs/archive/2026-10-25-conduit-mcp-server.md §2.
export function composeNotice(urgent: boolean): string {
  return `[conduit] New messages for you${urgent ? ' (urgent)' : ''}. Use the conduit read_inbox tool.`;
}

const BANNER_HANDLE_LIMIT = 5;

// Counts and Conduit-assigned handles only, never message text: the same rule as composeNotice,
// since a tool result is read as data too. Null when there is nothing to announce.
export function composeUnreadBanner(unnoticed: readonly StoredMessage[]): string | null {
  if (unnoticed.length === 0) return null;
  const urgent = unnoticed.filter((m) => m.priority === 'urgent').length;
  const senders: Handle[] = [...new Set(unnoticed.map((m) => m.from))];
  const shown = senders.slice(0, BANNER_HANDLE_LIMIT).join(', ');
  const rest = senders.length - BANNER_HANDLE_LIMIT;
  const more = rest > 0 ? ` and ${rest} more` : '';
  const noun = unnoticed.length === 1 ? 'message' : 'messages';
  const urgentPart = urgent > 0 ? ` (${urgent} urgent)` : '';
  return `[conduit] ${unnoticed.length} unread ${noun}${urgentPart} from ${shown}${more}. Call read_inbox.`;
}
