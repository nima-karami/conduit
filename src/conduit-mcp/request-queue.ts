// Node-free: the renderer may import this. Clock and timers are injected so the
// lifecycle is testable without real time.
import { type CreateInput, contentKeyOf, validateAnswer } from './request-args';
import {
  type AnsweredBy,
  isVisibleRequest,
  type RequestAnswerResult,
  type RequestRecord,
  type RequestView,
} from './request-types';
import { type Handle, type ToolError, toolError } from './types';

export const CAP_OPEN_PER_REQUESTER = 5;
const CAP_URGENT_PER_10MIN = 1;
export const CAP_CREATED_PER_HOUR = 20;
export const CAP_OPEN_PER_SERVER = 50;
export const HISTORY_MS = 30 * 86_400_000;
export const ENDED_IN_UI = 200;

const URGENT_WINDOW_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface QueueDeps {
  now(): number;
  newId(): string;
  machineId: string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  onEnded(r: RequestRecord): void;
  onChanged(): void;
}

export interface Stamp {
  requester: Handle | 'conduit';
  session: string | null;
  space: string | null;
  lead: string | null;
}

export type CreateOutcome =
  | { kind: 'created'; request: RequestRecord }
  | { kind: 'attached'; request: RequestRecord }
  | { kind: 'refused'; error: ToolError };

export interface RequestQueue {
  load(records: RequestRecord[]): void;
  createAgent(stamp: Stamp, input: CreateInput): CreateOutcome;
  createSystem(
    stamp: Stamp,
    fields: Pick<
      RequestRecord,
      | 'source'
      | 'kind'
      | 'title'
      | 'body'
      | 'options'
      | 'thread'
      | 'messageId'
      | 'blocked'
      | 'priority'
    >,
  ): RequestRecord;
  createBound(
    stamp: Stamp,
    fields: Pick<RequestRecord, 'title' | 'body' | 'permission'>,
    expiresAt: string,
  ): RequestRecord;
  answerLate(id: string, grantId: string): RequestAnswerResult;
  answer(id: string, input: unknown, by: AnsweredBy): RequestAnswerResult;
  withdraw(id: string, by: 'requester' | 'conduit', reason: string | null): RequestRecord | null;
  resolve(id: string): RequestRecord | null;
  orphanSession(sessionId: string): RequestRecord[];
  markDelivered(id: string): void;
  get(id: string): RequestRecord | undefined;
  open(): RequestRecord[];
  ended(limit: number): RequestRecord[];
  bySession(sessionId: string, state: 'open' | 'all', limit: number): RequestRecord[];
  purge(): number;
  records(): RequestRecord[];
  dispose(): void;
}

const clone = <T>(r: T): T => JSON.parse(JSON.stringify(r));

const isCountable = (r: RequestRecord): boolean => r.source === 'agent' || r.source === 'message';

