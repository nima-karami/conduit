// A's mirror of the open requests on the machines it controls (CON-42, plan decision 2). B is the
// only writer; nothing here reaches disk. Node-free: the renderer reads the views through McpUiState.

import type { RequestAnswerBody, RequestMirror } from '../contracts/link-protocol';
import type { RemoteRequestSink } from './remote-routing';
import type { ListRequestsOutput, RequestsUiState, RequestView } from './request-types';
import { type Result, toolError } from './types';

/** A mirrored request as the Needs-you queue shows it. `stale` while its link is down. */
export interface RemoteRequestView extends RequestView {
  stale: boolean;
  machineName: string;
}

export interface RemoteRequestRef {
  machineId: string;
  requestId: string;
  mirror: RequestMirror;
  view: RemoteRequestView;
}

export interface RemoteRequests extends RemoteRequestSink {
  views(): RemoteRequestView[];
  resolve(id: string): RemoteRequestRef | null;
}

interface MachineSet {
  /** The seq floor: a snapshot at or below it is stale news. Null until the link's first one. */
  seq: number | null;
  name: string;
  stale: boolean;
  requests: RequestMirror[];
}

/** `<requestId>@<machineId>`. Machine ids carry no '@', so the last one splits the id. */
const remoteRequestId = (requestId: string, machineId: string): string =>
  `${requestId}@${machineId}`;

const splitId = (id: string): { requestId: string; machineId: string } | null => {
  const at = id.lastIndexOf('@');
  if (at <= 0 || at === id.length - 1) return null;
  return { requestId: id.slice(0, at), machineId: id.slice(at + 1) };
};

// A permission is answered as an approve/deny, so it is an `attend` blocked on permission (the
// shape typeOf already reads as 'approve'). Its tool and grant detail stay in the mirror.
function viewOf(machineId: string, set: MachineSet, m: RequestMirror): RemoteRequestView {
  const permission = m.permission !== null;
  return {
    id: remoteRequestId(m.id, machineId),
    origin: machineId,
    source: permission ? 'policy' : 'agent',
    kind: m.kind === 'permission' ? 'attend' : m.kind,
    requester: m.requester,
    session: null,
    space: null,
    lead: null,
    machine: machineId,
    title: m.title,
    body: m.body,
    options: m.options,
    multi: m.multi,
    draft: m.draft,
    thread: null,
    messageId: null,
    blocked: permission ? 'permission' : null,
    priority: m.priority,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    default: null,
    contentKey: '',
    state: m.state,
    endedAt: null,
    // B's answer names B's own answerer; A has no RequestAnswer for it, so the row carries none.
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    waiting: false,
    waitingUntil: null,
    stale: set.stale,
    machineName: set.name,
  };
}

export function createRemoteRequests(deps: { onChanged(): void }): RemoteRequests {
  const machines = new Map<string, MachineSet>();

  const views = (): RemoteRequestView[] =>
    [...machines].flatMap(([machineId, set]) => set.requests.map((m) => viewOf(machineId, set, m)));

  return {
    apply(machineId, seq, requests, machineName) {
      const current = machines.get(machineId);
      if (current !== undefined && current.seq !== null && seq <= current.seq) return false;
      machines.set(machineId, { seq, name: machineName, stale: false, requests });
      deps.onChanged();
      return true;
    },

    setLinkState(machineId, state) {
      if (state === 'gone') {
        if (machines.delete(machineId)) deps.onChanged();
        return;
      }
      const current = machines.get(machineId);
      if (current === undefined) return;
      // A new link starts its own seq: B may have restarted, so the floor is reset on up.
      current.stale = state === 'down';
      if (state === 'up') current.seq = null;
      deps.onChanged();
    },

    views,

    resolve(id) {
      const parts = splitId(id);
      if (parts === null) return null;
      const set = machines.get(parts.machineId);
      const mirror = set?.requests.find((m) => m.id === parts.requestId);
      if (set === undefined || mirror === undefined) return null;
      return {
        machineId: parts.machineId,
        requestId: parts.requestId,
        mirror,
        view: viewOf(parts.machineId, set, mirror),
      };
    },
  };
}

