import { describe, expect, it } from 'vitest';
import { createClaudeFeedGap, FEED_GAP_SETTLE_MS } from '../../server/domain/claude-feed-gap';

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

const toolLine = (uuid: string, names: string[]): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    isSidechain: false,
    message: { content: names.map((name) => ({ type: 'tool_use', name })) },
  });

function rig() {
  let transcript = '';
  let readError: Error | null = null;
  const timers: Timer[] = [];
  const records: Array<{ sessionId: string; gap: number }> = [];
  const warnings: Array<{ msg: string; data?: object }> = [];
  const gap = createClaudeFeedGap<Timer>({
    readFile: async () => {
      if (readError) throw readError;
      return transcript;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cancelled = true;
    },
    record: (sessionId, n) => records.push({ sessionId, gap: n }),
    warn: (msg, data) => warnings.push({ msg, data }),
  });
  const appendTools = (uuid: string, names: string[]) => {
    transcript += `${toolLine(uuid, names)}\n`;
  };
  /** Fires every pending settle timer, then waits for the checks they started. */
  const settle = async () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    await gap.settled();
  };
  return {
    gap,
    timers,
    records,
    warnings,
    appendTools,
    settle,
    setReadError: (e: Error | null) => {
      readError = e;
    },
  };
}

describe('claude feed gap', () => {
  it('schedules the check FEED_GAP_SETTLE_MS after a Stop', () => {
    const r = rig();
    r.gap.stop('s1', '/t/a.jsonl');
    expect(r.timers.map((t) => t.ms)).toEqual([FEED_GAP_SETTLE_MS]);
    expect(FEED_GAP_SETTLE_MS).toBe(3_000);
  });

  it('takes a baseline on the first Stop and reports nothing', async () => {
    const r = rig();
    r.appendTools('u1', ['Bash', 'Edit']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('reports no gap when the posts match the tool calls since the last Stop', async () => {
    const r = rig();
    r.appendTools('u1', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash']);
    r.gap.post('s1', false);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
  });

  it('records a gap note for the calls whose posts never arrived', async () => {
    const r = rig();
    r.appendTools('u1', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash', 'Edit']);
    r.gap.post('s1', false);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a post with agent_id does not count toward the main session', async () => {
    const r = rig();
    r.appendTools('u1', []);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash']);
    r.gap.post('s1', true);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a post that lands inside the settle window counts', async () => {
    const r = rig();
    r.appendTools('u1', []);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    r.gap.post('s1', false);
    await r.settle();
    expect(r.records).toEqual([]);
  });

  it('a transcript path change takes a fresh baseline, then the next Stop checks it', async () => {
    const r = rig();
    r.appendTools('u1', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash', 'Bash', 'Bash']);
    r.gap.stop('s1', '/t/b.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    r.appendTools('u3', ['Write']);
    r.gap.stop('s1', '/t/b.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });

  it('a transcript read failure warns with no gap row', async () => {
    const r = rig();
    r.appendTools('u1', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.setReadError(new Error('ENOENT'));
    r.appendTools('u2', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ msg: expect.any(String) })]);
  });

  it('the counts reset at each Stop', async () => {
    const r = rig();
    r.appendTools('u1', []);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u2', ['Bash']);
    r.gap.post('s1', false);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    r.appendTools('u3', ['Bash']);
    r.gap.stop('s1', '/t/a.jsonl');
    await r.settle();
    expect(r.records).toEqual([{ sessionId: 's1', gap: 1 }]);
  });
});
