# Run report — timed messages (2026-08-28)

**Status: COMPLETE.** Merged to `main` as `c029f4f`. Spec `docs/specs/2026-08-28-timed-messages.md`,
plan `docs/plans/2026-08-28-timed-messages.plan.md`.

The ask: *"When running Claude Code I hit the usage limit and have to wait for the reset, then come
back and manually send a message to continue. I want Conduit to send a message to a specific
session on a timer or interval — open it from the command bar, type the message, choose timed or
interval, make it active. Once active, show a hovering icon over the terminal. If nothing is
active, no icon."*

**Tests: 3514 → 3706.** Verify green on the merge; `timed-messages`, `session-bootstrap`,
`durability` and `quit-guard` e2e green on merged `main`.

## What shipped

A schedule is composed from the command palette for a specific session, fires after a **delay**, at
a **clock time**, or on a **repeating interval** with a required max-repeat count, and is delivered
by the host writing into that session's PTY and pressing Enter. While something is armed, a chip
sits over that session's terminal showing the countdown; it opens the manage dialog and carries
cancel / edit / renew / send-now. Nothing armed, no chip. Schedules persist in
`userData/timed-messages.json` and survive restart.

**Limit-aware auto-resume** is on by default: when a session's own output ends with Claude Code's
usage-limit notice, Conduit parses the reset time it prints and arms a `Continue` for that moment,
shown with a distinct `Auto` treatment and one-click cancel.

### Four product decisions you locked, and how they landed
1. **Both triggers** — manual timer/interval *and* limit-aware auto-resume. Shipped.
2. **Send and press Enter, always**, not gated on bracketed-paste mode. Shipped as chosen. The
   consequence is recorded in the spec: a fire that lands while the terminal sits at a bare shell
   prompt is executed as a shell command. Two mitigations that don't reintroduce the gate: the
   message is sanitised host-side to a single line with C0/C1/ESC stripped and a length cap, and a
   message is *never* derived from terminal output — an auto-armed resume always sends the constant
   `Continue`.
3. **Max repeats only**, no idle gating. Shipped.
4. **Persist and fire on relaunch.** Shipped, with one correction forced by the code (below).

## Two conductor corrections

**"Fires on relaunch" had nothing to write into.** The architecture review verified that restored
sessions come back `stale` (`persistence.ts:37`), panes mount only for `running`
(`center-pane.tsx:123`), a hidden pane never posts `term:start` (`terminal-pane.tsx:544`), and
`autoRelaunchStale` is false by default — so after a restart there is no PTY for any session and the
spec's own restart scenario could not have passed. Resolved: a fire **requires a live PTY**;
otherwise the schedule enters `waiting`, writes nothing, and delivers once when that session comes
up. The host deliberately never spawns a PTY itself — a host-spawned PTY is a bare shell, which
would turn decision 2's accepted risk into a certainty on every overnight catch-up.

**Auto-resume defaults to armed, not to an offer.** The draft defaulted to offering, which requires
you to be present — defeating the feature. Kept `arm` as the default and gated the *arming*
instead: the notice must be in the session's output **tail**, and there is at most one auto-armed
schedule per session (replaced, never accumulated).

## What the reviews caught that green gates missed

The architecture review returned REVISE with three blockers; the code review returned
FIX-THEN-MERGE with thirteen. `npm run verify` was green before both. The five that mattered most,
all on the path that types into your terminal unattended:

- **Concurrent deliveries interleaved into one garbled executed command** — and it was
  *deterministic* on the restart catch-up path, where every waiting schedule for a session becomes
  deliverable at the same settle expiry. Now serialised per session.
- **Auto-arm could fire from a dead child's output.** `PtyHost` kept a session's tail across
  `term:exit` while the limit-episode state was cleared, so the first chunk from a *relaunched*
  shell was scanned against the previous agent's notice — arming `Continue` against a fresh bare
  shell, precisely the situation the design promises never to manufacture.
- **The reset time was read as the leftmost time in the line**, so `[14:32:07] … resets 23:10`
  armed at 14:32, and a `resets in 04:59` countdown footer re-armed every second.
- **The scheduled fire wrote the message unsanitised** (only the manual send-now path sanitised).
- **Two overlapping atomic writes shared one temp path**, so a shorter payload landing after a
  longer one left trailing bytes → unparseable JSON → every armed schedule silently gone. That is
  the 0.11.1 durability shape.

Plus a runaway: `maxRepeats: Infinity` from a hand-edited file meant `nextAt` never advanced and
`arm()` computed a zero wait — a hot loop writing into the PTY.

Every fix is **mutation-verified**: the builder reverted each one and confirmed the new test goes
red. One of those tests was itself green-but-broken on the first attempt (it measured a surface the
chip never paints on) and was rewritten to model the declaration site.

## Process findings

- **A test can be green and prove nothing.** The Aero contrast test passed at ~6:1 while the shipped
  chip rendered at ~2.5:1, because custom properties resolve at their *declaring* element and the
  chip paints inside `.termwrap`, which re-scopes the palette. Two of the limit-detector's tests
  were tautological — the "notice followed by 20 lines of diff" case handed the matcher three lines
  with no notice in them.
- **The e2e was passing by luck, twice over.** A 1 s interval measured against wall-clock counted
  each round trip as an elapsed slot, and the injected test clock's offset lives in host memory
  while `nextAt` is written to disk with it applied — so a schedule armed after four advances came
  back four minutes from due. Both were invisible until the serialised queue shifted timing by
  ~130 ms.
- **Attribution before blame.** Six smoke scenarios are red on this machine. The builder stood up a
  **second worktree from unmodified `main`** and proved they fail identically there — zero
  regressions attributable to this lane. It also diagnosed the cause of one: the scenario writes to
  the PTY the moment a session reports `running`, but ConPTY drops input written before the console
  initialises. Filed with the three-line fix.

## Known, recorded, not done
- **`PTY_SETTLE_MS = 3000` is the one place left where the feature trusts a duration instead of an
  observation.** Gating the settle on the first `term:data` after `term:start` would be evidence
  rather than a timer; it needs a spec amendment and a decision about a shell that prints nothing.
- `Send now` now queues behind an in-flight scheduled fire rather than racing it — the only reading
  that doesn't garble the PTY. The queue is never more than one delivery deep.
- The `.claude/worktrees/timed-messages` directory could not be deleted after the branch merged (a
  stale file handle); the git worktree is deregistered and the branch is gone. Two older leftovers
  sit beside it. All under a gitignored path.

## Follow-ups captured in `docs/wishlist.md`
- The ConPTY prompt race behind six red smoke scenarios, with the fix.
- `goto-index.e2e.mjs` cannot pass from any worktree under a dot-directory (it rejects a resolved
  path containing `/.<dot-dir>/`), so a worktree lane reads it as a navigation regression.
