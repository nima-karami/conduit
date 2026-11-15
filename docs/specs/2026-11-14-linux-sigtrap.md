---
status: diagnosis
date: 2026-11-14
card: CON-13
---

# Linux SIGTRAP: two different crashes behind one symptom

Diagnosis only, nothing built. (LITE) Every causal claim below comes from a measurement listed in
§Evidence. Anything I only inferred is marked ASSUMED. Electron 43.8.3 (Chrome 150.0.7871.250).
The installed `/opt/Conduit/conduit` and every `node_modules/electron/dist/electron` have the same
build-id, `1ea27271f46c4393039387ce16f8a53bc3e93f74`.

## Verdict

| | A: installed app | B: headless e2e |
|---|---|---|
| Fatal check | `LOG(FATAL) "GPU process isn't usable. Goodbye."` in `content::IntentionallyCrashBrowserForUnusableGpuProcess` (`gpu_data_manager_impl_private.cc:416`) | `CHECK(gtk_ui)` in `GetGtkUiPlatform()`, reached from `GtkMessageBox::GtkMessageBox` (`shell/browser/ui/message_box_gtk.cc:51`) |
| Trigger | The desktop session ends (logout or shutdown). systemd stops the app's scope, which SIGTERMs every process in it at once. The zygote and the GPU and network children die. The browser tries to relaunch the GPU process 6 times, each launch fails (`error_code=1002`), and it runs out of fallback modes. | Conduit main throws an uncaught `Error: write EPIPE` from `child.stdin.end()` in `runGitBin` (`src/git-exec.ts:112`) for `git check-ignore -z --stdin`. git exits early (code 128 outside a repo) before reading stdin. Electron's default handler then calls `dialog.showErrorBox`, and under `--ozone-platform=headless` there is no GTK UI, so the CHECK fires. |
| Is load the cause? | No. All 3 crashes happened at session end. | Load only widens the race. 4 of 4 loaded runs trapped, 1 of 2 in a later loaded run. |
| Conduit's fault? | No. A bare Electron app crashes the same way. | Yes, the missing stdin `'error'` listener. Electron's behaviour (CHECK instead of a stderr fallback) is secondary. |
| Confidence | High: reproduced with a bare app, same offset `911e9c1`. | High: reproduced, JS stack captured, and the trap goes away when the stdin error is handled. |

The ticket's "SIGTRAP while heavy work ran in parallel" story merged A and B. The 0.61.0 crash
(Nov 12 17:32) is A, during a system shutdown. The e2e traps are B.

## Evidence (commands, output excerpts)

1. **Apport file**: `/var/crash/_opt_Conduit_conduit.1000.crash`. `ProblemType: Crash`,
   `Package: conduit 0.63.0`, `Date: Fri Nov 13 19:41:33`, `Signal: 5 SIGTRAP`,
   `ProcCmdline: /opt/Conduit/conduit` (the browser process, not a child). It was rewritten after
   the 0.61.0 crash, so the 0.61.0 core is gone. `apport-unpack` produced the core. The build-id in
   the core matches the installed binary.
2. **Symbolized stack** (gdb crashed loading the 546 MB DWARF file, so I resolved the core frames
   with `addr2line -f -C -i` against `electron.debug` from `electron-v43.8.3-linux-x64-debug.zip`):
   `#0 logging::LogMessage::HandleFatal` → `#1 LogMessage::Flush` → `#2 LogMessageFatal::~LogMessageFatal`
   → `#3 content::(anon)::IntentionallyCrashBrowserForUnusableGpuProcess()`. The Chromium source at
   150.0.7871.250 shows `FallBackToNextGpuMode()` calls this when `fallback_modes_` is empty.
3. **Kernel**: `journalctl -k` shows 10 `trap int3` lines. The kernel prints the file offset, and
   vaddr = offset + 0x1000 (checked against the core).
   - Installed app: offset `911e9c1`, which `addr2line` resolves to `HandleFatal`. Nov 13 19:41:32 and 19:45:07.
   - Dev electron in e2e: offset `62317b9`, which resolves to `GtkMessageBox::GtkMessageBox`. 8 runs on Nov 12, 17:51–19:25.
4. **A happens at session end**: the user journal around each A crash shows
   `Stopping app-gnome-conduit-<pid>.scope`, children `gone … reason: killed, exitCode: 15`, then
   `GPU process launch failed: error_code=1002` ×6, then `FATAL:…gpu_data_manager_impl_private.cc:416`.
   It is preceded by `Stopped gnome-session-manager@ubuntu.service`. The Nov 12 17:32:37 crash
   matches too: that boot ended at 17:32:44 (`journalctl --list-boots`). In all 3 cases
   `~/.config/conduit/logs` has no `app quit` line, so **`before-quit` (and its `flushStateSync`)
   never ran**.
5. **A minimal repro**: `main.js` =
   `app.whenReady().then(()=>new BrowserWindow({show:false}).loadURL('data:text/html,ok'))`, run under
   `systemd-run --user --scope --unit=X … --ozone-platform=headless`, then `systemctl --user stop X.scope`.
   - Plain: 3/3 FATAL, same offset `911e9c1`, no `before-quit`.
   - With a JS `process.on('SIGTERM')` handler: 3/3 FATAL, and the handler never ran.
   - With `--in-process-gpu`: 0/3 FATAL, but 3/3 browser processes were **still alive 10 s later**
     (a hang; I killed them by PID). In an earlier run one stayed alive for more than 5 min.
