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
