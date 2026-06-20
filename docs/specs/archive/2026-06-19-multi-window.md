---
status: implemented
date: 2026-06-19
tier: FULL
type: UI
---

> **Shipped (all slices):** Slice A (multi-window foundation, `ff0ceb5`) + Slice B
> (move a live session across windows, no PTY restart, `0ff8018`) + Slice C
> (cross-window pointer drag + tear-out-to-desktop, `1605dc1`; multi-window layout
> persistence across restart, `70e09cf`) — on `git-run` 2026-06-19/20. The literal
> cross-window HTML5 pointer gesture's *feel* is the one human-smoke item (the
> `session:dragEnd` message + host hit-test/move/tear-out path are verified).

# Multi-window + cross-window session drag-and-drop

## Problem frame

**Job:** "When I'm working across more than one project (or want two terminals
side by side on one screen), let me have **multiple Conduit windows** open at once —
and freely **move a running session from one window to another**."

Today Conduit is single-instance, single-window by deliberate design: a
`requestSingleInstanceLock` (`electron/main.ts`) makes every relaunch — including
"Open in Conduit" from another folder — route its target into the **one** existing
window (`second-instance` handler) and focus it. The entire engine
(`SessionManager` + `PtyHost` + IPC handlers + `send`/`postState`) is a single-window
closure that targets one global `win`.

**Actors:** the desktop user (single human, local machine). No multi-user concern.

**Success outcomes:**
- The user can open ≥2 Conduit windows and place them side by side.
- Each window is an independent view (its own tabs, active session, docs, explorer).
- A **live** session can be moved between windows **without the shell restarting**
  (PTY, scrollback, cwd, busy state all intact).
- The existing "Open in Conduit" routing keeps working (routes into the focused
  window).

