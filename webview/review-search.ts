/**
 * Search-in-diff for the Review surface (spec 2026-08-27-review-supercharge §2 Lane C).
 *
 * The corpus is the LOADED `FileReview` data, never the rendered DOM: a collapsed card, a row
 * past the 40-row cap and a card the windower hasn't mounted all hold matches the user must be
 * able to reach. Folded unchanged context is excluded by construction — it lives in
 * `FileReview.folds`, and only `hunks` is read here.
 *
 * DOM-free so the whole model is unit-testable in Node, exactly like review-window.ts and
 * review-keymap.ts; the React layer owns painting, revealing and focus.
 */

import { escapeRegExp } from '../src/content-search';
import { fuzzyScore } from '../src/fuzzy';
import type { FileReview } from '../src/review-hunks';

/** Match-list ceiling (spec §5 Budgets). Past it the bar reports "2000+". */
export const MAX_REVIEW_MATCHES = 2000;

export interface ReviewSearchFile {
  path: string;
  /** null ⇒ this file's diff hasn't loaded yet (the working source streams per card). */
  review: FileReview | null;
}

export interface ReviewMatch {
  /** Index into the searched file list — the same order Review renders its cards in. */
  fileIndex: number;
  path: string;
  hunkIndex: number;
  /** The line's stable per-file `seq`, which is also the row's `data-seq` attribute. */
  seq: number;
  /** Start offset into the line's text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

export interface ReviewSearchResult {
  matches: ReviewMatch[];
  /** True when `MAX_REVIEW_MATCHES` truncated the list. */
  capped: boolean;
  /** Files whose diff has loaded — the part of `total` actually searched. */
  loaded: number;
  total: number;
}

export interface ReviewSearchOptions {
  caseSensitive?: boolean;
  limit?: number;
}

const EMPTY: ReviewSearchResult = { matches: [], capped: false, loaded: 0, total: 0 };

/**
 * Every match of `query` across the loaded files, in card order then file order. Plain
 * substring — no regex (spec §2 Lane C) — matched over the ORIGINAL text via a regex flag
 * rather than a lowercased haystack, which is not length-preserving for every code point and
 * would shift the offsets the highlighter maps onto DOM ranges (see md-find.ts).
 */
export function collectMatches(
  files: readonly ReviewSearchFile[],
  query: string,
  opts: ReviewSearchOptions = {},
): ReviewSearchResult {
  const limit = opts.limit ?? MAX_REVIEW_MATCHES;
  let loaded = 0;
  for (const f of files) if (f.review) loaded++;
  if (query.length === 0) return { ...EMPTY, loaded, total: files.length };

  const re = new RegExp(escapeRegExp(query), opts.caseSensitive ? 'g' : 'gi');
  const matches: ReviewMatch[] = [];
  let capped = false;

  for (let fileIndex = 0; fileIndex < files.length && !capped; fileIndex++) {
    const { path, review } = files[fileIndex];
    if (!review) continue;
    for (let hunkIndex = 0; hunkIndex < review.hunks.length && !capped; hunkIndex++) {
      for (const line of review.hunks[hunkIndex].lines) {
        re.lastIndex = 0;
        for (let m = re.exec(line.text); m !== null; m = re.exec(line.text)) {
          matches.push({
            fileIndex,
            path,
            hunkIndex,
            seq: line.seq,
            start: m.index,
            end: m.index + m[0].length,
          });
          if (matches.length >= limit) {
            capped = true;
            break;
          }
        }
        if (capped) break;
      }
    }
  }
  return { matches, capped, loaded, total: files.length };
}

/** Wrapping step over a match list. Returns -1 when there is nothing to step through. */
export function stepMatch(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return dir === 1 ? 0 : count - 1;
  return (((index + dir) % count) + count) % count;
}

/** `n / m`, with the cap rendered as "2000+" so a truncated list never claims to be exact. */
export function matchCountLabel(ordinal: number, count: number, capped: boolean): string {
  return `${ordinal} / ${count}${capped ? '+' : ''}`;
}

/**
 * "in N of M files" — shown only while part of the changeset is still unloaded, which is the
 * working source's streaming state. Null means "this is everything", so the bar says nothing.
 */
export function partialLabel(loaded: number, total: number): string | null {
  return loaded >= total ? null : `in ${loaded} of ${total} files`;
}

/** Fuzzy path filter for the navigator field. An empty query matches everything. */
export function fileFilterMatches(path: string, query: string): boolean {
  const q = query.trim();
  if (q === '') return true;
  return fuzzyScore(q, path) !== null;
}
