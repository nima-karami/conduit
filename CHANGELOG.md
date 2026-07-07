# Changelog

All notable user-facing changes to Conduit. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Internal run artifacts
(build reports, audits, retrospectives) live in `docs/runs/`, not here.

## [Unreleased]

## [0.24.0] — 2026-07-06

### Added
- **Review agent architecture proposals on the canvas — and edit them before applying.** When an
  agent proposes changes, the banner now says **Review changes**: the proposal opens *on the canvas*
  as an editable draft, with added components ringed green and edited ones amber. Tweak anything you
  like (rename, retype ports, move things), then **Apply changes** to save your version, or
  **Discard** to drop it. Nothing is saved until you apply.
- **Auto-layout — agents no longer place your components.** Agents describe the *relationships* and
  *interfaces*; Conduit arranges the nodes with a clean layered (left-to-right dataflow) layout. A
  diagram an agent hands you unpositioned is auto-arranged on open, a new **Tidy** button re-arranges
  the current graph on demand, and your manual drags are kept.
- **Keyboard access to the canvas menus.** Focus a component, wire, or the empty canvas and press
  **Shift+F10** (or the context-menu key) to open its menu, navigate with the arrow keys, and return
  focus where you were on close.

### Fixed
- **Edges no longer disappear when you move a component.** Dragging a node could drop the wires
  attached to it; they now stay put.

## [0.23.0] — 2026-07-06

### Added
- **The architecture view is now a typed, Grasshopper-style node graph** — the surface an agent
  reads to understand your system and write the implementing code.
  - **Named input/output ports.** Add ports to a component with the **+** buttons (they reveal as you
    zoom in or select a card) and **wire port to port** by dragging between pins. Rename a port in
    place by double-clicking it.
  - **Typed ports & reusable interfaces.** Give a port a type — a primitive (`string`, `number`,
    `boolean`, `date`, `json`), a `List<…>`, or a **named interface** you define. Open **Interfaces**
    in the header to author interfaces with typed fields, including **nested and recursive** types
    (e.g. `User { name: string; friends: List<User> }`). Deleting an interface safely clears the
    ports and fields that referenced it and tells you how many.
  - **Complex components you drill into.** Open a component's nested canvas to any depth; the parent's
    ports appear inside as **read-only boundary nodes** so the child knows its contract. **Escape
    steps up** one level (it no longer closes the view), and the breadcrumb jumps between levels.
  - **Grouping & composition.** Multi-select and **Group** components into a named box, **Encapsulate**
    a selection into a new nested component, **Explode** a component back into its parent, and
    **Insert space** (hold **Alt** and drag on empty canvas, or use the pane menu) to open room
    between nodes.
  - **Presentation & editing.** Inline component rename (double-click the title or **F2**), an icon
    picker, a description field, and distinct visuals for empty vs. leaf vs. nested components.
  - **Right-click menus on every surface** — component, port, wire, empty canvas, and group — each in
    a consistent order with the destructive action last.
- **Agents can read and write the diagram** via the bundled **Conduit Architecture** skill and JSON
  schema, which now cover ports, typed interfaces, wiring, and nested components.

## [0.22.0] — 2026-07-06

### Added
- **Install Conduit's agent skills** from **Settings → Skills** (or the command palette →
  "Install Conduit skills…"). Conduit now bundles skills that teach an agent how to read and update
  a project's `.conduit` artifacts — starting with **Conduit Architecture** and **Conduit Plan** —
  and installs any of them into either **this project** (`.claude/skills/`) or your **user profile**
  (`~/.claude/skills/`), so a Claude Code session working in your repo picks them up. Re-installing
  updates in place; the panel shows each skill's version and install status.

## [0.21.3] — 2026-07-03

### Fixed
- **Drag-and-drop into the file explorer now highlights the folder you're actually over**, instead
  of outlining the entire explorer. Hover a folder and just that folder lights up; hover a file and
  its parent folder lights up; drag over the empty area below the files to drop into the project
  root. This also fixes a case where dropping a file onto a subfolder could import it into both that
  folder and the project root.

## [0.21.2] — 2026-07-03

