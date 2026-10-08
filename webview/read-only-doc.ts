import type { FileContentDTO } from '../src/protocol';
import { AUTO_SAVE_COPY } from './auto-save-copy';

/** Why the editor won't take edits for this doc — its banner and one-shot announcement — or
 *  null when it is writable. One place, so the editor's readOnly, the save store's `writable` and
 *  the banner can't disagree (spec 2026-10-08-language-support §2.4–2.5). */
export function readOnlyNotice(
  doc: Pick<FileContentDTO, 'truncated' | 'window' | 'readOnlyReason' | 'binary'>,
): string | null {
  if (doc.binary) return null;
  if (doc.truncated)
    return doc.window === 'tail' ? AUTO_SAVE_COPY.tailBanner : AUTO_SAVE_COPY.partialBanner;
  if (doc.readOnlyReason === 'invalid-utf8') return AUTO_SAVE_COPY.invalidUtf8Banner;
  if (doc.readOnlyReason === 'mixed-eol') return AUTO_SAVE_COPY.mixedEolBanner;
  return null;
}
