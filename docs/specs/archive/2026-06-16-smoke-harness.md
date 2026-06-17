---
status: implemented
date: 2026-06-16
---

# Real-app smoke harness + scenario port

## Problem

Every autonomous build-loop run that touches a **host / IPC / PTY / OS-boundary**
feature ends with items marked `needs-human-smoke`: the logic is unit-tested and the
renderer is verified against the mock preview, but the *real* effect crosses the
Electron boundary the mock can't exercise, so a human must launch the built app and
eyeball it. This recurs in every recent run (paste, D2 reveal, T1A attention routing,
T1B relaunch, D5 file DnD, E2 live `cd`). One proven real-app test exists
(`test/e2e/paste.e2e.mjs`) but its launch/bridge/assertion boilerplate is inlined, so
nothing reuses it and the autoloop has no command to drive.

A companion gap rides along: `npm run verify` does **not** bundle the renderer, so a
browser-unsafe import in shared `src/` passes verify yet breaks the esbuild IIFE build.
Every recent run worked around this by running `node esbuild.mjs` manually.

## Goal

A **Playwright-Electron smoke suite the autoloop can run itself**, so host-boundary
features are verified autonomously instead of deferred to human smoke. Deliverable:

1. A **reusable harness** extracted from `paste.e2e.mjs`.
2. A **comprehensive port** of the outstanding `needs-human-smoke` scenarios onto it.
3. One command — `npm run test:smoke` — that runs them all with a pass/fail/skip summary.
4. The **`esbuild`-in-verify gate fix** (bundled here because it is the other standing
   workflow gap).

## Hard constraints (from the repo — do not violate)

- **Never add the smoke suite to `npm run verify` or `verify.yml`.** CI is headless
  Linux; this suite needs a real GUI and Windows ConPTY. It runs on the autoloop's
  Windows machine only. On non-`win32` / no-GUI it must **skip gracefully** (`exit 0`,
  print `SKIP`), exactly as `paste.e2e.mjs` does today.
- **Resolve Playwright by path from the npx cache**, never `require('playwright')` as a
  bare specifier. Playwright is intentionally *not* a `package.json` dependency; a bare
  require would trip the dead-code / unlisted-dependency gates (Fallow). Reuse
  `loadPlaywright()`'s candidate-path search from `paste.e2e.mjs`.
- Each run launches with a **throwaway `--user-data-dir`** (a fresh `mkdtemp` dir) so it
  starts from a clean slate and **never touches the user's real `sessions.json` /
  `agents.json`**.
- **No production-code changes for the sake of observability.** Assertions observe the
  real app from the outside (see §3). The only production-file edit in this spec is the
  `verify` chain change in §5.
- Scratch artifacts (temp user-data dirs, reader scripts, dump files) go in
  `os.tmpdir()` via `mkdtemp`, never in the repo tree.

## 1. Harness module — `test/e2e/harness.mjs`

Extract the boilerplate currently inlined in `paste.e2e.mjs` into a shared ESM module.
Exports:

- `loadPlaywright()` — the npx-cache path search (moved verbatim from `paste.e2e.mjs`).
- `launchApp({ extraArgs? } = {})` → `{ app, page, userDataDir, cleanup }`. Launches the
  real built app (`_electron.launch` with `executablePath = require('electron')`, a fresh
  throwaway `--user-data-dir`, and the repo path), waits for `domcontentloaded` and
  `window.agentDeck`. `cleanup()` closes the app and removes temp dirs.
- `tapBridge(page)` — installs a `window.agentDeck.subscribe` capture into `window.__cap`
  (concatenated `term:data`) and `window.__sessions` (latest `state.sessions`). Idempotent
  per page.
- `openSession(page, { path, agentId })` → resolves to the new session id. Drives
  `post({ type:'openRepo', path, agentId })` (no native folder dialog — `openRepo` falls
  back to the first detected shell if the id is missing), waits for `.termpane` and for the
  new session to appear in `window.__sessions`.
- `spyMain(app, apiSpecs)` — **the assertion seam (§3)**. Via `app.evaluate()`, wraps the
  named real Electron APIs at runtime so each call is recorded into a buffer on the main
  process. Returns nothing; calls are read back with `getSpyCalls(app)`.
- `getSpyCalls(app)` → `Array<{ api, args, ts }>` read from the main-process buffer via
  `app.evaluate()`.
- `setWindowFocus(app, focused)` — drive real `win.focus()` / `win.blur()` (or
  `BrowserWindow.blur`) so focus-gated behavior (T1A) can be exercised.