### Changed
- **Keyboard shortcuts no longer hijack the terminal.** When a terminal is focused every key now
  goes to the shell/TUI (e.g. a Claude Code session), so app shortcuts stop stealing keys that the
  program in the terminal needs. **Ctrl+`** is the one exception — it now *toggles* focus in and out
  of the terminal, so you can always get back to the app. When the code editor is focused, the
  editor's own keybindings win and app shortcuts act only as a fallback.
- **The built-in navigation shortcuts are now editable.** Ctrl+Tab, Ctrl+Shift+Tab,
  Ctrl+PageUp/PageDown, Ctrl+`, and Ctrl+1–9 can be rebound in Settings → Shortcuts (Record/Reset),
  like every other shortcut.

## [0.21.1] — 2026-07-03

### Fixed
- **Persisted state no longer looks "wiped" on the first launch after an update.** Your open
  sessions, recent-folders history, session/terminal picker, and theme now appear immediately
  instead of showing empty until you opened a folder. The data was always safe on disk — the new
  window occasionally missed the initial state snapshot from the background process because the
  message bridge delivered that startup backlog only to whichever UI component subscribed first.
  It now delivers it to every subscriber, in order.

## [0.21.0] — 2026-07-02

### Added
- **Review Changes summary.** The Review header now shows a diffstat — **`N files changed · +X −Y`**
  — above the file cards, for the working tree and for any two-ref comparison, so you can see the
  size of a change before scrolling it.
- **Review file navigator.** A toggleable list of the changed files (with each file's kind and
  `+/−`); click one to jump straight to its diff card (it scrolls into view and expands). The
  open/closed state is remembered.

### Changed
- **The app opens on the Files tab by default and remembers your choice.** The right pane no longer
  forces the Changes tab on launch — it restores whichever of Files/Changes you last used.
- **Restoring a session now brings back all its tabs**, not just file tabs — open diffs, commit
  diffs, the Review tab, History, and web tabs reopen too (a restored Review opens on the working
  tree).

### Fixed
- **Switching sessions focuses the terminal.** After clicking another running session you can type
  immediately — focus lands in that session's terminal instead of nowhere.
- **The History commit detail stays open.** Selecting a commit and then visiting another tab and
  returning to History keeps that commit selected with its detail pane open (no need to re-click).
- **Removed a duplicate "Compare…" entry** in the Review git bar — comparing two refs now has a
  single, clear entry point (the Compare button).

## [0.20.0] — 2026-07-02

### Added
- **Git blame in the editor.** Toggle Git Blame to see the author, time, and commit summary for
  the line your cursor is on; click the lens to open that commit in Review.
- **Images in Markdown reports render.** A relative or local image an agent embeds (e.g.
  `![chart](./out/chart.png)`) now shows instead of a broken icon.
- **Word-level diff in Review.** A one-word edit highlights just the changed word on each side,
  not the whole line.
- **Search all of git history.** Find a commit by message, author, or changed content anywhere in
  history — not just the commits currently loaded in the graph.
- **Clickable links in the terminal.** `http(s)` URLs an agent prints (dev-server, PR/issue links)
  open in your browser.
- **Compare images with synced zoom.** In a side-by-side image diff, zooming or panning one side
  moves the other too, so you can line up a change.
- **Rotate PDF pages** — for scanned or landscape documents.
- **More VS Code shortcuts.** The command palette shows each command's shortcut; **Ctrl+PgUp/PgDn**
  switch tabs; **Ctrl+Shift+G** opens git history; **Ctrl+Shift+T** reopens the last closed tab;
  built-in navigation shortcuts are listed in Settings → Shortcuts.
- **Close all stale sessions** in one action, without touching running ones.

### Changed
- **Quick open (Ctrl+P)** now lists every tracked file and respects `.gitignore`, instead of
  stopping at a fixed cap and surfacing build/vendor folders.
- **Find in files** respects `.gitignore` and no longer freezes the app or terminals while it
  searches a large repo.
- **Remote images in Markdown** load on click (a "Load image from …" chip) instead of fetching
  automatically, so agent- or repo-authored docs can't quietly beacon out.
- **The file explorer** stays smooth in very large folders (only the visible rows render).
- Empty Markdown documents and empty Mermaid blocks show a neutral message instead of a blank pane.
- **Light theme (Paper):** syntax-highlighted diffs, status colors, badges, and hover states are
  now legible.

### Fixed
- **Terminal links resolve against the right repo.** In a multi-repo workspace, a path or commit
  printed in the terminal opens the file/commit from that terminal's own repo, not a different
  pinned one. Git blame's "open in Review" is repo-correct too.
- **CRLF files** no longer show every line as changed in Review and the diff viewer (Windows
  autocrlf).
