# Scheduler and auto-resume (CON-11) — implementation plan

**Spec:** `docs/specs/2026-11-13-scheduler-auto-resume.md`  **Tier:** FULL
**Spike:** `docs/runs/2026-11-13-con-11/spike.md` (decisions D1–D3 in `docs/runs/2026-11-13-con-11/blockers.md`)

## Goal
Replace the timer + tail-scan limit detection with a server-side Scheduler (jobs) and a Limit
monitor fed by structured Claude/Codex signals plus an editable rule set on the rendered screen,
with whole multi-line delivery.

## Architecture
Pure logic lives in `src/` (as `timed-messages.ts`, `timer-scheduler.ts` do today); wiring lives in
`server/`. Every adapter produces `LimitSignal`s; only the Limit monitor
(`server/domain/limit-monitor.ts`, conductor-owned) turns them into episodes and resume jobs; only
the Scheduler (`src/scheduler.ts`) owns job state and timers; only `pty-writer` writes. The domain
(`server/domain/index.ts`) composes them and is edited only by the conductor.

## Data flow
```
Claude Code ──hook cmd──> resources/conduit-mcp/conduit-hook.cjs ──line socket (HookPost)──┐
            ──statusLine─> conduit-hook.cjs statusline (forwards rate_limits, runs user's) ─┤
                                                                                            v
                         server/mcp/endpoint.ts (token→session) ── onHook(sessionId, post) ─┐
Codex rollout JSONL ──watchDir──> server/domain/codex-rollout-watch.ts ── LimitSignal ──────┤
PTY data ──> domain onData ──> limit-monitor rules scan (runtime.screen, ≤1/s) ─ LimitSignal┤
term.input (human) ─> services ─> domain.humanInput(id) ─────────────────────────────────── ┤
attention busy edge ─> domain ─────────────────────────────────────────────────────────────┤
                                                                                            v
                         server/domain/limit-monitor.ts  (episodes, pre-fire, verify policy)
                            │ armResume/accept/cancel/resolveVerify      ▲ preFire(job)
                            v                                            │
                         src/scheduler.ts (jobs, timers, states, history, caps)
                            │ deliver(job) ─> domain: normalize + deliverableText
                            v
                         typing.submit(id, text, {bracketed}) ─> src/pty-writer.ts
                            (paste ESC[200~…ESC[201~, wait outputQuiet 300ms/5s, floor 120ms, \r)
State: userData/scheduler.json {version:2, jobs, episodes}; userData/limit-rules.json;
server-settings.json (autoResume*); sessions.json (Session.autoResume).
```

