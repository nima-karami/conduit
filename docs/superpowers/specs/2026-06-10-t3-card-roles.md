# T3 — Configurable session-card roles

## Problem
F3 only gave per-field visibility toggles. The request was to choose what each card
shows AS title / subtitle / detail — assign fields to roles, not just show/hide.

## Model
A card has three role slots, each bound to a field (or none):
- **Title** (default `name`), **Subtitle** (default `agent`), **Detail** (default `time`).
- Fields: `name, agent, folder, path, worktree, time, status, none`.
- Status dot stays as the always-on anchor.

### Settings (src/settings.ts)
Replace the booleans `cardAgent/cardTime/cardStatusText/cardPath/cardWorktree`
with `cardTitle/cardSubtitle/cardDetail: CardField`. Validate each via oneOf
(title falls back to `name`, others to their defaults). restore() drops the old keys.

### Field resolver
`fieldValue(session, agentLabel, field)` → string for each field id (none → '').

### SessionItem
Render title (role), subtitle line (role), detail line (role); skip empty/none.
Status dot unchanged.

### Settings UI (Appearance → Session card)
Three selects — Title / Subtitle / Detail — each listing the fields; plus the live
preview card already there, reflecting the chosen roles.

## Acceptance criteria
1. Three role selects appear; changing them re-renders the real cards + preview live.
2. e.g. Title=Folder, Subtitle=Agent, Detail=Status produces cards showing those.
3. Setting a role to None hides that line.
4. Choices persist; old card* keys ignored gracefully.
5. typecheck + build + tests green.
