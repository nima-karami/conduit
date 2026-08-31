# Conduit — Wishlist (inbox)

Raw, un-triaged ideas land here first. This is an **inbox, not a tracker** — it
holds things that haven't been built yet. Once an item is picked up it leaves
this file:

- **Promoted** → a spec in `docs/specs/` (see `docs/specs/INDEX.md`).
- **Shipped** → recorded in `docs/runs/<date>-<name>/report.md` with evidence + SHAs.
- **In a live build** → tracked in `.autoloop/tasks.yaml` (run state, gitignored).

So don't track status here — delete an item once it moves on. History of what
shipped lives in `docs/runs/`, not here.

## Captured

Goal lens: [[conduit-daily-driver-goal]] — make Conduit usable enough to live in.

- **Terminal still reported "stuck" with the agent idle.** v0.27.0/v0.27.1 fixed two real
  mechanisms (see `docs/runs/2026-08-06-terminal-follow/report.md`), but the originally
  reported symptom — scrolled up, agent has *stopped* producing, still cannot reach the
  bottom — was never reproduced, including against real Claude Code in the real app. Leading
  untested hypothesis: the buffer is genuinely at the bottom and the **WebGL renderer is
  showing stale pixels**, which every buffer-index measurement would miss by construction; a
  keystroke forcing a repaint fits. Discriminator is already shipped — if "Jump to latest" is
  visible the buffer really is scrolled up; if it is absent and the screen still looks frozen,
  it is the renderer. Needs a real-session observation before any fix.

## Spec-ready (promoted → see `docs/specs/INDEX.md`)

_(none active)_

> **Rejected 2026-06-23:** the agent chat UI, skill installer, and interactive plans were built
> on the `chat-ui` branch and then discarded — they drove Claude Code via the Agent SDK, which
> requires a billed API key and **cannot use a Pro/Max subscription**. See [[conduit-chat-ui-run]]
> and `docs/plans/2026-06-23-north-star-roadmap.plan.md`. Revisit only via a raw `claude` CLI
> adapter (subscription auth).

---

_Shipped batches (history in `docs/runs/`): round-6/7 (2026-06-15); round-8; **round-9**
daily-driver `D1–D10` + Tier-1 `T1A`/`T1B` (`docs/runs/2026-06-16-daily-driver/`, 8 done + 4
committed-needs-human-smoke); **daily-driver-2** `E1–E3` live-cwd + breadcrumbs
(`docs/runs/2026-06-16-daily-driver-2/`). Open human-smoke recipes for the round-9
`needs-human-smoke` items (D2/T1A/T1B/D5) live in `.autoloop/blockers.md` — and are exactly
what W1 automates. **2026-06-17-night** (`docs/runs/2026-06-17-night/`): macOS test build +
installer branding + image-viewer zoom/diffs (shipped in **v0.1.13**); D11 was found already
shipped. Deferred from r7: "rename Conduit→Claude Code" (keystroke-injection
footgun) and the CLI-/rename ambient-title tradeoff. **2026-06-19-wishlist**
(`docs/runs/2026-06-19-wishlist/`): cwd-card + group-reorder bugs, logging (Slice A+B),
git-history commit graph (Slice A+B), **multi-window** (Slice A+B+C: many windows, move a live
session across windows with no PTY restart, cross-window drag + tear-out, and layout persistence
across restart), and the **git branch switcher** (indicator Slice B, D-1 approved: refuse-if-
busy/dirty out-of-band checkout) — now all on `main` (the `git-run` working branch was folded
into `main` and removed 2026-06-22). Remaining: the chat-ui/skill-installer/interactive-plans work
awaits integration decision (D-2) — built on the `chat-ui` branch but never merged into `main`;
worktree-switch-in-place + further multi-window polish are vision._

- **`readBlob` swallows non-ENOENT read errors for every persisted-state file.**
  `electron/main.ts` treats "unreadable" and "absent" identically for `sessions.json`,
  `docs.json`, `repos.json`, `windows.json` and `review-marks.json`. Each caller now has its own
  dirty/persist gate, so no known path loses data today — but the shared helper is one gate away
  from repeating the 0.11.1 incident (empty in-memory state flushed over an intact file). Worth
  distinguishing ENOENT from a real read failure at the source, with a durability test per caller.
  Surfaced by the Lane B code review, 2026-08-27; deliberately out of that lane's scope.

- **`Segmented` (settings modal) and `SegmentedRadios` (Review scope) are twins.**
  Lane D added `webview/components/segmented-radios.tsx` as a proper `role="radiogroup"` with
  arrow-key navigation; `settings-modal.tsx`'s older `Segmented` is the same control without the
  a11y. Folding the latter into the former is an accessibility win, but it changes settings-modal
  semantics, so it was deliberately left out of Lane D. Surfaced 2026-08-27.

