import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { SessionManager } from '../../src/session-manager';
import type { AgentDefinition, Session } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};

function seqIds() {
  let n = 0;
  return () => `id${n++}`;
}

describe('SessionManager (model)', () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager(new AgentRegistry([claude]), seqIds());
  });

  it('creates a running session with a repo-first derived name', () => {
    const s = mgr.create('claude', '/work/proj');
    expect(s.status).toBe('running');
    expect(s.agentId).toBe('claude');
    expect(s.projectPath).toBe('/work/proj');
    expect(s.name).toBe('proj — Claude'); // folder leads, then agent
    expect(mgr.list()).toHaveLength(1);
  });

  it('preserves an explicit name (does not apply the default scheme)', () => {
    const s = mgr.create('claude', '/work/proj', 'My Session');
    expect(s.name).toBe('My Session');
  });

  it('stamps createdAt and lastActiveAt from injected now on create', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const s = m.create('claude', '/work/proj');
    expect(s.createdAt).toBe(1000);
    expect(s.lastActiveAt).toBe(1000);
    clock = 2000;
    expect(m.get(s.id)?.createdAt).toBe(1000); // unchanged
  });

  it('touch() bumps lastActiveAt only; unknown id is a no-op', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const s = m.create('claude', '/work/proj');
    let calls = 0;
    m.onChange(() => calls++);
    clock = 5000;
    m.touch(s.id);
    expect(m.get(s.id)?.lastActiveAt).toBe(5000);
    expect(m.get(s.id)?.createdAt).toBe(1000);
    expect(calls).toBe(1);
    m.touch('nope'); // unknown -> no emit, no throw
    expect(calls).toBe(1);
  });

  it('throttles touch() within minIntervalMs (coalesces keystroke bumps)', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const s = m.create('claude', '/work/proj');
    let calls = 0;
    m.onChange(() => calls++);
    clock = 1100; // 100ms later, inside the 30s window
    m.touch(s.id, 30_000);
    expect(m.get(s.id)?.lastActiveAt).toBe(1000); // skipped, not bumped
    expect(calls).toBe(0);
    clock = 40_000; // well past the window
    m.touch(s.id, 30_000);
    expect(m.get(s.id)?.lastActiveAt).toBe(40_000); // bumped
    expect(calls).toBe(1);
  });

  it('sorts available via lastActiveAt (model exposes the field)', () => {
    let clock = 1000;
    const m = new SessionManager(new AgentRegistry([claude]), seqIds(), () => clock);
    const a = m.create('claude', '/a');
    clock = 3000;
    const b = m.create('claude', '/b');
    const byActive = m.list().sort((x, y) => y.lastActiveAt - x.lastActiveAt);
    expect(byActive[0].id).toBe(b.id);
    expect(byActive[1].id).toBe(a.id);
  });

  it('throws when the agent is unknown', () => {
    expect(() => mgr.create('nope', '/work/proj')).toThrow(/unknown agent/i);
  });

  it('renames a session (ignoring blank names)', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.rename(s.id, 'My Session');
    expect(mgr.get(s.id)?.name).toBe('My Session');
    mgr.rename(s.id, '   ');
    expect(mgr.get(s.id)?.name).toBe('My Session');
  });

  it('removes a session', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.remove(s.id);
    expect(mgr.list()).toHaveLength(0);
  });

  it('updates status and notifies once per change', () => {
    let calls = 0;
    mgr.onChange(() => calls++);
    const s = mgr.create('claude', '/a');
    mgr.setStatus(s.id, 'exited');
    mgr.setStatus(s.id, 'exited'); // no-op, same status
    expect(mgr.get(s.id)?.status).toBe('exited');
    expect(calls).toBe(2); // create + first setStatus
  });

  it('groups sessions by projectPath', () => {
    mgr.create('claude', '/a');
    mgr.create('claude', '/a');
    mgr.create('claude', '/b');
    const groups = mgr.groupByProject();
    expect(groups.map((g) => g.projectPath).sort()).toEqual(['/a', '/b']);
    expect(groups.find((g) => g.projectPath === '/a')?.sessions).toHaveLength(2);
  });

  it('restores persisted sessions as stale, backfilling lastActiveAt from createdAt', () => {
    // Legacy persisted session: has createdAt but no lastActiveAt field.
    mgr.restore([
      {
        id: 'x',
        name: 'Old',
        agentId: 'claude',
        projectPath: '/a',
        status: 'running',
        createdAt: 42,
      } as Session,
    ]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get('x')?.status).toBe('stale');
    expect(mgr.get('x')?.lastActiveAt).toBe(42); // backfilled from createdAt
  });
});