- **Renamed files** show their real diff instead of a whole-file add.
- **Git history** shows a proper error + retry on a transient git failure (instead of looking like
  an empty repo), a background refresh no longer blanks a loaded graph, and "Load more" stays
  available while a search filter is active.
- **Turning off "reopen previous sessions" no longer wipes your saved sessions.**
- **PDF text selection and find highlights** line up with the text, including rotated and justified
  text.

## [0.19.0] — 2026-07-01

### Added
- **Syntax highlighting in Review Changes.** Diff lines are now colored per language — the
  same palette as the editor — so you can actually read what an agent changed. Added and
  removed lines keep their green/red tint and `+`/`-` sign under the token colors; unknown
  file types fall back to plain text.
- **Find in a rendered Markdown file.** Press **Ctrl/Cmd+F** while viewing a Markdown doc to
  search it in place — matches highlight with a running `n/total` count, Enter/Shift+Enter
  cycle through them (and scroll each into view), Esc closes. No need to switch to source.
- **Export a Mermaid diagram.** The diagram zoom viewer now has **Export SVG** and
  **Export PNG** buttons to save a diagram an agent produced.
- **Collapsible Markdown outline.** In a long doc, fold a heading's nested sections in
  the Outline panel to focus on the parts you care about.

### Changed
- **Markdown code blocks** now use the editor's syntax palette instead of a separate theme,
  so code reads consistently whether it's in a file, a diff, or a Markdown fence.

### Fixed
- **Light theme (Paper) legibility.** Bold text in Markdown is no longer invisible white-on-
  white, and the branch-filter and session-rename inputs are no longer dark-on-dark.
- **Terminal links and file search can't hang anymore.** If the app doesn't get a response
  (a session that went away mid-request), a terminal link now resolves to plain text and the
  search spinner clears with a timeout, instead of waiting forever.

## [0.18.0] — 2026-06-30

### Added
- **Compare any two refs from one dialog.** A new **Compare** icon on the git band opens a
  dialog where you pick a **base and a target** — each can be a **local or remote branch, a tag,
  a commit, or a pasted SHA** — and see the diff in Review Changes **without ever checking out a
  branch**. Swap the two sides, and a live preview shows the resulting comparison. Replaces the
  older buried compare builder.
- **Back / Forward with the mouse and keyboard.** Your mouse's side buttons (and **Alt+←/Alt+→**)
  now navigate Back and Forward through the tabs and terminals you've visited, like VS Code.
- **Middle-click to close / open.** Middle-click a tab to close it (you're still prompted about
  unsaved changes); middle-click a file in the Explorer to open it in a permanent tab.

### Changed
- **Tabs remember where you were.** Switching away from a tab and back restores your exact scroll
  position — and for code, your cursor, selection, and folding too — instead of jumping to the top.

### Fixed
- Reopening a file you'd closed now starts at the top, rather than restoring the scroll position
  it had before you closed it.

## [0.17.0] — 2026-06-29

### Added
- **Spring-loaded folders.** While dragging, hover a collapsed folder for a moment and it expands
  so you can drop into nested folders; folders opened this way re-collapse if you drop elsewhere.
- **Drag a whole multi-selection.** Grabbing a selected row in the Explorer now moves/copies the
  entire selection (a folder and a file inside it are de-duped so nothing moves twice).
- **Name-collision dialog for drag-and-drop and import.** When a move/copy/import would overwrite
  an existing item you now get **Replace / Keep both / Cancel** (with an "apply to all remaining"
  option for batches), instead of the operation silently failing. Replacing a non-empty folder
  warns first.
- **Full keyboard control of the Explorer.** Arrow keys navigate, Enter opens/expands, **F2**
  renames, Delete deletes, Esc clears, and **Cut/Copy/Paste (Ctrl+X/C/V)** move or copy files
  without dragging (also in the right-click menu) — a keyboard alternative to drag-and-drop.

### Changed
- **The drop target is now precise.** Dragging over a folder highlights just that one folder row,
  so you can see exactly where the item will land — instead of lighting up the whole directory.
- **Renaming a file selects only the name, not the extension** (`component` in `component.tsx`),
  so a quick rename keeps the extension. Folders and dotfiles still select the whole name.

### Fixed
- **Renaming a file by only its capitalization now works** (e.g. `Readme.md` → `README.md`) on
  Windows/macOS, where it previously could be a no-op.
- Explorer name validation now rejects reserved Windows names (`CON`, `AUX`, …), invalid
  characters, and trailing dots before hitting disk.

