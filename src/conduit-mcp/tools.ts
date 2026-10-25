import {
  type AttachmentSender,
  type AttachmentSnapshot,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  textPage,
} from './attachments';
import type { ToolCallResult } from './json-rpc';
import type { MessageStore } from './store';
import {
  type AttachmentRecord,
  type Handle,
  HUMAN_HANDLE,
  type InboxMessageOut,
  type ListSessionsOutput,
  type MessageKind,
  type MessageRecord,
  type Presence,
  type Priority,
  type ReadAttachmentOutput,
  type ReadInboxOutput,
  type Result,
  type SendMessageOutput,
  type StoredMessage,
  type ToolError,
  type ToolErrorCode,
  toolError,
} from './types';

/** sessionId null ⇔ HUMAN_HANDLE */
export interface Caller {
  handle: Handle;
  sessionId: string | null;
}
export interface DirectoryEntry {
  handle: Handle;
  sessionId: string;
  label: string;
  agent: string;
  project: string | null;
  home: string;
  roots: string[];
  presence: Presence;
  messaging: 'connected' | 'unavailable';
}
export interface ToolDeps {
  store: MessageStore;
  directory(): DirectoryEntry[];
  messagingOn(): boolean;
  now(): Date;
  /** 'm_' / 't_' + 16 base32 chars */
  newId(prefix: 'm' | 't'): string;
  snapshot(sender: AttachmentSender, path: string): Promise<Result<AttachmentSnapshot>>;
  onStored(msg: MessageRecord): void;
  onThreadLimit(threadId: string, by: Handle): void;
  warn(message: string, data: Record<string, unknown>): void;
}
export interface ToolHandlers {
  listSessions(caller: Caller): Result<ListSessionsOutput>;
  sendMessage(caller: Caller, args: unknown): Promise<Result<SendMessageOutput>>;
  readInbox(caller: Caller, args: unknown): Promise<Result<ReadInboxOutput>>;
  readAttachment(caller: Caller, args: unknown): Promise<Result<ReadAttachmentOutput>>;
}

export const RATE_LIMIT_PER_MIN = 60;
export const THREAD_AGENT_LIMIT = 20;
export const MAX_BODY_BYTES = 32 * 1024;
const MAX_RECIPIENTS = 10;
const MAX_SUBJECT_CHARS = 200;
const RATE_WINDOW_MS = 60_000;
const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT = 50;
const PRIORITIES: readonly Priority[] = ['fyi', 'normal', 'urgent'];
const KINDS: readonly MessageKind[] = ['inform', 'request', 'question', 'done'];
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Provenance framing: docs/specs/2026-10-25-conduit-mcp-server.md §3.2. */
export function frameBody(from: Handle, messageId: string, body: string): string {
  const who =
    from === HUMAN_HANDLE ? 'the human via Conduit' : `session ${from} (an agent, not the user)`;
  return `[conduit message ${messageId} from ${who}]\n${body}\n[end of conduit message ${messageId}]`;
}

type Fail = { ok: false; error: ToolError };
const fail = (code: ToolErrorCode, message: string): Fail => ({
  ok: false,
  error: toolError(code, message),
});
const invalid = (message: string) => fail('invalid_argument', message);
const MESSAGING_OFF = () => fail('messaging_off', 'Conduit messaging is turned off');

type Args = Record<string, unknown>;

/** Accepts only the declared keys, so a smuggled `from` is refused rather than ignored. */
function argsObject(args: unknown, allowed: readonly string[]): Args | Fail {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return invalid('arguments must be an object');
  }
  const extra = Object.keys(args).find((k) => !allowed.includes(k));
  return extra === undefined ? (args as Args) : invalid(`unknown argument: ${extra}`);
}
const isFail = (v: unknown): v is Fail =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

const optString = (a: Args, k: string) => a[k] === undefined || typeof a[k] === 'string';
const optEnum = (a: Args, k: string, values: readonly string[]) =>
  a[k] === undefined || (typeof a[k] === 'string' && values.includes(a[k] as string));

