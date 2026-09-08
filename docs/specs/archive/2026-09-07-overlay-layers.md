---
status: shipped
date: 2026-09-07
---

# Feature Spec: Overlay layers — every popup escapes its pane and stacks in order

**Tier:** FULL   **Feature type:** UI
**One-line request:** "There are pages and pop-ups around our application that don't fully display the
dropdown … what appears gets clipped … I think that's a side effect of us not using our native or
primitive components. Do a search for that class of issue … or a pop-up requires a confirmation on top
but the confirmation renders under the pop-up." Plus QA finding F1 from the 2026-09-07 re-verification
of review-mode (header/action bar overflow at the window's minimum width).

Inputs: `.autoloop/evidence/2026-09-07-review-verify-and-overlay-audit/overlay-audit.md` (static
audit, nine findings, z-index ledger, nesting matrix) and `qa-main-9c58182.md` (runtime QA, F1).

## 1. Problem frame

- **Job:** any floating surface — dialog, confirm, dropdown, popover, full-screen viewer, editor
  widget — is fully visible wherever it was opened from, sits above the thing that opened it, and
  answers Escape in the order it was opened. Nobody writing a new dialog has to know which ancestor
  blurs, clips or chamfers.
- **Actors:** the user; future contributors adding an overlay.
- **Success outcomes:** the nine audited surfaces are visibly fixed in all three themes; there is one
  way to mount a modal and one way to float an anchored popup, and both are what `ContextMenu`
  already does; the Review header stays operable at the window's minimum width.
- **Non-goals:** a focus-trap for every dialog (only where one exists today); restyling any dialog;
  redesigning the compare combobox or the type picker beyond where their popups live; a generic
  tooltip system; touching `.board`'s deliberately pane-local overlays; removing the panel blur.

### Root cause, in one paragraph

Overlays are `position: fixed` but rendered **inline** where their owner happens to live. Two
stylesheet rules turn ordinary ancestors into containing blocks and clippers for them:
`backdrop-filter` on `.right`, `.sidebar`, `.topbar`, `.termwrap` (`styles.css` ~6698–6713, on for any
background but `none`; default is `aurora`) and Neon's `clip-path` chamfer on `.chamfer`/`.modal`/
`.btn`/… (~491–500). Modals all share `z-index: 60` and no layer order, so a confirm opened *by* a
dialog paints under it when it happens to come first in JSX. `ContextMenu` escapes all of this by
portaling to `document.body` (its docstring names the hazard); every clipped surface bypassed it.

## 2. Behavior & states

### 2.1 Primitives (the fix)

- **One overlay stack** (module singleton, the repo's publish/subscribe store shape). Every
  `ModalLayer` and every `Popover` pushes an entry `{ id, kind: 'modal' | 'popover', onDismiss }` on
  mount and pops it on unmount. The stack owns the **single Escape listener** (window, capture): it
  calls `onDismiss` of the **top entry only** and stops the event there. No overlay binds its own
  Escape any more. When a `modal` entry is pushed, every `popover` entry below it is dismissed
  (menus are transient; a confirm must never mount under an open menu — audit N7).
- **`ModalLayer`** — portals its backdrop to `document.body` and paints at
  `calc(var(--layer-modal) + depth)`, depth = its index among mounted modal entries (bounded to the
  reserved band, §2.3). Scrim click = `onDismiss` (caller-controlled). The backdrop's class is `backdropClass`
  (default `modal__backdrop`); a caller that needs more passes the full list (the palette passes
  `modal__backdrop palette__backdrop`; the mermaid viewer passes `mermaid-zoom__backdrop` alone —
  the one caller that opts out of the scrim styling, and which thereby moves from z 200 to the
  modal band, so toasts now paint above the fullscreen viewer).
- **`Popover`** — portals an anchored floating box to `document.body` at `--layer-popover`,
  positioned by the existing pure helpers (`anchorMenuToRect` → `clampMenuPosition`), re-clamped
  after first layout, dismissed on outside mousedown / any capture-phase scroll outside itself /
  blur / resize, and on Escape through the stack; keeps the `triggerRef` toggle contract.
  **`ContextMenu` becomes a consumer of `Popover`** (its portal, clamp and dismiss code moves into
  `Popover`; nothing is copied). Content semantics stay the caller's (`role="menu"`, `listbox`, a
  filter input…). The popover frame element and every backdrop declare
  `-webkit-app-region: no-drag` and are listed in the drag-region guard's overlay roots (CLAUDE.md:
  Electron's drag mask ignores z-order, and no e2e can catch it).
- A **Monaco overflow host**: one body-level node handed to every `create`/`createDiffEditor` as
  `overflowWidgetsDomNode`, so hover cards, suggest and parameter-hint widgets are laid out against
  the viewport instead of the editor's (blurred, clipped) pane. `fixedOverflowWidgets: true` alone is
  wrong here: it makes the widgets `position: fixed` inside `.termwrap`, whose blur would then trap
  them.
- **Layer tokens** in `:root`: `--layer-modal: 60` (band 60–79 reserved for stacked modals),
  `--layer-popover: 80`, `--layer-toast: 200`, `--layer-theatre: 300`, replacing the literals in
  `.modal__backdrop`, `.ctxmenu`, `.toasts`, `.theatre`; `.mermaid-zoom__backdrop`'s `z-index: 200`
  is deleted (its z is now the layer's inline value). The stacked modal z is an inline
  `calc(var(--layer-modal) + depth)`.

### 2.2 Surfaces that change (each audit finding → its fix)

| # | Surface | Today (per audit) | After |
|---|---|---|---|
| 1 | Explorer name-collision prompt (`ConflictDialog`) | trapped in the 340px rail, buttons cut | `ModalLayer`; centred on the window |
| 2 | Compare refs dialog → ref combobox list | clipped by the dialog's Neon chamfer | list in a `Popover` anchored to the input, full width of the input, viewport-clamped |
| 3 | Timed messages → discard/cancel confirm | paints under the dialog; Escape ambiguous | confirm is a later layer → above; Escape closes the confirm only |
| 4 | Arch inspector type picker | clipped by the inspector scrollport | `Popover` anchored to the chip |
| 5 | Mermaid expand overlay | covers only the doc pane | `ModalLayer` (own backdrop class); covers the window |
| 6 | Review in-view confirms (discard hunk/file, unsaved note) | scrim covers only the doc pane | `ModalLayer`; window scrim |
| 7 | Arch "Delete component?" | inside `.arch`'s z-40 context, under menus/toasts | `ModalLayer` at root; any open menu is dismissed when it mounts |
| 8 | Monaco hover / suggest / parameter hints | clipped to the editor box (suspected) | overflow host at body level |
| 9 | Native `<select>` in timed-message (×2) and arch inspector Kind | OS chrome, unthemed | `SelectField` |
| F1 | Review header + action bar at ≤ ~450px header width | source label and stats collapse to 0, `…` unreachable, Stage all clipped | §2.4 |

All nine `className="modal__backdrop"` sites migrate to `ModalLayer` (command palette, compare,
confirm, conflict, icon picker, new session, settings, timed message, web prompt) so there is no
second way left to mount a modal.

### 2.3 Layer stack semantics

- Depth is assigned on mount, released on unmount; siblings re-derive depth, so closing a middle
  layer never leaves a gap that reorders survivors. Depth is clamped to 19 (the reserved band);
  a 21st simultaneous modal is not a reachable state, and the clamp keeps it under `--layer-popover`.
- **Escape:** the stack dispatches to the top entry only. Today the nine dialogs handle Escape three
  different ways (measured: `useEscapeKey` ×4, a raw window `keydown` ×3 — confirm, conflict, new
  session — and a React `onKeyDown` on the dialog root ×2 — compare, timed message; the mermaid
  viewer also uses a root `onKeyDown`). All of those Escape branches are removed; each dialog passes
  the same decision as its `onDismiss`:

  | Dialog | `onDismiss` |
  |---|---|
  | `ConfirmDialog`, `ConflictDialog`, new session, settings, web prompt, palette, icon picker, compare, mermaid | its existing close/cancel callback |
  | Timed message | `requestClose` (unchanged: opens the discard confirm when the draft is dirty, which mounts as a new top entry and then owns Escape) |

  Non-Escape keys stay local: Enter in `ConfirmDialog`, arrows in the palette, the Tab-trap
  `onKeyDown` handlers in compare / timed message / mermaid. The compare combobox's "Escape closes
  the open list first" survives because the list is a `Popover` and therefore the top entry.
- A `Popover` opened from inside a modal paints above every modal and takes Escape first.
- A `Popover` closes on outside **mousedown**; the click that follows lands on whatever was under
  the pointer (a scrim, if that is what was clicked, then also dismisses its dialog). This is the
  existing `ContextMenu` behaviour and is kept.
- Toasts stay above modals and popovers; the theatre film stays above everything and inert.

### 2.4 Review header at narrow widths (F1)

Container queries on `.review__head` (already a container) and on `.review__actionbar` (becomes one;
its only popup is the portaled overflow menu, so containment traps nothing):

| Header inline size | Behaviour |
|---|---|
| ≤ 900px | count word hidden (exists) |
| ≤ 720px | reviewed meter hidden (exists) |
| **≤ 480px** (new) | scope segment and `.review__stats` hidden (the navigator's header already shows the counts); the `…` overflow menu gains a `Scope` group — `All` / `Staged` / `Unstaged` as checkable rows, current one checked, all three disabled when the source is a commit or range (same rule as the segment: the menu's owner derives both from `source` via `scopeOfSource` and `source.kind !== 'working'`). Source trigger label keeps a floor of 72px and truncates with an ellipsis instead of collapsing to 0. |
| action bar ≤ 480px | notes summary hidden; the agent-handoff button shows its icon only (accessible name unchanged); `Stage all` keeps its label. |

Invariant restored from the review-mode spec §2.2: the header's right cluster (find, `…`) and the
panel toggle are never pushed outside the header; neither the header nor the bar ever overflows
horizontally.

### 2.5 Current behaviour

| Claim about today's behaviour | How it was measured | Measured or ASSUMED |
|---|---|---|
| Review action-bar `Discard all…` confirm (mounts in `app.tsx`) and `Compare refs…` dialog (mounts under the unpositioned `.center`) are window-centred | runtime QA 2026-09-07, bounding boxes vs window, 3 themes | Measured |
| At a 250px header (900px window, default rails) the head overflows 119px, source label and stats are 0px, `.review__more` is not hit-testable, the bar overflows 34px | runtime QA 2026-09-07, `narrow.json` sweep | Measured |
| Findings 1–7: trapped / clipped / mis-ordered as described | static read of the ancestor chain and stylesheet (audit) | **ASSUMED** — static analysis is inference. The build captures a baseline screenshot of each at the base commit before changing anything (§7 AC-0); a finding that does not reproduce is recorded, not "fixed". |
| Finding 8: Monaco widgets clip at the pane edge | none | **ASSUMED** — baseline capture required (hover near the bottom-right of a narrow editor, and inside a change-peek zone) |
| `ConfirmDialog` binds Escape on `window`; `TimedMessageDialog` handles it in a root `onKeyDown`, so with the confirm open both fire (the dialog's, via bubbling, only when focus is inside it) | grep of `keydown`/`useEscapeKey`/`onKeyDown` across the nine sites (code map 2026-09-07) | Measured (static); the visible outcome is captured in AC-0's baseline for finding 3 |
| The arch type picker has no outside-click dismiss today (closes on Escape or pick only) | grep `mousedown` in `architecture-view.tsx`: none | Measured; the `Popover` adds outside-click dismiss — a deliberate behaviour change |
| `.shell > .sidebar/.center/.right` and `.resizer` rules are dead | recursive grep (audit) | Measured (grep); delete as part of the layer-token change, cite the grep in the commit |

## 3. Data / interface contract

- `ModalLayer` props: `onDismiss?: () => void` (scrim click + Escape when topmost; omit for a layer
  that must not dismiss that way), `backdropClass?` (default `modal__backdrop`), `children`.
  Portals to `document.body`. Renders the backdrop element with inline `zIndex`; because portals
  append in mount order, DOM order already stacks later modals above earlier ones and the inline
  z is the explicit statement of the same order.
- The Settings modal's shortcut recorder (which today wins Escape by listening in the capture
  phase) becomes a stack entry while recording, so Escape cancels the recording and not the modal.
- `Popover` props: `anchor: Rect` (viewport coords) **or** `at: Point`, `width?: number` (floor;
  select-style popups match their trigger — the combobox passes its input's rect width, replacing
  today's `left: 0; right: 0` sizing), `onClose: () => void` (idempotent; fires from many
  listeners), `triggerRef?`, `className?`, `role?`/aria passthrough, `children`. Positions with
  `anchorMenuToRect` then `clampMenuPosition`; re-clamps after first layout (content size).
- Overlay stack: a module singleton (publish/subscribe/get triplet like `review-nav-store`, read
  with `useSyncExternalStore`), exposing register/unregister and `modalDepth(id)`. Pure ordering and
  Escape-dispatch logic unit-tested without a DOM.
- Escape routing: one window `keydown` capture listener owned by the stack. `useEscapeKey` stays
  only for non-overlay consumers (find bars etc.); no overlay uses it after this spec.
- Combobox a11y across the portal: the combobox input keeps `aria-controls` and
  `aria-activedescendant`; its wrapper adds `aria-owns={listId}` so the portaled listbox is still
  in the combobox's accessibility tree.
- Monaco: `webview/monaco-setup.ts` (or the existing editor-creation seam) owns one lazily-created
  host node appended to `document.body`, passed as `overflowWidgetsDomNode` to both creates.
- Review overflow menu: the scope rows call the same `onSetSource` the segment calls
  (`review-source-control.tsx:30`), so there is one producer of scope changes.

Producers / consumers:

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Modal open/close state | each dialog's owner (unchanged) | `ModalLayer` stack (new) | yes |
| Escape keydown | window | today: every dialog's own listener + `ContextMenu`/wrapper menus via `useEscapeKey`; after: the stack alone, dispatching to the top entry (modal or popover) | yes — every migrated dialog's and `ContextMenu`'s Escape listener is removed in the same slice |
| Popup anchor rect | trigger element (`getBoundingClientRect`) | `Popover` | yes |
| Review scope value + disabled rule | `review-source-control.tsx` derives both from `source` today; after: `review-view.tsx` (owner of the `…` menu) derives the same from `source` for the rows | both `onSetSource` producers → review source state (unchanged) | yes |
| Monaco overflow widgets | Monaco | body-level host node | yes |
| `background` / `--bg-blur` setting | settings | the blur rules (unchanged) | no — untouched by design; portaling makes the blur irrelevant to overlays, and AC-10 proves both `none` and `aurora` |

## 4. Edge cases & failure modes

| Condition | Expected behaviour |
|---|---|
| Confirm opened over a confirm (depth 3) | each paints above the previous; Escape unwinds one at a time |
| Two layers mount in the same commit | depth follows mount order; both visible; the later one is top |
| Middle layer closes | survivors keep relative order, re-derived depths, no flicker |
| Popover open, window resized / any container scrolled | popover closes (existing menu behaviour) |
| Popover inside a modal; scrim click | mousedown closes the popover; the same click's `click` event then reaches the scrim and dismisses the dialog (existing menu behaviour, kept) |
| A modal mounts while a context menu is open | the menu is dismissed by the stack before the modal paints |
| Combobox rows in a portal | mousedown on a row is prevented (existing) so the input keeps focus and `onBlur` does not close the list before `onClick` |
| Type picker Escape | still stops propagation to the canvas (React synthetic events cross portals along the React tree) so the canvas does not also step up a level |
| Portaled dialog opened from the arch canvas | clicks inside it are outside React Flow's DOM — no pan/drag starts |
| `background: none` | nothing to trap; overlays behave identically |
| Neon | dialogs keep their own chamfer; the popover frame's chamfer (if it uses `.ctxmenu`) clips only the popover's own box |
| Reduced motion | modal fade already respects it; no new animation |
| Header exactly at a breakpoint while the source picker is open | the picker is portaled; hiding the segment does not unmount the picker |
| Monaco editor disposed while a hover is showing | Monaco removes its widget from the host node; the host node itself is never removed |
| Fake-shell preview in a plain browser | portals to `document.body` work without the host bridge |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Scrim click dismisses | as each dialog does today | no | unchanged behaviour |
| Modal base / popover / toast / theatre layer values | 60 / 80 / 200 / 300 | no | the existing ledger, now named once |
| Header breakpoint for hiding the scope segment | 480px | no | measured: degradation begins below ~450px |
| Source label floor | 72px | no | enough for an ellipsised ref name plus caret |
| Monaco widgets host | on for all editors | no | no reason to keep a clipped variant |

## 6. Scope slicing

- **MVP (must):** layer tokens; `ModalLayer` + stack + Escape routing, all nine backdrop sites and
  the mermaid overlay migrated; `Popover` with `ContextMenu` rebuilt on it; combobox and type picker
  popups on `Popover`; Monaco overflow host; three `SelectField` swaps; F1 header/bar; unit tests
  for the stack ordering and the pure positioning; e2e for the previously broken surfaces; the dead
  `.shell > …` arms and `.resizer` rules deleted.
- **v1 (should):** `anchorMenuToRect` gains a `prefer: 'above'` option used by the action-bar `…`
  so the menu opens above the bar instead of over it (QA F4).
- **Vision (could):** `BranchSwitcherMenu`, `CommitPickerMenu`, `RepoPickerMenu` on `Popover`
  instead of three copies of its logic; a focus trap in `ModalLayer`.
- **Out of scope:** any dialog's content, copy or styling; the pane-local overlays the audit marked
  clean by design (board, markdown TOC, find bars, review `?` help).

## 7. Acceptance criteria

**AC-0 (baseline first).** Before any change, each of findings 1–8 is captured at the base commit
in the real app; the capture is the evidence the fix is measured against.

EARS:
- The app **shall** mount every modal backdrop and every anchored popup as a child of
  `document.body`. (Ubiquitous; verified by a unit test asserting no JSX `className="modal__backdrop`
  attribute remains outside `ModalLayer`, and by e2e DOM parentage checks.)
- **When** a modal opens while another modal is open, the app **shall** paint the new one above the
  old one, regardless of JSX order.
- **When** Escape is pressed with two or more modals open, the app **shall** close only the topmost.
- **While** a popover is open inside a modal, the app **shall** paint it above every modal, and
  Escape **shall** close only the popover.
- **When** a modal opens while a context menu is open, the app **shall** dismiss the menu first.
- The popover frame and every modal backdrop **shall** be excluded from the window drag region
  (`no-drag`), guarded by `test/unit/drag-region.test.ts`.
- **If** a backdrop is rendered inside a blurred, clipped or chamfered ancestor, **then** the modal
  **shall** still cover and centre on the window (the portal makes the ancestor irrelevant).
- **When** the ref combobox opens, the app **shall** show the whole list (up to its max height) with
  no edge cut by the dialog, in all three themes.
- **When** a type chip opens its picker for the last port in a scrolled inspector, the app **shall**
  show the whole picker.
- **When** a Mermaid diagram is expanded, the overlay **shall** cover the whole window.
- **When** a Monaco hover appears near the pane's bottom-right edge, the app **shall** show it whole.
- **While** the Review header is ≤ 480px wide, the app **shall** expose All/Staged/Unstaged in the
  overflow menu and keep the `…` button hit-testable; the source label **shall** be at least 72px
  wide with visible text; the header and bar **shall not** overflow horizontally at any width the
  window allows.
- The three replaced native selects **shall** render the app dropdown with the same options,
  labels, values and accessible names.

Gherkin (key flows):

```gherkin
Feature: Overlays escape their pane and stack in order
  Background:
    Given Conduit is open on a repo with the default aurora background

  Scenario: A confirm opened by a dialog is on top and owns Escape   (finding 3)
    When I open Timed messages, type a message and press Escape
    Then the "Discard this message" confirm is above the dialog and its buttons are clickable
    When I press Escape again
    Then only the confirm closes and the Timed messages dialog is still open

  Scenario: The name-collision prompt is centred on the window   (finding 1)
    Given the right pane is at its default width
    When I drop a file onto a folder that already contains that name
    Then the prompt's box is centred on the window and all three buttons are fully visible

  Scenario: The compare combobox list is not clipped under Neon   (finding 2)
    Given the theme is Neon
    When I open Compare refs and focus the base field
    Then the list's bottom edge is inside the viewport and not inside the dialog's clip

  Scenario: Review header at the minimum window width   (F1)
    Given the window is 900px wide with the sessions rail and right pane at their defaults
    When Review is the active tab
    Then the overflow button is hit-testable, "Stage all" is fully inside the bar,
      and the overflow menu lists All, Staged and Unstaged with the current one checked
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| `ModalLayer` | open (depth n) | scrim + dialog above everything opened before it | Escape / scrim click dismisses (when the caller allows) |
| `ModalLayer` | stacked | each later dialog above the earlier, earlier still visible beneath the new scrim | — |
| `Popover` | open | anchored box, clamped to the viewport | outside click / scroll / resize / Escape closes |
| Combobox list | populated / no match / "Refine to see N more" / loading ("Loading refs…") / error (the dialog's existing `phase === 'error'` state) | as today, now fully visible in the popover | pick, refine, retry (existing) |
| Type picker | populated / no match / "new interface" row | as today, fully visible | pick |
| Review header ≤ 480px | compact | segment gone; `…` menu has a Scope group | pick a scope |
| Review header, commit/range source, compact | disabled scope | Scope rows greyed, tooltip says why (segment's existing rule) | — |
| Action bar ≤ 480px | compact | icon-only handoff, Stage all | — |

Offline, permission, not-found: n/a — the only overlay that fetches (compare) keeps its existing
states above; the primitives themselves fetch nothing.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| `ModalLayer` | dismiss | scrim click | Escape (topmost only) | tap scrim | — | children keep their `role="dialog"/"alertdialog"`; `ConfirmDialog` gains the `aria-modal` its siblings already have |
| `Popover` | dismiss | outside mousedown | Escape; content keys are the caller's | tap outside | — | caller's role |
| Scope rows in `…` menu | choose | click | menu arrows + Enter (existing) | tap | — | `menuitemcheckbox` + `aria-checked`, `aria-disabled` on commit/range |
| Icon-only handoff button | send | click | Enter/Space | tap | — | `aria-label` = the full label |
| `SelectField` swaps | choose | click | existing menu keys | tap | — | timed-message units keep `Delay unit` / `Interval unit`; the arch Kind select (bare today) gets `ariaLabel="Kind"` |

## 10. Accessibility & i18n (UI)

- Focus: portaling does not change initial focus (`autoFocus` and the explicit `focus()` calls run
  on mount). On close, focus returns where each dialog returns it today (unchanged).
- Escape order matches visual order (topmost first) — this is a fix, not a regression.
- The compact header keeps every command reachable by keyboard through the `…` menu.
- Accessible names of icon-only controls are unchanged (`aria-label`); the handoff button's label
  becomes its `aria-label` when compact.
- Contrast/colour: no new colours.
- i18n: the repo has no locale layer; copy stays in the components' `STR` constants where they exist
  (`compare-dialog.tsx:29`), plain literals elsewhere, matching the surrounding file. New copy:
  `Scope`, and the three scope labels already in `review-scope.ts` (`SCOPE_LABEL`). No RTL work
  (none exists in the app).

## 11. Design tokens (UI)

- New `--layer-*` custom properties in `:root` (numbers, not colours). No new colour roles; all
  three themes inherit unchanged backdrop, scrim and chamfer tokens.
- The popover frame class joins the `-webkit-app-region: no-drag` rule beside the existing overlay
  roots, and `OVERLAY_ROOTS` in `test/unit/drag-region.test.ts` gains it and the backdrop.

## 12. Assumptions

- The popover frame for the combobox and the type picker keeps each one's existing classes; the
  positioning and sizing rules (`position: absolute; top/left/right`, the combobox's full-width
  stretch) move to the primitive, which sizes from the trigger rect.
- The type picker gaining outside-click dismiss is accepted as part of moving onto `Popover`.
- The compare dialog's Tab trap no longer cycles through the (now portaled) option rows; Tab from
  the last dialog control wraps to the first, and the list is driven by arrows as before.
- A scrim click that also closes an open popover dismisses both (existing behaviour, see §2.3).
- `ContextMenu`'s public props are unchanged, so its ~15 consumers do not move.
- `Toasts` keeps its own portal; only its z literal becomes the token.
- The layer stack is renderer-only state; nothing persists.

## 13. Decisions Needed

- [normal] **Monaco fix is conditional on AC-0.** If the baseline shows Monaco widgets do not clip
  (finding 8 was "suspected"), the overflow host is skipped and recorded. Default: build it only if
  the baseline reproduces the clip.
- [normal] Findings 1–7 are static-analysis claims. Default: capture each at base before fixing;
  any that does not reproduce is reported as such in the run report and left alone.
- [normal] Escape ownership moves from nine per-dialog handlers to the stack (§2.3 table). Default:
  every dialog's `onDismiss` is its existing cancel path; the timed-message dialog keeps routing
  through its dirty-draft confirm. Any dialog whose measured Escape behaviour differs from that table
  at baseline is recorded, not silently matched.
