import { folderKey } from '../src/folder-key';
import { sessionContains, sessionHasFolderKey, watchFoldersFor } from '../src/session-folders';
import type { Session } from '../src/types';
import type { SessionFolderDiff } from './app-session-store';
import type { FsFire, ProjectWatcher } from './project-watcher';

export interface SessionFolderRuntimeDeps {
  store: { get(id: string): Session | undefined; list(): Session[] };
  visibleSessionIds: () => readonly string[];
  scheduleRepoScan: (sessionId: string, force?: boolean) => void;
  reconcilePlans: (homes: string[]) => void;
  broadcastFsChanged: (fire: FsFire) => void;
  dropResolutionsForRoot: (root: string) => void;
  createWatcher: (
    onFire: (f: FsFire) => void,
    onSuspect: (folders: string[]) => void,
  ) => Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  /** The server owns folder health (W4); a lost or renamed watch is its only signal (C2 folders.suspect). */
  suspect: (sessionId: string, path: string) => void;
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

/** The server's health marks, compared per list so a returning folder rescans its repos. */
const healthOf = (s: Session) => `${s.homeMissing ? 1 : 0}|${(s.missingRoots ?? []).join('\n')}`;

/**
 * The app's half of a session's folder lifecycle: watchers, repo scans and plan reconcile, driven
 * by the server's session list (L12 S1; mf-model plan Contracts).
 */
export class SessionFolderRuntime {
  private listeners: ((sessionId: string) => void)[] = [];
  private readonly watcher: Pick<ProjectWatcher, 'setFolders' | 'stop'>;
  private readonly health = new Map<string, string>();
  private readonly projectsByWindow = new Map<
    number,
    { p: string; sessionId: string | undefined }
  >();

  constructor(private readonly deps: SessionFolderRuntimeDeps) {
    this.watcher = deps.createWatcher(
      (f) => this.fired(f),
      (folders) => this.suspect(folders),
    );
  }

  /** Every server list, with the store's diff against the previous one. */
  applied(diffs: readonly SessionFolderDiff[]): void {
    let removed = false;
    for (const d of diffs) {
      if (d.kind === 'added') this.created(d.sessionId);
      else if (d.kind === 'changed') this.foldersChanged(d.sessionId, d);
      else {
        this.health.delete(d.sessionId);
        removed = true;
      }
    }
    for (const s of this.deps.store.list()) {
      const h = healthOf(s);
      const before = this.health.get(s.id);
      this.health.set(s.id, h);
      if (before === undefined || before === h) continue;
      this.deps.scheduleRepoScan(s.id);
      if (this.armsFor(s.id)) this.arm();
      this.emit(s.id);
    }
    if (removed) {
      this.arm();
      this.reconcilePlans();
    }
  }

  created(sessionId: string): void {
    this.deps.scheduleRepoScan(sessionId);
  }

  foldersChanged(sessionId: string, change: { homeChanged: boolean }): void {
    this.deps.scheduleRepoScan(sessionId);
    if (change.homeChanged) this.reconcilePlans();
    if (this.armsFor(sessionId)) this.arm();
    this.emit(sessionId);
  }

  requestProject(p: string, sessionId: string | undefined, windowId: number, force = false): void {
    if (!p) return;
    const id = sessionId ? this.deps.store.get(sessionId)?.id : undefined;
    this.projectsByWindow.set(windowId, { p, sessionId: id });
    this.arm();
    this.reconcilePlans();
    // A repo created outside every watched folder is only ever found by these refreshes.
    for (const s of this.deps.store.list()) {
      if (sessionContains(s, p)) this.deps.scheduleRepoScan(s.id, force && (!id || id === s.id));
    }
  }

  windowClosed(windowId: number): void {
    this.projectsByWindow.delete(windowId);
    this.arm();
  }

  visibilityChanged(): void {
    this.arm();
  }

  /** A session gained or lost registered repos, or was disposed. */
  reposChanged(): void {
    this.arm();
  }

  onFoldersChanged(cb: (sessionId: string) => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  stop(): void {
    this.watcher.stop();
    this.listeners = [];
  }

  /** Whether the session's folders are in the armed set: shown in a window, or tracking repos. */
  private armsFor(sessionId: string): boolean {
    return (
      !!this.deps.store.get(sessionId)?.repos?.length ||
      [...this.projectsByWindow.values()].some((p) => p.sessionId === sessionId)
    );
  }

  private arm() {
    const visible = this.deps.visibleSessionIds().flatMap((id) => {
      const s = this.deps.store.get(id);
      return s ? watchFoldersFor(s.home, s) : [];
    });
    // Hidden too: a write then marks only its repo, and switching back runs git for that repo
    // alone (multi-repo-tracking spec §2 "no catch-up git"). Bounded by open sessions; the
    // watcher folds nested roots into their ancestor's watch.
    const tracking = this.deps.store
      .list()
      .flatMap((s) => (s.repos?.length ? watchFoldersFor(s.home, s) : []));
    this.watcher.setFolders([
      ...new Set([
        ...[...this.projectsByWindow.values()].flatMap(({ p, sessionId }) =>
          watchFoldersFor(p, sessionId ? this.deps.store.get(sessionId) : undefined),
        ),
        ...visible,
        ...tracking,
      ]),
    ]);
  }

  private reconcilePlans() {
    this.deps.reconcilePlans(this.deps.store.list().map((s) => s.home));
  }

  private fired(f: FsFire) {
    this.deps.broadcastFsChanged(f);
    for (const folder of f.folders) this.deps.dropResolutionsForRoot(folder);
    const keys = f.folders.map(folderKey);
    for (const s of this.deps.store.list()) {
      if (keys.some((k) => sessionHasFolderKey(s, k))) this.deps.scheduleRepoScan(s.id);
    }
  }

  private suspect(folders: string[]) {
    this.deps.log('warn', 'watch suspect', { folders });
    const keys = new Set(folders.map(folderKey));
    const affected = new Set(
      [...this.projectsByWindow.values()].flatMap(({ p, sessionId }) =>
        sessionId &&
        watchFoldersFor(p, this.deps.store.get(sessionId)).some((root) => keys.has(folderKey(root)))
          ? [sessionId]
          : [],
      ),
    );
    // The server rechecks only a path that is one of that session's own folders.
    for (const id of affected) for (const folder of folders) this.deps.suspect(id, folder);
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
