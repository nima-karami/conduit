import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disposeHarnesses,
  harness,
  isFault,
  type RecordedEvent,
} from '../../server/domain/testing/fakes';
import type { SessionView } from '../../src/contracts/server-protocol';
import type { TimedMessage } from '../../src/timed-messages';

afterEach(disposeHarnesses);

const ESC = '\x1b';
const viewOf = (h: ReturnType<typeof harness>, id: string): SessionView | undefined =>
  h.domain.snapshot().sessions.find((s) => s.id === id);

async function live(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  const id = await h.create(extra);
  await h.call('sessions.start', { sessionId: id });
  return id;
}

const data = (h: ReturnType<typeof harness>, sessionId: string, chunk: string, tail?: string[]) => {
  if (tail) h.runtime.tails.set(sessionId, tail);
  h.runtime.fire({ type: 'data', sessionId, generation: 1, data: chunk });
};

describe('server domain: event order', () => {
  afterEach(() => vi.useRealTimers());

  it('emits sessions.opened before the sessions.changed that first lists the session', async () => {
    const h = harness();
    const id = await h.create({ placement: { nearSessionId: 'x', focus: false } });
    await vi.waitFor(() => expect(h.types()).toContain('sessions.changed'));
    const opened = h.events.findIndex((e) => e.type === 'sessions.opened');
    const changed = h.events.findIndex(
      (e) =>
        e.type === 'sessions.changed' &&
        (e.data as { sessions: SessionView[] }).sessions.some((s) => s.id === id),
    );
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(opened).toBeLessThan(changed);
    expect(h.events[opened]?.data).toEqual({ sessionId: id, openerSessionId: 'x', focus: false });
  });

  it('emits timers.fired before the timers.changed of that fire', async () => {
    const h = harness({ e2e: true });
    const id = await live(h);
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'go', trigger: { kind: 'in', delayMs: 1 } },
    });
    // The PTY settle window holds a fresh launch's delivery; the e2e clock seam moves past it.
    await h.call('timers.test', { op: 'advance', ms: 10_000 });
    // The first timers.changed that carries the fire (its lastFire) must come after timers.fired.
    const showsFire = (e: RecordedEvent) =>
      e.type === 'timers.changed' &&
      (e.data as { schedules: TimedMessage[] }).schedules.some((s) => s.lastFire !== undefined);
    await vi.waitFor(() => expect(h.events.some(showsFire)).toBe(true));
    const fired = h.types().indexOf('timers.fired');
    expect(fired).toBeGreaterThanOrEqual(0);
    expect(fired).toBeLessThan(h.events.findIndex(showsFire));
    expect(h.submitted).toEqual([{ sessionId: id, text: 'go' }]);
  });

  it('refuses timers.test unless started for e2e', async () => {
    const h = harness();
    await expect(h.call('timers.test', { op: 'advance', ms: 1 })).rejects.toSatisfy((e: unknown) =>
      isFault(e, 'refused'),
    );
  });

  it('re-evaluates due timers on system.resumed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    const id = await live(h);
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'wake', trigger: { kind: 'in', delayMs: 60_000 } },
    });
    // The machine slept past the due time: the clock moved, the armed timeout never ran.
    vi.setSystemTime(Date.now() + 3_600_000);
    await h.call('system.resumed');
    // Microtasks only: advancing the fake clock would run the armed timeout and prove nothing.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.submitted).toEqual([{ sessionId: id, text: 'wake' }]);
  });
});

