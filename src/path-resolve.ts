/**
 * Pure async resolution of terminal path tokens against every session root (spec
 * 2026-10-16-terminal-path-links §3.2; the rules are the plan's Contracts "src/path-resolve.ts").
 * Browser-safe: string work on forward-slashed input, platform and fs injected. The host shell is
 * electron/path-link-resolver.ts; ranking happens renderer-side after the cache.
 */
import type { ResolveRoot } from './path-link-roots';
import {
  expandToken,
  isAbsoluteToken,
  isUncLike,
  joinAbs,
  normalizeAbs,
  type PathPlatform,
} from './path-token-normalize';

export { isUncLike };

/** One entry of a file index. `rel` is forward-slash, relative to the index root. */
export interface IndexedFile {
  rel: string;
  abs: string;
}

export type CandidateStrength = 'exact-cwd' | 'exact-root' | 'suffix';

export interface PathCandidate {
  /** normalizeAbs'd. */
  absPath: string;
  /** Index into the reply's roots; -1 = outside every root. */
  rootIdx: number;
  /** Relative to roots[rootIdx].abs ('' for the root itself); absPath when rootIdx is -1. */
  relToRoot: string;
  repoRoot: string;
  /** Relative to repoRoot (Copy relative path). */
  relToRepo: string;
  isDir: boolean;
  strength: CandidateStrength;
}

export interface TokenResolution {
  /** alts.join('\0') — the renderer's pending cache token. */
  key: string;
  /** Strength, then root order, then shorter relToRoot (the renderer re-ranks). */
  candidates: PathCandidate[];
  truncated: boolean;
  total: number;
  /** 'invalid' = this entry failed host validation. */
  error?: 'timeout' | 'session-gone' | 'invalid';
  /** Which alt resolved, when it was not the first (row 40: the pane links that alt's text). */
  alt?: number;
  /** A uri target's `#L` / `:l:c` position, decoded host-side (the renderer never parses it). */
  line?: number;
  col?: number;
}

export type StatKind = (absPath: string) => Promise<'file' | 'dir' | null>;

export interface ResolveDeps {
  stat: StatKind;
  /** git toplevel of a folder, '' when not a repo. */
  topLevel: (dir: string) => Promise<string>;
  /** Hands the thread back between tokens and between fallback batches; the host passes a
   *  setImmediate chain so a 200-root burst does not starve its other IPC (review r1 PERF). */
  yieldTurn?: () => Promise<void>;
}

export interface ResolveIndex {
  root: string;
  files: IndexedFile[];
  /** Root indices whose files this index lists completely (git listing answered, not capped). */
  coveredRootIdx: number[];
}

export interface ResolveCtx {
  /** Live cwd, forward-slashed. */
  cwd: string;
  cwdGitRoot: string;
  roots: ResolveRoot[];
  indexes: ResolveIndex[];
  caseSensitive: boolean;
  homeDir: string;
  platform: PathPlatform;
  cap?: number;
}

export const DEFAULT_CANDIDATE_CAP = 200;
export const MAX_ALTS = 4;
/** Covered roots stat'ed at once by the ignored-file fallback: libuv's default pool size, so a
 *  fallback never queues more fs work than the pool runs at once. */
export const IGNORED_FALLBACK_BATCH = 4;
/** A tail-truncated last segment (`src/util/a…`, row 37) links only while its prefix stays this
 *  specific; more matches are noise, not a link. */
export const TRAILING_ELISION_MAX = 10;

export interface IndexMemo {
  foldedRels: string[];
  absSet: Set<string>;
}

// Keyed by the index ARRAY: the host's 5 s index cache hands back the same array while warm, so
// repaints never re-fold 20k paths.
const memoByCase = {
  sensitive: new WeakMap<IndexedFile[], IndexMemo>(),
  folded: new WeakMap<IndexedFile[], IndexMemo>(),
};

const foldWith = (caseSensitive: boolean) => (s: string) => (caseSensitive ? s : s.toLowerCase());
const slash = (s: string) => s.replace(/\\/g, '/');

