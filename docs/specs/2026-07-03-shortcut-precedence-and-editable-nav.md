---
status: active
date: 2026-07-03
tier: FULL
type: UI
---

# Shortcut precedence (terminal/editor first) + editable built-in nav

## Problem

Two user reports on the keyboard-shortcut system:

1. **App shortcuts hijack the terminal (and editor).** The global key dispatcher
   (`webview/app.tsx` `onKey`) is registered **capture-phase on `window`** *specifically to run
   before* xterm/Monaco (`app.tsx:686`, comment `:681-685`). So a registered app combo fires even
   when a terminal is focused — e.g. `Ctrl+P` opens quick-open instead of reaching a TUI (Claude
   Code) running in the shell. The user wants app shortcuts to be a **fallback**: the terminal and
   editor get keys first; app shortcuts fire only for keys those surfaces don't consume.
2. **The "built-in navigation" shortcuts aren't editable.** Most shortcuts already rebind via
   Settings → Shortcuts (Record/Reset, persisted in `settings.shortcuts`). But `Ctrl+Tab`,
   `Ctrl+Shift+Tab`, `Ctrl+PageUp/PageDown`, `Ctrl+`` `, and `Ctrl+1…9` are `fixed: true`
   (`shortcuts.ts:100-141`), hardcoded in a literal block (`app.tsx:626-679`), and shown read-only.

Decisions (confirmed with the user):
- **Terminal focused → only `Ctrl+`` (the focus toggle) fires; every other key goes to the
  shell/TUI.** Ctrl+` must remain so the user can escape the terminal.
- **Editor focused → Monaco's own keybindings win; app shortcuts are the fallback** (fire only for
  keys Monaco doesn't consume).
- **Make the built-in nav set editable too** (Record/Reset like the rest).

## Design

### 1. Precedence — two window handlers replace the one capture handler

The current single capture handler pre-empts everything. Replace with:

