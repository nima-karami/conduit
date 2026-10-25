import { describe, expect, it } from 'vitest';
import type { GateVerdict } from '../../src/conduit-mcp/notice-gate';
import { composeNotice } from '../../src/conduit-mcp/notice-text';
import {
  type AttentionRaise,
  createNotifier,
  type NotifierSession,
} from '../../src/conduit-mcp/notifier';
import type { Priority, StoredMessage } from '../../src/conduit-mcp/types';
import type { SubmitOutcome } from '../../src/pty-writer';

const H = 'codex-2';
const S = 's2';

function harness(opts: { rearmAll?: boolean } = {}) {
  const msgs: StoredMessage[] = [];
  const session: NotifierSession = { sessionId: S, handle: H, busy: false };
  let gate: GateVerdict = { open: true };
  let outcome: SubmitOutcome = 'submitted';
  let submitDelay: Promise<void> | null = null;
  const submits: string[] = [];
  const raises: AttentionRaise[] = [];
  const marked: string[][] = [];
  let n = 0;

  const add = (priority: Priority, status: 'queued' | 'noticed' = 'queued', noticeCount = 0) => {
    n += 1;
    const m: StoredMessage = {
      messageId: `m_${n}`,
      threadId: 't_1',
      from: 'claude-1',
      to: [H],
      subject: '',
      kind: 'inform',
      priority,
      sentAt: new Date(Date.UTC(2026, 9, 25, 0, 0, n)).toISOString(),
      body: 'secret peer text',
      attachments: [],
      recipients: { [H]: { status, noticeCount, updatedAt: '' } },
      expired: false,
    };
    msgs.push(m);
    return m;
  };
  const read = (m: StoredMessage) => {
    m.recipients[H] = { ...m.recipients[H], status: 'read' };
  };

  const notifier = createNotifier(
    {
      sessions: () => [session],
      pending: (h) =>
        msgs.filter((m) => {
          const s = m.recipients[h]?.status;
          return s === 'queued' || s === 'noticed';
        }),
      precheck: async () => gate,
      submit: async (_id, text) => {
        submits.push(text);
        if (submitDelay) await submitDelay;
        return outcome;
      },
      markNoticed: async (h, ids) => {
        marked.push(ids);
        for (const m of msgs) {
          if (!ids.includes(m.messageId)) continue;
          const r = m.recipients[h];
          m.recipients[h] = { ...r, status: 'noticed', noticeCount: r.noticeCount + 1 };
        }
      },
      raise: (item) => raises.push(item),
    },
    { rearmAll: opts.rearmAll ?? false },
  );

  return {
    notifier,
    session,
    add,
    read,
    submits,
    raises,
    marked,
    setGate: (g: GateVerdict) => {
      gate = g;
    },
    setOutcome: (o: SubmitOutcome) => {
      outcome = o;
    },
    holdSubmit: () => {
      let release = () => {};
      submitDelay = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        submitDelay = null;
        release();
      };
    },
    /** A busy→idle cycle across two ticks. */
    cycle: async () => {
      session.busy = true;
      await notifier.tick();
      session.busy = false;
      await notifier.tick();
    },
  };
}

const CLOSED: GateVerdict = { open: false, reason: 'busy' };

