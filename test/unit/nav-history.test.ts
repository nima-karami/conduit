import { describe, expect, it } from 'vitest';
import {
  type ApplyResult,
  canBack,
  canForward,
  drop,
  EMPTY_NAV,
  NAV_STACK_CAP,
  type NavOps,
  type NavState,
  nextLanding,
  record,
  traverse,
  updateCurrent,
} from '../../src/nav-history';

interface E {
  id: string;
  n?: number;
}

const OPS: NavOps<E> = {
  sameTarget: (a, b) => a.id === b.id,
  coalesces: (a, b) =>
    a.id === b.id && (a.n === undefined || b.n === undefined || Math.abs(a.n - b.n) <= 2),
  absorb: (into, next) => (next.n === undefined ? into : { ...into, n: next.n }),
};

const e = (id: string, n?: number): E => (n === undefined ? { id } : { id, n });
const empty: NavState<E> = EMPTY_NAV;

function build(...names: string[]): NavState<E> {
  return names.reduce((s, id) => record(s, null, e(id), OPS), empty);
}

const ids = (s: NavState<E>) => s.stack.map((x) => x.id);
const always = () => true;
const nowhere = () => false;
/** The usual case: the current entry is what the user is looking at. */
const showing = (s: NavState<E>) => (x: E) => x === s.stack[s.index];
const applyAll = async (): Promise<ApplyResult> => 'applied';

