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

- **`readBlob` swallows non-ENOENT read errors for most persisted-state files.**
  `readBlob` (`src/config.ts`) treats "unreadable" and "absent" identically, and
  `electron/main.ts` still reads `sessions.json`, `docs.json`, `repos.json`, `windows.json`,
  `review-marks.json`, `timed-messages` and `settings.json` through it (`projects.json` and the
  launchers file already use `readFileState`, which keeps the distinction). Each caller has its
  own dirty/persist gate, so no known path loses data today — but the shared helper is one gate
  away from repeating the 0.11.1 incident (empty in-memory state flushed over an intact file).
  Move the remaining callers to `readFileState`, with a durability test per caller.

- **`Segmented` (settings modal) and `SegmentedRadios` (Review scope) are twins.**
  `webview/components/segmented-radios.tsx` is a proper `role="radiogroup"` with arrow-key
  navigation; `settings-modal.tsx`'s older `Segmented` is the same control without the a11y.
  Folding the latter into the former is an accessibility win, but it changes settings-modal
  semantics.

- **`goto-index.e2e.mjs` cannot pass from any worktree under a dot-directory.** It asserts the
  resolved path contains no `/.<dot-dir>/` segment, so every run from `.claude/worktrees/**` fails
  by construction while being green in a normal checkout. Worth a guard or a scenario fix so a
  worktree lane doesn't read it as a navigation regression.

- **Diff contrast is unmeasured at a lowered `codeOpacity`.** Every floor in the 2026-08-31
  review-fidelity work is asserted at the default opacity, where the diff body is opaque and a
  Review row composites on `--code-base` exactly. Neon is the only theme with `--theatre` lit, and
  a user who turns the code surface translucent puts the shader backdrop underneath the row wash.
  Worth measuring the add/remove row and the `+`/`−` glyph at, say, 0.85 and 0.7 opacity and
  deciding whether the floors need a second surface, the way `.theatre`'s scanline film has one.

- **Monaco widgets read the wrong token scope on Aero.** `ensureTheme`
  (`webview/monaco-theme.ts`) resolves its tokens at `document.documentElement`, but the editor
  lives inside `.termwrap`, which Aero re-scopes to the ink tiers. So on Aero the find widget and
  the peek views paint in the *page* tiers (`--raise: #ffffff`) over an ink editor. The proper fix
  is `ensureTheme(code?, host?)` reading `getComputedStyle(hostEl)`, which drags in restating
  `--focus-ring*` in both the ink block and `.docpage` — a cross-cutting token change that needs
  its own lane. Same mispairing, same file: `peekViewTitleLabel.foreground`,
  `peekViewResult.lineForeground`, `peekViewResult.selectionForeground` and
  `list.activeSelectionForeground` are all `--syn-default` on `--raise` surfaces.

- **Robustness phases 2–3 were never specced.** Phase 1 (host git layer) shipped as
  `docs/specs/archive/2026-07-07-git-host-robustness.md`. Left open from the 2026-07-07 audit:
  client-side graceful states for git IPC (timeouts, loading/error/retry, request epochs
  cancelling stale switches, commit-file-list virtualization) and explorer/multi-repo perf (row
  rebuild memo, symlink guards, watcher→rescan decoupling). Some pieces have since landed
  piecemeal (`detectRepos` is async, `src/with-timeout.ts` exists), so re-audit before speccing.
