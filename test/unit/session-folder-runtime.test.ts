import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDiff, SessionFolderDiff } from '../../electron/app-session-store';
import type { FsFire } from '../../electron/project-watcher';
import { SessionFolderRuntime } from '../../electron/session-folder-runtime';
import { SUSPECT_WINDOW_MS } from '../../src/suspect-backoff';
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

function harness(homeDir = '/nobody') {
  // The store's own objects, so a test's edit to one is the session the runtime reads.
  const sessions: Session[] = [];
  const add = (...more: Session[]) => sessions.push(...more);
  add(session('a', '/w/a'), session('b', '/w/b'));
  const events: string[] = [];
  const logs: string[] = [];
  const logData: (Record<string, unknown> | undefined)[] = [];
  const armed: string[][] = [];
  const suspects: string[] = [];
  let fire: (f: FsFire) => void = () => {};
  let suspect: (folders: string[]) => void = () => {};
  let visible: readonly string[] = [];
  const suspended = new Set<number>();
  const rt = new SessionFolderRuntime({
    store: { get: (id) => sessions.find((s) => s.id === id), list: () => sessions },
    visibleSessionIds: () => visible,
    isWindowSuspended: (windowId) => suspended.has(windowId),
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
    suspect: (id, path) => suspects.push(`${id}:${path}`),
    log: (level, msg, data) => {
      logs.push(`${level}:${msg}`);
      logData.push(data);
    },
    homeDir,
  });
  return {
    rt,
    sessions,
    add,
    events,
    logs,
    logData,
    armed,
    suspects,
    suspended,
    fire: (f: FsFire) => fire(f),
    suspect: (f: string[]) => suspect(f),
    setVisible: (ids: readonly string[]) => {
      visible = ids;
    },
  };
}

const diff = (
  sessionId: string,
  kind: SessionFolderDiff['kind'],
  homeChanged = false,
): SessionFolderDiff => ({ sessionId, kind, homeChanged, cwdChanged: false });

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

describe('SessionFolderRuntime (server list)', () => {
  it('applied: added scans, changed re-runs foldersChanged, removed re-arms and reconciles', () => {
    const h = harness();
    h.rt.applied([diff('a', 'added'), diff('b', 'added')]);
    expect(h.events).toEqual(['scan:a', 'scan:b']);
    h.events.length = 0;
    h.rt.applied([diff('a', 'changed', true)]);
    expect(h.events).toEqual(['scan:a', 'plans:/w/a,/w/b']);
    h.events.length = 0;
    h.armed.length = 0;
    h.sessions.splice(1, 1);
    h.rt.applied([diff('b', 'removed')]);
    expect(h.events).toEqual(['plans:/w/a']);
    expect(h.armed).toHaveLength(1);
  });

  it('a health mark the server changed rescans, re-arms if watched and emits', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R'];
    h.rt.applied([diff('a', 'added'), diff('b', 'added')]);
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.events.length = 0;
    h.armed.length = 0;
    h.sessions[0].missingRoots = ['/x/R'];
    h.rt.applied([]);
    expect(h.events).toEqual(['scan:a', 'hook:a']);
    expect(h.armed).toEqual([['/w/a']]);
    h.events.length = 0;
    h.rt.applied([]);
    expect(h.events).toEqual([]);
  });

  it('a turnEnded diff is neither a removal nor a folder change', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R'];
    h.rt.applied([diff('a', 'added'), diff('b', 'added')]);
    h.events.length = 0;
    const turnEnded: SessionDiff = { sessionId: 'a', kind: 'turnEnded' };
    h.rt.applied([turnEnded]);
    expect(h.events).toEqual([]);
    h.sessions[0].missingRoots = ['/x/R'];
    h.rt.applied([]);
    expect(h.events).toContain('scan:a');
  });

  it('onSuspect sends folders.suspect per watched session and folder', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R'];
    // Not '/x/R': a second suspect for it inside the backoff window would be deferred.
    h.suspect(['/x/S']);
    expect(h.suspects).toEqual([]);
    expect(h.logs).toHaveLength(1);
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 2);
    h.suspect(['/x/R', '/w/a']);
    expect(h.suspects).toEqual(['a:/x/R', 'a:/w/a']);
  });

  it('onSuspect includes a hidden session whose registered repos keep its folders armed', () => {
    const h = harness();
    h.sessions[1].repos = [{ root: '/w/b', name: 'b', folder: '/w/b', tag: 'home' }];
    h.rt.reposChanged();
    h.suspect(['/w/b']);
    expect(h.armed.at(-1)).toContain('/w/b');
    expect(h.suspects).toEqual(['b:/w/b']);
  });
});

