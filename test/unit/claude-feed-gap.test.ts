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
  let recordFailure: Error | null = null;
  let hangAt: number | null = null;
  let release: (() => void) | null = null;
  let hangSizeNext = false;
  let sizeFailure: Error | null = null;
  const ranges: Array<[number, number]> = [];
  const timers: Timer[] = [];
  const records: Array<{ sessionId: string; gap: number }> = [];
  const warnings: string[] = [];
  const gap = createClaudeFeedGap<Timer>({
    readRange: async (_path, start, end) => {
      ranges.push([start, end]);
      readCount += 1;
      if (readCount === hangAt) {
        hangAt = null;
        return new Promise<Buffer>((resolve) => {
          release = () => resolve(Buffer.from(transcript, 'utf8').subarray(start, end));
        });
      }
      if (readCount === failAt) {
        failAt = null;
        throw failure;
      }
      return Buffer.from(transcript, 'utf8').subarray(start, end);
    },
    sizeOf: async () => {
      if (sizeFailure !== null) {
        const failure = sizeFailure;
        sizeFailure = null;
        throw failure;
      }
      if (hangSizeNext) {
        hangSizeNext = false;
        return new Promise<number>(() => {});
      }
      return Buffer.byteLength(transcript, 'utf8');
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cancelled = true;
    },
    record: (sessionId, n) => {
      if (recordFailure !== null) {
        const failure = recordFailure;
        recordFailure = null;
        throw failure;
      }
      records.push({ sessionId, gap: n });
    },
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
    failNextRecord: (error: Error) => {
      recordFailure = error;
    },
    hangRead: (nth: number) => {
      hangAt = readCount + nth;
    },
    hangSizeNext: () => {
      hangSizeNext = true;
    },
    failSizeNext: (error: Error) => {
      sizeFailure = error;
    },
    releaseHungRead: () => {
      release?.();
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

  it('a baseline on a long transcript reads only its 64 KiB tail, and the offset lands after the last line', async () => {
    const r = rig();
    const filler = `${JSON.stringify({ type: 'user', text: 'f'.repeat(1000) })}\n`;
    r.replaceTranscript(filler.repeat(200));
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    const size = Buffer.byteLength(`${filler.repeat(200)}${use('u0', 't0')}\n`);
    expect(r.ranges).toEqual([[size - 65_536, size]]);
    expect(r.records).toEqual([]);
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a span over 32 MiB is a baseline: no gap is reported, and the check reads only the tail', async () => {
    const r = rig();
    const head = `${use('u0', 't0')}\n`;
    r.replaceTranscript(head);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    const huge = JSON.stringify({
      type: 'assistant',
      uuid: 'big',
      message: {
        content: [
          { type: 'tool_use', id: 'ghost', name: 'Bash' },
          { type: 'text', text: 'z'.repeat(33 * 1024 * 1024) },
        ],
      },
    });
    const body = `${head}${huge}\n`;
    r.replaceTranscript(body);
    const size = Buffer.byteLength(body);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.ranges.at(-1)).toEqual([size - 65_536, size]);
    r.append(use('u1', 't1'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a check that throws warns and never stalls the queue: the next Stop still checks', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.failNextRecord(new Error('sink full'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    r.append(use('u2', 't2'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 2 }]);
    expect(r.warnings).toHaveLength(1);
  });

  it('a failed record keeps the matched posts, so the retry still counts the calls they cover', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.append(use('u2', 't2'));
    r.gap.post('s1', false, 't1');
    r.failNextRecord(new Error('sink full'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a hung check times out, warns, and the queue moves on to the next session', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('b', '/t/b.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.hangRead(1);
    r.gap.stop('a', '/t/a.jsonl');
    r.gap.stop('b', '/t/b.jsonl');
    for (const t of r.timers.filter((x) => x.ms === 3_000 && !x.cancelled)) t.fn();
    await flushMicrotasks();
    for (const t of r.timers.filter((x) => x.ms === 10_000 && !x.cancelled)) t.fn();
    await r.gap.settled();
    expect(r.records).toEqual([{ sessionId: 'b', gap: 1 }]);
    expect(r.warnings.some((w) => w.includes('timed out'))).toBe(true);
  });

  it('a timed-out check that finishes late writes nothing, so the next Stop counts from the old offset', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.hangRead(2);
    r.gap.stop('s1', '/t/a.jsonl');
    for (const t of r.timers.filter((x) => x.ms === 3_000 && !x.cancelled)) t.fn();
    await flushMicrotasks();
    for (const t of r.timers.filter((x) => x.ms === 10_000 && !x.cancelled)) t.fn();
    await flushMicrotasks();
    r.releaseHungRead();
    await flushMicrotasks();
    expect(r.records).toEqual([]);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a size lookup that never resolves times out, and the queue moves on to the next session', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('b', '/t/b.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.hangSizeNext();
    r.gap.stop('a', '/t/a.jsonl');
    r.gap.stop('b', '/t/b.jsonl');
    for (const t of r.timers.filter((x) => x.ms === 3_000 && !x.cancelled)) t.fn();
    await flushMicrotasks();
    for (const t of r.timers.filter((x) => x.ms === 10_000 && !x.cancelled)) t.fn();
    await r.gap.settled();
    expect(r.records).toEqual([{ sessionId: 'b', gap: 1 }]);
    expect(r.warnings).toContain('feed gap check timed out; later checks continue');
  });

  it('a transcript that cannot be statted warns and is not checked', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.failSizeNext(new Error('ENOENT'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.warnings).toEqual(['transcript not statable; feed gap not checked']);
    expect(r.ranges).toEqual([]);
  });

  it('dispose cancels the timeout of a check that is still running', async () => {
    const r = rig();
    r.append(use('u0', 't0'));
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.append(use('u1', 't1'));
    r.hangRead(1);
    r.gap.stop('s1', '/t/a.jsonl');
    for (const t of r.timers.filter((x) => x.ms === 3_000 && !x.cancelled)) t.fn();
    await flushMicrotasks();
    r.gap.dispose();
    expect(r.timers.filter((x) => x.ms === 10_000).every((x) => x.cancelled)).toBe(true);
  });
});

/** Lets the queued check start, since the test drives timers directly rather than through settle(). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
