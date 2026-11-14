# Request queue machinery (CON-21) — implementation plan

**Spec:** `docs/specs/archive/2026-11-14-user-input-requests.md` (v4.5)  **Tier:** FULL
**Gate evidence:** `docs/runs/2026-11-14-CON-21/osc7501.md` (REQ-D9, measured)

## Goal
Build the server-side request object, its store, lifecycle and the four agent tools. Feed it from
the scheduler, prose questions and observed prompts. Add defaults at expiry and Away, and keep
no-window asks alive for their full budget. Every request reaches the renderer through `mcp:state`,
so CON-20 can draw it. No UI ships here.

## Architecture
Requests live in the conduit-mcp host (server process), beside the message store. The tools
dispatch there, and the session directory, inbox and attention port are already there. Pure logic
sits in flat `src/conduit-mcp/request-*.ts` modules, as `store.ts` and `session-waits.ts` do: queue
state machine, arg/answer validation, file format, waiters and the source reconciler. One composer,
`request-service.ts`, owns their wiring. `host.ts` only constructs it and routes calls, events and
renderer messages to it, which keeps the shared `host.ts` claim thin. Persistence is one JSON file
(`<userData>/conduit-mcp/requests.json`), written atomically and coalesced, like `scheduler.json`.

## Data flow
```
agent CLI ──tools/call──> host.callTool ──(group 'requests')──> requestService.tools.*
                                                              │ create/attach/replace (caps, dedupe)
ServerAttention ─onChange─> host ─> requestService.onAttention ┤ reconcile observed + scheduler
message store ─onChange──> host ─> requestService.onStore ─────┤ reconcile message (kind question → you)
renderer mcp:requestAnswer / mcp:setAway ─> host.handleRenderer ┤ answer (first wins) / presence
                                                              v
                                  request-queue (state, timers: expiry→default|expired)
                                     │ persist (coalesced) → conduit-mcp/requests.json
                                     │ end event
                 ┌───────────────────┼─────────────────────────────┬──────────────────────┐
                 v                   v                             v                      v
         request-waits         inbox delivery              scheduler action        host.scheduleBroadcast
   (a waiting call returns)  (store.append from 'you',    (deps.limit.resumeNow /    → mcp:state {requests,
                              request_id, when no call     dismissIssue)               presence} → app → renderer
                              was waiting)                                           → tray-channel (counts)   
```