**Non-goals (this feature):**
- True separate OS processes per window (rejected: would make cross-window session
  move impossible — you can't hand a live PTY between processes).
- Persisting the multi-window **layout** across restart (which session in which
  window, window geometry) — deferred; v1 restores all sessions into one window.
- Multi-monitor-aware placement, window snapping, per-window themes/settings.
- macOS-specific window behaviors beyond what already exists (primary target is
  Windows; keep cross-platform code paths working but don't add mac polish).

## Architecture decision (locked with the user)

- **One engine, many windows.** The main process keeps owning all shells/sessions;
  each `BrowserWindow` is a view onto the subset of sessions it owns. Moving a
  session between windows reassigns its owner window — the PTY never moves.
- **Reuse-current launch routing + explicit New Window.** "Open in Conduit" /
  relaunch keeps routing into the focused window. A **New Window** command + shortcut
  and a **Move to new window** (tear-off) action create additional windows.
- **Close a window → end its sessions.** Closing a window ends the sessions it owns
  (guarded by the existing running-session confirm). Closing the **last** window
  quits the app.
- **Restore into one window (v1).** On launch, every restored (stale) session comes
  back in a single primary window.

## Behavior & states

### Window lifecycle
- **Primary window:** created on app launch (as today). Owns all restored sessions.
- **New window:** empty (no sessions); shows the empty-state CTA. Created via command
  palette "New Window", shortcut **Ctrl/Cmd+Shift+N**, or as the destination of a
  "Move to new window" tear-off.
- **Focus:** the OS-focused Conduit window is the **active window** for routing
  launch targets ("Open in Conduit", new sessions from a global action).
- **Close:** intercepted by the quit-guard. If the window owns running sessions, the
  existing confirm dialog runs (scoped to **that window's** sessions). On confirm,
  those sessions are disposed (PTYs killed, removed from the manager, scrollback files
  cleaned per existing teardown). If it is the **last** open window, the app quits
  after the guard; otherwise only that window closes.

### Session ↔ window ownership
- Every session has exactly **one** owner window at runtime (`windowId`).
- New sessions (openRepo / new-session / duplicate) are owned by the window that
  initiated them (resolved from the `to-host` message's `e.sender`).
- On restore, all sessions are owned by the primary window.
- A session is rendered/streamed **only** to its owner window. Other windows never
  see it in their `state` or receive its `term:data`.

### Moving a session (Slice B)
- **Move to new window:** spawns a fresh window and reassigns the session to it.
  The originating window drops it; the new window shows it as the active tab,
  scrollback intact, shell still running.
- **Move to window N / drag across windows:** reassign the session to an existing
  target window. The session disappears from the source tab strip and appears in the
  target's, selected. No `term:start`, no remount that would kill the PTY (the
  owner-window change must NOT change the session's React `key`/sessionId — see
  [[conduit-powershell-crash-root-cause]] for why a remount kills the ConPTY child).
- If a moved session was the source window's only session, the source window shows
  the empty state (it does **not** auto-close).

### Transitions summary
```
launch ──► primary window (owns restored sessions)
"New Window" / Ctrl+Shift+N ──► empty window
session create (in window W) ──► session owned by W
"Move to new window" ──► new window owns session; source drops it
"Move to window N" / drag-drop ──► window N owns session; source drops it
close window (no running sessions) ──► window closes; sessions (none) gone
close window (running sessions) ──► confirm ─► dispose its sessions ─► close
close LAST window ──► (guard) ─► quit app
```

## Data / interface contract

### Host → renderer (`HostToWebview`)
- `state` becomes **per-window**: the host filters `sessions` to those owned by the
  receiving window before sending. Shared fields (settings, agents, repos) are sent
  to every window unchanged.
- `term:data` / `term:exit` route only to the owner window's webContents.
- New: `win:id` (or fold into `state`) so the renderer knows its own window id (used
  to tag drag payloads and "move to other window" targets).
- New: `win:list` — the set of open windows `{ id, title, sessionCount }` for the
  "Move to window…" picker and to show drop targets. Broadcast on window
  open/close/focus change.

### Renderer → host (`WebviewToHost`)
- All existing messages now implicitly carry the sender window via `e.sender`
  (no payload change); the host resolves the owner window from it.
- New: `win:new` — create a new empty window.
- New: `session:move` — `{ sessionId, target: { kind: 'new' } | { kind: 'window', windowId } }`.
- Window controls (`win:minimize` / `win:toggleMaximize` / `win:close`) must target
  **`BrowserWindow.fromWebContents(e.sender)`**, not the global `win`.

### Invariants
- A `sessionId` is owned by exactly one window at all times.
- The engine (manager/pty/activity/git/scrollback) is process-global and unaffected by
  which window renders a session.
- `send(msg)` must never broadcast a session-scoped message to non-owner windows
  (prevents cross-talk: another window writing a foreign session's term:data).

## Edge cases & failure modes

- **Last window close with running sessions:** guard runs once for that window; on
  confirm, dispose + quit.
- **Move a session to a window that is closing / just closed:** reject the move
  (no-op) and keep it in the source window; surface a toast.
- **Move the active/last session out of a window:** source window falls to empty
  state; remains open.
- **Two windows race to own a new session** (e.g. simultaneous openRepo): each
  openRepo is keyed to its own `e.sender`; no shared mutable selection — safe.
- **Window-scoped `to-host` after its window is gone** (message in flight during
  close): `BrowserWindow.fromWebContents` returns null → ignore.
- **Cross-window DnD is not native in Electron** (HTML5 drag events don't cross
  `BrowserWindow` boundaries). Mitigation/scope: Slice B ships the reliable
  **menu/command** moves ("Move to new window", "Move to window…"); true
  pointer-drag-across-window-bounds (hit-test the pointer over another window on
  drag-end in main) is **Slice C / vision**. This is the one real technical risk and
  is sliced accordingly.
- **CONDUIT_E2E hidden launch:** new windows must honor `show:false` under E2E so the
  smoke suite stays headless.
- **`second-instance` while multiple windows open:** route the target into the
  **focused** Conduit window (fall back to the most-recently-focused if none focused).

## Defaults vs. settings

- **New-window shortcut = Ctrl/Cmd+Shift+N** (industry standard). No setting.
- **Launch routing = reuse focused window** (locked). No setting.
- **Close-window = end its sessions** (locked). No setting; the existing
  running-session confirm is the only gate.
- **Restore = all into one window** (locked, v1). A future setting could offer
  "restore multi-window layout" once that's built — not now.
- No new persisted user settings introduced by v1.

## Scope slicing

**MVP — Slice A (multi-window foundation):**
- Hoist the engine out of the single-window closure into a process-global owned by a
  window registry; `send`/`postState` become window-aware.
- Window registry: `windowId → { window, ownedSessionIds }`; session `windowId`.
- New Window command + Ctrl/Cmd+Shift+N + (optional) a top-bar "＋ window" control.
- Per-window `state` filtering + per-window `term:data` routing.
- Window controls target `e.sender`'s window. Quit-guard scoped per window; last
  window quits.
- New sessions open in the originating window. Restore → primary window.
- *Verifiable:* open a 2nd window, start a session in each, confirm isolation
  (each window sees only its own), close one window (others survive), close last
  (quits).

**v1 — Slice B (move sessions across windows):**
- `session:move` host handler (reassign ownership, re-`postState` both windows, no
  PTY restart, no sessionId/key change).
- Tab/session context-menu + command: **Move to new window**, **Move to window…**
  (picker from `win:list`).
- Drag a session tab and drop it onto another **already-open** window's tab strip
  (best-effort within Electron's constraints; menu actions are the guaranteed path).
- *Verifiable:* move a live session A→B; assert the shell kept running (scrollback
  + a pre-move sentinel still present in the rendered buffer in window B).

**Slice C / vision (later):**
- True pointer drag across OS window bounds (main-process pointer hit-test on
  drag-end) and tear-out-to-desktop to spawn a window at the drop point.
- Persist multi-window layout across restart (geometry + per-window session set).
- Per-window project/cwd context surfaced in the title bar.

**Out of scope:** separate-process isolation, multi-user, window snapping/tiling.

## Acceptance criteria

### Slice A (declarative + EARS)
- A "New Window" command exists in the palette and a Ctrl/Cmd+Shift+N shortcut; each
  opens an additional, empty Conduit window.
- **WHEN** a session is created from window W, the host **SHALL** mark it owned by W
  and include it only in W's `state`.
- **WHEN** the host emits `term:data` for session S, it **SHALL** send only to the
  webContents of S's owner window.
- **WHEN** the user closes a window that owns no running sessions, the system
  **SHALL** close only that window and leave other windows running.
- **WHEN** the user closes a window owning running sessions, the system **SHALL**
  run the running-session confirm scoped to that window; on confirm, dispose those
  sessions; **IF** it was the last window, **THEN** quit.
- Window min/max/close controls **SHALL** act on the window that hosts the clicking
  renderer, not a global window.

```gherkin
Scenario: Sessions are isolated per window
  Given a primary window with session A
  And I open a New Window and start session B in it
  Then the primary window's tab strip shows only A
  And the new window's tab strip shows only B
  And typing in B never appears in A
```

### Slice B (Gherkin)
```gherkin
Scenario: Move a live session to another window without restarting it
  Given window-1 owns a running session S with output "SENTINEL" in its scrollback
  And window-2 is open
  When I choose "Move to window… → window-2" on session S
  Then S disappears from window-1 and appears selected in window-2
  And S's shell is still the same process (no relaunch banner)
  And window-2's rendered terminal buffer still contains "SENTINEL"
```

## Decisions made under design (reversible; surfaced)

- **D-1 Engine-global refactor over per-window engines.** Required by the locked
  "one engine" model; the bulk of Slice A is mechanical hoisting of the
  `app.whenReady` closure into a shared scope + threading a `windowId`.
- **D-2 Ownership via `e.sender`**, not a renderer-sent window id, so a compromised/
  buggy renderer can't claim another window's sessions. Renderer learns its own id
  from the host (`win:id`) only for display/drag-tagging.
- **D-3 Menu-based moves are the contract; pointer-drag-across-windows is polish.**
  Electron doesn't carry HTML5 DnD across `BrowserWindow`s, so the guaranteed UX is
  "Move to new window / Move to window…"; literal cross-window drag is Slice C. This
  honors the user's "drag and drop" ask while not blocking the feature on an Electron
  limitation.
- **D-4 No multi-window persistence in v1** (locked) — restore collapses to one
  window.

## Self-audit

Template coverage walked: problem frame ✓, behavior/states ✓, data/interface
contract ✓, edge cases ✓, defaults vs settings ✓ (no new settings), scope slicing ✓,
acceptance criteria (declarative + EARS + Gherkin) ✓. UI module: state catalog
(empty window, single/multi session, move-in-flight, close-guard) ✓; interaction
(command, shortcut, context menu, drag) ✓; a11y — New Window reachable by keyboard,
"Move to window…" picker keyboard-navigable, focus moves to the moved session's new
window ✓; i18n — all new strings ("New Window", "Move to new window", "Move to
window…") go through the same literal-string path as existing UI (no i18n framework
in the app today; consistent with codebase) ✓; design tokens — new window chrome
reuses existing top-bar/tab CSS vars ✓. No unaddressed items.
