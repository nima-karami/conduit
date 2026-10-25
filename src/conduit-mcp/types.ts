// Node-free: the renderer imports these wire types (plan ruling 8).

export type Handle = string;
export const HUMAN_HANDLE = 'you';
export type Priority = 'fyi' | 'normal' | 'urgent';
export type MessageKind = 'inform' | 'request' | 'question' | 'done';
export type RecipientStatus = 'queued' | 'noticed' | 'read' | 'undelivered' | 'expired';
export type ToolErrorCode =
  | 'not_in_session'
  | 'unknown_handle'
  | 'self_target'
  | 'too_large'
  | 'too_many'
  | 'path_outside_roots'
  | 'path_unreadable'
  | 'not_found'
  | 'unsupported_media'
  | 'rate_limited'
  | 'thread_limit'
  | 'store_unavailable'
  | 'messaging_off'
  | 'host_unavailable'
  | 'invalid_argument';
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: ToolError };

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set([
  'rate_limited',
  'store_unavailable',
  'host_unavailable',
]);

export function toolError(code: ToolErrorCode, message: string): ToolError {
  return { code, message, retryable: RETRYABLE.has(code) };
}

export interface AttachmentRecord {
  attachmentId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}
export interface MessageRecord {
  messageId: string;
  threadId: string;
  from: Handle;
  to: Handle[];
  subject: string;
  kind: MessageKind;
  priority: Priority;
  /** ISO-8601 UTC */
  sentAt: string;
  body: string;
  attachments: AttachmentRecord[];
}
export interface RecipientState {
  status: RecipientStatus;
  noticeCount: number;
  updatedAt: string;
}
export interface StoredMessage extends MessageRecord {
  recipients: Record<Handle, RecipientState>;
  /** Tombstone: body '' and blobs unref'd. */
  expired: boolean;
}
export type LogRecord =
  | { v: 1; t: 'msg'; msg: MessageRecord }
  | {
      v: 1;
      t: 'rcpt';
      messageId: string;
      handle: Handle;
      status: 'noticed' | 'read' | 'undelivered';
      at: string;
    }
  | { v: 1; t: 'allow'; threadId: string; at: string }
  | { v: 1; t: 'expire'; messageId: string; at: string };
export interface ThreadSummary {
  threadId: string;
  subject: string;
  firstLine: string;
  participants: Handle[];
  topPriority: Priority;
  lastAt: string;
  messageCount: number;
  /** Recipients with ≥1 unread non-expired message. */
  unreadFor: Handle[];
}

export type ScreenVerdict = 'blocking' | 'notice-echoed' | 'empty-input' | 'unknown';
export type GateClosedReason =
  | 'off'
  | 'paused'
  | 'not-running'
  | 'settling'
  | 'no-connection'
  | 'busy'
  | 'quiet'
  | 'blocking-prompt'
  | 'no-empty-input'
  | 'draft'
  | 'spacing'
  | 'no-echo';

export type Presence = 'busy' | 'idle' | 'exited';
export interface ListSessionsOutput {
  sessions: Array<{
    handle: Handle;
    label: string;
    agent: string;
    project: string | null;
    roots: string[];
    presence: Presence;
    messaging: 'connected' | 'unavailable';
    self: boolean;
  }>;
  human: { handle: 'you' };
}
export interface SendMessageOutput {
  message_id: string;
  thread_id: string;
  recipients: Array<{ handle: Handle; status: 'queued' | 'refused'; reason?: ToolErrorCode }>;
}
export interface InboxMessageOut {
  message_id: string;
  thread_id: string;
  from: Handle;
  to: Handle[];
  subject: string;
  kind: MessageKind;
  priority: Priority;
  sent_at: string;
  /** Framed: see tools.ts frameBody. */
  body: string;
  attachments: Array<{ attachment_id: string; name: string; mime: string; bytes: number }>;
}
export interface ReadInboxOutput {
  messages: InboxMessageOut[];
  remaining: number;
}
export type ReadAttachmentOutput =
  | {
      kind: 'text';
      attachment_id: string;
      name: string;
      mime: string;
      bytes: number;
      offset: number;
      next_offset: number | null;
      text: string;
    }
  | {
      kind: 'image';
      attachment_id: string;
      name: string;
      mime: string;
      bytes: number;
      base64: string;
    };

export type McpUnavailableReason =
  | 'cmd-metachar'
  | 'unquotable-path'
  | 'messaging-off'
  | 'endpoint-down';
export type McpAttentionReason =
  | 'urgent-waiting'
  | 'message-to-you'
  | 'thread-paused'
  | 'unread-after-renotice'
  | 'unsent-notice';
export interface McpAttentionItem {
  /** `${reason}:${handle}:${messageId ?? threadId ?? ''}` */
  id: string;
  reason: McpAttentionReason;
  handle: Handle;
  sessionId: string | null;
  threadId: string | null;
  messageId: string | null;
  at: string;
}
