/**
 * Which resolved path tokens become links on a set of logical lines: the one rule the xterm link
 * provider, Open Detected Link and the keyboard menu share (spec 2026-10-16-terminal-path-links
 * rows 40 and 60). Pure: the pane owns the buffer and the resolve cache.
 */
import type { TokenResolution } from '../src/path-resolve';
import type { PathToken } from './terminal-links';

/** What a clicked path link needs to open a candidate: its cache entry and position. */
export interface LinkTarget {
  key: string;
  scope: string;
  line?: number;
  col?: number;
}

/** A path token is its alts joined by NUL; no path char is NUL, so the split is exact. */
export const pathTokenKey = (tok: { alts: readonly string[] }): string => tok.alts.join('\0');

/** The text a path token's link covers, what it opens and how it is named. Row 40: the link
 *  covers the alt that resolved, and the `:l` printed after the longest alt is only that alt's. */
export function linkTargetOf(
  tok: PathToken,
  res: TokenResolution,
  key: string,
  scope: string,
): { span: { start: number; end: number }; link: LinkTarget; token: string } {
  const altIdx = res.alt ?? 0;
  const own = !tok.altEnds || altIdx === 0;
  return {
    span: { start: tok.start, end: tok.altEnds?.[altIdx] ?? tok.end },
    link: { key, scope, line: own ? tok.line : undefined, col: own ? tok.col : undefined },
    token: tok.alts[altIdx] ?? tok.raw,
  };
}

export interface TokenLine {
  /** 0-based buffer row the logical line starts on. */
  firstRow: number;
  /** Path tokens not overlapping a URL, in detection order. */
  tokens: readonly PathToken[];
  /** A cell's text offset: only the link covering it counts. */
  at?: number;
}

export interface PathLinkAt<R> {
  token: string;
  found: R;
  link: LinkTarget;
  firstRow: number;
  span: { start: number; end: number };
}

/** The distinct token keys to resolve, newest line first (`lines` is in screen order), so the
 *  output an agent just printed wins the cap (QA r1 D1). `total` counts every distinct token. */
export function capTokenKeys(
  lines: readonly TokenLine[],
  cap: number,
): { keys: string[]; truncated: boolean; total: number } {
  const all = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const tok of lines[i].tokens) all.add(pathTokenKey(tok));
  }
  const keys = [...all].slice(0, cap);
  return { keys, truncated: all.size > cap, total: all.size };
}

/** The links on `lines`, newest line first: a token with no candidate is plain text, and one
 *  overlapping an earlier link on its line is dropped (a word a longer path already took). */
export function pathLinksOf<R extends { res: TokenResolution }>(
  lines: readonly TokenLine[],
  resolved: ReadonlyMap<string, R>,
  scope: string,
): PathLinkAt<R>[] {
  const out: PathLinkAt<R>[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const { tokens, at, firstRow } = lines[i];
    const taken: Array<{ start: number; end: number }> = [];
    for (const tok of tokens) {
      const key = pathTokenKey(tok);
      const found = resolved.get(key);
      if (!found || found.res.candidates.length === 0) continue;
      const { span, link, token } = linkTargetOf(tok, found.res, key, scope);
      if (taken.some((p) => span.start < p.end && p.start < span.end)) continue;
      taken.push(span);
      if (at !== undefined && !(span.start <= at && at < span.end)) continue;
      out.push({ token, found, link, firstRow, span });
    }
  }
  return out;
}
