# Editor-parity run — 2026-09-28 → 2026-09-29

Autonomous build loop over five user requests, plus a discovery refill. Stopped on user request
("release what we have so far, pause and park the rest"): **v0.44.0 released** from `main` at
`3b64d88`; unfinished work parked on branches.

## Shipped in v0.44.0

| Item | Merge | Evidence |
|---|---|---|
| Folder chevrons on the left in Files and Changes; one tree treatment | `e65432b` | review APPROVE; QA 3 themes; merged-tree verify EXIT=0 |
| Rebindable Go to Definition / Implementations / References | `4233895` | review APPROVE (r2); QA 35/35; merged-tree verify EXIT=0 |
| Auto save (off / afterDelay / onFocusChange / onWindowChange) | `e54b3a1` | review APPROVE (r3); QA pass; merged-tree verify + 4 e2e EXIT=0 |
| Changes list and Files tree follow the focused tab | `de36575` | review APPROVE; QA pass (302-file tree, multi-repo, relaunch); verify EXIT=0 |
| Refill: rename/move/delete retarget open tabs; >2 MB partial files can't be truncated | `8466702` | review APPROVE (r3); QA defects all fixed with e2e; verify EXIT=0 |

Specs archived to `docs/specs/archive/2026-09-28-*.md`. Plans in `docs/plans/2026-09-28-*.plan.md`.

## Parked (not in the release)

- **split-editor** — `feat/split-editor` @ `bb13305` (48+ commits, based on `8466702`). Built in full;
  third review **APPROVE**; branch verify EXIT=0. Not merged because the final runtime QA (QA3) was
  stopped mid-run by the pause. Remaining before merge: the two review should-fixes
  (`webview/focus-targets.ts:17` disconnected-element clause; a `:focus` rule for `.gh` /
  `.review__scroll`), a QA3 re-run, then integrate. Also carries the fix for the measured
  **Ctrl+Tab / tab-click focus loss** (focus-target registry).
- **dirty-quit-guard** — `feat/dirty-quit-guard` @ `38b97f0` (based on `8466702`). Spec + plan
  reviewed (architecture critic REVISE → revised). Slices 1–2 of 6 built (A1 probe true; pure
  close-guard state machine, FileSaves hooks, unsaved-files, ConfirmDialog). Slices 3–6 touch
  `app.tsx` / `main.ts` and should be built after split-editor merges.

## Needs a human

- Auto save **On window change** — the hidden e2e window gets no renderer `blur`, so it's unverified.
- Quit guard's native "Wait / Close anyway" fallback (once built) — Playwright can't drive native dialogs.

## Decisions taken autonomously (override if you disagree)

