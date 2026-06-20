# Run report — wishlist batch (2026-06-19, autonomous)

Autonomous build-loop run draining the 2026-06-19 wishlist toward the daily-driver
goal. Conductor: Opus 4.8 (1M). Mode: delegated (fresh-context Opus subagents
implement; conductor held architecture + taste). Built **serially** on branch
**`git-run`** (not merged to `main`; release left to the user). FULL features touch
shared entry files (`protocol.ts` / `main.ts` / `styles.css`), so a parallel fan-out
would collide — serial build + per-feature independent verify was the safe call.

> **Phase 2 (continuation):** the user confirmed they were the sole session (no
> contention) and asked to "finish the job" — build Slice B for logging + git-history
> and the full multi-window feature. Those four shipped too; see the **Phase 2** section
> below. Every feature's merged tree was independently re-verified green (exit 0).

## Shipped (verified, committed on `git-run`)

| Feature | Tier | Spec | Commit | Verify | Runtime proof |
|---|---|---|---|---|---|
| **cwd-card** — session card folder/path follows live cwd | LITE | wishlist bug 1 | `1a196c6` | green (1470) | preview render: card shows live `cwd` folder while group header keeps launch `projectPath` |
| **group-reorder-snap** — manual-mode group/card drag persists | LITE | wishlist bug 2 | `fa62181` | green (1470) | pure `reorderPersists` unit-covered (5 cases); bug was 100% in the pure decision; drag wiring unchanged |
| **logging** — leveled JSONL logger (Slice A) | FULL | `docs/specs/2026-06-19-logging.md` | `63225a5` | green (1496) | `logging` e2e 3/3: JSONL record written, secret `token`→`[redacted]` (`path` kept), `revealLogs`→`shell.openPath` |
| **git-history** — read-only multi-branch commit graph (Slice A) | FULL | `docs/specs/2026-06-19-git-history.md` | `a70a1b1` (backend) + `9174700` (renderer) | green (1518) | `git-history` e2e: 459 commits, laneCount=3, rows rendered in DOM, commit-select fetched a 4-file diff + screenshot |

Final `npm run verify` on the combined `git-run` tree was **independently re-confirmed
green (exit 0) after each FULL feature** — 1518 unit tests, dead-code clean, gitleaks
clean. (`npm audit` notes pre-existing low/moderate dompurify advisories via
monaco-editor, below the high gate, unchanged by this run; semgrep runs in CI.)

### cwd-card (`1a196c6`)
`fieldValue` folder/path cases and the `SessionItem` detail tooltip now use
`session.cwd ?? session.projectPath`, so a card reflects where the shell actually is
after `cd`. **Grouping is deliberately unchanged** (still keyed on launch
`projectPath`) — the user's note flagged dynamic re-grouping as a separate opt-in; we
shipped the display fix now and left re-bucketing as future work. 4 new unit cases.

### group-reorder-snap (`fa62181`)
Root cause was a self-referential gate: `commitReorder` compared the dropped
candidate against `sortedCanonical(candidate)`, which returns the candidate unchanged
in manual sort → always a no-op → manual reorders never persisted. Extracted a pure
`reorderPersists(candidate, current, sort, sessionsById)` into `src/reorder.ts`
(manual → baseline is the current rendered order; computed sorts → baseline is the
sort canonical, keeping the deviate→switch-to-manual path); both drag callers now pass
`renderedIds`. 5 new unit cases.

### logging (`63225a5`)
Slice A (MVP): pure core `src/logging.ts` (`levelEnabled`/`formatRecord`/`redact`/
`shouldRotate`/`pruneOldLogs`); host `electron/logger.ts` is the sole disk writer
(rotating JSONL in `userData/logs/`, dev-only console, best-effort never-throws,
`CONDUIT_E2E` → temp dir). Settings gained `logging` (ON) + `logLevel` (`info`),
live-applied; the renderer `log` channel was extended back-compatibly; `revealLogs`
IPC opens the folder. Seams instrumented: app/window lifecycle, pty spawn/exit
(info) + resize/dispose (debug), IPC errors, fs mutate, git actions/refresh, updater,
scrollback, second-instance/OS-open — **never the PTY byte stream**. 21 logging + 8
settings unit cases.
- **needs-human-smoke (minor):** the Settings "Logging" toggle/dropdown/Reveal-logs
  were not driven by a UI click in the smoke (the underlying logic + FS write + redaction
  + reveal IPC ARE proven by the e2e). `copyDiagnostics` is Slice B (not built).
