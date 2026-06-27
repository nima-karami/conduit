import type { PersistedDoc } from './protocol';
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

// Editor tabs persist to a SIBLING docs.json (not inside sessions.json) so a corrupt tab blob
// can never break session restore (ADR-style isolation; spec §3.2 D3). Versioned: an absent or
// older blob parses to [] ⇒ "no tabs", exactly like restoreSessions degrades.
const DOCS_VERSION = 1;

export function serializeDocs(docs: PersistedDoc[]): string {
  return JSON.stringify({ version: DOCS_VERSION, docs });
}

export function parseDocs(blob: string | undefined): PersistedDoc[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (!parsed || parsed.version !== DOCS_VERSION || !Array.isArray(parsed.docs)) return [];
    return parsed.docs.filter(
      (d: unknown): d is PersistedDoc =>
        !!d &&
        typeof d === 'object' &&
        (d as PersistedDoc).kind === 'file' &&
        typeof (d as PersistedDoc).path === 'string' &&
        typeof (d as PersistedDoc).sessionId === 'string',
    );
  } catch {
    return [];
  }
}
