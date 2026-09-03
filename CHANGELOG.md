# Changelog

All notable user-facing changes to Conduit. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Internal run artifacts
(build reports, audits, retrospectives) live in `docs/runs/`, not here.

## [Unreleased]

### Fixed
- **Clicking a link in the terminal opens it, with no scare dialog.** Links that a CLI emits as a
  labelled hyperlink (the OSC 8 kind — what Claude Code prints) went down xterm's own default
  path, which asked "Do you want to navigate to …? WARNING: This link could potentially be
  dangerous" and then, on OK, failed to open anything at all. Conduit's own link handling only
  covered links it detected as plain text. Both kinds now open in your real browser through the
  same scheme-checked path, with no dialog.
- **The git history and Review buttons stay put when you open a file.** The git band — branch,
  commit history, Review changes, Compare — used to vanish the moment any ordinary document tab
  became active, so opening a file removed the only way to reach Review or History and gave no
  hint that switching back to the terminal would bring them back. Those actions belong to the
  repo, not to the document, so the band now rides every surface in a session that has one.
- **Dollar amounts in markdown are no longer swallowed as math.** A pair of `$` in a document was
  read as LaTeX, so "Published CA$170,000 to $250,000" lost both dollar signs and re-rendered the
  text between them in a serif math italic. Currency, `$PATH` and template literals now stay as
  written; genuine math still renders when written with `$$…$$`.
- **A timed message due while its session's terminal was still settling could spin the app.**
  Right after a session's PTY starts, timed messages hold off briefly rather than typing into a
  shell that hasn't printed its prompt yet. If a schedule was already due when that window opened,
  the timer re-armed itself immediately instead of waiting out the window — a busy loop on the
  main process for the rest of it. Fixed; also confirmed arming still works correctly with several
  sessions each running their own schedule, with the window minimized, and on a session that isn't
  the active tab.
- **The timed-messages dialog no longer scrolls, and Neon's cut corner sits where it should.**
  Switching the "When" trigger (In / At / Every) used to change the card's height enough that it
  started scrolling internally past a point — one dialog, several different heights depending
  which trigger was open. On Neon that also broke the chamfered corner, which draws itself at the
  surface's own bottom-right: on a scrolling element that was the bottom of the *content*, not the
  visible card, so the cut read as inset and unfinished. The dialog is sized to content now, like
  every other dialog in the app.

### Added
- **Command palette search finds commands by more than their exact title.** Entries can carry
  hidden keyword aliases, so typing "interval", "schedule", or "timer" now finds "Send timed
  message…" even though none of those words appear in it. A direct title match always ranks above
  a keyword-only match.

## [0.36.2] — 2026-08-31

### Fixed
- **The editor's find bar looks like the rest of Conduit.** It was the editor library's own
  chrome: a grey field with a stock-blue edge, a close button sitting above the row it belongs to,
  and an expand chevron drawn as a full-height bar. Now it is the same raised surface, hairline
  and 22px icon buttons as the terminal's find bar, everything centred on one row, and clicking
  into the field lights up the *whole* field at its border the way every other search box in the
  app does. "No results" turns the app's red, the field's text is legible on the light theme, and
  the widget stops sliding in when your system asks for reduced motion.

## [0.36.1] — 2026-08-31

### Changed
- **Changed lines in Review are easier to see, especially on Neon.** Every added and removed row
  now carries a coloured bar down its leading edge in the same green/red the editor's gutter uses,
  and its `+`/`−` marker takes that colour too instead of the old neutral grey. Neon's row tint
  was also the faintest of the three themes — a deleted row was a 7% step off an unchanged one —
  and is now level with Aero and Aero Dark. Word-level highlights inside a changed line follow the
  theme as well, so Neon no longer shows a warm brick box inside a magenta row.
- **The editor's scroll map actually finds your changes.** Two edits far apart in a long file used
  to blank the map entirely — anything more than 500 lines between the first and last change and
  every mark vanished. That limit is now 4x larger and matches Review's, so an import at the top
  and a function at the bottom both show up. The marks themselves are half again as wide, the
  minimap echoes each one as a band rather than a hairline, and error marks keep their own lane.
- **A brand-new file no longer paints the map solid.** An untracked file has nothing to compare
  against, so it keeps its gutter bars — every line really is new — and leaves the scroll map and
  minimap empty instead of drawing one unbroken stripe you cannot navigate.
- **The editor's change markers follow the "ignore whitespace" setting** that Review already had,
  so a pure re-indent stops lighting up the whole file in both places at once.
- **The side-by-side diff shows its changes properly.** Changed lines are washed strongly enough to
  read at a glance now that they carry the signal alone, the changed words inside them are picked
  out, and the strip down the right edge uses the same green and red as everywhere else instead of
  a barely-visible tint derived from the wash. A changed line and the changed word inside it are
  also the same colour now — on the light theme they were two visibly different reds.

