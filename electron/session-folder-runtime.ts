import * as os from 'node:os';
import { folderKey } from '../src/folder-key';
import { isAncestorOf } from '../src/owning-session';
import { sessionContains, sessionHasFolderKey, watchFoldersFor } from '../src/session-folders';
import {
  createSuspectBackoff,
  SUSPECT_WINDOW_MS,
  type SuspectBackoff,
} from '../src/suspect-backoff';
import type { Session } from '../src/types';
import { isBroadWatchRoot } from '../src/watch-scope';
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
  homeDir?: string;
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
  private readonly homeDir: string;
  private readonly backoff: SuspectBackoff<string>;
  private readonly projectsByWindow = new Map<
    number,
    { p: string; sessionId: string | undefined }
  >();

  constructor(private readonly deps: SessionFolderRuntimeDeps) {
    this.homeDir = deps.homeDir ?? os.homedir();
    this.backoff = createSuspectBackoff({
      windowMs: SUSPECT_WINDOW_MS,
      onRecheck: (path, repeats) => this.recheck(path, repeats),
    });
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
    this.backoff.dispose();
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

  /** `sessionId` is the session that contributed a folder of its own, the only kind the server rechecks. */
  private watchEntries(): { path: string; sessionId: string | undefined }[] {
    const armed = new Set<Session>();
    const projects = [...this.projectsByWindow.values()].flatMap(({ p, sessionId }) => {
      const s = sessionId ? this.deps.store.get(sessionId) : undefined;
      if (s) armed.add(s);
      return watchFoldersFor(p, s).map((path) => ({ path, sessionId }));
    });
    const visible = this.deps.visibleSessionIds().flatMap((id) => {
      const s = this.deps.store.get(id);
      if (s) armed.add(s);
      return s ? watchFoldersFor(s.home, s).map((path) => ({ path, sessionId: id })) : [];
    });
    // Hidden too: a write then marks only its repo, and switching back runs git for that repo
    // alone (multi-repo-tracking spec §2 "no catch-up git"). Bounded by open sessions; the
    // watcher folds nested roots into their ancestor's watch.
    const tracking = this.deps.store.list().flatMap((s) => {
      if (!s.repos?.length) return [];
      armed.add(s);
      return watchFoldersFor(s.home, s).map((path) => ({ path, sessionId: s.id }));
    });
    return [...projects, ...visible, ...tracking, ...this.reposUnderBroad(armed)];
  }

  /**
   * A home or drive folder is watched top-level only (isBroadWatchRoot), so the repos inside it
   * would see no working-tree event at all; each gets the recursive watch the folder no longer
   * gives it.
   */
  private reposUnderBroad(
    sessions: ReadonlySet<Session>,
  ): { path: string; sessionId: undefined }[] {
    return [...sessions].flatMap((s) => {
      const broad = watchFoldersFor(s.home, s)
        .filter((f) => isBroadWatchRoot(f, this.homeDir))
        .map(folderKey);
      return (s.repos ?? [])
        .filter((r) => broad.some((b) => isAncestorOf(b, folderKey(r.root))))
        .map((r) => ({ path: r.root, sessionId: undefined }));
    });
  }

  private arm() {
    this.watcher.setFolders([...new Set(this.watchEntries().map(({ path }) => path))]);
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

  /** A folder's watch overflowing every second (a busy tree) must not recheck every second. */
  private suspect(folders: string[]) {
    for (const f of folders) this.backoff.hit(folderKey(f), f);
  }

  private recheck(path: string, repeats: number) {
    this.deps.log(
      'warn',
      'watch suspect',
      repeats > 1 ? { folders: [path], repeats, windowMs: SUSPECT_WINDOW_MS } : { folders: [path] },
    );
    const key = folderKey(path);
    // The server rechecks only a path this session contributed to the armed set.
    const owned = new Map<string, string>();
    for (const e of this.watchEntries())
      if (e.sessionId && folderKey(e.path) === key) owned.set(e.sessionId, e.path);
    for (const [id, p] of owned) this.deps.suspect(id, p);
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
