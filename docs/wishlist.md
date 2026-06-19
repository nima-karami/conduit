# Conduit — Wishlist (inbox)

Raw, un-triaged ideas land here first. This is an **inbox, not a tracker** — it
holds things that haven't been built yet. Once an item is picked up it leaves
this file:

- **Promoted** → a spec in `docs/specs/` (see `docs/specs/INDEX.md`).
- **Shipped** → recorded in `docs/runs/<date>-<name>/report.md` with evidence + SHAs.
- **In a live build** → tracked in `.autoloop/tasks.yaml` (run state, gitignored).

So don't track status here — delete an item once it moves on. History of what
shipped lives in `docs/runs/`, not here.

## Captured

Goal lens: [[conduit-daily-driver-goal]] — make Conduit usable enough to live in.

### Bugs (2026-06-19 intake)

- **Session card path doesn't follow the live working directory.** When you `cd` around in a
  session's terminal, the Files/Changes views re-root to the new directory (E2a live-cwd is
  tracked on `session.cwd`), but the **session card in the sidebar keeps showing the launch
  folder**. Root cause: the card's `folder`/`path` fields resolve from `session.projectPath`
  (the static launch dir), not `session.cwd` — `webview/card-fields.ts` (`fieldValue`, the
  `folder`/`path` cases). The displayed folder/path should prefer `session.cwd ?? projectPath`
  so it reflects where the shell actually is. **Open design decision (flag, don't assume):**
  should the sidebar *grouping* also re-bucket by live cwd (a session that `cd`s elsewhere
  leaves its project group), or keep today's **stable** grouping by launch `projectPath`
  (sessions stay under the folder they were started in) and only update the *displayed* path?
  The user is open to the session moving out of its project category — recommend: update the
  displayed folder/path to live cwd now; treat dynamic re-grouping as a separate, opt-in
  behavior (it makes cards jump groups as you navigate). Code: `webview/card-fields.ts`,
  `webview/components/sidebar.tsx` (`renderGroups` groups by `projectPath`; `SessionItem`
  detail + `title`). (bug + small design call)

- **Reordering project groups by drag snaps back.** With sessions grouped by project, dragging
  a project header to reorder the groups does nothing — they snap back to the original order.
  Root cause: `commitReorder` (`webview/components/sidebar.tsx`) only persists when
  `dropResolvesToManual(candidate, sortedCanonical(candidate, sort))` is true, but for
  `sort === 'manual'` `sortedCanonical` returns the candidate **unchanged** (`src/reorder.ts`
  line ~29), so the gate is always "no-op" and the reorder is never committed — every drag in
  manual sort is dropped (group headers *and* cards). Fix direction: in manual mode compare the
  candidate against the **current rendered order** (`renderedIds`) and persist if it differs,
  instead of comparing the candidate to its own canonical; keep the existing
  "deviates-from-sort → switch to manual" path for the non-manual sorts. `src/reorder.ts` is
  pure → cover with a unit test (manual-mode group reorder persists). Code:
  `webview/components/sidebar.tsx` (`commitReorder`, `groupDrag`, `sessionDrag`),
  `src/reorder.ts` (`dropResolvesToManual`, `sortedCanonical`, `reorderByGroup`). (bug)

## Spec-ready (promoted → see `docs/specs/INDEX.md`)

- **Agent-agnostic chat UI over CLI agents** → `docs/specs/2026-06-17-agent-chat-ui.md`.
  A clean, elegant **chat surface** that drives Claude Code / Codex under the hood (no raw
  terminal) and renders structured turns: assistant markdown, collapsible thinking, rich
  tool-call cards (edits-as-diffs, clickable file paths), **inline tool approvals**, a
  **running-mode selector incl. Auto** (server-side safety classifier), and a skills /
  slash-command picker. Agent-agnostic via a normalized event model behind a `ChatAdapter`
  interface. **v1 builds the Claude Code adapter** (Agent SDK streaming session — needed for
  `canUseTool` + mid-session mode change + `--resume`, and to dodge the one-shot `-p` Auto
  abort) **+ a `FakeAdapter`** for offline smoke tests; **Codex adapter and interactive
  option-buttons are designed, not built**. Transcript + CLI session id persisted →
  **resume on reopen**. Reuses the W4 markdown/mermaid viewer, the D11 path-link seam, and the
  busy/attention seams. See [[conduit-daily-driver-goal]].

- **Skill installer** → `docs/specs/2026-06-17-skill-installer.md`. Conduit ships
  **bundled skills** and installs one into the **project** (`.claude/skills/`) or **user**
  (`~/.claude/skills/`) Claude Code skills dir from the UI, with installed / outdated /
  locally-modified **detection** + update (atomic, path-guarded copy). Claude Code targets in
  v1; Codex layout designed. The general delivery mechanism whose first consumer is the
  plan-authoring skill below. Pairs with the chat-UI skills picker.

- **Multi-window + cross-window session drag-and-drop** → `docs/specs/2026-06-19-multi-window.md`.
  Conduit is single-instance/single-window today (a `requestSingleInstanceLock` routes every
  relaunch — incl. "Open in Conduit" — into the one window). Decided model: **one engine, many
  windows** — the main process keeps owning all shells; each `BrowserWindow` is a view onto the
  sessions it owns, so a **live** session can move between windows with **no PTY restart**.
  **Slice A** (foundation): hoist the engine out of the single-window closure into a window
  registry; per-window `state`/`term:data` routing keyed on `e.sender`; **New Window** command +
  Ctrl/Cmd+Shift+N; window controls target the sender's window; closing a window ends its sessions
  (existing running-session confirm), last window quits; restore collapses to one window (v1).
  **Slice B**: `session:move` (reassign owner, no remount — must not change the session's React
  key or it kills the ConPTY child, see [[conduit-powershell-crash-root-cause]]) + **Move to new
  window** / **Move to window…** menu actions; literal tab-drag across OS windows is best-effort
  (Electron doesn't carry HTML5 DnD across `BrowserWindow`s → **Slice C/vision** along with
  multi-window layout persistence + tear-out-to-desktop). Locked decisions (window model, launch
  routing, close behavior, restore) recorded in the spec's "Architecture decision" section. Not
  yet in a live build. See [[conduit-daily-driver-goal]].

- **Professional logging** → `docs/specs/2026-06-19-logging.md`. A single leveled logger
  (off/error/warn/info/debug/trace) across main + renderer, persisted to **rotating JSONL
  files** in userData (readable in a packaged build), controlled from Settings (enable + level,
  live), with secret **redaction** and a **"Reveal logs" / "Copy diagnostics"** action. **No
  in-app viewer in v1** (files + reveal). The point is to stop ghost-chasing: instrument the key
  seams (app/window lifecycle, session/PTY spawn-exit-dispose, IPC errors, file mutate, git
  actions, updater, scrollback persist/restore, OS-open/second-instance) — never the raw PTY
  byte stream. Pure core (level gate / format / redact / rotation) is unit-testable; extends the
  existing `{type:'log'}` channel. Default assumed ON@info (flagged). Not yet in a live build.

- **Git history — multi-branch commit graph** → `docs/specs/2026-06-19-git-history.md`. A
  **read-only** full **multi-branch graph** (all refs, lanes, merges, ref/HEAD badges) for the
  active repo, opened from a **button on the right of the git indicator bar**; click a commit to
  see author/date/message/changed-files and its **diff** (reuses the existing `FileDiffDTO` +
  diff viewer). New host module `src/git-history.ts` mirrors `git-info.ts` (bounded, non-throwing
  `execFile git log`/`git show`, host-only, `gitAvailable` latch); **pure** `parseCommits` +
  `assignLanes` are the testable core. Custom lane layout (no graph dependency — flagged
  reversible). Mutations (checkout/branch) are explicitly **out of scope** — they belong with the
  branch-switcher (branch-worktree-indicator Slice B) and its busy/dirty safety gating. New
  `git-history` doc kind (sibling to board/architecture/review). Not yet in a live build.

- **Interactive plans** → `docs/specs/2026-06-17-interactive-plans.md`. An agent authors a
  structured `.conduit/plan.json` (multi-step, nested substeps, per-step status, markdown
  bodies) rendered as an **interactive, commentable plan view** (center pane, sibling to the
  board/architecture canvas) instead of a wall of markdown. The user comments **anchored to a
  specific step/substep/text-span**, sets per-step Approve / Request-changes, and that feedback
  **persists to disk** (`.conduit/plan.comments.json`) so the **agent reads it next turn** and
  revises (structural rewrites via the existing `plan.proposed.json` proposal-diff flow). Reuses
  the `.conduit/` artifact + watcher + proposal infra (ADR 0002); realizes the `plan_update`
  seam reserved in the chat-UI spec; ships the `conduit-plan` skill the installer above
  delivers. See [[conduit-daily-driver-goal]].

---

_Shipped batches (history in `docs/runs/`): round-6/7 (2026-06-15); round-8; **round-9**
daily-driver `D1–D10` + Tier-1 `T1A`/`T1B` (`docs/runs/2026-06-16-daily-driver/`, 8 done + 4
committed-needs-human-smoke); **daily-driver-2** `E1–E3` live-cwd + breadcrumbs
(`docs/runs/2026-06-16-daily-driver-2/`). Open human-smoke recipes for the round-9
`needs-human-smoke` items (D2/T1A/T1B/D5) live in `.autoloop/blockers.md` — and are exactly
what W1 automates. **2026-06-17-night** (`docs/runs/2026-06-17-night/`): macOS test build +
installer branding + image-viewer zoom/diffs (shipped in **v0.1.13**); D11 was found already
shipped. Deferred from r7: "rename Conduit→Claude Code" (keystroke-injection
footgun) and the CLI-/rename ambient-title tradeoff._