## Settled decisions — do not re-litigate
- Everything in spec §3 "Rulings" R1–R12 and the spike decisions D1 (chain the status line),
  D2 (Codex adapter enabled with the `session_meta` binding rule), D3 (bound file's folder watched).
- An empty status line renders identically to none (measured 2026-11-13, Claude 2.1.325), so the
  Conduit statusLine is injected for every Claude launch, user status line or not.
- Hook commands are a POSIX shell string on every platform (Claude runs hooks through bash; Git
  Bash on Windows): `ELECTRON_RUN_AS_NODE=1 '<execPath>' '<hookClient>' hook <Event>`. Verified
  by the remote (Windows) e2e; if it fails there it is a conductor fix, not a lane fix.
- Names: Scheduler, job, Limit monitor, episode. User copy keeps "timed message"/"auto-resume".
- Executors are Haiku (user decision); they never edit the conductor-owned files listed under Claims.

## Spec staleness
- Spec says caps live in `src/timed-messages.ts`: true (`MAX_PER_SESSION`/`MAX_TOTAL` at
  `src/timed-messages.ts:71-72`), but the 30-min suppression is `OFFER_SUPPRESS_MS` in
  `src/limit-notice.ts:17`. Plan moves it into the Limit monitor.
- Spec names `src/timed-messages.ts` as the scheduler; the scheduler is actually
  `src/timer-scheduler.ts` (`TimerScheduler`). Plan replaces it with `src/scheduler.ts`.
- Spec's persisted `LimitEpisode` collides with the in-memory `LimitEpisode` at
  `src/limit-notice.ts:30`. The old type is deleted at integration (conductor), with
  `scanLimitNotice`/`decideLimitAction`/`TAIL_LINES`.
- `timers.*` handlers live in `server/domain/index.ts:1437-1474`, not `server/services.ts`.
- The domain's attention dep is only `statusOf` (`src/contracts/server-ports.ts:182`); R3's busy
  edge needs `onChange` (exists on `ServerAttention`, `server/attention/index.ts` ~132). Conductor widens.
- Stuck "needs you" is set from `src/conduit-mcp/host.ts:1696-1700` (`stuckPass`), which would
  clear a monitor-set reason. Plan adds a separate attention fact `setResumeIssue` (conductor).
- `watchDir` (`electron/watch-dir.ts:78`) has no `server/` importer yet; server modules import it
  from there (pure Node, no Electron API).

## Global constraints
- Gate: `npm run verify` (conductor only, exit code captured directly). Executors run
  `npx vitest run <their test files>` and `npx tsc -p tsconfig.json --noEmit` and
  `npx biome check <their files>` — never e2e, never the full gate under load.
- Node/TS per repo (`tsconfig.json`), vitest 4, Biome. Tests: `test/unit/<kebab>.test.ts`.
- **Comments explain WHY, never what.** If the why is in the spec, the comment is a pointer:
  `// see spec 2026-11-13-scheduler-auto-resume R5`. No `as any`, no `@ts-ignore`, no swallowed
  errors (log them), no `!important`, no magic offsets.
- Names: files kebab-case; types PascalCase; functions camelCase; constants UPPER_SNAKE.
- Every new export must have a caller (a test counts: `test/unit/*.test.ts` are fallow entries).
- Never use `process.platform` in a unit test; normalise paths in code.
- Git: commit only on your lane branch with
  `git -c user.name="$(git log -1 --format=%an main)" -c user.email="$(git log -1 --format=%ae main)" commit`.
- GUI rule (verbatim, applies to anyone who might launch anything graphical): any GUI app launched
  for testing (Electron, browsers) must be invisible, with no windows on the desktop and no focus
  stealing (--ozone-platform=headless or a headless display). If hiding can't be guaranteed, don't
  launch. Executors launch nothing.

## Out of scope
MCP tools; the UI redesign; any renderer change beyond the dialog textarea and re-pointing the
existing settings select to `autoResume`; OS schedulers; changing Claude/Codex settings files.

## Contracts (Slice 0 — conductor commits these before lanes start)

### `src/contracts/scheduler.ts`
```ts
import type { CliKind } from '../conduit-mcp/tool-policy';
import type { SignalSource } from './auto-resume';
export type JobTrigger =
  | { kind: 'in'; delayMs: number }
  | { kind: 'at'; clock: string; zone?: string }
  | { kind: 'every'; everyMs: number; maxRepeats: number }
  | { kind: 'limit-reset'; episodeId: string; resetAt: number; marginMs: number };
export type JobAction = { kind: 'send'; message: string };
export type JobState =
  | 'proposed' | 'armed' | 'waiting' | 'checking' | 'sending' | 'verifying'
  | 'done' | 'skipped' | 'failed' | 'cancelled';
export const TERMINAL_JOB_STATES: readonly JobState[] = ['done', 'skipped', 'failed', 'cancelled'];
export const JOB_HISTORY_MAX = 20;
export interface JobHistoryEntry { at: number; state: JobState; reason?: string }
export interface Job {
  id: string; sessionId: string; origin: 'user' | 'limit' | 'mcp';
  trigger: JobTrigger; action: JobAction; nextAt: number; state: JobState;
  attempts: number; maxAttempts: number; createdAt: number;
  history: JobHistoryEntry[];
  firedCount?: number;      // time jobs only (R9)
  waitingSince?: number;
}
export interface LimitEpisode {
  id: string; sessionId: string; cli: CliKind | 'other'; startedAt: number;
  resetAt: number | null; source: SignalSource; state: 'open' | 'resumed' | 'expired' | 'closed';
}
export interface SchedulerFile { version: 2; jobs: Job[]; episodes: LimitEpisode[]; kind?: 'newer' }
export type PreFireVerdict = { go: true } | { go: false; reason: string };
export type DeliveryResult = { ok: true; joined: boolean } | { ok: false; reason: string };
export type AutoResumeMode = 'on' | 'ask' | 'off';
export type SessionAutoResume = 'inherit' | 'on' | 'off';
```

### `src/contracts/auto-resume.ts`
```ts
import type { CliKind } from '../conduit-mcp/tool-policy';
import type { StuckKind } from '../cli-stuck-screens';
export type SignalSource =
  | 'claude-hook' | 'claude-statusline' | 'codex-rollout' | 'attention' | 'human-input' | `rule:${string}`;
export type LimitSignal =
  | { kind: 'limited'; sessionId: string; at: number; resetAt?: number; window?: string; source: SignalSource; detail?: string }
  | { kind: 'reset-info'; sessionId: string; at: number; windows: { name: string; usedPct?: number; resetAt: number }[]; source: SignalSource }
  | { kind: 'resumed'; sessionId: string; at: number; by: 'cli-auto' | 'turn' | 'human-input'; source: SignalSource }
  | { kind: 'auto-resume-unavailable'; sessionId: string; at: number; source: SignalSource };
export type ResetFormat = 'clock' | 'clock-or-date' | 'countdown';
export interface LimitRule {
  id: string; cli: CliKind | '*'; enabled: boolean;
  match: string;                       // JS regex source, ≤ 500 chars, flags 'mi'
  reset?: { group: string; format: ResetFormat };   // group = a named capture group in `match`
  message?: string;
  kind?: StuckKind;                    // R6: CON-151 "needs you" kind
  reason?: string;                     // R6: template; `{reset}` is replaced by the reset group text
}
export interface RuleMatch { rule: LimitRule; resetAt: number | null; resetText: string | null; reason: string }
export const LIMIT_RULE_MAX_PATTERN = 500;
export const RULE_SCAN_ROWS = 25;
```
(`'attention'` and `'human-input'` are the R3/R4 sources; spec's `SignalSource` list gains them —
recorded as a plan-level extension, needed because R3 names `source:'attention'`.)

### `src/contracts/hook-protocol.ts`
```ts
/** One line, hook client → server, on the MCP endpoint socket; the server answers `HookAck` and closes. */
export interface HookPost { conduitHook: 1; token: string; event: HookEvent; payload: unknown }
export type HookEvent = 'StopFailure' | 'UserPromptSubmit' | 'Stop' | 'Notification' | 'StatusLine';
export type HookAck = { conduitHook: 1; ok: boolean };
export const HOOK_POST_MAX_BYTES = 256 * 1024;
```

### `src/message-text.ts` (conductor writes it fully in Slice 0, with `test/unit/message-text.test.ts`)
```ts
export const MAX_MESSAGE_CHARS = 16_000;
export const MESSAGE_TOO_LONG = 'Too long — 16,000 characters at most';
export type MessageCheck = { ok: true; message: string } | { ok: false; error: string };
/** \r\n and \r → \n; strips C0 (except \n), DEL, C1; trims; empty → error 'Message is empty'; > cap → MESSAGE_TOO_LONG. Never truncates. */
export function normalizeMessage(raw: string): MessageCheck;
/** bracketed → text unchanged; else lines joined with ' ' (blank lines dropped), joined:true iff a \n was present. */
export function deliverableText(message: string, bracketed: boolean): { text: string; joined: boolean };
```

### Version registry (`src/contracts/session-identity.ts` `SERVER_FILE_VERSION`)
Add `'scheduler.json': 2` and `'limit-rules.json': 1`.

### Fixtures (conductor, Slice 0): `test/fixtures/codex-rollout/`
`primary-meta.jsonl` (one primary `session_meta` line, redacted from a real file),
`guardian-meta.jsonl` (a subagent `session_meta`), `turn.jsonl` (task_started, token_count with
rate_limits, task_complete), `limit.jsonl` (task_started, token_count with
`rate_limit_reached_type`, task_complete with `error.codex_error_info: "usage_limit_exceeded"`),
`limit-turn-complete.jsonl` (same, `turn_complete`). `test/fixtures/claude-hooks/`:
`stop-failure-rate-limit.json`, `user-prompt-submit.json`, `stop.json`,
`notification-quota-fired.json`, `notification-quota-stale.json`, `statusline-rate-limits.json`,
`statusline-startup.json`.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| Message normalisation (newlines kept, 16k, reject) | `src/message-text.ts` | Scheduler.set/armResume, domain deliver, dialog | both |
| Persisted jobs (`scheduler.json`) | `src/scheduler-store.ts` serialize (domain writer) | domain start → Scheduler.load | both |
| `timed-messages.json` | old builds | `migrateTimedMessagesV1` (read only, file untouched) | consumer only — producer is older builds, unaffected by design |
| Legacy `timer:state.schedules` | Scheduler → `toTimedMessage` | renderer timer-store/chip/dialog | both (renderer unchanged; projection keeps its shape) |
| `timer:state.jobs/episodes` (new) | domain timersState | renderer (ignores unknown fields) | producer; renderer consumption is the UI pass |
| Paste delivery + Enter timing | pty-writer | agent CLI | both (e2e) |
| `outputQuiet` | `server/runtime/output-quiet.ts` from runtime `data` events | pty-writer | both |
| `pasteModes` for all sessions (R2) | domain onData | deliver, MCP `bracketedPaste` port | both |
| `--settings` JSON | `src/claude-hook-settings.ts` via `src/mcp-launch.ts` | Claude Code | both (S1 measured) |
| HookPost lines | `conduit-hook.cjs` | `server/mcp/endpoint.ts` → `onHook` → monitor | both |
| Claude LimitSignals | `src/claude-signals.ts` | limit-monitor | both |
| Codex LimitSignals | `server/domain/codex-rollout-watch.ts` | limit-monitor | both |
| Rule matches | `src/limit-rules.ts` | limit-monitor (resume) and `detectStuckScreen` (CON-151) | both |
| Settings `autoResume*` | settings modal / `serverSettings.patch` | limit-monitor | both |
| Session `autoResume` | `scheduler.setSessionAutoResume` | limit-monitor | both |
| "needs you" (resume issue) | limit-monitor → `attention.setResumeIssue` | attention statusOf → sidebar | both |
| Human input | services `term.input` | limit-monitor `resumed{human-input}` | both |

## File map
| Path | Action | Responsibility | Owner |
|---|---|---|---|
| `src/contracts/scheduler.ts` | create | job/episode types | conductor S0 |
| `src/contracts/auto-resume.ts` | create | signal + rule types | conductor S0 |
| `src/contracts/hook-protocol.ts` | create | hook wire line | conductor S0 |
| `src/message-text.ts` | create | normalise + deliverable text | conductor S0 |
| `src/contracts/session-identity.ts` | modify | file versions | conductor S0 |
| `test/fixtures/codex-rollout/*`, `test/fixtures/claude-hooks/*` | create | recorded inputs | conductor S0 |
| `src/scheduler.ts` | create | `Scheduler` class (replaces `TimerScheduler`) | lane A |
| `src/scheduler-store.ts` | create | v2 parse/serialize, v1 migration (R9) | lane A |
| `src/pty-writer.ts` | modify | bracketed submit, outputQuiet wait | lane B |
| `server/runtime/output-quiet.ts` | create | per-session output-quiet waiter | lane B |
| `server/runtime/typing.ts` | modify | supply outputQuiet | lane B |
| `webview/components/timed-message-dialog.tsx` | modify | interim textarea + count | lane B |
| `src/claude-hook-settings.ts` | create | build `--settings` JSON | lane C |
| `src/claude-user-status-line.ts` | create | resolve user's effective statusLine (launch-time copy of padding etc.) | lane C |
| `src/claude-signals.ts` | create | hook/status-line payload → LimitSignal | lane C |
| `src/mcp-launch.ts` | modify | add `--settings` arg + settingsJson | lane C |
| `resources/conduit-mcp/conduit-hook.cjs` | create | hook client + statusline wrapper | lane C |
| `server/mcp/endpoint.ts` | modify | accept HookPost line → `onHook` | lane C |
| `src/reset-time.ts` | create | clock / date / countdown parsing | lane D |
| `src/limit-rules.ts` | create | defaults, parse/validate file, match | lane D |
| `src/cli-stuck-screens.ts` | modify | becomes a reader of a rule set | lane D |
| `src/codex-rollout.ts` | create | meta parse, binding predicate, line → signal, line splitter | lane D |
| `server/domain/codex-rollout-watch.ts` | create | bind + tail rollout files via watchDir | lane D |
| `server/domain/limit-rules-file.ts` | create | create/load/reload `limit-rules.json` | lane D |
| `server/domain/limit-monitor.ts` | create | episodes, pre-fire, verify policy, rules scan, offer | conductor |
| `server/domain/index.ts`, `server/services.ts`, `server/compose.ts`, `server/mcp/index.ts`, `src/conduit-mcp/host.ts`, `server/attention/index.ts`, `src/contracts/server-ports.ts`, `src/contracts/server-protocol.ts`, `src/protocol.ts`, `src/settings.ts`, `src/types.ts`, `src/persistence.ts`, `src/session-manager.ts`, `server/domain/testing/fakes.ts`, `webview/components/settings-modal.tsx` | modify | integration | conductor |
| `src/timer-scheduler.ts`, `test/unit/timer-scheduler.test.ts` | delete | superseded by Scheduler | conductor (integration) |
| `src/limit-notice.ts`, `test/unit/limit-notice.test.ts` | delete | superseded by rules + reset-time | conductor (integration) |
| `src/timed-messages.ts` | modify | drop `sanitizeMessage` cap/`MAX_MESSAGE_CHARS`/`SUBMIT_GAP_MS` once unused | conductor (integration) |
| `test/e2e/auto-resume-*.e2e.mjs`, `test/e2e/fixtures/fake-claude-hooks.mjs` | create | §7 scenarios | conductor |
| `CHANGELOG.md` | modify | Unreleased entry | conductor |

## Scripts
1. `tools/` none durable. One-off (conductor, scratchpad): `make-fixtures.py` redacting real
   `session_meta` lines into `test/fixtures/codex-rollout/`. Count: 1.

## Slices

### Slice 0: contracts (conductor)
**Check:** `npx vitest run test/unit/message-text.test.ts` green; `npm run verify` exit 0; commit.

### Slice A: Scheduler core (lane A, Haiku)
**Check:** `npx vitest run test/unit/scheduler.test.ts test/unit/scheduler-store.test.ts` green;
`npx tsc -p tsconfig.json --noEmit` exit 0; `npx biome check src/scheduler.ts src/scheduler-store.ts test/unit/scheduler*.test.ts` exit 0.
**Parallel groups:** G-A: A.1, A.2 (A.2 after A.1, same executor)

#### Task A.1: scheduler store + migration
**Files:** Create `src/scheduler-store.ts`; Test `test/unit/scheduler-store.test.ts`.
**Interfaces — Produces:**
```ts
export function parseSchedulerFile(blob: string | null, opts: { maxAttempts: number; now: number }): SchedulerFile;
export function serializeSchedulerFile(file: SchedulerFile): string;
export function migrateTimedMessagesV1(v1: TimedMessagesFile, opts: { maxAttempts: number }): { jobs: Job[]; episodes: LimitEpisode[] };
```
Consumes: `Job, LimitEpisode, SchedulerFile, JOB_HISTORY_MAX, TERMINAL_JOB_STATES` from
`src/contracts/scheduler.ts`; `TimedMessage, TimedMessagesFile, parseTimedMessagesFile` from
`src/timed-messages.ts`; `judgePersistedVersion` and `SERVER_FILE_VERSION` from
`src/contracts/session-identity.ts` (read how `parseTimedMessagesFile` at
`src/timed-messages.ts:480-505` uses them and mirror it); `normalizeMessage` from `src/message-text.ts`.
**Rules:** null/corrupt/foreign → `{version:2, jobs:[], episodes:[]}`; newer version → same plus
`kind:'newer'`. Invalid individual jobs (bad message per `normalizeMessage`, unknown trigger kind)
are dropped. `serializeSchedulerFile` keeps non-terminal jobs, plus terminal `limit-reset` jobs
whose last history entry is < 24 h old (max 10 per session, newest kept), and episodes referenced
by a kept job or in state `open`. R9 mapping exactly as spec §3 R9 (copy it into test names).
**Steps:**
- [ ] Failing tests: 'parses null/corrupt/foreign as empty', 'marks a newer file', 'round-trips a v2 file',
  'R9: once with spec → at trigger', 'R9: once without spec → in trigger delayMs = nextAt − createdAt',
  'R9: interval → every', 'R9: firedCount, waitingSince copied; lastFire → one history entry',
  'R9: origin limit → limit-reset job + synthetic open episode migrated-<id>, resetAt nextAt − 60000, marginMs 60000, source rule:migrated',
  'R9: attempts 0, maxAttempts from opts', 'serialize drops done time jobs and old terminal limit jobs'.
- [ ] Run `npx vitest run test/unit/scheduler-store.test.ts` — expect FAIL (module missing).
- [ ] Implement.

#### Task A.2: Scheduler class
**Files:** Create `src/scheduler.ts`; Test `test/unit/scheduler.test.ts` (port every case of
`test/unit/timer-scheduler.test.ts` to the Job model first — that file is the behavioural spec for
time jobs — then add the new cases). Do NOT modify or delete `src/timer-scheduler.ts`.
**Interfaces — Produces:**
```ts
export interface SchedulerDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  isAlive(sessionId: string): boolean;
  sessionExists(sessionId: string): boolean;
  /** Runs only for limit-reset jobs, at fire time and again when a waiting job becomes deliverable. */
  preFire(job: Job): PreFireVerdict;
  /** Writes the message; the domain does normalisation, bracketing and joining. */
  deliver(job: Job): Promise<DeliveryResult>;
  onChange(): void;                       // persist + broadcast
  onFired(ev: FiredEvent): void;          // same FiredEvent shape as src/timer-scheduler.ts:32
  /** A limit-reset job reached `failed`; the monitor raises "needs you". */
  onJobFailed(job: Job, reason: string): void;
  verifyMs(): number;
  minDelayMs: number;
  minIntervalMs: number;
}
export type SetResult = { ok: true; job: Job } | { ok: false; error: string };
export interface ArmResumeInput {
  sessionId: string; episodeId: string; resetAt: number; marginMs: number;
  message: string; maxAttempts: number; proposed: boolean;
}
export class Scheduler {
  constructor(deps: SchedulerDeps);
  list(): Job[];
  load(jobs: readonly Job[]): void;
  set(input: TimedMessageInput): SetResult;              // time jobs; message via normalizeMessage (reject, never truncate)
  armResume(input: ArmResumeInput): SetResult;           // ≤1 live limit-reset job per session: updates it (resetAt/nextAt/episodeId) if present; never refused for caps (R7)
  accept(jobId: string): boolean;                        // proposed → armed
  cancel(jobId: string, reason: string): boolean;        // any non-terminal → cancelled
  cancelSession(sessionId: string, reason: string): void;
  resolveVerify(sessionId: string, outcome: { kind: 'resumed' } | { kind: 'limited'; resetAt: number }): void;
  renewSchedule(id: string): SetResult;                  // same semantics as TimerScheduler.renewSchedule
  sendNow(id: string): Promise<boolean>;                 // same semantics as TimerScheduler.sendNow
  sendOnce(sessionId: string, message: string): Promise<boolean>; // same as TimerScheduler.sendOnce
  history(sessionId: string): Job[];                     // all jobs for the session incl. terminal, newest first
  onPtyStart(sessionId: string): void;
  onSessionDisposed(sessionId: string): void;            // cancels its jobs, reason 'session closed'
  advanceClock(ms: number): void;
  evaluate(): void;
  stop(): void;
}
export function toTimedMessage(job: Job): TimedMessage | null; // legacy projection for timer:state; null for proposed/terminal-other-than-done
```
Consumes: contracts above; `TimedMessage, TimedMessageInput, MAX_PER_SESSION, MAX_TOTAL,
MIN_DELAY_MS, MIN_INTERVAL_MS, CATCHUP_MS, LATE_GRACE_MS, PTY_SETTLE_MS, resolveClockTime,
nextFireAt, newTimedMessageId` from `src/timed-messages.ts`; `normalizeMessage` from
`src/message-text.ts`; `FiredEvent` re-declared identically (copy the interface from
`src/timer-scheduler.ts:32-40`; the conductor deletes the old one at integration).
**State machine (limit-reset jobs):** `proposed` (never fires) · `armed` → at `nextAt`:
not alive → `waiting`; alive → `checking` → `preFire` → `{go:false}` → `skipped` (reason) ·
`{go:true}` → `sending` → `deliver` → `{ok:false}` → `failed` (reason, `onJobFailed`) ·
`{ok:true}` → attempts+1, history reason `'lines joined (no bracketed paste)'` when `joined`, →
`verifying` with a `verifyMs()` timer. `resolveVerify(resumed)` → `done`. `resolveVerify(limited)`
→ attempts ≥ maxAttempts ? `failed` 'still limited' (+`onJobFailed`) : `armed` at
`resetAt + marginMs`. Verify timer expiry → `failed` 'no response' (+`onJobFailed`). Fire after
`nextAt + LATE_GRACE_MS` → history reason includes `'late'`. A limit-reset job older than
`resetAt + 24 h` → `cancelled` 'expired'. Every transition appends `{at, state, reason?}`;
history keeps the last `JOB_HISTORY_MAX`. Time jobs: today's TimerScheduler semantics, never
`verifying`, never `preFire`. Caps (`MAX_PER_SESSION`, `MAX_TOTAL`) count only non-terminal
non-limit-reset jobs (R7).
**Steps:**
- [ ] Port timer-scheduler tests; add: 'limit-reset job ignores caps', 'second armResume updates the
  one live job', 'proposed never fires; accept arms', 'skips with preFire reason, writes nothing',
  'waiting until PTY start, preFire runs again', 'verifying → done on resumed', 're-arms on limited
  until maxAttempts then failed still limited', 'verify timeout → failed no response',
  'joined delivery recorded in history', 'overdue fires once flagged late', 'history capped at 20',
  'set rejects a 16001-char message with MESSAGE_TOO_LONG', 'keeps line breaks in time-job messages',
  'toTimedMessage projects a time job like TimerScheduler did'.
- [ ] Run `npx vitest run test/unit/scheduler.test.ts` — expect FAIL.
- [ ] Implement.

### Slice B: Delivery (lane B, Haiku)
**Check:** `npx vitest run test/unit/pty-writer.test.ts test/unit/output-quiet.test.ts test/unit/typing-guard.test.ts test/unit/timed-message-dialog.test.tsx` green; tsc; biome on touched files.

#### Task B.1: pty-writer bracketed + outputQuiet
**Files:** Modify `src/pty-writer.ts`; Test `test/unit/pty-writer.test.ts` (update).
**Interfaces — Produces:**
```ts
export interface SubmitOptions extends SubmitHooks { bracketed?: boolean }
export interface PtyWriterDeps {
  generation(sessionId: string): number | undefined;
  input(sessionId: string, data: string): boolean;
  sleep(ms: number): Promise<void>;
  /** Resolves once the session's output has been quiet for quietMs, or maxMs after the call. */
  outputQuiet(sessionId: string, quietMs: number, maxMs: number): Promise<void>;
}
export const ENTER_FLOOR_MS = 120;
export const ECHO_QUIET_MS = 300;
export const ECHO_MAX_MS = 5_000;
// PtyWriter.submit(sessionId: string, text: string, opts?: SubmitOptions): Promise<SubmitOutcome>
```
`gapMs` is removed from `PtyWriterDeps`. After the text write (and in `sequence`):
`await Promise.all([deps.sleep(ENTER_FLOOR_MS), deps.outputQuiet(id, ECHO_QUIET_MS, ECHO_MAX_MS)])`.
`bracketed: true` writes `ESC[200~` + text + `ESC[201~` as one `input` call. All generation /
hook checks keep their order.
**Call sites:** `server/runtime/typing.ts` (B.2), `src/conduit-mcp/host.ts` and domain callers
use `submit(id, text)` or `submit(id, text, hooks)` — still valid, no edit needed.
**Steps:** failing tests 'wraps a bracketed paste in one write', 'unbracketed writes the text as is',
'waits for outputQuiet and the 120 ms floor before Enter', 'sequence waits the same way',
'generation change during the quiet wait withholds Enter' → FAIL → implement.

#### Task B.2: output-quiet waiter + typing wiring
**Files:** Create `server/runtime/output-quiet.ts`; Modify `server/runtime/typing.ts`;
Test `test/unit/output-quiet.test.ts`; update `test/unit/typing-guard.test.ts` if it passes `gapMs`.
**Interfaces — Produces:**
```ts
export interface OutputQuietDeps {
  on(listener: (e: RuntimeEvent) => void): () => void;   // TerminalRuntime['on']
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}
export interface OutputQuiet {
  wait(sessionId: string, quietMs: number, maxMs: number): Promise<void>;
  dispose(): void;
}
export function createOutputQuiet(deps: OutputQuietDeps): OutputQuiet;
// typing.ts:
export function createTyping(
  runtime: Pick<TerminalRuntime, 'get' | 'input' | 'on'>,
  opts?: { sleep?: (ms: number) => Promise<void>; outputQuiet?: OutputQuiet },
): TypingPort;
```
Quiet = no `{type:'data'}` event for that session in the last `quietMs` (measured from the later of
the call and the last data event). `RuntimeEvent`/`TerminalRuntime` from
`src/contracts/terminal-runtime.ts`. `createTyping` no longer imports `SUBMIT_GAP_MS`.
**Call sites:** `server/runtime/index.ts` (`createTyping(runtime)` — `runtime` already has `on`;
no edit needed).
**Steps:** failing tests 'resolves after quietMs with no data', 'data pushes it out', 'resolves at
maxMs under constant output', 'other sessions' data is ignored', 'dispose unsubscribes' → implement.

#### Task B.3: interim textarea (spec §8–11)
**Files:** Modify `webview/components/timed-message-dialog.tsx` (and its stylesheet only if the
textarea needs a rule — use existing classes/tokens first); Test
`test/unit/timed-message-dialog.test.tsx` (create if absent, follow sibling `*.test.tsx` setup).
Behaviour exactly spec §8–11: multi-line `<textarea>` (Enter = newline, Ctrl/Cmd+Enter = Arm),
count `n / 16,000` under it in the existing hint style, over the limit: error colour, Arm disabled,
hint `MESSAGE_TOO_LONG`, announced via the existing hint's `aria-describedby`. Replace
`sanitizeMessage` uses with `normalizeMessage` from `src/message-text.ts`. No other UI change.
**Steps:** failing tests 'renders a textarea', 'Enter inserts a newline, Ctrl+Enter arms',
'shows n / 16,000', 'over the limit disables Arm and shows the hint' → implement.

### Slice C: Claude adapter (lane C, Haiku)
**Check:** `npx vitest run test/unit/claude-hook-settings.test.ts test/unit/claude-user-status-line.test.ts test/unit/claude-signals.test.ts test/unit/mcp-launch.test.ts test/unit/conduit-hook-client.test.ts test/unit/mcp-endpoint-hook.test.ts` green; tsc; biome.

#### Task C.1: settings JSON + user status line + launch wiring
**Files:** Create `src/claude-hook-settings.ts`, `src/claude-user-status-line.ts`; Modify
`src/mcp-launch.ts`; Tests `test/unit/claude-hook-settings.test.ts`,
`test/unit/claude-user-status-line.test.ts`, `test/unit/mcp-launch.test.ts` (update).
**Produces:**
```ts
// claude-user-status-line.ts
export interface StatusLineSetting { type: 'command'; command: string; padding?: number; refreshInterval?: number; hideVimModeIndicator?: boolean }
export function readUserStatusLine(i: { projectDir: string; configDir: string; readFile: (p: string) => string | null }): StatusLineSetting | null;
// precedence: <projectDir>/.claude/settings.local.json > <projectDir>/.claude/settings.json > <configDir>/settings.json;
// first file whose statusLine.type === 'command' with a non-empty string command wins; a command containing 'conduit-hook.cjs' is ignored.
// claude-hook-settings.ts
export function claudeHookSettings(i: { execPath: string; hookClient: string; userStatusLine: StatusLineSetting | null }): Record<string, unknown>;
// hooks: StopFailure [{matcher:'rate_limit', hooks:[cmd('hook StopFailure')]}], UserPromptSubmit [{hooks:[cmd('hook UserPromptSubmit')]}],
// Stop [{hooks:[cmd('hook Stop')]}], Notification [{matcher:'quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled', hooks:[cmd('hook Notification')]}];
// each cmd = {type:'command', command: `ELECTRON_RUN_AS_NODE=1 ${sq(execPath)} ${sq(hookClient)} hook <Event>`, timeout: 5};
// statusLine = {type:'command', command: `ELECTRON_RUN_AS_NODE=1 ${sq(execPath)} ${sq(hookClient)} statusline`, ...padding/refreshInterval/hideVimModeIndicator copied from userStatusLine when set};
// sq = POSIX single-quote ('…' with ' → '\''). Returns undefined-free plain JSON.
// mcp-launch.ts: mcpLaunchWiring input gains `claudeSettings: { file: string; json: string } | null`;
// for 'mcp-config-flag', args become ['--settings', file, '--mcp-config', configFile, '--allowedTools', CLAUDE_ALLOWED_TOOLS]
// when claudeSettings is set; result gains `settingsJson: string | null` (null for other adapters).
```
**Call sites of `mcpLaunchWiring`:** `src/conduit-mcp/host.ts:1905` — conductor updates it at
integration (passes `claudeSettings: null` until then is NOT acceptable as a lane edit; the lane
does not touch host.ts, so make the field optional: `claudeSettings?: …`).
**Steps:** failing tests per precedence case, quoting of a path with a space and a quote, matcher
strings exactly as above, statusLine copy of padding, args order with/without settings → implement.

#### Task C.2: payload → signals
**Files:** Create `src/claude-signals.ts`; Test `test/unit/claude-signals.test.ts` using
`test/fixtures/claude-hooks/*.json`.
**Produces:**
```ts
export function claudeSignalsFromHook(sessionId: string, event: HookEvent, payload: unknown, now: number): LimitSignal[];
```
Mapping: `StopFailure` with `error === 'rate_limit'` → `limited{source:'claude-hook', detail: error_details}`;
`UserPromptSubmit` → `resumed{by:'turn', source:'claude-hook'}`; `Stop` → `[]` (turn end is not a
resume); `Notification` `notification_type === 'quota_auto_resume_fired'` → `resumed{by:'cli-auto'}`;
`quota_auto_resume_stale|disabled` → `auto-resume-unavailable`; `StatusLine` with `rate_limits` →
`reset-info{source:'claude-statusline', windows:[{name:'five_hour'|'seven_day'|…, usedPct:
used_percentage, resetAt: resets_at*1000}]}` (windows with a numeric `resets_at` only; none → `[]`).
Anything malformed → `[]` (never throws).

#### Task C.3: hook client + statusline wrapper
**Files:** Create `resources/conduit-mcp/conduit-hook.cjs`; Test `test/unit/conduit-hook-client.test.ts`
(spawn the script with `process.execPath`, a temp unix-socket/pipe server from
`test/helpers/line-socket.ts` or `test/helpers/test-endpoint.ts`; read those helpers first).
Dependency-free CommonJS like `resources/conduit-mcp/conduit-mcp-shim.cjs` (read it for env names
`CONDUIT_SESSION_TOKEN`, `CONDUIT_MCP_ENDPOINT` and connection code).
Behaviour:
- `hook <Event>`: read stdin (≤ `HOOK_POST_MAX_BYTES`, 2 s cap); no token or endpoint → exit 0 at
  once; else connect, write one `HookPost` line, wait for the ack line or 1.5 s total, exit 0.
  **Never writes to stdout or stderr** (Claude treats hook stdout as context). Always exit 0.
- `statusline`: read stdin JSON; in parallel (a) if `rate_limits` present, post
  `{event:'StatusLine', payload:{rate_limits}}` with a 300 ms budget, (b) resolve the user's status
  line with the same precedence as `readUserStatusLine` (projectDir = `workspace.project_dir` ||
  `cwd`; configDir = `CLAUDE_CONFIG_DIR` || `~/.claude`), run it through the POSIX shell Claude
  uses (`statusLineShell`: win32 → `CLAUDE_CODE_GIT_BASH_PATH` || `bash` `-c`; else `/bin/sh -c`;
  never cmd.exe — corrected after review), stdin = the same JSON, 5 s timeout; print its stdout unchanged. No user command
  → print nothing. Server unreachable → still prints the user's output. Exit 0 always.
**Steps:** failing tests 'hook posts one line and exits 0', 'no token exits 0 without connecting',
'unreachable endpoint exits 0 within 2 s', 'hook prints nothing', 'statusline prints the user
command output unchanged', 'statusline prints user output when the server is unreachable, within
1 s', 'statusline forwards rate_limits', 'statusline ignores a conduit-hook.cjs user command' → implement.

#### Task C.4: endpoint accepts HookPost
**Files:** Modify `server/mcp/endpoint.ts`; Test `test/unit/mcp-endpoint-hook.test.ts` (read the
existing endpoint test file — find it with `grep -l createShimEndpoint test/unit` — and mirror its setup).
**Produces:** `createShimEndpoint` opts gain `onHook?: (sessionId: string, post: HookPost) => void`.
A first line that parses as an object with `conduitHook === 1` is a hook post: resolve `token`
the same way the hello path does (`welcomeFor`); known token → call `onHook`, write
`{"conduitHook":1,"ok":true}\n`, close; unknown/draining → `ok:false`, close, log at debug. Line
over `HOOK_POST_MAX_BYTES` → close. The C6 hello path is unchanged (frozen contract).
**Steps:** failing tests 'known token → onHook + ok ack', 'unknown token → ok:false, no onHook',
'oversized line closes', 'a normal C6 hello still works' → implement.

### Slice D: Codex adapter + rules (lane D, Haiku)
**Check:** `npx vitest run test/unit/reset-time.test.ts test/unit/limit-rules.test.ts test/unit/cli-stuck-screens.test.ts test/unit/codex-rollout.test.ts test/unit/codex-rollout-watch.test.ts test/unit/limit-rules-file.test.ts` green (the existing `cli-stuck-screens.test.ts` cases pass **unchanged**); tsc; biome.

#### Task D.1: reset-time parsing
**Files:** Create `src/reset-time.ts`; Test `test/unit/reset-time.test.ts`.
**Produces:** `export function parseResetText(text: string, format: ResetFormat, now: number): number | null;`
`clock`: `3pm`, `3:45 PM`, `23:10`, optional `(Area/City)` IANA zone → next occurrence via
`resolveClockTime` from `src/timed-messages.ts`. `clock-or-date`: also `Nov 18, 3pm`,
`Nov 18th, 2026 3:45 PM`, `November 18 at 3pm` (year defaults to the next occurrence ≥ now − 1 day).
`countdown`: `4h 59m`, `59m`, `2 hours`, `4:59` (h:mm) → now + duration. Result > now + 8 days or
< now − 1 day → null. Port the positive/negative cases from `test/unit/limit-notice.test.ts`
(`parseResetClock`) — including "a leading log stamp is not the reset time" — and spec §2 table rows
("resets Nov 18, 3pm" must resolve to Nov 18).

#### Task D.2: rule set
**Files:** Create `src/limit-rules.ts`; Modify `src/cli-stuck-screens.ts`; Tests
`test/unit/limit-rules.test.ts`, `test/unit/cli-stuck-screens.test.ts` (add cases; keep existing unchanged).
**Produces:**
```ts
export const DEFAULT_LIMIT_RULES: readonly LimitRule[];
export function parseLimitRulesFile(blob: string): { rules: LimitRule[]; invalid: { id: string; error: string }[] };
export function compileLimitRules(rules: readonly LimitRule[]): CompiledRules;   // opaque; invalid regex / >500 chars / missing named group → excluded and reported
export interface CompiledRules { rules: readonly LimitRule[]; invalid: { id: string; error: string }[] }
export function matchLimitRules(compiled: CompiledRules, cli: CliKind, rows: readonly string[], now: number): RuleMatch | null;
// cli-stuck-screens.ts:
export function detectStuckScreen(cli: CliKind, rows: readonly string[], rules?: CompiledRules): StuckScreen | null; // default = compileLimitRules(DEFAULT_LIMIT_RULES), compiled once
```
Matching: last `RULE_SCAN_ROWS` non-empty rows joined by `\n`, flags `mi`; rules in array order,
first enabled match for `cli` or `'*'` wins (so blocking prompts precede usage lines, preserving
today's precedence). `reason` = rule.reason with `{reset}` → reset group text (no group → literal
reason); `resetAt` via `parseResetText`. `detectStuckScreen` returns `{kind, reason}` of the first
match that has a `kind`. Defaults = today's patterns from `src/cli-stuck-screens.ts:15-27` (two-
regex prompts become one `[\s\S]*` regex), the Codex `try again at` rule with format
`clock-or-date`, and a Claude `resets <time>` rule equivalent to today's `scanLimitNotice` anchors
(limit word + hit/reached/exceeded/usage + resets) with format `clock-or-date`; every default with
an id `default:<cli>:<name>`. File shape: `{version: 1, rules: LimitRule[]}`.
**Steps:** failing tests: every existing cli-stuck-screens case; 'Codex ■ limit line with try again
at 3:45 PM resolves resetAt' (the spec §2 "never arms" row); 'Claude notice with 3 lines under it is
found' (the TAIL_LINES row); 'invalid regex disabled, others load'; 'pattern over 500 chars
rejected'; 'missing named group rejected'; 'disabled rule ignored'; 'only the last 25 non-empty
rows are read' → implement.

