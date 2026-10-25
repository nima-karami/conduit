import { describe, expect, it } from 'vitest';
import { createPtyWriter, type PtyWriterDeps } from '../../src/pty-writer';

interface Gap {
  ms: number;
  release(): void;
}

function harness() {
  const log: Array<[string, string]> = [];
  const gens = new Map<string, number>([
    ['a', 1],
    ['b', 1],
  ]);
  const gaps: Gap[] = [];
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
    gapMs: 120,
  };
  const writer = createPtyWriter(deps);
  /** Let every queued microtask (slot hand-offs, hook awaits) run. */
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  /** Release the oldest pending gap, then flush. */
  const releaseGap = async () => {
    await flush();
    const g = gaps.shift();
    if (!g) throw new Error('no pending gap');
    g.release();
    await flush();
  };
  return {
    writer,
    log,
    gens,
    gaps,
    flush,
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
    expect(h.gaps.map((g) => g.ms)).toEqual([120]);
    await h.releaseGap();
    expect(await p).toBe('submitted');
    expect(writes(h.log, 'a')).toEqual(['hi', '\r']);
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
});
