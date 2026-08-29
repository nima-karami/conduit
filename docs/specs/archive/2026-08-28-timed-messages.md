---
status: shipped
date: 2026-08-28
---

# Feature Spec: Timed messages — send a message to a session on a timer, an interval, or when a usage limit resets

**Tier:** FULL   **Feature type:** UI
**One-line request:** "When running Claude Code I hit the usage limit and have to wait for the
reset, then come back and manually send a message to continue. I want Conduit to send a message to
a specific session on a timer or interval — open it from the command bar, type the message, choose
timed or interval, make it active, and show a hovering icon over the terminal so I know it's armed."

One feature, one spec — no lanes. §6 slices it into MVP / v1 build order; everything in both slices
is in scope.

> Locked product decisions (do not re-open): **both** triggers (manual delay / clock time /
> interval, **and** limit-aware auto-resume); delivery **always** sends the text and presses Enter,
> never gated on bracketed-paste mode; repeat control is **max-repeats only**, no idle gating;
> schedules **persist across restart** and a missed fire lands **once**, legibly late.

> Revision 2026-08-28 (post architecture review, REVISE): a fire now requires a **live PTY** and
> otherwise **waits** — the host never spawns one (§2 "Lifecycle"; conductor decision);
> `autoResumeOnLimit` defaults to **`arm`**, with the arming gated rather than the detector (§2
> "Limit-aware"; conductor decision); delivery is liveness-checked twice and reports whether it
> landed (§2 "Delivery"); the chip's `paused` state is gone — a non-running session has no pane, so
> **Waiting** is signalled on the stale card and the session rail (§2 "Waiting"); the catch-up window
> depends on `origin`; `mgr.touch` is not called on a fire.

## 0. What exists (summary — the spec builds on this, doesn't restate it)

| Surface | Today | What this feature needs |
|---|---|---|
| Delivery into a session | `pty.input(sessionId, data)` (`src/pty-host.ts:157`) is the single write into a PTY. It is **void** and silently no-ops for a session with no live process (`this.procs.get(id)?.write(data)`). `isAlive(sessionId)` (`:142`) is the liveness read. `term:input` (`electron/main.ts:2823`) is `input`'s only caller and also does `mgr.touch(id, 30_000)`, commented "user interaction = activity". | The **fire path**: one host-side call, liveness-checked, reporting whether it landed — and deliberately **not** touching `lastActiveAt` (§2 "Delivery"). |
| `webview/terminal-bus.ts` | sessionId-keyed registry (`registerTerminal`, `requestTerminalFocus`, `pasteToTerminal`, `hasLiveTerminal`). `hasLiveTerminal` answers **false** unless the foreground program has bracketed paste on, and `pasteToTerminal` re-checks at delivery — Lane F's safety gate for multi-line review notes. | A **registry-presence** read (`hasRegisteredTerminal`) for UI copy only. The bracketed-paste gate is untouched, because timed delivery does not route through this module at all (§2 "Delivery", §12.2). |
| When a PTY exists at all | A pane is mounted only for a `running` session (`center-pane.tsx:123` filters `status === 'running'`), and a mounted pane posts `term:start` **only once it has a real laid-out size** — `fitIfVisible()` returns false for a zero-width/hidden pane (`terminal-pane.tsx:511-513`) and gates the post at `:544`. Restore marks **every** session `stale` (`src/persistence.ts:37`, `src/session-manager.ts:120`) and `autoRelaunchStale` defaults to **false** (`src/settings.ts:204`). | The load-bearing consequence: **after a restart there is no PTY for any session**, so a catch-up fire has nothing to write into until the session is live again (§2 "Lifecycle"). |
| Host output observation | `term:data` in `electron/main.ts:1222` already runs three chunk-carrying scanners: `countBareBells` (carry in `bellScanState`), `CwdScanner`, and the scrollback ring. `pty.lastLine()` (`src/pty-host.ts:147`) derives the last non-empty ANSI-stripped line from a small per-session tail. | A fourth scanner, reading the **trailing** lines of that same tail (§2 "Limit-aware"). |
| Timers in the host | **No precedent.** `nextSnoozeExpiry` (`src/attention.ts:76`) looks like one but is **renderer-only** — its single caller is `webview/use-snooze.ts:29`, with zero hits in `electron/main.ts`. The host's existing timers are per-item debounces (`gitDebounce`, `repoScanDebounce`, `scrollbackPersistTimers`). | A host-side scheduler, argued on its merits in §2 "The timer" rather than inherited. |
| `userData` persistence | `sessionsFile()`/`reviewMarksFile()` + `persistFile` (async, atomic) + `flushStateSync` on quit + a **dirty gate** (`reviewMarksDirty`, `electron/main.ts:1557`); broadcast to every window (`review:marks`, via `broadcast` at `electron/main.ts:820`). | Exactly this, for `timed-messages.json` (§3). |
| Session teardown | `disposeSession` (`electron/main.ts:1852`) is the one place a session's per-session state is dropped — `pty.dispose`, `mgr.remove`, `activity.forget`, the scanners, the scrollback ring and its file. | One more line in it (§2 "Lifecycle"). |
| Non-running sessions on screen | The stale card (`center-pane.tsx:250`, "Session not running" + Relaunch) and the rail's five-state machine (`src/session-icon.ts` `sessionIconState`: stale / busy / attention / review / idle, mutually exclusive, read by the rail, the card badge and the topbar chip). | The **Waiting** signal lives here, not on the terminal chip (§2 "Waiting"). |
| Entry point | `PaletteEntry[]` in `webview/app.tsx:2214`; `SHORTCUT_ACTIONS` (`webview/shortcuts.ts`) requires a `defaultCombo`, so a binding-less command is palette-only. | One palette command; **no** default key (§5). |
| Dialogs | `.modal__backdrop` is already `-webkit-app-region: no-drag` (`styles.css:999`); `compare-dialog.tsx` is the focus-trap precedent; `SegmentedRadios` is the radiogroup control; `pushToast` is the transient channel. | Reused wholesale. |

Inherited constraints: all host state broadcasts go to every window (two windows, one main process);
`userData` files are atomic-written with a sync quit flush and a dirty gate; CI `verify` runs on
**ubuntu**, so nothing may depend on the machine's `TZ` or `process.platform`; two tsconfigs; any
host/IPC-boundary work gets a `test/e2e/<name>.e2e.mjs` scenario on the shared harness.

