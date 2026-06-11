/**
 * close-dirty.ts — pure decision logic for dirty-close confirmation.
 *
 * This module contains only pure functions with no side effects, no React, and no
 * imports from stores. All impure orchestration (showing the dialog, invoking save,
 * dispatching close) is done by the caller (app.tsx).
 */

/** Whether a close attempt for `path` requires a confirmation prompt. */
export function needsDirtyPrompt(isDirty: boolean): boolean {
  return isDirty;
}

/**
 * Filter a list of doc ids down to those that need a dirty-close prompt.
 * Accepts a predicate rather than the store directly so this stays pure.
 *
 * @param ids - The candidate doc ids to check.
 * @param isDocDirty - Pure predicate: given a doc id, is it dirty?
 * @returns The subset of ids that are dirty and need prompting.
 */
export function dirtyDocIds(ids: readonly string[], isDocDirty: (id: string) => boolean): string[] {
  return ids.filter((id) => isDocDirty(id));
}

/**
 * Build a human-readable title for the dirty-close dialog.
 * @param fileName - The base name of the file (not the full path).
 */
export function dirtyCloseTitle(fileName: string): string {
  return `Unsaved changes in ${fileName}`;
}

/**
 * Build the message body for the dirty-close dialog.
 * @param fileName - The base name of the file.
 */
export function dirtyCloseMessage(fileName: string): string {
  return `"${fileName}" has unsaved changes. Save before closing, or discard them?`;
}
