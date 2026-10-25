import type { SubmitOutcome } from '../pty-writer';
import type { GateVerdict } from './notice-gate';
import { composeNotice } from './notice-text';
import type { Handle, StoredMessage } from './types';

export type AttentionRaise =
  | { kind: 'urgent-waiting'; handle: Handle; messageId: string }
  | { kind: 'unsent-notice'; handle: Handle }
  | { kind: 'unread-after-renotice'; handle: Handle; messageId: string };
export interface NotifierSession {
  sessionId: string;
  handle: Handle;
  busy: boolean;
}
export interface NotifierDeps {
  /** Notifiable adapters only. */
  sessions(): NotifierSession[];
  pending(handle: Handle): StoredMessage[];
  /** Decides only whether to TRY; the full gate runs again in the writer slot (plan ruling 1). */
  precheck(sessionId: string): Promise<GateVerdict>;
  submit(sessionId: string, text: string): Promise<SubmitOutcome>;
  markNoticed(handle: Handle, messageIds: string[]): Promise<void>;
  raise(item: AttentionRaise): void;
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

  async function tickSession(s: NotifierSession): Promise<void> {
    const pending = deps.pending(s.handle);
    const st = handleState(s.handle, pending);
    const live = new Set(pending.map((m) => m.messageId));
    for (const ids of [st.armed, st.exhausted, st.urgentRaised]) {
      for (const id of ids) if (!live.has(id)) ids.delete(id);
    }

    if (wasBusy.get(s.sessionId) === true && !s.busy) {
      for (const m of pending) {
        const r = m.recipients[s.handle];
        if (r?.status !== 'noticed') continue;
        if (r.noticeCount === 1) st.armed.add(m.messageId);
        else if (r.noticeCount >= 2 && !st.exhausted.has(m.messageId)) {
          st.exhausted.add(m.messageId);
          st.armed.delete(m.messageId);
          deps.raise({ kind: 'unread-after-renotice', handle: s.handle, messageId: m.messageId });
        }
      }
    }
    wasBusy.set(s.sessionId, s.busy);

    const due = pending.filter((m) => {
      if (m.priority === 'fyi' || st.exhausted.has(m.messageId)) return false;
      return m.recipients[s.handle]?.status === 'queued' || st.armed.has(m.messageId);
    });
    if (due.length === 0) return;

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
    const outcome = await deps.submit(s.sessionId, composeNotice(urgent));
    if (outcome === 'submitted') {
      const ids = pending.map((m) => m.messageId);
      for (const id of ids) st.armed.delete(id);
      await deps.markNoticed(s.handle, ids);
    } else if (outcome === 'withheld') {
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
    },
    trackedIds() {
      let n = 0;
      for (const st of handles.values())
        n += st.armed.size + st.exhausted.size + st.urgentRaised.size;
      return n;
    },
  };
}