#### Task D.3: Codex rollout pure helpers
**Files:** Create `src/codex-rollout.ts`; Test `test/unit/codex-rollout.test.ts` using
`test/fixtures/codex-rollout/*.jsonl`.
**Produces:**
```ts
export interface RolloutMeta { id: string; cwd: string; timestamp: number; isSubThread: boolean }
export function parseRolloutMeta(firstLine: string): RolloutMeta | null;
export function bindsTo(meta: RolloutMeta, s: { cwd: string; launchAt: number }, samePath: (a: string, b: string) => boolean): boolean;
// cwd equal via samePath; !isSubThread (parent_thread_id present OR source is an object with key 'subagent');
// meta.timestamp >= launchAt - 5000.
export function rolloutSignals(sessionId: string, line: string, episodeOpen: boolean, now: number): LimitSignal[];
// task_complete|turn_complete with error.codex_error_info === 'usage_limit_exceeded' → limited{source:'codex-rollout'};
// token_count: rate_limits → reset-info (primary/secondary with numeric resets_at → resetAt*1000, usedPct used_percent,
//   name 'primary'|'secondary'); rate_limit_reached_type non-null → also limited;
// task_started|turn_started with episodeOpen → resumed{by:'turn'}. Malformed → [].
export class LineSplitter { push(chunk: string): string[] }   // returns complete lines, keeps a partial tail
```

