import type { Session } from './types';

const VERSION = 1;

export function serializeSessions(sessions: Session[]): string {
  return JSON.stringify({ version: VERSION, sessions });
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
