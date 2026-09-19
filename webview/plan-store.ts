import { advanceBaseline, seedBaseline } from '../src/plan-baseline';
import { splitPlan } from '../src/plan-blocks';
import {
  applyPlanCommentPatch,
  mergeComments,
  type PlanBaseline,
  type PlanCommentPatch,
  type PlanCommentsData,
} from '../src/plan-comments';
import type { HostToWebview } from '../src/protocol';
import { normalizeRoot } from '../src/review-marks';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of one plan document per `${root}::${slug}` (plan
 * docs/plans/2026-09-19-interactive-plan.plan.md §Contracts). A module-singleton external store
 * like review-notes-store.ts: the host owns the two files, this owns the editing session — the
 * pending write, the conflict it turns into, the baseline, and which blocks the agent last wrote.
 */

export interface PlanDocState {
  root: string;
  slug: string;
  status: 'loading' | 'ready' | 'not-found' | 'error';
  error?: string;
  disk: string | null;
  comments: PlanCommentsData;
  pendingWrite: boolean;
  readOnly: boolean;
  saveError: string | null;
  commentsError: string | null;
  conflict: { theirs: string } | null;
  agentChanged: ReadonlySet<string>;
}

type Listener = () => void;
type ExternalListener = (root: string, slug: string) => void;

type PlanDocMsg = Extract<HostToWebview, { type: 'plan:doc' }>;
type PlanCommentsMsg = Extract<HostToWebview, { type: 'plan:comments' }>;
type PlanErrorMsg = Extract<HostToWebview, { type: 'plan:error' }>;

const EMPTY_HASHES: ReadonlySet<string> = new Set();
const EMPTY_COMMENTS: PlanCommentsData = { version: 1, comments: [] };
/** Nothing has been read off disk yet, so no block can be attributed to the agent. */
const NO_BASELINE: PlanBaseline = { at: '', blockHashes: [] };

const states = new Map<string, PlanDocState>();
/** The baseline until a Send persists one into `.comments.json`; `comments.baseline` outranks it. */
const seeded = new Map<string, PlanBaseline>();
const listeners = new Set<Listener>();
const externalListeners = new Set<ExternalListener>();

/** The host broadcasts every `plan:*` with `normalizeRoot(root)` while the renderer derives raw
 *  roots from `planRootFromPath`, so the map is keyed on the folded form (review-notes-store.ts
 *  does the same); `planKey` itself stays the literal `${root}::${slug}` of the contract. */
function keyOf(root: string, slug: string): string {
  return planKey(normalizeRoot(root), slug);
}

function hashesOf(markdown: string | null): string[] {
  return markdown ? splitPlan(markdown).blocks.map((b) => b.hash) : [];
}

function set(key: string, next: PlanDocState): void {
  states.set(key, next);
  listeners.forEach((l) => {
    l();
  });
}

function update(key: string, patch: Partial<PlanDocState>): void {
  const prev = states.get(key);
  if (!prev) return;
  set(key, { ...prev, ...patch });
}

function baselineOf(key: string): PlanBaseline | undefined {
  return states.get(key)?.comments.baseline ?? seeded.get(key);
}

/** Seeding a plan whose markdown has not landed yet would pin an EMPTY baseline and read every
 *  block back as human-changed, so it waits for the disk copy however the two loads interleave. */
function seedIfNeeded(key: string): void {
  const state = states.get(key);
  if (!state || state.status === 'loading' || state.status === 'error') return;
  if (state.comments.baseline || seeded.has(key)) return;
  seeded.set(key, seedBaseline(hashesOf(state.disk), new Date().toISOString()));
}

function planWith(
  prev: PlanDocState,
  next: string | null,
  after: readonly string[],
  known: ReadonlySet<string>,
  comments: PlanCommentsData,
): PlanDocState {
  return {
    ...prev,
    status: next === null ? 'not-found' : 'ready',
    error: undefined,
    disk: next,
    comments,
    pendingWrite: false,
    conflict: null,
    agentChanged: new Set(after.filter((h) => !known.has(h))),
  };
}

/** Take a disk version the agent wrote: shared by an external write and "Load theirs". */
function adopt(key: string, next: string | null): void {
  const prev = states.get(key);
  if (!prev) return;
  const before = hashesOf(prev.disk);
  const after = hashesOf(next);
  const known = new Set(before);
  const advanced = advanceBaseline(
    baselineOf(key) ?? NO_BASELINE,
    before,
    after,
    new Date().toISOString(),
  );
  if (prev.comments.baseline) {
    set(key, planWith(prev, next, after, known, { ...prev.comments, baseline: advanced }));
    return;
  }
  seeded.set(key, advanced);
  set(key, planWith(prev, next, after, known, prev.comments));
}

function fireExternal(root: string, slug: string): void {
  externalListeners.forEach((l) => {
    l(root, slug);
  });
}

