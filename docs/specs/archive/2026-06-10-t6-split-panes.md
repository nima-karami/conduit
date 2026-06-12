# T6 — Split panes (multiple terminals at once)

## Problem
"tabs/panes" was requested but only one terminal is visible at a time. Allow
viewing two sessions' terminals side by side.

## Key constraint
Each running session's terminal (xterm + PTY) is mounted exactly once in the
center's `.termstack` (display-toggled by active id). Mounting a second xterm for
the same session would double-start/มirror the PTY. So split must reuse the single
mounted instances — just make two of them visible side by side, not remount.

## Design
- App state `splitId: string | null` — a second running session shown beside the
  active one (must differ from active; auto-cleared if it stops or equals active).
- `.termstack` becomes a flex row. A `termhost` is visible when its id is the active
  **or** the split id; visible hosts get `flex: 1` → side by side. Others stay
  `display:none` (mounted, preserving scrollback). Terminals refit via ResizeObserver.
- The split host shows a small header (session name + ✕ to unsplit).
- Triggers: session-card context-menu "Open in split"; palette command
  "Split with: <session>"; close via the ✕ or palette "Close split".
- When a document tab is active, the terminal area (and split) is hidden as today.

## Acceptance criteria
1. "Open in split" on a second running session shows two terminals side by side.
2. Both terminals are live (own PTYs), refit to their half-width, keep scrollback.
3. ✕ on the split pane returns to single; splitting the active session is disallowed.
4. Split auto-clears if the split session is closed.
5. typecheck + build + tests green.
