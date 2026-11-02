import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeHarnesses, FakeRuntime, harness, isFault } from '../../server/domain/testing/fakes';
import type { SessionStartResult } from '../../src/contracts/server-protocol';
import { COMMAND_AGENT_ID } from '../../src/session-command';

type Started = Extract<SessionStartResult, { ok: true; target: unknown }>;

const start = async (h: ReturnType<typeof harness>, sessionId: string) =>
  (await h.call('sessions.start', { sessionId })) as SessionStartResult;

const persisted = (userData: string) =>
  JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as {
    sessions: { id: string; lastGeneration?: number }[];
  };

afterEach(disposeHarnesses);

describe('server domain: sessions.start', () => {
  it('allocates the generation from the persisted lastGeneration, so it survives a restart', async () => {
    const a = harness();
    const id = await a.create();
    const first = (await start(a, id)) as Started;
    expect(first.generation).toBe(1);
    expect(a.runtime.spawns[0]?.ids.generation).toBe(1);
    expect(a.runtime.spawns[0]?.ids.launchId).toMatch(/^[0-9a-f]{32}$/);
    expect(persisted(a.userData).sessions.find((s) => s.id === id)?.lastGeneration).toBe(1);

    a.domain.dispose();
    const b = harness({ userData: a.userData });
    b.domain.adopted([]);
    const second = (await start(b, id)) as Started;
    expect(second.generation).toBe(2);
    expect(b.runtime.spawns[0]?.labels['conduit.generation']).toBe('2');
  });

  it('waits for the launch seam and prepares the launch before spawning with the same ids', async () => {
    const h = harness();
    const id = await h.create();
    await start(h, id);
    const order = h.calls.filter((c) => /^(whenLaunchReady|prepareLaunch|spawn)/.test(c));
    expect(order).toEqual(['whenLaunchReady', 'prepareLaunch:1', 'spawn']);
    const call = h.runtime.spawns[0];
    expect(call?.spec.env?.CONDUIT_SESSION_TOKEN).toBe('t');
    expect(call?.labels).toMatchObject({
      'conduit.session': id,
      'conduit.instance': 'inst',
      'conduit.launch': call?.ids.launchId,
      'conduit.role': 'session',
    });
  });

  it('takes the history from ScrollbackPort once, before the spawn, and appends the relaunch marker to the prelude', async () => {
    const replay = {
      data: 'old history',
      replay: [{ length: 11, geometry: { cols: 80, rows: 30 } }],
    };
    const h = harness({ replay });
    const id = await h.create();
    const r = (await start(h, id)) as Started;
    expect(r.spawned).toBe(true);
    const marker = r.prelude?.data.slice(replay.data.length) ?? '';
    expect(r.prelude?.data.startsWith(replay.data)).toBe(true);
    expect(marker).toContain('session relaunched');
    expect(r.prelude?.replay).toEqual([...replay.replay, { length: marker.length }]);
    expect(h.calls.filter((c) => c === `replay:${id}`)).toHaveLength(1);
    expect(h.calls.indexOf(`replay:${id}`)).toBeLessThan(h.calls.indexOf('spawn'));
    // In the ring before the spawn without a term.show: the app writes it from the prelude.
    expect(h.recorded).toEqual([{ sessionId: id, data: marker }]);
    expect(h.calls.indexOf('record')).toBeLessThan(h.calls.indexOf('spawn'));
    // Never through show or TypingPort.
    expect(h.shown).toEqual([]);
    expect(h.written).toEqual([]);
  });

  it('a relaunch with no history still carries the marker in the prelude', async () => {
    const h = harness();
    const id = await h.create();
    await h.call('sessions.relaunch', { sessionIds: [id] });
    const r = (await start(h, id)) as Started;
    expect(r.prelude?.data).toContain('session relaunched');
    expect(h.shown).toEqual([]);
  });

  it("sizes the ConPTY padding from the pane's requested rows, else hc's default", async () => {
    const replay = { data: 'old', replay: [{ length: 3 }] };
    const h = harness({ replay, platform: 'win32' });
    const sized = await h.create();
    h.domain.resized(sized, { cols: 80, rows: 7 });
    const r = (await start(h, sized)) as Started;
    expect(r.prelude?.data.endsWith(`—\x1b[0m\r\n${'\r\n'.repeat(7)}`)).toBe(true);
    const unsized = await h.create();
    const w = (await start(h, unsized)) as Started;
    expect(w.prelude?.data.endsWith(`—\x1b[0m\r\n${'\r\n'.repeat(120)}`)).toBe(true);
  });

  it('takes no replay with scrollback persistence off, on the live and the finished path', async () => {
    const runtime = new FakeRuntime();
    const h = harness({
      runtime,
      replay: { data: 'x', replay: [{ length: 1 }] },
      files: {
        'server-settings.json': JSON.stringify({
          version: 1,
          settings: { scrollbackPersistence: false },
        }),
      },
    });
    const id = await h.create();
    expect(await start(h, id)).not.toHaveProperty('prelude');
    runtime.nextSpawn = async (c) => ({
      ok: true,
      launchId: c.ids.launchId,
      finished: { exitCode: 0, reason: 'exited', output: '' },
    });
    const other = await h.create();
    expect(await start(h, other)).toMatchObject({ prelude: { data: '', replay: [] } });
    expect(h.calls.some((c) => c.startsWith('replay:'))).toBe(false);
  });

  it('attaches a live session while stopping instead of refusing', async () => {
    const h = harness();
    const id = await h.create();
    await start(h, id);
    h.state.stopping = true;
    expect(await start(h, id)).toMatchObject({ ok: true, spawned: false, generation: 1 });
  });

  it('waits for the first reconcile before allocating, and attaches what it adopted', async () => {
    const h = harness({ reconciled: false });
    const id = await h.create();
    const pending = start(h, id);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls.some((c) => c.startsWith('prepareLaunch') || c === 'spawn')).toBe(false);
    const terminal = h.runtime.live(id, 4, 'd'.repeat(32), { cols: 80, rows: 24 });
    h.domain.adopted([
      {
        ...terminal,
        labels: {
          'conduit.session': id,
          'conduit.instance': 'inst',
          'conduit.generation': '4',
          'conduit.launch': 'd'.repeat(32),
          'conduit.role': 'session',
        },
      },
    ]);
    expect(await pending).toMatchObject({ ok: true, spawned: false, generation: 4 });
    expect(h.runtime.spawns).toHaveLength(0);
  });

  it("restores the user's captured XDG values into the session's env, an empty one included", async () => {
    const h = harness({
      env: {
        CONDUIT_USER_XDG_CAPTURED: '1',
        CONDUIT_USER_XDG_CONFIG_HOME: '/u/config',
        CONDUIT_USER_XDG_STATE_HOME: '',
        XDG_CONFIG_HOME: '/conduit/hc/config',
      },
    });
    const id = await h.create();
    await start(h, id);
    expect(h.runtime.spawns[0]?.spec.env).toMatchObject({
      XDG_CONFIG_HOME: '/u/config',
      XDG_STATE_HOME: '',
    });

    // Not captured: the server's XDG are the user's own, inherited, and nothing is set.
    const plain = harness({ env: { XDG_CONFIG_HOME: '/mine' } });
    const p = await plain.create();
    await start(plain, p);
    const env = plain.runtime.spawns[0]?.spec.env ?? {};
    expect('XDG_CONFIG_HOME' in env || 'XDG_STATE_HOME' in env).toBe(false);
  });

  it('returns spawned:false for a live session: no prelude, no second run', async () => {
    const h = harness({ replay: { data: 'x', replay: [{ length: 1 }] } });
    const id = await h.create();
    await start(h, id);
    const again = (await start(h, id)) as Started;
    expect(again).toMatchObject({ ok: true, spawned: false, generation: 1 });
    expect(again.prelude).toBeUndefined();
    expect(h.runtime.spawns).toHaveLength(1);
  });

  it('shares one spawn between concurrent starts', async () => {
    const h = harness();
    const id = await h.create();
    const [a, b] = await Promise.all([start(h, id), start(h, id)]);
    expect(h.runtime.spawns).toHaveLength(1);
    expect([a, b].map((r) => r.ok && 'spawned' in r && r.spawned).sort()).toEqual([false, true]);
  });

  it('returns a finished start with its output as prelude and marks the session exited', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => ({
      ok: true,
      launchId: c.ids.launchId,
      finished: { exitCode: 3, reason: 'exited', output: 'done!' },
    });
    const h = harness({ runtime, replay: { data: 'bye', replay: [{ length: 3 }] } });
    const id = await h.create();
    const r = await start(h, id);
    expect(r).toMatchObject({ ok: true, finished: { exitCode: 3, reason: 'exited' } });
    const prelude = 'prelude' in r ? r.prelude : undefined;
    expect(prelude?.data.startsWith('bye')).toBe(true);
    expect(prelude?.replay[0]).toEqual({ length: 3 });
    // The program's final output follows the history and the marker, as its own run.
    expect(prelude?.data.endsWith('done!')).toBe(true);
    expect(prelude?.replay.at(-1)).toEqual({ length: 'done!'.length });
    // One replay per start: a second would record the neutralizer tail in the ring again.
    expect(h.calls.filter((c) => c === `replay:${id}`)).toHaveLength(1);
    expect((h.domain.sessions.get(id) ?? { status: '' }).status).toBe('exited');
  });

  it('refuses spawn_unconfirmed in the result and shows Retry state; a pane start never runs it twice', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => {
      runtime.fire({
        type: 'unconfirmed',
        sessionId: c.sessionId,
        generation: c.ids.generation,
        launchId: c.ids.launchId,
      });
      return { ok: false, refusal: { reason: 'spawn_unconfirmed', launchId: c.ids.launchId } };
    };
    const h = harness({ runtime });
    const id = await h.create();
    const r = await start(h, id);
    const launchId = h.runtime.spawns[0]?.ids.launchId;
    expect(r).toEqual({ ok: false, refusal: { reason: 'spawn_unconfirmed', launchId } });
    const view = h.domain.snapshot().sessions.find((s) => s.id === id);
    expect(view?.runtime.spawn).toBe('unconfirmed');
    expect(await start(h, id)).toEqual(r);
    expect(h.runtime.spawns).toHaveLength(1);
  });

  it('refuses server_stopping in the result', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async () => ({ ok: false, refusal: { reason: 'server_stopping' } });
    const h = harness({ runtime });
    const id = await h.create();
    expect(await start(h, id)).toEqual({ ok: false, refusal: { reason: 'server_stopping' } });
    expect(h.shown.some((s) => s.sessionId === id)).toBe(true);
  });

  it("handles hc's spawn_failed like a can't-start: line through show, stale, unresolvable", async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async () => ({
      ok: false,
      refusal: { reason: 'spawn_failed', message: 'permission denied' },
    });
    const history = { data: 'old', replay: [{ length: 3 }] };
    const h = harness({ runtime, replay: history });
    const id = await h.create();
    const r = await start(h, id);
    expect(r).toMatchObject({ ok: false, refusal: { reason: 'unresolvable', command: 'sh' } });
    // The ring already holds the marker, so the pane gets the same prelude.
    const prelude = 'prelude' in r ? r.prelude : undefined;
    expect(prelude?.data).toBe(history.data + (h.recorded[0]?.data ?? ''));
    expect(h.shown.map((s) => s.data).join('')).toContain("can't start: permission denied");
    const view = h.domain.snapshot().sessions.find((s) => s.id === id);
    expect(view).toMatchObject({ status: 'stale', runtime: { spawn: 'none' } });
    expect(view?.startRefusal).toBeUndefined();
  });

  it("a refused start returns the stored history as prelude, replayed before the can't-start line", async () => {
    const history = { data: 'old', replay: [{ length: 3 }] };
    const h = harness({ replay: history, resolveCommand: () => undefined });
    const id = await h.create();
    expect(await start(h, id)).toEqual({
      ok: false,
      refusal: { reason: 'unresolvable', command: 'sh' },
      prelude: history,
    });
    expect(h.calls.indexOf(`replay:${id}`)).toBeLessThan(h.calls.indexOf('show'));
    expect(h.calls.filter((c) => c === `replay:${id}`)).toHaveLength(1);
  });

  it("shows the can't-start line through show and refuses unresolvable in the result", async () => {
    const h = harness({ resolveCommand: () => undefined });
    const id = await h.create();
    const r = await start(h, id);
    expect(r).toEqual({ ok: false, refusal: { reason: 'unresolvable', command: 'sh' } });
    expect(h.shown.find((s) => s.sessionId === id)?.data).toContain("can't start: sh not found");
    expect(h.runtime.spawns).toHaveLength(0);
    expect(h.domain.snapshot().sessions.find((s) => s.id === id)?.startRefusal).toEqual({
      reason: 'unresolvable',
      command: 'sh',
    });
  });

  it('refuses home-missing and command-invalid in the result', async () => {
    const h = harness();
    const home = join(h.userData, 'gone');
    mkdirSync(home);
    const id = await h.create({ home });
    await h.call('sessions.relaunch', { sessionIds: [id] });
    rmSync(home, { recursive: true });
    expect(await start(h, id)).toEqual({ ok: false, refusal: { reason: 'home-missing' } });
    expect(h.runtime.spawns).toHaveLength(0);
    expect(h.shown.some((s) => s.data.includes("can't start: home folder"))).toBe(true);

    // A saved open_terminal command that failed coercion is kept and refused at start.
    const bad = { id: 'cmd1', name: 'c', agentId: COMMAND_AGENT_ID, home: h.home, roots: [] };
    const c = harness({
      files: { 'sessions.json': JSON.stringify({ version: 1, sessions: [bad] }) },
    });
    expect(await start(c, 'cmd1')).toEqual({ ok: false, refusal: { reason: 'command-invalid' } });
    expect(c.runtime.spawns).toHaveLength(0);
    expect(c.shown.some((s) => s.data.includes('saved command is invalid'))).toBe(true);
  });

  it('shows role-brief banners through show before the spawn', async () => {
    const h = harness();
    const id = await h.create({
      agentId: 'claude',
      brief: { kind: 'text', text: 'Be a reviewer' },
    });
    // A brief whose stored copy is gone is dropped at launch with a banner.
    rmSync(join(h.userData, 'brief-store'), { recursive: true, force: true });
    await start(h, id);
    const banner = h.calls.indexOf('show');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(h.calls.indexOf('spawn'));
    expect(h.written).toEqual([]);
  });
});

