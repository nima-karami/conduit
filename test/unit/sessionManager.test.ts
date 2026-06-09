import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/sessionManager';
import { AgentRegistry } from '../../src/agentRegistry';
import { AgentDefinition } from '../../src/types';

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

  it('creates a running session with a derived name', () => {
    const s = mgr.create('claude', '/work/proj');
    expect(s.status).toBe('running');
    expect(s.agentId).toBe('claude');
    expect(s.projectPath).toBe('/work/proj');
    expect(s.name).toBe('Claude — proj');
    expect(mgr.list()).toHaveLength(1);
  });

  it('throws when the agent is unknown', () => {
    expect(() => mgr.create('nope', '/work/proj')).toThrow(/unknown agent/i);
  });

  it('renames a session (ignoring blank names)', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.rename(s.id, 'My Session');
    expect(mgr.get(s.id)!.name).toBe('My Session');
    mgr.rename(s.id, '   ');
    expect(mgr.get(s.id)!.name).toBe('My Session');
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
    expect(mgr.get(s.id)!.status).toBe('exited');
    expect(calls).toBe(2); // create + first setStatus
  });

  it('groups sessions by projectPath', () => {
    mgr.create('claude', '/a');
    mgr.create('claude', '/a');
    mgr.create('claude', '/b');
    const groups = mgr.groupByProject();
    expect(groups.map((g) => g.projectPath).sort()).toEqual(['/a', '/b']);
    expect(groups.find((g) => g.projectPath === '/a')!.sessions).toHaveLength(2);
  });

  it('restores persisted sessions as stale', () => {
    mgr.restore([
      { id: 'x', name: 'Old', agentId: 'claude', projectPath: '/a', status: 'running', createdAt: 1 },
    ]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get('x')!.status).toBe('stale');
  });
});
