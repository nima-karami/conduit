---
status: shipped
date: 2026-07-06
tier: FULL
type: Host+UI
---

# Conduit skill installer

## Problem

Conduit's `.conduit/` knowledge artifacts (architecture diagram, board, plan) are **human-owned,
agent-proposes** (ADR 0002 §3): an agent working in a project writes `<artifact>.proposed.json`
and the human accepts a diff. But an agent only knows *how* to do that — the envelope, the
tree-of-graphs schema, the id-stability rules, the propose-don't-overwrite flow — if it has been
taught. That teaching is packaged as **Claude Code skills** (`SKILL.md` folders): `conduit-plan`
and `conduit-architecture` exist today.

Two gaps:

1. **The skills can't ship.** They live in the repo's `.claude/skills/`, which is **gitignored**,
   so they're local to one checkout — never packaged with the app, never delivered to a user.
2. **There's no way to install them where agents look.** An agent running in the user's terminal
   (a Claude Code session) discovers skills in the opened project's `.claude/skills/` or the
   user-global `~/.claude/skills/`. Nothing in Conduit puts them there.

The user wants Conduit to **install its bundled skills** into a chosen destination (this project
or user-global), from the UI.

> **Not the rejected 2026-06-23 installer.** The INDEX records a "skill installer" spec rejected
> because it depended on the Claude Agent SDK (billed API key, no Pro/Max subscription). This one
> shares only the name: it is a **file copy** of bundled `SKILL.md` folders to disk. No SDK, no
> API key, no agent execution. It is viable exactly where the old one wasn't.

## Goals

- Bundle a set of skills **with the app** from a tracked source, so they ship.
- A **Settings → Skills** panel that lists every bundled skill and installs any one into either
  **this project** (`<projectRoot>/.claude/skills/<id>/`) or **user-global**
  (`~/.claude/skills/<id>/`), showing per-destination install status.
- **Generic:** no hardcoded skill list — the installer enumerates whatever is bundled. Seeded with
  `conduit-plan` + `conduit-architecture`; a new folder dropped into the bundle auto-appears.

## Non-goals

- Executing skills, or anything touching the Claude Agent SDK.
- Uninstall (v1 — a skill is a folder the user can delete; add later if wanted).
- Targeting non-Claude-Code agent conventions (Cursor, etc.).
- Editing skill contents in-app.

## Design

### 1. Bundled skill sources (tracked + packaged)

