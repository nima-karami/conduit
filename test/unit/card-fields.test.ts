import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import { agentRowTooltip, cantStartReason, fieldValue } from '../../webview/card-fields';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    agentId: 'shell:cmd',
    home: '/launch/dir',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe('fieldValue path', () => {
  it('path: full live cwd when cwd is set', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir', cwd: '/work/sub' });
    expect(fieldValue(s, 'Agent', 'path')).toBe('/work/sub');
  });

  it('path: falls back to home when cwd is undefined', () => {
    const s = makeSession({ id: 's1', home: '/launch/dir' });
    expect(fieldValue(s, 'Agent', 'path')).toBe('/launch/dir');
  });

  it('agent and worktree read straight through', () => {
    const s = makeSession({ id: 's1', worktree: 'wt' });
    expect(fieldValue(s, 'Codex', 'agent')).toBe('Codex');
    expect(fieldValue(s, 'Codex', 'worktree')).toBe('wt');
    expect(fieldValue(makeSession({ id: 's2' }), '', 'worktree')).toBe('');
  });
});

describe('agentRowTooltip', () => {
  it('keeps the old card fields reachable, one fact per line', () => {
    const s = makeSession({ id: 'Fix e2e', cwd: '/work/sub', worktree: 'e2e-flake' });
    expect(
      agentRowTooltip({ session: s, agentLabel: 'Codex', state: 'Working', space: 'Conduit' }),
    ).toBe(['Fix e2e', 'Working · Conduit', 'Codex', '/work/sub', 'worktree e2e-flake'].join('\n'));
  });

  it('omits what is absent and appends the extra lines', () => {
    const s = makeSession({ id: 'a' });
    expect(
      agentRowTooltip({
        session: s,
        agentLabel: '',
        state: 'Idle',
        extra: ['', 'Opened by codex-1'],
      }),
    ).toBe(['a', 'Idle', '/launch/dir', 'Opened by codex-1'].join('\n'));
  });
});

describe('cantStartReason', () => {
  it('names the missing home or the command that was not found', () => {
    expect(cantStartReason(makeSession({ id: 'a', status: 'stale', homeMissing: true }))).toBe(
      "Can't start: Home folder not found",
    );
    expect(
      cantStartReason(
        makeSession({
          id: 'a',
          status: 'stale',
          startRefusal: { reason: 'unresolvable', command: 'codex' },
        }),
      ),
    ).toBe("Can't start: codex wasn't found");
    expect(cantStartReason(makeSession({ id: 'a' }))).toBe('');
  });
});
