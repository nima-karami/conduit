import { describe, expect, it } from 'vitest';
import {
  forcesAsk,
  openedByRemote,
  resolveTargets,
  type TargetCaller,
  type TargetDeps,
} from '../../src/conduit-mcp/policy-targets';
import { HUMAN_HANDLE } from '../../src/conduit-mcp/types';

const SESSIONS: Record<string, { id: string; cwd: string | null; projectId: string | null }> = {
  alpha: { id: 's-alpha', cwd: '/w/a', projectId: 'p1' },
  beta: { id: 's-beta', cwd: '/w/b', projectId: 'p1' },
};
const CHILDREN = [{ id: 's-child', cwd: '/w/c', projectId: 'p1' }];

const deps: TargetDeps = {
  sessionByHandle: (h) => SESSIONS[h] ?? Object.values(SESSIONS).find((x) => x.id === h) ?? null,
  childrenOf: () => CHILDREN,
  realPath: (p) => (p === '/link' ? '/real' : p.startsWith('/w/') || p === '/gone' ? p : null),
};
const caller: TargetCaller = { sessionId: 's-caller', home: '/w/a' };

describe('resolveTargets', () => {
  it('close_session(handles) gives one target per session', () => {
    const targets = resolveTargets(
      'close_session',
      { sessions: ['alpha', 'beta', 'ghost'] },
      caller,
      deps,
    );
    expect(targets).toEqual([
      { sessionId: 's-alpha', path: null, folder: '/w/a', projectId: 'p1' },
      { sessionId: 's-beta', path: null, folder: '/w/b', projectId: 'p1' },
    ]);
  });

  it("close_session children:true targets the caller's children", () => {
    const targets = resolveTargets(
      'close_session',
      { children: true, sessions: ['alpha'] },
      caller,
      deps,
    );
    expect(targets.map((t) => t.sessionId)).toEqual(['s-child', 's-alpha']);
    const none = resolveTargets('close_session', { sessions: ['alpha'] }, caller, deps);
    expect(none.map((t) => t.sessionId)).toEqual(['s-alpha']);
  });

  it('a routed open names no folder target here: its path is on another machine (CON-40 S3)', () => {
    expect(resolveTargets('open_session', { machine: 'desk', path: '/w/a' }, caller, deps)).toEqual(
      [],
    );
    expect(
      resolveTargets(
        'open_terminal',
        { machine: 'desk', path: '/w/a', command: 'x' },
        caller,
        deps,
      ),
    ).toEqual([]);
    expect(
      resolveTargets('open_session', { path: '/w/a' }, caller, deps).map((t) => t.folder),
    ).toEqual(['/w/a']);
  });

  it('attach_folder gives a real-path folder target', () => {
    expect(resolveTargets('attach_folder', { path: '/link' }, caller, deps)).toEqual([
      { sessionId: null, path: '/real', folder: '/real', projectId: null },
    ]);
  });

  it("attach_folder to a session on another machine names no folder here (its folder is that machine's to check)", () => {
    expect(
      resolveTargets('attach_folder', { path: '/link', session: 'h@box' }, caller, deps),
    ).toEqual([]);
  });

  it('attach_folder also targets the session named by its session arg', () => {
    const targets = resolveTargets(
      'attach_folder',
      { path: '/link', session: 'beta' },
      caller,
      deps,
    );
    expect(targets.map((t) => [t.sessionId, t.path])).toEqual([
      ['s-beta', null],
      [null, '/real'],
    ]);
  });

  it('a relative path resolves against the caller home', () => {
    expect(resolveTargets('open_file', { path: 'src/x.ts' }, caller, deps)).toEqual([
      { sessionId: null, path: '/w/a/src/x.ts', folder: '/w/a/src', projectId: null },
    ]);
  });

  it('a relative path with no caller home yields no target', () => {
    const homeless: TargetCaller = { sessionId: 's-caller', home: null };
    expect(resolveTargets('open_file', { path: 'src/x.ts' }, homeless, deps)).toEqual([]);
  });

  it('an absolute path is normalised before the real path lookup', () => {
    expect(resolveTargets('open_file', { path: '/w/a/../b/new.ts' }, caller, deps)).toEqual([
      { sessionId: null, path: '/w/b/new.ts', folder: '/w/b', projectId: null },
    ]);
  });

  it('a session lookup result supplies the target metadata', () => {
    expect(resolveTargets('close_session', { session: 's-beta' }, caller, deps)).toEqual([
      { sessionId: 's-beta', path: null, folder: '/w/b', projectId: 'p1' },
    ]);
  });

  it('a path that does not resolve keeps its absolute form', () => {
    expect(resolveTargets('attach_folder', { path: '/gone/x' }, caller, deps)).toEqual([
      { sessionId: null, path: '/gone/x', folder: '/gone/x', projectId: null },
    ]);
  });

  it('open_file target folder is the parent directory', () => {
    expect(resolveTargets('open_file', { path: '/w/a/src/x.ts' }, caller, deps)).toEqual([
      { sessionId: null, path: '/w/a/src/x.ts', folder: '/w/a/src', projectId: null },
    ]);
  });

  it('open_url has no targets', () => {
    expect(resolveTargets('open_url', { url: 'https://example.com' }, caller, deps)).toEqual([]);
  });

  it('send_message excludes you', () => {
    const asked: string[] = [];
    const recording: TargetDeps = {
      ...deps,
      sessionByHandle: (h) => {
        asked.push(h);
        return deps.sessionByHandle(h);
      },
    };
    const targets = resolveTargets(
      'send_message',
      { to: ['alpha', HUMAN_HANDLE], body: 'hi' },
      caller,
      recording,
    );
    expect(targets.map((t) => t.sessionId)).toEqual(['s-alpha']);
    expect(asked).toEqual(['alpha']);
  });
});

