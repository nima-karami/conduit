import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { folderKey } from '../../src/folder-key';
import { type LocateDeps, locateFolder } from '../../src/folder-locate';
import { SessionManager } from '../../src/session-manager';
import { createSessionOps, type SessionOpResult } from '../../src/session-ops';
import type { AgentDefinition, Session } from '../../src/types';

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    agentId: 'shell:cmd',
    home: '/w/home',
    roots: ['/w/att', '/w/other'],
    ...over,
  }) as Session;

const posixDirname = (p: string) => {
  const i = p.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/);
  return i <= 0 ? p.slice(0, 1) || p : p.slice(0, i);
};

function deps(opts: {
  s?: Session;
  picked?: string | null;
  existing?: string[];
  result?: SessionOpResult;
}) {
  const existing = new Set(opts.existing ?? []);
  const ok: SessionOpResult = opts.result ?? { ok: true };
  const d = {
    get: vi.fn((id: string) =>
      id === (opts.s ?? session()).id ? (opts.s ?? session()) : undefined,
    ),
    pick: vi.fn(async (_d: string | undefined) =>
      opts.picked === undefined ? '/w/new' : opts.picked,
    ),
    isDir: vi.fn(async (p: string) => existing.has(p)),
    dirname: posixDirname,
    ops: {
      setHome: vi.fn(async (_id: string, _p: string, _k: boolean) => ok),
      replaceRoot: vi.fn(async (_id: string, _o: string, _n: string) => ok),
    },
  } satisfies LocateDeps;
  return d;
}

