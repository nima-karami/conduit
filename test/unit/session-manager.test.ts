import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { folderKey } from '../../src/folder-key';
import type { RepoInfo } from '../../src/repo-scan';
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

function seqIds() {
  let n = 0;
  return () => `id${n++}`;
}

/**
 * A manager backed by a mutable `clock` (set `h.clock` to advance time) with one
 * `/work/proj` session created at t=1000 and an onChange counter (`h.calls`).
 */
function managerWithClockAndSession() {
  const h = { clock: 1000, calls: 0 } as {
    clock: number;
    calls: number;
    m: SessionManager;
    s: Session;
  };
  h.m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => h.clock);
  h.s = h.m.create('claude', '/work/proj');
  h.m.onChange(() => h.calls++);
  return h;
}

describe('SessionManager (model)', () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager(new AgentRegistry([claude]), seqIds());
  });

  it('creates a running session named after the folder basename only', () => {
    const s = mgr.create('claude', '/work/proj');
    expect(s.status).toBe('running');
    expect(s.agentId).toBe('claude');
    expect(s.home).toBe('/work/proj');
    expect(s.name).toBe('proj'); // folder basename only — no agent suffix
    expect(mgr.list()).toHaveLength(1);
  });

  it('preserves an explicit name (does not apply the default scheme)', () => {
    const s = mgr.create('claude', '/work/proj', { name: 'My Session' });
    expect(s.name).toBe('My Session');
  });

  it('stamps createdAt and lastActiveAt from injected now on create', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const s = m.create('claude', '/work/proj');
    expect(s.createdAt).toBe(1000);
    expect(s.lastActiveAt).toBe(1000);
    clock = 2000;
    expect(m.get(s.id)?.createdAt).toBe(1000); // unchanged
  });

  it('touch() bumps lastActiveAt only; unknown id is a no-op', () => {
    const h = managerWithClockAndSession();
    h.clock = 5000;
    h.m.touch(h.s.id);
    expect(h.m.get(h.s.id)?.lastActiveAt).toBe(5000);
    expect(h.m.get(h.s.id)?.createdAt).toBe(1000);
    expect(h.calls).toBe(1);
    h.m.touch('nope'); // unknown -> no emit, no throw
    expect(h.calls).toBe(1);
  });

  it('throttles touch() within minIntervalMs (coalesces keystroke bumps)', () => {
    const h = managerWithClockAndSession();
    h.clock = 1100; // 100ms later, inside the 30s window
    h.m.touch(h.s.id, 30_000);
    expect(h.m.get(h.s.id)?.lastActiveAt).toBe(1000); // skipped, not bumped
    expect(h.calls).toBe(0);
    h.clock = 40_000; // well past the window
    h.m.touch(h.s.id, 30_000);
    expect(h.m.get(h.s.id)?.lastActiveAt).toBe(40_000); // bumped
    expect(h.calls).toBe(1);
  });

  it('sorts available via lastActiveAt (model exposes the field)', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const a = m.create('claude', '/a');
    clock = 3000;
    const b = m.create('claude', '/b');
    const byActive = m.list().sort((x, y) => y.lastActiveAt - x.lastActiveAt);
    expect(byActive[0].id).toBe(b.id);
    expect(byActive[1].id).toBe(a.id);
  });

  it('throws when the agent is unknown', () => {
    expect(() => mgr.create('nope', '/work/proj')).toThrow(/unknown agent/i);
  });

  it('renames a session (ignoring blank names)', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.rename(s.id, 'My Session');
    expect(mgr.get(s.id)?.name).toBe('My Session');
    mgr.rename(s.id, '   ');
    expect(mgr.get(s.id)?.name).toBe('My Session');
  });

  it('removes a session', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.remove(s.id);
    expect(mgr.list()).toHaveLength(0);
  });

  it('updates status and notifies once per change', () => {
    let calls = 0;
    mgr.onChange(() => calls++);
    const s = mgr.create('claude', '/a');
    mgr.setStatus(s.id, 'exited');
    mgr.setStatus(s.id, 'exited'); // no-op, same status
    expect(mgr.get(s.id)?.status).toBe('exited');
    expect(calls).toBe(2); // create + first setStatus
  });

  it('restores persisted sessions as stale, backfilling lastActiveAt from createdAt', () => {
    // Legacy persisted session: has createdAt but no lastActiveAt field.
    mgr.restore([
      {
        id: 'x',
        name: 'Old',
        agentId: 'claude',
        home: '/a',
        status: 'running',
        createdAt: 42,
      } as Session,
    ]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get('x')?.status).toBe('stale');
    expect(mgr.get('x')?.lastActiveAt).toBe(42); // backfilled from createdAt
  });
});