- **Capture-phase handler, terminal-only.** If focus is in the xterm surface
  (`.xterm-helper-textarea`): fire **only** the action whose effective combo is `navFocusTerminal`
  (Ctrl+` by default) — `preventDefault` + `stopPropagation`, then run it. For **every other
  combo, do nothing** (no preventDefault) so the event flows on to xterm → the shell/TUI. If focus
  is not in the terminal, this handler returns immediately (the bubble handler owns those cases).
  Capture is required here because xterm would otherwise consume Ctrl+` itself.

- **Bubble-phase handler, everything else.** Returns early if focus is in the terminal (handled in
  capture) or if `e.defaultPrevented` is already set — i.e. a focused widget (Monaco) consumed the
  key. Otherwise it matches `SHORTCUT_ACTIONS` and fires, subject to the form-field guard
  (`isComboAllowedWhileTyping`). Because Monaco runs its keybindings at the target phase and marks
  handled keys `defaultPrevented` (and/or stops propagation) *before* the event bubbles to
  `window`, Monaco naturally wins any key it binds; app shortcuts fire for the rest. This
  **subsumes** the old `EDITOR_OWNED_ACTIONS` (undo/redo) carve-out — Monaco consuming Ctrl+Z sets
  `defaultPrevented`, so the app skips it automatically.

The pure decision is extracted and unit-tested:
`decideShortcut({ inTerminal, inEditor, inFormField, defaultPrevented }, action, combo)` →
`'fire' | 'skip'`:
- `inTerminal`: fire iff `action.id === 'navFocusTerminal'`.
- `defaultPrevented`: skip (a widget consumed it).
- `inFormField`: fire iff `isComboAllowedWhileTyping(combo)`.
- else (editor-unconsumed / plain): fire.

### 2. `navFocusTerminal` becomes a real toggle (the escape hatch)

Today Ctrl+` only *focuses* the terminal. Make it toggle by current focus: **in the terminal →
move focus to the active doc's editor (or, if none, blur the terminal to the app root) so app
shortcuts work again; not in the terminal → `activate(null)` + focus the terminal** (existing
behavior). This is what lets Ctrl+` escape a focused terminal.

### 3. Fold the built-in nav shortcuts into the registry

Drop `fixed: true`. `navNextTab` / `navPrevTab` / `navPrevTabPage` / `navNextTabPage` /
`navFocusTerminal` / `navGoToTab` become ordinary rebindable actions with handlers in `actionMap`;
delete the hardcoded literal block in `app.tsx`. Both handlers then drive everything through
`SHORTCUT_ACTIONS` + `effectiveCombo`.

### 4. Combo grammar extension (`webview/shortcuts.ts`)

The current grammar only has `Mod` (Ctrl/⌘), `Alt`, `Shift` + a key. Add:
- **A literal `Ctrl` token** meaning `ctrlKey` on *every* platform (distinct from `Mod`, since
  `Cmd+Tab` is OS-reserved on macOS — the nav set is Ctrl-based cross-platform). `matchCombo` and
  `comboFromEvent` handle `Ctrl` independently of `Mod`.
- **Non-printable keys** already flow through (`Tab`, `PageUp`, `PageDown`, `` ` ``) since
  `comboFromEvent` keeps multi-char `e.key` verbatim; verify `` ` `` normalizes consistently
  (prefer `e.code === 'Backquote'`).
- **The digit family `navGoToTab`**: represent as a modifier-prefix + a `Digit` family token (e.g.
  combo string `Ctrl+1…9`). `matchCombo` matches when the modifiers match and `e.key` is `1`–`9`.
  Recording captures a digit press and normalizes to the family (stores the pressed modifiers +
  `1…9`), so the *modifier prefix* is rebindable while the 1–9 range is intrinsic. `formatCombo`
  renders it readably (e.g. `Ctrl + 1…9`). Note this limitation in the row's UI/help.

### 5. Settings editability (`webview/components/settings-modal.tsx`)

With `fixed` gone, the nav rows render with Record/Reset like the others (they already read
`effectiveCombo` + the override map). Ensure: the recorder captures literal-`Ctrl` combos and the
digit family; conflict detection includes the nav rows; Reset restores the default. Keep the
grouping ("Built-in navigation").

## Isolation / units
- `webview/shortcuts.ts` — grammar (`matchCombo`/`comboFromEvent`/`formatCombo`) stays pure +
  DOM-free; unit-tested for `Ctrl` token, nav keys, and the digit family.
- A pure `decideShortcut(ctx, action, combo)` (in shortcuts.ts or a sibling) — unit-tested for all
  four focus contexts incl. the terminal reserved-only rule and defaultPrevented.
- `webview/app.tsx` — two thin window handlers that compute focus context and call `decideShortcut`;
  no shortcut logic inline.
- `webview/typing-guard.ts` — add `isTerminalEntry(el)` (the `.xterm-helper-textarea` test) so the
  terminal check has a named home; `isTypingEntry` keeps returning false for it.

## Error / edge handling
- Rebinding `navFocusTerminal` to another combo makes *that* the terminal escape (reserved set is
  by action id, resolved through `effectiveCombo`).
- A user who rebinds a nav key to something a TUI needs is their choice (same as any rebind).
- Conflicts between a rebound nav key and an existing action surface in the existing conflict UI.

## Testing
- **Unit** (`test/unit/shortcuts.test.ts`): `matchCombo`/`comboFromEvent`/`formatCombo` for
  `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageUp`, `Ctrl+PageDown`, `Ctrl+`` `, and the `Ctrl+1…9`
  family (1 and 9 match, 0 doesn't); `Mod` vs literal `Ctrl` distinction (on mac `Mod`=meta,
  `Ctrl`=control).
- **Unit** (`test/unit/decide-shortcut.test.ts`): every focus context × the reserved/defaultPrevented/
  allowed-while-typing rules.
- **e2e** (`test/e2e/shortcut-precedence.e2e.mjs`, real app): with the terminal focused, the
  quick-open combo does **not** open the palette (key reaches the shell); `Ctrl+`` toggles focus
  out of the terminal; with the terminal **not** focused the same combo **does** open the palette.
  (Editor-fallback is covered by the unit decision test + `defaultPrevented`; a Monaco-focus e2e is
  optional.)

## Out of scope
Per-keychord "when" clauses, chord sequences (Ctrl+K Ctrl+S), and a full VS Code
`commandsToSkipShell`-style per-command terminal allowlist. The reserved terminal set is just
`navFocusTerminal`.
