// Node-free: the renderer imports these wire types. See docs/specs/archive/2026-11-14-user-input-requests.md §4.1-4.2.
import type { GrantChoice } from './grant-store';
import type { Grant, PolicyTarget } from './policy-types';
import type { ToolName } from './tool-policy';
import type { Handle } from './types';

export type RequestSource = 'agent' | 'message' | 'observed' | 'scheduler' | 'policy';
export type AgentRequestKind = 'confirm' | 'choose' | 'text' | 'review';
export type RequestKind = AgentRequestKind | 'attend' | 'permission';
export type RequestState =
  | 'open'
  | 'answered'
  | 'expired'
  | 'withdrawn'
  | 'superseded'
  | 'resolved'
  | 'orphaned';
export type RequestOutcome =
  | 'approved'
  | 'declined'
  | 'answered'
  | 'chosen'
  | 'edited'
  | 'dismissed'
  | 'allowed'
  | 'denied';
export type RequestPriority = 'normal' | 'urgent';
export type BlockedKind = 'permission' | 'question' | 'auth' | null;

export interface RequestOption {
  label: string;
  description?: string;
}

export interface AnswerInput {
  outcome: RequestOutcome;
  text?: string;
  /** choose `chosen`: labels of the request's options. */
  values?: string[];
  /** `declined` / `denied`. */
  reason?: string;
  grant?: GrantChoice;
  scope?: 'session';
}
export type AnsweredBy =
  | { kind: 'you'; windowId: number | null }
  | { kind: 'default' }
  | { kind: 'remote'; machineId: string };
export interface RequestAnswer extends AnswerInput {
  answeredBy: AnsweredBy;
  at: string;
}

/** Who asked on another machine. `requester` holds `handle@machineId` for these records. */
export interface RemoteRequester {
  handle: Handle;
  machineId: string;
}

/** The one place the display form is derived from the structured identity. */
export const requesterOfRemote = (remote: RemoteRequester): string =>
  `${remote.handle}@${remote.machineId}`;

export interface RequestRecord {
  id: string;
  /** The origin server's machine id; the only writer, and its clock is the one that counts. */
  origin: string;
  source: RequestSource;
  kind: RequestKind;
  requester: Handle | 'conduit';
  /** Set only on a permission asked by a peer over the link; absent on records from before CON-42. */
  remote?: RemoteRequester | null;
  session: string | null;
  /** Stamped at creation so views filter without a lookup (owner, 2026-11-14). */
  space: string | null;
  lead: string | null;
  machine: string;
  title: string;
  body: string;
  options: RequestOption[];
  multi: boolean;
  draft: string | null;
  thread: string | null;
  messageId: string | null;
  blocked: BlockedKind;
  priority: RequestPriority;
  createdAt: string;
  expiresAt: string | null;
  default: AnswerInput | null;
  contentKey: string;
  state: RequestState;
  endedAt: string | null;
  answer: RequestAnswer | null;
  withdrawnBy: 'requester' | 'conduit' | null;
  withdrawReason: string | null;
  supersededBy: string | null;
  deliveredAt: string | null;
  permission: {
    tool: ToolName;
    why: string;
    targets: PolicyTarget[];
    lateGrant: Grant['id'] | null;
    // Absent on records from before forced asks: every such permission was grantable.
    grantable?: boolean;
  } | null;
}

export type VisibleRequestRecord = Omit<RequestRecord, 'kind' | 'permission'> & {
  kind: Exclude<RequestKind, 'permission'>;
  permission: null;
};

export const isVisibleRequest = (r: RequestRecord): r is VisibleRequestRecord =>
  r.kind !== 'permission';

/**
 * What A knows about a request mirrored from another machine (CON-42). Set only on those rows; the
 * permission carries the tool and grantability for the owner's answer, never a local permission.
 */
export interface RemoteRequestFacts {
  machineName: string;
  stale: boolean;
  permission: { tool: string; why: string; grantable: boolean } | null;
}

// `remote` on a record names the peer that asked for a permission (never a visible row), so a visible
// row's `remote` is the mirror facts below.
export interface RequestView extends Omit<VisibleRequestRecord, 'remote'> {
  /** Live, never persisted: a call is blocked on it right now. */
  waiting: boolean;
  /** Live: when the latest waiting call gives up (ISO UTC), so views count down; null when none waits. */
  waitingUntil: string | null;
  /** Set only on a request mirrored from another machine. */
  remote?: RemoteRequestFacts;
}

export interface OwnerPermissionView {
  id: string;
  sessionId: string;
  requester: string;
  title: string;
  tool: ToolName;
  why: string;
  state: RequestState;
  createdAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  withdrawReason: string | null;
  grantable: boolean;
  answerable: boolean;
  choices: GrantChoice[];
}
export interface OwnerPermissionCursor {
  at: string;
  id: string;
}
export interface OwnerPermissionPage {
  permissions: OwnerPermissionView[];
  nextCursor: OwnerPermissionCursor | null;
}

export interface HumanPresence {
  state: 'here' | 'away';
  since: string;
  until: string | null;
  lastAway: { from: string; to: string } | null;
}

export interface RequestsUiState {
  open: RequestView[];
  ended: RequestView[];
  presence: HumanPresence;
}

/**
 * The peer_* refusals are a remote owner's answer that did not reach its machine: the link is down,
 * the peer is too old to take it, or the link was removed (CON-42 decision 3).
 */
export type AnswerRefusal =
  | 'not_found'
  | 'already_ended'
  | 'not_answerable'
  | 'invalid_answer'
  | 'peer_unreachable'
  | 'peer_incompatible'
  | 'peer_revoked';

export type QueueAnswerResult =
  | { ok: true; record: RequestRecord }
  | { ok: false; reason: AnswerRefusal; message: string };

export type PermissionAnswerResult =
  | { ok: true }
  | { ok: false; reason: AnswerRefusal; message: string };

export type RequestAnswerResult =
  | { ok: true; request: RequestView }
  | {
      ok: false;
      reason: AnswerRefusal;
      message: string;
      request: RequestView | null;
    };

export interface RequestAnswerOut {
  outcome: RequestOutcome;
  text?: string;
  values?: string[];
  reason?: string;
  answered_by: 'you' | 'default';
  at: string;
}

export type RequestCallOutput =
  | { state: 'answered'; request_id: string; answer: RequestAnswerOut }
  | { state: 'open'; request_id: string; clamped_to?: number }
  | { state: Exclude<RequestState, 'open' | 'answered'>; request_id: string; reason?: string };

export interface ListRequestsOutput {
  requests: Array<{
    request_id: string;
    kind: Exclude<RequestKind, 'permission'>;
    title: string;
    state: RequestState;
    created_at: string;
    expires_at: string | null;
    waiting: boolean;
    answer: RequestAnswerOut | null;
  }>;
}
