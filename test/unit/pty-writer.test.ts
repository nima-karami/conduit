import { describe, expect, it } from 'vitest';
import {
  createPtyWriter,
  ECHO_MAX_MS,
  ECHO_QUIET_MS,
  ENTER_FLOOR_MS,
  type PtyWriterDeps,
} from '../../src/pty-writer';

interface Gap {
  ms: number;
  release(): void;
}

interface Quiet {
  sessionId: string;
  quietMs: number;
  maxMs: number;
  release(): void;
}

function harness() {
  const log: Array<[string, string]> = [];
  const gens = new Map<string, number>([
    ['a', 1],
    ['b', 1],
  ]);
  const gaps: Gap[] = [];
  const quiets: Quiet[] = [];
  let failWrites = false;
  const deps: PtyWriterDeps = {
    generation: (id) => gens.get(id),
    input: (id, data) => {
      if (failWrites) return false;
      log.push([id, data]);
      return true;
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        gaps.push({ ms, release: resolve });
      }),
    outputQuiet: (sessionId, quietMs, maxMs) =>
      new Promise<void>((resolve) => {
        quiets.push({ sessionId, quietMs, maxMs, release: resolve });
      }),
  };
  const writer = createPtyWriter(deps);
  /** Let every queued microtask (slot hand-offs, hook awaits) run. */
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const releaseSleep = async () => {
    await flush();
    const g = gaps.shift();
    if (!g) throw new Error('no pending gap');
    g.release();
    await flush();
  };
  const releaseQuiet = async () => {
    await flush();
    const q = quiets.shift();
    if (!q) throw new Error('no pending quiet wait');
    q.release();
    await flush();
  };
  const releaseGap = async () => {
    await flush();
    const g = gaps.shift();
    if (!g) throw new Error('no pending gap');
    g.release();
    quiets.shift()?.release();
    await flush();
  };
  return {
    writer,
    log,
    gens,
    gaps,
    quiets,
    flush,
    releaseSleep,
    releaseQuiet,
    releaseGap,
    failWrites: () => {
      failWrites = true;
    },
  };
}

const writes = (log: Array<[string, string]>, id: string) =>
  log.filter(([s]) => s === id).map(([, d]) => d);

