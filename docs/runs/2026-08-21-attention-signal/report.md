# Run report — 2026-08-21 attention-signal

User report: the "needs you" pings are useful but fire when there is nothing to
show, and keep re-firing. Investigation → spec → build → adversarial review →
revision. **Released as v0.33.0 (2026-08-21)** — CI verify + Release green, installer published.

Spec: `docs/specs/2026-08-21-attention-signal-quality.md` (contract + acceptance
matrix). Plan: `docs/plans/2026-08-21-attention-signal-quality.plan.md`.

## What was wrong

The detector's only input was "any output, then 1.5 s quiet, on any session but
the single globally-focused one". No waiting-for-you concept, no episode latch on
the badge (a repainting TUI re-pinged forever), one global focus id (multi-window
and split-pane sessions on screen got flagged), spawn banners pinged, exited
sessions "finished".

## What shipped

- **Qualifying runs**: attention arms only after a substantial run (≥2 s sustained
  or ≥1 KiB) ends with ≥4 s quiet; runs end at idle (busy-window boundary), so
  unrelated bursts and mid-turn tool dribble can never merge into one.
- **Episode latch**: one ping per episode across badge, float-to-top, chip, flash,
  OS notification; viewing acknowledges; re-arming requires a new qualifying run
  or bell. (The old per-surface `osNotified` guard is deleted, subsumed.)
- **Bare BEL arms immediately** — OSC/DCS-aware scanner with per-session carry
  across PTY chunk boundaries (a split `ESC ]0;title BEL` cannot fabricate a bell).
- **Per-window visible sets** (active + split) replace the global focus id;
  `focus` → `visible` protocol; window close drops its set.
- **Spawn grace (5 s)** and exit suppression; `recordExit` after `forget` no
  longer resurrects entries.

## Verification

- Unit: 39-case state-machine matrix + 33 bell/last-line cases; full suite 2878
  passed / 203 files. Verify exit 0 (evidence
  `.autoloop/evidence/attention-signal-*.txt`).
- E2E (real app): `attention-signal` 12 rows hidden (spinner-forever, CC-turn
  shape, ack-then-dribble, 3 s dribble, run-boundary echos, BEL, OSC-title BEL,
  spawn banner, split-visible, exit) + `attention` visible-window OS-surface legs.
- Red proofs: trivial-burst and ack-then-dribble rows red on pre-fix build; the
  run-boundary row red on the pre-revision build (it is the D1 regression guard).
- Review: REVISE → 3 defects fixed (D1 run-never-ends — the big one, found by
  hand-simulation after the first build was green everywhere; D2 chunk-split bell
  fabrication; D3 entry resurrection leak) → re-verified.

## Known limits / follow-ups

- Real Claude Code is not driven in the suite (auth/nondeterminism); scripted
  byte patterns model it. Constants are exported for cheap tuning against daily
  use.
- A minimized/hidden window still counts as "visible" for exemption (spec wording;
  noted divergence from "on screen").
- Contract 6's not-running guarantee is implemented via `term:exit` only; the
  machine has no session-status input (incidental today).
- `bytes` are UTF-16 code units, not bytes (documented; harmless at the 1 KiB
  threshold).
- Deferred by design: prompt-shape parsing, renderer emulator-mode reporting,
  OSC 9/777.

## Lesson

The first build passed 34 unit cases, 11 e2e rows, and full verify with D1 —
"runs never end at idle" — sitting in plain sight: every "must not arm" test
drove exactly one burst per episode. The adversarial review's hand-simulation
found it, and the fix's regression row failed red against the green build. Green
suites prove the cases someone thought to write.
