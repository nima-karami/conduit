import { describe, expect, it } from 'vitest';
import {
  clampRef,
  firstRef,
  type HunkRef,
  nextFile,
  nextHunk,
  prevFile,
  prevHunk,
  REVIEW_KEY_HELP,
  type ReviewFileHunks,
  reviewActionAllowed,
  reviewActionFor,
  syncToAnchor,
} from '../../webview/review-keymap';

const press = (
  key: string,
  mods: Partial<Omit<Parameters<typeof reviewActionFor>[0], 'key'>> = {},
) =>
  reviewActionFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

/** a.ts: 2 hunks · bin.png: none (binary) · c.ts: 1 hunk. */
const FILES: ReviewFileHunks[] = [
  { path: 'a.ts', hunkCount: 2 },
  { path: 'bin.png', hunkCount: 0 },
  { path: 'c.ts', hunkCount: 1 },
];
const ref = (fileIndex: number, hunkIndex: number): HunkRef => ({ fileIndex, hunkIndex });

describe('reviewActionFor', () => {
  it('maps the navigation keys', () => {
    expect(press('j')).toBe('nextHunk');
    expect(press('k')).toBe('prevHunk');
    expect(press('J', { shiftKey: true })).toBe('nextFile');
    expect(press('K', { shiftKey: true })).toBe('prevFile');
  });

  it('maps the action keys', () => {
    expect(press('m')).toBe('toggleReviewed');
    expect(press('o')).toBe('openHunk');
    expect(press('Enter')).toBe('openHunk');
    expect(press('e')).toBe('expandAll');
    expect(press('E', { shiftKey: true })).toBe('collapseAll');
    expect(press('?', { shiftKey: true })).toBe('toggleHelp');
  });

  it('accepts ? without shift, for layouts that do not need it', () => {
    expect(press('?')).toBe('toggleHelp');
  });

  it('ignores every Ctrl / Cmd / Alt combination', () => {
    expect(press('j', { ctrlKey: true })).toBeNull();
    expect(press('j', { metaKey: true })).toBeNull();
    expect(press('j', { altKey: true })).toBeNull();
    expect(press('Enter', { ctrlKey: true })).toBeNull();
  });

  it('ignores a shifted press of an unshifted binding', () => {
    expect(press('Enter', { shiftKey: true })).toBeNull();
    expect(press('m', { shiftKey: true })).toBeNull();
  });

  it('ignores keys this surface does not own', () => {
    for (const key of ['f', 'g', 'ArrowDown', ' ']) {
      expect(press(key)).toBeNull();
    }
  });

  it('opens search on the bare / and on Mod+F (Lane C)', () => {
    expect(press('/')).toBe('openSearch');
    expect(press('f', { ctrlKey: true })).toBe('openSearch');
    expect(press('f', { metaKey: true })).toBe('openSearch');
    // `key` is upper-cased when Caps Lock or Shift is down; the combo is the same one.
    expect(press('F', { ctrlKey: true, shiftKey: true })).toBe('openSearch');
  });

  it('leaves Alt+F alone — it is not the find combo', () => {
    expect(press('f', { altKey: true })).toBeNull();
    expect(press('f', { ctrlKey: true, altKey: true })).toBeNull();
  });

  it('maps the hunk-op keys (Lane E)', () => {
    expect(press('s')).toBe('stageHunk');
    expect(press('d')).toBe('discardHunk');
  });

  it('still ignores them under a modifier', () => {
    expect(press('s', { ctrlKey: true })).toBeNull();
    expect(press('d', { metaKey: true })).toBeNull();
    expect(press('s', { shiftKey: true })).toBeNull();
  });

  it('maps c to addNote, and leaves Shift+C unbound', () => {
    expect(press('c')).toBe('addNote');
    expect(press('C')).toBeNull();
  });

  it('does not map c while a modifier is held', () => {
    expect(press('c', { ctrlKey: true })).toBeNull();
    expect(press('c', { metaKey: true })).toBeNull();
  });

  it('prints the note key in the help panel', () => {
    expect(REVIEW_KEY_HELP.some((r) => r.keys === 'c')).toBe(true);
  });

  it('prints the hunk-op keys in the help table', () => {
    expect(REVIEW_KEY_HELP.some((r) => r.keys === 's / d')).toBe(true);
  });

  it('publishes a help table covering exactly the bound keys', () => {
    const described = REVIEW_KEY_HELP.map((r) => r.keys).join(' ');
    for (const token of ['j', 'k', 'J', 'K', 'm', 'o', 'e', '/', 'Mod+F', '?', 'Esc']) {
      expect(described).toContain(token);
    }
    expect(described).not.toContain('Stage');
  });
});

