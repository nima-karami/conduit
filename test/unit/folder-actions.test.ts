import { describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { FolderSectionModel } from '../../src/session-sections';
import { createFolderActions } from '../../webview/folder-actions';
import type { requestHost } from '../../webview/host-request';
import type { PushToastInput } from '../../webview/toast-store';

type Reply = (m: WebviewToHost & { requestId: number }) => Partial<HostToWebview> | null;

/** A fake requestHost: records every sent message and answers from `replies` by message type. */
function harness(
  replies: Partial<Record<WebviewToHost['type'], Reply | Reply[]>>,
  dirty: string[] = [],
) {
  const sent: WebviewToHost[] = [];
  const posted: WebviewToHost[] = [];
  const toasts: PushToastInput[] = [];
  const timeouts: number[] = [];
  let seq = 0;
  const queues = new Map<string, Reply[]>();
  for (const [k, v] of Object.entries(replies))
    queues.set(k, Array.isArray(v) ? [...v] : [v as Reply]);
  const request = (async (send, types, timeoutMs) => {
    const requestId = ++seq;
    const m = send(requestId) as WebviewToHost & { requestId: number };
    sent.push(m);
    timeouts.push(timeoutMs);
    const q = queues.get(m.type);
    const fn = q && (q.length > 1 ? q.shift() : q[0]);
    if (!fn) return null;
    const r = fn(m);
    return r === null ? null : ({ type: types[0], requestId, ...r } as never);
  }) as typeof requestHost;
  const actions = createFolderActions({
    sessionId: 's1',
    request,
    post: (m) => posted.push(m),
    toast: (t) => toasts.push(t),
    dirtyPaths: () => new Set(dirty),
  });
  return { actions, sent, posted, toasts, timeouts };
}

const sec = (over: Partial<FolderSectionModel> = {}): FolderSectionModel => ({
  path: '/w/ci-image',
  key: '/w/ci-image',
  kind: 'attached',
  missing: false,
  name: 'ci-image',
  label: 'ci-image',
  ...over,
});

const ok: Reply = () => ({ ok: true });
const fail =
  (reason: string): Reply =>
  () =>
    ({ ok: false, reason }) as never;

describe('FolderActions.add', () => {
  it('add: pick → addRoot with requestId → added outcome', async () => {
    const h = harness({ 'folder:pick': () => ({ path: 'C:\\W\\Api' }), 'session:addRoot': ok });
    expect(await h.actions.add()).toEqual({ kind: 'added', key: 'c:/w/api', name: 'Api' });
    expect(h.sent.map((m) => m.type)).toEqual(['folder:pick', 'session:addRoot']);
    expect(h.sent[1]).toEqual({
      type: 'session:addRoot',
      sessionId: 's1',
      path: 'C:\\W\\Api',
      requestId: 2,
    });
    expect(h.toasts).toEqual([]);
  });

  it('add: picker cancel → none, nothing posted after pick, no toast', async () => {
    for (const pick of [() => ({ path: null }), () => null] as Reply[]) {
      const h = harness({ 'folder:pick': pick, 'session:addRoot': ok });
      expect(await h.actions.add()).toEqual({ kind: 'none' });
      expect(h.sent.map((m) => m.type)).toEqual(['folder:pick']);
      expect(h.posted).toEqual([]);
      expect(h.toasts).toEqual([]);
    }
  });

  it('add: duplicate / overlaps / other → §2.6 copy', async () => {
    const cases: [Reply | undefined, string][] = [
      [fail('duplicate'), 'api-contracts is already in this session.'],
      [fail('overlaps'), 'api-contracts overlaps a folder already in this session.'],
      [fail('not-found'), "Couldn't add api-contracts."],
      [undefined, "Couldn't add api-contracts."],
    ];
    for (const [reply, copy] of cases) {
      const h = harness({
        'folder:pick': () => ({ path: '/w/api-contracts' }),
        ...(reply ? { 'session:addRoot': reply } : {}),
      });
      expect(await h.actions.add()).toEqual({ kind: 'none' });
      expect(h.toasts).toEqual([{ message: copy, variant: 'error' }]);
    }
  });
});

describe('FolderActions.remove', () => {
  it('remove: dirty file under folder → refusal toast "Save or close 2 unsaved files in ci-image first.", nothing sent', async () => {
    const h = harness({ 'session:removeRoot': ok }, [
      '/w/ci-image/b.txt',
      'C:/elsewhere/x.ts',
      '/w/ci-image/lib/u.ts',
      '/w/ci-image-2/z.ts',
    ]);
    expect(await h.actions.remove(sec())).toEqual({ kind: 'none' });
    expect(h.sent).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.toasts).toEqual([
      { message: 'Save or close 2 unsaved files in ci-image first.', variant: 'error' },
    ]);
    const one = harness({ 'session:removeRoot': ok }, ['/W/CI-IMAGE/b.txt']);
    await one.actions.remove(sec({ path: 'C:\\W\\ci-image', key: 'c:/w/ci-image' }));
    expect(one.toasts[0]?.message).toBe('Removed ci-image from session');
    const cased = harness({ 'session:removeRoot': ok }, ['c:/w/ci-image/b.txt']);
    await cased.actions.remove(sec({ path: 'C:\\W\\ci-image', key: 'c:/w/ci-image' }));
    expect(cased.toasts[0]?.message).toBe('Save or close 1 unsaved file in ci-image first.');
  });

  it('remove: ok → info toast "Removed ci-image from session" with Undo', async () => {
    const h = harness({ 'session:removeRoot': ok });
    expect(await h.actions.remove(sec())).toEqual({
      kind: 'removed',
      key: '/w/ci-image',
      name: 'ci-image',
    });
    expect(h.sent).toEqual([
      { type: 'session:removeRoot', sessionId: 's1', path: '/w/ci-image', requestId: 1 },
    ]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toBe('Removed ci-image from session');
    expect(h.toasts[0].variant).toBe('info');
    expect(h.toasts[0].action?.label).toBe('Undo');
  });

  it('Undo posts addRoot for the captured sessionId and path', async () => {
    const h = harness({ 'session:removeRoot': ok, 'session:addRoot': ok });
    await h.actions.remove(sec());
    h.toasts[0].action?.run();
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent[1]).toEqual({
      type: 'session:addRoot',
      sessionId: 's1',
      path: '/w/ci-image',
      requestId: 2,
    });
    expect(h.toasts).toHaveLength(1);
  });

  it('Undo duplicate is silent', async () => {
    const h = harness({ 'session:removeRoot': ok, 'session:addRoot': fail('duplicate') });
    await h.actions.remove(sec());
    h.toasts[0].action?.run();
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    await Promise.resolve();
    expect(h.toasts).toHaveLength(1);
    const other = harness({ 'session:removeRoot': ok, 'session:addRoot': fail('overlaps') });
    await other.actions.remove(sec());
    other.toasts[0].action?.run();
    await vi.waitFor(() => expect(other.toasts).toHaveLength(2));
    expect(other.toasts[1]).toEqual({
      message: 'ci-image overlaps a folder already in this session.',
      variant: 'error',
    });
  });

  it('remove of a missing folder → toast without action', async () => {
    const h = harness({ 'session:removeRoot': ok });
    await h.actions.remove(sec({ missing: true }));
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toBe('Removed ci-image from session');
    expect(h.toasts[0].action).toBeUndefined();
  });

  it('remove failure → "Couldn\'t remove <name>."', async () => {
    const h = harness({ 'session:removeRoot': fail('not-attached') });
    expect(await h.actions.remove(sec())).toEqual({ kind: 'none' });
    expect(h.toasts).toEqual([{ message: "Couldn't remove ci-image.", variant: 'error' }]);
  });
});