## [0.16.0] — 2026-06-29

### Added
- **Compare any two refs in Review Changes.** The source picker now has a **Compare…** builder:
  pick a base and a target — each a branch, a commit, or (for the target) the working tree — and
  Review shows the difference. Branch-vs-branch and commit-vs-commit use a merge-base (three-dot)
  diff, like a pull request; a comparison against the working tree shows your uncommitted changes
  relative to the chosen ref. Identical refs show a "No differences" state.

### Changed
- **The Review source picker now lives on the git breadcrumb** (the row with the folder/branch
  pickers and the History/Review icons), shown whenever the Review tab is active, instead of inside
  the Review header.
- **Long diff lines now wrap** in Review Changes instead of showing a per-line horizontal
  scrollbar, so you can read a whole line without scrolling sideways.
- **Large/added files in Review Changes show a more compact portion** (~40 changed lines) before
  "Show all N lines", so a big new file no longer floods the view.

### Fixed
- **Opening Review from a commit's detail now works reliably.** The icon-only "Review changes"
  button in the commit detail overlapped the detail's close button, which was swallowing its
  clicks.

## [0.15.0] — 2026-06-29

### Added
- **Pick which commit to review from a searchable dropdown.** The Review Changes tab's source
  selector is now a full commit picker: search recent commits by hash, message, or author, pick
  one (or "Working tree"), or paste a commit SHA. Replaces the previous two-item toggle.
- **Collapse and expand individual file cards in Review Changes.** Click a file's header to
  collapse it to a single line, so you can scan a large changeset quickly and focus on the files
  you care about.

### Changed
- **Large and newly-added files in Review Changes now show a bounded portion** (the first ~300
  changed lines) with a "Show all N lines" / "Show less" toggle, instead of dumping an entire
  thousand-line file into the view.
- **The "Review changes" action on a commit's detail is now a clean icon button** (right-aligned),
  matching the Review icon used elsewhere, instead of a text button.

## [0.14.0] — 2026-06-29

### Added
- **Review a specific commit in the Review Changes tab.** The Review tab now has a source
  selector in its header: switch between the working tree and a commit. A **"Review changes"**
  button on a commit's detail (in the History tab) opens that commit's full changeset in the
  Review tab, using the same fast virtualized view as working-tree review.
- **Commit hashes in the terminal are clickable.** When a tool (e.g. Claude Code) prints a
  commit hash, Conduit detects it, verifies it's a real commit in the session's repo, and makes
  it a link that opens that commit in the Review Changes tab.

### Changed
- **The History tab's commit-detail pane remembers its size.** Dragging the pane taller (or
  using Up/Down on the seam) now persists across closing and reopening the tab — and across
  restarts — instead of resetting to the default height each time.

## [0.13.0] — 2026-06-29

### Added
- **The file explorer supports multi-select.** Ctrl/Cmd-click toggles a row in or out of the
  selection; Shift-click selects the contiguous range from the last clicked row; a plain click
  collapses back to a single selection — mirroring VS Code. Selected rows are marked for screen
  readers and carry a left accent bar so the selection reads clearly in high-contrast mode.
  (Keyboard selection and bulk actions on the selection are planned next.)
- **Editor tabs now use VS Code-style preview tabs.** Single-clicking a file (or opening it
  from a path link, search, go-to-definition, the Review view, etc.) opens it in one reusable
  *preview* tab (shown italic) that the next single-click replaces in place — so browsing files
  no longer buries you in tabs. Double-clicking the file or the tab, editing it, or dragging it
  promotes it to a permanent tab; a "Keep Open" item on the tab menu does the same from the
  keyboard. Opening a file that's already pinned just focuses it.
- **Open editor tabs are restored when you reopen Conduit**, including which tab is active and
  each tab's preview/pinned state (gated by the existing "restore sessions" setting). Tabs for
  files that no longer exist are kept and show a not-found state rather than vanishing.

### Changed
- **The Review Changes button moved out of the Changes tab** to sit next to "View commit
  history" in the git bar, so it's reachable from any sidebar tab and always available — even
  with no changes, where the Review page shows a "Nothing to review" message.

### Performance
- **The Review Changes view stays fast on large changesets.** The list of file cards is now
  virtualized — only the cards near the viewport are rendered (with their diffs fetched on
  demand) — so opening a review of hundreds or thousands of changed files is instant and scrolls
  smoothly instead of freezing. A single very large file is capped with a "Show remaining lines"
  expander.

