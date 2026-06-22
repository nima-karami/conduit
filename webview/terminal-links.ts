/**
 * Pure path-token detection for the terminal link provider (D11). The xterm link-provider
 * wiring lives in terminal-pane.tsx and consumes this side-effect-free core.
 */

export interface PathToken {
  /** Resolved absolute path, forward-slash normalized. */
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
      path: resolved,
      line: lineNum,
      col: colNum,
      start,
      end,
    });
  }

  return tokens;
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
