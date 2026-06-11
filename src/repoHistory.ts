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
