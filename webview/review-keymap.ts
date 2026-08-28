/**
 * The Review surface's scoped keyboard model (spec 2026-08-27-review-supercharge §2 Lane B).
 * DOM-free: `reviewActionFor` takes the four modifier flags and a `key`, and the cursor walk is
 * a fold over `{ path, hunkCount }` — so the whole model is unit-testable in Node exactly like
 * review-window.ts, and the React layer only owns focus, scrolling and propagation.
 *
 * Keys this lane does NOT bind: `c` (Lane F).
 */

export type ReviewAction =
  | 'nextHunk'
  | 'prevHunk'
  | 'nextFile'
  | 'prevFile'
  | 'toggleReviewed'
  | 'openHunk'
  | 'expandAll'
  | 'collapseAll'
  | 'stageHunk'
  | 'discardHunk'
  | 'openSearch'
  | 'toggleHelp';

/** The subset of a KeyboardEvent the mapping reads. */
export interface ReviewKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ACTIONS: Readonly<Record<string, ReviewAction>> = {
  j: 'nextHunk',
  k: 'prevHunk',
  J: 'nextFile',
  K: 'prevFile',
  m: 'toggleReviewed',
  o: 'openHunk',
  Enter: 'openHunk',
  e: 'expandAll',
  E: 'collapseAll',
  s: 'stageHunk',
  d: 'discardHunk',
  '/': 'openSearch',
  '?': 'toggleHelp',
};

/** What the `?` panel prints. Kept beside the table so the two can't drift. */
export const REVIEW_KEY_HELP: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'j / k', description: 'Next / previous change' },
  { keys: 'J / K', description: 'Next / previous file' },
  { keys: 'm', description: 'Mark the current file reviewed' },
  { keys: 'o / Enter', description: 'Open the current change in the editor' },
  { keys: 's / d', description: 'Stage / discard the current change' },
  { keys: 'e / Shift+E', description: 'Expand / collapse every file' },
  { keys: '/ or Mod+F', description: 'Search the changed lines' },
  { keys: '?', description: 'Show this list' },
  { keys: 'Esc', description: 'Close search, then this list, then Review' },
];

export function reviewActionFor(e: ReviewKeyEvent): ReviewAction | null {
  // The one modified binding this surface takes: VS Code's find combo, alongside the bare `/`.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F'))
    return 'openSearch';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // `key` already encodes shift for letters (`J` is the shifted `j`), so the only shifted press
  // left to reject is one of an UNSHIFTED binding — Shift+Enter, Shift+m.
  if (e.shiftKey && (e.key === 'Enter' || /^[a-z]$/.test(e.key))) return null;
  return ACTIONS[e.key] ?? null;
}

/** One file as the cursor sees it. `hunkCount` 0 ⇒ binary, or a diff that hasn't loaded. */
export interface ReviewFileHunks {
  path: string;
  hunkCount: number;
}

/** `hunkIndex` -1 ⇒ the file is current but has no hunk to point at. */
export interface HunkRef {
  fileIndex: number;
  hunkIndex: number;
}

const atFile = (files: readonly ReviewFileHunks[], i: number): HunkRef => ({
  fileIndex: i,
  hunkIndex: files[i].hunkCount > 0 ? 0 : -1,
});

export function firstRef(files: readonly ReviewFileHunks[]): HunkRef | null {
  if (files.length === 0) return null;
  for (let i = 0; i < files.length; i++)
    if (files[i].hunkCount > 0) return { fileIndex: i, hunkIndex: 0 };
  return atFile(files, 0);
}

/** Bring a ref back inside a list that has since changed (files added, removed, reordered). */
export function clampRef(ref: HunkRef | null, files: readonly ReviewFileHunks[]): HunkRef | null {
  if (!ref || files.length === 0) return null;
  const fileIndex = Math.min(Math.max(ref.fileIndex, 0), files.length - 1);
  const count = files[fileIndex].hunkCount;
  if (count <= 0) return { fileIndex, hunkIndex: -1 };
  return { fileIndex, hunkIndex: Math.min(Math.max(ref.hunkIndex, 0), count - 1) };
}

/** The next/previous file index that has at least one hunk, or -1 when none does. */
function stepToHunkFile(files: readonly ReviewFileHunks[], from: number, delta: 1 | -1): number {
  const n = files.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + delta * step) % n) + n) % n;
    if (files[i].hunkCount > 0) return i;
  }
  return -1;
}

export function nextHunk(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  const count = files[cur.fileIndex].hunkCount;
  if (cur.hunkIndex >= 0 && cur.hunkIndex + 1 < count) {
    return { fileIndex: cur.fileIndex, hunkIndex: cur.hunkIndex + 1 };
  }
  const i = stepToHunkFile(files, cur.fileIndex, 1);
  // A single hunk in the whole changeset wraps to itself; nothing to walk at all stays put.
  return i < 0 ? cur : { fileIndex: i, hunkIndex: 0 };
}

export function prevHunk(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  if (cur.hunkIndex > 0) return { fileIndex: cur.fileIndex, hunkIndex: cur.hunkIndex - 1 };
  const i = stepToHunkFile(files, cur.fileIndex, -1);
  return i < 0 ? cur : { fileIndex: i, hunkIndex: Math.max(0, files[i].hunkCount - 1) };
}

function stepFile(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
  delta: 1 | -1,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  const n = files.length;
  return atFile(files, (((cur.fileIndex + delta) % n) + n) % n);
}

export function nextFile(files: readonly ReviewFileHunks[], current: HunkRef | null) {
  return stepFile(files, current, 1);
}

export function prevFile(files: readonly ReviewFileHunks[], current: HunkRef | null) {
  return stepFile(files, current, -1);
}

/**
 * Follow the scroller: once the top-visible card is a DIFFERENT file from the one the cursor
 * sits in, the cursor moves to it. Scrolling is how the user says "I'm looking at this now",
 * and a ring left three files behind would make the next `j` jump somewhere unexpected.
 */
export function syncToAnchor(
  current: HunkRef | null,
  files: readonly ReviewFileHunks[],
  anchorIndex: number,
): HunkRef | null {
  if (anchorIndex < 0 || anchorIndex >= files.length) return clampRef(current, files);
  if (current && current.fileIndex === anchorIndex) return clampRef(current, files);
  return atFile(files, anchorIndex);
}

/** Controls that own Enter (and Space) themselves. */
export const INTERACTIVE_TARGET = 'button, a, input, select, textarea, [role="button"]';

/**
 * Whether the keymap may consume this key, given what has focus. Enter belongs to the focused
 * control: the reveal effect parks focus on a hunk header or a card toggle, so swallowing Enter
 * there would stop "Mark reviewed", "Split", "Open file" and the card collapse toggle working at
 * all (spec 2026-08-27-review-supercharge §9). Letters are unaffected — a button does nothing
 * with `j`.
 */
export function reviewActionAllowed(
  action: ReviewAction,
  key: string,
  targetIsInteractive: boolean,
): boolean {
  return !(action === 'openHunk' && key === 'Enter' && targetIsInteractive);
}
