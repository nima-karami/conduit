import { describe, expect, it } from 'vitest';
import {
  busySessions,
  needsQuitConfirm,
  quitConfirmCopy,
  runningSessions,
} from '../../src/quit-guard';
import type { Session } from '../../src/types';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'my-session',
    agentId: 'shell:cmd',
    projectPath: 'C:/proj',
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// runningSessions
// ──────────────────────────────────────────────────────────────────────────────

describe('runningSessions', () => {
  it('returns only sessions with status running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running' }),
      makeSession({ id: 'b', status: 'exited' }),
      makeSession({ id: 'c', status: 'stale' }),
      makeSession({ id: 'd', status: 'running' }),
    ];
    const result = runningSessions(sessions);
    expect(result.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('returns empty array when no sessions are running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'exited' }),
      makeSession({ id: 'b', status: 'stale' }),
    ];
    expect(runningSessions(sessions)).toEqual([]);
  });

  it('returns all sessions when all are running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running' }),
      makeSession({ id: 'b', status: 'running' }),
    ];
    expect(runningSessions(sessions)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(runningSessions([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// busySessions
// ──────────────────────────────────────────────────────────────────────────────

describe('busySessions', () => {
  it('returns only running sessions that are busy', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running', busy: true }),
      makeSession({ id: 'b', status: 'running', busy: false }),
      makeSession({ id: 'c', status: 'running' }), // busy undefined → falsy
      makeSession({ id: 'd', status: 'exited', busy: true }), // not running
      makeSession({ id: 'e', status: 'running', busy: true }),
    ];
    const result = busySessions(sessions);
    expect(result.map((s) => s.id)).toEqual(['a', 'e']);
  });

  it('excludes exited/stale sessions even when flagged busy', () => {
    const sessions: Session[] = [
      makeSession({ id: 'x', status: 'stale', busy: true }),
      makeSession({ id: 'y', status: 'exited', busy: true }),
    ];
    expect(busySessions(sessions)).toEqual([]);
  });

  it('returns empty array when no running sessions are busy', () => {
    const sessions: Session[] = [makeSession({ id: 'a', status: 'running', busy: false })];
    expect(busySessions(sessions)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(busySessions([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// needsQuitConfirm
// ──────────────────────────────────────────────────────────────────────────────

describe('needsQuitConfirm', () => {
  it('returns true when at least one session is running', () => {
    const sessions: Session[] = [
      makeSession({ status: 'running' }),
      makeSession({ id: 'b', status: 'exited' }),
    ];
    expect(needsQuitConfirm(sessions)).toBe(true);
  });

  it('returns false when no sessions are running', () => {
    const sessions: Session[] = [
      makeSession({ status: 'exited' }),
      makeSession({ id: 'b', status: 'stale' }),
    ];
    expect(needsQuitConfirm(sessions)).toBe(false);
  });

  it('returns false for empty session list', () => {
    expect(needsQuitConfirm([])).toBe(false);
  });

  it('returns true when all sessions are running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running' }),
      makeSession({ id: 'b', status: 'running' }),
    ];
    expect(needsQuitConfirm(sessions)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// quitConfirmCopy — quit reason, plural, with busy sessions
// ──────────────────────────────────────────────────────────────────────────────

describe('quitConfirmCopy', () => {
  const twoRunning = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];

  describe('reason: quit — plural, with busy', () => {
    it('title counts sessions', () => {
      const { title } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(title).toBe('2 sessions still running');
    });

    it('body mentions quitting and busy clause', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(body).toContain('2 running agents');
      expect(body).toContain('(1 actively working)');
    });

    it('confirmLabel is "Quit"', () => {
      const { confirmLabel } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(confirmLabel).toBe('Quit');
    });
  });

  describe('reason: quit — plural, busy = 0', () => {
    it('omits the busy clause when busy = 0', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'quit' });
      expect(body).not.toContain('actively working');
    });

    it('still mentions the agent count', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'quit' });
      expect(body).toContain('2 running agents');
    });
  });

  describe('reason: quit — singular', () => {
    const oneRunning = [makeSession({ id: 'a' })];

    it('title uses singular "session"', () => {
      const { title } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'quit' });
      expect(title).toBe('1 session still running');
    });

    it('body uses singular "agent"', () => {
      const { body } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'quit' });
      expect(body).toContain('1 running agent');
      expect(body).not.toContain('agents');
    });
  });

  describe('reason: update — plural, with busy', () => {
    it('title counts sessions', () => {
      const { title } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(title).toBe('2 sessions still running');
    });

    it('body mentions closing and relaunch', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(body).toContain('closes');
      expect(body).toContain('relaunch');
      expect(body).toContain('(2 actively working)');
    });

    it('confirmLabel is "Relaunch & update"', () => {
      const { confirmLabel } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(confirmLabel).toBe('Relaunch & update');
    });
  });

  describe('reason: update — plural, busy = 0', () => {
    it('omits the busy clause', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'update' });
      expect(body).not.toContain('actively working');
    });
  });

  describe('reason: update — singular', () => {
    const oneRunning = [makeSession({ id: 'a' })];

    it('title uses singular "session"', () => {
      const { title } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'update' });
      expect(title).toBe('1 session still running');
    });

    it('body uses singular "agent"', () => {
      const { body } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'update' });
      expect(body).toContain('1 running agent');
      expect(body).not.toContain('agents');
    });
  });
});
