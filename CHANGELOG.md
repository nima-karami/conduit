# Changelog

All notable user-facing changes to Conduit. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Internal run artifacts
(build reports, audits, retrospectives) live in `docs/runs/`, not here.

## [Unreleased]

## [0.1.11] — 2026-06-17

### Fixed
- **New Windows PowerShell sessions no longer exit immediately.** The live-cwd hook was
  passed on PowerShell's launch command line, which could kill a freshly spawned session
  during its startup (you'd see "process exited", and only a manual restart worked). The
  hook is now installed after the shell is up, so PowerShell starts reliably — live-cwd
  tracking is unchanged. Other shells (cmd, Git Bash, WSL) were unaffected.

### Changed
- **New Conduit app icon.**

### Fixed
- **Changes list: long file names no longer overlap the line-change counts.** A long
  path now truncates with an ellipsis (the folder prefix shortens first, keeping the
  file name readable), and the `+`/`-` counts sit flush to the right — with the row's
  Stage/Discard actions sliding in over that spot on hover.

## [0.1.9] — 2026-06-17

### Added
- **Drag files & folders from your OS into the Files explorer.** Drag from Windows Explorer
  (or Finder) onto the file tree to copy them into the project — drop on a folder to land
  them there, or on empty space to add them at the project root. Name clashes get a
  "(n)" suffix instead of overwriting; your originals are never moved.
- **Drag files & folders from your OS into a terminal** to insert their paths at the prompt
  (multiple at once), the same way dragging from the Files explorer already worked.
- **Live change monitoring.** Conduit now watches the active project's working tree and
  refreshes the Changes list, git decorations, and the file tree **the moment something
  changes on disk** — an agent edit, a terminal command, an external tool — instead of only
  when you refocus the window. The watch is debounced and skips noise (`node_modules`,
  `.git` internals, build output) so it stays light even on big repos.

## [0.1.8] — 2026-06-17

### Added
- **Drag a file from the Files explorer onto a terminal to insert its path.** Drop a file
  (or folder) on a terminal and its path is pasted at the prompt — normalized to your OS's
  separators and quoted if it contains spaces — so you can reference it in a command without
  typing it out.

### Changed
- **Scrollbars now appear only when you're hovering that section** instead of showing in
  every panel at once, so an inactive list isn't cluttered by a scrollbar you're not using.
- **The editor tab strip's horizontal scrollbar is slimmer and cleaner** — no constant track
  rail; a thin rounded thumb fades in only while you're over the tabs.

## [0.1.7] — 2026-06-17

### Changed
- **The "update ready" card is now pinned just above Settings** at the bottom of the
  sidebar, instead of scrolling at the end of the sessions list — so it's always in view
  when an update is staged.

## [0.1.6] — 2026-06-17

### Fixed
- **Rendered Markdown selection & copy cleaned up.** The faint "#" shown next to a heading
  on hover is no longer pulled into a text selection or copy. Selecting the whole document
  with **Ctrl+A** now selects only the Markdown content (not the entire app), and the
  right-click **Copy** now puts the formatted (rich) content on the clipboard — matching a
  manual selection + Ctrl+C — so pasting into another Markdown-aware editor keeps the
  formatting instead of dropping to raw text.

## [0.1.5] — 2026-06-17

### Fixed
- **"Session finished" notifications no longer repeat.** A session that keeps emitting a
  little output after finishing (a redrawing prompt or TUI) used to re-fire the desktop
  notification and taskbar flash over and over. Conduit now alerts you once and stays quiet
  until you open that session — a later finish alerts again.
- **The file explorer keeps its place when you switch sessions.** Expanded folders are
  remembered per project, so switching to another session and back no longer collapses the
  tree to the top.
- **Opening a file reveals it in the explorer.** However you open a file — the tree, search,
  the command palette, go-to-definition, or a terminal link — the Files panel now expands to
  it and highlights the row.

## [0.1.4] — 2026-06-17

### Added
- **Terminal scrollback survives a restart.** Each terminal session's recent output is
  persisted (a bounded 256 KiB window per session); when you reopen or relaunch the session
  after restarting Conduit, its prior history is restored into the terminal (marked with a
  dim `— restored —` line) instead of starting blank. On by default; toggle with the new
  "Persist terminal scrollback" setting.
- **"Open in Conduit" in the Explorer right-click menu:** right-click a folder (or the
  empty space inside one) and choose "Open in Conduit" to start a session rooted there —
  it opens in your running Conduit, or launches the app if it's closed.

### Changed
- **Installs and updates are now silent:** Conduit ships as a one-click installer, and
  applying an update no longer shows the installer wizard — pressing "Relaunch to update"
  simply updates and reopens the app.

## [0.1.1] — 2026-06-16

### Changed
- The "Check for updates" control in Settings → About is now a compact "Check now" button
  with an **inline status** — a green "Up to date" confirmation when current, live download
  progress, and a "Relaunch" action when an update is staged — instead of a transient toast.

## [0.1.0] — 2026-06-16

### Added
- **Automatic updates:** the app checks for updates on launch (and every 4 hours),
  downloads silently, and shows a card in the sidebar when a new version is ready.
  Click "Relaunch to update" to apply. A "Check for updates" button in Settings
  triggers a manual check. Updates are published via GitHub Releases.
- **Open files now refresh from disk:** if a file open in an editor or Markdown tab is
  changed on disk (by an agent, an external editor, or a terminal command), the tab updates
  to the new content. The active tab is also re-read whenever you switch to it or refocus
  the window. Your unsaved edits are never overwritten — a dirty buffer is left untouched.
- **Undo/redo for file operations:** create, rename, move, and copy in the Files explorer
  can now be undone and redone with Ctrl+Z / Ctrl+Shift+Z. Undo of a create or copy sends the
  file to the OS recycle bin (recoverable). The shortcut defers to the editor's own text
  undo while you're typing in a file, so it never hijacks editing.
- **Editor breadcrumbs (VS Code/Cursor-style):** a bar below the editor tabs showing the
  open file as clickable segments — directory path segments and in-file symbols. Each path
  segment opens a dropdown of its siblings (pick one to open it); each symbol segment lists
  the symbols at its level and jumps the editor to the one you choose, and the symbol chain
  follows your cursor.
- **The Files and Changes views now follow your terminal's working directory:** when a
  session reports a new directory (e.g. you `cd` in a PowerShell or bash session), the file
  tree, the Changes view, and the new directory row re-root to it live. The session still
  groups in the sidebar under the folder it was launched in. Toggle with the new "Track
  terminal working directory" setting (on by default).
- The Files tab now shows the session's current directory as a distinct row in the toolbar
  (its name, with the full path on hover).
- **Custom session icons:** right-click a session → "Set icon…" to choose from the full
  Lucide icon set in a searchable, categorized, virtualized picker (synonym search — e.g.
  "delete" finds the trash icon). Reset to the auto-derived icon any time.
- **Session status now shows on the icon** instead of a separate dot: a not-running session
  is dimmed, an actively-working one pulses, and one needing attention is accented.
- **OS notifications when a backgrounded session finishes:** taskbar flash + a system
  notification (clicking it focuses Conduit and the session). On by default; toggle in
  Settings.
- **Relaunch stale sessions after a restart:** a "Relaunch all stale sessions" command, an
  opt-in "relaunch on startup" setting, and a "— session relaunched —" marker.
- **Drag-and-drop in the Files tree:** drag a file/folder onto a folder to move it; hold
  Ctrl to copy. Path-guarded so operations can't escape the project root.
- The Changes tab now shows a count badge (accented when another tab is active) when a
  session has uncommitted changes.
- Searched files now open in (and switch to) the session they belong to, and the recent-files
  list is per-session.
- Find-in-files now matches file and folder **names**, not just contents: a name hit
  surfaces the file (even binary/oversize ones), highlights the matched name, and
  shows a "name" badge.
- Documentation layout and lifecycle convention (`docs/specs` + `archive/`, dated
  names, `INDEX.md`, per-run `docs/runs/`, this changelog). See ADR 0003.

### Fixed
- Session card layout: the icon now sits at the top-left, aligned with the name row (was
  vertically centered against the whole card), and is slightly larger.
- The editor breadcrumb bar now shares the editor/terminal background with a subtle divider,
  instead of reading as a separate band.
- A scrollable breadcrumb (or context-menu) dropdown can now be scrolled with both the
  mouse wheel and by dragging its scrollbar; it no longer dismisses itself the instant you
  try, and the scroll no longer "escapes" to the editor behind it.
- The Files view's directory/repo name is no longer smaller than the file and folder rows.
- The icon-picker search field now shows the same focus highlight as every other search box
  (the whole box, with the search icon inside the highlighted area) — and no longer draws a
  second, nested ring on the inner input.
- The Files view now has a single "Collapse all folders" action (the old expand toggle only
  expanded already-loaded folders).
- "Reveal in Explorer" on a session now opens the folder itself, not its parent.
- A long project path no longer overflows the session card.
- The close "✕" is hidden while renaming a session, so it can't be mistaken for cancel.
- Clicking a search hit in a Markdown file now scrolls to and highlights the match in the
  **rendered** view, not only in the editor.
- A session no longer gets renamed to a running command (e.g. "npm run security")
  when a tool sets the terminal title; genuine app titles and `/rename` still win.
- Editor tabs are scoped to their session — you no longer see another session's open
  editors, and switching sessions restores that session's own view.
- The terminal view stays pinned to the bottom on a large write (e.g. a big Claude
  Code edit) instead of stranding you mid-scroll, while leaving a scrolled-up user
  alone.

## 2026-06-11 — Round 3 ("mastermind" run, in progress)

### Fixed
- Sidebar-collapse flash and other optimistic-toggle reverts (settings echo no
  longer clobbers pending local changes).
- Unreliable save: global Ctrl/Cmd+S routed to the active document; visible save
  affordance; failures now surface as toasts; files served via go-to-def/recents
  are writable.
- Markdown rendered view now reflects saved content after a source edit; re-opening
  a file re-reads from disk.
- Diff side-by-side/inline toggle is honoured at narrow widths (no silent override).
- Three-dot menu triggers close on second click instead of reopening.
- Panel drag-dock works in both directions.
- A batch of renderer and host-side defects (palette scroll, shortcuts-while-typing,
  lost board edits, pty kill-race, settings validation, and more).

### Added
- Working Changes panel actions (stage/unstage/discard, per-file and bulk).
- Explorer create/rename/delete (path-guarded, trash delete, inline rename).
- Terminal find, clear, and right-click copy/paste menu.
- Editor depth: dirty-close confirm, Save All, Revert File.
- Markdown: clickable links (relative files open in-app, external in browser,
  anchors scroll), copy-code buttons, heading anchors.
- VS Code-style tab overflow: wheel scroll, open-editors dropdown, close left/right.
- Bulk git actions folded into a compact kebab menu (agent-first direction).
- App icon/logo wired as the window icon and into empty states.

## 2026-06-11 — Rounds 1 & 2

Large autonomous feature build across the editor, terminal, board, and canvas
surfaces. See `docs/runs/2026-06-11-round1/report.md` and
`docs/runs/2026-06-11-round2/report.md`.

## 2026-06-10 — v2 feature set

Tabs, background blur/opacity, cross-file go-to-definition, movable center pane,
sessions sort/filter, and the architecture canvas. See
`docs/runs/2026-06-10-v2-features/retro.md`.

## 2026-06-09

Standalone Electron app pivot; file browser + Monaco code viewer; embedded
agent terminals. See `docs/runs/`.