#### Task D.4: rollout watcher
**Files:** Create `server/domain/codex-rollout-watch.ts`; Test `test/unit/codex-rollout-watch.test.ts`
(temp dirs via `test/helpers/temp-roots.ts`; inject a fake `watchDir` and `readFile`/`open`).
**Produces:**
```ts
export interface CodexWatchDeps {
  sessionsRoot: string;                      // ~/.codex/sessions (CODEX_HOME/sessions when set)
  now(): number;
  localDate(ms: number): { y: number; m: number; d: number };
  watchDir: typeof import('../../electron/watch-dir').watchDir;
  fs: { readdir(p: string): Promise<string[]>; readFirstLine(p: string): Promise<string | null>; readFrom(p: string, offset: number): Promise<{ data: string; size: number }>; exists(p: string): Promise<boolean> };
  samePath(a: string, b: string): boolean;
  episodeOpen(sessionId: string): boolean;
  onSignal(s: LimitSignal): void;
  log: { debug(msg: string, data?: object): void; warn(msg: string, data?: object): void };
}
export interface CodexWatch {
  track(sessionId: string, s: { cwd: string; launchAt: number }): void;
  untrack(sessionId: string): void;
  boundFile(sessionId: string): string | null;
  dispose(): void;
}
export function createCodexRolloutWatch(deps: CodexWatchDeps): CodexWatch;
```
Rules (spike D2/D3): while any session is unbound, watch `sessionsRoot/YYYY/MM/DD` for the launch's
local date and the next day's (use `watchDirWhilePresent` from `electron/watch-dir.ts` if it fits,
else poll existence every 2 s); on a new `rollout-*.jsonl`, read its first line; bind when
`bindsTo` holds for exactly one unbound session; two qualify → bind neither for that file and
`log.warn`. Bound: `watchDir` the bound file's directory (one watch per directory, shared),
debounce 250 ms, `readFrom(lastOffset)`, feed `LineSplitter`, emit `rolloutSignals` (offset starts
at 0 — a late bind replays the file's lines so a limit before binding still arrives; the monitor
de-duplicates by episode). `untrack` releases watches with no remaining users. Never watch the
whole tree. `dispose` closes all.