export function memoFor(files: IndexedFile[], caseSensitive: boolean): IndexMemo {
  const map = caseSensitive ? memoByCase.sensitive : memoByCase.folded;
  const hit = map.get(files);
  if (hit) return hit;
  const fold = foldWith(caseSensitive);
  const memo: IndexMemo = {
    foldedRels: files.map((f) => fold(f.rel)),
    absSet: new Set(files.map((f) => fold(slash(f.abs)))),
  };
  map.set(files, memo);
  return memo;
}

const STRENGTH_ORDER: Record<CandidateStrength, number> = {
  'exact-cwd': 0,
  'exact-root': 1,
  suffix: 2,
};
const ELISION_SEG = /^(?:\.{3,}|…)$/;

interface Found {
  absPath: string;
  isDir: boolean;
  strength: CandidateStrength;
}

/** Per-call view of the ctx with folded keys precomputed. */
class Resolution {
  readonly fold: (s: string) => string;
  readonly rootKeys: string[];
  private readonly rootIdxByKey: Map<string, number>;
  private readonly userRootIdxByKey = new Map<string, number>();
  /** First index listing each root, built once: a find() per root per alt made a 200-root
   *  resolve quadratic (review r1 PERF). */
  private readonly coveringByRoot = new Map<number, ResolveIndex>();
  private readonly topMemo = new Map<string, Promise<string>>();

  constructor(
    readonly ctx: ResolveCtx,
    readonly deps: ResolveDeps,
  ) {
    this.fold = foldWith(ctx.caseSensitive);
    this.rootKeys = ctx.roots.map((r) => this.keyOf(r.abs));
    this.rootIdxByKey = new Map();
    this.rootKeys.forEach((k, i) => {
      if (!this.rootIdxByKey.has(k)) this.rootIdxByKey.set(k, i);
      if (ctx.roots[i].userChosen && !this.userRootIdxByKey.has(k)) this.userRootIdxByKey.set(k, i);
    });
    for (const ix of ctx.indexes) {
      for (const i of ix.coveredRootIdx)
        if (!this.coveringByRoot.has(i)) this.coveringByRoot.set(i, ix);
    }
  }

  yieldTurn(): Promise<void> {
    return this.deps.yieldTurn ? this.deps.yieldTurn() : Promise.resolve();
  }

  keyOf(p: string): string {
    return this.fold(normalizeAbs(p, this.ctx.platform));
  }

  /** `key` lies at or under `rootKey` (both from keyOf). */
  static under(rootKey: string, key: string): boolean {
    if (key === rootKey) return true;
    return key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
  }

  /** Walks the path's ancestors against a key map: a scan of every root per candidate made a
   *  200-root resolve quadratic (plan Slice 6 profile). */
  deepestRoot(absPath: string, byKey = this.rootIdxByKey): number {
    let cur = this.keyOf(absPath);
    for (;;) {
      const idx = byKey.get(cur);
      if (idx !== undefined) return idx;
      if (cur === '/' || cur.endsWith(':/') || !cur.includes('/')) return -1;
      const cut = cur.lastIndexOf('/');
      const parent = cut === 0 ? '/' : cur.slice(0, cut);
      cur = /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
    }
  }

  deepestUserRoot(absPath: string): number {
    return this.deepestRoot(absPath, this.userRootIdxByKey);
  }

  /** A UNC path may only be touched under a user-chosen UNC root (plan: resolver rule 2). */
  uncAdmitted(absPath: string): boolean {
    const k = this.keyOf(absPath);
    return this.ctx.roots.some(
      (r, i) => r.userChosen && isUncLike(r.abs) && Resolution.under(this.rootKeys[i], k),
    );
  }

  async stat(absPath: string): Promise<'file' | 'dir' | null> {
    try {
      return await this.deps.stat(absPath);
    } catch {
      // A failed stat is a miss by contract: resolveTokens never rejects.
      return null;
    }
  }

  topLevel(dir: string): Promise<string> {
    const k = this.keyOf(dir);
    let p = this.topMemo.get(k);
    if (!p) {
      p = this.deps.topLevel(dir).then(
        (t) => (t ? normalizeAbs(t, this.ctx.platform) : ''),
        // A failed toplevel probe means "not a repo" by contract.
        () => '',
      );
      this.topMemo.set(k, p);
    }
    return p;
  }

