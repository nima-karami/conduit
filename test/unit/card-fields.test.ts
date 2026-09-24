import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import { fieldValue } from '../../webview/card-fields';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    agentId: 'shell:cmd',
    home: '/launch/dir',
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe('fieldValue folder/path', () => {
  it('folder: basename of live cwd when cwd is set', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir', cwd: '/work/sub' });
    expect(fieldValue(s, 'Agent', 'folder')).toBe('sub');
  });

  it('folder: falls back to home basename when cwd is undefined', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir' });
    expect(fieldValue(s, 'Agent', 'folder')).toBe('dir');
  });

  it('path: full live cwd when cwd is set', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir', cwd: '/work/sub' });
    expect(fieldValue(s, 'Agent', 'path')).toBe('/work/sub');
  });

  it('path: falls back to home when cwd is undefined', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir' });
    expect(fieldValue(s, 'Agent', 'path')).toBe('/launch/dir');
  });
});
