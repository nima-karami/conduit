# Run report — skill installer (2026-07-06)

Single-feature autonomous build, run right-sized (not the full parallel loop — one feature,
no new cross-cutting boundary, integrated on `main` per this repo's continuous pattern).

## Shipped

**Conduit skill installer** — a generic installer for the agent skills Conduit bundles, so a
Claude Code session working in a user's project can pick up the skills that teach it how to
read/update that project's `.conduit` artifacts.

- **Commit:** `4a20f00` (feature) on `main`; spec `0bb3844`.
- **Spec:** `docs/specs/2026-07-06-skill-installer.md` (Active). A **file copy** — explicitly
  NOT the SDK-coupled installer rejected 2026-06-23.
- **Surface:**
  - `resources/skills/` — tracked canonical bundle (seed: `conduit-plan`, `conduit-architecture`),
    packaged into the app via electron-builder `extraResources` (`process.resourcesPath/skills`;
    dev reads the repo copy).
  - `src/skills.ts` — pure frontmatter parse / version compare / status derivation (13 unit tests).
  - `electron/skills-service.ts` — enumerate the bundle, read installed versions, validated
    recursive copy into `<project|~>/.claude/skills/<id>`; `CONDUIT_HOME` test seam.
  - `skills:list` / `skills:install` IPC → `window.agentDeck.skills` → `webview/bridge.ts` (+ mock).
  - **Settings → Skills** panel (per-destination status + Install/Update/Reinstall; project action
    disabled with a hint when no folder is open) and a **command-palette** entry
    "Install Conduit skills…".

## Evidence

- `npm run verify` **green on the committed tree** — 2131 tests (161 files), typecheck (both
  configs), biome, dead-code clean, security. (was 2118 before; +13 skills unit tests.)
- **Real-artifact e2e** `test/e2e/skill-install.e2e.mjs` — drives the actual Electron app
  (hidden) and asserts real files land on disk for BOTH destinations: bridge-level install into a
  temp project + a UI-driven install to a temp `CONDUIT_HOME`, with the panel's status/label
  flipping. This crosses the real host/IPC/FS boundary a mock can't. PASS (~23s).

## Not verified by this run (flagged)

- **Packaged-app bundling** (`extraResources` → `process.resourcesPath/skills`): the dev path is
  proven by the e2e (the running app enumerated + installed the bundled skills); the *packaged*
  path follows the standard electron-builder contract but is only exercised by an actual
  `dist`/installer build — which the CI **Release** workflow performs. Acceptance criterion #1 is
  therefore covered by CI on the next release, not by this local run.

## Decisions taken during autonomy (no human mid-run)

- **Generic enumeration** over a hardcoded skill list (user pick during brainstorming).
- **Settings → Skills** entry point + palette command (user pick).
- **Silent, version-aware, idempotent overwrite** (no confirm) — safe because the target is always
  a validated `<root>/.claude/skills/<known-id>` we own.
- **No uninstall / Claude-Code-convention only** in v1 (YAGNI).

## Follow-ups (queued, not requested)

- Author a **`conduit-board`** skill and drop it into `resources/skills/` — the installer will
  enumerate it automatically (board has the same propose→accept mechanism).
- **Run all e2e hidden**: the visible opt-out scenarios (`shortcut-precedence`, `terminal-focus`,
  `attention`) pop up windows and were seen to stall on the quit-guard popup on a loaded machine.
  Candidate root-cause fix: launch those windows **off-screen** (focusable, not visible) instead of
  `show:true`. Tracked in memory (`feedback-e2e-run-hidden`).
