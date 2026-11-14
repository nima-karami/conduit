import type { MessageKind, Presence, Priority } from '../conduit-mcp/types';
import type { SessionAttentionFacts } from '../types';
import type { Capabilities, Capability } from './remote-principal';

export type { Capabilities, Capability } from './remote-principal';

// see docs/specs/2026-11-14-conduit-network.md — wire version; a major mismatch is `incompatible`
export const LINK_PROTOCOL = { major: 1, minor: 0 } as const;
export const LINK_FEATURES = ['messaging', 'monitor', 'drive', 'view'] as const;
export type LinkFeature = (typeof LINK_FEATURES)[number];
export const LINK_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const LINK_PING_MS = 5_000;
export const LINK_DEGRADED_MS = 10_000;
export const LINK_DOWN_MS = 20_000;
export const PAIRING_WINDOW_MS = 10 * 60_000;
export const PAIRING_WARN_MS = 60_000;
// see docs/plans/2026-11-14-conduit-network-machinery.plan.md §Contracts
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_NETWORK_PORT = 47391;

export const OWN_DEFAULT_CAPABILITIES: Capabilities = {
  messaging: true,
  monitor: true,
  drive: false,
};
export type LinkState =
  | 'connecting'
  | 'up'
  | 'degraded'
  | 'down'
  | 'incompatible'
  | 'identity-changed'
  | 'revoked';

export interface HelloFrame {
  t: 'hello';
  protocol: { major: number; minor: number };
  machineId: string;
  /** base64 raw */
  serverKey: string;
  ownerKey: string | null;
  selfName: string;
  features: LinkFeature[];
  /** what the sender enables on this link */
  capabilities: Capabilities;
}

export type LinkFrame =
  | HelloFrame
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'bye'; reason: 'duplicate' | 'revoked' | 'incompatible' | 'shutdown' }
  | { t: 'revoked' }
  | { t: 'caps'; capabilities: Capabilities }
  | { t: 'msg'; message: WireMessage }
  | { t: 'ack'; messageId: string; recipients: WireRecipientOutcome[] }
  | { t: 'receipt'; messageId: string; handle: string; status: 'noticed' | 'read' | 'undelivered' }
  | { t: 'snapshot'; snapshot: MonitorSnapshot }
  | { t: 'view.open'; viewId: string; sessionId: string }
  | {
      t: 'view.opened';
      viewId: string;
      /** base64 */
      firstPaint: string;
      size: { cols: number; rows: number };
      windowsPty: { backend: 'conpty'; buildNumber: number } | null;
    }
  /** base64 */
  | { t: 'view.data'; viewId: string; data: string }
  | { t: 'view.size'; viewId: string; size: { cols: number; rows: number } }
  | {
      t: 'view.end';
      viewId: string;
      reason: 'exited' | 'closed' | 'refused' | 'resync';
      exitCode: number | null;
    }
  | { t: 'view.close'; viewId: string }
  | { t: 'drive.input'; sessionId: string; data: string }
  | { t: 'drive.resize'; sessionId: string; cols: number; rows: number }
  | { t: 'drive.open'; requestId: string; agentId: string; folder: string }
  | { t: 'drive.close'; requestId: string; sessionId: string }
  | {
      t: 'drive.result';
      requestId: string;
      ok: boolean;
      sessionId: string | null;
      error: string | null;
    };

export interface WireMessage {
  messageId: string;
  threadId: string;
  /** handle on origin */
  from: string;
  /** local handles on the receiver */
  to: string[];
  subject: string;
  kind: MessageKind;
  priority: Priority;
  sentAt: string;
  body: string;
  attachments: { name: string; mime: string; data: string /* base64 */ }[];
}

export interface WireRecipientOutcome {
  handle: string;
  status: 'delivered' | 'refused';
  reason:
    | 'unknown_session'
    | 'not_messageable'
    | 'messaging_off'
    | 'capability_off'
    | 'thread_limit'
    | 'rate_limited'
    | null;
}