describe('server domain: sessions.create and MCP opens', () => {
  it('refuses sessions.create as an RPC error', async () => {
    const h = harness();
    await expect(h.call('sessions.create', { agentId: 'nope', home: h.home })).rejects.toSatisfy(
      (e: unknown) => isFault(e, 'invalid'),
    );
    await expect(
      h.call('sessions.create', { agentId: 'sh', home: join(h.home, 'missing') }),
    ).rejects.toSatisfy((e: unknown) => isFault(e, 'invalid'));
  });

  it('refuses sessions.create with server_stopping while stopping, creating nothing', async () => {
    const h = harness({ stopping: true });
    await expect(h.call('sessions.create', { agentId: 'sh', home: h.home })).rejects.toSatisfy(
      (e: unknown) => isFault(e, 'server_stopping'),
    );
    expect(h.domain.sessions.list()).toHaveLength(0);
  });

  it('maps an unconfirmed MCP open to DomainOpenOutcome with the sessionId', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => ({
      ok: false,
      refusal: { reason: 'spawn_unconfirmed', launchId: c.ids.launchId },
    });
    const h = harness({ runtime });
    const caller = await h.create();
    const outcome = await h.domain.domain.openSession({
      callerSessionId: caller,
      openedBy: { handle: 'a1', sessionId: caller },
      home: h.home,
      label: 'worker',
      focus: false,
      launch: { kind: 'agent', agentId: 'sh' },
    });
    expect(outcome).toMatchObject({ ok: false, code: 'spawn_unconfirmed' });
    const sessionId = outcome.ok ? '' : 'sessionId' in outcome ? outcome.sessionId : '';
    expect(h.domain.sessions.get(sessionId)?.name).toBe('worker');
  });

  it('maps MCP opens: ok with label, unknown_agent, server_stopping with nothing created', async () => {
    const h = harness();
    const caller = await h.create();
    const req = {
      callerSessionId: caller,
      openedBy: { handle: 'a1', sessionId: caller },
      home: h.home,
      label: 'w',
      focus: true,
    };
    const ok = await h.domain.domain.openSession({
      ...req,
      launch: { kind: 'agent', agentId: 'sh' },
    });
    expect(ok).toMatchObject({ ok: true, label: 'w' });
    expect(h.runtime.spawns).toHaveLength(1);
    expect(
      await h.domain.domain.openSession({ ...req, launch: { kind: 'agent', agentId: 'zz' } }),
    ).toMatchObject({ ok: false, code: 'unknown_agent' });
    const count = h.domain.sessions.list().length;
    h.state.stopping = true;
    expect(
      await h.domain.domain.openSession({ ...req, launch: { kind: 'agent', agentId: 'sh' } }),
    ).toMatchObject({ ok: false, code: 'server_stopping' });
    expect(h.domain.sessions.list()).toHaveLength(count);
  });
});