- Files tree now also follows the focused tab (the request assumed it already did; it didn't).
- Auto save: compare-before-write only for auto/close saves; manual Ctrl+S unchanged. A file that
  differs from disk only by normalisation (mixed EOL / BOM) is never auto-saved.
- Nav keybindings: editor rows record `keyCode` (what Monaco matches), so non-US layouts work;
  a nav override always wins over other editor chords; context-menu hints use Monaco's compact style.
- Deleting a file whose tab has unsaved edits keeps the tab open, marked deleted (VS Code parity).
- 2 MB partial-load cap kept; partial files open read-only.
- Split editor (parked): symmetric editor-group state; Terminal stays group 1 only, a plain button
  beside the tablist; opens go to group 2 while group 1 shows the Terminal; tab-navigation chords
  skip the shell like VS Code's `commandsToSkipShell` (Ctrl+W still reaches the shell).

## Queued decisions for the user

1. Should a pointer click on the Terminal tab focus xterm (VS Code does)? Today it doesn't.
2. Ctrl+Tab from inside a focused web page can't switch tabs (the guest swallows it); fixing needs
   new key-forwarding IPC.
3. Raise the 2 MB partial-load cap for VS Code parity (needs perf measurement)?
4. Undo stack and HTML preview/source choice don't survive a rename.

## Discovered, not fixed (candidates for a next run)

- Explorer delete isn't undoable, and Ctrl+Z after a delete undoes an older, unrelated move.
- Double-clicking a file in Files leaves focus in Files; clicking a Changes row leaves focus on `body`.
- Ctrl+9 opens the 9th tab, not the last (VS Code: last).
- Changes rows aren't keyboard-reachable.
- Pre-existing e2e failures seen on base during the run: `mf-live-edits` ("E3: nothing pasted
  while busy") and `goto-index` ("deep source file … got 0"). Not caused by this run.
- file-integrity follow-ups: clean-source/dirty-destination drag-replace branch untested;
  `writeDone` after a disk conflict clears it (narrow race).

## Gate notes

- Every merge re-ran `npm run verify` on the merged tree (EXIT=0) plus the e2e scenarios touching
  the merged surfaces. Gate definitions only gained tests (baseline diff: selector swaps + additions).
- **Not done:** the full e2e sweep on merged `main` planned for run end — the release was cut on
  request before it. CI `verify` + `Release` run on the tag.

## Learnings

`learnings.md` in this folder (tagged per destination).

---

# Continuation — 2026-09-29 → 2026-09-30

Resumed after v0.44.0; v0.45.0 released mid-run (split editor, Electron 43.7.6, tab-switch focus).
Then, on user request, e2e moved off the local machine; the parked items and four discovery
items were gated with it. Unattended from "I won't be here".

## On origin/main (each gated by a full remote run incl. verify + the excluded scenarios run locally, one at a time)

| Item | Pushed | Notes |
|---|---|---|
| Remote e2e MVP (`npm run e2e:remote`; local = one exact-name scenario, BelowNormal, pipe lock) | `c3dfa39` | full suite ~14 min remote vs ~107 min local; 8 focus/display scenarios excluded remotely, run locally |
| Focus lands in the tab after leaving the Terminal | `c3dfa39` | root cause: a passive effect flushed at the next chord's render |
| Unsaved-files quit/close guard (Save / Don't Save / Cancel) | `58c4ff3` | the merge broke Back/Forward (`!!confirm` bound to `window.confirm`); caught by the remote full run, fixed + biome `noRestrictedGlobals` guard; focus ring on primary buttons fixed app-wide (`--rest-shadow`) |
| Milkdown timer unit-test flake | `87c4181` | uncleared upstream `setTimeout`; test outlives it |
| Folders opened via an 8.3 short path | `05f7174` | were refused for save/rename/preview and diffed as new; roots now canonicalised at registration only |
| **Security:** preview reads only its own folder | `902f054` | a junction or encoded `..%2F` segment let a page under root A read root B same-origin; per-root verdict, parser rejects separators, deepest root wins |

## Not pushed

- **Remote e2e v1** (nightly state, `--affected` by per-function coverage, quarantine, 6 slow
  scenarios split into 19, release gated on the full suite, `verify:quick`, 3 harness fixes) is
  merged into local `main` at `96ff52d`. Review APPROVE after 3 rounds. Its merged-tree gate was
  **stopped by the system (low memory)** before the remote run dispatched. To finish:
  `npm run e2e:remote -- --full`, the excluded scenarios locally, then push.

## Needs a human

- Quit guard's native "Wait / Close anyway" box (unresponsive renderer).
- Auto save **On window change** (hidden windows get no blur).
- Review `~/.claude/skills/autonomous-build-loop` edits: originals + diff in `.autoloop/evidence/slice-x/`.

## Decisions queued

- `--affected` selectivity is modest under the per-line rule; revisit with real main-nightly stats.
- Residual under-selection: functions run at startup are credited only to scenarios calling them
  later (mitigated by the always-run core smoke set + nightly/release full runs).
- Quarantine candidates to watch: timed-messages, review-multi-repo, multi-repo.
- Upstream Milkdown: `Timer` should clear its timeout (issue not filed).
- Earlier queue still open: Terminal click focusing xterm, Ctrl+Tab from web guests, the 2 MB
  cap, undo across rename, Monaco 0.57 for dompurify.
