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
import { claudeSettingsFileOf } from '../../src/claude-hook-settings';
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
    expect(h.submitted).toEqual([{ sessionId: id, text: 'go', bracketed: false, settle: 'quiet' }]);
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
    expect(h.submitted).toEqual([
      { sessionId: id, text: 'wake', bracketed: false, settle: 'quiet' },
    ]);
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

  // see spec 2026-11-13-scheduler-auto-resume R6: rules read the rendered screen, not the tail.
  it('arms one resume job from a limit notice on the rendered screen, per autoResume', async () => {
    const h = harness();
    const notice = [
      "You've hit your session limit · resets 11:10pm (America/Toronto)",
      'line under it',
      'another',
      'and a third',
    ];
    const id = await live(h, { agentId: 'claude' });
    h.runtime.screens.set(id, notice);
    data(h, id, 'x');
    const resumeJobs = (sid: string) =>
      (h.domain.snapshot().timers.jobs ?? []).filter(
        (j) => j.sessionId === sid && j.trigger.kind === 'limit-reset',
      );
    await vi.waitFor(() => expect(resumeJobs(id)).toHaveLength(1), { timeout: 3000 });

    await h.call('serverSettings.patch', { patch: { autoResume: 'off' } });
    const other = await live(h, { agentId: 'claude' });
    h.runtime.screens.set(other, notice);
    data(h, other, 'x');
    await vi.waitFor(
      () =>
        expect(h.domain.snapshot().timers.episodes?.some((e) => e.sessionId === other)).toBe(true),
      { timeout: 3000 },
    );
    expect(resumeJobs(other)).toHaveLength(0);
    expect(h.resumeIssues.get(other)).toMatch(/auto-resume is off/);
  });

  it('a Claude StopFailure hook with a status-line reset arms one job; human input resolves the episode', async () => {
    const h = harness();
    const id = await live(h, { agentId: 'claude' });
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StatusLine',
      payload: { rate_limits: { five_hour: { used_percentage: 100, resets_at: resetSec } } },
    });
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StopFailure',
      payload: { hook_event_name: 'StopFailure', error: 'rate_limit' },
    });
    const jobs = (h.domain.snapshot().timers.jobs ?? []).filter((j) => j.sessionId === id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextAt).toBe(resetSec * 1000 + 120_000);
    h.domain.humanInput(id);
    expect(h.domain.snapshot().timers.episodes?.find((e) => e.sessionId === id)?.state).toBe(
      'resumed',
    );
  });

  it('scheduler.setSessionAutoResume off cancels an armed resume; history lists it; on re-arms', async () => {
    const h = harness();
    const id = await live(h, { agentId: 'claude' });
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StatusLine',
      payload: { rate_limits: { five_hour: { used_percentage: 100, resets_at: resetSec } } },
    });
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StopFailure',
      payload: { error: 'rate_limit' },
    });
    await h.call('scheduler.setSessionAutoResume', { sessionId: id, mode: 'off' });
    const history = (await h.call('scheduler.history', { sessionId: id })) as {
      jobs: { state: string }[];
      episodes: { state: string }[];
    };
    expect(history.jobs.map((j) => j.state)).toEqual(['cancelled']);
    expect(history.episodes.map((e) => e.state)).toEqual(['open']);
    await h.call('scheduler.setSessionAutoResume', { sessionId: id, mode: 'inherit' });
    const live2 = (h.domain.snapshot().timers.jobs ?? []).filter(
      (j) => j.sessionId === id && j.state === 'armed',
    );
    expect(live2).toHaveLength(1);
    await expect(
      h.call('scheduler.setSessionAutoResume', { sessionId: id, mode: 'sometimes' }),
    ).rejects.toSatisfy((e: unknown) => isFault(e, 'refused'));
  });

  it('turning auto-resume off globally cancels an armed resume', async () => {
    const h = harness();
    const id = await live(h, { agentId: 'claude' });
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StatusLine',
      payload: {
        rate_limits: {
          five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    });
    h.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StopFailure',
      payload: { error: 'rate_limit' },
    });
    await h.call('serverSettings.patch', { patch: { autoResume: 'off' } });
    expect(
      (h.domain.snapshot().timers.jobs ?? []).filter((j) => j.sessionId === id)[0]?.state,
    ).toBe('cancelled');
  });

  it('reads bracketed paste from the attach paint, where a CLI that set it at startup shows it', async () => {
    const h = harness();
    const id = await live(h);
    h.runtime.fire({
      type: 'paint',
      sessionId: id,
      generation: 1,
      data: `${ESC}[?2004hprompt> `,
      size: { cols: 80, rows: 24 },
      cause: 'attach',
    });
    expect(h.domain.domain.bracketedPaste(id)).toBe(true);
    h.runtime.fire({
      type: 'paint',
      sessionId: id,
      generation: 1,
      data: 'repaint without modes',
      size: { cols: 80, rows: 24 },
      cause: 'gap',
    });
    // Every paint is the full screen, modes included: one without ?2004h means off.
    expect(h.domain.domain.bracketedPaste(id)).toBe(false);
  });

  it('a Claude launch with injected hooks is structured from the start (R13)', async () => {
    const notice = [
      "You've hit your session limit · resets 11:10pm (America/Toronto)",
      'a',
      'b',
      'c',
    ];
    // Without hooks: rules open the episode, and a sustained busy edge resumes it.
    const plain = harness();
    const p = await live(plain, { agentId: 'claude' });
    plain.runtime.screens.set(p, notice);
    data(plain, p, 'x');
    const ep = (h: typeof plain, id: string) =>
      h.domain.snapshot().timers.episodes?.find((e) => e.sessionId === id);
    await vi.waitFor(() => expect(ep(plain, p)?.state).toBe('open'), { timeout: 3000 });
    plain.state.busy = true;
    plain.attentionChanged();
    await vi.waitFor(() => expect(ep(plain, p)?.state).toBe('resumed'), { timeout: 4000 });

    // With hooks: the same notice opens nothing (the hooks speak), and a hook-opened episode
    // survives a sustained busy edge.
    const hooked = harness({
      launchArgs: (sid, userData) => [
        '--settings',
        claudeSettingsFileOf(join(userData, 'conduit-mcp'), sid),
      ],
    });
    const id = await live(hooked, { agentId: 'claude' });
    hooked.runtime.screens.set(id, notice);
    data(hooked, id, 'x');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(ep(hooked, id)).toBeUndefined();
    hooked.domain.hookPost(id, {
      conduitHook: 1,
      token: 't',
      event: 'StopFailure',
      payload: { error: 'rate_limit' },
    });
    expect(ep(hooked, id)?.state).toBe('open');
    hooked.state.busy = true;
    hooked.attentionChanged();
    await new Promise((r) => setTimeout(r, 2_300));
    expect(ep(hooked, id)?.state).toBe('open');

    // A user's own --settings is not Conduit's hooks: rules still speak for that session.
    const own = harness({ launchArgs: () => ['--settings', '/home/u/my-settings.json'] });
    const o = await live(own, { agentId: 'claude' });
    own.runtime.screens.set(o, notice);
    data(own, o, 'x');
    await vi.waitFor(() => expect(ep(own, o)?.state).toBe('open'), { timeout: 3000 });
  }, 25_000);

  it('tracks bracketed paste for every session, not only scoped ones (spec R2)', async () => {
    const h = harness();
    const id = await live(h);
    data(h, id, `${ESC}[?2004h`);
    expect(h.domain.domain.bracketedPaste(id)).toBe(true);
    data(h, id, `${ESC}[?2004l`);
    expect(h.domain.domain.bracketedPaste(id)).toBe(false);
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

describe('server domain: attention facts', () => {
  it('every sessions.changed view carries the neutral facts the services layer overrides', async () => {
    const h = harness();
    const id = await h.create();
    await vi.waitFor(() => expect(h.types()).toContain('sessions.changed'));
    const views = h.events
      .filter((e) => e.type === 'sessions.changed')
      .flatMap((e) => (e.data as { sessions: SessionView[] }).sessions)
      .filter((s) => s.id === id);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(v).toMatchObject({ attentionReason: null, completions: 0 });
  });
});
