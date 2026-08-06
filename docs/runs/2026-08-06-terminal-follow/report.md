# Run report — terminal follow / runaway scroll (2026-08-06)

Released **v0.27.0** (`5aede15`) and **v0.27.1** (`ff6036c`). Both built and published
locally — see *Release* below.

## The request

> Running Claude Code in Conduit, scrolling up to read while it generates, then being
> unable to scroll back down to the bottom. It fixes itself the moment you type, press
> `End`, or otherwise touch the input.

Prior attempts had failed repeatedly. The user also stated up front — and repeated when the
first fix landed — that it happens **even when Claude Code has stopped generating**.

## What was proven

**The full-ring treadmill.** Once xterm's scrollback ring is full, `BufferService.scroll()`
keeps a scrolled-up reader's text stationary by decrementing `ydisp` on every trimmed line
while `ybase` stays pinned at max. The gap to the bottom therefore grows at the *output*
rate. Since it closes only at the *scroll* rate, `d(gap)/dt = output − scroll`, and a working
agent outruns any wheel — so **no wheel tuning can fix it**; a direct `scrollToBottom` is the
only way back, and it also clears `isUserScrolling`, re-arming follow-mode.

Measured in a real browser against real xterm, user scrolling **down** 24 notches per round:

```
scrolled up + read 2s     BEHIND= 339
wheel DOWN round 1 (24x)  BEHIND= 516     <- going down, losing ground
wheel DOWN round 2 (24x)  BEHIND= 685
wheel DOWN round 4 (24x)  BEHIND=1000     <- pinned against the top of the buffer
after pressing End        BEHIND=   0   userScrolling=n
```

Conduit set no `scrollback`, so xterm's default of 1000 lines applied — roughly eight
seconds of agent output, after which every session is permanently in this regime.

**Two defects in the fix itself**, both found only after shipping v0.27.0:

- The control was drawn with literal `border-radius: 999px` and a fixed
  `rgba(0,0,0,0.4)` shadow. `--r-round` is `0` in Neon and `--elev-3` is tinted on the
  light theme and `none` in Neon, so it stayed round where everything else squares off and
  wore a black shadow over a light page.
- **It never appeared on an idle terminal.** It watched `Terminal.onScroll`, which fires
  for new output and for `scrollLines()` but **never for a wheel scroll** — xterm reports
  that path with `suppressScrollEvent`. The regression test drove the scroll with
  `scrollLines()` and so passed against a build no user could operate.

## What was NOT reproduced

The user's stated case — **scrolled up, generation stopped, still cannot reach the bottom** —
was never reproduced. Four hypotheses were tested and three died against evidence:

| Hypothesis | Verdict |
|---|---|
| Full-ring treadmill | **Confirmed**, fixed — but only bites while output is arriving |
| Idle Ink repaint dragging the viewport | **Dead** — real Claude Code emits *zero* cursor-up sequences |
| xterm's native DOM-`scrollTop` wheel path is broken | **Dead** — reaches the bottom fine |
| WebGL renderer showing stale pixels | **Untested** — the leading remaining candidate |

The last one is invisible to every measurement taken here: all instrumentation read buffer
indices (`ydisp`/`ybase`), which would look perfectly healthy while the pixels are stale. It
fits "it thinks the bottom is there but it's not" and "any keystroke fixes it" (a keypress
forces a repaint). Carried in `docs/wishlist.md`.

Final attempt drove **real Claude Code inside real Conduit** with a real wheel:

```
wheel DOWN round 1     ydisp=578 ybase=578 BEHIND=0
generation stopped     ydisp=578 ybase=578 BEHIND=0
IDLE wheel DOWN x4     ydisp=578 ybase=578 BEHIND=0   -> reached bottom
```

## Load-bearing finding

Recording the real PTY byte stream from Claude Code **2.1.223** showed it emits only
`?2004h` (bracketed paste), `?1004h` (focus), `?2031h` — **no mouse tracking**, no alternate
screen, no cursor-up. So `shouldHandleWheelLocally` (which requires
`mouseTrackingMode !== 'none'`) **never fires for Claude Code**; confirmed live in the app as
`mouse=none take=0 defer=108`.

The existing takeover and its comments described that path as being *for* Claude Code. That
premise is false and is the likely reason earlier attempts kept patching a code path Claude
Code never touches. Comments corrected; both facts added to `CLAUDE.md`.

## Method note

Two synthetic reproductions were built on a guess about what Claude Code emits, and both
modelled it wrongly — the first as an append-only stream, the second as an Ink repaint loop.
Worse, both had mouse tracking *on*, so they exercised Conduit's own wheel takeover and never
touched the path Claude Code actually uses. Recording the real byte stream should have come
first; it is cheap and settles the question outright. The recorder is reusable and costs one
short session to regenerate.

## Verification

- `npm run verify` green — 2547 tests, at the pre-existing 12-warning baseline.
- Full smoke suite green — **74 passed, 0 failed, 0 errors**.
- `test/e2e/terminal-follow.e2e.mjs` — new. Scrolls with a **real wheel** on an **idle**
  terminal; both properties are load-bearing (a running producer fires `onScroll` from output
  and hides the wheel gap). Negative-controlled twice: removing the control fails at
  `.term-follow`, and removing only the viewport listener fails the same way.
- `chamfer-edge.e2e.mjs` — its mirrored selector constant now includes `.term-follow`.
- Themes verified by computed style + screenshot in all three: Neon `radius: 0`,
  `shadow: none`, 9px chamfer with diagonal colour == border colour and corner width ==
  side width; light Aero gets the tinted `--elev-3`.

## Release

GitHub Actions was in a **major outage** (`build-and-publish` never acquired a
`windows-latest` runner, twice, at exactly 15m02s). Both releases were therefore built and
published from the dev machine, matching the CI job step for step. Verified equivalent:
`NotSigned` (no cert configured, as in CI), no `publisherName` in `app-update.yml` (the
v0.2.1 auto-update breakage), and the published `latest.yml` sha512/size matching the
uploaded asset exactly.

One local-only hazard: `dist/` held stale `0.2.0` artifacts, which the workflow's
`dist/*.exe` glob would have uploaded alongside the new installer. CI never sees this because
it checks out fresh. Clear `dist/` before any local publish.
