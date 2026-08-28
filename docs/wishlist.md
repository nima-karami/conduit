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
