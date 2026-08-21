---
status: active
date: 2026-08-21
tier: FULL
---

# Attention signal quality

## Why

The "needs you" feature pings on false signals (user report, 2026-08-21). The
2026-08-21 investigation found the detector's only input is `term:data` → "any
output, then 1500 ms quiet, on any session but the single globally-focused one"
(`src/session-activity.ts`, fed at `electron/main.ts` `recordOutput`). Confirmed
false-positive paths, ranked:

1. No "waiting for you" concept — a background `ls`, a mid-turn Claude Code tool
   pause, or any slow printer arms attention.
2. No episode latch on the in-app state — `recordOutput` clears the flag, the next
   quiet re-sets it, so a periodically repainting TUI (Claude Code's statusline)
   re-pings forever; the existing `osNotified` guard covers only the OS
   notification, and session focus clears it, restarting the loop.
3. `focusedId` is one global string — with two windows the last `focus` writer
   wins, so a session the user is staring at gets flagged; split-pane sessions are
   never exempt.
4. Spawn/relaunch banners arm attention (`autoRelaunchStale` pings every restored
   session at startup).
5. Resize repaint of a split session pings an on-screen terminal.
6. `term:exit` yields a "finished" notification for a session the user killed.

(Scrollback replay was ruled out — replayed bytes bypass `recordOutput`.)

## Contract

The busy/idle machine (1500 ms window) is unchanged for the Busy meter and icons.
What changes is when `needsAttention` arms, what it exempts, and how it re-arms.

1. **Qualifying run.** A quiet edge arms attention only when the run that just
   ended was substantial: `runDuration >= MIN_RUN_MS (2000)` **or**
   `runBytes >= MIN_RUN_BYTES (1024)`, and the quiet gap is
   `ATTENTION_QUIET_MS (4000)` (busy stays 1500 ms — hysteresis is deliberate). A
   run starts at the first output after idle/acknowledgment and accumulates
   duration + bytes.
2. **Bell arms immediately.** A bare BEL (0x07) in the output arms attention with
   no quiet wait — BEL inside an OSC string (e.g. `ESC ]0;title BEL`) is a
   terminator, not a bell, so the scan must be OSC-aware (extend the scanner state
   machine beside `stripAnsi` in `src/last-line.ts`; a naive `includes('\x07')` is
   the named failure). BEL is the ecosystem's explicit "attention" signal (Claude
   Code rings it on permission prompts); honoring it is signal, not heuristic.
3. **Episode latch.** Arming starts an *episode*. The badge, float-to-top, chip,
   flash and OS notification all fire at most once per episode. Acknowledgment
   (the session becoming visible) ends the episode; a new episode requires a new
   qualifying run or a new BEL. Output alone never re-arms an acknowledged
   session. The now-redundant `osNotified` set is subsumed (the latch lives in the
   state machine, not per-surface).
4. **Visible set, per window.** The exemption is the set of sessions visible in
   any window: each renderer reports its visible session ids (active + split) on
   change; main keys the sets by sender window and drops a window's set when it
   closes. A visible session never arms and is auto-acknowledged. OS-level
   surfaces (flash/notification) additionally require no focused window,
   unchanged.
5. **Spawn grace.** No attention edge within `SPAWN_GRACE_MS (5000)` of that
   session's `pty.start` (covers shell banners, relaunch marker follow-on, and
   `autoRelaunchStale` bursts; the qualifying-run rule already covers most of
   this — the grace is the guarantee).
6. **Only running sessions arm.** A session that exited (`term:exit` seen, or
   status ≠ running) never arms; in-flight state for it resets.

Non-goals, explicit: per-shell prompt-shape parsing and renderer emulator-mode
reporting (bracketed-paste/alt-screen "at a prompt" proxies) — more surface than
signal today; recorded as a possible future refinement. OSC 9/777 desktop
notifications — no evidence Claude Code emits them; revisit with a byte capture.

## Behavioral acceptance (the e2e matrix; scripted PTY children, real app)

| Pattern (scripted child) | Expected |
|---|---|
| Spinner loop: small write every 300 ms, forever (CC working) | never arms |
| Long burst (≥2 s or ≥1 KiB) then silence (CC turn end / build done), session not visible | arms once; second quiet cycle without new run does NOT re-fire |
| Same, then session viewed, then a single small repaint (CC idle statusline) | no re-arm |
| Bare BEL mid-stream, not visible | arms immediately |
| `ESC ]0;title BEL` only | never arms |
| Fresh spawn banner then quiet | never arms (grace + non-qualifying) |
| Split-pane session finishing a qualifying run while on screen | no badge |
| Two windows, each watching its own active session | neither arms from its own on-screen session |
| Session exits after output | no "finished" notification |

Verification runs on Windows against the real built app. Real Claude Code is not
driven in the suite (auth/nondeterminism); the scripted patterns model its known
emissions. Constants (`MIN_RUN_MS`, `MIN_RUN_BYTES`, `ATTENTION_QUIET_MS`,
`SPAWN_GRACE_MS`) are exported and unit-tested so tuning against real-world use
is a constant change, not a redesign.
