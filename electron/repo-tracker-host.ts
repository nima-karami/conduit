import * as fs from 'node:fs';
import * as path from 'node:path';
import { folderKey } from '../src/folder-key';
import { interrogateGit } from '../src/git-info';
import { readRepoChanges } from '../src/project-info';
import type { HostToWebview, RepoSnapshot } from '../src/protocol';
import {
  createRepoTracker,
  type RepoTracker,
  type RepoTrackerDeps,
  type TrackerUpdate,
} from '../src/repo-tracker';
import type { SessionManager } from '../src/session-manager';
import type { SessionResourceDemand } from '../src/session-resource-demand';
import { shouldIgnoreWatchPath } from '../src/watch-filter';
import type { Logger } from './logger';
import { watchDirWhilePresent } from './watch-dir';

// Electron shell around the pure tracker core: docs/plans/2026-10-16-multi-repo-tracking.plan.md
// (Contracts, electron/repo-tracker-host.ts).

export interface RepoTrackerHostDeps {
  mgr: Pick<SessionManager, 'get' | 'list' | 'mergeRepoGit'>;
  demand: Pick<SessionResourceDemand, 'isVisible' | 'isShownInWindow' | 'shownIn'>;
  /** Whether the window owns the session (main's sessionOwner). */
  owns: (windowId: number, sessionId: string) => boolean;
  windows: () => Iterable<{ id: number; send(msg: HostToWebview): void }>;
  log: Pick<Logger, 'debug' | 'warn'>;
  /** Tests only; the real deps are built here. */
  trackerDeps?: Partial<RepoTrackerDeps>;
  /** Tests only. */
  watchDirWhilePresent?: typeof watchDirWhilePresent;
}

export interface RepoTrackerHost {
  readonly tracker: RepoTracker;
  onWatchedPath(absKey: string): void;
  lostFolders(folders: readonly string[]): void;
  setLiveRoots(roots: readonly string[]): void;
  /** The renderer-reported ids that are live sessions this window owns. */
  ownedIds(windowId: number, ids: readonly string[]): string[];
  /** On EVERY `visible` message: a reloaded renderer in the same window re-posts the same ids. */
  windowShown(windowId: number, ids: readonly string[]): void;
  /** Un-minimize: the renderer posts no `visible` for it, so its sessions are re-sent here. */
  windowRestored(windowId: number): void;
  /** Raw IPC payloads: shape-checked here. */
  setLinesDemand(windowId: number, sessionIds: unknown): void;
  dropWindow(windowId: number): void;
  windowFocused(): void;
  refresh(sessionId: unknown, root: unknown): void;
  stop(): void;
}

async function indexMtime(root: string): Promise<number> {
  const dotGit = path.join(root, '.git');
  const st = await fs.promises.stat(dotGit);
  if (st.isDirectory()) return (await fs.promises.stat(path.join(dotGit, 'index'))).mtimeMs;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
  if (!m) return 0;
  return (await fs.promises.stat(path.join(path.resolve(root, m[1]), 'index'))).mtimeMs;
}

