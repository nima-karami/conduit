import {
  type CreateInput,
  parseListRequests,
  parseRequestInput,
  parseWaitRequest,
  parseWithdrawRequest,
  validateAnswer,
} from './request-args';
import { emptyPresence, parseRequestsFile, serializeRequestsFile } from './request-file';
import type { RequestsIo } from './request-file-fs';
import { createRequestQueue, ENDED_IN_UI, type RequestQueue, type Stamp } from './request-queue';
import {
  type QuestionMessage,
  reconcileAttention,
  reconcileQuestions,
  type SessionNeedsYou,
  type SourceAction,
} from './request-sources';
import {
  type HumanPresence,
  isVisibleRequest,
  type ListRequestsOutput,
  type RequestAnswer,
  type RequestAnswerOut,
  type RequestAnswerResult,
  type RequestCallOutput,
  type RequestRecord,
  type RequestsUiState,
  type RequestView,
  type VisibleRequestRecord,
} from './request-types';
import {
  createRequestWaits,
  REQUEST_WAITS_PER_CALLER,
  type RequestWaits,
  requestWaitMs,
} from './request-waits';
import type { Caller } from './tools';
import { type Result, toolError } from './types';
import type { CallKey } from './window-waits';

export const PERSIST_COALESCE_MS = 250;

export interface RequestServiceDeps {
  io: RequestsIo;
  machineId: string;
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  warn(message: string, data?: unknown): void;
  stampOf(sessionId: string): { session: string | null; space: string | null; lead: string | null };
  budgetMs(caller: Caller): number;
  deliver(r: RequestRecord): Promise<boolean>;
  onChanged(): void;
  onNew(r: RequestRecord): void;
  replyToQuestion(r: RequestRecord, text: string): Promise<boolean>;
  scheduler: {
    resumeNow(sessionId: string): Promise<boolean>;
    autoResumeOn(sessionId: string): boolean;
    dismissIssue(sessionId: string): void;
  };
}

export interface RequestService {
  start(): void;
  stop(): Promise<void>;
  onAttention(facts: readonly SessionNeedsYou[]): void;
  onQuestions(unread: readonly QuestionMessage[]): void;
  tools: {
    requestInput(
      caller: Caller,
      args: unknown,
      key: CallKey,
    ): Promise<Result<RequestCallOutput> | null>;
    waitRequest(
      caller: Caller,
      args: unknown,
      key: CallKey,
    ): Promise<Result<RequestCallOutput> | null>;
    withdrawRequest(
      caller: Caller,
      args: unknown,
    ): Result<{ state: 'withdrawn'; request_id: string }>;
    listRequests(caller: Caller, args: unknown): Result<ListRequestsOutput>;
  };
  answerFromRenderer(
    requestId: string,
    answer: unknown,
    windowId: number | null,
  ): Promise<RequestAnswerResult>;
  setAway(away: boolean, until: string | null): void;
  humanActive(): void;
  cancelCalls(match: (w: { sessionId: string; key: CallKey }) => boolean): void;
  onSessionDeleted(sessionId: string): void;
  retryDeliveries(): void;
  purge(): void;
  ui(): RequestsUiState;
  presence(): HumanPresence;
}

interface Timer {
  handle: unknown;
}

const answerOut = (a: RequestAnswer): RequestAnswerOut => ({
  outcome: a.outcome,
  ...(a.text === undefined ? {} : { text: a.text }),
  ...(a.values === undefined ? {} : { values: a.values }),
  ...(a.reason === undefined ? {} : { reason: a.reason }),
  answered_by: a.answeredBy.kind === 'default' ? 'default' : 'you',
  at: a.at,
});

const outputOf = (r: RequestRecord): RequestCallOutput => {
  if (r.state === 'open') return { state: 'open', request_id: r.id };
  if (r.state === 'answered') {
    // The queue sets an answer on every answered transition (renderer, default at expiry).
    if (r.answer === null) throw new Error(`request ${r.id} is answered without an answer`);
    return { state: 'answered', request_id: r.id, answer: answerOut(r.answer) };
  }
  return {
    state: r.state,
    request_id: r.id,
    ...(r.withdrawReason ? { reason: r.withdrawReason } : {}),
  };
};

