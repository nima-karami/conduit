# Changelog

All notable user-facing changes to Conduit. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Internal run artifacts
(build reports, audits, retrospectives) live in `docs/runs/`, not here.

## [Unreleased]

### Added
- **Multi-repo awareness.** Opening a folder that contains several git repositories now shows a
  repo picker (separate from the branch picker) that scopes the branch indicator, history, and
  Changes to one **active repo**. The active repo follows your context — terminal `cd`, the file
  you focus, an explorer click — and a manual pick stays **pinned** until you choose "Auto". The
  Files explorer still browses the whole tree. Single-repo projects are unchanged; toggle it in
  Settings → Workspace → Multi-repo picker.

## [0.9.0] — 2026-06-25

### Added
- **File-type icons in the Explorer**, with a chooser in Appearance → Explorer: **None**,
  **Minimal** (monochrome line icons), or **Colored** (per-language tint).
- **Type `exit` to close a session.** Exiting a plain shell now closes its session
  (warning first if it owns open editor tabs); coding-agent sessions keep their
  "Process exited / Restart" card.

### Changed
- **Git-ignored files and folders are dimmed in the Explorer**, so build/dependency dirs
  (node_modules, dist, …) read as secondary while staying visible.
- **Syntax highlighting now covers ~70 file types** — Go, Rust, Kotlin, Swift,
  Terraform/HCL, Dockerfile, and many more.
- **The breadcrumb shows the full file name when there's room**, and a visible `…` when
  it has to truncate.
- **Closing an idle shell no longer asks for confirmation** — only a running agent or a
  session with open editor tabs prompts.

### Fixed
- **New files inside a new folder now each appear in the change list** (and as file-tree
  status dots), instead of only the containing folder showing up.
- **Review Changes stays responsive with many changed files** — removed redundant diff
  re-fetches and per-update re-rendering of every file card.
