import { folderKey } from './folder-key';
import type { GitInterrogation } from './git-info';
import { isAncestorOf } from './owning-session';
import type { RepoRead } from './project-info';
import type { RepoSnapshot } from './protocol';
import { repoGitFingerprint } from './repo-git';
import { type DirtyKind, RepoPathMap } from './repo-path-map';
import {
  createRefreshScheduler,
  type MarkOptions,
  type PendingKinds,
} from './repo-refresh-scheduler';
import type { RepoInfo, RepoTag } from './repo-scan';
import type { GitInfo } from './types';

// Host-wide repo tracker core: every rule below is specified in
// docs/plans/2026-10-16-multi-repo-tracking.plan.md (Contracts, repo-tracker).

export const FOCUS_STALE_MS = 30_000;
/** Behind first fill and live edits. */
export const FOCUS_PRIORITY = 1000;

export interface TrackerUpdate {
  key: string;
  root: string;
  /** Every session containing the repo, visible or not. */
  sessions: readonly string[];
  /** Present when the run produced one. */
  snapshot?: RepoSnapshot;
  /** Present when info changed (meta run, or dirty flipped). */
  git?: GitInfo;
}

export interface RepoTrackerDeps {
  readChanges(root: string, opts: { lines: boolean }): Promise<RepoRead>;
  /** The host passes {skipDirty:true}. */
  interrogate(root: string): Promise<GitInterrogation>;
  isSessionVisible(sessionId: string): boolean;
  wantsLines(sessionId: string): boolean;
  /** Watch a common git dir recursively; it self-re-arms (watchDirWhilePresent). onPath gets
   *  folderKey'd, already-filtered abs paths; onLost fires on any no-filename event (overflow, or
   *  recovery after a missing phase). */
  watchGitDir(
    commonDir: string,
    onPath: (absKey: string) => void,
    onLost: () => void,
  ): { close(): void };
  /** First-fill rank; 0 on failure. */
  indexMtime(root: string): Promise<number>;
  publish(update: TrackerUpdate): void;
  removed(key: string, root: string, sessions: readonly string[]): void;
  log(level: 'debug' | 'warn', msg: string, data?: Record<string, unknown>): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface RepoTracker {
  setSessionRepos(sessionId: string, repos: readonly RepoInfo[]): void;
  dropSession(sessionId: string): void;
  onWatchedPath(absKey: string): void;
  /** A working-tree watch reported possible event loss for these folders. */
  lostFolders(folders: readonly string[]): void;
  /** Roots of the ProjectWatcher's LIVE recursive watches (not the requested set). */
  setLiveRoots(roots: readonly string[]): void;
  visibilityChanged(): void;
  linesDemandChanged(): void;
  /** Window focus: the recovery sweep for anything the watches missed. */
  windowFocused(): void;
  /** Explicit Retry (repo:refresh). Root must already be registered (else no-op). */
  refreshNow(root: string): void;
  /** Keyed by RepoInfo.root. */
  snapshotsFor(sessionId: string): Record<string, RepoSnapshot>;
  stop(): void;
}

interface Repo {
  key: string;
  root: string;
  sessions: Set<string>;
  gitDir?: string;
  commonDir?: string;
  branch?: string;
  info?: GitInfo;
  snapshot?: RepoSnapshot;
  lastRefreshAt?: number;
  covered: boolean;
  /** Mirrors the scheduler's pending kinds: set by a mark, cleared when a run takes them. */
  pending: boolean;
  /** The `lines` of the read in flight; undefined while none is. */
  readingLines?: boolean;
  /** The last interrogation got no answer from git: the next mark of any kind re-runs it. */
  metaOwed?: boolean;
  /** A failed lines read already re-marked once; cleared by the next good read. */
  linesRetried?: boolean;
}

const FIRST_FILL_TAGS: ReadonlySet<RepoTag> = new Set(['home', 'attached']);

/** GitInfo with today's dirty semantics: only a born branch or a detached HEAD carries it. */
function withDirty(info: GitInfo, dirty: boolean): GitInfo {
  if (info.kind === 'bare' || info.kind === 'none' || info.unborn) return info;
  return { ...info, dirty };
}

export function createRepoTracker(deps: RepoTrackerDeps): RepoTracker {
  const repos = new Map<string, Repo>();
  const sessionRepos = new Map<string, readonly RepoInfo[]>();
  const ownWatches = new Map<string, { close(): void }>();
  let liveRoots: string[] = [];
  let pathMap = new RepoPathMap([]);
  let stopped = false;

  const scheduler = createRefreshScheduler({
    run: (key, kinds) => runJob(key, kinds),
    eligible: (key) => {
      const repo = repos.get(key);
      return !!repo && [...repo.sessions].some((s) => deps.isSessionVisible(s));
    },
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });

  const mark = (repo: Repo, kinds: readonly DirtyKind[], opts?: MarkOptions) => {
    if (stopped) return;
    repo.pending = true;
    for (const kind of kinds) scheduler.mark(repo.key, kind, opts);
    if (repo.metaOwed && !kinds.includes('meta')) scheduler.mark(repo.key, 'meta', opts);
  };

  const isCovered = (key: string) => liveRoots.some((r) => isAncestorOf(r, key));

  const rebuildPathMap = () => {
    pathMap = new RepoPathMap(
      [...repos.values()].map((r) => ({
        key: r.key,
        root: r.root,
        gitDir: r.gitDir,
        commonDir: r.commonDir,
        branch: r.branch,
      })),
    );
  };

  const onLostCommonDir = (commonDir: string) => {
    for (const repo of repos.values())
      if (repo.commonDir === commonDir) mark(repo, ['tree', 'meta']);
  };

  // A covered common dir's events already arrive through the working-tree watch.
  const reconcileWatches = () => {
    const wanted = new Set<string>();
    if (!stopped)
      for (const repo of repos.values())
        if (repo.commonDir && !isCovered(repo.commonDir)) wanted.add(repo.commonDir);
    for (const [dir, w] of ownWatches) {
      if (wanted.has(dir)) continue;
      w.close();
      ownWatches.delete(dir);
    }
    for (const dir of wanted) {
      if (ownWatches.has(dir)) continue;
      ownWatches.set(
        dir,
        deps.watchGitDir(dir, onWatchedPath, () => onLostCommonDir(dir)),
      );
    }
  };

  const snapshotOf = (repo: Repo): RepoSnapshot | undefined =>
    repo.snapshot && (repo.pending ? { ...repo.snapshot, stale: true } : repo.snapshot);

  const wantsLinesFor = (repo: Repo) => [...repo.sessions].some((s) => deps.wantsLines(s));

  async function runJob(key: string, kinds: PendingKinds): Promise<void> {
    const repo = repos.get(key);
    if (!repo) return;
    repo.pending = false;
    try {
      let info = repo.info;
      if (kinds.meta) {
        const it = await deps.interrogate(repo.root);
        if (repos.get(key) !== repo || stopped) return;
        repo.metaOwed = it.failure !== undefined;
        // Wiping the dirs on a timeout would unmap the git dir and close its watch (spec §3 Errors).
        if (it.failure)
          deps.log('warn', '[repo-tracker] interrogation failed; last good kept', {
            root: repo.root,
            failure: it.failure,
          });
        else {
          repo.gitDir = it.gitDir === undefined ? undefined : folderKey(it.gitDir);
          repo.commonDir = it.commonDir === undefined ? undefined : folderKey(it.commonDir);
          repo.branch = it.info.kind === 'branch' ? it.info.branch : undefined;
          info = repo.info?.dirty === undefined ? it.info : withDirty(it.info, repo.info.dirty);
          rebuildPathMap();
          reconcileWatches();
        }
      }
      const lines = wantsLinesFor(repo);
      repo.readingLines = lines;
      const read = await deps.readChanges(repo.root, { lines }).finally(() => {
        repo.readingLines = undefined;
      });
      if (repos.get(key) !== repo || stopped) return;
      if (read.ok) {
        repo.linesRetried = false;
        repo.lastRefreshAt = deps.now();
        repo.snapshot = {
          changes: read.changes,
          lines,
          refreshedAt: repo.lastRefreshAt,
        };
        if (info) info = withDirty(info, read.trackedDirty);
      } else {
        repo.snapshot = {
          ...(repo.snapshot ?? { changes: [], lines: false, refreshedAt: 0 }),
          error: read.reason,
        };
      }
      const gitChanged = !!info && repoGitFingerprint(info) !== repoGitFingerprint(repo.info);
      repo.info = info;
      deps.publish({
        key,
        root: repo.root,
        sessions: [...repo.sessions],
        snapshot: repo.snapshot,
        ...(info && gitChanged ? { git: info } : {}),
      });
      // The failed read may have absorbed a demand rise, which would leave "Counting lines…" up
      // until some unrelated fire; once only, so a repo that keeps failing doesn't spin.
      if (!read.ok && lines && !repo.snapshot.lines && !repo.linesRetried) {
        repo.linesRetried = true;
        mark(repo, ['tree']);
      }
    } catch (error) {
      deps.log('warn', '[repo-tracker] refresh failed', { root: repo.root, error: String(error) });
    }
  }

  const removeRepo = (repo: Repo, droppedBy: readonly string[]) => {
    scheduler.forget(repo.key);
    repos.delete(repo.key);
    deps.removed(repo.key, repo.root, droppedBy);
  };

  const firstFill = (added: ReadonlyArray<{ repo: Repo; info: RepoInfo }>) => {
    const nested: Array<{ repo: Repo; info: RepoInfo }> = [];
    for (const a of added) {
      if (FIRST_FILL_TAGS.has(a.info.tag))
        mark(a.repo, ['meta', 'tree'], { immediate: true, priority: 0 });
      else nested.push(a);
    }
    if (nested.length === 0) return;
    void Promise.all(nested.map((n) => deps.indexMtime(n.repo.root))).then((mtimes) => {
      const ranked = nested
        .map((n, i) => ({ ...n, mtime: mtimes[i] }))
        .sort((a, b) => b.mtime - a.mtime || a.info.name.localeCompare(b.info.name));
      ranked.forEach(({ repo }, i) => {
        if (repos.get(repo.key) === repo)
          mark(repo, ['meta', 'tree'], { immediate: true, priority: i + 1 });
      });
    });
  };

  function onWatchedPath(absKey: string): void {
    if (stopped) return;
    for (const hit of pathMap.classify(absKey)) {
      const repo = repos.get(hit.key);
      if (repo) mark(repo, [hit.kind]);
    }
  }

  const setSessionRepos = (sessionId: string, next: readonly RepoInfo[]) => {
    if (stopped) return;
    const prevKeys = new Set((sessionRepos.get(sessionId) ?? []).map((r) => folderKey(r.root)));
    const nextKeys = new Set(next.map((r) => folderKey(r.root)));
    if (next.length > 0) sessionRepos.set(sessionId, next);
    else sessionRepos.delete(sessionId);
    const added: Array<{ repo: Repo; info: RepoInfo }> = [];
    const joined: Repo[] = [];
    for (const ri of next) {
      const key = folderKey(ri.root);
      const existing = repos.get(key);
      if (existing) {
        if (!existing.sessions.has(sessionId)) {
          existing.sessions.add(sessionId);
          joined.push(existing);
        }
        continue;
      }
      const repo: Repo = {
        key,
        root: ri.root,
        sessions: new Set([sessionId]),
        covered: isCovered(key),
        pending: false,
      };
      repos.set(key, repo);
      added.push({ repo, info: ri });
    }
    let removedAny = false;
    for (const key of prevKeys) {
      if (nextKeys.has(key)) continue;
      const repo = repos.get(key);
      if (!repo) continue;
      repo.sessions.delete(sessionId);
      if (repo.sessions.size === 0) {
        removeRepo(repo, [sessionId]);
        removedAny = true;
      }
    }
    if (added.length > 0 || removedAny) {
      rebuildPathMap();
      reconcileWatches();
    }
    // A session joining an already-read repo would otherwise wait for its next run.
    for (const repo of joined) {
      const snapshot = snapshotOf(repo);
      if (!snapshot && !repo.info) continue;
      deps.publish({
        key: repo.key,
        root: repo.root,
        sessions: [...repo.sessions],
        ...(snapshot ? { snapshot } : {}),
        ...(repo.info ? { git: repo.info } : {}),
      });
    }
    firstFill(added);
  };

  return {
    setSessionRepos,
    dropSession(sessionId) {
      setSessionRepos(sessionId, []);
    },
    onWatchedPath,
    lostFolders(folders) {
      const keys = folders.map(folderKey);
      for (const repo of repos.values()) {
        const hit = keys.some(
          (f) => isAncestorOf(f, repo.key) || (!!repo.commonDir && isAncestorOf(f, repo.commonDir)),
        );
        if (hit) mark(repo, ['tree', 'meta']);
      }
    },
    setLiveRoots(roots) {
      if (stopped) return;
      liveRoots = roots.map(folderKey);
      for (const repo of repos.values()) {
        const covered = isCovered(repo.key);
        // Edits made while nothing watched the tree are caught up once; losing coverage may
        // have dropped events, including a checkout.
        if (covered && !repo.covered) mark(repo, ['tree']);
        else if (!covered && repo.covered) mark(repo, ['tree', 'meta']);
        repo.covered = covered;
      }
      reconcileWatches();
    },
    visibilityChanged() {
      scheduler.reconsider();
    },
    linesDemandChanged() {
      for (const repo of repos.values()) {
        const hasLines = repo.readingLines ?? repo.snapshot?.lines === true;
        if (!hasLines && wantsLinesFor(repo)) mark(repo, ['tree'], { immediate: true });
      }
    },
    windowFocused() {
      const now = deps.now();
      for (const repo of repos.values()) {
        if (![...repo.sessions].some((s) => deps.isSessionVisible(s))) continue;
        if (repo.commonDir === undefined) mark(repo, ['meta', 'tree'], { immediate: true });
        else if (repo.lastRefreshAt === undefined || now - repo.lastRefreshAt > FOCUS_STALE_MS)
          mark(repo, ['tree'], { priority: FOCUS_PRIORITY });
      }
    },
    refreshNow(root) {
      const repo = repos.get(folderKey(root));
      if (repo) mark(repo, ['meta', 'tree'], { immediate: true });
    },
    snapshotsFor(sessionId) {
      const out: Record<string, RepoSnapshot> = {};
      for (const ri of sessionRepos.get(sessionId) ?? []) {
        const repo = repos.get(folderKey(ri.root));
        const snapshot = repo && snapshotOf(repo);
        if (snapshot) out[ri.root] = snapshot;
      }
      return out;
    },
    stop() {
      stopped = true;
      scheduler.stop();
      reconcileWatches();
    },
  };
}