#### Task D.5: rules file
**Files:** Create `server/domain/limit-rules-file.ts`; Test `test/unit/limit-rules-file.test.ts`.
**Produces:**
```ts
export interface LimitRulesSource { current(): CompiledRules; dispose(): void }
export function createLimitRulesSource(deps: {
  userData: string;
  watchDir: typeof import('../../electron/watch-dir').watchDir;
  fs: { read(p: string): string | null; writeAtomic(p: string, data: string): void };
  onChange(): void;
  log: { info(msg: string, data?: object): void; warn(msg: string, data?: object): void };
}): LimitRulesSource;
```
Missing file → write `{version:1, rules: DEFAULT_LIMIT_RULES}` once. Corrupt JSON / foreign version
→ defaults in memory + one `warn`, file untouched. Invalid rules → excluded + one `warn` each.
`watchDir(userData)` filtered to `limit-rules.json`, debounced 250 ms → reload → `onChange`.

### Slice E: integration (conductor, serial, after lanes merge one at a time)
**Check:** `npm run verify` exit 0 on the merged tree.
E.1 settings: `autoResume`/`autoResumeMarginMs`/`autoResumeMaxAttempts`/`autoResumeMessage`/
`autoResumeVerifyMs` in `src/settings.ts` (+coerce with ranges, migrate `autoResumeOnLimit`
arm→on, offer→ask, off→off), `SERVER_SETTINGS_KEYS`, settings-modal select re-pointed (same labels).
E.2 session override: `Session.autoResume?: 'on'|'off'`, persistence coercion, `setAutoResume`,
`SessionStorePort`.
E.3 attention `setResumeIssue(id, reason|null)` (+ statusOf precedence) and `AttentionPort`.
E.4 `server/domain/limit-monitor.ts` + `test/unit/limit-monitor.test.ts`: episodes (R1, expiry
24 h), merge of signals (structured beats rule; resetAt from newest reset-info: window ≥100 % else
soonest within 8 days; weekly vs 5-hour → later), mode (R8, per-session wins), offer/suppression
(30 min), pre-fire (R4: episode closed / busy / resumed), verify mapping (resumed → resolveVerify
resumed; limited during verifying → resolveVerify limited), needs-you reasons ('limit reached,
reset time unknown', 'still limited', 'no response'), rules scan (R6: trailing-edge 1/s,
`runtime.screen`, rule-only resumed after 2 non-matching scans), late Codex bind de-dup.
E.5 domain: Scheduler replaces TimerScheduler; store load/migrate/persist; R2 move; R1
`endEpisode` change; deliver with normalize + `deliverableText` + `bracketed`; timers.* handlers on
the Scheduler; `scheduler.setSessionAutoResume`/`scheduler.history`; timersState gains
jobs/episodes; busy-edge from attention `onChange`; `humanInput` from services `term.input`;
host.ts: write the `--settings` file beside the MCP config, pass `claudeSettings`, `onHook` →
monitor, `detectStuckScreen(cli, rows, rules.current())`; codex watch track/untrack on spawn/exit.
E.6 delete `src/timer-scheduler.ts`, `src/limit-notice.ts`, their tests; trim `src/timed-messages.ts`.
E.7 e2e: the nine §7 scenarios as `test/e2e/auto-resume-*.e2e.mjs` with
`test/e2e/fixtures/fake-claude-hooks.mjs` (fake `claude` invoking the configured hook commands with
recorded payloads, R11); fix `timed-message-dialog-ui.e2e.mjs` for the textarea.
E.8 `CHANGELOG.md` Unreleased; report.

