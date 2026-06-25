/**
 * Pure resolution of a terminal path TOKEN to candidate files (path-links v1). The host
 * wires this with a real file index + `statSync`; the renderer link provider renders the
 * result (0 → plain, 1 → open, >1 → disambiguation dropdown). Side-effect-free over its
 * inputs (the existence/type check is injected) so it's exhaustively unit-testable.
 *
 * Two rules, in order:
 *  1. Exact — the token joined to the session cwd, then the project root, then (if already
 *     absolute) as-is. The first that exists is the sole candidate. This covers absolute,
 *     `./`/`../`, and bare project-relative paths, and keeps directory links working
 *     (existence/type comes from the injected stat).
 *  2. Suffix search — only when no exact hit and the token is not absolute: project files
 *     whose path ends with the token on a SEGMENT boundary (`accent.ts` matches
 *     `src/core/theme/accent.ts`, never `xaccent.ts`). Sorted shortest-path-first, capped.
 *
 * Abbreviated paths (`C:/x/.../src/app.tsx`, `.../foo/bar.ts`) — where an agent elides the
 * middle with `...` — short-circuit to a suffix search on the concrete tail after the last
 * elision (the drive/root prefix and elided middle are unknowable). >1 hit → disambiguation.
 */

/** One entry of the project file index. `rel` is forward-slash, relative to the project root. */
export interface IndexedFile {
  rel: string;
  abs: string;
}

export interface PathCandidate {
  absPath: string;
  /** Path relative to the project root — the dropdown's display label. */
  relPath: string;
  isDir: boolean;
}

export interface TokenResolution {
  token: string;
  candidates: PathCandidate[];
  /** True when more than `cap` files matched the suffix search; only the first `cap` returned. */
  truncated: boolean;
}

/** Existence + type of an absolute path: 'file' | 'dir' | null (missing). Injected for purity. */
export type StatKind = (absPath: string) => 'file' | 'dir' | null;

const DEFAULT_CANDIDATE_CAP = 50;

const normSlash = (s: string): string => s.replace(/\\/g, '/');
const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);
const stripDotSlash = (s: string): string => s.replace(/^\.\//, '');

const joinPath = (base: string, rel: string): string =>
  `${base.replace(/\/+$/, '')}/${stripDotSlash(rel)}`;

const relTo = (root: string, abs: string): string => {
  const r = root.replace(/\/+$/, '');
  return abs.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? abs.slice(r.length + 1) : abs;
};

export interface ResolveCtx {
  /** Session live working directory (forward-slash). */
  cwd: string;
  /** Project root (forward-slash); falls back to cwd when not a repo. */
  root: string;
  /** Project file index for the suffix search. */
  files: IndexedFile[];
  /** Match suffixes case-sensitively (Linux) or not (Windows/macOS). */
  caseSensitive: boolean;
  cap?: number;
}

/** A path SEGMENT that is an elision marker (3+ dots), e.g. the `...` in `a/.../b`. */
const ELISION_SEG = /^\.{3,}$/;

/**
 * When `token` has an elision segment (`.../`), return the concrete tail after the LAST
 * elision (`C:/x/.../src/app.tsx` → `src/app.tsx`); otherwise null. Only the tail is
 * resolvable — the prefix and elided middle are unknowable, so we suffix-search the tail.
 */
function elisionTail(token: string): string | null {
  const segs = token.split('/');
  let last = -1;
  for (let i = 0; i < segs.length; i++) if (ELISION_SEG.test(segs[i])) last = i;
  if (last === -1) return null;
  const tail = segs
    .slice(last + 1)
    .filter(Boolean)
    .join('/');
  return tail || null;
}

/** Segment-aligned suffix search over the file index for a (non-absolute) needle token. */
function suffixSearch(needleToken: string, rawToken: string, ctx: ResolveCtx): TokenResolution {
  const cap = ctx.cap ?? DEFAULT_CANDIDATE_CAP;
  const fold = (s: string) => (ctx.caseSensitive ? s : s.toLowerCase());
  const needle = fold(stripDotSlash(needleToken));
  const matched = ctx.files.filter((f) => {
    const rel = fold(f.rel);
    return rel === needle || rel.endsWith(`/${needle}`);
  });
  matched.sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  const truncated = matched.length > cap;
  const candidates = matched
    .slice(0, cap)
    .map((f) => ({ absPath: f.abs, relPath: f.rel, isDir: false }));
  return { token: rawToken, candidates, truncated };
}

export function resolveToken(rawToken: string, ctx: ResolveCtx, stat: StatKind): TokenResolution {
  const token = normSlash(rawToken);

  // Abbreviated path (`.../` elision): resolve by suffix-searching the concrete tail.
  const tail = elisionTail(token);
  if (tail !== null) return suffixSearch(tail, rawToken, ctx);

  const abs = isAbsolute(token);

  // Rule 1 — exact (cwd over root). Absolute tokens are checked as-is.
  const exacts = abs
    ? [token]
    : ctx.root && ctx.root !== ctx.cwd
      ? [joinPath(ctx.cwd, token), joinPath(ctx.root, token)]
      : [joinPath(ctx.cwd, token)];
  for (const candidateAbs of exacts) {
    const kind = stat(candidateAbs);
    if (kind) {
      return {
        token: rawToken,
        candidates: [
          { absPath: candidateAbs, relPath: relTo(ctx.root, candidateAbs), isDir: kind === 'dir' },
        ],
        truncated: false,
      };
    }
  }

  // An absolute token names a specific location — it never suffix-searches.
  if (abs) return { token: rawToken, candidates: [], truncated: false };

  // Rule 2 — segment-aligned suffix search over the file index.
  return suffixSearch(token, rawToken, ctx);
}
