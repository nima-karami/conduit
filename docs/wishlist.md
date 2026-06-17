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

- **D11 · Clickable file/folder paths in terminal output → open in the editor.** When an
  agent (e.g. Claude Code) prints a file or folder path in its chat/terminal output, it
  should be **clickable** to open that file in the embedded Monaco editor (and folders to
  reveal in the Files view). No xterm link provider exists today (verified: no
  `registerLinkProvider`/web-links addon) — this is net-new. Register a custom xterm link
  provider on the terminal that detects path-like tokens (absolute + relative, with
  optional `:line[:col]` suffixes like `app.tsx:109`), **resolves them against the
  session's `activeCwd`** (the new E2 field), validates existence host-side through the
  path-guard (`src/path-guard.ts`), and on click routes through the existing
  `readFile`→`fileContent` editor-open flow — opening in (and switching to) the path's
  **owning** session, consistent with the per-session editor model. Reuse the
  `setReveal`/`takeReveal` seam to jump to the `:line` when present. Folders → reveal in the
  Files view (or the existing reveal action). Style matched links (underline on hover),
  keyboard-accessible, and guard for `window.agentDeck` being absent (mock preview). Touches
  `webview/components/terminal-pane.tsx`, the editor-open path, and `src/path-guard.ts`.

- **T2 · Terminal scrollback persistence across restart.** The highest-value remaining
  "don't lose my work" durability gap, **deliberately deferred from T1B** (which shipped
  auto-relaunch + "relaunch all stale" + a restarted marker, but *not* history). Today
  `src/persistence.ts` restores a session's metadata only — the PTY and its **scrollback are
  lost**, so a relaunched session starts blank. Persist each session's terminal scrollback
  (bounded ring buffer) and restore it into xterm on reopen/relaunch so the prior history is
  visible. Decisions to make: where the buffer lives (userData, keyed by session id) and its
  size cap; whether restored history is visually marked as pre-restart; interaction with the
  opt-in auto-relaunch. Larger sub-project than a papercut — likely its own spec. Note: W1's
  `scrollback.e2e.mjs` smoke scenario is **already authored and skipped, waiting on this
  feature** to land. See [[conduit-daily-driver-goal]].

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
what W1 automates. Deferred from r7: "rename Conduit→Claude Code" (keystroke-injection
footgun) and the CLI-/rename ambient-title tradeoff._
