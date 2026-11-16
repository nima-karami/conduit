import type { MessageKind, Presence, Priority } from '../conduit-mcp/types';
import type { DirEntryDTO, FileContentDTO } from '../protocol';
import type { SessionAttentionFacts } from '../types';
import type { RemotePolicyDoc, RemotePolicySnapshot } from './remote-policy';
import type { Capabilities, Capability } from './remote-principal';

export type { Capabilities, Capability } from './remote-principal';

// see docs/specs/2026-11-14-conduit-network.md — wire version; a major mismatch is `incompatible`
// minor 1 added the hello's platform and version (spec 5.3): a peer at minor 0 omits them.
// minor 2 added the routed `call` / `call.result` frames (spec 5.3, CON-40).
// minor 3 added `request.mirror` / `request.answer` / `request.answered` (spec 5.3, CON-42).
// minor 4 added `fs.req` / `fs.res` / `fs.watch` / `fs.unwatch` / `fs.changed` (spec 5.3, CON-43).
// minor 5 added `policy.changed` / `policy.push` / `policy.pushed` / `policy.revoke` (plan
// 2026-11-16-remote-ssh-rules, Technical decisions 3).
export const LINK_PROTOCOL = { major: 1, minor: 5 } as const;
/** The lowest peer minor that serves `call` frames: a routed call to an older peer is refused, not sent. */
export const ROUTED_CALLS_MIN_MINOR = 2;
/** The lowest peer minor that serves request frames: an older peer gets no mirror and no answers. */
export const REQUEST_MIRROR_MIN_MINOR = 3;
/** The lowest peer minor that serves fs frames: a file request to an older peer is refused, not sent. */
export const FS_MIN_MINOR = 4;
export const FS_OPS = ['list', 'read', 'stat'] as const;
export type FsOp = (typeof FS_OPS)[number];
export const FS_ERROR_CODES = [
  'refused',
  'not_found',
  'too_large',
  'unavailable',
  'failed',
] as const;
export type FsErrorCode = (typeof FS_ERROR_CODES)[number];
/** One `fs.res` result; list entries never include a deny-listed name (plan CON-43 decision 3). */
export type FsResult =
  | { op: 'list'; path: string; entries: DirEntryDTO[] }
  | { op: 'read'; file: FileContentDTO }
  | { op: 'stat'; kind: 'file' | 'dir'; size: number; mtimeMs: number };
/** The lowest peer minor that serves policy frames: an older peer gets no snapshot and refuses pushes. */
export const POLICY_MIN_MINOR = 5;
export const LINK_FEATURES = ['messaging', 'monitor', 'drive', 'view'] as const;
export type LinkFeature = (typeof LINK_FEATURES)[number];
// The session tools a lead may route to a peer; anything else in a `call` is a malformed frame.
export const ROUTED_TOOLS = [
  'list_agents',
  'open_session',
  'open_terminal',
  'send_input',
  'read_screen',
  'close_session',
] as const;
export type RoutedTool = (typeof ROUTED_TOOLS)[number];
// The argument blob is re-serialized into a tool call on the far side; the cap keeps one frame
// from crowding the link. Result size is bounded by the frame limit instead.
export const CALL_ARGS_MAX_BYTES = 64 * 1024;
const CALL_ID_MAX = 64;
const HANDLE_MAX = 64;
// The mirror is bounded per frame, so a busy peer cannot push an unbounded queue into A's UI.
export const REQUEST_MIRROR_MAX = 200;
// Bodies, drafts and text answers are multi-line, so they are capped in bytes: that is what the
// frame limit and the wire actually count.
export const REQUEST_BODY_MAX_BYTES = 16 * 1024;
export const REQUEST_TITLE_MAX = 256;
export const REQUESTER_MAX = 64;
const REQUEST_ID_MAX = 64;
export const REQUEST_OPTION_LABEL_MAX = 256;
export const REQUEST_OPTION_DESCRIPTION_MAX = 1024;
const REQUEST_TIMESTAMP_MAX = 64;
const ANSWER_OUTCOME_MAX = 64;
export const ANSWER_VALUES_MAX = 8;
export const ANSWER_VALUE_MAX = 256;
export const ANSWER_REASON_MAX = 200;
const PERMISSION_TOOL_MAX = 64;
export const PERMISSION_WHY_MAX = 1024;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1024;
const ERROR_HINT_MAX = 512;
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

