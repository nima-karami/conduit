import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeHarnesses, harness, isFault } from '../../server/domain/testing/fakes';
import { APP_SESSION_FIELDS, type ServerSettings } from '../../src/contracts/server-protocol';

const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');
const json = (dir: string, name: string) => JSON.parse(read(dir, name));
afterEach(disposeHarnesses);

const v051Settings = (settings: Record<string, unknown>) =>
  JSON.stringify({ version: 1, settings });

describe('server domain: server settings', () => {
  it('seeds server-settings.json once from v0.51 settings.json, server keys only', async () => {
    const h = harness({
      files: {
        'settings.json': v051Settings({
          trackCwd: false,
          theme: 'light',
          autoResumeOnLimit: 'offer',
        }),
      },
    });
    const file = json(h.userData, 'server-settings.json');
    expect(file.version).toBe(1);
    expect(file.settings.trackCwd).toBe(false);
    // The pre-CON-11 key migrates on the way in (spec 2026-11-13 §3 "Settings").
    expect(file.settings.autoResume).toBe('ask');
    expect('theme' in file.settings).toBe(false);

    // Seeded once: a later settings.json never overrides the server's own file.
    writeFileSync(join(h.userData, 'settings.json'), v051Settings({ trackCwd: true }));
    await h.domain.dispose();
    const again = harness({ userData: h.userData });
    expect(again.domain.settings().trackCwd).toBe(false);
  });

  it('patches key-scoped and coerced, writes the file and emits serverSettings.changed', async () => {
    const h = harness();
    const r = (await h.call('serverSettings.patch', {
      patch: { trackCwd: false, theme: 'dark', autoResume: 'bogus' },
    })) as { settings: ServerSettings };
    expect(r.settings.trackCwd).toBe(false);
    expect(r.settings.autoResume).toBe('on');
    expect('theme' in r.settings).toBe(false);
    expect(json(h.userData, 'server-settings.json').settings.trackCwd).toBe(false);
    const changed = h.events.filter((e) => e.type === 'serverSettings.changed');
    expect(changed).toEqual([{ type: 'serverSettings.changed', data: { settings: r.settings } }]);
    // Never the app's settings.json.
    expect(existsSync(join(h.userData, 'settings.json'))).toBe(false);
  });

  it('backs up a corrupt server-settings.json, logs it, then seeds', async () => {
    const corrupt = '{ not json';
    const h = harness({
      files: {
        'server-settings.json': corrupt,
        'settings.json': v051Settings({ trackCwd: false }),
      },
    });
    expect(read(h.userData, 'server-settings.corrupt.json')).toBe(corrupt);
    expect(json(h.userData, 'server-settings.json')).toMatchObject({
      version: 1,
      settings: { trackCwd: false },
    });
    expect(h.logs.some((l) => l.includes('server-settings.json is corrupt'))).toBe(true);
  });

  it('keeps the first corrupt backup when a later corruption is re-seeded', async () => {
    const h = harness({
      files: { 'server-settings.json': '{ second', 'server-settings.corrupt.json': '{ first' },
    });
    expect(read(h.userData, 'server-settings.corrupt.json')).toBe('{ first');
    expect(json(h.userData, 'server-settings.json').version).toBe(1);
  });

  it('never overwrites a corrupt server-settings.json whose backup failed', async () => {
    const corrupt = '{ not json';
    const userData = mkdtempSync(join(tmpdir(), 'conduit-w4-backup-'));
    try {
      writeFileSync(join(userData, 'server-settings.json'), corrupt);
      // A directory in the backup's place makes the backup write fail.
      mkdirSync(join(userData, 'server-settings.corrupt.json', 'x'), { recursive: true });
      const h = harness({ userData });
      await h.call('serverSettings.patch', { patch: { trackCwd: false } });
      expect(read(userData, 'server-settings.json')).toBe(corrupt);
      expect(h.logs.some((l) => l.includes('backup failed'))).toBe(true);
      await h.domain.dispose();
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a newer server-settings.json', async () => {
    const newer = JSON.stringify({ version: 99, settings: { trackCwd: false } });
    const h = harness({ files: { 'server-settings.json': newer } });
    await h.call('serverSettings.patch', { patch: { trackCwd: true } });
    expect(read(h.userData, 'server-settings.json')).toBe(newer);
  });
});

describe('server domain: persisted formats', () => {
  it('never overwrites a newer sessions.json, timed-messages.json or projects.json', async () => {
    const files = {
      'sessions.json': JSON.stringify({ version: 99, sessions: [] }),
      'timed-messages.json': JSON.stringify({ version: 99, schedules: [] }),
      'projects.json': JSON.stringify({ version: 99, projects: [] }),
    };
    const h = harness({ files });
    h.domain.adopted([]);
    const id = await h.create();
    await expect(h.call('sessions.start', { sessionId: id })).rejects.toSatisfy((e: unknown) =>
      isFault(e, 'unavailable'),
    );
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'x', trigger: { kind: 'in', delayMs: 3_600_000 } },
    });
    await expect(h.call('projects.create', { name: 'P', requestId: 1 })).rejects.toSatisfy(
      (e: unknown) => isFault(e, 'unavailable'),
    );
    await h.domain.persist();
    for (const [name, text] of Object.entries(files)) expect(read(h.userData, name)).toBe(text);
  });

  // see spec 2026-11-13-scheduler-auto-resume §3 "Job (persisted)" and R9.
  it('migrates timed-messages.json v1 into scheduler.json v2 and leaves the old file untouched', async () => {
    const first = harness();
    const id = await first.create();
    await first.domain.persist();
    await first.domain.dispose();
    const v1 = JSON.stringify({
      version: 1,
      schedules: [
        {
          id: 'tm-1',
          sessionId: id,
          message: 'hello',
          kind: 'once',
          nextAt: Date.now() + 3_600_000,
          maxRepeats: 1,
          firedCount: 0,
          state: 'armed',
          origin: 'manual',
          createdAt: Date.now(),
        },
      ],
    });
    // A pre-CON-11 tree: sessions.json and timed-messages.json, no scheduler.json yet.
    rmSync(join(first.userData, 'scheduler.json'), { force: true });
    writeFileSync(join(first.userData, 'timed-messages.json'), v1);
    const h = harness({ userData: first.userData });
    h.domain.adopted([]);
    await vi.waitFor(() =>
      expect(h.domain.snapshot().timers.jobs?.map((j) => j.id)).toEqual(['tm-1']),
    );
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'x', trigger: { kind: 'in', delayMs: 7_200_000 } },
    });
    await h.domain.persist();
    expect(read(h.userData, 'timed-messages.json')).toBe(v1);
    const v2 = json(h.userData, 'scheduler.json');
    expect(v2.version).toBe(2);
    expect(v2.jobs.map((j: { id: string }) => j.id)).toContain('tm-1');
  });

  it('never overwrites a newer scheduler.json', async () => {
    const newer = JSON.stringify({ version: 99, jobs: [], episodes: [] });
    const h = harness({ files: { 'scheduler.json': newer } });
    h.domain.adopted([]);
    const id = await h.create();
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'x', trigger: { kind: 'in', delayMs: 3_600_000 } },
    });
    await h.domain.persist();
    expect(read(h.userData, 'scheduler.json')).toBe(newer);
  });

  it('blocks launcher writes on a newer launchers.json', async () => {
    const newer = JSON.stringify({ version: 99, usage: {}, custom: [] });
    const h = harness({ files: { 'launchers.json': newer } });
    await h.create();
    await h.call('launchers.addCustom', { commandLine: 'node --version', requestId: 1 });
    await h.domain.persist();
    expect(read(h.userData, 'launchers.json')).toBe(newer);
  });

  it("a person's sessions.create pushes the bumped launcher usage; an MCP open pushes none", async () => {
    const h = harness();
    h.events.length = 0;
    await h.call('sessions.create', { agentId: 'sh', home: h.home });
    const pushed = h.events
      .filter((e) => e.type === 'data.changed')
      .map((e) => e.data as { store: string; value: { id: string; uses: number }[] })
      .filter((d) => d.store === 'launchers');
    expect(pushed.at(-1)?.value.find((l) => l.id === 'sh')?.uses).toBe(1);

    h.events.length = 0;
    await h.call('sessions.create', {
      agentId: 'sh',
      home: h.home,
      openedBy: { handle: 'fake-1', sessionId: 'opener' },
    });
    expect(h.events.filter((e) => e.type === 'data.changed')).toEqual([]);
  });

  it('restoreSessions:false keeps live and unconfirmed sessions with their lastGeneration, drops the rest', async () => {
    const a = harness({
      files: {
        'server-settings.json': JSON.stringify({
          version: 1,
          settings: { restoreSessions: false },
        }),
      },
    });
    a.domain.adopted([]);
    const liveId = await a.create();
    const idle = await a.create();
    const unconfirmed = await a.create();
    await a.call('sessions.start', { sessionId: liveId });
    a.runtime.fire({
      type: 'unconfirmed',
      sessionId: unconfirmed,
      generation: 1,
      launchId: 'b'.repeat(32),
    });
    await a.domain.persist();
    const ids = json(a.userData, 'sessions.json').sessions.map((s: { id: string }) => s.id);
    expect(ids.sort()).toEqual([liveId, unconfirmed].sort());
    expect(ids).not.toContain(idle);

    // A restart reopens only what reconcile adopted or left unconfirmed.
    await a.domain.dispose();
    const b = harness({ userData: a.userData, reconciled: false });
    b.runtime.fire({
      type: 'unconfirmed',
      sessionId: unconfirmed,
      generation: 1,
      launchId: 'b'.repeat(32),
    });
    const terminal = b.runtime.live(liveId, 1, 'c'.repeat(32), { cols: 80, rows: 24 });
    b.domain.adopted([
      {
        ...terminal,
        labels: {
          'conduit.session': liveId,
          'conduit.instance': 'inst',
          'conduit.generation': '1',
          'conduit.launch': 'c'.repeat(32),
          'conduit.role': 'session',
        },
      },
    ]);
    const views = b.domain.snapshot().sessions;
    expect(views.map((s) => s.id).sort()).toEqual([liveId, unconfirmed].sort());
    expect(views.find((s) => s.id === liveId)).toMatchObject({
      status: 'running',
      runtime: { spawn: 'live', generation: 1 },
    });
    expect(views.find((s) => s.id === unconfirmed)?.runtime.spawn).toBe('unconfirmed');
    expect(b.domain.sessions.allocateLaunch(liveId).generation).toBe(2);
  });

  it('sends views without the app fields or the launch counter', async () => {
    const h = harness();
    const id = await h.create();
    await h.call('sessions.start', { sessionId: id });
    const record = h.domain.sessions.get(id);
    expect(record).toHaveProperty('lastGeneration', 1);
    // SessionManager's imported repo logic writes these on the shared record.
    if (record) Object.assign(record, { repoPinned: false, repos: [], autoRepoRoot: h.home });
    const view = h.domain.snapshot().sessions.find((s) => s.id === id) ?? {};
    for (const k of [...APP_SESSION_FIELDS, 'lastGeneration']) expect(k in view).toBe(false);
  });

  it('views carry neutral attention facts, and sessions.json never stores them', async () => {
    const h = harness();
    const id = await h.create();
    expect(h.domain.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
      attentionReason: null,
      completions: 0,
    });
    const record = h.domain.sessions.get(id);
    if (record) Object.assign(record, { attentionReason: 'blocked', completions: 2 });
    await h.domain.persist();
    const stored = json(h.userData, 'sessions.json').sessions[0];
    expect(stored).not.toHaveProperty('attentionReason');
    expect(stored).not.toHaveProperty('completions');
  });

  it('restoreSessions:true reopens every session as stale', async () => {
    const a = harness();
    const id = await a.create();
    await a.domain.persist();
    await a.domain.dispose();
    const b = harness({ userData: a.userData });
    expect(b.domain.snapshot().sessions.map((s) => [s.id, s.status])).toEqual([[id, 'stale']]);
  });

  // D21: after restore the rest stay stale. stopAll's leftover token rows emit C1 exit
  // (killed/lost) during the next server's reconcile; that must not read as "the agent quit".
  it.each(['killed', 'lost'] as const)(
    'a %s exit after restore stays stale (cold stop, not an agent quit)',
    async (reason) => {
      const a = harness();
      const id = await a.create();
      await a.call('sessions.start', { sessionId: id });
      await a.domain.persist();
      await a.domain.dispose();

      const b = harness({ userData: a.userData, reconciled: false });
      expect(b.domain.snapshot().sessions.find((s) => s.id === id)?.status).toBe('stale');
      b.runtime.fire({ type: 'exit', sessionId: id, generation: 1, code: 1, reason });
      expect(b.domain.snapshot().sessions.find((s) => s.id === id)?.status).toBe('stale');
    },
  );

  it('a running session reads exited on any exit, a kill included', async () => {
    const a = harness();
    const id = await a.create();
    await a.call('sessions.start', { sessionId: id });
    expect(a.domain.snapshot().sessions.find((s) => s.id === id)?.status).toBe('running');
    a.runtime.fire({ type: 'exit', sessionId: id, generation: 1, code: 1, reason: 'killed' });
    expect(a.domain.snapshot().sessions.find((s) => s.id === id)?.status).toBe('exited');
  });

  it('an agent that quit on its own while no server watched reads exited after restore', async () => {
    const a = harness();
    const id = await a.create();
    await a.call('sessions.start', { sessionId: id });
    await a.domain.persist();
    await a.domain.dispose();

    const b = harness({ userData: a.userData, reconciled: false });
    b.runtime.fire({ type: 'exit', sessionId: id, generation: 1, code: 0, reason: 'exited' });
    expect(b.domain.snapshot().sessions.find((s) => s.id === id)?.status).toBe('exited');
  });
});

