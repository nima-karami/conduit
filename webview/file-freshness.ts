/**
 * file-freshness.ts — pure decision logic for K3 (fresh-file-content).
 *
 * Dirty-buffer protection: a fresh disk-read replaces the files-map entry only
 * when the path is CLEAN. The CodeViewer mount effect is keyed on `doc.content`,
 * so replacing the entry for a DIRTY path would re-run the effect, re-seed the
 * Monaco model from disk, and silently destroy the user's unsaved edits.
 */

/** Always true — never short-circuit on a cached copy (disk may have changed).
 *  The caller MUST keep the cached copy displayed (no flicker) until the reply. */
export function shouldRequestRead(_path: string, _hasCachedCopy: boolean): boolean {
  return true;
}

/** Replace the files-map entry ONLY when the path is CLEAN — see the dirty-buffer
 *  protection in the module header. */
export function shouldReplaceContent(_path: string, isDirty: boolean): boolean {
  return !isDirty;
}

/** Always true: the save path is authoritative — the just-written content is the
 *  new on-disk baseline, no round-trip needed. */
export function shouldUpdateAfterSave(_path: string): boolean {
  return true;
}
