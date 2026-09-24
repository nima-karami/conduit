import { isStaleResponse, type SearchFileResult } from './content-search';
import { folderKey } from './folder-key';
import { countNoun } from './menu-selection';
import type { FolderSectionModel } from './session-sections';

const STR = {
  timedOut: 'Search timed out. Try again.',
  partial: 'Partial (limit reached)',
};

export interface FolderReply {
  results: SearchFileResult[];
  truncated: boolean;
  error?: string;
}

/** One search across every present folder under one requestId (spec §2.9, D11). */
export interface MultiSearchState {
  requestId: number;
  /** Folder keys, folder order. */
  expected: readonly string[];
  replies: Readonly<Record<string, FolderReply>>;
  timedOut: boolean;
}

export const IDLE_SEARCH: MultiSearchState = {
  requestId: 0,
  expected: [],
  replies: {},
  timedOut: false,
};

/** Search's request-builder input: the non-missing sections, in order (L9). */
export function searchableFolders(sections: readonly FolderSectionModel[]): FolderSectionModel[] {
  return sections.filter((s) => !s.missing);
}

export function startMultiSearch(
  requestId: number,
  folderKeys: readonly string[],
): MultiSearchState {
  return { requestId, expected: [...folderKeys], replies: {}, timedOut: false };
}

/** Stale requestId or folderKey(msg.root) ∉ expected → s unchanged (same object). */
export function acceptFolderReply(
  s: MultiSearchState,
  msg: {
    requestId: number;
    root: string;
    results: SearchFileResult[];
    truncated: boolean;
    error?: string;
  },
): MultiSearchState {
  const key = folderKey(msg.root);
  if (isStaleResponse(msg.requestId, s.requestId) || !s.expected.includes(key)) return s;
  const reply: FolderReply = {
    results: msg.results,
    truncated: msg.truncated,
    ...(msg.error !== undefined ? { error: msg.error } : {}),
  };
  return { ...s, replies: { ...s.replies, [key]: reply } };
}

/** Folders left the session mid-flight: expected ∩ keys; their replies dropped. */
export function retainFolders(s: MultiSearchState, keys: readonly string[]): MultiSearchState {
  const expected = s.expected.filter((k) => keys.includes(k));
  if (expected.length === s.expected.length) return s;
  const replies: Record<string, FolderReply> = {};
  for (const k of expected) if (s.replies[k]) replies[k] = s.replies[k];
  return { ...s, expected, replies };
}

export function timeOutSearch(s: MultiSearchState): MultiSearchState {
  return s.timedOut ? s : { ...s, timedOut: true };
}

export function isSearching(s: MultiSearchState): boolean {
  return !s.timedOut && s.expected.some((k) => !s.replies[k]);
}

export interface SearchFolderGroup {
  key: string;
  results: SearchFileResult[];
  resultCount: number;
  note?: string;
}

// A name-only hit (no content matches) counts as one result, as the single-folder summary does.
const countOf = (results: readonly SearchFileResult[]) =>
  results.reduce((n, f) => n + (f.matches.length || 1), 0);

/** Expected order; only groups with ≥1 result or a note. */
export function searchFolderGroups(s: MultiSearchState): SearchFolderGroup[] {
  return s.expected.flatMap((key) => {
    const r = s.replies[key];
    const note = r
      ? (r.error ?? (r.truncated ? STR.partial : undefined))
      : s.timedOut
        ? STR.timedOut
        : undefined;
    const results = r?.results ?? [];
    if (results.length === 0 && note === undefined) return [];
    return [{ key, results, resultCount: countOf(results), ...(note ? { note } : {}) }];
  });
}

export function multiSearchSummary(groups: readonly SearchFolderGroup[]): string {
  const withResults = groups.filter((g) => g.results.length > 0);
  const n = withResults.reduce((acc, g) => acc + g.resultCount, 0);
  const m = withResults.reduce((acc, g) => acc + g.results.length, 0);
  return `${countNoun(n, 'result', 'results')} in ${countNoun(m, 'file', 'files')} · ${countNoun(withResults.length, 'folder', 'folders')}`;
}