describe('nav-history core', () => {
  it('record with a null from pushes only the target', () => {
    const s = record(empty, null, e('a', 1), OPS);
    expect(s.stack).toEqual([e('a', 1)]);
    expect(s.index).toBe(0);
  });

  it('F1 absorbs from into the current entry', () => {
    const s0 = record(empty, null, e('a', 1), OPS);
    const s = record(s0, e('a', 9), e('b'), OPS);
    expect(s.stack).toEqual([e('a', 9), e('b')]);
    expect(s.index).toBe(1);
  });

  it('F2 pushes from when it is not the current entry', () => {
    const s0 = record(empty, null, e('a', 1), OPS);
    const s = record(s0, e('x', 3), e('b'), OPS);
    expect(ids(s)).toEqual(['a', 'x', 'b']);
    expect(s.index).toBe(2);
  });

  it('a coalescing target replaces the current entry and keeps forward history', () => {
    const s0: NavState<E> = { stack: [e('a', 1), e('b', 5), e('c')], index: 1 };
    const s = record(s0, null, e('b', 6), OPS);
    expect(s.stack).toEqual([e('a', 1), e('b', 6), e('c')]);
    expect(s.index).toBe(1);
  });

  it('a non-coalescing target truncates forward history', () => {
    const s0: NavState<E> = { stack: [e('a', 1), e('b', 5), e('c')], index: 1 };
    const s = record(s0, null, e('d'), OPS);
    expect(ids(s)).toEqual(['a', 'b', 'd']);
    expect(s.index).toBe(2);
  });

  it('push never leaves two adjacent coalescing entries', () => {
    let s = empty;
    const steps: [string, number][] = [
      ['a', 1],
      ['a', 2],
      ['a', 10],
      ['b', 1],
      ['b', 3],
      ['a', 10],
    ];
    for (const [id, n] of steps) s = record(s, null, e(id, n), OPS);
    for (let i = 1; i < s.stack.length; i++) {
      expect(OPS.coalesces(s.stack[i - 1], s.stack[i])).toBe(false);
    }
    expect(s.stack).toEqual([e('a', 2), e('a', 10), e('b', 3), e('a', 10)]);
  });

  it('cap evicts the oldest', () => {
    let s = empty;
    for (let i = 1; i <= 60; i++) s = record(s, null, e(`e${i}`), OPS);
    expect(s.stack.length).toBe(NAV_STACK_CAP);
    expect(s.stack[0].id).toBe('e11');
    expect(s.index).toBe(NAV_STACK_CAP - 1);
  });

  it('cap holds when from and to are both pushed', () => {
    let s = build(...Array.from({ length: NAV_STACK_CAP }, (_, i) => `e${i}`));
    s = record(s, e('from'), e('to'), OPS);
    expect(s.stack.length).toBe(NAV_STACK_CAP);
    expect(ids(s).slice(-2)).toEqual(['from', 'to']);
    expect(s.index).toBe(NAV_STACK_CAP - 1);
  });

  it('back from the capped tip reaches exactly the 50 most recent', async () => {
    let s = build(...Array.from({ length: NAV_STACK_CAP + 5 }, (_, i) => `s${i}`));
    let steps = 0;
    while (canBack(s, always, showing(s))) {
      s = await traverse(s, -1, always, showing(s), applyAll);
      steps++;
    }
    expect(steps).toBe(NAV_STACK_CAP - 1);
    expect(s.stack[s.index].id).toBe('s5');
  });

  it('updateCurrent never pushes or truncates', () => {
    const s0: NavState<E> = { stack: [e('a', 1), e('b', 5), e('c')], index: 1 };
    const moved = updateCurrent(s0, e('b', 40), OPS);
    expect(moved.stack).toEqual([e('a', 1), e('b', 40), e('c')]);
    expect(moved.index).toBe(1);
    expect(updateCurrent(s0, e('z', 1), OPS)).toBe(s0);
    expect(updateCurrent(empty, e('z', 1), OPS)).toBe(empty);
  });

  it('nextLanding skips dead entries in both directions', () => {
    const s: NavState<E> = { stack: [e('a'), e('dead1'), e('b'), e('dead2'), e('c')], index: 2 };
    const isLive = (x: E) => !x.id.startsWith('dead');
    expect(nextLanding(s, -1, isLive, showing(s))).toBe(0);
    expect(nextLanding(s, 1, isLive, showing(s))).toBe(4);
    const bottom = { ...s, index: 0 };
    expect(nextLanding(bottom, -1, isLive, showing(bottom))).toBe(-1);
    const top: NavState<E> = { stack: [e('a'), e('dead1')], index: 0 };
    expect(nextLanding(top, 1, isLive, showing(top))).toBe(-1);
  });

  it('Back lands on the current entry when it is not what is on screen', () => {
    const s: NavState<E> = { stack: [e('a'), e('b'), e('c')], index: 2 };
    expect(nextLanding(s, -1, always, nowhere)).toBe(2);
    expect(nextLanding(s, 1, always, nowhere)).toBe(-1);
    expect(canBack({ stack: [e('a')], index: 0 }, always, nowhere)).toBe(true);
  });

  it('a step never lands on an entry that is already on screen', () => {
    const s: NavState<E> = { stack: [e('c', 1), e('a'), e('c', 2)], index: 2 };
    const onC = (x: E) => x.id === 'c';
    expect(nextLanding(s, -1, always, onC)).toBe(1);
    expect(nextLanding(s, -1, (x) => x.id !== 'a', onC)).toBe(-1);
    expect(canBack(s, (x) => x.id !== 'a', onC)).toBe(false);
  });

  it('drop at or before the index shifts the index down', () => {
    const s0: NavState<E> = { stack: [e('a'), e('b'), e('c'), e('d')], index: 2 };
    const before = drop(s0, 0);
    expect(ids(before)).toEqual(['b', 'c', 'd']);
    expect(before.index).toBe(1);
    const at = drop(s0, 2);
    expect(ids(at)).toEqual(['a', 'b', 'd']);
    expect(at.index).toBe(1);
    const after = drop(s0, 3);
    expect(ids(after)).toEqual(['a', 'b', 'c']);
    expect(after.index).toBe(2);
  });

  it('traverse drops dead entries and lands on the next applied one', async () => {
    const applied: string[] = [];
    const apply = async (x: E): Promise<ApplyResult> => {
      applied.push(x.id);
      return x.id === 'gone' ? 'dead' : 'applied';
    };
    const s1: NavState<E> = { stack: [e('a'), e('gone'), e('c')], index: 2 };
    const back = await traverse(s1, -1, always, showing(s1), apply);
    expect(ids(back)).toEqual(['a', 'c']);
    expect(back.index).toBe(0);
    expect(applied).toEqual(['gone', 'a']);

    applied.length = 0;
    const s2: NavState<E> = { stack: [e('a'), e('gone'), e('c')], index: 0 };
    const fwd = await traverse(s2, 1, always, showing(s2), apply);
    expect(ids(fwd)).toEqual(['a', 'c']);
    expect(fwd.index).toBe(1);
    expect(applied).toEqual(['gone', 'c']);
  });

  it('traverse drops a dead current entry and keeps stepping back', async () => {
    const applied: string[] = [];
    const s = await traverse(
      { stack: [e('a'), e('b'), e('gone')], index: 2 },
      -1,
      always,
      nowhere,
      async (x) => {
        applied.push(x.id);
        return x.id === 'gone' ? 'dead' : 'applied';
      },
    );
    expect(applied).toEqual(['gone', 'b']);
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.index).toBe(1);
  });

  it('traverse skips sync-dead entries without applying them', async () => {
    const applied: string[] = [];
    const s0: NavState<E> = { stack: [e('a'), e('dead'), e('c')], index: 2 };
    const s = await traverse(
      s0,
      -1,
      (x) => x.id !== 'dead',
      showing(s0),
      async (x) => {
        applied.push(x.id);
        return 'applied';
      },
    );
    expect(applied).toEqual(['a']);
    expect(ids(s)).toEqual(['a', 'dead', 'c']);
    expect(s.index).toBe(0);
  });

  it('traverse with nothing live returns the state with only drops', async () => {
    const s0: NavState<E> = { stack: [e('gone1'), e('gone2'), e('c')], index: 2 };
    const s = await traverse(s0, -1, always, showing(s0), async () => 'dead');
    expect(ids(s)).toEqual(['c']);
    expect(s.index).toBe(0);
  });

  it('traverse rejects when apply rejects', async () => {
    const s0 = build('a', 'b');
    await expect(
      traverse(s0, -1, always, showing(s0), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('canBack/canForward respect isLive', () => {
    const s: NavState<E> = { stack: [e('dead'), e('b'), e('c')], index: 1 };
    const isLive = (x: E) => x.id !== 'dead';
    expect(canBack(s, isLive, showing(s))).toBe(false);
    expect(canBack(s, always, showing(s))).toBe(true);
    expect(canForward(s, isLive, showing(s))).toBe(true);
    const tip = { ...s, index: 2 };
    expect(canForward(tip, always, showing(tip))).toBe(false);
    expect(canBack(empty, always, nowhere)).toBe(false);
  });
});
