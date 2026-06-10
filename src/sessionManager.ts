import { AgentRegistry } from './agentRegistry';
import { Session, SessionStatus } from './types';

export interface ProjectGroup {
  projectPath: string;
  sessions: Session[];
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/**
 * Authoritative store of agent sessions. Pure model — it does not spawn
 * terminals (the webview's xterm + the host's PtyHost own the processes, keyed
 * by session id). Persisted via {@link list} / {@link restore}.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly registry: AgentRegistry,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2),
  ) {}

  onChange(cb: () => void) {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  create(agentId: string, projectPath: string, name?: string): Session {
    const def = this.registry.get(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);
    const id = this.newId();
    const session: Session = {
      id,
      name: name || `${def.label} — ${basename(projectPath)}`,
      agentId,
      projectPath,
      status: 'running',
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.emit();
    return session;
  }

  /** Clone an existing session (same agent + folder), as a new running session. */
  duplicate(id: string): Session | undefined {
    const src = this.sessions.get(id);
    if (!src) return undefined;
    return this.create(src.agentId, src.projectPath, `${src.name} (copy)`);
  }

  /** Load persisted sessions as stale (their terminals are gone after reload). */
  restore(sessions: Session[]) {
    for (const s of sessions) this.sessions.set(s.id, { ...s, status: 'stale' });
    this.emit();
  }

  rename(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s && name.trim()) {
      s.name = name.trim();
      this.emit();
    }
  }

  setStatus(id: string, status: SessionStatus) {
    const s = this.sessions.get(id);
    if (s && s.status !== status) {
      s.status = status;
      this.emit();
    }
  }

  remove(id: string) {
    if (this.sessions.delete(id)) this.emit();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
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