- **Terminal path links now resolve abbreviated paths** like `C:/project/.../file.tsx`
  (the elided middle is matched against the project's files).

## [0.8.5] — 2026-06-23

### Fixed
- **Clicking a path link opens it in the session you clicked from.** With two sessions open in
  the same folder (e.g. side-by-side in split view), clicking a file path in one session's
  terminal could open the document in the *other* session's editor. The clicked terminal's
  session is now authoritative, so the file always opens where you clicked.

## [0.8.4] — 2026-06-23

### Changed
- **The file explorer now shows build and dependency folders.** `dist`, `out`, `.next`, and
  `node_modules` are no longer hidden from the Files tree — only VCS/OS metadata (`.git`,
  `.DS_Store`, etc.) stays hidden, matching a standard code editor. Folders are read lazily, so
  large `node_modules` trees don't slow the tree down.

## [0.8.3] — 2026-06-23

### Changed
- **Context menus are consistent everywhere.** Right-click menus across the app (sessions, tabs,
  files/folders, change rows, board cards, canvas nodes) now follow one order — primary action
  first, then edit, then copy/reveal, with the destructive action always last and set apart.
  Labels are normalized to sentence case (e.g. "Close others", "Close to the right").

## [0.8.2] — 2026-06-23

### Fixed
- **Review Changes now scrolls with many files.** With a large change list the file cards were
  squashed into thin, unreadable slivers instead of the view scrolling. Cards now keep their
  full height and the list scrolls.

## [0.8.1] — 2026-06-22

### Fixed
- **History search box is vertically centered again.** The search field in the Git History
  toolbar sat slightly too high; it now centers correctly in its bar.

## [0.8.0] — 2026-06-22

### Changed
- **More terminal paths are clickable.** Paths printed in the terminal now link far more
  broadly: project-relative paths (`src/core/theme/accent.ts`, `webview/app.tsx`) **and** bare
  filenames (`accent.ts`, `README.md`), not just absolute and `./` / `../` paths. A bare
  filename is resolved against the whole project — if it matches one file it opens directly; if
  several files share the name, clicking opens a **dropdown to pick which one**. Only tokens
  that name a real file or folder become links.
- **The History tab's branch/ref filter is now the app's own dropdown.** It used a native OS
  `<select>` popup that clashed with the rest of the chrome; it's now Conduit's themed,
  keyboard-navigable dropdown with the same filtering (pick a ref or "All branches").

### Fixed
- **Deleted folders no longer linger in the recent-folders list.** A recent folder whose
  directory was removed or renamed is now hidden from the New Session list (clicking it would
  just fail). It's filtered at display time only — the entry stays in storage, so a remounted
  drive or a recreated folder reappears on its own.

## [0.7.3] — 2026-06-22

### Changed
- **General settings now match the Appearance tab.** Every setting sits in a titled, bordered
  subsection (Sessions, Workspace, Notifications, Accessibility, Logging, Reset) instead of a
  flat list with a single bordered "Logging" block standing out — so the two tabs look
  consistent.

## [0.7.2] — 2026-06-22

### Fixed
- **History list now fills the view.** The commit ledger only rendered a handful of rows with
  empty space below, because the virtualization measured the scroller's height before it
  existed (during the initial load) and never re-measured — so it stayed at zero. It now
  re-measures when the list mounts and fills the container.
- **History search box is vertically centered.** It used a native `search`-type field (which
  renders the text a hair high); it's now a plain text field like every other search box.
- **Commit detail has a close (×) button.** The detail panel now has an × in its top-right
  corner to dismiss it and return to the full-height history — no need to press Esc.

## [0.7.1] — 2026-06-22

### Changed
- **Commit detail now opens inline in the History view, not as a tab.** The History tab is a
  vertical split: the commit graph + list fills the pane, and **selecting a commit reveals its
  detail (message, author, changed files) in a panel below it** — with a **draggable seam** so
  you choose how much of each to see. The graph is full-height until you pick a commit. Opening
  a changed **file** still opens its diff as a full-width editor tab (preview / double-click to
  pin), so deep file review keeps its room while browsing commits stays in one place.

### Fixed
- **Branch button really has no background now.** The switchable branch name is a button, and a
  missing background reset let the OS's native button fill paint an off-palette pill at rest;
  it's now transparent like the rest of the indicator. (The earlier 0.7.0 fix only addressed a
  lingering focus ring, not this resting fill.)

## [0.7.0] — 2026-06-22

### Changed
- **Commit history opens in real editor tabs.** Reviewing a past change is no longer crammed
  into the History view's side drawer. The History tab is now just the commit graph + list;
  **clicking a commit opens it as its own tab** (full message, author, changed files), and
  **clicking a file opens that commit's diff** as a full-width editor tab — the same diff
  viewer (and side-by-side split) you use everywhere else. Browsing stays tidy: commit and
  diff tabs are **preview** tabs (italic, reused as you click) until you **double-click to
  pin** one for keeping/comparing.

### Fixed
- **Branch button no longer shows an odd background.** The branch name in the git indicator
  now reads as part of the bar — transparent at rest with a small dropdown caret — instead of
  a stray filled pill (a focus ring that lingered after opening the branch menu with the mouse).

## [0.6.0] — 2026-06-20

### Added
- **Multiple windows, and move a live session between them.** Open more than one Conduit
  window (command palette → "New window", or Ctrl/Cmd+Shift+N) and place them side by side —
  each window has its own tabs and sessions. Move a session to another window **without
  restarting the shell** (process, scrollback, and working directory all come along): use the
  session's right-click menu, or **drag its tab onto another window** — or onto the desktop to
  **tear it out into a brand-new window** at the drop point. Your **window layout is remembered**
  across restarts: quit with two windows and they come back as two windows with their sessions.
  Closing a window ends only its own sessions; closing the last one quits.
- **Switch git branches from the indicator.** Click the branch name at the top of a terminal to
  open a branch picker (filter as you type) and switch in place. It runs the checkout out of
  band — never typed into your shell — and **refuses when the terminal is busy or the working
  tree is dirty**, so it can't corrupt a running process or lose changes.
