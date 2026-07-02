/**
 * Pure project-wide find-in-files core (L5). NODE-FREE on purpose: it's imported by
 * BOTH the Electron host (real fs, see src/content-search-fs.ts) AND the browser-targeted
 * renderer (the preview mock searches an in-memory tree), so it must NOT statically import
 * `node:fs`/`node:path`. The caller injects the filesystem via {@link ContentSearchDeps}.
 *
 * This module is also the single source of truth for the ignored-directory set and the
 * binary-file sniff: src/file-search.ts and src/file-service.ts re-import them from here
 * (so there's one IGNORED set, not three drifting copies).
 *
 * Three matcher modes (literal, whole-word, regex) all honour a case toggle. Caps + a
 * wall-clock budget + a per-line step budget protect against catastrophic regex
 * backtracking and runaway walks: on exhaustion the search returns PARTIAL results
 * flagged `truncated`. An invalid user regex returns a structured `{ error }` (never
 * throws), surfaced inline in the UI.
 */

/** Directory names never descended into during a content/file walk. */
export const IGNORED: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '.cache',
  '.next',
  'build',
  '.cursor',
  '.vscode-test',
  '.playwright',
  '.playwright-cli',
  '.playwright-mcp',
]);

/** A byte buffer the matcher reads bytes/utf8 from (Node Buffer or Uint8Array-like). */
export interface BufferLike {
  length: number;
  [i: number]: number;
  toString(encoding: 'utf8'): string;
}

/** True if `buf`'s first bytes contain a NUL — treated as a binary file (skip). */
export function isBinary(buf: { length: number; [i: number]: number }): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** A directory entry; the minimal shape the walker consumes (fs.Dirent-compatible). */
export interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ContentSearchDeps {
  readdir: (p: string) => Dirent[];
  /** Reads a file as a byte buffer (so the binary sniff sees raw bytes). */
  readFile: (p: string) => BufferLike;
  /** Clock for the time budget (host/preview pass Date.now; tests inject). */
  now: () => number;
}

export interface ContentSearchCaps {
  /** Per-file match budget; hitting it truncates that file. */
  perFileCap: number;
  /** Total match budget across all files; hitting it truncates the whole search. */
  totalCap: number;
  /** Wall-clock budget (ms); on exhaustion the walk stops with partial results. */
  timeBudgetMs: number;
}

const DEFAULT_CAPS: ContentSearchCaps = {
  perFileCap: 200,
  totalCap: 2000,
  timeBudgetMs: 2000,
};

/** Files larger than this are skipped (bytes). */
const MAX_FILE_BYTES = 1024 * 1024;
/** A matched line is trimmed for display and capped at this many chars. */
const MAX_LINE_TEXT = 300;
/**
 * Catastrophic-backtracking guard: the maximum number of `RegExp.exec` calls per line.
 * A pathological pattern (e.g. nested quantifiers) can hang a single `exec`, but a line
 * is bounded, and a sane pattern needs at most (line length) execs. This caps the COUNT
 * of advancing execs so a degenerate matcher can't spin a single line forever.
 */
const MAX_EXEC_PER_LINE = 10_000;

export interface SearchQuery {
  text: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma-separated globs (project-relative). Empty = include everything. */
  include?: string;
  /** Comma-separated globs (project-relative). Empty = exclude nothing. */
  exclude?: string;
}

export interface SearchMatch {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start in the original (CR-stripped) line. */
  column: number;
  /** The matched line, trimmed and capped at {@link MAX_LINE_TEXT}. */
  lineText: string;
}

export interface SearchFileResult {
  rel: string;
  abs: string;
  matches: SearchMatch[];
  /** True when the query matched the file's relative path (a file or folder NAME),
   * not just its contents. A name-only hit has an empty `matches` array. The renderer
   * highlights the match in the header (re-running the matcher over the path) and
   * counts it as a result. */
  nameMatch?: boolean;
}