describe('SessionManager repo state', () => {
  const repos: RepoInfo[] = [
    { root: '/work/A', name: '.', folder: '/work/A', tag: 'home' },
    { root: '/work/A/sub', name: 'sub', folder: '/work/A', tag: 'nested' },
    { root: '/work/B', name: '.', folder: '/work/B', tag: 'attached' },
  ];
  function mgrWith() {
    const m = new SessionManager(
      new AgentRegistry([claude]),
      () => 's1',
      () => 0,
    );
    m.create('claude', '/work/A');
    return m;
  }

  it('derives activeRepoRoot from repos with opened-root fallback', () => {
    const m = mgrWith();
    m.setRepos('s1', repos);
    expect(m.get('s1')?.activeRepoRoot).toBe('/work/A');
    expect(m.get('s1')?.repoPinned).toBe(false);
  });

  it('auto-follow sets the active repo when unpinned', () => {
    const m = mgrWith();
    m.setRepos('s1', repos);
    m.setAutoRepo('s1', '/work/B');
    expect(m.get('s1')?.activeRepoRoot).toBe('/work/B');
  });

  it('a pin holds the active repo across auto-follow until unpinned', () => {
    const m = mgrWith();
    m.setRepos('s1', repos);
    m.pinRepo('s1', '/work/A/sub');
    expect(m.get('s1')?.repoPinned).toBe(true);
    m.setAutoRepo('s1', '/work/B'); // ignored while pinned
    expect(m.get('s1')?.activeRepoRoot).toBe('/work/A/sub');
    m.unpinRepo('s1');
    expect(m.get('s1')?.repoPinned).toBe(false);
    expect(m.get('s1')?.activeRepoRoot).toBe('/work/B'); // resumes following auto
  });

  it('a deleted pinned repo falls back when repos refresh', () => {
    const m = mgrWith();
    m.setRepos('s1', repos);
    m.pinRepo('s1', '/work/B');
    m.setRepos(
      's1',
      repos.filter((r) => r.root !== '/work/B'),
    );
    expect(m.get('s1')?.activeRepoRoot).not.toBe('/work/B');
    expect(m.get('s1')?.repoPinned).toBe(false);
  });

  it('setRepos emits on a tag-only change', () => {
    const m = mgrWith();
    m.setRepos('s1', repos);
    let calls = 0;
    m.onChange(() => calls++);
    m.setRepos('s1', [...repos]);
    expect(calls).toBe(0);
    m.setRepos('s1', [repos[0], { ...repos[1], tag: 'attached' }, repos[2]]);
    expect(calls).toBe(1);
    m.setRepos('s1', [repos[0], { ...repos[1], tag: 'attached' }, { ...repos[2], folder: '/w' }]);
    expect(calls).toBe(2);
  });
});

