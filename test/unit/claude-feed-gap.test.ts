import { describe, expect, it } from 'vitest';
import { createClaudeFeedGap, FEED_GAP_SETTLE_MS } from '../../server/domain/claude-feed-gap';

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

const use = (uuid: string, toolUseId: string, name = 'Bash'): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    isSidechain: false,
    message: { content: [{ type: 'tool_use', id: toolUseId, name }] },
  });

function rig() {
  let transcript = '';
  let readCount = 0;
  let failAt: number | null = null;
  let failure: Error = new Error('unarmed');
  const ranges: Array<[number, number]> = [];
  const timers: Timer[] = [];
  const records: Array<{ sessionId: string; gap: number }> = [];
  const warnings: string[] = [];
  const gap = createClaudeFeedGap<Timer>({
    readRange: async (_path, start, end) => {
      ranges.push([start, end]);
      readCount += 1;
      if (readCount === failAt) {
        failAt = null;
        throw failure;
      }
      return Buffer.from(transcript, 'utf8').subarray(start, end);
    },
    sizeOf: () => Buffer.byteLength(transcript, 'utf8'),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cancelled = true;
    },
    record: (sessionId, n) => records.push({ sessionId, gap: n }),
    warn: (msg) => warnings.push(msg),
  });
  const append = (line: string): void => {
    transcript += `${line}\n`;
  };
  const replaceTranscript = (text: string): void => {
    transcript = text;
  };
  /** Fires the settle timers that are still live, then waits for the checks they queued. */
  const settle = async (): Promise<void> => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    await gap.settled();
  };
  return {
    gap,
    ranges,
    timers,
    records,
    warnings,
    append,
    replaceTranscript,
    settle,
    failRead: (nth: number, error: Error) => {
      failAt = readCount + nth;
      failure = error;
    },
  };
}

describe('claude feed gap', () => {
  it('schedules the check FEED_GAP_SETTLE_MS after a Stop', () => {
    const r = rig();
    r.gap.stop('s1', '/t/a.jsonl');
    expect(r.timers.map((t) => t.ms)).toEqual([3_000]);
    expect(FEED_GAP_SETTLE_MS).toBe(3_000);
  });

  it('takes a baseline on the first Stop and reports nothing', async () => {
    const r = rig();
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('reports no gap when every tool call since the last Stop has a post', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.post('s1', false, 't1');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
  });

  it('a lost post is a gap of one', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.append(use('u2', 't2'));
    r.gap.post('s1', false, 't1');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a post with agent_id does not match a main-session tool call', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.post('s1', true, 't1');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a late post for the ended turn, arriving inside the settle window, matches', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    r.gap.post('s1', false, 't1');
    await r.settle();
    expect(r.records).toEqual([]);
  });

  it('a tool call appended after the Stop is not in that span; its post may arrive after the check', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.post('s1', false, 't1');
    r.gap.stop('s1', '/t/a.jsonl');
    r.append(use('u2', 't2'));
    await r.settle();
    expect(r.records).toEqual([]);
    r.gap.post('s1', false, 't2');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
  });

  it('a transcript path change takes a fresh baseline, and the next Stop checks the new span', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/b.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    r.append(use('u2', 't2'));
    r.gap.stop('s1', '/t/b.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a file that shrank takes a baseline, not a count from the start', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.replaceTranscript('{}\n');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    r.append(use('u2', 't2'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it.each([
    ['fingerprint', 1],
    ['span', 2],
  ])(
    'a failed %s read warns with no gap row, and the next Stop counts from the old offset',
    async (_which, nth) => {
      const r = rig();
      r.append(use('u0', 't0'));
      r.gap.stop('s1', '/t/a.jsonl');
      await r.settle();
      r.append(use('u1', 't1'));
      r.failRead(nth, new Error('EIO'));
      r.gap.stop('s1', '/t/a.jsonl');
      await r.settle();
      expect(r.records).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      r.append(use('u2', 't2'));
      r.gap.stop('s1', '/t/a.jsonl');
      await r.settle();
      expect(r.records).toEqual([{ sessionId: 's1', gap: 2 }]);
      expect(r.warnings).toHaveLength(1);
    },
  );

  it('the fingerprint is the last 256 bytes of a longer last line, not the whole line', async () => {
    const r = rig();
    const long = JSON.stringify({
      type: 'assistant',
      uuid: 'u0',
      isSidechain: false,
      message: {
        content: [
          { type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'x'.repeat(1000) } },
        ],
      },
    });
    r.append(long);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    const end = Buffer.byteLength(`${long}\n`);
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.ranges.slice(1, 3)).toEqual([
      [end - 256, end],
      [end, end + use('u1', 't1').length + 1],
    ]);
  });

  it('the counts reset at each Stop', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.post('s1', false, 't1');
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u2', 't2'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('forget cancels the pending check and drops the session state', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    r.gap.forget('s1');
    expect(r.timers.at(-1)?.cancelled).toBe(true);
    await r.settle();
    expect(r.records).toEqual([]);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u2', 't2'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it("a second check re-reads the last line's tail, then reads only the appended bytes", async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    const firstEnd = r.ranges.at(-1)?.[1] ?? -1;
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.ranges).toEqual([
      [0, firstEnd],
      [0, firstEnd],
      [firstEnd, firstEnd + use('u1', 't1').length + 1],
    ]);
  });

  it('a file replaced at the same path by a longer one takes a baseline, not a false gap', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.replaceTranscript(`${use('x0', 'z0')}\n${use('x1', 'z1')}\n${use('x2', 'z2')}\n`);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.warnings).toEqual([]);
    r.append(use('x3', 'z3'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a line cut at the Stop is counted exactly once, on the check after its newline lands', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    const whole = use('u1', 't1');
    const cut = whole.slice(0, 30);
    r.replaceTranscript(`${use('u0', 't0')}\n${cut}`);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    r.replaceTranscript(`${use('u0', 't0')}\n${whole}\n`);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a baseline prunes the posts for the calls it scanned', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.post('s1', false, 't0');
    expect(r.gap.receivedCount('s1')).toBe(1);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.gap.receivedCount('s1')).toBe(0);
  });

  it('caps the received posts at 1000 and drops the oldest, keeping the newest', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.gap.post('s1', false, 'old');
    for (let i = 0; i < 1000; i += 1) r.gap.post('s1', false, `x${i}`);
    expect(r.gap.receivedCount('s1')).toBe(1000);
    r.append(use('u1', 'old'));
    r.append(use('u2', 'x999'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });
});
