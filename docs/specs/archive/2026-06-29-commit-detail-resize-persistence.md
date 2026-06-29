---
status: active
date: 2026-06-29
---

# Feature Spec: Persist the History-tab commit-detail pane height

**Tier:** LITE   **Feature type:** UI
**One-line request:** "The Commit Preview window or panel that pops up when I click a commit under the History tab. Every time I open and close it, it resets to its original position so it doesn't remember how big or small it was. I want it to remember its state because, for example, I click on the commit. It pops up right and small so I drag it up so it's bigger. If I close it and open it again, then it resets to the small size."

## 0. Context (real code, not a guess)

The "Commit Preview" the user describes is the **commit-detail pane** — `CommitView`
rendered inline in the bottom of the History tab's vertical split
(`webview/components/git-history-view.tsx`). It is not a floating window; it's the
resizable bottom pane revealed when a commit row is selected.

- Height lives in component-local state: `const [detailH, setDetailH] = useState(DETAIL_DEFAULT_H)` (~line 185), `DETAIL_DEFAULT_H = 300`.
- A draggable seam (`.gh__resizer`, `onResizeStart`) and keyboard (`onResizeKey`, Up/Down, `DETAIL_KEY_STEP = 24`) mutate `detailH`, clamped by `clampDetailH` to `[DETAIL_MIN_H=140, splitH − LEDGER_MIN_H(160)]`.
- **Root cause of the bug:** `detailH` is local state. It resets to 300 every time `GitHistoryView` unmounts/remounts — which happens whenever the History tab is closed and reopened (and on app restart). The user's drag is therefore forgotten.

The fix is to persist the dragged height. **This spec does not change the resizer,
the clamp logic, or the close/Escape behavior** — only where the number is stored.

## 1. Problem frame

- **Job:** "When I size the commit-detail pane to my liking, keep it that size next time I open it — don't make me re-drag it every time."
- **Actors:** A single user browsing commit history in the History tab.
- **Success outcomes (observable):**
  - After dragging the seam taller (or shorter), closing the detail pane (or the whole History tab) and reopening it shows the pane at the height the user left it — not the 300 px default.
  - The remembered height also survives an app restart.
- **Non-goals:**
  - Not redesigning the resizer, the seam, or the keyboard controls.
  - Not persisting which commit was selected, scroll position, search/filter, or the detail pane's open/closed state.
  - Not making the pane a floating/movable window (it is a docked split pane; "position" in the request means *size*).
  - No per-commit or per-repo height — a single height applies everywhere (matches `leftWidth`/`rightWidth`).

## 2. Behavior & states

- **Primary flow (happy path):**
  1. User selects a commit → detail pane appears at the persisted height (300 px on first-ever use).
  2. User drags the seam up to enlarge it (or Up/Down arrows).
  3. On release (drag end) / on each keyboard step, the new height is persisted.
  4. User closes the pane (X / Escape) or closes + reopens the History tab, or restarts the app.
  5. Next time the detail pane appears, it is at the persisted height.

- **States / transitions:**
  - *No persisted value* (first run / post-reset) → seed from `DETAIL_DEFAULT_H` (300).
  - *Persisted value present* → seed `detailH` from it, re-clamped to the current runtime bounds.
  - *Persisted value now out of bounds* (e.g. window/pane is much shorter than when saved) → clamp into `[DETAIL_MIN_H, splitH − LEDGER_MIN_H]` on use; the displayed pane is always valid. The persisted number is corrected to the clamped value the next time the user resizes (we do not eagerly rewrite storage on read).

## 3. Data / interface contract

Reuse the existing settings store (`src/settings.ts` ↔ `webview/settings.tsx`),
exactly as `leftWidth`/`rightWidth` do.

- **New field:** `historyDetailHeight: number` on `AppSettings`.
- **Default:** `300` (= current `DETAIL_DEFAULT_H`) in `DEFAULT_SETTINGS`.
- **Coercion (`coerceSettings`):** `clampNum(payload.historyDetailHeight, <min>, <max>, 300)`.
  - `min` = `DETAIL_MIN_H` (140) so a corrupt/tiny value never produces an unusable pane.
  - `max`: there is no static upper bound (the real upper bound is `splitH − LEDGER_MIN_H`, only known at runtime). Use a generous static ceiling for the *stored* value (suggest `2000`, comfortably above any realistic pane height) purely as a sanity guard; the **runtime** `clampDetailH` already enforces the true per-render upper bound. (Flag: ceiling value — see Decisions Needed.)
