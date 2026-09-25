import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentScope,
  agentScopeDrift,
  type DismissKind,
  isTypeablePath,
  pruneDismissed,
  scopeFromSpawnArgs,
} from '../../src/agent-scope';
import type { Session } from '../../src/types';

type Folders = Pick<Session, 'home' | 'homeMissing' | 'roots' | 'missingRoots'>;

const wres = (base: string, p: string) => path.win32.resolve(base, p);
const pres = (base: string, p: string) => path.posix.resolve(base, p);
const none = new Map<string, DismissKind>();
const always = async () => true;

const scope = (cwd: string, dirs: string[] = [], external: string[] = []): AgentScope => ({
  cwd,
  dirs,
  external,
});

describe('scopeFromSpawnArgs (AC-2)', () => {
  const folders = { home: '/h', roots: ['/x', '/y', '/a', '/b'] };

  it('--add-dir x, --add-dir=y and variadic --add-dir a b -p all captured', () => {
    const s = scopeFromSpawnArgs(
      '/h',
      ['--add-dir', '/x', '--add-dir=/y', '--add-dir', '/a', '/b', '-p', 'hi'],
      pres,
      folders,
    );
    expect(s.cwd).toBe('/h');
    expect(s.dirs).toEqual(['/x', '/y', '/a', '/b']);
    expect(s.external).toEqual([]);
  });

  it('empty values are dropped and duplicates collapse by folder key', () => {
    const s = scopeFromSpawnArgs('C:\\h', ['--add-dir=', '--add-dir', 'C:\\X', 'c:/x/'], wres, {
      home: 'C:\\h',
      roots: ['C:\\x'],
    });
    expect(s.dirs).toEqual(['C:\\X']);
  });

  it('relative value resolves against cwd', () => {
    const s = scopeFromSpawnArgs('C:\\h', ['--add-dir', 'sub'], wres, {
      home: 'C:\\h',
      roots: [],
    });
    expect(s.dirs).toEqual(['C:\\h\\sub']);
  });

  it('user-supplied dir outside the folders is external', () => {
    const s = scopeFromSpawnArgs('/h', ['--add-dir', '/shared'], pres, { home: '/h', roots: [] });
    expect(s.external).toEqual(['/shared']);
  });

  it('dir under home is not external', () => {
    const s = scopeFromSpawnArgs('/h', ['--add-dir', '/h/sub'], pres, { home: '/h', roots: [] });
    expect(s.dirs).toEqual(['/h/sub']);
    expect(s.external).toEqual([]);
  });

  it('a cwd outside the folders is external too', () => {
    const s = scopeFromSpawnArgs('/elsewhere', [], pres, { home: '/h', roots: [] });
    expect(s.external).toEqual(['/elsewhere']);
  });
});

