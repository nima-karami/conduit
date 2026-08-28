# Timed Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arm a message against a session — in N minutes, at a wall-clock time, or on an interval — and have the host type it into that session's live PTY and press Enter when the time comes; plus a limit-aware auto-resume that reads a usage-limit notice out of the session's own trailing output and arms `Continue` for just after the reset. A schedule survives a restart, waits (visibly) while its session is not running, and lands **once**, marked late.

**Architecture:** One pure, node-free model (`src/timed-messages.ts`) owns the record, the trigger→`nextAt` resolution, the catch-up arithmetic and the sanitiser; the host and the renderer both import it, so the two sides can only disagree by disagreeing with that file. A second pure module (`src/limit-notice.ts`) owns the notice detection. A third (`src/timer-scheduler.ts`) owns the schedule set, the single `setTimeout`, the waiting/settle machinery and the fire decision, with the clock, the timer, the liveness read and the write all **injected** — so the whole scheduler is unit-testable without Electron, and `electron/main.ts` only wires it to `Date.now`, `setTimeout`, `PtyHost` and `persistFile`. Delivery is one host-side call (`pty.input` twice, liveness-checked on both sides of a 120 ms gap), never a renderer round trip. The renderer holds no source of truth: a `timer:state` broadcast fills a module-singleton external store (the `webview/review-marks-store.ts` shape) that the chip, the dialog, the stale card and the rail all read.

**Tech Stack:** TypeScript (two tsconfigs: host `tsconfig.json`, renderer `tsconfig.webview.json`), React 18, Electron IPC via `src/protocol.ts`, `Intl.DateTimeFormat` for zone maths and time formatting, Vitest for unit tests, Playwright-Electron for the e2e scenario, Biome for lint/format.

**Spec:** `docs/specs/2026-08-28-timed-messages.md` — read the **revision note at the top** and **§0** first; they are load-bearing and this plan does not restate them. This plan implements the whole spec (MVP + v1 of §6); the §6 "Vision" items are out of scope.

> **Five things the revision changed. Do not build the pre-revision behaviour.**
> 1. A fire requires a **live PTY**. The host never spawns one. No PTY at `nextAt` → the schedule goes **`waiting`**, `nextAt` is held, nothing is written.
> 2. `autoResumeOnLimit` defaults to **`arm`**, not `offer`. Safety lives in the arming gates (tail-only matching, one limit schedule per session, the self-labelling `Auto` chip), not in asking.
> 3. `deliver()` is liveness-checked **twice** — before the text and again after `SUBMIT_GAP_MS` — and reports whether it landed. `delivered` is derived from `pty.input`'s new boolean return, never assumed.
> 4. There is **no `paused` chip state and no `waiting` chip state**. A non-running session has no pane, so **Waiting** is signalled on the stale card and the session rail instead.
> 5. The catch-up window is keyed on `origin`: `manual` 6 h, `limit` 24 h. And a fire **never** calls `mgr.touch`.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **One write path into a PTY** (`pty.input`) and **one fire path** into it (`deliver`). Delivery is host-side; it does not route through `webview/terminal-bus.ts`, whose bracketed-paste precondition stays exactly as it is. `terminal-bus` gains only `hasRegisteredTerminal(sessionId)`, used for dialog copy. (§2 "Delivery", §12.4)
- **Delivery always sends the text and then `\r`** — two writes, never one string, and never gated on bracketed-paste mode. (locked decision 2)
- **A fire does not call `mgr.touch`.** `lastActiveAt` means *the user interacted*; a 3am robot keystroke would corrupt card age, the rail's recency sort and board linkage. (§2 "Delivery")
- **`nextAt` (epoch ms UTC) is the only authority on when something fires.** The `setTimeout` is a hint; every evaluation re-compares wall-clock `now`. The settle delay, the countdown tick, the `firing`/`late` display windows and the offer-suppression window are **presentational** and may drift or be skipped. (§2 "The timer")
- **No polling.** One `setTimeout` to the earliest `nextAt`, re-armed after every fire and every mutation, clamped to 2^31−1 ms. `powerMonitor`'s `resume` and `unlock-screen` re-evaluate. (§2 "The timer")
- **A message is only ever text the user typed or a built-in constant** (`Continue`). Nothing parsed out of terminal output is ever composed into a message. (§2 "Delivery")
- **Sanitation:** C0/C1 controls and `ESC` removed, tabs/newlines collapsed to single spaces, trimmed, capped at `MAX_MESSAGE_CHARS = 2000`; empty after sanitation is refused. (§2)
- **Caps:** `MAX_PER_SESSION = 3`, `MAX_TOTAL = 20`, **one live `origin:'limit'` schedule per session** (a new auto-arm *replaces*, never accumulates), 2000 chars. (§2, §5)
- **Catch-up windows:** `manual` 6 h, `limit` 24 h, applied at the moment a `waiting` schedule becomes deliverable. Past the window → skipped with `reason:'expired'`. Inside it → **one** delivery, `late: true`; N elapsed interval slots collapse into one delivery with `firedCount` advanced by N, capped at `maxRepeats`. (§2 "Lifecycle")
- **Host boundary validation** (the renderer is not trusted): `sessionId` must exist in `mgr.list()`; `message` re-sanitized host-side; `everyMs >= 60_000`; `maxRepeats` in `1..100`; **`nextAt` recomputed host-side from the submitted trigger**, never accepted as a number; caps enforced; a rejection replies with an error toast, never a silent drop. (§3)
- **Detection reads the session's TRAILING output only** — the last `TAIL_LINES = 3` non-empty ANSI-stripped lines of the tail `pty.lastLine()` already maintains, via a new `PtyHost.tailLines`. A limit string that scrolled past inside a `git log` is not a match. **No parseable time → no notice, no arm, no offer**, one debug log line. (§2 "Limit-aware")
- **Persistence:** `userData/timed-messages.json`, `{ version: 1; schedules: TimedMessage[] }`, written with `persistFile` (atomic), flushed synchronously in `before-quit` behind a **`timersDirty` gate** — exactly the `review-marks.json` shape, for exactly the 0.11.1 durability reason. Corrupt/foreign version → empty + one host log line. A `done` schedule is dropped from the file. (§3)
- **Broadcast, not reply:** `timer:state` and `timer:fired` go to **every** window via `broadcast` (`electron/main.ts:820`); a freshly loaded window gets `timer:state` in its `ready` handler, like `review:marks`. Offer resolution is idempotent in the host. (§3, §4)
- **Schedules die with their session inside `disposeSession`** (`electron/main.ts:1852`), alongside `pty.dispose` / `activity.forget` / the scanners — not lazily. (§2 "Lifecycle")
- **`CONDUIT_E2E=1` only:** the minimum delay/interval floors drop to 0, and `timer:test { op:'advance', ms }` is registered. Neither exists in a shipped build. (§7)
- **Colour never alone:** `armed` carries a clock glyph + the time in words, `auto` the literal word *Auto*, `offer` a `!` + *Resume*, `late` the word *late*, waiting the word *Waiting*. (§10)
- **The countdown is never announced.** Only *arm*, *auto-arm*, *cancel*, *fire*, *miss* and *waiting* reach the `role="status" aria-live="polite"` region, once each. (§10)
- **Reduced motion** (`prefers-reduced-motion` **and** `:root[data-reduce-motion="true"]`): no chip fade-in, static `firing` glyph, no `late` flash. **Forced colors:** the chip signals state with `border` and glyph, not `background`. (§10)
- **Contrast:** chip text >= 4.5:1 against `--raise` in all three themes. Tokens alias the palette (`--accent`, `--amber` mixed toward `--text`, the `.attnchip` recipe at `styles.css:1136`) — **no raw hex**. (§10, §11)
- **The chip is a real `<button>`, always drawn when mounted.** Nothing in this feature sits at `opacity: 0` with pointer events live; the chip's tooltip is `pointer-events: none`. (§2 "Overlay", `test/unit/hover-overlays.test.ts`)
- **Nothing here overlaps `.topbar`.** The dialog rides `.modal__backdrop`, which already carries `-webkit-app-region: no-drag` (`styles.css:999`). (`CLAUDE.md`)
- **NEVER write redundant comments.** A comment explains *why* — a non-obvious constraint or gotcha — never restates *what* the code says. Don't re-explain a decision that lives in the spec; link to it (`// see spec 2026-08-28-timed-messages §2 "Lifecycle"`). (`CLAUDE.md`)
- **Fix root causes, no band-aids.** No `!important`, no specificity escalation, no `as any` / `@ts-ignore`. (`CLAUDE.md`)
- **Two tsconfigs.** `npm run typecheck` runs both. `src/timed-messages.ts` and `src/limit-notice.ts` are imported by the renderer — they may never carry a `node:` import. (`CLAUDE.md`)
- **CI `verify` runs on `ubuntu-latest`.** Every timezone case passes an **explicit IANA zone**; nothing may depend on the machine's `TZ`, `process.platform` or `path.sep`. (`CLAUDE.md`, §7)
- **`npm run verify` is the gate.** Never disable, downgrade, narrow, or defer one of its checks — including `fallow:check`, which fails on an unused export. (`CLAUDE.md`)
- **The e2e runs hidden** on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1` → `show:false`) and **alone on a quiet machine** — a loaded machine fails PTY-adjacent scenarios the way a broken PTY does. (`CLAUDE.md`)
- **Scratch artifacts never land in the repo.** Screenshots go to an absolute path under `%TEMP%\claude-scratch`; run evidence goes to `.autoloop/evidence/` (gitignored). (`CLAUDE.md`)
- **Docs layout is a contract (ADR 0003).** User-facing changes go in root `CHANGELOG.md`.

## Assumptions

Recorded because this is an unattended pipeline — no questions were asked. Each is the conservative reading of a place the spec is silent or slightly ambiguous.

1. **The scenario file is `test/e2e/timed-messages.e2e.mjs`** (plural), matching the module names. §7 writes `timed-message.e2e.mjs`; the run brief names the plural. The runner globs `*.e2e.mjs`, so either works — plural is used everywhere in this plan.
2. **The scheduler is its own module, `src/timer-scheduler.ts`,** rather than inline state in `electron/main.ts` (where `reviewMarks` lives). A timer, a settle window, a delivery race and a catch-up decision are not a `Map` — inline they would be reachable only through the e2e. Every dependency (clock, timer, `isAlive`, `deliver`, persistence, broadcast, session existence) is injected, so the whole thing is exercised by unit tests and `main.ts` only wires it.
3. **`late` needs a threshold; `LATE_GRACE_MS = 30_000`.** The spec never gives one, and an on-time fire is always a few ms past `nextAt`. Anything more than 30 s overdue is `late`.
4. **`resolveClockTime` returns `number | null`,** null for an unparseable `HH:MM`. A total function returning a made-up instant would arm a schedule at a time the user never asked for.
5. **A spring-forward gap resolves to the transition instant itself** — for `America/Toronto` on 2026-03-08, `02:30` resolves to `03:00 EDT` (07:00 UTC), found by bisecting the hour the two offset candidates straddle. §2 says "the instant the clock jumps to"; Luxon's shift-by-the-gap rule (which would give 03:30) is the other reading and is **not** used.
6. **A delivery that fails between the text and the `\r` consumes its slot** and records `delivered: false, reason: 'noSession'`. Half the message is already in the PTY; returning the slot would double it on the next attempt. §4 specifies the reporting, not the slot.
7. **`waiting` schedules get no timer.** The window is applied "at the moment it becomes deliverable" (§4), so a waiting schedule wakes on `term:start`, never on a clock — which is also what keeps an idle app's timer set empty.
8. **`Renew` keeps `lastFire`.** §2 says it resets `firedCount`, `state` and `nextAt`; the row's "Last sent 11:10 PM" is the user's only receipt, and dropping it on renew would erase it.
9. **The toast store grows an optional `action`** (`{ label, run }`), rendered as one button. §2 asks for **Undo** on the auto-arm toast and **Renew** on the missed toast, and `webview/toast-store.ts` has no action channel today.
10. **The rail badge is an independent indicator, not a sixth `SessionIconVisualState`** — §12.10, verbatim. `src/session-icon.ts` and its three consumers are untouched. `SessionCard` reads the waiting count from the store **directly** rather than taking a prop: it is a leaf component, the store is a module singleton, and threading one number through the sidebar's sort / group / drag plumbing would touch four call sites for nothing.
11. **`autoResumeOnLimit` lives in Settings › General › "Notifications"** as a `SelectField` (`off` / `offer` / `arm`). §5 says "Settings › Behaviour"; the modal has no tab by that name — General is where `osAttention` and `autoRelaunchStale` live, which is the same class of decision.
12. **The e2e proves the on-time path byte-for-byte with `runShellReader`** (a PowerShell reader that dumps raw stdin, so the text *and* the `\r` are both visible), and proves the **restart** path with a real `cmd.exe` echo — a reader cannot be pre-armed inside a shell that does not exist yet, and §7's own Gherkin uses `echo conduit-timed-ok` for exactly that scenario.
13. **`lastNonEmptyLines` is added to `src/last-line.ts`** and `lastNonEmptyLine` is refactored onto it, rather than `PtyHost` growing its own line splitter. The `LAST_LINE_MAX` truncation stays on the single-line function only — a limit notice can be longer than a card subtitle.
14. **The offer's suppression window (30 min) and the episode map are host memory keyed by `sessionId`,** never persisted (§2 "Limit-aware"), and are dropped in `disposeSession` alongside the other scanners.
15. **`describeNext` takes an injected `formatTime`.** Wall-clock rendering goes through `Intl.DateTimeFormat` in the user's locale (§10), which is exactly what a CI-portable unit test cannot assert against — so the pure module takes the formatter and the renderer supplies the real one.
16. **The `At` composer is a native `<input type="time">`,** not a hand-rolled `HH:MM` field plus an am/pm control. §2 describes the latter; the native control already follows the OS's 12h/24h preference (which is what §10 asks for), is already keyboard-operable, and hands back the 24-hour string `resolveClockTime` wants. One control instead of two, with no bespoke parsing to get wrong.
17. **The chip is a `role="group"` wrapping two real buttons** — the surface that opens the dialog, and the `auto` state's `×`. §2 says "it is a real `<button>`" and §9 says "the `×` is its own labelled button"; a `<button>` inside a `<button>` is invalid HTML and the inner one is unreachable in several browsers, so the group is the only shape that satisfies both.
18. **`firing` is derived, not pushed.** The host sends no "I am delivering" message; the chip infers it from "the earliest armed schedule's `nextAt` has passed and no `timer:fired` for it has arrived", which is exactly the in-flight window. Adding a host message for a ≤2 s presentational state would put a third channel on the wire for nothing.
19. **The restart scenario arms at +8 s rather than §7's +2 s.** The intent — no clock injection, a real close and relaunch — is unchanged, but `closeApp` answers a quit-guard prompt and can take a second or two, and a 2 s delay races the shutdown: if it fired first the scenario would be flaky in the direction of a false pass. At +8 s it cannot fire before the first app is gone, and the assertion is written so it holds whether the schedule came due while the app was closed or a moment after it came back — either way the session is `stale` with no PTY, so it can only settle on `waiting`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/timed-messages.ts` | The model: record shape, constants/caps, `sanitizeMessage`, id, `resolveClockTime`, `nextFireAt`, `buildSchedule`, `capError`, `catchUp`, `advanceAfterFire`, `markWaiting`, `renew`, `describeNext`, file parse/serialize. Node-free. |
| `src/limit-notice.ts` | Pure limit-notice detection over a tail: the three anchors, the time forms, the zone, and the episode decision. Node-free. |
| `src/timer-scheduler.ts` | The schedule store + single timer + waiting/settle + fire decision. Every dependency injected; node-free. |
| `webview/timer-store.ts` | Renderer mirror of `timer:state` / `timer:fired` with a load gate (the `review-marks-store.ts` shape). |
| `webview/components/timed-message-dialog.tsx` | Focus-trapped composer + this session's schedule list. |
| `webview/components/timer-chip.tsx` | The terminal overlay chip. |
| `test/unit/timed-messages.test.ts`, `test/unit/limit-notice.test.ts`, `test/unit/timer-scheduler.test.ts`, `test/unit/pty-host-io.test.ts`, `test/unit/timer-store.test.ts` | Unit coverage. |
| `test/e2e/timed-messages.e2e.mjs` | The host/PTY-boundary scenario. |

**Modified**

| File | Change |
|---|---|
| `src/last-line.ts` | `lastNonEmptyLines(tail, n)`; `lastNonEmptyLine` refactored onto it. |
| `src/pty-host.ts` | `input` returns `boolean`; new `tailLines(sessionId, n)`. |
| `src/protocol.ts` | Re-export the model types; `timer:state` / `timer:fired` (host→windows); `timer:set` / `timer:cancel` / `timer:renew` / `timer:sendNow` / `timer:sendOnce` / `timer:offer` / `timer:test` (webview→host). |
| `src/settings.ts` | `autoResumeOnLimit: 'off' \| 'offer' \| 'arm'`, default `'arm'`. |
| `electron/main.ts` | Scheduler wiring, `deliverTimedMessage`, persistence + dirty gate + quit flush, `term:start` settle hook, `disposeSession` line, `powerMonitor`, the limit scanner beside `countBareBells`, the seven `timer:*` cases, `ready` push. |
| `webview/bridge.ts` | Preview replies for the `timer:*` messages. |
| `webview/terminal-bus.ts` | `hasRegisteredTerminal(sessionId)`. |
| `webview/toast-store.ts`, `webview/components/toasts.tsx` | Optional one-button toast action. |
| `webview/components/terminal-pane.tsx` | Mount `TimerChip` in `.termpane-wrap`. |
| `webview/components/center-pane.tsx` | The stale card's Waiting line. |
| `webview/components/session-card.tsx` | The rail's waiting badge (reads the store directly — `sidebar.tsx` is untouched). |
| `webview/app.tsx` | Palette command, context-menu row, dialog mount, live-region announcements. |
| `webview/components/settings-modal.tsx` | The `autoResumeOnLimit` row. |
| `webview/styles.css` | Three tokens x three themes; chip, dialog, stale line, rail badge; reduced-motion + forced-colors blocks. |
| `test/unit/theme-tokens.test.ts` | Contrast assertions for the three tokens. |
| `test/unit/coerce-settings.test.ts` | `autoResumeOnLimit` coercion. |
| `test/unit/last-line.test.ts`, `test/unit/terminal-bus.test.ts`, `test/unit/toast-store.test.ts` | Extend for the new functions. |
| `CHANGELOG.md` | New `## [Unreleased]` → `### Added`. |

---

## Task 1: The pure model (`src/timed-messages.ts`)

**Files:**
- Create: `src/timed-messages.ts`
- Test: `test/unit/timed-messages.test.ts`

**Interfaces:**
- Consumes: nothing (node-free; `Intl` only).
- Produces:
  - `TimedMessage`, `TimedMessageKind`, `TimedMessageState`, `TimedMessageOrigin`, `FireFailure`, `ClockSpec`, `LastFire`, `TriggerInput`, `TimedMessageInput`, `TimedMessagesFile`, `DueDecision`
  - constants: `MAX_MESSAGE_CHARS`, `MAX_PER_SESSION`, `MAX_TOTAL`, `MIN_DELAY_MS`, `MIN_INTERVAL_MS`, `MAX_REPEATS`, `DEFAULT_REPEATS`, `DEFAULT_DELAY_MS`, `CLOCK_GRACE_MS`, `MAX_CLOCK_AHEAD_MS`, `CATCHUP_MS`, `LATE_GRACE_MS`, `LIMIT_PADDING_MS`, `LIMIT_MESSAGE`, `PTY_SETTLE_MS`, `SUBMIT_GAP_MS`, `HOUR_MS`
  - `sanitizeMessage`, `newTimedMessageId`, `resolveClockTime`, `nextFireAt`, `buildSchedule`, `capError`, `catchUp`, `advanceAfterFire`, `markWaiting`, `renew`, `formatDuration`, `describeNext`, `parseTimedMessagesFile`, `serializeTimedMessagesFile`

This is `src/review-marks.ts`'s role for this feature: the disk shape and the wire shape are the same object, and both sides import the same arithmetic. Nothing here touches `node:`, so the renderer can import it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/timed-messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  advanceAfterFire,
  buildSchedule,
  capError,
  CATCHUP_MS,
  catchUp,
  CLOCK_GRACE_MS,
  describeNext,
  formatDuration,
  LATE_GRACE_MS,
  MAX_CLOCK_AHEAD_MS,
  MAX_MESSAGE_CHARS,
  MAX_PER_SESSION,
  MAX_TOTAL,
  markWaiting,
  newTimedMessageId,
  nextFireAt,
  parseTimedMessagesFile,
  renew,
  resolveClockTime,
  sanitizeMessage,
  serializeTimedMessagesFile,
  type TimedMessage,
} from '../../src/timed-messages';

const TORONTO = 'America/Toronto';
const HOUR = 3_600_000;

/** A fixed, zone-independent instant to anchor the clock cases: 2026-08-28T15:00:00Z. */
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

const schedule = (over: Partial<TimedMessage> = {}): TimedMessage => ({
  id: 'tm-1',
  sessionId: 's1',
  message: 'Continue',
  kind: 'once',
  nextAt: NOW,
  maxRepeats: 1,
  firedCount: 0,
  state: 'armed',
  origin: 'manual',
  createdAt: NOW - HOUR,
  ...over,
});

describe('sanitizeMessage', () => {
  it('collapses newlines, carriage returns and tabs into single spaces', () => {
    expect(sanitizeMessage('a\r\nb\tc\n\n d')).toBe('a b c d');
  });

  it('strips ESC and every other C0 control', () => {
    expect(sanitizeMessage('\u001b[31mred\u001b[0m\u0000 ok')).toBe('[31mred[0m ok');
  });

  it('strips C1 controls and DEL', () => {
    expect(sanitizeMessage('a\u0090b\u007fc')).toBe('abc');
  });

  it('trims and caps at 2000 characters', () => {
    const long = sanitizeMessage(`  ${'x'.repeat(MAX_MESSAGE_CHARS + 500)}  `);
    expect(long.length).toBe(MAX_MESSAGE_CHARS);
    expect(long.startsWith('x')).toBe(true);
  });

  it('reduces a whitespace-only message to the empty string', () => {
    expect(sanitizeMessage('\r\n\t   ')).toBe('');
  });

  it('leaves an ordinary message alone', () => {
    expect(sanitizeMessage('Continue')).toBe('Continue');
  });
});

describe('newTimedMessageId', () => {
  it('follows the review-notes id convention', () => {
    expect(newTimedMessageId(NOW, () => 0.5)).toMatch(/^tm-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('is unique across calls at the same instant', () => {
    const a = newTimedMessageId(NOW, () => 0.123456);
    const b = newTimedMessageId(NOW, () => 0.987654);
    expect(a).not.toBe(b);
  });
});

describe('resolveClockTime', () => {
  it('resolves the next occurrence today in an explicit zone', () => {
    // 15:00Z on 2026-08-28 is 11:00 EDT; 23:10 EDT the same day is 03:10Z on the 29th.
    expect(resolveClockTime('23:10', TORONTO, NOW)).toBe(Date.UTC(2026, 7, 29, 3, 10));
  });

  it('rolls to tomorrow when the wall clock already passed', () => {
    // 10:00 EDT is 14:00Z — an hour before NOW, well outside the grace.
    expect(resolveClockTime('10:00', TORONTO, NOW)).toBe(Date.UTC(2026, 7, 29, 14, 0));
  });

  it('means NOW inside the two-minute backward grace', () => {
    const justPassed = Date.UTC(2026, 7, 28, 14, 59); // 10:59 EDT, one minute ago
    const t = resolveClockTime('10:59', TORONTO, NOW);
    expect(t).toBe(justPassed);
    expect(NOW - t).toBeLessThanOrEqual(CLOCK_GRACE_MS);
  });

  it('rolls to tomorrow one millisecond past the grace', () => {
    const now = Date.UTC(2026, 7, 28, 15, 0) + CLOCK_GRACE_MS + 1;
    expect(resolveClockTime('10:58', TORONTO, now)).toBe(Date.UTC(2026, 7, 29, 14, 58));
  });

  it('resolves a spring-forward gap to the instant the clock jumps to', () => {
    // 2026-03-08, America/Toronto: 02:00 EST becomes 03:00 EDT, so 02:30 never happens.
    const before = Date.UTC(2026, 2, 8, 5, 0); // 00:00 EST
    expect(resolveClockTime('02:30', TORONTO, before)).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });

  it('resolves a fall-back ambiguity to the EARLIER instant', () => {
    // 2026-11-01, America/Toronto: 01:30 happens twice — 05:30Z (EDT) then 06:30Z (EST).
    const before = Date.UTC(2026, 10, 1, 4, 0); // 00:00 EDT
    expect(resolveClockTime('01:30', TORONTO, before)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('never resolves more than 25 hours ahead', () => {
    expect(MAX_CLOCK_AHEAD_MS).toBe(25 * HOUR);
    for (const clock of ['00:00', '06:30', '12:00', '18:45', '23:59']) {
      const t = resolveClockTime(clock, TORONTO, NOW);
      expect(t).not.toBeNull();
      expect((t as number) - NOW).toBeLessThanOrEqual(MAX_CLOCK_AHEAD_MS);
    }
  });

  it('falls back to the local zone for an unusable zone string', () => {
    // 'EDT' is an abbreviation, not an IANA id — Intl throws on it. CI is ubuntu, so the
    // assertion compares against the zone-less answer rather than a fixed instant.
    expect(resolveClockTime('23:10', 'EDT', NOW)).toBe(resolveClockTime('23:10', undefined, NOW));
  });

  it('returns null for a clock it cannot read', () => {
    expect(resolveClockTime('11pm', TORONTO, NOW)).toBeNull();
    expect(resolveClockTime('25:00', TORONTO, NOW)).toBeNull();
    expect(resolveClockTime('', TORONTO, NOW)).toBeNull();
  });
});

describe('nextFireAt', () => {
  it('resolves each trigger to an instant, and null for an unreadable clock', () => {
    expect(nextFireAt({ kind: 'in', delayMs: 60_000 }, NOW)).toBe(NOW + 60_000);
    expect(nextFireAt({ kind: 'every', everyMs: 2 * HOUR, maxRepeats: 3 }, NOW)).toBe(NOW + 2 * HOUR);
    expect(nextFireAt({ kind: 'at', clock: '23:10', zone: TORONTO }, NOW)).toBe(
      Date.UTC(2026, 7, 29, 3, 10),
    );
    expect(nextFireAt({ kind: 'at', clock: 'noon' }, NOW)).toBeNull();
  });
});

describe('buildSchedule', () => {
  it('builds an In schedule at now + delay', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'Continue', trigger: { kind: 'in', delayMs: 30 * 60_000 } },
      NOW,
      { id: 'tm-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule).toMatchObject({
      id: 'tm-1',
      kind: 'once',
      maxRepeats: 1,
      firedCount: 0,
      state: 'armed',
      origin: 'manual',
      nextAt: NOW + 30 * 60_000,
    });
    expect(r.schedule.spec).toBeUndefined();
    expect(r.schedule.everyMs).toBeUndefined();
  });

  it('stores the wall-clock intent for an At schedule, which Renew needs', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'Continue', trigger: { kind: 'at', clock: '23:10', zone: TORONTO } },
      NOW,
      { id: 'tm-2' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule.spec).toEqual({ clock: '23:10', zone: TORONTO });
    expect(r.schedule.nextAt).toBe(Date.UTC(2026, 7, 29, 3, 10));
  });

  it('builds an interval schedule at now + everyMs with its repeat count', () => {
    const r = buildSchedule(
      {
        sessionId: 's1',
        message: 'Do this again',
        trigger: { kind: 'every', everyMs: 2 * HOUR, maxRepeats: 5 },
      },
      NOW,
      { id: 'tm-3' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule).toMatchObject({ kind: 'interval', everyMs: 2 * HOUR, maxRepeats: 5 });
    expect(r.schedule.nextAt).toBe(NOW + 2 * HOUR);
  });

  it('sanitizes the message it stores', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'go\r\nnow', trigger: { kind: 'in', delayMs: 60_000 } },
      NOW,
    );
    expect(r.ok && r.schedule.message).toBe('go now');
  });

  it('refuses a message that sanitizes to nothing', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: '\r\n', trigger: { kind: 'in', delayMs: 60_000 } },
      NOW,
    );
    expect(r).toEqual({ ok: false, error: 'Type a message to send.' });
  });

  it('refuses a delay under the floor, and honours a lowered floor', () => {
    const input = { sessionId: 's1', message: 'go', trigger: { kind: 'in' as const, delayMs: 800 } };
    expect(buildSchedule(input, NOW).ok).toBe(false);
    expect(buildSchedule(input, NOW, { minDelayMs: 0 }).ok).toBe(true);
  });

  it('refuses an interval under a minute and a repeat count out of range', () => {
    expect(
      buildSchedule(
        { sessionId: 's1', message: 'go', trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 } },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      buildSchedule(
        { sessionId: 's1', message: 'go', trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 0 } },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      buildSchedule(
        { sessionId: 's1', message: 'go', trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 101 } },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('refuses an unreadable clock', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'go', trigger: { kind: 'at', clock: 'half eleven' } },
      NOW,
    );
    expect(r.ok).toBe(false);
  });
});

