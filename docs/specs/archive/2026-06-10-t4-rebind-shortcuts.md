# T4 — Set / rebind shortcuts

## Problem
The Shortcuts tab was read-only and the key handler was hardcoded in App. The
request was to *set* shortcuts. Make bindings data-driven, editable, and persisted.

## Model
- `src/shortcuts.ts`: `SHORTCUT_ACTIONS` = list of `{ id, description, group,
  defaultCombo }`. Combos use a `Mod` token (Ctrl on win/linux, ⌘ on mac), e.g.
  `Mod+P`, `Mod+Shift+P`, `Mod+,`.
- `comboFromEvent(e)`: capture a normalized combo from a keydown (null if only
  modifiers). `matchCombo(e, combo)`: test an event against a combo. `formatCombo`
  for display. Pure + unit-tested.
- Settings: `shortcuts: Record<actionId, combo>` (overrides; defaults used when
  absent). Validated as a string→string map.

## App (data-driven handler)
One keydown handler builds the effective binding per action (override ?? default),
and runs the matching action. Action map: openSettings, openSearch, openCommands,
newSession, toggleSidebar, openBoard.

## Settings → Shortcuts (editor)
Each action row shows description + current combo (formatted) + **Record** button.
Recording captures the next key combo → saves to `settings.shortcuts`. Detect
conflicts (combo already bound to another action) and warn. **Reset** per row clears
the override (back to default). Esc cancels recording.

## Acceptance criteria
1. Shortcuts tab lists actions with their current bindings + Record/Reset.
2. Recording a new combo changes the binding; the actual shortcut then works
   (e.g. rebind palette to Mod+K and Mod+K opens it; old combo no longer does).
3. Conflicts are flagged.
4. Reset restores the default; bindings persist across reload.
5. comboFromEvent/matchCombo unit-tested; typecheck + build + tests green.