## 1. Problem frame

- **Job:** an agent stops — a usage limit, a finished task, a plan that needs another pass — and the
  only thing between it and more work is a human typing one word at a specific time. The user wants
  to *set that word and that time once, walk away, and see at a glance that it is armed*.
- **Actors:** the user (arms, edits, cancels); the host (owns the schedule, the clock, and the
  write); the session's agent (receives the message as if the user typed it).
- **Success outcomes:**
  - A message can be armed against a named session in under ten seconds from the command bar.
  - While anything is armed, that session's terminal carries a small chip saying so and when it
    fires; when nothing is armed there is **no chip at all**.
  - A limit notice in the session's own output arms a resume by itself, visibly and reversibly.
  - Closing the app does not lose an armed schedule; a fire that came due meanwhile lands once, as
    soon as the session is live again, and is marked late.
- **Non-goals:** cron expressions or calendar recurrence; conditional triggers ("when it goes idle",
  "when it prints X") — locked out by decision 3; queues of different messages; **starting a session
  the user did not start** (§2 "Lifecycle"); sending to a session in another application; an i18n
  layer (the repo has none); a full fire-history log (§2 "After a fire" keeps the last fire only);
  reading or acting on the agent's reply.

## 2. Behavior & states

### Delivery — one path, host-side, liveness-checked

**A scheduled fire is a host-issued write into a live PTY.** `deliver(sessionId, message)`:

1. `if (!pty.isAlive(sessionId)) return { delivered: false, reason: 'noSession' }`
2. `if (!pty.input(sessionId, message)) return { delivered: false, reason: 'noSession' }`
3. wait `SUBMIT_GAP_MS = 120`
4. **re-check** `pty.isAlive(sessionId)` — the process can exit inside that gap, and half a message
   sitting in a dead PTY must not be reported as sent
5. `pty.input(sessionId, '\r')` → `{ delivered: true }`

`PtyHost.input` gains a **boolean return** (`const p = this.procs.get(id); if (!p) return false;
p.write(data); return true;`) so `delivered` is *derived from the write*, not asserted around a void
call. `term:input`'s existing behaviour is unchanged — it ignores the return.

Two writes, not one: a TUI that coalesces a single read can keep a trailing `\r` in its input buffer
as literal text instead of treating it as submit. `\r`, not `\n`, because that is what xterm sends
for Enter.

**A fire does not call `mgr.touch`.** `lastActiveAt` means *the user interacted with this session*
(`electron/main.ts:2825`) and drives card age, the rail's recency sort and board linkage. A 3am robot
keystroke reporting the user was at the keyboard would corrupt all three. The session becomes `busy`
through the ordinary output path when the agent responds, which is the honest signal.

Why host-side rather than through `terminal-bus`: the schedule, its clock, and the PTY all live in
the main process, and a fire must not depend on a renderer. A pane can be unmounted (its window
closed, or the session owned by the *other* window), and after a restart no pane is mounted at all.
Routing through the bus would also force that module to grow an ungated sibling to `pasteToTerminal`;
keeping delivery out of it entirely is what leaves the review-notes bracketed-paste precondition
honest. `terminal-bus` gains only `hasRegisteredTerminal(sessionId)` — registry presence, no mode
check — used for dialog copy.

**Message sanitation** (`sanitizeMessage`, pure): C0/C1 controls and `ESC` removed, tabs and newlines
collapsed to single spaces, trimmed, capped at `MAX_MESSAGE_CHARS = 2000`. Empty after sanitation is
rejected at the composer. This is what makes "always press Enter" safe to specify: the payload is one
line, so it cannot submit early or inject an escape sequence.

**Invariant:** a message is only ever text the user typed or a built-in constant. Nothing parsed out
of terminal output is ever composed into a message.

### The schedule

Host-owned, one record per armed thing, **many per session** (caps `MAX_PER_SESSION = 3`,
`MAX_TOTAL = 20`). `src/timed-messages.ts` is a Node-free pure module (the `src/review-marks.ts`
model): parse/serialize, `nextFireAt`, `resolveClockTime`, `advanceAfterFire`, `catchUp`,
`sanitizeMessage`, `describeNext`. Host and renderer both import it, so the two sides can only
disagree by disagreeing with this file.

```ts
export interface TimedMessage {
  id: string;              // `tm-<base36>-<rand>` (the src/review-notes.ts id convention)
  sessionId: string;
  message: string;         // sanitized, single line
  kind: 'once' | 'interval';
  nextAt: number;          // epoch ms UTC — authoritative, recomputed after each fire
  everyMs?: number;        // 'interval' only
  /** Wall-clock intent. Sole consumer: manual Renew on an 'at' schedule (below). */
  spec?: { clock: string; zone?: string };   // '23:10', 'America/Toronto'
  maxRepeats: number;      // 'once' = 1; 'interval' required, default 5, max 100
  firedCount: number;
  state: 'armed' | 'waiting' | 'done';
  /** When it came due with no live PTY — drives the Waiting signal and the toast copy. */
  waitingSince?: number;
  origin: 'manual' | 'limit';
  createdAt: number;
  lastFire?: { at: number; late: boolean; delivered: boolean; reason?: 'expired' | 'noSession' };
}
```

`cancelled` is deliberately not a state — cancel deletes the record.

### Triggers

| Trigger | Composer | `nextAt` |
|---|---|---|
| **In** (delay) | number + minutes/hours; default **30 minutes**; floor `MIN_DELAY_MS = 30_000` | `now + delay` |
| **At** (clock time) | `HH:MM` + am/pm, the user's local zone | the next occurrence of that wall clock (below) |
| **Every** (interval) | number + minutes/hours (floor **60 s**) + **Repeats** (required, default 5) | first at `now + everyMs`, then `+everyMs` per fire |

`In` and `At` are `kind:'once'` with `maxRepeats: 1`; the Repeats field is hidden for them.