describe('capError', () => {
  const on = (sessionId: string, id: string) => schedule({ id, sessionId });

  it('allows the third schedule on a session and refuses the fourth', () => {
    const three = [on('s1', 'a'), on('s1', 'b'), on('s1', 'c')];
    expect(capError(three.slice(0, 2), 's1', undefined)).toBeNull();
    expect(capError(three, 's1', undefined)).toBe(
      `${MAX_PER_SESSION} timed messages already on this session — cancel one first.`,
    );
  });

  it('does not count the schedule being edited against its own cap', () => {
    const three = [on('s1', 'a'), on('s1', 'b'), on('s1', 'c')];
    expect(capError(three, 's1', 'b')).toBeNull();
  });

  it('does not count done schedules', () => {
    const three = [
      on('s1', 'a'),
      on('s1', 'b'),
      schedule({ id: 'c', sessionId: 's1', state: 'done' }),
    ];
    expect(capError(three, 's1', undefined)).toBeNull();
  });

  it('refuses past the global total', () => {
    const many = Array.from({ length: MAX_TOTAL }, (_, i) => on(`s${i}`, `id${i}`));
    expect(capError(many, 'sNew', undefined)).toBe(
      `${MAX_TOTAL} timed messages already armed — cancel one first.`,
    );
  });
});

describe('catchUp', () => {
  it('waits while nextAt is still ahead', () => {
    expect(catchUp(schedule({ nextAt: NOW + 60_000 }), NOW)).toMatchObject({ action: 'wait' });
  });

  it('fires on time without marking late, right up to the grace', () => {
    expect(catchUp(schedule({ nextAt: NOW - 5 }), NOW)).toMatchObject({
      action: 'fire',
      late: false,
      slots: 1,
    });
    expect(catchUp(schedule({ nextAt: NOW - LATE_GRACE_MS }), NOW).late).toBe(false);
    expect(catchUp(schedule({ nextAt: NOW - LATE_GRACE_MS - 1 }), NOW).late).toBe(true);
  });

  it('fires late inside the manual window', () => {
    const d = catchUp(schedule({ nextAt: NOW - 5 * HOUR }), NOW);
    expect(d).toMatchObject({ action: 'fire', late: true, slots: 1 });
  });

  it('skips a manual schedule past its 6 hour window', () => {
    const d = catchUp(schedule({ nextAt: NOW - CATCHUP_MS.manual - 1 }), NOW);
    expect(d.action).toBe('skip');
  });

  it('delivers the lid-closed-overnight limit case and skips the same delay for manual', () => {
    const overnight = 10 * HOUR;
    expect(
      catchUp(schedule({ origin: 'limit', nextAt: NOW - overnight }), NOW),
    ).toMatchObject({ action: 'fire', late: true });
    expect(catchUp(schedule({ origin: 'manual', nextAt: NOW - overnight }), NOW).action).toBe(
      'skip',
    );
  });

  it('skips a limit schedule past its 24 hour window', () => {
    expect(catchUp(schedule({ origin: 'limit', nextAt: NOW - CATCHUP_MS.limit - 1 }), NOW).action).toBe(
      'skip',
    );
  });

  it('collapses several elapsed interval slots into one delivery', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: HOUR,
      maxRepeats: 10,
      nextAt: NOW - 3 * HOUR - 1,
    });
    expect(catchUp(s, NOW)).toMatchObject({ action: 'fire', slots: 4, late: true });
  });

  it('caps the collapsed slots at the repeats that remain', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: HOUR,
      maxRepeats: 3,
      firedCount: 1,
      nextAt: NOW - 5 * HOUR,
    });
    expect(catchUp(s, NOW).slots).toBe(2);
  });

  it('never fires a schedule with no repeats left or one already done', () => {
    expect(catchUp(schedule({ maxRepeats: 1, firedCount: 1, nextAt: NOW - 1 }), NOW).action).toBe(
      'wait',
    );
    expect(catchUp(schedule({ state: 'done', nextAt: NOW - 1 }), NOW).action).toBe('wait');
  });

  it('treats a waiting schedule as due — the window is applied when it becomes deliverable', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR, nextAt: NOW - HOUR });
    expect(catchUp(s, NOW)).toMatchObject({ action: 'fire', late: true });
  });
});

describe('advanceAfterFire', () => {
  it('marks a once schedule done and records the fire', () => {
    const next = advanceAfterFire(schedule(), NOW, { slots: 1, late: false, delivered: true });
    expect(next).toMatchObject({ firedCount: 1, state: 'done' });
    expect(next.lastFire).toEqual({ at: NOW, late: false, delivered: true });
  });

  it('re-arms an interval at nextAt + slots * everyMs', () => {
    const s = schedule({ kind: 'interval', everyMs: HOUR, maxRepeats: 3, nextAt: NOW - 2 * HOUR });
    const next = advanceAfterFire(s, NOW, { slots: 3, late: true, delivered: true });
    // 3 slots consumed of 3 → done, and nextAt is never moved past the end.
    expect(next).toMatchObject({ firedCount: 3, state: 'done' });

    const partial = advanceAfterFire(
      schedule({ kind: 'interval', everyMs: HOUR, maxRepeats: 5, nextAt: NOW - 1 }),
      NOW,
      { slots: 1, late: false, delivered: true },
    );
    expect(partial).toMatchObject({ firedCount: 1, state: 'armed', nextAt: NOW - 1 + HOUR });
  });

  it('advances past NOW when several slots elapsed, so it cannot re-fire immediately', () => {
    const s = schedule({ kind: 'interval', everyMs: HOUR, maxRepeats: 10, nextAt: NOW - 3 * HOUR - 1 });
    const next = advanceAfterFire(s, NOW, { slots: 4, late: true, delivered: true });
    expect(next.nextAt).toBeGreaterThan(NOW);
  });

  it('records a failure reason and clears the waiting marker', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR });
    const next = advanceAfterFire(s, NOW, {
      slots: 1,
      late: true,
      delivered: false,
      reason: 'noSession',
    });
    expect(next.lastFire).toEqual({ at: NOW, late: true, delivered: false, reason: 'noSession' });
    expect(next.waitingSince).toBeUndefined();
    expect(next.state).toBe('done');
  });
});

describe('markWaiting', () => {
  it('stamps waitingSince with the missed nextAt', () => {
    const s = schedule({ nextAt: NOW - HOUR });
    const w = markWaiting(s, s.nextAt);
    expect(w).toMatchObject({ state: 'waiting', waitingSince: NOW - HOUR, nextAt: NOW - HOUR });
  });

  it('is idempotent, so a re-evaluation raises no change', () => {
    const w = markWaiting(schedule(), NOW);
    expect(markWaiting(w, NOW)).toBe(w);
  });
});

describe('renew', () => {
  it('re-resolves the stored wall clock for an At schedule rather than adding an offset', () => {
    const s = schedule({
      spec: { clock: '23:10', zone: TORONTO },
      nextAt: NOW - 5 * HOUR,
      firedCount: 1,
      state: 'done',
      lastFire: { at: NOW - 5 * HOUR, late: false, delivered: true },
    });
    const r = renew(s, NOW);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      nextAt: Date.UTC(2026, 7, 29, 3, 10),
      firedCount: 0,
      state: 'armed',
    });
    // The receipt survives: the row's "Last sent" is the user's only record of the fire.
    expect(r?.lastFire).toEqual(s.lastFire);
  });

  it('restarts an interval at now + everyMs', () => {
    const s = schedule({ kind: 'interval', everyMs: 2 * HOUR, maxRepeats: 5, firedCount: 5, state: 'done' });
    expect(renew(s, NOW)).toMatchObject({ nextAt: NOW + 2 * HOUR, firedCount: 0, state: 'armed' });
  });

  it('restarts a plain delay at its original distance from creation', () => {
    const s = schedule({ createdAt: NOW - 4 * HOUR, nextAt: NOW - 3 * HOUR, state: 'done', firedCount: 1 });
    expect(renew(s, NOW)?.nextAt).toBe(NOW + HOUR);
  });

  it('drops the waiting marker', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR });
    expect(renew(s, NOW)?.waitingSince).toBeUndefined();
  });
});

describe('formatDuration / describeNext', () => {
  const at = () => '11:10 PM';

  it('formats short forms', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4 * 60_000)).toBe('4m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(2 * HOUR + 12 * 60_000)).toBe('2h 12m');
    expect(formatDuration(30 * HOUR)).toBe('1d');
  });

  it('counts down under an hour and names the clock time beyond it', () => {
    expect(describeNext(schedule({ nextAt: NOW + 4 * 60_000 }), NOW, at)).toBe('in 4m');
    expect(describeNext(schedule({ nextAt: NOW + 4 * HOUR }), NOW, at)).toBe('at 11:10 PM');
  });

  it('says Waiting and the completed count instead of a countdown', () => {
    expect(describeNext(schedule({ state: 'waiting' }), NOW, at)).toBe('Waiting');
    expect(
      describeNext(schedule({ state: 'done', firedCount: 3, maxRepeats: 3 }), NOW, at),
    ).toBe('Sent 3 of 3');
  });

  it('says due now for a schedule whose moment has passed', () => {
    expect(describeNext(schedule({ nextAt: NOW - 1 }), NOW, at)).toBe('due now');
  });
});

describe('the persisted file', () => {
  it('round-trips armed and waiting schedules', () => {
    const file = { version: 1 as const, schedules: [schedule(), schedule({ id: 'tm-2', state: 'waiting' as const })] };
    expect(parseTimedMessagesFile(serializeTimedMessagesFile(file)).schedules).toHaveLength(2);
  });

  it('drops done schedules on write — they exist only for the rest of the run', () => {
    const file = {
      version: 1 as const,
      schedules: [schedule(), schedule({ id: 'tm-2', state: 'done' as const })],
    };
    const back = parseTimedMessagesFile(serializeTimedMessagesFile(file));
    expect(back.schedules.map((s) => s.id)).toEqual(['tm-1']);
  });

  it('treats an absent, corrupt or foreign-version file as empty', () => {
    expect(parseTimedMessagesFile(undefined).schedules).toEqual([]);
    expect(parseTimedMessagesFile('{oops').schedules).toEqual([]);
    expect(parseTimedMessagesFile('[]').schedules).toEqual([]);
    expect(parseTimedMessagesFile(JSON.stringify({ version: 2, schedules: [schedule()] })).schedules).toEqual([]);
  });

  it('drops entries that are not schedules and caps the total', () => {
    const junk = JSON.stringify({
      version: 1,
      schedules: [schedule(), { id: 'x' }, null, 'nope'],
    });
    expect(parseTimedMessagesFile(junk).schedules).toHaveLength(1);

    const flood = JSON.stringify({
      version: 1,
      schedules: Array.from({ length: MAX_TOTAL + 5 }, (_, i) => schedule({ id: `tm-${i}` })),
    });
    expect(parseTimedMessagesFile(flood).schedules).toHaveLength(MAX_TOTAL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/timed-messages.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/timed-messages"`.

- [ ] **Step 3: Write the implementation**

Create `src/timed-messages.ts`:

```ts
/**
 * The timed-message model (spec 2026-08-28-timed-messages §2 "The schedule"). Node-free on
 * purpose: the HOST owns userData/timed-messages.json and the scheduler with it, and the
 * RENDERER renders the chip, the dialog and the countdown from it — so the two sides can only
 * ever disagree by disagreeing with this file. Same role src/review-marks.ts plays for marks.
 */

export type TimedMessageKind = 'once' | 'interval';
export type TimedMessageState = 'armed' | 'waiting' | 'done';
export type TimedMessageOrigin = 'manual' | 'limit';
/** Why a due fire produced no delivery. */
export type FireFailure = 'expired' | 'noSession';

/** The wall-clock intent behind an `At` schedule. Sole consumer: Renew (§2 "Triggers"). */
export interface ClockSpec {
  clock: string;
  zone?: string;
}

export interface LastFire {
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface TimedMessage {
  /** `tm-<base36>-<rand>` — the src/review-notes.ts id convention. */
  id: string;
  sessionId: string;
  /** Sanitized, single line. */
  message: string;
  kind: TimedMessageKind;
  /** Epoch ms UTC — authoritative, recomputed after each fire. */
  nextAt: number;
  everyMs?: number;
  spec?: ClockSpec;
  maxRepeats: number;
  firedCount: number;
  state: TimedMessageState;
  /** When it came due with no live PTY — drives the Waiting signal and the toast copy. */
  waitingSince?: number;
  origin: TimedMessageOrigin;
  createdAt: number;
  lastFire?: LastFire;
}

export interface TimedMessagesFile {
  version: 1;
  schedules: TimedMessage[];
}

/** What the composer submits. `nextAt` is deliberately absent: the host derives it (§3). */
export type TriggerInput =
  | { kind: 'in'; delayMs: number }
  | { kind: 'at'; clock: string; zone?: string }
  | { kind: 'every'; everyMs: number; maxRepeats: number };

export interface TimedMessageInput {
  id?: string;
  sessionId: string;
  message: string;
  trigger: TriggerInput;
  origin?: TimedMessageOrigin;
}

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_PER_SESSION = 3;
export const MAX_TOTAL = 20;
export const MIN_DELAY_MS = 30_000;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_REPEATS = 100;
export const DEFAULT_REPEATS = 5;
export const DEFAULT_DELAY_MS = 30 * 60_000;
/** Backward grace on an `At` time, so "11:10pm" typed at 11:11pm means now, not tomorrow. */
export const CLOCK_GRACE_MS = 120_000;
export const MAX_CLOCK_AHEAD_MS = 25 * 3_600_000;
export const HOUR_MS = 3_600_000;
/** How stale an intent may be when it finally becomes deliverable — the two decay differently. */
export const CATCHUP_MS: Record<TimedMessageOrigin, number> = {
  manual: 6 * HOUR_MS,
  limit: 24 * HOUR_MS,
};
/** Past this much overdue a fire is reported as late. An on-time fire is always a few ms out. */
export const LATE_GRACE_MS = 30_000;
/** Reset boundaries are approximate, so an auto-resume aims just past one (§5). */
export const LIMIT_PADDING_MS = 60_000;
/** The ONLY message the app composes for itself — never anything parsed from output (§2). */
export const LIMIT_MESSAGE = 'Continue';
/** A message written into a shell that has not printed its prompt yet is lost (§2). */
export const PTY_SETTLE_MS = 3_000;
/** Two writes, not one: a TUI coalescing a single read keeps a trailing CR as literal text. */
export const SUBMIT_GAP_MS = 120;

/**
 * One line, no control characters. This is what makes "always press Enter" safe to specify
 * (§2 "Delivery"): the payload cannot submit early or inject an escape sequence.
 */
export function sanitizeMessage(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) {
      out += ' ';
      continue;
    }
    if (c < 0x20 || c === 0x7f) continue; // C0 + DEL, ESC included
    if (c >= 0x80 && c <= 0x9f) continue; // C1
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS).trimEnd();
}

export function newTimedMessageId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `tm-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

const ZONE_OPTS: Intl.DateTimeFormatOptions = {
  // h23 rather than hour12:false — the latter still yields '24' for midnight on older ICU.
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * A formatter pinned to `zone`, or null when the runtime rejects the id. An abbreviation like
 * `EDT` is exactly that case, and §2 says it falls back to local rather than failing.
 */
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const hit = FORMATTERS.get(zone);
  if (hit) return hit;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...ZONE_OPTS });
    fmt.format(0);
    FORMATTERS.set(zone, fmt);
    return fmt;
  } catch {
    return null;
  }
}

/** UTC is the last resort rather than `Date`'s own offset: CI runs on ubuntu and the answer must
 *  never move with the machine's TZ (CLAUDE.md). */
const UTC_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...ZONE_OPTS });

function localFormatter(): Intl.DateTimeFormat {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (local ? zoneFormatter(local) : null) ?? UTC_FORMATTER;
}

function wallClockIn(fmt: Intl.DateTimeFormat, at: number): Wall {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** The zone's UTC offset in ms at `at` (local minus UTC), read through Intl — never Date's. */
function offsetAt(fmt: Intl.DateTimeFormat, at: number): number {
  const w = wallClockIn(fmt, at);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
}

/**
 * The first instant on the far side of an offset transition that `lo`..`hi` straddles.
 * Bisected to the minute, which is where every real transition sits.
 */
function transitionBetween(fmt: Intl.DateTimeFormat, lo: number, hi: number): number {
  const before = offsetAt(fmt, lo);
  let low = lo;
  let high = hi;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
    if (mid === low) break;
    if (offsetAt(fmt, mid) === before) low = mid;
    else high = mid;
  }
  return high;
}

/**
 * The UTC instant for a wall clock in a zone, converged in two passes. A fall-back ambiguity
 * settles on the EARLIER instant (the first pass already agrees with itself there); a
 * spring-forward gap — where neither pass agrees — answers with the instant the clock jumps to.
 */
function instantFor(fmt: Intl.DateTimeFormat, y: number, mo: number, d: number, h: number, mi: number): number {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  const o1 = offsetAt(fmt, target);
  const t1 = target - o1;
  const o2 = offsetAt(fmt, t1);
  if (o2 === o1) return t1;
  const t2 = target - o2;
  if (offsetAt(fmt, t2) === o2) return t2;
  return transitionBetween(fmt, Math.min(t1, t2), Math.max(t1, t2));
}

/**
 * The next occurrence of a `HH:MM` wall clock in `zone` (absent or unusable → the machine's),
 * with CLOCK_GRACE_MS of backward tolerance. Null when the clock string is unreadable — a
 * total function here would arm a schedule at a time nobody asked for.
 */
export function resolveClockTime(clock: string, zone: string | undefined, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const fmt = (zone ? zoneFormatter(zone) : null) ?? localFormatter();
  const today = wallClockIn(fmt, now);
  for (let add = 0; add <= 2; add++) {
    const t = instantFor(fmt, today.y, today.mo, today.d + add, h, mi);
    if (t >= now - CLOCK_GRACE_MS) return Math.min(t, now + MAX_CLOCK_AHEAD_MS);
  }
  return null;
}

export function nextFireAt(trigger: TriggerInput, now: number): number | null {
  if (trigger.kind === 'at') return resolveClockTime(trigger.clock, trigger.zone, now);
  if (trigger.kind === 'in') return now + trigger.delayMs;
  return now + trigger.everyMs;
}

export type BuildResult = { ok: true; schedule: TimedMessage } | { ok: false; error: string };

/**
 * Validate a submitted trigger and turn it into a record. Runs on the HOST as well as in the
 * composer, because the renderer is not trusted (§3) — in particular `nextAt` is derived here
 * and never accepted from the wire. `minDelayMs`/`minIntervalMs` drop to 0 under CONDUIT_E2E.
 */
export function buildSchedule(
  input: TimedMessageInput,
  now: number,
  opts: {
    minDelayMs?: number;
    minIntervalMs?: number;
    id?: string;
    newId?: () => string;
  } = {},
): BuildResult {
  const message = sanitizeMessage(input.message);
  if (!message) return { ok: false, error: 'Type a message to send.' };

  const minDelay = opts.minDelayMs ?? MIN_DELAY_MS;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const t = input.trigger;

  if (t.kind === 'in' && !(t.delayMs >= minDelay)) {
    return { ok: false, error: `Wait at least ${Math.round(minDelay / 1000)} seconds.` };
  }
  if (t.kind === 'every') {
    if (!(t.everyMs >= minInterval)) {
      return { ok: false, error: 'Repeat no faster than once a minute.' };
    }
    if (!Number.isInteger(t.maxRepeats) || t.maxRepeats < 1 || t.maxRepeats > MAX_REPEATS) {
      return { ok: false, error: `Repeats must be between 1 and ${MAX_REPEATS}.` };
    }
  }

  const nextAt = nextFireAt(t, now);
  if (nextAt === null) return { ok: false, error: 'That time could not be read — use HH:MM.' };

  return {
    ok: true,
    schedule: {
      id: opts.id ?? input.id ?? (opts.newId ?? newTimedMessageId)(),
      sessionId: input.sessionId,
      message,
      kind: t.kind === 'every' ? 'interval' : 'once',
      nextAt,
      ...(t.kind === 'every' ? { everyMs: t.everyMs } : {}),
      ...(t.kind === 'at' ? { spec: { clock: t.clock, ...(t.zone ? { zone: t.zone } : {}) } } : {}),
      maxRepeats: t.kind === 'every' ? t.maxRepeats : 1,
      firedCount: 0,
      state: 'armed',
      origin: input.origin ?? 'manual',
      createdAt: now,
    },
  };
}

/** The cap message for arming another schedule, or null when there is room. `editingId` is
 *  excluded so re-saving the third schedule on a session is not refused as a fourth. */
export function capError(
  existing: readonly TimedMessage[],
  sessionId: string,
  editingId: string | undefined,
): string | null {
  const live = existing.filter((s) => s.state !== 'done' && s.id !== editingId);
  if (live.length >= MAX_TOTAL) {
    return `${MAX_TOTAL} timed messages already armed — cancel one first.`;
  }
  if (live.filter((s) => s.sessionId === sessionId).length >= MAX_PER_SESSION) {
    return `${MAX_PER_SESSION} timed messages already on this session — cancel one first.`;
  }
  return null;
}

export interface DueDecision {
  action: 'wait' | 'fire' | 'skip';
  late: boolean;
  /** Interval slots this fire consumes — several collapse into ONE delivery (§2). */
  slots: number;
  overdueMs: number;
}

/**
 * What to do with a schedule at `now`. Applied at the moment it becomes deliverable, which for
 * a `waiting` schedule is when its PTY comes back — that is why the window is measured here
 * and not when it first came due (§4).
 */
export function catchUp(s: TimedMessage, now: number): DueDecision {
  const overdueMs = now - s.nextAt;
  const remaining = Math.max(s.maxRepeats - s.firedCount, 0);
  if (s.state === 'done' || remaining === 0 || overdueMs < 0) {
    return { action: 'wait', late: false, slots: 0, overdueMs };
  }
  const every = s.kind === 'interval' ? Math.max(s.everyMs ?? MIN_INTERVAL_MS, 1) : 0;
  const elapsed = every > 0 ? 1 + Math.floor(overdueMs / every) : 1;
  const slots = Math.min(elapsed, remaining);
  if (overdueMs > CATCHUP_MS[s.origin]) return { action: 'skip', late: true, slots, overdueMs };
  return { action: 'fire', late: overdueMs > LATE_GRACE_MS, slots, overdueMs };
}

/** A schedule that just fired or was renewed is no longer waiting on anything. */
function withoutWaiting(s: TimedMessage): TimedMessage {
  if (s.waitingSince === undefined) return s;
  const next = { ...s };
  delete next.waitingSince;
  return next;
}

export function advanceAfterFire(
  s: TimedMessage,
  now: number,
  outcome: { slots: number; late: boolean; delivered: boolean; reason?: FireFailure },
): TimedMessage {
  const firedCount = Math.min(s.firedCount + outcome.slots, s.maxRepeats);
  const done = firedCount >= s.maxRepeats;
  const every = s.everyMs ?? 0;
  return {
    ...withoutWaiting(s),
    firedCount,
    state: done ? 'done' : 'armed',
    // `slots` is 1 + the elapsed intervals, so the new nextAt is always in the future.
    nextAt: done || s.kind === 'once' ? s.nextAt : s.nextAt + outcome.slots * every,
    lastFire: {
      at: now,
      late: outcome.late,
      delivered: outcome.delivered,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  };
}

/** Came due with no live PTY. `nextAt` is HELD — nothing was delivered (§2 "Lifecycle"). */
export function markWaiting(s: TimedMessage, at: number): TimedMessage {
  return s.state === 'waiting' ? s : { ...s, state: 'waiting', waitingSince: at };
}

/**
 * Restart with the same parameters. An `At` schedule re-resolves its stored WALL CLOCK through
 * Intl rather than adding a fixed offset — the one thing `spec` exists for (§2 "Triggers").
 */
export function renew(s: TimedMessage, now: number): TimedMessage | null {
  const trigger: TriggerInput =
    s.kind === 'interval'
      ? { kind: 'every', everyMs: s.everyMs ?? MIN_INTERVAL_MS, maxRepeats: s.maxRepeats }
      : s.spec
        ? { kind: 'at', clock: s.spec.clock, ...(s.spec.zone ? { zone: s.spec.zone } : {}) }
        : { kind: 'in', delayMs: Math.max(s.nextAt - s.createdAt, 0) };
  const nextAt = nextFireAt(trigger, now);
  if (nextAt === null) return null;
  return { ...withoutWaiting(s), nextAt, firedCount: 0, state: 'armed' };
}

/** English short forms (§10): `45s`, `4m`, `2h 12m`, `1d`. No i18n layer in this repo. */
export function formatDuration(ms: number): string {
  const secs = Math.max(Math.round(ms / 1000), 0);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The chip's and the row's one line. `formatTime` is injected because the real one is an
 * Intl.DateTimeFormat in the user's locale (§10) — which is precisely what a CI-portable test
 * cannot assert against.
 */
export function describeNext(
  s: TimedMessage,
  now: number,
  formatTime: (at: number) => string,
): string {
  if (s.state === 'done') return `Sent ${s.firedCount} of ${s.maxRepeats}`;
  if (s.state === 'waiting') return 'Waiting';
  const delta = s.nextAt - now;
  if (delta <= 0) return 'due now';
  return delta < HOUR_MS ? `in ${formatDuration(delta)}` : `at ${formatTime(s.nextAt)}`;
}

/** Not exported: `fallow:check` fails on an export nothing outside this file consumes. */
function emptyTimedMessagesFile(): TimedMessagesFile {
  return { version: 1, schedules: [] };
}

const isSchedule = (v: unknown): v is TimedMessage => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.sessionId === 'string' &&
    typeof s.message === 'string' &&
    (s.kind === 'once' || s.kind === 'interval') &&
    typeof s.nextAt === 'number' &&
    Number.isFinite(s.nextAt) &&
    typeof s.maxRepeats === 'number' &&
    typeof s.firedCount === 'number' &&
    (s.state === 'armed' || s.state === 'waiting' || s.state === 'done') &&
    (s.origin === 'manual' || s.origin === 'limit') &&
    typeof s.createdAt === 'number'
  );
};

