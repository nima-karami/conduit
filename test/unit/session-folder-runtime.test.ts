import { describe, expect, it } from 'vitest';
import type { FsFire } from '../../electron/project-watcher';
import { SessionFolderRuntime } from '../../electron/session-folder-runtime';
import type { Session } from '../../src/types';

function session(id: string, home: string, roots: string[] = []): Session {
  return {
    id,
    name: id,
    agentId: 'claude',
    home,
    roots,
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function harness() {
  const sessions = [session('a', '/w/a'), session('b', '/w/b')];
  const events: string[] = [];
  const logs: string[] = [];
  const armed: string[][] = [];
  let fire: (f: FsFire) => void = () => {};
  let suspect: (folders: string[]) => void = () => {};
  const rt = new SessionFolderRuntime({
    mgr: { get: (id) => sessions.find((s) => s.id === id), list: () => sessions },
    scheduleRepoScan: (id) => events.push(`scan:${id}`),
    reconcilePlans: (homes) => events.push(`plans:${homes.join(',')}`),
    broadcastFsChanged: (f) => events.push(`fs:${f.root}|${f.folders.join(',')}`),
    dropResolutionsForRoot: (root) => events.push(`drop:${root}`),
    createWatcher: (onFire, onSuspect) => {
      fire = onFire;
      suspect = onSuspect;
      return {
        setFolders: (f) => armed.push([...f]),
        stop: () => events.push('watch:stop'),
      };
    },
    log: (level, msg) => logs.push(`${level}:${msg}`),
  });
  return {
    rt,
    sessions,
    events,
    logs,
    armed,
    fire: (f: FsFire) => fire(f),
    suspect: (f: string[]) => suspect(f),
  };
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

  it('stop drops hook subscribers and stops the watcher', () => {
    const h = harness();
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.stop();
    expect(h.events).toEqual(['watch:stop']);
    h.events.length = 0;
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.events).toEqual(['scan:a']);
  });
});

describe('SessionFolderRuntime (watcher)', () => {
  it('requestProject arms watchFoldersFor(p, session)', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R', '/x/gone'];
    h.sessions[0].missingRoots = ['/x/gone'];
    h.rt.requestProject('/w/a/sub', 'a');
    expect(h.armed).toEqual([['/w/a/sub', '/w/a', '/x/R']]);
    expect(h.events).toContain('plans:/w/a,/w/b');
    h.rt.requestProject('/w/b', undefined);
    h.rt.requestProject('/w/b', 'unknown');
    expect(h.armed.slice(1)).toEqual([['/w/b'], ['/w/b']]);
    h.rt.requestProject('', 'a');
    expect(h.armed).toHaveLength(3);
  });

  it('requestProject rescans every session containing p (home or root) — N1', () => {
    const h = harness();
    h.sessions.push(session('c', '/elsewhere', ['/w/a/pkg']), session('d', '/w/a/pkg/deep'));
    h.rt.requestProject('/w/a/pkg/src', 'a');
    expect(h.events.filter((e) => e.startsWith('scan:'))).toEqual(['scan:a', 'scan:c']);
  });

  it('fire → one broadcast, dropResolutions per folder, each owning session rescanned once', () => {
    const h = harness();
    h.sessions.push(session('c', '/x/R'), session('d', '/w/a/sub'), session('e', '/w'));
    h.sessions[1].roots = ['/x/R'];
    h.fire({ root: '/w/a/sub', folders: ['/w/a/sub', '/w/a', '/x/R'] });
    expect(h.events).toEqual([
      'fs:/w/a/sub|/w/a/sub,/w/a,/x/R',
      'drop:/w/a/sub',
      'drop:/w/a',
      'drop:/x/R',
      'scan:a',
      'scan:b',
      'scan:c',
      'scan:d',
    ]);
  });

  it('a suspect watch is logged', () => {
    const h = harness();
    h.suspect(['/x/R']);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^warn:/);
  });

  it('foldersChanged on the watched session re-arms; on another does not', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a');
    h.armed.length = 0;
    h.sessions[0].roots = ['/x/R'];
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.armed).toEqual([['/w/a', '/w/a', '/x/R']]);
    h.sessions[1].roots = ['/x/S'];
    h.rt.foldersChanged('b', { homeChanged: false });
    expect(h.armed).toHaveLength(1);
  });
});