describe('FolderActions.makeHome / locate / attach', () => {
  it('makeHome sends session:setHome; failure copy', async () => {
    const h = harness({ 'session:setHome': ok });
    await h.actions.makeHome(sec());
    expect(h.sent).toEqual([
      { type: 'session:setHome', sessionId: 's1', path: '/w/ci-image', requestId: 1 },
    ]);
    expect(h.toasts).toEqual([]);
    const f = harness({ 'session:setHome': fail('not-found') });
    await f.actions.makeHome(sec());
    expect(f.toasts).toEqual([{ message: "Couldn't make ci-image home.", variant: 'error' }]);
  });

  it('locate ok → located with key of result.path; cancelled silent; duplicate copy names the picked folder', async () => {
    const h = harness({ 'session:locateFolder': () => ({ ok: true, path: 'D:\\Moved\\CI' }) });
    expect(await h.actions.locate(sec({ missing: true }))).toEqual({
      kind: 'located',
      key: 'd:/moved/ci',
      name: 'CI',
    });
    expect(h.sent).toEqual([
      { type: 'session:locateFolder', sessionId: 's1', path: '/w/ci-image', requestId: 1 },
    ]);
    expect(h.timeouts[0]).toBe(30 * 60_000);

    for (const reply of [() => ({ ok: false, reason: 'cancelled' }), () => null] as Reply[]) {
      const c = harness({ 'session:locateFolder': reply });
      expect(await c.actions.locate(sec())).toEqual({ kind: 'none' });
      expect(c.toasts).toEqual([]);
    }

    const dup = harness({
      'session:locateFolder': () => ({ ok: false, reason: 'duplicate', path: '/w/rmb' }) as never,
    });
    expect(await dup.actions.locate(sec())).toEqual({ kind: 'none' });
    expect(dup.toasts).toEqual([{ message: 'rmb is already in this session.', variant: 'error' }]);
    const over = harness({ 'session:locateFolder': fail('overlaps') });
    await over.actions.locate(sec());
    expect(over.toasts).toEqual([
      { message: 'ci-image overlaps a folder already in this session.', variant: 'error' },
    ]);
    const other = harness({ 'session:locateFolder': fail('not-attached') });
    await other.actions.locate(sec());
    expect(other.toasts).toEqual([{ message: "Couldn't locate ci-image.", variant: 'error' }]);
  });

  it('attach: serial, collects attached/failed, no toast', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowOk: Reply = () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      inFlight--;
      return { ok: true };
    };
    const h = harness({ 'session:addRoot': [slowOk, fail('duplicate'), slowOk] });
    expect(await h.actions.attach(['/x/a', '/x/b', '/x/c'])).toEqual({
      attached: ['/x/a', '/x/c'],
      failed: ['/x/b'],
    });
    expect(h.sent.map((m) => (m as { path: string }).path)).toEqual(['/x/a', '/x/b', '/x/c']);
    expect(maxInFlight).toBe(1);
    expect(h.toasts).toEqual([]);
  });
});