- `sendDragDrop(page, { files, targetSelector })` — dispatches a real
  `DragEvent('drop', { dataTransfer })` (with a populated `DataTransfer` listing file
  paths) on the target element, generalizing the paste-`ClipboardEvent` technique. Also
  fires the `dragenter`/`dragover` the handler expects.
- `runShellReader(page, sid, { script, dumpPath })` — write a reader script to a temp dir,
  send it as `term:input`, wait for its `READY` sentinel; used by stdin-asserting scenarios
  (paste).
- Small assertion helpers (`assert`, `assertCall(calls, api, predicate)`) and a uniform
  `log()` / exit-code convention (`0` pass/skip-on-non-win32, `1` fail, `2` error).

**Robustness principle:** prefer `page.waitForFunction` polling over fixed
`waitForTimeout` sleeps wherever a state condition can be observed; reserve fixed waits
only for the few cases with no observable signal (e.g. letting xterm process
`ESC[?2004h`), and keep them documented.

## 2. Runner — `test/e2e/run-smoke.mjs` + `npm run test:smoke`

- Discovers `test/e2e/*.e2e.mjs`, runs them **sequentially** (they each launch a real
  app; parallel launches contend on the GUI), each as a child process so one crash can't
  abort the suite.
- Prints a per-scenario `PASS` / `FAIL` / `SKIP` line plus a final summary; exits non-zero
  if any scenario failed.
- On non-`win32`, prints `SKIP (suite is Windows-only)` and exits `0`.
- `package.json`: `"test:smoke": "node test/e2e/run-smoke.mjs"` — the single canonical
  command. (The old `test:e2e` script, which pointed at the bare `paste.e2e.mjs`, is
  removed; `run-smoke.mjs` supersedes it and accepts a name filter for targeted runs.)

## 3. Assertion seam — main-process spy via `app.evaluate`

The chosen strategy for side-effects with **no observable getter** (OS notifications,
taskbar flash, tray/overlay badge, reveal-in-Explorer, on-disk fs move). Playwright's
`_electron` driver can run code in the **main process** via `app.evaluate()`. Before
triggering a scenario, `spyMain` wraps the real APIs there to record every call; the
scenario then asserts the right call fired with the right args. This observes the real
call with **zero production-code change**.

APIs wrapped (initial set; the harness takes a spec list so new ones are cheap):

- `Notification` — replace the global constructor in main with a recording shim.
- `BrowserWindow.prototype.flashFrame` — wrap; record the boolean arg.
- `BrowserWindow.prototype.setOverlayIcon` — wrap; record.
- `app.setBadgeCount` — wrap; record the count.
- `shell.openPath` and `shell.showItemInFolder` — wrap; record the path.

For DnD, the assertion is **on-disk**: after `sendDragDrop`, poll until the source file is
gone and the destination exists (the move must have gone through `src/path-guard.ts`); a
path-guard rejection is a fail.

Anything that proves genuinely unobservable even via the spy is documented in the spec as
**residual human-smoke** — not silently dropped. (Expectation: none in §4 except
scrollback, which is blocked on its feature, not on observability.)

## 4. Scenario port

Each scenario is its own `<name>.e2e.mjs` importing the harness, with explicit pass
criteria. Tier mirrors the autoloop convention (`LITE` = single assertion, `FULL` =
multi-step / multiple assertions).

| Scenario | File | Tier | Assertion |
|---|---|---|---|
| **paste** (migrate existing) | `paste.e2e.mjs` | FULL | Real `Ctrl+V` of a 25-line payload reaches the child wrapped in `ESC[200~ … ESC[201~` (bracketed), via the stdin reader. Behavior-identical to today; only the boilerplate moves to the harness. |
| **T1A attention routing** | `attention.e2e.mjs` | FULL | With the window **blurred** (`setWindowFocus(false)`), drive a busy→idle "needs-attention" edge; assert `spyMain` recorded `Notification` + `flashFrame(true)` + an overlay/badge call. Then `setWindowFocus(true)`; assert the attention is **cleared** (`flashFrame(false)` / badge reset) and that triggering the edge **while focused fires nothing**. Respects the setting gate (on by default). |
| **D2 reveal-in-Explorer** | `reveal.e2e.mjs` | LITE | Trigger reveal on a **directory** → assert `shell.openPath(dir)` recorded (not `showItemInFolder`). Trigger on a **file** → assert `showItemInFolder(file)`. |
| **D5 file DnD** | `dnd.e2e.mjs` | FULL | `sendDragDrop` a file from one folder row to another in the Files view; poll until the file **moved on disk** to the destination and is gone from the source. Verify a move *outside* the project root is **rejected** by the path-guard (file unchanged). |
| **E2 live `cd`** | `cwd.e2e.mjs` | FULL | With `trackCwd` on (default): in a real **PowerShell** session `cd` into a subfolder → assert `state` for that session shows `cwd` = the subfolder while its sidebar group stays on `projectPath`. Repeat in **bash/Git Bash**. Open a **claude/agent** session → assert its launch args/prompt are **unaltered**. Toggle `trackCwd` **off** → `cd` no longer moves `cwd`. (This is the E2b human-smoke recipe, automated.) |
| **T1B durability** | `durability.e2e.mjs` | FULL | Open a session, confirm running; kill its PTY (or close+relaunch the app on the same `--user-data-dir`); on reopen assert the session is **restored** (status reflects stale/relaunched) and the **relaunch** action brings it back to `running`. |
| **scrollback restore** | `scrollback.e2e.mjs` | — | **Authored but quarantined / skipped** until the scrollback-persistence feature exists (it is the deferred next daily-driver item). The file ships with the intended assertion (restart → prior `term:data` history is present in the restored session) guarded by a feature-presence check that makes it `SKIP` today and flip to active when the feature lands. No false green. |