const isAgentEnd = (r: RequestRecord): boolean =>
  r.source === 'agent' && (r.state === 'answered' || r.state === 'expired');

const iso = (ms: number): string => new Date(ms).toISOString();

export function createRequestService(deps: RequestServiceDeps): RequestService {
  let writable = true;
  let presence: HumanPresence = emptyPresence(deps.now());
  let dirty = false;
  let persistTimer: Timer | null = null;
  let awayTimer: Timer | null = null;
  const inFlight = new Set<string>();

  const view = (r: VisibleRequestRecord): RequestView => {
    const until = waits.waitingUntil(r.id);
    return {
      ...r,
      waiting: until !== null,
      waitingUntil: until === null ? null : new Date(until).toISOString(),
    };
  };

  const viewOf = (r: RequestRecord): RequestView | null => (isVisibleRequest(r) ? view(r) : null);

  const markDirty = (): void => {
    if (!writable) return;
    dirty = true;
    if (persistTimer !== null) return;
    persistTimer = {
      handle: deps.setTimer(() => {
        persistTimer = null;
        void writeNow();
      }, PERSIST_COALESCE_MS),
    };
  };

  const writeNow = async (): Promise<void> => {
    if (!writable || !dirty) return;
    dirty = false;
    const text = serializeRequestsFile({
      version: 1,
      requests: queue.records(),
      presence,
    });
    try {
      await deps.io.write(text);
    } catch (e) {
      // Still dirty: the next change or stop() writes it again rather than losing it.
      dirty = true;
      deps.warn('requests.json could not be saved', e);
    }
  };

  const changed = (): void => {
    markDirty();
    deps.onChanged();
  };

  const deliverOne = async (id: string): Promise<void> => {
    if (inFlight.has(id)) return;
    const r = queue.get(id);
    if (r === undefined) return;
    inFlight.add(id);
    try {
      if (await deps.deliver(r)) queue.markDelivered(id);
    } catch (e) {
      deps.warn('a late request answer could not be delivered', e);
    } finally {
      inFlight.delete(id);
    }
  };

  const waits: RequestWaits = createRequestWaits({
    now: () => deps.now(),
    setTimer: (fn, ms) => deps.setTimer(fn, ms),
    clearTimer: (t) => deps.clearTimer(t),
    onWaitingChanged: () => deps.onChanged(),
  });

  const queue: RequestQueue = createRequestQueue({
    now: () => deps.now(),
    newId: () => deps.newId(),
    machineId: deps.machineId,
    setTimer: (fn, ms) => deps.setTimer(fn, ms),
    clearTimer: (t) => deps.clearTimer(t),
    onEnded: (r) => {
      // A waiting call returns the answer itself and marks it delivered, so only an unwaited end
      // goes to the inbox.
      const hadWaiter = waits.isWaiting(r.id);
      waits.ended(r.id);
      if (isAgentEnd(r) && !hadWaiter && r.deliveredAt === null) void deliverOne(r.id);
    },
    onChanged: changed,
  });

  const disarmAway = (): void => {
    if (awayTimer === null) return;
    deps.clearTimer(awayTimer.handle);
    awayTimer = null;
  };

  const armAway = (until: string | null): void => {
    disarmAway();
    if (until === null) return;
    awayTimer = {
      handle: deps.setTimer(
        () => {
          awayTimer = null;
          setAway(false, null);
        },
        Math.max(0, Date.parse(until) - deps.now()),
      ),
    };
  };

  const setAway = (away: boolean, until: string | null): void => {
    if (until !== null && Number.isNaN(Date.parse(until))) {
      deps.warn('setAway ignored: until is not a valid date', { until });
      return;
    }
    const nowIso = iso(deps.now());
    if (away) {
      presence = { state: 'away', since: nowIso, until, lastAway: presence.lastAway };
      armAway(until);
    } else {
      if (presence.state !== 'away') return;
      presence = {
        state: 'here',
        since: nowIso,
        until: null,
        lastAway: { from: presence.since, to: nowIso },
      };
      disarmAway();
    }
    changed();
  };

  const notCapped = (sessionId: string): Result<never> | null =>
    waits.countFor(sessionId) >= REQUEST_WAITS_PER_CALLER
      ? {
          ok: false,
          error: toolError(
            'rate_limited',
            `${REQUEST_WAITS_PER_CALLER} calls are already waiting on requests`,
            sessionId,
            { hint: 'wait on the requests you already have, or let them end first' },
          ),
        }
      : null;

  const endedOutput = (r: RequestRecord): RequestCallOutput => {
    if (isAgentEnd(r)) queue.markDelivered(r.id);
    return outputOf(r);
  };

  const awaitRequest = async (
    caller: Caller,
    sessionId: string,
    requestId: string,
    waitS: number | null,
    key: CallKey,
  ): Promise<Result<RequestCallOutput> | null> => {
    const r = queue.get(requestId);
    if (r === undefined) {
      return { ok: false, error: toolError('not_found', `no request ${requestId}`, sessionId) };
    }
    if (r.state !== 'open') return { ok: true, value: endedOutput(r) };

    const { ms, clampedTo } = requestWaitMs(waitS, deps.budgetMs(caller));
    const end = await waits.open({ requestId, sessionId, key, timeoutMs: ms });
    if (end.kind === 'cancelled') return null;
    const after = queue.get(requestId);
    if (after === undefined) {
      return { ok: false, error: toolError('not_found', `no request ${requestId}`, sessionId) };
    }
    if (end.kind === 'ended') return { ok: true, value: endedOutput(after) };
    return {
      ok: true,
      value: {
        state: 'open',
        request_id: requestId,
        ...(clampedTo === undefined ? {} : { clamped_to: clampedTo }),
      },
    };
  };

  const noSession = (): Result<never> => ({
    ok: false,
    error: toolError('not_in_session', 'request tools need an agent session'),
  });

  const requestInput = async (
    caller: Caller,
    args: unknown,
    key: CallKey,
  ): Promise<Result<RequestCallOutput> | null> => {
    const sessionId = caller.sessionId;
    if (sessionId === null) return noSession();
    const parsed = parseRequestInput(args);
    if (!parsed.ok) return parsed;
    const capped = notCapped(sessionId);
    if (capped !== null) return capped;

    const input: CreateInput = parsed.value;
    const stamp: Stamp = { requester: caller.handle, ...deps.stampOf(sessionId) };
    const outcome = queue.createAgent(stamp, input);
    if (outcome.kind === 'refused') return { ok: false, error: outcome.error };
    if (outcome.kind === 'created') deps.onNew(outcome.request);
    return awaitRequest(caller, sessionId, outcome.request.id, input.waitS, key);
  };

  const waitRequest = async (
    caller: Caller,
    args: unknown,
    key: CallKey,
  ): Promise<Result<RequestCallOutput> | null> => {
    const sessionId = caller.sessionId;
    if (sessionId === null) return noSession();
    const parsed = parseWaitRequest(args);
    if (!parsed.ok) return parsed;
    const { requestId, waitS } = parsed.value;
    const r = queue.get(requestId);
    if (r === undefined || r.session !== sessionId) {
      return {
        ok: false,
        error: toolError('not_found', `no request ${requestId} of yours`, sessionId),
      };
    }
    if (r.state === 'open') {
      const capped = notCapped(sessionId);
      if (capped !== null) return capped;
    }
    return awaitRequest(caller, sessionId, requestId, waitS, key);
  };

  const withdrawRequest = (
    caller: Caller,
    args: unknown,
  ): Result<{ state: 'withdrawn'; request_id: string }> => {
    const sessionId = caller.sessionId;
    if (sessionId === null) return noSession();
    const parsed = parseWithdrawRequest(args);
    if (!parsed.ok) return parsed;
    const { requestId, reason } = parsed.value;
    const r = queue.get(requestId);
    if (r === undefined || r.session !== sessionId || r.state !== 'open') {
      return {
        ok: false,
        error: toolError('not_found', `no open request ${requestId} of yours`, sessionId),
      };
    }
    queue.withdraw(requestId, 'requester', reason);
    return { ok: true, value: { state: 'withdrawn', request_id: requestId } };
  };

  const listRequests = (caller: Caller, args: unknown): Result<ListRequestsOutput> => {
    const sessionId = caller.sessionId;
    if (sessionId === null) return noSession();
    const parsed = parseListRequests(args);
    if (!parsed.ok) return parsed;
    const requests = queue
      .bySession(sessionId, parsed.value.state, parsed.value.limit)
      .map((r) => ({
        request_id: r.id,
        kind: r.kind,
        title: r.title,
        state: r.state,
        created_at: r.createdAt,
        expires_at: r.expiresAt,
        waiting: waits.isWaiting(r.id),
        answer: r.answer === null ? null : answerOut(r.answer),
      }));
    return { ok: true, value: { requests } };
  };

  const handledIssues = new Map<string, string>();
  // Marking the question read during its reply fires the question source; it must not resolve the
  // request that is being answered, or the answer below would be refused as already ended.
  const replying = new Set<string>();

  const applyActions = (actions: readonly SourceAction[]): void => {
    for (const a of actions) {
      if (a.kind === 'resolve') {
        queue.resolve(a.id);
        continue;
      }
      const place =
        a.sessionId === null
          ? { session: null, space: null, lead: null }
          : deps.stampOf(a.sessionId);
      deps.onNew(
        queue.createSystem({ requester: a.requester, ...place }, { source: a.source, ...a.fields }),
      );
    }
  };

  // Every answered question, not only dismissed ones: a reply whose mark-read failed leaves the
  // message unread, and it must not be asked again.
  const handledQuestions = (): Set<string> => {
    const ids = new Set<string>();
    for (const r of queue.records()) {
      if (r.source === 'message' && r.state === 'answered' && r.messageId !== null) {
        ids.add(r.messageId);
      }
    }
    return ids;
  };

  const actOnScheduler = (r: VisibleRequestRecord, sessionId: string): void => {
    const answer = r.answer;
    if (answer === null) return;
    if (answer.outcome === 'dismissed') {
      deps.scheduler.dismissIssue(sessionId);
      return;
    }
    if (answer.values?.[0] === 'Resume now') {
      void deps.scheduler.resumeNow(sessionId).then(
        (ok) => {
          if (!ok)
            deps.warn('resume now did not send: the session has no open limit', { sessionId });
        },
        (e: unknown) => deps.warn('resume now failed', e),
      );
      return;
    }
    if (answer.values?.[0] === 'Turn auto-resume on' && !deps.scheduler.autoResumeOn(sessionId)) {
      deps.warn('auto-resume could not be turned on: the session is gone', { sessionId });
    }
  };

  return {
    onAttention(facts) {
      for (const [sessionId, issue] of handledIssues) {
        const f = facts.find((x) => x.sessionId === sessionId);
        if (f === undefined || f.resumeIssue !== issue) handledIssues.delete(sessionId);
      }
      applyActions(reconcileAttention(queue.open(), facts, handledIssues));
    },

    onQuestions(unread) {
      const open = queue.open().filter((r) => r.messageId === null || !replying.has(r.messageId));
      const pending = unread.filter((q) => !replying.has(q.messageId));
      applyActions(reconcileQuestions(open, pending, handledQuestions()));
    },

    start() {
      let parsed: ReturnType<typeof parseRequestsFile>;
      try {
        parsed = parseRequestsFile(deps.io.read(), deps.now());
      } catch (e) {
        // Not writable this run: a file we could not read must not be overwritten by an empty queue.
        deps.warn('requests.json could not be read; starting empty and not saving', e);
        writable = false;
        parsed = parseRequestsFile(null, deps.now());
      }
      if (parsed.kind === 'newer') {
        writable = false;
        deps.warn('requests.json is from a newer version; requests will not be saved');
      } else if (parsed.kind === 'corrupt') {
        deps.warn('requests.json is unreadable; starting empty, and the next save replaces it');
      }
      if (parsed.dropped > 0) {
        deps.warn(`dropped ${parsed.dropped} unreadable request(s) from requests.json`);
      }
      presence = parsed.file.presence;
      queue.load(parsed.file.requests);
      if (presence.state !== 'away') return;
      if (presence.until === null) return;
      const untilMs = Date.parse(presence.until);
      if (Number.isNaN(untilMs)) {
        deps.warn('requests.json has an invalid away end; ending Away');
        setAway(false, null);
      } else if (untilMs <= deps.now()) {
        setAway(false, null);
      } else {
        armAway(presence.until);
      }
    },

    async stop() {
      if (persistTimer !== null) {
        deps.clearTimer(persistTimer.handle);
        persistTimer = null;
      }
      await writeNow();
      disarmAway();
      waits.dispose();
      queue.dispose();
    },

    tools: {
      requestInput,
      waitRequest,
      withdrawRequest,
      listRequests,
    },

    async answerFromRenderer(requestId, answer, windowId) {
      const record = queue.get(requestId);
      if (record !== undefined && record.source === 'message' && record.state === 'open') {
        const checked = validateAnswer(record, answer);
        if (!checked.ok) {
          return {
            ok: false,
            reason: 'invalid_answer',
            message: checked.error.message,
            request: viewOf(record),
          };
        }
        const { outcome, text } = checked.value;
        if (outcome === 'answered' && text !== undefined) {
          if (record.messageId !== null && replying.has(record.messageId)) {
            return {
              ok: false,
              reason: 'not_answerable',
              message: 'the reply is already being sent',
              request: viewOf(record),
            };
          }
          if (record.messageId !== null) replying.add(record.messageId);
          let sent: boolean;
          try {
            sent = await deps.replyToQuestion(record, text);
          } finally {
            if (record.messageId !== null) replying.delete(record.messageId);
          }
          if (!sent) {
            return {
              ok: false,
              reason: 'not_answerable',
              message: 'the reply could not be sent; try again',
              request: viewOf(record),
            };
          }
        }
      }

      const result = queue.answer(requestId, answer, { kind: 'you', windowId });
      if (!result.ok) {
        const after = queue.get(requestId);
        return {
          ok: false,
          reason: result.reason,
          message: result.message,
          request: after === undefined ? null : viewOf(after),
        };
      }
      const answered = result.record;
      if (!isVisibleRequest(answered)) {
        return {
          ok: false,
          reason: 'not_answerable',
          message: 'permission requests are answered through the policy',
          request: null,
        };
      }
      if (answered.source === 'scheduler' && answered.session !== null) {
        // Before acting: acting can re-enter onAttention synchronously while the issue persists.
        handledIssues.set(answered.session, answered.body);
        actOnScheduler(answered, answered.session);
      }
      return { ok: true, request: view(answered) };
    },

    setAway,

    humanActive() {
      if (presence.state === 'away') setAway(false, null);
    },

    cancelCalls(match) {
      waits.cancel(match);
    },

    onSessionDeleted(sessionId) {
      waits.cancel((w) => w.sessionId === sessionId);
      queue.orphanSession(sessionId);
    },

    retryDeliveries() {
      for (const r of queue.records()) {
        if (isAgentEnd(r) && r.deliveredAt === null && !waits.isWaiting(r.id)) {
          void deliverOne(r.id);
        }
      }
    },

    purge() {
      queue.purge();
    },

    ui() {
      return {
        open: queue.open().filter(isVisibleRequest).map(view),
        ended: queue.ended(ENDED_IN_UI).filter(isVisibleRequest).map(view),
        presence,
      };
    },

    presence() {
      return presence;
    },
  };
}
