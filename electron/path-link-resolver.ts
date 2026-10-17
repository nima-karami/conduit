/**
 * Host shell around the pure terminal path resolver (src/path-resolve.ts): validates the
 * renderer's tokens, derives the session's roots per request, gathers the file indexes and bounds
 * every stat. No `electron` import, so it is unit-tested with fakes. See plan
 * 2026-10-16-terminal-path-links Contracts "electron/path-link-resolver.ts".
 */
import { activeCwd } from '../src/active-cwd';
import { folderKey } from '../src/folder-key';
import { buildResolveRoots, type ResolveRoot, rootsSigOf } from '../src/path-link-roots';
import {
  type IndexedFile,
  MAX_ALTS,
  type ResolveIndex,
  resolveTokens,
  type TokenResolution,
} from '../src/path-resolve';
import { isUncLike, type PathPlatform } from '../src/path-token-normalize';
import type { Session } from '../src/types';

export interface PathLinkResolverDeps {
  getSession(id: string): Session | undefined;
  /** The git toplevel of the session's live cwd, or that cwd when it is in no repo. */
  gitRoot(session: Session): Promise<string>;
  /** projectFileIndexMeta(root).files plus the roots it lists completely (meta.covered). */
  fileIndex(root: string): Promise<{ files: IndexedFile[]; coveredRoots: string[] }>;
  /** fs.promises.stat → kind; null on a miss. The shell races UNC paths against the budget. */
  stat(abs: string): Promise<'file' | 'dir' | null>;
  /** repoTopLevel. */
  topLevel(dir: string): Promise<string>;
  homeDir: string;
  platform: PathPlatform;
  caseSensitive: boolean;
  log: { warn(scope: string, msg: string, data?: Record<string, unknown>): void };
}

export interface PathLinkReply {
  /** The live cwd this reply resolved against (forward-slashed); the renderer's store scope. */
  cwd: string;
  rootsSig: string;
  roots: ResolveRoot[];
  results: TokenResolution[];
}

export interface PathLinkResolver {
  /** Never rejects on bad input: an unknown session gives one 'session-gone' result per entry. */
  resolve(sessionId: string, tokens: unknown): Promise<PathLinkReply>;
  /** Click-time existence probe behind `pathExists`; a UNC-like path counts as null past the
   *  budget. */
  probe(abs: string): Promise<'file' | 'dir' | null>;
}

export const STAT_CONCURRENCY = 16;
/** Resolves running at once; the rest queue. A burst of 50 left the main thread no gap for a
 *  readFile round trip (review r1 PERF: p95 38 ms idle vs 1,073 ms under the burst). */
export const RESOLVE_CONCURRENCY = 2;
export const MAX_TOKENS = 10;
export const UNC_PROBE_BUDGET_MS = 500;
// Mirrors MAX_TOKEN_LENGTH in webview/terminal-links.ts; the renderer is never trusted for it.
const MAX_ALT_LENGTH = 1024;

const slash = (p: string) => p.replace(/\\/g, '/');

type Entry = { kind: 'valid'; key: string; alts: string[] } | { kind: 'invalid'; key: string };

/** Per-token validation at the renderer→host trust boundary (plan Decisions, blocker 3). */
function validate(tokens: unknown): Entry[] {
  if (!Array.isArray(tokens)) return [];
  return tokens.slice(0, MAX_TOKENS).map((t): Entry => {
    const alts: unknown =
      typeof t === 'object' && t !== null ? (t as { alts?: unknown }).alts : undefined;
    if (!Array.isArray(alts) || alts.length === 0 || !alts.every((a) => typeof a === 'string')) {
      return { kind: 'invalid', key: '' };
    }
    const key = alts.join('\0');
    const kept = alts.slice(0, MAX_ALTS).filter((a) => a.length > 0 && a.length <= MAX_ALT_LENGTH);
    return kept.length > 0 ? { kind: 'valid', key, alts: kept } : { kind: 'invalid', key };
  });
}

const empty = (key: string, error: TokenResolution['error']): TokenResolution => ({
  key,
  candidates: [],
  truncated: false,
  total: 0,
  error,
});