- **Git history — a multi-branch commit graph.** A button at the right of the git branch
  indicator opens a read-only commit graph for the repo: all branches, lanes and merges, and
  ref/HEAD badges. Click any commit to read its full message and changed files, then open a
  file to see that commit's diff in the usual diff viewer. **Search** commits by message,
  author, or SHA and **filter to a branch**; long histories stay smooth (virtualized) and the
  graph refreshes as the repo changes. Read-only — it never changes your branches or tree.
- **Logging you can turn on and hand over.** Settings → Logging lets you enable logging and
  pick a level (off/error/warn/info/debug/trace). Conduit writes rotating log files in its
  data folder (readable even in a packaged build), with secrets redacted, a "Reveal logs"
  button, a one-click **"Copy diagnostics"** bundle (logs + version/OS info) for bug reports,
  and a recent-log tail in Settings → About. On by default at `info`.

### Fixed
- **Session cards follow your shell.** A session card's folder and path now reflect where the
  terminal actually is after you `cd` around, instead of staying pinned to the folder it was
  launched in. (Sidebar grouping still stays by the launch folder.)
- **Manual sidebar reordering sticks.** Dragging a project group (or a card) to reorder it by
  hand no longer snaps back — the new order persists.

## [0.5.1] — 2026-06-19

### Fixed
- **Restored terminal history no longer vanishes on relaunch.** Reopening a session used to
  flash your previous scrollback for a split second and then wipe it as the shell restarted —
  on Windows, ConPTY clears and repaints the screen when it spawns, erasing the just-restored
  history. Conduit now parks the restored history in the scrollback buffer before the shell
  starts, so it survives the spawn: scroll up after a relaunch and your earlier output is
  right there, directly above the fresh prompt.

## [0.5.0] — 2026-06-19

### Added
- **Browse a web page inside Conduit.** Command palette → "Open web page…" opens any
  `http(s)` URL as a tab next to your terminals and editor: address bar, back/forward,
  reload/stop, the live page title on the tab, and a clear in-tab message when a page can't
  load. The "open in system browser" button hands the current page off to your default
  browser. Web tabs stay loaded when you switch away and back. Each page runs as an isolated,
  sandboxed guest — Conduit never injects itself into the sites you open.
- **"Open externally" / "Open with…" in the Explorer.** Right-click a file in the Files
  panel → "Open externally" opens it in its default app, or "Open with…" brings up the OS
  application chooser (Windows) so you can pick which app handles it.

## [0.4.0] — 2026-06-19

### Added
- **View PDFs inside Conduit.** Opening a `.pdf` now renders it in a built-in viewer instead
  of falling through to a "binary file" notice: continuous scrolling through every page,
  zoom (±, fit-width, fit-page), selectable/copyable text, in-document find with next/prev
  highlighting, and a collapsible sidebar with the document outline and page thumbnails.
  Keyboard: PageUp/Down, Home/End, Ctrl+F to find, Ctrl +/- to zoom, Esc to close find.
  Password-protected PDFs show an "unsupported" notice; very large files (over 50 MB) and
  corrupt files show a clear message rather than failing silently.
- **Open files in Conduit from the OS.** Right-click any file in Explorer → "Open with
  Conduit" opens it in Conduit's editor, rooted at the file's git repo (or its folder when
  it isn't in one). Conduit also registers as a selectable editor, so you can pick it under
  "Open with → Choose another app" and set it as the default app for common text/code/config
  types in Settings → Default apps. (Windows; uninstalling removes all the entries.)

## [0.3.0] — 2026-06-19

### Added
- **Git branch indicator in the terminal.** A clean, breadcrumb-style strip at the top of
  each terminal tab shows the current git branch (or a short SHA when detached), with
  markers for a linked worktree, an in-progress operation (rebasing, merging, …), and an
  uncommitted-changes dot. It updates as the shell changes directory or branch, and hides
  itself outside a git repo. Toggle it in Settings (on by default).

### Fixed
- **The document outline keeps the section you clicked selected.** In the Markdown outline,
  clicking the last — or second-to-last — of several short trailing sections no longer jumps
  the highlight to a different section; the one you picked stays active.
