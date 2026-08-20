---
status: shipped
date: 2026-08-20
tier: LITE
type: host
---

# Renderer crash recovery

## Why

Conduit registered no `render-process-gone` handler. When a renderer died — the real incident
was an unbounded diff allocation OOM'ing it — the window stayed black forever. Nothing else was
broken: the main process still held every session, and every PTY child was still running. The
only escape a user had was quitting the whole app and relaunching, which killed all of it.

The recovery is a `webContents.reload()`. The renderer holds no source of truth, so a reloaded
one boots exactly like a fresh app start: it posts `ready`, gets `state`, auto-selects a
session, mounts the pane, and sends `term:start`. That hits the ATTACH path (`pty.isAlive`) and
replays the in-memory ring — the same flow a session move between windows already uses. Session
ownership is keyed by `BrowserWindow.id`, which a renderer crash does not change, so
`sendToOwner` keeps resolving. No new mechanism was needed.

## Contract

`decideCrashRecovery(reason, priorReloads, now)` (`src/crash-recovery.ts`) is the whole policy.

| Reason | Action |
|--------|--------|
| `clean-exit`, `killed` | `ignore` — ordinary teardown. Reloading here would fight the quit path. |
| `crashed`, `oom`, `abnormal-exit`, `launch-failed`, `integrity-failure`, **anything unknown** | `reload`, while inside the budget |
| any of the above, past the budget | `give-up` |

- **Budget: at most `MAX_RELOADS` (3) reloads per window inside a `RELOAD_WINDOW_MS` (5 min)
  sliding window.** A renderer that crashes on every boot must not become a reload storm; past
  the bound the window is left as it is and the log says why.
- An unrecognised reason reloads. A black window is the worst outcome available, so a future
  Electron reason must not fall through to "do nothing".
- The returned `reloads` is `priorReloads` pruned to the window, plus `now` on the `reload`
  path. Pruning happens on the give-up path too, so the history cannot grow without bound and
  the budget recovers once a burst ages out. `ignore` spends nothing and prunes nothing.

## Wiring

`createWindow` in `electron/main.ts` is the single window factory (multi-window included), so
the handler is registered there once and every window gets it. Reload history is a module-level
`WeakMap<BrowserWindow, number[]>` — per window, collected with the window. The event is logged
at **error** through the existing file-backed logger (`electron/logger.ts`, userData/logs) with
`reason`, `exitCode`, the chosen action and the reload count. `reload()` is guarded on
`isDestroyed()` for both the window and its webContents.

The logger is built inside the app-ready closure (it needs restored settings), so the
module-level factory reaches it through `hostLog`, the same "set by the app-ready closure"
pattern `schedulePersistLayout` already uses.

## Tests

- `test/unit/crash-recovery.test.ts` — every reason, the window pruning (including both sides of
  the exactly-`RELOAD_WINDOW_MS` edge), the give-up boundary, budget recovery after the burst
  ages out, and non-mutation of the caller's array.
- `test/e2e/renderer-crash-recover.e2e.mjs` — the runtime proof. Types a marker into a live
  shell, calls `webContents.forcefullyCrashRenderer()` from the main process, then asserts the
  renderer OS process id changed, the window reloaded, the pane re-attached with no interaction,
  the pre-crash marker is back on screen (ring replay), and a newly typed `echo` round-trips
  through the same surviving shell. Verified to fail against the pre-fix build ("Window never
  recovered after the renderer crash — it is still black").

  Two gotchas that shaped it, both documented in the scenario:
  - A crashed target leaves the Playwright `Page` permanently dead ("Target crashed") and the
    reload reuses the same target, so Playwright never hands out a fresh handle. Everything
    after the crash is driven through the main process via `webContents.executeJavaScript`.
  - `webContents.executeJavaScript` suspends until the page stops loading, so it cannot install
    the opt-in `window.__terms` hook before React constructs the Terminal. CDP's
    `Page.addScriptToEvaluateOnNewDocument` (via `webContents.debugger`, which attaches fine
    alongside Playwright) is the only document-start hook that survives the crash.
