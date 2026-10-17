/**
 * Pure path-token detection for the terminal link provider (D11). The xterm link-provider
 * wiring lives in terminal-pane.tsx and consumes this side-effect-free core. The rules are
 * docs/specs/2026-10-16-terminal-path-links.md §3.1; resolution is host-side (src/path-resolve.ts).
 */
import { langFromPath } from '../src/lang';
import { MAX_ALTS } from '../src/path-resolve';

export interface PathToken {
  /** === alts[0]. */
  raw: string;
  /** Forward-slashed raws the host tries in order, first hit wins (e.g. a route group's whole
   *  token, then its post-paren tail). 1..MAX_ALTS entries. */
  alts: string[];
  /** Row 40: where each alt ends (alts[i] spans start..altEnds[i]). Absent when every alt is the
   *  same printed text, start..end. */
  altEnds?: number[];
  /** 1-based, from a `:l`, `(l,c)`, `#Ll` or ` line l` suffix. */
  line?: number;
  col?: number;
  /** 0-based offsets in the logical line; end exclusive. */
  start: number;
  end: number;
}

// VS Code's link limits (spec §3.1): proven defaults, no local data.
export const MAX_LOGICAL_LINE = 2000;
export const MAX_PATH_TOKENS = 10;
export const MAX_TOKEN_LENGTH = 1024;

// Always junk at a path's tail; `)` is junk only when unbalanced (see trimTrailing).
const TRAILING_ALWAYS = new Set(['.', ',', ';', "'", '"', '`', '}', ']']);

// Path character class — every char that can appear inside a path segment.
// Explicitly excludes: colon (reserved for :line suffix), whitespace, quotes,
// angle brackets, pipes, glob chars (? *), ANSI bracket/escape chars ([\x1b).
// Backslash is allowed for Windows paths.
const PC = `[^\\s"'<>|?*:[\\]\\x00-\\x1f]`;

const PC_RE = new RegExp(`^${PC}$`);

/** Whether one character can sit inside a path segment (the PC class). */
export function isPathChar(ch: string): boolean {
  return PC_RE.test(ch);
}

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
  // The language registry maps csv to plaintext, but a printed `z.csv` is a file (spec row 44).
  'csv',
]);

// Extensionless names the language registry doesn't know as a language (spec §3.1); Makefile,
// Dockerfile and dotfiles like `.env` / `.gitignore` pass through langFromPath instead.
const EXTENSIONLESS = new Set(['README', 'LICENSE', 'CODEOWNERS', 'Justfile', 'Procfile']);

/** The extension (lowercase, no dot) of a bare filename, or '' if none. */
function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The false-positive gate for a separator-free token (`obj.foo`, `example.com`, `version 1.2`). */
function isFileLikeName(name: string): boolean {
  return (
    FILENAME_EXTS.has(fileExt(name)) ||
    EXTENSIONLESS.has(name) ||
    langFromPath(name) !== 'plaintext'
  );
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
    // A device path (`\\?\…`, `\\.\…`, `//?/…`, `//./…`), matched whole so that no fragment of it
    // is detected, then dropped (row 18: device forms are never links).
    `[\\\\/][\\\\/][?.][\\\\/][^\\s"'<>|*]*` +
    // POSIX absolute — not preceded by a digit, colon, or slash. This blocks:
    //   - `//` (double-slash as in `https://`)
    //   - `:path` (port-followed paths like `3000/api`)
    // It does NOT block letter-preceded paths, which covers ANSI-terminated
    // sequences like `\x1b[31m/src/main.ts` where the `m` precedes the path.
    `|(?<![0-9:/])/${PC}+(?:[/\\\\]${PC}*)*` +
    // Windows absolute — not preceded by alphanumeric
    `|(?<![A-Za-z0-9])[A-Za-z]:[/\\\\]${PC}*(?:[/\\\\]${PC}*)*` +
    // UNC `\\host\share\…` (row 18), never the `\\.\` device namespace (`\\?\` fails on PC).
    `|(?<![\\w\\\\/])\\\\\\\\(?!\\.[\\\\/])${SEG}+(?:[/\\\\]${SEG}+)+` +
    // Relative: ../ or ./
    `|\\.\\.\\/(?:${PC}+(?:[/]${PC}*)*)?` +
    `|\\./${PC}+(?:[/]${PC}*)*` +
    // Bare project-relative path WITH at least one separator (e.g. `src/core/theme/accent.ts`,
    // `webview/app.tsx`) — no leading `/`, `./`, `../`, or drive. The lookbehind keeps it from
    // matching the tail of a URL/longer token (`https://a/b` → `a/b` is preceded by `/`;
    // `user@host/p`, `pkg.name/x` blocked too). Resolved against the session cwd like any
    // relative path; the host `pathExists` check is the false-positive filter, so only tokens
    // that name a real file/dir ever render as links.
    // A backslash separator (`src\index.ts`, row 48) and a trailing-slash dir (`src/`, row 45)
    // count too.
    `|(?<![\\w./\\\\:~@[-])${SEG}+(?:(?:[/\\\\]${SEG}+)+[/\\\\]?|/)` +
    // Known extensionless names and dotfiles (rows 43); the gate in detectPathTokens filters
    // the dotfile shape through the language registry. Listed before the bare-filename
    // alternate so `.env.local` isn't split into a stem and a non-extension.
    `|(?<![\\w./\\\\:~@[-])(?:README|LICENSE|CODEOWNERS|Makefile|Dockerfile|Containerfile|Justfile|Procfile|Gemfile|Rakefile)(?![\\w.-])` +
    `|(?<![\\w./\\\\:~@[-])\\.[A-Za-z][\\w-]*(?:\\.[\\w-]+)*` +
    // Bare filename WITH an extension (single segment, no separator), e.g. `accent.ts`,
    // `README.md`. Same start lookbehind. The name is gated by isFileLikeName in
    // detectPathTokens (the regex just shapes the candidate); the host then suffix-searches
    // the session's roots for it.
    `|(?<![\\w./\\\\:~@[-])${SEG}+\\.[A-Za-z0-9]{1,8}` +
    `)` +
    // Optional :line[:col] suffix — note the path char class excludes `:` so
    // this cleanly separates from the path without ambiguity.
    `(?::(\\d+)(?::(\\d+))?)?`,
  'g',
);

