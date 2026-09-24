import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { folderKey } from '../../src/folder-key';
import type { ProbedFolder, SessionOpReason } from '../../src/folder-validation';
import { SessionManager } from '../../src/session-manager';
import { createSessionOps } from '../../src/session-ops';
import type { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};

type ProbeResult =
  | ProbedFolder
  | { reason: 'invalid-path' | 'not-a-directory' | 'filesystem-root' };

const present = (stored: string, real = stored): ProbeResult => ({
  status: 'present',
  stored,
  key: folderKey(stored),
  realKey: folderKey(real),
});
const missing = (stored: string): ProbeResult => ({
  status: 'missing',
  stored,
  key: folderKey(stored),
});

/** Probe fake: a folder is present unless listed; `hold(p)` makes one more probe of p wait for `release(p)`. */
function harness(
  opts: {
    missing?: string[];
    real?: Record<string, string>;
    bad?: Record<string, ProbeResult>;
  } = {},
) {
  let n = 0;
  const mgr = new SessionManager(new AgentRegistry([claude]), () => `s${n++}`);
  const realKeys = new Map<string, string>();
  const changes: { id: string; homeChanged: boolean }[] = [];
  const held = new Map<string, (() => void)[]>();
  const holdNext = new Map<string, number>();
  const projects = new Set(['p1']);
  const probe = async (raw: unknown): Promise<ProbeResult> => {
    if (typeof raw !== 'string' || !raw.startsWith('/')) return { reason: 'invalid-path' };
    const holds = holdNext.get(raw) ?? 0;
    if (holds > 0) {
      holdNext.set(raw, holds - 1);
      await new Promise<void>((r) => held.set(raw, [...(held.get(raw) ?? []), r]));
    }
    if (opts.bad?.[raw]) return opts.bad[raw];
    if (opts.missing?.includes(raw)) return missing(raw);
    return present(raw, opts.real?.[raw]);
  };
  const ops = createSessionOps({
    mgr,
    projects: { has: (id) => projects.has(id) },
    probe,
    realKeys,
    onFoldersChanged: (id, c) => changes.push({ id, ...c }),
  });
  const hold = (p: string) => holdNext.set(p, (holdNext.get(p) ?? 0) + 1);
  const release = (p: string) => {
    const q = held.get(p) ?? [];
    held.set(p, q.slice(1));
    q[0]?.();
  };
  return { mgr, ops, realKeys, changes, hold, release };
}

const fail = (reason: SessionOpReason) => ({ ok: false, reason });
const OK = { ok: true };

