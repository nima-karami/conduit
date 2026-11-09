import type { SubmitOutcome } from '../pty-writer';
import type { GateVerdict } from './notice-gate';
import { composeNotice } from './notice-text';
import type { Handle, StoredMessage } from './types';

/**
 * What an in-band unread banner announces: every unread message but fyi. It marks nothing; a
 * banner is no notice, so the notifier still escalates and re-notices the messages it is about.
 */
export function bannerCandidates(pending: readonly StoredMessage[]): StoredMessage[] {
  return pending.filter((m) => m.priority !== 'fyi');
}

/** Queue mode: a burst of sends inside this window becomes one notice, not one per message. */
export const MIDTURN_DEBOUNCE_MS = 1000;
/**
 * Queue mode: busy can stay true for a whole turn that never reports idle, so the busy→idle
 * edge cannot be the only re-notice trigger. An unread notice re-arms once after this long.
 */
export const QUEUED_NOTICE_STALE_MS = 300_000;

export type AttentionRaise =
  | { kind: 'urgent-waiting'; handle: Handle; messageId: string }
  | { kind: 'unsent-notice'; handle: Handle }
  | { kind: 'unread-after-renotice'; handle: Handle; messageId: string };
export interface NotifierSession {
  sessionId: string;
  handle: Handle;
  busy: boolean;
  /** Queue adapters accept a notice mid-turn; hold adapters only at an idle prompt. */
  queues: boolean;
}
export interface NotifierDeps {
  /** Notifiable adapters only. */
  sessions(): NotifierSession[];
  pending(handle: Handle): StoredMessage[];
  /** Decides only whether to TRY; the full gate runs again in the writer slot (plan ruling 1). */
  precheck(sessionId: string): Promise<GateVerdict>;
  submit(
    sessionId: string,
    text: string,
    onFinal?: (outcome: SubmitOutcome) => void | Promise<void>,
  ): Promise<SubmitOutcome>;
  markNoticed(handle: Handle, messageIds: string[]): Promise<void>;
  raise(item: AttentionRaise): void;
  /** Epoch ms. Queue-mode timing reads it; injected so tests can drive time. */
  now(): number;
}
export interface Notifier {
  tick(): Promise<void>;
  forget(sessionId: string): void;
  /** Per-message ids held across ticks. Exists so a test can catch a leak. */
  trackedIds(): number;
}

interface HandleState {
  /** Noticed once and re-armed by a busy→idle edge (spec §2 re-notice). */
  armed: Set<string>;
  /** Escalated to the human after the re-notice; never due again. */
  exhausted: Set<string>;
  urgentRaised: Set<string>;
}