describe('locateFolder', () => {
  it('home target: setHome(id, picked, false)', async () => {
    const d = deps({});
    expect(await locateFolder('s1', '/w/home', d)).toEqual({ ok: true, path: '/w/new' });
    expect(d.ops.setHome).toHaveBeenCalledWith('s1', '/w/new', false);
    expect(d.ops.setHome.mock.calls[0][2]).toBe(false);
    expect(d.ops.replaceRoot).not.toHaveBeenCalled();
  });

  it('attached target: replaceRoot with the stored spelling at its index', async () => {
    const d = deps({});
    expect(await locateFolder('s1', '/w/other', d)).toEqual({ ok: true, path: '/w/new' });
    expect(d.ops.replaceRoot).toHaveBeenCalledWith('s1', '/w/other', '/w/new');
    expect(d.ops.setHome).not.toHaveBeenCalled();
  });

  it('match by folderKey casing', async () => {
    const s = session({ home: 'C:\\Home', roots: ['C:\\A'] });
    const d = deps({ s });
    expect(await locateFolder('s1', 'c:/a', d)).toEqual({ ok: true, path: '/w/new' });
    expect(d.ops.replaceRoot).toHaveBeenCalledWith('s1', 'C:\\A', '/w/new');
    await locateFolder('s1', 'c:/home/', d);
    expect(d.ops.setHome).toHaveBeenCalledWith('s1', '/w/new', false);
  });

  it('picker opens at nearest existing ancestor', async () => {
    const s = session({ roots: ['/a/b/c'] });
    const d = deps({ s, existing: ['/a'] });
    await locateFolder('s1', '/a/b/c', d);
    expect(d.pick).toHaveBeenCalledWith('/a');
    const none = deps({ s, existing: [] });
    await locateFolder('s1', '/a/b/c', none);
    expect(none.pick).toHaveBeenCalledWith(undefined);
  });

  it('cancel → {ok:false, reason:"cancelled"}, no op called', async () => {
    const d = deps({ picked: null });
    expect(await locateFolder('s1', '/w/att', d)).toEqual({ ok: false, reason: 'cancelled' });
    expect(d.ops.replaceRoot).not.toHaveBeenCalled();
    expect(d.ops.setHome).not.toHaveBeenCalled();
  });

  it('path not in session → not-attached, no pick', async () => {
    const d = deps({});
    expect(await locateFolder('s1', '/w/elsewhere', d)).toEqual({
      ok: false,
      reason: 'not-attached',
    });
    expect(d.pick).not.toHaveBeenCalled();
  });

  it('unknown session / non-string → unknown-session / invalid-path', async () => {
    const d = deps({});
    expect(await locateFolder('nope', '/w/att', d)).toEqual({
      ok: false,
      reason: 'unknown-session',
    });
    expect(await locateFolder(42, '/w/att', d)).toEqual({ ok: false, reason: 'unknown-session' });
    expect(await locateFolder('s1', 7, d)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(d.pick).not.toHaveBeenCalled();
  });

  it('op failure reason passed through (duplicate, overlaps)', async () => {
    for (const reason of ['duplicate', 'overlaps'] as const) {
      const d = deps({ result: { ok: false, reason } });
      expect(await locateFolder('s1', '/w/att', d)).toEqual({ ok: false, reason, path: '/w/new' });
      const h = deps({ result: { ok: false, reason } });
      expect(await locateFolder('s1', '/w/home', h)).toEqual({ ok: false, reason, path: '/w/new' });
    }
  });

  it('re-picking the same path → ok', async () => {
    const d = deps({ picked: '/w/att' });
    expect(await locateFolder('s1', '/w/att', d)).toEqual({ ok: true, path: '/w/att' });
    expect(d.ops.replaceRoot).toHaveBeenCalledWith('s1', '/w/att', '/w/att');
  });
});

describe('locateFolder against the real SessionOps', () => {
  const agent: AgentDefinition = {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    args: [],
    icon: 'sparkle',
    color: 'terminal.ansiMagenta',
    cwdStrategy: 'workspaceFolder',
  };

  function real(picked: string | null, onPick?: (mgr: SessionManager, id: string) => void) {
    const mgr = new SessionManager(new AgentRegistry([agent]), () => 's1');
    const probe = async (raw: unknown) =>
      typeof raw === 'string'
        ? ({
            status: 'present',
            stored: raw,
            key: folderKey(raw),
            realKey: folderKey(raw),
          } as const)
        : ({ reason: 'invalid-path' } as const);
    const ops = createSessionOps({
      mgr,
      projects: { has: () => false },
      probe,
      realKeys: new Map(),
      onFoldersChanged: () => {},
    });
    const s = mgr.create('claude', '/w/home');
    mgr.addRoot(s.id, '/w/att');
    const d: LocateDeps = {
      get: (id) => mgr.get(id),
      pick: async () => {
        onPick?.(mgr, s.id);
        return picked;
      },
      isDir: async () => false,
      dirname: posixDirname,
      ops,
    };
    return { mgr, id: s.id, d };
  }

  it('home: re-picking its own path is a no-op success', async () => {
    const { mgr, id, d } = real('/w/home');
    expect(await locateFolder(id, '/w/home', d)).toEqual({ ok: true, path: '/w/home' });
    expect(mgr.get(id)?.home).toBe('/w/home');
    expect(mgr.get(id)?.roots).toEqual(['/w/att']);
  });

  it('home: re-picking its own path in another spelling keeps the stored one', async () => {
    const { mgr, id, d } = real('/w/home/');
    expect(await locateFolder(id, '/w/home', d)).toEqual({ ok: true, path: '/w/home' });
    expect(mgr.get(id)?.home).toBe('/w/home');
  });

  it('attached: re-picking its own path is a success in place', async () => {
    const { mgr, id, d } = real('/w/att');
    expect(await locateFolder(id, '/w/att', d)).toEqual({ ok: true, path: '/w/att' });
    expect(mgr.get(id)?.roots).toEqual(['/w/att']);
  });

  it('home: a new path replaces the home and drops the old one', async () => {
    const { mgr, id, d } = real('/w/moved');
    expect(await locateFolder(id, '/w/home', d)).toEqual({ ok: true, path: '/w/moved' });
    expect(mgr.get(id)?.home).toBe('/w/moved');
    expect(mgr.get(id)?.roots).toEqual(['/w/att']);
  });

  it('home changed while the picker was open → refused, the new home kept', async () => {
    const { mgr, id, d } = real('/w/moved', (m, sid) => m.setHome(sid, '/w/att', true));
    expect(await locateFolder(id, '/w/home', d)).toEqual({
      ok: false,
      reason: 'not-attached',
      path: '/w/moved',
    });
    expect(mgr.get(id)?.home).toBe('/w/att');
    expect(mgr.get(id)?.roots).toEqual(['/w/home']);
  });

  it('session closed while the picker was open → unknown-session', async () => {
    const { id, d } = real('/w/moved', (m, sid) => m.remove(sid));
    expect(await locateFolder(id, '/w/home', d)).toMatchObject({
      ok: false,
      reason: 'unknown-session',
    });
  });
});