## 5. `esbuild`-in-verify gate fix

Separate, small, same spec. The renderer is bundled by `node esbuild.mjs` (the `build`
script) but `npm run verify` never runs it, so a browser-unsafe import in shared `src/`
(e.g. a Node built-in pulled into a file the webview imports) passes verify and only
breaks at package time.

Fix — **add** the bundle to the gate (a strengthening; adds a check, never narrows one):

- `package.json` `verify` chain: insert `npm run build` (i.e. `node esbuild.mjs`) into the
  chain — placed after `typecheck` (fail fast on types first) and before the heavier
  security steps. The build is pure bundling, needs no GUI, and is safe on CI.
- `.github/workflows/verify.yml`: add a `Build (bundle main + preload + renderer)` step
  running `npm run build`, mirroring the script order.

This stays consistent with the CLAUDE.md rule "never disable, downgrade, narrow, or defer
a verify check" — it strengthens the gate.

## 6. Workflow note (light)

One line added to the autoloop convention (and a pointer in CLAUDE.md's gotchas):
host-boundary items run `npm run test:smoke` — write a new harness scenario — instead of
marking `needs-human-smoke`. Kept deliberately light; the comprehensive scenario set in §4
is the substance.

## Acceptance criteria

- `test/e2e/harness.mjs` exists and exports the helpers in §1; `paste.e2e.mjs` is migrated
  onto it with **identical behavior** (still passes on Windows).
- `npm run test:smoke` runs all `*.e2e.mjs` sequentially, prints a pass/fail/skip summary,
  exits non-zero on any failure, and exits `0` with `SKIP` on non-`win32`.
- The five new scenarios (T1A, D2, D5, E2, T1B) pass on the author's Windows machine
  against the **real built app**; evidence (per-scenario PASS lines + what was asserted)
  recorded in the run report.
- `scrollback.e2e.mjs` exists and **SKIPs** cleanly today (feature absent), with the
  intended assertion written.
- `node esbuild.mjs` is part of both the `verify` script and `verify.yml`; `npm run
  verify` is **EXIT 0** on the branch.
- No new `package.json` dependency added (Playwright still resolved by path); Fallow
  dead-code / unlisted-dep gates stay green (`test/e2e/*.mjs` already a fallow `entry`).
- The smoke suite is **not** wired into `npm run verify` or `verify.yml`.

## Out of scope

- Building the scrollback-persistence feature itself (separate spec; this only ships its
  smoke, skipped).
- A headless/Linux/CI path for the smoke suite (the GUI + ConPTY dependency is inherent;
  it stays a local/autoloop-machine gate).
- macOS/Linux scenario coverage (Windows-first; the harness should not *hard-code*
  Windows-only assumptions beyond the documented `win32` skip, but cross-platform runs are
  not a deliverable here).
- Heavy autoloop plumbing (auto-selecting which scenario to write per item); §6 is a
  convention note only.

## References

- `test/e2e/paste.e2e.mjs` — the proven real-app pattern this generalizes.
- `test/e2e/README.md` — existing e2e notes.
- Memory: `playwright-electron-real-app-verification` (the launch/bridge/assertion recipe);
  `playwright-cli-webview-verification` (the pure-renderer counterpart, not used here).
- `.autoloop/blockers.md` — the standing gate-gap note (§5) and the E2b smoke recipe (§4).
- Recurring `needs-human-smoke` items: `docs/runs/2026-06-16-daily-driver/report.md` and
  `docs/runs/2026-06-16-daily-driver-2/report.md`.
