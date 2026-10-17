import { folderKey } from './folder-key';
import type { GitFailure } from './git-exec';
import type { ChangeDTO, HostToWebview, RepoChanges, RepoSnapshot } from './protocol';
import { orderRepos, repoBaseName, repoLabel, repoSub } from './repo-display';
import type { RepoInfo } from './repo-scan';
import type { ChangesViewMode } from './settings';
import type { Session } from './types';

export type SessionSnapshots = Readonly<Record<string, Readonly<Record<string, RepoSnapshot>>>>;

export function applyRepoDelta(
  prev: SessionSnapshots,
  msg: Extract<HostToWebview, { type: 'repoDelta' }>,
  visibleIds: readonly string[],
): SessionSnapshots {
  const base = msg.full ? {} : (prev[msg.sessionId] ?? {});
  const merged: Record<string, RepoSnapshot> = { ...base };
  for (const [root, entry] of Object.entries(msg.repos)) {
    if ('removed' in entry) delete merged[root];
    else merged[root] = entry;
  }
  const out: Record<string, Readonly<Record<string, RepoSnapshot>>> = {};
  for (const id of visibleIds) {
    const snaps = id === msg.sessionId ? merged : prev[id];
    if (snaps !== undefined) out[id] = snaps;
  }
  return out;
}

/** undefined while repos are undefined (detecting); a repo without a snapshot is omitted so the
 *  view reads it as loading. */
export function repoChangesOf(
  repos: readonly RepoInfo[] | undefined,
  snaps: Readonly<Record<string, RepoSnapshot>> | undefined,
): RepoChanges[] | undefined {
  if (repos === undefined) return undefined;
  const byKey = new Map(Object.entries(snaps ?? {}).map(([root, snap]) => [folderKey(root), snap]));
  return repos.flatMap((repo) => {
    const snap = snaps?.[repo.root] ?? byKey.get(folderKey(repo.root));
    if (snap === undefined) return [];
    const sub = repoSub(repo);
    return [
      {
        root: repo.root,
        name: repoBaseName(repo.root),
        tag: repo.tag,
        ...(sub === undefined ? {} : { sub }),
        changes: snap.changes,
        lines: snap.lines,
        refreshedAt: snap.refreshedAt,
        ...(snap.stale ? { stale: snap.stale } : {}),
        ...(snap.error ? { error: snap.error } : {}),
      },
    ];
  });
}

export interface RepoHeadModel {
  repo: RepoInfo;
  label: string;
  sub?: string;
  /** undefined = this repo's first result is not in yet. */
  changes: ChangeDTO[] | undefined;
  staged: ChangeDTO[];
  unstaged: ChangeDTO[];
  lines: boolean;
  refreshedAt?: number;
  stale?: true;
  error?: GitFailure;
}

export type ChangesModel =
  | { kind: 'no-session' }
  | { kind: 'detecting' }
  | { kind: 'no-repos' }
  | {
      kind: 'ready';
      view: ChangesViewMode;
      /** all: every repo, display order; active: exactly the active repo. */
      heads: RepoHeadModel[];
      repos: RepoInfo[];
      activeRoot: string;
      pinned: boolean;
      /** Summed over heads whose changes are loaded. */
      count: number;
      added: number;
      removed: number;
      loading: boolean;
      /** Some loaded repo has not had its line counts read yet. */
      linesPending: boolean;
      allClean: boolean;
    };

export function changesModel(input: {
  session: Pick<Session, 'repos' | 'roots' | 'activeRepoRoot' | 'repoPinned'> | undefined;
  repoChanges: readonly RepoChanges[] | undefined;
  view: ChangesViewMode;
}): ChangesModel {
  const { session, repoChanges, view } = input;
  if (!session) return { kind: 'no-session' };
  if (session.repos === undefined) return { kind: 'detecting' };
  if (session.repos.length === 0) return { kind: 'no-repos' };
  const repos = orderRepos(session.repos, session.roots);
  const byKey = new Map((repoChanges ?? []).map((e) => [folderKey(e.root), e]));
  const activeKey = session.activeRepoRoot ? folderKey(session.activeRepoRoot) : undefined;
  const active = repos.find((r) => folderKey(r.root) === activeKey) ?? repos[0];
  const shown = view === 'all' ? repos : [active];
  const heads = shown.map((repo): RepoHeadModel => {
    const entry = byKey.get(folderKey(repo.root));
    // refreshedAt 0 = the first read failed: still loading, with the error shown beside it.
    const changes = entry && entry.refreshedAt > 0 ? entry.changes : undefined;
    const sub = repoSub(repo);
    return {
      repo,
      label: repoLabel(repo, repos),
      ...(sub === undefined ? {} : { sub }),
      changes,
      staged: (changes ?? []).filter((c) => c.staged),
      unstaged: (changes ?? []).filter((c) => !c.staged),
      lines: entry?.lines ?? false,
      ...(entry === undefined ? {} : { refreshedAt: entry.refreshedAt }),
      ...(entry?.stale ? { stale: entry.stale } : {}),
      ...(entry?.error ? { error: entry.error } : {}),
    };
  });
  const loaded = heads.flatMap((h) => h.changes ?? []);
  const loading = heads.some((h) => h.changes === undefined);
  return {
    kind: 'ready',
    view,
    heads,
    repos,
    activeRoot: active.root,
    pinned: session.repoPinned === true,
    count: loaded.length,
    added: loaded.reduce((a, c) => a + c.added, 0),
    removed: loaded.reduce((a, c) => a + c.removed, 0),
    loading,
    // Same rule as the Review nav: a clean repo has no counts to wait on.
    linesPending: heads.some((h) => !!h.changes?.length && !h.lines),
    allClean: !loading && loaded.length === 0,
  };
}
