---
status: active
date: 2026-06-16
---

# Quit / close / update-relaunch guard for running agents

## Problem

Conduit silently kills every running agent on quit, close, or update-relaunch — with
no confirmation. For a daily driver running long agent tasks, one accidental `Ctrl+W`,
window-✕, or a one-click update relaunch can destroy hours of work.

There are three routes that terminate running sessions, only one of which is guarded —
and only for *editor* dirtiness, not running sessions:

| Path | Trigger | Today |
|---|---|---|
| Custom titlebar **✕** | renderer → `win:close` → `win.close()` (`electron/main.ts:933`) | renderer guards dirty *editors* (`webview/close-dirty.ts`), not sessions |
| **OS close** | Alt+F4, taskbar → Close, `window-all-closed` | unguarded — `before-quit` → `pty.disposeAll()` (`electron/main.ts:939`) |
| **Update relaunch** | update card → `updateRelaunch` → `quitAndInstall()` (`electron/main.ts:830`) | unguarded — relaunches immediately; the auto-updater (shipped) introduced this path |

Because OS-close and update-relaunch bypass the renderer's custom chrome, the guard
**cannot live only in the renderer** — the spine must be in the main process.

Good news already in place: unsaved *editor* edits are guarded
(`webview/close-dirty.ts`, `dirty-store.ts`, `confirm-dialog.tsx`). It is the running
*agents* that are unprotected. Spawn failures and process exit are also already
surfaced (`src/pty-host.ts` — red error line + `term:exit`); this spec does not touch
those.

## Decision summary

- **Trigger:** prompt whenever **≥1 session has a live PTY** (`status: 'running'`).
  Safest — never silently kills work. False-positives cost one keypress; false-negatives
  cost agent work. The dialog still calls out how many are *actively busy*.
- **No opt-out toggle** — always-on (user decision).
- **Dialog rendering:** renderer `confirm-dialog.tsx` with a **native fallback**
  (approach A below).

## Architecture

### Pure decision module — `src/quit-guard.ts`

Mirrors `webview/close-dirty.ts` (pure functions, no React, no store imports; orchestration
lives in the caller). Exports:

- `runningSessions(sessions)` → sessions with `status === 'running'` (live PTY).
- `busySessions(sessions)` → running sessions currently flagged busy/working by the
  existing busy machine (consumed as-is; this spec does not change busy detection).
- `needsQuitConfirm(sessions): boolean` → `runningSessions(sessions).length > 0`.
- `quitConfirmCopy({ running, busy, reason })` → `{ title, body, confirmLabel }`, where
  `reason` is `'quit'` or `'update'` (§ Update-relaunch). Pure string assembly.

Unit-tested with vitest (running/busy filters, the boolean, all copy variants).

### Main-process interception (the spine)

Intercept the `BrowserWindow` **`close` event**: `win.on('close', e => …)`. When
`needsQuitConfirm(currentSessions)` is true **and** a `quitConfirmed` flag is not set,
call `e.preventDefault()` and start the confirm flow (below). On a *proceed* result, set
`quitConfirmed = true` and re-issue `win.close()`; on *cancel*, do nothing (window stays
open). The `quitConfirmed` flag prevents an infinite loop and is reset if the window
survives (cancel).

This single seam covers all three paths:
- custom **✕** (`win:close` calls `win.close()`),
- OS close (the same `close` event fires),
- update relaunch (`quitAndInstall()` → app quit → window `close`), though update gets an
  earlier, update-specific confirm in its own handler so the copy can differ (§ below).

`before-quit` stays as the resource disposer (`pty.disposeAll()` etc.) — unchanged.

### Dialog rendering — approach A (renderer confirm + native fallback)

When main needs to confirm:

1. Main sends a `confirmQuit` message (`{ reason, running, busy }`) to the renderer.
2. Renderer shows the existing `confirm-dialog.tsx` (matches the custom chrome; can list
   running session names + busy state) and replies with a `quitDecision`
   (`{ proceed: boolean }`).
3. Main resolves on that reply. **Fallback:** if the renderer does not answer within a
   short timeout (e.g. 1500 ms — wedged/busy renderer, or no window), main falls back to a
   native `dialog.showMessageBox` on the window so the guard still works.