describe('SessionManager folders and projects', () => {
  function counted() {
    const m = new SessionManager(new AgentRegistry([claude]), seqIds());
    const h = { m, calls: 0 };
    m.onChange(() => h.calls++);
    return h;
  }

  it('create stores roots, projectId and seeds missingRoots ∩ roots', () => {
    const { m } = counted();
    const s = m.create('claude', 'C:/w/home', {
      roots: ['C:/w/a', 'C:/w/b', 'C:/w/c'],
      missingRoots: ['c:/W/C', 'C:/w/zzz', 'C:/w/a'],
      projectId: 'p1',
      cardId: 'card-1',
    });
    expect(s.roots).toEqual(['C:/w/a', 'C:/w/b', 'C:/w/c']);
    expect(s.missingRoots).toEqual(['C:/w/a', 'C:/w/c']);
    expect(s.projectId).toBe('p1');
    expect(s.cardId).toBe('card-1');
    const plain = m.create('claude', '/w/plain');
    expect(plain.roots).toEqual([]);
    expect('missingRoots' in plain).toBe(false);
    expect('projectId' in plain).toBe(false);
    expect(
      'missingRoots' in m.create('claude', '/w/x', { roots: ['/w/r'], missingRoots: [] }),
    ).toBe(false);
  });

  it('duplicate copies home, roots, missingRoots, projectId but not cardId', () => {
    const { m } = counted();
    const src = m.create('claude', '/w/home', {
      roots: ['/w/a', '/w/b'],
      missingRoots: ['/w/b'],
      projectId: 'p1',
      cardId: 'card-1',
    });
    const dup = m.duplicate(src.id);
    expect(dup).toMatchObject({
      agentId: 'claude',
      home: '/w/home',
      roots: ['/w/a', '/w/b'],
      missingRoots: ['/w/b'],
      projectId: 'p1',
    });
    expect(dup && 'cardId' in dup).toBe(false);
    expect(dup?.roots).not.toBe(src.roots);
    expect(dup?.missingRoots).not.toBe(src.missingRoots);
  });

  it('addRoot appends', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', { roots: ['/w/a'] });
    h.calls = 0;
    expect(h.m.addRoot(s.id, '/w/b')).toBe(true);
    expect(h.m.get(s.id)?.roots).toEqual(['/w/a', '/w/b']);
    expect(h.calls).toBe(1);
    expect(h.m.addRoot('nope', '/w/c')).toBe(false);
    expect(h.calls).toBe(1);
  });

  it('removeRoot by key drops its missing flag', () => {
    const h = counted();
    const s = h.m.create('claude', 'C:/w/home', {
      roots: ['C:/w/A', 'C:/w/B'],
      missingRoots: ['C:/w/A', 'C:/w/B'],
    });
    h.calls = 0;
    expect(h.m.removeRoot(s.id, 'c:/w/a')).toBe(true);
    expect(h.m.get(s.id)?.roots).toEqual(['C:/w/B']);
    expect(h.m.get(s.id)?.missingRoots).toEqual(['C:/w/B']);
    expect(h.m.removeRoot(s.id, 'c:/w/b')).toBe(true);
    expect(h.m.get(s.id)?.roots).toEqual([]);
    expect(h.m.get(s.id) && 'missingRoots' in (h.m.get(s.id) ?? {})).toBe(false);
    expect(h.m.removeRoot(s.id, 'c:/w/b')).toBe(false);
    expect(h.calls).toBe(2);
  });

  it('replaceRoot keeps the index', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', {
      roots: ['/w/a', '/w/b', '/w/c'],
      missingRoots: ['/w/b', '/w/c'],
    });
    expect(h.m.replaceRoot(s.id, '/w/b', '/w/B2')).toBe(true);
    expect(h.m.get(s.id)?.roots).toEqual(['/w/a', '/w/B2', '/w/c']);
    expect(h.m.get(s.id)?.missingRoots).toEqual(['/w/c']);
    expect(h.m.replaceRoot(s.id, '/w/zzz', '/w/q')).toBe(false);
  });

  it('setHome swap moves the missing flag to homeMissing and back', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', { roots: ['/w/a', '/w/r'], missingRoots: ['/w/r'] });
    h.calls = 0;
    expect(h.m.setHome(s.id, '/w/r', true)).toBe(true);
    let cur = h.m.get(s.id);
    expect(cur?.home).toBe('/w/r');
    expect(cur?.homeMissing).toBe(true);
    expect(cur?.roots).toEqual(['/w/a', '/w/home']);
    expect(cur && 'missingRoots' in cur).toBe(false);

    expect(h.m.setHome(s.id, '/w/home', true)).toBe(true);
    cur = h.m.get(s.id);
    expect(cur?.home).toBe('/w/home');
    expect(cur && 'homeMissing' in cur).toBe(false);
    expect(cur?.roots).toEqual(['/w/a', '/w/r']);
    expect(cur?.missingRoots).toEqual(['/w/r']);
    expect(h.calls).toBe(2);
  });

  it('setHome keepOldHome:false does not append', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', { roots: ['/w/a'] });
    expect(h.m.setHome(s.id, '/w/new', false)).toBe(true);
    expect(h.m.get(s.id)?.home).toBe('/w/new');
    expect(h.m.get(s.id)?.roots).toEqual(['/w/a']);
    expect(h.m.setHome(s.id, '/w/new', true)).toBe(false);
  });

  it('setProject sets/clears', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home');
    h.calls = 0;
    expect(h.m.setProject(s.id, 'p1')).toBe(true);
    expect(h.m.get(s.id)?.projectId).toBe('p1');
    expect(h.m.setProject(s.id, 'p1')).toBe(false);
    expect(h.m.setProject(s.id, undefined)).toBe(true);
    expect('projectId' in (h.m.get(s.id) ?? {})).toBe(false);
    expect(h.m.setProject('nope', 'p1')).toBe(false);
    expect(h.calls).toBe(2);
  });

  it('clearProject: every holder cleared, one emit', () => {
    const h = counted();
    const a = h.m.create('claude', '/w/a', { projectId: 'p1' });
    const b = h.m.create('claude', '/w/b', { projectId: 'p1' });
    const c = h.m.create('claude', '/w/c', { projectId: 'p2' });
    h.calls = 0;
    expect(h.m.clearProject('p1')).toBe(2);
    expect(h.calls).toBe(1);
    expect('projectId' in (h.m.get(a.id) ?? {})).toBe(false);
    expect('projectId' in (h.m.get(b.id) ?? {})).toBe(false);
    expect(h.m.get(c.id)?.projectId).toBe('p2');
    expect(h.m.clearProject('p1')).toBe(0);
    expect(h.calls).toBe(1);
  });

  it('setFolderHealth intersects with current roots (removeRoot mid-check keeps I3)', () => {
    const h = counted();
    const s = h.m.create('claude', 'C:/w/home', { roots: ['C:/w/a', 'C:/w/b', 'C:/w/c'] });
    h.m.removeRoot(s.id, 'c:/w/b');
    h.calls = 0;
    const health = { homeKey: 'c:/w/home', homeMissing: false };
    expect(
      h.m.setFolderHealth(s.id, { ...health, missingRoots: ['c:/W/C', 'C:/w/b', 'C:/w/gone'] }),
    ).toBe(true);
    expect(h.m.get(s.id)?.missingRoots).toEqual(['C:/w/c']);
    expect(h.m.setFolderHealth(s.id, { ...health, missingRoots: ['C:/w/c', 'C:/w/a'] })).toBe(true);
    expect(h.m.get(s.id)?.missingRoots).toEqual(['C:/w/a', 'C:/w/c']);
    expect(h.calls).toBe(2);
    expect(h.m.setFolderHealth('nope', { ...health, missingRoots: [] })).toBe(false);
  });

  it('setFolderHealth: stale homeKey after setHome → homeMissing ignored (S2)', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', { roots: ['/w/r'] });
    const measured = folderKey('/w/home');
    h.m.setHome(s.id, '/w/new', true);
    h.calls = 0;
    expect(
      h.m.setFolderHealth(s.id, { homeKey: measured, missingRoots: [], homeMissing: true }),
    ).toBe(false);
    expect('homeMissing' in (h.m.get(s.id) ?? {})).toBe(false);
    expect(h.calls).toBe(0);
    expect(
      h.m.setFolderHealth(s.id, {
        homeKey: folderKey('/w/new'),
        missingRoots: [],
        homeMissing: true,
      }),
    ).toBe(true);
    expect(h.m.get(s.id)?.homeMissing).toBe(true);
  });

  it('setFolderHealth: fields absent when empty/false; no emit when unchanged', () => {
    const h = counted();
    const s = h.m.create('claude', '/w/home', { roots: ['/w/r'] });
    const homeKey = folderKey('/w/home');
    h.calls = 0;
    const set = (missingRoots: string[], homeMissing: boolean) =>
      h.m.setFolderHealth(s.id, { homeKey, missingRoots, homeMissing });
    expect(set([], false)).toBe(false);
    expect(set(['/w/r'], true)).toBe(true);
    expect(set(['/w/r'], true)).toBe(false);
    expect(h.calls).toBe(1);
    expect(set([], false)).toBe(true);
    const cur = h.m.get(s.id) ?? {};
    expect('missingRoots' in cur || 'homeMissing' in cur).toBe(false);
    expect(h.calls).toBe(2);
  });
});