  indexCovering(rootIdx: number): ResolveIndex | undefined {
    return this.coveringByRoot.get(rootIdx);
  }

  /** Row 37: files named `prefix…` directly in `dir` (an absolute folder, or one matched as
   *  whole trailing segments of each index's rel). Deduped, so the cap counts files. */
  prefixSearch(dir: string, prefix: string): Found[] {
    const absDir = dir && isAbsoluteToken(dir, this.ctx.platform) ? this.keyOf(dir) : null;
    const relDir = absDir === null ? this.fold(dir.replace(/^(?:\.\/)+/, '')) : '';
    const p = this.fold(prefix);
    const seen = new Set<string>();
    const out: Found[] = [];
    for (const ix of this.ctx.indexes) {
      const { foldedRels } = memoFor(ix.files, this.ctx.caseSensitive);
      for (let i = 0; i < foldedRels.length; i++) {
        const rel = foldedRels[i];
        const cut = rel.lastIndexOf('/');
        if (!rel.slice(cut + 1).startsWith(p)) continue;
        const absPath = normalizeAbs(ix.files[i].abs, this.ctx.platform);
        const k = this.keyOf(absPath);
        if (absDir !== null) {
          if (k.slice(0, k.lastIndexOf('/')) !== absDir) continue;
        } else if (relDir) {
          const fdir = cut < 0 ? '' : rel.slice(0, cut);
          if (fdir !== relDir && !fdir.endsWith(`/${relDir}`)) continue;
        }
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ absPath, isDir: false, strength: 'suffix' });
      }
    }
    return out;
  }

  suffixSearch(needle: string, partialFirst: boolean): Found[] {
    const n = this.fold(needle);
    const out: Found[] = [];
    for (const ix of this.ctx.indexes) {
      const { foldedRels } = memoFor(ix.files, this.ctx.caseSensitive);
      for (let i = 0; i < foldedRels.length; i++) {
        const rel = foldedRels[i];
        const hit = partialFirst ? rel.endsWith(n) : rel === n || rel.endsWith(`/${n}`);
        if (hit)
          out.push({
            absPath: normalizeAbs(ix.files[i].abs, this.ctx.platform),
            isDir: false,
            strength: 'suffix',
          });
      }
    }
    return out;
  }
}

/** Row 37: `dir/pre…` → the folder part and the last segment's prefix; null otherwise. */
function trailingElision(t: string): { dir: string; prefix: string } | null {
  const cut = t.lastIndexOf('/');
  const last = t.slice(cut + 1);
  if (last.length < 2 || !last.endsWith('…')) return null;
  return { dir: cut < 0 ? '' : t.slice(0, cut), prefix: last.slice(0, -1) };
}

/** Rule 6: the head before the first elision and the tail after the last one. */
function splitElision(t: string): { head: string; tail: string; partialFirst: boolean } | null {
  const segs = t.split('/');
  let first = -1;
  let last = -1;
  let partialFirst = false;
  for (let i = 0; i < segs.length; i++) {
    const pure = ELISION_SEG.test(segs[i]);
    const partial = !pure && segs[i].startsWith('…');
    if (!pure && !partial) continue;
    if (first < 0) first = i;
    last = i;
    partialFirst = partial;
  }
  if (last < 0) return null;
  const tailSegs = partialFirst
    ? [segs[last].slice(1), ...segs.slice(last + 1)]
    : segs.slice(last + 1);
  const tail = tailSegs.filter(Boolean).join('/');
  if (!tail) return null;
  return { head: segs.slice(0, first).join('/'), tail, partialFirst };
}

/** The concrete tail of an elided token (`…/src/index.ts` → `src/index.ts`), null when the token
 *  has no elision: what a search for the token should look for. */
export function elisionTail(token: string): string | null {
  return splitElision(slash(token))?.tail ?? null;
}

/** Membership comes from `ls-files --exclude-standard`, so a gitignored file is never in it. A
 *  dotfile or a token with a separator is worth a stat; a bare word is prose far more often than
 *  an ignored file (spec §3.2 "Index", review r1 SF2). */
