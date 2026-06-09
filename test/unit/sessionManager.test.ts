import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/sessionManager';
import { AgentRegistry } from '../../src/agentRegistry';
import { TerminalHost, TerminalHandle } from '../../src/terminalHost';
import { AgentDefinition, SpawnSpec } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};

class FakeHost implements TerminalHost {
  created: { spec: SpawnSpec; opts: any; h: TerminalHandle }[] = [];
  focused: string[] = [];
  disposed: string[] = [];
  private closeCbs: ((h: TerminalHandle) => void)[] = [];
  private seq = 0;

  create(spec: SpawnSpec, opts: any): TerminalHandle {
    const h = { id: `t${this.seq++}` };
    this.created.push({ spec, opts, h });
    return h;
  }
  focus(h: TerminalHandle) {
    this.focused.push(h.id);
  }
  dispose(h: TerminalHandle) {
    this.disposed.push(h.id);
    this.closeCbs.forEach((cb) => cb(h));
  }
  onDidClose(cb: (h: TerminalHandle) => void) {
    this.closeCbs.push(cb);
    return { dispose() {} };
  }
}

function seqIds() {
  let n = 0;
  return () => `id${n++}`;
}

describe('SessionManager', () => {
  let host: FakeHost;
  let mgr: SessionManager;

  beforeEach(() => {
    host = new FakeHost();
    mgr = new SessionManager(new AgentRegistry([claude]), host, seqIds());
  });

  it('creates a running session and a terminal', () => {
    const s = mgr.create('claude', '/work/proj');
    expect(s.status).toBe('running');
    expect(s.agentId).toBe('claude');
    expect(s.projectPath).toBe('/work/proj');
    expect(host.created).toHaveLength(1);
    expect(host.created[0].spec.cwd).toBe('/work/proj');
  });

  it('focuses the underlying terminal', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.focus(s.id);
    expect(host.focused).toEqual([host.created[0].h.id]);
  });

  it('renames a session', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.rename(s.id, 'My Session');
    expect(mgr.list()[0].name).toBe('My Session');
  });

  it('marks session exited when its terminal closes', () => {
    const s = mgr.create('claude', '/work/proj');
    host.dispose(host.created[0].h);
    expect(mgr.list().find((x) => x.id === s.id)!.status).toBe('exited');
  });

  it('groups sessions by projectPath', () => {
    mgr.create('claude', '/a');
    mgr.create('claude', '/a');
    mgr.create('claude', '/b');
    const groups = mgr.groupByProject();
    expect(groups.map((g) => g.projectPath).sort()).toEqual(['/a', '/b']);
    expect(groups.find((g) => g.projectPath === '/a')!.sessions).toHaveLength(2);
  });

  it('notifies onChange listeners on create', () => {
    let calls = 0;
    mgr.onChange(() => calls++);
    mgr.create('claude', '/a');
    expect(calls).toBe(1);
  });

  it('restores sessions as stale without creating terminals', () => {
    mgr.restore([
      { id: 'x', name: 'Old', agentId: 'claude', projectPath: '/a', status: 'running', createdAt: 1 },
    ]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].status).toBe('stale');
    expect(host.created).toHaveLength(0);
  });

  it('relaunches a stale session, creating a terminal and marking it running', () => {
    mgr.restore([
      { id: 'x', name: 'Old', agentId: 'claude', projectPath: '/a', status: 'running', createdAt: 1 },
    ]);
    mgr.relaunch('x');
    expect(mgr.list()[0].status).toBe('running');
    expect(host.created).toHaveLength(1);
    expect(host.created[0].spec.cwd).toBe('/a');
  });

  it('ignores relaunch for non-stale sessions', () => {
    const s = mgr.create('claude', '/a');
    mgr.relaunch(s.id);
    expect(host.created).toHaveLength(1); // only the original create, no extra terminal
  });
});