- **Decision (flagged):** default ON@`info` — surfaced for the user to flip to `warn`/off.

### git-history (`a70a1b1` backend, `9174700` renderer)
Slice A (MVP), split backend→frontend. Backend `src/git-history.ts` mirrors
`git-info.ts` discipline (bounded non-throwing `execFile` with an arg array,
`gitAvailable` latch, host-only): pure `parseCommits` + `assignLanes` (the testable
core — 12 unit cases proving merge multi-parent edges, root lane termination, ref
prefix-stripping + HEAD/tag/remote distinction), `getHistory` (paged, `hasMore` via
over-fetch) and `getCommitDiff` (reuses the existing `FileDiffDTO` shape from
`file-service.ts`; merge → vs first parent, root → vs empty tree). Renderer: a new
`git-history` doc kind (center pane, kept mounted), an entry button at the right of
the git indicator bar, a "commit ledger" graph (crisp SVG lanes themed via CSS vars,
merge = hollow diamond, HEAD ringed, capped ref badges), commit detail drawer (full
message + changed files + copy-SHA), file click → existing diff viewer, keyboard list
nav. Mutations (checkout/branch) are out of scope per spec. 10 render unit cases +
a real-app e2e.
- **Limitation / needs-human-smoke (minor):** the backend resolves an empty repo and a
  not-a-git-repo cwd to the same empty result with no distinguishing flag, so the view
  shows one neutral "no history" state for both; a distinct `not-a-repo` message and the
  `error/timeout` retry state aren't exercised in the e2e. Splitting them (host flag) is
  a clean Slice B follow-up.

## Phase 2 — Slice B + multi-window (shipped, verified, committed on `git-run`)

After the user confirmed sole-session/no-contention and asked to finish the job, four
more FULL features shipped, serially, each independently re-verified green:

| Feature | Spec | Commit | Verify | Runtime proof |
|---|---|---|---|---|
| **logging Slice B** | `archive/2026-06-19-logging.md` | `04e8fbb` | green (1525) | e2e: renderer `log.<level>` lands in JSONL; `copyDiagnostics` bundle (versions+redacted tail) → reveal; `readLogTail`/About tail |
| **git-history Slice B** | `archive/2026-06-19-git-history.md` | `b12843b` | green (1546) | e2e on this repo: search → 6/462 rows; ref filter (parent-walk reachability) → 9 rows; virtualization 9 DOM rows vs 462; refresh request-id guard |
| **multi-window Slice A** | `archive/2026-06-19-multi-window.md` | `ff0ceb5` | green (1553) | e2e: 2 windows, per-window state isolation (w1=[A]/w2=[B]), term:data routed to owner only (SENTINEL in w2 not w1), independent close. Both window screenshots captured |
| **multi-window Slice B** | same | `0ff8018` | green (1557) | e2e: move live session w1→w2 — **pre-move SENTINEL replayed into w2 + post-move echo lands (live PTY survived) + no relaunch banner**; reject bogus window. Screenshots: w1 empty, w2 holds both sentinels |

### logging Slice B (`04e8fbb`)
Renderer logger `webview/log.ts` (bridge-routed, console fallback, guarded); `copyDiagnostics`
IPC (version/OS header + already-redacted log tail → `showItemInFolder`); `readLogTail` IPC →
recent-log tail in Settings → About (off-aware). Pure `buildDiagnosticsHeader` + `tailLines`
unit-tested. Broadened seams (settings save, rename/duplicate, shell reveal/open, board/spec
writes, search). Invariants preserved (never-throw, redact-before-sink, no PTY byte stream).