describe('createPtyWriter', () => {
  it('text, gap, then \\r', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'hi');
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['hi']);
    expect(h.gaps.map((g) => g.ms)).toEqual([ENTER_FLOOR_MS]);
    await h.releaseGap();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['hi', '\r']);
  });

  it('wraps a bracketed paste in one write', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'l1\nl2', { bracketed: true });
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['\x1b[200~l1\nl2\x1b[201~']);
    await h.releaseGap();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['\x1b[200~l1\nl2\x1b[201~', '\r']);
  });

  it('unbracketed writes the text as is', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'l1\nl2', { bracketed: false });
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['l1\nl2']);
    await h.releaseGap();
    expect(await p).toBe('submitted');
  });

  it('waits for outputQuiet and the 120 ms floor before Enter', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'hi');
    await h.flush();
    expect(h.gaps.map((g) => g.ms)).toEqual([ENTER_FLOOR_MS]);
    expect(h.quiets.map((q) => [q.sessionId, q.quietMs, q.maxMs])).toEqual([
      ['a', ECHO_QUIET_MS, ECHO_MAX_MS],
    ]);
    await h.releaseQuiet();
    expect(writes(h.log, 'a')).toEqual(['hi']);
    await h.releaseSleep();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['hi', '\r']);
  });

  it('generation change during the quiet wait withholds Enter', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'x');
    await h.flush();
    await h.releaseSleep();
    h.gens.set('a', 2);
    await h.releaseQuiet();
    expect(await p).toBe('generation-changed');
    expect(writes(h.log, 'a')).toEqual(['x']);
  });

  it('two submits on one session never interleave', async () => {
    const h = harness();
    const pa = h.writer.submit('a', 'a');
    const pb = h.writer.submit('a', 'b');
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['a']);
    await h.releaseGap();
    await h.releaseGap();
    expect(await pa).toBe('submitted');
    expect(await pb).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['a', '\r', 'b', '\r']);
  });

  it('beforeText runs inside the slot', async () => {
    const h = harness();
    let bCalledAt = -1;
    const pa = h.writer.submit('a', 'A');
    const pb = h.writer.submit('a', 'B', {
      beforeText: () => {
        bCalledAt = h.log.length;
        return true;
      },
    });
    await h.flush();
    expect(bCalledAt).toBe(-1);
    await h.releaseGap();
    expect(bCalledAt).toBe(2);
    expect(h.log[1]).toEqual(['a', '\r']);
    await h.releaseGap();
    await Promise.all([pa, pb]);
  });

  it('beforeText false → gate-closed, nothing written', async () => {
    const h = harness();
    expect(await h.writer.submit('a', 'x', { beforeText: () => false })).toBe('gate-closed');
    expect(h.log).toEqual([]);
    expect(h.gaps).toEqual([]);
  });

  it('a respawn while beforeText awaits → generation-changed, nothing written', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'x', {
      beforeText: async () => {
        h.gens.set('a', 2);
        return true;
      },
    });
    await h.flush();
    expect(h.log).toEqual([]);
    expect(await p).toBe('generation-changed');
  });

  it('different sessions do not block each other', async () => {
    const h = harness();
    const pa = h.writer.submit('a', 'x');
    const pb = h.writer.submit('b', 'y');
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['x']);
    expect(writes(h.log, 'b')).toEqual(['y']);
    expect(h.gaps).toHaveLength(2);
    await h.releaseGap();
    await h.releaseGap();
    expect(await pa).toBe('submitted');
    expect(await pb).toBe('submitted');
  });

  it('generation change in the gap → no \\r', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'x');
    await h.flush();
    h.gens.set('a', 2);
    await h.releaseGap();
    expect(await p).toBe('generation-changed');
    expect(writes(h.log, 'a')).toEqual(['x']);
  });

  it('a respawn while beforeEnter awaits → generation-changed, no \\r', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'x', {
      beforeEnter: async () => {
        h.gens.set('a', 2);
        return true;
      },
    });
    await h.releaseGap();
    expect(await p).toBe('generation-changed');
    expect(writes(h.log, 'a')).toEqual(['x']);
  });

  it('beforeEnter false → withheld, no \\r', async () => {
    const h = harness();
    const p = h.writer.submit('a', 'x', { beforeEnter: async () => false });
    await h.releaseGap();
    expect(await p).toBe('withheld');
    expect(writes(h.log, 'a')).toEqual(['x']);
  });

  it('a rejected hook does not break the chain', async () => {
    const h = harness();
    const p1 = h.writer.submit('a', 'x', {
      beforeText: () => Promise.reject(new Error('boom')),
    });
    const p2 = h.writer.submit('a', 'y', {
      beforeEnter: () => {
        throw new Error('boom');
      },
    });
    const p3 = h.writer.submit('a', 'z');
    expect(await p1).toBe('gate-closed');
    await h.releaseGap();
    expect(await p2).toBe('withheld');
    await h.releaseGap();
    expect(await p3).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['y', 'z', '\r']);
  });

  it('no pty → no-pty', async () => {
    const h = harness();
    expect(await h.writer.submit('nope', 'x')).toBe('no-pty');
    expect(h.log).toEqual([]);
  });

  it('a failed write → write-failed', async () => {
    const h = harness();
    h.failWrites();
    expect(await h.writer.submit('a', 'x')).toBe('write-failed');
  });

  it('a submit after forget still runs', async () => {
    const h = harness();
    h.writer.forget('a');
    const p = h.writer.submit('a', 'y');
    await h.releaseGap();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['y', '\r']);
  });

  it('serializes input writes and waits the submit gap before Enter', async () => {
    const h = harness();
    const sequence = Reflect.get(h.writer, 'sequence');
    expect(typeof sequence).toBe('function');
    const p = sequence(
      'a',
      () => {
        h.log.push(['a', 'text']);
        return true;
      },
      { submit: true },
    );
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['text']);
    expect(h.gaps.map((g) => g.ms)).toEqual([ENTER_FLOOR_MS]);
    await h.releaseGap();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['text', '\r']);
  });

  it('sequence waits outputQuiet as well before Enter', async () => {
    const h = harness();
    const p = h.writer.sequence(
      'a',
      () => {
        h.log.push(['a', 'text']);
        return true;
      },
      { submit: true },
    );
    await h.flush();
    expect(h.gaps.map((g) => g.ms)).toEqual([ENTER_FLOOR_MS]);
    expect(h.quiets.map((q) => [q.sessionId, q.quietMs, q.maxMs])).toEqual([
      ['a', ECHO_QUIET_MS, ECHO_MAX_MS],
    ]);
    await h.releaseQuiet();
    expect(writes(h.log, 'a')).toEqual(['text']);
    await h.releaseSleep();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['text', '\r']);
  });
  it('keeps a queued sequence outside another submit and drops a stale Enter', async () => {
    const h = harness();
    const first = h.writer.submit('a', 'first');
    const second = h.writer.sequence(
      'a',
      () => {
        h.log.push(['a', 'second']);
        return true;
      },
      { submit: true },
    );
    await h.flush();
    expect(writes(h.log, 'a')).toEqual(['first']);
    await h.releaseGap();
    expect(await first).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['first', '\r', 'second']);
    h.gens.set('a', 2);
    await h.releaseGap();
    expect(await second).toBe('generation-changed');
    expect(writes(h.log, 'a')).toEqual(['first', '\r', 'second']);
  });
  it('submitEnter sends only the submit key', async () => {
    const h = harness();
    expect(await h.writer.submitEnter('a')).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['\r']);
  });

  it('submitEnter gates inside the slot', async () => {
    const h = harness();
    let gated = false;
    const ahead = h.writer.submit('a', 'queued-ahead');
    const p = h.writer.submitEnter('a', {
      beforeEnter: () => {
        gated = true;
        return true;
      },
    });
    await h.flush();
    expect(gated).toBe(false);
    expect(writes(h.log, 'a')).toEqual(['queued-ahead']);
    await h.releaseGap();
    expect(await ahead).toBe('submitted');
    expect(gated).toBe(true);
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['queued-ahead', '\r', '\r']);
  });

  it('submitEnter with a closed gate → withheld, no \r', async () => {
    const h = harness();
    expect(await h.writer.submitEnter('a', { beforeEnter: () => false })).toBe('withheld');
    expect(h.log).toEqual([]);
  });

  it('submitEnter queued behind a running submit: human key in the gap → withheld', async () => {
    const h = harness();
    let allowEnter = true;
    const p1 = h.writer.submit('a', 'x');
    const p2 = h.writer.submitEnter('a', {
      beforeEnter: () => allowEnter,
    });
    await h.flush();
    allowEnter = false;
    await h.releaseGap();
    expect(await p1).toBe('submitted');
    expect(await p2).toBe('withheld');
    expect(writes(h.log, 'a')).toEqual(['x', '\r']);
  });

  it('submitEnter with no pty → no-pty', async () => {
    const h = harness();
    expect(await h.writer.submitEnter('nope')).toBe('no-pty');
    expect(h.log).toEqual([]);
  });

  it('submitEnter hook respawns the session and returns true → generation-changed, no \\r', async () => {
    const h = harness();
    const p = h.writer.submitEnter('a', {
      beforeEnter: () => {
        h.gens.set('a', 2);
        return true;
      },
    });
    await h.flush();
    expect(await p).toBe('generation-changed');
    expect(h.log).toEqual([]);
  });

  it('submitEnter hook sees a respawn inside the slot → withheld', async () => {
    const h = harness();
    const p1 = h.writer.submit('a', 'x');
    const p2 = h.writer.submitEnter('a', {
      beforeEnter: async () => h.gens.get('a') === 1,
    });
    await h.flush();
    h.gens.set('a', 2);
    await h.releaseGap();
    expect(await p1).toBe('generation-changed');
    expect(await p2).toBe('withheld');
    expect(writes(h.log, 'a')).toEqual(['x']);
  });

  it('a failed submitEnter write → write-failed', async () => {
    const h = harness();
    h.failWrites();
    expect(await h.writer.submitEnter('a')).toBe('write-failed');
  });
});
