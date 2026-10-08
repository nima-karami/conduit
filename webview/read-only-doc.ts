import type { FileContentDTO } from '../src/protocol';
import { AUTO_SAVE_COPY } from './auto-save-copy';

export interface ReadOnlyState {
  /** The editor banner and its one-shot announcement. */
  banner: string;
  /** Why a save is refused, for the save store's toast. */
  refusal: string;
}

/** Why the editor won't take edits for this doc, or null when it is writable. One place, so the
 *  editor's readOnly, the save store's refusal and the banner can't disagree (spec
 *  2026-10-08-language-support §2.4–2.5). */
export function readOnlyState(
  doc: Pick<FileContentDTO, 'truncated' | 'window' | 'readOnlyReason' | 'binary'>,
): ReadOnlyState | null {
  if (doc.binary) return null;
  if (doc.truncated) {
    return doc.window === 'tail'
      ? { banner: AUTO_SAVE_COPY.tailBanner, refusal: AUTO_SAVE_COPY.tailFile }
      : { banner: AUTO_SAVE_COPY.partialBanner, refusal: AUTO_SAVE_COPY.partialFile };
  }
  if (doc.readOnlyReason === 'invalid-utf8')
    return { banner: AUTO_SAVE_COPY.invalidUtf8Banner, refusal: AUTO_SAVE_COPY.invalidUtf8Refusal };
  if (doc.readOnlyReason === 'mixed-eol')
    return { banner: AUTO_SAVE_COPY.mixedEolBanner, refusal: AUTO_SAVE_COPY.mixedEolRefusal };
  return null;
}