export function createRepoTrackerHost(deps: RepoTrackerHostDeps): RepoTrackerHost {
  const { mgr, demand, log } = deps;
  const watchWhilePresent = deps.watchDirWhilePresent ?? watchDirWhilePresent;
  const linesDemand = new Map<number, Set<string>>();

  // The tracker keys by folderKey, so each session gets the root as its own RepoInfo spells it.
  const rootFor = (sessionId: string, key: string, fallback: string) =>
    mgr.get(sessionId)?.repos?.find((r) => folderKey(r.root) === key)?.root ?? fallback;

  const sendDelta = (
    sessionId: string,
    key: string,
    fallbackRoot: string,
    entry: RepoSnapshot | { removed: true },
  ) => {
    const root = rootFor(sessionId, key, fallbackRoot);
    for (const w of deps.windows()) {
      // Minimized windows too: restore re-sends in full, but a delta must not be lost meanwhile.
      if (!deps.owns(w.id, sessionId) || !demand.isShownInWindow(w.id, sessionId)) continue;
      w.send({ type: 'repoDelta', sessionId, full: false, repos: { [root]: entry } });
    }
  };

  const publish = (update: TrackerUpdate) => {
    const { git } = update;
    if (git)
      mgr.mergeRepoGit(
        update.sessions.map((sessionId) => ({
          sessionId,
          root: rootFor(sessionId, update.key, update.root),
          info: git,
        })),
      );
    const { snapshot } = update;
    if (snapshot)
      for (const sessionId of update.sessions)
        sendDelta(sessionId, update.key, update.root, snapshot);
  };

  const tracker = createRepoTracker({
    readChanges: readRepoChanges,
    interrogate: (root) => interrogateGit(root, { skipDirty: true }),
    isSessionVisible: (id) => demand.isVisible(id),
    wantsLines: (id) => [...linesDemand.values()].some((ids) => ids.has(id)),
    watchGitDir: (commonDir, onPath, onLost) =>
      watchWhilePresent(
        commonDir,
        {
          recursive: true,
          log: (message, error) =>
            log.warn('repo-tracker', `git dir ${message}`, { commonDir, error: String(error) }),
        },
        (_event, filename) => {
          if (filename === null) return onLost();
          const rel = filename.replace(/\\/g, '/');
          // The filter only recognises git churn under a `.git` segment, which a path relative
          // to the common dir lacks (plan, Contracts: host shell).
          if (shouldIgnoreWatchPath(`.git/${rel}`)) return;
          onPath(folderKey(`${commonDir}/${rel}`));
        },
      ),
    indexMtime: (root) =>
      indexMtime(root).catch((error: unknown) => {
        log.debug('repo-tracker', 'index mtime unreadable; ranked last', {
          root,
          error: String(error),
        });
        return 0;
      }),
    publish,
    removed: (key, root, sessions) => {
      for (const sessionId of sessions) sendDelta(sessionId, key, root, { removed: true });
    },
    log: (level, msg, data) => log[level]('repo-tracker', msg, data),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...deps.trackerDeps,
  });

  const owned = (windowId: number, ids: readonly string[]) =>
    ids.filter((id) => mgr.get(id) !== undefined && deps.owns(windowId, id));

  const sendFull = (windowId: number, ids: readonly string[]) => {
    const target = [...deps.windows()].find((w) => w.id === windowId);
    if (target)
      for (const sessionId of owned(windowId, ids))
        target.send({
          type: 'repoDelta',
          sessionId,
          full: true,
          repos: tracker.snapshotsFor(sessionId),
        });
  };

  return {
    tracker,
    onWatchedPath: (absKey) => tracker.onWatchedPath(absKey),
    lostFolders: (folders) => tracker.lostFolders(folders),
    setLiveRoots: (roots) => tracker.setLiveRoots(roots),
    ownedIds: owned,
    windowShown(windowId, ids) {
      sendFull(windowId, ids);
      tracker.visibilityChanged();
    },
    windowRestored(windowId) {
      sendFull(windowId, demand.shownIn(windowId));
    },
    setLinesDemand(windowId, sessionIds) {
      if (!Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === 'string')) {
        log.warn('repo-tracker', 'changes:subscribe ignored: sessionIds is not a string array', {
          windowId,
        });
        return;
      }
      linesDemand.set(windowId, new Set(owned(windowId, sessionIds)));
      tracker.linesDemandChanged();
    },
    dropWindow(windowId) {
      linesDemand.delete(windowId);
    },
    windowFocused: () => tracker.windowFocused(),
    refresh(sessionId, root) {
      if (typeof sessionId !== 'string' || typeof root !== 'string') {
        log.warn('repo-tracker', 'repo:refresh ignored: sessionId and root must be strings', {
          sessionId: String(sessionId),
        });
        return;
      }
      const key = folderKey(root);
      if (!mgr.get(sessionId)?.repos?.some((r) => folderKey(r.root) === key)) {
        log.warn('repo-tracker', 'refresh rejected: root is not a repo of the session', {
          sessionId,
          root,
        });
        return;
      }
      tracker.refreshNow(root);
    },
    stop: () => tracker.stop(),
  };
}
