import { describe, expect, it, vi } from 'vitest';
import { type LocateDeps, locateFolder } from '../../src/folder-locate';
import type { SessionOpResult } from '../../src/session-ops';
import type { Session } from '../../src/types';

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
