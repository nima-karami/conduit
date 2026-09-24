import { folderKey } from '../src/folder-key';
import { plural } from '../src/plural';
import type { ChangeDTO, RepoChanges } from '../src/protocol';
import { repoBaseName, repoLabel } from '../src/repo-display';
import type { RepoInfo, RepoTag } from '../src/repo-scan';
import type { ReviewSource } from './docs';
import { joinPath } from './file-tree';
import { inScope, type ReviewScope } from './review-scope';

/**
 * Review's own notes artifact, hidden from Review's own change list (spec §2 Lane F). `.conduit/`
 * is gitignored in Conduit itself but not necessarily in the repo being reviewed, so without this
 * a note makes review-notes.json appear as a change inside the very review that produced it — and
 * grow with every note. The Changes panel still lists it: it is a real file the user may want to
 * commit or gitignore, and that decision belongs there, not here.
 */
const NOTES_ARTIFACT_PATH = '.conduit/review-notes.json';
export type ReviewFile = ChangeDTO & { repoRoot: string };

export function reviewFileKey(f: Pick<ReviewFile, 'repoRoot' | 'path'>): string {
  return joinPath(f.repoRoot, f.path);
}

export function cardDomKey(root: string, path: string): string {
  return `${folderKey(root)}\0${path}`;
}

export function findRepo<T extends { root: string }>(
  repos: readonly T[],
  root: string,
): T | undefined {
  const key = folderKey(root);
  return repos.find((r) => folderKey(r.root) === key);
}

/** Spec 2026-09-23-mf-review §2.1: a commit/range root is honoured even outside reviewRepos. */
export function resolveReviewRepo(
  source: ReviewSource | undefined,
  reviewRepos: readonly { root: string }[],
  fallbackRoot: string | undefined,
): string | null {
  if (source && source.kind !== 'working') return source.repoRoot ?? fallbackRoot ?? null;
  const matched =
    source?.repoRoot === undefined ? undefined : findRepo(reviewRepos, source.repoRoot);
  if (matched) return matched.root;
  return reviewRepos.length >= 2 ? null : (reviewRepos[0]?.root ?? fallbackRoot ?? null);
}

/** The spec §4 "repo leaves" trigger. */
export function isStaleWorkingRoot(
  source: ReviewSource | undefined,
  reviewRepos: readonly { root: string }[],
): boolean {
  return (
    source?.kind === 'working' &&
    source.repoRoot !== undefined &&
    !findRepo(reviewRepos, source.repoRoot)
  );
}

export function reviewViewKey(sourceKey: string, resolvedRoot: string | null): string {
  return `${sourceKey}\0${resolvedRoot ?? '*'}`;
}

function dedupeReviewPaths<T extends { path: string }>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of files) {
    if (f.path === NOTES_ARTIFACT_PATH || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

export function workingReviewFiles(
  repos: readonly RepoChanges[],
  root: string | null,
): ReviewFile[] {
  const picked = root === null ? repos : [findRepo(repos, root)].filter((r) => r !== undefined);
  return picked.flatMap((r) => tagReviewFiles(r.changes, r.root));
}

export function tagReviewFiles<T extends { path: string }>(
  files: readonly T[],
  root: string,
): (T & { repoRoot: string })[] {
  return dedupeReviewPaths(files).map((f) => ({ ...f, repoRoot: root }));
}

export interface ReviewGroup {
  root: string;
  name: string;
  tag: RepoTag;
  sub?: string;
  branch?: string;
  files: ReviewFile[];
  reviewed: number;
}

export function groupReviewFiles(
  files: readonly ReviewFile[],
  repos: readonly RepoChanges[],
  reviewed: ReadonlySet<string>,
): ReviewGroup[] {
  const groups: ReviewGroup[] = [];
  for (const r of repos) {
    const key = folderKey(r.root);
    const own = files.filter((f) => folderKey(f.repoRoot) === key);
    if (own.length === 0) continue;
    groups.push({
      root: r.root,
      name: r.name,
      tag: r.tag,
      ...(r.sub === undefined ? {} : { sub: r.sub }),
      ...(r.branch === undefined ? {} : { branch: r.branch }),
      files: own,
      reviewed: own.filter((f) => reviewed.has(reviewFileKey(f))).length,
    });
  }
  return groups;
}

/** Every repo with a change on that git side, over raw `repoChanges` — never the listed groups,
 *  which scope and file filter narrow. Review's Stage all and the navigator's kebab share it. */
export function rootsWithSide(repoChanges: readonly RepoChanges[], staged: boolean): string[] {
  return repoChanges.filter((r) => r.changes.some((c) => c.staged === staged)).map((r) => r.root);
}

/** undefined = repo changes have not arrived yet, distinct from [] (nothing to review). */
export function reviewRepoChangesFor(
  repos: readonly RepoInfo[] | undefined,
  repoChanges: readonly RepoChanges[] | undefined,
  changes: readonly ChangeDTO[],
  fallbackRoot: string | undefined,
): RepoChanges[] | undefined {
  if (repos && repos.length > 0) return repoChanges && [...repoChanges];
  if (fallbackRoot === undefined) return [];
  return [
    { root: fallbackRoot, name: repoBaseName(fallbackRoot), tag: 'home', changes: [...changes] },
  ];
}

export interface RepoChipRow {
  root: string | null;
  label: string;
  checked: boolean;
  hint?: string;
}

// Scope-filter BEFORE deduping: git status emits a `MM` path's staged entry first, so deduping
// first would hide the path from the Unstaged count.
function chipHint(changes: readonly ChangeDTO[] | undefined, scope: ReviewScope): string {
  if (changes === undefined) return '…';
  const n = dedupeReviewPaths(changes.filter((c) => inScope(c, scope))).length;
  return n > 0 ? plural(n, 'file') : 'clean';
}

export function repoChipRows(
  reviewRepos: readonly RepoInfo[],
  repoChanges: readonly RepoChanges[] | undefined,
  resolved: string | null,
  scope: ReviewScope,
): RepoChipRow[] {
  const resolvedKey = resolved === null ? null : folderKey(resolved);
  return [
    { root: null, label: 'All repos', checked: resolved === null },
    ...reviewRepos.map((repo) => ({
      root: repo.root,
      label: repoLabel(repo, reviewRepos),
      checked: folderKey(repo.root) === resolvedKey,
      hint: chipHint(
        repoChanges === undefined ? undefined : (findRepo(repoChanges, repo.root)?.changes ?? []),
        scope,
      ),
    })),
  ];
}

export function repoChipLabel(reviewRepos: readonly RepoInfo[], resolved: string | null): string {
  if (resolved === null) return 'All repos';
  const repo = findRepo(reviewRepos, resolved);
  return repo ? repoLabel(repo, reviewRepos) : repoBaseName(resolved);
}

export function repoDisplayPath(r: Pick<RepoChanges, 'root' | 'sub'>): string {
  return r.sub ?? r.root;
}

/** The root a git request from Review names: one the source carries, else the resolved review
 *  repo — for an unstamped commit/range that is `fallbackRoot`. With no detected repo nothing is
 *  sent: the host reads an unrooted request against the session's git root, and it would reject a
 *  cwd that is not a repo top-level. */
export function reviewRequestRoot(
  source: ReviewSource | undefined,
  reviewRepos: readonly { root: string }[],
  fallbackRoot: string | undefined,
): string | undefined {
  if (source && source.kind !== 'working' && source.repoRoot !== undefined) return source.repoRoot;
  if (reviewRepos.length === 0) return undefined;
  return resolveReviewRepo(source, reviewRepos, fallbackRoot) ?? undefined;
}