interface SendArgs {
  to: string[];
  body: string;
  subject: string;
  priority: Priority;
  kind: MessageKind;
  threadId: string | undefined;
  paths: string[];
}

function parseSendArgs(raw: unknown): SendArgs | Fail {
  const a = argsObject(raw, [
    'to',
    'body',
    'subject',
    'priority',
    'kind',
    'thread_id',
    'attachments',
  ]);
  if (isFail(a)) return a;
  const to = a.to;
  if (!Array.isArray(to) || to.length === 0 || !to.every((h) => typeof h === 'string')) {
    return invalid('to must be a non-empty array of handles');
  }
  if (typeof a.body !== 'string') return invalid('body must be a string');
  if (!optString(a, 'subject') || !optString(a, 'thread_id')) {
    return invalid('subject and thread_id must be strings');
  }
  if (!optEnum(a, 'priority', PRIORITIES)) return invalid('priority must be fyi|normal|urgent');
  if (!optEnum(a, 'kind', KINDS)) return invalid('kind must be inform|request|question|done');
  const atts = a.attachments ?? [];
  if (!Array.isArray(atts)) return invalid('attachments must be an array');
  const paths: string[] = [];
  for (const att of atts) {
    const o = argsObject(att, ['path']);
    if (isFail(o)) return o;
    if (typeof o.path !== 'string') return invalid('attachment path must be a string');
    paths.push(o.path);
  }
  return {
    to,
    body: a.body,
    subject: (a.subject as string | undefined) ?? '',
    priority: (a.priority as Priority | undefined) ?? 'normal',
    kind: (a.kind as MessageKind | undefined) ?? 'inform',
    threadId: a.thread_id as string | undefined,
    paths,
  };
}

const isParticipant = (m: StoredMessage, h: Handle) => m.from === h || m.to.includes(h);