function mayBeIgnoredFile(t: string): boolean {
  if (t.includes('/')) return true;
  return t.startsWith('.') && t !== '.' && t !== '..';
}

async function ignoredFallback(t: string, roots: number[], r: Resolution): Promise<Found[]> {
  const { ctx } = r;
  const out: Found[] = [];
  for (let b = 0; b < roots.length; b += IGNORED_FALLBACK_BATCH) {
    await r.yieldTurn();
    const hits = await Promise.all(
      roots.slice(b, b + IGNORED_FALLBACK_BATCH).map(async (i): Promise<Found | null> => {
        const abs = joinAbs(ctx.roots[i].abs, t, ctx.platform);
        const kind = await r.stat(abs);
        return kind ? { absPath: abs, isDir: kind === 'dir', strength: 'exact-root' } : null;
      }),
    );
    for (const hit of hits) if (hit) out.push(hit);
  }
  return out;
}

async function resolveAlt(alt: string, r: Resolution): Promise<Found[]> {
  const { ctx } = r;
  const t = expandToken(alt, { platform: ctx.platform, homeDir: ctx.homeDir });
  const isDirTok = t.endsWith('/');

  const elided = splitElision(t);
  if (elided) {
    let found = r.suffixSearch(elided.tail, elided.partialFirst);
    if (elided.head && isAbsoluteToken(elided.head, ctx.platform)) {
      const headKey = r.keyOf(elided.head);
      found = found.filter((f) => Resolution.under(headKey, r.keyOf(f.absPath)));
    }
    return found;
  }

  const trailing = trailingElision(t);
  if (trailing) {
    const found = r.prefixSearch(trailing.dir, trailing.prefix);
    return found.length <= TRAILING_ELISION_MAX ? found : [];
  }

  if (isUncLike(t)) {
    const abs = normalizeAbs(t, ctx.platform);
    return r.uncAdmitted(abs) ? [{ absPath: abs, isDir: isDirTok, strength: 'exact-cwd' }] : [];
  }

  if (isAbsoluteToken(t, ctx.platform)) {
    const abs = normalizeAbs(t, ctx.platform);
    const kind = await r.stat(abs);
    return kind ? [{ absPath: abs, isDir: kind === 'dir', strength: 'exact-cwd' }] : [];
  }

  const found: Found[] = [];
  const cwdBases = [ctx.cwd];
  if (ctx.cwdGitRoot && r.keyOf(ctx.cwdGitRoot) !== r.keyOf(ctx.cwd)) cwdBases.push(ctx.cwdGitRoot);
  const joinedKeys = new Set(cwdBases.map((b) => r.keyOf(b)));
  for (const base of cwdBases) {
    if (!base) continue;
    const abs = joinAbs(base, t, ctx.platform);
    if (isUncLike(abs) && !r.uncAdmitted(abs)) continue;
    const kind = await r.stat(abs);
    if (kind) {
      found.push({ absPath: abs, isDir: kind === 'dir', strength: 'exact-cwd' });
      break;
    }
  }

  const rootHits = await Promise.all(
    ctx.roots.map(async (root, i): Promise<Found | null> => {
      if (joinedKeys.has(r.rootKeys[i])) return null;
      const abs = joinAbs(root.abs, t, ctx.platform);
      const covering = r.indexCovering(i);
      if (!isDirTok && covering) {
        return memoFor(covering.files, ctx.caseSensitive).absSet.has(r.fold(abs))
          ? { absPath: abs, isDir: false, strength: 'exact-root' }
          : null;
      }
      if (isUncLike(root.abs)) return null;
      const kind = await r.stat(abs);
      return kind ? { absPath: abs, isDir: kind === 'dir', strength: 'exact-root' } : null;
    }),
  );
  for (const hit of rootHits) if (hit) found.push(hit);
  if (found.length > 0 || isDirTok) return found;

  // A dot segment would have the fallback stat outside the root it joins to.
  const needle = t.replace(/^(?:\.\/)+/, '');
  if (needle.split('/').some((s) => s === '..' || s === '.')) return [];

  if (mayBeIgnoredFile(t)) {
    const missed = ctx.roots.flatMap((root, i) =>
      !joinedKeys.has(r.rootKeys[i]) && r.indexCovering(i) && !isUncLike(root.abs) ? [i] : [],
    );
    const ignored = await ignoredFallback(t, missed, r);
    if (ignored.length > 0) return ignored;
  }

  return r.suffixSearch(needle, false);
}

