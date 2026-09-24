import { folderKey } from '../src/folder-key';
import { sessionContains, sessionHasFolderKey, watchFoldersFor } from '../src/session-folders';
import type { SessionManager } from '../src/session-manager';
import type { FsFire, ProjectWatcher } from './project-watcher';

export interface SessionFolderRuntimeDeps {
  mgr: Pick<SessionManager, 'get' | 'list'>;
  scheduleRepoScan: (sessionId: string) => void;
  reconcilePlans: (homes: string[]) => void;
  broadcastFsChanged: (fire: FsFire) => void;
  dropResolutionsForRoot: (root: string) => void;
  createWatcher: (
    onFire: (f: FsFire) => void,
    onSuspect: (folders: string[]) => void,
  ) => Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

/** The host's one owner of a session's folder lifecycle (L12 S1; mf-model plan Contracts). */
export class SessionFolderRuntime {
  private listeners: ((sessionId: string) => void)[] = [];
  private readonly watcher: Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  // The single global watcher follows the latest requestProject from any window (spec §12).
  private watched: { p: string; sessionId: string | undefined } | null = null;

  constructor(private readonly deps: SessionFolderRuntimeDeps) {
    this.watcher = deps.createWatcher(
      (f) => this.fired(f),
      (folders) => deps.log('warn', 'watch suspect', { folders }),
    );
  }

  created(sessionId: string): void {
    this.deps.scheduleRepoScan(sessionId);
  }

  foldersChanged(sessionId: string, change: { homeChanged: boolean }): void {
    this.deps.scheduleRepoScan(sessionId);
    if (change.homeChanged) this.reconcilePlans();
    if (this.watched?.sessionId === sessionId) this.arm();
    this.emit(sessionId);
  }

  requestProject(p: string, sessionId: string | undefined): void {
    if (!p) return;
    this.watched = { p, sessionId: sessionId ? this.deps.mgr.get(sessionId)?.id : undefined };
    this.arm();
    this.reconcilePlans();
    // A repo created outside every watched folder is only ever found by these refreshes.
    for (const s of this.deps.mgr.list()) {
      if (sessionContains(s, p)) this.deps.scheduleRepoScan(s.id);
    }
  }

  onFoldersChanged(cb: (sessionId: string) => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  stop(): void {
    this.watcher.stop();
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