6. **B reproduced**: `npm run e2e -- conduit-mcp-notify --repeat 4` (one of the Nov 12 crashers,
   18:11:41) with 16 busy loops on 12 cores, headless. Result: 4/4 FAIL, 4 traps at `62317b9`.
   The JS stack came from a `--require` hook injected through `ELECTRON_OVERRIDE_DIST_PATH` (a
   wrapper script; Playwright drops `NODE_OPTIONS`), which logs `uncaughtExceptionMonitor` and
   wraps `dialog.*` without changing either:
   `Error: write EPIPE … at Socket.end (node:net) at out/main.js:27299:42`. The source map resolves
   that to `src/git-exec.ts:112`. The next call is `dialog.showErrorBox("A JavaScript error
   occurred in the main process", …)` from `electron/js2c/browser_init`.
7. **B, the workaround proven**: the same scenario and load, with the hook adding a
   `child.stdin.on('error')` listener: 4/4 PASS, 0 traps. The listener logged
   `stdin EPIPE file=git args=["check-ignore","-z","--stdin"] after=1ms` and `after=12ms`,
   with `killed=false`, so the cause is not the execFile timeout. `printf 'a\0' | git check-ignore
   -z --stdin` in a non-repo directory exits 128 at once without reading stdin.
8. **B minimal repro, Electron side**: `app.whenReady().then(()=>dialog.showErrorBox('t','c'))`,
   run with `--ozone-platform=headless`, exits 133 (SIGTRAP) at offset `62317b9`. No CHECK text is
   printed (official builds strip it).

## Options

**A (session-end crash). The real fix is upstream.**
- A1 Report to Electron/Chromium with repro 5 (one file, `systemd-run --scope` plus `stop`). Ask
  that the browser not FATAL on GPU relaunch failure while it is being terminated (or when the
  zygote is gone). Cost: none to us. Benefit: fixes every Electron app. Timeline: not ours.
- A2 `--in-process-gpu`. Measured: it trades the crash for a hang at logout, and it changes GPU
  isolation that CLAUDE.md depends on (GPU switches, atlas restarts). **Reject.**
- A3 A JS SIGTERM handler. Measured: it never runs before the FATAL. **Reject.**
- A4 Live with it, but cap the damage. The real costs are (i) the final `flushStateSync` is skipped,
  so state since the last periodic write is lost (ASSUMED: I did not check how often state is
  persisted outside quit), and (ii) Apport shows a "Conduit crashed" prompt after the next login
  (ASSUMED from Ubuntu defaults; not observed). A possible mitigation is to persist state on
  change instead of relying on quit (ASSUMED feasible; that is a design question, not measured here).

**B (e2e trap, and a latent user-facing error dialog)**
- B1 Handle `'error'` on `child.stdin` in `runGitBin`. EPIPE is expected when git exits early; the
  outcome already comes from the exit code. This fixes the root cause in one place for every stdin
  caller (`git check-ignore`, `git cat-file --batch-check`, `--pathspec-from-file=-`, `git apply`).
  It is measured to remove the trap (§7). **Recommended.**
- B2 Add a Conduit main-process `uncaughtException` handler that logs, and in e2e fails the
  scenario loudly with the stack, so a future stray exception shows up as a stack instead of a
  SIGTRAP. Trade-off: it replaces Electron's dialog for users, so it must log or report and never
  swallow (CLAUDE.md "no swallowed errors"). Complements B1; does not replace it.
- B3 Report to Electron that `dialog.*` CHECKs under headless ozone instead of falling back to
  stderr (repro 8). Low priority: it only affects headless use.

## What remains unknown

- Which directory the failing `check-ignore` ran in. Not logged. ASSUMED: a non-repo dir listed by
  the Explorer, given the exit-128 timing.
- Whether installed GUI users hit B. ASSUMED yes, rarely: the same EPIPE in a GUI session should
  show Electron's "A JavaScript error occurred in the main process" box instead of crashing. Not
  reproduced in a GUI (owner rule: no visible windows).
- The ticket's other named scenarios (preview-origin, preview-transport, auto-save) were not run.
  The leftover Nov 12 userData dirs that line up with the traps are app-sessions, app-web,
  conduit-mcp-compose, conduit-mcp-notify and 4 unnamed ones. The ticket's "nine" is 8 e2e traps
  plus the 17:32 installed crash.
- How much state A actually loses at logout.

## Decisions Needed

1. **(high) Split CON-13 into two cards**: "B: git stdin EPIPE crashes main" (a Conduit bug, small)
   and "A: session-end GPU FATAL" (upstream). Default/recommendation: split. B is a Conduit fix
   that can ship on its own; A is a report-and-wait.
2. **(normal) Done criteria for B**: B1 plus a unit test that feeds stdin to a binary that exits
   before reading, plus the loaded headless run of conduit-mcp-notify ×4 showing no trap.
   Recommendation: also B2, so the next stray exception fails with a stack.
3. **(normal) A**: file the upstream report with repro 5 (recommended), and decide separately
   whether logout-time state loss deserves its own card (persist on change). Default: report only,
   no Conduit change.
