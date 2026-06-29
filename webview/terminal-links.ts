/**
 * Pure path-token detection for the terminal link provider (D11). The xterm link-provider
 * wiring lives in terminal-pane.tsx and consumes this side-effect-free core.
 */

export interface PathToken {
  /** The matched path text as printed (cleaned of trailing junk + the `:line:col` suffix).
   *  This is what the host resolver searches with — for a bare filename it's `accent.ts`,
   *  for a relative path `src/core/theme/accent.ts`, for an absolute one the absolute path. */
  raw: string;
  /** Resolved absolute path (relative tokens joined to cwd), forward-slash normalized.
   *  Retained for back-compat; the v1 link provider resolves via the host using `raw`. */
  path: string;
  /** 1-based line number from a `:line` suffix, if present. */
  line?: number;
  /** 1-based column number from a `:line:col` suffix, if present. */
  col?: number;
  /** 0-based start index in the original line string. */
  start: number;
  /** 0-based exclusive end index in the original line string. */
  end: number;
}

// Characters that are legitimate path-terminators when found at the tail —
// sentence punctuation and paired delimiters that shouldn't be part of the path.
const TRAILING_JUNK = /[.,;)}\]'"]+$/;

// Path character class — every char that can appear inside a path segment.
// Explicitly excludes: colon (reserved for :line suffix), whitespace, quotes,
// angle brackets, pipes, glob chars (? *), ANSI bracket/escape chars ([\x1b).
// Backslash is allowed for Windows paths.
const PC = `[^\\s"'<>|?*:[\\]\\x00-\\x1f]`;

// Like PC but ALSO excludes the separators `/` and `\` — a single path SEGMENT. Used to
// build the bare-relative alternate so "≥1 separator" is enforced structurally rather than
// via backtracking (PC alone would gobble slashes).
const SEG = `[^\\s"'<>|?*:[\\]\\x00-\\x1f/\\\\]`;

// Extension allowlist for BARE filenames (single segment, no separator). A bare token only
// becomes a link candidate if its extension is here — this keeps method calls (`obj.foo`) and
// domains (`example.com`) from spamming the host resolver. Tokens that contain a separator are
// a real path shape and skip this gate. Lowercase, no leading dot; extend as needed.
const FILENAME_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'md',
  'mdx',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'psm1',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'svg',
  'txt',
  'lock',
  'sql',
  'graphql',
  'gql',
  'proto',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'pdf',
]);

/** The extension (lowercase, no dot) of a bare filename, or '' if none. */
function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Candidate finder: looks for path-start characters and returns the raw match.
// Three alternates inside ONE group so the suffix `(?::line)?` attaches cleanly:
//
//   POSIX absolute:   /path     — lookbehind blocks :/ (URL scheme)
//   Windows absolute: C:\path   — lookbehind blocks preceding letter/digit (avoids
//                                 the `s` in `https://`)
//   Relative:         ./path or ../path
//
// Group indices: 1=whole-path  2=line  3=col
const PATH_RE = new RegExp(
  `(` +
    // POSIX absolute — not preceded by a digit, colon, or slash. This blocks:
    //   - `//` (double-slash as in `https://`)
    //   - `:path` (port-followed paths like `3000/api`)
    // It does NOT block letter-preceded paths, which covers ANSI-terminated
    // sequences like `\x1b[31m/src/main.ts` where the `m` precedes the path.
    `(?<![0-9:/])/${PC}+(?:[/\\\\]${PC}*)*` +
    // Windows absolute — not preceded by alphanumeric
    `|(?<![A-Za-z0-9])[A-Za-z]:[/\\\\]${PC}*(?:[/\\\\]${PC}*)*` +
    // Relative: ../ or ./
    `|\\.\\.\\/(?:${PC}+(?:[/]${PC}*)*)?` +
    `|\\./${PC}+(?:[/]${PC}*)*` +
    // Bare project-relative path WITH at least one separator (e.g. `src/core/theme/accent.ts`,
    // `webview/app.tsx`) — no leading `/`, `./`, `../`, or drive. The lookbehind keeps it from
    // matching the tail of a URL/longer token (`https://a/b` → `a/b` is preceded by `/`;
    // `user@host/p`, `pkg.name/x` blocked too). Resolved against the session cwd like any
    // relative path; the host `pathExists` check is the false-positive filter, so only tokens
    // that name a real file/dir ever render as links.
    `|(?<![\\w./\\\\:~@[-])${SEG}+(?:/${SEG}+)+` +
    // Bare filename WITH an extension (single segment, no separator), e.g. `accent.ts`,
    // `README.md`. Same start lookbehind. The extension is gated against FILENAME_EXTS in
    // detectPathTokens (the regex just shapes the candidate); the host then suffix-searches
    // the project for it (1 match opens, >1 opens a disambiguation dropdown).
    `|(?<![\\w./\\\\:~@[-])${SEG}+\\.[A-Za-z0-9]{1,8}` +
    `)` +
    // Optional :line[:col] suffix — note the path char class excludes `:` so
    // this cleanly separates from the path without ambiguity.
    `(?::(\\d+)(?::(\\d+))?)?`,
  'g',
);