- **The quit confirmation waits for you.** Closing the app with running sessions no longer
  auto-dismisses the "you have sessions running" prompt and quits on its own after a moment;
  it now waits for an explicit Cancel or Quit.
- **Mermaid diagrams stay crisp when zoomed.** The fullscreen diagram zoom no longer
  pixelates at high zoom (the SVG scales vectorially), and its zoom toolbar now sits at the
  top-right, matching the image viewer.
- **Editor tabs don't resize when the strip overflows.** Opening enough tabs to overflow the
  strip no longer squishes them — tabs stay a constant size, and the horizontal scrollbar is
  now a thin 1px overlay that takes no layout space.

## [0.2.2] — 2026-06-18

### Fixed
- **The terminal mouse wheel scrolls history again under interactive tools.** When a
  full-screen tool like Claude Code turned on mouse tracking, the wheel stopped scrolling
  the terminal's scrollback — once you scrolled up you couldn't get back to the bottom
  except by pressing a key. The wheel now scrolls history in that case as expected, while
  still leaving the wheel to full-screen apps in the alternate screen (less, vim).
- **Dragging on a zoomed Mermaid diagram pans instead of selecting text.** In the
  fullscreen diagram viewer, a click-drag to pan no longer drag-selects the diagram's
  text labels.

## [0.2.1] — 2026-06-18

### Fixed
- **Auto-update works again.** 0.1.13 added a hardcoded Windows publisher name to the
  build, which made the updater require every download to be code-signed by that
  publisher — but the installers are unsigned, so updating from 0.1.13 failed with a
  signature ("checks failed") error. The publisher name is no longer hardcoded, so the
  updater verifies downloads by checksum (unchanged) without demanding a signature that
  doesn't exist. **Note:** because the rejected check runs in the *already-installed*
  app, anyone on 0.1.13 or 0.2.0 must install 0.2.1 manually once (from the Releases
  page); auto-updates resume normally afterward.

## [0.2.0] — 2026-06-18

### Added
- **Markdown math.** Inline `$…$` and block `$$…$$` LaTeX now renders as typeset
  equations (KaTeX).
- **GitHub-style alerts.** `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
  and `> [!CAUTION]` blockquotes render as colored callouts with icons.
- **Frontmatter card.** A document's leading YAML frontmatter renders as a tidy
  key/value metadata card instead of a stray horizontal rule.
- **Zoomable Mermaid diagrams.** Click a diagram (or its expand button) to open a
  fullscreen viewer — zoom with the wheel or buttons, pan by dragging or with arrow
  keys, reset to fit, and close with Esc. The diagram stays crisp at any zoom.
- **Document outline.** Docs with several headings gain an "Outline" toggle: a panel
  listing the headings that you can click to jump, with the current section
  highlighted as you scroll.

### Changed
- **Mermaid diagrams now match the app theme** (including light themes) instead of a
  fixed dark palette, and recolor live when you switch themes.

### Fixed
- **Heading links stay stable.** Heading anchor ids no longer drift when the rendered
  view re-renders, so in-document links keep working.

## [0.1.12] — 2026-06-18

### Fixed
- **New PowerShell sessions no longer crash on launch.** The real cause was the terminal
  pane recreating itself shortly after mount (its setup re-ran when the session's working
  directory or mono font first settled), which killed the just-started shell and instantly
  re-spawned it — and a Windows ConPTY shell re-spawned that fast dies with
  `STATUS_CONTROL_C_EXIT`, surfacing as "process exited" with only a manual restart to
  recover. The terminal/PTY now lives for the session's lifetime and is never torn down by
  working-dir, font, or theme changes. (The earlier 0.1.11 attempt addressed the wrong
  layer; this fixes the root cause.)
- **The live-cwd hook no longer appears as a stray command in PowerShell.** It had been
  typed into the shell's input, which PSReadLine echoed as a visible command at the first
  prompt; it is once again installed silently as a launch argument. Live-cwd tracking is
  unchanged.

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