- **Write path:** the renderer calls `update({ historyDetailHeight })` (debounced 250 ms + flush-on-unload, already implemented in `settings.tsx`). The host persists to `settings.json` in userData via the existing `updateSettings` IPC.
- **Invariant:** the value the user *sees* is always within `[DETAIL_MIN_H, splitH − LEDGER_MIN_H]`; the *stored* value is always within `[140, ceiling]`.

**Implementation pointers (renderer, `git-history-view.tsx`):**
- `GitHistoryView` renders inside `SettingsProvider`, so `const { settings, update } = useSettings()` is available (the same hook app.tsx uses for `commitWidth`).
- Seed the existing local state from settings: `const [detailH, setDetailH] = useState(() => clampDetailH(settings.historyDetailHeight))` — keep local state for smooth dragging; do not drive height off context per frame. (`clampDetailH` reads `splitRef`, null at first render → only the lower bound applies at mount, which is fine; the existing render/window-resize clamp enforces the upper bound.)
- Persist on commit, not per pointermove: in `onResizeStart`'s `onUp` handler call `update({ historyDetailHeight: <final detailH> })`; in `onResizeKey`, after each `clampDetailH`, call `update({ historyDetailHeight: <next> })`. Both ride the existing 250 ms debounce + unload-flush in `settings.tsx` (no settings spam).

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| First-ever use (no persisted value) | Coercion returns default 300; pane opens at 300 as today. |
| Persisted value below `DETAIL_MIN_H` / corrupt / non-number | `clampNum` returns 300 (or the clamped min); never an unusable pane. |
| Persisted value taller than the current split (small window) | `clampDetailH` shrinks it to `splitH − LEDGER_MIN_H` on render; pane stays usable. Stored value untouched until next resize. |
| Rapid dragging | Live drag mutates local `detailH` for smoothness; persistence is debounced (250 ms) so frequent moves coalesce into one write — no settings spam. |
| Multiple windows open (multi-window build) | `historyDetailHeight` is a single global setting (like `leftWidth`). The last window to write wins; the existing settings-sync gate (`src/settings-sync.ts`) already guards stale host echoes. Other windows pick up the value on their next remount/hydrate. Acceptable for a cosmetic preference. |
| "Reset layout" / "Reset all" in settings | MVP: leave `resetLayout()` untouched (a stale custom height is harmless and the user can re-drag). v1: add `historyDetailHeight` to `resetLayout()` since it is a layout dimension alongside `leftWidth`/`rightWidth`. ("Reset all" already covers it via `DEFAULT_SETTINGS`.) |
| Detail pane closed, then reopened in same session | Pane re-reads the (now persisted) height; no reset to 300 — this is the core bug being fixed. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Where to store the height | `settings.json` (durable) | Implicit (set by dragging; no explicit toggle) | Matches `leftWidth`/`rightWidth`; survives restart at zero extra cost. |
| Default height | 300 px | No (same as today) | Preserves current first-run behavior. |
| Scope | One global value | No | Mirrors panel-width prefs; a per-repo/per-commit height is unrequested complexity. |
| Surface a settings-panel control | No | — | The drag *is* the control; an explicit numeric input is over-production. |

## 6. Scope slicing

- **MVP (must):** Persist `historyDetailHeight` via the settings store; seed `detailH` from it (clamped); write on resize-end + keyboard step. Survives tab close/reopen and restart.
- **v1 (should):** Include `historyDetailHeight` in `resetLayout()` so "Reset layout" returns it to 300.
- **Vision (could):** None warranted. (A per-repo height would be the only conceivable extension and is explicitly unrequested.)
- **Out of scope:** Persisting selection/scroll/open-state; floating/movable detail window; any resizer-mechanics change; a settings-panel numeric field.

## 7. Acceptance criteria

- Dragging the detail seam taller, then closing and reopening the detail pane within the same session, shows the pane at the dragged height (not 300).
- Dragging the seam, then closing the History tab and reopening it, shows the pane at the dragged height.
- Dragging the seam, then fully restarting the app, shows the pane at the dragged height.
- With no persisted value (fresh profile / after "Reset layout"), the pane opens at 300 px.
- A persisted height larger than the current pane can hold is clamped to a usable size on open (ledger keeps ≥ `LEDGER_MIN_H`); the app never shows an unusable or zero-height ledger.
- Keyboard Up/Down resizing is persisted the same way as drag.

