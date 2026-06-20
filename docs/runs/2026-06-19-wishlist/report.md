# Run report — wishlist batch (2026-06-19, autonomous)

Autonomous build-loop run draining the 2026-06-19 wishlist toward the daily-driver
goal. Conductor: Opus 4.8 (1M). Mode: delegated (fresh-context Opus subagents
implement; conductor held architecture + taste). Built **serially** on branch
**`git-run`** (not merged to `main` — main is checked out in a concurrent worktree;
release left to the user). The two FULL features both touch `protocol.ts` +
`main.ts` + `styles.css`, so a parallel fan-out would collide on shared entry files.

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

## Not built this run (deferred, with reasons — see `.autoloop/blockers.md`)

- **agent-chat-ui / skill-installer / interactive-plans** — already built and
  smoke-tested on branches `wt-chat-ui`, `wt-skill-installer`, `wt-interactive-plans`
  (and rolled up on `chat-ui`, which also archived their specs + drained the wishlist).
  `git-run` still lists them as active specs — the branch family was never integrated.
  **Not rebuilt** (rebuilding duplicates/conflicts with finished work). **Queued decision
  D-2:** user decides whether to merge the chat-ui family into `git-run`/`main` and
  resolve the wishlist/spec-archive divergence. `chat-ui` is also actively worked in
  worktree `conduit-wt-chatui` — confirm it's settled before merging.
- **multi-window** (`docs/specs/2026-06-19-multi-window.md`) — Slice A is a main-process
  engine hoist out of the single-window closure + per-window IPC routing; a cross-cutting
  `electron/main.ts` refactor whose regression blast radius touches every session's PTY
  routing. Per the loop's "don't auto-land risky bets unsupervised" rule (and main being
  live in a concurrent worktree), deferred to a supervised session. High daily-driver
  value — good next pick with a human watching.
- **branch-switcher Slice B** (`docs/specs/2026-06-18-branch-worktree-indicator.md`) —
  blocked on **decision D-1** (refuse-if-busy-or-dirty switch semantics; conductor
  recommends approving the spec's conservative default).

## Queued decisions for the user

- **D-1** — approve the branch-switcher's refuse-if-busy-or-dirty semantics → unblocks Slice B.
- **D-2** — integrate (or keep iterating) the `chat-ui`/`wt-*` branch family; resolve the
  git-run ↔ chat-ui wishlist/spec divergence.
- **logging default** — ON@`info` (flagged; flip to `warn`/off if undesired).

## Notes
- Phase 0: `npm run verify` baseline was green at kickoff; the e2e/observation harness
  (`test/e2e/run-smoke.mjs`, hidden Electron via `CONDUIT_E2E`) drove the real app for
  logging + git-history. The recurring `app.close()` teardown TIMEOUT under a loaded
  machine is a documented harness flake — assertions printed PASS before teardown in
  every scenario; not a feature failure.
- All four features land on `git-run` ahead of `main`; the user ff's `main` per release.
