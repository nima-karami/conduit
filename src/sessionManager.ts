import { AgentRegistry } from './agentRegistry';
import { TerminalHost, TerminalHandle } from './terminalHost';
import { Session, SessionStatus } from './types';

export interface ProjectGroup {
  projectPath: string;
  sessions: Session[];
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly handles = new Map<string, TerminalHandle>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly registry: AgentRegistry,
    private readonly host: TerminalHost,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2),
  ) {
    this.host.onDidClose((h) => {
      for (const [sid, handle] of this.handles) {
        if (handle.id === h.id) {
          this.setStatus(sid, 'exited');
        }
      }
    });
  }

  onChange(cb: () => void) {
    this.listeners.push(cb);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  create(agentId: string, projectPath: string, worktree?: string): Session {
    const spec = this.registry.resolve(agentId, projectPath);
    const def = this.registry.get(agentId)!;
    const id = this.newId();
    const name = `${def.label} — ${projectPath.split(/[\\/]/).pop() || projectPath}`;
    const handle = this.host.create(spec, { name, color: def.color, icon: def.icon });
    const session: Session = {
      id,
      name,
      agentId,
      projectPath,
      worktree,
      status: 'running',
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.handles.set(id, handle);
    this.emit();
    return session;
  }

  focus(id: string) {
    const h = this.handles.get(id);
    if (h) this.host.focus(h);
  }

  rename(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s) {
      s.name = name;
      this.emit();
    }
  }

  kill(id: string) {
    const h = this.handles.get(id);
    if (h) this.host.dispose(h);
  }

  private setStatus(id: string, status: SessionStatus) {
    const s = this.sessions.get(id);
    if (s) {
      s.status = status;
      this.emit();
    }
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  groupByProject(): ProjectGroup[] {
    const map = new Map<string, Session[]>();
    for (const s of this.sessions.values()) {
      const arr = map.get(s.projectPath) ?? [];
      arr.push(s);
      map.set(s.projectPath, arr);
    }
    return [...map.entries()].map(([projectPath, sessions]) => ({ projectPath, sessions }));
  }
}
