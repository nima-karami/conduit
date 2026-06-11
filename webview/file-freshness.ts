/**
 * file-freshness.ts — pure decision logic for K3 (fresh-file-content).
 *
 * Answers two questions that arise when a file is opened or saved:
 *
 *   1. shouldRequestRead(path, hasCachedCopy)
 *      Always true: we always ask the host for a fresh copy. The caller keeps
 *      the cached copy visible until the host replies (no flicker), but we never
 *      skip the round-trip in case disk changed since the last read.
 *
 *   2. shouldReplaceContent(path, isDirty)
 *      A fresh disk-read arrives. Should the renderer update the files map for
 *      this path, which will push the new content to viewers?
 *      - CLEAN (not dirty): YES — render the fresh disk content. This is the
 *        whole point of the branch: a re-opened (or externally-changed) file
 *        shows its current on-disk content.
 *      - DIRTY (user has unsaved edits): NO — leave the map entry untouched.
 *        The CodeViewer mount effect is keyed on `doc.content`, so replacing the
 *        map entry would re-run the effect and re-seed the Monaco model from
 *        disk, silently destroying the user's unsaved edits (data loss). By
 *        NOT updating the map for a dirty path, `doc.content` is unchanged, the
 *        effect does not re-run, and the buffer survives. The markdown rendered
 *        view of a dirty doc keeps showing the in-buffer baseline rather than a
 *        disk copy the user hasn't seen — which is the coherent choice.
 *
 * Both functions are pure (no imports from the store) so they can be unit-tested
 * without any mocking.
 */

/**
 * Should the renderer post a `readFile` request to the host for `path`?
 *
 * Always true — we never short-circuit on a cached copy. The caller MUST keep
 * the cached copy displayed (no flicker) while waiting for the reply.
 *
 * The `_hasCachedCopy` parameter is accepted so callers have a discoverable
 * place to understand the decision, and so tests can document the behaviour.
 */
export function shouldRequestRead(_path: string, _hasCachedCopy: boolean): boolean {
  return true;
}

/**
 * When a fresh `fileContent` message arrives, should the renderer replace the
 * entry in the `files` map for `path`?
 *
 * `isDirty` reports whether the user has unsaved edits for this path (from
 * dirty-store).
 *
 * Rule: replace the map entry ONLY when the path is CLEAN. A dirty path keeps its
 * existing map entry so its `doc.content` does not change — this is what protects
 * the user's unsaved Monaco buffer, because CodeViewer's mount/seed effect is
 * keyed on `doc.content` and re-runs (re-seeding the model from disk) whenever it
 * changes. Skipping the update for dirty paths means the effect never re-runs and
 * the buffer survives. A clean path picks up the fresh disk content (the point of
 * the branch).
 */
export function shouldReplaceContent(_path: string, isDirty: boolean): boolean {
  return !isDirty;
}

/**
 * After a successful in-editor save, the saved content is known locally — no
 * round-trip needed. Should the renderer update the files map immediately?
 *
 * Always true. The save path is authoritative: the content was just written to
 * disk, so it is the new on-disk baseline.
 */
export function shouldUpdateAfterSave(_path: string): boolean {
  return true;
}
