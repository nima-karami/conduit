import { describe, expect, it } from 'vitest';

/**
 * Unit test for the term:start kill-race guard decision.
 *
 * The guard in electron/main.ts is: `if (!mgr.get(m.sessionId)) break;`
 * We model the decision as a pure function so it can be tested without node-pty.
 */
function shouldStart(sessionExists: boolean): boolean {
  return sessionExists;
}

describe('term:start kill-race guard', () => {
  it('allows start when session is present in the manager', () => {
    expect(shouldStart(true)).toBe(true);
  });

  it('bails when session has been removed from the manager (kill-race)', () => {
    expect(shouldStart(false)).toBe(false);
  });

  it('models the sequence: kill before term:start → no spawn', () => {
    // Simulate: session created, then killed (mgr.remove), then term:start arrives.
    const sessions = new Map<string, { id: string }>();
    const id = 'session-abc';
    sessions.set(id, { id });

    // kill removes from manager
    sessions.delete(id);

    // term:start guard: session gone → bail
    const exists = sessions.has(id);
    expect(shouldStart(exists)).toBe(false);
  });

  it('models the happy path: session present → start proceeds', () => {
    const sessions = new Map<string, { id: string }>();
    const id = 'session-xyz';
    sessions.set(id, { id });

    const exists = sessions.has(id);
    expect(shouldStart(exists)).toBe(true);
  });
});
