# F3 — Configurable session cards

## Goal
Replace the 3 fixed presets (comfortable/compact/detailed) with real per-field
control: the user chooses exactly what each session card displays, with a live
preview in Settings. "More visibility and control over what each card shows."

## Field model
A session card can show these elements; each is individually toggleable:

| Field | Default | Content |
|---|---|---|
| status dot | always on | colour-coded run state (not toggleable — it's the anchor) |
| name | always on | session name (the title) |
| agent | on | shell/agent label (e.g. "PowerShell 7") |
| time | on | relative time since created |
| status text | off | "running" / "stale" / "exited" |
| path | off | project folder (monospace) |
| worktree | on | worktree label when present |

Overall row tightness continues to come from the existing global **density** setting.

## Settings model (src/settings.ts)
Remove `sessionCard: SessionCard` (+ `SessionCard` type, CARDS). Add booleans:
`cardAgent, cardTime, cardStatusText, cardPath, cardWorktree`
(defaults: true, true, false, false, true). restore() validates each as bool.

## Sidebar (SessionItem)
Take a `fields` object (the 5 booleans) instead of `card`. Render:
- meta row shows agent / time / status-text joined by · separators, only the
  enabled ones (omit the row entirely if none enabled).
- path line when `cardPath`.
- worktree appended to path/meta when `cardWorktree` and present.

## Settings UI (Appearance tab)
Replace the "Session card" segmented control with a **Session card** section:
- a column of toggles (Agent, Timestamp, Status text, Project path, Worktree)
- a **live preview** card showing a sample session reflecting the current toggles +
  theme + density.

## Acceptance criteria
1. Appearance shows 5 session-card toggles + a live preview that updates as you toggle.
2. Each toggle adds/removes that element from the real sidebar cards immediately.
3. With all meta toggles off, cards show just dot + name (no empty meta row).
4. Choices persist across reload (settings.json).
5. No leftover references to the old `sessionCard` enum; typecheck + build + tests green.
