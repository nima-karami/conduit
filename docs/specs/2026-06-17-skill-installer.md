---
status: active
date: 2026-06-17
---

# Skill installer — install Conduit-bundled skills into an agent's skills dir

## Problem

For an agent to participate in Conduit-specific workflows it often needs a **skill** installed
on the user's machine — most immediately the **plan-authoring skill** (see the
`interactive-plans` spec) that teaches the agent to emit plans in Conduit's format. Today there
is no in-app way to get a skill onto disk: the user must hand-create `SKILL.md` and any helper
files in the right directory. Claude Code discovers skills under `~/.claude/skills/<name>/`
(personal) and `<projectRoot>/.claude/skills/<name>/` (project); getting the layout/frontmatter
right by hand is error-prone.

## Goal

Conduit **ships a curated set of bundled skills** in-app and offers a one-action **install**
(and **update**) into either the **project** or **user** Claude Code skills directory, with
clear **state detection** (not installed / installed / outdated / locally modified). The
mechanism is **agent-agnostic** behind a small target-resolver: v1 implements **Claude Code**
targets; the **Codex** layout is designed, not wired.

This is the *general* delivery mechanism. Its first consumer is the plan-authoring skill, but it
is reusable for any future bundled skill (and complements the chat-UI skills picker).

## Non-goals (v1)

- Installing from **arbitrary local folders** or **URLs / a marketplace** (user chose
  bundled-only). `clui-cc` has a marketplace; explicitly out of scope.
- **Uninstall** beyond a thin "remove" (optional; see Out of scope).
- Authoring skills in-app.

## Architecture

### Bundled skills — source + manifest

Skills ship inside the app package under a resources dir, e.g. `assets/skills/<id>/` containing
`SKILL.md` (+ any helper files). A small **manifest** (`assets/skills/manifest.json`, or derived
by scanning the dir) lists each bundled skill:

```ts
interface BundledSkill {
  id: string;          // dir name, slug; e.g. 'conduit-plan'
  name: string;        // display name (from SKILL.md frontmatter)
  description: string; // one-line (from SKILL.md frontmatter)
  version: string;     // SKILL.md frontmatter `version:` — drives update detection
  protocol: 'claude-code'; // which agent layout it targets (v1: claude-code only)
}
```

The host resolves the bundled source dir from the packaged app resources at runtime (dev: the
repo `assets/skills/`; prod: the unpacked resources path). Each bundled `SKILL.md` carries a
`version:` in its frontmatter — the single source of truth for "is the installed copy current?".

### Target resolution — agent-agnostic, path-guarded

A pure helper resolves the install destination from `(protocol, scope, projectRoot?)`:

```ts
type InstallScope = 'project' | 'user';
function skillTargetDir(protocol, scope, skillId, opts): string
// claude-code + project → <projectRoot>/.claude/skills/<skillId>/
// claude-code + user    → <homedir>/.claude/skills/<skillId>/
// codex + …             → DESIGNED (e.g. Codex's skills/prompts dir) — not implemented in v1
```

`skillId` is sanitized to a single safe path segment and a normalized containment check asserts
the result stays inside `…/.claude/skills/` (defense in depth — reuses the `safeSpecFileName` /
containment pattern from `conduit-fs.ts` `specPath`). A hostile id can never escape the skills
dir. `project` scope requires an open project; with none, the project option is disabled.

### Install / update — atomic folder copy

Install copies the whole bundled skill **folder** (skills can be multi-file) into the target:

- `mkdir -p` the target dir.
- Copy each file via the existing **atomic write** discipline (temp + rename, errors surfaced —
  reuse/extend `writeAtomic` in `conduit-fs.ts`), so a crash mid-install never leaves a
  half-written `SKILL.md`.
