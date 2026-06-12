# Spec — Code-editor context-menu overhaul (E5)

**Tier:** FULL · **Feature type:** UI · **Slug:** `ctx-menu-overhaul`

One-line: replace Monaco's built-in (off-theme) right-click menu in the code editor
with the app's shared `.ctxmenu` component, wired to a useful, context-aware set of
editor actions.

---

## 1. Problem frame

**Job-to-be-done:** When I right-click in the code editor, I want a menu that looks
like the rest of the app and offers the actions I actually need (copy, find,
go-to-definition, etc.) — not Monaco's default menu, which is styled differently and,
once the app hid its built-in goto items, is also too slim.

**Actors:** A user reading code in the Monaco-backed `CodeViewer`.

**Success outcomes:**
- Right-click opens the app-styled `.ctxmenu` (same component as file/tab/session
  menus), positioned at the cursor, dismissing on the shared rules (Esc, outside
  click, scroll, blur, resize, activation).
- The menu carries the essential, *working* editor actions; each acts on the editor.
- Monaco's own native menu never appears in the editor.

**Non-goals:**
- Not making the editor editable. It is read-only today (`readOnly: true`); we do not
  add Cut/Paste behavior (see §5).
- Not re-implementing go-to-definition — we reuse the existing custom
  `agentdeck.goToDefinition` action (CLAUDE.md gotcha; native goto isn't bundled).
- Not touching other menus (file/tab/session/canvas/board).
- Not adding new clipboard/host protocol messages.

---

## 2. Behavior & states

**Trigger:** `editor.onContextMenu(e)` fires on right-click inside the editor. We
`preventDefault` the browser menu (Monaco's own menu is already suppressed via
`contextmenu: false`), read `e.event.posx/posy` (browser clientX/clientY) for the
anchor, and open the shared `ContextMenu` with a freshly built item list.

**Item-list states** (the list is a pure function of context — see §3):

| Context dimension | Effect on items |
|---|---|
| `readOnly` (always true today) | Cut/Paste are **omitted** (read-only editor can't mutate or paste). |
| `hasSelection` (selection non-empty) | **Copy** enabled; otherwise Copy disabled. |
| `canGoToDefinition` (TS/JS language) | Go-to-Definition shown; for non-TS files it is **disabled** (worker only resolves TS/JS), aiding discoverability. |

**Menu lifecycle:** identical to every other consumer — local `MenuState | null` in
the component; set on context-menu, cleared by `ContextMenu`'s `onClose`. No new
dismissal logic.

**Empty/degenerate:** the list is never empty (Find / Select All / Command Palette /
Toggle Word Wrap are always present), so the menu always has actionable content.

---

## 3. Data / interface contract

A **pure, testable builder** produces the item descriptors (label + which Monaco
action to run + enabled flag), decoupled from React/Monaco so it can be unit-tested
in node:

```ts
interface EditorMenuContext {
  readOnly: boolean;
  hasSelection: boolean;
  canGoToDefinition: boolean; // TS/JS model
}
interface EditorMenuItemSpec {
  id: string;                 // stable key for tests
  label: string;
  action:                     // how it maps to Monaco
    | { kind: 'action'; actionId: string }     // editor.getAction(id)?.run()
    | { kind: 'copy' };                         // clipboard copy of selection
  iconKey?: 'copy' | 'search' | 'graph' | 'command' | 'doc';
  disabled?: boolean;
  separatorBefore?: boolean;
}
function buildEditorMenuItems(ctx: EditorMenuContext): EditorMenuItemSpec[];
```

The component maps each `EditorMenuItemSpec` → `MenuItem` (binding `onClick` to the
real editor and an icon component), then opens `ContextMenu`.

**Invariants:**
- Order is stable and deterministic for a given context.
- No Cut/Paste entries when `readOnly` is true.
- Copy is present but `disabled` when `!hasSelection`.
- Go-to-Definition present but `disabled` when `!canGoToDefinition`.

---

## 4. Edge cases & failure modes

- **No selection:** Copy is disabled (not hidden) — discoverable, can't act on
  nothing.
- **Binary file:** `CodeViewer` renders a notice and never mounts the editor, so the
  menu never appears — no special handling needed.
- **Non-TS/JS file:** Go-to-Definition disabled; the underlying worker call already
  no-ops, but disabling avoids a dead click.
- **Action missing at runtime:** `editor.getAction(id)?.run()` is null-safe; a
  missing action is a no-op (menu still closes). Builder only references actions we
  register (`agentdeck.goToDefinition`, `agentdeck.toggleWordWrap`) or Monaco
  built-ins known to exist in a standalone editor (`actions.find`,
  `editor.action.selectAll`, `editor.action.quickCommand`).
- **Right-click outside text (gutter/empty area):** still opens the menu at the
  cursor; selection-dependent items reflect current selection.
- **Clipboard denied:** Copy uses the same `navigator.clipboard?.writeText` path the
  app already uses elsewhere; failure is a silent no-op (acceptable parity).

---

## 5. Defaults vs. settings

No new settings. The action set is fixed. Read-only is read from the editor's own
option, not a new flag, so if the editor ever becomes editable the builder gains
Cut/Paste by flipping `readOnly` — designed for that but not enabled now.

**Read-only decision (recorded):** the editor is read-only today. Per the wishlist
crux, Cut/Paste are **omitted** rather than shown-disabled, because a permanently
read-only editor showing greyed Cut/Paste is noise, not discoverability. Copy +
navigation/search/palette is the genuinely useful set.

---

## 6. Scope slicing

- **MVP:** `contextmenu: false`; `onContextMenu` opens shared menu; items = Copy,
  Go to Definition, Find, Select All, Toggle Word Wrap, Command Palette — context
  enabling per §3.
- **v1 (this spec = MVP+v1):** pure builder extracted + unit-tested; icons matched to
  the app set; disabled states wired.
- **Out of scope:** Cut/Paste/editability; Find References / Rename / Format (no
  reliable standalone support / read-only); multi-cursor actions; submenus.

---

## 7. Acceptance criteria

**Declarative**
- AC1: Right-clicking the editor shows an element with class `ctxmenu` (app menu),
  and Monaco's `.monaco-menu` native menu does **not** appear.
- AC2: The menu contains Copy, Go to Definition, Find, Select All, Toggle Word Wrap,
  and Command Palette; contains **no** Cut or Paste item.
- AC3: With a selection, Copy is enabled and copying places the selection on the
  clipboard. With no selection, Copy is disabled.
- AC4: Go to Definition runs the custom `agentdeck.goToDefinition` action (not
  Monaco's built-in reveal).
- AC5: Find opens Monaco's find widget; Select All selects the document; Command
  Palette opens Monaco's quick-command; Toggle Word Wrap flips wrap.
- AC6: `buildEditorMenuItems` unit tests cover read-only omission, selection
  enable/disable, and TS-vs-non-TS go-to-def enable/disable.

**EARS**
- When the user right-clicks within the editor, the system shall display the shared
  context menu at the cursor and suppress the browser/native menu.
- While the editor `readOnly` is true, the system shall not present Cut or Paste.
- Where the active model is not TS/JS, the system shall present Go to Definition in a
  disabled state.

**Gherkin**
```
Scenario: App-styled menu replaces Monaco's native menu
  Given a code file is open in the editor
  When I right-click inside the editor
  Then a ".ctxmenu" element appears at the cursor
  And no Monaco native context menu is shown
  And the menu lists Copy, Go to Definition, Find, Select All, Toggle Word Wrap, Command Palette

Scenario: Copy acts on the selection
  Given I have selected some text in the editor
  When I right-click and choose Copy
  Then the selected text is on the clipboard
```

---

## UI module

**State catalog:** closed; open (anchored, clamped to viewport via existing
`clampMenuPosition`); item-hover/keyboard-active (handled by `ContextMenu`); disabled
item (Copy w/o selection, Go-to-def on non-TS). No loading/error states.

**Interaction inventory:** right-click (open), Esc/outside-click/scroll/blur/resize
(close — inherited), arrow keys/Home/End/Enter (keyboard nav — inherited), click item
(run + close). No new shortcuts; Alt+Z / F12 keep working independently.

**Accessibility:** inherited from `ContextMenu` — `role="menu"`, `role="menuitem"`,
`aria-activedescendant`, `aria-disabled` on disabled items, full keyboard nav. No new
a11y surface introduced; disabled items are focusable-skipped exactly as today.

**i18n:** labels are short English strings consistent with existing menus (the app is
English-only, no i18n framework present — parity, not a regression). Flagged below.

**Design tokens:** zero new CSS. Reuses `.ctxmenu`, `.ctxmenu__item`,
`.ctxmenu__icon`, `.ctxmenu__sep` and existing icon components (`IconCopy`,
`IconSearch`, `IconGraph`/`IconBranch`, `IconCommand`, `IconDoc`) — all already
token-driven. This is the whole point of the feature: visual parity by reuse.

---

## Decisions Needed

- **[normal] Action set selection.** Chose Copy / Go-to-Def / Find / Select All /
  Toggle Word Wrap / Command Palette. Omitted Cut/Paste (read-only), Find
  References / Rename / Format (not reliable in a standalone read-only editor).
  Reversible — add to the builder if desired.
- **[normal] Cut/Paste omitted vs. disabled.** Omitted (cleaner for a permanently
  read-only editor). If the editor becomes editable, flip via the `readOnly` context
  field. Reversible.
- **[normal] i18n.** Strings hardcoded English, matching all existing menus. No i18n
  framework exists; introducing one is out of scope.

## Self-audit

Core spine: problem frame ✔ · behavior/states ✔ · contract ✔ · edge cases ✔ ·
defaults/settings ✔ · scope ✔ · acceptance (declarative+EARS+Gherkin) ✔. UI module:
states ✔ · interactions ✔ · a11y ✔ · i18n ✔ · tokens ✔. No unaddressed items.
