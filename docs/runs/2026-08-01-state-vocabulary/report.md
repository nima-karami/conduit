# Run report — 2026-08-01 state vocabulary + chrome polish

Base `bcf0d15` (v0.25.1) → head after lane B and B-1. Seven lanes, all shipped, none
quarantined. Unit tests 2386 → 2547. Biome warnings held at the pre-existing 12.

## Shipped

| Lane | What | Merge | Build |
|---|---|---|---|
| S | Collapse-sidebar button removed | `7da0a11` | `beac69f` |
| I | Theme-coupled chrome icons | `fb48cc3` | `7071e7a` |
| V | Interaction state vocabulary | `dbe4032` | `40bb563` |
| P | Session state in the search bar | `7cffc5a` | `f66616d` |
| G | Branch picker reads as a field | `3150a40` | `a9ff47e` (+ `4e4c793`) |
| RC | Aero pills + Neon content glyphs | `8543f64` | `dcccf29` |
| B | Band baseline alignment | `6b411d6` | `9cf1a4e` (+ `1dc970f`) |

Every merge was verified on the **merged tree**, not only in its worktree.

## The headline numbers

- Hover fill values **27 → 17**. Of the 17, three are the vocabulary's own tokens; the
  other 14 are legitimately not interaction state (scrollbar thumbs, resizer hairlines,
  amber session *status*, red danger, two canvas one-offs), each allow-listed with a
  reason.
- `:disabled` treatments **8 → 1**.
- ~60 bespoke state rules deleted rather than supplemented.
- Two surfaces gained a hover they never had (`.rtab`, `.palette__row`); one dead rule
  removed (`--hover` was referenced and never defined).

## What the run is actually worth

The instructive part of this run is not the diff. It is that **three separate lanes
shipped CSS that was correct by every automated gate and wrong on screen**, and each was
caught only by looking at a screenshot:

1. **V** placed the vocabulary near the top of the sheet, following the spec's (wrong)
   claim that it was a zero-specificity floor. Lint, typecheck and ~2500 unit tests were
   green on a stylesheet where hover did nothing at all.
2. **G** put a border on `button.git-indicator__seg` — an element+class compound that
   out-ranks the ladder — which silently ate both the hover and open states. Green again.
3. **B** was handed a prescribed `box-shadow: inset` fix by the conductor. It measured
   instead of complying: the panel's fill is an opaque *child*, and descendants paint over
   an inset shadow, so the hairline vanished while the alignment "passed".

A loop that could only read green unit output would have shipped all three. This is the
argument for the visual harness being a gate, not a nicety.

## Corrections to the conductor's own spec

- The `:where()` role lists are **not** a zero-specificity floor. Each compound is worth
  exactly what its trailing state pseudo-class adds — one class — which *ties* a
  component's rest rule and *loses* to every modifier deviation. The section's position is
  therefore load-bearing. Recorded in the spec's Mechanism section and as **V-3**.
- The Compact half-pixel origin did **not** smear hairlines. Chromium pixel-snaps 1px
  borders at paint. The real defect was fractional *layout* (`.sidebar__head` at
  `top 69.5 / bottom 100.5`). Lane B declined to repeat the false claim in its comment.

## Forks raised and ruled

`blockers.md` carries all seven with reasoning: **I-1** (Compare redrawn onto the 16 grid
— kept), **I-2** (content tier sharpened by CSS, never a family swap — became lane C),
**V-1** (Neon hover stays neutral), **V-2** (V integrates before B), **V-3** (section
position is load-bearing), **G-1** (band chips take a real border, reversing V — kept;
`box-sizing: border-box` means a border costs no height), **B-1** (a panel flush under the
top bar must not redraw that band's edge — shipped in this run, since it was the user's
reported defect surviving from a second cause).

## Defects found that nobody reported

- Several chrome glyphs' dots were **zero-length subpaths** (`M6 8.5h.01`) visible only
  because of a round cap. Switching Neon to `butt` made the agent's eyes, the server's
  LEDs and the browser frame's title-bar dots render as *nothing*.
- The **current branch was rendered `disabled`**, making the one row its menu exists to
  confirm the faintest thing in it. The same treatment now keys off `aria-checked`, so the
  commit picker inherited the fix.
- `.tab:focus-visible { border-radius: 0 }` survived from when tabs were square slabs and
  had been squaring the focus ring around a rounded tab ever since.
- `.filerow--revealed` overrode `.filerow--selected` purely by source order.
- An off-palette hardcoded `rgba(217, 119, 92, 0.5)` in the composer's focus ring.
- 28 comment lines in `styles.css` were **mojibaked** by a PowerShell round-trip in an
  earlier run (em dash and ellipsis double-encoded), committed as far back as v0.25.1.
  Repaired in `1dc970f`. The conductor reproduced the same corruption mid-run and caught
  it — `Get-Content`/`Set-Content` in PowerShell 5.1 reads UTF-8 as ANSI and adds a BOM.
  **Never round-trip a source file through PowerShell.**

## Smoke suite — 70 / 72

Run in four batches (the runner's filter is a substring OR, and the full suite outlives
a foreground window).

- **69 passed outright.**
- **`git-blame`** errored under batch load and **passed in isolation** — a load flake,
  the same one seen at the 0.25.1 gate.
- **`markdown-viewer`** and **`paste`** fail *reproducibly*, both on a clipboard
  assertion returning empty. **Not caused by this run:** both fail identically when
  checked out at `bcf0d15` (v0.25.1, the shipped build) and run in a clean worktree.
  This is clipboard access being unavailable to a hidden Electron on this machine, not
  a regression. Nothing in this run touches clipboard code — but that was verified
  against the baseline rather than assumed.

## Open follow-ups

- **The tab focus ring is clipped** top and bottom by `.tabbar`'s `overflow-y: hidden`.
  Pre-existing; lane RC's pill makes it more visible. Deliberately not forwarded to lane B
  mid-flight rather than widen a delicate 1px fix.
- **Trim the vocabulary section's header comment** to a pointer now that the specificity
  argument lives in the spec and in V-3; `CLAUDE.md` says the code keeps only the gotcha.
- **Stale** is the one session state with no screenshot evidence — no reliable route to a
  not-running session exists from the live app. Covered by unit tests only.
- Carried from the previous run and still open: a `--warn` token slot (now a fourth
  caller), canvas virtualization, `--r-window` on the OS window.

## Process notes

- `merge.autoStash` plus a dirty ledger, and concurrent worktree git operations, both
  produced `index.lock` failures mid-merge. Commit the ledger before merging.
- Worktree `node_modules` are junctions to the shared tree. `git worktree remove --force`
  follows them and deletes the **shared** modules — `cmd /c rmdir` the junction first.
