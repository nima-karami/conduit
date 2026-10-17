import { folderKey } from './folder-key';
import type { SearchHit } from './protocol';
import type { FolderSectionModel } from './session-sections';

/** folderKey → that folder's `searchFiles` hits (spec §2.10). */
export type FolderCorpus = Readonly<Record<string, SearchHit[]>>;

/** Present folders with no corpus entry yet, or whose entry predates a `fileIndexChanged`
 *  (`stale`, folderKeys) — what the palette asks the host for. */
export function foldersToRequest(
  folders: readonly string[],
  corpus: FolderCorpus,
  stale: ReadonlySet<string> = new Set(),
): string[] {
  return folders.filter((f) => !(folderKey(f) in corpus) || stale.has(folderKey(f)));
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

/**
 * Which folders the palette asks the host for, one ask in flight per folder. A
 * `fileIndexChanged` that lands while a folder's ask is in flight marks it dirty instead of
 * firing another uncached `ls-files` beside it; its reply then frees it for one follow-up,
 * however many signals came meanwhile (search-scope review r2 SF2).
 */
export class CorpusRequests {
  /** Asked during this palette session (in flight or answered). */
  private readonly asked = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Entries a `fileIndexChanged` outdated: asked again past the host's cache. */
  private readonly stale = new Set<string>();
  /** Outdated again while in flight. */
  private readonly dirty = new Set<string>();

  /** The asks to post now for the present `folders`, claimed as in flight. */
  next(folders: readonly string[], corpus: FolderCorpus): { root: string; fresh: boolean }[] {
    const out: { root: string; fresh: boolean }[] = [];
    for (const root of foldersToRequest(folders, corpus, this.stale)) {
      const k = folderKey(root);
      if (this.asked.has(k) || this.inFlight.has(k)) continue;
      this.asked.add(k);
      this.inFlight.add(k);
      out.push({ root, fresh: this.stale.delete(k) });
    }
    return out;
  }

  /** The host's index changed under these cached folders. */
  invalidate(keys: Iterable<string>): void {
    for (const k of keys) {
      this.stale.add(k);
      if (this.inFlight.has(k)) this.dirty.add(k);
      else this.asked.delete(k);
    }
  }

  /** A reply for `root` landed. */
  settle(root: string): void {
    const k = folderKey(root);
    this.inFlight.delete(k);
    if (this.dirty.delete(k)) this.asked.delete(k);
  }

  /** The palette closed. A reply still in flight is dropped from the books, so a reply the host
   *  never sends cannot pin a folder: the next open asks again. */
  close(): void {
    this.asked.clear();
    this.inFlight.clear();
    this.dirty.clear();
  }
}
