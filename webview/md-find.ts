/**
 * Pure in-document find controller for the rendered markdown viewer. It operates on a
 * flattened text string (the TreeWalker join of the rendered container's text nodes) so
 * it is fully unit-testable without a DOM. The viewer maps each offset range back onto a
 * DOM `Range` to paint via the CSS Custom Highlight API. See spec 2026-07-01-markdown-search
 * §3, and pdf-find.ts (D5) — same shape, deliberately not shared to avoid coupling viewers.
 */

import { escapeRegExp } from '../src/content-search';

export interface MdMatch {
  /** Start offset into the flattened text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/**
 * Find all matches of `query` in `text`, in reading order. Plain case-insensitive
 * substring; empty/whitespace-only queries yield no matches. Overlapping matches are not
 * returned — search resumes after each hit (standard find behaviour).
 */
export function findTextMatches(text: string, query: string): MdMatch[] {
  if (query.trim().length === 0) return [];
  // Match case-insensitively over the ORIGINAL text via a regex `i` flag. Lowercasing
  // the haystack instead would corrupt offsets: `toLowerCase()` isn't length-preserving
  // for some code points (e.g. 'İ' U+0130 → two chars), shifting every later match off
  // the DOM ranges the viewer maps these offsets onto.
  const re = new RegExp(escapeRegExp(query), 'gi');
  const out: MdMatch[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
    // Non-overlapping: the global regex's lastIndex already resumes after the match.
    // Guard the (unreachable after trim) zero-width case so exec can't spin.
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * Stateful cursor over a match list. The viewer calls `next()`/`prev()` to cycle
 * (wrapping at the ends) and reads `active()` to know which range to scroll to and paint
 * as the current match. Re-running a query replaces the matches and resets the cursor.
 */
export class MdFindController {
  private matches: MdMatch[] = [];
  private index = -1;

  /** Re-run the search. Returns the (possibly empty) match list; the active match resets
   *  to the first result, or none when there are zero results. */
  search(text: string, query: string): MdMatch[] {
    this.matches = findTextMatches(text, query);
    this.index = this.matches.length > 0 ? 0 : -1;
    return this.matches;
  }

  get count(): number {
    return this.matches.length;
  }

  /** 1-based position of the active match for display (`activeOrdinal / count`), or 0
   *  when there are no matches. */
  get activeOrdinal(): number {
    return this.index < 0 ? 0 : this.index + 1;
  }

  active(): MdMatch | null {
    return this.index < 0 ? null : this.matches[this.index];
  }

  /** Advance to the next match, wrapping to the first after the last. No-op (returns
   *  null) when there are zero matches. */
  next(): MdMatch | null {
    if (this.matches.length === 0) return null;
    this.index = (this.index + 1) % this.matches.length;
    return this.matches[this.index];
  }

  /** Step to the previous match, wrapping to the last before the first. */
  prev(): MdMatch | null {
    if (this.matches.length === 0) return null;
    this.index = (this.index - 1 + this.matches.length) % this.matches.length;
    return this.matches[this.index];
  }
}
