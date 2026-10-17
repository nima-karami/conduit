/**
 * Host shell around the pure terminal path resolver (src/path-resolve.ts): validates the
 * renderer's tokens, derives the session's roots per request, gathers the file indexes and bounds
 * every stat. No `electron` import, so it is unit-tested with fakes. See plan
 * 2026-10-16-terminal-path-links Contracts "electron/path-link-resolver.ts".
 */
import { activeCwd } from '../src/active-cwd';
import { folderKey } from '../src/folder-key';
import { decodeFileUri } from '../src/link-target';
import { isAncestorOf } from '../src/owning-session';
import { confineToRoots } from '../src/path-link-confine';
import {
  buildResolveRoots,
  type ResolveRoot,
  rootsSigOf,
  userRootsOf,
} from '../src/path-link-roots';
import {
  type IndexedFile,
  MAX_ALTS,
  type PathCandidate,
  type ResolveIndex,
  resolveTokens,
  type TokenResolution,
} from '../src/path-resolve';
import { isUncLike, normalizeAbs, type PathPlatform } from '../src/path-token-normalize';
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
  /** Forward-slashed realPathLeaf (src/path-link-confine.ts slashedRealPathLeaf): sync, so it runs
   *  only for a uri target that passed the decode and lexical checks, once per click. */
  realPathLeaf(t: string): string;
  homeDir: string;
  platform: PathPlatform;
  caseSensitive: boolean;
  log: {
    warn(scope: string, msg: string, data?: Record<string, unknown>): void;
    debug(scope: string, msg: string, data?: Record<string, unknown>): void;
  };
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
/** Resolves running their CPU slices at once; the rest queue. A burst of 50 left the main thread
 *  no gap for a readFile round trip (review r1 PERF: p95 38 ms idle vs 1,073 ms under the burst).
 *  A resolve parked on I/O gives its slot up (review r2: one offline drive starved every session). */
export const RESOLVE_CONCURRENCY = 2;
/** An I/O await longer than this gives up the resolve's slot: well past a local stat or a warm
 *  index, well short of an offline drive or a cold index build. */
export const PARKED_IO_MS = 50;
export const MAX_TOKENS = 10;
export const UNC_PROBE_BUDGET_MS = 500;
// Mirrors MAX_TOKEN_LENGTH in webview/terminal-links.ts; the renderer is never trusted for it.
const MAX_ALT_LENGTH = 1024;

const slash = (p: string) => p.replace(/\\/g, '/');

/** `uri`: an OSC 8 / file:// target, resolved by decode + confinement only (plan Contracts
 *  "v1 OSC 8 / file://"), never by the path rules. */
type Entry =
  | { kind: 'valid'; key: string; alts: string[]; uri: boolean }
  | { kind: 'invalid'; key: string };

/** Per-token validation at the renderer→host trust boundary (plan Decisions, blocker 3). */
function validate(tokens: unknown): Entry[] {
  if (!Array.isArray(tokens)) return [];
  return tokens.slice(0, MAX_TOKENS).map((t): Entry => {
    const obj =
      typeof t === 'object' && t !== null ? (t as { alts?: unknown; target?: unknown }) : {};
    const alts: unknown = obj.alts;
    if (!Array.isArray(alts) || alts.length === 0 || !alts.every((a) => typeof a === 'string')) {
      return { kind: 'invalid', key: '' };
    }
    const key = alts.join('\0');
    const kept = alts.slice(0, MAX_ALTS).filter((a) => a.length > 0 && a.length <= MAX_ALT_LENGTH);
    return kept.length > 0
      ? { kind: 'valid', key, alts: kept, uri: obj.target === 'uri' }
      : { kind: 'invalid', key };
  });
}

const empty = (key: string, error?: TokenResolution['error']): TokenResolution => ({
  key,
  candidates: [],
  truncated: false,
  total: 0,
  ...(error ? { error } : {}),
});

/** `abs` relative to `base`, which the caller has checked contains it ('' for base itself). */
const relUnder = (base: string, abs: string): string => {
  const b = base.replace(/\/$/, '');
  return abs.length > b.length ? abs.slice(b.length + 1) : '';
};

interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

function semaphore(limit: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((r) => queue.push(r));
    },
    release() {
      // Handed straight to the next waiter, so a newcomer can never slip in between.
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

/** One limiter per resolve call: every stat of the call shares its slots. */
function withConcurrency(limit: number) {
  const sem = semaphore(limit);
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await sem.acquire();
    try {
      return await task();
    } finally {
      sem.release();
    }
  };
}

/** One resolve's hold on a host-wide slot. An I/O await that outlasts PARKED_IO_MS drops the
 *  hold (from a timer, when no continuation can be mid-slice), and every branch takes it back
 *  before resuming. Dropping on every await let a 50-resolve burst run at once: readFile p95
 *  under the burst went 1.5× → 4.5× idle (review r2 stress). */
