---
status: active
date: 2026-06-22
tier: LITE
---

# Feature Spec: Git-history ref selector uses the app's own dropdown

**Tier:** LITE   **Feature type:** UI
**One-line request:** "The branch selector dropdown under the git history tab SHOULD use our own dropdown UI, not the OS dropdown."

## 1. Problem frame

- **Job:** Filter the git-history graph by ref using a control that looks and behaves
  like the rest of Conduit, not a native OS widget.
- **Actors:** A user viewing the History tab who wants to scope commits to a branch /
  tag / ref.
- **Success outcome (observable):** The ref filter renders as Conduit's themed
  dropdown (matching the indicator-bar branch switcher), not the platform `<select>`
  popup, with identical filtering results.
- **Non-goals:** Changing *what* refs are offered, the filter semantics, or any other
  History-tab control. Not switching branches (this is read-only filtering).

## 2. Behavior & states

Today: `git-history-view.tsx:763–775` renders a native `<select className="gh__reffilter">`
with an "All branches" option (value `""`) plus one `<option>` per ref from
`collectRefs(state.commits)`; `onChange` calls `onRefFilter(value || null)`.

New behavior: a **trigger button** showing the current selection ("All branches" or
the ref name) opens a portaled custom menu listing the same options; selecting a row
calls the same `onRefFilter(refName | null)` and closes the menu.

| State | What the user sees |
|---|---|
| Closed | Button labeled with current ref (or "All branches") + a caret |
| Open | Menu of rows: "All branches" first, then each ref; current row marked selected |
| Selected | Menu closes, button label + graph filter update |
| Empty refs | Control not rendered (unchanged: only shows when `refOptions.length > 0`) |

## 3. Data / interface contract

Unchanged props/data flow — only the rendering changes:
- Input: `refOptions: GitRef[]` (from `collectRefs(state.commits)`), `refFilter: string | null`.
- Output: `onRefFilter(refName: string | null)` — `null` for "All branches".
- No new IPC; reuses the already-loaded commit refs.

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Zero refs | Control hidden (as today). |
| One ref | Menu still works (All branches + that ref). |
| Many refs | Menu scrolls (reuse `.ctxmenu` max-height/overflow); type-to-filter optional (see Assumptions). |
| Current ref filtered out after refresh | If `refFilter` no longer exists in `refOptions`, fall back to "All branches" (matches native-select behavior where a missing value shows blank). |
| Click-outside / Esc | Menu dismisses without changing the filter. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Reuse component | Prefer a shared filterable-menu over a bespoke one | No | Two ref/branch menus now exist; converging avoids drift. |
| Type-to-filter | Off for MVP, on if list is long | No | Ref lists are usually short; the branch switcher already has the pattern to lift if needed. |

## 6. Scope slicing

- **MVP:** Replace the native `<select>` with a trigger button + portaled menu
  (reusing `ContextMenu` or a `BranchSwitcherMenu`-style component) wired to the
  existing `onRefFilter`. Themed, keyboard-navigable, dismiss-on-outside/Esc.
- **v1:** Factor a shared filterable-menu so the indicator-bar branch switcher and
  this ref filter share one implementation (the explore notes both already lean on
  `.ctxmenu` + `clampMenuPosition` + `createPortal`).
- **Out of scope:** Switching branches from this control; remote/tag grouping.

## 7. Acceptance criteria

- The History-tab ref filter no longer renders a native `<select>`; it renders
  Conduit's themed dropdown.
- Selecting "All branches" sets the filter to `null`; selecting a ref sets it to that
  ref name; the graph updates identically to before.
- The dropdown is operable by keyboard (↑/↓/Enter/Esc) and dismisses on
  outside-click and Esc.
- With zero refs the control stays hidden.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Ref trigger button | default | Current ref / "All branches" + caret | Click → open |
| Ref menu | open | "All branches" + ref rows; current marked | Click/Enter row → select |
| Ref menu | empty (filtered) | "No matches" (only if type-to-filter enabled) | type / Esc |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Trigger | open/close | click | Enter/Space open | — | `aria-haspopup`, `aria-expanded` |
| Menu | select/dismiss | click row; outside dismiss | ↑/↓/Home/End/Enter/Esc | — | `role="menu"`, rows `role="menuitemradio"` + `aria-checked` for current |

Reuse the established menu patterns (`branch-switcher-menu.tsx` already does
`menuitemradio` + current-pinned + portal + keyboard nav; `context-menu.tsx` provides
generic rows). Either is acceptable; v1 converges them.

## 10. Accessibility & i18n

- Keyboard + screen-reader parity with the indicator-bar switcher (`role="menu"`,
  `menuitemradio`, `aria-checked`, focus management already implemented there).
- Strings ("All branches", filter label) route through the existing git-history
  `STR.*` constants — no new hardcoded English. The native `<select>`'s
  `aria-label` (`STR.filterLabel`) carries to the new trigger button.

## 11. Design tokens (UI)

- Reuse `.ctxmenu` / `.git-branch-menu` styling (hover `--accent-soft`, themed
  border/shadow). Trigger button matches the History filter-bar control styling
  (`gh__reffilter` visual weight). No new hex; inherits theme variants.

## 12. Assumptions

- Reusing an existing menu component (not building new positioning/dismiss logic) is
  expected — the repo already has two proven menus and the shared helpers
  (`clampMenuPosition`, `useEscapeKey`, portal).
- Type-to-filter is omitted in MVP; the branch switcher's filter can be lifted later
  if ref lists grow long.
- No persistence: the ref filter remains view-local state as it is today.

## 14. Open questions

- None blocking. (Whether to converge into a single shared menu component is a v1
  refactor decision, not a behavior change.)
