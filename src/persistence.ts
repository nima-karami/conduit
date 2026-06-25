import type { Session } from './types';

const VERSION = 1;

export function serializeSessions(sessions: Session[]): string {
  // `git` and the repo-* fields are runtime-derived (host re-interrogates/re-scans on every
  // cwd change); persisting them would write a stale snapshot that lies until the first
  // refresh. Strip them all.
  const persisted = sessions.map(
    ({
      git: _git,
      repos: _repos,
      activeRepoRoot: _activeRepoRoot,
      repoPinned: _repoPinned,
      pinnedRepoRoot: _pinnedRepoRoot,
      autoRepoRoot: _autoRepoRoot,
      ...rest
    }) => rest,
  );
  return JSON.stringify({ version: VERSION, sessions: persisted });
}

export function restoreSessions(blob: string | undefined): Session[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.map((s: Session) => {
      // Back-compat: blobs written before lastActiveAt/createdAt existed.
      const createdAt = s.createdAt ?? Date.now();
      return {
        ...s,
        status: 'stale' as const,
        createdAt,
        lastActiveAt: s.lastActiveAt ?? createdAt,
      };
    });
  } catch {
    return [];
  }
}