describe('firstRef / clampRef', () => {
  it('starts on the first file that has a hunk', () => {
    expect(firstRef(FILES)).toEqual(ref(0, 0));
    expect(firstRef([{ path: 'bin.png', hunkCount: 0 }])).toEqual(ref(0, -1));
    expect(firstRef([])).toBeNull();
  });

  it('clamps a file index past the end of a shrunken list', () => {
    expect(clampRef(ref(9, 0), FILES)).toEqual(ref(2, 0));
  });

  it('clamps a hunk index past the end of its file', () => {
    expect(clampRef(ref(0, 7), FILES)).toEqual(ref(0, 1));
  });

  it('drops a hunk index for a file that has none, and adopts one for a file that does', () => {
    expect(clampRef(ref(1, 0), FILES)).toEqual(ref(1, -1));
    expect(clampRef(ref(2, -1), FILES)).toEqual(ref(2, 0));
  });

  it('is null for an empty list or a null ref', () => {
    expect(clampRef(ref(0, 0), [])).toBeNull();
    expect(clampRef(null, FILES)).toBeNull();
  });
});

describe('nextHunk / prevHunk', () => {
  it('walks within a file, then crosses to the next file that has hunks', () => {
    expect(nextHunk(FILES, ref(0, 0))).toEqual(ref(0, 1));
    // bin.png has no hunk — j skips it entirely.
    expect(nextHunk(FILES, ref(0, 1))).toEqual(ref(2, 0));
  });

  it('wraps forward to the first file with hunks', () => {
    expect(nextHunk(FILES, ref(2, 0))).toEqual(ref(0, 0));
  });

  it('walks back into the LAST hunk of the previous file with hunks', () => {
    expect(prevHunk(FILES, ref(2, 0))).toEqual(ref(0, 1));
    expect(prevHunk(FILES, ref(0, 1))).toEqual(ref(0, 0));
  });

  it('wraps backward from the first hunk to the last hunk in the list', () => {
    expect(prevHunk(FILES, ref(0, 0))).toEqual(ref(2, 0));
  });

  it('starts from the first hunk when nothing is current', () => {
    expect(nextHunk(FILES, null)).toEqual(ref(0, 0));
    expect(prevHunk(FILES, null)).toEqual(ref(0, 0));
  });

  it('a single hunk wraps to itself', () => {
    const one: ReviewFileHunks[] = [{ path: 'a.ts', hunkCount: 1 }];
    expect(nextHunk(one, ref(0, 0))).toEqual(ref(0, 0));
    expect(prevHunk(one, ref(0, 0))).toEqual(ref(0, 0));
  });

  it('stays put when no file in the list has a hunk', () => {
    const none: ReviewFileHunks[] = [{ path: 'bin.png', hunkCount: 0 }];
    expect(nextHunk(none, ref(0, -1))).toEqual(ref(0, -1));
    expect(prevHunk(none, ref(0, -1))).toEqual(ref(0, -1));
  });

  it('is null for an empty list', () => {
    expect(nextHunk([], null)).toBeNull();
    expect(prevHunk([], ref(0, 0))).toBeNull();
  });
});

describe('nextFile / prevFile', () => {
  it('moves by file INCLUDING files with no hunks, landing on their first hunk', () => {
    expect(nextFile(FILES, ref(0, 1))).toEqual(ref(1, -1));
    expect(nextFile(FILES, ref(1, -1))).toEqual(ref(2, 0));
  });

  it('wraps in both directions', () => {
    expect(nextFile(FILES, ref(2, 0))).toEqual(ref(0, 0));
    expect(prevFile(FILES, ref(0, 0))).toEqual(ref(2, 0));
  });

  it('starts from the first file when nothing is current', () => {
    expect(nextFile(FILES, null)).toEqual(ref(0, 0));
  });
});

describe('syncToAnchor', () => {
  it('adopts the anchored file when the cursor is somewhere else', () => {
    expect(syncToAnchor(ref(0, 1), FILES, 2)).toEqual(ref(2, 0));
  });

  it('leaves the cursor alone while it is already inside the anchored file', () => {
    expect(syncToAnchor(ref(0, 1), FILES, 0)).toEqual(ref(0, 1));
  });

  it('seeds the cursor from the anchor when there is none', () => {
    expect(syncToAnchor(null, FILES, 1)).toEqual(ref(1, -1));
  });

  it('falls back to clamping when the anchor index is out of range', () => {
    expect(syncToAnchor(ref(0, 9), FILES, -1)).toEqual(ref(0, 1));
    expect(syncToAnchor(null, FILES, -1)).toBeNull();
  });
});

describe('reviewActionAllowed', () => {
  it('declines Enter while an interactive control has focus, so the control still fires', () => {
    expect(reviewActionAllowed('openHunk', 'Enter', true)).toBe(false);
  });

  it('takes Enter when focus is on the scroller itself', () => {
    expect(reviewActionAllowed('openHunk', 'Enter', false)).toBe(true);
  });

  it('never gives up `o` — a button does nothing with a letter', () => {
    expect(reviewActionAllowed('openHunk', 'o', true)).toBe(true);
  });

  it('leaves every other action alone, focused control or not', () => {
    for (const a of [
      'nextHunk',
      'prevHunk',
      'nextFile',
      'toggleReviewed',
      'collapseAll',
    ] as const) {
      expect(reviewActionAllowed(a, 'j', true)).toBe(true);
    }
  });
});
