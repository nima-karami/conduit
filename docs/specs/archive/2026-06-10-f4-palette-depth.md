# F4 — Command palette depth

## Goal
Turn the two-mode palette into a single unified palette with VS Code-style prefix
switching, recents, and a richer command set.

## Unified palette + prefixes
- One palette. Default (Ctrl+P): files + open sessions.
- Typing `>` at the start switches to **commands** (filter by the text after `>`).
- Ctrl+Shift+P opens the palette pre-filled with `>` (command mode).
- Empty query in default mode shows **Recent** (recently opened docs) + sessions,
  instead of dumping the whole file list.

## Recents
App tracks the last N (10) opened doc paths (file/diff), most-recent first.
Recent entries reopen the doc. A file already in recents is moved to front.

## Richer commands
Add commands beyond the current set:
- Toggle sidebar, Back, Forward
- Reduce motion on/off, Cycle theme
- Close other tabs, Reveal active file in Explorer, Copy active file path
- Open Settings: General / Appearance / Shortcuts (deep-link the tab)
- Switch to session … (each session as a command too)
Keep existing: New session, Open settings, Reveal project, Close session, Theme: X.

## Component changes (CommandPalette)
- Props: `items` (default set), `commandItems`, `recentItems`, `initialQuery`,
  `placeholder`, `onClose`.
- Internal selection logic:
  - query starts with `>` → commandItems, fuzzied by query.slice(1).trim()
  - else query empty → recentItems + the session entries from `items`
  - else → fuzzy `items`
- Group headers reflect the active set (Recent / Sessions / Files / Commands).

## Settings deep-link
SettingsModal accepts an optional `initialTab`; the palette's "Open Settings: X"
commands open it on that tab.

## Acceptance criteria
1. Ctrl+P empty shows Recent (after opening some files) + Sessions, not the full file list.
2. Typing `>` switches to commands; Ctrl+Shift+P opens already in command mode.
3. Recents reopen the right doc and reorder by recency.
4. New commands work: toggle sidebar, cycle theme, reduce motion, reveal/copy active file, deep-link settings tabs.
5. typecheck + build + tests green.
