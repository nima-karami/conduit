// The palette's per-session "Recent" list. A diff's scope is part of its identity, so the
// (Index) and (Working Tree) tabs of one file are separate entries.

import type { DiffTabScope } from '../src/protocol';
import { DIFF_SCOPE_SUFFIX } from './diff-tab-scope';

export interface RecentDoc {
  kind: 'file' | 'diff';
  path: string;
  diffScope?: DiffTabScope;
}

export const RECENT_DOC_LIMIT = 10;

const sameDoc = (a: RecentDoc, b: RecentDoc) =>
  a.kind === b.kind && a.path === b.path && (a.diffScope ?? 'all') === (b.diffScope ?? 'all');

export function pushRecentDoc(list: readonly RecentDoc[], entry: RecentDoc): RecentDoc[] {
  return [entry, ...list.filter((r) => !sameDoc(r, entry))].slice(0, RECENT_DOC_LIMIT);
}

export function recentPaletteId(entry: RecentDoc): string {
  return `recent:${entry.kind}:${entry.diffScope ?? 'all'}:${entry.path}`;
}

export function recentSubtitle(entry: RecentDoc): string | undefined {
  if (entry.kind === 'file') return undefined;
  return entry.diffScope ? `diff${DIFF_SCOPE_SUFFIX[entry.diffScope]}` : 'diff';
}
