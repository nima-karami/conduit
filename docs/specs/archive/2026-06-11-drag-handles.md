# Spec — B1: Drag panels without the explicit handle affordance

**Tier:** FULL · **Feature type:** UI · **Slug:** `drag-handles`

**Triage reason:** Touches three movable-panel surfaces (sessions header, explorer
header, editor tab bar) plus a non-trivial interaction guard that must coexist with
existing intra-bar drags and controls — multi-surface, user-facing, novel guard
logic → FULL.

---

## 1. Problem frame

**Job (JTBD):** _When_ I want to rearrange the workbench panels, _I want to_ grab a
panel by its own bar/header (the way every other app lets me drag a window by its
title bar), _so that_ I move it without an ugly dedicated "drag-handle" strip or a
permanent grab-hand cursor cluttering the UI.

**Today:** Each side panel (`PanelFrame`) renders a separate `.panel__grip` strip —
an uppercase title + a `⠿` dots glyph, with a permanent `cursor: grab` — that is the
*only* place a panel-move drag can start. The center (terminal/editor) panel renders
a `.tabbar__grip` `⠿` glyph at the left of the tab bar for the same purpose. Both
are visually noisy and the grab-hand cursor is always on.

**Actors:** the single local desktop user (Electron renderer). No multi-user / sync.

**Success outcomes:**
- The dedicated grip widgets and the permanent grab-hand cursor are gone.
- A panel-move drag still starts — now from the panel's own bar/header background and
  from the editor tab-bar background (or a tab).
- All existing rearrange/dock capability is preserved (no lost functionality).
- No existing in-bar interaction breaks: sort/filter three-dot button, filter input +
  clear button, New/Search buttons, tab clicks, tab close buttons, and the existing
  intra-bar **tab reorder** drag and **session reorder** drag all still work.

**Non-goals:**
- Changing the drop/dock algorithm (`moveBefore`, `parseLayout`, region order).
- Changing panel **resize** (`.panel__resize`) behavior.
- D2 (reorder whole project groups) — separate item; this only relocates the
  *initiator* and removes chrome.
- Touch / pointer-coarse gestures, keyboard-driven panel move (not present today;
  out of scope).

---

## 2. Behavior & states

A movable panel has a **drag-source bar** (its header/top bar). The drag lifecycle:

- **idle** — bar shown with no grab-hand cursor; controls behave normally.
- **arming** — pointer/`dragstart` lands on the bar; the system decides whether the
  target is a drag-eligible bar background or an interactive control.
- **dragging-panel** — a panel-move drag is in flight (`dragRegionRef` set); other
  panels show their drop-target outline on drag-over; cursor may read `grabbing`.
- **dropped** — on a different region, the layout order updates and persists; state
  resets to idle.
- **cancelled** — drag ends with no valid drop; state resets, no change.

Coexisting, unchanged drags:
- **tab-reorder** (intra `.tabbar`) — a tab dragged over another tab reorders docs.
- **session-reorder** (intra sidebar list) — a session card dragged reorders sessions.

The new rule: a **panel-move** drag must start **only** when the pointer lands on the
bar's own background (non-interactive empty region), never on a control or on a child
element that owns its own drag (a tab, a session card).

---

## 3. Interface contract (the guard)

Extract a pure predicate so it is unit-testable independent of the DOM event plumbing:

```
isPanelDragTarget(target: Element | null, barEl: Element): boolean
```

- Returns `true` only when `target` is the bar element itself or a descendant that is
  **not** inside any interactive/own-drag element.
- Returns `false` when `target.closest(INTERACTIVE_SELECTOR)` matches within the bar,
  or when `target` is outside `barEl`.

`INTERACTIVE_SELECTOR` (the exclusion set) covers, at minimum:
`button, a, input, select, textarea, [role="button"], [role="menuitem"],
[draggable="true"], .tab, .session, [contenteditable="true"]`.

**Invariants:**
- The predicate is side-effect free and DOM-read-only.
- `barEl` itself counts as eligible background (dragging the empty bar moves the panel).
- A control nested arbitrarily deep inside the bar is still excluded (uses `closest`).
- A child that declares its own `draggable` (tabs, session cards) is excluded so its
  own reorder drag is never hijacked.

---

## 4. Edge cases & failure modes

- **Empty tab bar** (only the terminal tab): the terminal tab is a `button` → a panel
  drag still works from the empty space to its right. Acceptance: bar background right
  of the tabs initiates panel move.
- **Tab strip overflowing/scrolled:** the scrollable `.tabbar` still has background
  between/after tabs; guard keys off target, not coordinates, so it holds.
- **Filter input focused, user drags the bar background:** input keeps focus/value;
  panel drag starts only if the pointer was on background, not the input.
- **`window.agentDeck` undefined** (browser preview / fake shell): drag is pure DOM +
  React state + a settings write; it must not throw if the host bridge is absent —
  guard any host calls (the existing `update()` already routes through the bridge,
  which no-ops without the host).
