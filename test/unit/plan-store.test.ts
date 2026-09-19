import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitPlan } from '../../src/plan-blocks';
import type { PlanComment, PlanCommentsData } from '../../src/plan-comments';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import {
  baselineFor,
  getPlanState,
  loadPlan,
  markViewed,
  patchPlanComments,
  planExternalChanges,
  planKey,
  resolveConflict,
  subscribePlans,
  writePlan,
} from '../../webview/plan-store';

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  emit: (_m: HostToWebview): void => {},
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.emit = cb;
    return () => {};
  },
}));

const ROOT = 'C:/work/repo';

const A = '# Title\n\nAlpha paragraph.\n';
const B = '# Title\n\nBeta paragraph.\n';

const hashesOf = (md: string): string[] => splitPlan(md).blocks.map((b) => b.hash);

const doc = (
  slug: string,
  markdown: string | null,
  origin: 'load' | 'external' | 'write-ack',
): HostToWebview => ({ type: 'plan:doc', root: ROOT, slug, markdown, origin });

const commentsMsg = (
  slug: string,
  comments: PlanCommentsData,
  origin: 'load' | 'external' | 'ack',
): HostToWebview => ({ type: 'plan:comments', root: ROOT, slug, comments, origin });

const empty: PlanCommentsData = { version: 1, comments: [] };

const comment = (id: string, text: string, author: 'human' | 'agent' = 'human'): PlanComment => ({
  id,
  author,
  text,
  anchor: { index: 1, hash: 'h1', snippet: 'Alpha paragraph.' },
  status: 'open',
  createdAt: '2026-09-19T10:00:00.000Z',
});

/** Every test owns its own key: the store is a module singleton and never drops an entry. */
function open(slug: string, markdown: string | null = A, data: PlanCommentsData = empty): void {
  loadPlan(ROOT, slug);
  bus.emit(doc(slug, markdown, 'load'));
  bus.emit(commentsMsg(slug, data, 'load'));
}

beforeEach(() => {
  bus.posted.length = 0;
});