**Clock resolution** (`resolveClockTime(clock, zone, now)`): the **next** occurrence of that wall
clock in `zone` (absent → the user's local zone), with a `CLOCK_GRACE_MS = 120_000` backward grace so
"at 11:10pm" typed at 11:11pm means *now*, not tomorrow. Offsets come from
`Intl.DateTimeFormat(undefined, { timeZone })` probed at a candidate instant, converged in two passes
— never from `Date`'s local offset, because CI runs on ubuntu and the answer must not move with the
machine's `TZ`. A spring-forward gap resolves to the instant the clock jumps to; a fall-back
ambiguity to the **earlier** instant; never more than 25 h out. An unusable zone string (an
abbreviation like `EDT`, on which the formatter throws) falls back to local.

`spec` is stored only because **Renew** on an `At` schedule must re-resolve *the wall clock*, not
add a fixed offset — that is its one consumer. `At` is `kind:'once'`, so nothing else re-derives a
time and there is no recurring-DST question to answer.

### Lifecycle — a fire requires a live PTY, and the host never starts one

*(Conductor decision.)* After a restart every session is `stale`, no pane is mounted, and
`autoRelaunchStale` is off by default — so there is no PTY to write into. The rule:

**If the session is not live at `nextAt`, the schedule becomes `waiting` and stays waiting until that
session's PTY comes up — by auto-relaunch, or because the user opened the session — and then delivers
once.** The host does **not** spawn a PTY of its own. A host-spawned PTY is a bare shell, which would
turn the accepted always-Enter risk (§12.1) from a possibility into a certainty on every catch-up.
Nothing is ever typed into a dead session.

| Event | Effect on a schedule |
|---|---|
| `nextAt` arrives, PTY live | fire; `nextAt` advances (interval) or `state:'done'` (once) |
| `nextAt` arrives, PTY not live | → `waiting`, `waitingSince = nextAt`. `nextAt` **does not advance**. No delivery, no error |
| `term:exit` while armed | the next due fire finds no PTY and goes `waiting` — nothing special happens at exit itself |
| PTY starts for that session (`term:start`) | after `PTY_SETTLE_MS`, every `waiting` schedule for it delivers once (subject to the catch-up window), then resumes normal scheduling |
| `relaunch` (same id, `electron/main.ts:2349`) | the ordinary path to the row above — the session becomes `running`, its pane mounts, `term:start` fires |
| `disposeSession` (`kill`, `electron/main.ts:1852`) | its schedules are **deleted there**, alongside `pty.dispose` / `activity.forget` / the scanners — not lazily at some later mutation |
| Terminal pane unmounts (window closed, other window) | **no effect** on the schedule; the PTY is what matters, and it is host-owned |
| App quit while armed | persisted; on relaunch it is `waiting` until the session is live |

**Settle:** a delivery waits `PTY_SETTLE_MS = 3_000` after that session's `term:start` — a message
written into a shell that has not yet printed its prompt is lost.

**Catch-up window**, applied at the moment a `waiting` schedule becomes deliverable — how stale the
intent may be, keyed on `origin` because the two intents decay differently:

| `origin` | Window | Why |
|---|---|---|
| `manual` | `6 h` | "In 30 minutes, do this again" is about a working session that has moved on |
| `limit` | `24 h` | "Continue when the limit resets" is still exactly what the user wants the next morning — the motivating case is a lid closed at 11pm and opened at 9am |

Past the window → **skipped**, `lastFire = { delivered: false, reason: 'expired' }`, slots advanced.
Inside it → **one** delivery, `late: true`. If several interval slots elapsed they **collapse into a
single delivery**, and `firedCount` advances by the number of elapsed slots, capped at `maxRepeats`.
A laptop asleep for a day never produces a burst.

### Waiting — signalled where a non-running session actually lives

The terminal chip cannot show this state: a non-running session has no pane at all
(`center-pane.tsx:123`). One vocabulary, the word **Waiting**, used in all three places it appears:

- **Stale card** (`center-pane.tsx:250`, beside "Session not running" + Relaunch): *"1 timed message
  waiting — it will send when this session starts."* This is the surface the user is already looking
  at when they hit the problem, and Relaunch is right there.
- **Session rail / card badge:** a small clock glyph + count. It is deliberately **not** a sixth
  `SessionIconVisualState` — those five are mutually exclusive lifecycle states with a precedence
  order read by three consumers (`src/session-icon.ts`), and "has a timer waiting" is orthogonal to
  all of them (a `waiting` schedule can sit on a stale session or, after a `term:exit`, alongside any
  other state). It renders as an independent badge, so nothing in the existing precedence moves.
- **Dialog row:** *"Waiting — will send when this session starts."*

### The timer

One `setTimeout` to the **earliest** `nextAt` across all armed schedules, re-armed after every fire
and every mutation, clamped to the `setTimeout` ceiling (2^31−1 ms) with a re-arm on expiry. There is
no host precedent to inherit (§0), so the argument is on merits: an interval poll would have to run
at the accuracy the feature promises (seconds) forever, on every launch, whether or not anything is
armed — a permanent background cost for a feature that is idle almost always. A single timer costs
nothing when the set is empty, which is the normal case.

`setTimeout` does not advance across a Windows suspend, so `powerMonitor`'s `resume` and
`unlock-screen` re-evaluate `now` against every `nextAt` and re-arm. **The timer is never the source
of truth; `nextAt` is** — every evaluation compares wall-clock `now`, so a timer that fired early,
late, or not at all cannot produce a wrong outcome.

**Scope of the no-polling invariant:** it governs `nextAt` only. The settle delay, the offer
suppression window, the `firing` and `late` display windows, and the chip's countdown tick are
**presentational** timers — they may drift, be throttled by a hidden window, or be skipped entirely
without changing when or whether anything is delivered.

### Limit-aware auto-resume

**Detection** runs host-side in the existing `term:data` handler, beside `countBareBells`
(`src/limit-notice.ts`, pure). It does **not** scan every line of every chunk. After a chunk is
processed it evaluates the session's **trailing output** — the last `TAIL_LINES = 3` non-empty
ANSI-stripped lines, from the same per-session tail `pty.lastLine()` already maintains (`PtyHost`
gains `tailLines(sessionId, n)` reading that buffer; no new state).

*Why the tail:* a limit string that scrolls past inside a `git log`, a diff, or the agent quoting one
back is not the session asking to be resumed. Requiring the notice to be what the session is
**currently showing** is what makes arming-by-default defensible.

A line is a limit notice only when **all three** hold — anchors, not one exact string:

1. it contains `limit`;
2. it contains a **limit anchor**: `hit`, `reached`, `exceeded`, `usage`, or `session limit`;
3. it contains a **reset anchor**: `reset`, `resets`, `resets at`, or `will reset`;

and a time parses out of it. Time forms handled: `11:10pm`, `11pm`, `11:10 PM`, `23:10`, each with an
optional trailing IANA zone in parentheses — covering `You've hit your session limit · resets 11:10pm
(America/Toronto)` and its variants. **No time parses → no notice** (locked: degrade, never misfire).

**Episode state** is host memory, keyed by `sessionId`: `{ resetAt, resolved }`. A repeat match with
the same `resetAt` is ignored (a TUI redraws its footer constantly); a match with a *different*
`resetAt` supersedes. Nothing about an episode is persisted — it describes a live moment, and after a
restart the notice is gone.

**`autoResumeOnLimit`** (§5) — default **`arm`**:

- **`arm`** (default): immediately arm a `kind:'once'`, `origin:'limit'` schedule at
  `resetAt + LIMIT_PADDING_MS = 60_000` (reset boundaries are approximate) with the message
  **`Continue`**. One toast: *"Armed: Continue at 11:10 PM"* with **Undo**. The chip shows the
  auto-armed treatment (below). Three things keep this safe: the tail requirement above; the cap
  below; and the fact that it is visible and cancellable in two clicks from the surface the user is
  already looking at.
- **`offer`**: same detection, but the chip enters `offer` and one toast asks — *"Session limit —
  resets 11:10 PM. Resume then?"* / **Resume then** · **Dismiss**. Dismissing marks the episode
  resolved, suppressing further offers for that session until a different `resetAt` appears or 30
  minutes pass.
- **`off`**: the detector does not run.

**Cap: one live `origin:'limit'` schedule per session.** A new auto-arm **replaces** the existing one
rather than accumulating, so a session that prints a limit notice a hundred times ends with one
schedule, not a hundred. This is separate from, and stricter than, `MAX_PER_SESSION`.

**Idempotence across windows:** the offer/arm decision is resolved **in the host**, once. `broadcast`
(`electron/main.ts:820`) delivers `timer:state` to every window, so both windows show the same toast;
a `timer:offer` message for an episode already `resolved` is a **no-op**, and the offer disappearing
from `timer:state` is what dismisses the sibling window's toast. Two users clicking "Resume then" in
two windows produce one schedule.

### Overlay — the armed chip

Rendered inside `.termpane-wrap` **only** when that session has a live schedule, a pending offer, or a
just-fired notice. Nothing armed → the element does not exist. It sits top-right (`top:8px;
right:14px`), the `.term-find` corner; while the find bar is open the chip takes a
`.term-timer--stacked` modifier (`top:44px`) rather than out-specifying anything.

| State | Shows | Tone |
|---|---|---|
| `armed` (manual) | clock glyph + `in 4m` (or `at 11:10 PM` beyond an hour) + `×3` when repeats remain | `--timer-armed` |
| `auto` (`origin:'limit'`) | **`Auto`** badge + clock glyph + `at 11:10 PM`, plus an inline `×` that cancels it outright | `--timer-auto` |
| `offer` (`offer` mode only) | `!` glyph + `Resume at 11:10 PM?` | `--timer-auto` |
| `firing` | spinner glyph + `Sending…` (≤ 2 s) | as the underlying state |
| `late` | the word `late` + `Sent 10h late`, for 10 s, then back or gone | `--timer-late` |

There is no `paused` or `waiting` chip state — a session in that condition has no pane (§2
"Waiting").

The `auto` treatment is deliberately unlike `armed`: the user did not ask for this one, so it names
itself (`Auto`), carries its own colour, and is cancellable without opening anything.

Countdown text re-renders on a **1 s** tick under an hour, a **1 min** tick above it, and not at all
while the window is hidden (`document.visibilityState`) — a presentational timer, per the invariant
scope above. Clicking the chip opens the dialog. It is a real `<button>` and is always drawn when
mounted: the hover-obstruction rule bites on things that fade in while hit-testable, so the chip's
tooltip is `pointer-events: none` and nothing in this feature sits at `opacity: 0` with pointer
events live. Nothing here overlaps `.topbar`; the dialog's `.modal__backdrop` already carries
`-webkit-app-region: no-drag`.

### The dialog

`webview/components/timed-message-dialog.tsx` — focus-trapped `role="dialog" aria-modal="true"` over
`.modal__backdrop` (the `compare-dialog.tsx` precedent), titled *"Timed messages — &lt;session
name&gt;"*. Two stacked parts:

**Composer** — a message field (defaulting to `Continue`) with quick chips **Continue · Do this again
· Think about it again**; a `SegmentedRadios` trigger picker **In · At · Every**; that trigger's
fields; for `Every`, **Repeats**. A hint line always resolves the choice into plain words: *"First
send tomorrow at 11:10 PM — in 4h 12m, then every 2h, 5 times."* Footer: **Cancel · Send now · Arm**
(primary).

**This session's schedules** — one row each: the message (truncated), next fire or *Waiting*, repeats
left, an origin badge (`Manual` / `Auto`), the last fire if any (*"Last sent 11:10 PM · 10h late"*),
and:

| Action | Meaning |
|---|---|
| **Edit** | loads the row into the composer; saving keeps the `id` and **re-arms** (`firedCount = 0`, `nextAt` recomputed from now) |
| **Renew** | restart with the same parameters: `firedCount = 0`, `state = 'armed'`, `nextAt` recomputed from now (`In`/`Every` → `now + everyMs`; `At` → the next occurrence of the stored wall clock, re-resolved through `Intl`). Offered on `done` rows (which stay listed for the run) and on armed ones, where it resets the countdown |
| **Send now** | deliver immediately; **never** consumes a repeat and never moves `nextAt`. Disabled with a reason when the session has no live PTY |
| **Cancel** | delete the schedule. Always confirms (`confirm-dialog`) — an armed timer is the thing the user walked away trusting |

There is no manual pause: `waiting` is host-derived from the PTY, and a second source of the same
state would be two ways to say one thing.

### After a fire

A toast: *"Sent "Continue" to Backend agent"*; late, *"Sent "Continue" to Backend agent — 10h late
(scheduled 11:10 PM, waited for the session)"*; skipped, *"Timed message missed — "Continue" was due
11:10 PM, too long ago to send"* with **Renew**. The chip flashes `late` for 10 s. The schedule's row
keeps `lastFire`; there is no separate history surface. When `firedCount` reaches `maxRepeats` the
state becomes `done`, the chip drops it, the row stays for the rest of the run (so **Renew** is
reachable), and it is dropped from the persisted file.

### Entry points

- Command palette (`webview/app.tsx` `commandItems`): **"Send timed message…"**, group `Commands`,
  clock icon, acting on the **active** session; with none, one toast *"Open a session first."*
- The chip.
- The stale card's Waiting line.
- Session card / tab context menu: **"Timed message…"**.
- No default key binding (§5).

## 3. Data / interface contract

| Item | Shape | Notes |
|---|---|---|
| `userData/timed-messages.json` | `{ version: 1; schedules: TimedMessage[] }` | host in-memory + `persistFile` (atomic) + `flushStateSync` on quit behind a `timersDirty` gate, exactly like `review-marks.json`. Corrupt or foreign version → **empty**, one host log line, next write replaces |
| `timer:state` (host→all windows) | `{ schedules: TimedMessage[]; offer: LimitOffer \| null }` | one push, broadcast to every window via `broadcast` (`electron/main.ts:820`); the renderer holds no other copy. The offer disappearing is what dismisses a sibling window's toast |
| `timer:fired` (host→all windows) | `{ id, sessionId, at, late, delivered, reason? }` | `delivered` is **derived** from `pty.input`'s return, never assumed; `timer:state` alone cannot distinguish a fire from an edit |
| `timer:set` (webview→host) | `{ schedule: TimedMessageInput }` | create or replace by `id`; the host sanitizes, validates, caps, re-arms, persists, broadcasts |
| `timer:cancel` / `timer:renew` / `timer:sendNow` | `{ id }` | |
| `timer:sendOnce` | `{ sessionId, message }` | the composer's **Send now** with nothing armed |
| `timer:offer` | `{ sessionId, action: 'arm' \| 'dismiss' }` | **no-op** when the session's episode is already `resolved` (two-window idempotence) |
| `timer:test` (webview→host) | `{ op: 'advance'; ms }` | **`CONDUIT_E2E=1` only**; shifts the host's schedule clock offset and re-evaluates (§7) |
| `PtyHost.input` | `input(sessionId, data): boolean` | was `void`; returns whether a live process took the write. `term:input`'s caller is unchanged |
| `PtyHost.tailLines` | `tailLines(sessionId, n): string[]` | the last `n` non-empty ANSI-stripped lines from the tail `lastLine()` already reads; no new per-session state |
| `terminal-bus` (renderer) | `+ hasRegisteredTerminal(sessionId): boolean` | registry presence only; `hasLiveTerminal`'s bracketed-paste precondition is unchanged |
| `AppSettings` | `+ autoResumeOnLimit: 'off' \| 'offer' \| 'arm'` | default **`'arm'`** |

Validation at the host boundary (the renderer is not trusted): `sessionId` must exist in
`mgr.list()`; `message` is re-sanitized host-side; `everyMs ≥ 60_000`; `maxRepeats` in `1..100`;
`nextAt` is **recomputed host-side from the submitted trigger**, never accepted as a number; caps
enforced. A rejected `timer:set` replies with an error toast, never a silent drop.

**Invariants:** exactly one write path into a PTY (`pty.input`) and exactly one fire path into it; a
fire happens only into a **live** PTY, and the host never spawns one; `nextAt` is the only authority
on when something fires (the `setTimeout` is a hint, and the presentational timers are not authority
at all); a session's schedules die with it in `disposeSession`; a message is never derived from
terminal output; at most one `origin:'limit'` schedule is live per session; a missed fire produces
**at most one** delivery.

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| `nextAt` arrives with no live PTY | → **`waiting`**; nothing written, `nextAt` held, no error. Signalled on the stale card and the rail |
| App restarted with a schedule due | every session restores `stale` with no PTY, so the schedule is `waiting`; it delivers once, `PTY_SETTLE_MS` after the user (or auto-relaunch) brings that session up |
| User never reopens the session | it stays `waiting` indefinitely, visibly; the catch-up window is applied at the moment it *becomes* deliverable, so a very old one is then skipped rather than fired |
| Sleeping laptop: `limit` fire due 11:10pm, lid opened 9am | ~10 h overdue, inside the **24 h** `limit` window → delivered once when the session is live, marked late. The same delay on a `manual` schedule (6 h window) is skipped with a **Renew** toast |
| Process exits between the text and the `\r` | the second `isAlive` check fails; `delivered: false`, `reason:'noSession'`; no half-sent message reported as sent |
| Several interval slots elapsed while closed or asleep | collapse to **one** delivery; `firedCount` advances by the elapsed slots, capped at `maxRepeats` |
| Machine suspended past a fire | `powerMonitor` `resume`/`unlock-screen` re-evaluates; fires late, or goes `waiting` if the PTY died with the suspend |
| System clock changed / DST boundary | `nextAt` (a UTC instant) is unaffected; only manual **Renew** on an `At` schedule re-resolves the wall clock, and it does so through `Intl` |
| "At" time already passed today | next occurrence tomorrow, except within the 2-minute backward grace, which means now |
| Session killed while armed | schedules deleted inside `disposeSession` |
| Terminal sits at a bare shell prompt | the message is **executed as a shell command** — the accepted consequence of the locked always-Enter decision (§12.1). The host never *creates* that situation, because it never spawns a PTY (§2 "Lifecycle") |
| Message with newlines / ESC / 4 KB | sanitized to one line, capped at 2000 chars; empty after sanitation → the composer refuses |
| 4th schedule on one session, or 21st overall | refused: *"3 timed messages already on this session — cancel one first."* |
| Session prints a limit notice 100 times | one `origin:'limit'` schedule; each new `resetAt` **replaces** the last |
| Limit string scrolls past inside a `git log` or a diff | **no match** — the notice must be in the last 3 non-empty lines of the session's tail |
| Agent quotes a limit message mid-answer, then keeps talking | no match by the time the tail moves on; if it does match momentarily, the auto-armed schedule is labelled `Auto`, visible, and cancellable in one click |
| Limit notice with no parseable time | **no notice, no arm, no offer** — silence, one debug log line |
| Two windows, one offer | resolved once in the host; the second `timer:offer` is a no-op; the offer leaving `timer:state` dismisses the sibling toast |
| Two windows, one edit | last writer wins via the broadcast |
| Chip and find bar both want the corner | the chip takes `--stacked` (`top:44px`) while the find bar is open |
| `autoResumeOnLimit: 'off'` | the detector does not run |
| `timed-messages.json` corrupt or absent | empty set, one host log line |
| Schedule for a session id no longer in `mgr.list()` (file edited, session gone) | dropped at load, never re-persisted |
| Window hidden | the countdown tick suspends; `nextAt` is unaffected |
| Fire lands while the user is typing in that terminal | the message interleaves with their input; accepted — locked decision 3 rules out activity gating |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Delivery presses Enter | always | **no** | locked decision 2 — the point is that the agent continues unattended |
| A fire needs a live PTY; the host never spawns one | always | **no** | conductor decision — a host-spawned PTY is a bare shell, which makes the Enter risk a certainty |
| Limit-aware behaviour | **`arm`** | `autoResumeOnLimit` — Settings › Behaviour (`off` / `offer` / `arm`) | the stated job is "I don't have to come back and send a message manually"; an offer-by-default leaves the user doing the thing the feature exists to remove. Safety comes from gating the *arming* — tail-only matching, one limit schedule per session, a self-labelling `Auto` chip with a one-click cancel — not from asking |
| Default message | `Continue` | no (three quick chips) | the user's own first example; a setting for one word is surface without payoff |
| Delay default | 30 minutes | per schedule | the user's own example |
| Interval repeats | 5 (required, max 100) | per schedule | locked decision 3 — a required count is what bounds an unattended loop |
| Minimum delay / interval | 30 s / 60 s | no (the floor is 0 under `CONDUIT_E2E`) | below that this is a keyboard macro, not a schedule |
| Limit padding | reset + 60 s | no | reset boundaries are approximate |
| Catch-up window | `manual` 6 h · `limit` 24 h | no | the two intents decay at different rates (§2) |
| Tail depth for detection | last 3 non-empty lines | no | deep enough for a footer under a status line, shallow enough that scrolled-past text never matches |
| Caps | 3 per session · 20 total · 1 limit-schedule per session · 2000 chars | no | rationale inline in §2 |
| Key binding | none | a binding can be added later (`SHORTCUT_ACTIONS` requires a `defaultCombo`, so there is no binding-less registry row) | this is a considered action, not a hot path |
| Storage | `userData/timed-messages.json` | no | per-user runtime state; a schedule must never appear as a change in the reviewed tree |

## 6. Scope slicing

- **MVP:** `In` / `At` one-shots; the host schedule store, single timer, persistence, the
  live-PTY-or-`waiting` rule, catch-up and the late marker; the chip (`armed` / `late`); the
  **Waiting** signal on the stale card; the dialog (composer + list + Cancel); the palette command;
  the toast on fire.
- **v1:** `Every` + max-repeats; the limit detector, `arm`/`offer`/`off`, the `Auto` chip treatment
  and its cap; **Send now**, **Edit**, **Renew**; the rail badge; the context-menu entry;
  `powerMonitor` re-evaluation.
- **Vision:** per-agent notice profiles (other tools' limit wording); saved message templates; a real
  fire history; arming from the session rail without opening the session.
- **Out of scope:** §1 non-goals — in particular, starting a session the user did not start.

## 7. Acceptance criteria

This crosses the host/IPC boundary and the PTY, so it gets one e2e scenario:
**`test/e2e/timed-message.e2e.mjs`**, on the shared harness (hidden launch, `closeApp` teardown, run
serially).

**Proving a fire without waiting real minutes** — three mechanisms, named here so the scenario cannot
quietly become a `sleep`:

1. The minimum-delay floor drops to **0** when `process.env.CONDUIT_E2E === '1'`, so the on-time path
   is armed at +800 ms.
2. `timer:test { op:'advance', ms }` — registered **only** under `CONDUIT_E2E` — shifts the host's
   schedule clock offset and re-evaluates every `nextAt`, proving interval repeats and the expiry
   windows in milliseconds.
3. The **restart** path uses no injection at all: arm at +2 s, `closeApp`, relaunch against the same
   `userDataDir`, assert the schedule came back **`waiting` with nothing delivered** (there is no
   PTY), then post `{ type:'relaunch', id }` through the tapped bridge — the ordinary "user opens the
   session" path, which mounts the pane and produces `term:start` — and assert exactly one late
   delivery.

Delivery is asserted against a **real `cmd.exe`** through the harness's `runShellReader` — the shell
echoes what was typed — which is also the only honest test that the text *and* the Enter both landed.

**EARS**

- When the user runs "Send timed message…" from the palette with a session active, the system shall
  open the dialog focused on the message field, prefilled with `Continue`.
- When a schedule is armed, the system shall render a chip over that session's terminal within one
  frame, and shall render **no chip** for a session with nothing armed.
- When `nextAt` arrives and the session's PTY is live, the system shall write the message and then
  `\r`, and the session shall receive both.
- Where the session's PTY is not live at `nextAt`, the system shall write nothing, shall hold
  `nextAt`, shall mark the schedule `waiting`, and shall **not** start a PTY.
- While a schedule is `waiting`, the system shall say so on that session's stale card and on its rail
  badge.
- When that session's PTY starts, the system shall deliver the waiting message exactly once,
  `PTY_SETTLE_MS` later, marked late.
- When the app relaunches with a schedule whose `nextAt` passed while it was closed, the system shall
  restore it as `waiting` and shall deliver nothing until the session is live again.
- If the process exits between the message and the `\r`, the system shall report `delivered: false`.
- When a `once` schedule fires, the system shall set `state:'done'`, remove the chip, and keep the row
  renewable for the rest of the run.
- When an `interval` schedule with `maxRepeats: 3` fires, the system shall re-arm at `+everyMs` until
  the third fire and then stop.
- Where a schedule becomes deliverable more than its origin's catch-up window past `nextAt`, the
  system shall skip it and record `reason:'expired'`.
- When a session is killed, the system shall delete its schedules during `disposeSession`.
- When the session's trailing output carries a limit notice with a parseable reset time and
  `autoResumeOnLimit` is `arm`, the system shall arm exactly one `origin:'limit'` schedule at
  reset + 60 s, label it `Auto`, and offer Undo.
- Where the same session produces further limit notices, the system shall keep exactly one
  `origin:'limit'` schedule, replacing rather than accumulating.
- Where the limit line is not within the last three non-empty lines of the session's tail, the system
  shall not arm.
- Where the notice carries no parseable time, the system shall not arm and shall raise no offer.
- Where two windows are open and one resolves an offer, the system shall produce one schedule and
  clear the toast in both.
- When a fire is delivered, the system shall **not** update the session's `lastActiveAt`.
- When **Send now** is used, the system shall deliver immediately and shall change neither
  `firedCount` nor `nextAt`.
- When **Renew** is used, the system shall reset `firedCount` to 0 and recompute `nextAt` from now.
- When a schedule fires, the system shall announce it once via `aria-live="polite"`; the countdown
  itself shall never be announced.
- Where the message contains newlines or escape characters, the system shall deliver one sanitized
  line.

```gherkin
Feature: Timed messages
  Scenario: A schedule that came due while the app was closed waits, then sends once
    Given a shell session with a timed message "echo conduit-timed-ok" armed 2 seconds out
    When the app is closed before it fires and relaunched 5 seconds later
    Then the schedule is restored as waiting
    And nothing has been written to any terminal
    And the session's stale card says a timed message is waiting
    When the session is relaunched
    Then the session receives "echo conduit-timed-ok" followed by Enter exactly once
    And the shell echoes "conduit-timed-ok"
    And the toast and the schedule row both mark the send as late

  Scenario: Interval repeats stop at the limit
    Given an interval message armed every 1 second with 3 repeats
    When the host clock is advanced past four intervals
    Then the message has been delivered 3 times
    And the schedule is done and the chip is gone
```

**Unit** (`test/unit/timed-messages.test.ts`, `test/unit/limit-notice.test.ts`) — every timezone case
passes an **explicit IANA zone**, never the machine's, because CI is ubuntu:

- `resolveClockTime` — the next occurrence; the 2-minute backward grace; a spring-forward gap; a
  fall-back ambiguity; a zone-less clock; an unusable zone string falling back to local.
- `catchUp` — one delivery for N elapsed slots; `firedCount` capped at `maxRepeats`; the 6 h `manual`
  and 24 h `limit` windows, including the 10 h overnight case passing for `limit` and failing for
  `manual`.
- `sanitizeMessage` — CR/LF/tab/ESC/C1 removal, the 2000-char cap, empty rejection.
- `scanLimitNotice` — four real wordings; `11:10pm` / `11pm` / `23:10`, with and without a
  parenthesised zone; a notice split across two `term:data` chunks; a redraw deduped; **a real notice
  followed by 20 lines of diff output, which must not match**; and three near-miss lines that must
  not match.
- The chip's CSS is already covered by `test/unit/hover-overlays.test.ts`'s sheet-derived rules; no
  new guard test is needed.

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| Chip | absent | nothing over the terminal | — |
| | armed | clock + `in 4m` (or `at 11:10 PM`) + `×3` | click → dialog |
| | auto | `Auto` badge + `at 11:10 PM` + inline `×` | click → dialog; `×` cancels |
| | offer (`offer` mode) | `!` + `Resume at 11:10 PM?` | click → dialog, on the offer |
| | firing | `Sending…` | — |
| | late | `Sent 10h late` (10 s) | click → dialog |
| Stale card | has waiting schedules | *"1 timed message waiting — it will send when this session starts."* beside Relaunch | click → dialog; Relaunch |
| Session rail / card | has waiting schedules | clock glyph + count badge, independent of the five-state machine | click → session |
| Composer | empty message | Arm disabled, hint *"Type a message"* | — |
| | valid | the resolved-time hint line | Arm · Send now · Cancel |
| | over cap | *"3 timed messages already on this session"*, Arm disabled | cancel one |
| | invalid time | field marked, Arm disabled | — |
| | session has no live PTY | Send now disabled + *"This session isn't running"*; Arm still allowed, hint *"It will wait until this session starts."* | — |
| Schedule row | armed | next fire + repeats left + origin badge | Edit · Send now · Cancel |
| | waiting | *"Waiting — will send when this session starts"* | Edit · Cancel |
| | done | *"Sent 3 of 3 · last 11:10 PM"* | Renew · Cancel |
| | last fire late | *"· 10h late"* on the row | |
| | last fire expired | *"· missed (too old)"* | Renew |
| Offer banner (in dialog, `offer` mode) | pending | reset time + the source line | Resume then · Dismiss |
| Toast | fired / late / missed / auto-armed / rejected | one line | Undo (auto-armed) · Renew (missed) |
| Persisted file | absent / valid / corrupt | nothing / restored schedules / nothing + host log | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Chip | open dialog; cancel (auto) | click; hover → title | reachable when focus is outside xterm; the **palette command is the guaranteed keyboard route** (xterm swallows Tab) | — | `<button>`, `aria-label="Timed message — next in 4 minutes, 3 sends left"`; the `×` is its own labelled button |
| Stale-card Waiting line | open dialog | click | in tab order — the stale card is ordinary DOM, no xterm in the way | — | `<button>`, `aria-label="1 timed message waiting — open"` |
| Rail badge | — (indicator) | hover → title | — | — | `aria-hidden`; the card's accessible name carries "1 timed message waiting" |
| Palette entry | open dialog | click | `Mod+Shift+P` then type | — | inherited from `CommandPalette` |
| Trigger picker | select In / At / Every | click | ←/→/Home/End (`SegmentedRadios`) | — | `role="radiogroup"` |
| Message field | type; quick chips | click | text entry; the chips are buttons in tab order | native | labelled `<input>` |
| Repeats | set count | click / spin | number entry | native | labelled, `aria-describedby` the hint line |
| Composer footer | Arm / Send now / Cancel | click | Tab; **Enter arms** from any field; **Esc** closes, confirming when the message is dirty | — | primary button `aria-keyshortcuts="Enter"`; Send now `aria-disabled` + `aria-describedby` the reason |
| Schedule row | edit / send now / renew / cancel | click | Tab within the trapped dialog | — | `role="group"`, `aria-label` = the message |
| Cancel | delete | click | Enter on the focused button | — | confirms via `confirm-dialog` |
| Offer banner | resume / dismiss | click | Tab | — | `role="group"` |
| Toast | dismiss / Undo / Renew | click | Tab | — | the existing `role="status"` region |

Every pointer action has a keyboard path; the one destructive action (Cancel) confirms; no drag is
introduced.

## 10. Accessibility & i18n

- **The countdown is not a live region.** A per-second `aria-live` chip would be a screen-reader
  firehose. The chip's `aria-label` updates silently; only *arm*, *auto-arm*, *cancel*, *fire*, *miss*
  and *waiting* are announced, once each, through the app's existing `role="status" aria-live="polite"`
  region: *"Timed message armed — Continue, in 30 minutes"*, *"Automatically armed — Continue at 11:10
  PM. Undo available."*, *"Sent Continue to Backend agent"*, *"Sent Continue to Backend agent, 10
  hours late"*, *"Timed message waiting — Backend agent isn't running"*, *"Timed message missed"*.
- **The auto-arm is announced, not silent.** It is the one thing here that happens without the user
  asking, so it gets the same single polite announcement as a manual arm, naming that it was
  automatic and that Undo exists.
- **Colour never alone.** `armed` carries a clock glyph and the time in words; `auto` the literal word
  *Auto*; `offer` a `!` and the word *Resume*; `late` the word *late*; waiting the word *Waiting*.
  Strip the colour and nothing is lost.
- **Contrast:** chip text ≥ 4.5:1 and its border ≥ 3:1 against `--raise` on all three themes; the
  `auto` and `late` tones follow the existing amber treatment (`styles.css:1134` mixes toward
  `--text` precisely because raw `--amber` misses 4.5:1 on its own wash).
- **Focus:** the dialog traps focus (`compare-dialog.tsx`), opens on the message field, and returns
  focus to whatever opened it — the chip, the stale card's line, or the element focused before the
  palette. Cancelling a row returns focus to the next row, or to the composer when it was the last.
- **Keyboard operability:** xterm captures Tab, so the chip is not guaranteed tabbable from inside the
  terminal. The palette command is therefore the documented keyboard route to everything the chip
  offers, and the dialog itself is fully operable from the keyboard. The stale card's Waiting line
  has no such problem — there is no terminal on that surface.
- **Reduced motion:** under `prefers-reduced-motion` or `settings.reduceMotion` the chip does not fade
  in, the `firing` spinner becomes a static glyph, and the `late` flash becomes a plain state change.
- **Forced colors:** the chip signals state with `border` and glyph, not `background`.
- **i18n:** English literals, repo convention, no layer. Times and dates render through
  `Intl.DateTimeFormat` in the user's locale and zone, so 12h/24h follows the OS; durations use
  English short forms (`in 4m`, `10h late`); the persisted file stores epoch ms UTC plus the
  wall-clock intent, never a formatted string.

## 11. Design tokens (UI)

Three semantic roles, defined per theme (Aero / Aero Dark / Neon) beside the existing status tokens,
aliasing the palette rather than restating it — no raw hex:

| Token | Role | Aliases |
|---|---|---|
| `--timer-armed` | the user scheduled this, and it is on track | `var(--accent)` |
| `--timer-auto` | the app scheduled this, or is asking to — the "you didn't ask for this" tier, shared by the `auto` chip and the `offer` state | `var(--amber)` — the same "this concerns you" meaning `needsAttention` already owns |
| `--timer-late` | a fire landed outside its window | `var(--amber)` at the mixed text tier |

Waiting reuses `--text-dim` on the stale card and the rail badge — it is an absence of activity, not
a state that should draw the eye.

The chip reuses `--raise`, `--border-2`, `--elev-3`, `--r-round`, `--text` and `--text-dim` — the
`.term-follow` recipe — so it reads as one family with the existing terminal overlays. No new
elevation or radius is introduced.

## 12. Assumptions

1. **A message delivered while the terminal sits at a bare shell prompt is executed as a shell
   command.** Delivery always sends the text and presses Enter (locked decision 2) and is not gated on
   bracketed-paste mode, so a session that has dropped out of its agent TUI will run the message as a
   command. Recorded, accepted, not designed around. The host never *manufactures* that situation: it
   only ever writes into a PTY the user's own session already had running.
2. **"Fires on relaunch" means after the session is live again**, not at app start. There is no PTY
   for any session immediately after a restart (§0), so a due schedule waits — visibly — until the
   user opens the session or auto-relaunch does. Nothing is ever typed into a dead session, and the
   host never spawns one. *(Conductor decision.)*
3. **`autoResumeOnLimit` defaults to `arm`** because the job is to remove the manual step, not to
   relocate it. Safety is in the arming gates — tail-only matching, one limit schedule per session, a
   self-labelling `Auto` chip with a one-click cancel and an Undo toast — not in asking first.
   *(Conductor decision.)*
4. Delivery is host-side (`pty.input`) rather than through `terminal-bus`, because the timer, the
   schedule and the PTY are all host-owned and a fire must survive an unmounted pane and a restart.
   `terminal-bus`'s bracketed-paste gate is untouched; it gains only a registry-presence read for
   dialog copy. This departs from the mechanism suggested in the original brief — the reasoning is in
   §2 "Delivery".
5. A fire is not user activity: `lastActiveAt` is left alone, so card age, recency sort and board
   linkage keep meaning what they mean.
6. Schedules are per-user runtime state → `userData/timed-messages.json`, never the project's
   `.conduit/`.
7. `relaunch` preserving the session id (`electron/main.ts:2349`) is what lets a schedule survive a
   relaunch; `disposeSession` is the one place they die.
8. The limit detector reads the session's own trailing output and is best-effort by construction:
   anchors rather than a fixed string, the tail rather than the stream, and no parseable time means no
   action at all.
9. `powerMonitor` is not used anywhere in the host today; this feature introduces it for the
   suspend/resume re-evaluation, which is load-bearing on Windows where `setTimeout` does not advance
   across a suspend.
10. Adding a badge rather than a sixth `SessionIconVisualState` keeps the five-state precedence in
    `src/session-icon.ts` and its three consumers untouched; "has a timer waiting" is orthogonal to
    the lifecycle states, not another one of them.
11. Multi-window is last-writer-wins via the host broadcast, as with `review:marks`; the one
    order-sensitive action (resolving an offer) is made idempotent in the host instead.
12. No i18n layer (repo convention); `Intl` is used for formatting and zone maths only.

## 13. Decisions Needed

_None._ Four choices were locked before authoring (both triggers; always press Enter; max-repeats
only; persist and fire late once), and the architecture review's two blockers were resolved by the
conductor and are recorded as §12.2 and §12.3. The remaining design calls — host-side delivery, the
`waiting` state and where it is signalled, renew semantics, the origin-keyed catch-up window, and the
caps — are settled in §2 and §5.

## 14. Open questions

_None._
