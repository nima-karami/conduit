# Run report — 2026-08-20 james-crash-triad

One user incident (reported by James, with screenshot), three root causes, three fixes —
all merged to `main`, each with a pre-fix red proof and a full green verify. Not yet
released (version bump awaits approval; entries sit under CHANGELOG `[Unreleased]`).

Incident: clicking a commit-hash link in the terminal on a huge monorepo commit →
"Loading commit changes…" → black window (renderer OOM) → after restarting and clicking
↻ Relaunch, the terminal spammed `35;57;21M…` mouse-report junk into the shell.

Diagnosis (two independent code investigations, 2026-08-20) is summarized in the specs;
this report records what shipped and what remains.

## Shipped

| Fix | Commit | Spec | Proof |
|---|---|---|---|
| Scrollback replay neutralizer — cold relaunch appends `REPLAY_MODE_NEUTRALIZER` (DECRST mouse/alt-screen/paste/DECCKM + autowrap/DECSTBM/SGR resets) so a dead TUI's modes can't arm against a fresh shell; attach path deliberately exempt (a live TUI's replayed modes are correct) | `a0ba91e` | `2026-08-20-scrollback-replay-neutralizer.md` | e2e `scrollback-mode-neutralize`: pre-fix red reproduced the literal `\x1b[<35;11;5M…` junk; post-fix green ×6. 17 unit tests. |
| Renderer crash auto-recovery — `render-process-gone` on every window; pure `decideCrashRecovery` (`ignore` clean-exit/killed; `reload` crashes incl. unknown reasons; `give-up` past 3 reloads/5 min); reload takes the attach path so PTY children survive | `d9a609b` | `2026-08-20-renderer-crash-recovery.md` | e2e `renderer-crash-recover`: real `forcefullyCrashRenderer`, pid change, no-click re-attach, ring replay, post-crash echo; pre-fix red "window still black". `quit-guard` + `durability` green. 20 unit tests. |
| Commit-review memory bounds — prefix/suffix trim + `MAX_LCS_CELLS` budget + `approx` flag in `diffLines`; host `--numstat` badge counts on `FileDiffDTO`; `useCommitFiles` error channel + Retry; `GIT_TIMEOUT.diff` for commit diffs; emphasis guard | `2339f83`…`43b203c` | `2026-08-20-commit-review-memory-bounds.md` (plan: `docs/plans/2026-08-20-commit-diff-oom.plan.md`) | Unit red proof was a genuine V8 OOM of the vitest worker; e2e `commit-review-bounds` ready in 1.3 s vs 34.7 s pre-fix (over the 20 s budget), exact hunks for the trim case, approx notice for the unrelated-sides case, numstat-exact badges, error state for a bogus sha. Independent code review: APPROVE (trim arithmetic hand-verified). |
| Review-note follow-through: preview fake shell now answers `git:commitDiff` via the error channel (was: eternal "Loading…" in browser preview) | `0d8838e` | — (review note) | biome + typecheck; covered by the error-state path. |

Also: corrected the stale CLAUDE.md claim that Claude Code never enables mouse tracking
(true ≤2.1.223; newer versions do — that is how the incident happened), and the false
"replay is non-destructive" comment in `src/settings.ts`.

Verify on final `main`: 202 test files / 2829 passed, biome clean, typecheck+build clean,
audit clean (2 pre-existing moderate), gitleaks clean. First final-verify attempt failed
on a gitleaks FALSE POSITIVE: an e2e evidence log in `.autoloop/evidence/` captured
`"token":"<40-hex commit sha>"`, which matches `generic-api-key`. Resolved by redacting
hex SHAs in the evidence log — the gate itself was not touched. **Lesson for future
runs:** evidence logs live inside the scanned tree; never capture key-like JSON
(`token:`/`key:`) with hex values verbatim — redact SHAs at capture time.

## Verification notes

- All three fixes verified against the REAL built app (hidden harness), serially, with
  pre-fix red runs proving each test bites. No `needs-human-smoke` items.
- Platform caveat: verification ran on Windows. James is on macOS; every fix is
  platform-neutral (string suffix / Electron event / pure math), but no macOS build was
  exercised in this run.
- e2e technique worth keeping (documented in the crash-recovery scenario header): a
  crashed target permanently kills the Playwright `Page`; post-crash assertions must go
  through `webContents.executeJavaScript`, and pre-load hooks need CDP
  `Page.addScriptToEvaluateOnNewDocument` via `webContents.debugger`.

## Follow-ups (queued, not blocking)

1. **History detail pane ignores the new commit-diff `error` status** — shows its empty
   state ("No files") where Review shows Retry (`webview/components/commit-view.tsx`).
2. **Range mode still derives badges by diffing in the renderer** — bounded now, but a
   large comparison can burn seconds of main thread; migrate `getRangeDiff` to
   `--numstat` like the commit path (spec's declared out-of-scope).
3. **numstat-timeout fallback**: if the extra `--numstat` spawn fails, the whole
   changeset falls back to the renderer parse (bounded, but the "no whole-changeset
   parse" guarantee is happy-path only).
4. **`git-wedged` stress headroom shrank** (~22 s → ~10 s) with the 10 s diff timeout —
   one slow spawn from flaking; consider raising its budget.
5. **Commit-diff IPC payload is still file-count-capped only** — streaming/chunking the
   multi-MB single message is the remaining robustness gap on this path.
6. Cosmetic: a >4 M-line pure add/delete would flag `approx` needlessly (unreachable
   under the 2 MB per-side cap).

## Decisions made under autonomy

- Neutralizer applies to the cold relaunch path only (attach exempt) — rationale in the
  spec; this was the one open design point in the diagnosis.
- Crash recovery gives up (logs, stops reloading) after 3 reloads in 5 min rather than
  showing a dialog — a reload storm is worse than a stable black window with logs.
- e2e for memory bounds drives the History → Review path rather than the terminal-link
  click (the link path has its own scenario; keeping a PTY dependency out of the memory
  proof avoided a documented false-signal flake, which duly appeared once and passed
  alone twice).
- Release not performed — awaiting approval.