describe('plan store', () => {
  it('load posts plan:load once per key', () => {
    expect(getPlanState(ROOT, 'once')).toBeUndefined();

    loadPlan(ROOT, 'once');
    loadPlan(ROOT, 'once');
    loadPlan(ROOT, 'other');

    expect(bus.posted).toEqual([
      { type: 'plan:load', root: ROOT, slug: 'once' },
      { type: 'plan:load', root: ROOT, slug: 'other' },
    ]);
    expect(getPlanState(ROOT, 'once')?.status).toBe('loading');
    expect(planKey(ROOT, 'once')).toBe(`${ROOT}::once`);
  });

  it('plan:doc load fills disk; plan:comments load fills comments', () => {
    loadPlan(ROOT, 'fill');
    bus.emit(doc('fill', A, 'load'));
    expect(getPlanState(ROOT, 'fill')?.status).toBe('ready');
    expect(getPlanState(ROOT, 'fill')?.disk).toBe(A);
    expect(getPlanState(ROOT, 'fill')?.comments.comments).toEqual([]);

    bus.emit(commentsMsg('fill', { version: 1, comments: [comment('c1', 'why?')] }, 'load'));
    expect(getPlanState(ROOT, 'fill')?.comments.comments.map((c) => c.id)).toEqual(['c1']);
    expect(getPlanState(ROOT, 'fill')?.disk).toBe(A);

    loadPlan(ROOT, 'gone');
    bus.emit(doc('gone', null, 'load'));
    expect(getPlanState(ROOT, 'gone')?.status).toBe('not-found');
    expect(getPlanState(ROOT, 'gone')?.disk).toBeNull();
  });

  it('a plan with no stored baseline is seeded from the loaded disk hashes', () => {
    open('seed');
    expect(baselineFor(ROOT, 'seed').blockHashes).toEqual(hashesOf(A));

    const stored = { at: '2026-01-01T00:00:00.000Z', blockHashes: ['kept'] };
    open('stored', A, { version: 1, baseline: stored, comments: [] });
    expect(baselineFor(ROOT, 'stored')).toEqual(stored);
  });

  it('does not seed a baseline from a plan whose markdown has not landed yet', () => {
    loadPlan(ROOT, 'reordered');
    bus.emit(commentsMsg('reordered', empty, 'load'));
    expect(baselineFor(ROOT, 'reordered').blockHashes).toEqual([]);

    bus.emit(doc('reordered', A, 'load'));
    expect(baselineFor(ROOT, 'reordered').blockHashes).toEqual(hashesOf(A));
  });

  it('external while clean replaces disk, sets agentChanged to the new hashes and advances the baseline', () => {
    open('ext');
    bus.emit(doc('ext', B, 'external'));

    const state = getPlanState(ROOT, 'ext');
    expect(state?.disk).toBe(B);
    expect(state?.status).toBe('ready');
    expect(state?.conflict).toBeNull();
    expect([...(state?.agentChanged ?? [])]).toEqual(
      hashesOf(B).filter((h) => !hashesOf(A).includes(h)),
    );
    expect(baselineFor(ROOT, 'ext').blockHashes).toEqual(hashesOf(B));
  });

  it('external while pendingWrite sets conflict and leaves disk and baseline', () => {
    open('clash');
    writePlan(ROOT, 'clash', '# Title\n\nMine.\n');
    expect(getPlanState(ROOT, 'clash')?.pendingWrite).toBe(true);

    bus.emit(doc('clash', B, 'external'));

    const state = getPlanState(ROOT, 'clash');
    expect(state?.conflict).toEqual({ theirs: B });
    expect(state?.disk).toBe(A);
    expect([...(state?.agentChanged ?? [])]).toEqual([]);
    expect(baselineFor(ROOT, 'clash').blockHashes).toEqual(hashesOf(A));
  });

  it('resolveConflict theirs adopts theirs and clears conflict; mine posts plan:write with mine', () => {
    open('theirs');
    writePlan(ROOT, 'theirs', '# Title\n\nMine.\n');
    bus.emit(doc('theirs', B, 'external'));
    resolveConflict(ROOT, 'theirs', 'theirs', '# Title\n\nMine.\n');

    const adopted = getPlanState(ROOT, 'theirs');
    expect(adopted?.conflict).toBeNull();
    expect(adopted?.disk).toBe(B);
    expect(adopted?.pendingWrite).toBe(false);
    expect([...(adopted?.agentChanged ?? [])]).toEqual(
      hashesOf(B).filter((h) => !hashesOf(A).includes(h)),
    );
    expect(baselineFor(ROOT, 'theirs').blockHashes).toEqual(hashesOf(B));

    const MINE = '# Title\n\nMine only.\n';
    open('mine');
    writePlan(ROOT, 'mine', MINE);
    bus.emit(doc('mine', B, 'external'));
    bus.posted.length = 0;
    resolveConflict(ROOT, 'mine', 'mine', MINE);

    const kept = getPlanState(ROOT, 'mine');
    expect(kept?.conflict).toBeNull();
    expect(kept?.disk).toBe(A);
    expect(kept?.pendingWrite).toBe(true);
    expect(bus.posted).toEqual([{ type: 'plan:write', root: ROOT, slug: 'mine', markdown: MINE }]);
  });

  it('write-ack clears pendingWrite and saveError', () => {
    open('ack');
    writePlan(ROOT, 'ack', B);
    bus.emit({ type: 'plan:error', root: ROOT, slug: 'ack', op: 'write', message: 'disk full' });
    expect(getPlanState(ROOT, 'ack')?.saveError).toBe('disk full');

    writePlan(ROOT, 'ack', B);
    expect(getPlanState(ROOT, 'ack')?.pendingWrite).toBe(true);

    bus.emit(doc('ack', B, 'write-ack'));
    const state = getPlanState(ROOT, 'ack');
    expect(state?.pendingWrite).toBe(false);
    expect(state?.saveError).toBeNull();
    expect(state?.readOnly).toBe(false);
    expect(state?.disk).toBe(B);
  });

  it('plan:comments ack never touches pendingWrite or disk', () => {
    open('isolate');
    writePlan(ROOT, 'isolate', B);

    bus.emit(commentsMsg('isolate', { version: 1, comments: [comment('c9', 'note')] }, 'ack'));

    const state = getPlanState(ROOT, 'isolate');
    expect(state?.pendingWrite).toBe(true);
    expect(state?.disk).toBe(A);
    expect(state?.commentsError).toBeNull();
    expect(state?.comments.comments.map((c) => c.id)).toEqual(['c9']);
  });

  it('patchPlanComments applies optimistically and posts', () => {
    open('optimistic');
    const added = comment('c1', 'why this block?');
    patchPlanComments(ROOT, 'optimistic', { type: 'add', comment: added });

    expect(getPlanState(ROOT, 'optimistic')?.comments.comments).toEqual([added]);
    expect(bus.posted.at(-1)).toEqual({
      type: 'plan:setComments',
      root: ROOT,
      slug: 'optimistic',
      patch: { type: 'add', comment: added },
    });
  });

  it('external comments merge by id', () => {
    open('merge');
    patchPlanComments(ROOT, 'merge', { type: 'add', comment: comment('c1', 'my edited text') });

    bus.emit(
      commentsMsg(
        'merge',
        { version: 1, comments: [comment('c1', 'stale text'), comment('c2', 'agent', 'agent')] },
        'external',
      ),
    );

    const merged = getPlanState(ROOT, 'merge')?.comments.comments ?? [];
    expect(merged.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(merged[0].text).toBe('my edited text');
  });

  it('planExternalChanges notifies root+slug on external', () => {
    const seen: string[] = [];
    const off = planExternalChanges().subscribe((root, slug) => {
      seen.push(`${root}|${slug}`);
    });

    open('watched');
    bus.emit(doc('watched', B, 'external'));
    bus.emit(doc('never-loaded', B, 'external'));

    expect(seen).toEqual([`${ROOT}|watched`, `${ROOT}|never-loaded`]);
    expect(getPlanState(ROOT, 'never-loaded')).toBeUndefined();

    off();
    bus.emit(doc('watched', A, 'external'));
    expect(seen).toHaveLength(2);
  });

  it('plan:error write with EPERM sets readOnly; other write errors set saveError', () => {
    open('locked');
    bus.emit({
      type: 'plan:error',
      root: ROOT,
      slug: 'locked',
      op: 'write',
      message: 'EPERM: operation not permitted, open plan.md',
    });
    expect(getPlanState(ROOT, 'locked')?.readOnly).toBe(true);
    expect(getPlanState(ROOT, 'locked')?.saveError).toBeNull();

    bus.posted.length = 0;
    writePlan(ROOT, 'locked', B);
    expect(bus.posted).toEqual([]);

    open('failed');
    bus.emit({
      type: 'plan:error',
      root: ROOT,
      slug: 'failed',
      op: 'write',
      message: 'ENOSPC: no space left on device',
    });
    expect(getPlanState(ROOT, 'failed')?.saveError).toBe('ENOSPC: no space left on device');
    expect(getPlanState(ROOT, 'failed')?.readOnly).toBe(false);
  });

  it('plan:error comments sets commentsError', () => {
    open('badcomments');
    writePlan(ROOT, 'badcomments', B);
    bus.emit({
      type: 'plan:error',
      root: ROOT,
      slug: 'badcomments',
      op: 'comments',
      message: 'comments file is not writable',
    });

    const state = getPlanState(ROOT, 'badcomments');
    expect(state?.commentsError).toBe('comments file is not writable');
    expect(state?.saveError).toBeNull();
    expect(state?.pendingWrite).toBe(true);

    bus.emit(commentsMsg('badcomments', empty, 'ack'));
    expect(getPlanState(ROOT, 'badcomments')?.commentsError).toBeNull();
  });

  it('plan:error load sets the error status', () => {
    loadPlan(ROOT, 'broken');
    bus.emit({ type: 'plan:error', root: ROOT, slug: 'broken', op: 'load', message: 'EBUSY' });
    expect(getPlanState(ROOT, 'broken')?.status).toBe('error');
    expect(getPlanState(ROOT, 'broken')?.error).toBe('EBUSY');
  });

  it('markViewed drops one hash from agentChanged', () => {
    open('viewed');
    bus.emit(doc('viewed', B, 'external'));
    const changed = [...(getPlanState(ROOT, 'viewed')?.agentChanged ?? [])];
    expect(changed).toHaveLength(1);

    markViewed(ROOT, 'viewed', changed[0]);
    expect([...(getPlanState(ROOT, 'viewed')?.agentChanged ?? [])]).toEqual([]);
  });

  it('replaces the entry object on every change so useSyncExternalStore sees it', () => {
    open('stable');
    const first = getPlanState(ROOT, 'stable');
    expect(getPlanState(ROOT, 'stable')).toBe(first);

    let notified = 0;
    const off = subscribePlans(() => {
      notified += 1;
    });
    writePlan(ROOT, 'stable', B);
    expect(getPlanState(ROOT, 'stable')).not.toBe(first);
    expect(notified).toBe(1);

    off();
    bus.emit(doc('stable', B, 'write-ack'));
    expect(notified).toBe(1);
  });
});