describe('server domain: internal subscribers on C1 data', () => {
  it('derives lastLine from tailLines', async () => {
    const h = harness();
    const id = await live(h);
    data(h, id, 'hello\r\n', ['first', 'hello'.repeat(40)]);
    const line = viewOf(h, id)?.lastLine ?? '';
    expect(line.startsWith('hellohello')).toBe(true);
    expect(line.length).toBe(120);
  });

  it('arms a limit timer from the trailing lines per autoResumeOnLimit', async () => {
    const h = harness();
    const id = await live(h);
    data(h, id, 'x', ["You've hit your session limit · resets 11:10pm (America/Toronto)"]);
    const { schedules } = h.domain.snapshot().timers;
    expect(schedules.filter((s) => s.sessionId === id && s.origin === 'limit')).toHaveLength(1);

    await h.call('serverSettings.patch', { patch: { autoResumeOnLimit: 'off' } });
    const other = await live(h);
    data(h, other, 'x', ["You've hit your session limit · resets 11:10pm (America/Toronto)"]);
    expect(h.domain.snapshot().timers.schedules.some((s) => s.sessionId === other)).toBe(false);
  });

  it('tracks bracketed paste for runAddDir and notes the paste as a draft before writing', async () => {
    const h = harness();
    const extra = join(h.userData, 'extra');
    mkdirSync(extra);
    const id = await live(h, { agentId: 'claude' });
    expect(
      await h.call('sessions.mutate', { sessionId: id, mutation: { op: 'addRoot', path: extra } }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(viewOf(h, id)?.agentScope?.typeable).toEqual([extra]));
    expect(await h.call('sessions.addDirs', { sessionId: id, requestId: 1 })).toEqual({
      sessionId: id,
      ok: false,
      reason: 'notReady',
    });
    data(h, id, `${ESC}[?2004h`);
    expect(await h.call('sessions.addDirs', { sessionId: id, requestId: 2 })).toEqual({
      sessionId: id,
      ok: true,
    });
    const paste = `${ESC}[200~/add-dir ${extra}${ESC}[201~`;
    expect(h.drafts).toEqual([{ sessionId: id, data: paste }]);
    expect(h.written).toEqual([{ sessionId: id, data: paste, generation: 1 }]);
    // scopes.output: claude confirming the folder ends the drift.
    data(h, id, `\u23BF  Added ${extra} as a working directory for this session\r\n`);
    await vi.waitFor(() => expect(viewOf(h, id)?.agentScope).toBeUndefined());
  });

  it('an unseen folder that goes missing drops out of the agent scope', async () => {
    const h = harness();
    const extra = join(h.userData, 'extra');
    mkdirSync(extra);
    const id = await live(h, { agentId: 'claude' });
    await h.call('sessions.mutate', { sessionId: id, mutation: { op: 'addRoot', path: extra } });
    await vi.waitFor(() => expect(viewOf(h, id)?.agentScope?.typeable).toEqual([extra]));
    rmSync(extra, { recursive: true });
    // The addRoot's own health check may still be in flight and answer the first suspect.
    await vi.waitFor(async () => {
      await h.call('folders.suspect', { sessionId: id, path: extra });
      expect(viewOf(h, id)?.missingRoots).toEqual([extra]);
    });
    await vi.waitFor(() => expect(viewOf(h, id)?.agentScope).toBeUndefined());
  });

  it('refuses add-dir while attention says busy', async () => {
    const h = harness();
    const extra = join(h.userData, 'extra');
    mkdirSync(extra);
    const id = await live(h, { agentId: 'claude' });
    await h.call('sessions.mutate', { sessionId: id, mutation: { op: 'addRoot', path: extra } });
    await vi.waitFor(() => expect(viewOf(h, id)?.agentScope?.typeable).toEqual([extra]));
    data(h, id, `${ESC}[?2004h`);
    h.state.busy = true;
    expect(await h.call('sessions.addDirs', { sessionId: id, requestId: 1 })).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(h.written).toEqual([]);
  });

  it('follows the cwd from OSC reports into SessionView.cwd, never the app repo fields', async () => {
    const h = harness();
    const sub = join(h.home, 'sub');
    mkdirSync(sub);
    const id = await live(h);
    data(h, id, `${ESC}]7;${pathToFileURL(sub).href}\x07`);
    const slash = (p: string | undefined) => p?.replace(/\\/g, '/').toLowerCase();
    await vi.waitFor(() => expect(slash(viewOf(h, id)?.cwd)).toBe(slash(sub)));
    const view = viewOf(h, id) ?? {};
    for (const k of ['repos', 'repoGit', 'activeRepoRoot', 'autoRepoRoot', 'pinnedRepoRoot'])
      expect(k in view).toBe(false);
  });

  it('applies hc titles and runtime facts to the view', async () => {
    const h = harness();
    const id = await live(h);
    h.runtime.fire({ type: 'title', sessionId: id, title: 'my build' });
    h.runtime.fire({ type: 'status', sessionId: id, status: { state: 'working' } });
    h.runtime.fire({ type: 'size', sessionId: id, size: { cols: 100, rows: 40 } });
    const view = viewOf(h, id);
    expect(view?.name).toBe('my build');
    expect(view?.runtime).toEqual({
      generation: 1,
      spawn: 'live',
      reportedStatus: { state: 'working' },
      lastSize: { cols: 100, rows: 40 },
    });
    h.runtime.fire({ type: 'exit', sessionId: id, generation: 1, code: 0, reason: 'exited' });
    expect(viewOf(h, id)).toMatchObject({ status: 'exited', runtime: { spawn: 'none' } });
  });

  it('marks spawn unconfirmed on a C1 unconfirmed event and live on a late registration', async () => {
    const h = harness();
    const id = await h.create();
    h.runtime.fire({ type: 'unconfirmed', sessionId: id, generation: 4, launchId: 'a'.repeat(32) });
    expect(viewOf(h, id)?.runtime).toMatchObject({ spawn: 'unconfirmed', generation: 4 });
    h.runtime.fire({ type: 'spawned', sessionId: id, generation: 4, size: { cols: 80, rows: 24 } });
    expect(viewOf(h, id)?.runtime).toMatchObject({ spawn: 'live', generation: 4 });
  });
});
