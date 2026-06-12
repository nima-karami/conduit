# Spec — word-wrap (wishlist E2)

**Tier:** LITE · **Feature type:** UI
**One-line:** Add word wrap to the Monaco code editor, toggled by the standard
**Alt+Z** shortcut, with the preference persisted in app settings (default off),
matching the behavior of standard editors (VS Code, etc.).

## Problem frame

- **Job:** Long lines in the Monaco code editor (`webview/components/code-viewer.tsx`)
  overflow into a horizontal scrollbar. The Markdown preview already reflows, so the
  two center-pane surfaces are inconsistent. A user reading a wide source line wants to
  toggle soft wrapping the same way every modern editor does — with **Alt+Z**.
- **Actors:** Anyone viewing a code file in the center pane.
- **Success:** With wrap off, a file with long lines shows a horizontal scrollbar.
  Pressing **Alt+Z** wraps the lines (no horizontal scrollbar); pressing it again
  toggles back. The choice persists across editor mounts and app restarts.
- **Non-goals (explicit):**
  - No per-file wrap memory — it is a single global preference.
  - No wrap-column / ruler / wrap-indent configuration UI (Monaco defaults are fine).
  - No change to the Markdown preview (it already wraps).
  - No change to the terminal.

## Behavior & states

- **State:** a single boolean `wordWrap` on `AppSettings` (default `false` = off),
  persisted via the existing settings store (`settings.json` in userData) and
  validated in `restoreSettings`.
- **At editor mount:** the editor is created with `wordWrap: settings.wordWrap ?
  'on' : 'off'`.
- **On Alt+Z (editor focused):** a Monaco editor action toggles `settings.wordWrap`
  via the settings store's `update()`. Because the action mutates the shared setting,
  every open editor re-applies the new value (the effect re-runs / value flows in),
  and the new value is persisted (debounced) for future mounts.
- **Command palette:** the toggle is registered with `editor.addAction`, so it also
  appears in Monaco's command palette (F1) as "Toggle Word Wrap".
- **Settings UI:** an "Word wrap" toggle in Settings → Appearance mirrors the same
  setting, so it is discoverable without knowing the shortcut.

## Interface contract

- `AppSettings` gains `wordWrap: boolean` (default `false`); `restoreSettings`
  validates it with the existing `bool()` helper.
- `CodeViewer` consumes `useSettings()` to read `wordWrap` and to `update({ wordWrap })`
  from the Alt+Z action. The editor's `updateOptions({ wordWrap })` is called when the
  setting changes so already-open editors react live.
- Keybinding: `monaco.KeyMod.Alt | monaco.KeyCode.KeyZ` via `editor.addAction` (action
  API preferred over a raw keydown handler so it shows in the command palette).

## Edge cases

- **Binary file:** no editor is mounted (early return), so the shortcut is irrelevant.
- **Multiple open editors:** all read the same global setting; toggling in one applies
  to all on the next render — acceptable and consistent with a global preference.
- **Fake-shell / plain-browser preview:** `useSettings` works without the host bridge
  (settings default in-memory), so Alt+Z is fully testable in the browser preview.

## Defaults vs. settings

- Default **off** (`false`) — matches the current behavior and VS Code's default.
- Persisted: yes, via the existing `AppSettings` store. A follow-up could add per-file
  wrap memory, but that is out of scope for this LITE pass.

## Scope slicing

- **MVP (this task):** `wordWrap` setting + Alt+Z Monaco action toggling it + live
  `updateOptions` + Appearance toggle.
- **Out of scope:** per-file wrap state, wrap-column config, wrap indent style.

## Acceptance criteria (declarative)

1. `AppSettings` has `wordWrap: boolean` (default `false`), validated in
   `restoreSettings`.
2. The Monaco editor mounts with wrap matching `settings.wordWrap`.
3. **Alt+Z** in a focused editor toggles wrap on/off and the action appears in the
   command palette as "Toggle Word Wrap".
4. The preference persists (a Settings → Appearance toggle reflects/controls it).
5. `npm run verify` and `npm run build` both pass.
6. Runtime proof: open a file with long lines → horizontal scrollbar present; press
   Alt+Z → lines wrap, scrollbar gone; press Alt+Z again → scrollbar returns.

## Self-audit

Template spine covered: problem frame, behavior/states, interface contract, edge
cases, defaults/settings, scope slicing, acceptance criteria. UI module: states &
toggle interaction covered; a11y — the Settings toggle reuses the existing accessible
`Toggle` (role="switch"); the Monaco action is keyboard-driven and palette-listed;
i18n — one new label ("Word wrap" / "Toggle Word Wrap"), no other copy. No items left
unaddressed.

## Decisions Needed

none