- **Nested draggable conflict:** because the bar background is only conditionally the
  drag source, and tabs/cards set their own `draggable`, the browser starts the drag
  on the element under the pointer; the guard ensures the bar's `dragstart` does not
  fire a panel move when it originated from a child control.
- **Rapid click on a control inside the bar:** must register as a click, not a drag —
  guard returns `false` so no panel-move starts and the control's handler runs.

---

## 5. Defaults vs. settings

No new settings. This is a chrome/affordance change with one obvious behavior.
Rationale: a drag affordance has a single correct design; a toggle would be
over-production. Existing `settings.layout` / widths persistence is unchanged.

| Default | Value | Rationale |
|---|---|---|
| Cursor on bar background | subtle — at most `grab` on hover of true background, `grabbing` only during active drag; no permanent hand | wishlist asks for "no permanent grab-hand"; prefer subtle |
| Drag source | bar background + (for editor) a tab also moves the panel? | See Decisions Needed D-1 |

---

## 6. Scope slicing

- **MVP:** Remove `.panel__grip` and `.tabbar__grip` widgets + permanent grab-hand
  CSS. Make `PanelFrame`'s header bar and the `.tabbar` the panel-move drag source via
  the guarded predicate. All existing controls + tab-reorder + session-reorder intact.
- **v1 (this pass):** subtle cursor (`grab` on true bar background only; `grabbing`
  while dragging). A thin, quiet panel header retained where one is needed as a drag
  surface, but with no title-strip/dots chrome.
- **Out of scope:** D2 group reorder; keyboard move; touch gestures; redesigning the
  panel header contents.

---

## 7. Acceptance criteria

### Declarative
- The `.panel__grip` "Drag to move the … panel" strip (title + `⠿`) is removed from
  every side panel.
- The `.tabbar__grip` `⠿` glyph is removed from the editor tab bar.
- No element shows a permanent `cursor: grab` grab-hand at rest.
- Dragging from a side panel's bar/header **background** rearranges that panel exactly
  as the old grip did.
- Dragging from the editor **tab-bar background** rearranges the center panel exactly
  as the old `.tabbar__grip` did.
- Clicking the three-dot sort/filter button opens its menu (no drag started).
- Typing in the filter input and clicking its clear button work (no drag started).
- Clicking a tab selects it; clicking a tab's close button closes it (no drag).
- Dragging a tab over another tab still reorders docs.
- Dragging a session card still reorders sessions.

### EARS
- **Event:** When the user begins a drag on a panel bar's non-interactive background,
  the system shall start a panel-move drag for that panel.
- **Unwanted:** If a drag begins on an interactive control or an own-draggable child
  inside the bar, then the system shall NOT start a panel-move drag.
- **State:** While a panel-move drag is in flight, the system shall show drop-target
  affordances on other regions and may show a `grabbing` cursor.
- **Ubiquitous:** The system shall not display a permanent grab-hand cursor on any bar
  at rest.
- **Event:** When a panel-move drag is dropped on a different region, the system shall
  reorder and persist the layout (unchanged dock algorithm).

### Gherkin
```gherkin
Feature: Drag panels from their own bar
  Background:
    Given the workbench shows the sessions, center, and explorer panels

  Scenario: Move a panel by its bar background
    Given no dedicated drag-handle widget is visible
    When I drag the sessions panel header background onto the center panel
    Then the sessions panel is re-docked and the new order persists

  Scenario: Controls in the bar are not hijacked
    When I click the three-dot sort/filter button in the sessions bar
    Then its menu opens and no panel-move drag starts

  Scenario: Tab reorder still works
    Given two document tabs are open
    When I drag one tab over the other
    Then the tabs reorder and the center panel does not move
```

---

## Decisions Needed

- **D-1 (normal):** Should dragging an editor **tab** (not just the tab-bar
  background) move the whole center panel? The wishlist says "grab a TAB inside the
  code editor (or the whole tab bar)". **Conflict:** tabs already own an intra-bar
  reorder drag. Decision (conservative, reversible): **panel-move initiates from the
  tab-bar background only; tabs keep their existing reorder drag.** This preserves
  tab-reorder unambiguously and still satisfies "grab the whole tab bar." If a future
  pass wants tab-as-panel-handle, it needs a disambiguation gesture (e.g. modifier or
  drag-threshold) — noted, not built now.
- **D-2 (normal):** Do the side panels still need a visible (empty) header bar to grab,
  or can the entire panel be the drag surface? Decision: **keep a slim, quiet header
  bar** as the drag surface (a full-panel drag source would conflict with the panel's
  scrollable content and its many controls). The header loses its title/dots chrome
  and grab cursor but remains a thin grabbable strip.

---

## Self-audit

All core-spine sections present (problem, states, contract, edge cases, defaults,
scope, acceptance). UI module: state catalog (§2), interaction inventory (§3–4),
cursor/affordance (§5). a11y: drag is mouse/pointer only today; no new a11y
regression introduced; keyboard panel-move was never present and stays out of scope
(flagged). i18n: removed strings were the grip `title` tooltips ("Drag to move the …
panel"); no new user-facing copy added. Design tokens: cursor change only; no new
colors. No unaddressed checklist items.
