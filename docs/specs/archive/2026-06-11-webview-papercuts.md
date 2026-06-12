# Webview Papercuts (K4) — Fix Specifications

Eight confirmed renderer defects fixed on branch `r3/webview-papercuts`.

---

## Fix 1: Command palette active row scroll-into-view

**File:** `webview/components/command-palette.tsx`

**Problem:** Two `useEffect` hooks both had empty `[]` deps. The first unnecessarily called `setActive(0)` (redundant with `useState(0)`). The second scrolled the active row into view but only ran once on mount — arrow-key navigation never re-triggered it, so the highlighted row could scroll out of view.

**Fix:** Removed the redundant `setActive(0)` effect. Changed the scroll effect deps from `[]` to `[active]` so it re-runs every time the active index changes.

---

## Fix 2: Global shortcuts fire while typing

**Files:** `webview/typing-guard.ts` (new), `webview/app.tsx`

**Problem:** The global `window.addEventListener('keydown', ...)` in App fired shortcuts like `Mod+P` (palette), `Mod+B` (sidebar toggle), `Mod+N` (new session) even when focus was in a text-entry element (session filter `<input>`, spec editor `<textarea>`, pipeline label `<input>`).

**Rule established:**
- **Blocked while typing:** All global shortcuts except those explicitly allowed.
- **Allowed while typing:** `Mod+S` (save — intentionally global) and any `Escape`-prefixed combo (handled per-component).
- **Monaco is exempt:** Monaco captures its own keyboard events before they bubble to window, so the guard only covers non-Monaco fields.

**Fix:** Created `webview/typing-guard.ts` with two pure, tested functions:
- `isTypingEntry(el)` — returns true for `<input>`, `<textarea>`, and `contenteditable` elements.
- `isComboAllowedWhileTyping(combo)` — returns true only for `Mod+S` and `Escape`-prefixed combos.

The global handler in `app.tsx` now checks both before firing any action.

---

## Fix 3: Board/Architecture edits lost on quick close

**Files:** `webview/use-debounced-flush.ts` (new), `webview/components/board-view.tsx`, `webview/components/architecture-view.tsx`

**Problem:** Both `BoardView` and the architecture `Canvas` debounced saves to the host with `setTimeout(..., 300)`. If the user pressed Escape to close the view within that 300ms window, the component unmounted and the pending timer was dropped — the edit was silently lost.

**Fix:** Created `webview/use-debounced-flush.ts` with:
- `makeDebouncedFlush(cb, delayMs)` — pure factory returning `{ schedule, flush, cancel }`. Used in unit tests.
- `useDebouncedFlush(cb, delayMs)` — React hook wrapping the factory. Its cleanup effect calls `flush()` on unmount, guaranteeing any pending save fires even if the view is closed before the timer expires.

Both `board-view.tsx` and `architecture-view.tsx` now use `useDebouncedFlush` instead of raw `setTimeout`. The board's subscribe handler uses `cancel` when an external agent update arrives (external truth wins).

---

## Fix 4: new-session-modal bogus deps

**File:** `webview/components/new-session-modal.tsx`

**Problem:** The `useEffect` that syncs `termId` to the selected repo listed `repos.find` as a dependency. `repos.find` is `Array.prototype.find` — a stable built-in that never changes identity. This meant the effect never re-ran when the `repos` array content changed (e.g. when the host pushed a new repo list), which could leave `termId` stale.

**Fix:** Replaced `repos.find` with `repos` in the dependency array. The effect now correctly re-runs when `sel`, `defaultTerm`, or the `repos` array changes.

---

## Fix 5: Confirm dialog Enter confirms even when Cancel is focused

**File:** `webview/components/confirm-dialog.tsx`

**Problem:** The global `window.keydown` handler unconditionally fired `onConfirm()` on Enter. When the Cancel button had focus (user tabbed to it), pressing Enter triggered both: the button's native click (`onClose`) AND the window handler (`onConfirm + onClose`) — a double-fire that confirmed the destructive action.

**Fix:** Added a `cancelRef` ref to the Cancel button. The keydown handler now checks `document.activeElement === cancelRef.current` before firing `onConfirm`. If Cancel is focused, the native button semantics handle the close — the window handler does nothing.

---

## Fix 6: doc-tabs button-in-button

**File:** `webview/components/doc-tabs.tsx`

**Problem:** Each doc tab was rendered as a `<button>` containing a child `<button class="tab__close">` — invalid HTML (interactive element inside interactive element). This caused React `validateDOMNesting` warnings and unreliable click handling on the close button.

**Fix:** Changed the outer tab element from `<button>` to `<div role="tab" tabIndex={0} aria-selected={...}>`. Added `onKeyDown` to activate on Enter/Space (preserving keyboard behaviour). The `<button class="tab__close">` remains a real button (valid: button inside div). All existing behaviours preserved: click to activate, close, drag/reorder, dirty affordance, context menu.

---

## Fix 7: Undefined CSS var --code-surface

**File:** `webview/styles.css`

**Finding:** `--code-surface` was already correctly defined in `styles.css` at line 2283:
```css
--code-surface: color-mix(in srgb, var(--code-bg) calc(var(--code-alpha) * 100%), transparent);
```
`--code-bg` and `--code-alpha` are set by `applyToDom` in `settings.tsx` via `el.style.setProperty`, and `color-mix` resolves them at paint time. **This fix was already in place** — the audit finding referred to an earlier code state.

---

## Fix 8: Duplicate conflicting .filerow rule blocks

**File:** `webview/styles.css`

**Problem:** Two separate `.filerow` / `.filerow__*` rule blocks existed:
1. Lines ~1500–1554: hover used `var(--panel-2)`. Had `flex: 1; white-space/overflow/ellipsis` on `__name`, badge modifier classes.
2. Lines ~1783–1812 (later, winning): hover used `var(--raise)`. Had `flex: 0 0 auto` on `__chev/__icon`. Was missing `flex: 1` and ellipsis on `__name`, and all badge classes.

The later block won via CSS cascade. The first block's hover was dead, but its `__name` flex/ellipsis and badge classes were live — those properties were being overridden back to nothing by the second block's incomplete `__name` rule.

**Fix:** Removed the first block entirely. Replaced the second block with a single canonical block that merges all live styles: `var(--raise)` hover (winner), `flex: 0 0 auto` on chev/icon, `flex: 1` + ellipsis on `__name`, `font-size: 12.5px`, and all badge modifier classes.