## Settled decisions — do not re-litigate
- REQ-D1 = C (one queue). REQ-D15 = defaults only for agent kinds, never `permission`, `attend` or `cli-prompt`. REQ-D20 = `question` only. REQ-D21 = (a) one human, (b) remote read-only (nothing to build: no links), (c) wait the full budget, plus the tray and an OS notification.
- Design defaults kept: REQ-D3 (tool family names), D5 (`wait_s` = budget − 10 s), D7 (no approve-all), D8 (caps §4.6), D10 (no secret kind), D16 (Away explicit), D17 (presence in `list_sessions`).
- Owner, 2026-11-14: always-on free text for `confirm`/`choose`; Skip = `dismissed`; `space`/`lead`/`machine` are stamped at creation.
- Lead brief: no UI; `permission` conversion is out (today's approval card keeps working); no lead escalation; nothing cross-machine; `attend` only on what REQ-D9 measured.
- REQ-D9 measured: Claude Code reports `blocked` for permission and question, and OpenCode for permission. `attend` = OSC 7501 `blocked` only, for any reporting program. No screen patterns.

## Spec staleness
- §2 "With no app window connected, waiting asks are denied 5 s after the last app disconnects": true (`server/mcp/index.ts:41,320-327`). But **a new ask cannot start with no ready window at all**: the gate returns `window_not_ready` (`src/conduit-mcp/tool-policy.ts:428-430`). Every default ask tool is also `when: 'viewing'` (`tool-policy.ts:139-181`), which needs the session on screen. So the §9 scenario "no window open, a tool whose policy is ask, not denied before its budget" only holds for a policy with `when: 'always'`, or for an ask already waiting when the app goes away. Plan: implement exactly that (Slice 5), and report it as Decisions Needed #1.
- An ask can be answered only from the window it was sent to (`src/conduit-mcp/window-waits.ts:83-88`), and a reconnecting app gets new window ids. **Corrected during the build:** re-homing already exists. `answeringWindow` (`server/mcp/index.ts`, F7 step 4) maps the reconnected owner window's answer onto the old bound window, and `pendingAsks`/`approvals.changed` re-send the cards. So Slice 5 only removes the grace deny and binds a no-app `when: always` ask to `NO_OWNER_WINDOW` (0), which the same remap answers.
- §4.3 "a waiting ask stays in the tray and raises an OS notification": with no app, the only OS surface is the Windows tray helper (`native/tray`). It has no notification message today, and there is no tray helper on Linux. Lead ruling: no app-closed OS notification on this card (see Left for later); the tray count still shows it.
- §2 "The tray shows N running, M need you": M counts only `needsAttention` sessions (`src/tray-counts.ts:8-15`), not stuck screens, resume issues, asks or messages. Plan: M = open requests to you + waiting asks + needs-you sessions not already covered by an open `attend` or `scheduler` request (Slice 5).
- §4.1 `machine` "the origin machine id": no machine id exists in the codebase. NET says it derives from a server key that doesn't exist yet. Plan: `m-` + 8 random hex, persisted in `conduit-mcp/machine-id.json` (Decisions Needed #4).
- §4.1 `space`: sessions have no `space` field. A space is the project (`src/conduit-mcp/tool-schemas.ts:27-28`). Plan: `space` = `Session.projectId ?? null`.
- §4.10/F5 scheduler: there is no "try again at reset" or "resume now" action for a limit episode (`src/scheduler.ts:386-388`; `answerOffer` only acts on proposed jobs). CON-15 isn't built. Plan: two options, `Resume now` and `Turn auto-resume on`, plus Skip (Decisions Needed #2).
- §4.5 "a keystroke ends Away in any window": the server only sees terminal keystrokes (`term.input`). Plan: terminal input and an explicit `mcp:setAway` end Away. CON-20 sends `mcp:setAway {away:false}` for other window input.

## Global constraints
- Gate: `npm run verify` on every merged tree, exit code captured directly (`npm run verify; echo "exit=$?"`). Never through a pipe. Inner loop: `npm run verify:quick`.
- Unit tests: `test/unit/<kebab-name>.test.ts`, vitest, `environment: node`. Run one file with `npx vitest run test/unit/<file>`.
- Naming: kebab-case files; `camelCase` functions; `PascalCase` types; `SCREAMING_SNAKE` constants. Tool args and outputs are **snake_case** on the wire (`request_id`, `wait_s`, `thread_id`). Internal records are camelCase.
- `src/conduit-mcp/request-types.ts` and anything the renderer imports stay **Node-free** (type-only imports from `./types`).
- Comments explain WHY, never what. A pointer like `// see spec 2026-11-14-user-input-requests §4.3` is preferred over a re-explanation.
- No `as any`, no `@ts-ignore`, no swallowed errors (log through `deps.warn`), no `!important`.
- Git only via `runGitBin`, directories watched only via `watchDir` (neither should be needed here).
- Unit tests never rely on win32 behaviour. Use injected clocks and timers, never real `setTimeout` waits.
- Every user-facing change gets a `CHANGELOG.md` line, under Unreleased.
- Commits: `git -c user.name="$(git log main -1 --format=%an)" -c user.email="$(git log main -1 --format=%ae)" commit`. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- **Apps tested on this machine stay hidden**: any Electron/browser launched for testing uses `--ozone-platform=headless` (the e2e harness does so on Linux). Otherwise don't launch.
- Haiku lanes write code and unit tests only. They never run e2e, never merge, never touch files outside their task's `Files:`.

## Out of scope
UI of any kind (panel, pop-up, tab, pill, waiting notice, digest view); `permission` requests (the approval card stays as is); `form`; `to: lead`, `answer_request`, `escalate_request`; `cli-prompt`; cross-machine anything; screen-pattern prompt detection; OS-notification quick actions (REQ-D11); POL Activity rows.

## Contracts

### C1 Wire types — `src/conduit-mcp/request-types.ts` (written by the orchestrator in T1.0, frozen after)
```ts
import type { Handle } from './types';

export type RequestSource = 'agent' | 'message' | 'observed' | 'scheduler';
export type AgentRequestKind = 'confirm' | 'choose' | 'text' | 'review';
export type RequestKind = AgentRequestKind | 'attend';
export type RequestState =
  | 'open' | 'answered' | 'expired' | 'withdrawn' | 'superseded' | 'resolved' | 'orphaned';
export type RequestOutcome = 'approved' | 'declined' | 'answered' | 'chosen' | 'edited' | 'dismissed';
export type RequestPriority = 'normal' | 'urgent';
export type BlockedKind = 'permission' | 'question' | 'auth' | null;

export interface RequestOption { label: string; description?: string }

/** What a human (or a default) submits; validated per kind by validateAnswer. */
export interface AnswerInput {
  outcome: RequestOutcome;
  text?: string;      // ≤ 8 KB; for review 'edited' ≤ 32 KB (the edited draft)
  values?: string[];  // choose 'chosen': option labels
  reason?: string;    // ≤ 500 chars; 'declined' only
}
export type AnsweredBy = { kind: 'you'; windowId: number | null } | { kind: 'default' };
export interface RequestAnswer extends AnswerInput { answeredBy: AnsweredBy; at: string }

export interface RequestRecord {
  id: string;                    // 'r_' + 12 base36
  origin: string;                // machine id, 'm-xxxxxxxx'
  source: RequestSource;
  kind: RequestKind;
  requester: Handle | 'conduit';
  session: string | null;        // the session it concerns
  space: string | null;          // Session.projectId at creation
  lead: string | null;           // root sessionId of the openedBy chain (self when unopened)
  machine: string;               // same as origin in MVP
  title: string;                 // ≤ 200 chars
  body: string;                  // ≤ 8 KB
  options: RequestOption[];      // choose: 2–8; scheduler: fixed; else []
  multi: boolean;                // choose: more than one value allowed
  draft: string | null;          // review: ≤ 32 KB
  thread: string | null;         // thread id
  messageId: string | null;      // source 'message': the question message
  blocked: BlockedKind;          // source 'observed': the reported kind
  priority: RequestPriority;
  createdAt: string;             // ISO UTC, origin clock
  expiresAt: string | null;      // resolved from expires_in at creation
  default: AnswerInput | null;   // requires expiresAt; agent kinds only
  contentKey: string;            // dedupe key (see C3); '' for non-agent sources
  state: RequestState;
  endedAt: string | null;
  answer: RequestAnswer | null;
  withdrawnBy: 'requester' | 'conduit' | null;
  withdrawReason: string | null;
  supersededBy: string | null;
  deliveredAt: string | null;    // inbox delivery of a late end (agent source)
}

/** The renderer's view: the record plus live, unpersisted facts. */
export interface RequestView extends RequestRecord { waiting: boolean }

export interface HumanPresence {
  state: 'here' | 'away';
  since: string;                 // ISO UTC of the last change
  until: string | null;          // away until (null = until I'm back)
  lastAway: { from: string; to: string } | null; // the last finished Away period, for the digest
}

export interface RequestsUiState {
  open: RequestView[];           // every open request, any source
  ended: RequestView[];          // newest 200 ended, by endedAt desc
  presence: HumanPresence;
}

export type RequestAnswerResult =
  | { ok: true; request: RequestView }
  | { ok: false; reason: 'not_found' | 'already_ended' | 'not_answerable' | 'invalid_answer';
      message: string; request: RequestView | null };

/** Tool outputs (snake_case wire). */
export type RequestCallOutput =
  | { state: 'answered'; request_id: string; answer: RequestAnswerOut }
  | { state: 'open'; request_id: string; clamped_to?: number }
  | { state: Exclude<RequestState, 'open' | 'answered'>; request_id: string; reason?: string };
export interface RequestAnswerOut {
  outcome: RequestOutcome; text?: string; values?: string[]; reason?: string;
  answered_by: 'you' | 'default'; at: string;
}
export interface ListRequestsOutput {
  requests: Array<{ request_id: string; kind: RequestKind; title: string; state: RequestState;
    created_at: string; expires_at: string | null; waiting: boolean;
    answer: RequestAnswerOut | null }>;
}
```

### C2 Limits — `src/conduit-mcp/request-args.ts` exports these constants
`TITLE_MAX = 200` · `BODY_MAX_BYTES = 8192` · `DRAFT_MAX_BYTES = 32768` · `TEXT_MAX_BYTES = 8192` · `REASON_MAX = 500` · `OPTIONS_MIN = 2` · `OPTIONS_MAX = 8` · `OPTION_LABEL_MAX = 100` · `OPTION_DESC_MAX = 300` · `EXPIRES_MAX_MS = 7 * 86_400_000` · `WITHDRAW_REASON_MAX = 200`.
Caps (`request-queue.ts`): `CAP_OPEN_PER_REQUESTER = 5` · `CAP_URGENT_PER_10MIN = 1` · `CAP_CREATED_PER_HOUR = 20` · `CAP_OPEN_PER_SERVER = 50` · `HISTORY_MS = 30 * 86_400_000` · `ENDED_IN_UI = 200`.
Waits (`request-waits.ts`): `REQUEST_WAIT_MARGIN_MS = 10_000` (default wait = budget − 10 s), `REQUEST_REPLY_MARGIN_MS = 5_000` (an explicit `wait_s` is clamped to budget − 5 s, reported as `clamped_to`), `REQUEST_WAITS_PER_CALLER = 4`.

### C3 `request-args.ts` (pure)
```ts
export interface CreateInput {
  kind: AgentRequestKind; title: string; body: string; options: RequestOption[]; multi: boolean;
  draft: string | null; thread: string | null; priority: RequestPriority;
  expiresInMs: number | null; default: AnswerInput | null; replaces: string | null;
  waitS: number | null;                       // null = default (budget − 10 s)
}
export function parseRequestInput(raw: unknown): Result<CreateInput>;
export function parseWaitRequest(raw: unknown): Result<{ requestId: string; waitS: number | null }>;
export function parseWithdrawRequest(raw: unknown): Result<{ requestId: string; reason: string | null }>;
export function parseListRequests(raw: unknown): Result<{ state: 'open' | 'all'; limit: number }>; // limit 1..100, default 50
export function parseExpiresIn(s: string): number | null;  // /^(\d+)(s|m|h|d)$/ → ms; null if bad or > EXPIRES_MAX_MS or 0
export function validateAnswer(
  r: Pick<RequestRecord, 'kind' | 'source' | 'options' | 'multi'>, a: unknown,
): Result<AnswerInput>;
export function contentKeyOf(i: CreateInput): string;      // stable JSON of every field except replaces and waitS
```
Errors: any wrong type/unknown key/missing field → `invalid_args`; any size over a limit → `too_large`. A `default` without `expires_in` → `invalid_args` "a default needs expires_in" (spec §5). `options` given for a non-choose kind → `invalid_args`. Review without `draft` → `invalid_args`.
`validateAnswer` matrix (anything else → `invalid_args`):
| kind / source | allowed outcomes and payload |
|---|---|
| `confirm` | `approved` {text?} · `declined` {reason?, text?} · `answered` {text required} · `dismissed` |
| `choose` (agent or scheduler) | `chosen` {values: ≥1 labels of `options`; exactly 1 unless `multi`; text?} · `answered` {text required} (agent only) · `dismissed` |
| `text` (agent or message) | `answered` {text required} · `dismissed` |
| `review` | `approved` {} · `edited` {text required, ≤ 32 KB} · `declined` {reason?} · `dismissed` |
| `attend` | nothing: `not_answerable` (returned by the queue, not here) |
A `default` is validated with the same matrix, except that `dismissed` is not allowed as a default.

### C4 `request-queue.ts` (pure; injected clock + timers)
```ts
export interface QueueDeps {
  now(): number; newId(): string; machineId: string;
  setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void;
  onEnded(r: RequestRecord): void;     // after any transition to an end state
  onChanged(): void;                   // any mutation (persist + broadcast)
}
export interface Stamp { requester: Handle | 'conduit'; session: string | null; space: string | null; lead: string | null }
export type CreateOutcome =
  | { kind: 'created'; request: RequestRecord }
  | { kind: 'attached'; request: RequestRecord }        // dedupe hit (same session, contentKey, open)
  | { kind: 'refused'; error: ToolError };
export interface RequestQueue {
  load(records: RequestRecord[]): void;   // arms expiry timers; ends overdue ones; resolves open observed/scheduler (reason 'restart'); purges ended > HISTORY_MS
  createAgent(stamp: Stamp, input: CreateInput): CreateOutcome;   // caps, dedupe, replaces → old 'superseded'
  createSystem(stamp: Stamp, fields: Pick<RequestRecord, 'source' | 'kind' | 'title' | 'body' | 'options' | 'thread' | 'messageId' | 'blocked' | 'priority'>): RequestRecord;
  answer(id: string, input: unknown, by: AnsweredBy): RequestAnswerResult;   // first wins; validates via validateAnswer; waiting computed by caller
  withdraw(id: string, by: 'requester' | 'conduit', reason: string | null): RequestRecord | null;
  resolve(id: string): RequestRecord | null;    // observed/scheduler/message condition cleared
  orphanSession(sessionId: string): RequestRecord[];  // open requests of a deleted requester session
  markDelivered(id: string): void;
  get(id: string): RequestRecord | undefined;
  open(): RequestRecord[];                      // createdAt asc
  ended(limit: number): RequestRecord[];        // endedAt desc
  bySession(sessionId: string, state: 'open' | 'all', limit: number): RequestRecord[];
  purge(): number;                              // drop ended older than HISTORY_MS
  records(): RequestRecord[];                   // for persistence
  dispose(): void;
}
```
Invariants: an end state is terminal (any later answer → `already_ended`). Expiry with a default → `answered` with `answeredBy {kind:'default'}`. Expiry without one → `expired`. `replaces` must name an open request of the **same session**, else `not_found`. Caps count only `source ∈ {agent, message}`. A dedupe hit never counts toward a cap, and an `urgent` dedupe hit doesn't spend the urgent token. Cap errors are `rate_limited` with a hint naming the cap ("you have 5 open requests; withdraw one or wait"). `orphanSession` sets `orphaned` only on open requests whose `session` is the deleted one.

### C5 `request-file.ts` (pure) + `request-file-fs.ts` (Node)
```ts
export interface RequestsFile { version: 1; requests: RequestRecord[]; presence: HumanPresence }
export function parseRequestsFile(text: string | null, now: number):
  { kind: 'ok' | 'empty' | 'corrupt' | 'newer'; file: RequestsFile };   // 'newer' via judgePersistedVersion('conduit-mcp/requests.json', v)
export function serializeRequestsFile(f: RequestsFile): string;
export function emptyPresence(now: number): HumanPresence;           // {state:'here', since, until:null, lastAway:null}
// request-file-fs.ts
export interface RequestsIo { read(): string | null; write(text: string): Promise<void> }
export function createRequestsIo(file: string): RequestsIo;          // atomicWriteFile from src/atomic-write.ts
```
`newer` → the service runs with an empty queue and never writes (warns once), as the scheduler does. `corrupt` → empty, and the next write replaces it. Records failing shape validation are dropped one by one, with a warn.

### C6 `request-waits.ts` (pure)
```ts
export type WaitEnd = { kind: 'ended' } | { kind: 'timeout' } | { kind: 'cancelled' };
export interface RequestWaits {
  open(w: { requestId: string; sessionId: string; key: CallKey; timeoutMs: number }): Promise<WaitEnd>;
  ended(requestId: string): void;          // resolves every wait on it with 'ended'
  cancel(match: (w: { sessionId: string; key: CallKey }) => boolean): void;   // → 'cancelled'
  isWaiting(requestId: string): boolean;
  countFor(sessionId: string): number;
  dispose(): void;                          // → 'cancelled'
}
export function createRequestWaits(deps: { setTimer; clearTimer; onWaitingChanged(): void }): RequestWaits;
export function requestWaitMs(waitS: number | null, budgetMs: number): { ms: number; clampedTo?: number };
```
`CallKey` is imported from `./window-waits`. `requestWaitMs(null, b)` = `max(0, b − 10_000)`. `requestWaitMs(s, b)` = `min(s*1000, b − 5_000)`, floored at 0, with `clampedTo` (seconds) when clamped. `wait_s: 0` → 0 ms → returns `open` at once.

### C7 `request-sources.ts` (pure reconciler)
```ts
export interface SessionNeedsYou { sessionId: string; handle: Handle | null; blocked: BlockedKind | false; visible: boolean; resumeIssue: string | null }
export interface QuestionMessage { messageId: string; threadId: string; from: Handle; fromSession: string | null; subject: string; body: string; sentAt: string }
export type SourceAction =
  | { kind: 'create'; source: 'observed' | 'scheduler' | 'message'; sessionId: string | null; requester: Handle | 'conduit';
      fields: Pick<RequestRecord, 'kind' | 'title' | 'body' | 'options' | 'thread' | 'messageId' | 'blocked' | 'priority'> }
  | { kind: 'resolve'; id: string };
export function reconcileAttention(open: RequestRecord[], facts: SessionNeedsYou[]): SourceAction[];
export function reconcileQuestions(open: RequestRecord[], unread: QuestionMessage[]): SourceAction[];
export const SCHEDULER_OPTIONS: readonly RequestOption[]; // [{label:'Resume now'}, {label:'Turn auto-resume on'}]
```
Rules:
- **observed**: create when `blocked !== false` and `!visible`, and no open observed request exists for that session. Kind `attend`. Title is Conduit-written, `${handle ?? 'A session'} is waiting at a prompt in its terminal`. Body ''. Resolve when `blocked === false` (the prompt cleared). Becoming visible does not resolve it.
- **scheduler**: create when `resumeIssue !== null` and no open scheduler request exists for the session. Kind `choose`, `requester: 'conduit'`, title `${handle} hit a usage limit that auto-resume can't handle`, body = the resume-issue string (Conduit's own text), options `SCHEDULER_OPTIONS`. Resolve when `resumeIssue === null`.
- **message**: create one `text` request per unread question message to `you` with no open message request for that `messageId`. The requester is the sender. Title `${from} asked you a question`, body = the message subject + "\n\n" + the first 600 chars of the body, `thread`, `messageId`. Resolve when the message is no longer unread for `you` (read in Messages, or replied).

### C8 `request-service.ts` (composer, consumed by host.ts)
```ts
export interface RequestServiceDeps {
  io: RequestsIo; machineId: string; now(): number; newId(): string;
  setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void;
  warn(message: string, data?: unknown): void;
  stampOf(sessionId: string): Omit<Stamp, 'requester'>;     // space + lead from the session list
  handleOf(sessionId: string): Handle | null;
  sessionOfHandle(handle: Handle): string | null;
  budgetMs(caller: Caller): number;                          // askBudgetMs(cliKindOfHandle, wiredAtLaunch)
  deliver(r: RequestRecord): Promise<boolean>;               // late end → inbox message; false = store down, retry later
  replyToQuestion(r: RequestRecord, text: string): Promise<Result<void>>; // ordinary human reply in r.thread, then mark the message read
  scheduler: { resumeNow(sessionId: string): boolean; autoResumeOn(sessionId: string): boolean; dismiss(sessionId: string): void };
  onChanged(): void;                                         // host.scheduleBroadcast
  onNew(r: RequestRecord): void;                             // host → attention edge (Slice 5)
}
export interface RequestService {
  start(): void; stop(): Promise<void>;
  tools: {
    requestInput(caller: Caller, args: unknown, key: CallKey): Promise<Result<RequestCallOutput> | null>;
    waitRequest(caller: Caller, args: unknown, key: CallKey): Promise<Result<RequestCallOutput> | null>;
    withdrawRequest(caller: Caller, args: unknown): Result<{ state: 'withdrawn'; request_id: string }>;
    listRequests(caller: Caller, args: unknown): Result<ListRequestsOutput>;
  };
  answerFromRenderer(requestId: string, answer: unknown, windowId: number | null): Promise<RequestAnswerResult>;
  setAway(away: boolean, until: string | null): void;
  humanActive(): void;                                       // terminal input → ends Away
  cancelCalls(match: (w: { sessionId: string; key: CallKey }) => boolean): void; // client cancel, conn close
  onSessionDeleted(sessionId: string): void;                 // cancel its waits + orphan its requests
  onAttention(facts: SessionNeedsYou[]): void;
  onQuestions(unread: QuestionMessage[]): void;
  retryDeliveries(): void;                                   // store became available
  purge(): void;                                             // the host's 6 h retention tick
  ui(): RequestsUiState;
  presence(): HumanPresence;
}
```
A `null` from a tool means the client cancelled, so the host sends no reply (the existing `callTool` contract). Withdrawing someone else's request, or a non-open one → `not_found` (own open requests only).

### C9 Late-answer inbox message (deliver)
`store.append` a `MessageRecord` with:
- `from: 'you'`, `to: [requester]`, `kind: 'inform'`, `priority: 'normal'`
- `subject: 'Answer to your request ' + id` (Conduit-written)
- `requestId: id`, and **always a new thread** (never `r.thread`), so the human's views can filter it whole

The body is `JSON.stringify({request_id, state, answer: RequestAnswerOut | null})`. It is sent when an agent-source request ends `answered` or `expired` and no call was waiting at that moment. `MessageRecord` gains `requestId?: string`, and `InboxMessageOut` gains `request_id?: string`.

**Kept out of the human's Messages (lead ruling 2):** `uiState()` excludes every message with `requestId` from `threads`, `youUnread*` and `attention`, and the `mcp:thread` view does the same. A thread whose messages all carry `requestId` is omitted. The store contract only gains the optional field.

**Typed notice:** `composeNotice(urgent: boolean, answered: boolean)` (`src/conduit-mcp/notice-text.ts`). When any due message carries `requestId`, the notifier types `[conduit] A request you made was answered. Use the conduit read_inbox tool.`, a fixed ASCII line with no peer text.

### C10 Renderer/server messages — `src/protocol.ts`
- `WebviewToHost`: `{type:'mcp:requestAnswer'; requestId: string; answer: AnswerInput}` · `{type:'mcp:setAway'; away: boolean; until: string | null}`.
- `HostToWebview`: `{type:'mcp:requestResult'; requestId: string; result: RequestAnswerResult}` (reply to the sender only).
- `McpUiState` gains `requests: RequestsUiState`. It rides the existing `mcp:state` broadcast and the `events.subscribe` snapshot. Any window may answer (spec §4.4: all views show the same object), and the first answer wins.
- `ListSessionsOutput.human` becomes `{ handle: 'you'; presence: 'here' | 'away' }`.

### C11 Attention port — `src/contracts/server-ports.ts`
`AttentionPort` gains `needsYouFacts(): SessionNeedsYou[]`. It is implemented in `server/attention/index.ts` from `reported` (state `blocked` → its `kind`, else `false`), `resumeIssues` and `activity.isVisible`. It covers every session with a reported status or a resume issue. `SessionNeedsYou` lives in `src/contracts/server-ports.ts`, and `request-sources.ts` imports it from there, type-only.

### C12 Limit monitor actions — `server/domain/limit-monitor.ts`
`resumeNow(sessionId: string): boolean`: when an episode is open, send the session's resume message once via `scheduler.sendOnce`, and leave the episode to its normal verify path. `dismissIssue(sessionId: string): void`: `closeEpisode(sessionId, 'closed')`, which clears the resume issue. `autoResumeOn` = the existing `scheduler.setSessionAutoResume(sessionId, 'on')` path (`server/domain/index.ts:1579-1586`). All three are exposed through the domain to `server/mcp/index.ts` as `deps.limit`.

### C13 Tray count — `src/tray-counts.ts`
`trayCounts(sessions, health, stopping, needs: { openRequests: readonly RequestView[]; waitingAsks: number })`. There is no tray-protocol change.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| request records | request-queue (via tools, sources) | request-service ui() → `McpUiState.requests` → renderer (CON-20 later); tray-channel counts | both (the renderer side is only the state shape plus the bridge mock; no UI) |
| late answer | request-service.deliver → message store | agent `read_inbox` (`request_id`); notifier | both |
| answer | renderer `mcp:requestAnswer`, default timer | queue → waits / inbox / limit monitor / thread reply | both |
| attention facts | ServerAttention (`needsYouFacts`) | request-sources reconcile | both |
| resume issue | limit-monitor `setResumeIssue` | ServerAttention (unchanged) + request-sources | consumer added; producer unchanged except the two new actions |
| question messages | message store | request-sources (via host) | consumer added; store gains only `requestId` |
| ask lifetime with no app | server/mcp/index.ts (grace removed), call-flow | tool callers (no more `ui_unavailable`) | both. Callers of `ui_unavailable`: `src/conduit-mcp/types.ts:52`, `webview/conduit-mcp-strings.ts:229`, `test/unit/server-mcp-wiring.test.ts:477,701-750`, `src/conduit-mcp/host.ts:2129-2137`, `src/conduit-mcp/call-flow.ts:209,294-298,493-502` |
| tray M | `src/tray-counts.ts` | `src/tray-view.ts` text and icon | both |
| OS notification (a window exists) | host `onNew` → `attention.edge` kind `'request'` | `electron/server-events.ts` → `notifyAttention` | both |
| message-to-you attention item for a question covered by a `message` request | host `uiState` (`youAttention`) | renderer chip; tray (requests only) | producer: the item is dropped while an open message request covers every unread-for-you message of that thread (lead ruling 6) |
| late-answer messages in the human's views | host `uiState` / `mcp:thread` | renderer Messages | producer filters `requestId` messages (lead ruling 2) |
| `list_sessions.human` | tools.ts | agents (wire); `tool-schemas.ts` description | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/request-types.ts` | create | wire types C1 (Node-free) |
| `src/conduit-mcp/request-args.ts` | create | tool arg parsing, answer validation, limits C2/C3 |
| `src/conduit-mcp/request-queue.ts` | create | lifecycle state machine, caps, dedupe, expiry, history C4 |
| `src/conduit-mcp/request-file.ts` | create | requests.json parse/serialize C5 |
| `src/conduit-mcp/request-file-fs.ts` | create | fs io for requests.json C5 |
| `src/conduit-mcp/request-waits.ts` | create | blocked-call registry C6 |
| `src/conduit-mcp/request-sources.ts` | create | observed/scheduler/message reconciler C7 |
| `src/conduit-mcp/request-service.ts` | create | composer + tool handlers + delivery + presence C8 |
| `src/conduit-mcp/machine-id.ts` | create | the one accessor `loadMachineId(dir)`: load-or-create `conduit-mcp/machine-id.json` → `m-xxxxxxxx`. Provisional; the comment points to `docs/specs/2026-11-14-conduit-network.md` §4.1 so CON-16 can replace it |
| `src/conduit-mcp/notice-text.ts`, `src/conduit-mcp/notifier.ts` | modify | the typed answered notice (C9) |
| `src/conduit-mcp/tool-policy.ts` | modify | `REQUEST_TOOL_NAMES`, group `'requests'`, specs (MESSAGING_SPEC shape); gate change (Slice 5) |
| `src/conduit-mcp/tool-schemas.ts` | modify | 4 schemas; `CONDUIT_INSTRUCTIONS` names request_input; `list_sessions` human presence wording |
| `webview/conduit-mcp-strings.ts` | modify | tool descriptions, `requests` group label; drop `ui_unavailable` |
| `src/conduit-mcp/types.ts` | modify | `MessageRecord.requestId?`, `InboxMessageOut.request_id?`, `ListSessionsOutput.human.presence`; drop `ui_unavailable` |
| `src/conduit-mcp/tools.ts` | modify | readInbox emits `request_id`; listSessions `human.presence` (new ToolDeps `presence()`) |
| `src/conduit-mcp/store.ts` | modify | keep `requestId` through parse/replay (if the parser strips unknown fields) |
| `src/conduit-mcp/ui-types.ts` | modify | `McpUiState.requests` |
| `src/protocol.ts` | modify | C10 messages |
| `src/conduit-mcp/host.ts` | modify | construct the service; route tools, renderer messages, store/attention/session/conn events; deps.limit; `onNew` edge |
| `webview/bridge.ts` | modify | fake-shell `mcp:state` gets an empty `requests` |
| `src/contracts/server-ports.ts` | modify | `SessionNeedsYou`, `AttentionPort.needsYouFacts` |
| `server/attention/index.ts` | modify | implement `needsYouFacts` |
| `server/domain/limit-monitor.ts` | modify | `resumeNow`, `dismissIssue` |
| `server/domain/index.ts` | modify | expose `limit` actions to services |
| `server/services.ts` | modify | pass `limit` + attention into createMcp |
| `server/mcp/index.ts` | modify | remove APP_GRACE_MS deny; re-home asks on presence; pass deps |
| `src/conduit-mcp/call-flow.ts` | modify | no-app ask path; `rehome`; delete `denyUnavailable`/`unavailable` |
| `src/conduit-mcp/window-waits.ts` | modify | `retarget(id, windowId)` |
| `src/tray-counts.ts` | modify | M = requests + asks + uncovered sessions |
| `server/tray-channel.ts` | modify | tap `mcp:state` for the count |
| `src/contracts/server-protocol.ts` | modify | `attention.edge.kind` += `'request'`, plus `requestKind?`/`handle?` fields |
| `electron/server-events.ts`, `electron/main.ts` | modify | the `'request'` edge → notifyAttention with Conduit words; 10 s burst coalescing |
| `test/unit/request-*.test.ts`, `test/unit/machine-id.test.ts` | create | per-module unit tests |
| `test/e2e/requests-agent.e2e.mjs` | create | agent asks → answered in time; late answer via inbox; cancel/retry attach |
| `test/e2e/requests-sources.e2e.mjs` | create | OSC 7501 blocked off-screen → attend → resolved; question message → request |
| `test/e2e/asks-no-window.e2e.mjs` | create | `when: always` ask survives app close and is answerable after reconnect; tray count |
| `docs/specs/INDEX.md` | modify | link the run folder (no status change; CON-20 still owes the UI) |
| `CHANGELOG.md` | modify | agent-facing tools; no-window asks; tray count |

## Scripts
None. Every repeated edit is a type-checked registration, not a text pattern.

## Slices

### Slice 1: Request core (pure)
**Check:** `npx vitest run test/unit/request-args.test.ts test/unit/request-queue.test.ts test/unit/request-file.test.ts` is green, then `npm run verify`.
**Parallel groups:** Serial first: T1.0 · then G1: T1.1 · G2: T1.2 · G3: T1.3
**Claims:** none (all new files)

#### Task 1.0: Wire types (orchestrator)
**Files:** Create `src/conduit-mcp/request-types.ts` (C1 verbatim).
**Steps:** write, typecheck, commit. It is the frozen contract for every lane.

#### Task 1.1: Args and answer validation
**Files:** Create `src/conduit-mcp/request-args.ts`, `test/unit/request-args.test.ts`.
**Interfaces:** Produces C2 constants + C3. Consumes C1, `Result`/`toolError` from `src/conduit-mcp/types.ts`, and the `argsObject` idiom (`src/conduit-mcp/tools.ts:171-179`: copy the behaviour, unknown key → `invalid_args`).
**Steps:**
- [ ] Failing tests: 'rejects a default without expires_in' → `error.code == 'invalid_args'`. 'rejects a 201-char title' → `too_large`. 'choose needs 2–8 options'. 'review needs a draft'. 'parseExpiresIn("2h") == 7_200_000; ("8d") == null; ("0m") == null'. 'validateAnswer: choose chosen with an unknown label → invalid_args'. 'single-choice rejects 2 values unless multi'. 'confirm answered needs text'. 'attend is never validated here' (the caller checks first). 'a default may not be dismissed'. 'contentKeyOf ignores replaces and wait_s'.
- [ ] Run → FAIL (module missing). Implement.

#### Task 1.2: Queue state machine
**Files:** Create `src/conduit-mcp/request-queue.ts`, `test/unit/request-queue.test.ts`.
**Interfaces:** Produces C4 + the cap/history constants (C2). Consumes C1, `validateAnswer(r, a): Result<AnswerInput>` (C3; import it, and stub nothing: until T1.1 lands, write the tests against the real import and rebase onto T1.1 before finishing) and `toolError`.
**Steps:**
- [ ] Failing tests (fake clock/timers): 'first answer wins; second gets already_ended'. 'expiry with a default answers with answeredBy default'. 'expiry without a default → expired'. 'replaces supersedes the old one and links supersededBy'. 'replaces of another session's request → not_found'. 'dedupe: same session, same contentKey, open → attached, no cap spent'. '6th open from one requester → rate_limited'. '2nd urgent within 10 min → rate_limited'. '21st created in an hour → rate_limited'. '51st open on the server → rate_limited'. 'load resolves open observed and scheduler requests, keeps agent ones open, ends overdue ones, purges ended > 30 d'. 'orphanSession only touches open requests of that session'. 'attend answer → not_answerable'. 'onEnded fires once per end'.
- [ ] Run → FAIL. Implement.

#### Task 1.3: File format and io
**Files:** Create `src/conduit-mcp/request-file.ts`, `src/conduit-mcp/request-file-fs.ts`, `test/unit/request-file.test.ts`.
**Interfaces:** Produces C5. Consumes C1, `judgePersistedVersion` (`src/contracts/session-identity.ts`), `atomicWriteFile` (`src/atomic-write.ts:59+`).
**Steps:**
- [ ] Failing tests: 'round-trips a file'. 'null text → empty'. 'garbage → corrupt + empty'. 'version 2 → newer'. 'drops a malformed record and keeps the rest'. 'io writes atomically into a temp dir' (use `test/helpers/temp-roots.ts`).
- [ ] Run → FAIL. Implement.

### Slice 2: Agent tools end to end
**Check:** unit tests below are green. `npm run verify` passes. Then `npm run e2e:remote -- requests-agent` passes: a fake agent calls `request_input` (choose, `wait_s: 3`) and the test answers via `mcp:requestAnswer` within the wait → result `answered`. A second call (`wait_s: 2`) isn't answered → `open`, then the test answers → the agent's `read_inbox` shows `request_id` and outcome `chosen`. A third call is cancelled mid-wait and then repeated → it attaches to the same `request_id`.
**Parallel groups:** G1: T2.1 · G2: T2.2 · G3: T2.3 · Serial: T2.4, T2.5
**Claims (serial lane):** `src/conduit-mcp/host.ts`, `src/protocol.ts`, `src/conduit-mcp/ui-types.ts`, `src/conduit-mcp/types.ts`, `src/conduit-mcp/tools.ts`, `webview/bridge.ts`

#### Task 2.1: Waits
**Files:** Create `src/conduit-mcp/request-waits.ts`, `test/unit/request-waits.test.ts`.
**Interfaces:** Produces C6. Consumes `CallKey` (`src/conduit-mcp/window-waits.ts:5-9`).
**Steps:** failing tests 'ended resolves all waits on that id', 'timeout resolves timeout', 'cancel by key resolves cancelled and isWaiting turns false', 'onWaitingChanged fires on open and on every end', 'requestWaitMs(null, 120000) == 110000; (200, 50000) == {ms:45000, clampedTo:45}; (0, x) == 0'. Implement.

#### Task 2.2: Service (no sources yet)
**Files:** Create `src/conduit-mcp/request-service.ts`, `src/conduit-mcp/machine-id.ts`, `test/unit/request-service.test.ts`, `test/unit/machine-id.test.ts`.
**Interfaces:** Produces C8, except three members that arrive with their first caller: `onAttention`/`onQuestions` and `deps.scheduler`/`deps.replyToQuestion` in Slice 4 (T4.4), and `deps.onNew` in Slice 5 (T5.4), and `loadMachineId(dir: string): string`. Consumes C1–C6 and C9 (through `deps.deliver`).
**Steps:**
- [ ] Failing tests with fake deps: 'answered within the wait → returns state answered, no deliver call'. 'not answered → returns open; a later answer calls deliver once and markDelivered'. 'deliver false → retried by retryDeliveries'. 'cancelCalls → the tool returns null and the request stays open with waiting false'. 'repeat identical call attaches and waits again'. 'withdraw of another session's request → not_found'. 'list_requests returns only the caller session's requests'. 'setAway(true, until) then the timer passes until → here, lastAway set'. 'humanActive ends Away'. 'expiry default while nobody waits → deliver called with answered_by default'. 'persists coalesced (one write per tick) and never writes after a newer file'. 'machine id is created once and reused; format /^m-[0-9a-f]{8}$/'.
- [ ] Run → FAIL. Implement.

#### Task 2.3: Tool registration
**Files:** Modify `src/conduit-mcp/tool-policy.ts` (add `export const REQUEST_TOOL_NAMES = ['request_input','wait_request','withdraw_request','list_requests'] as const;` to `TOOL_NAMES`, group `'requests'` in `ToolGroup`/`TOOL_GROUPS` after `'messaging'`, specs = `MESSAGING_SPEC`, extend the `TOOL_SPECS` conditional type so request tools take `null` budget, and treat them like messaging in `isMessagingTool`'s gate skip **without** the message-store availability check). Modify `src/conduit-mcp/tool-schemas.ts` (4 closed schemas matching C3; `wait_s` integer ≥ 0 ≤ 540; `CONDUIT_INSTRUCTIONS` adds one sentence: "To ask the human a question and get a structured answer, use request_input."). Modify `webview/conduit-mcp-strings.ts` (4 descriptions, group label "Requests"). Update tests: `test/unit/conduit-mcp-tool-policy.test.ts:54-57` (groups), `test/unit/conduit-mcp-json-rpc.test.ts:143-150` (should pass unchanged), plus any `TOOL_NAMES`-derived UI test that counts groups.
**Interfaces:** Produces `REQUEST_TOOL_NAMES`, `isRequestTool(name: ToolName): boolean` (tool-policy.ts).
**Steps:** failing test 'groups are messaging, requests, sessions, editor', 'request tools default on, no ask', 'gate lets a request tool through with no ready window'. Implement.

#### Task 2.4: Host wiring (serial)
**Files:** Modify `src/conduit-mcp/host.ts`, `src/protocol.ts`, `src/conduit-mcp/ui-types.ts`, `src/conduit-mcp/types.ts`, `src/conduit-mcp/tools.ts`, `src/conduit-mcp/store.ts` (only if its parser drops `requestId`), `webview/bridge.ts`; tests in `test/unit/conduit-mcp-host.test.ts` (new describe 'requests').
**Interfaces:** Consumes C8, C9, C10, `isRequestTool`. Host hooks:
- `callTool`: `isRequestTool(name)` → `requestService.tools.*` with `key = {connId, requestId}`. Skip `store.available()`.
- `notifications/cancelled` (host.ts:1438-1441) and connection close (host.ts:1493) → `requestService.cancelCalls`.
- Session delete (host.ts:2067-2069) → `onSessionDeleted`.
- `store.onChange` (host.ts:548-552) → `retryDeliveries` when available.
- 6 h retention tick (host.ts:1891-1894) → `purge`.
- `onRendererInput` (host.ts:1998) → `humanActive`.
- `handleRenderer` `mcp:requestAnswer` → reply `mcp:requestResult`; `mcp:setAway` → `setAway`.
- `uiState()` adds `requests: requestService.ui()`.
- `deliver` per C9 through `tools.sendMessage`'s store path, as the human caller.
- `budgetMs = askBudgetMs(cliKindOfHandle(handle), wiredAtLaunch(sessionId))`.
- `stampOf` walks `openedBy` through `deps.sessions.list()` (stop at a missing opener, and guard cycles with a visited set).
- `requests.json` lives in `deps.dir`, and the machine id in `deps.dir`.
- Lead ruling 2 (C9): filter `requestId` messages out of `uiState()` (threads, youUnread*, attention) and the `mcp:thread` view. Typed notice: `composeNotice(urgent, answered)` in `src/conduit-mcp/notice-text.ts`, chosen in `src/conduit-mcp/notifier.ts` when any due message has `requestId`. Add both files to this task's Files.
**Steps:** failing host tests: 'request_input answered from the renderer returns answered', 'late answer lands in read_inbox with request_id', 'cancel then repeat attaches', 'a second window's answer gets already_ended', 'uiState carries requests'. Implement.

#### Task 2.5: e2e (orchestrator)
**Files:** Create `test/e2e/requests-agent.e2e.mjs`. Use `test/e2e/conduit-mcp-helpers.mjs` (`fakeAgentProfile`, `openFake`, `startCall`/`resultAfter`, `callTool`, `records`, `mcpState`), and post `mcp:requestAnswer` through the same bridge path `clickAskAnswer` uses. Run `npm run e2e:remote -- requests-agent`.

### Slice 3: CHANGELOG + docs for the agent tools (orchestrator, with Slice 2's merge)
**Check:** `npm run verify`. The CHANGELOG has an Unreleased line. `docs/specs/INDEX.md` links the run folder.

### Slice 4: Sources
**Check:** unit tests green; `npm run verify`; `npm run e2e:remote -- requests-sources` (an off-screen session reports `ESC]7501;state=blocked;kind=permission BEL` via `report()` from `test/e2e/attention-footer-helpers.mjs` → one open `attend` request; reporting `idle` → `resolved`. A fake agent `send_message` to `you` with kind `question` → an open `message` request; answering it with text posts a thread reply and resolves the unread). Before writing the e2e, the orchestrator confirms `kind=` is the right key against `src/contracts/hc/hc.openrpc.json:738-770`.
**Parallel groups:** G1: T4.1 · G2: T4.2 · G3: T4.3 · Serial: T4.4
**Claims (serial lane):** `src/conduit-mcp/host.ts`, `src/conduit-mcp/request-service.ts`, `server/services.ts`, `server/mcp/index.ts`, `server/domain/index.ts`

#### Task 4.1: Reconciler
**Files:** Create `src/conduit-mcp/request-sources.ts`, `test/unit/request-sources.test.ts`.
**Interfaces:** Produces C7. Consumes C1 and `SessionNeedsYou` (C11; T4.2 adds it to `src/contracts/server-ports.ts`. Until then, write the test against the C11 shape and rebase onto T4.2).
**Steps:** failing tests per C7 rule (create once, no duplicate on a repeat pass, resolve on clear, visible never resolves attend, scheduler resolves when the issue clears, message resolves when read). Implement.

#### Task 4.2: Attention facts
**Files:** Modify `src/contracts/server-ports.ts`, `server/attention/index.ts`, `test/unit/server-attention.test.ts`.
**Interfaces:** Produces C11.
**Steps:** failing tests 'blocked permission while hidden → blocked "permission", visible false', 'non-blocked → false', 'resume issue appears and clears'. Implement.

#### Task 4.3: Limit monitor actions
**Files:** Modify `server/domain/limit-monitor.ts`, `test/unit/limit-monitor.test.ts` (or the existing monitor test file; find it with `ls test/unit | grep limit-monitor`).
**Interfaces:** Produces C12 `resumeNow`, `dismissIssue`.
**Steps:** failing tests 'resumeNow sends the resume message once via sendOnce when an episode is open; false with none', 'dismissIssue closes the episode and clears the resume issue'. Implement.

#### Task 4.4: Wiring (serial, orchestrator or one Haiku with the full claim set)
Service gains `onAttention`/`onQuestions` (calls `reconcile*`, applies `createSystem`/`resolve`). The answer of a scheduler request maps `Resume now` → `deps.scheduler.resumeNow`, `Turn auto-resume on` → `autoResumeOn`, and `dismissed` → `dismiss`. A `message` answer with text → `replyToQuestion`. Host calls `onAttention(deps.attention.needsYouFacts())` on `attention.onChange`, and `onQuestions(...)` from store changes (unread question messages to `you`). Lead ruling 6: in `uiState()`, drop a thread's `message-to-you` attention item while every unread-for-you message in that thread is a question covered by an open `message` request. The question is then counted once, as the request. `server/domain/index.ts` exposes `limit`, and `server/services.ts` → `server/mcp/index.ts` → host deps carry it. Then the e2e.

### Slice 5: No-window asks, tray count, in-app OS notification
**Check:** unit tests green; `npm run verify`; `npm run e2e:remote -- asks-no-window requests-agent`.
**Parallel groups:** G1: T5.1 · G2: T5.2 · Serial: T5.4
**Claims (serial lane):** `server/mcp/index.ts`, `src/conduit-mcp/host.ts`, `src/contracts/server-protocol.ts`, `electron/server-events.ts`, `electron/main.ts`

#### Task 5.1: Asks outlive the app
**Files:** Modify `src/conduit-mcp/call-flow.ts`, `src/conduit-mcp/window-waits.ts`, `src/conduit-mcp/tool-policy.ts` (gate), `src/conduit-mcp/types.ts` + `webview/conduit-mcp-strings.ts` (drop `ui_unavailable`); tests `test/unit/conduit-mcp-call-flow.test.ts`, `test/unit/conduit-mcp-tool-policy.test.ts`, `test/unit/window-waits.test.ts` (find the existing names with `ls test/unit | grep -E 'call-flow|window-waits|tool-policy'`).
**Interfaces:** Produces `CallFlow.rehome(ownerWindowOf: (sessionId: string) => number | null): void`, `WindowWaits.retarget(id: string, windowId: number): boolean`, and a `gateToolCall` input `appConnected: boolean`.
Rules:
- With `!appConnected`, `access: 'ask'` and `when: 'always'` → pass the gate, and `ask()` opens the wait with `windowId: null` (no `mcp:ask` sent).
- `when: 'viewing'` with no app keeps `window_not_ready`.
- With the app connected and no ready owner, keep `window_not_ready` (unchanged).
- `rehome` retargets each waiting ask whose window is null or gone to `ownerWindowOf(caller)`, and sends `mcp:ask` there.
- Delete `denyUnavailable` and `unavailable`.
**Steps:** failing tests 'ask with no app and when always waits its budget then approval_timeout', 'rehome makes the ask answerable from the new window', 'when viewing with no app → window_not_ready'. Implement.

#### Task 5.2: Tray count (TS side)
**Files:** Modify `src/tray-counts.ts`, `server/tray-channel.ts`; tests `test/unit/tray-counts.test.ts`, `test/unit/tray-channel.test.ts` (check the existing names with `ls test/unit | grep tray`).
**Interfaces:** C13.
- `needsYou = openRequests.length + waitingAsks + attentionSessions(running).filter(s => !openRequests.some(r => r.session === s.id && (r.source === 'observed' || r.source === 'scheduler'))).length`.
- tray-channel taps `ui.post` whose `message.type === 'mcp:state'`, reading `state.requests.open` and `state.awaitingApproval`. The waiting-ask count is the sum of open asks: add `waitingAsks: number` to `McpUiState` in T5.4 if `awaitingApproval` (session ids) undercounts. T5.2 reads a `waitingAsks` field, and T5.4 adds it.
**Steps:** failing tests 'M counts requests and asks and doesn't double-count attend/scheduler sessions', 'a question message row counts once'. Implement.

#### Task 5.4: Wiring + in-app OS notification (serial, orchestrator)
- `server/mcp/index.ts`: delete `APP_GRACE_MS`, `graceTimer` and `appDisconnected`'s timer. Pass `appConnected: presence.connected()` into the host gate. Call `flow.rehome` on `presence` when a ready window appears.
- Host `onNew(r)` emits `attention.edge {kind:'request', sessionId: r.session, requestKind: r.kind, handle: r.requester}`, unless Away and not urgent.
- `electron/server-events.ts` routes it to `notifyAttention`, and `electron/main.ts` writes the body in Conduit's words, coalesced to one per 10 s ("4 new requests from 3 agents").
- `McpUiState.waitingAsks: number` (count of waiting asks) for T5.2.
- e2e `asks-no-window` (pattern: `test/e2e/auto-resume-works-with-no-window.e2e.mjs`).
- `test/unit/server-mcp-wiring.test.ts:701-750` grace tests are replaced by 'asks survive app disconnect until their budget'.

## Verification
- Per task: the task's own vitest file, red first, then green; `npm run verify:quick` before handing back.
- Per lane merge: the orchestrator reviews the diff (`code-review` skill), merges one lane at a time, runs `npm run verify; echo "exit=$?"`, and commits.
- Per slice: the slice's check (e2e remote by exact name, plus `--affected`), then a report to the lead with the SHA, the verify exit code and the e2e run ids.
- End: `npm run e2e:remote -- --affected` on the final tree.

## Deviation rule
If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the work. Never a shim, a second copy, a special case, a widened type, a fallback, or an override patched in place of its semantic source. A Haiku lane reports back instead of improvising, and the report leads with the fix that keeps the locked decision.

## Decisions Needed
- [ruled, default accepted] #1 REQ-D21c under default policy: every default ask tool is `when: 'viewing'`, so with no window a new ask is still refused (`window_not_ready`). Only `when: 'always'` asks, and asks already waiting when the app closes, wait out their budget. Default taken: exactly that; policy semantics unchanged.
- [ruled, default accepted] #2 Scheduler request options: CON-15 isn't built, and no "try at reset" action exists for an unknown reset. Default taken: `Resume now` (send the resume message once) · `Turn auto-resume on` · Skip (= dismiss the episode's needs-you). The request resolves when the resume issue clears.
- [ruled] #3 No app-closed OS notification on this card (lead): see Left for later.
- [ruled, default accepted] #4 Machine id: `m-` + 8 random hex, persisted per userData in `conduit-mcp/machine-id.json`, until NET derives it from a server key. Stored requests keep the old value then.
- [ruled] #5 Late answers are tagged `requestId` and filtered out of the human's views (lead ruling 2; C9).
- [normal] #6 Caps count `message` rows toward the 5-per-requester limit, but a question row is never refused. The cap only blocks the sender's next `request_input`.

## Left for later
- **App-closed OS notification (Windows and Linux).** With no app running, a waiting ask or a new request shows only in the tray count. A notification surface is needed: a tray-helper balloon on Windows, and on Linux something that exists without the Electron app (no tray helper there today). The lead files it as a card. Removed from this card: the `notify` tray-protocol message and the Rust balloon.
