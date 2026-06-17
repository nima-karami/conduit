/**
 * Pure decision logic for dirty-close confirmation. All impure orchestration
 * (showing the dialog, invoking save, dispatching close) lives in the caller (app.tsx).
 */

/** Whether a close attempt for `path` requires a confirmation prompt. */
export function needsDirtyPrompt(isDirty: boolean): boolean {
  return isDirty;
}

/**
 * Filter doc ids down to those needing a dirty-close prompt. Takes a predicate
 * rather than the store directly so this stays pure.
 */
export function dirtyDocIds(ids: readonly string[], isDocDirty: (id: string) => boolean): string[] {
  return ids.filter((id) => isDocDirty(id));
}

export function dirtyCloseTitle(fileName: string): string {
  return `Unsaved changes in ${fileName}`;
}

export function dirtyCloseMessage(fileName: string): string {
  return `"${fileName}" has unsaved changes. Save before closing, or discard them?`;
}
