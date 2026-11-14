---
status: approved
date: 2026-11-13
---

# Feature Spec: Scheduler and auto-resume (CON-11)

**Tier:** FULL   **Feature type:** non-UI (server engine; the UI redesign is a separate pass)
**Card:** CON-11 "Auto continue resiliency" (Notion, Conduit Tasks)
**One-line request:** "Make sure the auto-continue feature works for Claude Code and Codex, is
controllable globally and per session, and is robust, not hacky. Investigate triggers, message
length and failure modes." Refined with the owner on 2026-11-13: it lives in the Conduit server,
runs with no window open, uses the CLIs' structured signals before any text scan, keeps an
editable text-rule fallback, and later gets MCP tools.

## 1. Problem frame

- **Job:** when an agent session stops on a usage limit, resume it shortly after the limit resets,
  without the human watching, and never type into a session that already resumed or that is
  doing something else.
- **Actors:** the human (sets defaults and per-session overrides); the agent CLIs (Claude Code,
  Codex; others through rules); the Conduit server (detects, schedules, delivers); later, agents
  through Conduit MCP.
- **Success outcomes (observable):**
  1. A Claude Code or Codex session that hits a limit gets one resume message about
     `margin` after the reset, and a new turn starts.
  2. If the CLI resumed by itself (Claude Code's built-in auto-continue) or the human typed,
     Conduit sends nothing and records "skipped: already resumed".
  3. A multi-paragraph scheduled message arrives whole, with its line breaks, and is submitted.
  4. All of this works with every Conduit window closed.
  5. When Conduit can't resume (no reset time, retries exhausted), the session shows "needs you"
     with the reason, rather than silently doing nothing.
- **Non-goals:** the UI redesign (dialog, chip, settings layout: designed with the owner on the
  "Auto-continue" page of the Conduit UI and Themes canvas); MCP tools (§6 v1); turning off or
  driving Claude Code's own auto-continue; sending anything other than plain text input.

## 2. Behavior & states

### Naming (code and docs)
- **Scheduler**: the server engine that owns **jobs**. A job = a **trigger** + an **action**
  for one session. Today's timed messages become time-triggered jobs.
- **Limit monitor**: turns CLI signals into **limit episodes** and arms **resume jobs**
  (trigger `limit-reset`).
- **Signal adapter**: one per source (Claude hooks + status line, Codex session log, text rules).
- User-facing copy keeps "timed message" and "auto-resume" until the UI pass renames anything.

### Primary flow (resume job)
1. An adapter reports `limited` for session S (with `resetAt` when known).
2. The Limit monitor opens an episode for S (or updates the open one) and, if auto-resume is
   enabled for S, arms a resume job firing at `resetAt + margin`.
3. At fire time the job runs the **pre-fire check**: if S resumed since the episode began, a turn
   is running, or the episode was closed → `skipped` (reason recorded). If S has no live PTY →
   `waiting` (existing behaviour: deliver once it is up).
4. Otherwise it **delivers** the message (§3 Delivery) and enters `verifying`.
5. Within `verifyWindow` a `resumed` signal → `done`, episode closed. A new `limited` signal
   with a later `resetAt` → re-arm (attempt + 1). Nothing at all → `failed: no response`.
6. After `maxAttempts` deliveries without a resume → `failed: still limited`; S is marked
   "needs you" with that reason.

### Job states
`armed → (waiting) → checking → sending → verifying → done`
side exits: `skipped` (pre-fire check), `failed` (delivery error, no response, retries
exhausted), `cancelled` (human, session closed). Time jobs (`in`/`at`/`every`) skip
`verifying` and keep today's repeat semantics. Every transition appends to the job's bounded
history (last 20 entries: state, at, reason) and to the server log (`scheduler` scope).

### Episode states
`open(resetAt | unknown) → resumed | expired | closed-by-session-exit`. `unknown` reset → no job;
S marked "needs you: limit reached, reset time unknown". An episode persists with its job so a
server restart keeps the pre-fire check meaningful.

### Current behaviour (measured 2026-11-13 on the v0.61 tree; the files are identical on main 94fcef13)

| Claim | How measured | Status |
|---|---|---|
| A 2,614-char three-paragraph message is stored as 2,000 chars with no line breaks | esbuild bundle calling `sanitizeMessage` on that input: `in 2614 out 2000 … newlines kept false` | Measured |
| The Codex limit line ("■ You’ve hit your usage limit … try again at 3:45 PM") never arms | same harness: `looksLikeLimitLine → false`, `scanLimitNotice → null` | Measured |
| "resets Nov 18, 3pm" resolves to today's 3pm (date dropped) | same harness, now = Nov 13 15:00 EST → `2026-11-13T20:00Z` | Measured |
| A Claude notice with ≥3 non-empty lines under it is not found (TAIL_LINES = 3) | same harness: notice + 3 lines → `null`; alone → found | Measured |
| Real Claude Code renders ≥3 lines under its limit notice, so detection misses in practice | not reproduced against a live limit | ASSUMED (§13) |
| The message `<input>` drops line breaks on paste | single-line `<input>` in timed-message-dialog.tsx; not driven | ASSUMED (§13) |
| Delivery = one raw write, 120 ms, then `\r`; a long burst can lose the Enter in a TUI | pty-writer.ts read; owner reports partial delivery; not reproduced | ASSUMED (§13) |
| Detection and arming run in the server and work with no window | ADR 0007 + `server/domain/index.ts` `onData`; not driven windowless | ASSUMED, verify in e2e |

## 3. Data / interface contract

### Job (persisted)
```ts
type JobTrigger =
  | { kind: 'in'; delayMs: number } | { kind: 'at'; clock: string; zone?: string }
  | { kind: 'every'; everyMs: number; maxRepeats: number }
  | { kind: 'limit-reset'; episodeId: string; resetAt: number; marginMs: number };
type JobAction = { kind: 'send'; message: string };
interface Job {
  id: string; sessionId: string; origin: 'user' | 'limit' | 'mcp';
  trigger: JobTrigger; action: JobAction; nextAt: number;
  state: 'armed'|'waiting'|'checking'|'sending'|'verifying'|'done'|'skipped'|'failed'|'cancelled';
  attempts: number; maxAttempts: number; createdAt: number;
  history: { at: number; state: Job['state']; reason?: string }[]; // ≤ 20
}
interface LimitEpisode {
  id: string; sessionId: string; cli: CliKind | 'other'; startedAt: number;
  resetAt: number | null; source: SignalSource; state: 'open'|'resumed'|'expired'|'closed';
}
```
- Store: `userData/scheduler.json` `{ version: 2, jobs, episodes }`, written atomically (the
  existing timed-messages writer pattern). First start migrates `timed-messages.json` v1 into it
  and leaves the old file untouched (a downgrade sees its old timers, never a corrupt file).
  Corrupt or foreign-version file = empty set plus one log line (today's rule).
- Caps: today's per-session and total caps stay; at most one live `limit-reset` job per session.

### Signals (adapter → Limit monitor)
```ts
type SignalSource = 'claude-hook' | 'claude-statusline' | 'codex-rollout' | `rule:${string}`;
type LimitSignal =
  | { kind: 'limited'; sessionId: string; at: number; resetAt?: number; window?: string; source: SignalSource; detail?: string }
  | { kind: 'reset-info'; sessionId: string; at: number; windows: { name: string; usedPct?: number; resetAt: number }[]; source: SignalSource }
  | { kind: 'resumed'; sessionId: string; at: number; by: 'cli-auto' | 'turn' | 'human-input'; source: SignalSource }
  | { kind: 'auto-resume-unavailable'; sessionId: string; at: number; source: SignalSource }; // CLI's own auto-continue stopped
```
Priority when sources disagree: structured (hook / status line / session log) beats a rule. A
`limited` without `resetAt` takes it from the newest `reset-info` (the window at ≥100 %, else the
soonest `resetAt` within 8 days), else from a rule's parsed time, else the episode is `unknown`.

### Claude Code adapter
- Launch: the existing per-launch wiring (`src/mcp-launch.ts`, which already adds `--mcp-config`)
  also adds `--settings <host-owned json>` with:
  - hooks `StopFailure` (matcher `rate_limit`) → `limited`; `UserPromptSubmit`, `Stop` → turn
    activity (`resumed` when an episode is open); `Notification` matchers
    `quota_auto_resume_fired` → `resumed{by:'cli-auto'}`, `quota_auto_resume_stale|disabled` →
    `auto-resume-unavailable`.
  - `statusLine` → a Conduit wrapper that forwards the stdin JSON (`rate_limits.*`) as
    `reset-info`, then runs the user's own status line command, if any, and prints its output
    unchanged.
- Hook commands run a small Conduit hook client (beside the existing MCP shim) that posts
  `{event, payload}` to the server endpoint with the session's `CONDUIT_SESSION_TOKEN`; the server
  maps the token to the session (the MCP host already does this). Unknown or missing token →
  dropped, logged.
- **Spike gate (S1):** whether `--settings` hooks and `statusLine` merge with or replace the
  user's own. If they replace, Conduit must chain the user's hooks/status line itself or not
  inject that piece (§13).

### Codex adapter
- Source: the session's rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`).
  **Measured** on this machine's 10 real files (Codex 0.167.0-alpha, written by Codex Desktop):
  - first line `session_meta` with `payload.{id, timestamp, cwd, originator, cli_version, source}`;
  - turns are `event_msg` `task_started` (`turn_id`, `started_at` epoch s) and `task_complete`
    (`turn_id`, `completed_at`, `last_agent_message`). There is **no** `turn_complete` in these
    files, so the source-reading name was wrong for this version;
  - `event_msg` `token_count` carries `rate_limits.{primary,secondary}.{used_percent,
    window_minutes, resets_at (epoch s)}`, `plan_type`, `rate_limit_reached_type`.
  - No file contains a limit, so the error shape on `task_complete` (expected
    `error.codex_error_info == "usage_limit_exceeded"`) is **unconfirmed**; build from a fixture
    and accept either `task_complete.error` or `turn_complete.error`.
- Mapping: limit error on a task/turn end, or `rate_limit_reached_type` non-null → `limited`;
  `token_count.rate_limits` → `reset-info`; a `task_started` after an open episode → `resumed`.
- Watch only through `watchDir` (CLAUDE.md); read appended bytes only; tolerate a partial last line.
- **Spike gates:** S2 field names: settled above, except the limit error shape. S3 how to bind
  a Conduit session to its rollout file (candidates: newest file whose `session_meta.cwd` is the
  session's cwd and whose `timestamp` is after the launch; a `SessionStart` hook if it needs no
  trust prompt). S4 flush latency. **The Codex CLI is not on PATH on this machine** (only Codex
  Desktop's data), so S3/S4 are settled from the openai/codex source plus fixtures, and the
  binding rule must be unit-tested against recorded `session_meta` lines, not a live CLI.

### Text-rule fallback
- File `userData/limit-rules.json`, created on first run with the shipped defaults (today's
  Claude, Codex and Cursor patterns from `src/cli-stuck-screens.ts` and `src/limit-notice.ts`):
```ts
interface LimitRule {
  id: string; cli: CliKind | '*'; enabled: boolean;
  match: string;            // JS regex source, ≤ 500 chars, flags 'mi'
  reset?: { group: string; format: 'clock' | 'clock-or-date' | 'countdown' };
  message?: string;         // overrides the resume message for this rule
}
```
- Evaluated against the **rendered screen** (`runtime.screen` snapshot, last 25 non-empty rows),
  not the raw stream, throttled to at most once per second per session, and only for CLIs with
  no structured adapter or as the reset-time source when the structured `limited` lacks one.
- Reloaded when the file changes (`watchDir`). An invalid rule is disabled and logged; the rest
  still load. Dates parse (`Nov 18, 3pm`, `Nov 18th, 2026 3:45 PM`); a countdown resolves from now.

### Delivery (shared by every job)
- Message: control characters stripped except `\n`; `\r\n`/`\r` → `\n`; line breaks kept. Cap
  `MAX_MESSAGE_CHARS = 16000`. Over the cap is **rejected with an error**, never truncated.
- When the session's app has bracketed paste on (`trackBracketedPaste` already tracks it), send
  `ESC[200~ … ESC[201~`. Without it, a multi-line message has its line breaks joined with a space
  and the job history says so (a bare newline would submit early).
- Enter is sent once the echo settles: output quiet for 300 ms, at most 5 s after the paste;
  then `\r`. No fixed 120 ms gap for long messages.

### Settings and per-session override
| Key (server settings) | Default | Range |
|---|---|---|
| `autoResume` | `on` (migrates `autoResumeOnLimit`: `arm→on`, `offer→ask`, `off→off`) | on / ask / off |
| `autoResumeMarginMs` | 120 000 | 0 – 900 000 |
| `autoResumeMaxAttempts` | 3 | 1 – 5 |
| `autoResumeMessage` | `Continue` | 1 – 16 000 chars |
| `autoResumeVerifyMs` | 90 000 | 30 000 – 600 000 |
| per session (`sessions.json`): `autoResume` | `inherit` | inherit / on / off |

### Server protocol
- Keep `timers.set|cancel|renew|sendNow|offer` and the `timers` state broadcast working for the
  current renderer, backed by the Scheduler (the UI pass renames them). The state gains `jobs`
  (with `state`, `attempts`, `history`) and `episodes`.
- Add `scheduler.setSessionAutoResume {sessionId, mode}` and `scheduler.history {sessionId}`.
- Every method takes and returns plain data, so MCP tools later wrap the same calls.

### Producers / consumers
| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `LimitSignal` | Claude adapter, Codex adapter, rules | Limit monitor | yes |
| Episodes, resume jobs | Limit monitor | Scheduler, attention ("needs you"), renderer chip/dialog | yes; renderer only keeps working (UI pass later) |
| Jobs file | Scheduler | Scheduler on start; older builds read `timed-messages.json` | yes (old file left as is) |
| Delivered keystrokes | pty-writer | the agent CLI | yes |
| `--settings` json, hook client | launch wiring | Claude Code | yes |
| User's own hooks / status line | the user | Claude Code | **no**: Conduit must not replace them (S1 decides chain vs skip) |
| Stuck-screen "needs you" (CON-151) | `cli-stuck-screens.ts` | attention | yes: its patterns become the default rules; it reads the same rule set |
| Settings `autoResume*` | settings modal (renderer) | Limit monitor | yes; the existing select keeps working, new keys get no UI until the UI pass |

### Rulings (settled after the spec review; executors do not re-decide these)
- **R1 Episode lifecycle.** An episode closes only on: a `resumed` signal; the session being
  closed or retired (the close handlers at `server/domain/index.ts` ~1211 and ~1237); the agent
  quitting on its own (PTY exit with `reason === 'exited'`, nothing left to continue → job
  `cancelled: agent exited`); or expiry 24 h after `resetAt`. Any other PTY loss (Conduit's own
  stop, server restart, a restored stale session) keeps the episode open and the job `waiting`.
  So `endEpisode` (~651, called on exit ~750) stops deleting limit episodes except for
  `reason === 'exited'`. A respawned PTY keeps the open episode; the pre-fire check runs when
  delivery becomes possible.
- **R2 Paste-mode tracking for every session.** `trackBracketedPaste` moves out of the
  `scopes.tracks(id)` guard (~697) so `pasteModes` is maintained for all sessions. The scope
  output call stays guarded.
- **R3 What "resumed" means, per source.** Universal: after an episode opens, the session's
  attention status turning busy (`deps.attention.statusOf(id).busy` false → true) emits
  `resumed{by:'turn', source:'attention'}`. Claude adds hook-based `resumed`; Codex adds
  `task_started`. Rules-only CLIs rely on: the matching rule no longer matching on two
  consecutive screen scans after output arrived, OR the universal busy edge. Verify applies to
  every source with this definition.
- **R4 Pre-fire inputs.** "A turn is running" = `deps.attention.statusOf(id).busy`.
  "The human typed" = any keystroke arriving through the window path `term.input`
  (`server/services.ts` ~321 → MCP host `termInput`) after the episode began; Conduit's own
  writer and MCP `send_input` don't count. The Limit monitor records it as
  `resumed{by:'human-input'}` (producer: that path; consumer: the Limit monitor).
- **R5 Delivery location.** The change lives in `src/pty-writer.ts`: `submit(sessionId, text,
  {bracketed})` wraps the paste itself, and the fixed `gapMs` becomes a wait on a new dep
  `outputQuiet(sessionId, quietMs=300, maxMs=5000): Promise<void>` supplied by
  `server/runtime/typing.ts` from the runtime's output events, with a 120 ms floor. `beforeText`
  and `beforeEnter` hooks keep their meaning. `submitEnter` is unchanged. The domain's `deliver`
  callback (~568) passes `bracketed: pasteModes.get(id)?.on`.
- **R6 Rules scan.** Owned by a new Limit-monitor module under `server/domain/`. Trigger: PTY
  data, trailing-edge throttled to one scan per second per session, reading
  `await runtime.screen(id)` (last 25 non-empty rows). The raw `tailLines` scan is removed.
  `LimitRule` gains optional `kind?: StuckKind` and `reason?: string` (a template that may use
  the reset group); `detectStuckScreen` keeps its signature and becomes a reader of the loaded
  rule set, so CON-151's "needs you" and auto-resume share one pattern source.
- **R7 Caps.** `limit-reset` jobs do not count toward `MAX_PER_SESSION` (3) or `MAX_TOTAL` (20)
  in `src/timed-messages.ts`; the separate rule is at most one live resume job per session. A
  resume job is never refused for space.
- **R8 Ask mode.** With effective mode `ask`, a `limited` signal opens the episode and creates the
  job in an extra state `proposed` (never fires), raising today's offer (`limitOffer`,
  `timers.offer`). Accept → `armed`; Dismiss → `cancelled`, re-offered only after today's
  30-minute suppression. Effective mode: a per-session `on` or `off` wins; `inherit` follows the
  global value, `ask` included.
- **R9 Migration v1 → v2**, field by field: `id`, `sessionId`, `createdAt`, `nextAt` copied;
  `message` → `action: {kind:'send', message}`; `kind:'once'` with `spec` → trigger `at`
  `{clock: spec.clock, zone: spec.zone}`; `kind:'once'` without `spec` → trigger `in`
  `{delayMs: nextAt − createdAt}`; `kind:'interval'` → trigger `every` `{everyMs, maxRepeats}`;
  `firedCount` kept as a `firedCount` field (time jobs only); `state` armed/waiting/done copied;
  `waitingSince` kept; `lastFire` → one history entry. `origin:'limit'` → a `limit-reset` job
  with a synthetic open episode (`id: migrated-<job id>`, `resetAt: nextAt − 60 000`,
  `marginMs: 60 000`, `source: 'rule:migrated'`). `attempts` 0, `maxAttempts` from settings.
- **R10 Watching.** Codex: `watchDir` on the current dated folder `sessions/YYYY/MM/DD` only (and
  the next day's once it exists), never the whole tree. Rules file: `watchDir` on `userData`.
- **R11 Hook client and e2e.** E2E uses the real hook client and the real `--settings` wiring with
  a fake `claude` script on PATH that invokes the configured hook commands with recorded
  payloads. All e2e is `test/e2e/<name>.e2e.mjs`, launched only via `launchElectron`, ended only
  via `finishScenario`, run with `npm run e2e:remote`.
- **R12 Spike gate S5 (Claude names).** Measure against the installed Claude Code 2.1.325, with
  no model requests: that `StopFailure` accepts matcher `rate_limit`, that `Notification`
  matchers `quota_auto_resume_fired|stale|disabled` exist, and the statusLine JSON field names
  (from a startup render, or from the docs if no render happens without a request). Anything not
  confirmable is built from fixtures and listed in the run report.
- **R13 Busy is not a resume (replaces R3's busy edge and R4's busy-skip; lead ruling 2026-11-14).**
  Attention's `busy` means "any output in 1.5 s", so a repaint looks like a turn. (1) The attention
  busy edge emits `resumed` only for a session with no live structured adapter (rules-only CLIs, a
  Codex session not yet bound), and only when busy holds continuously for ≥ 2 s. Claude sessions
  and bound Codex sessions resume only from structured signals or human input (R4). (2) Busy at fire
  time never skips: the job goes `waiting` ("session busy"), is re-checked once output has been
  quiet for 3 s, for at most 2 min; on quiet the full pre-fire check runs again and delivers if it
  passes; busy for the whole 2 min → skipped "session kept working", episode resumed. Each outcome
  goes in the job history.

## 4. Edge cases & failure modes

| Condition | Expected behaviour |
|---|---|
| Same notice redrawn or repeated | One episode, one job (keyed by session; `resetAt` change updates the job) |
| Claude's built-in auto-continue fires first | `resumed{cli-auto}` closes the episode; the job skips |
| Built-in auto-continue stops (stale / disabled / >24 h) | Job stays armed; nothing extra |
| Human types into the session before fire | `resumed{human-input}` (or a turn starts) → skip |
| Session busy at fire time | skip, reason "busy" |
| Session closed | jobs cancelled, episode closed (today's `endEpisode` path) |
| PTY down at fire time (restored, stale) | `waiting`, deliver once up, pre-fire check runs again then |
| Server restarted between arm and fire | job and episode restored; overdue job fires once, flagged late |
| Machine asleep across the reset | fires on wake, flagged late; the pre-fire check still applies |
| Still limited after delivery | new `limited` → re-arm; after `maxAttempts` → failed, needs you |
| No signal at all after delivery | `failed: no response`, needs you |
| No reset time | no job; needs you with reason |
| Reset > 8 days out or in the past | treated as unknown (no job), logged |
| Weekly vs 5-hour window both limited | use the later `resetAt` |
| Two windows open on the same server | the server is the single decider; one job (today's rule) |
| Message over 16 000 chars | rejected with an error at arm time and at fire time |
| App without bracketed paste | lines joined, recorded in history |
| Invalid / catastrophic regex in rules | invalid → disabled; patterns capped at 500 chars, input capped at 25 rows |
| Hook client can't reach the server | exits 0 quickly (never blocks Claude), signal lost, rules still apply |
| Codex rollout file missing / not bound | no Codex structured signal; rules apply |
| Auto-resume off (global or session) | episodes still tracked for "needs you"; no job |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Auto-resume on | on | global + per session | the owner wants it as a safety net even with Claude's own |
| Margin after reset | 2 min | yes | reset boundaries are approximate; lets Claude's built-in go first |
| Retries | 3 | yes | bounded: never loop into a limited account |
| Message | `Continue` | yes, and per rule | matches today; long messages now supported |
| Verify window | 90 s | yes | a resumed turn shows activity well within this |
| Rules file | shipped defaults | file edit (UI later) | owner asked for patterns that change without a release |
| Defer to Claude's auto-continue | yes, by pre-fire check | no | sending into its wait cancels it |

## 6. Scope slicing

- **MVP (this build):** spike S1–S4; Scheduler with the job model, persistence and migration;
  Limit monitor with episodes, the pre-fire check, verify and retry; the Claude adapter (per S1);
  the Codex adapter (per S2–S4); the rules fallback on the rendered screen; delivery fixes;
  settings and the per-session override in the server; the existing renderer keeps working, with
  one interim fix: the dialog's message field becomes a multi-line textarea showing the
  16 000-char limit (no other UI change).
- **v1:** MCP tools (`schedule_message`, `list_jobs`, `cancel_job`, `set_auto_resume`) over the
  same server calls; the redesigned UI from the canvas.
- **Vision:** per-CLI layer between global and session; more job triggers (on session idle, on
  exit); job types beyond `send`.
- **Out of scope:** changing Claude Code's own settings; any OS-level scheduler (cron, systemd,
  Task Scheduler). The server is the scheduler; it runs whenever Conduit's service runs.

## 7. Acceptance criteria

### EARS
- When an adapter reports `limited` with a reset time for a session whose auto-resume is on, the
  Limit monitor shall arm exactly one resume job at `resetAt + margin`.
- When a resume job fires and the session has resumed since the episode began, the Scheduler
  shall not write to the PTY and shall record `skipped: already resumed`.
- When a resume job delivers and no `resumed` signal arrives within the verify window, the
  Scheduler shall mark it `failed: no response` and mark the session "needs you".
- If a session is limited again after delivery, then the Scheduler shall re-arm until
  `maxAttempts`, then stop and mark the session "needs you".
- If a limit is detected without a reset time, then the Limit monitor shall arm nothing and mark
  the session "needs you: reset time unknown".
- The Scheduler shall deliver every message of up to 16 000 characters whole, keeping line
  breaks when the app has bracketed paste on, and shall reject longer messages with an error.
- While no Conduit window is open, the Scheduler and Limit monitor shall detect, fire and deliver
  exactly as with a window open.
- Where the user has their own Claude hooks or status line, Conduit's launch shall leave them
  working.

### Gherkin (each is an e2e scenario with a fake CLI in a real PTY)
```gherkin
Feature: Auto-resume
  Scenario: Claude-shaped session resumes after reset
    Given a session running a fake Claude CLI that emits a StopFailure rate_limit hook
      and a status line with five_hour.resets_at 30 seconds ahead
    And autoResumeMarginMs is 5000
    When the reset time plus margin passes
    Then the session receives "Continue" followed by Enter exactly once
    And when the fake CLI emits a UserPromptSubmit hook the job is done

  Scenario: CLI resumed by itself
    Given an armed resume job for a session
    When the fake CLI emits Notification quota_auto_resume_fired before the job fires
    Then nothing is written to the PTY at fire time
    And the job history says "skipped: already resumed"

  Scenario: Codex-shaped session from its session log
    Given a fake Codex CLI bound to a rollout file
    When it appends turn_complete with usage_limit_exceeded and a token_count with resets_at
    Then a resume job is armed for resets_at plus the margin

  Scenario: Long multi-paragraph message
    Given a fake TUI with bracketed paste on
    When a 6000-character three-paragraph message is sent
    Then the TUI receives all 6000 characters inside one bracketed paste, line breaks intact
    And Enter arrives only after the paste has been echoed

  Scenario: Retries run out
    Given autoResumeMaxAttempts is 2 and a fake CLI that reports limited again after each delivery
    When both deliveries happen
    Then no third delivery is made and the session shows needs you with "still limited"

  Scenario: App without bracketed paste
    Given a fake TUI with bracketed paste off
    When a two-line message is sent
    Then it arrives as one line joined by a space and the job history says so

  Scenario: Server restart between arm and fire
    Given an armed resume job
    When the Conduit server restarts and the fire time passes during the restart
    Then the job fires once after start, flagged late, after the pre-fire check

  Scenario: User's own Claude hooks and status line keep working
    Given a user settings file with a SessionStart hook and a statusLine command
    When Conduit launches the fake claude with its --settings
    Then the user's hook runs and the user's status line output is what is shown

  Scenario: Works with no window
    Given the Conduit server is running and every window is closed
    When a fake CLI hits a limit with a reset 20 seconds ahead
    Then the message is delivered after reset plus margin
```

## 8–11. UI module
Not applicable to the engine. The one interim UI change (§6) has these states, and nothing else
in the renderer changes: the message field is a multi-line textarea (Enter adds a line,
Ctrl/Cmd+Enter arms); a count `n / 16,000` sits under it in the existing hint style; over the
limit the count turns to the error colour, Arm is disabled and the hint says "Too long — 16,000
characters at most"; the count is announced through the existing hint's `aria-describedby`.
Copy is English-only like the rest of the dialog.

## 12. Assumptions
- The server process outlives the windows (ADR 0007); e2e confirms it for this feature.
- Claude Code ≥ 2.1.234 and Codex ≥ 0.145 are the structured-signal baselines; older versions
  fall back to rules.
- `CONDUIT_SESSION_TOKEN` is present in every Conduit-launched agent PTY (it is today for MCP).
- The per-session override is stored server-side now; where it appears in the UI is the UI pass.
- Spike sessions use the owner's installed CLIs but make **no model requests** (start-up events,
  hooks that fire before the first prompt, files on disk, recorded fixtures).

## 13. Decisions Needed
- [high] **S1 result:** if `--settings` hooks or `statusLine` replace the user's own, choose chain
  (Conduit reads the user's settings and calls their hooks / status line) vs skip that piece and
  rely on rules. Default if the spike can't settle it: inject `StopFailure` and `Notification`
  hooks only if they merge; never replace the user's status line (no `reset-info` from Claude
  then; reset time from rules).
- [high] **S3 result:** how a Codex session is bound to its rollout file. Default: if no reliable
  binding exists, the Codex adapter ships disabled and Codex uses rules (the `try again at` rule
  with date support), which still fixes today's "never arms".
- [normal] Real Claude Code renders lines under its limit notice (ASSUMED): moot once detection
  reads the rendered screen.
- [normal] The `<input>` paste loss and the lost-Enter cause (ASSUMED): the long-message e2e
  scenario must reproduce today's failure before the fix lands (red first).
- [normal] Names "Scheduler / job / Limit monitor" for code and docs, proposed by the conductor
  and not objected to; user-facing names are decided in the UI pass.
- [normal] Leaving `timed-messages.json` untouched after migration means a downgrade shows old
  timers that already fired. Accepted for a clean downgrade path.

- **Outcome (spike 2026-11-13, `docs/runs/2026-11-13-con-11/spike.md`, approved by the lead):** S1 hooks
  merge, `statusLine` replaces → **chain** (wrapper forwards `rate_limits`, then runs the user's effective
  status line; never blocks or blanks it). S3 → Codex adapter **enabled** with the `session_meta` binding
  rule (rules cover the pre-bind window, no duplicate episode on a late bind). R10 refined: a bound session
  watches its file's own folder.

## 14. Open questions
None that block the build; the two `high` items above have safe defaults and are settled by the spike.

## Self-audit
- Every template section is present or marked not applicable with a reason (§8–11).
- Current-behaviour claims: four measured, four marked ASSUMED and mirrored in §13.
- Producer/consumer: the one "no" (the user's own hooks / status line) is guarded by R11's
  e2e scenario and the S1 default.
- Review findings 1–13 (2026-11-13) addressed in R1–R12, §7 and §8–11.