/** The Needs-you queue's open and ended lists with the remote rows added after the local ones. */
export function mergeRemoteRequests(
  local: RequestsUiState,
  remote: readonly RemoteRequestView[],
): RequestsUiState {
  return {
    open: [...local.open, ...remote.filter((r) => r.state === 'open')],
    ended: [...local.ended, ...remote.filter((r) => r.state !== 'open')],
    presence: local.presence,
  };
}

export type RemoteListRow = ListRequestsOutput['requests'][number] & { machine: string };

const DEFAULT_LIST_LIMIT = 50;

/**
 * list_requests with the remote rows added. Agents read these only; they never answer them. The
 * local call has already validated the args, so only the limit and state are read here.
 */
export function mergeListRequests(
  local: Result<ListRequestsOutput>,
  remote: readonly RemoteRequestView[],
  args: unknown,
): Result<{ requests: (ListRequestsOutput['requests'][number] | RemoteListRow)[] }> {
  if (!local.ok) return local;
  const record: Record<string, unknown> = isRecord(args) ? args : {};
  const all = record.state === 'all';
  const limit = typeof record.limit === 'number' ? record.limit : DEFAULT_LIST_LIMIT;
  const rows: RemoteListRow[] = remote
    .filter((r) => all || r.state === 'open')
    .map((r) => ({
      request_id: r.id,
      kind: r.kind,
      title: r.title,
      state: r.state,
      created_at: r.createdAt,
      expires_at: r.expiresAt,
      waiting: false,
      answer: null,
      machine: r.machineName,
    }));
  return { ok: true, value: { requests: [...local.value.requests, ...rows].slice(0, limit) } };
}

export type RemoteAnswerCheck =
  | { ok: true; body: RequestAnswerBody }
  | { ok: false; reason: 'already_ended' | 'invalid_answer'; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Decides an owner's answer to a mirrored request before anything is sent. B validates the full
 * answer against its own record; this keeps what A can know (the state, permission shape and
 * grantability) from crossing the link.
 */
export function checkRemoteAnswer(ref: RemoteRequestRef, answer: unknown): RemoteAnswerCheck {
  if (!isRecord(answer) || typeof answer.outcome !== 'string')
    return { ok: false, reason: 'invalid_answer', message: 'an answer names an outcome' };
  if (ref.mirror.state !== 'open')
    return {
      ok: false,
      reason: 'already_ended',
      message: `request ${ref.requestId} already ${ref.mirror.state}`,
    };
  // The renderer's grant is a scope (who, on, for) that B re-derives; the wire carries only that one
  // is asked for.
  const grant = answer.grant !== undefined;
  const isPermission = ref.mirror.kind === 'permission';
  const grantable = ref.mirror.permission?.grantable === true;
  const isPermissionOutcome = answer.outcome === 'allowed' || answer.outcome === 'denied';
  if (!isPermission && isPermissionOutcome)
    return { ok: false, reason: 'invalid_answer', message: 'not an answer to a permission' };
  if (isPermission && !isPermissionOutcome)
    return { ok: false, reason: 'invalid_answer', message: 'a permission is allowed or denied' };
  if (grant && (!isPermission || answer.outcome !== 'allowed' || !grantable))
    return {
      ok: false,
      reason: 'invalid_answer',
      message: 'only an allow of a grantable permission can grant',
    };
  const body: RequestAnswerBody = { outcome: answer.outcome };
  if (typeof answer.text === 'string') body.text = answer.text;
  const values = answer.values;
  if (Array.isArray(values) && values.every((v): v is string => typeof v === 'string'))
    body.values = values;
  if (typeof answer.reason === 'string') body.reason = answer.reason;
  if (grant) body.grant = true;
  return { ok: true, body };
}

/** The refusal an unreachable machine gives, before anything is sent. */
export const unreachableRemote = (machineName: string) =>
  toolError(
    'peer_unreachable',
    `${machineName} is unreachable; the answer was not sent, answer it when the link is back`,
  );