export type HelloOs = 'linux' | 'windows' | 'other';
export type HelloArch = 'x64' | 'arm64' | 'other';
export interface HelloPlatform {
  os: HelloOs;
  arch: HelloArch;
}

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
  /** Absent from a minor-0 peer. An ssh controller reads its os and version from these. */
  platform?: HelloPlatform;
  version?: string;
}

/** Node's platform and arch names as the hello spells them; anything else is `other`. */
export function helloPlatform(platform: string, arch: string): HelloPlatform {
  const os: HelloOs = platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : 'other';
  const cpu: HelloArch = arch === 'x64' || arch === 'arm64' ? arch : 'other';
  return { os, arch: cpu };
}

export type LinkFrame =
  | HelloFrame
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'bye'; reason: 'duplicate' | 'revoked' | 'incompatible' | 'shutdown' }
  | { t: 'revoked' }
  /** The owner private key, once, over the first authenticated link (plan decision 10). */
  | { t: 'owner'; publicKey: string; privateKey: string }
  | { t: 'owner.ack' }
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
    }
  /** Forwarded by the lead's machine; `principal.handle` is the only identity on the wire. */
  | {
      t: 'call';
      id: string;
      tool: RoutedTool;
      args: Record<string, unknown>;
      principal: { handle: string };
    }
  | { t: 'call.result'; id: string; ok: true; result: Record<string, unknown> }
  | {
      t: 'call.result';
      id: string;
      ok: false;
      error: { code: string; message: string; retryable: boolean; hint?: string };
    }
  /** A file request from A's owner, served only on an inbound ssh controller link (plan CON-43). */
  | { t: 'fs.req'; id: string; op: FsOp; sessionId: string; path: string }
  | { t: 'fs.res'; id: string; ok: true; result: FsResult }
  | { t: 'fs.res'; id: string; ok: false; error: { code: FsErrorCode; message: string } }
  /** Re-sent by A after a reconnect, never replayed; B drops a link's watches when it goes down. */
  | { t: 'fs.watch'; watchId: string; sessionId: string; path: string }
  | { t: 'fs.unwatch'; watchId: string }
  /** Changed paths under a watch; an empty list means "re-read everything under it". */
  | { t: 'fs.changed'; watchId: string; paths: string[] }
  /** B's open requests plus those that ended in the last 10 min; a newer seq replaces the old set. */
  | { t: 'request.mirror'; seq: number; requests: RequestMirror[] }
  /** A's owner answering a mirrored request on B. Never replayed: a drop is `peer_unreachable`. */
  | { t: 'request.answer'; answerId: string; requestId: string; answer: RequestAnswerBody }
  | { t: 'request.answered'; answerId: string; ok: true }
  | {
      t: 'request.answered';
      answerId: string;
      ok: false;
      error: { code: string; message: string; retryable: boolean; hint?: string };
    }
  /** Sent by the machine that owns the policy to the controllers that dialed it in. */
  | ({ t: 'policy.changed' } & RemotePolicySnapshot)
  /** `baseRev` is the revision the edit started from; a different current rev is a conflict. */
  | { t: 'policy.push'; id: string; baseRev: number; doc: RemotePolicyDoc }
  | { t: 'policy.pushed'; id: string; ok: true; rev: number }
  | {
      t: 'policy.pushed';
      id: string;
      ok: false;
      error: { code: string; message: string; retryable: boolean; hint?: string };
      current?: { rev: number; doc: RemotePolicyDoc };
    }
  | { t: 'policy.revoke'; id: string; grantId: string };

export const REQUEST_MIRROR_KINDS = [
  'confirm',
  'choose',
  'text',
  'review',
  'attend',
  'permission',
] as const;
export type RequestMirrorKind = (typeof REQUEST_MIRROR_KINDS)[number];
export const REQUEST_MIRROR_STATES = [
  'open',
  'answered',
  'expired',
  'withdrawn',
  'superseded',
  'resolved',
  'orphaned',
] as const;
export type RequestMirrorState = (typeof REQUEST_MIRROR_STATES)[number];

/**
 * A request as A renders and answers it. Plain wire types, not B's RequestView: targets, args and
 * session ids are B's private detail and never cross the link.
 */
export interface RequestMirror {
  id: string;
  kind: RequestMirrorKind;
  title: string;
  body: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  draft: string | null;
  priority: 'normal' | 'urgent';
  createdAt: string;
  expiresAt: string | null;
  /** A display string, e.g. `handle@machine`; never parsed back into an identity. */
  requester: string;
  state: RequestMirrorState;
  answer: { outcome: string; text?: string; values?: string[]; reason?: string; at: string } | null;
  permission: { tool: string; why: string; grantable: boolean } | null;
}