async function finalize(key: string, found: Found[], r: Resolution): Promise<TokenResolution> {
  const { ctx } = r;
  const byPath = new Map<string, Found>();
  for (const f of found) {
    const k = r.keyOf(f.absPath);
    const prev = byPath.get(k);
    if (!prev || STRENGTH_ORDER[f.strength] < STRENGTH_ORDER[prev.strength]) byPath.set(k, f);
  }

  const relTo = (base: string, abs: string): string => {
    const bk = r.keyOf(base);
    const ak = r.keyOf(abs);
    if (ak === bk) return '';
    if (!Resolution.under(bk, ak)) return abs;
    return abs.slice(normalizeAbs(base, ctx.platform).replace(/\/$/, '').length + 1);
  };

  const candidates = await Promise.all(
    [...byPath.values()].map(async (f): Promise<PathCandidate> => {
      const rootIdx = r.deepestRoot(f.absPath);
      const folder = f.isDir ? f.absPath : parentFolder(f.absPath);
      const fromRoot = rootIdx >= 0 ? await r.topLevel(ctx.roots[rootIdx].abs) : '';
      const top = fromRoot || (await r.topLevel(folder));
      const repoRoot = top || normalizeAbs(folder, ctx.platform);
      return {
        absPath: f.absPath,
        rootIdx,
        relToRoot: rootIdx >= 0 ? relTo(ctx.roots[rootIdx].abs, f.absPath) : f.absPath,
        repoRoot,
        relToRepo: relTo(top || copyBaseOutsideRepo(r, f.absPath, repoRoot), f.absPath),
        isDir: f.isDir,
        strength: f.strength,
      };
    }),
  );

  candidates.sort(
    (a, b) =>
      STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
      (a.rootIdx < 0 ? Number.MAX_SAFE_INTEGER : a.rootIdx) -
        (b.rootIdx < 0 ? Number.MAX_SAFE_INTEGER : b.rootIdx) ||
      a.relToRoot.length - b.relToRoot.length ||
      a.relToRoot.localeCompare(b.relToRoot),
  );
  const cap = ctx.cap ?? DEFAULT_CANDIDATE_CAP;
  return {
    key,
    candidates: candidates.slice(0, cap),
    truncated: candidates.length > cap,
    total: candidates.length,
  };
}

/** The folder holding `abs` (forward-slashed); a drive or posix root keeps its separator. */
export function parentFolder(abs: string): string {
  const cut = abs.lastIndexOf('/');
  if (cut < 0) return abs;
  const head = abs.slice(0, cut);
  return head === '' || /^[A-Za-z]:$/.test(head) ? abs.slice(0, cut + 1) : head;
}

/** Copy relative path outside any repo: relative to the user root the file is under, not its own
 *  folder, which would leave only its name (QA r1 D3). */
function copyBaseOutsideRepo(r: Resolution, abs: string, folder: string): string {
  const u = r.deepestUserRoot(abs);
  return u >= 0 ? r.ctx.roots[u].abs : folder;
}

/** Never rejects: a throwing stat or topLevel counts as a miss or as ''. Trusts its input — the
 *  host shell enforces MAX_ALTS and the token limits. */
export async function resolveTokens(
  tokens: ReadonlyArray<{ alts: string[] }>,
  ctx: ResolveCtx,
  deps: ResolveDeps,
): Promise<TokenResolution[]> {
  const r = new Resolution(ctx, deps);
  return Promise.all(
    tokens.map(async ({ alts }, i) => {
      if (i > 0) await r.yieldTurn();
      const key = alts.join('\0');
      for (let a = 0; a < alts.length; a++) {
        const found = await resolveAlt(alts[a], r);
        if (found.length === 0) continue;
        const res = await finalize(key, found, r);
        return a > 0 ? { ...res, alt: a } : res;
      }
      return { key, candidates: [], truncated: false, total: 0 };
    }),
  );
}