describe('agentScopeDrift (AC-1)', () => {
  const base: Folders = { home: '/h', roots: [] };

  it('no drift → undefined', async () => {
    expect(await agentScopeDrift(base, scope('/h'), none, always)).toBeUndefined();
  });

  it('added root → unseen', async () => {
    const v = await agentScopeDrift({ ...base, roots: ['/d'] }, scope('/h'), none, always);
    expect(v).toEqual({ unseen: ['/d'], stillSeen: [], typeable: ['/d'] });
  });

  it('root inside a scope dir → not unseen', async () => {
    const v = await agentScopeDrift(
      { ...base, roots: ['/big/inner'] },
      scope('/h', ['/big']),
      none,
      always,
    );
    expect(v?.unseen ?? []).toEqual([]);
  });

  it('a root that is merely a name-prefix of a scope dir is still unseen', async () => {
    const v = await agentScopeDrift(
      { ...base, roots: ['/bigger'] },
      scope('/h', ['/big']),
      none,
      async () => false,
    );
    expect(v?.unseen).toEqual(['/bigger']);
  });

  it('removed root still in scope → stillSeen', async () => {
    const v = await agentScopeDrift(base, scope('/h', ['/d']), none, always);
    expect(v).toEqual({ unseen: [], stillSeen: ['/d'], typeable: [] });
  });

  it('removed root that no longer exists → not stillSeen; exists called only for candidates', async () => {
    const exists = vi.fn(async () => false);
    const v = await agentScopeDrift(
      { ...base, roots: ['/e'] },
      scope('/h', ['/d', '/e']),
      none,
      exists,
    );
    expect(v).toBeUndefined();
    expect(exists.mock.calls).toEqual([['/d']]);
  });

  it('missing root in scope → neither', async () => {
    const exists = vi.fn(always);
    const v = await agentScopeDrift(
      { ...base, roots: ['/d'], missingRoots: ['/d'] },
      scope('/h', ['/d']),
      none,
      exists,
    );
    expect(v).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });

  it('missing root not in scope → not unseen', async () => {
    const v = await agentScopeDrift(
      { ...base, roots: ['/d'], missingRoots: ['/d'] },
      scope('/h'),
      none,
      always,
    );
    expect(v).toBeUndefined();
  });

  it('Make home swap → undefined', async () => {
    const v = await agentScopeDrift(
      { home: '/e', roots: ['/h'] },
      scope('/h', ['/e']),
      none,
      always,
    );
    expect(v).toBeUndefined();
  });

  it('dismissed unseen / stillSeen excluded', async () => {
    const dismissed = new Map<string, DismissKind>([
      ['/d', 'unseen'],
      ['/gone', 'stillSeen'],
    ]);
    const v = await agentScopeDrift(
      { ...base, roots: ['/d', '/k'] },
      scope('/h', ['/gone']),
      dismissed,
      always,
    );
    expect(v).toEqual({ unseen: ['/k'], stillSeen: [], typeable: ['/k'] });
  });

  it('a dismissal of the other kind does not hide a path', async () => {
    const dismissed = new Map<string, DismissKind>([['/d', 'stillSeen']]);
    const v = await agentScopeDrift({ ...base, roots: ['/d'] }, scope('/h'), dismissed, always);
    expect(v?.unseen).toEqual(['/d']);
  });

  it('external never stillSeen', async () => {
    const exists = vi.fn(always);
    const v = await agentScopeDrift(base, scope('/h', ['/shared'], ['/shared']), none, exists);
    expect(v).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });

  it('homeMissing → home not unseen', async () => {
    const v = await agentScopeDrift(
      { home: '/h2', homeMissing: true, roots: [] },
      scope('/h', [], []),
      none,
      async () => false,
    );
    expect(v).toBeUndefined();
  });

  it('C:\\A vs c:/a/ same folder; /A vs /a different', async () => {
    expect(
      await agentScopeDrift(
        { home: 'C:\\h', roots: ['C:\\A'] },
        scope('c:/h/', ['c:/a/']),
        none,
        always,
      ),
    ).toBeUndefined();
    const v = await agentScopeDrift(
      { home: '/h', roots: ['/A'] },
      scope('/h', ['/a']),
      none,
      always,
    );
    expect(v).toEqual({ unseen: ['/A'], stillSeen: ['/a'], typeable: ['/A'] });
  });

  it('cwd and dirs dedupe by key before the existence check', async () => {
    const exists = vi.fn(always);
    const v = await agentScopeDrift(
      { home: '/n', roots: [] },
      scope('/h', ['/h', '/H2', '/H2/']),
      none,
      exists,
    );
    expect(v?.stillSeen).toEqual(['/h', '/H2']);
    expect(exists).toHaveBeenCalledTimes(2);
  });
});

describe('isTypeablePath (AC-3)', () => {
  it('double spaces kept verbatim in typeable', async () => {
    const p = 'C:\\a  b';
    const v = await agentScopeDrift({ home: 'C:\\h', roots: [p] }, scope('C:\\h'), none, always);
    expect(v?.typeable).toEqual([p]);
  });

  it('\\x07, \\x7f, \\x85 rejected', () => {
    expect(isTypeablePath('C:\\a\x07b')).toBe(false);
    expect(isTypeablePath('C:\\a\x7fb')).toBe(false);
    expect(isTypeablePath('C:\\a\x85b')).toBe(false);
    expect(isTypeablePath('C:\\a\nb')).toBe(false);
    expect(isTypeablePath('C:\\a\x00b')).toBe(false);
  });

  it('\\\\host\\share and //host/share rejected', () => {
    expect(isTypeablePath('\\\\host\\share')).toBe(false);
    expect(isTypeablePath('//host/share')).toBe(false);
  });

  it('R&D typeable', () => {
    expect(isTypeablePath('C:\\R&D')).toBe(true);
    expect(isTypeablePath('/home/me/Ünïcode dir')).toBe(true);
  });

  it('an untypeable unseen folder stays unseen but not typeable', async () => {
    const v = await agentScopeDrift(
      { home: '/h', roots: ['//srv/share', '/ok'] },
      scope('/h'),
      none,
      always,
    );
    expect(v).toEqual({ unseen: ['//srv/share', '/ok'], stillSeen: [], typeable: ['/ok'] });
  });
});

describe('pruneDismissed', () => {
  it('removed root drops its unseen dismissal', () => {
    const d = new Map<string, DismissKind>([
      ['/d', 'unseen'],
      ['/k', 'unseen'],
    ]);
    expect([...pruneDismissed(d, { home: '/h', roots: ['/k'] })]).toEqual([['/k', 'unseen']]);
  });

  it('re-added path drops its stillSeen dismissal', () => {
    const d = new Map<string, DismissKind>([
      ['/d', 'stillSeen'],
      ['/e', 'stillSeen'],
    ]);
    expect([...pruneDismissed(d, { home: '/h', roots: ['/d'] })]).toEqual([['/e', 'stillSeen']]);
  });

  it('a stillSeen dismissal under a re-added parent drops too', () => {
    const d = new Map<string, DismissKind>([['/p/c', 'stillSeen']]);
    expect(pruneDismissed(d, { home: '/h', roots: ['/p'] }).size).toBe(0);
  });
});