Canonical source of truth moves to a **tracked** dir: `resources/skills/<id>/` — each an existing
Claude Code skill folder (`SKILL.md` required; optional companion files, e.g.
`architecture.schema.json`). Seed by copying the two current skills there. The existing
gitignored `.claude/skills/` copies are left untouched (they're this checkout's dogfood copies;
they'll simply be overwritten if the user installs into this project).

Packaging: electron-builder `extraResources` maps `resources/skills` → `skills`, so in a built app
the bundle is at `path.join(process.resourcesPath, 'skills')`. In dev (unpackaged) it's the repo's
`resources/skills`. A single resolver (`app.isPackaged ? resourcesPath : repo path`) returns the
right dir for both.

The `SKILL.md` YAML frontmatter **is the manifest** — `name`, `description`, `version`. The skill
**id** is its folder name. No separate manifest file.

### 2. `src/skills.ts` — pure, unit-tested (no I/O)

- `parseSkillFrontmatter(md: string): { name; description; version } | null` — minimal YAML
  frontmatter reader (the same `---`-delimited block the specs use); returns null if absent/invalid.
- `compareVersions(a, b): -1 | 0 | 1` — dotted-numeric compare (`1.0.0` vs `1.2.0`); non-numeric
  segments compared lexically; missing segments treated as 0. (Small + local; no new dep.)
- `deriveStatus(bundledVersion, installedVersion): 'not-installed' | 'installed' | 'update'` —
  `null` installed → not-installed; bundled > installed → update; else installed.

### 3. `electron/skills-service.ts` — host I/O

- `bundledSkillsDir(): string` — the resolver above.
- `globalSkillsRoot(): string` — `path.join(CONDUIT_HOME, '.claude', 'skills')` where
  `CONDUIT_HOME = process.env.CONDUIT_HOME || os.homedir()`. The env override is the **test seam**
  (below) — in production it's always the real home.
- `projectSkillsRoot(projectRoot): string` — `path.join(projectRoot, '.claude', 'skills')`.
- `listSkills(projectRoot | null)` → for each bundled skill:
  `{ id, name, description, version, project: SkillStatus, global: SkillStatus }` where a
  `SkillStatus` carries the installed version (or null) and the derived status. Reads each
  destination's `<id>/SKILL.md` frontmatter to get the installed version. Malformed/half-written
  bundled skills are skipped (logged), never crash the list.
- `installSkill(id, destination, projectRoot | null)` → recursive copy of `resources/skills/<id>/`
  into `<root>/.claude/skills/<id>/`, creating parents. **Safety:** the target is always
  `.../.claude/skills/<validated-id>`; `id` must match `^[a-z0-9][a-z0-9-]*$` and must be a
  present bundled skill — so the copy can never escape the skills dir or overwrite anything but a
  skill folder. Overwrite-in-place: remove the existing `<id>` folder (only after id validation)
  then copy. Returns `{ ok: true } | { ok: false; error }`.

### 4. IPC + bridge

- `src/protocol.ts`: request/response types for `skills:list` and `skills:install`.
- `electron/main.ts`: handlers delegating to `skills-service`, passing the window's active repo
  root for the `project` destination.
- `electron/preload.ts`: expose `agentDeck.skills.list()` / `agentDeck.skills.install(id, dest)`.
- `webview/bridge.ts` + `webview/mock.ts`: renderer wrappers + a fake (preview lists the bundled
  skills as all *not-installed*, install is a no-op success) so the panel renders in a plain
  browser.

### 5. Settings → Skills panel (`webview/components/settings-modal.tsx`)

A new "Skills" section. On open, calls `skills.list()`. Renders one row per skill:

- Name, version, description.
- Two destination controls — **This project** and **User (global)** — each a button whose label
  reflects status: *Install* / *Update to vX* / *Reinstall* (idempotent). Clicking installs and
  re-lists so the status updates in place; a toast confirms ("Installed conduit-architecture to
  this project").
- **This project** is disabled with a hint ("Open a folder to install here") when no project is
  active.
- Errors surface as an error toast; the row stays interactive.

A command-palette command **"Install Conduit skills…"** opens Settings focused on this section
(reuses the existing settings-open + section-select path).

### 6. Behavior decisions (confirmed)

- **Version-aware, idempotent, silent overwrite** — no confirm dialog. We only ever replace a
  folder we own (validated id under `.claude/skills/`), so overwrite is safe and low-friction.
- **No uninstall** in v1.
- **Claude Code convention only** (project `.claude/skills/`, global `~/.claude/skills/`).

## Error handling

| Condition | Behavior |
|-----------|----------|
| Bundled dir missing/empty | Panel shows "No bundled skills found." |
| Malformed bundled `SKILL.md` | That skill skipped (logged); others still list |
| Install write fails (permissions) | Error toast; list unchanged |
| No active project | "This project" action disabled with hint |
| Installed `SKILL.md` unreadable | Status treated as not-installed (safe: Install/Reinstall) |

## Testing

- **Unit** (`test/unit/skills.test.ts`): `parseSkillFrontmatter` (present / absent / malformed),
  `compareVersions` (ordering, unequal lengths, non-numeric), `deriveStatus` (all three branches).
- **e2e** (`test/e2e/skill-install.e2e.mjs`): launch with `CONDUIT_HOME` pointed at a temp dir and
  a temp project; open Settings → Skills; install `conduit-architecture` to **project**, assert
  `<tmpProject>/.claude/skills/conduit-architecture/SKILL.md` exists and the row flips to
  *Installed*; install to **global**, assert it lands under `CONDUIT_HOME/.claude/skills/…`. This
  is the host/FS boundary the units can't cover.

### Test seam

`globalSkillsRoot()` honors `process.env.CONDUIT_HOME` before `os.homedir()`. This is the *only*
production-affecting seam and is inert unless the env var is set (the e2e sets it); it keeps the
suite from writing into the real `~/.claude`.

## Files

**New**
- `resources/skills/conduit-plan/SKILL.md` (copied from `.claude/skills/`)
- `resources/skills/conduit-architecture/{SKILL.md,architecture.schema.json}` (copied)
- `src/skills.ts` (pure)
- `electron/skills-service.ts` (host)
- `test/unit/skills.test.ts`
- `test/e2e/skill-install.e2e.mjs`

**Changed**
- `electron/main.ts` (IPC handlers), `electron/preload.ts` (expose), `src/protocol.ts` (types)
- `webview/components/settings-modal.tsx` (Skills panel), `webview/bridge.ts` + `webview/mock.ts`
- command registry (palette entry) — wherever palette commands are declared
- `package.json` build config (`extraResources`)
- `CHANGELOG.md`

## Acceptance criteria

1. A built app contains the bundled skills and lists them in Settings → Skills.
2. Installing a skill to **this project** creates `<projectRoot>/.claude/skills/<id>/` with the
   full skill folder; the row shows *Installed* at the bundled version.
3. Installing to **user-global** creates `~/.claude/skills/<id>/` likewise.
4. Re-running install overwrites in place (no duplicate/partial folders); a newer bundled version
   shows *Update* first.
5. With no project open, the project action is disabled; global still works.
6. `npm run verify` green, including new unit tests; the e2e passes against temp dirs.
