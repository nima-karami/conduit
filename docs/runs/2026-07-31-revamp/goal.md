# Run: Conduit visual & UX revamp

**Started** 2026-07-31 · **Mode** autonomous build loop, unattended · **Conductor** Claude Opus 5
(1M) in this session · **Subagents** Opus only (never Sonnet — see repo memory).

## Goal

Implement the Claude Design handoff (`docs/design-handoff/revamp/`) inside Conduit's existing
renderer: replace the six shipped themes with three (**Aero**, **Aero Dark**, **Neon**), introduce
the two axes the token system lacks (**shape**, **material**), and rebuild the screens on the new
language.

Source of truth, in precedence order:

1. `docs/design-handoff/revamp/spec/Conduit Token Contract.txt` — every token, three themes.
2. `docs/design-handoff/revamp/spec/00-README.md` — geometry, chamfer rule, status system,
   theme↔font coupling, registry edits.
3. `docs/design-handoff/revamp/frames/*.png` — the rendered designs (see `FRAMES.md`).
4. Per-screen notes in `spec/Conduit <screen>.txt`.

## Phase 0 — grounding (done, 2026-07-31)

| Gate | State |
|---|---|
| One-command verify (`npm run verify`: format, lint, dead-code, duplication, typecheck, tests, SAST, audit, secrets) | **green at baseline** `ecff720` |
| Deterministic checks + CI + pre-commit | present (ADR 0001, 0004) |
| Real-runtime e2e (`npm run test:smoke`, 70+ scenarios on `test/e2e/harness.mjs`) | present |
| **Visual observation harness** | **added this run** — `npm run shots` (`test/e2e/visual/`), drives the real app hidden at 1320×820 (the design frames' native size) against a self-built fixture repo with real history, a dirty worktree and `.conduit/` artifacts |

`solidify-repo` was not re-run: the repo already satisfies every category it audits (instruction
files, deterministic gates, one-command verify, security gate, runtime QA), evidenced by the green
baseline above. Recorded as a right-sizing decision, not a skip.

## Non-negotiables for every lane

- **Never weaken a gate.** `npm run verify` must be green before a lane reports done.
- **Evidence is a screenshot from the real app**, captured with `npm run shots`, not a claim.
- **Theme owns shape + material only. Density owns spacing + size.** A theme block that sets a
  height or a padding is a defect (token contract, "Density — the axis this contract nearly broke").
- **Do not "fix" the three signed-off sub-4.5:1 contrast values** (`--syn-comment`,
  white-on-`#d6922a`, `--syn-keyword`).
- **No redundant comments** (repo CLAUDE.md). Comments explain *why*.
- Lanes work in a worktree **outside the repo** (`%TEMP%\conduit-wt\<lane>`) — a worktree inside
  the checkout breaks `biome check .` with a nested root config.