describe('createSessionOps', () => {
  it('two addRoot for one path in a burst → second duplicate', async () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home');
    h.hold('/w/r');
    h.hold('/w/r');
    const first = h.ops.addRoot(s.id, '/w/r');
    const second = h.ops.addRoot(s.id, '/w/r');
    await Promise.resolve();
    h.release('/w/r');
    expect(await first).toEqual(OK);
    h.release('/w/r');
    expect(await second).toEqual(fail('duplicate'));
    expect(h.mgr.get(s.id)?.roots).toEqual(['/w/r']);
  });

  it('addRoot of a symlink to home → duplicate via its real key', async () => {
    const h = harness({ real: { '/w/link': '/w/home' } });
    const s = h.mgr.create('claude', '/w/home');
    expect(await h.ops.addRoot(s.id, '/w/link')).toEqual(fail('duplicate'));
    expect(h.mgr.get(s.id)?.roots).toEqual([]);
  });

  it('addRoot of X when an attached root is a junction to X → duplicate via the cached real key', async () => {
    const h = harness({ real: { '/w/junction': '/x/target' } });
    const s = h.mgr.create('claude', '/w/home');
    expect(await h.ops.addRoot(s.id, '/w/junction')).toEqual(OK);
    expect(h.realKeys.get('/w/junction')).toBe('/x/target');
    expect(await h.ops.addRoot(s.id, '/x/target')).toEqual(fail('duplicate'));
    expect(await h.ops.addRoot(s.id, '/x/target/inner')).toEqual(fail('overlaps'));
  });

  it('addRoot of a missing path → not-found', async () => {
    const h = harness({ missing: ['/w/gone'] });
    const s = h.mgr.create('claude', '/w/home');
    expect(await h.ops.addRoot(s.id, '/w/gone')).toEqual(fail('not-found'));
    expect(await h.ops.addRoot(s.id, 'rel')).toEqual(fail('invalid-path'));
    expect(await h.ops.addRoot('nope', '/w/a')).toEqual(fail('unknown-session'));
    expect(await h.ops.addRoot(42, '/w/a')).toEqual(fail('unknown-session'));
    expect(h.changes).toEqual([]);
  });

  it('setHome to a subfolder of old home → overlaps', async () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home', { roots: ['/w/a'] });
    expect(await h.ops.setHome(s.id, '/w/home/sub')).toEqual(fail('overlaps'));
    expect(await h.ops.setHome(s.id, '/w/a/sub')).toEqual(fail('overlaps'));
    expect(await h.ops.setHome(s.id, '/w/home')).toEqual(fail('duplicate'));
    expect(await h.ops.setHome(s.id, '/w/home/sub', false)).toEqual(OK);
    expect(h.mgr.get(s.id)).toMatchObject({ home: '/w/home/sub', roots: ['/w/a'] });
  });

  it('setHome to a new present folder keeps the old home attached; a swap skips the probe', async () => {
    const h = harness({ missing: ['/w/a', '/w/gone'] });
    const s = h.mgr.create('claude', '/w/home', { roots: ['/w/a'], missingRoots: ['/w/a'] });
    expect(await h.ops.setHome(s.id, '/w/gone')).toEqual(fail('not-found'));
    expect(await h.ops.setHome(s.id, '/w/new')).toEqual(OK);
    expect(h.mgr.get(s.id)).toMatchObject({ home: '/w/new', roots: ['/w/a', '/w/home'] });
    // /w/a probes missing, so reaching OK proves the swap path never probed it.
    expect(await h.ops.setHome(s.id, '/w/a')).toEqual(OK);
    expect(h.mgr.get(s.id)).toMatchObject({
      home: '/w/a',
      homeMissing: true,
      roots: ['/w/home', '/w/new'],
    });
    expect(await h.ops.setHome(s.id, 7)).toEqual(fail('invalid-path'));
  });

  it('33rd root → too-many', async () => {
    const h = harness();
    const roots = Array.from({ length: 32 }, (_, i) => `/r/${i}`);
    const s = h.mgr.create('claude', '/w/home', { roots });
    expect(await h.ops.addRoot(s.id, '/r/extra')).toEqual(fail('too-many'));
    expect(await h.ops.setHome(s.id, '/w/other')).toEqual(fail('too-many'));
    expect(await h.ops.setHome(s.id, '/w/other', false)).toEqual(OK);
    const r = await h.ops.resolveInitialRoots('/w/h2', [...roots, '/r/extra']);
    expect(r.roots).toHaveLength(32);
    expect(r.dropped).toEqual([{ path: '/r/extra', reason: 'too-many' }]);
  });

  it('removeRoot home → is-home; unknown → not-attached; realKeys entry dropped', async () => {
    const h = harness({ real: { '/w/a': '/x/a' } });
    const s = h.mgr.create('claude', '/w/home');
    await h.ops.addRoot(s.id, '/w/a');
    expect(h.realKeys.has('/w/a')).toBe(true);
    h.changes.length = 0;
    expect(h.ops.removeRoot(s.id, '/w/home')).toEqual(fail('is-home'));
    expect(h.ops.removeRoot(s.id, '/w/zzz')).toEqual(fail('not-attached'));
    expect(h.ops.removeRoot(s.id, 5)).toEqual(fail('invalid-path'));
    expect(h.ops.removeRoot('nope', '/w/a')).toEqual(fail('unknown-session'));
    expect(h.changes).toEqual([]);
    expect(h.ops.removeRoot(s.id, '/w/a/')).toEqual(OK);
    expect(h.mgr.get(s.id)?.roots).toEqual([]);
    expect(h.realKeys.has('/w/a')).toBe(false);
    expect(h.changes).toEqual([{ id: s.id, homeChanged: false }]);
  });

  it('replaceRoot excludes old from the overlap check and keeps the index', async () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home', { roots: ['/w/a', '/w/b', '/w/c'] });
    expect(await h.ops.replaceRoot(s.id, '/w/b', '/w/b/inner')).toEqual(OK);
    expect(h.mgr.get(s.id)?.roots).toEqual(['/w/a', '/w/b/inner', '/w/c']);
    expect(await h.ops.replaceRoot(s.id, '/w/a', '/w/c')).toEqual(fail('duplicate'));
    expect(await h.ops.replaceRoot(s.id, '/w/zzz', '/w/d')).toEqual(fail('not-attached'));
    expect(await h.ops.replaceRoot(s.id, '/w/a', '/w/home/x')).toEqual(fail('overlaps'));
  });

  it('session killed mid-probe → unknown-session, no mutation', async () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home');
    const other = h.mgr.create('claude', '/w/other');
    h.hold('/w/r');
    const pending = h.ops.addRoot(s.id, '/w/r');
    await Promise.resolve();
    h.mgr.remove(s.id);
    h.release('/w/r');
    expect(await pending).toEqual(fail('unknown-session'));
    expect(h.mgr.get(other.id)?.roots).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it('resolveInitialRoots keeps a missing root lexically in roots and missing, drops home/dups/invalid with reasons, keeps order', async () => {
    const h = harness({
      missing: ['/w/gone', '/w/gone/sub'],
      bad: { '/w/file': { reason: 'not-a-directory' } },
    });
    const r = await h.ops.resolveInitialRoots('/w/home', [
      '/w/b',
      '/w/gone',
      '/w/home/',
      'relative',
      '/w/b',
      '/w/gone/sub',
      '/w/file',
      '/w/a',
      3,
    ]);
    expect(r).toEqual({
      roots: ['/w/b', '/w/gone', '/w/a'],
      missing: ['/w/gone'],
      dropped: [
        { path: '/w/home/', reason: 'is-home' },
        { path: 'relative', reason: 'invalid-path' },
        { path: '/w/b', reason: 'duplicate' },
        { path: '/w/gone/sub', reason: 'overlaps' },
        { path: '/w/file', reason: 'not-a-directory' },
        { path: '', reason: 'invalid-path' },
      ],
    });
    expect(h.realKeys.get('/w/b')).toBe('/w/b');
    expect(h.realKeys.has('/w/gone')).toBe(false);
    expect(await h.ops.resolveInitialRoots('/w/home', 'nope')).toEqual({
      roots: [],
      missing: [],
      dropped: [],
    });
  });

  it('setProject unknown id → unknown-project', () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home');
    expect(h.ops.setProject(s.id, 'zzz')).toEqual(fail('unknown-project'));
    expect(h.ops.setProject(s.id, 7)).toEqual(fail('unknown-project'));
    expect(h.ops.setProject('nope', 'p1')).toEqual(fail('unknown-session'));
    expect(h.ops.setProject(s.id, 'p1')).toEqual(OK);
    expect(h.mgr.get(s.id)?.projectId).toBe('p1');
    expect(h.ops.setProject(s.id, null)).toEqual(OK);
    expect(h.mgr.get(s.id)?.projectId).toBeUndefined();
  });

  it('onFoldersChanged once per successful op with homeChanged', async () => {
    const h = harness();
    const s = h.mgr.create('claude', '/w/home');
    await h.ops.addRoot(s.id, '/w/a');
    await h.ops.addRoot(s.id, '/w/a');
    await h.ops.setHome(s.id, '/w/new');
    await h.ops.replaceRoot(s.id, '/w/a', '/w/a2');
    h.ops.removeRoot(s.id, '/w/a2');
    h.ops.setProject(s.id, 'p1');
    expect(h.changes).toEqual([
      { id: s.id, homeChanged: false },
      { id: s.id, homeChanged: true },
      { id: s.id, homeChanged: false },
      { id: s.id, homeChanged: false },
    ]);
  });
});