// git's diff headers prefix both sides with `a/` and `b/` (spec row 49).
const DIFF_HEADER_RE = /^(?:diff --git |--- |\+\+\+ )/;
// tsc / MSBuild `(l,c)` and GitHub `#Ll[-Lm]` suffixes, inside the matched text (PC allows them).
const PAREN_POS_RE = /\((\d+)(?:,\s?(\d+))?\)$/;
const HASH_LINE_RE = /#L(\d+)(?:-L?\d+)?$/;
// ` line 42` / Python's `File "x.py", line 42`, just past the path.
const LINE_WORD_RE = /^"?,?\s+line\s+(\d+)/;
// A quoted span holding whitespace (row 39). The quote must open after a boundary and close
// before one, so apostrophes in prose (`don't … it's`) never pair up.
const QC = `[^"'<>|?*\\x00-\\x1f]`;
const QUOTED_RE = new RegExp(`(?<=^|[\\s(=:[])(["'])(${QC}*\\s${QC}*)\\1(?=$|[\\s),.;:\\]])`, 'g');

/** How many leading chars are wrapper, not path: backticks, then the opener of a first-segment
 *  `(` whose `)` is not in that segment (`Update(src/x.ts)`, `(src/x.ts)`, `[t](src/x.ts)`).
 *  A `(` after a separator is a real path char (`app/(group)/page.tsx`). `[` and `<` never reach
 *  here: the path char class excludes them. */
function leadingWrapper(text: string): number {
  let i = 0;
  while (text[i] === '`') i++;
  const rest = text.slice(i);
  const sep = rest.search(/[/\\]/);
  const first = sep < 0 ? rest : rest.slice(0, sep);
  const open = first.lastIndexOf('(');
  if (open >= 0 && !first.includes(')', open)) i += open + 1;
  return i;
}

/** Drop sentence punctuation and closers off the tail; a `)` only when unbalanced, so a route
 *  group or an `(l,c)` suffix keeps its own. */
function trimTrailing(text: string): string {
  let t = text;
  for (;;) {
    const last = t[t.length - 1];
    if (last === undefined) return t;
    if (TRAILING_ALWAYS.has(last)) {
      t = t.slice(0, -1);
      continue;
    }
    if (last === ')' && t.split(')').length > t.split('(').length) {
      t = t.slice(0, -1);
      continue;
    }
    return t;
  }
}

function isAbsoluteOrHome(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~/') || /^[A-Za-z]:\//.test(p);
}

