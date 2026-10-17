import { describe, expect, it } from 'vitest';
import {
  type IndexChunk,
  type IndexMode,
  indexQueueSlot,
  planIndexPass,
  type RootIndexState,
  takeChunks,
  wantsFullIndex,
} from '../../src/index-streams';

const A = 1;
const B = 2;

/** One host pass, as electron/main.ts runs it: plan, then cut and "send" each window's chunks. */
function pass(
  state: RootIndexState,
  requester: number | null,
  mode: IndexMode,
  selected: string[],
  repoSet: string | null = '',
): Map<number, IndexChunk[]> {
  const plans = planIndexPass(state, {
    requester,
    mode,
    repoSet,
    selected,
    fullOrder: selected,
  });
  const out = new Map<number, IndexChunk[]>();
  for (const plan of plans) {
    const stream = state.streams.get(plan.windowId);
    if (stream) out.set(plan.windowId, takeChunks(plan, stream, 2));
  }
  return out;
}

const fresh = (): RootIndexState => ({ repoSet: '', streams: new Map() });
const pathsOf = (chunks: IndexChunk[] | undefined) => (chunks ?? []).flatMap((c) => c.paths);

describe('per-window index streams (search-scope review r3 SF-B)', () => {
  it("B's full index while A has files pending: A still gets them, its own stream untouched", () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts']);
    // late.ts appears; A's top-up has not run yet when B opens the root.
    const second = pass(s, B, 'full', ['/w/a.ts', '/w/late.ts']);
    expect(pathsOf(second.get(B))).toEqual(['/w/a.ts', '/w/late.ts']);
    expect(second.get(B)?.[0]).toMatchObject({ seq: 0, tsconfig: true });
    expect(pathsOf(second.get(A))).toEqual(['/w/late.ts']);
    expect(second.get(A)?.[0]?.seq).toBe(1);
    expect(second.get(A)?.[0]?.tsconfig).toBe(false);
    // Nothing is left owed to either window.
    expect(pass(s, A, 'incremental', ['/w/a.ts', '/w/late.ts']).size).toBe(0);
  });

  it("A's top-up diffs against A's own sent, not what B's stream put in", () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts']);
    pass(s, B, 'full', ['/w/a.ts']);
    // Only B resolved this module on demand.
    s.streams.get(B)?.sent.add('/w/dep.ts');
    const topup = pass(s, A, 'incremental', ['/w/a.ts', '/w/dep.ts']);
    expect(pathsOf(topup.get(A))).toEqual(['/w/dep.ts']);
    expect(topup.has(B)).toBe(false);
  });

  it('a reloaded renderer gets the seq-0 chunk with the tsconfig again, and only it is reset', () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
    pass(s, B, 'full', ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
    const bSeq = s.streams.get(B)?.nextSeq;
    const reload = pass(s, A, 'full', ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
    expect(reload.get(A)?.map((c) => c.seq)).toEqual([0, 1]);
    expect(reload.get(A)?.[0]).toMatchObject({ tsconfig: true, paths: ['/w/a.ts', '/w/b.ts'] });
    expect(reload.has(B)).toBe(false);
    expect(s.streams.get(B)?.nextSeq).toBe(bSeq);
  });

  it("a top-up from a window with no stream (a reload's first ask) is a full index for it", () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts']);
    expect(wantsFullIndex(s, B, 'incremental')).toBe(true);
    expect(wantsFullIndex(s, A, 'incremental')).toBe(false);
    expect(wantsFullIndex(s, null, 'resync')).toBe(false);
    const late = pass(s, B, 'incremental', ['/w/a.ts']);
    expect(late.get(B)?.[0]).toMatchObject({ seq: 0, tsconfig: true, paths: ['/w/a.ts'] });
  });

  it('a repo set change re-syncs every window against its own sent', () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/r/a.ts', '/w/r/gen/y.ts']);
    pass(s, B, 'full', ['/w/r/a.ts']);
    s.streams.get(B)?.sent.add('/w/r/gen/y.ts');
    s.streams.get(B)?.resolved.add('/w/r/gen/y.ts');
    const resync = pass(s, null, 'incremental', ['/w/r/a.ts'], '/w/r');
    expect(resync.get(A)?.[0]?.removed).toEqual(['/w/r/gen/y.ts']);
    expect(resync.get(A)?.[0]?.paths).toEqual([]);
    // B's copy came from a module resolution, so it stays.
    expect(resync.has(B)).toBe(false);
    expect(s.repoSet).toBe('/w/r');
  });

  it('a host pass for a root no window streams plans nothing', () => {
    expect(pass(fresh(), null, 'resync', ['/w/a.ts']).size).toBe(0);
  });
});

describe('index queue coalescing (search-scope review r4 SF-B)', () => {
  it('a top-up from a window that holds a stream joins the shared top-up', () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts']);
    pass(s, B, 'full', ['/w/a.ts']);
    expect(indexQueueSlot(s, A, 'incremental')).toBe(indexQueueSlot(s, B, 'incremental'));
    expect(indexQueueSlot(s, null, 'resync')).toBe(indexQueueSlot(s, null, 'resync'));
  });

  it("a top-up from a window with no stream never joins another window's top-up", () => {
    const s = fresh();
    pass(s, A, 'full', ['/w/a.ts']);
    const own = indexQueueSlot(s, B, 'incremental');
    expect(own).not.toBeNull();
    expect(own).not.toBe(indexQueueSlot(s, A, 'incremental'));
    // A burst of them from the same window still costs one pass.
    expect(indexQueueSlot(s, B, 'incremental')).toBe(own);
  });

  it('an explicit full index always queues its own pass', () => {
    expect(indexQueueSlot(fresh(), A, 'full')).toBeNull();
  });
});