export interface MonitorSession {
  sessionId: string;
  handle: string | null;
  label: string;
  agent: string;
  presence: Presence;
  messaging: 'connected' | 'unavailable';
  messageable: boolean;
  notices: 'typed' | 'pull';
  home: string;
  roots: string[];
  attention: SessionAttentionFacts;
  completions: number;
  limit: { state: string; resumeAt: string | null } | null;
  status: 'running' | 'exited' | 'stale';
}

export interface MonitorSnapshot {
  seq: number;
  sessions: MonitorSession[];
  requests: {
    requestId: string;
    type: string;
    summary: string;
    sessionHandle: string | null;
    createdAt: string;
  }[];
  youUnread: number;
  ownerPresence: 'here' | 'away';
  /** for drive.open */
  agents: { id: string; label: string }[];
}

/**
 * Strict validator for an incoming frame. Anything that is not exactly one of the shapes above
 * (unknown `t`, missing or ill-typed field, extra key at any level) is null, so a peer cannot
 * smuggle fields past a typed handler.
 */
export function parseLinkFrame(raw: unknown): LinkFrame | null {
  if (!isRec(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello':
      return parseHello(raw);
    case 'ping':
    case 'pong':
    case 'revoked':
      return frame(raw, raw.t, [], () => true) ? raw : null;
    case 'bye':
      return frame(raw, 'bye', ['reason'], (r) => oneOf(r.reason, BYE_REASONS)) ? raw : null;
    case 'caps':
      return frame(raw, 'caps', ['capabilities'], (r) => isCapabilities(r.capabilities))
        ? raw
        : null;
    case 'msg':
      return frame(raw, 'msg', ['message'], (r) => isWireMessage(r.message)) ? raw : null;
    case 'ack':
      return frame(
        raw,
        'ack',
        ['messageId', 'recipients'],
        (r) => str(r.messageId) && arrayOf(r.recipients, isRecipientOutcome),
      )
        ? raw
        : null;
    case 'receipt':
      return frame(
        raw,
        'receipt',
        ['messageId', 'handle', 'status'],
        (r) => str(r.messageId) && str(r.handle) && oneOf(r.status, RECEIPT_STATUSES),
      )
        ? raw
        : null;
    case 'snapshot':
      return frame(raw, 'snapshot', ['snapshot'], (r) => isSnapshot(r.snapshot)) ? raw : null;
    case 'view.open':
      return frame(
        raw,
        'view.open',
        ['viewId', 'sessionId'],
        (r) => str(r.viewId) && str(r.sessionId),
      )
        ? raw
        : null;
    case 'view.opened':
      return frame(
        raw,
        'view.opened',
        ['viewId', 'firstPaint', 'size', 'windowsPty'],
        (r) => str(r.viewId) && str(r.firstPaint) && isSize(r.size) && isWindowsPty(r.windowsPty),
      )
        ? raw
        : null;
    case 'view.data':
      return frame(raw, 'view.data', ['viewId', 'data'], (r) => str(r.viewId) && str(r.data))
        ? raw
        : null;
    case 'view.size':
      return frame(raw, 'view.size', ['viewId', 'size'], (r) => str(r.viewId) && isSize(r.size))
        ? raw
        : null;
    case 'view.end':
      return frame(
        raw,
        'view.end',
        ['viewId', 'reason', 'exitCode'],
        (r) => str(r.viewId) && oneOf(r.reason, VIEW_END_REASONS) && nullable(r.exitCode, num),
      )
        ? raw
        : null;
    case 'view.close':
      return frame(raw, 'view.close', ['viewId'], (r) => str(r.viewId)) ? raw : null;
    case 'drive.input':
      return frame(
        raw,
        'drive.input',
        ['sessionId', 'data'],
        (r) => str(r.sessionId) && str(r.data),
      )
        ? raw
        : null;
    case 'drive.resize':
      return frame(
        raw,
        'drive.resize',
        ['sessionId', 'cols', 'rows'],
        (r) => str(r.sessionId) && dim(r.cols) && dim(r.rows),
      )
        ? raw
        : null;
    case 'drive.open':
      return frame(
        raw,
        'drive.open',
        ['requestId', 'agentId', 'folder'],
        (r) => str(r.requestId) && str(r.agentId) && str(r.folder),
      )
        ? raw
        : null;
    case 'drive.close':
      return frame(
        raw,
        'drive.close',
        ['requestId', 'sessionId'],
        (r) => str(r.requestId) && str(r.sessionId),
      )
        ? raw
        : null;
    case 'drive.result':
      return frame(
        raw,
        'drive.result',
        ['requestId', 'ok', 'sessionId', 'error'],
        (r) =>
          str(r.requestId) && bool(r.ok) && nullable(r.sessionId, str) && nullable(r.error, str),
      )
        ? raw
        : null;
    default:
      return null;
  }
}

// ---- validator helpers (private) ----

type Rec = Record<string, unknown>;
type FrameOf<T extends LinkFrame['t']> = Extract<LinkFrame, { t: T }>;

const BYE_REASONS = ['duplicate', 'revoked', 'incompatible', 'shutdown'] as const;
const RECEIPT_STATUSES = ['noticed', 'read', 'undelivered'] as const;
const VIEW_END_REASONS = ['exited', 'closed', 'refused', 'resync'] as const;
const RECIPIENT_STATUSES = ['delivered', 'refused'] as const;
const RECIPIENT_REASONS = [
  'unknown_session',
  'not_messageable',
  'messaging_off',
  'capability_off',
  'thread_limit',
  'rate_limited',
] as const;
const MESSAGE_KINDS: readonly MessageKind[] = ['inform', 'request', 'question', 'done'];
const PRIORITIES: readonly Priority[] = ['fyi', 'normal', 'urgent'];
const PRESENCES: readonly Presence[] = ['busy', 'idle', 'exited'];
const ATTENTION_REASONS = ['blocked', 'bell', 'stuck'] as const;
const CAPABILITY_KEYS: readonly Capability[] = ['messaging', 'monitor', 'drive'];

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
/** Sizes and counts from a peer reach the PTY and allocations, so only positive integers pass. */
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const dim = (v: unknown): v is number => int(v) && v >= 1 && v <= 10_000;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);
const nullable = (v: unknown, check: (x: unknown) => boolean): boolean => v === null || check(v);
const arrayOf = (v: unknown, check: (x: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every(check);

/** Exactly the required keys, plus any of the optional ones, and nothing else. */
function hasKeys(
  v: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): v is Rec {
  if (!isRec(v)) return false;
  const keys = Object.keys(v);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

/** A top-level frame: its `t` plus exactly its fields, then the field checks. */
function frame<T extends LinkFrame['t']>(
  v: Rec,
  t: T,
  fields: readonly string[],
  check: (r: Rec) => boolean,
): v is Rec & FrameOf<T> {
  return v.t === t && hasKeys(v, ['t', ...fields]) && check(v);
}

/**
 * hello is the one lenient frame: a newer minor version may add fields and features, and the
 * receiver must still read the version to show `incompatible` or "doesn't support" instead of
 * dropping the connection. Unknown keys and features are ignored; every other frame stays strict.
 */
function parseHello(r: Rec): HelloFrame | null {
  const p = r.protocol;
  const caps = r.capabilities;
  const listed: unknown[] | null = Array.isArray(r.features) ? r.features : null;
  const features = listed?.filter(str) ?? null;
  const ownerKey = r.ownerKey === null ? null : str(r.ownerKey) ? r.ownerKey : undefined;
  if (
    !isRec(p) ||
    !int(p.major) ||
    !int(p.minor) ||
    !str(r.machineId) ||
    !str(r.serverKey) ||
    ownerKey === undefined ||
    !str(r.selfName) ||
    features === null ||
    features.length !== listed?.length ||
    !isRec(caps) ||
    !bool(caps.messaging) ||
    !bool(caps.monitor) ||
    !bool(caps.drive)
  )
    return null;
  return {
    t: 'hello',
    protocol: { major: p.major, minor: p.minor },
    machineId: r.machineId,
    serverKey: r.serverKey,
    ownerKey,
    selfName: r.selfName,
    features: LINK_FEATURES.filter((f) => features.includes(f)),
    capabilities: { messaging: caps.messaging, monitor: caps.monitor, drive: caps.drive },
  };
}

function isCapabilities(v: unknown): boolean {
  return hasKeys(v, CAPABILITY_KEYS) && CAPABILITY_KEYS.every((k) => bool(v[k]));
}

function isSize(v: unknown): boolean {
  return hasKeys(v, ['cols', 'rows']) && dim(v.cols) && dim(v.rows);
}

function isWindowsPty(v: unknown): boolean {
  return (
    v === null ||
    (hasKeys(v, ['backend', 'buildNumber']) && v.backend === 'conpty' && num(v.buildNumber))
  );
}

function isWireMessage(v: unknown): boolean {
  return (
    hasKeys(v, [
      'messageId',
      'threadId',
      'from',
      'to',
      'subject',
      'kind',
      'priority',
      'sentAt',
      'body',
      'attachments',
    ]) &&
    str(v.messageId) &&
    str(v.threadId) &&
    str(v.from) &&
    arrayOf(v.to, str) &&
    str(v.subject) &&
    oneOf(v.kind, MESSAGE_KINDS) &&
    oneOf(v.priority, PRIORITIES) &&
    str(v.sentAt) &&
    str(v.body) &&
    arrayOf(v.attachments, isAttachment)
  );
}

function isAttachment(v: unknown): boolean {
  return hasKeys(v, ['name', 'mime', 'data']) && str(v.name) && str(v.mime) && str(v.data);
}

function isRecipientOutcome(v: unknown): boolean {
  return (
    hasKeys(v, ['handle', 'status', 'reason']) &&
    str(v.handle) &&
    oneOf(v.status, RECIPIENT_STATUSES) &&
    nullable(v.reason, (x) => oneOf(x, RECIPIENT_REASONS))
  );
}

function isAttentionFacts(v: unknown): boolean {
  return (
    hasKeys(v, ['attentionReason', 'completions'], ['stuckReason']) &&
    nullable(v.attentionReason, (x) => oneOf(x, ATTENTION_REASONS)) &&
    num(v.completions) &&
    (v.stuckReason === undefined || str(v.stuckReason))
  );
}

function isMonitorSession(v: unknown): boolean {
  return (
    hasKeys(v, [
      'sessionId',
      'handle',
      'label',
      'agent',
      'presence',
      'messaging',
      'messageable',
      'notices',
      'home',
      'roots',
      'attention',
      'completions',
      'limit',
      'status',
    ]) &&
    str(v.sessionId) &&
    nullable(v.handle, str) &&
    str(v.label) &&
    str(v.agent) &&
    oneOf(v.presence, PRESENCES) &&
    oneOf(v.messaging, ['connected', 'unavailable'] as const) &&
    bool(v.messageable) &&
    oneOf(v.notices, ['typed', 'pull'] as const) &&
    str(v.home) &&
    arrayOf(v.roots, str) &&
    isAttentionFacts(v.attention) &&
    num(v.completions) &&
    nullable(
      v.limit,
      (x) => hasKeys(x, ['state', 'resumeAt']) && str(x.state) && nullable(x.resumeAt, str),
    ) &&
    oneOf(v.status, ['running', 'exited', 'stale'] as const)
  );
}

function isSnapshot(v: unknown): boolean {
  return (
    hasKeys(v, ['seq', 'sessions', 'requests', 'youUnread', 'ownerPresence', 'agents']) &&
    num(v.seq) &&
    arrayOf(v.sessions, isMonitorSession) &&
    arrayOf(
      v.requests,
      (x) =>
        hasKeys(x, ['requestId', 'type', 'summary', 'sessionHandle', 'createdAt']) &&
        str(x.requestId) &&
        str(x.type) &&
        str(x.summary) &&
        nullable(x.sessionHandle, str) &&
        str(x.createdAt),
    ) &&
    num(v.youUnread) &&
    oneOf(v.ownerPresence, ['here', 'away'] as const) &&
    arrayOf(v.agents, (x) => hasKeys(x, ['id', 'label']) && str(x.id) && str(x.label))
  );
}