### Fixed
- **Review Changes keeps your place.** Leaving the Review tab for a file, a terminal or
  anything else and coming back no longer drops you somewhere else in the list. It comes back
  exactly as you left it: the same scroll position on the same file, the cards you collapsed still
  collapsed, the unchanged runs you expanded still expanded, plus your file filter, your search and
  the hunk your keyboard cursor was on. Switching the review to a different commit or comparison
  still starts fresh, and closing the tab still forgets it.
- **Jumping to the next change says why when it cannot.** Opening a folder that is not a git repo,
  a file git cannot read, or one too large to compare used to leave the map silently empty and
  indistinguishable from "nothing changed here". It now says which of those it is.

## [0.36.0] — 2026-08-29

### Added
- **Send a message to a session on a timer.** Open the command bar and run **Send timed
  message…** (it is also on a session's right-click menu): type what to send, choose **In** a
  few minutes, **At** a time of day, or **Every** so often for a set number of repeats, and arm
  it. Conduit types it into that session and presses Enter for you. While something is armed the
  terminal carries a small chip saying what is coming and when — click it to change or cancel —
  and when nothing is armed there is no chip at all.
- **It survives a restart, and it waits for you.** An armed message is remembered across quitting
  the app. Nothing is ever typed into a session that isn't running, and Conduit will not start one
  behind your back: a message whose moment passed while the session was down says **Waiting** on
  the session card and in the sidebar, and sends once — marked late — as soon as you open that
  session again. A message that has been waiting far too long is skipped and offers you a Renew
  instead of surprising you with old instructions.
- **Automatic resume after a usage limit.** When a session's own output says it hit a usage limit
  and names a reset time, Conduit arms a **Continue** for a minute after the reset and tells you so
  with an Undo. The chip labels it **Auto** and cancels in one click, and only what the session is
  showing right now counts — a limit message scrolling past inside a `git log` is not a match. In
  Settings › General you can switch this to ask first, or turn it off.

## [0.35.0] — 2026-08-28

### Added
- **Start a session in any folder, straight from the Explorer.** Right-click a folder and pick
  **Open as new session**: the New Session dialog opens with that folder already set as the
  working directory, so all that is left is picking the agent. Useful for a package in a monorepo
  or a subproject you want an agent scoped to. It is a folder action, and it needs the selection to
  come down to a single folder — a session has one working directory — so it is greyed out on a
  wider selection. Reachable from the keyboard through the usual context-menu key.
- **The editor now shows what changed.** Open any file with uncommitted work and the gutter
  marks it: a solid bar on added lines, a dashed bar where a line was rewritten, and a small
  triangle where lines were removed — with matching marks on the scroll map and in the minimap,
  so you can see at a glance where an agent has been in a file you haven't scrolled through yet.
  The marks are live: they follow your typing, they follow a commit or a branch switch, and a
  brand-new file reads as added end to end. `Alt+F5` and `Shift+Alt+F5` walk the changes (both
  rebindable in Settings › Shortcuts), and hovering a mark says what it is. Everything is
  measured against HEAD, the same baseline the Review tab uses, so the two can't disagree.
- **The minimap is on by default**, without character rendering — it is where the change marks
  for the parts of a file you can't see actually live. Settings › Appearance › Editor & code has
  a switch for it, and one for the change markers themselves.
- **Review has a keyboard.** With the Review tab focused, `j` and `k` walk change to change across
  the whole changeset, `J` and `K` jump file to file, `m` marks the file you are on as reviewed,
  `o` (or Enter) opens the current change in the editor, and `e` / `Shift+E` expand or collapse
  every file at once. A ring marks where you are, and `?` prints the list without you having to
  remember any of it. Escape closes the list, then Review, as it always did.
- **Reviewed marks survive a restart.** Ticking a file used to last until you closed the tab; now
  it is remembered per repository and per changeset, and it comes back when you reopen Review —
  including in a second window, which updates as you tick. It is deliberately kept outside your
  project, so marking a file read never shows up as a change in the tree you are reviewing. If the
  file changes again after you marked it, the mark clears itself: it was a receipt for the version
  you actually read.
- **Collapse all / Expand all**, in the Review header, with the file you were on kept in view.
- **Review source quick-picks.** The source picker now offers **Last commit**, **Unpushed** (what
  is not on your upstream branch yet) and **Since branch point** (everything since this branch left
  the default branch) above the commit list. Rows that don't apply to the repository — no upstream,
  no default branch, nothing to compare — are simply not shown.
- **Ignore whitespace**, a toggle in the Review header, so a re-indent stops burying the two lines
  that actually changed. Off by default, and remembered.
- **Review one side at a time.** A **Scope** switch beside the Review source picker splits the
  working tree into **All**, **Staged** and **Unstaged**. Staged compares HEAD to the index,
  Unstaged compares the index to your files on disk, and All is the whole diff Review has always
  shown. A file you have half-staged shows up in all three, each time with only that side's
  changes, so it is finally possible to read what you are about to commit without the rest of your
  edits mixed in. A conflicted file says so instead — a conflict has no staged version to compare
  against, so it is one to read under All. The Staged and Changes headers in the Changes panel
  each grew a Review button that opens Review already on that side. Arrow keys move between the
  three; every new Review starts on All.
- **Stage, unstage or throw away one change at a time.** Every hunk in the Review tab now carries
  its own Stage and Discard — so a review that used to mean "take the whole file or none of it"
  can go change by change. Under the Staged scope the pair becomes Unstage on its own: those
  hunks are already staged, and discarding them is a job for the Unstaged side. The same buttons
  live in the editor: click a change marker in the gutter and a panel opens in place showing the
  lines that were removed, with Stage · Discard and arrows to walk to the next one (also on the
  editor's right-click menu, as "Peek change"). `s` and `d` do it from the keyboard while Review
  has focus, and Discard always asks first.
- Hunk actions bow out where they cannot be honest about what they would do: on a conflicted
  file, on a file you have half-staged while reading the All scope, and while Ignore whitespace
  is on — each says which, on hover.
- The patch is built from git's own diff of the file, not from what's on screen, so files with
  Windows line endings or no newline at the end come through exactly right — and if the file has
  changed since the diff you're looking at was loaded, the operation is refused and the card
  reloads rather than applying half of it.
- **Search the diff.** `/` or `Ctrl+F` with Review focused opens a find bar over the changed
  lines. It searches the diffs themselves rather than what happens to be on screen, so a match
  inside a collapsed file, or on a line past a big file's "Show all" cut-off, still counts — press
  Enter and Review opens whatever it has to open to put that line in front of you. Enter and
  Shift+Enter walk the results, `Aa` switches to matching case, and unchanged lines you have
  hidden in a fold stay out of it. Reviewing a commit or a comparison searches all of it; the
  working tree loads file by file as you scroll, so there the bar says how much it has actually
  seen — "in 12 of 198 files" — and offers **Search all files** to fetch the rest and count again.
- **Filter the file list by name.** A field above the Review file list narrows both the list and
  the cards beside it to the paths you type; Esc clears it.
- **Leave notes on a line, and hand them to the agent.** Hover any line in Review and a `+`
  appears in the gutter — or press `c` on the change you are on. Write what you want changed,
  save with Ctrl/Cmd+Enter, and the note sits under that line as a thread you can edit, resolve
  or delete. Notes are stored in your project, at `.conduit/review-notes.json`, precisely so the
  agent can read them; they come back when you reopen Review, in either window, and an agent that
  edits the file itself shows up live. When the code moves under a note it follows the line it was
  written on; when the line is gone for good the note is listed at the top of the file’s card
  ("lost its place") rather than quietly disappearing. Open files show the same notes as a small
  mark in the editor's gutter — hover for the text, click to jump back to Review.
- **Send to agent.** One button in the Review sidebar pastes every open note into the session’s
  terminal as a single markdown block, grouped by file with the line and the code it was written
  against. It never presses Enter — you read what reached the agent and send it yourself. If that
  session has no terminal, the button offers the same text on the clipboard instead.

### Fixed
- **The file header now stays put while you scroll through a long file** in Review, instead of
  scrolling away and leaving you looking at a diff you can no longer name.
- **"Open file" on a too-large-to-diff file works.** The button has been there, and inert, since
  the notice was written.
- **"Browse…" stays put at the top of the New Session dialog.** It used to be the last row of the
  recent-repositories list, so once you had a few repos it sat below the fold and had to be
  scrolled to every single time you wanted to open a folder that was not already in the list. It is
  now pinned above the list, which scrolls underneath it.

## [0.34.0] — 2026-08-27

### Fixed
- **Go to Definition now reaches into packages (`node_modules`, `@types`, `exports` maps,
  subpaths), monorepo siblings and workspace links, aliases from any tsconfig in the tree, files
  above the project root, and files beyond the index cap — resolving and indexing them on
  demand.** Conduit only ever read the source files under your project root, so everything else
  was a dead end however ordinary it looked: `zod`, `lodash` through its `@types` package,
  `date-fns/format`, a workspace package behind an npm junction, `../shared/thing` one directory
  up, an `@/…` alias declared in `tsconfig.app.json` rather than `tsconfig.json`. Now a lookup
  that misses resolves the specifier the way Node and TypeScript would — from the file doing the
  importing, not from the project root — reads what it finds plus the files that one imports, and
  tries again. A `@tsconfig/*` preset named in `extends` is followed too, so the compiler options
  your project actually declares are the ones the editor uses. A resolved package is remembered
  until the project changes on disk, so the second lookup is free.
- **Go to Definition tells you what actually happened.** It used to decide it had worked by
  checking whether the cursor moved — and the cursor did move, to the `import` line of the file
  you were already in, any time the thing you asked about lived somewhere Conduit hadn't indexed
  (a package, a monorepo sibling, a file above the project root). It looked like a definition. It
  wasn't one. Now every navigation ends in something you can act on, at the cursor: what it can't
  reach and why ("Can't navigate into 'zod' — it isn't indexed"), that there is genuinely nothing
  there, or how far the project index has got if it is still building. Monaco's "No definition
  found for 'zod'" is gone — that was never true; the definition exists, Conduit just hadn't read
  it. And peeking several results, or peeking references from a symbol you are already standing
  on, no longer raises a stray "still indexing" toast.
- **Go to Definition reaches more of your project.** Conduit used to skip every directory whose
  name began with a dot, which quietly took `.storybook`, `.config`, `.github/scripts` and
  `.vscode` out of the index along with the tool-state folders it was actually aiming at — so a
  declaration in any of them was unreachable. It also stopped noticing your project the moment it
  finished reading it: a file created afterwards, by you or by an agent, stayed invisible until
  you reopened the window. Both are fixed — the exclusion list is now specific, and new files are
  picked up as they appear. And a source file over 2 MB is now skipped and counted rather than
  read halfway: the language service used to be handed the first 2 MB and would confidently deny
  every symbol past the cut. When a lookup misses, the message says what the index left out
  ("1 file over 2 MB skipped").

## [0.33.0] — 2026-08-21

### Fixed
- **"Needs you" stops pinging for sessions with nothing to show.** A background session used to
  raise the badge — and the taskbar flash and the desktop notification — any time its output
  paused for a second and a half. A one-line `echo`, a shell printing its startup banner, an agent
  pausing mid-turn to run a tool: all of it looked like "finished, come look". Worse, a tool that
  repaints its status line kept re-raising it forever, and the moment you glanced at the session it
  started over. Now a session only asks for you when it has actually done something — a run of real
  length or size that then went quiet, or a terminal bell, which is what agents ring when they want
  an answer. It asks once and then waits: nothing re-raises it until you have looked. A session you
  can see never asks at all, including one sitting in a split pane or open in another window, and
  neither does one that just started or one whose process has exited.

## [0.32.0] — 2026-08-20

### Fixed
- **Relaunching a session no longer leaves the terminal spitting `35;57;21M` at your prompt.**
  If the session had been running a full-screen tool that turned on mouse tracking and was killed
  before it could turn it off, restoring that session's history switched mouse tracking back on —
  against the fresh shell underneath it. Every mouse movement over the terminal then typed a
  garbled mouse report at the prompt. Restored history now stops carrying that state over.
- **A crashed window comes back on its own instead of going black.** If Conduit's window process
  died — a big enough diff could run it out of memory — the window went black and stayed that
  way, even though every session and every shell behind it was still running. The only way out
  was quitting the whole app, which killed them all. The window now reloads itself and reconnects
  to the sessions that were already there: your scrollback comes back and you can keep typing in
  the same shell. If it keeps crashing, Conduit stops retrying rather than looping.
- **Opening a huge commit in Review no longer freezes or crashes the app.** Reviewing a big
  commit — a monorepo merge, anything touching a large lockfile or generated file — used to
  sit on "Loading commit changes…" and then take the window down with it, because Conduit
  line-matched every file in the commit up front just to print the `+N −N` counts. Those
  counts now come straight from git, and a file whose two versions are too different to line
  up is shown as a whole-file replacement with a note saying so, instead of being matched
  line by line. A commit that can't be read at all now says so and offers a Retry, rather
  than loading forever.

## [0.31.1] — 2026-08-17

### Fixed
- **Tooltips and hover buttons no longer fight your cursor.** Hovering the X on the code
  editor's find bar (Ctrl+F) popped a "Close (Escape)" label directly on top of the button it
  describes, so the pointer landed on the label instead of the X — and moving onto the label made
  it flicker. Labels like that no longer take the pointer at all.
- **Invisible buttons can no longer be clicked.** Row and card actions fade in on hover, but they
  were still clickable while completely invisible — including two destructive ones: *discard* on a
  changed-file row, and *kill* on a session card. Clicking empty space near the right edge of a
  resting row could trigger them. The same was true of the board card actions, the image viewer's
  controls, the heading link in rendered Markdown, the architecture canvas's remove-port button,
  and the unsaved-changes dot on a tab (where a click beside the X silently saved instead).

## [0.31.0] — 2026-08-17

### Added
- **Select several files in the Explorer from the keyboard.** Until now multi-select was
  mouse-only, so the actions that work on a selection — including everything in the right-click
  menu — were out of reach without a mouse. `Ctrl+A` selects everything in view, `Shift` with the
  arrow keys or Home/End extends the selection a row at a time (press again to grow, reverse to
  shrink), `Ctrl` with the arrows moves between rows **without** disturbing what's selected, and
  `Ctrl+Space` adds or removes the row you're on. Selecting all announces the new count for screen
  readers.

## [0.30.0] — 2026-08-17

### Fixed
- **Right-clicking a multi-selection now acts on all of it.** Selecting several files in the
  Explorer and right-clicking one of them deleted a single file — the one under the pointer —
  and the same was true of Copy path. Delete, Open, Cut, Copy, Copy path and Copy relative path
  now apply to everything selected, and Delete says how many it will take ("Delete 3 items").
  Deleting several files asks once, lists what is going, and opens on Cancel; anything that
  can't reach the Recycle Bin is reported together instead of one dialog at a time. Actions that
  can only mean one file — Rename, Open with, Reveal in Explorer, the New/Paste items — are
  greyed out while more than one row is selected, so the scope is visible before you click. The
  Delete key follows the same rule.
- **Same fix on the architecture canvas.** Deleting with several components selected removed
  only the right-clicked one, and one undo now brings the whole group back. Right-clicking a
  component that wasn't part of the selection used to leave the old selection lit up on screen
  while the menu acted on something else; it now collapses onto the component you clicked.
- **Ctrl+click selects more than one component on the architecture canvas.** It never did —
  the click was registered but the extra selection was discarded on the next repaint, so
  rubber-band dragging was the only way to select a group.

## [0.29.3] — 2026-08-12

### Fixed
- **No more flash of the wrong theme at launch.** The window opened on the default look — Aero
  Dark's colours, fonts and panel widths — and only switched to your own theme a moment after
  the app had drawn itself. Your settings now reach the window before its first frame, so it
  starts on the theme you chose.

## [0.29.2] — 2026-08-10

### Fixed
- **Shells on macOS and Linux load your profile again.** Sessions started the shell without
  making it a login/interactive one, so `.zshrc`, `.bash_profile` and anything they set up —
  aliases, PATH, version managers — were skipped. Shells that reject those flags (`dash`,
  `ash`, plain `sh`) are detected and launched without them. Thanks to
  [@Coteh](https://github.com/Coteh) for the fix.
- **Buttons in a dialog that overlaps the top bar respond again.** A dialog's close button —
  and anything else under the top bar's footprint — was being treated as part of the window's
  drag handle, so the pointer moved the window instead of pressing the button. It looked like
  only part of the button worked, and it was worse on Aero and Aero Dark, whose top bar is an
  inset card that reaches further down the window than Neon's. Dialogs, menus and the command
  palette now take the click.

## [0.29.1] — 2026-08-10

### Fixed
- **Images and diagrams open at the right size, without the flash.** Anything bigger than the
  pane used to appear at full size for a moment and then visibly shrink into place. It is now
  sized before it is drawn and fades in, and dragging a zoomed image follows the cursor
  instead of lagging behind it.
- **The diagram zoom viewer actually zooms.** Zoom in raised the percentage but left the
  diagram the same size, and a small diagram opened as a stamp in the middle of a full-screen
  window. It now fills the window on open and every step visibly enlarges it.
- **Wide diagrams stay readable.** A diagram much wider than the column was squeezed to fit —
  the widest ones down to a few pixels tall. They now hold a legible size and scroll sideways,
  very tall ones no longer push the surrounding text off screen, and the button that opens the
  full-screen viewer stays visible on any diagram that needed either.
- **PDFs open fitted, and one after another.** A PDF opens scaled to the width of the pane —
  measured off its widest page, not just the first — and re-fits when the pane resizes instead
  of quietly keeping the old scale. Opening a second PDF while one is already open no longer
  reports the new file as corrupt. Ctrl+wheel zooms, as in any other reader.

## [0.29.0] — 2026-08-07

### Added
- **The full Go to… menu, and it crosses files.** Right-click a symbol for **Go to
  Definition** (F12), **Go to Type Definition**, **Go to Implementations** (Ctrl+F12), **Go to
  References** (Shift+F12), **Peek Definition** (Alt+F12) and **Find All References**
  (Shift+Alt+F12) — with the accelerators shown on the rows, and the peek and reference
  widgets themed to match the rest of the app.

### Fixed
- **Go to Definition on an import now actually resolves.** The project index was built from a
  walk that stopped after 4,000 files of any kind — README files, images, fixtures — before it
  had reached deep source directories, so definitions living there could never be found. It is
  now built from the same gitignore-aware file list the rest of the app uses, with no such cap.
- **"Resolving definition…" can no longer hang forever.** Every navigation has a deadline; if
  it passes, you get told, with a retry, instead of a message that sits there. And when a
  lookup comes up empty only because the project is still being indexed, it says so rather
  than claiming there's no definition.
- **No more flash of unstyled text when opening a file.** Syntax colours are ready before the
  editor is, so a file is coloured from its first frame instead of arriving grey and repainting.
- **Opening a file is no longer slowed down by indexing.** Indexing starts when a project is
  opened rather than when you open your first code file, it leads with the file you're looking
  at and everything it imports, and it no longer builds an in-memory editor document for every
  file in the project.
- **Path aliases resolve.** Projects using `baseUrl`/`paths` in `tsconfig.json` (`@/components/…`)
  can navigate through those imports; the project's own compiler options are honoured.

## [0.28.1] — 2026-08-07

### Fixed
- **Links to files now work in rendered Markdown.** A link written as
  `[src](file:///c:/app/thing.js)` — the form agents and "copy as link" produce — did nothing
  when clicked. So did a plain absolute path like `[src](C:/app/thing.js)`; only links
  relative to the document ever worked. Both are now opened in Conduit like any other file.
- **Frontmatter renders as a proper card again.** A document starting with a `---` block —
  every agent skill file — ran its keys and values together into one unstyled line
  (`namemy-skilldescriptionUse when…`). Keys and values are laid out as labelled rows.

## [0.28.0] — 2026-08-07

### Changed
- **Conduit now runs on a newer foundation:** Electron 43, React 19, the terminal engine's
  version 6 and TypeScript 7, along with the rest of the libraries. Nothing should look or
  behave differently — this is groundwork, and it is called out only because that much of the
  runtime moving at once is worth knowing about if something does seem off.

### Security
- **Dependency upgrade.** Fixes a high-severity advisory in the PDF renderer (arbitrary code
  execution when opening a malicious PDF) and four moderate ones in the diagram renderer
  (script injection, prototype pollution and two denial-of-service paths). Electron and the
  remaining libraries moved to their latest compatible releases.

### Fixed
- **The Explorer no longer flickers while an agent works.** Git-ignored files and folders
  would briefly snap from dimmed to full brightness and back, several times a second, as
  files changed on disk. Each refresh asks git which entries are ignored, and under load that
  question sometimes took longer than its two-second budget — a timed-out answer looks exactly
  like "nothing here is ignored", so the whole folder lit up until the next refresh. Conduit
  now tells a real answer apart from a failed one and keeps the last known result when git
  doesn't reply in time, and it reuses a recent answer instead of re-asking on every keystroke
  of output, so it asks far less often in the first place.

## [0.27.2] — 2026-08-06

### Fixed
- **Four more corners now square off in Neon.** The web view's address bar, the architecture
  canvas's group boxes, its type picker and the Mermaid zoom control all asked for a corner
  step that was never defined, so they silently fell back to a fixed radius and stayed rounded
  in Neon while everything around them squared off. Same defect the "Jump to latest" button
  had, found by sweeping the stylesheet for undefined design tokens.

## [0.27.1] — 2026-08-06

### Fixed
- **The "Jump to latest" button follows the theme.** It was drawn as a literal round-cornered
  pill with a fixed dark shadow, so it stayed round in Neon — where every other control squares
  off and takes a cut corner — and carried a heavy black shadow on the light theme. It now reads
  its shape and elevation from the theme like everything else, and takes Neon's chamfer.
- **The button now appears when you scroll an idle terminal.** It watched only the terminal's
  own scroll event, which does not fire for the mouse wheel — so on a terminal that had stopped
  producing output, scrolling up offered no way back at all.

## [0.27.0] — 2026-08-06

### Fixed
- **Scrolling up to read a working agent no longer strands you.** Scroll back through Claude
  Code's output while it is still generating and the bottom would run away from you: every
  wheel notch down lost ground rather than gaining it, until you were pinned against the top
  of the buffer. Only a keystroke got you back — which also typed into the agent's prompt.
  The cause was the scrollback ring filling up. Once full, the terminal holds the text you are
  reading still by sliding the viewport up as old lines are dropped, so the gap to the bottom
  grew at the speed the agent was writing, and no wheel can outrun that. Scrolling off the
  bottom now shows a **Jump to latest** button that returns you to the newest output and
  resumes following, and the ring holds ten times as much history before it starts dropping.

## [0.26.3] — 2026-08-04

### Fixed
- **The repository picker matches the branch picker beside it.** Open a folder holding more
  than one repository or worktree and the tab row shows two dropdowns. The branch one filled
  the row; the repository one shrank to fit its text, sitting about half the height in the
  middle of the band. They now share the row's height, baseline, corner radius and border, so
  the pair reads as one fixture.

## [0.26.2] — 2026-08-04

### Fixed
- **Neon: the cut corner is the same line as the rest of the border.** It was drawn two pixels
  thick against a one-pixel border, and sat a few pixels inside the cut rather than on it — so
  it read as a separate bar floating over the corner instead of the outline continuing round
  it. The corner now takes its weight from the border it continues and lands on the cut edge.

## [0.26.1] — 2026-08-02

### Fixed
- **Neon: a chamfered button's cut corner matches its own border.** The Relaunch button, the
  confirm and cancel buttons in dialogs, the selected repository row and the danger buttons
  all drew four coloured sides and a grey corner. The corner now takes its colour from the
  element's border directly instead of being coloured separately, so it can no longer fall
  out of step — this is the same defect that was fixed on session cards in 0.25.1, returning
  on every surface whose state set a border colour of its own.

## [0.26.0] — 2026-08-02

One vocabulary for what every control looks like at rest, hovered, pressed, selected and
disabled — applied across the whole app — plus an icon set that follows the theme.

### Added
- **The search bar tells you where you are.** Session results now carry their real icon and
  their state — Busy, Needs you, Review, Idle — and the session you are already in is marked
  with an accent edge and a "Current" chip. It matters most with the Sessions panel hidden,
  when the search bar is the only way to move between sessions. Every state carries a word,
  not just a colour.
- **A pressed state.** No control in the app had one, so clicking a row felt like nothing had
  happened until the view changed.

### Changed
- **Hover means "the pointer is here" — nothing more.** Six surfaces used to answer hover six
  different ways: the view switcher darkened, the git-band icons lit up in the accent colour,
  the Changes/Files tabs did nothing at all, an unfocused tab only brightened its text, a file
  row filled grey, and a search result went accent. Hover is now one neutral wash everywhere,
  and the accent colour is reserved for what the app is actually doing — what is selected,
  current, or armed.
- **Icons follow the theme.** Aero keeps round ends and soft corners; Neon squares them off,
  and seventeen glyphs are drawn differently there rather than merely sharpened. File and
  session icons sharpen under Neon too.
- **Aero: pill corners** on the search bar, the Workspace/Board/Canvas switch and the editor
  tabs.
- **The collapse-sidebar button is gone.** It could only ever collapse one specific panel, and
  panels can be dragged to either side, so it had no stable meaning. Both panels still toggle
  from the command palette, from a right-click on the top bar or either panel, and with
  Ctrl+B / Ctrl+Shift+E.

### Fixed
- **The chrome bands really do line up now.** The side panels drew their edge with a border
  that took up space, so their contents started one pixel below the editor's tab strip — which
  read as a thicker top border. At Compact the top bar also computed to half a pixel, putting
  everything below it off the pixel grid. Under Neon a panel sitting flush beneath the top bar
  additionally redrew that band's edge, doubling it.
- **Neon: the branch picker no longer paints over the tab strip.** Its chip was a pixel taller
  than the row it sits in, so it covered the divider underneath — while hovering, and at rest.
- **The branch menu looks like the rest of the app.** The picker, its filter field and the menu
  now behave like every other field: an edge that is always drawn and brightens through hover
  to open, rather than a fill that appears from nowhere.
- **The branch you are on is no longer the faintest row in the menu.** It was rendered as
  disabled, so the one row the menu exists to confirm was greyed out. It now reads as selected,
  and remains reachable with a keyboard and a screen reader.
- **Hovering the Changes/Files tabs and search results does something.** Neither had any hover
  treatment at all.
- **A selected file is no longer indistinguishable from a hovered one** — they were the exact
  same fill.
- **Disabled controls look disabled, consistently.** There were eight different treatments in
  the app; there is now one.
- **Focus rings follow the shape they are drawn around**, including on tabs, where a leftover
  rule from when tabs were square slabs had been squaring the ring off.

## [0.25.1] — 2026-08-01

Polish across all three themes, from a review of the 0.25.0 build.

### Added
- **Dropdowns are the app's own.** Every picker in Settings and the new-session dialog used the
  operating system's dropdown, which ignored the theme entirely — square corners under Neon, no
  check mark, its own chevron. They now open the same menu the branch switcher uses: themed,
  keyboard-navigable, matched to the width of the field they belong to.

### Fixed
- **Neon: a card's border is one continuous edge.** Selecting a session showed a border on four
  sides but not across the clipped corner; deselecting showed the corner and nothing else. The
  cut corner and the four sides now take their colour from the same place, so every state draws
  a complete outline.
- **Neon: no more cut corners where there is nothing to cut.** The Settings button at the foot of
  the sessions rail and the bottom of the Files rail sit against the window edge, so clipping
  their corner took a notch out of the window itself.
- **Neon: tabs fill their row.** A tab stopped short of the band it sits in, leaving a sliver
  above and below that read as unfinished.
- **Aero: panel borders no longer vanish at the corners.** The fill inside a rounded panel had
  square corners, so it painted over the border along every curve.
- **The chrome bands line up.** The sessions header, the tab row and the Changes/Files tabs were
  three different heights with two different label sizes. They are one band now, and the top bar
  — which was cramped — is half again as tall.
- **The search bar is centred on the window** rather than in the gap between the switcher and the
  window controls, so it stops shifting as those change width.
- **Hovering the selected view no longer makes its label unreadable** — under Neon the text took
  the same colour as the fill behind it.
- **The Repository link in Settings › About opens the actual repository.** It pointed at a
  misspelled owner and 404'd; it now comes from the same place the updater gets releases.
- **A session card shows one icon, not two.** The card already carries the session's own icon, so
  the state also having one read as clutter — the state's word remains.
- **The close button on a tab sits properly at its edge** instead of stranded short of it.

## [0.25.0] — 2026-08-01

A full visual and UX revamp. The six themes are replaced by three — **Aero**, **Aero Dark** and
**Neon** — on a token system that now carries corner shape and material as well as colour. Your
stored theme is migrated, not reset.

### Added
- **The sessions rail tells you what each agent is doing.** Every card now carries a live line
  under its name — the last thing that session actually printed, whether that is
  `Edit webview/styles.css`, a prompt like `Apply edit to router.ts? (y/n)`, or where a shell was
  left — plus one of five states, each with a word as well as a colour: **Busy** (with an activity
  meter), **Needs you**, **Review**, **Idle** and **Stale**. A session waiting on you offers
  **Go to** and **Snooze** on the card itself; Snooze quiets it for ten minutes without answering
  or killing the prompt. A session whose agent finished and left changes behind reads **Review**,
  with the number of changed files and a click straight into Review changes. The rail header counts
  live sessions, and every project group shows its own count.
- **Review changes is a review surface, not a diff dump.** The Review tab now opens with a
  full-height file list down its left side: one row per changed file with a **reviewed checkbox**,
  its status, name, directory and `+n −m`, and a `3 / 6 reviewed` meter above it so you can see how
  far through a changeset you are. Ticking a file — from the list, or from **Mark reviewed** in its
  card header — steps it back so the files you have not read stand out. Each card also gets
  **Split**, which opens that file as a real side-by-side diff. At the foot of the panel,
  **Accept all** stages every changed file and **Discard** throws the working tree away, behind the
  usual confirmation. Reviewing a commit or a comparison instead shows the commit subject under the
  header and hides the footer — there is nothing in a commit to accept. The marks last as long as
  the tab does.
- **The empty state teaches instead of apologising.** Each panel now explains its own emptiness,
  and the centre offers the three real ways to start as a ranked list — **New session**, **Open a
  shell** and **Reopen last** (which names the folder, agent and how long ago). Each row shows its
  keyboard shortcut, and "Open a shell" and "Reopen last" are new rebindable commands rather than
  labels on nothing. A route only appears when it can actually go somewhere.
- **The board keeps count.** Planning and Building can carry a WIP limit, set in the Pipeline panel
  and stored in `.conduit/pipeline.json`; a column at or over its limit says so. A limit is a
  count, never a block — nothing stops you moving a card. Cards an agent has proposed are flagged,
  and cards a proposal would add appear in place as dashed previews until you accept or reject.
- **The architecture canvas states its budget.** A chip reads `48 / 500 nodes · full detail` and
  doubles as a level-of-detail switch: past a threshold, node cards drop port labels, then
  subtitles, then collapse to title-only chips, so a large graph degrades visibly rather than
  quietly getting slow. Agent-proposed components wear the same dashed treatment as the review
  legend that sits above them.

### Changed
- **One less band between you and your code.** The git branch chip and its history / review /
  compare actions moved into the tab row, and the breadcrumb moved inside the code panel. Two of
  the four stacked chrome bands are gone. Board and Canvas are now reached from a **labelled**
  Workspace / Board / Canvas switcher in the top bar rather than three unlabelled icons, and a
  chip beside it counts the sessions waiting on you — hidden entirely when none are.
- **Aero's panels float; Neon's are flush.** Aero sets the window on a tinted ground with detached
  panels, one soft elevation level and a deeper one under the terminal. Neon collapses the padding
  and gutters to zero, squares every corner, notches the bottom-right of filled surfaces and lays a
  scanline over the shell — all of it on a single `--theatre` dial that can be turned to zero.
- **The Changes rail groups what is staged.** Staged and unstaged sections under one
  `5 changes +12 −79` summary, with `M`/`A`/`D`/`U` status letters. Opening a file from the tree
  now actually highlights it — it silently failed before when the path separators disagreed.
- **Settings › Appearance shows all sixteen controls.** The dialog is taller, the theme picker
  draws each theme as a small window (including Neon's notch), and any setting a theme provides —
  interface font, monospace font, code surface, file icons — says whether it is following the theme
  and offers to hand it back.
- **Three themes instead of six: Aero, Aero Dark and Neon.** Midnight, Slate, Nord and Forest all
  become **Aero Dark**, Paper becomes **Aero**, and High contrast becomes **Aero Dark** — your
  chosen theme is migrated, not reset. Each theme now carries its own corner shape, elevation and
  font pair (Aero on Figtree + IBM Plex Mono, Neon on Chakra Petch + JetBrains Mono); switching
  theme applies its pair unless you have picked a font yourself, in which case your pick sticks.
  The editor, terminal and diff panels keep their ink surface in every theme, and the syntax
  palette now follows the theme instead of being one fixed set.
- **Diffs show both line numbers.** Review rows carry the old and the new line number side by
  side, and each hunk is labelled with its real `@@` range — so a change reads without switching
  to a split view. In Aero, the Review surface and rendered markdown now sit on the light page;
  only the code itself keeps the ink surface.

### Fixed
- **Quitting no longer forgets your sessions.** Closing the app wrote the session list to disk
  correctly and then immediately overwrote it with an empty one, as the terminals it was shutting
  down reported their exits. With "Restore sessions" on, the next launch came back to nothing —
  and a saved two-window layout collapsed into one, because a window with no sessions to restore
  isn't reopened.
- **Your file-icon pack sticks.** Picking an icon pack (or setting one in `settings.json`) could
  be silently reset to the theme's default on the next load. A theme switch still updates the
  icons unless you have chosen a pack yourself.
- **A settings change reaches your other windows.** Saving a setting only reached other windows
  when something unrelated happened to broadcast next — for an idle session, possibly never.
- **Back and forward work while the file tree has focus.** `Alt+←` / `Alt+→` (and anything else
  bound to a modified arrow key) were swallowed by the tree's own arrow-key navigation.
- **Go to definition stops landing in the wrong copy of a file.** Projects containing a git
  worktree or agent scratch tree — anything under a dot-directory — were indexed twice, so a
  definition could open a stale duplicate instead of the file you were working in.

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
