/**
 * Pure dirty-state logic for the editable code editor (I2). A buffer is "dirty"
 * when it differs from the last-saved (on-disk) baseline. This is the testable core
 * of the unsaved-changes indicator — kept free of React/Monaco so it can be unit
 * tested directly (buffer===disk -> clean; differs -> dirty; post-save -> clean).
 */

/** True when the current buffer differs from the on-disk baseline. */
export function isDirty(baseline: string, buffer: string): boolean {
  return baseline !== buffer;
}

/**
 * Compute the next dirty set after the buffer for `path` changes. A path whose
 * buffer matches its baseline is removed from the set; one that differs is added.
 * Returns a NEW set only when membership actually changed (so subscribers don't
 * re-render on no-op edits like typing then undoing back to the baseline).
 */
export function nextDirtySet(
  current: ReadonlySet<string>,
  path: string,
  baseline: string,
  buffer: string,
): Set<string> {
  const dirty = isDirty(baseline, buffer);
  if (dirty === current.has(path)) return current as Set<string>;
  const next = new Set(current);
  if (dirty) next.add(path);
  else next.delete(path);
  return next;
}
