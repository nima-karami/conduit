# Conduit — Wishlist

A running intake of feature ideas, small enhancements, and bug fixes. Raw ideas
land here first; the good ones get expanded into full features and an autonomous
implementation plan, then built and verified one at a time.

> **Round 1 (A–G, 31 items)** and **Round 2 (H/I/J, 9 items)** shipped on
> 2026-06-11 — see `docs/builds/2026-06-11-run-report.md` and
> `docs/builds/2026-06-11-round2-run-report.md`. This file now tracks **round 3**.

## How an item moves through here

The main thread is **pure orchestration** — it captures ideas, relays results,
gets decisions, and dispatches the next agent. Every substantive step runs
**inside a subagent** so the main context never fills with research or build churn.

1. **Captured** — the raw idea.
2. **Expanded** — a subagent turns a worthy idea into a real feature: scope, UX, edge cases.
3. **Planned** — a subagent produces an implementation plan. _(FULL items only)_
4. **In progress** — a subagent builds it on a branch; verifies with `npm run verify`
   and, where it's UI, exercises + screenshots via Playwright.
5. **Done** — merged.

---

## Backlog (round 3 — the "mastermind" run)

Sourced from the user's directive (fix the named bugs, fix the many little bugs,
deepen thin features, improve design, develop the northstar) plus three read-only
audits run 2026-06-11: a root-cause pass on the named bugs, a broad quality sweep
(~38 findings), and an architecture review of `autoloop/conduit-northstar`
(verdict: sound — rebase and land it).

| # | Item | Type | Status | Notes |
|---|------|------|--------|-------|
| N0 | Land the northstar branch (rebase onto main, merge) | Foundation | Captured | Review: 2 trivial conflicts |
| K1 | Sidebar collapse flash — settings echo clobbers optimistic toggles | Bug | Captured | Root-caused: host `state` broadcast vs 250ms persist debounce |
| K2 | Save unreliable — global Ctrl+S, save affordance, unmissable errors, read-grant | Bug | Captured | Root-caused: save bound only inside Monaco; out-of-root rejections quiet |
| K3 | Markdown rendered view stale after source-edit + save; stale re-opens | Bug | Captured | Root-caused: `doc.content` prop never refreshed; `!files.has` guard |
| K4 | Renderer papercut batch (8 confirmed defects) | Bugs | Captured | palette scroll, shortcuts-while-typing, lost board edits, DOM nesting, CSS vars… |
| K5 | Host hardening (pty kill race, swallowed write errors, settings validation) | Bugs | Captured | |
| L3 | Editor depth: dirty-close confirm, Save All, Revert File | Feature | Captured | |
| L1 | Git Changes actions actually work (stage/unstage/discard, confirmed) | Feature | Captured | Today's buttons are dead |
| L2 | Explorer create / rename / delete (path-guarded, trash delete) | Feature | Captured | |
| L4 | Terminal find (search addon), clear, right-click copy/paste menu | Feature | Captured | |
| L5 | Global find-in-files panel (bounded host search) | Feature | Captured | |
| L6 | Markdown copy-code buttons + heading anchors | UX | Captured | |
| L7 | Diff viewer: side-by-side/inline toggle + change navigation | UX | Captured | |
| N1 | Proposal mechanism — make "agent proposes / human owns" real | Feature | Captured | ADR 0002 §3's deferred piece |
| N2 | Board↔session linkage — start session from card, status badge on card | Feature | Captured | The orchestration gap |
| N3 | Orchestration status surfaces (spec/proposal badges, queue popover) | Feature | Captured | |
| M1 | Design polish: focus-visible, keyboard reveals, scrollbars, empty states, contrast | Design | Captured | Last — sweeps new surfaces too |

**Sequencing:** N0 first (everything builds on the merged tree) → K1→K2→K3 (named
bugs, shared files) → K4, K5 (sweeps) → L3 → L1 → L2 → L4 → L6 → L7 → L5 →
N1 → N2 → N3 → M1 (last). Serial run (one tree, Windows + node-pty).

---

## Expanded features

_Detailed write-ups land in `docs/specs/` as items are built (one subagent per item)._
