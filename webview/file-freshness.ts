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
 *   2. shouldReplaceContent(path, isDirtyFn)
 *      A fresh disk-read arrives. Should the renderer update the files map for
 *      this path, which will push the new content to viewers?
 *      - CLEAN (not dirty): YES — render the fresh disk content.
 *      - DIRTY (user has unsaved edits): update the files map so the RENDERED
 *        VIEW (markdown) is consistent with saved disk state, but the Monaco
 *        buffer is NOT replaced (CodeViewer holds it in the model; the prop
 *        change does not re-create the model for an already-mounted editor
 *        because the mount effect depends on doc.path, not doc.content).
 *        So the answer is still YES — we update the map; CodeViewer is
 *        responsible for NOT re-seeding the model when it's dirty.
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
 * `isDirty` is a predicate that reports whether the user has unsaved edits for
 * this path (from dirty-store).
 *
 * Rule: ALWAYS replace the map entry. When the file is dirty, the map update
 * does NOT clobber the user's Monaco buffer (CodeViewer's mount effect is keyed
 * on `doc.path`, so a content change alone does not re-seed the model for an
 * already-mounted editor). The markdown rendered view of a dirty doc will show
 * the on-disk content rather than the in-buffer content; this is the safe choice
 * — showing saved disk state is never wrong, and a dirty markdown file being
 * viewed in render mode is an unusual edge case.
 *
 * The `isDirty` parameter is accepted so tests can document the dirty-buffer
 * contract and future callers can make a different choice if needed.
 */
export function shouldReplaceContent(_path: string, _isDirty: boolean): boolean {
  return true;
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