/**
 * Detect path-like tokens in a terminal line, sorted by start offset. `line` may contain
 * ANSI codes — the regex's path char class excludes `[` and `\x1b`, so ANSI sequences
 * terminate matches cleanly. Relative paths are skipped when `activeCwd` is absent.
 */
export function detectPathTokens(line: string, activeCwd: string | undefined): PathToken[] {
  const tokens: PathToken[] = [];
  PATH_RE.lastIndex = 0;

  for (;;) {
    const m = PATH_RE.exec(line);
    if (m === null) break;
    const rawPath = m[1];
    const rawLineNum = m[2];
    const rawColNum = m[3];

    const junk = TRAILING_JUNK.exec(rawPath);
    const cleanPath = junk ? rawPath.slice(0, junk.index) : rawPath;
    if (!cleanPath) continue;

    // A BARE filename (no separator) only qualifies if its extension is allowlisted — this is
    // the false-positive gate that keeps `obj.foo` / `example.com` from reaching the resolver.
    const hasSep = /[/\\]/.test(cleanPath);
    if (!hasSep && !FILENAME_EXTS.has(fileExt(cleanPath))) continue;

    let resolved: string;
    if (isAbsolutePath(cleanPath)) {
      resolved = cleanPath.replace(/\\/g, '/');
    } else {
      if (!activeCwd) continue;
      resolved = resolvePath(activeCwd, cleanPath);
    }

    const lineNum = rawLineNum !== undefined ? parseInt(rawLineNum, 10) : undefined;
    const colNum = rawColNum !== undefined ? parseInt(rawColNum, 10) : undefined;

    const start = m.index;
    const matchEnd = m.index + m[0].length;
    // With no numeric suffix, shrink end past any stripped trailing junk to the clean path.
    const end = rawLineNum !== undefined ? matchEnd : start + cleanPath.length;

    tokens.push({
      raw: cleanPath.replace(/\\/g, '/'),
      path: resolved,
      line: lineNum,
      col: colNum,
      start,
      end,
    });
  }

  return tokens;
}

/** A commit-hash candidate in a terminal line (0-based `start`, exclusive `end`, like PathToken). */
export interface CommitToken {
  raw: string;
  start: number;
  end: number;
}

// A standalone lowercase-hex run of 7–40 chars (git short default → full sha). The boundaries are
// the false-positive guard; host validation is the real gate. See spec §3.1.
//   - Lookbehind rejects `#abc123` (CSS), `0x…` (the `x` is a word char), and a run glued to a
//     preceding hex/word char or path/url/scope separator (`. / \ : @ ~ -`; `_` is in `\w`).
//   - Lookahead rejects a run continued by a hex/word char or `-`, and a trailing `.<alnum>`
//     (filename `abc1234.ts`, decimal `abc1234.5`) — bare sentence punctuation (`. , ) ]`) is left
//     outside the match, so the token span stays clean without trailing-junk stripping.
const COMMIT_RE = /(?<![\w#.@~:/\\-])[0-9a-f]{7,40}(?![\w-]|\.[0-9A-Za-z])/g;

// Bounds a pathological all-hex line (e.g. a wall of `git log` oids) so any one validate batch
// stays small; excess candidates render plain. A constant, not a setting (spec §3.1).
const COMMIT_CANDIDATE_CAP = 32;

/**
 * Detect standalone lowercase commit-hash candidates in a terminal line, in start order, capped
 * at {@link COMMIT_CANDIDATE_CAP}. Pure shape detection — kept separate from `PATH_RE`; the link
 * provider validates these host-side and merges with path links (path wins on overlap, §3.4).
 */
export function detectCommitTokens(line: string): CommitToken[] {
  const tokens: CommitToken[] = [];
  COMMIT_RE.lastIndex = 0;
  for (;;) {
    const m = COMMIT_RE.exec(line);
    if (m === null) break;
    tokens.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
    if (tokens.length >= COMMIT_CANDIDATE_CAP) break;
  }
  return tokens;
}

/**
 * Drop commit candidates whose span overlaps any resolved path-link span (path links win, §3.4).
 * `pathSpans` are the spans of path tokens that actually resolved to a link on the same line.
 */
export function filterCommitTokensByPathSpans(
  commits: CommitToken[],
  pathSpans: Array<{ start: number; end: number }>,
): CommitToken[] {
  return commits.filter((c) => !pathSpans.some((p) => c.start < p.end && p.start < c.end));
}

/** True when `p` looks like an absolute path (POSIX or Windows). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * Resolve a relative path against a cwd (`./`, `../`) without node:path, since this module
 * must import in the browser renderer.
 */
function resolvePath(base: string, rel: string): string {
  const baseParts = base.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  const relParts = rel.replace(/\\/g, '/').split('/');

  const parts = [...baseParts];
  for (const part of relParts) {
    if (part === '..') {
      if (parts.length > 1) parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }

  return parts.join('/');
}