export function createNotifier(deps: NotifierDeps, opts: { rearmAll: boolean }): Notifier {
  const wasBusy = new Map<string, boolean>();
  const busyRoseAt = new Map<string, number>();
  const lastNoticeAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const handles = new Map<Handle, HandleState>();

  function handleState(h: Handle, pending: readonly StoredMessage[]): HandleState {
    let st = handles.get(h);
    if (!st) {
      st = { armed: new Set(), exhausted: new Set(), urgentRaised: new Set() };
      handles.set(h, st);
      // After a host restart, a notice already typed may never have been acted on.
      if (opts.rearmAll) {
        for (const m of pending)
          if (m.recipients[h]?.status === 'noticed') st.armed.add(m.messageId);
      }
    }
    return st;
  }

  function escalate(st: HandleState, h: Handle, messageId: string): void {
    st.exhausted.add(messageId);
    st.armed.delete(messageId);
    deps.raise({ kind: 'unread-after-renotice', handle: h, messageId });
  }

  async function tickSession(s: NotifierSession): Promise<void> {
    const pending = deps.pending(s.handle);
    const st = handleState(s.handle, pending);
    const live = new Set(pending.map((m) => m.messageId));
    for (const ids of [st.armed, st.exhausted, st.urgentRaised]) {
      for (const id of ids) if (!live.has(id)) ids.delete(id);
    }
    const now = deps.now();

    if (!wasBusy.get(s.sessionId) && s.busy) busyRoseAt.set(s.sessionId, now);
    // A busy→idle edge closes the turn a queued notice landed in, not a new one, unless busy
    // rose again after that notice was typed.
    const idleEdge = wasBusy.get(s.sessionId) === true && !s.busy;
    const rose = busyRoseAt.get(s.sessionId) ?? Number.NEGATIVE_INFINITY;
    const lastNotice = lastNoticeAt.get(s.sessionId) ?? Number.NEGATIVE_INFINITY;
    if (idleEdge && (!s.queues || rose > lastNotice)) {
      for (const m of pending) {
        const r = m.recipients[s.handle];
        if (r?.status !== 'noticed') continue;
        if (r.noticeCount === 1) st.armed.add(m.messageId);
        else if (r.noticeCount >= 2 && !st.exhausted.has(m.messageId))
          escalate(st, s.handle, m.messageId);
      }
    }
    wasBusy.set(s.sessionId, s.busy);

    // Queue mode only: a queued notice never reads as idle, so the edge above can't be the sole
    // re-notice trigger. Re-arm once after the stale window, then escalate on the next one.
    if (s.queues) {
      for (const m of pending) {
        const r = m.recipients[s.handle];
        if (r?.status !== 'noticed' || st.exhausted.has(m.messageId)) continue;
        if (!(now - Date.parse(r.updatedAt) >= QUEUED_NOTICE_STALE_MS)) continue;
        if (r.noticeCount === 1) st.armed.add(m.messageId);
        else if (r.noticeCount >= 2) escalate(st, s.handle, m.messageId);
      }
    }

    const due = pending.filter((m) => {
      if (m.priority === 'fyi' || st.exhausted.has(m.messageId)) return false;
      return m.recipients[s.handle]?.status === 'queued' || st.armed.has(m.messageId);
    });
    if (due.length === 0) return;

    if (s.queues) {
      // Waiting out the debounce lets a burst land in one notice.
      const oldest = Math.min(...due.map((m) => Date.parse(m.sentAt)));
      if (!(now - oldest >= MIDTURN_DEBOUNCE_MS)) return;
      // One notice outstanding at a time: a second one before the first is read is noise. Exhausted
      // messages are excluded because they are already escalated; counting them would block forever.
      const outstanding = pending.some(
        (m) =>
          m.recipients[s.handle]?.status === 'noticed' &&
          !st.armed.has(m.messageId) &&
          !st.exhausted.has(m.messageId),
      );
      // An urgent message must not wait behind a normal notice that is still unread.
      const urgentDue = due.some(
        (m) => m.priority === 'urgent' && m.recipients[s.handle]?.status === 'queued',
      );
      if (outstanding && !urgentDue) return;
    }

    const verdict = await deps.precheck(s.sessionId);
    if (!verdict.open) {
      for (const m of due) {
        if (m.priority !== 'urgent' || st.urgentRaised.has(m.messageId)) continue;
        st.urgentRaised.add(m.messageId);
        deps.raise({ kind: 'urgent-waiting', handle: s.handle, messageId: m.messageId });
      }
      return;
    }

    const urgent = pending.some((m) => m.priority === 'urgent');
    const outcome = await deps.submit(s.sessionId, composeNotice(urgent), async (finalOutcome) => {
      if (finalOutcome === 'submitted') {
        lastNoticeAt.set(s.sessionId, deps.now());
        const ids = pending.map((m) => m.messageId);
        for (const id of ids) st.armed.delete(id);
        await deps.markNoticed(s.handle, ids);
      }
    });
    if (outcome === 'withheld') {
      deps.raise({ kind: 'unsent-notice', handle: s.handle });
    }
  }

  return {
    async tick() {
      const runs = deps.sessions().map(async (s) => {
        if (inFlight.has(s.sessionId)) return;
        inFlight.add(s.sessionId);
        try {
          await tickSession(s);
        } finally {
          inFlight.delete(s.sessionId);
        }
      });
      await Promise.all(runs);
    },
    forget(sessionId) {
      wasBusy.delete(sessionId);
      busyRoseAt.delete(sessionId);
      lastNoticeAt.delete(sessionId);
    },
    trackedIds() {
      let n = 0;
      for (const st of handles.values())
        n += st.armed.size + st.exhausted.size + st.urgentRaised.size;
      return n;
    },
  };
}
