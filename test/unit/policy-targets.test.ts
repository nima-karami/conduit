import { describe, expect, it } from 'vitest';
import { resolveTargets, type TargetDeps } from '../../src/conduit-mcp/policy-targets';

const SESSIONS: Record<string, { id: string; cwd: string | null; projectId: string | null }> = {
  alpha: { id: 's-alpha', cwd: '/w/a', projectId: 'p1' },
  beta: { id: 's-beta', cwd: '/w/b', projectId: 'p1' },
};

const deps: TargetDeps = {
  sessionByHandle: (h) => SESSIONS[h] ?? null,
  realPath: (p) => (p === '/link' ? '/real' : p.startsWith('/w/') || p === '/gone' ? p : null),
};

describe('resolveTargets', () => {
  it('close_session(handles) gives one target per session', () => {
    const targets = resolveTargets('close_session', { sessions: ['alpha', 'beta', 'ghost'] }, deps);
    expect(targets).toEqual([
      { sessionId: 's-alpha', path: null, folder: '/w/a', projectId: 'p1' },
      { sessionId: 's-beta', path: null, folder: '/w/b', projectId: 'p1' },
    ]);
  });

  it('attach_folder gives a real-path folder target', () => {
    expect(resolveTargets('attach_folder', { path: '/link' }, deps)).toEqual([
      { sessionId: null, path: '/real', folder: '/real', projectId: null },
    ]);
  });

  it('a path that does not resolve keeps its raw form', () => {
    expect(resolveTargets('attach_folder', { path: '/gone/x' }, deps)).toEqual([
      { sessionId: null, path: '/gone/x', folder: '/gone/x', projectId: null },
    ]);
  });

  it('open_file target folder is the parent directory', () => {
    expect(resolveTargets('open_file', { path: '/w/a/src/x.ts' }, deps)).toEqual([
      { sessionId: null, path: '/w/a/src/x.ts', folder: '/w/a/src', projectId: null },
    ]);
  });

  it('open_url has no targets', () => {
    expect(resolveTargets('open_url', { url: 'https://example.com' }, deps)).toEqual([]);
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
    const targets = resolveTargets('send_message', { to: ['alpha', 'you'], body: 'hi' }, recording);
    expect(targets.map((t) => t.sessionId)).toEqual(['s-alpha']);
    expect(asked).toEqual(['alpha']);
  });
});
