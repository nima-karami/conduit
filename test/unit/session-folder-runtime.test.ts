import { describe, expect, it } from 'vitest';
import type { FsFire } from '../../electron/project-watcher';
import { SessionFolderRuntime } from '../../electron/session-folder-runtime';
import { AgentRegistry } from '../../src/agent-registry';
import type { Bounded, FolderHealthReport, FolderState } from '../../src/folder-health';
import type { SessionOpReason } from '../../src/folder-validation';
import { SessionManager } from '../../src/session-manager';
import type { AgentDefinition, Session } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};

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
  const mgr = new SessionManager(new AgentRegistry([claude]));
  // The manager's own objects, so a test's edit to one is the session the runtime reads.
  const sessions: Session[] = [];
  const add = (...more: Session[]) => {
    mgr.restore(more);
    sessions.splice(0, sessions.length, ...mgr.list());
  };
  add(session('a', '/w/a'), session('b', '/w/b'));
  const events: string[] = [];
  const logs: string[] = [];
  const armed: string[][] = [];
  const checks: [string, readonly string[] | undefined][] = [];
  const revalidations: string[] = [];
  const reasons = new Map<string, SessionOpReason>();
  const realKeys = new Map<string, string>();
  const realpaths: string[] = [];
  let apply: (r: FolderHealthReport, bounded: Bounded) => Promise<void> = async () => {};
  let pending: Promise<void> | undefined;
  let checkResult: Promise<void> = Promise.resolve();
  let fire: (f: FsFire) => void = () => {};
  let suspect: (folders: string[]) => void = () => {};
  let onBroadcast: (f: FsFire) => void = () => {};
  const rt = new SessionFolderRuntime({
    mgr,
    createHealth: (a) => {
      apply = a;
      return {
        check: (id, only) => {
          checks.push([id, only]);
          return checkResult;
        },
        pending: () => pending,
        dispose: () => events.push('health:dispose'),
      };
    },
    revalidate: async (id, root) => {
      revalidations.push(`${id}:${root}`);
      return reasons.get(root) ?? null;
    },
    realpath: async (p) => {
      realpaths.push(p);
      return `/real${p}`;
    },
    realKeys,
    scheduleRepoScan: (id) => events.push(`scan:${id}`),
    reconcilePlans: (homes) => events.push(`plans:${homes.join(',')}`),
    broadcastFsChanged: (f) => {
      events.push(`fs:${f.root}|${f.folders.join(',')}`);
      onBroadcast(f);
    },
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
  const report = (
    sessionId: string,
    homeKey: string,
    st: Record<string, FolderState>,
    bounded: Bounded = (work) => work(),
  ) => apply({ sessionId, homeKey, states: new Map(Object.entries(st)) }, bounded);
  return {
    rt,
    sessions,
    add,
    events,
    logs,
    armed,
    checks,
    revalidations,
    reasons,
    realKeys,
    realpaths,
    report,
    setPending: (p: Promise<void> | undefined) => {
      pending = p;
    },
    setCheckResult: (p: Promise<void>) => {
      checkResult = p;
    },
    fire: (f: FsFire) => fire(f),
    onBroadcast: (cb: (f: FsFire) => void) => {
      onBroadcast = cb;
    },
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

  it('stop drops hook subscribers, stops the watcher and disposes health', () => {
    const h = harness();
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.rt.stop();
    expect(h.events).toEqual(['watch:stop', 'health:dispose']);
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
    expect(h.armed).toEqual([['/w/a', '/w/a', '/x/R']]);
    h.sessions[1].roots = ['/x/S'];
    h.rt.foldersChanged('b', { homeChanged: false });
    expect(h.armed).toHaveLength(1);
  });
});

describe('SessionFolderRuntime (health)', () => {
  it('restored checks every session; created, foldersChanged and requestProject check theirs', () => {
    const h = harness();
    h.rt.restored();
    h.rt.created('b');
    h.rt.foldersChanged('a', { homeChanged: false });
    h.rt.requestProject('/w/b/sub', 'b', 1);
    h.rt.requestProject('/w/b/sub', undefined, 1);
    expect(h.checks).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['b', undefined],
      ['a', undefined],
      ['b', undefined],
    ]);
  });

  it('restored scans each session once its first check has applied (spec §2.2)', async () => {
    const h = harness();
    let applied = () => {};
    h.setCheckResult(
      new Promise<void>((r) => {
        applied = r;
      }),
    );
    h.rt.restored();
    const scans = () => h.events.filter((e) => e.startsWith('scan:'));
    await Promise.resolve();
    expect(scans()).toEqual([]);
    applied();
    await new Promise((r) => setTimeout(r, 0));
    expect(scans()).toEqual(['scan:a', 'scan:b']);
  });

  it('no health check on an ordinary fire (S4)', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.checks.length = 0;
    h.fire({ root: '/w/a', folders: ['/w/a'] });
    expect(h.checks).toEqual([]);
  });

  it('the renderer refresh each fire provokes does not health-check (S4)', () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R'];
    // app.tsx answers every fsChanged with refreshChanges() → requestProject for the active session.
    h.onBroadcast(() => h.rt.requestProject('/w/a', 'a', 1));
    h.rt.requestProject('/w/a', 'a', 1);
    for (let i = 0; i < 5; i++) h.fire({ root: '/w/a', folders: ['/w/a', '/x/R'] });
    expect(h.checks).toEqual([['a', undefined]]);
  });

  it('two windows refreshing different sessions check each once, not on every fire (R1)', () => {
    const h = harness();
    // Every fsChanged reaches both windows, and each answers for its own active session.
    h.onBroadcast(() => {
      h.rt.requestProject('/w/a', 'a', 1);
      h.rt.requestProject('/w/b', 'b', 2);
    });
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 2);
    for (let i = 0; i < 5; i++) h.fire({ root: '/w/b', folders: ['/w/b'] });
    expect(h.checks).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });

  it('a window switching session checks it; a closed window forgets its session', () => {
    const h = harness();
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 2);
    h.rt.requestProject('/w/b', 'b', 1);
    h.rt.windowClosed(2);
    h.rt.requestProject('/w/b', 'b', 2);
    expect(h.checks.map(([id]) => id)).toEqual(['a', 'b', 'b', 'b']);
  });

  it('requestProject checks on a session switch; focus checks the watched session', () => {
    const h = harness();
    h.rt.focused();
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.requestProject('/w/a/sub', 'a', 1);
    h.rt.requestProject('/w/b', 'b', 1);
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.focused();
    expect(h.checks).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['a', undefined],
      ['a', undefined],
    ]);
  });

  it('onSuspect checks only the suspect folders', () => {
    const h = harness();
    h.suspect(['/x/R']);
    expect(h.checks).toEqual([]);
    expect(h.logs).toHaveLength(1);
    h.rt.requestProject('/w/a', 'a', 1);
    h.checks.length = 0;
    h.suspect(['/x/R', '/w/a']);
    expect(h.checks).toEqual([['a', ['/x/R', '/w/a']]]);
  });

  it('returning root failing revalidation stays missing, logged once', async () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R', '/x/S'];
    h.sessions[0].missingRoots = ['/x/R', '/x/S'];
    h.reasons.set('/x/R', 'duplicate');
    await h.report('a', '/w/a', { '/w/a': 'present', '/x/R': 'present', '/x/S': 'present' });
    await h.report('a', '/w/a', { '/x/R': 'present' });
    expect(h.revalidations).toEqual(['a:/x/R', 'a:/x/S', 'a:/x/R']);
    expect(h.sessions[0].missingRoots).toEqual(['/x/R']);
    expect(h.logs.filter((l) => l.includes('revalidation'))).toHaveLength(1);
  });

  it('a returning home runs the validator; a failure keeps homeMissing, logged once', async () => {
    const h = harness();
    h.sessions[0].homeMissing = true;
    h.reasons.set('/w/a', 'overlaps');
    await h.report('a', '/w/a', { '/w/a': 'present' });
    await h.report('a', '/w/a', { '/w/a': 'present' });
    expect(h.revalidations).toEqual(['a:/w/a', 'a:/w/a']);
    expect(h.sessions[0].homeMissing).toBe(true);
    expect(h.logs.filter((l) => l.includes('revalidation'))).toHaveLength(1);
    h.reasons.delete('/w/a');
    await h.report('a', '/w/a', { '/w/a': 'present' });
    expect(h.sessions[0].homeMissing).toBeUndefined();
  });

  it('fs work not done in time keeps the mark, caches no key and logs nothing (F4)', async () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R', '/x/S'];
    h.sessions[0].missingRoots = ['/x/R'];
    await h.report('a', '/w/a', { '/x/R': 'present', '/x/S': 'present' }, async () => undefined);
    expect(h.sessions[0].missingRoots).toEqual(['/x/R']);
    expect(h.realKeys.has('/x/S')).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it('first presence stores the realpath key once (S5); a missing folder gets none', async () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R', '/x/gone'];
    h.realKeys.set('/w/a', '/w/a');
    await h.report('a', '/w/a', { '/w/a': 'present', '/x/R': 'present', '/x/gone': 'missing' });
    await h.report('a', '/w/a', { '/w/a': 'present', '/x/R': 'present' });
    expect(h.realpaths).toEqual(['/x/R']);
    expect(h.realKeys.get('/x/R')).toBe('/real/x/R');
  });

  it('a change rescans, re-arms if watched and emits onFoldersChanged', async () => {
    const h = harness();
    h.sessions[0].roots = ['/x/R'];
    h.rt.requestProject('/w/a', 'a', 1);
    h.rt.onFoldersChanged((id) => h.events.push(`hook:${id}`));
    h.events.length = 0;
    h.armed.length = 0;
    await h.report('a', '/w/a', { '/w/a': 'present', '/x/R': 'missing' });
    expect(h.sessions[0].missingRoots).toEqual(['/x/R']);
    expect(h.events).toEqual(['scan:a', 'hook:a']);
    expect(h.armed).toEqual([['/w/a', '/w/a']]);

    h.events.length = 0;
    await h.report('a', '/w/a', { '/x/R': 'missing' });
    expect(h.events).toEqual([]);

    await h.report('b', '/w/b', { '/w/b': 'missing' });
    expect(h.sessions[1].homeMissing).toBe(true);
    expect(h.events).toEqual(['scan:b', 'hook:b']);
    expect(h.armed).toHaveLength(1);
    await h.report('gone', '/w/gone', { '/w/gone': 'missing' });
    expect(h.events).toHaveLength(2);
  });

  it('pending() delegates', () => {
    const h = harness();
    expect(h.rt.pending('a')).toBeUndefined();
    const p = Promise.resolve();
    h.setPending(p);
    expect(h.rt.pending('a')).toBe(p);
  });
});
