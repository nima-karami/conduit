// Node-free: the renderer imports these wire types. See docs/specs/2026-11-14-user-input-requests.md §4.1-4.2.
import type { Handle } from './types';

export type RequestSource = 'agent' | 'message' | 'observed' | 'scheduler';
export type AgentRequestKind = 'confirm' | 'choose' | 'text' | 'review';
export type RequestKind = AgentRequestKind | 'attend';
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
  | 'dismissed';
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
  /** `declined` only. */
  reason?: string;
}
export type AnsweredBy = { kind: 'you'; windowId: number | null } | { kind: 'default' };
export interface RequestAnswer extends AnswerInput {
  answeredBy: AnsweredBy;
  at: string;
}

export interface RequestRecord {
  id: string;
  /** The origin server's machine id; the only writer, and its clock is the one that counts. */
  origin: string;
  source: RequestSource;
  kind: RequestKind;
  requester: Handle | 'conduit';
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
}

export interface RequestView extends RequestRecord {
  /** Live, never persisted: a call is blocked on it right now. */
  waiting: boolean;
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

export type RequestAnswerResult =
  | { ok: true; request: RequestView }
  | {
      ok: false;
      reason: 'not_found' | 'already_ended' | 'not_answerable' | 'invalid_answer';
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
    kind: RequestKind;
    title: string;
    state: RequestState;
    created_at: string;
    expires_at: string | null;
    waiting: boolean;
    answer: RequestAnswerOut | null;
  }>;
}