function slotLease(slots: Semaphore) {
  let held = false;
  // A throw rejects the resolve while sibling branches are still parked; each would otherwise
  // take a slot on settling that nothing releases, and two such leaks stop every path link.
  let ended = false;
  let retaking: Promise<void> | null = null;
  const take = (): Promise<void> => {
    if (held || ended) return Promise.resolve();
    retaking ??= slots.acquire().then(() => {
      retaking = null;
      if (ended) slots.release();
      else held = true;
    });
    return retaking;
  };
  const drop = () => {
    if (!held) return;
    held = false;
    slots.release();
  };
  return {
    take,
    end() {
      ended = true;
      drop();
    },
    /** Runs I/O, dropping the slot if it is slow; resolves only once the slot is held again. */
    async io<T>(task: () => Promise<T>): Promise<T> {
      const timer = setTimeout(drop, PARKED_IO_MS);
      try {
        return await task();
      } finally {
        clearTimeout(timer);
        await take();
      }
    },
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

  const resolveSlots = semaphore(RESOLVE_CONCURRENCY);

  const resolveLeased = async (
    session: Session,
    entries: Entry[],
    lease: ReturnType<typeof slotLease>,
  ): Promise<PathLinkReply> => {
    const cwd = slash(activeCwd(session));
    // Warm, the toplevel and the indexes are memo lookups: CPU that the cap is for. Cold, they
    // are a git spawn and an index build, which the lease lets go of once they run long.
    const cwdGitRoot = slash(await lease.io(() => deps.gitRoot(session)).catch(() => cwd));
    const roots = buildResolveRoots(session, cwdGitRoot, opts);
    const rootsSig = rootsSigOf(session);
    const valid = entries.filter(
      (e): e is Extract<Entry, { kind: 'valid' }> => e.kind === 'valid' && !e.uri,
    );
    const uris = entries.filter(
      (e): e is Extract<Entry, { kind: 'valid' }> => e.kind === 'valid' && e.uri,
    );
    const indexes =
      valid.length > 0 ? await lease.io(() => indexesFor(roots, cwdGitRoot || cwd)) : [];
    const limit = withConcurrency(STAT_CONCURRENCY);
    const knownRepoKeys = new Set([
      ...(session.repos ?? []).map((r) => key(r.root)),
      ...(cwdGitRoot !== cwd ? [key(cwdGitRoot)] : []),
    ]);
    const turn = turnTaker();
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
        stat: (abs) => lease.io(() => limit(() => raceUnc(abs, deps.stat))),
        yieldTurn: () => turn().then(lease.take),
        // A repo the session's scan registered, or the cwd's git root, is its own toplevel:
        // asking git once per root put 200 spawns on every 200-repo resolve (Slice 6 profile).
        topLevel: (dir) =>
          knownRepoKeys.has(key(dir)) ? Promise.resolve(dir) : lease.io(() => deps.topLevel(dir)),
      },
    );
    const uriResults = new Map<Entry, TokenResolution>();
    for (const e of uris) {
      uriResults.set(e, await resolveUri(session, e, roots, lease, knownRepoKeys));
    }
    let next = 0;
    const results = entries.map((e) => {
      if (e.kind === 'invalid') return empty(e.key, 'invalid');
      const u = uriResults.get(e);
      if (u) return u;
      // The trimmed alts resolved; the renderer's pending token is the original join.
      return { ...resolved[next++], key: e.key };
    });
    return { cwd, rootsSig, roots, results };
  };

  /** Terminal output chose this target (an OSC 8 label can hide it), so it opens only when it
   *  decodes, confines to a user-chosen root and exists — never through the path rules, whose
   *  elision and suffix search would reach past the confinement. */
  const resolveUri = async (
    session: Session,
    e: Extract<Entry, { kind: 'valid' }>,
    roots: ResolveRoot[],
    lease: ReturnType<typeof slotLease>,
    knownRepoKeys: Set<string>,
  ): Promise<TokenResolution> => {
    const refused = (reason: 'undecodable' | 'outside-roots') => {
      deps.log.debug('links', 'uri-refused', { reason });
      return empty(e.key);
    };
    const target = decodeFileUri(e.alts[0], deps.platform);
    if (!target) return refused('undecodable');
    const confined = confineToRoots(target.path, userRootsOf(session, opts), {
      realPathLeaf: deps.realPathLeaf,
      ...opts,
    });
    if (!confined) return refused('outside-roots');
    const pos = {
      ...(target.line !== undefined ? { line: target.line } : {}),
      ...(target.col !== undefined ? { col: target.col } : {}),
    };
    const real = confined.real;
    const kind = await lease.io(() => raceUnc(real, deps.stat)).catch(() => null);
    if (!kind) return { ...empty(e.key), ...pos };

    const realKey = key(real);
    let rootIdx = -1;
    roots.forEach((r, i) => {
      if (
        isAncestorOf(key(r.abs), realKey) &&
        (rootIdx < 0 || r.abs.length > roots[rootIdx].abs.length)
      )
        rootIdx = i;
    });
    const folder =
      kind === 'dir' ? real : real.slice(0, Math.max(real.lastIndexOf('/'), 0)) || real;
    const top = knownRepoKeys.has(key(folder))
      ? folder
      : await lease.io(() => deps.topLevel(folder)).catch(() => '');
    const repoRoot = top ? normalizeAbs(slash(top), deps.platform) : folder;
    const cand: PathCandidate = {
      absPath: real,
      rootIdx,
      relToRoot: rootIdx >= 0 ? relUnder(roots[rootIdx].abs, real) : real,
      repoRoot,
      relToRepo: isAncestorOf(key(repoRoot), realKey) ? relUnder(repoRoot, real) : real,
      isDir: kind === 'dir',
      strength: 'exact-cwd',
    };
    return { key: e.key, candidates: [cand], truncated: false, total: 1, ...pos };
  };

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
    const lease = slotLease(resolveSlots);
    await lease.take();
    try {
      return await resolveLeased(session, entries, lease);
    } finally {
      lease.end();
    }
  };

  return {
    resolve: resolveNow,
    probe(abs) {
      return raceUnc(abs, deps.stat).catch(() => null);
    },
  };
}