This yields a **single, consistent** confirmation flow and reuses the existing dialog,
while keeping native robustness as a safety net. New protocol messages: `confirmQuit`
(host→webview) and `quitDecision` (webview→host), added to `src/protocol.ts`.

**Double-prompt avoidance:** the editor-dirty confirm (renderer, on the ✕ path) and the
running-sessions confirm address different concerns and are sequenced — dirty-editor check
first (existing), then the session guard. They are not merged. (Extending the dirty-editor
guard to the OS-close path is out of scope.)

## Update-relaunch flow

The `updateRelaunch` IPC handler checks `needsQuitConfirm` **before** calling
`quitAndInstall()`. If sessions are running, it runs the same confirm flow with
`reason: 'update'`, e.g.:

> **Relaunch to install the update?**
> This closes N running agent(s) (M actively working). They'll be restored as stale on
> relaunch.

Proceed → set `quitConfirmed = true` (so the subsequent window `close` event passes through
without a second prompt), then `quitAndInstall()`. Cancel → stay open, the update stays
pending (the user can relaunch later). Copy reflects T1B auto-relaunch / T2 scrollback once
those land, but this spec does not depend on them.

## UX & copy

- **Quit/close** dialog: title **"N session(s) still running"**, body "Quitting will stop
  them (M actively working). Quit anyway?", destructive button **"Quit"**.
- **Update** dialog: as above, destructive button **"Relaunch & update"**.
- The **focused/default** button is the **safe** one (Cancel) so an accidental Enter does
  not quit. Esc = cancel.
- Singular/plural handled in `quitConfirmCopy`. When `busy === 0`, omit the "(M actively
  working)" clause.

## Testing

- **Unit (vitest):** `src/quit-guard.ts` — `runningSessions` / `busySessions` filters,
  `needsQuitConfirm`, and every `quitConfirmCopy` variant (quit vs update; singular/plural;
  busy = 0 vs > 0).
- **Real-app smoke (W1 harness):** a new scenario `quit-guard.e2e.mjs` — open a running
  session; trigger window close; assert it was `preventDefault`'d and `confirmQuit` fired
  (observed via the W1 `spyMain` seam / bridge tap); send a *cancel* `quitDecision` → app
  stays; send *proceed* → app quits. Likewise drive `updateRelaunch` with a running session
  and assert the update-flavored confirm precedes `quitAndInstall`. This scenario is added
  to the W1 smoke spec's scenario set.

## Acceptance criteria

- `src/quit-guard.ts` exists, is pure, and is unit-tested.
- Closing the window (custom ✕ **and** OS close) with ≥1 running session shows a single
  confirmation; cancel keeps the app open with sessions intact; proceed quits.
- `updateRelaunch` with ≥1 running session shows the update-flavored confirm before
  `quitAndInstall()`; cancel leaves the update pending.
- A wedged/unresponsive renderer still gets a native fallback dialog (the guard never
  silently no-ops into a kill).
- With **zero** running sessions, quit/close/relaunch proceed with **no** prompt.
- `npm run verify` EXIT 0; `node esbuild.mjs` green; new protocol messages typed in
  `src/protocol.ts`.

## Out of scope

- Extending the unsaved-*editor* guard to the OS-close path (separate concern).
- Any change to busy/needs-attention detection (consumed as-is).
- A "don't ask again" / opt-out setting (explicitly declined — always-on).
- Building T1B auto-relaunch or T2 scrollback (this only references them in copy).

## References

- `electron/main.ts` — `win:close` (`:933`), `before-quit` (`:939`), `updateRelaunch`
  (`:830`), `window-all-closed` (`:982`).
- `electron/updater.ts` — `quitAndInstall` (`:79`).
- `webview/close-dirty.ts`, `webview/components/confirm-dialog.tsx`,
  `webview/dirty-store.ts` — the existing dirty-confirm pattern this composes with.
- `src/pty-host.ts` — existing spawn-failure / exit surfacing (unchanged).
- W1 smoke harness: `docs/specs/2026-06-16-smoke-harness.md` (hosts the `quit-guard.e2e.mjs`
  scenario).