/** A corrupt or foreign-version file is an EMPTY set, never an error: the next write replaces
 *  it and the user loses an armed timer they can see is gone, not their work (§3). */
export function parseTimedMessagesFile(blob: string | undefined): TimedMessagesFile {
  if (!blob) return emptyTimedMessagesFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyTimedMessagesFile();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return emptyTimedMessagesFile();
  }
  const { version, schedules } = parsed as { version?: unknown; schedules?: unknown };
  if (version !== 1 || !Array.isArray(schedules)) return emptyTimedMessagesFile();
  return { version: 1, schedules: schedules.filter(isSchedule).slice(0, MAX_TOTAL) };
}

/** `done` schedules stay listed for the rest of the run so Renew is reachable, but they are
 *  not written — the next launch has nothing to renew (§2 "After a fire"). */
export function serializeTimedMessagesFile(file: TimedMessagesFile): string {
  return JSON.stringify(
    { version: 1, schedules: file.schedules.filter((s) => s.state !== 'done') },
    null,
    2,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/timed-messages.test.ts`
Expected: PASS — 59 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/timed-messages.ts test/unit/timed-messages.test.ts
git commit -m "feat(timers): add the pure timed-message model"
```

---

## Task 2: The limit detector (`src/limit-notice.ts`)

**Files:**
- Create: `src/limit-notice.ts`
- Test: `test/unit/limit-notice.test.ts`

**Interfaces:**
- Consumes: `resolveClockTime` from `src/timed-messages.ts` (Task 1).
- Produces:
  - `export const TAIL_LINES = 3`
  - `export const OFFER_SUPPRESS_MS = 30 * 60_000`
  - `export interface LimitNotice { resetAt: number; clock: string; zone?: string; line: string }`
  - `export interface LimitEpisode { resetAt: number; resolved: boolean; at: number }`
  - `export type LimitMode = 'off' | 'offer' | 'arm'`
  - `export type LimitAction = 'ignore' | 'arm' | 'offer'`
  - `export function parseResetClock(line: string): { clock: string; zone?: string } | null`
  - `export function scanLimitNotice(tail: readonly string[], now: number): LimitNotice | null`
  - `export function decideLimitAction(prev, notice, mode, now): LimitAction`

Anchors, not one exact string, and the notice must be what the session is **currently showing** — that tail requirement is what makes arming-by-default defensible (§2 "Limit-aware"). No parseable time means no notice at all: the locked degrade-never-misfire rule.

- [ ] **Step 1: Write the failing test**

Create `test/unit/limit-notice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decideLimitAction,
  type LimitEpisode,
  type LimitNotice,
  OFFER_SUPPRESS_MS,
  parseResetClock,
  scanLimitNotice,
} from '../../src/limit-notice';

const TORONTO = 'America/Toronto';
/** 2026-08-28T15:00:00Z = 11:00 EDT. */
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);
/** 23:10 EDT on the same day. */
const RESET_2310 = Date.UTC(2026, 7, 29, 3, 10);

const tail = (...lines: string[]) => lines;

describe('parseResetClock', () => {
  it('reads 12-hour forms with and without minutes', () => {
    expect(parseResetClock('resets 11:10pm')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets 11pm')).toEqual({ clock: '23:00' });
    expect(parseResetClock('resets at 11:10 PM')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets at 7:05 a.m.')).toEqual({ clock: '07:05' });
  });

  it('reads a 24-hour form', () => {
    expect(parseResetClock('resets at 23:10')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets at 07:05')).toEqual({ clock: '07:05' });
  });

  it('maps noon and midnight the way a clock does, not the way arithmetic does', () => {
    expect(parseResetClock('resets 12am')).toEqual({ clock: '00:00' });
    expect(parseResetClock('resets 12:30pm')).toEqual({ clock: '12:30' });
  });

  it('picks up a parenthesised IANA zone, including a three-part one', () => {
    expect(parseResetClock('resets 11:10pm (America/Toronto)')).toEqual({
      clock: '23:10',
      zone: 'America/Toronto',
    });
    expect(parseResetClock('resets 23:10 (America/Argentina/Buenos_Aires)')).toEqual({
      clock: '23:10',
      zone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('ignores a parenthesised abbreviation that is not an IANA id', () => {
    expect(parseResetClock('resets 11:10pm (EDT)')).toEqual({ clock: '23:10' });
  });

  it('returns null when nothing that could be a time is present', () => {
    expect(parseResetClock('resets later today')).toBeNull();
    expect(parseResetClock('resets at 25:99')).toBeNull();
  });
});

describe('scanLimitNotice — real wordings', () => {
  const cases: [string, string][] = [
    ["You've hit your session limit · resets 11:10pm (America/Toronto)", '23:10'],
    ['Claude usage limit reached. Your limit will reset at 11pm.', '23:00'],
    ['Session limit exceeded — resets at 23:10', '23:10'],
    ['You have reached your usage limit; it resets 11:10 PM', '23:10'],
  ];

  for (const [line, clock] of cases) {
    it(`matches: ${line}`, () => {
      const notice = scanLimitNotice(tail('...', 'working', line), NOW);
      expect(notice).not.toBeNull();
      expect(notice?.clock).toBe(clock);
      expect(notice?.line).toBe(line);
    });
  }

  it('resolves the reset instant through the parsed zone', () => {
    const notice = scanLimitNotice(
      tail("You've hit your session limit · resets 11:10pm (America/Toronto)"),
      NOW,
    );
    expect(notice?.resetAt).toBe(RESET_2310);
    expect(notice?.zone).toBe(TORONTO);
  });

  it('reads a notice that arrived split across two chunks, because the TAIL is reassembled', () => {
    // The host feeds pty.tailLines(), which is derived from the accumulated tail — a notice
    // whose two halves came in different term:data chunks is one line by the time it is read.
    const notice = scanLimitNotice(tail('$ claude', "You've hit your session limit · resets 11:10pm"), NOW);
    expect(notice?.clock).toBe('23:10');
  });

  it('matches only the LAST matching line when the footer redraws', () => {
    const notice = scanLimitNotice(
      tail('limit reached, resets 10:00pm', 'still working', 'usage limit reached, resets 11:10pm'),
      NOW,
    );
    expect(notice?.clock).toBe('23:10');
  });
});

describe('scanLimitNotice — what must NOT match', () => {
  const negatives: [string, string][] = [
    [
      'a real notice that has scrolled away behind diff output',
      '+  const retries = 3;',
    ],
    ['a comment about a limit with no limit anchor', '+  // the limit resets nightly at 23:10'],
    [
      'an unrelated sentence carrying limit, reset and a time',
      'Please reset your password before the 12:30 deadline; there is no limit',
    ],
    ['a limit with no reset anchor', 'You have hit the limit of open files'],
    ['every anchor but no parseable time', 'Session limit reached — try again later'],
    ['a word that merely contains limit', 'rate limiter tripped; counters reset at 12:30'],
  ];

  for (const [label, line] of negatives) {
    it(`does not match ${label}`, () => {
      expect(scanLimitNotice(tail('x', 'y', line), NOW)).toBeNull();
    });
  }

  it('does not match a real notice pushed out of the tail by later output', () => {
    // Only the last three non-empty lines are ever handed in — that is the whole gate.
    const lines = [
      '- const a = 1;',
      '+ const a = 2;',
      '  const b = 3;',
    ];
    expect(scanLimitNotice(lines, NOW)).toBeNull();
  });

  it('returns null for an empty tail', () => {
    expect(scanLimitNotice([], NOW)).toBeNull();
  });
});

describe('decideLimitAction', () => {
  const notice: LimitNotice = {
    resetAt: RESET_2310,
    clock: '23:10',
    zone: TORONTO,
    line: "You've hit your session limit · resets 11:10pm",
  };
  const other: LimitNotice = { ...notice, resetAt: RESET_2310 + 3_600_000, clock: '00:10' };
  const episode = (over: Partial<LimitEpisode> = {}): LimitEpisode => ({
    resetAt: RESET_2310,
    resolved: false,
    at: NOW,
    ...over,
  });

  it('does nothing at all when the mode is off', () => {
    expect(decideLimitAction(undefined, notice, 'off', NOW)).toBe('ignore');
    expect(decideLimitAction(episode(), other, 'off', NOW)).toBe('ignore');
  });

  it('arms a first notice under arm, and offers under offer', () => {
    expect(decideLimitAction(undefined, notice, 'arm', NOW)).toBe('arm');
    expect(decideLimitAction(undefined, notice, 'offer', NOW)).toBe('offer');
  });

  it('ignores a redraw of the same episode', () => {
    expect(decideLimitAction(episode(), notice, 'arm', NOW)).toBe('ignore');
    expect(decideLimitAction(episode(), notice, 'offer', NOW)).toBe('ignore');
  });

  it('supersedes when a different reset time appears', () => {
    expect(decideLimitAction(episode(), other, 'arm', NOW)).toBe('arm');
    expect(decideLimitAction(episode(), other, 'offer', NOW)).toBe('offer');
  });

  it('keeps a dismissed offer quiet for thirty minutes, then offers again', () => {
    const dismissed = episode({ resolved: true, at: NOW });
    expect(decideLimitAction(dismissed, notice, 'offer', NOW + OFFER_SUPPRESS_MS - 1)).toBe('ignore');
    expect(decideLimitAction(dismissed, notice, 'offer', NOW + OFFER_SUPPRESS_MS)).toBe('offer');
  });

  it('never re-arms a resolved episode under arm — the user cancelled it on purpose', () => {
    expect(decideLimitAction(episode({ resolved: true }), notice, 'arm', NOW + OFFER_SUPPRESS_MS)).toBe(
      'ignore',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/limit-notice.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/limit-notice"`.

- [ ] **Step 3: Write the implementation**

Create `src/limit-notice.ts`:

```ts
/**
 * Usage-limit notice detection (spec 2026-08-28-timed-messages §2 "Limit-aware"). Pure and
 * node-free: the host runs it beside countBareBells on the session's TRAILING output, and the
 * renderer never runs it at all.
 *
 * Best-effort by construction — anchors rather than a fixed string, the tail rather than the
 * stream, and no parseable time means no action at all (§12.8).
 */

import { resolveClockTime } from './timed-messages';

/** Deep enough for a footer under a status line, shallow enough that scrolled-past text never
 *  matches. The caller passes exactly this many lines; nothing here re-reads the stream. */
export const TAIL_LINES = 3;

/** How long a dismissed offer stays dismissed for the same reset time (§2 "Limit-aware"). */
export const OFFER_SUPPRESS_MS = 30 * 60_000;

export interface LimitNotice {
  /** The reset instant, epoch ms UTC. */
  resetAt: number;
  /** The 24-hour wall clock it was read as — kept for the toast copy and the chip. */
  clock: string;
  zone?: string;
  /** The matching line, verbatim. Shown in the offer banner; NEVER used as a message (§2). */
  line: string;
}

/** Host memory, per session. Never persisted: it describes a live moment (§2). */
export interface LimitEpisode {
  resetAt: number;
  resolved: boolean;
  /** When this episode was last acted on — the offer suppression clock. */
  at: number;
}

export type LimitMode = 'off' | 'offer' | 'arm';
export type LimitAction = 'ignore' | 'arm' | 'offer';

const LIMIT_WORD = /\blimits?\b/i;
/** One of these must appear, so "the limit resets nightly" is not a session asking for help. */
const LIMIT_ANCHOR = /\b(hit|reached|exceeded|usage)\b|\bsession limit\b/i;
const RESET_ANCHOR = /\bresets?\b/i;

/** `11:10pm`, `11pm`, `11:10 PM`, `7:05 a.m.` */
const TWELVE_HOUR = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?\b/i;
/** `23:10` */
const TWENTY_FOUR_HOUR = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
/** A parenthesised IANA id — at least one slash, which is what excludes `(EDT)`. */
const IANA_ZONE = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The reset wall clock in a line, normalised to 24-hour `HH:MM`, plus its zone when the line
 * names one. Null when nothing readable is there — which is the whole "degrade, never
 * misfire" rule.
 */
export function parseResetClock(line: string): { clock: string; zone?: string } | null {
  const zoneMatch = IANA_ZONE.exec(line);
  const zone = zoneMatch?.[1];

  const twelve = TWELVE_HOUR.exec(line);
  if (twelve) {
    const raw = Number(twelve[1]);
    if (raw < 1 || raw > 12) return null;
    const pm = twelve[3].toLowerCase() === 'p';
    const hour = pm ? (raw === 12 ? 12 : raw + 12) : raw === 12 ? 0 : raw;
    return { clock: `${pad(hour)}:${twelve[2] ?? '00'}`, ...(zone ? { zone } : {}) };
  }

  const twentyFour = TWENTY_FOUR_HOUR.exec(line);
  if (twentyFour) {
    return { clock: `${pad(Number(twentyFour[1]))}:${twentyFour[2]}`, ...(zone ? { zone } : {}) };
  }
  return null;
}

/**
 * The most recent limit notice in the session's trailing output, or null. All three anchors
 * must hold AND a time must parse; the newest line wins, because a TUI redrawing its footer
 * puts the current state last.
 */
export function scanLimitNotice(tail: readonly string[], now: number): LimitNotice | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!LIMIT_WORD.test(line)) continue;
    if (!LIMIT_ANCHOR.test(line)) continue;
    if (!RESET_ANCHOR.test(line)) continue;
    const parsed = parseResetClock(line);
    if (!parsed) continue;
    const resetAt = resolveClockTime(parsed.clock, parsed.zone, now);
    if (resetAt === null) continue;
    return { resetAt, clock: parsed.clock, ...(parsed.zone ? { zone: parsed.zone } : {}), line };
  }
  return null;
}

/**
 * What a fresh notice should do given what the host already knows about this session's episode.
 * Resolved once, in the host, so two windows produce one schedule and one toast (§2, §4).
 */
export function decideLimitAction(
  prev: LimitEpisode | undefined,
  notice: LimitNotice,
  mode: LimitMode,
  now: number,
): LimitAction {
  if (mode === 'off') return 'ignore';
  if (prev && prev.resetAt === notice.resetAt) {
    // Same episode. A TUI redraws its footer constantly, and an Undo/Dismiss is a decision.
    if (mode === 'arm') return 'ignore';
    if (!prev.resolved) return 'ignore';
    return now - prev.at >= OFFER_SUPPRESS_MS ? 'offer' : 'ignore';
  }
  return mode === 'arm' ? 'arm' : 'offer';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/limit-notice.test.ts`
Expected: PASS — 27 tests.

- [ ] **Step 5: Commit**

```bash
git add src/limit-notice.ts test/unit/limit-notice.test.ts
git commit -m "feat(timers): detect a usage-limit notice in a session's trailing output"
```

---

## Task 3: `PtyHost.input` reports, and `PtyHost.tailLines` reads

**Files:**
- Modify: `src/last-line.ts` — new `lastNonEmptyLines`; `lastNonEmptyLine` refactored onto it (`:159-168`)
- Modify: `src/pty-host.ts` — `input` (`:157`), new `tailLines` after `lastLine` (`:147-155`)
- Test: `test/unit/last-line.test.ts` (extend), `test/unit/pty-host-io.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function lastNonEmptyLines(tail: string, n: number): string[]` — oldest→newest, ANSI-stripped, printable, trimmed, **uncapped**
  - `PtyHost.input(sessionId: string, data: string): boolean`
  - `PtyHost.tailLines(sessionId: string, n: number): string[]`

`input`'s boolean is what makes `delivered` **derived from the write** rather than asserted around a void call (§2 "Delivery"). `term:input`'s existing caller ignores the return, so its behaviour is unchanged. `tailLines` adds **no per-session state** — it reads the same `tails` map `lastLine()` already maintains.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/last-line.test.ts`:

```ts
describe('lastNonEmptyLines', () => {
  it('returns the last n non-empty lines oldest-first', () => {
    expect(lastNonEmptyLines('a\nb\n\nc\nd\n', 3)).toEqual(['b', 'c', 'd']);
  });

  it('returns everything when the tail is shorter than n', () => {
    expect(lastNonEmptyLines('only\n', 3)).toEqual(['only']);
  });

  it('strips ANSI and treats a bare CR as a new line, like lastNonEmptyLine', () => {
    expect(lastNonEmptyLines('\u001b[2Kold frame\rnew frame\n', 2)).toEqual(['new frame']);
  });

  it('does not truncate at LAST_LINE_MAX — a limit notice can be longer than a subtitle', () => {
    const long = `${'x'.repeat(300)} resets 11:10pm`;
    expect(lastNonEmptyLines(`${long}\n`, 1)).toEqual([long]);
    expect(lastNonEmptyLine(`${long}\n`).length).toBeLessThanOrEqual(LAST_LINE_MAX);
  });

  it('is empty for a tail with no text', () => {
    expect(lastNonEmptyLines('\u001b[2J\u001b[H', 3)).toEqual([]);
    expect(lastNonEmptyLines('', 3)).toEqual([]);
  });

  it('returns nothing for a non-positive n', () => {
    expect(lastNonEmptyLines('a\nb\n', 0)).toEqual([]);
  });
});
```

(Extend the file's existing import to `import { LAST_LINE_MAX, lastNonEmptyLine, lastNonEmptyLines, ... } from '../../src/last-line';`.)

Create `test/unit/pty-host-io.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PtyHost's two new reads (spec 2026-08-28-timed-messages §3): `input` reports whether a live
 * process took the write — which is what `delivered` is derived from — and `tailLines` exposes
 * the tail `lastLine` already keeps, for the limit detector.
 *
 * node-pty is mocked: this asserts PtyHost's own bookkeeping, and the real module is a native
 * addon built against Electron's ABI.
 */

const writes: { sessionId: string; data: string }[] = [];
let onExitCb: ((e: { exitCode: number }) => void) | null = null;

vi.mock('@lydell/node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: (cb: (e: { exitCode: number }) => void) => {
      onExitCb = cb;
    },
    write: (data: string) => writes.push({ sessionId: 'current', data }),
    resize: () => {},
    kill: () => {},
  }),
}));

const { PtyHost } = await import('../../src/pty-host');

const spec = { command: 'cmd.exe', args: [] as string[], cwd: '.' };