describe('forcesAsk: a machine never added always asks (spec 4.6, RS-D6)', () => {
  const known =
    (...refs: string[]) =>
    (ref: string) =>
      refs.includes(ref);

  it('connect_machine to an ssh target that is not added forces an ask', () => {
    expect(forcesAsk('connect_machine', { machine: 'new.example' }, known())).toBe(true);
  });

  it('connect_machine to a machine already added does not', () => {
    expect(forcesAsk('connect_machine', { machine: 'win-box' }, known('win-box'))).toBe(false);
  });

  it('a value that is not an ssh target never reaches a dial, so it does not ask', () => {
    expect(forcesAsk('connect_machine', { machine: 'not a target!' }, known())).toBe(false);
    expect(forcesAsk('connect_machine', { machine: '-oProxyCommand=x' }, known())).toBe(false);
  });

  it('the other machine tools never force an ask', () => {
    expect(forcesAsk('disconnect_machine', { machine: 'new.example' }, known())).toBe(false);
    expect(forcesAsk('list_machines', {}, known())).toBe(false);
  });

  it('a missing or empty machine argument does not ask', () => {
    expect(forcesAsk('connect_machine', {}, known())).toBe(false);
    expect(forcesAsk('connect_machine', { machine: '' }, known())).toBe(false);
  });
});

describe('openedByRemote: a remote principal reaches only the sessions it opened', () => {
  const lead = { kind: 'remote' as const, handle: 'claude-3', machineId: 'm-0000000a' };

  it('matches an opener with the same machine and handle', () => {
    expect(openedByRemote({ handle: 'claude-3', machineId: 'm-0000000a' }, lead)).toBe(true);
  });

  it('refuses an opener from a different machine with the same handle', () => {
    expect(openedByRemote({ handle: 'claude-3', machineId: 'm-0000000b' }, lead)).toBe(false);
  });

  it('refuses an opener with the same machine and a different handle', () => {
    expect(openedByRemote({ handle: 'claude-4', machineId: 'm-0000000a' }, lead)).toBe(false);
  });

  it('refuses a local opener, and no opener at all', () => {
    expect(openedByRemote({ handle: 'claude-3', sessionId: 'x' }, lead)).toBe(false);
    expect(openedByRemote(undefined, lead)).toBe(false);
  });
});
