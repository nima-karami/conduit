import { folderKey } from './folder-key';
import type { PersistedDoc } from './protocol';
import type { Session } from './types';

const VERSION = 1;

export function serializeSessions(sessions: Session[]): string {
  // `git`, `lastLine`, `completedRun`, the repo-* fields and the missing-folder marks are
  // runtime-derived (the host re-interrogates/re-scans on every cwd change and re-checks folders
  // on restore, and the PTY tail dies with the process); persisting them would write a stale
  // snapshot that lies until the first refresh. Strip them all.
  const persisted = sessions.map(
    ({
      git: _git,
      repos: _repos,
      activeRepoRoot: _activeRepoRoot,
      repoPinned: _repoPinned,
      pinnedRepoRoot: _pinnedRepoRoot,
      autoRepoRoot: _autoRepoRoot,
      lastLine: _lastLine,
      completedRun: _completedRun,
      missingRoots: _missingRoots,
      homeMissing: _homeMissing,
      ...rest
    }) => ({ ...rest, projectPath: rest.home }), // downgrade mirror; see mf-model spec §2.3
  );
  return JSON.stringify({ version: VERSION, sessions: persisted });
}

export type SessionsParse =
  | { kind: 'empty' }
  | { kind: 'ok'; sessions: Session[]; legacyIds: string[]; dropped: number };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

function coerceRoots(raw: unknown, home: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set([folderKey(home)]);
  const roots: string[] = [];
  for (const r of raw) {
    if (!nonEmpty(r) || seen.has(folderKey(r))) continue;
    seen.add(folderKey(r));
    roots.push(r);
  }
  return roots;
}

/** See mf-model spec §2.3 "Parse (sessions)". A legacy entry is one without a `home`. */
export function parseSessions(blob: string | undefined): SessionsParse {
  if (!blob) return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { kind: 'empty' };
  }
  const { version, sessions: entries } = (parsed ?? {}) as {
    version?: unknown;
    sessions?: unknown;
  };
  if (version !== VERSION || !Array.isArray(entries)) return { kind: 'empty' };

  const sessions: Session[] = [];
  const legacyIds: string[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      dropped++;
      continue;
    }
    const {
      home: rawHome,
      projectPath,
      roots,
      projectId,
      ...rest
    } = entry as Record<string, unknown>;
    const legacy = !nonEmpty(rawHome);
    const home = legacy ? projectPath : rawHome;
    if (!nonEmpty(home)) {
      dropped++;
      continue;
    }
    const s = rest as Omit<Session, 'home' | 'roots' | 'projectId'>;
    // Back-compat: blobs written before lastActiveAt/createdAt existed.
    const createdAt = s.createdAt ?? Date.now();
    sessions.push({
      ...s,
      home,
      roots: coerceRoots(roots, home),
      ...(typeof projectId === 'string' ? { projectId } : {}),
      status: 'stale',
      createdAt,
      lastActiveAt: s.lastActiveAt ?? createdAt,
    });
    if (legacy) legacyIds.push(s.id);
  }
  return { kind: 'ok', sessions, legacyIds, dropped };
}

// When "reopen previous sessions" is off the host must never overwrite sessions.json: the next
// persist/quit would serialize the (empty, unrestored) live model over the saved set, so toggling
// restore back on would bring back nothing. Gate every sessions.json write on this instead —
// leave the last restore-on snapshot untouched. Tradeoff: session activity during a restore-off
// run isn't tracked to disk (by design — restore off means "don't manage my session set").
export function shouldPersistSessions(settings: { restoreSessions: boolean }): boolean {
  return settings.restoreSessions;
}

// Editor tabs persist to a SIBLING docs.json (not inside sessions.json) so a corrupt tab blob
// can never break session restore (ADR-style isolation; spec §3.2 D3). Versioned: an absent or
// older blob parses to [] ⇒ "no tabs", exactly like restoreSessions degrades.
const DOCS_VERSION = 1;

export function serializeDocs(docs: PersistedDoc[]): string {
  return JSON.stringify({ version: DOCS_VERSION, docs });
}

// A present-but-unknown diffScope drops the entry rather than widening it to unscoped, which
// would show different content under the same title (spec 2026-09-22-scoped-diff-tabs §3).
function isRestorableDoc(d: unknown): d is PersistedDoc {
  if (!d || typeof d !== 'object') return false;
  const { kind, path, sessionId, diffScope } = d as PersistedDoc;
  if (kind !== 'file' && kind !== 'diff') return false;
  if (typeof path !== 'string' || typeof sessionId !== 'string') return false;
  return (
    diffScope === undefined ||
    (kind === 'diff' && (diffScope === 'staged' || diffScope === 'unstaged'))
  );
}

export function parseDocs(blob: string | undefined): PersistedDoc[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (!parsed || parsed.version !== DOCS_VERSION || !Array.isArray(parsed.docs)) return [];
    return parsed.docs.filter(isRestorableDoc);
  } catch {
    return [];
  }
}
