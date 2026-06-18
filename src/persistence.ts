import type { Session } from './types';

const VERSION = 1;

export function serializeSessions(sessions: Session[]): string {
  // `git` is runtime-derived (host re-interrogates on every cwd change); persisting it
  // would write a stale branch/dirty snapshot that lies until the first refresh. Strip it.
  const persisted = sessions.map(({ git: _git, ...rest }) => rest);
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
