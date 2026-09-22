// Back/Forward history stack, generic over the entry type so the editor (and, later, the arch
// canvas drill levels) supply their own "same place" and coalescing rules. Pure + unit-tested;
// the editor model is webview/editor-nav.ts, the React glue webview/use-nav-history.ts.
// See docs/specs/2026-09-22-editor-nav-history.md §3.

export interface NavState<E> {
  readonly stack: readonly E[];
  readonly index: number;
}

export const EMPTY_NAV: NavState<never> = { stack: [], index: -1 };

/** Bounded per window: the oldest entries are evicted from the front on overflow. */
export const NAV_STACK_CAP = 50;

export interface NavOps<E> {
  /** Same place ignoring position — F1 ("the active doc IS the current entry"). */
  sameTarget(a: E, b: E): boolean;
  /** R4: `next` folds into `current` instead of being pushed. */
  coalesces(current: E, next: E): boolean;
  /** The entry that stands for `into` after `next` is folded in. */
  absorb(into: E, next: E): E;
}

export type ApplyResult = 'applied' | 'dead';

function replaceCurrent<E>(s: NavState<E>, entry: E): NavState<E> {
  const stack = s.stack.slice();
  stack[s.index] = entry;
  return { stack, index: s.index };
}

function push<E>(s: NavState<E>, entry: E, ops: NavOps<E>): NavState<E> {
  const cur = s.stack[s.index];
  if (cur !== undefined && ops.coalesces(cur, entry)) {
    return replaceCurrent(s, ops.absorb(cur, entry));
  }
  const stack = s.stack.slice(0, s.index + 1);
  stack.push(entry);
  const evict = Math.max(0, stack.length - NAV_STACK_CAP);
  return { stack: stack.slice(evict), index: stack.length - evict - 1 };
}

/** F1/F2/F3 then push(to). `from === null` is F3. */
export function record<E>(s: NavState<E>, from: E | null, to: E, ops: NavOps<E>): NavState<E> {
  let st = s;
  if (from !== null) {
    const cur = st.stack[st.index];
    st =
      cur !== undefined && ops.sameTarget(cur, from)
        ? replaceCurrent(st, ops.absorb(cur, from))
        : push(st, from, ops);
  }
  return push(st, to, ops);
}

/** §2.3 step 0: fold `live` into the current entry when it is the same place. Never pushes or truncates. */
export function updateCurrent<E>(s: NavState<E>, live: E, ops: NavOps<E>): NavState<E> {
  const cur = s.stack[s.index];
  if (cur === undefined || !ops.sameTarget(cur, live)) return s;
  return replaceCurrent(s, ops.absorb(cur, live));
}

/** Nearest index in `dir` whose entry passes `isLive`, or -1. */
export function nextLive<E>(s: NavState<E>, dir: -1 | 1, isLive: (e: E) => boolean): number {
  for (let i = s.index + dir; i >= 0 && i < s.stack.length; i += dir) {
    if (isLive(s.stack[i])) return i;
  }
  return -1;
}

export function drop<E>(s: NavState<E>, i: number): NavState<E> {
  const stack = s.stack.slice();
  stack.splice(i, 1);
  return { stack, index: i < s.index ? s.index - 1 : s.index };
}

/** Step with skip-dead: a sync-dead entry is skipped, one `apply` reports dead is dropped. */
export async function traverse<E>(
  s: NavState<E>,
  dir: -1 | 1,
  isLive: (e: E) => boolean,
  apply: (e: E) => Promise<ApplyResult>,
): Promise<NavState<E>> {
  let st = s;
  for (let i = nextLive(st, dir, isLive); i !== -1; i = nextLive(st, dir, isLive)) {
    if ((await apply(st.stack[i])) === 'applied') return { stack: st.stack, index: i };
    st = drop(st, i);
  }
  return st;
}

export const canBack = <E>(s: NavState<E>, isLive: (e: E) => boolean): boolean =>
  nextLive(s, -1, isLive) !== -1;
export const canForward = <E>(s: NavState<E>, isLive: (e: E) => boolean): boolean =>
  nextLive(s, 1, isLive) !== -1;
