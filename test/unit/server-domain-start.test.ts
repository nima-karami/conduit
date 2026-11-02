import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeRuntime, harness, isFault } from '../../server/domain/testing/fakes';
import type { SessionStartResult } from '../../src/contracts/server-protocol';
import { COMMAND_AGENT_ID } from '../../src/session-command';

type Started = Extract<SessionStartResult, { ok: true; target: unknown }>;

const start = async (h: ReturnType<typeof harness>, sessionId: string) =>
  (await h.call('sessions.start', { sessionId })) as SessionStartResult;

const persisted = (userData: string) =>
  JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as {
    sessions: { id: string; lastGeneration?: number }[];
  };

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
    b.domain.dispose();
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
    h.domain.dispose();
  });

  it('takes the prelude from ScrollbackPort and shows the relaunch padding through show', async () => {
    const replay = {
      data: 'old history',
      replay: [{ length: 11, geometry: { cols: 80, rows: 30 } }],
    };
    const h = harness({ replay });
    const id = await h.create();
    const r = (await start(h, id)) as Started;
    expect(r.prelude).toEqual(replay);
    expect(r.spawned).toBe(true);
    expect(h.calls).toContain(`replay:${id}`);
    // Host-composed bytes never go through TypingPort.
    expect(h.shown.some((s) => s.data.includes('session relaunched'))).toBe(true);
    expect(h.written).toEqual([]);
    h.domain.dispose();
  });

  it('returns spawned:false for a live session: no prelude, no second run', async () => {
    const h = harness({ replay: { data: 'x', replay: [{ length: 1 }] } });
    const id = await h.create();
    await start(h, id);
    const again = (await start(h, id)) as Started;
    expect(again).toMatchObject({ ok: true, spawned: false, generation: 1 });
    expect(again.prelude).toBeUndefined();
    expect(h.runtime.spawns).toHaveLength(1);
    h.domain.dispose();
  });

  it('shares one spawn between concurrent starts', async () => {
    const h = harness();
    const id = await h.create();
    const [a, b] = await Promise.all([start(h, id), start(h, id)]);
    expect(h.runtime.spawns).toHaveLength(1);
    expect([a, b].map((r) => r.ok && 'spawned' in r && r.spawned).sort()).toEqual([false, true]);
    h.domain.dispose();
  });

  it('returns a finished start with its output as prelude and marks the session exited', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async (c) => ({
      ok: true,
      launchId: c.ids.launchId,
      finished: { exitCode: 3, reason: 'exited' },
    });
    const h = harness({ runtime, replay: { data: 'bye', replay: [{ length: 3 }] } });
    const id = await h.create();
    const r = await start(h, id);
    expect(r).toEqual({
      ok: true,
      finished: { exitCode: 3, reason: 'exited' },
      prelude: { data: 'bye', replay: [{ length: 3 }] },
    });
    expect((h.domain.sessions.get(id) ?? { status: '' }).status).toBe('exited');
    h.domain.dispose();
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
    h.domain.dispose();
  });

  it('refuses server_stopping in the result', async () => {
    const runtime = new FakeRuntime();
    runtime.nextSpawn = async () => ({ ok: false, refusal: { reason: 'server_stopping' } });
    const h = harness({ runtime });
    const id = await h.create();
    expect(await start(h, id)).toEqual({ ok: false, refusal: { reason: 'server_stopping' } });
    expect(h.shown.some((s) => s.sessionId === id)).toBe(true);
    h.domain.dispose();
  });

  it("shows the can't-start line through show and refuses unresolvable in the result", async () => {
    const h = harness();
    h.deps.resolveCommand = () => undefined;
    const id = await h.create();
    const r = await start(h, id);
    expect(r).toEqual({ ok: false, refusal: { reason: 'unresolvable', command: 'sh' } });
    expect(h.shown.find((s) => s.sessionId === id)?.data).toContain("can't start: sh not found");
    expect(h.runtime.spawns).toHaveLength(0);
    expect(h.domain.snapshot().sessions.find((s) => s.id === id)?.startRefusal).toEqual({
      reason: 'unresolvable',
      command: 'sh',
    });
    h.domain.dispose();
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
    h.domain.dispose();

    // A saved open_terminal command that failed coercion is kept and refused at start.
    const bad = { id: 'cmd1', name: 'c', agentId: COMMAND_AGENT_ID, home: h.home, roots: [] };
    const c = harness({
      files: { 'sessions.json': JSON.stringify({ version: 1, sessions: [bad] }) },
    });
    expect(await start(c, 'cmd1')).toEqual({ ok: false, refusal: { reason: 'command-invalid' } });
    expect(c.runtime.spawns).toHaveLength(0);
    expect(c.shown.some((s) => s.data.includes('saved command is invalid'))).toBe(true);
    c.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
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
    h.domain.dispose();
  });
});