function onDoc(msg: PlanDocMsg): void {
  const key = keyOf(msg.root, msg.slug);
  const prev = states.get(key);
  switch (msg.origin) {
    case 'load':
      if (!prev) break;
      update(key, {
        status: msg.markdown === null ? 'not-found' : 'ready',
        error: undefined,
        disk: msg.markdown,
      });
      seedIfNeeded(key);
      break;
    case 'external':
      if (prev?.pendingWrite) update(key, { conflict: { theirs: msg.markdown ?? '' } });
      else if (prev) adopt(key, msg.markdown);
      // Also for a plan this window never opened: that is the toast's only cue.
      fireExternal(msg.root, msg.slug);
      break;
    case 'write-ack':
      if (!prev) break;
      update(key, { pendingWrite: false, saveError: null, readOnly: false, disk: msg.markdown });
      break;
  }
}

function onComments(msg: PlanCommentsMsg): void {
  const key = keyOf(msg.root, msg.slug);
  const prev = states.get(key);
  if (!prev) return;
  if (msg.origin === 'ack') {
    update(key, { comments: msg.comments, commentsError: null });
    return;
  }
  update(key, { comments: mergeComments(prev.comments, msg.comments) });
  if (msg.origin === 'load') seedIfNeeded(key);
}

function onError(msg: PlanErrorMsg): void {
  const key = keyOf(msg.root, msg.slug);
  if (!states.has(key)) return;
  switch (msg.op) {
    case 'load':
      update(key, { status: 'error', error: msg.message });
      break;
    case 'write':
      // The attempt is over either way; a pendingWrite left standing would turn every later
      // agent write into a conflict the user has no way to clear.
      update(
        key,
        /EACCES|EPERM/.test(msg.message)
          ? { pendingWrite: false, readOnly: true }
          : { pendingWrite: false, saveError: msg.message },
      );
      break;
    case 'comments':
      update(key, { commentsError: msg.message });
      break;
  }
}

subscribe((msg) => {
  if (msg.type === 'plan:doc') onDoc(msg);
  else if (msg.type === 'plan:comments') onComments(msg);
  else if (msg.type === 'plan:error') onError(msg);
});

export function planKey(root: string, slug: string): string {
  return `${root}::${slug}`;
}

export function subscribePlans(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getPlanState(root: string, slug: string): PlanDocState | undefined {
  return states.get(keyOf(root, slug));
}

/** Idempotent per key: the entry itself is the "already asked" flag. */
export function loadPlan(root: string, slug: string): void {
  const key = keyOf(root, slug);
  if (states.has(key)) return;
  set(key, {
    root,
    slug,
    status: 'loading',
    disk: null,
    comments: EMPTY_COMMENTS,
    pendingWrite: false,
    readOnly: false,
    saveError: null,
    commentsError: null,
    conflict: null,
    agentChanged: EMPTY_HASHES,
  });
  post({ type: 'plan:load', root, slug });
}

/**
 * A human edit exists but its debounce has not elapsed. Spec §4 calls an agent write "inside the
 * debounce window" a conflict, and the watcher's own 250 ms settle means such a write reaches us
 * around the time the debounce fires — so dirtiness has to start at the keystroke, not at the post,
 * or the human's bytes land on top of the agent's without ever offering the choice.
 */
export function markPending(root: string, slug: string): void {
  const key = keyOf(root, slug);
  const state = states.get(key);
  if (!state || state.conflict !== null || state.readOnly || state.pendingWrite) return;
  update(key, { pendingWrite: true });
}

export function writePlan(root: string, slug: string, markdown: string): void {
  const key = keyOf(root, slug);
  const state = states.get(key);
  if (!state || state.conflict !== null || state.readOnly) return;
  update(key, { pendingWrite: true });
  post({ type: 'plan:write', root, slug, markdown });
}

/** Fold locally first so the thread answers in the same frame; the host's echo then wins. */
export function patchPlanComments(root: string, slug: string, patch: PlanCommentPatch): void {
  const key = keyOf(root, slug);
  const state = states.get(key);
  if (!state) return;
  update(key, { comments: applyPlanCommentPatch(state.comments, patch) });
  post({ type: 'plan:setComments', root, slug, patch });
}

export function resolveConflict(
  root: string,
  slug: string,
  choice: 'theirs' | 'mine',
  mine: string,
): void {
  const key = keyOf(root, slug);
  const state = states.get(key);
  if (!state || state.conflict === null) return;
  if (choice === 'theirs') {
    adopt(key, state.conflict.theirs);
    return;
  }
  update(key, { conflict: null });
  writePlan(root, slug, mine);
}

export function markViewed(root: string, slug: string, hash: string): void {
  const key = keyOf(root, slug);
  const state = states.get(key);
  if (!state?.agentChanged.has(hash)) return;
  const agentChanged = new Set(state.agentChanged);
  agentChanged.delete(hash);
  update(key, { agentChanged });
}

const externalChanges = {
  subscribe(cb: ExternalListener): () => void {
    externalListeners.add(cb);
    return () => {
      externalListeners.delete(cb);
    };
  },
};

export function planExternalChanges(): { subscribe: (cb: ExternalListener) => () => void } {
  return externalChanges;
}

export function baselineFor(root: string, slug: string): PlanBaseline {
  return baselineOf(keyOf(root, slug)) ?? NO_BASELINE;
}
