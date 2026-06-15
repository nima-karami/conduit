import type { AgentRegistry } from './agent-registry';
import { sessionNameFromPath } from './session-name';
import { resolveTitleSync } from './session-title';
import type { Session, SessionStatus } from './types';

export interface ProjectGroup {
  projectPath: string;
  sessions: Session[];
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
    private readonly now: () => number = () => Date.now(),
  ) {}

  onChange(cb: () => void) {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  private emit() {
    this.listeners.forEach((l) => {
      l();
    });
  }

  create(agentId: string, projectPath: string, name?: string, cardId?: string): Session {
    const def = this.registry.get(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);
    const id = this.newId();
    const ts = this.now();
    const session: Session = {
      id,
      // Default name is the folder basename only — no agent suffix or counter.
      name: name || sessionNameFromPath(projectPath),
      agentId,
      projectPath,
      status: 'running',
      createdAt: ts,
      lastActiveAt: ts,
      // New sessions track the terminal title until the user renames (see applyTitle).
      // An explicit name (e.g. a duplicate's "… (copy)") still tracks; the title only
      // overrides when it's meaningful per resolveTitleSync.
      autoTitle: true,
      // N2: stamp the originating board card so the link survives (persisted in sessions.json).
      ...(cardId ? { cardId } : {}),
    };
    this.sessions.set(id, session);
    this.emit();
    return session;
  }

  /**
   * Mark a session as active now (cheap signal: terminal start / user input).
   * `minIntervalMs` coalesces high-frequency callers (e.g. per-keystroke input):
   * if the last bump was within the window, it's skipped so we don't persist +
   * broadcast on every character. Relative-time granularity is minutes, so
   * sub-minute precision is invisible anyway. Pass 0 (default) to always bump.
   */
  touch(id: string, minIntervalMs = 0) {
    const s = this.sessions.get(id);
    if (!s) return;
    const ts = this.now();
    if (minIntervalMs > 0 && ts - s.lastActiveAt < minIntervalMs) return;
    s.lastActiveAt = ts;
    this.emit();
  }

  /** Reorder sessions to match `orderedIds` (unknown ids ignored, missing appended). */
  reorder(orderedIds: string[]) {
    const ordered = new Map<string, Session>();
    for (const id of orderedIds) {
      const s = this.sessions.get(id);
      if (s) ordered.set(id, s);
    }
    for (const [id, s] of this.sessions) if (!ordered.has(id)) ordered.set(id, s);
    this.sessions.clear();
    for (const [id, s] of ordered) this.sessions.set(id, s);
    this.emit();
  }

  /** Clone an existing session (same agent + folder), as a new running session. */
  duplicate(id: string): Session | undefined {
    const src = this.sessions.get(id);
    if (!src) return undefined;
    return this.create(src.agentId, src.projectPath, `${src.name} (copy)`);
  }

  /** Load persisted sessions as stale (their terminals are gone after reload). */
  restore(sessions: Session[]) {
    for (const s of sessions) {
      // Back-compat: sessions persisted before lastActiveAt/createdAt existed.
      const createdAt = s.createdAt ?? this.now();
      const lastActiveAt = s.lastActiveAt ?? createdAt;
      this.sessions.set(s.id, { ...s, status: 'stale', createdAt, lastActiveAt });
    }
    this.emit();
  }

  rename(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s && name.trim()) {
      s.name = name.trim();
      // A manual rename wins: stop tracking the terminal title from now on.
      s.autoTitle = false;
      this.emit();
    }
  }

  /**
   * Adopt the terminal's title (OSC 0/2) as the session name, if policy allows
   * (see resolveTitleSync: ignores empty/path/locked titles). This is how an app
   * running in the terminal — e.g. Claude Code, including a live `/rename` — drives
   * the session label. Leaves autoTitle true so subsequent title changes keep flowing.
   */
  applyTitle(id: string, title: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const next = resolveTitleSync(s, title);
    if (next && next !== s.name) {
      s.name = next;
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
