# Feature Spec: Menu System (reusable context-menu component)

**Tier:** FULL   **Feature type:** UI
**One-line request:** Extract a single reusable context-menu component that matches the app's existing menu design, and refactor the app's current context menu(s) onto it — without changing existing behavior — so later features (E5 code-editor menu, F1 canvas menu, G1 board menu, A3 panel-toggle menu, D1 sessions sort/filter) can all consume one component.

> **Build state note (resolves the build-vs-harden ambiguity):** A prior task already created `webview/components/context-menu.tsx` and wired all four app menus onto it. This task therefore **hardens** the existing primitive — extract a pure, unit-tested viewport-clamp helper; adopt the shared `use-escape-key` hook; add keyboard navigation + ARIA — while keeping the four menus' items and behavior byte-identical. "Create the component / refactor menus onto it" in §6 MVP is satisfied-and-verified rather than built-from-zero. A downstream consumer task should assume the component **exists today** and consume it as documented in §3.

## 1. Problem frame
- **Job:** Give the app one canonical floating menu primitive so every feature that needs a "list of actions at a point" mounts the same component with a different item list — instead of each feature re-implementing positioning, dismissal, and styling.
- **Actors / roles:** (a) Conduit end-user invoking a context menu (right-click a file/change/session, click a tab's overflow, etc.); (b) feature developers (incl. downstream autoloop tasks E5/F1/G1/A3/D1) mounting the component.
- **Success outcomes (observable):**
  - There is exactly ONE menu implementation in `webview/` (`components/context-menu.tsx`), driven by app design variables.
  - All four existing app context menus (session card, editor tab, file-tree node, change-list entry) render through it with identical items and behavior to before.
  - The menu opens at the cursor, never overflows the viewport, and dismisses on Escape / click-outside / scroll / window blur / resize / item activation.
  - A downstream task can mount it for a new feature by passing `{x, y, items}` and an `onClose`, with no positioning/dismiss code of its own.
- **Non-goals:**
  - Building the consumer menus E5/F1/G1/A3/D1 (separate tasks).
  - Replacing Monaco's *own* in-editor right-click menu (`editor.contrib.contextmenu` in `code-viewer.tsx`) — that is Monaco-internal and out of scope.
  - A general menubar / dropdown-button / nested-submenu system. Submenus are explicitly deferred (see Scope).
  - Theming beyond the app's existing single dark theme.

## 2. Behavior & states
- **Primary flow (happy path):** User right-clicks a target → handler builds an item list and sets menu state `{x, y, items}` → component mounts as a floating layer at `(x, y)`, clamped into the viewport → user clicks an item → the item's `onClick` runs, then the menu closes. Owner clears menu state.
- **States / transitions:**
  - *Closed* — no menu state; component not rendered.
  - *Opening / positioning* — first layout pass measures the menu and clamps `(x, y)` to the viewport before paint (no visible jump).
  - *Open / idle* — menu visible; pointer hover highlights an item.
  - *Keyboard-focused* — Up/Down moves an active highlight across enabled items; Enter activates the active item.
  - *Dismissing* — triggered by Escape, click/mousedown outside, scroll, window blur, window resize, or item activation → `onClose()` → back to Closed.

## 3. Data / interface contract
This is a UI primitive; its "contract" is its prop API.

```ts
interface MenuItem {
  label: string;            // visible text; also the React key (assumed unique per menu)
  icon?: ReactNode;         // optional leading glyph
  onClick: () => void;      // action; runs before the menu closes
  danger?: boolean;         // destructive styling (red)
  separatorBefore?: boolean;// renders a divider above this item
  disabled?: boolean;       // non-activatable, skipped by keyboard nav
}

interface MenuState {
  x: number;                // viewport x (e.clientX)
  y: number;                // viewport y (e.clientY)
  items: MenuItem[];
}

function ContextMenu(props: { menu: MenuState; onClose: () => void }): JSX.Element;
```

**Extension points (for downstream consumers E5/F1/G1/A3/D1):** The MVP contract is intentionally fixed at `{x, y, items}` + `onClose` — no `className`/`width`/placement props. A consumer that only needs a list of actions at a point mounts it as-is. If a future consumer needs width or styling hints, add a narrow, documented prop (e.g. `minWidth`) at that time rather than speculatively (see Vision). Per-item width is governed by CSS (`min-width: 184px`).

- **Inputs:** `menu` (position + items) and `onClose`. Position comes from a `contextmenu`/`click` event's `clientX/clientY` (untrusted only in the sense of being arbitrary numbers — must be clamped, never assumed on-screen).
- **Outputs:** rendered floating menu; side effects are the items' `onClick` callbacks and `onClose`.
- **Invariants:**
  - The rendered menu box is fully within `[8px, viewport-8px]` on both axes whenever it fits; if it cannot fit, the top-left is pinned to `8px` (never negative, never off-screen top-left).
  - Activating any enabled item calls its `onClick` exactly once, then `onClose` exactly once, in that order.
  - `onClose` is idempotent from the component's side (calling it does not require the menu still be mounted).
  - The pure positioning function is deterministic: same inputs → same clamped output.

## 4. Edge cases & failure modes
| Condition | Expected behavior / recovery |
|---|---|
| Concurrency / double-submit | Re-opening (new right-click) while a menu is open replaces the menu state; only the latest `{x,y,items}` is shown. A second activation can't happen because the menu closes on the first. |
| Zero / one / many items | Zero items → empty menu box (callers are expected not to open empty menus; component does not crash). One item → renders normally. Many items taller than viewport → see "Limits". |
| Limits exceeded (menu taller/wider than viewport) | Clamp pins top-left to the 8px margin so the menu's top-left stays visible; the menu may extend past the bottom edge if it is genuinely taller than the viewport (acceptable; matches prior behavior — no internal scroll in MVP). |
| Cursor near right/bottom edge | Menu is shifted left/up so its right/bottom edge sits at `viewport-8px`; it opens "above/left of" the cursor effectively, never clipped. |
| Partial failure / retry / idempotency | An item `onClick` that throws still results in the menu closing? — No: `onClick` runs then `onClose`; if `onClick` throws, `onClose` won't run (React error boundary territory). Acceptable: items are simple `post()`/state calls. Documented as assumption. |
| Stale data | Items capture their closures at build time (in the owner's handler). If underlying data changed between open and click, that's the owner's concern, unchanged from today. |
| Disabled items | Not activatable by pointer (`disabled` button) and skipped by keyboard nav; never receive focus highlight. |
| All items disabled (zero enabled) | Up/Down/Enter are no-ops (no enabled target); menu still dismisses on Esc/outside. |
| `items` change while open (owner rebuilds list) | Keyboard-active index is reset/clamped so it never points past the new list; if the previously active item is gone, highlight clears until the next arrow press. |
| Menu wider than viewport | Same clamp rule as height: left pinned to 8px margin; the menu may extend past the right edge only if genuinely wider than the viewport (no truncation in MVP — current menus are narrow, `min-width: 184px`). |
| Window resized / scrolled while open | Menu dismisses (cannot guarantee anchor validity) — preserves prior behavior. |

## 5. Defaults vs. settings
| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Viewport edge margin | 8px | No | Matches existing code; small, safe, not a user preference. |
| Dismiss on scroll/resize/blur | On | No | Anchor becomes invalid; consistent with OS menus and prior behavior. |
| Keyboard navigation | On (Up/Down/Enter/Esc) | No | Accessibility improvement; additive, no item-list changes required. |
| Submenus | Not supported | No (deferred) | No current consumer needs them; YAGNI. Add when a consumer requires it. |
| Activation closes menu | Yes | No | Standard context-menu behavior; matches today. |
| Auto-focus first item on open | No (highlight only starts on first arrow key) | No | Avoids stealing focus / surprising pointer users; arrow key engages keyboard mode. |

## 6. Scope slicing
- **MVP (must):**
  - Pure, unit-tested viewport-clamp positioning helper in a `.ts` module under `src/`.
  - `ContextMenu` component consuming that helper, using `use-escape-key` for dismiss, and the existing `.ctxmenu*` styles (design variables only).
  - All four existing menus refactored to (continue to) consume the single component; zero behavior change to their item lists.
- **v1 (should):**
  - Keyboard navigation (Up/Down/Home/End/Enter/Esc) skipping disabled items + `aria` roles (`menu`/`menuitem`) + `aria-activedescendant` for the active item.
- **Vision (could):**
  - Submenus, internal scroll for very tall menus, "open above" preference flag, type-ahead, full WAI-ARIA focus-trap + roving tabindex, a `minWidth`/`className` extension prop if a consumer needs it.
- **Out of scope:** Monaco editor menu; menubar; non-context dropdowns; multi-theme.

## 7. Acceptance criteria

### Declarative
- Right-clicking a file in the Explorer opens the menu with the same items as before, rendered by the shared component.
- The menu never renders any part off-screen when opened near a viewport edge (top-left pinned ≥ 8px, right/bottom ≤ viewport − 8px when it fits).
- Pressing Escape, clicking outside, scrolling, or activating an item dismisses the menu.
- Exactly one menu component exists in the webview; no inline/duplicate menu rendering remains.

### EARS
- **Event:** When a context menu is opened at `(x, y)`, the system shall position the menu so its full box lies within the viewport minus an 8px margin whenever it fits.
- **Unwanted:** If the requested position would place the menu's right or bottom edge past the viewport margin, then the system shall shift the menu left/up to the margin rather than clip it.
- **Unwanted:** If the menu is larger than the available space, then the system shall pin its top-left to the 8px margin (never a negative coordinate).
- **Event:** When the user presses Escape, clicks outside the menu, scrolls, or the window blurs/resizes, the system shall close the menu.
- **Event:** When the user activates an enabled item, the system shall invoke that item's action and then close the menu.
- **State:** While the user navigates with the keyboard, the system shall move the active highlight only across enabled items and shall activate the highlighted item on Enter.
- **Unwanted:** If an item is disabled, then the system shall not activate it via pointer or keyboard and shall not give it the active highlight.

### Gherkin
```gherkin
Feature: Reusable context menu
  Scenario: Open near the bottom-right corner
    Given the viewport is 1000x800
    And a menu measuring 200x300
    When it is opened at (980, 780)
    Then its left is clamped to 792 (1000-200-8)
    And its top is clamped to 492 (800-300-8)

  Scenario: Dismiss on Escape
    Given a context menu is open
    When the user presses Escape
    Then the menu closes and onClose is called

  Scenario: Existing file menu unchanged
    Given the file Explorer is shown
    When the user right-clicks a file node
    Then the menu shows Open, Reveal in Explorer, Copy path, Copy relative path
    And it is rendered by the shared ContextMenu component

  Scenario: Keyboard nav skips a disabled item
    Given a menu is open with items [A enabled, B disabled, C enabled]
    When the user presses ArrowDown twice from no selection
    Then the active item is C, not B

  Scenario: Dismiss on window blur
    Given a context menu is open
    When the window loses focus (blur) or is resized
    Then the menu closes and onClose is called
```

## 8. State catalog (UI)
| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| ContextMenu | Closed | nothing | — |
| ContextMenu | Open/idle | floating panel of items at cursor | hover to highlight, click to activate |
| MenuItem | Default | label (+ optional icon) | click → onClick |
| MenuItem | Hover | accent-soft background | click |
| MenuItem | Keyboard-active | accent-soft background (from arrow keys) | Enter |
| MenuItem | Disabled | faint text, no hover | none |
| MenuItem | Danger | red text/icon | click (destructive) |
| Separator | — | thin divider line above item | none |

## 9. Interaction inventory (UI)
| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| ContextMenu container | open/close/position | mousedown-outside closes | Esc closes | (n/a — desktop Electron) | this *is* the context menu | `role="menu"` |
| MenuItem | activate | click activates | Up/Down move active, Enter activates | — | — | `role="menuitem"`, `aria-disabled` when disabled |
| Separator | — | — | skipped by nav | — | — | decorative (no role) |

## 10. Accessibility & i18n (UI)
- **Roles:** container `role="menu"`; each actionable item `role="menuitem"`; disabled items expose `aria-disabled`. Separators are non-interactive `<div>`s (decorative).
- **Keyboard:** Up/Down traverse enabled items (wrap at ends), Home/End jump to the first/last enabled item, Enter activates the active item, Escape closes (via shared `use-escape-key`). Pointer users are unaffected (highlight is only engaged once an arrow/Home/End key is pressed).
- **Screen-reader announcement:** The active item is exposed via `aria-activedescendant` on the `role="menu"` container, pointing at the active `menuitem`'s id. This gives AT a focus target without moving DOM focus into the overlay. When no item is active, the attribute is omitted.
- **Focus:** Menu does not trap focus in MVP (it's a transient overlay closed by outside-interaction); keyboard navigation/activation is handled by a window-level keydown listener while open. Combined with `aria-activedescendant`, this preserves current pointer behavior while adding accessible keyboard nav. Tab is not hijacked; if the user Tabs away the menu dismisses via blur. (Full WAI-ARIA focus-trap + roving tabindex is deferred — see Vision.)
- **Contrast / visibility:** Uses existing tokens; danger items use `--red`; disabled use `--text-faint`. No new color decisions.
- **Reduced motion:** Open animation is the existing `modal-fade` (0.1s) — negligible; no separate reduced-motion handling needed (assumption).
- **i18n:** Item `label`s are caller-supplied strings; the component imposes no hardcoded copy. No new user-facing strings are introduced by the component itself, so there is nothing to translate here. (Conduit currently ships English-only; out of scope to add i18n infra.)

## 11. Design tokens (UI)
Semantic roles already present in `webview/styles.css` `.ctxmenu*` and reused verbatim — no raw hex introduced by this work:
- Surface: `--panel-2`; border: `--border-2` / `--border`; radius: `--r-sm`.
- Text: `--text`, `--text-dim` (icon), `--text-faint` (disabled).
- Accent (hover/active): `--accent-soft`.
- Danger: `--red` (and the existing `rgba(224,114,111,0.14)` danger-hover — pre-existing in stylesheet, not introduced here).
- Single dark theme only; no light/high-contrast variants exist in the app.

## 12. Assumptions
- A prior task already extracted `ContextMenu` and wired all four app menus onto it; this work **hardens** that primitive (pure tested clamp helper, `use-escape-key`, keyboard nav, ARIA) rather than creating it from scratch. Behavior/items of the four menus must remain byte-identical.
- `label` is unique within a single menu (used as React key) — true for all current menus.
- Item `onClick` callbacks are non-throwing simple actions; no error-boundary handling added.
- The danger-hover `rgba(...)` literal already in the stylesheet is pre-existing and left as-is (not introduced by this change; out of scope to refactor unrelated CSS).
- Desktop Electron target — no touch interaction surface to design for.
- The pure helper lives in `src/` (e.g. `src/menu-position.ts`) so the node-env Vitest suite (`test/unit/**`) can import it, matching the existing `layout`/`reorder` pattern where `webview/` imports from `../src/`.

## 13. Decisions Needed (autonomous mode)
- [normal] Whether to add keyboard navigation now or defer to a consumer task. **Default taken:** add it now (cheap, additive, improves a11y of the foundation; no item-list changes). Reversible.
- [normal] Where the pure clamp helper lives. **Default taken:** `src/menu-position.ts` to fit the existing test harness (node env, imports from `src/`). Reversible.
- [normal] Auto-focus first item on open. **Default taken:** no — only engage keyboard highlight on first arrow press, to avoid surprising pointer users. Reversible.

## 14. Open questions
None (autonomous mode — all routed to Assumptions / Decisions Needed).
```

## Self-audit
All core-spine sections (1–7) and UI-module sections (8–11) are filled. Sections 12–13 carry the autonomous-mode assumptions and flagged decisions. Section 14 is intentionally empty (autonomous). Non-UI section 3 is included because the prop API *is* this component's contract and downstream tasks need it. No section left thin without justification.
