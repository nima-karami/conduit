import { resolveActiveRepo } from './active-repo';
import type { AgentRegistry } from './agent-registry';
import { folderKey } from './folder-key';
import type { RepoInfo } from './repo-scan';
import { iconKindFromText } from './session-icon';
import { sessionNameFromPath } from './session-name';
import { resolveTitleSync } from './session-title';
import type { GitInfo, Session, SessionStatus } from './types';

/** Shallow value-equality for GitInfo so setGit only emits on a real change. */
function sameGit(a: GitInfo | undefined, b: GitInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.branch === b.branch &&
    a.unborn === b.unborn &&
    a.sha === b.sha &&
    a.isWorktree === b.isWorktree &&
    a.worktreeName === b.worktreeName &&
    a.dirty === b.dirty &&
    a.operation === b.operation
  );
}

export interface SessionCreateOpts {
  name?: string;
  cardId?: string;
  roots?: string[];
  missingRoots?: string[];
  projectId?: string;
}

function setMissing(s: Session, keys: ReadonlySet<string>) {
  const missing = s.roots.filter((r) => keys.has(folderKey(r)));
  if (missing.length > 0) s.missingRoots = missing;
  else delete s.missingRoots;
}

const missingKeys = (s: Session) => new Set((s.missingRoots ?? []).map(folderKey));

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

  create(agentId: string, home: string, opts: SessionCreateOpts = {}): Session {
    const { name, cardId, projectId } = opts;
    const def = this.registry.get(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);
    const id = this.newId();
    const ts = this.now();
    const session: Session = {
      id,
      // Default name is the folder basename only — no agent suffix or counter.
      name: name || sessionNameFromPath(home),
      agentId,
      home,
      roots: [...(opts.roots ?? [])],
      status: 'running',
      createdAt: ts,
      lastActiveAt: ts,
      // N2: stamp the originating board card so the link survives (persisted in sessions.json).
      ...(cardId ? { cardId } : {}),
      ...(projectId ? { projectId } : {}),
    };
    setMissing(session, new Set((opts.missingRoots ?? []).map(folderKey)));
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
    return this.create(src.agentId, src.home, {
      name: `${src.name} (copy)`,
      roots: src.roots,
      missingRoots: src.missingRoots,
      projectId: src.projectId,
    });
  }

  // The folder mutations below take already-validated input (src/session-ops.ts validates).
  addRoot(id: string, stored: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.roots.push(stored);
    this.emit();
    return true;
  }

  removeRoot(id: string, key: string): boolean {
    const s = this.sessions.get(id);
    const i = s ? s.roots.findIndex((r) => folderKey(r) === key) : -1;
    if (!s || i < 0) return false;
    const missing = missingKeys(s);
    s.roots.splice(i, 1);
    setMissing(s, missing);
    this.emit();
    return true;
  }

  replaceRoot(id: string, oldKey: string, stored: string): boolean {
    const s = this.sessions.get(id);
    const i = s ? s.roots.findIndex((r) => folderKey(r) === oldKey) : -1;
    if (!s || i < 0) return false;
    const missing = missingKeys(s);
    missing.delete(oldKey);
    s.roots[i] = stored;
    setMissing(s, missing);
    this.emit();
    return true;
  }

  /** See mf-model plan Contracts "SessionManager" for how the missing flags travel. */
  setHome(id: string, stored: string, keepOldHome: boolean): boolean {
    const s = this.sessions.get(id);
    const key = folderKey(stored);
    if (!s || folderKey(s.home) === key) return false;
    const missing = missingKeys(s);
    const oldHome = s.home;
    const oldHomeMissing = s.homeMissing === true;
    const i = s.roots.findIndex((r) => folderKey(r) === key);
    if (i >= 0) s.roots.splice(i, 1);
    if (i >= 0 && missing.has(key)) s.homeMissing = true;
    else delete s.homeMissing;
    missing.delete(key);
    if (keepOldHome) {
      s.roots.push(oldHome);
      if (oldHomeMissing) missing.add(folderKey(oldHome));
    }
    s.home = stored;
    setMissing(s, missing);
    this.emit();
    return true;
  }

  setProject(id: string, projectId: string | undefined): boolean {
    const s = this.sessions.get(id);
    if (!s || s.projectId === projectId) return false;
    if (projectId) s.projectId = projectId;
    else delete s.projectId;
    this.emit();
    return true;
  }

  clearProject(projectId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.projectId !== projectId) continue;
      delete s.projectId;
      n++;
    }
    if (n > 0) this.emit();
    return n;
  }

  /** A health result measured against an earlier home leaves `homeMissing` alone (S2). */
  setFolderHealth(
    id: string,
    h: { homeKey: string; missingRoots: string[]; homeMissing: boolean },
  ): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const before = JSON.stringify([s.missingRoots, s.homeMissing]);
    setMissing(s, new Set(h.missingRoots.map(folderKey)));
    if (h.homeKey === folderKey(s.home)) {
      if (h.homeMissing) s.homeMissing = true;
      else delete s.homeMissing;
    }
    if (JSON.stringify([s.missingRoots, s.homeMissing]) === before) return false;
    this.emit();
    return true;
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
      this.emit();
    }
  }

  /**
   * Set or clear a user-chosen Lucide icon override for a session (D3). Pass a
   * Lucide icon name (kebab-case) to set the override, or `null`/`undefined` to
   * clear it and fall back to appIcon / agent-derived icon.
   */
  setIconOverride(id: string, icon: string | null | undefined) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (icon) {
      s.iconOverride = icon;
    } else {
      delete s.iconOverride;
    }
    this.emit();
  }

  /**
   * Adopt the terminal's title (OSC 0/2) as the session name, if policy allows
   * (see resolveTitleSync: ignores empty/path/folder titles). This is how an app
   * running in the terminal — e.g. Claude Code, including a live `/rename` — drives
   * the session label. A meaningful title always wins, so a `/rename` overrides a
   * prior manual rename.
   */
  applyTitle(id: string, title: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    let changed = false;
    const next = resolveTitleSync(s, title);
    if (next && next !== s.name) {
      s.name = next;
      changed = true;
    }
    // Sticky icon: if the title names a known app (e.g. `claude` running inside a
    // plain shell), adopt that glyph and keep it even after a later /rename.
    const kind = iconKindFromText(title);
    if (kind && s.appIcon !== kind) {
      s.appIcon = kind;
      changed = true;
    }
    if (changed) this.emit();
  }

  setStatus(id: string, status: SessionStatus) {
    const s = this.sessions.get(id);
    if (s && s.status !== status) {
      s.status = status;
      this.emit();
    }
  }

  /**
   * Update the session's live working directory (E2a). Only emits when the cwd
   * actually changes; does NOT touch home (the stable group key).
   */
  setCwd(id: string, cwd: string) {
    const s = this.sessions.get(id);
    if (s && s.cwd !== cwd) {
      s.cwd = cwd;
      this.emit();
    }
  }

  /**
   * Attach runtime-derived git context for the session's active cwd. Emits on any
   * change (shallow-compared) so the renderer rebroadcast carries the new GitInfo.
   * Never persisted — serializeSessions strips `git`.
   */
  setGit(id: string, git: GitInfo | undefined) {
    const s = this.sessions.get(id);
    if (s && !sameGit(s.git, git)) {
      s.git = git;
      this.emit();
    }
  }

  /** Recompute derived active-repo fields from repos+pin+auto. Returns whether they changed. */
  private recomputeActiveRepo(s: Session): boolean {
    const next = resolveActiveRepo({
      repos: s.repos ?? [],
      pinnedRoot: s.pinnedRepoRoot,
      autoRoot: s.autoRepoRoot,
      openedRoot: s.home,
    });
    // resolveActiveRepo returns the pinned root only when it still exists, so the pin is in
    // effect iff it won. A pin whose repo vanished didn't win → drop it. (No second scan.)
    const pinned = next !== undefined && next === s.pinnedRepoRoot;
    if (s.pinnedRepoRoot && !pinned) delete s.pinnedRepoRoot;
    let changed = false;
    if (s.activeRepoRoot !== next) {
      s.activeRepoRoot = next;
      changed = true;
    }
    if (s.repoPinned !== pinned) {
      s.repoPinned = pinned;
      changed = true;
    }
    return changed;
  }

  setRepos(id: string, repos: RepoInfo[]) {
    const s = this.sessions.get(id);
    if (!s) return;
    // The scan re-runs on every fsChanged tick; skip the broadcast + persist when the detected
    // repo list is identical (same entries, same order) and nothing derived changed.
    const sameList =
      (s.repos?.length ?? 0) === repos.length &&
      repos.every((r, i) => {
        const o = s.repos?.[i];
        return o?.root === r.root && o.tag === r.tag && o.folder === r.folder;
      });
    s.repos = repos;
    const derivedChanged = this.recomputeActiveRepo(s);
    if (!sameList || derivedChanged) this.emit();
  }

  setAutoRepo(id: string, root: string | undefined) {
    const s = this.sessions.get(id);
    if (!s || s.autoRepoRoot === root) return;
    s.autoRepoRoot = root;
    if (this.recomputeActiveRepo(s)) this.emit();
  }

  pinRepo(id: string, root: string) {
    const s = this.sessions.get(id);
    if (!s || s.pinnedRepoRoot === root) return;
    s.pinnedRepoRoot = root;
    if (this.recomputeActiveRepo(s)) this.emit();
  }

  unpinRepo(id: string) {
    const s = this.sessions.get(id);
    if (!s?.pinnedRepoRoot) return;
    delete s.pinnedRepoRoot;
    if (this.recomputeActiveRepo(s)) this.emit();
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
}