/** One limiter per resolve call: every stat of the call shares its slots. */
function withConcurrency(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** Each call waits for the previous one, then for a setImmediate: chained, so every turn lands in
 *  its own event-loop iteration and pending I/O callbacks run between them. */
function turnTaker(): () => Promise<void> {
  let tail = Promise.resolve();
  return () => {
    tail = tail.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
    return tail;
  };
}

/** An offline share must delay only its own token: a UNC stat past the budget is a miss. */
function raceUnc(abs: string, stat: PathLinkResolverDeps['stat']): Promise<'file' | 'dir' | null> {
  if (!isUncLike(abs)) return stat(abs);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), UNC_PROBE_BUDGET_MS);
    stat(abs).then(
      (kind) => {
        clearTimeout(timer);
        resolve(kind);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function createPathLinkResolver(deps: PathLinkResolverDeps): PathLinkResolver {
  const opts = { platform: deps.platform, caseSensitive: deps.caseSensitive };
  const key = (p: string) => (deps.caseSensitive ? folderKey(p) : folderKey(p).toLowerCase());

  const indexesFor = async (roots: ResolveRoot[], cwdRoot: string): Promise<ResolveIndex[]> => {
    // Nested repos are never indexed one by one: the cwd root's composite index covers them.
    const wanted = [cwdRoot, ...roots.filter((r) => r.kind === 'attached').map((r) => r.abs)];
    const unique = [...new Map(wanted.map((r) => [key(r), r])).values()];
    const rootIdxByKey = new Map(roots.map((r, i) => [key(r.abs), i]));
    const built = await Promise.all(
      unique.map((root) =>
        deps.fileIndex(root).then(
          (ix): ResolveIndex => ({
            root,
            files: ix.files,
            coveredRootIdx: ix.coveredRoots
              .map((c) => rootIdxByKey.get(key(c)))
              .filter((i): i is number => i !== undefined),
          }),
          (error: unknown) => {
            // A failed index degrades this root to stat-only resolution (no suffix search).
            deps.log.warn('links', 'index-failed', { root, error: String(error) });
            return null;
          },
        ),
      ),
    );
    return built.filter((ix): ix is ResolveIndex => ix !== null);
  };

  const resolveSlot = withConcurrency(RESOLVE_CONCURRENCY);

  const resolveNow = async (sessionId: string, tokens: unknown): Promise<PathLinkReply> => {
    const entries = validate(tokens);
    const session = deps.getSession(sessionId);
    if (!session) {
      return {
        cwd: '',
        rootsSig: '',
        roots: [],
        results: entries.map((e) => empty(e.key, 'session-gone')),
      };
    }
    const cwd = slash(activeCwd(session));
    const cwdGitRoot = slash(await deps.gitRoot(session).catch(() => cwd));
    const roots = buildResolveRoots(session, cwdGitRoot, opts);
    const rootsSig = rootsSigOf(session);
    const valid = entries.filter((e): e is Extract<Entry, { kind: 'valid' }> => e.kind === 'valid');
    const indexes = valid.length > 0 ? await indexesFor(roots, cwdGitRoot || cwd) : [];
    const limit = withConcurrency(STAT_CONCURRENCY);
    const knownRepoKeys = new Set([
      ...(session.repos ?? []).map((r) => key(r.root)),
      ...(cwdGitRoot !== cwd ? [key(cwdGitRoot)] : []),
    ]);
    const resolved = await resolveTokens(
      valid.map((e) => ({ alts: e.alts })),
      {
        cwd,
        cwdGitRoot,
        roots,
        indexes,
        caseSensitive: deps.caseSensitive,
        homeDir: deps.homeDir,
        platform: deps.platform,
      },
      {
        stat: (abs) => limit(() => raceUnc(abs, deps.stat)),
        yieldTurn: turnTaker(),
        // A repo the session's scan registered, or the cwd's git root, is its own toplevel:
        // asking git once per root put 200 spawns on every 200-repo resolve (Slice 6 profile).
        topLevel: (dir) =>
          knownRepoKeys.has(key(dir)) ? Promise.resolve(dir) : deps.topLevel(dir),
      },
    );
    let next = 0;
    const results = entries.map((e) => {
      if (e.kind === 'invalid') return empty(e.key, 'invalid');
      // The trimmed alts resolved; the renderer's pending token is the original join.
      return { ...resolved[next++], key: e.key };
    });
    return { cwd, rootsSig, roots, results };
  };

  return {
    resolve: (sessionId, tokens) => resolveSlot(() => resolveNow(sessionId, tokens)),
    probe(abs) {
      return raceUnc(abs, deps.stat).catch(() => null);
    },
  };
}
