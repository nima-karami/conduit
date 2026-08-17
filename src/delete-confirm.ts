/**
 * Copy for the Explorer's delete flow: the Recycle-Bin confirm, the aggregated permanent-delete
 * fallback, and the live-region outcome. Pure so the wording (and the plural forms) are pinned by
 * unit tests. See docs/specs/2026-08-16-selection-aware-context-menus.md §4.3.
 *
 * The single-target strings are the ones that shipped before bulk delete existed and must stay
 * verbatim, so both builders branch on N === 1 rather than degrading the bulk form.
 */

import { countNoun } from './menu-selection';

/** The confirm is a fixed-size modal with no scroll region (§16 #3). */
const NAME_LIST_CAP = 5;

/** What one delete pass actually did; the Explorer refreshes and announces from it. */
export interface DeleteOutcome {
  deleted: string[];
  failed: string[];
}

function baseName(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? p
  );
}

function nameListing(paths: readonly string[]): string {
  const shown = paths.slice(0, NAME_LIST_CAP).map(baseName);
  const rest = paths.length - shown.length;
  return `\n\n${[...shown, ...(rest > 0 ? [`…and ${rest} more`] : [])].join('\n')}`;
}

export function trashConfirmMessage(paths: readonly string[]): string {
  if (paths.length === 1) return `Move "${baseName(paths[0])}" to the Recycle Bin?`;
  return `Move ${countNoun(paths.length, 'item', 'items')} to the Recycle Bin?${nameListing(paths)}`;
}

export function permanentConfirmMessage(paths: readonly string[]): string {
  if (paths.length === 1) {
    return `Couldn't move "${baseName(paths[0])}" to the Recycle Bin. Delete it permanently? This cannot be undone.`;
  }
  return `Couldn't move ${countNoun(paths.length, 'item', 'items')} to the Recycle Bin. Delete permanently? This cannot be undone.${nameListing(paths)}`;
}

/** Empty when there is nothing to say, so the caller can skip announcing. */
export function deleteOutcomeAnnouncement(deleted: number, failed: number): string {
  if (failed > 0) return `${deleted} deleted, ${failed} failed`;
  if (deleted === 0) return '';
  return `Deleted ${countNoun(deleted, 'item', 'items')}`;
}
