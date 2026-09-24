import { folderKey } from './folder-key';
import type { ChangeDTO, RepoChanges } from './protocol';
import { orderRepos, repoLabel, repoSetKey, repoSub } from './repo-display';
import type { RepoInfo } from './repo-scan';
import type { ChangesViewMode } from './settings';
import type { Session } from './types';

/** A reply computed for a repo set the session has since left is dropped, not shown. */
export function acceptRepoChanges(
  prev: RepoChanges[] | undefined,
  incoming: RepoChanges[] | undefined,
  repos: readonly RepoInfo[] | undefined,
): RepoChanges[] | undefined {
  if (incoming === undefined || repos === undefined) return prev;
  return repoSetKey(incoming) === repoSetKey(repos) ? incoming : prev;
}

export interface RepoHeadModel {
  repo: RepoInfo;
  label: string;
  sub?: string;
  /** undefined = this repo's first result is not in yet. */
  changes: ChangeDTO[] | undefined;
  staged: ChangeDTO[];
  unstaged: ChangeDTO[];
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
  const byKey = new Map((repoChanges ?? []).map((e) => [folderKey(e.root), e.changes]));
  const activeKey = session.activeRepoRoot ? folderKey(session.activeRepoRoot) : undefined;
  const active = repos.find((r) => folderKey(r.root) === activeKey) ?? repos[0];
  const shown = view === 'all' ? repos : [active];
  const heads = shown.map((repo): RepoHeadModel => {
    const changes = byKey.get(folderKey(repo.root));
    const sub = repoSub(repo);
    return {
      repo,
      label: repoLabel(repo, repos),
      ...(sub === undefined ? {} : { sub }),
      changes,
      staged: (changes ?? []).filter((c) => c.staged),
      unstaged: (changes ?? []).filter((c) => !c.staged),
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
    allClean: !loading && loaded.length === 0,
  };
}