export function createRequestQueue(deps: QueueDeps): RequestQueue {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const timeOf = (s: string): number => Date.parse(s);

  let store = new Map<string, RequestRecord>();
  const timers = new Map<string, unknown>();

  const view = (r: RequestRecord): RequestView | null =>
    isVisibleRequest(r) ? { ...clone(r), waiting: false, waitingUntil: null } : null;

  const disarm = (id: string): void => {
    if (!timers.has(id)) return;
    const t = timers.get(id);
    timers.delete(id);
    deps.clearTimer(t);
  };

  const arm = (r: RequestRecord): void => {
    disarm(r.id);
    if (r.state !== 'open' || r.expiresAt === null) return;
    const ms = Math.max(0, timeOf(r.expiresAt) - deps.now());
    timers.set(
      r.id,
      deps.setTimer(() => fire(r.id), ms),
    );
  };

  // A transition to an end state: the one place that sets endedAt, stops the
  // timer, and tells the owner, so no path can skip one of them.
  const finish = (r: RequestRecord, state: RequestRecord['state']): void => {
    r.state = state;
    r.endedAt = iso(deps.now());
    disarm(r.id);
    deps.onEnded(clone(r));
    deps.onChanged();
  };

  const expire = (r: RequestRecord): void => {
    if (r.default !== null) {
      r.answer = { ...r.default, answeredBy: { kind: 'default' }, at: iso(deps.now()) };
      finish(r, 'answered');
      return;
    }
    finish(r, 'expired');
  };

  const fire = (id: string): void => {
    timers.delete(id);
    const r = store.get(id);
    if (r === undefined || r.state !== 'open') return;
    expire(r);
  };

  const insert = (r: RequestRecord): RequestRecord => {
    const stored = clone(r);
    store.set(stored.id, stored);
    arm(stored);
    return clone(stored);
  };

  const purgeEnded = (): number => {
    const cutoff = deps.now() - HISTORY_MS;
    let removed = 0;
    for (const [id, r] of store) {
      if (r.state === 'open' || r.endedAt === null) continue;
      if (timeOf(r.endedAt) < cutoff) {
        store.delete(id);
        removed++;
      }
    }
    if (removed > 0) deps.onChanged();
    return removed;
  };

  const openRecords = (): RequestRecord[] => [...store.values()].filter((r) => r.state === 'open');

  const refuse = (
    code: 'not_found' | 'rate_limited',
    message: string,
    session: string | null,
    hint?: string,
  ): CreateOutcome => ({
    kind: 'refused',
    error: toolError(
      code,
      message,
      session ?? undefined,
      hint === undefined ? undefined : { hint },
    ),
  });

  return {
    load(records) {
      for (const id of [...timers.keys()]) disarm(id);
      store = new Map(records.map((r) => [r.id, clone(r)]));
      const now = deps.now();
      for (const r of [...store.values()]) {
        if (r.state !== 'open') continue;
        if (r.source === 'observed' || r.source === 'scheduler') {
          finish(r, 'resolved');
          continue;
        }
        if (r.expiresAt !== null && timeOf(r.expiresAt) <= now) {
          expire(r);
          continue;
        }
        arm(r);
      }
      // A pure restore changes nothing on disk; every transition above already reported itself.
      purgeEnded();
    },

    createAgent(stamp, input) {
      const now = deps.now();
      const contentKey = contentKeyOf(input);

      let replaced: RequestRecord | null = null;
      if (input.replaces !== null) {
        const old = store.get(input.replaces);
        if (old === undefined || old.state !== 'open' || old.session !== stamp.session) {
          return refuse('not_found', `no open request ${input.replaces} of yours`, stamp.session);
        }
        replaced = old;
      } else if (stamp.session !== null) {
        const dup = openRecords().find(
          (r) => r.source === 'agent' && r.session === stamp.session && r.contentKey === contentKey,
        );
        if (dup) return { kind: 'attached', request: clone(dup) };
      }

      const countable = [...store.values()].filter(
        (r) => isCountable(r) && r.requester === stamp.requester,
      );
      const openMine = countable.filter((r) => r.state === 'open' && r.id !== replaced?.id).length;
      if (openMine >= CAP_OPEN_PER_REQUESTER) {
        return refuse(
          'rate_limited',
          `${CAP_OPEN_PER_REQUESTER} open requests already`,
          stamp.session,
          `you have ${CAP_OPEN_PER_REQUESTER} open requests; withdraw one or wait`,
        );
      }
      if (input.priority === 'urgent') {
        const urgent = countable.filter(
          (r) => r.priority === 'urgent' && now - timeOf(r.createdAt) < URGENT_WINDOW_MS,
        ).length;
        if (urgent >= CAP_URGENT_PER_10MIN) {
          return refuse(
            'rate_limited',
            'an urgent request was already made in the last 10 minutes',
            stamp.session,
            'send it at normal priority or wait 10 minutes',
          );
        }
      }
      const hour = countable.filter((r) => now - timeOf(r.createdAt) < HOUR_MS).length;
      if (hour >= CAP_CREATED_PER_HOUR) {
        return refuse(
          'rate_limited',
          `${CAP_CREATED_PER_HOUR} requests created in the last hour`,
          stamp.session,
          'wait before creating another request',
        );
      }
      if (openRecords().filter((r) => r.id !== replaced?.id).length >= CAP_OPEN_PER_SERVER) {
        return refuse(
          'rate_limited',
          `the server already has ${CAP_OPEN_PER_SERVER} open requests`,
          stamp.session,
          'wait for some requests to end',
        );
      }

      const created = insert({
        id: deps.newId(),
        origin: deps.machineId,
        source: 'agent',
        kind: input.kind,
        requester: stamp.requester,
        session: stamp.session,
        space: stamp.space,
        lead: stamp.lead,
        machine: deps.machineId,
        title: input.title,
        body: input.body,
        options: input.options,
        multi: input.multi,
        draft: input.draft,
        thread: input.thread,
        messageId: null,
        blocked: null,
        priority: input.priority,
        createdAt: iso(now),
        expiresAt: input.expiresInMs === null ? null : iso(now + input.expiresInMs),
        default: input.default,
        contentKey,
        state: 'open',
        endedAt: null,
        answer: null,
        withdrawnBy: null,
        withdrawReason: null,
        supersededBy: null,
        deliveredAt: null,
        permission: null,
      });

      if (replaced !== null) {
        replaced.supersededBy = created.id;
        finish(replaced, 'superseded');
      }
      deps.onChanged();
      return { kind: 'created', request: created };
    },

    createSystem(stamp, fields) {
      const created = insert({
        id: deps.newId(),
        origin: deps.machineId,
        source: fields.source,
        kind: fields.kind,
        requester: stamp.requester,
        session: stamp.session,
        space: stamp.space,
        lead: stamp.lead,
        machine: deps.machineId,
        title: fields.title,
        body: fields.body,
        options: fields.options,
        multi: false,
        draft: null,
        thread: fields.thread,
        messageId: fields.messageId,
        blocked: fields.blocked,
        priority: fields.priority,
        createdAt: iso(deps.now()),
        expiresAt: null,
        default: null,
        contentKey: '',
        state: 'open',
        endedAt: null,
        answer: null,
        withdrawnBy: null,
        withdrawReason: null,
        supersededBy: null,
        deliveredAt: null,
        permission: null,
      });
      deps.onChanged();
      return created;
    },

    createBound(stamp, fields, expiresAt) {
      const created = insert({
        id: deps.newId(),
        origin: deps.machineId,
        source: 'policy',
        kind: 'permission',
        requester: stamp.requester,
        session: stamp.session,
        space: stamp.space,
        lead: stamp.lead,
        machine: deps.machineId,
        title: fields.title,
        body: fields.body,
        options: [],
        multi: false,
        draft: null,
        thread: null,
        messageId: null,
        blocked: null,
        priority: 'normal',
        createdAt: iso(deps.now()),
        expiresAt,
        default: null,
        contentKey: '',
        state: 'open',
        endedAt: null,
        answer: null,
        withdrawnBy: null,
        withdrawReason: null,
        supersededBy: null,
        deliveredAt: null,
        permission: fields.permission,
      });
      deps.onChanged();
      return created;
    },

    answerLate(id, grantId) {
      const r = store.get(id);
      if (r === undefined) {
        return { ok: false, reason: 'not_found', message: `no request ${id}`, request: null };
      }
      if (r.permission === null || r.state !== 'expired' || r.permission.lateGrant !== null) {
        return {
          ok: false,
          reason: 'not_answerable',
          message: `request ${id} is not an expired permission without a late grant`,
          request: view(r),
        };
      }
      r.permission.lateGrant = grantId;
      deps.onChanged();
      return { ok: true, request: view(r) };
    },

    answer(id, input, by) {
      const r = store.get(id);
      if (r === undefined) {
        return { ok: false, reason: 'not_found', message: `no request ${id}`, request: null };
      }
      if (r.state !== 'open') {
        return {
          ok: false,
          reason: 'already_ended',
          message: `request ${id} already ${r.state}`,
          request: view(r),
        };
      }
      if (r.kind === 'attend') {
        return {
          ok: false,
          reason: 'not_answerable',
          message: 'attention requests are answered in the app, not here',
          request: view(r),
        };
      }
      const checked = validateAnswer(r, input);
      if (!checked.ok) {
        return {
          ok: false,
          reason: 'invalid_answer',
          message: checked.error.message,
          request: view(r),
        };
      }
      r.answer = { ...checked.value, answeredBy: by, at: iso(deps.now()) };
      finish(r, 'answered');
      return { ok: true, request: view(r) };
    },

    withdraw(id, by, reason) {
      const r = store.get(id);
      if (r === undefined || r.state !== 'open') return null;
      r.withdrawnBy = by;
      r.withdrawReason = reason;
      finish(r, 'withdrawn');
      return clone(r);
    },

    resolve(id) {
      const r = store.get(id);
      if (r === undefined || r.state !== 'open') return null;
      finish(r, 'resolved');
      return clone(r);
    },

    orphanSession(sessionId) {
      const hit = openRecords().filter((r) => r.session === sessionId);
      for (const r of hit) finish(r, 'orphaned');
      return hit.map(clone);
    },

    markDelivered(id) {
      const r = store.get(id);
      if (!r) return;
      r.deliveredAt = iso(deps.now());
      deps.onChanged();
    },

    get(id) {
      const r = store.get(id);
      return r === undefined ? undefined : clone(r);
    },

    open() {
      return openRecords()
        .sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
        .map(clone);
    },

    ended(limit) {
      return [...store.values()]
        .filter((r) => r.state !== 'open' && r.endedAt !== null)
        .sort((a, b) => timeOf(b.endedAt ?? '') - timeOf(a.endedAt ?? ''))
        .slice(0, limit)
        .map(clone);
    },

    bySession(sessionId, state, limit) {
      return [...store.values()]
        .filter((r) => r.session === sessionId && (state === 'all' || r.state === 'open'))
        .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
        .slice(0, limit)
        .map(clone);
    },

    purge: purgeEnded,

    records() {
      return [...store.values()].map(clone);
    },

    dispose() {
      for (const id of [...timers.keys()]) disarm(id);
    },
  };
}