describe('PtyHost.input', () => {
  beforeEach(() => {
    writes.length = 0;
    onExitCb = null;
  });

  it('returns false and writes nothing for a session with no live process', () => {
    const host = new PtyHost(() => {});
    expect(host.input('ghost', 'Continue')).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('returns true and writes for a live session', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    expect(host.input('s1', 'Continue')).toBe(true);
    expect(host.input('s1', '\r')).toBe(true);
    expect(writes.map((w) => w.data)).toEqual(['Continue', '\r']);
  });

  it('returns false once the process has exited', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    onExitCb?.({ exitCode: 0 });
    expect(host.isAlive('s1')).toBe(false);
    expect(host.input('s1', 'Continue')).toBe(false);
  });

  it('returns false after dispose', () => {
    const host = new PtyHost(() => {});
    host.start('s1', 80, 24, spec);
    host.dispose('s1');
    expect(host.input('s1', 'Continue')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/last-line.test.ts test/unit/pty-host-io.test.ts`
Expected: FAIL — `lastNonEmptyLines is not a function`, and `expected undefined to be true` from `input`'s void return.

- [ ] **Step 3: Split the tail reader in `src/last-line.ts`**

Replace `lastNonEmptyLine` (`:159-168`) with:

```ts
/**
 * The last `n` non-empty lines of a PTY tail, oldest first, ANSI-stripped and collapsed —
 * UNCAPPED, unlike {@link lastNonEmptyLine}: the card subtitle wants 120 characters, the limit
 * detector wants the whole line it is matching against.
 *
 * A bare CR starts a new line here as well as CRLF: a TUI redraws its status line by returning
 * to column 0, so the text before the CR is a previous frame, not the current one.
 */
export function lastNonEmptyLines(tail: string, n: number): string[] {
  if (n <= 0) return [];
  const lines = stripAnsi(tail).split(/\r?\n|\r/);
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
    const line = printable(lines[i]).trim();
    if (line) out.push(line);
  }
  return out.reverse();
}

/**
 * The last non-empty line of a PTY tail, capped at {@link LAST_LINE_MAX}. Returns '' when the
 * tail carries no text (a session that has printed nothing but control sequences shows no
 * subtitle rather than a blank one).
 */
export function lastNonEmptyLine(tail: string): string {
  const [line] = lastNonEmptyLines(tail, 1);
  if (!line) return '';
  return line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX - 1)}…` : line;
}
```

- [ ] **Step 4: Make `input` report, and add `tailLines`**

In `src/pty-host.ts`, change the import (`:6`):

```ts
import { lastNonEmptyLine } from './last-line';
```

to:

```ts
import { lastNonEmptyLine, lastNonEmptyLines } from './last-line';
```

Add after `lastLine` (which ends `:155`):

```ts
  /**
   * The session's last `n` non-empty output lines — the same tail `lastLine` reads, no new
   * per-session state. The limit detector (src/limit-notice.ts) matches against THIS rather
   * than the stream, so a notice that scrolled past inside a diff is not a match.
   */
  tailLines(sessionId: string, n: number): string[] {
    return lastNonEmptyLines(this.tails.get(sessionId) ?? '', n);
  }
```

Replace `input` (`:157-159`):

```ts
  input(sessionId: string, data: string) {
    this.procs.get(sessionId)?.write(data);
  }
```

with:

```ts
  /**
   * Write into a session's PTY. Returns whether a LIVE process took it — the scheduled-fire
   * path derives `delivered` from this rather than asserting it around a void call (spec
   * 2026-08-28-timed-messages §2 "Delivery"). `term:input` ignores the return.
   */
  input(sessionId: string, data: string): boolean {
    const proc = this.procs.get(sessionId);
    if (!proc) return false;
    proc.write(data);
    return true;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/last-line.test.ts test/unit/pty-host-io.test.ts test/unit/bell-scan.test.ts`
Expected: PASS — the existing `lastNonEmptyLine` cases still green (that is the point of running the whole file).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 for both projects.

- [ ] **Step 7: Commit**

```bash
git add src/last-line.ts src/pty-host.ts test/unit/last-line.test.ts test/unit/pty-host-io.test.ts
git commit -m "feat(pty): report whether a write landed and expose the output tail"
```

---

## Task 4: The protocol pairs and the preview bridge

**Files:**
- Modify: `src/protocol.ts` — the model re-exports beside the review ones (`:205`); `LimitOffer`; four `HostToWebview` members after `review:notes` (`:374`); seven `WebviewToHost` members after `review:setNotes` (`:656`)
- Modify: `webview/bridge.ts` — a preview branch after the `review:setNotes` branch (ends `:881`)

**Interfaces:**
- Consumes: `TimedMessage`, `TimedMessageInput`, `FireFailure`, `buildSchedule` from `src/timed-messages.ts` (Task 1).
- Produces:
  - `export interface LimitOffer { sessionId: string; resetAt: number; line: string }`
  - Host→windows: `timer:state`, `timer:fired`, `timer:error`
  - Webview→host: `timer:set`, `timer:cancel`, `timer:renew`, `timer:sendNow`, `timer:sendOnce`, `timer:offer`, `timer:test`

`timer:state` and `timer:fired` are **broadcast** (both windows share one main process, and either may be showing the session); `timer:error` is a **reply** to the sender, because only the window that submitted a rejected schedule should toast about it.

- [ ] **Step 1: Re-export the model and declare the offer**

In `src/protocol.ts`, add to the import block at the top:

```ts
import type { FireFailure, TimedMessage, TimedMessageInput } from './timed-messages';
```

and immediately after the `review-notes` re-export line (`:206`):

```ts
// The timed-message shapes live with their model because the disk shape and the wire shape are
// the same object; re-exported here so renderer code that only talks protocol doesn't have to
// reach past it. See spec 2026-08-28-timed-messages §3.
export type {
  FireFailure,
  LastFire,
  TimedMessage,
  TimedMessageInput,
  TimedMessageOrigin,
  TimedMessageState,
  TriggerInput,
} from './timed-messages';

/**
 * A pending "resume when the limit resets?" question, under `autoResumeOnLimit: 'offer'`.
 * Resolved ONCE in the host, so two windows produce one schedule; the offer LEAVING
 * `timer:state` is what dismisses the sibling window's toast (§2 "Limit-aware", §4).
 */
export interface LimitOffer {
  sessionId: string;
  resetAt: number;
  /** The line the notice was read from. Displayed verbatim; never composed into a message. */
  line: string;
}
```

- [ ] **Step 2: Add the host→windows members**

In the `HostToWebview` union, immediately after the `review:notes` member (`:374`):

```ts
  // Every schedule the host holds plus the pending limit offer, BROADCAST to every window —
  // the renderer keeps no other copy (§3). An empty list is a real answer: it is what opens the
  // renderer's load gate.
  | { type: 'timer:state'; schedules: TimedMessage[]; offer: LimitOffer | null }
  // One fire. `delivered` is DERIVED from pty.input's return, never assumed, and timer:state
  // alone cannot tell a fire from an edit — hence a second message rather than a flag.
  | {
      type: 'timer:fired';
      id: string;
      sessionId: string;
      at: number;
      late: boolean;
      delivered: boolean;
      reason?: FireFailure;
    }
  // A rejected timer:set / timer:sendOnce, back to the SENDER only: the other window did not
  // ask for anything and must not toast. Never a silent drop (§3).
  | { type: 'timer:error'; message: string }
```

- [ ] **Step 3: Add the webview→host members**

In the `WebviewToHost` union, immediately after the `review:setNotes` member (`:656`):

```ts
  // Create or replace one schedule by id. The host sanitizes, validates, caps, RECOMPUTES
  // `nextAt` from the trigger, re-arms, persists and broadcasts (§3).
  | { type: 'timer:set'; schedule: TimedMessageInput }
  | { type: 'timer:cancel'; id: string }
  | { type: 'timer:renew'; id: string }
  // Deliver now. Consumes no repeat and does not move nextAt (§2 "The dialog").
  | { type: 'timer:sendNow'; id: string }
  // The composer's Send now with nothing armed — no schedule is created.
  | { type: 'timer:sendOnce'; sessionId: string; message: string }
  // Resolve a limit offer. A NO-OP when the session's episode is already resolved, which is
  // what makes two windows clicking "Resume then" produce one schedule (§3, §4).
  | { type: 'timer:offer'; sessionId: string; action: 'arm' | 'dismiss' }
  // CONDUIT_E2E=1 ONLY: shift the host's schedule clock and re-evaluate, so the smoke scenario
  // proves interval repeats and the expiry windows in milliseconds instead of hours (§7).
  | { type: 'timer:test'; op: 'advance'; ms: number }
```

- [ ] **Step 4: Answer them in the preview bridge**

In `webview/bridge.ts`, add to the imports:

```ts
import {
  buildSchedule,
  renew as renewSchedule,
  type TimedMessage,
} from '../src/timed-messages';
```

and insert directly after the `review:setNotes` branch (ends `:881`):

```ts
// Preview-only schedule store: the browser shell has no host, and a dialog whose Arm button
// did nothing would misrepresent the surface (see the fake-shell note in CLAUDE.md).
const previewSchedules: TimedMessage[] = [];
const emitTimerState = () =>
  setTimeout(() => emit({ type: 'timer:state', schedules: [...previewSchedules], offer: null }), 15);
```

(place the two consts beside `previewNotesByRoot` at `:537`, not inside `mockHost`), then inside `mockHost`:

```ts
  if (msg.type === 'timer:set') {
    const built = buildSchedule(msg.schedule, Date.now(), { id: msg.schedule.id });
    if (!built.ok) {
      setTimeout(() => emit({ type: 'timer:error', message: built.error }), 15);
      return;
    }
    const i = previewSchedules.findIndex((s) => s.id === built.schedule.id);
    if (i >= 0) previewSchedules[i] = built.schedule;
    else previewSchedules.push(built.schedule);
    emitTimerState();
    return;
  }
  if (msg.type === 'timer:cancel') {
    const i = previewSchedules.findIndex((s) => s.id === msg.id);
    if (i >= 0) previewSchedules.splice(i, 1);
    emitTimerState();
    return;
  }
  if (msg.type === 'timer:renew') {
    const i = previewSchedules.findIndex((s) => s.id === msg.id);
    const next = i >= 0 ? renewSchedule(previewSchedules[i], Date.now()) : null;
    if (next) previewSchedules[i] = next;
    emitTimerState();
    return;
  }
  if (
    msg.type === 'timer:sendNow' ||
    msg.type === 'timer:sendOnce' ||
    msg.type === 'timer:offer' ||
    msg.type === 'timer:test'
  ) {
    // No PTY in the preview shell, so there is nothing to deliver into and no detector running.
    emitTimerState();
    return;
  }
```

Add the load-gate open beside the existing `review:marks` one in the `ready` branch (`:548`):

```ts
      emit({ type: 'timer:state', schedules: [], offer: null });
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0. A missing branch in either union fails here — that is the check.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.ts webview/bridge.ts
git commit -m "feat(timers): add the timer protocol pairs and preview answers"
```

---

## Task 5: The host scheduler (`src/timer-scheduler.ts`)

**Files:**
- Create: `src/timer-scheduler.ts`
- Test: `test/unit/timer-scheduler.test.ts`

**Interfaces:**
- Consumes: everything from `src/timed-messages.ts` (Task 1).
- Produces:
  - `export interface FiredEvent { id: string; sessionId: string; at: number; late: boolean; delivered: boolean; reason?: FireFailure }`
  - `export interface SchedulerDeps { now(): number; setTimer(ms, fn): unknown; clearTimer(handle): void; isAlive(sessionId): boolean; deliver(sessionId, message): Promise<boolean>; sessionExists(sessionId): boolean; onChange(): void; onFired(ev): void; minDelayMs: number; minIntervalMs: number }`
  - `export type SetResult = { ok: true; schedule: TimedMessage } | { ok: false; error: string }`
  - `export class TimerScheduler`

Every dependency is injected, which is what makes the timer, the waiting rule, the settle window, the catch-up windows and the two-phase delivery testable without Electron — and leaves `electron/main.ts` with wiring only (assumption 2).

- [ ] **Step 1: Write the failing test**

Create `test/unit/timer-scheduler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CATCHUP_MS, LIMIT_MESSAGE, PTY_SETTLE_MS, type TimedMessage } from '../../src/timed-messages';
import { type FiredEvent, type SchedulerDeps, TimerScheduler } from '../../src/timer-scheduler';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

/** Let the scheduler's async delivery settle. Only the SCHEDULER's timer is faked. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<SchedulerDeps> = {}) {
  let clock = NOW;
  let pending: { at: number; fn: () => void } | null = null;
  const alive = new Set<string>(['s1']);
  const known = new Set<string>(['s1', 's2']);
  const delivered: { sessionId: string; message: string }[] = [];
  const fired: FiredEvent[] = [];
  let changes = 0;
  let deliverOk = true;

  const deps: SchedulerDeps = {
    now: () => clock,
    setTimer: (ms, fn) => {
      pending = { at: clock + ms, fn };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    isAlive: (id) => alive.has(id),
    deliver: async (sessionId, message) => {
      if (!alive.has(sessionId)) return false;
      delivered.push({ sessionId, message });
      return deliverOk;
    },
    sessionExists: (id) => known.has(id),
    onChange: () => {
      changes += 1;
    },
    onFired: (ev) => {
      fired.push(ev);
    },
    minDelayMs: 0,
    minIntervalMs: 0,
    ...over,
  };

  const scheduler = new TimerScheduler(deps);

  return {
    scheduler,
    delivered,
    fired,
    alive,
    known,
    changes: () => changes,
    nextWaitMs: () => (pending === null ? null : pending.at - clock),
    /** Advance the wall clock and run the armed timer if it is now due. */
    async tick(ms: number) {
      clock += ms;
      if (pending && pending.at <= clock) {
        const due = pending;
        pending = null;
        due.fn();
      }
      await flush();
    },
    setDeliverOk(v: boolean) {
      deliverOk = v;
    },
    now: () => clock,
  };
}

const arm = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) =>
  h.scheduler.set({
    sessionId: 's1',
    message: 'Continue',
    trigger: { kind: 'in', delayMs: 60_000 },
    ...over,
  });

describe('arming', () => {
  it('accepts a schedule, derives nextAt from the trigger and arms the earliest timer', () => {
    const h = harness();
    const r = arm(h);
    expect(r.ok).toBe(true);
    expect(h.scheduler.list()).toHaveLength(1);
    expect(h.scheduler.list()[0].nextAt).toBe(NOW + 60_000);
    expect(h.nextWaitMs()).toBe(60_000);
    expect(h.changes()).toBe(1);
  });

  it('arms to the EARLIEST nextAt across schedules, not the newest', () => {
    const h = harness();
    arm(h, { trigger: { kind: 'in', delayMs: 10 * 60_000 } });
    arm(h, { trigger: { kind: 'in', delayMs: 2 * 60_000 } });
    expect(h.nextWaitMs()).toBe(2 * 60_000);
  });

  it('refuses a schedule for a session the manager does not know', () => {
    const h = harness();
    expect(arm(h, { sessionId: 'ghost' })).toEqual({ ok: false, error: 'That session is gone.' });
    expect(h.scheduler.list()).toHaveLength(0);
  });

  it('refuses a fourth schedule on one session', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(arm(h).ok).toBe(true);
    const r = arm(h);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/already on this session/);
  });

  it('replaces by id when the composer saves an edit, keeping one row', () => {
    const h = harness();
    const first = arm(h);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = h.scheduler.set({
      id: first.schedule.id,
      sessionId: 's1',
      message: 'Do this again',
      trigger: { kind: 'in', delayMs: 5 * 60_000 },
    });
    expect(again.ok).toBe(true);
    expect(h.scheduler.list()).toHaveLength(1);
    expect(h.scheduler.list()[0].message).toBe('Do this again');
    expect(h.scheduler.list()[0].firedCount).toBe(0);
  });

  it('arms no timer at all when nothing is scheduled', () => {
    const h = harness();
    h.scheduler.evaluate();
    expect(h.nextWaitMs()).toBeNull();
  });
});

describe('firing into a live PTY', () => {
  it('delivers the message once and marks a once schedule done', async () => {
    const h = harness();
    arm(h);
    await h.tick(60_000);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 1 });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({ sessionId: 's1', delivered: true, late: false });
  });

  it('drops the timer once nothing is armed', async () => {
    const h = harness();
    arm(h);
    await h.tick(60_000);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('re-arms an interval until its repeat count and then stops', async () => {
    const h = harness();
    expect(
      h.scheduler.set({
        sessionId: 's1',
        message: 'again',
        trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
      }).ok,
    ).toBe(true);
    for (let i = 0; i < 4; i++) await h.tick(1000);
    expect(h.delivered).toHaveLength(3);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 3 });
    expect(h.nextWaitMs()).toBeNull();
  });

  it('collapses several elapsed interval slots into ONE delivery', async () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'again',
      trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 10 },
    });
    // Four slots elapse while the process is busy elsewhere; the timer fires once, late.
    await h.tick(4 * HOUR);
    expect(h.delivered).toHaveLength(1);
    expect(h.scheduler.list()[0].firedCount).toBe(4);
    expect(h.scheduler.list()[0].nextAt).toBeGreaterThan(h.now());
  });

  it('reports delivered:false when the process dies between the text and the Enter', async () => {
    const h = harness();
    arm(h);
    h.setDeliverOk(false);
    await h.tick(60_000);
    expect(h.fired[0]).toMatchObject({ delivered: false, reason: 'noSession' });
    // The slot is consumed: half the message is already in the PTY (plan assumption 6).
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 1 });
  });

  it('never touches a schedule twice while its delivery is in flight', async () => {
    let release: (v: boolean) => void = () => {};
    const h = harness({
      deliver: () => new Promise<boolean>((r) => (release = r)),
    });
    arm(h);
    await h.tick(60_000);
    h.scheduler.evaluate();
    h.scheduler.evaluate();
    release(true);
    await flush();
    expect(h.fired).toHaveLength(1);
  });
});

describe('waiting for a PTY', () => {
  it('goes waiting instead of writing when the session is not live, and holds nextAt', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.list()[0]).toMatchObject({
      state: 'waiting',
      waitingSince: NOW + 60_000,
      nextAt: NOW + 60_000,
    });
    expect(h.fired).toHaveLength(0);
  });

  it('raises no further change once it is already waiting', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    const after = h.changes();
    h.scheduler.evaluate();
    h.scheduler.evaluate();
    expect(h.changes()).toBe(after);
  });

  it('arms no clock for a waiting schedule — it wakes on term:start', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('delivers once, late, PTY_SETTLE_MS after that session starts', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);

    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    expect(h.nextWaitMs()).toBe(PTY_SETTLE_MS);

    // A message written into a shell that has not printed its prompt is lost, so nothing goes
    // out before the settle window closes.
    await h.tick(PTY_SETTLE_MS - 1);
    expect(h.delivered).toHaveLength(0);

    await h.tick(1);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.fired[0]).toMatchObject({ late: true, delivered: true });
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('delivers a waiting schedule EXACTLY once even if term:start repeats', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toHaveLength(1);
  });

  it('skips a manual schedule that became deliverable past its 6 hour window', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    await h.tick(CATCHUP_MS.manual + 1);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toHaveLength(0);
    expect(h.fired[0]).toMatchObject({ delivered: false, reason: 'expired' });
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('still delivers a limit schedule ten hours late — the lid-closed-overnight case', async () => {
    const h = harness();
    h.scheduler.armLimit('s1', NOW + 60_000);
    h.alive.delete('s1');
    await h.tick(2 * 60_000);
    await h.tick(10 * HOUR);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: LIMIT_MESSAGE }]);
    expect(h.fired[0]).toMatchObject({ late: true, delivered: true });
  });
});

describe('the limit schedule', () => {
  it('arms Continue one minute past the reset', () => {
    const h = harness();
    const s = h.scheduler.armLimit('s1', NOW + HOUR);
    expect(s).not.toBeNull();
    expect(s).toMatchObject({ message: LIMIT_MESSAGE, origin: 'limit', kind: 'once' });
    expect(s?.nextAt).toBe(NOW + HOUR + 60_000);
  });

  it('REPLACES the session limit schedule rather than accumulating', () => {
    const h = harness();
    h.scheduler.armLimit('s1', NOW + HOUR);
    h.scheduler.armLimit('s1', NOW + 2 * HOUR);
    h.scheduler.armLimit('s1', NOW + 3 * HOUR);
    const limits = h.scheduler.list().filter((s) => s.origin === 'limit');
    expect(limits).toHaveLength(1);
    expect(limits[0].nextAt).toBe(NOW + 3 * HOUR + 60_000);
  });

  it('leaves manual schedules on the same session alone', () => {
    const h = harness();
    arm(h);
    h.scheduler.armLimit('s1', NOW + HOUR);
    expect(h.scheduler.list()).toHaveLength(2);
  });

  it('arms a reset that has already passed for immediate delivery, not the past', () => {
    const h = harness();
    const s = h.scheduler.armLimit('s1', NOW - HOUR);
    expect(s?.nextAt).toBe(NOW);
  });
});

describe('cancel, renew, send now', () => {
  it('cancel deletes the record — there is no cancelled state', () => {
    const h = harness();
    const r = arm(h);
    expect(r.ok && h.scheduler.cancel(r.schedule.id)).toBe(true);
    expect(h.scheduler.list()).toHaveLength(0);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('cancel of an unknown id is a harmless false', () => {
    const h = harness();
    expect(h.scheduler.cancel('nope')).toBe(false);
  });

  it('renew resets firedCount and recomputes nextAt from now', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    await h.tick(60_000);
    expect(h.scheduler.list()[0].state).toBe('done');
    const renewed = h.scheduler.renewSchedule(r.schedule.id);
    expect(renewed.ok).toBe(true);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'armed', firedCount: 0 });
    expect(h.scheduler.list()[0].nextAt).toBe(h.now() + 60_000);
  });

  it('send now delivers immediately and moves neither firedCount nor nextAt', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    expect(await h.scheduler.sendNow(r.schedule.id)).toBe(true);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.scheduler.list()[0]).toMatchObject({ firedCount: 0, nextAt: NOW + 60_000 });
    expect(h.fired).toHaveLength(0);
  });

  it('send now answers false for a session with no live PTY', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    h.alive.delete('s1');
    expect(await h.scheduler.sendNow(r.schedule.id)).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });

  it('send once delivers without creating a schedule', async () => {
    const h = harness();
    expect(await h.scheduler.sendOnce('s1', 'ping\r\nnow')).toBe(true);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'ping now' }]);
    expect(h.scheduler.list()).toHaveLength(0);
  });

  it('send once refuses an empty message rather than pressing a bare Enter', async () => {
    const h = harness();
    expect(await h.scheduler.sendOnce('s1', '   ')).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('drops a disposed session schedules and re-arms', () => {
    const h = harness();
    arm(h);
    h.scheduler.set({ sessionId: 's2', message: 'other', trigger: { kind: 'in', delayMs: HOUR } });
    h.scheduler.onSessionDisposed('s1');
    expect(h.scheduler.list().map((s) => s.sessionId)).toEqual(['s2']);
    expect(h.nextWaitMs()).toBe(HOUR);
  });

  it('load drops schedules whose session is gone, and never re-persists them', () => {
    const h = harness();
    const stored: TimedMessage[] = [
      {
        id: 'a',
        sessionId: 's1',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW + HOUR,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW,
      },
      {
        id: 'b',
        sessionId: 'gone',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW + HOUR,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW,
      },
    ];
    h.scheduler.load(stored);
    expect(h.scheduler.list().map((s) => s.id)).toEqual(['a']);
    expect(h.changes()).toBe(0);
  });

  it('a restored schedule whose moment passed while the app was closed waits, silently', async () => {
    const h = harness();
    h.alive.delete('s1');
    h.scheduler.load([
      {
        id: 'a',
        sessionId: 's1',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW - 60_000,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW - HOUR,
      },
    ]);
    await flush();
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.list()[0].state).toBe('waiting');
  });

  it('stop clears the timer so no handle outlives the app', () => {
    const h = harness();
    arm(h);
    h.scheduler.stop();
    expect(h.nextWaitMs()).toBeNull();
  });

  it('advanceClock shifts the schedule clock and re-evaluates (the CONDUIT_E2E seam)', async () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'again',
      trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
    });
    for (let i = 0; i < 4; i++) {
      h.scheduler.advanceClock(1000);
      await flush();
    }
    expect(h.delivered).toHaveLength(3);
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('a suspend past a fire delivers on resume rather than never', async () => {
    const h = harness({});
    arm(h);
    // setTimeout does not advance across a Windows suspend: the clock moved, the timer did not.
    await h.tick(0);
    h.scheduler.advanceClock(2 * HOUR);
    await flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.fired[0].late).toBe(true);
  });

  it('clamps a very distant nextAt to the setTimeout ceiling and re-arms', () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'far',
      trigger: { kind: 'in', delayMs: 40 * 24 * HOUR },
    });
    expect(h.nextWaitMs()).toBe(2_147_483_647);
  });
});

```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/timer-scheduler.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/timer-scheduler"`.

- [ ] **Step 3: Write the implementation**

Create `src/timer-scheduler.ts`:

```ts
/**
 * The timed-message scheduler (spec 2026-08-28-timed-messages §2 "The timer", "Lifecycle").
 * Owns the schedule set, ONE setTimeout, the waiting/settle machinery and the fire decision.
 *
 * Every dependency is injected — the clock, the timer, the liveness read, the write, the
 * persist and the broadcast — so this whole file is exercised without Electron and
 * electron/main.ts is left with wiring only. Node-free for the same reason as the model.
 *
 * The timer is NEVER the source of truth: every evaluation re-compares wall-clock `now`
 * against `nextAt`, so a timer that fired early, late, or not at all cannot produce a wrong
 * outcome. That is what makes `advanceClock` and the powerMonitor re-evaluation safe.
 */

import {
  advanceAfterFire,
  buildSchedule,
  capError,
  catchUp,
  type DueDecision,
  type FireFailure,
  LIMIT_MESSAGE,
  LIMIT_PADDING_MS,
  markWaiting,
  MAX_TOTAL,
  PTY_SETTLE_MS,
  renew,
  sanitizeMessage,
  type TimedMessage,
  type TimedMessageInput,
} from './timed-messages';

export interface FiredEvent {
  id: string;
  sessionId: string;
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface SchedulerDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  isAlive(sessionId: string): boolean;
  /** Writes the message and then Enter into a LIVE PTY; resolves what actually landed. */
  deliver(sessionId: string, message: string): Promise<boolean>;
  sessionExists(sessionId: string): boolean;
  /** The set changed: persist it and broadcast timer:state. */
  onChange(): void;
  onFired(ev: FiredEvent): void;
  /** 0 under CONDUIT_E2E, so the smoke scenario can arm at +800 ms (§7). */
  minDelayMs: number;
  minIntervalMs: number;
}

export type SetResult = { ok: true; schedule: TimedMessage } | { ok: false; error: string };

/** setTimeout's ceiling. A longer wait is chunked; expiry re-arms from `nextAt`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class TimerScheduler {
  private schedules: TimedMessage[] = [];
  private handle: unknown = null;
  /** Shifted only by `advanceClock`, which exists only under CONDUIT_E2E. */
  private clockOffset = 0;
  /** Per session: the instant its freshly started PTY is ready to be written to. */
  private readonly settleUntil = new Map<string, number>();
  /** Schedules with a delivery in flight — a second evaluate must not fire them again. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now() + this.clockOffset;
  }

  list(): TimedMessage[] {
    return this.schedules;
  }

  /** Adopt the persisted set. Schedules for a session the manager no longer knows are dropped
   *  and never re-persisted (§4); nothing is written here, so the dirty gate stays closed. */
  load(schedules: readonly TimedMessage[]): void {
    this.schedules = schedules
      .filter((s) => s.state !== 'done' && this.deps.sessionExists(s.sessionId))
      .slice(0, MAX_TOTAL);
    this.evaluate();
  }

  set(input: TimedMessageInput): SetResult {
    if (!this.deps.sessionExists(input.sessionId)) {
      return { ok: false, error: 'That session is gone.' };
    }
    const editingId =
      input.id && this.schedules.some((s) => s.id === input.id) ? input.id : undefined;
    const cap = capError(this.schedules, input.sessionId, editingId);
    if (cap) return { ok: false, error: cap };

    const built = buildSchedule(input, this.now(), {
      minDelayMs: this.deps.minDelayMs,
      minIntervalMs: this.deps.minIntervalMs,
      ...(editingId ? { id: editingId } : {}),
    });
    if (!built.ok) return built;
    this.put(built.schedule, { insert: true });
    this.changed();
    return built;
  }

  /**
   * Auto-resume for a detected limit reset. Exactly ONE live limit schedule per session — a
   * session printing a notice a hundred times ends with one, not a hundred (§2 "Limit-aware").
   */
  armLimit(sessionId: string, resetAt: number): TimedMessage | null {
    if (!this.deps.sessionExists(sessionId)) return null;
    const now = this.now();
    const others = this.schedules.filter(
      (s) => !(s.sessionId === sessionId && s.origin === 'limit'),
    );
    if (capError(others, sessionId, undefined)) return null;
    const built = buildSchedule(
      {
        sessionId,
        message: LIMIT_MESSAGE,
        trigger: { kind: 'in', delayMs: Math.max(resetAt + LIMIT_PADDING_MS - now, 0) },
        origin: 'limit',
      },
      now,
      { minDelayMs: 0, minIntervalMs: this.deps.minIntervalMs },
    );
    if (!built.ok) return null;
    this.schedules = [...others, built.schedule];
    this.changed();
    return built.schedule;
  }

  cancel(id: string): boolean {
    const next = this.schedules.filter((s) => s.id !== id);
    if (next.length === this.schedules.length) return false;
    this.schedules = next;
    this.changed();
    return true;
  }

  renewSchedule(id: string): SetResult {
    const current = this.schedules.find((s) => s.id === id);
    if (!current) return { ok: false, error: 'That timed message is gone.' };
    const next = renew(current, this.now());
    if (!next) return { ok: false, error: 'That time could not be resolved again.' };
    this.put(next);
    this.changed();
    return { ok: true, schedule: next };
  }

  /** Deliver now. Consumes no repeat and does not move `nextAt` (§2 "The dialog"). */
  async sendNow(id: string): Promise<boolean> {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return false;
    return this.sendOnce(s.sessionId, s.message);
  }

  async sendOnce(sessionId: string, message: string): Promise<boolean> {
    const text = sanitizeMessage(message);
    // An empty message would press a bare Enter into someone's shell.
    if (!text) return false;
    if (!this.deps.isAlive(sessionId)) return false;
    return this.deps.deliver(sessionId, text);
  }

  /**
   * That session's PTY just came up. Everything waiting on it delivers once the settle window
   * closes — a message written into a shell that has not printed its prompt is lost.
   */
  onPtyStart(sessionId: string): void {
    this.settleUntil.set(sessionId, this.now() + PTY_SETTLE_MS);
    this.arm();
  }

  onSessionDisposed(sessionId: string): void {
    this.settleUntil.delete(sessionId);
    const next = this.schedules.filter((s) => s.sessionId !== sessionId);
    if (next.length === this.schedules.length) {
      this.arm();
      return;
    }
    this.schedules = next;
    this.changed();
  }

  /** CONDUIT_E2E only: shift the schedule clock so an interval or an expiry window can be
   *  proven in milliseconds instead of hours (§7). */
  advanceClock(ms: number): void {
    this.clockOffset += ms;
    this.evaluate();
  }

  stop(): void {
    if (this.handle === null) return;
    this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  /**
   * Compare every schedule against the wall clock and act. Also the powerMonitor hook: a
   * suspend stops setTimeout but not the clock, so re-evaluating on resume is the whole fix.
   */
  evaluate(): void {
    const now = this.now();
    let mutated = false;

    for (const s of [...this.schedules]) {
      if (this.inFlight.has(s.id)) continue;
      const decision = catchUp(s, now);
      if (decision.action === 'wait') continue;

      if (!this.deps.isAlive(s.sessionId)) {
        // Due with no PTY: hold nextAt, write nothing, say so. The host never spawns one.
        const waiting = markWaiting(s, s.nextAt);
        if (waiting !== s) {
          this.put(waiting);
          mutated = true;
        }
        continue;
      }

      if (now < (this.settleUntil.get(s.sessionId) ?? 0)) continue; // re-armed below

      if (decision.action === 'skip') {
        const next = advanceAfterFire(s, now, {
          slots: decision.slots,
          late: true,
          delivered: false,
          reason: 'expired',
        });
        this.put(next);
        this.deps.onFired({
          id: s.id,
          sessionId: s.sessionId,
          at: now,
          late: true,
          delivered: false,
          reason: 'expired',
        });
        mutated = true;
        continue;
      }

      this.fire(s, decision);
    }

    if (mutated) this.deps.onChange();
    this.arm();
  }

  private fire(s: TimedMessage, decision: DueDecision): void {
    this.inFlight.add(s.id);
    void this.deps.deliver(s.sessionId, s.message).then((delivered) => {
      this.inFlight.delete(s.id);
      const at = this.now();
      this.put(
        advanceAfterFire(s, at, {
          slots: decision.slots,
          late: decision.late,
          delivered,
          ...(delivered ? {} : { reason: 'noSession' as const }),
        }),
      );
      this.deps.onFired({
        id: s.id,
        sessionId: s.sessionId,
        at,
        late: decision.late,
        delivered,
        ...(delivered ? {} : { reason: 'noSession' as const }),
      });
      this.deps.onChange();
      this.arm();
    });
  }

  private put(next: TimedMessage, opts: { insert?: boolean } = {}): void {
    const i = this.schedules.findIndex((s) => s.id === next.id);
    if (i >= 0) {
      this.schedules = this.schedules.map((s) => (s.id === next.id ? next : s));
      return;
    }
    if (opts.insert) this.schedules = [...this.schedules, next];
  }

  private changed(): void {
    this.deps.onChange();
    this.evaluate();
  }

  /**
   * One timer, to the earliest thing that could happen. A `waiting` schedule contributes none:
   * its window is applied when its PTY comes back, not on a clock (§4) — which is also what
   * keeps an idle app's timer set empty.
   */
  private arm(): void {
    this.stop();
    const now = this.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const s of this.schedules) {
      if (s.state === 'done' || s.state === 'waiting') continue;
      earliest = Math.min(earliest, Math.max(s.nextAt, now));
    }
    for (const at of this.settleUntil.values()) {
      if (at > now) earliest = Math.min(earliest, at);
    }
    if (!Number.isFinite(earliest)) return;
    const wait = Math.min(Math.max(earliest - now, 0), MAX_TIMEOUT_MS);
    this.handle = this.deps.setTimer(wait, () => {
      this.handle = null;
      this.evaluate();
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/timer-scheduler.test.ts`
Expected: PASS — 37 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 for both projects.

- [ ] **Step 6: Commit**

```bash
git add src/timer-scheduler.ts test/unit/timer-scheduler.test.ts
git commit -m "feat(timers): add the host schedule store, single timer and waiting rule"
```

---

## Task 6: Wire the scheduler into the host

**Files:**
- Modify: `electron/main.ts` — imports (`:1-110`); `timedMessagesFile()` beside `reviewMarksFile()` (`:805`); the scheduler block after the `PtyHost` construction and its scrollback helpers, and **before** `flushStateSync` (`:1539`); the load after `mgr.restore` (`:1373-1375`); the quit flush (`:1557`); `disposeSession` (`:1852`); `term:start` (`:2716`); the `ready` case (`:1905`); six new `case`s beside `term:input` (`:2823`); `before-quit` (`:3159`)

**Interfaces:**
- Consumes: `TimerScheduler`, `SchedulerDeps` (Task 5); `parseTimedMessagesFile`, `serializeTimedMessagesFile`, `SUBMIT_GAP_MS`, `MIN_DELAY_MS`, `MIN_INTERVAL_MS` (Task 1); `LimitOffer` (Task 4); `PtyHost.input`'s boolean (Task 3).
- Produces: `userData/timed-messages.json`; `timer:state` / `timer:fired` broadcasts; `timer:error` replies.

This task has no unit test of its own — `electron/main.ts` is not importable under vitest. Its gate is `npm run typecheck && npm run build` here and the e2e scenario in Task 15. That is the same shape the host wiring took in `docs/plans/2026-08-27-review-lane-a-editor-markers.plan.md` Task 4.

- [ ] **Step 1: Add the imports**

In `electron/main.ts`, add `powerMonitor` to the `electron` import list (`:6-15`, alphabetical — between `Notification` and `screen`), and beside the other `src/` imports:

```ts
import {
  MIN_DELAY_MS,
  MIN_INTERVAL_MS,
  parseTimedMessagesFile,
  serializeTimedMessagesFile,
  SUBMIT_GAP_MS,
} from '../src/timed-messages';
import { TimerScheduler } from '../src/timer-scheduler';
```

and add `LimitOffer` to the existing `../src/protocol` type import.

- [ ] **Step 2: Name the file**

In `electron/main.ts`, after `reviewMarksFile()` (`:805`):

```ts
// Armed timed messages (spec 2026-08-28-timed-messages §3). Per-user runtime state, so it lives
// in userData beside sessions.json — never in the project, where an armed timer would read as a
// change in the tree the user is reviewing.
const timedMessagesFile = () => path.join(userData(), 'timed-messages.json');
```

- [ ] **Step 3: Build the scheduler**

Insert immediately after the `PtyHost` construction block and its scrollback helpers (`flushScrollback` / `scheduleScrollbackPersist`), and **before** `flushStateSync`, which reads the dirty gate:

```ts
  // ── Timed messages (spec 2026-08-28-timed-messages) ────────────────────────
  // Host-owned schedules and ONE timer. Declared up here because flushStateSync reads the dirty
  // gate and disposeSession drops a session's schedules.
  let timersDirty = false;
  let limitOffer: LimitOffer | null = null;

  const broadcastTimers = () => {
    // Every window: either may be showing the session, and the offer LEAVING this payload is
    // what dismisses a sibling window's toast (§3, §4).
    broadcast({ type: 'timer:state', schedules: timers.list(), offer: limitOffer });
  };

  /**
   * THE fire path into a PTY. Liveness-checked on BOTH sides of the submit gap: the child can
   * exit inside it, and half a message sitting in a dead PTY must never be reported as sent.
   * Two writes rather than one string — a TUI that coalesces a single read keeps a trailing CR
   * as literal text instead of treating it as submit.
   *
   * Deliberately does NOT call mgr.touch: a 3am robot keystroke is not the user at the keyboard,
   * and lastActiveAt drives card age, the rail's recency sort and board linkage (§2 "Delivery").
   */
  const deliverTimedMessage = async (sessionId: string, message: string): Promise<boolean> => {
    if (!pty.isAlive(sessionId)) return false;
    if (!pty.input(sessionId, message)) return false;
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_GAP_MS));
    if (!pty.isAlive(sessionId)) return false;
    return pty.input(sessionId, '\r');
  };

  const timers = new TimerScheduler({
    now: () => Date.now(),
    setTimer: (ms, fn) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    isAlive: (id) => pty.isAlive(id),
    deliver: deliverTimedMessage,
    sessionExists: (id) => !!mgr.get(id),
    onChange: () => {
      timersDirty = true;
      persistFile(
        timedMessagesFile(),
        serializeTimedMessagesFile({ version: 1, schedules: timers.list() }),
        'timed-messages.json',
      );
      broadcastTimers();
    },
    onFired: (ev) => {
      log.info('timer', 'fired', ev);
      broadcast({ type: 'timer:fired', ...ev });
    },
    // The floor drops to 0 under CONDUIT_E2E so the smoke scenario can arm at +800 ms (§7).
    minDelayMs: process.env.CONDUIT_E2E === '1' ? 0 : MIN_DELAY_MS,
    minIntervalMs: process.env.CONDUIT_E2E === '1' ? 0 : MIN_INTERVAL_MS,
  });

  // setTimeout does not advance across a Windows suspend, so a timer due at 3am is simply late
  // by however long the lid was shut. `nextAt` is the authority, so re-evaluating on wake is the
  // entire fix — there is nothing to reschedule (§2 "The timer").
  powerMonitor.on('resume', () => timers.evaluate());
  powerMonitor.on('unlock-screen', () => timers.evaluate());
```

- [ ] **Step 4: Load the persisted set after the sessions**

In `electron/main.ts`, directly after the `if (settings.restoreSessions) { … }` restore block (ends `:1375`):

```ts
  // AFTER the session set, because a schedule whose session is gone is dropped at load and never
  // re-persisted (§4). Every restored session is `stale` with no PTY, so anything already due
  // lands in `waiting` — nothing is written and nothing is spawned (§2 "Lifecycle").
  timers.load(parseTimedMessagesFile(readBlob(timedMessagesFile())).schedules);
```

- [ ] **Step 5: Flush on quit, behind the dirty gate**

In `flushStateSync`, after the `reviewMarksDirty` write (`:1557-1558`):

```ts
    // Same force-kill-on-update hazard as sessions.json: an interrupted async write would leave
    // an armed timer half-written and the next launch would silently lose it. Gated on an actual
    // change this run — readBlob swallows every read error, so an unconditional flush could
    // overwrite an intact file with nothing (the 0.11.1 durability class of bug).
    if (timersDirty)
      write(
        timedMessagesFile(),
        serializeTimedMessagesFile({ version: 1, schedules: timers.list() }),
        'timed-messages.json',
      );
```

- [ ] **Step 6: Drop a killed session's schedules where every other per-session map is dropped**

In `disposeSession` (`:1852`), after `bellScanState.delete(id);`:

```ts
    // A session's schedules die WITH it, here — not lazily at some later mutation (§2).
    timers.onSessionDisposed(id);
```

- [ ] **Step 7: Open the settle window when a PTY starts**

In the `term:start` case, immediately after `mgr.touch(m.sessionId); // session became active` (`:2741` in the cold-start branch):

```ts
          // Anything waiting on this session delivers PTY_SETTLE_MS from now: a message written
          // into a shell that has not printed its prompt is lost (§2 "Lifecycle"). The ATTACH
          // branch above deliberately does not call this — that PTY has been alive all along,
          // so nothing can be waiting on it.
          timers.onPtyStart(m.sessionId);
```

- [ ] **Step 8: Push the state to a freshly loaded window**

In the `ready` case, after `replyHere({ type: 'review:marks', repos: allMarkRepos() });` (`:1905`):

```ts
          // Timed messages, to the window that just loaded. An empty list is a real answer: it is
          // what opens the renderer's load gate (§3).
          replyHere({ type: 'timer:state', schedules: timers.list(), offer: limitOffer });
```

- [ ] **Step 9: Handle the six renderer messages**

In `handle`'s switch, immediately before `case 'term:input':` (`:2823`):

```ts
        case 'timer:set': {
          // The renderer is not trusted: the scheduler re-sanitizes, revalidates, re-caps and
          // RECOMPUTES nextAt from the trigger. A rejection is a toast, never a silent drop (§3).
          const res = timers.set(m.schedule);
          if (!res.ok) replyHere({ type: 'timer:error', message: res.error });
          break;
        }
        case 'timer:cancel':
          timers.cancel(m.id);
          break;
        case 'timer:renew': {
          const res = timers.renewSchedule(m.id);
          if (!res.ok) replyHere({ type: 'timer:error', message: res.error });
          break;
        }
        case 'timer:sendNow': {
          const sent = await timers.sendNow(m.id);
          if (!sent) replyHere({ type: 'timer:error', message: "That session isn't running." });
          break;
        }
        case 'timer:sendOnce': {
          const sent = await timers.sendOnce(m.sessionId, m.message);
          if (!sent)
            replyHere({ type: 'timer:error', message: "Nothing sent — that session isn't running." });
          break;
        }
        case 'timer:test':
          // Smoke-only seam, gated so it never exists in a shipped build (§7).
          if (process.env.CONDUIT_E2E === '1' && m.op === 'advance') timers.advanceClock(m.ms);
          break;
```

- [ ] **Step 10: Release the timer on quit**

In `before-quit` (`:3159`), beside `clearInterval(sweepTimer);`:

```ts
    // The armed setTimeout would otherwise keep the main process alive past quit.
    timers.stop();
```

- [ ] **Step 11: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0. `timer:offer` is deliberately still unhandled here — Task 7 adds it with the detector that raises it.

- [ ] **Step 12: Commit**

```bash
git add electron/main.ts
git commit -m "feat(timers): own the schedule set, the fire path and its persistence in the host"
```

---

## Task 7: Limit detection on the host, and the `autoResumeOnLimit` setting

**Files:**
- Modify: `src/limit-notice.ts` — add `looksLikeLimitLine` (Task 2's module)
- Modify: `test/unit/limit-notice.test.ts` — cases for it
- Modify: `src/settings.ts` — `AppSettings` (after `osAttention`, `:123`), `DEFAULT_SETTINGS` (after `osAttention: true`, `:203`), `LIMIT_MODES` + `coerceSettings` (after the `osAttention` line, `:438`)
- Modify: `test/unit/coerce-settings.test.ts`
- Modify: `webview/components/settings-modal.tsx` — a row in `General`'s **Notifications** group (`:861-870`)
- Modify: `electron/main.ts` — `limitEpisodes` + `scanForLimitNotice` beside the scheduler block; the scanner call in the `term:data` branch (after the bell scan, `:1231`); the episode drop in `term:exit` (`:1280`) and `disposeSession` (`:1852`); `case 'timer:offer'`

**Interfaces:**
- Consumes: `scanLimitNotice`, `decideLimitAction`, `LimitEpisode`, `TAIL_LINES` (Task 2); `PtyHost.tailLines` (Task 3); `TimerScheduler.armLimit` (Task 5).
- Produces: `export function looksLikeLimitLine(line: string): boolean`; `AppSettings['autoResumeOnLimit']: 'off' | 'offer' | 'arm'` (default `'arm'`).

The detector is a **fourth** chunk-driven scanner beside `countBareBells`, `CwdScanner` and the scrollback ring — but unlike them it does not read the chunk. It re-reads the session's trailing lines *after* the chunk landed, which is the whole gate (§2 "Limit-aware").

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/limit-notice.test.ts` (and add `looksLikeLimitLine` to its import):

```ts
describe('looksLikeLimitLine', () => {
  it('is true for a notice whose time did not parse — the one debug-log case', () => {
    expect(looksLikeLimitLine('Session limit reached — try again later')).toBe(true);
    expect(looksLikeLimitLine('You have hit your usage limit; it resets soon')).toBe(true);
  });

  it('is false for a line missing any one of the three anchors', () => {
    expect(looksLikeLimitLine('You have hit the limit of open files')).toBe(false);
    expect(looksLikeLimitLine('the limit resets nightly')).toBe(false);
    expect(looksLikeLimitLine('usage reached, resets soon')).toBe(false);
  });

  it('is false for ordinary output', () => {
    expect(looksLikeLimitLine('$ npm run verify')).toBe(false);
  });
});
```

Append to `test/unit/coerce-settings.test.ts`:

```ts
describe('autoResumeOnLimit', () => {
  it('defaults to arm — the job is to remove the manual step, not relocate it', () => {
    expect(coerceSettings({}).autoResumeOnLimit).toBe('arm');
  });

  it('accepts each of the three modes', () => {
    expect(coerceSettings({ autoResumeOnLimit: 'off' }).autoResumeOnLimit).toBe('off');
    expect(coerceSettings({ autoResumeOnLimit: 'offer' }).autoResumeOnLimit).toBe('offer');
    expect(coerceSettings({ autoResumeOnLimit: 'arm' }).autoResumeOnLimit).toBe('arm');
  });

  it('falls back to the default for anything else', () => {
    expect(coerceSettings({ autoResumeOnLimit: 'sometimes' }).autoResumeOnLimit).toBe('arm');
    expect(coerceSettings({ autoResumeOnLimit: true }).autoResumeOnLimit).toBe('arm');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/limit-notice.test.ts test/unit/coerce-settings.test.ts`
Expected: FAIL — `looksLikeLimitLine is not a function`, and `expected undefined to be 'arm'`.

- [ ] **Step 3: Export the anchors-only predicate**

In `src/limit-notice.ts`, immediately before `scanLimitNotice`:

```ts
/**
 * The three anchors, without the time. Its ONE consumer is the host's debug log: a notice whose
 * time did not parse is silence plus a single log line, never a guess (§4).
 */
export function looksLikeLimitLine(line: string): boolean {
  return LIMIT_WORD.test(line) && LIMIT_ANCHOR.test(line) && RESET_ANCHOR.test(line);
}
```

and rewrite `scanLimitNotice`'s per-line guard to use it:

```ts
export function scanLimitNotice(tail: readonly string[], now: number): LimitNotice | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!looksLikeLimitLine(line)) continue;
    const parsed = parseResetClock(line);
    if (!parsed) continue;
    const resetAt = resolveClockTime(parsed.clock, parsed.zone, now);
    if (resetAt === null) continue;
    return { resetAt, clock: parsed.clock, ...(parsed.zone ? { zone: parsed.zone } : {}), line };
  }
  return null;
}
```

- [ ] **Step 4: Add the setting**

In `src/settings.ts`, after the `osAttention: boolean;` declaration (`:123`):

```ts
  // Behaviour: what to do when a session's own trailing output says it hit a usage limit and
  // names a reset time. 'arm' (default) schedules `Continue` for reset + 60s and says so with an
  // Undo toast; 'offer' asks first; 'off' does not run the detector at all. Default 'arm'
  // because the stated job is "I don't have to come back and send a message manually" — safety
  // is in the arming gates, not in asking (spec 2026-08-28-timed-messages §5).
  autoResumeOnLimit: LimitResumeMode;
```

Above `AppSettings`, beside the other small unions:

```ts
export type LimitResumeMode = 'off' | 'offer' | 'arm';
```

In `DEFAULT_SETTINGS`, after `osAttention: true,` (`:203`):

```ts
  autoResumeOnLimit: 'arm',
```

Beside `LOG_LEVELS` (`:213`):

```ts
const LIMIT_RESUME_MODES: LimitResumeMode[] = ['off', 'offer', 'arm'];
```

In `coerceSettings`, after the `osAttention:` line (`:438`):

```ts
    autoResumeOnLimit: oneOf(
      payload.autoResumeOnLimit,
      LIMIT_RESUME_MODES,
      DEFAULT_SETTINGS.autoResumeOnLimit,
    ),
```

- [ ] **Step 5: Add the settings row**

In `webview/components/settings-modal.tsx`, inside the `Notifications` `SetGroup` in `General` (`:861-870`), after the `osAttention` `Section`:

```tsx
        <Section
          title="Resume automatically after a usage limit"
          desc="When a session says it hit a usage limit and names a reset time, arm a Continue for just after the reset. Offer asks first; Off never looks."
        >
          <SelectField
            ariaLabel="Resume automatically after a usage limit"
            value={settings.autoResumeOnLimit}
            options={[
              { value: 'arm', label: 'Arm it' },
              { value: 'offer', label: 'Ask me' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => update({ autoResumeOnLimit: v as LimitResumeMode })}
          />
        </Section>
```

Add `LimitResumeMode` to the file's existing `../../src/settings` type import.

- [ ] **Step 6: Run the detector on the host**

In `electron/main.ts`, add to the imports:

```ts
import {
  decideLimitAction,
  type LimitEpisode,
  looksLikeLimitLine,
  scanLimitNotice,
  TAIL_LINES,
} from '../src/limit-notice';
```

Add beside the scheduler block (after the `powerMonitor` lines from Task 6):

```ts
  // Per-session limit episode: the reset time currently on screen and whether it has been acted
  // on. Host memory only — it describes a live moment, and after a restart the notice is gone.
  const limitEpisodes = new Map<string, LimitEpisode>();

  /**
   * Read the session's TRAILING output for a usage-limit notice. Not the chunk: requiring the
   * notice to be what the session is currently SHOWING is what makes arming-by-default
   * defensible — a limit string inside a `git log` or a diff has already scrolled away
   * (spec 2026-08-28-timed-messages §2 "Limit-aware").
   */
  const scanForLimitNotice = (sessionId: string): void => {
    const at = Date.now();
    const notice = scanLimitNotice(pty.tailLines(sessionId, TAIL_LINES), at);
    if (!notice) {
      const [last] = pty.tailLines(sessionId, 1);
      // A notice with no readable time is silence plus one debug line, never a guess (§4).
      if (last && looksLikeLimitLine(last))
        log.debug('timer', 'limit-notice-unparsed', { sessionId, line: last });
      return;
    }
    const action = decideLimitAction(
      limitEpisodes.get(sessionId),
      notice,
      settings.autoResumeOnLimit,
      at,
    );
    if (action === 'ignore') return;
    // Resolved immediately for an arm: the schedule IS the resolution, and a redrawing footer
    // must not produce a second one.
    limitEpisodes.set(sessionId, { resetAt: notice.resetAt, resolved: action === 'arm', at });
    if (action === 'arm') {
      const armed = timers.armLimit(sessionId, notice.resetAt);
      log.info('timer', armed ? 'limit-armed' : 'limit-arm-refused', {
        sessionId,
        resetAt: notice.resetAt,
      });
      return;
    }
    limitOffer = { sessionId, resetAt: notice.resetAt, line: notice.line };
    broadcastTimers();
  };
```

In the `term:data` branch of the `PtyHost` callback, after the bell-scan block (`:1231`):

```ts
        // The fourth scanner. Unlike its three neighbours it does not read `msg.data` — it
        // re-reads the session's trailing lines now that the chunk has landed.
        if (settings.autoResumeOnLimit !== 'off') scanForLimitNotice(msg.sessionId);
```

In the `term:exit` branch, beside `bellScanState.delete(msg.sessionId);` (`:1280`):

```ts
        // The episode described a live moment; a dead child is not asking to be resumed.
        limitEpisodes.delete(msg.sessionId);
```

In `disposeSession`, beside the `timers.onSessionDisposed(id)` line from Task 6:

```ts
    limitEpisodes.delete(id);
    if (limitOffer?.sessionId === id) limitOffer = null;
```

- [ ] **Step 7: Resolve an offer, once**

In `handle`'s switch, beside the other `timer:` cases:

```ts
        case 'timer:offer': {
          // Resolved ONCE, in the host: two windows clicking "Resume then" produce one schedule,
          // and a message for an episode already resolved is a no-op (§3, §4).
          const episode = limitEpisodes.get(m.sessionId);
          if (!episode || episode.resolved) break;
          limitEpisodes.set(m.sessionId, { ...episode, resolved: true, at: Date.now() });
          if (limitOffer?.sessionId === m.sessionId) limitOffer = null;
          if (m.action === 'arm') timers.armLimit(m.sessionId, episode.resetAt);
          broadcastTimers();
          break;
        }
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/limit-notice.test.ts test/unit/coerce-settings.test.ts test/unit/settings.test.ts`
Expected: PASS — 33 limit-notice cases and the three new settings cases.

- [ ] **Step 9: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/limit-notice.ts src/settings.ts electron/main.ts webview/components/settings-modal.tsx test/unit/limit-notice.test.ts test/unit/coerce-settings.test.ts
git commit -m "feat(timers): arm a resume from a session's own usage-limit notice"
```

---

## Task 8: The renderer store (`webview/timer-store.ts`)

**Files:**
- Create: `webview/timer-store.ts`
- Test: `test/unit/timer-store.test.ts`

**Interfaces:**
- Consumes: `LimitOffer`, `TimedMessage`, `FireFailure` from `src/protocol.ts` (Task 4); `post`, `subscribe` from `webview/bridge.ts`.
- Produces:
  - `export interface FireRecord { id: string; sessionId: string; at: number; late: boolean; delivered: boolean; reason?: FireFailure }`
  - `export interface TimerSnapshot { loaded: boolean; schedules: readonly TimedMessage[]; offer: LimitOffer | null; fires: ReadonlyMap<string, FireRecord> }`
  - `export type TimerEvent` — `armed` | `autoArmed` | `cancelled` | `waiting` | `fired` | `error`
  - `subscribeTimers`, `getTimerSnapshot`, `subscribeTimerEvents`
  - `schedulesFor`, `liveSchedulesFor`, `waitingCountFor`
  - `armTimedMessage`, `cancelTimedMessage`, `renewTimedMessage`, `sendTimedMessageNow`, `sendMessageOnce`, `resolveLimitOffer`
  - `__resetTimerStoreForTest`

A module-singleton external store, exactly `webview/review-marks-store.ts`'s shape: `useSyncExternalStore` reads it, the host stays the single owner, and `loaded` is the **load gate** — every control stays disabled until the first `timer:state` lands, so a click during startup cannot be dropped or overwritten by the snapshot that follows.

The **event** channel exists because `timer:state` alone cannot tell the user what just happened: an auto-arm, a fire and an edit all arrive as a new schedule list. Diffing the incoming list against the previous snapshot is what turns those into the six announcements §10 allows.

- [ ] **Step 1: Write the failing test**

Create `test/unit/timer-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, LimitOffer, TimedMessage, WebviewToHost } from '../../src/protocol';
import {
  __resetTimerStoreForTest,
  armTimedMessage,
  cancelTimedMessage,
  getTimerSnapshot,
  liveSchedulesFor,
  resolveLimitOffer,
  schedulesFor,
  sendMessageOnce,
  subscribeTimerEvents,
  subscribeTimers,
  type TimerEvent,
  waitingCountFor,
} from '../../webview/timer-store';

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  emit: (_m: HostToWebview): void => {},
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.emit = cb;
    return () => {};
  },
}));

const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

const schedule = (over: Partial<TimedMessage> = {}): TimedMessage => ({
  id: 'tm-1',
  sessionId: 's1',
  message: 'Continue',
  kind: 'once',
  nextAt: NOW + 60_000,
  maxRepeats: 1,
  firedCount: 0,
  state: 'armed',
  origin: 'manual',
  createdAt: NOW,
  ...over,
});

const push = (schedules: TimedMessage[], offer: LimitOffer | null = null) =>
  bus.emit({ type: 'timer:state', schedules, offer });

beforeEach(() => {
  bus.posted.length = 0;
  __resetTimerStoreForTest();
});

describe('the load gate', () => {
  it('is not loaded until the first push', () => {
    expect(getTimerSnapshot().loaded).toBe(false);
    push([]);
    expect(getTimerSnapshot().loaded).toBe(true);
  });

  it('treats an EMPTY push as a real answer', () => {
    push([]);
    expect(getTimerSnapshot()).toMatchObject({ loaded: true, schedules: [], offer: null });
  });

  it('notifies subscribers and hands out a stable snapshot between pushes', () => {
    const seen = vi.fn();
    const off = subscribeTimers(seen);
    const before = getTimerSnapshot();
    expect(getTimerSnapshot()).toBe(before);
    push([schedule()]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(getTimerSnapshot()).not.toBe(before);
    off();
  });

  it('replaces the list wholesale — the host is authoritative', () => {
    push([schedule(), schedule({ id: 'tm-2' })]);
    push([schedule({ id: 'tm-2' })]);
    expect(getTimerSnapshot().schedules.map((s) => s.id)).toEqual(['tm-2']);
  });
});

describe('selectors', () => {
  it('filters by session and by liveness', () => {
    push([
      schedule(),
      schedule({ id: 'tm-2', state: 'done' }),
      schedule({ id: 'tm-3', sessionId: 's2' }),
    ]);
    expect(schedulesFor(getTimerSnapshot(), 's1').map((s) => s.id)).toEqual(['tm-1', 'tm-2']);
    expect(liveSchedulesFor(getTimerSnapshot(), 's1').map((s) => s.id)).toEqual(['tm-1']);
  });

  it('counts only waiting schedules for the rail badge and the stale card', () => {
    push([
      schedule({ state: 'waiting', waitingSince: NOW }),
      schedule({ id: 'tm-2', state: 'waiting', waitingSince: NOW }),
      schedule({ id: 'tm-3' }),
      schedule({ id: 'tm-4', sessionId: 's2', state: 'waiting', waitingSince: NOW }),
    ]);
    expect(waitingCountFor(getTimerSnapshot(), 's1')).toBe(2);
    expect(waitingCountFor(getTimerSnapshot(), 's2')).toBe(1);
    expect(waitingCountFor(getTimerSnapshot(), 's3')).toBe(0);
  });
});

describe('actions post exactly one message each', () => {
  it('arms through timer:set without inventing a nextAt', () => {
    armTimedMessage({
      sessionId: 's1',
      message: 'Continue',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    expect(bus.posted).toEqual([
      {
        type: 'timer:set',
        schedule: { sessionId: 's1', message: 'Continue', trigger: { kind: 'in', delayMs: 60_000 } },
      },
    ]);
  });

  it('cancels, sends once and resolves an offer', () => {
    cancelTimedMessage('tm-1');
    sendMessageOnce('s1', 'Continue');
    resolveLimitOffer('s1', 'dismiss');
    expect(bus.posted).toEqual([
      { type: 'timer:cancel', id: 'tm-1' },
      { type: 'timer:sendOnce', sessionId: 's1', message: 'Continue' },
      { type: 'timer:offer', sessionId: 's1', action: 'dismiss' },
    ]);
  });

  it('applies nothing optimistically — the host owns the set', () => {
    push([]);
    cancelTimedMessage('tm-1');
    expect(getTimerSnapshot().schedules).toEqual([]);
  });
});

describe('events', () => {
  const collect = () => {
    const events: TimerEvent[] = [];
    const off = subscribeTimerEvents((e) => events.push(e));
    return { events, off };
  };

  it('raises fired with the schedule it belongs to', () => {
    push([schedule({ state: 'done', firedCount: 1 })]);
    const { events, off } = collect();
    bus.emit({
      type: 'timer:fired',
      id: 'tm-1',
      sessionId: 's1',
      at: NOW,
      late: true,
      delivered: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fired' });
    if (events[0].kind === 'fired') {
      expect(events[0].fire).toMatchObject({ late: true, delivered: true });
      expect(events[0].schedule?.id).toBe('tm-1');
    }
    off();
  });

  it('records the last fire per session, for the chip flash', () => {
    bus.emit({
      type: 'timer:fired',
      id: 'tm-1',
      sessionId: 's1',
      at: NOW,
      late: false,
      delivered: true,
    });
    bus.emit({
      type: 'timer:fired',
      id: 'tm-2',
      sessionId: 's1',
      at: NOW + 1000,
      late: true,
      delivered: true,
    });
    expect(getTimerSnapshot().fires.get('s1')).toMatchObject({ id: 'tm-2', late: true });
  });

  it('raises autoArmed only for a limit schedule that was not there before', () => {
    push([]);
    const { events, off } = collect();
    const limit = schedule({ id: 'tm-auto', origin: 'limit' });
    push([limit]);
    push([limit]); // a redraw of the same state must not announce twice
    expect(events.filter((e) => e.kind === 'autoArmed')).toHaveLength(1);
    off();
  });

  it('raises armed, not autoArmed, for a manual schedule', () => {
    push([]);
    const { events, off } = collect();
    push([schedule()]);
    expect(events.map((e) => e.kind)).toEqual(['armed']);
    off();
  });

  it('raises cancelled for a record that simply vanished', () => {
    push([schedule()]);
    const { events, off } = collect();
    push([]);
    expect(events.map((e) => e.kind)).toEqual(['cancelled']);
    off();
  });

  it('raises waiting once, on the transition into waiting', () => {
    push([schedule()]);
    const { events, off } = collect();
    const waiting = schedule({ state: 'waiting', waitingSince: NOW });
    push([waiting]);
    push([waiting]);
    expect(events.filter((e) => e.kind === 'waiting')).toHaveLength(1);
    off();
  });

  it('raises error for a rejected write', () => {
    const { events, off } = collect();
    bus.emit({ type: 'timer:error', message: '3 timed messages already on this session' });
    expect(events).toEqual([
      { kind: 'error', message: '3 timed messages already on this session' },
    ]);
    off();
  });

  it('raises nothing for the very first push, so a relaunch does not re-announce', () => {
    const { events, off } = collect();
    push([schedule({ id: 'tm-auto', origin: 'limit' }), schedule({ id: 'tm-w', state: 'waiting' })]);
    expect(events).toEqual([]);
    off();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/timer-store.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/timer-store"`.

- [ ] **Step 3: Write the implementation**

Create `webview/timer-store.ts`:

```ts
import type {
  FireFailure,
  LimitOffer,
  TimedMessage,
  TimedMessageInput,
} from '../src/protocol';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's timed messages (spec 2026-08-28-timed-messages §3). A
 * module-singleton external store, mirroring review-marks-store.ts: the chip, the dialog, the
 * stale card and the rail read it with useSyncExternalStore, and the host stays the single owner.
 *
 * `loaded` is the LOAD GATE: every control is disabled until the first push lands, so a click
 * during startup can't be silently dropped or overwritten by the snapshot that follows.
 *
 * Nothing is applied optimistically. Unlike a review mark — a local toggle the host echoes — a
 * schedule's `nextAt` is DERIVED host-side (§3), so a local guess would show a time the host
 * never agreed to.
 */

export interface FireRecord {
  id: string;
  sessionId: string;
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface TimerSnapshot {
  loaded: boolean;
  schedules: readonly TimedMessage[];
  offer: LimitOffer | null;
  /** The most recent fire per session — the chip's `late` flash reads this. */
  fires: ReadonlyMap<string, FireRecord>;
}

/**
 * What just happened, as opposed to what is true now. `timer:state` alone cannot distinguish an
 * auto-arm from an edit from a fire, and §10 allows exactly six announcements — so the diff is
 * done here, once, rather than in every consumer.
 */
export type TimerEvent =
  | { kind: 'armed'; schedule: TimedMessage }
  | { kind: 'autoArmed'; schedule: TimedMessage }
  | { kind: 'cancelled'; schedule: TimedMessage }
  | { kind: 'waiting'; schedule: TimedMessage }
  | { kind: 'fired'; fire: FireRecord; schedule?: TimedMessage }
  | { kind: 'error'; message: string };

type Listener = () => void;
type EventListener = (e: TimerEvent) => void;

const EMPTY: TimerSnapshot = { loaded: false, schedules: [], offer: null, fires: new Map() };

let snapshot: TimerSnapshot = EMPTY;
const listeners = new Set<Listener>();
const eventListeners = new Set<EventListener>();

function emit(e: TimerEvent): void {
  eventListeners.forEach((l) => {
    l(e);
  });
}

function notify(next: TimerSnapshot): void {
  snapshot = next;
  listeners.forEach((l) => {
    l();
  });
}

function applyState(schedules: TimedMessage[], offer: LimitOffer | null): void {
  const previous = snapshot;
  notify({ loaded: true, schedules, offer, fires: previous.fires });
  // The FIRST push is the restore, not news: a schedule that came back waiting was announced
  // when it happened, in the run that armed it.
  if (!previous.loaded) return;
  const before = new Map(previous.schedules.map((s) => [s.id, s]));
  for (const s of schedules) {
    const was = before.get(s.id);
    if (!was && s.state !== 'done') {
      emit(s.origin === 'limit' ? { kind: 'autoArmed', schedule: s } : { kind: 'armed', schedule: s });
    } else if (s.state === 'waiting' && was?.state !== 'waiting') {
      emit({ kind: 'waiting', schedule: s });
    }
  }
  const now = new Set(schedules.map((s) => s.id));
  // A record that simply vanished was cancelled — cancel deletes, there is no cancelled state.
  for (const was of previous.schedules) {
    if (!now.has(was.id)) emit({ kind: 'cancelled', schedule: was });
  }
}

subscribe((msg) => {
  if (msg.type === 'timer:state') {
    applyState(msg.schedules, msg.offer);
    return;
  }
  if (msg.type === 'timer:fired') {
    const fire: FireRecord = {
      id: msg.id,
      sessionId: msg.sessionId,
      at: msg.at,
      late: msg.late,
      delivered: msg.delivered,
      ...(msg.reason ? { reason: msg.reason } : {}),
    };
    const fires = new Map(snapshot.fires);
    fires.set(fire.sessionId, fire);
    notify({ ...snapshot, fires });
    emit({ kind: 'fired', fire, schedule: snapshot.schedules.find((s) => s.id === fire.id) });
    return;
  }
  if (msg.type === 'timer:error') emit({ kind: 'error', message: msg.message });
});

export function subscribeTimers(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function subscribeTimerEvents(cb: EventListener): () => void {
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
}

export function getTimerSnapshot(): TimerSnapshot {
  return snapshot;
}

export function schedulesFor(snap: TimerSnapshot, sessionId: string): TimedMessage[] {
  return snap.schedules.filter((s) => s.sessionId === sessionId);
}

/** Everything still on the clock — what the chip renders from. */
export function liveSchedulesFor(snap: TimerSnapshot, sessionId: string): TimedMessage[] {
  return snap.schedules.filter((s) => s.sessionId === sessionId && s.state !== 'done');
}

/** The Waiting count behind the stale card's line and the rail badge (§2 "Waiting"). */
export function waitingCountFor(snap: TimerSnapshot, sessionId: string): number {
  return snap.schedules.filter((s) => s.sessionId === sessionId && s.state === 'waiting').length;
}

export function armTimedMessage(schedule: TimedMessageInput): void {
  post({ type: 'timer:set', schedule });
}

export function cancelTimedMessage(id: string): void {
  post({ type: 'timer:cancel', id });
}

export function renewTimedMessage(id: string): void {
  post({ type: 'timer:renew', id });
}

export function sendTimedMessageNow(id: string): void {
  post({ type: 'timer:sendNow', id });
}

export function sendMessageOnce(sessionId: string, message: string): void {
  post({ type: 'timer:sendOnce', sessionId, message });
}

export function resolveLimitOffer(sessionId: string, action: 'arm' | 'dismiss'): void {
  post({ type: 'timer:offer', sessionId, action });
}

/** Test-only: reset the singleton between cases. */
export function __resetTimerStoreForTest(): void {
  snapshot = EMPTY;
  listeners.clear();
  eventListeners.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/timer-store.test.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/timer-store.ts test/unit/timer-store.test.ts
git commit -m "feat(timers): mirror the host schedule set in a renderer store"
```

---

## Task 9: Registry presence, and a toast that can carry one action

**Files:**
- Modify: `webview/terminal-bus.ts` — `hasRegisteredTerminal` beside `hasLiveTerminal` (`:76-78`)
- Modify: `webview/toast-store.ts` — `ToastAction` on `Toast` and `PushToastInput`
- Modify: `webview/components/toasts.tsx` — render the action button
- Test: `test/unit/terminal-bus.test.ts`, `test/unit/toast-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function hasRegisteredTerminal(sessionId: string): boolean`
  - `export interface ToastAction { label: string; run: () => void }`; `Toast.action?`, `PushToastInput.action?`

`hasRegisteredTerminal` is registry presence **only**. `hasLiveTerminal`'s bracketed-paste precondition is Lane F's safety gate for multi-line review notes and is not touched — timed delivery never routes through this module at all (§2 "Delivery", §12.2). The dialog uses the new read for one thing: whether to disable **Send now** and say why.

The toast action is what §2 "After a fire" asks for — **Undo** on an auto-arm, **Renew** on a miss (plan assumption 9).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/terminal-bus.test.ts`:

```ts
describe('hasRegisteredTerminal', () => {
  const api = (bracketed: boolean) => ({
    focus: () => {},
    paste: () => {},
    bracketedPaste: () => bracketed,
  });

  it('is false for a session with no registered terminal', () => {
    expect(hasRegisteredTerminal('nobody')).toBe(false);
  });

  it('is true for a registered terminal even at a bare shell prompt', () => {
    const off = registerTerminal('s1', api(false));
    // The distinction from hasLiveTerminal is the point: bracketed paste is Lane F's gate for
    // multi-line notes, and timed delivery does not go through this module at all.
    expect(hasRegisteredTerminal('s1')).toBe(true);
    expect(hasLiveTerminal('s1')).toBe(false);
    off();
  });

  it('is false again once the terminal unregisters', () => {
    const off = registerTerminal('s2', api(true));
    off();
    expect(hasRegisteredTerminal('s2')).toBe(false);
  });
});
```

(add `hasRegisteredTerminal` to the file's import list.)

Append to `test/unit/toast-store.test.ts`:

```ts
describe('toast actions', () => {
  it('carries an optional single action through to the snapshot', () => {
    __resetToastsForTest();
    const run = vi.fn();
    pushToast({
      message: 'Armed: Continue at 11:10 PM',
      variant: 'info',
      durationMs: 0,
      action: { label: 'Undo', run },
    });
    const [toast] = getToastsSnapshot();
    expect(toast.action?.label).toBe('Undo');
    toast.action?.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves action undefined when none was given', () => {
    __resetToastsForTest();
    pushToast({ message: 'plain', variant: 'info', durationMs: 0 });
    expect(getToastsSnapshot()[0].action).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/terminal-bus.test.ts test/unit/toast-store.test.ts`
Expected: FAIL — `hasRegisteredTerminal is not a function`, and `expected undefined to be 'Undo'`.

- [ ] **Step 3: Add the registry read**

In `webview/terminal-bus.ts`, immediately after `hasLiveTerminal` (`:78`):

```ts
/**
 * Whether this session has a terminal mounted at all — registry presence, no mode check. Used
 * ONLY for dialog copy ("this session isn't running"); timed delivery is host-side and never
 * routes through this module, which is what leaves hasLiveTerminal's bracketed-paste
 * precondition honest (spec 2026-08-28-timed-messages §2 "Delivery").
 */
export function hasRegisteredTerminal(sessionId: string): boolean {
  return terminals.has(sessionId);
}
```

- [ ] **Step 4: Let a toast carry one action**

In `webview/toast-store.ts`, after the `ToastVariant` type:

```ts
/** One optional affordance on a toast — Undo an auto-arm, Renew a missed fire (§2). One, not a
 *  row: a toast is a notification with a way out, not a dialog. */
export interface ToastAction {
  label: string;
  run: () => void;
}
```

Add `action?: ToastAction;` to both `Toast` and `PushToastInput`, and carry it in `pushToast`:

```ts
  notify([...toasts, { id, message: input.message, variant: input.variant, ...(input.action ? { action: input.action } : {}) }]);
```

In `webview/components/toasts.tsx`, between the message and the close button:

```tsx
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/terminal-bus.test.ts test/unit/toast-store.test.ts`
Expected: PASS — including the 3 + 2 new cases.

- [ ] **Step 6: Commit**

```bash
git add webview/terminal-bus.ts webview/toast-store.ts webview/components/toasts.tsx test/unit/terminal-bus.test.ts test/unit/toast-store.test.ts
git commit -m "feat(timers): add a registry-presence read and a one-action toast"
```

---

## Task 10: Tokens and the chip / Waiting styling

**Files:**
- Modify: `webview/styles.css` — three tokens in `:root` after `--yellow: var(--amber);` (`:74`); a new block appended after the `.term-find__count--none` rule (`:3559-3561`); a `.stale__waiting` rule beside `.stale` (`:3607`); a `.session__timer` rule beside `.session__state`
- Modify: `test/unit/theme-tokens.test.ts` — a new `describe` after the `change-marker tokens` block

**Interfaces:**
- Consumes: nothing.
- Produces: `--timer-armed`, `--timer-auto`, `--timer-late`; classes `.term-timer` (+ `--stacked`, `--armed`, `--auto`, `--offer`, `--late`, `__open`, `__glyph`, `__badge`, `__word`, `__count`, `__cancel`, `__spin`), `.stale__waiting`, `.session__timer`.

The tokens are declared **once, on `:root`, as aliases** — `--accent`, `--amber` and `--text` are already retuned per theme, so a theme retunes these by retuning those. That is §11's "aliasing the palette rather than restating it"; the contrast test below is what proves each theme's *result* still reads. Raw `--amber` misses 4.5:1 on Aero's white `--raise`, which is why the two amber tiers are mixed toward `--text` — the same treatment `.attnchip` uses at `styles.css:1136`.

The chip's tooltip is the **native `title` attribute**, so there is no floating element that could obstruct anything; nothing in this feature sits at `opacity: 0` with pointer events live (`test/unit/hover-overlays.test.ts`).

- [ ] **Step 1: Write the failing test**

Insert into `test/unit/theme-tokens.test.ts`, after the `describe('change-marker tokens', …)` block:

```ts
/**
 * Timed-message tones (spec 2026-08-28-timed-messages §10, §11). The chip paints on --raise, so
 * that is the surface. §10 puts the bar at 4.5:1 for chip TEXT, which also clears the 3:1 its
 * border needs — the border reuses the same token.
 */
describe('timed-message tokens', () => {
  const TIMER_TOKENS = ['--timer-armed', '--timer-auto', '--timer-late'];

  /** Resolve `color-mix(in srgb, var(--a) N%, var(--b))` — the .attnchip text recipe. */
  function resolveMixed(tokens: Record<string, string>, name: string): string {
    const raw = tokens[name];
    if (!raw) throw new Error(`token ${name} is not declared`);
    const mix = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*var\((--[\w-]+)\)\)$/.exec(
      raw,
    );
    if (!mix) return resolve(tokens, name);
    const a = channels(resolve(tokens, mix[1]));
    const b = channels(resolve(tokens, mix[3]));
    const p = Number(mix[2]) / 100;
    const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return `#${a.map((v, i) => hex(v * p + b[i] * (1 - p))).join('')}`;
  }

  for (const { id } of THEMES) {
    const tokens = theme(id);
    const surface = resolve(tokens, '--raise');
    for (const token of TIMER_TOKENS) {
      it(`${id}: ${token} reads on the chip surface ${surface}`, () => {
        expect(contrast(resolveMixed(tokens, token), surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('never signals with colour alone — Auto and late are words, not hues', () => {
    expect(CSS).toMatch(/\.term-timer__badge\s*\{/);
    expect(CSS).toMatch(/\.term-timer__word\s*\{/);
  });

  it('steps below the find bar instead of out-specifying it', () => {
    expect(CSS).toMatch(/\.term-timer--stacked\s*\{[^}]*top:\s*44px/);
  });

  it('drops the chip animation under BOTH reduced-motion switches', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}\.term-timer/);
    expect(CSS).toMatch(/:root\[data-reduce-motion="true"\][^{]*\.term-timer/);
  });

  it('carries state on the border under forced colors, never a background', () => {
    expect(CSS).toMatch(
      /@media \(forced-colors: active\)[\s\S]{0,400}\.term-timer\s*\{[^}]*border-color:\s*CanvasText/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: FAIL — `token --timer-armed is not declared`.

- [ ] **Step 3: Add the tokens**

In `webview/styles.css`, inside `:root`, after `--yellow: var(--amber);` (`:74`):

```css
  /* Timed messages (spec 2026-08-28-timed-messages §11). Roles, not colours: `armed` is "you
     scheduled this and it is on track"; `auto` is the "you didn't ask for this" tier the
     attention amber already owns; `late` is that amber, quieter. Aliases only — a theme retunes
     these by retuning --accent / --amber / --text. Raw --amber misses 4.5:1 on Aero's white
     --raise, so the two amber tiers are mixed toward the theme's ink, exactly as .attnchip does. */
  --timer-armed: var(--accent);
  --timer-auto: color-mix(in srgb, var(--amber) 60%, var(--text));
  --timer-late: color-mix(in srgb, var(--amber) 40%, var(--text));
```

- [ ] **Step 4: Style the chip**

Append after the `.term-find__count--none` rule (`:3561`):

```css
/* ---- timed-message chip (spec 2026-08-28-timed-messages §2 "Overlay") ----
   The .term-find corner, on the .term-follow surface recipe, so it reads as one family with the
   other terminal overlays. Mounted ONLY while this session has something armed: nothing armed,
   no element. Always fully drawn — never opacity:0 with live pointer events, and its tooltip is
   the native `title`, so there is no floating element to obstruct anything. */
.term-timer {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: calc(11.5px * var(--font-scale));
  color: var(--text);
  background: var(--raise);
  border: 1px solid var(--border-2);
  border-radius: var(--r-round);
  box-shadow: var(--elev-3);
  animation: modal-fade 0.1s ease;
}
/* The chip is a GROUP: the whole surface is one real button, and the auto state's cancel is a
   second, separately labelled one — a <button> inside a <button> is invalid HTML and the inner
   one is unreachable in several browsers. */
.term-timer__open {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
/* The find bar owns this corner while it is open; the chip steps below it rather than winning a
   specificity fight with it. */
.term-timer--stacked {
  top: 44px;
}
/* Hover is a NEUTRAL wash (spec 2026-08-01-interaction-state-vocabulary): the border is
   carrying state here, so it must not double as the pointer cue. */
.term-timer:hover {
  background: color-mix(in srgb, var(--text) 8%, var(--raise));
}
.term-timer--armed {
  border-color: var(--timer-armed);
}
.term-timer--auto,
.term-timer--offer {
  border-color: var(--timer-auto);
}
.term-timer--late {
  border-color: var(--timer-late);
}
.term-timer__glyph {
  display: inline-grid;
  place-items: center;
  color: var(--text-dim);
}
.term-timer--armed .term-timer__glyph {
  color: var(--timer-armed);
}
.term-timer--auto .term-timer__glyph,
.term-timer--offer .term-timer__glyph {
  color: var(--timer-auto);
}
.term-timer--late .term-timer__glyph {
  color: var(--timer-late);
}
/* The literal word "Auto" — the user did not ask for this one, so it names itself (§2). */
.term-timer__badge {
  font-size: calc(10px * var(--font-scale));
  font-weight: 600;
  letter-spacing: var(--label-track);
  text-transform: var(--label-case);
  color: var(--timer-auto);
}
/* The literal word "late". */
.term-timer__word {
  font-weight: 600;
  color: var(--timer-late);
}
.term-timer__count {
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.term-timer__cancel {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--text-dim);
  font: inherit;
  cursor: pointer;
}
.term-timer__cancel:hover {
  background: var(--state-hover-bg);
  color: var(--text);
}
.term-timer__spin {
  animation: tm-spin 0.9s linear infinite;
}
@keyframes tm-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .term-timer,
  .term-timer__spin {
    animation: none;
  }
}
:root[data-reduce-motion="true"] .term-timer,
:root[data-reduce-motion="true"] .term-timer__spin {
  animation: none;
}
@media (forced-colors: active) {
  /* State rides the border and the glyph, never a background (§10). */
  .term-timer {
    border-color: CanvasText;
  }
  .term-timer__badge,
  .term-timer__word {
    color: CanvasText;
  }
}
```

- [ ] **Step 5: Style the two Waiting surfaces**

Append after the `.stale` rule (`:3618`):

```css
/* Waiting is signalled where a non-running session actually lives: this card and the rail (spec
   §2 "Waiting"). --text-dim, not a status colour — it is an absence of activity, not something
   that should draw the eye. */
.stale__waiting {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font: inherit;
  font-size: calc(12px * var(--font-scale));
  color: var(--text-dim);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-ctl);
}
.stale__waiting:hover {
  color: var(--text);
  border-color: var(--border-2);
}
/* An INDEPENDENT indicator, deliberately not a sixth session state: the five in
   src/session-icon.ts are mutually exclusive lifecycle states with a precedence order three
   consumers read, and "has a timer waiting" is orthogonal to all of them (§12.10). */
.session__timer {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: calc(10.5px * var(--font-scale));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: PASS — 9 new contrast assertions plus 4 structural ones.

- [ ] **Step 7: Format check**

Run: `npx biome check webview/styles.css`
Expected: no diagnostics. If formatting differs, run `npx biome format --write webview/styles.css` and re-check.

- [ ] **Step 8: Commit**

```bash
git add webview/styles.css test/unit/theme-tokens.test.ts
git commit -m "feat(theme): add timed-message tones and the terminal chip styling"
```

---

## Task 11: The compose / manage dialog

**Files:**
- Create: `webview/components/timed-message-dialog.tsx`
- Modify: `webview/styles.css` — a `.tmdlg*` block appended after the chip block from Task 10

**Interfaces:**
- Consumes: the store (Task 8); `describeNext`, `formatDuration`, `buildSchedule`, `DEFAULT_REPEATS`, `DEFAULT_DELAY_MS`, `MAX_REPEATS`, `sanitizeMessage`, `type TriggerInput` (Task 1); `hasRegisteredTerminal` (Task 9); `SegmentedRadios`; `ConfirmState` from `webview/components/confirm-dialog.tsx`.
- Produces: `export function TimedMessageDialog({ session, onClose, requestConfirm }: { session: Session; onClose: () => void; requestConfirm: (state: ConfirmState) => void }): JSX.Element`

Focus-trapped `role="dialog" aria-modal` over `.modal__backdrop` — the `compare-dialog.tsx` precedent, which also already carries `-webkit-app-region: no-drag` so no control inside it is swallowed by the window drag mask. Confirmation for the one destructive action goes through the app's existing `ConfirmDialog` rather than a second confirm implementation, which is why it is a prop.

- [ ] **Step 1: Write the component**

Create `webview/components/timed-message-dialog.tsx`:

```tsx
/**
 * Timed messages for one session (spec 2026-08-28-timed-messages §2 "The dialog", §9).
 * Composer on top, this session's schedules below. Focus-trapped over .modal__backdrop, on the
 * compare-dialog.tsx precedent.
 *
 * Every time it shows is rendered through Intl in the user's locale and zone, so 12h/24h follows
 * the OS (§10); nothing here formats a clock by hand.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import {
  buildSchedule,
  DEFAULT_DELAY_MS,
  DEFAULT_REPEATS,
  describeNext,
  formatDuration,
  MAX_REPEATS,
  sanitizeMessage,
  type TimedMessage,
  type TriggerInput,
} from '../../src/timed-messages';
import type { Session } from '../../src/types';
import { IconClock, IconClose, IconTrash } from '../icons';
import { hasRegisteredTerminal, subscribeTerminalBus } from '../terminal-bus';
import {
  armTimedMessage,
  cancelTimedMessage,
  getTimerSnapshot,
  renewTimedMessage,
  resolveLimitOffer,
  schedulesFor,
  sendMessageOnce,
  sendTimedMessageNow,
  subscribeTimers,
} from '../timer-store';

const QUICK_MESSAGES = ['Continue', 'Do this again', 'Think about it again'] as const;

type TriggerKind = 'in' | 'at' | 'every';
type Unit = 'minutes' | 'hours';

const TRIGGERS: readonly { id: TriggerKind; label: string }[] = [
  { id: 'in', label: 'In' },
  { id: 'at', label: 'At' },
  { id: 'every', label: 'Every' },
];

const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000 };

/** `HH:MM` in the browser's own zone, which is what `<input type="time">` produces. */
function clockNow(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TimedMessageDialog({
  session,
  onClose,
  requestConfirm,
}: {
  session: Session;
  onClose: () => void;
  requestConfirm: (state: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    focusCancel?: boolean;
    onConfirm: () => void;
  }) => void;
}) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  // Registry presence only — the bracketed-paste gate is Lane F's and is not consulted here.
  const hasTerminal = useSyncExternalStore(
    subscribeTerminalBus,
    () => hasRegisteredTerminal(session.id),
    () => hasRegisteredTerminal(session.id),
  );
  const titleId = useId();
  const messageId = useId();
  const hintId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);

  const [message, setMessage] = useState('Continue');
  const [kind, setKind] = useState<TriggerKind>('in');
  const [delay, setDelay] = useState(DEFAULT_DELAY_MS / UNIT_MS.minutes);
  const [delayUnit, setDelayUnit] = useState<Unit>('minutes');
  const [clock, setClock] = useState(() => clockNow(DEFAULT_DELAY_MS));
  const [every, setEvery] = useState(1);
  const [everyUnit, setEveryUnit] = useState<Unit>('hours');
  const [repeats, setRepeats] = useState(DEFAULT_REPEATS);
  const [editingId, setEditingId] = useState<string | null>(null);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
    [],
  );
  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    [],
  );
  const formatTime = useCallback((at: number) => timeFmt.format(new Date(at)), [timeFmt]);

  const rows = schedulesFor(snap, session.id);
  const offer = snap.offer?.sessionId === session.id ? snap.offer : null;

  const trigger: TriggerInput = useMemo(() => {
    if (kind === 'at') return { kind: 'at', clock };
    if (kind === 'every')
      return { kind: 'every', everyMs: every * UNIT_MS[everyUnit], maxRepeats: repeats };
    return { kind: 'in', delayMs: delay * UNIT_MS[delayUnit] };
  }, [kind, clock, every, everyUnit, repeats, delay, delayUnit]);

  // The same builder the host runs, so the hint can never promise a time the host would refuse.
  // The floor is dropped here only to preview; the host applies the real one (§3).
  const preview = useMemo(
    () =>
      buildSchedule(
        { sessionId: session.id, message, trigger, ...(editingId ? { id: editingId } : {}) },
        Date.now(),
        { minDelayMs: 0, minIntervalMs: 0 },
      ),
    [session.id, message, trigger, editingId],
  );

  const sanitized = sanitizeMessage(message);
  const canArm = preview.ok && sanitized.length > 0 && snap.loaded;

  const hint = (() => {
    if (!sanitized) return 'Type a message.';
    if (!preview.ok) return preview.error;
    const at = preview.schedule.nextAt;
    const first = `First send ${dayFmt.format(new Date(at))} — in ${formatDuration(at - Date.now())}`;
    if (kind !== 'every') return `${first}.`;
    return `${first}, then every ${formatDuration(every * UNIT_MS[everyUnit])}, ${repeats} times.`;
  })();

  const arm = () => {
    if (!canArm) return;
    armTimedMessage({
      sessionId: session.id,
      message: sanitized,
      trigger,
      ...(editingId ? { id: editingId } : {}),
    });
    setEditingId(null);
    onClose();
  };

  const edit = (s: TimedMessage) => {
    setEditingId(s.id);
    setMessage(s.message);
    if (s.kind === 'interval') {
      setKind('every');
      setEvery(Math.max(Math.round((s.everyMs ?? UNIT_MS.hours) / UNIT_MS.hours), 1));
      setEveryUnit('hours');
      setRepeats(s.maxRepeats);
    } else if (s.spec) {
      setKind('at');
      setClock(s.spec.clock);
    } else {
      setKind('in');
      setDelay(Math.max(Math.round((s.nextAt - s.createdAt) / UNIT_MS.minutes), 1));
      setDelayUnit('minutes');
    }
    messageRef.current?.focus();
  };

  const confirmCancel = (s: TimedMessage) => {
    // Always confirms: an armed timer is the thing the user walked away trusting (§2).
    requestConfirm({
      title: 'Cancel timed message',
      message: `Stop sending "${s.message}" to ${session.name}?`,
      confirmLabel: 'Cancel it',
      danger: true,
      focusCancel: true,
      onConfirm: () => cancelTimedMessage(s.id),
    });
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter' && canArm && !(e.target as HTMLElement).closest('.tmdlg__row')) {
      e.preventDefault();
      arm();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div
        ref={rootRef}
        className="tmdlg chamfer"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onRootKeyDown}
      >
        <div className="tmdlg__head">
          <IconClock size={15} />
          <span className="tmdlg__title" id={titleId}>{`Timed messages — ${session.name}`}</span>
          <button type="button" className="tmdlg__close" aria-label="Close" onClick={onClose}>
            <IconClose size={12} />
          </button>
        </div>

        {offer && (
          <div className="tmdlg__offer" role="group" aria-label="Usage limit detected">
            <span className="tmdlg__offertext">
              {`Session limit — resets ${formatTime(offer.resetAt)}. Resume then?`}
            </span>
            <span className="tmdlg__offerline">{offer.line}</span>
            <div className="tmdlg__offeractions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => resolveLimitOffer(session.id, 'arm')}
              >
                Resume then
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => resolveLimitOffer(session.id, 'dismiss')}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="tmdlg__composer">
          <label className="tmdlg__label" htmlFor={messageId}>
            Message
          </label>
          <input
            id={messageId}
            ref={messageRef}
            className="tmdlg__input"
            autoFocus
            value={message}
            aria-describedby={hintId}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="tmdlg__quick">
            {QUICK_MESSAGES.map((q) => (
              <button key={q} type="button" className="tmdlg__chip" onClick={() => setMessage(q)}>
                {q}
              </button>
            ))}
          </div>

          <SegmentedRadios
            label="When"
            className="tmdlg__trigger"
            value={kind}
            options={TRIGGERS}
            onChange={setKind}
          />

          {kind === 'in' && (
            <div className="tmdlg__fields">
              <input
                type="number"
                min={1}
                className="tmdlg__num"
                aria-label="Delay"
                value={delay}
                onChange={(e) => setDelay(Math.max(Number(e.target.value) || 1, 1))}
              />
              <select
                className="tmdlg__unit"
                aria-label="Delay unit"
                value={delayUnit}
                onChange={(e) => setDelayUnit(e.target.value as Unit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          )}

          {kind === 'at' && (
            <div className="tmdlg__fields">
              {/* A native time input rather than a hand-rolled HH:MM + am/pm pair: it is already
                  keyboard-operable and already follows the OS's 12h/24h preference (§10), and it
                  hands back the 24-hour string resolveClockTime wants. */}
              <input
                type="time"
                className="tmdlg__time"
                aria-label="Time of day"
                value={clock}
                onChange={(e) => setClock(e.target.value)}
              />
            </div>
          )}

          {kind === 'every' && (
            <div className="tmdlg__fields">
              <input
                type="number"
                min={1}
                className="tmdlg__num"
                aria-label="Interval"
                value={every}
                onChange={(e) => setEvery(Math.max(Number(e.target.value) || 1, 1))}
              />
              <select
                className="tmdlg__unit"
                aria-label="Interval unit"
                value={everyUnit}
                onChange={(e) => setEveryUnit(e.target.value as Unit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
              <label className="tmdlg__label tmdlg__label--inline" htmlFor={`${hintId}-repeats`}>
                Repeats
              </label>
              <input
                id={`${hintId}-repeats`}
                type="number"
                min={1}
                max={MAX_REPEATS}
                className="tmdlg__num"
                aria-describedby={hintId}
                value={repeats}
                onChange={(e) =>
                  setRepeats(Math.min(Math.max(Number(e.target.value) || 1, 1), MAX_REPEATS))
                }
              />
            </div>
          )}

          <p className="tmdlg__hint" id={hintId}>
            {hint}
          </p>
          {!hasTerminal && (
            <p className="tmdlg__hint tmdlg__hint--muted">
              This session isn't running — it will wait until it starts.
            </p>
          )}

          <div className="tmdlg__actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={!hasTerminal || !sanitized}
              aria-disabled={!hasTerminal || !sanitized}
              aria-describedby={hintId}
              onClick={() => {
                sendMessageOnce(session.id, sanitized);
                onClose();
              }}
            >
              Send now
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canArm}
              aria-keyshortcuts="Enter"
              onClick={arm}
            >
              {editingId ? 'Save' : 'Arm'}
            </button>
          </div>
        </div>

        <div className="tmdlg__list">
          {rows.length === 0 ? (
            <p className="tmdlg__empty">Nothing armed for this session.</p>
          ) : (
            rows.map((s) => (
              <div key={s.id} className="tmdlg__row" role="group" aria-label={s.message}>
                <span className="tmdlg__rowmsg" title={s.message}>
                  {s.message}
                </span>
                <span className="tmdlg__rowwhen">
                  {s.state === 'waiting'
                    ? 'Waiting — will send when this session starts'
                    : describeNext(s, Date.now(), formatTime)}
                </span>
                <span className="tmdlg__rowbadge">{s.origin === 'limit' ? 'Auto' : 'Manual'}</span>
                {s.kind === 'interval' && s.state !== 'done' && (
                  <span className="tmdlg__rowleft">{`${s.maxRepeats - s.firedCount} left`}</span>
                )}
                {s.lastFire && (
                  <span className="tmdlg__rowlast">
                    {s.lastFire.reason === 'expired'
                      ? `· missed (too old)`
                      : `· last ${formatTime(s.lastFire.at)}${s.lastFire.late ? ' · late' : ''}`}
                  </span>
                )}
                <span className="tmdlg__rowactions">
                  {s.state !== 'done' && (
                    <button type="button" className="btn btn--sm" onClick={() => edit(s)}>
                      Edit
                    </button>
                  )}
                  {s.state === 'armed' && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!hasTerminal}
                      aria-disabled={!hasTerminal}
                      onClick={() => sendTimedMessageNow(s.id)}
                    >
                      Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => renewTimedMessage(s.id)}
                  >
                    Renew
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    aria-label={`Cancel ${s.message}`}
                    onClick={() => confirmCancel(s)}
                  >
                    <IconTrash size={12} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

Add the missing import at the top of the file:

```tsx
import { SegmentedRadios } from './segmented-radios';
```

- [ ] **Step 2: Style it**

Append to `webview/styles.css`, after the chip block from Task 10:

```css
/* ---- timed-message dialog (spec 2026-08-28-timed-messages §2 "The dialog") ---- */
.tmdlg {
  width: min(620px, 92vw);
  max-height: 82vh;
  overflow-y: auto;
  padding: 16px;
  background: var(--panel);
  border: 1px solid var(--border-2);
  border-radius: var(--r-panel);
  box-shadow: var(--elev-3);
}
.tmdlg__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.tmdlg__title {
  flex: 1;
  font-weight: 600;
}
.tmdlg__close {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: var(--text-dim);
  cursor: pointer;
}
.tmdlg__close:hover {
  background: var(--state-hover-bg);
  color: var(--text);
}
.tmdlg__composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tmdlg__label {
  color: var(--text-dim);
  font-size: calc(11.5px * var(--font-scale));
}
.tmdlg__label--inline {
  align-self: center;
  margin-left: 8px;
}
.tmdlg__input,
.tmdlg__num,
.tmdlg__unit,
.tmdlg__time {
  padding: 6px 9px;
  background: var(--raise);
  border: 1px solid var(--border-2);
  border-radius: var(--r-ctl);
  color: var(--text);
  font: inherit;
}
.tmdlg__num {
  width: 72px;
}
.tmdlg__quick,
.tmdlg__fields,
.tmdlg__actions,
.tmdlg__rowactions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tmdlg__actions {
  justify-content: flex-end;
  margin-top: 4px;
}
.tmdlg__chip {
  padding: 3px 9px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-round);
  color: var(--text-dim);
  font: inherit;
  font-size: calc(11px * var(--font-scale));
  cursor: pointer;
}
.tmdlg__chip:hover {
  background: var(--state-hover-bg);
  color: var(--text);
}
.tmdlg__hint {
  margin: 0;
  color: var(--text-dim);
  font-size: calc(12px * var(--font-scale));
}
.tmdlg__hint--muted {
  color: var(--text-faint);
}
.tmdlg__offer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  padding: 10px;
  background: color-mix(in srgb, var(--amber) 9%, var(--raise));
  border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
  border-radius: var(--r-ctl);
}
.tmdlg__offertext {
  color: var(--timer-auto);
  font-weight: 600;
}
.tmdlg__offerline {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--font-scale));
}
.tmdlg__offeractions {
  display: flex;
  gap: 6px;
}
.tmdlg__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.tmdlg__empty {
  margin: 0;
  color: var(--text-faint);
  font-size: calc(12px * var(--font-scale));
}
.tmdlg__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--panel-2);
  border-radius: var(--r-card);
  font-size: calc(12px * var(--font-scale));
}
.tmdlg__rowmsg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmdlg__rowwhen,
.tmdlg__rowleft,
.tmdlg__rowlast {
  color: var(--text-dim);
  white-space: nowrap;
}
.tmdlg__rowbadge {
  padding: 1px 7px;
  border: 1px solid var(--border-2);
  border-radius: var(--r-round);
  color: var(--text-dim);
  font-size: calc(10px * var(--font-scale));
  text-transform: var(--label-case);
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0. Nothing renders it yet — Task 14 mounts it.

- [ ] **Step 4: Format check**

Run: `npx biome check webview/components/timed-message-dialog.tsx webview/styles.css`
Expected: no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add webview/components/timed-message-dialog.tsx webview/styles.css
git commit -m "feat(timers): add the compose and manage dialog"
```

---

## Task 12: The terminal chip

**Files:**
- Create: `webview/components/timer-chip.tsx`
- Modify: `webview/components/terminal-pane.tsx` — mount it inside `.termpane-wrap` (`:821`, beside the `.term-follow` and `TermSearchBar` siblings); one new prop

**Interfaces:**
- Consumes: the store (Task 8); `describeNext`, `formatDuration`, `HOUR_MS` (Task 1); `IconClock` (`webview/icons.tsx:440`).
- Produces: `export function TimerChip({ sessionId, stacked, onOpen }: { sessionId: string; stacked: boolean; onOpen: () => void }): JSX.Element | null`; `TerminalPane` gains `onOpenTimedMessages?: (sessionId: string) => void`.

Mounted **only** when that session has a live schedule, a pending offer, or a just-fired notice — nothing armed, no element at all (§2 "Overlay"). It returns `null` rather than rendering a hidden shell, which is also what keeps it out of the hover-obstruction class of bug.

The chip is a **group of two real buttons**, not one button containing another: the whole surface opens the dialog, and the `auto` state's `×` is its own labelled button. A `<button>` inside a `<button>` is invalid HTML and the inner one is unreachable in several browsers.

`firing` is derived, not pushed: the earliest armed schedule's `nextAt` has passed and no `timer:fired` for it has arrived yet — which is precisely the in-flight window. The host sends no "I am delivering" message and does not need to.

- [ ] **Step 1: Write the component**

Create `webview/components/timer-chip.tsx`:

```tsx
/**
 * The armed-timer chip over a terminal (spec 2026-08-28-timed-messages §2 "Overlay", §8).
 *
 * There is no `waiting` and no `paused` chip state: a session in either condition has no pane at
 * all (center-pane.tsx filters on `status === 'running'`), so Waiting is signalled on the stale
 * card and the session rail instead (§2 "Waiting").
 */
import { useEffect, useReducer } from 'react';
import { useSyncExternalStore } from 'react';
import { describeNext, formatDuration, HOUR_MS, type TimedMessage } from '../../src/timed-messages';
import { IconClock } from '../icons';
import { cancelTimedMessage, getTimerSnapshot, liveSchedulesFor, subscribeTimers } from '../timer-store';

/** How long a fire keeps flashing on the chip before it goes back or goes away (§2). */
const LATE_FLASH_MS = 10_000;

type ChipMode = 'armed' | 'auto' | 'offer' | 'firing' | 'late';

const earliest = (list: TimedMessage[]): TimedMessage | null =>
  list.reduce<TimedMessage | null>((best, s) => (!best || s.nextAt < best.nextAt ? s : best), null);

export function TimerChip({
  sessionId,
  stacked,
  onOpen,
}: {
  sessionId: string;
  stacked: boolean;
  onOpen: () => void;
}) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const live = liveSchedulesFor(snap, sessionId).filter((s) => s.state === 'armed');
  const next = earliest(live);
  const offer = snap.offer?.sessionId === sessionId ? snap.offer : null;
  const fire = snap.fires.get(sessionId);
  const now = Date.now();

  /**
   * Presentational only (§2 "The timer" — scope of the no-polling invariant): 1 s under an hour,
   * 1 min above it, and nothing at all while the window is hidden. It may drift, be throttled or
   * be skipped entirely without changing when anything is delivered.
   */
  const nextAt = next?.nextAt ?? null;
  useEffect(() => {
    if (nextAt === null) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (document.visibilityState === 'hidden') return;
      handle = setTimeout(
        () => {
          tick();
          arm();
        },
        nextAt - Date.now() < HOUR_MS ? 1000 : 60_000,
      );
    };
    const onVisibility = () => {
      if (handle) clearTimeout(handle);
      tick();
      arm();
    };
    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (handle) clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [nextAt]);

  const flashing = !!fire && now - fire.at < LATE_FLASH_MS;
  if (!next && !offer && !flashing) return null;

  // Transient states win over standing ones: what just happened is the news.
  const firing = !!next && next.nextAt <= now && (!fire || fire.at < next.nextAt);
  const mode: ChipMode = firing
    ? 'firing'
    : flashing && fire?.late
      ? 'late'
      : offer
        ? 'offer'
        : next?.origin === 'limit'
          ? 'auto'
          : 'armed';

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const formatTime = (at: number) => timeFmt.format(new Date(at));

  const text = (() => {
    if (mode === 'firing') return 'Sending…';
    if (mode === 'late' && fire && next) return `Sent ${formatDuration(fire.at - next.nextAt)} late`;
    if (mode === 'late' && fire) return 'Sent late';
    if (mode === 'offer' && offer) return `Resume at ${formatTime(offer.resetAt)}?`;
    return next ? describeNext(next, now, formatTime) : '';
  })();

  const repeatsLeft = next && next.kind === 'interval' ? next.maxRepeats - next.firedCount : 0;
  const label = [
    mode === 'auto' ? 'Automatic timed message' : 'Timed message',
    text,
    repeatsLeft > 1 ? `${repeatsLeft} sends left` : '',
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <div
      className={`term-timer term-timer--${mode}${stacked ? ' term-timer--stacked' : ''}`}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="term-timer__open"
        // Native title: no floating element, so nothing here can obstruct the terminal.
        title={label}
        aria-label={label}
        onClick={onOpen}
      >
        <span className={`term-timer__glyph${mode === 'firing' ? ' term-timer__spin' : ''}`}>
          {mode === 'offer' ? '!' : <IconClock size={12} />}
        </span>
        {mode === 'auto' && <span className="term-timer__badge">Auto</span>}
        {mode === 'late' && <span className="term-timer__word">late</span>}
        <span>{text}</span>
        {repeatsLeft > 1 && <span className="term-timer__count">{`×${repeatsLeft}`}</span>}
      </button>
      {mode === 'auto' && next && (
        <button
          type="button"
          className="term-timer__cancel"
          aria-label={`Cancel the automatic timed message ${text}`}
          title="Cancel"
          onClick={() => cancelTimedMessage(next.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the pane**

In `webview/components/terminal-pane.tsx`, add the prop to the component's parameter object beside `onOpenCommitReview`:

```tsx
  /** Open the timed-message dialog for this session — from the chip (§2 "Entry points"). */
  onOpenTimedMessages?: (sessionId: string) => void;
```

and render it inside `.termpane-wrap`, immediately after the `{search.open && <TermSearchBar … />}` block (`:891-899`):

```tsx
      {onOpenTimedMessages && (
        <TimerChip
          sessionId={sessionId}
          // The find bar owns the top-right corner while it is open (§4).
          stacked={search.open}
          onOpen={() => onOpenTimedMessages(sessionId)}
        />
      )}
```

with the import:

```tsx
import { TimerChip } from './timer-chip';
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0. `onOpenTimedMessages` is still unpassed — Task 14 threads it.

- [ ] **Step 4: Commit**

```bash
git add webview/components/timer-chip.tsx webview/components/terminal-pane.tsx
git commit -m "feat(timers): show an armed chip over the session's terminal"
```

---

## Task 13: The Waiting signal on the stale card and the rail

**Files:**
- Modify: `webview/components/center-pane.tsx` — the stale and exited cards (`:250-265`); one new prop
- Modify: `webview/components/session-card.tsx` — the waiting badge beside `session__state` (`:136`)

**Interfaces:**
- Consumes: `waitingCountFor`, `getTimerSnapshot`, `subscribeTimers` (Task 8).
- Produces: `CenterPane` gains `onOpenTimedMessages?: (sessionId: string) => void`; no new `SessionCard` prop.

This is where the spec put Waiting, and why: the terminal chip **cannot** show it, because a non-running session has no pane (`center-pane.tsx:123` filters on `status === 'running'`). The rail's indicator is an **independent badge**, not a sixth `SessionIconVisualState` — those five are mutually exclusive lifecycle states with a precedence order three consumers read, and "has a timer waiting" is orthogonal to all of them (§12.10).

`SessionCard` reads the store directly rather than taking a prop: it is a leaf, the store is a module singleton, and threading a count through the sidebar's sort/group/drag plumbing would touch four call sites for one number.

- [ ] **Step 1: Add the stale-card line**

In `webview/components/center-pane.tsx`, add the imports:

```tsx
import { useSyncExternalStore } from 'react';
import { getTimerSnapshot, subscribeTimers, waitingCountFor } from '../timer-store';
import { IconClock } from '../icons';
```

Add a local component above `CenterPane`:

```tsx
/**
 * "A timed message is waiting" — on the surface the user is already looking at when they hit the
 * problem, with Relaunch right beside it (spec 2026-08-28-timed-messages §2 "Waiting").
 */
function WaitingLine({ sessionId, onOpen }: { sessionId: string; onOpen: () => void }) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const count = waitingCountFor(snap, sessionId);
  if (count === 0) return null;
  const label = `${count} timed message${count === 1 ? '' : 's'} waiting`;
  return (
    <button
      type="button"
      className="stale__waiting"
      aria-label={`${label} — open`}
      onClick={onOpen}
    >
      <IconClock size={12} />
      {`${label} — ${count === 1 ? 'it' : 'they'} will send when this session starts.`}
    </button>
  );
}
```

Add the prop to `CenterPane`'s parameter object, beside `onRelaunch`:

```tsx
  /** Open the timed-message dialog for a session — from the stale card's Waiting line. */
  onOpenTimedMessages?: (sessionId: string) => void;
```

and render it in **both** non-running cards (`:250-265`) — an `exited` session has no PTY either:

```tsx
              {active && active.status === 'stale' && (
                <div className="stale">
                  <p className="stale__title">Session not running</p>
                  <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>
                    ↻ Relaunch
                  </button>
                  {onOpenTimedMessages && (
                    <WaitingLine
                      sessionId={active.id}
                      onOpen={() => onOpenTimedMessages(active.id)}
                    />
                  )}
                </div>
              )}
              {active && active.status === 'exited' && (
                <div className="stale">
                  <p className="stale__title">Process exited</p>
                  <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>
                    ↻ Restart
                  </button>
                  {onOpenTimedMessages && (
                    <WaitingLine
                      sessionId={active.id}
                      onOpen={() => onOpenTimedMessages(active.id)}
                    />
                  )}
                </div>
              )}
```

Thread the same prop into `TerminalPane` where the pane is mounted (`:238-245`):

```tsx
                      <TerminalPane
                        sessionId={s.id}
                        agentId={s.agentId}
                        cwd={s.cwd ?? s.projectPath}
                        onOpenFile={onOpenFileAt}
                        onRevealFolder={onRevealFolder}
                        onOpenCommitReview={onOpenCommitReview}
                        onOpenTimedMessages={onOpenTimedMessages}
                      />
```

- [ ] **Step 2: Add the rail badge**

In `webview/components/session-card.tsx`, add the imports:

```tsx
import { useSyncExternalStore } from 'react';
import { IconClock } from '../icons';
import { getTimerSnapshot, subscribeTimers, waitingCountFor } from '../timer-store';
```

Inside `SessionCard`, beside the other derived values (after `const changed = …`, `:91`):

```tsx
  const timerSnap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const waitingTimers = waitingCountFor(timerSnap, session.id);
```

and render it immediately after the `session__state` span (`:136`):

```tsx
        {!editing && waitingTimers > 0 && (
          <>
            {/* The glyph is decorative; the accessible name is carried in text, because the card
                row is a div and an aria-label on it would not be exposed (§9). */}
            <span
              className="session__timer"
              aria-hidden
              title={`${waitingTimers} timed message${waitingTimers === 1 ? '' : 's'} waiting`}
            >
              <IconClock size={11} />
              {waitingTimers}
            </span>
            <span className="sr-only">
              {`${waitingTimers} timed message${waitingTimers === 1 ? '' : 's'} waiting`}
            </span>
          </>
        )}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add webview/components/center-pane.tsx webview/components/session-card.tsx
git commit -m "feat(timers): signal a waiting message on the stale card and the rail"
```

---

## Task 14: Entry points, announcements and toasts

**Files:**
- Modify: `webview/app.tsx` — imports; `timedMessageFor` state beside `iconPickerSessionId` (`:172` region); `openTimedMessages`; the timer-event effect; a palette entry in `commandItems` (`:2221`); a row in `onSessionContextMenu` (`:1577`) and in `onTerminalTabContextMenu`; `onOpenTimedMessages` on `CenterPane`; the dialog mount beside `IconPickerModal` (`:2872`)

**Interfaces:**
- Consumes: `TimedMessageDialog` (Task 11); the store's events + actions (Task 8); `pushToast` with an action (Task 9); `formatDuration` (Task 1).
- Produces: nothing new.

Three entry points plus the chip and the stale card's line: the palette command (**no default key** — `SHORTCUT_ACTIONS` requires a `defaultCombo`, so a binding-less command is palette-only, §5), the session card's context menu, and the terminal tab's context menu.

§10 allows exactly six announcements — *arm*, *auto-arm*, *cancel*, *fire*, *miss*, *waiting* — once each, through the app's existing `role="status" aria-live="polite"` region (`app.tsx:2763`). The countdown is never announced.

- [ ] **Step 1: Add the imports and the state**

In `webview/app.tsx`:

```tsx
import { formatDuration } from '../src/timed-messages';
import { TimedMessageDialog } from './components/timed-message-dialog';
import {
  cancelTimedMessage,
  renewTimedMessage,
  subscribeTimerEvents,
} from './timer-store';
```

(`IconClock` is already exported from `./icons`; add it to the existing icon import list.)

Beside the other modal state (`:172`):

```tsx
  const [timedMessageFor, setTimedMessageFor] = useState<string | null>(null);
```

- [ ] **Step 2: Add the opener**

Beside the other view openers:

```tsx
  /** The palette acts on the ACTIVE session; the chip, the card menu and the stale card name one. */
  const openTimedMessages = useCallback(
    (sessionId?: string) => {
      const target = sessionId ?? activeId;
      if (!target) {
        pushToast({ message: 'Open a session first.', variant: 'error' });
        return;
      }
      setTimedMessageFor(target);
    },
    [activeId],
  );
```

- [ ] **Step 3: Turn timer events into toasts and one announcement each**

Beside the other effects:

```tsx
  // §10: arm, auto-arm, cancel, fire, miss and waiting are announced ONCE each; the countdown
  // never is — a per-second live region would be a screen-reader firehose.
  useEffect(() => {
    const announce = (text: string) => {
      if (navLiveRef.current) navLiveRef.current.textContent = text;
    };
    const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? 'the session';
    const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

    return subscribeTimerEvents((e) => {
      if (e.kind === 'error') {
        pushToast({ message: e.message, variant: 'error' });
        return;
      }
      if (e.kind === 'armed') {
        announce(
          `Timed message armed — ${e.schedule.message}, ${formatDuration(e.schedule.nextAt - Date.now())} from now`,
        );
        return;
      }
      if (e.kind === 'autoArmed') {
        const when = timeFmt.format(new Date(e.schedule.nextAt));
        pushToast({
          message: `Armed: ${e.schedule.message} at ${when}`,
          variant: 'info',
          action: { label: 'Undo', run: () => cancelTimedMessage(e.schedule.id) },
        });
        // The one thing here that happens without the user asking, so it says it was automatic
        // and that Undo exists (§10).
        announce(`Automatically armed — ${e.schedule.message} at ${when}. Undo available.`);
        return;
      }
      if (e.kind === 'cancelled') {
        announce(`Timed message cancelled — ${e.schedule.message}`);
        return;
      }
      if (e.kind === 'waiting') {
        announce(`Timed message waiting — ${nameOf(e.schedule.sessionId)} isn't running`);
        return;
      }
      // A fire. `e.schedule` is the PRE-fire record (the host broadcasts timer:fired before
      // timer:state), so its nextAt is the time this was scheduled for.
      const name = nameOf(e.fire.sessionId);
      const text = e.schedule?.message ?? 'the message';
      const lateBy = e.schedule ? formatDuration(e.fire.at - e.schedule.nextAt) : '';
      if (e.fire.reason === 'expired') {
        pushToast({
          message: `Timed message missed — "${text}" was due too long ago to send`,
          variant: 'error',
          action: { label: 'Renew', run: () => renewTimedMessage(e.fire.id) },
        });
        announce('Timed message missed');
        return;
      }
      if (!e.fire.delivered) {
        pushToast({
          message: `Couldn't send "${text}" to ${name} — the session ended mid-send`,
          variant: 'error',
        });
        announce(`Timed message not sent to ${name}`);
        return;
      }
      const suffix = e.fire.late ? ` — ${lateBy} late (waited for the session)` : '';
      pushToast({ message: `Sent "${text}" to ${name}${suffix}`, variant: 'info' });
      announce(`Sent ${text} to ${name}${e.fire.late ? `, ${lateBy} late` : ''}`);
    });
  }, [sessions]);
```

- [ ] **Step 4: Add the palette command**

In `commandItems`'s `cmds` array, after the `cmd:gitHistory` entry:

```tsx
      {
        id: 'cmd:timedMessage',
        title: 'Send timed message…',
        group: 'Commands',
        icon: <IconClock size={14} />,
        // No default key: SHORTCUT_ACTIONS requires a defaultCombo, so a binding-less command is
        // palette-only — and this is a considered action, not a hot path (§5).
        run: () => openTimedMessages(),
      },
```

Add `openTimedMessages` to the `useMemo` dependency list.

- [ ] **Step 5: Add the two context-menu rows**

In `onSessionContextMenu` (`:1577`), after the `Set icon…` row:

```tsx
        {
          label: 'Timed message…',
          icon: <IconClock size={14} />,
          onClick: () => openTimedMessages(s.id),
        },
```

and the same row in `onTerminalTabContextMenu`, acting on that tab's session id.

- [ ] **Step 6: Thread the opener and mount the dialog**

On the `CenterPane` element, beside `onRelaunch`:

```tsx
          onOpenTimedMessages={openTimedMessages}
```

and beside the `IconPickerModal` mount (`:2872`):

```tsx
      {timedMessageFor &&
        (() => {
          const target = sessions.find((s) => s.id === timedMessageFor);
          return target ? (
            <TimedMessageDialog
              session={target}
              onClose={() => setTimedMessageFor(null)}
              requestConfirm={setConfirm}
            />
          ) : null;
        })()}
```

- [ ] **Step 7: Typecheck, build and format**

Run: `npm run typecheck && npm run build && npx biome check webview/app.tsx`
Expected: exit 0, no diagnostics.

- [ ] **Step 8: Commit**

```bash
git add webview/app.tsx
git commit -m "feat(timers): palette command, context-menu rows, dialog mount and announcements"
```

---

## Task 15: Changelog entry

**Files:**
- Modify: `CHANGELOG.md` — a new `## [Unreleased]` section above `## [0.35.0] — 2026-08-28` (`:7`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the entry**

Insert immediately before `## [0.35.0] — 2026-08-28`:

```markdown
## [Unreleased]

### Added
- **Send a message to a session on a timer.** Open the command bar and run **Send timed
  message…** (it is also on a session's right-click menu): type what to send, choose **In** a
  few minutes, **At** a time of day, or **Every** so often for a set number of repeats, and arm
  it. Conduit types it into that session and presses Enter for you. While something is armed the
  terminal carries a small chip saying what is coming and when — click it to change or cancel —
  and when nothing is armed there is no chip at all.
- **It survives a restart, and it waits for you.** An armed message is remembered across quitting
  the app. Nothing is ever typed into a session that isn't running, and Conduit will not start one
  behind your back: a message whose moment passed while the session was down says **Waiting** on
  the session card and in the sidebar, and sends once — marked late — as soon as you open that
  session again. A message that has been waiting far too long is skipped and offers you a Renew
  instead of surprising you with old instructions.
- **Automatic resume after a usage limit.** When a session's own output says it hit a usage limit
  and names a reset time, Conduit arms a **Continue** for a minute after the reset and tells you so
  with an Undo. The chip labels it **Auto** and cancels in one click, and only what the session is
  showing right now counts — a limit message scrolling past inside a `git log` is not a match. In
  Settings › General you can switch this to ask first, or turn it off.
```

- [ ] **Step 2: Confirm nothing else broke**

Run: `npx biome check CHANGELOG.md`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for timed messages"
```

---

## Task 16: The `timed-messages` e2e scenario

**Files:**
- Create: `test/e2e/timed-messages.e2e.mjs`

**Interfaces:**
- Consumes: `assert`, `closeApp`, `loadPlaywright`, `makeLog`, `openSession`, `REPO`, `runShellReader`, `tapBridge` from `test/e2e/harness.mjs`.
- Produces: nothing.

This crosses the host/IPC boundary **and** the PTY, so per `CLAUDE.md` it gets a scenario on the shared harness. It is written in the `durability.e2e.mjs` style rather than with `runScenario`, because `runScenario` launches into a throwaway user-data dir and the restart half needs the **same** profile twice.

Three mechanisms keep it off the wall clock, exactly as §7 names them:

1. the minimum-delay floor is **0** under `CONDUIT_E2E`, so the on-time path is armed at +800 ms;
2. `timer:test { op:'advance', ms }` proves interval repeats in milliseconds;
3. the restart path uses **no injection** — arm, close, relaunch, assert `waiting` with nothing written, then post the ordinary `relaunch` and assert exactly one late delivery.

Delivery is asserted against a real `cmd.exe` twice over: byte-exact through `runShellReader` (a reader that dumps raw stdin, so the text **and** the `\r` are both visible), and through the shell's own echo on the restart path — which is the only honest test that both landed.

- [ ] **Step 1: Write the scenario**

Create `test/e2e/timed-messages.e2e.mjs`:

```js
/**
 * Timed messages (real-app smoke, spec 2026-08-28-timed-messages §7).
 *
 * Crosses the renderer/host boundary AND the PTY: the schedule, the clock and the write all live
 * in the main process, and the preview bridge has no PTY at all — so only the built app proves it.
 *
 * Launch 1: on-time delivery (byte-exact, via a stdin reader), interval repeats (via the
 *           CONDUIT_E2E clock seam), a chip screenshot, then arm one and quit.
 * Launch 2: the same profile — restored as `waiting` with nothing written, then the ordinary
 *           relaunch path delivers it once, late.
 *
 * Windows only. Run it ALONE on a quiet machine: leftover cmd.exe/conhost starves ConPTY and
 * makes every PTY-adjacent scenario look broken (CLAUDE.md).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  runShellReader,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[timed-messages] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('timed-messages');

/** A reader that echoes READY, then dumps whether the payload AND the Enter both arrived. */
const READER = `$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine("READY")
$in  = [Console]::OpenStandardInput()
$buf = New-Object byte[] 4096
$acc = New-Object System.Collections.Generic.List[byte]
while ($true) {
  $n = $in.Read($buf, 0, $buf.Length)
  if ($n -le 0) { break }
  for ($i = 0; $i -lt $n; $i++) { $acc.Add($buf[$i]) }
  $s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
  if ($s.Contains("conduit-timed-ok") -and $s.Contains([char]13)) { break }
}
$s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
"text=$($s.Contains('conduit-timed-ok')) enter=$($s.Contains([char]13))" | Out-File $env:DUMP -Encoding ascii
`;

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-timed-'));
const workDir = mkdtempSync(join(tmpdir(), 'conduit-timed-work-'));
const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
mkdirSync(shotDir, { recursive: true });

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  // Timer traffic, captured from the moment the window is live.
  await page.evaluate(() => {
    window.__fires = [];
    window.__timers = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'timer:fired') window.__fires.push(m);
      if (m.type === 'timer:state') window.__timers = m;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  return { app, page };
}

const armIn = (page, sessionId, message, delayMs) =>
  page.evaluate(
    ({ sid, msg, ms }) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: { sessionId: sid, message: msg, trigger: { kind: 'in', delayMs: ms } },
      }),
    { sid: sessionId, msg: message, ms: delayMs },
  );

const schedules = (page) => page.evaluate(() => (window.__timers?.schedules ?? []));

let first;
let second;
try {
  // ── Launch 1 ────────────────────────────────────────────────────────────────
  first = await launch();
  const { page } = first;
  const sid = await openSession(page, { path: workDir.replace(/\\/g, '/') });
  log('session running:', sid);

  // ── On-time delivery, byte-exact ────────────────────────────────────────────
  const dump = join(mkdtempSync(join(tmpdir(), 'conduit-timed-dump-')), 'd.txt');
  writeFileSync(dump, '');
  await runShellReader(page, sid, { script: READER, dumpPath: dump });
  log('stdin reader is up ✓');

  const activeBefore = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.lastActiveAt ?? 0,
    sid,
  );

  // The MIN_DELAY_MS floor is 0 under CONDUIT_E2E, so +800 ms is a legal schedule (§7).
  await armIn(page, sid, 'conduit-timed-ok', 800);
  await page.waitForFunction(() => (window.__fires || []).some((f) => f.delivered), null, {
    timeout: 20000,
  });
  const onTime = await page.evaluate(() => window.__fires[0]);
  assert(onTime.delivered === true, 'the on-time fire must report delivered');
  assert(onTime.late === false, `an on-time fire must not be late (got ${JSON.stringify(onTime)})`);

  const dumped = readFileSync(dump, 'utf8');
  assert(/text=True/i.test(dumped), `the shell did not receive the message: ${dumped}`);
  assert(/enter=True/i.test(dumped), `the shell did not receive the Enter: ${dumped}`);
  log('message AND Enter both reached the real shell ✓');

  // A fire is not the user at the keyboard: lastActiveAt must not move (§2 "Delivery").
  const activeAfter = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.lastActiveAt ?? 0,
    sid,
  );
  assert(
    activeAfter === activeBefore,
    `a fire must not touch lastActiveAt (${activeBefore} -> ${activeAfter})`,
  );
  log('lastActiveAt untouched by the fire ✓');

  // ── Interval repeats stop at the limit ──────────────────────────────────────
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: {
          sessionId: id,
          message: 'echo conduit-interval',
          trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
        },
      }),
    sid,
  );
  await page.waitForFunction(
    () => (window.__timers?.schedules ?? []).some((s) => s.kind === 'interval'),
    null,
    { timeout: 10000 },
  );
  const intervalId = (await schedules(page)).find((s) => s.kind === 'interval').id;

  // Four intervals in milliseconds, not four seconds — the CONDUIT_E2E clock seam (§7).
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() =>
      window.agentDeck.post({ type: 'timer:test', op: 'advance', ms: 1000 }),
    );
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(
    (id) => (window.__fires || []).filter((f) => f.id === id).length === 3,
    intervalId,
    { timeout: 20000 },
  );
  const done = (await schedules(page)).find((s) => s.id === intervalId);
  assert(done.state === 'done', `interval must stop at maxRepeats, got ${done.state}`);
  assert(
    done.firedCount === 3,
    `interval must fire exactly 3 times, got ${done.firedCount}`,
  );
  const cap = await page.evaluate(() => window.__cap || '');
  assert(cap.includes('conduit-interval'), 'the interval message never reached the shell');
  log('interval fired 3 times and stopped ✓');

  // ── The chip ────────────────────────────────────────────────────────────────
  await armIn(page, sid, 'conduit-chip', 30 * 60_000);
  await page.locator('.term-timer').first().waitFor({ state: 'visible', timeout: 10000 });
  const chipText = (await page.locator('.term-timer').first().innerText()).trim();
  assert(/\bin \d+/.test(chipText), `the chip must count down, got "${chipText}"`);
  await page.screenshot({ path: join(shotDir, 'timed-messages-chip.png') }).catch(() => {});
  log(`chip reads "${chipText}" ✓`);

  const chipId = (await schedules(page)).find((s) => s.message === 'conduit-chip').id;
  await page.evaluate((id) => window.agentDeck.post({ type: 'timer:cancel', id }), chipId);
  await page.waitForFunction(
    (id) => !(window.__timers?.schedules ?? []).some((s) => s.id === id),
    chipId,
    { timeout: 10000 },
  );

  // ── Arm one that will come due while the app is closed, then quit ───────────
  await armIn(page, sid, 'echo conduit-timed-late', 8000);
  await page.waitForFunction(
    () => (window.__timers?.schedules ?? []).some((s) => s.message === 'echo conduit-timed-late'),
    null,
    { timeout: 10000 },
  );
  await closeApp(first.app, page);
  first = null;
  log('app closed with a schedule armed ✓');

  // ── Launch 2: restored as waiting, with nothing written ─────────────────────
  second = await launch();
  const page2 = second.page;

  // No session is running after a restore, so this can only settle on `waiting` — whether it
  // came due while the app was closed or a moment after it came back.
  const waiting = await page2
    .waitForFunction(
      () =>
        (window.__timers?.schedules ?? []).find(
          (s) => s.message === 'echo conduit-timed-late' && s.state === 'waiting',
        ) || null,
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue());
  assert(waiting, 'the schedule did not come back as waiting');
  assert(
    typeof waiting.waitingSince === 'number',
    'a waiting schedule must record when it came due',
  );
  assert(
    (await page2.evaluate(() => (window.__fires || []).length)) === 0,
    'nothing may be delivered while the session has no PTY',
  );
  assert(
    !(await page2.evaluate(() => window.__cap || '')).includes('conduit-timed-late'),
    'nothing may be written to any terminal while the session is stale',
  );
  log('restored as waiting, nothing written ✓');

  // The stale card says so, beside its Relaunch button.
  await page2.locator('.stale__waiting').first().waitFor({ state: 'visible', timeout: 15000 });
  const waitingText = (await page2.locator('.stale__waiting').first().innerText()).trim();
  assert(/waiting/i.test(waitingText), `the stale card must say Waiting, got "${waitingText}"`);
  log(`stale card reads "${waitingText}" ✓`);

  // ── The ordinary "user opens the session" path delivers it, once, late ──────
  await page2.evaluate(
    (id) => window.agentDeck.post({ type: 'relaunch', id }),
    waiting.sessionId,
  );
  await page2.waitForFunction(() => (window.__fires || []).length > 0, null, { timeout: 60000 });
  const fires = await page2.evaluate(() => window.__fires);
  assert(fires.length === 1, `exactly one late delivery, got ${fires.length}`);
  assert(fires[0].delivered === true, 'the catch-up fire must report delivered');
  assert(fires[0].late === true, 'a catch-up fire must be marked late');

  // The real shell echoes what was typed: the command line AND its output.
  await page2.waitForFunction(
    () => ((window.__cap || '').match(/conduit-timed-late/g) || []).length >= 2,
    null,
    { timeout: 30000 },
  );
  const hits = await page2.evaluate(
    () => ((window.__cap || '').match(/conduit-timed-late/g) || []).length,
  );
  assert(hits === 2, `expected the typed line and its echo exactly once each, got ${hits}`);
  log('shell echoed the late message exactly once ✓');

  // The toast says it was late.
  const toast = (await page2.locator('.toast__msg').first().innerText()).trim();
  assert(/late/i.test(toast), `the toast must mark the send as late, got "${toast}"`);
  log(`toast reads "${toast}" ✓`);

  await closeApp(second.app, page2);
  second = null;

  log('PASS ✓ all assertions passed');
  process.exit(0);
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[timed-messages] FAIL ✗', e.message);
  } else {
    console.error('[timed-messages] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  for (const launched of [first, second]) {
    try {
      if (launched) await launched.app.close();
    } catch {
      /* already gone */
    }
  }
  process.exit(e?.name === 'AssertionError' ? 1 : 2);
}
```

- [ ] **Step 2: Run the scenario alone**

Run: `node test/e2e/run-smoke.mjs timed-messages`
Expected: `PASS ✓ all assertions passed`. Run it on a quiet machine — leftover `cmd.exe`/`conhost` from an earlier run starves ConPTY and makes this look like a broken PTY (`CLAUDE.md`). Re-run a failure **alone** before believing it.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/timed-messages.e2e.mjs
git commit -m "test(e2e): cover timed delivery, interval repeats and the restart catch-up"
```

---

## Task 17: Full gate and evidence

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: a green lane plus the run's evidence.

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: exit 0. Read the WHOLE output — never pipe it through `tail`, which has twice hidden a "Found N errors" line in this repo. If `fallow:check` reports an unused export, **delete the export** rather than suppressing the check: the plan already pruned the two it could see (`emptyTimedMessagesFile` is module-private and `advanceTimerClock` was never written — the e2e posts `timer:test` itself), so anything it reports is a consumer that did not land. If a check fails, fix the code, never the check.

- [ ] **Step 2: Run the full smoke suite**

Run: `npm run test:smoke`
Expected: every scenario PASS or SKIP, zero FAIL. Re-run any single failure alone before believing it.

- [ ] **Step 3: Capture the evidence**

```bash
mkdir -p .autoloop/evidence
npm run verify > .autoloop/evidence/timed-messages-verify.log 2>&1
node test/e2e/run-smoke.mjs timed-messages > .autoloop/evidence/timed-messages-e2e.log 2>&1
cp "$TEMP/claude-scratch/timed-messages-chip.png" .autoloop/evidence/timed-messages-chip.png
```

(On PowerShell: `Copy-Item "$env:TEMP\claude-scratch\timed-messages-chip.png" .autoloop\evidence\timed-messages-chip.png`.)

Expected: three files under `.autoloop/evidence/` — `timed-messages-verify.log` ending in a clean exit, `timed-messages-e2e.log` ending in `PASS`, and a screenshot showing the armed chip over the terminal. `.autoloop/` is gitignored, so none of this reaches the tree.

- [ ] **Step 4: Confirm the working tree is clean of scratch**

Run: `git status --ignored --short`
Expected: only the intended files. Screenshots live under `%TEMP%\claude-scratch`; nothing from this feature belongs in the repo.

- [ ] **Step 5: Commit anything the gate corrected**

```bash
git add -A
git commit -m "chore: verify green for timed messages"
```

(Skip if `git status` is already clean.)

---

## Self-Review

Run against the revised spec with fresh eyes.

**1. Spec coverage (revision note, §0–§12)**

| Spec requirement | Task |
|---|---|
| **Revision 1 — a fire requires a live PTY; the host never spawns one; otherwise `waiting`, `nextAt` held** | 5 (`evaluate`'s `isAlive` branch + `markWaiting`), 6 (no spawn anywhere in the wiring), 16 (asserted after a real restart) |
| **Revision 2 — `autoResumeOnLimit` defaults to `arm`, with the ARMING gated** | 7 (default `'arm'`; the gates are the tail read, the one-per-session cap and the `Auto` chip) |
| **Revision 3 — delivery liveness-checked twice, reports what landed** | 3 (`input` returns boolean), 6 (`deliverTimedMessage`), 5 (`delivered` threaded into `lastFire`/`FiredEvent`) |
| **Revision 4 — no `paused` / `waiting` chip state; Waiting on the stale card + rail** | 12 (chip has five modes, none of them waiting), 13 (both surfaces) |
| **Revision 5 — origin-keyed catch-up; no `mgr.touch` on a fire** | 1 (`CATCHUP_MS`), 6 (`deliverTimedMessage` has no touch), 16 (`lastActiveAt` asserted unchanged) |
| §2 Delivery: `pty.input` twice, `\r` not `\n`, `SUBMIT_GAP_MS`, host-side, not via `terminal-bus` | 6; 9 adds only `hasRegisteredTerminal` for copy |
| §2 `sanitizeMessage` — one line, C0/C1/ESC stripped, 2000 cap, empty rejected | 1 |
| §2 Invariant: a message is only user text or a built-in constant | 1 (`LIMIT_MESSAGE`), 7 (the notice line is displayed, never composed) |
| §2 The schedule: record shape, `MAX_PER_SESSION`, `MAX_TOTAL`, pure module both sides import | 1, 5 (`capError` enforced host-side) |
| §2 Triggers: In / At / Every, defaults, floors, `maxRepeats` | 1 (`buildSchedule`), 11 (composer) |
| §2 Clock resolution: next occurrence, 2-min grace, Intl-only offsets, spring gap, fall-back earlier, ≤25 h, unusable zone → local | 1 (`resolveClockTime`, nine cases) |
| §2 `spec` stored only for Renew | 1 (`renew`), 11 (`edit` reads it back) |
| §2 Lifecycle table (due+live, due+dead, `term:exit`, `term:start` + settle, relaunch, `disposeSession`, pane unmount, quit) | 5 (`evaluate`, `onPtyStart`, `onSessionDisposed`), 6 (the three call sites) |
| §2 Catch-up: window at deliverable-time, skip → `expired`, collapse N slots into one, `firedCount` capped | 1 (`catchUp` / `advanceAfterFire`), 5 |
| §2 Waiting in all three places, one vocabulary | 11 (dialog row), 13 (stale card + rail) |
| §2 The timer: one `setTimeout` to the earliest `nextAt`, re-armed, 2^31−1 clamp, `powerMonitor`, `nextAt` is the authority | 5 (`arm`, the clamp test, `advanceClock`), 6 (`powerMonitor`) |
| §2 Presentational timers may drift | 12 (the countdown tick, visibility-gated) |
| §2 Limit-aware: tail-only, three anchors, time forms, episode state, `arm`/`offer`/`off`, one limit schedule per session, cross-window idempotence | 2, 5 (`armLimit` replaces), 7 (wiring + `timer:offer`) |
| §2 Overlay: chip states, `.term-find` corner, `--stacked`, countdown cadence, real button, no `opacity:0` trap | 10 (CSS), 12 (component) |
| §2 The dialog: composer, quick chips, trigger picker, hint line, list rows, Edit / Renew / Send now / Cancel-with-confirm, no manual pause | 11 |
| §2 After a fire: three toasts, `late` flash, `done` rows stay renewable, dropped from the file | 1 (`serializeTimedMessagesFile` filters `done`), 12 (flash), 14 (toasts) |
| §2 Entry points: palette, chip, stale-card line, card/tab context menu, no default key | 12, 13, 14 |
| §3 `timed-messages.json` — atomic write, dirty gate, quit flush, corrupt → empty | 1 (parse/serialize), 6 |
| §3 Wire pairs incl. `timer:test` under `CONDUIT_E2E` | 4, 6 |
| §3 `PtyHost.input: boolean`, `PtyHost.tailLines` | 3 |
| §3 `terminal-bus.hasRegisteredTerminal` | 9 |
| §3 `AppSettings.autoResumeOnLimit` default `arm` | 7 |
| §3 Host-boundary validation, `nextAt` recomputed, rejection toasts | 1 (`buildSchedule`), 5 (`set`), 6 (`timer:error`) |
| §4 every row: no-PTY, restart, never-reopened, overnight limit vs manual, mid-send exit, collapsed slots, suspend, DST, passed clock, killed session, bare prompt, sanitation, caps, 100 notices, `git log`, quoted notice, no time, two windows, chip vs find bar, `off`, corrupt file, unknown session, hidden window, interleaved typing | 1, 2, 5, 6, 7, 10, 16 — each has a named unit case or an e2e assertion, except the two documented accepted risks (§12.1 bare prompt, interleaved typing) |
| §5 defaults table | 1 (constants), 7 (the one setting) |
| §6 MVP + v1 both built; Vision items absent | all |
| §7 EARS + Gherkin + the three no-wall-clock mechanisms | 16 |
| §7 unit list (`resolveClockTime`, `catchUp`, `sanitizeMessage`, `scanLimitNotice` incl. the diff-tail negative) | 1, 2 |
| §8 state catalog | 11 (composer + rows), 12 (chip), 13 (stale card + rail), 14 (toasts) |
| §9 interaction inventory: keyboard path for every pointer action, Cancel confirms, no drag | 11 (focus trap, Enter arms, Esc closes), 12, 13, 14 (palette is the guaranteed keyboard route) |
| §10 a11y: six announcements only, auto-arm announced, colour never alone, ≥4.5:1, focus return, reduced motion, forced colors, English literals | 10 (tokens + motion + forced colors, asserted), 11 (focus trap), 12 (aria-labels), 14 (the live region) |
| §11 three tokens, aliases not hex, chip reuses the `.term-follow` recipe | 10 |
| CHANGELOG | 15 |

No gaps. §6 "Vision" (per-agent notice profiles, saved templates, a real fire history, arming from the rail without opening the session) is deliberately absent, as are the §1 non-goals — in particular nothing anywhere spawns a PTY.

**2. Placeholder scan**

No "TBD", no "similar to Task N", no "add error handling", no "etc." standing in for code. Every implementation step carries the actual source; every test step carries real assertions with real expected values. The only prose-only steps are the two that legitimately have no artefact — Task 17's gate runs, and the file-path notes inside Task 6 (which is pure wiring and is gated by `typecheck && build` plus Task 16).

**3. Type consistency**

- `TimedMessage`'s twelve fields are identical in Task 1 (declaration), Task 4 (`export type` re-export — no second declaration anywhere), Task 5, Task 8 and every component. `waitingSince` is optional and is removed with `delete`, never set to `undefined`, so a serialized record never carries a null hole.
- `TriggerInput`'s three variants (`in` / `at` / `every`) are produced by the composer in Task 11, carried by `timer:set` in Task 4, and consumed by `buildSchedule` / `nextFireAt` in Task 1 — one declaration, no structural twin.
- `TimedMessageInput` (`id?`, `sessionId`, `message`, `trigger`, `origin?`) is the argument of `buildSchedule` (Task 1), `TimerScheduler.set` (Task 5), `armTimedMessage` (Task 8) and the `timer:set` payload (Task 4). Same type, same name, one declaration.
- `BuildResult` (Task 1) and `SetResult` (Task 5) are structurally identical and deliberately distinct: `set` can fail for reasons `buildSchedule` knows nothing about (unknown session, caps), and it returns `buildSchedule`'s failure unchanged — which typechecks precisely because the shapes match.
- `DueDecision` (`action`, `late`, `slots`, `overdueMs`) is produced by `catchUp` in Task 1 and read by `evaluate` / `fire` in Task 5; `fire` reads only `slots` and `late`.
- `FireFailure` (`'expired' | 'noSession'`) is declared once in Task 1, re-exported through protocol in Task 4, and used by `LastFire`, `FiredEvent` (Task 5), the `timer:fired` message (Task 4) and `FireRecord` (Task 8) — four consumers, one union.
- `SchedulerDeps`'s ten members are satisfied exactly by the literal in Task 6: `now`, `setTimer`, `clearTimer`, `isAlive`, `deliver`, `sessionExists`, `onChange`, `onFired`, `minDelayMs`, `minIntervalMs`. `setTimer` returns `unknown` and `clearTimer` takes `unknown`, which is why Task 6's `clearTimeout` needs its one cast — the alternative is leaking Node's `Timeout` type into a node-free module.
- `LimitNotice` (`resetAt`, `clock`, `zone?`, `line`) is produced by `scanLimitNotice` (Task 2) and consumed by `decideLimitAction` (Task 2) and `scanForLimitNotice` (Task 7); `LimitEpisode` (`resetAt`, `resolved`, `at`) is host-only and never crosses the wire. `LimitOffer` (Task 4) is the wire shape and is a different, deliberately smaller type.
- `TimerEvent`'s six variants are emitted in Task 8 and exhaustively handled in Task 14's effect (`error`, `armed`, `autoArmed`, `cancelled`, `waiting`, then the `fired` fall-through).
- `LimitResumeMode` is declared in `src/settings.ts` (Task 7) and imported by the settings modal (Task 7) and read by `decideLimitAction`'s `LimitMode` parameter — the two unions are spelled identically (`'off' | 'offer' | 'arm'`); `decideLimitAction` keeps its own name because `src/limit-notice.ts` must not import the settings module.
- CSS class names `.term-timer*`, `.stale__waiting`, `.session__timer` are produced in Task 10 and consumed in Tasks 12, 13 and 16; `.tmdlg*` in Task 11 only.
- `formatDuration` / `describeNext` / `HOUR_MS` are imported from `src/timed-messages.ts` by Tasks 11, 12 and 14 — the renderer never re-implements a duration string.

**4. Sequencing**

Each task is independently testable, and the risky host work lands before any UI: the three pure modules (1, 2, 3) come first with unit tests, then the wire (4), then the scheduler (5) with unit tests, then the host wiring (6, 7) gated on `typecheck && build`. Only then does the renderer start — store (8), plumbing (9), tokens (10), dialog (11), chip (12), Waiting (13), entry points (14). Nothing in 8–14 can break a host invariant, and 15–17 are documentation and gates. A reviewer stopping after Task 7 has a complete, working feature with no UI; a reviewer stopping after Task 14 has the whole thing.