**Test vehicle:** Add a unit test for the `coerceSettings` round-trip of `historyDetailHeight` (default, clamp-below-min, clamp-above-ceiling) alongside the existing `test/unit/coerce-settings.test.ts` / `settings.test.ts`. The cross-restart restore is a host/IPC-boundary behavior → cover it with a smoke scenario (`test/e2e/<name>.e2e.mjs` on the shared harness) per CLAUDE.md, rather than `needs-human-smoke`: drag taller, relaunch, assert the detail pane height is retained.

<!-- UI MODULE -->

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Commit-detail pane (`.gh__detail`) | Hidden | No detail pane (no commit selected) | Select a commit row |
| Commit-detail pane | Shown @ persisted height | Pane at last-saved height (300 first-run) | Drag seam / Up-Down / close (X / Esc) |
| Resizer seam (`.gh__resizer`) | Idle | 6 px separator with grab affordance | Drag, or focus + Up/Down |
| Resizer seam | Dragging | `body.gh-resizing`; pane height tracks pointer | Release to commit + persist |
| Detail pane (restore) | Clamped | Persisted height shrunk to fit a short window | — (auto, on render) |

*No new visual states are introduced* — this feature only changes the seed value and adds a persist-on-commit. The table documents the existing states the change touches.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Resizer seam | Resize + persist | Pointer-drag the seam (window-level listeners; persist on `pointerup`) | Focus seam, ArrowUp grows / ArrowDown shrinks by 24 px, **persist each step** | Same as pointer (pointer events) | None | `role="separator"`, `aria-orientation="horizontal"`, `aria-label` = "Resize commit detail (drag, or Up/Down arrows)", `tabIndex={0}` (all pre-existing — unchanged) |

The only behavioral addition: after a drag ends and after each keyboard step, call `update({ historyDetailHeight: <clamped> })`. The live drag continues to use local state for smoothness; persistence does not run per pointermove.

## 10. Accessibility & i18n

- **Keyboard:** Up/Down resize already works and must persist identically to drag — no regression to keyboard-only resizing.
- **Focus:** No change to focus order; the seam remains focusable (`tabIndex={0}`).
- **Screen reader:** The separator's existing `aria-label`/`role` are unchanged. No new announcement is required — height persistence is silent and non-disruptive (a live-region announcement of a remembered size would be noise).
- **Reduced motion:** No animation added; restoring the height is an instant layout, so `reduceMotion` is unaffected.
- **i18n:** No new user-facing strings. The existing `STR.resizeDetail` / `STR.closeDetail` are untouched. (Note: the repo has no active i18n layer; strings are inline `STR` constants — consistent with the rest of the view.)

## 11. Design tokens

No new tokens. Height is a runtime pixel value (`style={{ height: detailH }}`), not a themed token, exactly as today. No color/spacing/typography change; light/dark/high-contrast are unaffected.

## 12. Assumptions

- "Window/panel that pops up" = the docked commit-detail split pane (`CommitView` in `git-history-view.tsx`), confirmed against the code. "Remember its position/size" = remember the dragged **height**; the pane has no movable position.
- A single global height (not per-repo/per-session/per-commit) is what the user wants — they describe one pane and one size. Matches the `leftWidth`/`rightWidth` precedent.
- Durable persistence (across restart) is desirable and free here, so we do it rather than the session-only renderer-cache fallback.
- Persist on resize-commit (pointerup / key step), not on every pointermove — the settings store already debounces, and this avoids churn.
- The local `detailH` state is kept for smooth dragging and seeded from settings on mount; we do not drive the pane height directly off context on every frame.

## 13. Decisions Needed (autonomous)

- **[normal]** Storage mechanism: durable (settings store) vs session-only (renderer module cache). **Default taken: durable** via `AppSettings.historyDetailHeight`, because it fits the existing `leftWidth`/`rightWidth` pattern cleanly and satisfies both the literal close/reopen ask and the restart goal. Reversible (a one-field change).
- **[normal]** Static storage ceiling for `clampNum`. **Default taken: 2000 px** as a pure sanity guard; the real upper bound is enforced at render by `clampDetailH`. Any large finite number is fine; pick to taste.
- **[normal]** Whether "Reset layout" resets this height. **Default taken: yes, include it in `resetLayout()`** (it's a layout dimension). Low-risk; drop it if it complicates the change.

## 14. Open questions

None blocking — all routed to Decisions Needed with conservative, reversible defaults.

## Self-audit

All core-spine sections (1–7) and the UI module (8–11) are filled. Sections 3/4 are
expanded beyond a typical LITE because the *whole* feature is a data-contract + edge-case
question (clamp-on-restore), so depth is proportional, not padding. No section left blank.
Implementation pointers (file/symbol/line) are included because the conductor builds
straight from this spec.
