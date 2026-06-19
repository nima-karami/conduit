/**
 * Pure in-document find controller for the PDF viewer. No pdf.js dependency: it
 * operates on already-extracted per-page text so it is fully unit-testable.
 *
 * A page's text is the concatenation of its `getTextContent().items[].str`. A match
 * is a (pageIndex, start, end) range into that concatenated string; the viewer maps
 * the range back onto text-layer spans to paint the highlight. Matching is plain
 * case-insensitive substring (no regex) per the spec.
 */

export interface PdfMatch {
  /** 0-based page index. */
  page: number;
  /** Start offset into the page's concatenated text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/** A page's text as the viewer extracts it: the joined `str` of every text item. */
export type PageTexts = readonly string[];

/**
 * Find all matches of `query` across pages, in reading order (page, then position).
 * Empty/whitespace-only queries yield no matches. Overlapping matches are not
 * returned — search resumes after each match (standard find behaviour).
 */
export function findMatches(pages: PageTexts, query: string): PdfMatch[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const out: PdfMatch[] = [];
  for (let page = 0; page < pages.length; page++) {
    const hay = pages[page].toLowerCase();
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      out.push({ page, start: idx, end: idx + needle.length });
      from = idx + needle.length;
    }
  }
  return out;
}

/**
 * Stateful cursor over a match list. The viewer asks for `next()`/`prev()` to cycle
 * (wrapping at the ends) and reads `active()` to know which match to scroll to and
 * highlight. Re-running a query replaces the matches and resets the cursor.
 */
export class PdfFindController {
  private matches: PdfMatch[] = [];
  private index = -1;

  /** Re-run the search. Returns the (possibly empty) match list. The active match
   *  resets to the first result, or none when there are zero results. */
  search(pages: PageTexts, query: string): PdfMatch[] {
    this.matches = findMatches(pages, query);
    this.index = this.matches.length > 0 ? 0 : -1;
    return this.matches;
  }

  get count(): number {
    return this.matches.length;
  }

  /** 1-based position of the active match for display (`activeIndex / count`), or 0
   *  when there are no matches. */
  get activeOrdinal(): number {
    return this.index < 0 ? 0 : this.index + 1;
  }

  active(): PdfMatch | null {
    return this.index < 0 ? null : this.matches[this.index];
  }

  /** Advance to the next match, wrapping to the first after the last. No-op (returns
   *  null) when there are zero matches. */
  next(): PdfMatch | null {
    if (this.matches.length === 0) return null;
    this.index = (this.index + 1) % this.matches.length;
    return this.matches[this.index];
  }

  /** Step to the previous match, wrapping to the last before the first. */
  prev(): PdfMatch | null {
    if (this.matches.length === 0) return null;
    this.index = (this.index - 1 + this.matches.length) % this.matches.length;
    return this.matches[this.index];
  }
}

/**
 * Decode a `data:...;base64,<payload>` URL (or a bare base64 string) to a
 * `Uint8Array` suitable for `pdfjsLib.getDocument({ data })`. Lives here so it can be
 * unit-tested without the renderer/pdf.js. Uses `atob` in the browser; falls back to
 * Node's `Buffer` so the unit test (Node) can exercise the round-trip.
 */
export function base64ToUint8Array(input: string): Uint8Array {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
