---
status: implemented
date: 2026-08-20
tier: LITE
type: host
---

# Scrollback replay neutralizer

## Why

Conduit persists a session's raw PTY bytes — ANSI sequences intact — and replays them with
`term.write()` when a stale session is relaunched. `term.write()` cannot tell history from a
live command: a `ESC[?1003h` (any-event mouse tracking) sitting in the replayed history is
executed against the emulator exactly as if the freshly spawned shell had just emitted it.

A TUI leaves that mode-set behind whenever it dies without resetting. Killing a session calls
`pty.dispose()`, so the matching `ESC[?1003l` never reaches the ring — the last thing the
history says about mouse mode is "on". After relaunch the emulator is in any-event tracking
while the child is a plain shell, so every pointer move over the terminal sends a mouse report
(`ESC[<35;col;rowM`) down stdin. zsh swallows the ESC prefix and echoes the rest: the reported
symptom was a prompt spraying `35;57;21M35;59;21M…` on every mouse move.

Replay mutates emulator state in general — mouse modes, alternate screen, bracketed paste,
cursor-key mode, scroll regions, pending SGR. Mouse tracking is just the one that hurts.

## Contract

`REPLAY_MODE_NEUTRALIZER` (`src/scrollback-persistence.ts`) is a fixed DECRST/reset string,
applied by `neutralizeReplay(data)` as a **suffix**:

- Suffix, not prefix — it must win over whatever the replayed history set. A prefix would be
  overwritten by the very sequences it is meant to cancel.
- Resets, in order: all mouse protocols and encodings (`?1000 ?1002 ?1003` / `?1005 ?1006
  ?1015 ?1016`), focus reporting (`?1004`), alternate screen (`?1049`), bracketed paste
  (`?2004`), cursor-key application mode (`?1`); then autowrap back on (`?7h`), scroll region
  cleared (`ESC[r`), SGR reset (`ESC[m`).
- `?1049l` comes **before** `ESC[r` / `ESC[m` so those land on the normal buffer, not on an
  alternate buffer that is about to be discarded.
- `?7h` is the only *set* in the sequence: autowrap is on by default, so restoring it is a
  reset in spirit.
- Empty in → empty out. Nothing was replayed, so there is no history state to cancel.

## Where it applies — cold path only

`term:start` has two replay paths and only one gets the neutralizer.

| Path | Child | Neutralized |
|------|-------|-------------|
| Cold relaunch — restore `scrollback-<id>.json`, then `pty.start` spawns a **fresh** shell | new | **yes** |
| Attach — a window mounting a pane for a session whose PTY is **already alive**, replayed from the in-memory ring | existing | **no** |

On attach the child is still running. If it is a TUI with mouse tracking on, the replayed
mode-sets are *correct state reconstruction* — the new window's emulator needs them to match
the child. Neutralizing there would break mouse support for a live TUI. The neutralizer belongs
only where a fresh child is spawned underneath replayed history.

The neutralizer is appended to the outbound `term:data` only; the in-memory ring keeps the raw
restored bytes, so a later attach replay is unaffected.

## Tests

- `test/unit/scrollback-neutralizer.test.ts` — the sequence carries a DECRST for every mouse
  protocol and encoding plus `1004/1049/2004/?1`, contains no private-mode *set* other than
  `?7h`, orders `?1049l` before `ESC[r`/`ESC[m`, and `neutralizeReplay` appends rather than
  prepends.
- `test/e2e/scrollback-mode-neutralize.e2e.mjs` — the runtime proof. Seeds a scrollback file
  containing `ESC[?1003h ESC[?1006h`, relaunches the session, then asserts against the real
  xterm instance that `modes.mouseTrackingMode === 'none'` and that real pointer moves over the
  viewport produce no `ESC[<` report on the terminal's `onData`. Verified to fail against the
  pre-fix build.