describe('SessionFolderRuntime (watcher)', () => {
  it('keeps both visible windows watched and releases a closed window', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 2);
    expect(h.armed.at(-1)).toEqual(['/w/a', '/w/b']);
    h.rt.windowClosed(1);
    expect(h.armed.at(-1)).toEqual(['/w/b']);
  });

  it('arm unions visible sessions with window projects', () => {
    const h = harness();
    h.add(session('c', '/w/c'));
    h.sessions[0].roots = ['/x/R'];
    h.setVisible(['b', 'nope', 'c']);
    h.rt.requestProject('/w/a', 'a', 1);
    expect(h.armed.at(-1)).toEqual(['/w/a', '/x/R', '/w/b', '/w/c']);
  });

  it('a hidden session stays armed while it holds registered repos; reposChanged re-arms', () => {
    const h = harness();
    h.add(session('c', '/w/c'));
    const repo = (root: string) => ({ root, name: root, folder: root, tag: 'home' as const });
    h.sessions[1].repos = [repo('/w/b')];
    h.sessions[2].repos = [];
    h.rt.requestProject('/w/a', 'a', 1);
    expect(h.armed.at(-1)).toEqual(['/w/a', '/w/b']);
    h.sessions[2].repos = [repo('/w/c')];
    h.rt.reposChanged();
    expect(h.armed.at(-1)).toEqual(['/w/a', '/w/b', '/w/c']);
    h.sessions[1].repos = undefined;
    h.rt.reposChanged();
    expect(h.armed.at(-1)).toEqual(['/w/a', '/w/c']);
  });

  it('visibilityChanged re-arms', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    expect(h.armed.at(-1)).toEqual(['/w/a']);
    h.setVisible(['b']);
    h.rt.visibilityChanged();
    expect(h.armed.at(-1)).toEqual(['/w/a', '/w/b']);
  });

  it('requestProject arms watchFoldersFor(p, session)', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R', '/x/gone'];
    h.sessions[0].missingRoots = ['/x/gone'];
    h.rt.requestProject('/w/a/sub', 'a', 1);
    expect(h.armed).toEqual([['/w/a/sub', '/w/a', '/x/R']]);
    expect(h.events).toContain('plans:/w/a,/w/b');
    h.rt.requestProject('/w/b', undefined, 1);
    h.rt.requestProject('/w/b', 'unknown', 1);
    expect(h.armed.slice(1)).toEqual([['/w/b'], ['/w/b']]);
    h.rt.requestProject('', 'a', 1);
    expect(h.armed).toHaveLength(3);
  });

  it('requestProject rescans every session containing p (home or root) — N1', () => {
    const h = harness();
    h.add(session('c', '/elsewhere', ['/w/a/pkg']), session('d', '/w/a/pkg/deep'));
    h.rt.requestProject('/w/a/pkg/src', 'a', 1);
    expect(h.events.filter((e) => e.startsWith('scan:'))).toEqual(['scan:a', 'scan:c']);
  });

  it('fire → one broadcast, dropResolutions per folder, each owning session rescanned once', () => {
    const h = harness();
    h.add(session('c', '/x/R'), session('d', '/w/a/sub'), session('e', '/w'));
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

  it('foldersChanged on the watched session re-arms; on another does not', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.armed.length = 0;
    h.sessions[0].roots = ['/x/R'];
    h.rt.foldersChanged('a', { homeChanged: false });
    expect(h.armed).toEqual([['/w/a', '/x/R']]);
    h.sessions[1].roots = ['/x/S'];
    h.rt.foldersChanged('b', { homeChanged: false });
    expect(h.armed).toHaveLength(1);
  });

  it('a session in no window still re-arms on foldersChanged while it holds repos', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.sessions[1].repos = [{ root: '/w/b', name: 'b', folder: '/w/b', tag: 'home' }];
    h.armed.length = 0;
    h.sessions[1].roots = ['/x/S'];
    h.rt.foldersChanged('b', { homeChanged: false });
    expect(h.armed).toEqual([['/w/a', '/w/b', '/x/S']]);
  });
});

describe('SessionFolderRuntime (a session whose folder is the home directory)', () => {
  const repo = (root: string) => ({ root, name: root, folder: '/home/me', tag: 'home' as const });

  it('arms each repo inside it as a watch of its own; a normal folder adds none', () => {
    const h = harness('/home/me');
    h.add(session('h', '/home/me'));
    h.sessions[2].repos = [repo('/home/me/src/app'), repo('/home/me'), repo('/elsewhere/r')];
    h.sessions[1].repos = [{ root: '/w/b/sub', name: 'sub', folder: '/w/b', tag: 'home' }];
    h.setVisible(['h', 'b']);
    h.rt.visibilityChanged();
    expect(h.armed.at(-1)).toEqual(['/home/me', '/w/b', '/home/me/src/app']);
  });

  it('a lost repo watch is not a session folder, so the server is not asked to recheck it', () => {
    vi.useFakeTimers();
    try {
      const h = harness('/home/me');
      h.add(session('h', '/home/me'));
      h.sessions[2].repos = [repo('/home/me/src/app')];
      h.rt.reposChanged();
      h.suspect(['/home/me/src/app']);
      expect(h.suspects).toEqual([]);
      h.suspect(['/home/me']);
      expect(h.suspects).toEqual(['h:/home/me']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionFolderRuntime (suspect backoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a folder suspect every second rechecks at once, then once per window with one log line', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    for (let i = 0; i < 10; i++) {
      h.suspect(['/w/a']);
      vi.advanceTimersByTime(1000);
    }
    expect(h.suspects).toEqual(['a:/w/a']);
    expect(h.logs).toEqual(['warn:watch suspect']);
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS - 10_000);
    expect(h.suspects).toEqual(['a:/w/a', 'a:/w/a']);
    expect(h.logs).toEqual(['warn:watch suspect', 'warn:watch suspect']);
    expect(h.logData.at(-1)).toMatchObject({ folders: ['/w/a'], repeats: 9 });
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS * 2);
    expect(h.suspects).toHaveLength(2);
  });

  it('folders back off independently, and stop drops a pending trailing recheck', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 2);
    h.suspect(['/w/a']);
    h.suspect(['/w/a', '/w/b']);
    expect(h.suspects).toEqual(['a:/w/a', 'b:/w/b']);
    h.rt.stop();
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS);
    expect(h.suspects).toEqual(['a:/w/a', 'b:/w/b']);
  });
});