function inboxOut(m: StoredMessage): InboxMessageOut {
  return {
    message_id: m.messageId,
    thread_id: m.threadId,
    from: m.from,
    to: [...m.to],
    subject: m.subject,
    kind: m.kind,
    priority: m.priority,
    sent_at: m.sentAt,
    body: frameBody(m.from, m.messageId, m.body),
    attachments: m.attachments.map((x) => ({
      attachment_id: x.attachmentId,
      name: x.name,
      mime: x.mime,
      bytes: x.bytes,
    })),
  };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  const sendTimes = new Map<Handle, number[]>();

  function recentSends(h: Handle, now: number): number[] {
    const kept = (sendTimes.get(h) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    sendTimes.set(h, kept);
    return kept;
  }

  // Check order is fixed by the plan (Contracts, tools.ts "Order of sendMessage checks").
  async function sendMessage(caller: Caller, raw: unknown): Promise<Result<SendMessageOutput>> {
    if (!deps.messagingOn()) return MESSAGING_OFF();
    const a = parseSendArgs(raw);
    if (isFail(a)) return a;
    if (a.to.length > MAX_RECIPIENTS)
      return fail('too_many', `at most ${MAX_RECIPIENTS} recipients`);
    if (a.paths.length > MAX_ATTACHMENTS) {
      return fail('too_many', `at most ${MAX_ATTACHMENTS} attachments`);
    }
    if (utf8Bytes(a.body) > MAX_BODY_BYTES) return fail('too_large', 'body is over 32 KB');
    if (a.subject.length > MAX_SUBJECT_CHARS) return fail('too_large', 'subject is over 200 chars');

    const human = caller.handle === HUMAN_HANDLE;
    const now = deps.now();
    if (!human && recentSends(caller.handle, now.getTime()).length >= RATE_LIMIT_PER_MIN) {
      return fail('rate_limited', `more than ${RATE_LIMIT_PER_MIN} sends in a minute`);
    }
    // The human sees every thread, so may reply in any (plan Decisions: UI skips participation).
    if (
      a.threadId !== undefined &&
      !human &&
      !deps.store.participants(a.threadId).has(caller.handle)
    ) {
      return fail('not_found', `thread ${a.threadId} not found`);
    }
    if (
      a.threadId !== undefined &&
      !human &&
      deps.store.agentCountSinceHuman(a.threadId) >= THREAD_AGENT_LIMIT
    ) {
      deps.onThreadLimit(a.threadId, caller.handle);
      return fail('thread_limit', `thread paused after ${THREAD_AGENT_LIMIT} agent messages`);
    }

    const directory = deps.directory();
    const known = new Set(directory.map((e) => e.handle));
    const recipients: SendMessageOutput['recipients'] = [];
    for (const h of new Set(a.to)) {
      if (h === caller.handle)
        recipients.push({ handle: h, status: 'refused', reason: 'self_target' });
      else if (h === HUMAN_HANDLE || known.has(h)) recipients.push({ handle: h, status: 'queued' });
      else recipients.push({ handle: h, status: 'refused', reason: 'unknown_handle' });
    }
    const queued = recipients.filter((r) => r.status === 'queued').map((r) => r.handle);
    if (queued.length === 0) {
      const first = recipients[0];
      return fail(first.reason ?? 'unknown_handle', `no deliverable recipient (${first.handle})`);
    }

    const snapshots: AttachmentSnapshot[] = [];
    if (a.paths.length > 0) {
      if (human) return invalid('attachments from you are not supported yet');
      const self = directory.find((e) => e.handle === caller.handle);
      if (!self) return fail('not_in_session', `${caller.handle} is not a Conduit session`);
      let total = 0;
      for (const p of a.paths) {
        const s = await deps.snapshot({ home: self.home, roots: self.roots }, p);
        if (!s.ok) return s;
        total += s.value.data.byteLength;
        if (total > MAX_MESSAGE_ATTACHMENT_BYTES)
          return fail('too_large', 'attachments over 25 MB');
        snapshots.push(s.value);
      }
    }

    const attachments: AttachmentRecord[] = snapshots.map((s, i) => ({
      attachmentId: `a${i + 1}`,
      name: s.name,
      mime: s.mime,
      bytes: s.data.byteLength,
      sha256: s.sha256,
    }));
    const blobs = new Map(snapshots.map((s) => [s.sha256, { sha256: s.sha256, data: s.data }]));
    const msg: MessageRecord = {
      messageId: deps.newId('m'),
      threadId: a.threadId ?? deps.newId('t'),
      from: caller.handle,
      to: queued,
      subject: a.subject,
      kind: a.kind,
      priority: a.priority,
      sentAt: now.toISOString(),
      body: a.body,
      attachments,
    };
    const stored = await deps.store.append(msg, [...blobs.values()]);
    if (!stored.ok) return stored;
    if (!human) recentSends(caller.handle, now.getTime()).push(now.getTime());
    deps.onStored(msg);
    return {
      ok: true,
      value: { message_id: msg.messageId, thread_id: msg.threadId, recipients },
    };
  }

  async function readInbox(caller: Caller, raw: unknown): Promise<Result<ReadInboxOutput>> {
    if (!deps.messagingOn()) return MESSAGING_OFF();
    const a = argsObject(raw, ['unread_only', 'thread_id', 'limit']);
    if (isFail(a)) return a;
    if (a.unread_only !== undefined && typeof a.unread_only !== 'boolean') {
      return invalid('unread_only must be a boolean');
    }
    if (!optString(a, 'thread_id')) return invalid('thread_id must be a string');
    if (a.limit !== undefined && (typeof a.limit !== 'number' || !Number.isFinite(a.limit))) {
      return invalid('limit must be a number');
    }
    const threadId = a.thread_id as string | undefined;
    if (
      threadId !== undefined &&
      !deps.store.thread(threadId).some((m) => isParticipant(m, caller.handle))
    ) {
      return fail('not_found', `thread ${threadId} not found`);
    }
    const limit = Math.min(
      INBOX_MAX_LIMIT,
      Math.max(1, Math.floor((a.limit as number | undefined) ?? INBOX_DEFAULT_LIMIT)),
    );
    const { messages, remaining } = deps.store.inbox(caller.handle, {
      unreadOnly: (a.unread_only as boolean | undefined) ?? true,
      threadId,
      limit,
    });
    const out = messages.map(inboxOut);
    // The messages go back even when a mark fails: an unmarked one is simply returned again,
    // while failing the call would hide the ones already marked read.
    for (const m of messages) {
      const r = m.recipients[caller.handle];
      if (!r || r.status === 'read' || r.status === 'expired') continue;
      const marked = await deps.store.setStatus(m.messageId, caller.handle, 'read');
      if (!marked.ok) {
        deps.warn('read_inbox: mark read failed', {
          messageId: m.messageId,
          code: marked.error.code,
        });
      }
    }
    return { ok: true, value: { messages: out, remaining } };
  }

  async function readAttachment(
    caller: Caller,
    raw: unknown,
  ): Promise<Result<ReadAttachmentOutput>> {
    if (!deps.messagingOn()) return MESSAGING_OFF();
    const a = argsObject(raw, ['message_id', 'attachment_id', 'offset']);
    if (isFail(a)) return a;
    if (typeof a.message_id !== 'string' || typeof a.attachment_id !== 'string') {
      return invalid('message_id and attachment_id must be strings');
    }
    const offset = a.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      return invalid('offset must be an integer ≥ 0');
    }
    const m = deps.store.get(a.message_id);
    if (!m || !isParticipant(m, caller.handle)) return fail('not_found', 'message not found');
    const att = m.attachments.find((x) => x.attachmentId === a.attachment_id);
    if (!att || m.expired) return fail('not_found', 'attachment not found');
    let data: Uint8Array | undefined;
    try {
      data = await deps.store.readBlob(att.sha256);
    } catch (e) {
      return fail('store_unavailable', `attachment unreadable: ${messageOf(e)}`);
    }
    if (!data) return fail('not_found', 'attachment not found');
    const meta = {
      attachment_id: att.attachmentId,
      name: att.name,
      mime: att.mime,
      bytes: att.bytes,
    };
    if (IMAGE_MIMES.has(att.mime) && data.byteLength <= MAX_IMAGE_BYTES) {
      return {
        ok: true,
        value: { kind: 'image', ...meta, base64: Buffer.from(data).toString('base64') },
      };
    }
    if (att.mime.startsWith('text/')) {
      const page = textPage(data, offset);
      return {
        ok: true,
        value: { kind: 'text', ...meta, offset, next_offset: page.nextOffset, text: page.text },
      };
    }
    return fail(
      'unsupported_media',
      `${att.name} (${att.mime}, ${att.bytes} bytes) is not readable as text or an image`,
    );
  }

  return {
    listSessions(caller) {
      if (!deps.messagingOn()) return MESSAGING_OFF();
      return {
        ok: true,
        value: {
          sessions: deps.directory().map((e) => ({
            handle: e.handle,
            label: e.label,
            agent: e.agent,
            project: e.project,
            roots: [e.home, ...e.roots],
            presence: e.presence,
            messaging: e.messaging,
            self: e.handle === caller.handle,
          })),
          human: { handle: HUMAN_HANDLE },
        },
      };
    },
    sendMessage,
    readInbox,
    readAttachment,
  };
}

function isImageOutput(v: unknown): v is Extract<ReadAttachmentOutput, { kind: 'image' }> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { kind?: unknown; base64?: unknown };
  return o.kind === 'image' && typeof o.base64 === 'string';
}

export function toToolCallResult(r: Result<unknown>): ToolCallResult {
  if (!r.ok) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: r.error }) }], isError: true };
  }
  if (isImageOutput(r.value)) {
    const { base64, ...meta } = r.value;
    return {
      content: [
        { type: 'image', data: base64, mimeType: meta.mime },
        { type: 'text', text: JSON.stringify(meta) },
      ],
      structuredContent: meta,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r.value) }], structuredContent: r.value };
}