export interface RequestAnswerBody {
  outcome: string;
  text?: string;
  values?: string[];
  reason?: string;
  grant?: boolean;
}

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
  /**
   * Who opened it, for the peer's "opened by" view: a local opener's handle (machineId null) or a
   * remote lead's. Absent from a peer below minor 2, which never sent it.
   */
  openedBy?: MonitorOpener | null;
}

export interface MonitorOpener {
  handle: string;
  machineId: string | null;
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
    case 'owner.ack':
      return frame(raw, raw.t, [], () => true) ? raw : null;
    case 'bye':
      return frame(raw, 'bye', ['reason'], (r) => oneOf(r.reason, BYE_REASONS)) ? raw : null;
    case 'owner':
      return frame(
        raw,
        'owner',
        ['publicKey', 'privateKey'],
        (r) => str(r.publicKey) && str(r.privateKey),
      )
        ? raw
        : null;
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
    case 'call':
      return frame(
        raw,
        'call',
        ['id', 'tool', 'args', 'principal'],
        (r) =>
          isCallId(r.id) &&
          oneOf(r.tool, ROUTED_TOOLS) &&
          isCallArgs(r.args) &&
          isCallPrincipal(r.principal),
      )
        ? raw
        : null;
    case 'call.result':
      return parseCallResult(raw);
    case 'request.mirror':
      return frame(
        raw,
        'request.mirror',
        ['seq', 'requests'],
        (r) => int(r.seq) && isRequestList(r.requests),
      )
        ? raw
        : null;
    case 'request.answer':
      return frame(
        raw,
        'request.answer',
        ['answerId', 'requestId', 'answer'],
        (r) =>
          isCallId(r.answerId) &&
          isPrintableCapped(r.requestId, REQUEST_ID_MAX) &&
          isRequestAnswerBody(r.answer),
      )
        ? raw
        : null;
    case 'request.answered':
      return parseRequestAnswered(raw);
    case 'fs.req':
      return frame(
        raw,
        'fs.req',
        ['id', 'op', 'sessionId', 'path'],
        (r) =>
          isCallId(r.id) &&
          oneOf(r.op, FS_OPS) &&
          isPrintableCapped(r.sessionId, FS_SESSION_ID_MAX) &&
          isFsPath(r.path),
      )
        ? raw
        : null;
    case 'fs.res':
      return parseFsRes(raw);
    case 'fs.watch':
      return frame(
        raw,
        'fs.watch',
        ['watchId', 'sessionId', 'path'],
        (r) =>
          isCallId(r.watchId) &&
          isPrintableCapped(r.sessionId, FS_SESSION_ID_MAX) &&
          isFsPath(r.path),
      )
        ? raw
        : null;
    case 'fs.unwatch':
      return frame(raw, 'fs.unwatch', ['watchId'], (r) => isCallId(r.watchId)) ? raw : null;
    case 'fs.changed':
      return frame(
        raw,
        'fs.changed',
        ['watchId', 'paths'],
        (r) =>
          isCallId(r.watchId) &&
          Array.isArray(r.paths) &&
          r.paths.length <= FS_CHANGED_MAX &&
          r.paths.every(isFsPath),
      )
        ? raw
        : null;
    case 'policy.changed':
      return frame(
        raw,
        'policy.changed',
        ['rev', 'doc', 'grants'],
        (r) => int(r.rev) && isPolicyDoc(r.doc) && arrayOf(r.grants, isGrantView),
      )
        ? raw
        : null;
    case 'policy.push':
      return frame(
        raw,
        'policy.push',
        ['id', 'baseRev', 'doc'],
        (r) => isCallId(r.id) && int(r.baseRev) && isPolicyDoc(r.doc),
      )
        ? raw
        : null;
    case 'policy.pushed':
      return parsePolicyPushed(raw);
    case 'policy.revoke':
      return frame(
        raw,
        'policy.revoke',
        ['id', 'grantId'],
        (r) => isCallId(r.id) && isPrintableCapped(r.grantId, POLICY_ID_MAX),
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
  // A malformed platform or version is dropped, not fatal: the hello still shows the version.
  const platform = parseHelloPlatform(r.platform);
  const version = typeof r.version === 'string' && VERSION_SHAPE.test(r.version) ? r.version : null;
  return {
    t: 'hello',
    protocol: { major: p.major, minor: p.minor },
    machineId: r.machineId,
    serverKey: r.serverKey,
    ownerKey,
    selfName: r.selfName,
    features: LINK_FEATURES.filter((f) => features.includes(f)),
    capabilities: { messaging: caps.messaging, monitor: caps.monitor, drive: caps.drive },
    ...(platform === null ? {} : { platform }),
    ...(version === null ? {} : { version }),
  };
}

const VERSION_SHAPE = /^[A-Za-z0-9._+-]{1,64}$/;
const HELLO_OSES = ['linux', 'windows', 'other'] as const;
const HELLO_ARCHES = ['x64', 'arm64', 'other'] as const;
const isHelloOs = (v: unknown): v is HelloOs => HELLO_OSES.some((o) => o === v);
const isHelloArch = (v: unknown): v is HelloArch => HELLO_ARCHES.some((a) => a === v);

function parseHelloPlatform(v: unknown): HelloPlatform | null {
  if (!isRec(v) || !isHelloOs(v.os) || !isHelloArch(v.arch)) return null;
  return { os: v.os, arch: v.arch };
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

/**
 * A session handle as one machine names its own sessions ('you' included): a peer's handle is
 * shown as `handle@machine`, so one with an `@` or a space would pose as another address.
 */
export const BARE_HANDLE = /^[a-z0-9-]+$/;
const isBareHandle = (v: unknown): boolean => typeof v === 'string' && BARE_HANDLE.test(v);

const isMachineIdShape = (v: unknown): boolean =>
  typeof v === 'string' && /^m-[0-9a-f]{8}$/.test(v);

function isMonitorOpener(v: unknown): boolean {
  return (
    hasKeys(v, ['handle', 'machineId']) &&
    isBareHandle(v.handle) &&
    nullable(v.machineId, isMachineIdShape)
  );
}

function isMonitorSession(v: unknown): boolean {
  return (
    hasKeys(
      v,
      [
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
      ],
      ['openedBy'],
    ) &&
    str(v.sessionId) &&
    nullable(v.handle, isBareHandle) &&
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
    oneOf(v.status, ['running', 'exited', 'stale'] as const) &&
    (v.openedBy === undefined || nullable(v.openedBy, isMonitorOpener))
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

// Control characters are refused: these strings reach the other machine's UI and its logs.
const PRINTABLE = /^[^\p{Cc}]*$/u;
const isPrintableCapped = (v: unknown, max: number): boolean =>
  str(v) && v.length >= 1 && v.length <= max && PRINTABLE.test(v);

const isCallId = (v: unknown): boolean => isPrintableCapped(v, CALL_ID_MAX);
const POLICY_ID_MAX = 64;

function isCallArgs(v: unknown): boolean {
  return isRec(v) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= CALL_ARGS_MAX_BYTES;
}

/** The principal on the wire is a handle only; the machine id is always the link's own. */
function isCallPrincipal(v: unknown): boolean {
  return hasKeys(v, ['handle']) && isPrintableCapped(v.handle, HANDLE_MAX);
}

/** `ok` picks the variant; each variant has exactly its own field, so the other is an extra key. */
function parseCallResult(r: Rec): LinkFrame | null {
  if (!isCallId(r.id) || !bool(r.ok)) return null;
  if (r.ok)
    return frame(r, 'call.result', ['id', 'ok', 'result'], (x) => isRec(x.result)) ? r : null;
  return frame(r, 'call.result', ['id', 'ok', 'error'], (x) => isRoutedError(x.error)) ? r : null;
}

// A path names a file on the peer and reaches its file system, so it is printable and bounded; the
// serving side still confines it (src/network/fs-confine.ts) — the parser only bounds the shape.
const FS_PATH_MAX = 4096;
const FS_SESSION_ID_MAX = 64;
const FS_CHANGED_MAX = 256;
const FS_NAME_MAX = 1024;
const isFsPath = (v: unknown): boolean => isPrintableCapped(v, FS_PATH_MAX);

/** `ok` picks the variant; each variant has exactly its own field, so the other is an extra key. */
function parseFsRes(r: Rec): LinkFrame | null {
  if (!isCallId(r.id) || !bool(r.ok)) return null;
  if (r.ok)
    return frame(r, 'fs.res', ['id', 'ok', 'result'], (x) => isFsResult(x.result)) ? r : null;
  return frame(r, 'fs.res', ['id', 'ok', 'error'], (x) => isFsError(x.error)) ? r : null;
}

function isFsError(v: unknown): boolean {
  return (
    hasKeys(v, ['code', 'message']) &&
    oneOf(v.code, FS_ERROR_CODES) &&
    str(v.message) &&
    v.message.length <= ERROR_MESSAGE_MAX
  );
}

function isFsResult(v: unknown): boolean {
  if (!isRec(v)) return false;
  switch (v.op) {
    case 'list':
      return (
        hasKeys(v, ['op', 'path', 'entries']) &&
        isFsPath(v.path) &&
        arrayOf(
          v.entries,
          (e) =>
            hasKeys(e, ['name', 'kind'], ['ignored']) &&
            isPrintableCapped(e.name, FS_NAME_MAX) &&
            oneOf(e.kind, ['dir', 'file'] as const) &&
            (e.ignored === undefined || bool(e.ignored)),
        )
      );
    case 'read':
      return hasKeys(v, ['op', 'file']) && isFileContent(v.file);
    case 'stat':
      return (
        hasKeys(v, ['op', 'kind', 'size', 'mtimeMs']) &&
        oneOf(v.kind, ['file', 'dir'] as const) &&
        int(v.size) &&
        num(v.mtimeMs)
      );
    default:
      return false;
  }
}

/** FileContentDTO as B's file-service builds it (src/protocol.ts); data URLs are bounded by the frame. */
function isFileContent(v: unknown): boolean {
  return (
    hasKeys(
      v,
      ['path', 'content', 'language', 'truncated', 'binary'],
      ['error', 'image', 'pdf', 'window', 'readOnlyReason'],
    ) &&
    isFsPath(v.path) &&
    str(v.content) &&
    isPrintableCapped(v.language, 64) &&
    bool(v.truncated) &&
    bool(v.binary) &&
    (v.error === undefined || (str(v.error) && v.error.length <= ERROR_MESSAGE_MAX)) &&
    (v.image === undefined ||
      (hasKeys(v.image, ['mime', 'dataUrl', 'bytes']) &&
        isPrintableCapped(v.image.mime, 128) &&
        str(v.image.dataUrl) &&
        int(v.image.bytes))) &&
    (v.pdf === undefined ||
      (hasKeys(v.pdf, ['dataUrl', 'bytes']) && str(v.pdf.dataUrl) && int(v.pdf.bytes))) &&
    (v.window === undefined || v.window === 'tail') &&
    (v.readOnlyReason === undefined ||
      oneOf(v.readOnlyReason, ['invalid-utf8', 'mixed-eol', 'remote'] as const))
  );
}

/** `ok` picks the variant: a success carries the new rev, a failure says why and may carry the current doc. */
function parsePolicyPushed(r: Rec): LinkFrame | null {
  if (!isCallId(r.id) || !bool(r.ok)) return null;
  if (r.ok) return frame(r, 'policy.pushed', ['id', 'ok', 'rev'], (x) => int(x.rev)) ? r : null;
  return isPolicyPushedFailure(r) ? r : null;
}

function isPolicyPushedFailure(v: Rec): v is Rec & FrameOf<'policy.pushed'> {
  return (
    hasKeys(v, ['t', 'id', 'ok', 'error'], ['current']) &&
    isRoutedError(v.error) &&
    (v.current === undefined || isPolicyCurrent(v.current))
  );
}

/** Only the frame shape is checked here; the machine that owns the policy validates the doc deeply. */
function isPolicyDoc(v: unknown): boolean {
  return isRec(v) && Array.isArray(v.profiles) && Array.isArray(v.assignments);
}

function isPolicyCurrent(v: unknown): boolean {
  return hasKeys(v, ['rev', 'doc']) && int(v.rev) && isPolicyDoc(v.doc);
}

function isGrantView(v: unknown): boolean {
  return isRec(v) && isPrintableCapped(v.id, POLICY_ID_MAX);
}

/** `ok` picks the variant: a success has no error, a failure must say why. */
function parseRequestAnswered(r: Rec): LinkFrame | null {
  if (!isCallId(r.answerId) || !bool(r.ok)) return null;
  if (r.ok) return frame(r, 'request.answered', ['answerId', 'ok'], () => true) ? r : null;
  return frame(r, 'request.answered', ['answerId', 'ok', 'error'], (x) => isRoutedError(x.error))
    ? r
    : null;
}

/** Multi-line text keeps newlines and tabs; every other control character is refused. */
const MULTILINE_TEXT = /^(?:[^\p{Cc}]|[\n\r\t])*$/u;
const isMultilineCapped = (v: unknown, maxBytes: number): boolean =>
  str(v) && MULTILINE_TEXT.test(v) && new TextEncoder().encode(v).byteLength <= maxBytes;

function isRequestList(v: unknown): boolean {
  return Array.isArray(v) && v.length <= REQUEST_MIRROR_MAX && v.every(isRequestMirror);
}

function isRequestMirror(v: unknown): boolean {
  return (
    hasKeys(v, [
      'id',
      'kind',
      'title',
      'body',
      'options',
      'multi',
      'draft',
      'priority',
      'createdAt',
      'expiresAt',
      'requester',
      'state',
      'answer',
      'permission',
    ]) &&
    isPrintableCapped(v.id, REQUEST_ID_MAX) &&
    oneOf(v.kind, REQUEST_MIRROR_KINDS) &&
    isPrintableCapped(v.title, REQUEST_TITLE_MAX) &&
    isMultilineCapped(v.body, REQUEST_BODY_MAX_BYTES) &&
    arrayOf(v.options, isRequestOption) &&
    bool(v.multi) &&
    nullable(v.draft, (x) => isMultilineCapped(x, REQUEST_BODY_MAX_BYTES)) &&
    oneOf(v.priority, ['normal', 'urgent'] as const) &&
    isPrintableCapped(v.createdAt, REQUEST_TIMESTAMP_MAX) &&
    nullable(v.expiresAt, (x) => isPrintableCapped(x, REQUEST_TIMESTAMP_MAX)) &&
    isPrintableCapped(v.requester, REQUESTER_MAX) &&
    oneOf(v.state, REQUEST_MIRROR_STATES) &&
    nullable(v.answer, isRequestMirrorAnswer) &&
    nullable(v.permission, isRequestMirrorPermission)
  );
}

function isRequestOption(v: unknown): boolean {
  return (
    hasKeys(v, ['label'], ['description']) &&
    isPrintableCapped(v.label, REQUEST_OPTION_LABEL_MAX) &&
    (v.description === undefined ||
      isPrintableCapped(v.description, REQUEST_OPTION_DESCRIPTION_MAX))
  );
}

/** The outcome fields a request answer and a mirrored answer share. */
function isAnswerFields(v: Rec): boolean {
  return (
    isPrintableCapped(v.outcome, ANSWER_OUTCOME_MAX) &&
    (v.text === undefined || isMultilineCapped(v.text, REQUEST_BODY_MAX_BYTES)) &&
    (v.values === undefined ||
      (Array.isArray(v.values) &&
        v.values.length <= ANSWER_VALUES_MAX &&
        v.values.every((x) => isPrintableCapped(x, ANSWER_VALUE_MAX)))) &&
    (v.reason === undefined || isPrintableCapped(v.reason, ANSWER_REASON_MAX))
  );
}

function isRequestAnswerBody(v: unknown): boolean {
  return (
    hasKeys(v, ['outcome'], ['text', 'values', 'reason', 'grant']) &&
    isAnswerFields(v) &&
    (v.grant === undefined || bool(v.grant))
  );
}

function isRequestMirrorAnswer(v: unknown): boolean {
  return (
    hasKeys(v, ['outcome', 'at'], ['text', 'values', 'reason']) &&
    isAnswerFields(v) &&
    isPrintableCapped(v.at, REQUEST_TIMESTAMP_MAX)
  );
}

function isRequestMirrorPermission(v: unknown): boolean {
  return (
    hasKeys(v, ['tool', 'why', 'grantable']) &&
    isPrintableCapped(v.tool, PERMISSION_TOOL_MAX) &&
    isPrintableCapped(v.why, PERMISSION_WHY_MAX) &&
    bool(v.grantable)
  );
}

function isRoutedError(v: unknown): boolean {
  return (
    hasKeys(v, ['code', 'message', 'retryable'], ['hint']) &&
    isPrintableCapped(v.code, ERROR_CODE_MAX) &&
    isPrintableCapped(v.message, ERROR_MESSAGE_MAX) &&
    bool(v.retryable) &&
    (v.hint === undefined || isPrintableCapped(v.hint, ERROR_HINT_MAX))
  );
}
