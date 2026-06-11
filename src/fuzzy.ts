// Lightweight fuzzy subsequence matcher for the command palette. Not a full
// fzf — just enough to rank file paths / session names by a typed query.

export interface FuzzyResult<T> {
  item: T;
  score: number;
  positions: number[]; // matched character indices in the target (for highlight)
}

/**
 * Score `query` against `text` (case-insensitive subsequence). Returns null when
 * the query is not a subsequence. Higher score = better. Bonuses for consecutive
 * matches, matches after a separator (/, -, _, ., space), and matches at start.
 */
export function fuzzyScore(
  query: string,
  text: string,
): { score: number; positions: number[] } | null {
  if (!query) return { score: 1, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  const isSep = (c: string) =>
    c === '/' || c === '\\' || c === '-' || c === '_' || c === '.' || c === ' ';

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      positions.push(ti);
      score += 1;
      if (ti === prevMatch + 1) score += 5; // consecutive run
      if (ti === 0 || isSep(t[ti - 1])) score += 8; // word/segment start
      prevMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;

  // Prefer shorter targets and matches nearer the end of the path (filename).
  score -= text.length * 0.05;
  const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (positions.length && positions[0] > lastSlash) score += 6; // match is in the basename
  return { score, positions };
}

/** Filter + rank `items` by `query` using `key` to extract the searchable text. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (t: T) => string,
  limit = 50,
): FuzzyResult<T>[] {
  const out: FuzzyResult<T>[] = [];
  for (const item of items) {
    const m = fuzzyScore(query, key(item));
    if (m) out.push({ item, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