describe('server domain: folder health', () => {
  it('rechecks on a ui.presence focus change and on folders.suspect for own folders only', async () => {
    const h = harness();
    const root = join(h.userData, 'root');
    mkdirSync(root);
    const id = await h.create({ roots: [root] });
    expect(h.domain.sessions.get(id)?.roots).toEqual([root]);
    // relaunch awaits the create's own health check, which would otherwise answer the next one.
    await h.call('sessions.relaunch', { sessionIds: [id] });
    rmSync(root, { recursive: true });

    await h.domain.handle({ method: 'folders.suspect', params: { sessionId: id, path: root } });
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.missingRoots).toEqual([root]));

    mkdirSync(root);
    const presence = (focused: boolean) => [
      { windowId: 1, focused, ready: true, visibleSessionIds: [id], ownedSessionIds: [id] },
    ];
    h.domain.presence(presence(false));
    h.domain.presence(presence(true));
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.missingRoots).toBeUndefined());
  });

  it('rechecks a session the focused window newly shows', async () => {
    const h = harness();
    const home = join(h.userData, 'proj');
    mkdirSync(home);
    const id = await h.create({ home });
    await h.call('sessions.relaunch', { sessionIds: [id] });
    rmSync(home, { recursive: true });
    await h.domain.handle({ method: 'folders.suspect', params: { sessionId: id, path: home } });
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.homeMissing).toBe(true));
    const win = (visibleSessionIds: string[]) => [
      { windowId: 3, focused: true, ready: true, visibleSessionIds, ownedSessionIds: [id] },
    ];
    h.domain.presence(win([]));
    mkdirSync(home);
    h.domain.presence(win([id]));
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.homeMissing).toBeUndefined());
  });

  it('a home that came back clears on the focus recheck', async () => {
    const h = harness();
    const home = join(h.userData, 'proj');
    mkdirSync(home);
    const id = await h.create({ home });
    // relaunch awaits the create's own health check, which would otherwise answer the next one.
    await h.call('sessions.relaunch', { sessionIds: [id] });
    rmSync(home, { recursive: true });
    await h.domain.handle({ method: 'folders.suspect', params: { sessionId: id, path: home } });
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.homeMissing).toBe(true));
    mkdirSync(home);
    h.domain.presence([
      { windowId: 2, focused: true, ready: true, visibleSessionIds: [id], ownedSessionIds: [id] },
    ]);
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.homeMissing).toBeUndefined());
  });
});

describe('server domain: reloadAgents', () => {
  const agent = (id: string, command: string) => ({
    id,
    label: id,
    command,
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  });

  it('re-reads agents.json, shows the new definition and emits data.changed for agents and launchers', () => {
    const h = harness({ files: { 'agents.json': JSON.stringify([agent('my-a', 'a')]) } });
    const ids = () => (h.domain.snapshot().stores.agents as { id: string }[]).map((d) => d.id);
    expect(ids()).toContain('my-a');
    h.events.length = 0;

    h.domain.reloadAgents();
    expect(h.events.filter((e) => e.type === 'data.changed')).toEqual([]);

    writeFileSync(join(h.userData, 'agents.json'), JSON.stringify([agent('my-b', 'b')]));
    h.domain.reloadAgents();
    expect(ids()).toContain('my-b');
    expect(ids()).not.toContain('my-a');
    const stores = h.events
      .filter((e) => e.type === 'data.changed')
      .map((e) => (e.data as { store: string }).store);
    expect(stores).toEqual(expect.arrayContaining(['agents', 'launchers']));
  });
});