/** Whether a forward-slashed path's shape is worth a host round-trip. */
function isLinkable(p: string, activeCwd: string | undefined): boolean {
  if (!p || p.length > MAX_TOKEN_LENGTH) return false;
  if (!p.includes('/') && !isFileLikeName(p)) return false;
  return isAbsoluteOrHome(p) || Boolean(activeCwd);
}

// The extension words, the token itself being the last alt.
const MAX_EXTENSION_WORDS = MAX_ALTS - 1;
const WORD_RE = new RegExp(` (${PC}+)`, 'y');
const LINE_COL_AFTER_RE = /^:(\d+)(?::(\d+))?/;
// The device namespaces (`//./`, `//?/`) and a bare `//`: never a link (row 18).
const DEVICE_RE = /^\/\/(?:[?.](?:\/|$)|$)/;

/** Row 40: an unquoted absolute path with spaces (`C:/Program Files/x/y.ts`) prints as a token
 *  cut at the first space. When that token's last segment has no extension — it reads as cut
 *  off — the next ≤ 3 space-separated words become longer alts, longest first; the host stops at
 *  the first that exists. A token that already ends in a file name is left alone, so prose after
 *  a path costs no stats. */
function extendOverSpaces(
  line: string,
  from: number,
  p: string,
): { alts: string[]; ends: number[]; line?: number; col?: number } | null {
  if (!(p.startsWith('/') || /^[A-Za-z]:\//.test(p)) || p.startsWith('//')) return null;
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (last === '' || last.includes('.')) return null;
  const joined: string[] = [];
  const ends: number[] = [];
  let text = p;
  let at = from;
  let cut = false;
  while (joined.length < MAX_EXTENSION_WORDS && !cut) {
    WORD_RE.lastIndex = at;
    const w = WORD_RE.exec(line);
    if (!w) break;
    const word = trimTrailing(w[1]);
    if (!word) break;
    cut = word.length < w[1].length;
    text = `${text} ${word.replace(/\\/g, '/')}`;
    at += 1 + word.length;
    if (text.length > MAX_TOKEN_LENGTH) break;
    joined.push(text);
    ends.push(at);
  }
  if (joined.length === 0) return null;
  const lc = cut ? null : LINE_COL_AFTER_RE.exec(line.slice(at));
  if (lc) ends[ends.length - 1] += lc[0].length;
  return {
    alts: joined.reverse(),
    ends: ends.reverse(),
    ...(lc ? { line: Number(lc[1]) } : {}),
    ...(lc?.[2] !== undefined ? { col: Number(lc[2]) } : {}),
  };
}

function quotedTokens(line: string, activeCwd: string | undefined): PathToken[] {
  const out: PathToken[] = [];
  QUOTED_RE.lastIndex = 0;
  for (;;) {
    const m = QUOTED_RE.exec(line);
    if (m === null) break;
    const content = m[2];
    if (content !== content.trim()) continue;
    const p = content.replace(/\\/g, '/');
    if (!p.includes('/')) continue;
    const last = p.slice(p.lastIndexOf('/') + 1);
    if (last !== '' && !isFileLikeName(last)) continue;
    if (!isLinkable(p, activeCwd)) continue;
    const start = m.index + 1;
    out.push({ raw: p, alts: [p], start, end: start + content.length });
  }
  return out;
}

/**
 * Detect path-like tokens in a (logical) terminal line: the first MAX_PATH_TOKENS by start.
 * `line` may contain ANSI codes — the path char class excludes `[` and `\x1b`, so ANSI
 * sequences terminate matches cleanly. Relative paths are skipped when `activeCwd` is absent.
 */
export function detectPathTokens(line: string, activeCwd: string | undefined): PathToken[] {
  if (line.length > MAX_LOGICAL_LINE) return [];
  const diffHeader = DIFF_HEADER_RE.test(line);
  const quoted = quotedTokens(line, activeCwd);
  const tokens: PathToken[] = [...quoted];
  PATH_RE.lastIndex = 0;

  for (;;) {
    const m = PATH_RE.exec(line);
    if (m === null) break;
    const lead = leadingWrapper(m[1]);
    let start = m.index + lead;
    const text = trimTrailing(m[1].slice(lead));
    if (!text) continue;

    let pathText = text;
    let lineNum: number | undefined;
    let colNum: number | undefined;
    let end = start + text.length;
    // A `:l` suffix only belongs to the path when nothing was trimmed between them.
    if (m[2] !== undefined && text.length === m[1].length - lead) {
      lineNum = Number(m[2]);
      colNum = m[3] !== undefined ? Number(m[3]) : undefined;
      end = m.index + m[0].length;
    } else {
      const pos = PAREN_POS_RE.exec(text) ?? HASH_LINE_RE.exec(text);
      if (pos) {
        pathText = text.slice(0, pos.index);
        lineNum = Number(pos[1]);
        colNum = pos[2] !== undefined ? Number(pos[2]) : undefined;
      } else {
        const word = LINE_WORD_RE.exec(line.slice(end));
        if (word) lineNum = Number(word[1]);
      }
    }

    let p = pathText.replace(/\\/g, '/');
    if (diffHeader && /^[ab]\//.test(p)) {
      p = p.slice(2);
      start += 2;
      if (lineNum === undefined) end = start + p.length;
    }
    if (DEVICE_RE.test(p)) continue;
    if (!isLinkable(p, activeCwd)) continue;
    if (quoted.some((q) => start < q.end && q.start < end)) continue;

    const alts = [p];
    let altEnds: number[] | undefined;
    const untrimmed = text.length === m[1].length - lead;
    const ext =
      untrimmed && lineNum === undefined && pathText === text
        ? extendOverSpaces(line, end, p)
        : null;
    if (ext) {
      alts.unshift(...ext.alts);
      altEnds = [...ext.ends, end];
      end = ext.ends[0];
      lineNum = ext.line;
      colNum = ext.col;
    } else {
      // A route group (`app/(group)/page.tsx`) may also be a printed suffix of a longer path.
      const close = p.lastIndexOf(')/');
      if (close >= 0 && p.lastIndexOf('(', close) >= 0) {
        const tail = p.slice(close + 2);
        if (tail && isLinkable(tail, activeCwd)) alts.push(tail);
      }
    }

    tokens.push({
      raw: alts[0],
      alts,
      ...(altEnds ? { altEnds } : {}),
      line: lineNum,
      col: colNum,
      start,
      end,
    });
  }

  tokens.sort((a, b) => a.start - b.start);
  return tokens.slice(0, MAX_PATH_TOKENS);
}

/** An http(s)/file URL span in a terminal line (0-based `start`, exclusive `end`, like PathToken). */
export interface UrlToken {
  /** The URL text as printed, with surrounding-prose punctuation trimmed off the tail. */
  raw: string;
  start: number;
  end: number;
}

// An http(s)/file URL: scheme + `//` + a run of non-whitespace. The tail is over-captured on
// purpose (it grabs any trailing prose punctuation too) and then trimmed in detectUrlTokens —
// balance-aware trimming is easier as a post-step than as a regex. Case-insensitive scheme; the
// leading lookbehind keeps it from matching inside a longer word (`shttp://…`).
const URL_RE = /(?<![A-Za-z0-9])(?:https?|file):\/\/\S+/gi;

// Tail chars that are sentence/quote punctuation, never part of a URL — always trimmed.
const URL_TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`']);

// Closing delimiters mapped to their opener. A trailing closer is trimmed only when it's
// unbalanced within the captured URL (more closers than openers) — so a wrapper paren
// (`(http://x)` → count 1>0, trim) goes but a URL's own balanced parens
// (`…/Foo_(bar)` → 1==1, keep) stay. `>` pairs with the `<…>` angle-wrapper convention.
const URL_CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/**
 * Detect http(s)/file URL spans in a terminal line, in start order. Pure shape detection: URLs
 * need no filesystem check, so unlike paths/commits these render as links with no host round-trip.
 * The link provider gives path/commit detection precedence-avoidance by dropping any path/commit
 * span that overlaps a URL span (a `file://`/`http(s)` token is a URL, not a path).
 */
export function detectUrlTokens(text: string): UrlToken[] {
  const tokens: UrlToken[] = [];
  URL_RE.lastIndex = 0;
  for (;;) {
    const m = URL_RE.exec(text);
    if (m === null) break;
    let url = m[0];
    for (;;) {
      const last = url[url.length - 1];
      if (URL_TRAILING_PUNCT.has(last)) {
        url = url.slice(0, -1);
        continue;
      }
      const opener = URL_CLOSERS[last];
      if (opener) {
        const closes = url.split(last).length - 1;
        const opens = url.split(opener).length - 1;
        if (closes > opens) {
          url = url.slice(0, -1);
          continue;
        }
      }
      break;
    }
    // Trimming can leave a bare scheme (`http://` with only punctuation after it) — drop those.
    if (!/:\/\/\S/.test(url)) continue;
    tokens.push({ raw: url, start: m.index, end: m.index + url.length });
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
