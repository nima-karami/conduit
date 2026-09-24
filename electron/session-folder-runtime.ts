import {
  applyHealthReport,
  type FolderHealth,
  type FolderHealthReport,
} from '../src/folder-health';
import { folderKey } from '../src/folder-key';
import type { SessionOpReason } from '../src/folder-validation';
import { sessionContains, sessionHasFolderKey, watchFoldersFor } from '../src/session-folders';
import type { SessionManager } from '../src/session-manager';
import type { FsFire, ProjectWatcher } from './project-watcher';

export interface SessionFolderRuntimeDeps {
  mgr: Pick<SessionManager, 'get' | 'list' | 'setFolderHealth'>;
  scheduleRepoScan: (sessionId: string) => void;
  reconcilePlans: (homes: string[]) => void;
  broadcastFsChanged: (fire: FsFire) => void;
  dropResolutionsForRoot: (root: string) => void;
  createWatcher: (
    onFire: (f: FsFire) => void,
    onSuspect: (folders: string[]) => void,
  ) => Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  createHealth: (
    apply: (r: FolderHealthReport) => Promise<void>,
  ) => Pick<FolderHealth, 'check' | 'pending' | 'dispose'>;
  revalidate: (sessionId: string, folder: string) => Promise<SessionOpReason | null>;
  realpath: (p: string) => Promise<string>;
  realKeys: Map<string, string>;
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

/** The host's one owner of a session's folder lifecycle (L12 S1; mf-model plan Contracts). */
export class SessionFolderRuntime {
  private listeners: ((sessionId: string) => void)[] = [];
  private readonly watcher: Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  private readonly health: Pick<FolderHealth, 'check' | 'pending' | 'dispose'>;
  private readonly loggedRejections = new Map<string, SessionOpReason>();
  // The single global watcher follows the latest requestProject from any window (spec §12).
  private watched: { p: string; sessionId: string | undefined } | null = null;

  constructor(private readonly deps: SessionFolderRuntimeDeps) {
    this.watcher = deps.createWatcher(
      (f) => this.fired(f),
      (folders) => this.suspect(folders),
    );
    this.health = deps.createHealth((r) => this.applyHealth(r));
  }

  restored(): void {
    // Scan after the marks land, or detectRepos walks a hung root first (spec §2.2 "Restore").
    for (const s of this.deps.mgr.list()) {
      void this.health.check(s.id).then(() => this.deps.scheduleRepoScan(s.id));
    }
  }

  pending(sessionId: string): Promise<void> | undefined {
    return this.health.pending(sessionId);
  }

  created(sessionId: string): void {
    this.deps.scheduleRepoScan(sessionId);
    this.check(sessionId);
  }

  foldersChanged(sessionId: string, change: { homeChanged: boolean }): void {
    this.deps.scheduleRepoScan(sessionId);
    if (change.homeChanged) this.reconcilePlans();
    if (this.watched?.sessionId === sessionId) this.arm();
    this.emit(sessionId);
    this.check(sessionId);
  }

  requestProject(p: string, sessionId: string | undefined): void {
    if (!p) return;
    const id = sessionId ? this.deps.mgr.get(sessionId)?.id : undefined;
    const switched = id !== this.watched?.sessionId;
    this.watched = { p, sessionId: id };
    this.arm();
    // Only on a switch: every fsChanged comes back as a requestProject (spec §2.6, L12 S4).
    if (id && switched) this.check(id);
    this.reconcilePlans();
    // A repo created outside every watched folder is only ever found by these refreshes.
    for (const s of this.deps.mgr.list()) {
      if (sessionContains(s, p)) this.deps.scheduleRepoScan(s.id);
    }
  }

  focused(): void {
    if (this.watched?.sessionId) this.check(this.watched.sessionId);
  }

  onFoldersChanged(cb: (sessionId: string) => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  stop(): void {
    this.watcher.stop();
    this.health.dispose();
    this.listeners = [];
  }

  private arm() {
    if (!this.watched) return;
    const { p, sessionId } = this.watched;
    this.watcher.setFolders(
      watchFoldersFor(p, sessionId ? this.deps.mgr.get(sessionId) : undefined),
    );
  }

  private reconcilePlans() {
    this.deps.reconcilePlans(this.deps.mgr.list().map((s) => s.home));
  }

  private fired(f: FsFire) {
    this.deps.broadcastFsChanged(f);
    for (const folder of f.folders) this.deps.dropResolutionsForRoot(folder);
    const keys = f.folders.map(folderKey);
    for (const s of this.deps.mgr.list()) {
      if (keys.some((k) => sessionHasFolderKey(s, k))) this.deps.scheduleRepoScan(s.id);
    }
  }

  private check(sessionId: string, only?: readonly string[]) {
    void this.health.check(sessionId, only);
  }

  private suspect(folders: string[]) {
    this.deps.log('warn', 'watch suspect', { folders });
    if (this.watched?.sessionId) this.check(this.watched.sessionId, folders);
  }

  // FolderHealth awaits this, so it must not reject.
  private async applyHealth(r: FolderHealthReport): Promise<void> {
    try {
      await this.reconcileHealth(r);
    } catch (e) {
      this.deps.log('warn', `health apply failed: ${String(e)}`, { sessionId: r.sessionId });
    }
  }

  private async reconcileHealth(r: FolderHealthReport) {
    const s = this.deps.mgr.get(r.sessionId);
    if (!s) return;
    const { realKeys } = this.deps;
    const present = (key: string) => r.states.get(key) === 'present';
    const marked = new Set((s.missingRoots ?? []).map(folderKey));
    if (s.homeMissing && r.homeKey === folderKey(s.home)) marked.add(r.homeKey);
    const rejected = new Set<string>();
    for (const folder of [s.home, ...s.roots]) {
      const key = folderKey(folder);
      if (!present(key) || !marked.has(key)) continue;
      const reason = await this.deps.revalidate(s.id, folder);
      if (reason) rejected.add(key);
      this.noteRejection(key, folder, reason);
    }
    for (const folder of [s.home, ...s.roots]) {
      const key = folderKey(folder);
      if (!present(key) || rejected.has(key) || realKeys.has(key)) continue;
      try {
        realKeys.set(key, folderKey(await this.deps.realpath(folder)));
      } catch {
        // Gone again since its stat: the next check marks it, and its key stays lexical-only.
      }
    }
    const cur = this.deps.mgr.get(r.sessionId);
    if (!cur || !this.deps.mgr.setFolderHealth(cur.id, applyHealthReport(cur, r, rejected))) return;
    this.deps.scheduleRepoScan(cur.id);
    if (this.watched?.sessionId === cur.id) this.arm();
    this.emit(cur.id);
  }

  // Re-probed every poll tick, so only a new reason is worth a line (mf-model plan, Decisions).
  private noteRejection(key: string, folder: string, reason: SessionOpReason | null) {
    if (!reason) {
      this.loggedRejections.delete(key);
      return;
    }
    if (this.loggedRejections.get(key) === reason) return;
    this.loggedRejections.set(key, reason);
    this.deps.log('warn', 'returning folder failed revalidation', { folder, reason });
  }

  private emit(sessionId: string) {
    for (const l of this.listeners) {
      // A consumer's failure must not abort the op that already mutated the session.
      try {
        l(sessionId);
      } catch (e) {
        this.deps.log('warn', `onFoldersChanged listener failed: ${String(e)}`, { sessionId });
      }
    }
  }
}