### git-history Slice B (`b12843b`)
New `src/git-search.ts` pure helpers (`matchesQuery`, `reachableFromRef` BFS parent-walk ref
filter, `filterCommits`, `isStaleHistory`, `visibleRange`) — 21 unit cases. `assignLanes` moved
to node-free `src/git-graph-render.ts` (renderer re-lays-out the filtered set client-side);
`git-history.ts` re-exports. Fixed-height row virtualization with the SVG lane gutter windowed
to match. Refresh wired to the git-fingerprint + focus seams, debounced, with a monotonic
request-id guard (newest wins) that preserves query/filter/selection. *Provenance note:* this
slice leveraged pre-existing uncommitted WIP on the branch; the subagent reviewed it, upgraded
the ref filter to true reachability, verified against the real app, and committed. Integrity was
re-checked (logging IPC + git-history Slice A handlers intact). Search is scoped to loaded
commits (documented, spec-consistent).

### multi-window Slice A (`ff0ceb5`) — the engine refactor
Hoisted the single-window engine into a process-global **window registry** (`windows` Map +
`sessionOwner` Map + `primaryWindowId`; new pure `src/window-registry.ts`, 7 unit cases). The
single `send()` became three explicit routes — **broadcast** (path-tagged/shared, renderer
ignores non-current), **reply-to-sender** (request/response), **send-to-owner** (session-scoped
`term:data`/`term:exit`). `postState` filters each window to its owned sessions. New Window
(`win:new` + Ctrl/Cmd+Shift+N + palette) opens an empty window; ownership is assigned from
`e.sender` (D-2 — a renderer can't claim another window's sessions); restore collapses to the
primary window (D-4); `second-instance` routes to the focused window; window controls target
`BrowserWindow.fromWebContents(e.sender)`; the close guard is **per-window** (confirms + disposes
only that window's running sessions; last window quits). Conductor read all of `main.ts`, made
the architecture/send-classification calls, and spot-checked the built `postState` + close-guard.

### multi-window Slice B (`0ff8018`) — move a live session, no PTY restart
`PtyHost.isAlive()` + an **attach-aware `term:start`**: when the PTY is already alive (a window
adopting a moved session), the host replays the scrollback ring to that window and resizes —
it never respawns (`pty.start` was already idempotent). `session:move` reassigns ownership,
re-`postState`s both windows, and activates the session in the target; `win:list` + a `windowId`
in `state` drive the "Move to window…" picker; Move-to-new-window / Move-to-window entries on the
sidebar + tab context menus + palette. **The subagent caught a real hazard the plan missed:** the
source pane's unmount fires `term:dispose`, which killed the live PTY mid-move — fixed with a
one-shot `movingSessions` guard that swallows exactly that dispose (conductor spot-checked: sound,
one-shot consume). Cross-window pointer drag + layout persistence are Slice C (deferred per D-3/D-4).

## Phase 3 — branch switcher (D-1) + multi-window Slice C (shipped, verified, committed)

The user approved **D-1** (build the branch switcher), deferred **D-2** (chat-ui family —
needs hands-on testing), and asked for **multi-window Slice C**. Three more FULL features,
serial, each independently re-verified green:

| Feature | Spec | Commit | Verify | Runtime proof |
|---|---|---|---|---|
| **branch switcher (indicator Slice B)** | `archive/2026-06-18-branch-worktree-indicator.md` | `ef7a555` | green (1572) | e2e on a seeded 2-branch repo: switch idle+clean → branch updates, `projectPath` unchanged; refused when busy; refused when dirty; invalid ref rejected. Dropdown screenshot |
| **multi-window Slice C — drag + tear-out** | `archive/2026-06-19-multi-window.md` | `1605dc1` | green (1581) | e2e: `session:dragEnd` over another window → moves + PTY survives; over source → no-op; over desktop → tears out a new window. Torn-out window shows full accumulated scrollback |
| **multi-window Slice C — layout persistence** | same | `70e09cf` | green (1596) | **two-launch** e2e (shared user-data dir): quit with 2 windows → relaunch restores 2 windows, sessions back in their own windows (stale, isolated), window bounds round-tripped |

### branch switcher (`ef7a555`) — D-1 approved
Click the branch segment → a filterable, keyboard-navigable dropdown of local branches
(current marked, aria). Selecting one sends `git:switch`; the host **validates the ref against
its own enumerated list**, **refuses if the session is busy or the tree is dirty** (reason +
`aria-live` announcement, no git run), else runs `git checkout` **out-of-band via execFile**
(never typed into the shell) and refreshes the indicator. Pure `decideSwitch`/`isKnownRef` +
host `listBranches`/`isDirty`/`switchBranch`. `projectPath` never changes. **Worktree-switch-in-
place deferred** — ill-defined under a live shell; stays the spec's future "open worktree in a
new session" affordance.

### multi-window Slice C — cross-window drag + tear-out (`1605dc1`)
Electron doesn't carry HTML5 DnD across windows, so a tab `dragend` reports its **screen
coordinates** (`session:dragEnd`); the main process hit-tests which window contains the point
(pure `windowAtPoint`) and moves the session there (reusing Slice B's `moveSessionToWindow`,
factored out and shared), or **tears out a new window** at the drop point (pure `tearOutBounds`)
when the drop is on empty desktop; a drop back over the source window is a no-op (in-strip
reorder still stands). **needs-human-smoke:** the literal cross-window mouse-drag *gesture* isn't
synthesizable in Playwright — the `dragEnd` message + full host path are verified; a human should
confirm the gesture feels right.

### multi-window Slice C — layout persistence (`70e09cf`)
Window geometry + per-window session ownership persist to `windows.json` (userData), debounced on
move/resize/create + after a session move, with a guarded `before-quit` snapshot. On launch a pure
`planLayoutRestore` rebuilds the layout (drops vanished sessions, orphans → primary, ≥1 window,
single-window fallback when there's no file) — replacing Slice A's "collapse to one window" (D-4).
The **quit-vs-close rule** is the crux: quitting (or closing the last window) now **preserves**
its sessions so they restore, while deliberately closing one window among several still ends its
sessions. 37 unit cases + a real two-launch restore e2e (both restored windows screenshotted —
window-2 came back at its persisted resized bounds).

### de-flake (`d8a0380`)
While finalizing, the full `npm run verify` intermittently failed on the **real-git integration
tests timing out at the 5 s default** (7 tests, 2 files) — they pass fast in isolation (~14 s for
all 28) but get starved under the full 130-file suite's import/transform load. Scoped a 30 s
timeout to just those real-subprocess describe blocks (pure unit tests keep the tight 5 s); no
assertion changed. Full verify then green (exit 0), independently confirmed.

## Not built this run (deferred, with reasons — see `.autoloop/blockers.md`)

- **agent-chat-ui / skill-installer / interactive-plans** — already built and
  smoke-tested on branches `wt-chat-ui`, `wt-skill-installer`, `wt-interactive-plans`
  (and rolled up on `chat-ui`, which also archived their specs + drained the wishlist).
  `git-run` still lists them as active specs — the branch family was never integrated.
  **Not rebuilt** (rebuilding duplicates/conflicts with finished work). **Queued decision
  D-2:** user decides whether to merge the chat-ui family into `git-run`/`main` and
  resolve the wishlist/spec-archive divergence. `chat-ui` is also actively worked in
  worktree `conduit-wt-chatui` — confirm it's settled before merging.
  (`chat-ui` is also worked in worktree `conduit-wt-chatui` — confirm it's settled before merging.)

Everything else from the wishlist is now BUILT: multi-window Slice A+B (phase 2) and Slice C
(phase 3); the branch switcher (phase 3, D-1 approved). The only remaining slivers are explicit
**vision/future** items, not blockers: worktree-*switch*-in-place (branch switcher) and any further
multi-window polish.

## Queued decisions for the user

- **D-1** — RESOLVED (approved 2026-06-20): branch switcher built with the refuse-if-busy/dirty
  semantics.
- **D-2** — STILL OPEN: integrate (or keep iterating) the `chat-ui`/`wt-*` branch family
  (agent-chat-ui, skill-installer, interactive-plans); resolve the git-run ↔ chat-ui wishlist/spec
  divergence. User is testing it hands-on first.
- **logging default** — ON@`info` (flagged; flip to `warn`/off if undesired).

## Notes
- Phase 0: `npm run verify` baseline was green at kickoff; the e2e/observation harness
  (`test/e2e/run-smoke.mjs`, hidden Electron via `CONDUIT_E2E`) drove the real app for
  logging + git-history. The recurring `app.close()` teardown TIMEOUT under a loaded
  machine is a documented harness flake — assertions printed PASS before teardown in
  every scenario; not a feature failure.
- All four features land on `git-run` ahead of `main`; the user ff's `main` per release.