## [0.12.5] — 2026-06-26

### Fixed
- **The repo picker now picks up a repo/worktree added while the folder is open.** A new
  sub-repo or git worktree created after opening the folder was only detected via a filesystem
  watch rooted at the active session's working directory — so one created elsewhere (e.g. a
  sibling worktree) stayed invisible in the picker until a restart. Detection now also re-runs
  on every project refresh (open / window focus / cwd change), so the new repo appears on its
  own.

## [0.12.4] — 2026-06-25

### Fixed
- **Collapsing a folder in the explorer no longer pops it back open.** A background refresh
  (on focus / file changes) re-reads expanded folders; if its reply arrived just after you
  collapsed one, the folder would re-expand. Loading a directory's contents no longer changes
  its expanded state — expansion is now a separate, explicit action.

## [0.12.3] — 2026-06-25

### Fixed
- **The editor breadcrumb's symbol no longer floats to the far right.** The enclosing
  function/method segment (e.g. `ƒ migrateStage`) now sits directly after the file name
  instead of being pushed to the opposite edge of the bar. Long paths still truncate
  ancestor folders first, keeping the file name and symbol readable together.

## [0.12.2] — 2026-06-25

### Changed
- **The repo picker + branch indicator now show over the Review and History tabs**, not just
  the terminal. Those views are scoped to the active repo — which you can still change from
  the file explorer while they're open — so the active repo stays visible and switchable there.

## [0.12.1] — 2026-06-25

### Fixed
- **Multi-repo git now tracks the active repo everywhere.** When a workspace held several
  sub-repos, only the branch indicator and the change *list* followed the picked repo —
  staging/unstaging/discarding ran in the opened parent folder (so it silently failed or hit
  the wrong repo), opening a change's diff used the wrong path, the Review tab resolved files
  against the parent, and any git action reset Changes to the parent. Every git surface
  (Changes, the diff/Review views, all actions, History) now resolves against one shared
  active-repo root, matching the picker.

## [0.12.0] — 2026-06-25

### Added
- **More keyboard shortcuts, matching VS Code.** Close the active editor tab with `Ctrl/Cmd+W`,
  cycle tabs with `Ctrl+Tab` / `Ctrl+Shift+Tab`, jump to a tab with `Ctrl/Cmd+1`–`9`, and focus
  the terminal with `` Ctrl+` ``.
- **Open an HTML file in your browser.** Right-click an `.html` tab (or use the command palette →
  "Open active file in browser") to view it rendered, since the editor itself shows source.

### Changed
- **App shortcuts now work while the editor is focused.** The command palette, quick-open,
  sidebar toggles, and other global shortcuts fire from inside the Monaco editor too (VS Code
  parity); only the editor's own editing keys (undo/redo) still stay with the editor.
- **The selected line no longer draws a box outline** — only its line number is highlighted.

### Fixed
- **Go to Definition is reliable now.** The project index was capped at 400 source files, so
  jumping into a definition in any file past the cap silently did nothing (this app alone has
  ~400 source files). The whole first-party tree is indexed now, and an explicit lookup that
  finds nothing (e.g. a symbol defined in a dependency) says so instead of doing nothing.

## [0.11.2] — 2026-06-25

### Changed
- **Rendered Markdown re-renders less.** The viewer no longer re-parses the whole document on
  unrelated re-renders (the syntax-highlighting/sanitize/math pipeline is now stable), so large
  Markdown files stay snappier. Internal cleanup only — no behavior change.

## [0.11.1] — 2026-06-25

### Fixed
- **Updating no longer drops your settings or open sessions.** Persisted state was written
  non-atomically and only asynchronously, so when the auto-updater force-killed the app to
  swap in the new version it could truncate `sessions.json` / `settings.json` mid-write — and
  the next launch lost your sessions and reset some settings to defaults. State is now written
  atomically (temp file + rename) and flushed synchronously on quit. (Protects every update
  *from this version onward*; it can't retroactively recover already-lost data.)

## [0.11.0] — 2026-06-25

### Added
- **Rendered Markdown now shows embedded HTML** — README-style blocks like
  `<div align="center">`, `<img width=…>`, `<details>`, `<sub>`/`<sup>` render instead of
  being dropped. The HTML is sanitized first (GitHub's schema), so `<script>`, inline
  event handlers, and `javascript:` URLs are stripped; math and code highlighting are
  unaffected.

## [0.10.0] — 2026-06-25

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