export interface ContentSearchResponse {
  files: SearchFileResult[];
  /** True when a cap/budget cut the search short (results are partial). */
  truncated: boolean;
  /** Set (with no files) when the user's regex was invalid. */
  error?: string;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** Escape a literal string for safe embedding in a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a single glob (`*` = any run incl. `/`, `?` = one char) into an anchored
 * RegExp matched against a forward-slash, project-relative path. All other regex
 * metacharacters are escaped so a glob can never inject a pattern.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (const ch of glob.trim()) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`);
}

/** Parse comma-separated globs into RegExps (blank entries dropped). */
export function parseGlobs(spec: string | undefined): RegExp[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

/** Does `rel` pass the include/exclude filter? Include empty = include all. */
export function pathPasses(rel: string, includes: RegExp[], excludes: RegExp[]): boolean {
  if (excludes.some((re) => re.test(rel))) return false;
  if (includes.length > 0 && !includes.some((re) => re.test(rel))) return false;
  return true;
}

/** All match starts (0-based column) + length in `line`; empty when no match. */
export type LineMatcher = (line: string) => { col: number; len: number }[];

/**
 * Build a per-line matcher for the query, or return a structured error for an invalid
 * regex. Literal/whole-word build an internal global RegExp from the escaped text; regex
 * mode compiles the user pattern (only the case toggle maps to the `i` flag).
 */
export function buildMatcher(q: SearchQuery): { match: LineMatcher } | { error: string } {
  const flags = q.matchCase ? 'g' : 'gi';
  let source: string;
  if (q.regex) {
    source = q.text;
  } else if (q.wholeWord) {
    source = `\\b${escapeRegExp(q.text)}\\b`;
  } else {
    source = escapeRegExp(q.text);
  }
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Invalid regular expression.' };
  }
  // `\b` is unreliable for non-ASCII identifiers; for whole-word literal mode we also
  // enforce ASCII word boundaries explicitly so e.g. "cat" doesn't match "category".
  const enforceAsciiBoundary = q.wholeWord && !q.regex;
  const match: LineMatcher = (line) => {
    const hits: { col: number; len: number }[] = [];
    re.lastIndex = 0;
    let execs = 0;
    let m: RegExpExecArray | null = re.exec(line);
    while (m !== null && execs < MAX_EXEC_PER_LINE) {
      execs++;
      const len = m[0].length;
      const ok =
        !enforceAsciiBoundary ||
        (!isWordChar(line[m.index - 1]) && !isWordChar(line[m.index + len]));
      if (ok) hits.push({ col: m.index, len });
      // Guard against a zero-width match looping forever: always advance ≥1 char.
      re.lastIndex = m.index + (len > 0 ? len : 1);
      m = re.exec(line);
    }
    return hits;
  };
  return { match };
}

/** Trim a line for display and cap its length. */
function clip(line: string): string {
  const t = line.trim();
  return t.length > MAX_LINE_TEXT ? `${t.slice(0, MAX_LINE_TEXT)}…` : t;
}

/**
 * Scan one text body for matches, honouring the per-file and running total caps.
 * Returns the matches, whether the per-file (or total) cap cut it short, and the updated
 * running total. Pure + node-free so the line/column/cap logic is unit-tested directly.
 */
export function scanText(
  text: string,
  match: LineMatcher,
  totalSoFar: number,
  caps: Pick<ContentSearchCaps, 'perFileCap' | 'totalCap'> = DEFAULT_CAPS,
): { matches: SearchMatch[]; fileTruncated: boolean; totalAfter: number } {
  const matches: SearchMatch[] = [];
  const lines = text.split('\n');
  let total = totalSoFar;
  let fileTruncated = false;
  for (let i = 0; i < lines.length && !fileTruncated; i++) {
    // Strip a trailing CR so column math + display match the visible line.
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const hits = match(raw);
    if (hits.length === 0) continue;
    const lineText = clip(raw);
    for (const h of hits) {
      matches.push({ line: i + 1, column: h.col + 1, lineText });
      total++;
      if (matches.length >= caps.perFileCap || total >= caps.totalCap) {
        fileTruncated = true;
        break;
      }
    }
  }
  return { matches, fileTruncated, totalAfter: total };
}

/** Join an absolute dir with a child name using forward slashes (node-free). */
function joinPosix(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Record one file's contribution and return the updated running total. A content hit wins;
 * otherwise a name-only hit (query in the file/folder path) still surfaces the file and
 * counts toward the total so name matches can't run away. No-op when neither applies.
 * Shared by the sync and async walkers so the "what surfaces" rule lives in one place.
 */
function pushFileResult(
  files: SearchFileResult[],
  rel: string,
  abs: string,
  matches: SearchMatch[],
  nameMatch: boolean,
  total: number,
): number {
  if (matches.length > 0) {
    files.push(nameMatch ? { rel, abs, matches, nameMatch: true } : { rel, abs, matches });
    return total;
  }
  if (nameMatch) {
    files.push({ rel, abs, matches: [], nameMatch: true });
    return total + 1;
  }
  return total;
}

/**
 * Breadth-first file walk: yields each FILE as `{ abs, rel }` (rel = forward-slash,
 * root-relative), descending into every directory except `IGNORED` members and `.git*`.
 * Unreadable dirs are skipped. The caller decides when to stop (cap / budget).
 */
function* walkTree(
  root: string,
  readdir: (p: string) => Dirent[],
): Generator<{ abs: string; rel: string }> {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const queue: string[] = [base];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = joinPosix(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name) && !e.name.startsWith('.git')) queue.push(abs);
      } else if (e.isFile()) {
        yield { abs, rel: abs.slice(base.length + 1) };
      }
    }
  }
}

/**
 * Search every eligible file under `root` for `query`. Returns grouped matches plus a
 * `truncated` flag (cap/budget exhaustion) or an `{ error }` for an invalid regex. Pure
 * aside from the injected `deps`: the host wires real fs (src/content-search-fs.ts), the
 * preview mock + tests inject an in-memory tree.
 */
export function searchContent(
  root: string,
  query: SearchQuery,
  deps: ContentSearchDeps,
  caps: ContentSearchCaps = DEFAULT_CAPS,
): ContentSearchResponse {
  const { readdir, readFile, now } = deps;
  if (!query.text) return { files: [], truncated: false };

  const built = buildMatcher(query);
  if ('error' in built) return { files: [], truncated: false, error: built.error };
  const { match } = built;

  const includes = parseGlobs(query.include);
  const excludes = parseGlobs(query.exclude);

  const files: SearchFileResult[] = [];
  let total = 0;
  let truncated = false;
  const start = now();

  for (const { abs, rel } of walkTree(root, readdir)) {
    if (now() - start > caps.timeBudgetMs) {
      truncated = true;
      break;
    }
    if (!pathPasses(rel, includes, excludes)) continue;

    // A name match (query in the file/folder path) surfaces the file even when its
    // contents don't match — and even for a binary/oversize file we never scan.
    const nameMatch = match(rel).length > 0;

    let matches: SearchMatch[] = [];
    try {
      const buf = readFile(abs);
      if (buf.length <= MAX_FILE_BYTES && !isBinary(buf)) {
        const scan = scanText(buf.toString('utf8'), match, total, caps);
        matches = scan.matches;
        total = scan.totalAfter;
        if (scan.fileTruncated) truncated = true;
      }
    } catch {
      // unreadable file: a name-only hit can still surface it
    }

    total = pushFileResult(files, rel, abs, matches, nameMatch, total);
    if (total >= caps.totalCap) {
      truncated = true;
      break;
    }
  }

  return { files, truncated };
}

/**
 * Async deps for {@link searchContentAsync}: like {@link ContentSearchDeps} but every fs
 * call is awaited, plus a cooperative `yieldToEventLoop` and a `isCancelled` token. The host
 * wires real `fs.promises` + `setImmediate` (src/content-search-fs.ts); tests inject an
 * in-memory async tree.
 */
export interface AsyncContentSearchDeps {
  readdir: (p: string) => Promise<Dirent[]>;
  /** File size in bytes, read via stat BEFORE the body so an oversize file is never slurped
   *  into memory (the sync path reads first, then checks — fine for the tiny preview tree). */
  fileSize: (p: string) => Promise<number>;
  readFile: (p: string) => Promise<BufferLike>;
  now: () => number;
  /** Hand control back to the event loop (host: `setImmediate`) so a long walk on the main
   *  process never blocks IPC / PTY byte-forwarding / other windows. */
  yieldToEventLoop: () => Promise<void>;
  /** True once a newer query supersedes this one; the walk aborts cooperatively. */
  isCancelled?: () => boolean;
}

/** Yield to the event loop every N files walked (bounds the longest blocking stretch). */
const YIELD_EVERY_FILES = 200;

/**
 * Non-blocking twin of {@link searchContent}: same results, but the walk awaits fs, yields
 * to the event loop every {@link YIELD_EVERY_FILES} files, size-gates each file BEFORE
 * reading it, and aborts cooperatively when `isCancelled` flips (a superseded query). The
 * host runs this on the main process, so it must never monopolise the loop.
 */
export async function searchContentAsync(
  root: string,
  query: SearchQuery,
  deps: AsyncContentSearchDeps,
  caps: ContentSearchCaps = DEFAULT_CAPS,
): Promise<ContentSearchResponse> {
  const { readdir, readFile, fileSize, now, yieldToEventLoop, isCancelled } = deps;
  if (!query.text) return { files: [], truncated: false };

  const built = buildMatcher(query);
  if ('error' in built) return { files: [], truncated: false, error: built.error };
  const { match } = built;

  const includes = parseGlobs(query.include);
  const excludes = parseGlobs(query.exclude);

  const files: SearchFileResult[] = [];
  let total = 0;
  let truncated = false;
  const start = now();

  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const queue: string[] = [base];
  let sinceYield = 0;

  while (queue.length > 0) {
    if (isCancelled?.()) return { files, truncated: true };
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = joinPosix(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name) && !e.name.startsWith('.git')) queue.push(abs);
        continue;
      }
      if (!e.isFile()) continue;

      if (now() - start > caps.timeBudgetMs) return { files, truncated: true };
      if (isCancelled?.()) return { files, truncated: true };
      if (++sinceYield >= YIELD_EVERY_FILES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }

      const rel = abs.slice(base.length + 1);
      if (!pathPasses(rel, includes, excludes)) continue;

      const nameMatch = match(rel).length > 0;
      let matches: SearchMatch[] = [];
      try {
        if ((await fileSize(abs)) <= MAX_FILE_BYTES) {
          const buf = await readFile(abs);
          if (!isBinary(buf)) {
            const scan = scanText(buf.toString('utf8'), match, total, caps);
            matches = scan.matches;
            total = scan.totalAfter;
            if (scan.fileTruncated) truncated = true;
          }
        }
      } catch {
        // unreadable/vanished file: a name-only hit can still surface it
      }

      total = pushFileResult(files, rel, abs, matches, nameMatch, total);
      if (total >= caps.totalCap) return { files, truncated: true };
    }
  }

  return { files, truncated };
}

/**
 * Supersede helper: a response is stale (drop it) when its requestId is not the latest
 * the renderer issued. Pure so the renderer's drop-stale logic is unit-tested.
 */
export function isStaleResponse(responseId: number, latestId: number): boolean {
  return responseId !== latestId;
}
