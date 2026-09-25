import { folderKey } from './folder-key';
import type { SearchHit } from './protocol';
import type { FolderSectionModel } from './session-sections';

/** folderKey → that folder's `searchFiles` hits (spec §2.10). */
export type FolderCorpus = Readonly<Record<string, SearchHit[]>>;

/** Present folders with no corpus entry yet — what the palette asks the host for. */
export function foldersToRequest(folders: readonly string[], corpus: FolderCorpus): string[] {
  return folders.filter((f) => !(folderKey(f) in corpus));
}

/** A reply for a root no longer in the session leaves the corpus unchanged (same object). */
export function acceptSearchResults(
  corpus: FolderCorpus,
  msg: { root: string; results: SearchHit[] },
  folders: readonly string[],
): FolderCorpus {
  const key = folderKey(msg.root);
  if (!folders.some((f) => folderKey(f) === key)) return corpus;
  return { ...corpus, [key]: msg.results };
}

/** Drops folders that left the session; the same object when nothing drops. */
export function pruneCorpus(corpus: FolderCorpus, folders: readonly string[]): FolderCorpus {
  const keep = new Set(folders.map(folderKey));
  const keys = Object.keys(corpus);
  if (keys.every((k) => keep.has(k))) return corpus;
  return Object.fromEntries(keys.filter((k) => keep.has(k)).map((k) => [k, corpus[k]]));
}

export interface QuickOpenFileRow {
  hit: SearchHit;
  tag?: { label: string; tone: 'accent' | 'neutral'; title: string };
}

/** Folder order, then host order. The folder tag appears only when the session has more than
 *  one folder, so a single-folder session's rows are unchanged (AC12). */
export function quickOpenFileRows(
  corpus: FolderCorpus,
  sections: readonly FolderSectionModel[],
): QuickOpenFileRow[] {
  const tagged = sections.length > 1;
  return sections
    .filter((s) => !s.missing)
    .flatMap((s) =>
      (corpus[s.key] ?? []).map((hit) =>
        tagged
          ? {
              hit,
              tag: {
                label: s.label,
                tone: s.kind === 'home' ? ('accent' as const) : ('neutral' as const),
                title: s.path,
              },
            }
          : { hit },
      ),
    );
}
