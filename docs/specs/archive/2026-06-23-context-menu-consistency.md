---
status: implemented
date: 2026-06-23
tier: FULL
---

# Feature Spec: Context-menu ordering & grouping consistency

**Tier:** FULL **Feature type:** UI
**One-line request:** "we have added many options to context menus everywhere across the app, but I don't think the options are ordered and grouped logically and appropriately in all cases, can you check them and suggest better orderings"
**Scope chosen (user):** Consistency + primary-first + dedup/labels (largest of the three).

## 1. Problem frame

- **Job:** When a user right-clicks anything, the menu should be *predictable* — the same kind of
  action lives in the same place every time, the primary action is on top, and the dangerous one
  is alone at the bottom.
- **Actors:** Anyone using the app (mouse + keyboard).
- **Success outcomes:** Every object menu follows one group order; destructive actions are always
  last and separated; no two menus order the same actions differently; labels are worded/cased
  consistently.
- **Non-goals:** No new menu *functionality* (ordering/grouping/labels only — the chosen scope
  permits adding a *missing parallel* item so siblings match, but not net-new actions). No change
  to the `ContextMenu` component's behavior, keyboard nav, or a11y. No restyling.

## 2. The canonical convention (the heart of the spec)

**Object menus** (sessions, tabs, files/folders, change rows, board cards, canvas nodes) — groups
top→bottom, each separated by a divider:

| # | Group | Contains |
|---|---|---|
| 1 | **Primary / open** | the default action for this object (Open, Open diff, Open nested canvas, Start session, Relaunch, Open in split) |
| 2 | **Create** | New file…, New folder…, Add card, Add connected node |
| 3 | **Edit / transform** | Rename, Set icon…, Duplicate, Move to…, Stage/Unstage, Stash/Pop |
| 4 | **Reference** | Copy path, Copy relative path / Copy name, **then** Reveal in Explorer (copies first, reveal last — fixed) |
| 5 | **Destructive** | Delete / Close / Discard — `danger`, **always last, always `separatorBefore`**, scope order single → others → all |

**Content/text menus** (editor, terminal, markdown) keep the OS text-menu idiom they already
follow and are **not** forced into the object taxonomy: Clipboard (Cut/Copy/Paste) → Send/transform
(Mention) → Navigate (Go to Definition, Find) → View (Select all, Word wrap) → Clear. These already
conform; only label casing applies.

**Label rules:**

- **Object menus → sentence case** ("Close others", not "Close Others"; "Close to the right").
- **Editor command menu → keep Title Case** for established command names (Go to Definition,
  Command Palette) — proper-noun commands mirroring VS Code; sentence-casing them would read wrong.
- **Wording:** `Copy path` / `Copy relative path` for filesystem paths; `Copy name` only where the
  name ≠ a filename (sessions). Reconcile `Copy file name` → `Copy name` for tabs.

## 3. Interface contract

`MenuItem` (`label`, `icon`, `onClick`, `danger?`, `separatorBefore?`, `disabled?`) is **unchanged**.
All changes are to the **order of array items** and which item carries `separatorBefore`. Pure
builders (editor/term/markdown/sort-filter) already exist + are unit-tested; inline menus get the
same array reordering.

## 4. Per-menu changes (before → after)

**A. File-tree node — `right-pane.tsx:724`** *(destructive mid-menu → last)*
- File: Open / Open externally / Open with… │ New file… │ Rename… │ Copy path / Copy relative path / Reveal in Explorer │ **Delete (danger)**
- Folder: New file… / New folder… │ Rename… │ Copy path / Copy relative path / Reveal in Explorer │ **Delete (danger)**

**B. Change row — `app.tsx:1307`** *(separate discard; copies-first)*
- Open diff / Open file │ Copy path / Reveal in Explorer │ Stage all / Unstage all │ Stash changes / Pop stash │ **Discard all changes (danger, separatorBefore)**

**C. Session row — `app.tsx:995`** *(primary-first; ungroup the jumble)*
- (cond) Open in split pane / (cond) Relaunch │ Rename / Set icon… / Duplicate session / Move to…(windows) │ Copy path / Copy name / Reveal in Explorer │ **Close / Close others / Close all (danger)**

**D. Terminal-tab — `app.tsx:1172`**
- Rename / Set icon… / Duplicate session / Move to… │ Reveal in Explorer │ **Close editor tabs / Close session (danger)**

