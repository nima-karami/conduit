// Node-free: the renderer imports these wire types (plan ruling 8).

export type Handle = string;
export const HUMAN_HANDLE = 'you';
export type Priority = 'fyi' | 'normal' | 'urgent';
export type MessageKind = 'inform' | 'request' | 'question' | 'done';
/** Agent messages per thread before it pauses for the human (spec §2 loop guard). */
export const THREAD_AGENT_LIMIT = 20;
export type RecipientStatus = 'queued' | 'noticed' | 'read' | 'undelivered' | 'expired';
export type ToolErrorCode =
  | 'not_in_session'
  | 'unknown_session'
  | 'not_messageable'
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
  | 'tool_disabled'
  | 'unknown_agent'
  | 'path_missing'
  | 'not_a_directory'
  | 'not_a_file'
  | 'invalid_args'
  | 'command_not_found'
  | 'brief_unavailable'
  | 'spawn_unconfirmed'
  | 'server_stopping'
  | 'open_failed'
  | 'window_not_ready'
  | 'caller_not_visible'
  | 'denied'
  | 'approval_timeout'
  | 'cancelled'
  | 'session_exited'
  | 'session_restarting'
  | 'out_of_reach'
  | 'move_not_allowed'
  | 'bad_ref'
  | 'bad_url'
  | 'not_a_repo'
  | 'attach_refused'
  | 'unsaved_changes'
  | 'ui_timeout'
  | 'ui_unavailable';
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  sessionId?: string;
  /** Set when a session was opened but the call failed after it: the handle it holds. */
  handle?: Handle;
  /** One sentence on what the caller does next (spec flexible-agent-contracts §4.7). */
  hint?: string;
  /** The values the caller may retry with, at most MAX_VALID_IDS. */
  valid?: string[];
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: ToolError };

export const MAX_VALID_IDS = 30;

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set([
  'rate_limited',
  'store_unavailable',
  'host_unavailable',
  'window_not_ready',
  'server_stopping',
  'session_restarting',
]);

export interface ToolErrorDetail {
  hint?: string;
  valid?: readonly string[];
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  sessionId?: string,
  detail?: ToolErrorDetail,
): ToolError {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(detail?.hint === undefined ? {} : { hint: detail.hint }),
    ...(detail?.valid === undefined ? {} : { valid: detail.valid.slice(0, MAX_VALID_IDS) }),
  };
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
export type StoreLogRecord =
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
    session_id: string;
    label: string;
    agent: string;
    /** The opener's handle; null when the opener is not a listed session (or none opened it). */
    opened_by: Handle | null;
    project: string | null;
    home: string;
    roots: string[];
    presence: Presence;
    messaging: 'connected' | 'unavailable';
    /** What send_message accepts: an MCP adapter is defined, or a client is live. */
    messageable: boolean;
    /** "typed" when the session's adapter delivers typed notices, else the agent pulls read_inbox. */
    notices: 'typed' | 'pull';
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
  | 'endpoint-down'
  | 'cursor-not-connected'
  /** handles.json or the per-launch config could not be written. */
  | 'launch-io';
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