describe('server domain: restart, retry, discard, close', () => {
  it('restart retires the terminal, bumps restartSeq and keeps the status running', async () => {
    const h = harness();
    const id = await h.create();
    await start(h, id);
    const r = await h.call('sessions.restart', { sessionId: id });
    expect(r).toEqual({ ok: true, sessionId: id });
    expect(h.calls).toContain(`retire:${id}`);
    expect(h.calls).not.toContain(`kill:${id}`);
    const view = h.domain.snapshot().sessions.find((s) => s.id === id);
    expect(view?.status).toBe('running');
    expect(view?.restartSeq).toBe(1);
    // The remounted pane's start is the spawn, with a new generation.
    const again = (await start(h, id)) as Started;
    expect(again.spawned).toBe(true);
    expect(again.generation).toBe(2);
  });

  it('retryLaunch is a new launch; discardLaunch discards through C1', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => ({
      ok: false,
      refusal: { reason: 'spawn_unconfirmed', launchId: c.ids.launchId },
    });
    const h = harness({ runtime });
    const id = await h.create();
    await start(h, id);
    const firstLaunch = runtime.spawns[0]?.ids.launchId;
    runtime.nextSpawn = undefined;
    const retried = (await h.call('sessions.retryLaunch', { sessionId: id })) as Started;
    expect(retried).toMatchObject({ ok: true, spawned: true, generation: 2 });
    expect(runtime.spawns[1]?.ids.launchId).not.toBe(firstLaunch);

    const other = await h.create();
    runtime.nextSpawn = async (c) => ({
      ok: false,
      refusal: { reason: 'spawn_unconfirmed', launchId: c.ids.launchId },
    });
    await start(h, other);
    const launchId = runtime.spawns[2]?.ids.launchId;
    await h.call('sessions.discardLaunch', { sessionId: other });
    expect(h.calls).toContain(`discardLaunch:${other}:${launchId}`);
    expect(h.domain.snapshot().sessions.find((s) => s.id === other)?.runtime.spawn).toBe('none');
  });

  it('sessions.remove and DomainPort.closeSession share one close', async () => {
    const h = harness();
    const a = await h.create();
    const b = await h.create();
    await start(h, a);
    await start(h, b);
    await h.call('sessions.remove', { sessionId: a });
    expect(await h.domain.domain.closeSession(b, {})).toEqual({ ok: true });
    for (const id of [a, b]) {
      expect(h.calls).toContain(`kill:${id}`);
      expect(h.calls).toContain(`onSessionDeleted:${id}`);
      expect(h.calls).toContain(`forget:${id}`);
      expect(h.domain.sessions.get(id)).toBeUndefined();
    }
    expect(await h.domain.domain.closeSession(a, {})).toMatchObject({
      ok: false,
      code: 'unknown_session',
    });
  });

  it('closing an unconfirmed session discards its launch instead of killing', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => ({
      ok: false,
      refusal: { reason: 'spawn_unconfirmed', launchId: c.ids.launchId },
    });
    const h = harness({ runtime });
    const id = await h.create();
    await start(h, id);
    await h.domain.domain.closeSession(id, {});
    expect(h.calls.some((c) => c.startsWith(`discardLaunch:${id}:`))).toBe(true);
    expect(h.calls).not.toContain(`kill:${id}`);
  });
});

