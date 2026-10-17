import { indexRemovals } from './index-resync';
import { newIndexPaths } from './source-index';

// Per-window streams of one root's TS source index. Every window holds its own TS project, so
// each one's "already sent" set and chunk ordinals are its own: a shared set let one window's
// stream (or a reload) mark files as sent that another window never received, and a shared seq
// meant a second window or a reloaded renderer never got chunk 0, which carries the tsconfig
// (webview/ts-project.ts applyProjectFiles). See search-scope review r3 SF-B.

/** full: chunk 0 onward. incremental: files that appeared since. resync: incremental, plus the
 *  files that left the selection go out as `removed`. */
export type IndexMode = 'full' | 'incremental' | 'resync';

/** What one window's TS project has been sent for a root. `resolved` = what on-demand module
 *  resolutions added to `sent`; `nextSeq` keeps its chunk ordinals monotonic, because only a
 *  full stream may send `seq === 0`. */
export interface IndexStream {
  sent: Set<string>;
  resolved: Set<string>;
  nextSeq: number;
}

/** A root's index state: the repo set its selection was last built from (src/index-resync.ts)
 *  and the stream of every window indexing it. */
export interface RootIndexState {
  repoSet: string | null;
  streams: Map<number, IndexStream>;
}

export interface StreamPlan {
  windowId: number;
  /** Starts at chunk 0 (with the tsconfig) and is not supplemental. */
  full: boolean;
  /** In streaming order. */
  paths: string[];
  /** Sent before, no longer selected: leaves that window's TS project. */
  removed: string[];
}

/** Whether this pass streams `requester` a full index: it asked for one, or it holds no stream
 *  for the root (a reloaded renderer's top-up). */
export function wantsFullIndex(
  state: RootIndexState | undefined,
  requester: number | null,
  mode: IndexMode,
): boolean {
  return requester !== null && (mode === 'full' || !state?.streams.has(requester));
}

/**
 * The queued pass a request may ride on instead of queueing its own, or null when it needs its
 * own. A queued pass runs under its first requester's id, so only a request that is the same
 * top-up for every window may join it: one from a window with no stream is that window's full
 * index (`wantsFullIndex`), and merged into another window's top-up it would never be streamed
 * its index or tsconfig (search-scope review r4 SF-B). A burst of those still coalesces, per
 * window. An explicit full index never joins anything.
 */
export function indexQueueSlot(
  state: RootIndexState | undefined,
  windowId: number | null,
  mode: IndexMode,
): string | null {
  if (mode === 'full') return null;
  if (wantsFullIndex(state, windowId, mode)) return `full:${windowId}`;
  return mode;
}

/**
 * One index pass over `selected` (the root's current selection), for every window indexing the
 * root. The requester, when it wants a full index, gets a fresh stream from seq 0 in
 * `fullOrder`; every other window gets what its own stream lacks, plus its removals when the
 * repo set changed or a re-sync was asked for. Mutates `state`: the requester's stream is reset,
 * removals leave each `sent`, `repoSet` moves to the pass's. Paths join `sent` only as the
 * caller actually streams them.
 */
export function planIndexPass(
  state: RootIndexState,
  pass: {
    requester: number | null;
    mode: IndexMode;
    repoSet: string | null;
    selected: readonly string[];
    fullOrder: readonly string[];
  },
): StreamPlan[] {
  const resync = pass.mode === 'resync' || state.repoSet !== pass.repoSet;
  state.repoSet = pass.repoSet;
  const full = wantsFullIndex(state, pass.requester, pass.mode);
  if (full && pass.requester !== null)
    state.streams.set(pass.requester, { sent: new Set(), resolved: new Set(), nextSeq: 0 });
  const plans: StreamPlan[] = [];
  for (const [windowId, stream] of state.streams) {
    if (full && windowId === pass.requester) {
      plans.push({ windowId, full: true, paths: [...pass.fullOrder], removed: [] });
      continue;
    }
    const removed = resync ? indexRemovals(stream.sent, stream.resolved, pass.selected) : [];
    for (const p of removed) stream.sent.delete(p);
    const paths = newIndexPaths(pass.selected, stream.sent);
    if (paths.length || removed.length) plans.push({ windowId, full: false, paths, removed });
  }
  return plans;
}

export interface IndexChunk {
  seq: number;
  paths: string[];
  done: boolean;
  /** Only on the first chunk of a plan. */
  removed: string[];
  /** Carries the compiler options: chunk 0 of a full stream. */
  tsconfig: boolean;
}

/** Cut a plan into the chunks its window is sent, recording them on its stream. A full plan
 *  always sends chunk 0, and a re-sync that only removes still sends one chunk. */
export function takeChunks(plan: StreamPlan, stream: IndexStream, size: number): IndexChunk[] {
  const chunks: IndexChunk[] = [];
  const total = plan.paths.length;
  for (let i = 0; i < total || (i === 0 && (plan.full || plan.removed.length > 0)); i += size) {
    const seq = stream.nextSeq;
    stream.nextSeq += 1;
    const paths = plan.paths.slice(i, i + size);
    for (const p of paths) stream.sent.add(p);
    chunks.push({
      seq,
      paths,
      done: i + size >= total,
      removed: i === 0 ? plan.removed : [],
      tsconfig: plan.full && seq === 0,
    });
  }
  return chunks;
}
