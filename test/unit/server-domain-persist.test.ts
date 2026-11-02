import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { harness } from '../../server/domain/testing/fakes';
import type { ServerSettings } from '../../src/contracts/server-protocol';

const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');
const json = (dir: string, name: string) => JSON.parse(read(dir, name));
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
    expect(file.settings.autoResumeOnLimit).toBe('offer');
    expect('theme' in file.settings).toBe(false);
    h.domain.dispose();

    // Seeded once: a later settings.json never overrides the server's own file.
    writeFileSync(join(h.userData, 'settings.json'), v051Settings({ trackCwd: true }));
    const again = harness({ userData: h.userData });
    expect(again.domain.settings().trackCwd).toBe(false);
    again.domain.dispose();
  });

  it('patches key-scoped and coerced, writes the file and emits serverSettings.changed', async () => {
    const h = harness();
    const r = (await h.call('serverSettings.patch', {
      patch: { trackCwd: false, theme: 'dark', autoResumeOnLimit: 'bogus' },
    })) as { settings: ServerSettings };
    expect(r.settings.trackCwd).toBe(false);
    expect(r.settings.autoResumeOnLimit).toBe('arm');
    expect('theme' in r.settings).toBe(false);
    expect(json(h.userData, 'server-settings.json').settings.trackCwd).toBe(false);
    const changed = h.events.filter((e) => e.type === 'serverSettings.changed');
    expect(changed).toEqual([{ type: 'serverSettings.changed', data: { settings: r.settings } }]);
    // Never the app's settings.json.
    expect(existsSync(join(h.userData, 'settings.json'))).toBe(false);
    h.domain.dispose();
  });

  it('refuses to overwrite a newer server-settings.json', async () => {
    const newer = JSON.stringify({ version: 99, settings: { trackCwd: false } });
    const h = harness({ files: { 'server-settings.json': newer } });
    await h.call('serverSettings.patch', { patch: { trackCwd: true } });
    expect(read(h.userData, 'server-settings.json')).toBe(newer);
    h.domain.dispose();
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
    await h.call('sessions.start', { sessionId: id });
    await h.call('timers.set', {
      schedule: { sessionId: id, message: 'x', trigger: { kind: 'in', delayMs: 3_600_000 } },
    });
    await expect(h.call('projects.create', { name: 'P', requestId: 1 })).rejects.toBeTruthy();
    await h.domain.persist();
    for (const [name, text] of Object.entries(files)) expect(read(h.userData, name)).toBe(text);
    h.domain.dispose();
  });

  it('blocks launcher writes on a newer launchers.json', async () => {
    const newer = JSON.stringify({ version: 99, usage: {}, custom: [] });
    const h = harness({ files: { 'launchers.json': newer } });
    await h.create();
    await h.call('launchers.addCustom', { commandLine: 'node --version', requestId: 1 });
    await h.domain.persist();
    expect(read(h.userData, 'launchers.json')).toBe(newer);
    h.domain.dispose();
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
    a.domain.dispose();

    // A restart reopens only what reconcile adopted or left unconfirmed.
    const b = harness({ userData: a.userData });
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
    b.domain.dispose();
  });

  it('restoreSessions:true reopens every session as stale', async () => {
    const a = harness();
    const id = await a.create();
    await a.domain.persist();
    a.domain.dispose();
    const b = harness({ userData: a.userData });
    expect(b.domain.snapshot().sessions.map((s) => [s.id, s.status])).toEqual([[id, 'stale']]);
    b.domain.dispose();
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

    // A foreign path is ignored.
    h.domain.handle({
      method: 'folders.suspect',
      params: { sessionId: id, path: join(h.home, 'zz') },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.domain.sessions.get(id)?.missingRoots).toBeUndefined();

    await h.domain.handle({ method: 'folders.suspect', params: { sessionId: id, path: root } });
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.missingRoots).toEqual([root]));

    mkdirSync(root);
    const presence = (focused: boolean) => [
      { windowId: 1, focused, ready: true, visibleSessionIds: [id], ownedSessionIds: [id] },
    ];
    h.domain.presence(presence(false));
    h.domain.presence(presence(true));
    await vi.waitFor(() => expect(h.domain.sessions.get(id)?.missingRoots).toBeUndefined());
    h.domain.dispose();
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
    h.domain.dispose();
  });
});
