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

- **D12 · Update card position: above the divider, overlaying session cards.** Today the
  `UpdateCard` renders *inside* `.sidebar__foot`, below the divider (the foot's `border-top`),
  above the Settings button (`sidebar.tsx:571`, `styles.css:2964`/`2995`). Move it **above the
  divider** and make it **overlay** the session list: render it as a **sticky footer of the
  scroll list** (`position: sticky; bottom: 0`, opaque `var(--surface)` background, small
  `z-index`) so it pins to the bottom of the session list and session cards scroll **under** it;
  the divider + Settings button stay in `.sidebar__foot` below it. Pure markup/CSS move, no logic
  change.

- **D13 · Git status decorations in the Files explorer.** Mark modified/added/deleted/untracked
  files in the Files tree with a minimalistic **colored dot on the right** of each row
  (amber = M, green = A and U/untracked, red = D). **Renderer-only overlay — no host/protocol
  change:** the renderer already receives `changes: ChangeDTO[]` (`path` + `kind: 'M'|'A'|'D'|'U'`)
  for the Changes tab, so `FilesView` builds a `Map<path, ChangeKind>` and decorates each entry by
  matching path. **Folders roll up:** a folder whose descendants contain a change gets a dot too
  (compute from the change paths). Precedence when a file is both staged + unstaged (porcelain
  `MM`): show the worktree/unstaged kind. Reuse existing status color tokens (the Changes view
  already colors add/del); no new hex. (`FileNodeDTO.status?` already exists in the model but the
  tree consumes `DirEntryDTO` (name+kind) — overlay in the renderer rather than widening the DTO.)
  Touches `webview/components/right-pane.tsx` (`FilesView`), `webview/file-tree.ts`, `styles.css`.

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

### Spec-ready (queued for a later autonomous run)

These are already fully specified — pick them up directly from their spec, no
brainstorming needed.

- **W1 · Real-app smoke harness + scenario port.** Reusable Playwright-Electron harness
  extracted from `test/e2e/paste.e2e.mjs`, plus a **comprehensive port** of the recurring
  `needs-human-smoke` scenarios (T1A attention, D2 reveal, D5 DnD, E2 live `cd`, T1B
  durability; scrollback authored-but-skipped until T2 lands) behind `npm run test:smoke`,
  **plus** the `esbuild`-in-`verify` gate fix. Kills the recurring "needs-human-smoke" tax
  so the autoloop can verify host/IPC/PTY/OS-boundary features itself. Spec:
  `docs/specs/2026-06-16-smoke-harness.md`. Stays OUT of `npm run verify`/CI (GUI + Windows
  ConPTY). See [[playwright-electron-real-app-verification]].

- **W2 · Quit/close/update-relaunch guard.** Conduit silently kills every running agent on
  quit, close (custom ✕ **and** OS Alt+F4/taskbar), and update-relaunch — no confirmation.
  Add a guard: pure `src/quit-guard.ts` + main-process interception of the window `close`
  event (the one seam that catches all three paths), confirming via the existing
  `confirm-dialog.tsx` with a native fallback if the renderer is wedged; the `updateRelaunch`
  handler confirms before `quitAndInstall()`. Always-on, triggers on any live PTY. The one
  genuine daily-driver *absence* (a data-loss path the shipped auto-updater introduced).
  Spec: `docs/specs/2026-06-16-quit-guard.md`. Adds a `quit-guard.e2e.mjs` scenario to W1.

- **W3 · Sidebar grouping: collapse + universal drag.** Three asks for the project-grouped
  sessions sidebar: (a) **collapse/expand** each project group (persisted chevron; collapsed
  header shows session count + a busy/needs-attention rollup); (b) make session-tab DnD work
  in **every** sort mode (not just manual) — a drop that **violates the active sort**
  auto-switches sort to **Manual**, committing the on-screen order + the move (no-op drop =
  no switch); (c) the same for **project reorder** (drag a project header), extending the
  existing `reorderByGroup`. Drag stays disabled while a text filter is active. Today
  `canDrag = sort === 'manual' && unfiltered` (`sidebar.tsx:337`) hard-gates it. Spec:
  `docs/specs/2026-06-16-sidebar-grouping.md`. Adds a `sidebar-dnd.e2e.mjs` scenario to W1.

---

_Shipped batches (history in `docs/runs/`): round-6/7 (2026-06-15); round-8; **round-9**
daily-driver `D1–D10` + Tier-1 `T1A`/`T1B` (`docs/runs/2026-06-16-daily-driver/`, 8 done + 4
committed-needs-human-smoke); **daily-driver-2** `E1–E3` live-cwd + breadcrumbs
(`docs/runs/2026-06-16-daily-driver-2/`). Open human-smoke recipes for the round-9
`needs-human-smoke` items (D2/T1A/T1B/D5) live in `.autoloop/blockers.md` — and are exactly
what W1 automates. Deferred from r7: "rename Conduit→Claude Code" (keystroke-injection
footgun) and the CLI-/rename ambient-title tradeoff._
