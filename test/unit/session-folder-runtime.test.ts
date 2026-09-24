import { describe, expect, it } from 'vitest';
import { SessionFolderRuntime } from '../../electron/session-folder-runtime';
import type { Session } from '../../src/types';

function session(id: string, home: string): Session {
  return {
    id,
    name: id,
    agentId: 'claude',
    home,
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function harness() {
  const sessions = [session('a', '/w/a'), session('b', '/w/b')];
  const events: string[] = [];
  const logs: string[] = [];
  const rt = new SessionFolderRuntime({
    mgr: { get: (id) => sessions.find((s) => s.id === id), list: () => sessions },
    scheduleRepoScan: (id) => events.push(`scan:${id}`),
    reconcilePlans: (homes) => events.push(`plans:${homes.join(',')}`),
    log: (level, msg) => logs.push(`${level}:${msg}`),
  });
  return { rt, sessions, events, logs };
}

describe('SessionFolderRuntime (core)', () => {
  it('foldersChanged rescans; homeChanged also reconciles plans over every home', () => {
    const h = harness();
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.events).toEqual(['scan:a']);
    h.events.length = 0;
    h.sessions[0].home = '/w/a2';
    h.rt.foldersChanged('a', { homeChanged: true });
    expect(h.events).toEqual(['scan:a', 'plans:/w/a2,/w/b']);
  });

  it('onFoldersChanged fires after foldersChanged', () => {
    const h = harness();
    const sub = h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.foldersChanged('b', { homeChanged: true });
    expect(h.events).toEqual(['scan:b', 'plans:/w/a,/w/b', 'hook:b']);
    sub.dispose();
    h.events.length = 0;
    h.rt.foldersChanged('b', { homeChanged: false });
    expect(h.events).toEqual(['scan:b']);
  });

  it('a throwing hook is logged and does not stop the others', () => {
    const h = harness();
    h.rt.onFoldersChanged(() => {
      throw new Error('boom');
    });
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.events).toEqual(['scan:a', 'hook:a']);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^warn:.*boom/);
  });

  it('created rescans', () => {
    const h = harness();
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.created('b');
    expect(h.events).toEqual(['scan:b']);
  });

  it('stop drops hook subscribers', () => {
    const h = harness();
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.stop();
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.events).toEqual(['scan:a']);
  });
});
