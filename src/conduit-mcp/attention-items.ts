import type { AttentionRaise } from './notifier';
import {
  type Handle,
  HUMAN_HANDLE,
  type McpAttentionItem,
  type McpAttentionReason,
  type RecipientStatus,
  type ThreadSummary,
} from './types';

export type AttentionEvent =
  | {
      t: 'raise';
      raise: AttentionRaise;
      sessionId: string | null;
      threadId: string | null;
      at: string;
    }
  | { t: 'thread-limit'; threadId: string; handle: Handle; at: string }
  | { t: 'status'; messageId: string; handle: Handle; status: RecipientStatus }
  /** allowMore or a you-post */
  | { t: 'thread-reset'; threadId: string }
  | { t: 'notice-submitted'; handle: Handle }
  | { t: 'renderer-input'; handle: Handle }
  | { t: 'session-gone'; handle: Handle };

/** handle null: the item belongs to a thread, not to whoever raised it. */
export function attentionItemId(
  reason: McpAttentionReason,
  handle: Handle | null,
  ref: string | null,
): string {
  return `${reason}:${handle ?? ''}:${ref ?? ''}`;
}

/** The id is the identity, so a repeated raise is a no-op: each reason fires once. */
function add(items: readonly McpAttentionItem[], item: McpAttentionItem): McpAttentionItem[] {
  return items.some((i) => i.id === item.id) ? [...items] : [...items, item];
}

export function reduceAttention(
  items: readonly McpAttentionItem[],
  e: AttentionEvent,
): McpAttentionItem[] {
  switch (e.t) {
    case 'raise': {
      const r = e.raise;
      const messageId = r.kind === 'unsent-notice' ? null : r.messageId;
      return add(items, {
        id: attentionItemId(r.kind, r.handle, messageId ?? e.threadId),
        reason: r.kind,
        handle: r.handle,
        sessionId: e.sessionId,
        threadId: e.threadId,
        messageId,
        at: e.at,
      });
    }
    case 'thread-limit':
      return add(items, {
        id: attentionItemId('thread-paused', null, e.threadId),
        reason: 'thread-paused',
        handle: e.handle,
        sessionId: null,
        threadId: e.threadId,
        messageId: null,
        at: e.at,
      });
    case 'status': {
      const clears: McpAttentionReason[] =
        e.status === 'read'
          ? ['urgent-waiting', 'unread-after-renotice']
          : e.status === 'noticed'
            ? ['urgent-waiting']
            : [];
      return items.filter(
        (i) => !(i.messageId === e.messageId && i.handle === e.handle && clears.includes(i.reason)),
      );
    }
    case 'thread-reset':
      return items.filter((i) => !(i.reason === 'thread-paused' && i.threadId === e.threadId));
    case 'notice-submitted':
    case 'renderer-input':
      return items.filter((i) => !(i.reason === 'unsent-notice' && i.handle === e.handle));
    case 'session-gone':
      return items.filter((i) => i.reason === 'thread-paused' || i.handle !== e.handle);
  }
}

export function youAttention(threads: readonly ThreadSummary[], now: string): McpAttentionItem[] {
  return threads
    .filter((t) => t.unreadFor.includes(HUMAN_HANDLE))
    .map((t) => ({
      id: attentionItemId('message-to-you', HUMAN_HANDLE, t.threadId),
      reason: 'message-to-you',
      handle: HUMAN_HANDLE,
      sessionId: null,
      threadId: t.threadId,
      messageId: null,
      at: now,
    }));
}