## Verification
Per task: executor runs its slice's vitest files + tsc + biome. Per lane: conductor re-runs those
files in the lane worktree, then `code-review` (non-author) against this plan + spec. Merge one
lane at a time into `CON-11-scheduler-and-auto-resume`, then `npm run verify` (exit code captured
directly, no concurrent agents). After E: `npm run e2e:remote` (affected, then `--full`).

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never
a shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. An executor that hits this reports to the conductor with the fix that keeps the
locked decision, and does not edit outside its `Files:`.

## Amendments after review (conductor, 2026-11-14)
- B: map widened by two construction-site test edits (conduit-mcp-host.test.ts, server-runtime-spawn.test.ts); dialog count over the limit shows the raw length.
- A: `parseSchedulerFile(blob, { maxAttempts })` clamps (no `now`); `serializeSchedulerFile(file, now)`; limit deliveries emit `onFired`; `toTimedMessage` maps limit jobs (proposed/skipped/failed/cancelled → null; in-flight/done → done, firedCount 1); `sendOnce` propagates a rejected deliver; R13 `recheck(jobId)` and `{go:'wait'}`.
- C: the user's status line runs through `statusLineShell(platform, env, command)` (win32 → Git Bash `bash -c`; else `/bin/sh -c`), never cmd.exe; the TS and .cjs precedence share one case table at `test/helpers/claude-status-line-cases.ts`; the endpoint keeps the 64 KiB cap for any first line that has not shown the `{"conduitHook"` prefix within 64 KiB.
- D: `src/timed-messages.ts` exports `wallTimeToInstant` and `wallDateIn` (wrappers over the existing private zone helpers); `limit-rules.ts` exports `matchStuckRule(compiled, cli, rows)` for `detectStuckScreen`; rules take the LAST match on screen; the Codex reset group also accepts an optional IANA zone suffix; `parseLimitRulesFile` returns `version: 'read' | 'newer'` and throws on corrupt or unusable files.

## Decisions Needed
- [normal] `SignalSource` gains `'attention'` and `'human-input'` (R3/R4 name them) — default taken: add.
- [normal] Hook command uses a POSIX `VAR=1 cmd` prefix on Windows too (Claude runs hooks via Git
  Bash) — default taken; the remote Windows e2e decides, conductor fixes if it fails.
- [normal] Terminal limit jobs retained 24 h, ≤10 per session, for `scheduler.history` — default taken.