**E. Editor-tab — `app.tsx:1102`** *(casing only; keep close-at-top — for tabs, close is the primary, non-destructive action)*
- Close / Close others / Close to the right / Close to the left / Close all │ Copy path / Copy name / Reveal in Explorer

**F. Board card — `board-view.tsx:196`** *(primary-first)*
- Start session for this card │ Add spec… / Edit spec… │ Rename… / Duplicate / Move to <stage>… │ **Delete (danger)**

**G. Architecture node — `architecture-view.tsx:450`** *(primary-first)*
- Open/Create nested canvas │ Add connected node │ Rename… / Duplicate │ **Delete node (danger)**

**Already conform (no change):** editor menu, terminal menu, markdown menu, sort/filter menu, arch
pane menu, sidebar empty-pane menu, ref-filter & tab-overflow dropdowns (pure selection lists),
changes bulk-overflow menu.

## 5. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Conditional items absent (e.g. no Relaunch on a running session) | Group 1 may be empty → the first *rendered* item must never carry a leading separator. |
| All items in a group disabled | Group still renders (disabled items stay discoverable); separators unchanged. |
| Dynamic sub-lists (Move to <window>, Move to <stage>) | Keep internal order; live inside the Edit group. |
| Single window / no other windows | "Move to…" shows only "Move to new window". |

## 6. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Group order | The canonical order above | No | Consistency *is* the feature; a setting would defeat it. |
| Label casing | Sentence case (object) / Title (editor cmds) | No | Convention, not preference. |

## 7. Acceptance criteria

- **EARS:** While any object context menu is open, the system shall render groups in the canonical
  order with every `danger` item in the final group preceded by a separator.
- **EARS:** When a context menu renders, the system shall not display a separator above its first
  visible item.
- **Gherkin:**
  - Given the file-tree node menu, when opened, then "Delete" is the last item and is preceded by a separator.
  - Given the change-row menu, when opened, then "Discard all changes" is last, `danger`, and separated from "Pop stash".
  - Given the session-row menu, when opened, then "Reveal in Explorer" is in the reference group (after the copy items), not first.
  - Given the editor-tab menu, when opened, then labels read "Close others" / "Close to the right" (sentence case).
- **Verification:** real-app e2e opens representative menus (file-tree node, change row, session row,
  editor tab) and asserts visible `.ctxmenu__item` text order + which item has `--danger` +
  separator positions; a cross-menu invariant test asserts "no first item has `separatorBefore`"
  and "every `danger` item is last in its menu". Existing pure-builder unit tests stay green.

## 8. State catalog (UI)

Unchanged — open/hover/active/disabled/dismiss states all live in `ContextMenu` and are untouched.
Only the *contents* of `items[]` change.

## 9. Interaction inventory (UI)

Unchanged — pointer hover/click, keyboard nav (Up/Down/Home/End/Enter), open via `onContextMenu`,
dismiss via Esc/outside-click/scroll/blur/resize all handled by `ContextMenu`. No new interactions.

## 10. Accessibility & i18n (UI)

- **A11y:** No regression — `role="menu"/"menuitem"`, `aria-activedescendant`, `aria-disabled`,
  non-focusable separator `<div>`s already handled. Destructive-last *improves* a11y: predictable
  scan order, dangerous item not adjacent to common ones. Verify the first rendered item never
  carries a separator.
- **i18n:** App has no i18n framework; labels are hardcoded English. N/A beyond the casing/wording
  normalization, which aids any future extraction.

## 11. Design tokens (UI)

None added. `--danger` and the separator token already exist and are reused.

## 12. Assumptions

- Editor-command Title Case is intentional and kept (VS Code parity).
- Tab "close-at-top" is intentional (close is the tab's primary, non-destructive action) — not a violation.
- "Reference group = copies then reveal" is the chosen canonical internal order (was inconsistent; picking one).
- The shared-helper extraction (Vision) is optional and decided at build time, not now.

## 13. Scope slicing

- **MVP:** A, B, E (destructive-last + separator + casing) — pure correctness, zero judgment.
- **v1:** C, D, F, G (primary-first regrouping) + reference-group order standardization app-wide + label dedup.
- **Vision:** extract a tiny pure `orderMenuItems(groups)` helper so future menus declare *groups*
  and get separators/order for free (prevents re-drift). *Flagged optional — possibly over-engineering
  for ~7 menus; decide at build time.*
- **Out of scope:** new actions, styling, `ContextMenu` internals.

## 14. Open questions

None blocking. The one judgment call (shared `orderMenuItems` helper vs. hand-ordered arrays) is
deferred to implementation and flagged above.
