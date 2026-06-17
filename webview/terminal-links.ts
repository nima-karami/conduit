/**
 * Pure path-token detection for the terminal link provider (D11).
 *
 * Given a line of terminal text and the session's current working directory,
 * returns matched path tokens with their character spans and optional
 * line/column positions. This module has no side-effects — it is the
 * unit-testable core; the xterm link-provider wiring lives in
 * terminal-pane.tsx and consumes it.
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
    `)` +
    // Optional :line[:col] suffix — note the path char class excludes `:` so
    // this cleanly separates from the path without ambiguity.
    `(?::(\\d+)(?::(\\d+))?)?`,
  'g',
);

/**
 * Detect path-like tokens in a terminal line.
 *
 * @param line      The raw terminal line text (may contain ANSI codes; the
 *                  regex skips them because `[` and `\x1b` are excluded from
 *                  the path character class, so ANSI sequences terminate any
 *                  match cleanly).
 * @param activeCwd The session's current working directory for resolving
 *                  relative paths. When absent, relative paths are skipped.
 * @returns         An array of matched tokens, sorted by start offset.
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

    // Strip trailing punctuation from the path portion.
    const junk = TRAILING_JUNK.exec(rawPath);
    const cleanPath = junk ? rawPath.slice(0, junk.index) : rawPath;
    if (!cleanPath) continue;

    // Resolve relative paths; skip when no cwd is available.
    let resolved: string;
    if (isAbsolutePath(cleanPath)) {
      // Normalize backslashes to forward slashes.
      resolved = cleanPath.replace(/\\/g, '/');
    } else {
      if (!activeCwd) continue;
      resolved = resolvePath(activeCwd, cleanPath);
    }

    const lineNum = rawLineNum !== undefined ? parseInt(rawLineNum, 10) : undefined;
    const colNum = rawColNum !== undefined ? parseInt(rawColNum, 10) : undefined;

    const start = m.index;
    // End: covers the full match including any :line:col suffix.
    const matchEnd = m.index + m[0].length;
    // When trailing junk was stripped and there's no numeric suffix,
    // shrink end to the clean path.
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
 * Minimal path resolver for relative paths against a cwd.
 * Handles `./` and `../` prefixes without importing node:path (this module
 * must be importable in the browser renderer).
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