- **Update** overwrites the same target. If the installed copy is **locally modified** (see
  state detection) the UI requires an explicit confirm ("Update will overwrite your local
  changes to this skill").

### State detection

For a `(skill, target)` pair the host classifies install state by reading the target's
`SKILL.md`:

| State | Condition |
|-------|-----------|
| `not-installed` | no `SKILL.md` at target |
| `installed` | present; frontmatter `version` == bundled `version`; content hash matches bundled |
| `outdated` | present; bundled `version` is newer |
| `modified` | present; content hash differs but not via a version bump (user edited it) |

A pure classifier `skillInstallState(bundled, installed)` is unit-tested. "Content hash" is a
cheap hash over the skill's files so an unchanged install reads as `installed`, not `modified`.

### IPC

New typed messages in `src/protocol.ts`:

- webview → host: `{ type: 'listSkills'; projectRoot?: string }`
- host → webview: `{ type: 'skillList'; skills: SkillEntry[] }` where each `SkillEntry`
  carries the `BundledSkill` fields plus per-scope state
  (`{ project: InstallState; user: InstallState }`).
- webview → host: `{ type: 'installSkill'; skillId: string; scope: InstallScope; projectRoot?: string; overwriteModified?: boolean }`
- host → webview: `{ type: 'skillInstallResult'; skillId: string; scope: InstallScope; ok: boolean; error?: string }`
  (on success the renderer re-requests `listSkills` to refresh state).

### UI

A **Skills** section (in Settings, or a small dedicated panel) lists bundled skills. Per skill:

- name + description,
- a **state badge** per scope (Installed / Update available / Modified / Not installed),
- a **scope toggle** (Project · User; Project disabled when no project is open),
- an **Install** / **Update** button (Update on `outdated`/`modified`, with the overwrite
  confirm when `modified`).

Also a command-palette action ("Install a skill…") that opens the same panel.

Guard for `window.agentDeck` absent (mock preview): the panel shows bundled skills but install
actions are disabled (no host to write files).

## Decisions

- **Bundled-only source** (user choice) — keeps the surface small and the supply chain trusted;
  arbitrary/URL sources are a later, separable feature.
- **Both project and user scopes** — project-local skills travel with the repo; user skills
  apply everywhere. The user picks per install.
- **Version + hash detection**, not just presence — so "Update available" and "you edited this"
  are distinguishable and we never silently clobber a user's edits.
- **Atomic, path-guarded copy** — reuses the `conduit-fs.ts` write discipline and the
  `specPath` containment pattern; no new unsafe FS surface.
- **Claude Code only in v1; Codex layout designed** — mirrors the `agent-chat-ui` split (prove
  the resolver with one agent).

## Testing

- **Unit (vitest, pure):** `skillTargetDir` (project/user, id sanitization, containment refusal
  of escaping ids); `skillInstallState` (all four states incl. version-bump vs user-edit);
  manifest parse.
- **Real-app smoke (W1 harness):** install a bundled skill into a **temp** project/user dir,
  assert `SKILL.md` (+ helpers) land and state flips to `installed`; bump the bundled version
  fixture → state reads `outdated` → Update overwrites; a locally-modified target reads
  `modified` and Update requires the overwrite flag. (Targets a throwaway temp HOME/projectRoot
  so the suite never touches the real `~/.claude`.)

## Acceptance criteria

- [ ] A bundled skill can be installed into `<projectRoot>/.claude/skills/<id>/` or
      `~/.claude/skills/<id>/` from the UI, atomically.
- [ ] State is shown per scope: not-installed / installed / outdated / modified.
- [ ] Update overwrites; when the target is locally modified, an explicit confirm is required.
- [ ] An escaping/hostile skill id is refused (containment check); project scope is disabled
      with no open project.
- [ ] Pure resolver + state classifier are unit-tested; smoke install/update passes against a
      temp dir without touching the real `~/.claude`.
- [ ] `npm run verify` exits 0.

## Out of scope

- Arbitrary-folder / URL / marketplace sources.
- Codex install (resolver seam designed only).
- Full uninstall UX (a thin "remove skill" deleting the target dir may be included if cheap;
  otherwise deferred).
- In-app skill authoring/editing.

## References

- `electron/conduit-fs.ts` — `writeAtomic`, `specPath` containment pattern (`:304`),
  `safeSpecFileName` (`src/spec-path.ts`).
- `src/protocol.ts` — new skill IPC messages.
- `webview/app.tsx` — command-palette registration (`cmd:board`/`cmd:canvas` neighbourhood),
  Settings panel host.
- First consumer: `interactive-plans` spec (ships the `conduit-plan` skill this installs).
- Related: `agent-chat-ui` spec (skills picker; same Claude-Code-first / Codex-designed split).
- Claude Code skills layout (`~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/`):
  [skills docs](https://code.claude.com/docs/en/skills).
