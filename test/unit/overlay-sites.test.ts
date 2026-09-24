import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for the overlay-layers migration (docs/plans/2026-09-07-overlay-layers.plan.md
 * T2.5): every dialog backdrop portals through `ModalLayer`, and Escape is the stack's job, not
 * each dialog's own. Two invariants, checked across every migrated site:
 *
 *   1. No JSX literally writes `className="modal__backdrop` outside `modal-layer.tsx` itself —
 *      `ModalLayer` is the only place that string may appear as a class name.
 *   2. No migrated file dismisses ITSELF on Escape any more (`useEscapeKey(` is gone, and no
 *      `e.key === 'Escape'` check is paired with a call to that file's own dismiss prop).
 *
 * Invariant 2 is intentionally narrower than "the string 'Escape' never appears": `compare-
 * dialog.tsx`'s `RefCombobox` keeps its own Escape-closes-the-list handling until T3.1 puts that
 * list on a `Popover` (T2.3's own scope note), and `settings-modal.tsx`'s shortcut recorder keeps
 * a bare `if (e.key === 'Escape') return;` guard so its OWN "next key is the combo" listener
 * doesn't record Escape as a shortcut — `stopPropagation` (which the overlay store calls) does
 * not stop a sibling listener on the same target, so the guard is a real, load-bearing no-op, not
 * a dismiss. Matching "an Escape check next to a call to this file's dismiss prop" (rather than
 * the bare substring) tells the two apart while still catching a reverted removal.
 */

const ROOT = join(__dirname, '..', '..', 'webview', 'components');
const readSrc = (name: string) => readFileSync(join(ROOT, `${name}.tsx`), 'utf8');

const DIALOG_FILES = [
  'confirm-dialog',
  'conflict-dialog',
  'new-session-modal',
  'web-prompt-modal',
  'icon-picker-modal',
  'settings-modal',
  'command-palette',
  'compare-dialog',
  'timed-message-dialog',
];

const ALL_FILES = [
  ...DIALOG_FILES,
  'mermaid-zoom-overlay',
  'context-menu',
  'popover',
  'branch-chip',
  'repo-head',
  'changes-view',
  'new-session-launch-row',
  'new-session-project-chip',
  'new-session-folders',
  'new-session-preview',
];

/** Every dismiss-shaped prop/callback name used across the migrated dialogs. */
const DISMISS_CALLS = ['onClose', 'onDismiss', 'onCancel', 'onResolve', 'requestClose'];
const DISMISS_CALL_RE = new RegExp(`(?:${DISMISS_CALLS.join('|')})\\(`);

describe('new-session menus', () => {
  // The dialog adds no overlay root of its own: its menus ride Popover, whose .popover already
  // declares no-drag (drag-region.test.ts), so a menu over .topbar stays clickable.
  it.each(['new-session-launch-row', 'new-session-project-chip', 'new-session-folders'])(
    '%s renders its menus in a Popover and positions nothing itself',
    (name) => {
      const src = readSrc(name);
      expect(src).toMatch(/<Popover\b/);
      expect(src).not.toMatch(/position:\s*['"]?fixed/);
      expect(src).not.toMatch(/createPortal\(/);
    },
  );
});

describe('overlay migration static guard', () => {
  it.each(ALL_FILES)('%s never writes className="modal__backdrop" directly', (name) => {
    const src = readSrc(name);
    expect(src).not.toMatch(/className="modal__backdrop/);
  });

  it.each(ALL_FILES)('%s no longer uses useEscapeKey', (name) => {
    expect(readSrc(name)).not.toMatch(/useEscapeKey\(/);
  });

  it.each(ALL_FILES)('%s does not dismiss itself from an Escape check', (name) => {
    const src = readSrc(name);
    for (const m of src.matchAll(/e\.key === ['"]Escape['"]/g)) {
      // The 80 chars after the check is enough to span `{ e.preventDefault(); onClose(); }`
      // (the shape every reverted branch had) without reaching into an unrelated later block.
      const nearby = src.slice(m.index, m.index + 80);
      expect(nearby).not.toMatch(DISMISS_CALL_RE);
    }
  });
});

/**
 * `ContextMenu` renders `.popover .ctxmenu` and gets its positioning from `.popover`, but
 * `CommitPickerMenu` and `RepoPickerMenu` portal themselves and set inline left/top on `.ctxmenu`
 * alone. Strip the positioning from that class and those two lay out in
 * body flow with their coordinates inert — invisible to any click-based e2e, because Playwright
 * scrolls a target into view before clicking it.
 */
describe('portaled menu classes keep a positioning scheme', () => {
  const CSS = readFileSync(join(ROOT, '..', 'styles.css'), 'utf8');
  const ruleBody = (selector: string) => {
    const at = CSS.search(new RegExp(`^\\${selector} \\{`, 'm'));
    return at < 0 ? '' : CSS.slice(at, CSS.indexOf('}', at));
  };

  it.each(['.ctxmenu', '.popover'])('%s declares position: fixed and a z-index', (selector) => {
    const body = ruleBody(selector);
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/z-index:/);
  });

  it.each(['commit-picker-menu', 'repo-picker-menu'])(
    '%s still renders the .ctxmenu class it depends on',
    (name) => {
      expect(readSrc(name)).toMatch(/className="ctxmenu/);
    },
  );
});

// The switcher list sits inside the chip's Popover; a nested .ctxmenu would be position: fixed
// inside a positioned popover.
describe('the branch chip menu', () => {
  it('branch-chip renders its menu in a Popover', () => {
    expect(readSrc('branch-chip')).toMatch(/<Popover/);
    expect(readSrc('branch-switcher-menu')).not.toMatch(/className="ctxmenu[ "]/);
    expect(readSrc('branch-switcher-menu')).not.toMatch(/createPortal/);
  });
});

describe('modal-layer.tsx is the one legitimate modal__backdrop site', () => {
  it('still declares the default backdropClass', () => {
    const src = readFileSync(join(ROOT, 'modal-layer.tsx'), 'utf8');
    expect(src).toMatch(/modal__backdrop/);
  });
});
