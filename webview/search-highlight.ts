import { buildMatcher, type SearchQuery } from '../src/content-search';

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Split a (trimmed) result line into highlighted/plain segments for rendering. Re-runs
 * the search's matcher against the display text rather than reusing the host's column —
 * which is relative to the UNtrimmed line. An invalid/blank query yields one plain segment.
 */
export function highlightSegments(lineText: string, query: SearchQuery): HighlightSegment[] {
  if (!query.text) return [{ text: lineText, hit: false }];
  const built = buildMatcher(query);
  if ('error' in built) return [{ text: lineText, hit: false }];
  const hits = built
    .match(lineText)
    .filter((h) => h.len > 0)
    .sort((a, b) => a.col - b.col);
  if (hits.length === 0) return [{ text: lineText, hit: false }];

  const segs: HighlightSegment[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.col < cursor) continue; // skip overlapping match
    if (h.col > cursor) segs.push({ text: lineText.slice(cursor, h.col), hit: false });
    segs.push({ text: lineText.slice(h.col, h.col + h.len), hit: true });
    cursor = h.col + h.len;
  }
  if (cursor < lineText.length) segs.push({ text: lineText.slice(cursor), hit: false });
  return segs;
}
