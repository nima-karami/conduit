import type { RepoDTO } from './protocol';

const VERSION = 1;
const CAP = 20;

export function serializeRepos(list: RepoDTO[]): string {
  return JSON.stringify({ version: VERSION, repos: list });
}

export function restoreRepos(blob: string | undefined): RepoDTO[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (parsed && parsed.version === VERSION && Array.isArray(parsed.repos)) {
      return parsed.repos as RepoDTO[];
    }
  } catch {
    /* missing or malformed */
  }
  return [];
}

/** Move `entry` to the front (de-duped by path), capped to the most recent CAP. */
export function upsertRepo(list: RepoDTO[], entry: RepoDTO): RepoDTO[] {
  const rest = list.filter((r) => r.path !== entry.path);
  return [entry, ...rest].slice(0, CAP);
}

/**
 * Drop recent-folder entries whose path is no longer an existing directory. Pure over the
 * injected `existsDir` predicate so it's testable without the filesystem; the host passes a
 * real `statSync().isDirectory()` check. Non-destructive — the caller filters at display time
 * and never rewrites `repos.json`, so an unplugged/remounted drive or a recreated folder
 * reappears on its own.
 */
export function filterExistingRepos(list: RepoDTO[], existsDir: (p: string) => boolean): RepoDTO[] {
  return list.filter((r) => existsDir(r.path));
}
