# Run report — 2026-09-01 timed-messages polish

**Status: COMPLETE.** All three merged to `main`. User report on the shipped
timed-messages feature (v0.36.x): the dialog scrolls in a way that doesn't make sense,
Neon's chamfered corner is broken on it, arming needs edge-case coverage (parallel
sessions, minimized app, backgrounded session tab), and the command palette can't find
"Send timed message…" by synonym ("interval", "schedule", "timer"). Three build items,
run without further check-ins; `npm run verify` deferred to the very end across all of
them, not per-commit (per the user's explicit instruction).

## What shipped

### The dialog no longer scrolls, and Neon's chamfer is fixed — same root cause

`.tmdlg` carried `max-height: 82vh; overflow-y: auto;`. Switching the "When" trigger
(In / At / Every) changes the composer's height, and past a point the whole card
started scrolling — one dialog, several different heights depending which trigger was
open last.

On Neon that broke the chamfer too, and it's the same bug: the cut corner is an
absolutely-positioned `::after` pinned to the surface's own bottom-right corner. On a
scrolling element that corner is the bottom of the *content*, not the visible clipped
box — a failure mode already documented at `.ctxmenu` (styles.css ~6495), which solves
it by splitting a fixed frame from a scrolling inner region. `.tmdlg`'s content is
provably bounded (composer + at most `MAX_PER_SESSION = 3` schedule rows), so the fix
here is smaller: no overflow at all, sized to content, matching `.compare-dialog`'s
existing convention instead of `.ctxmenu`'s split-region one.

No prior e2e ever opened the dialog UI — `timed-messages.e2e.mjs` posts `timer:set`
directly and only touches the chip. New scenario
`test/e2e/timed-message-dialog-ui.e2e.mjs` opens the real dialog via the chip, switches
theme through the real command (`>Theme: …`, not a DOM poke — the app's own effect
overwrites a poked `data-theme`), walks all three trigger tabs, and asserts
`scrollHeight`/`scrollWidth` never exceed `clientHeight`/`clientWidth` (2px tolerance for
sub-pixel rounding) plus that Neon's `::after` actually paints.

Verified: `timed-message-dialog-ui`, `timed-messages`, and `chamfer-edge` e2e scenarios
all green, run individually.

**Commit:** `6b9aac5`.

### Command palette: keyword search

`PaletteEntry` gained an optional `keywords?: string[]` — never rendered, purely for
discoverability. Matching moved out of the palette's inline `groups` memo into an
exported `rankEntries(source, term)`: a title match is always tier 0, a keyword-only
match is tier 1, and tier always beats raw fuzzy score — so a real title match can never
be pushed down by someone else's synonym hit. Keywords were added across the Commands
and Settings groups; `cmd:timedMessage` ("Send timed message…") carries `interval`,
`schedule`, `timer`, `delay`, `repeat`, `reminder`, `continue`, `auto-resume`, etc. —
the concrete case the user named.

New `test/unit/command-palette.test.ts` (first test to touch this component): keyword
match found where the title isn't a fuzzy subsequence at all; a title match outranks a
keyword match even when the keyword's raw fuzzy score is higher; no-match entries
dropped; keyword-only matches ranked among themselves by score; empty-query behavior
unchanged (verified, not assumed — `fuzzyScore('', t)` still matches every title, so
everything stays tier 0 in source order).

Verified: new test file green (6/6), full unit suite green (249 files / 3828 tests),
`tsc -p tsconfig.webview.json --noEmit` clean, re-checked again after merge.

**Commit:** `10b338c` on `autoloop/palette-keywords`, merged to `main` as `dc04c4a`.

### Timer edge-case coverage — and a real defect it found

Three edge cases had no test coverage: two sessions each with their own armed
schedule coming due in the same `evaluate()` pass, a fire while the whole app window
is minimized, and a fire on a session that is running but not the active/visible tab.
`TimerScheduler` is host/Electron-free by design (every dependency injected), so the
cross-session logic is proven at the unit level; the minimize/backgrounded-tab cases
need the real app and a real PTY, so those are new e2e.

**Real defect found and fixed, root cause, in `src/timer-scheduler.ts`'s `arm()`:** a
schedule already due while its session sits inside the post-PTY-start settle window
(the brief hold-off after a shell starts, so nothing types into a prompt that hasn't
printed yet) was armed at `max(nextAt, now) === now`. `evaluate()` deliberately skips
a schedule inside that window, so the 0 ms timer just called `evaluate()` → `arm()` →
itself again — a busy loop on the main process for up to `PTY_SETTLE_MS` (3 s) every
time this combination occurred. Fixed by flooring a schedule's earliest actionable
instant by its own session's settle expiry. A unit test (`sleeps until the settle
expiry rather than spinning a zero-delay timer`) was written first and observed red
(`expected 0 to be 2000`) before the fix landed.

**Unit** (`test/unit/timer-scheduler.test.ts`, +7 tests, existing interleaving harness
generalized to tag writes per session): each session gets only its own message when
both are due in one pass; a dead session evaluated first doesn't block a live one's
fire; one session's settle window doesn't hold another back; a stalled write on one
session's queue doesn't stall another's; disposing one session leaves the other armed;
the settle busy-loop regression above.

**E2E** (new `test/e2e/timed-messages-concurrency.e2e.mjs`, real app + real PTYs):
(A) two sessions armed, clock-seam-advanced into the same evaluate pass — each
session's stdin reader confirms it received only its own message + Enter, never the
other's; (B) `BrowserWindow.minimize()`, `isMinimized()` re-checked at assertion time
(so the proof can't come from an implicit restore), schedule still fires into the real
PTY; (C) session A selected/active, session B running but backgrounded (its pane
mounted but not the visible tab) — B's schedule still fires into B's own PTY.

Verified: `npx vitest run test/unit/timer-scheduler.test.ts` (48/48, was 41 before);
`node test/e2e/run-smoke.mjs timed-messages` — both `timed-messages-concurrency` and
the original `timed-messages` scenario green, run together on the merged tree;
`tsc -p tsconfig.json --noEmit` clean.

**Commit:** `d187ce8` on `autoloop/timer-edge-cases`, merged to `main` as `18dd322`.

## Verification

Scoped tests/typecheck run after each merge (see each section above), never the full
gate, per the user's explicit instruction. `npm run verify` run once at the very end,
across the merged set:

- `check` (biome) — 0 errors, 17 pre-existing warnings (none in files this run touched).
- `typecheck` — both tsconfigs clean.
- `build` — clean.
- `test:unit` — 3835 passed, 2 skipped (249 files) — the same 2 pre-existing skips as
  before this run.
- `fallow:check` — Dead Code section empty. `dev dependencies in production`
  (react/react-dom) and duplication are both pre-existing, non-gating findings,
  unrelated to anything touched this run (confirmed: neither dependency classification
  nor any duplicated block traces to a file this run changed).
- `audit` — 2 moderate advisories (dompurify via monaco-editor's own dev tooling),
  below the `--audit-level=high` gate.
- `security` — gitleaks: no leaks found. Semgrep skipped locally (no Docker/semgrep on
  PATH; runs in CI per its own message) — expected, not a failure.

**Green end to end. No gate weakened, narrowed, or skipped to get there.**