describe('server domain: request validation', () => {
  it('answers a mutation of an unknown session not-ok, per C2', async () => {
    const h = harness();
    for (const mutation of [
      { op: 'rename', name: 'x' },
      { op: 'setIconOverride', icon: 'a' },
    ])
      expect(await h.call('sessions.mutate', { sessionId: 'nope', mutation })).toEqual({
        ok: false,
        reason: 'unknown-session',
      });
  });

  it('refuses non-string ids as invalid', async () => {
    const h = harness();
    const requests: [string, Record<string, unknown>][] = [
      ['timers.cancel', { id: 5 }],
      ['timers.renew', { id: 5 }],
      ['projects.delete', { id: 3 }],
      ['projects.rename', { id: 3, name: 'n' }],
      ['sessions.relaunch', { sessionIds: [1] }],
    ];
    for (const [method, params] of requests)
      await expect(h.call(method, params)).rejects.toSatisfy((e: unknown) => isFault(e, 'invalid'));
  });

  it('ignores a late runtime event for a closed session', async () => {
    const h = harness();
    const id = await h.create();
    await start(h, id);
    await h.call('sessions.remove', { sessionId: id });
    await vi.waitFor(() =>
      expect(
        h.events.some(
          (e) =>
            e.type === 'sessions.changed' &&
            (e.data as { sessions: { id: string }[] }).sessions.length === 0,
        ),
      ).toBe(true),
    );
    const before = h.types().length;
    h.runtime.fire({ type: 'status', sessionId: id, status: { state: 'working' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.types().slice(before)).toEqual([]);
  });
});