describe('createNotifier', () => {
  it('two sends while closed → one notice when open', async () => {
    const h = harness();
    h.setGate(CLOSED);
    const a = h.add('normal');
    const b = h.add('normal');
    await h.notifier.tick();
    h.setGate({ open: true });
    await h.notifier.tick();
    await h.notifier.tick();
    expect(h.submits).toEqual([composeNotice(false)]);
    expect(h.marked).toEqual([[a.messageId, b.messageId]]);
  });

  it('precheck closed → no submit', async () => {
    const h = harness();
    h.setGate(CLOSED);
    h.add('normal');
    await h.notifier.tick();
    expect(h.submits).toEqual([]);
    expect(h.raises).toEqual([]);
  });

  it('gate-closed outcome (closed in the slot) → stays due, no raise', async () => {
    const h = harness();
    h.add('urgent');
    h.setOutcome('gate-closed');
    await h.notifier.tick();
    expect(h.marked).toEqual([]);
    expect(h.raises).toEqual([]);
    h.setOutcome('submitted');
    await h.notifier.tick();
    expect(h.submits).toHaveLength(2);
    expect(h.marked).toHaveLength(1);
  });

  it('fyi alone never notices; fyi rides the next notice and is marked noticed', async () => {
    const h = harness();
    const f = h.add('fyi');
    await h.notifier.tick();
    expect(h.submits).toEqual([]);
    const m = h.add('normal');
    await h.notifier.tick();
    expect(h.submits).toHaveLength(1);
    expect(h.marked).toEqual([[f.messageId, m.messageId]]);
  });

  it('urgent while closed raises urgent-waiting once', async () => {
    const h = harness();
    h.setGate(CLOSED);
    const u = h.add('urgent');
    h.add('normal');
    await h.notifier.tick();
    await h.notifier.tick();
    expect(h.raises).toEqual([{ kind: 'urgent-waiting', handle: H, messageId: u.messageId }]);
  });

  it('urgent text when any pending urgent', async () => {
    const h = harness();
    h.add('fyi');
    h.add('urgent');
    await h.notifier.tick();
    expect(h.submits).toEqual([composeNotice(true)]);
    expect(h.submits[0]).not.toContain('secret');
  });

  it('withheld → unsent-notice, nothing marked', async () => {
    const h = harness();
    h.add('normal');
    h.setOutcome('withheld');
    await h.notifier.tick();
    expect(h.raises).toEqual([{ kind: 'unsent-notice', handle: H }]);
    expect(h.marked).toEqual([]);
  });

  it.each(['generation-changed', 'no-pty', 'write-failed'] as const)(
    '%s → stays due, nothing raised',
    async (o) => {
      const h = harness();
      h.add('normal');
      h.setOutcome(o);
      await h.notifier.tick();
      expect(h.marked).toEqual([]);
      expect(h.raises).toEqual([]);
      h.setOutcome('submitted');
      await h.notifier.tick();
      expect(h.marked).toHaveLength(1);
    },
  );

  it('a noticed message is not due again without a busy→idle cycle', async () => {
    const h = harness();
    h.add('normal');
    await h.notifier.tick();
    await h.notifier.tick();
    expect(h.submits).toHaveLength(1);
  });

  it('busy→idle after notice, still unread → re-notice once', async () => {
    const h = harness();
    const m = h.add('normal');
    await h.notifier.tick();
    await h.cycle();
    expect(h.submits).toHaveLength(2);
    expect(m.recipients[H].noticeCount).toBe(2);
    await h.notifier.tick();
    expect(h.submits).toHaveLength(2);
  });

  it('a message read after its notice is not re-noticed', async () => {
    const h = harness();
    const m = h.add('normal');
    await h.notifier.tick();
    h.read(m);
    await h.cycle();
    expect(h.submits).toHaveLength(1);
  });

  it('a second cycle unread → unread-after-renotice once, never due again', async () => {
    const h = harness();
    const m = h.add('normal');
    await h.notifier.tick();
    await h.cycle();
    await h.cycle();
    await h.cycle();
    expect(h.submits).toHaveLength(2);
    expect(h.raises).toEqual([
      { kind: 'unread-after-renotice', handle: H, messageId: m.messageId },
    ]);
  });

  it('per-message state is dropped once the message leaves pending', async () => {
    const h = harness();
    h.setGate(CLOSED);
    const a = h.add('urgent');
    const b = h.add('normal', 'noticed', 1);
    await h.notifier.tick();
    await h.cycle();
    expect(h.notifier.trackedIds()).toBe(2);
    h.read(a);
    h.read(b);
    await h.notifier.tick();
    expect(h.notifier.trackedIds()).toBe(0);
  });

  it('rearmAll arms noticed pending', async () => {
    const plain = harness();
    plain.add('normal', 'noticed', 1);
    await plain.notifier.tick();
    expect(plain.submits).toEqual([]);

    const h = harness({ rearmAll: true });
    h.add('normal', 'noticed', 1);
    await h.notifier.tick();
    expect(h.submits).toHaveLength(1);
  });

  it('no overlapping ticks per session', async () => {
    const h = harness();
    h.add('normal');
    const release = h.holdSubmit();
    const first = h.notifier.tick();
    await new Promise((r) => setTimeout(r, 0));
    const second = h.notifier.tick();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);
    expect(h.submits).toHaveLength(1);
  });
});
