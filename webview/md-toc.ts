/**
 * Pure core for the rendered-Markdown document outline (table of contents).
 *
 * Kept out of the component so the entry-building and scroll-spy selection are
 * unit-testable without a DOM (mirrors md-reveal.ts's findBlockForLine). The
 * component scrapes headings from the rendered DOM and feeds them here.
 */

export interface HeadingInfo {
  level: number; // 1..4
  id: string;
  text: string;
}

export interface TocEntry {
  id: string;
  text: string;
  level: number;
  /** Indentation depth relative to the document's shallowest heading (0-based). */
  depth: number;
}

/** Minimum headings before the outline is offered — short docs don't need one. */
export const TOC_MIN_HEADINGS = 3;

/**
 * Build outline entries from scraped headings: drop those with no id or empty text,
 * and compute `depth` relative to the shallowest remaining heading so indentation is
 * stable even when a doc starts at h2/h3.
 */
export function buildTocEntries(headings: HeadingInfo[]): TocEntry[] {
  const usable = headings.filter((h) => h.id && h.text.trim() !== '');
  if (usable.length === 0) return [];
  const minLevel = Math.min(...usable.map((h) => h.level));
  return usable.map((h) => ({
    id: h.id,
    text: h.text.trim(),
    level: h.level,
    depth: h.level - minLevel,
  }));
}

/**
 * Scroll-spy selection: index of the last heading whose top is at/above
 * `scrollTop + offset` (the reading line), or −1 when scrolled above the first.
 * `tops` are heading offsets within the scroll container, ascending.
 */
export function pickActiveIndex(tops: number[], scrollTop: number, offset: number): number {
  const line = scrollTop + offset;
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) {
      active = i;
    } else {
      break;
    }
  }
  // Before the first heading, still treat the first as active once any of it is in
  // view (avoids a "nothing selected" flash at the very top).
  if (active === -1 && tops.length > 0) return 0;
  return active;
}