- **`npm run verify` cannot see a literal NUL (or other C0 control char) in a source file.**
  Two NUL bytes slipped into string literals while building Lane C and stayed green through
  biome, both tsconfigs and 3 434 tests; the builder found them by eye. This is the second
  occurrence (the first is recorded in the 2026-07-01/02 solidify-polish run). A one-line scan in
  the `tools/secret-scan.mjs` style would close it. Surfaced 2026-08-27.

- **`hover-obstruction.e2e.mjs` silently requires the repo it opens to be dirty.**
  It asserts on `.change` rows in the Changes list but never seeds a change, so it passes or
  fails depending on whether the working tree happens to be dirty — it failed at the known-good
  `99c9afb` with a clean tree, and passed mid-run only because a lane was in flight. The scenario
  should create its own uncommitted change. Latent test fragility, not a product defect; surfaced
  while bisecting the 2026-08-27 session-bootstrap regression.

- **`markdown-viewer.e2e.mjs` asserts on the real OS clipboard.**
  It copies, then reads back with Electron's `clipboard.readHTML()` — a global Windows resource
  any other process can clobber between write and read. It passed and failed on identical code
  within the same hour on 2026-08-27/28. Neither the scenario nor the markdown copy path has
  changed since the v0.34.0 baseline. Same class as the `hover-obstruction` fragility: the
  scenario should assert on what the app put on the clipboard (spy the copy call), not on what
  the OS clipboard happens to hold N ms later.

- **Six smoke scenarios are red on `main` because they write to a PTY before cmd.exe has a console.**
  `scrollback`, `paste`, `terminal-drop`, `attention-signal`, `markdown-viewer` and
  `hover-obstruction` fail on unmodified `main` on this machine — verified 2026-08-28 by building a
  second worktree from `main` and running them there. `scrollback`'s cause was diagnosed: the
  scenario posts `term:input` the moment a session reports `running`, but ConPTY drops input
  written before the console initialises. The timed-messages e2e hit the same race and fixed it by
  waiting for the shell prompt before writing — three lines. Applying that wait to the other
  scenarios would make the smoke suite trustworthy again, which matters because these failures have
  twice been misread as product regressions. (See also the existing loaded-machine note in
  CLAUDE.md — that is a *different*, additional cause.)
- **`goto-index.e2e.mjs` cannot pass from any worktree under a dot-directory.** It asserts the
  resolved path contains no `/.<dot-dir>/` segment, so every run from `.claude/worktrees/**` fails
  by construction while being green in a normal checkout. Worth a guard or a scenario fix so a
  worktree lane doesn't read it as a navigation regression.

- **Diff contrast is unmeasured at a lowered `codeOpacity`.** Every floor in the 2026-08-31
  review-fidelity work is asserted at the default opacity, where the diff body is opaque and a
  Review row composites on `--code-base` exactly. Neon is the only theme with `--theatre` lit, and
  a user who turns the code surface translucent puts the shader backdrop underneath the row wash —
  which shifts the whole composite table and is a configuration people really run. Worth measuring
  the add/remove row and the `+`/`−` glyph at, say, 0.85 and 0.7 opacity and deciding whether the
  floors need a second surface, the way `.theatre`'s scanline film now has one.

## Monaco widgets read the wrong token scope on Aero (found 2026-08-31, T4)

`ensureTheme` (`webview/monaco-theme.ts`) resolves its tokens at `document.documentElement`, but
the editor lives inside `.termwrap`, which Aero re-scopes to the ink tiers (`styles.css:3386`).
So on Aero every Monaco widget — the find widget and the peek views — paints in the *page* tiers
(`--raise: #ffffff`) on top of an ink editor: a white bar over a dark editor.

Pre-existing, not introduced by T4, which made the widget internally coherent instead (everything
it paints now resolves at `:root`, matching what Monaco read) rather than widening the fix.

The proper fix is `ensureTheme(code?, host?)` reading `getComputedStyle(hostEl)` — but that drags
in restating `--focus-ring` / `--focus-ring-inset` / `--focus-ring-color` in both the ink block and
`.docpage`, which changes the focus ring for every control inside `.termwrap` on Aero. A
cross-cutting token change that needs its own lane.

Same mispairing, same file, untouched: `peekViewTitleLabel.foreground`,
`peekViewResult.lineForeground`, `peekViewResult.selectionForeground` and
`list.activeSelectionForeground` are all `--syn-default` on `--raise` surfaces.
