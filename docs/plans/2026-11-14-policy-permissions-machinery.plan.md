# Policy and permissions machinery (CON-24) — implementation plan

**Spec:** `docs/specs/2026-11-14-policy-and-permissions.md` (POL, MVP locked in §15)  **Tier:** FULL
**Builds on:** CON-21's queue (`docs/runs/2026-11-14-CON-21/report.md`), branch cut at `1fc7e690`.

## Goal
Replace the per-field tool policy with profiles, exceptions and grants decided by one engine. Every
Conduit decision and the native actions of Claude and Codex go to an Activity log. Asks become REQ
`permission` requests. No new UI: CON-25 draws it from the state and channels built here.

## Architecture
The engine is a pure function over a policy state (profiles, assignments, grants, one-use
overrides). It lives in flat `src/conduit-mcp/policy-*.ts` modules beside `tool-policy.ts`, which
keeps the tool catalogue, field model and gate. One composer, `policy-service.ts`, owns persistence
(`policy.json`, `grants.json`), the v0.64 migration, the Activity sink and grant timers. `host.ts`
only builds the principal and targets, calls `policyService.decide`, and routes renderer messages.
`call-flow.ts` turns an `ask` into a `permission` request and re-decides at answer time. The approval
card becomes a view of open `permission` requests.

The observed lane enters the same Activity sink:
- Claude through a new `PostToolUse` hook on the existing hook socket.
- Codex through a new action parser on the rollout tail the domain already runs.

## Data flow
```
agent ──tools/call──> host.callTool ── principal{sessionId, handle, launchedCli} + targets[]
                          │
                          v
                 policyService.decide(input) ── engine: floors → denies(+override) → grants → assignment
                          │  {decision, reason, rule{when,reach,move}}          │
                          │                                                     └─> activity.record(row)
          allow ──> gateToolCall(rule: window/on-screen) ──> tool runs ──> activity outcome
          deny  ──> tool_disabled (+reason)                          
          ask   ──> callFlow.ask ──> requestService.createPermission(expiresAt = call budget)
                                         │                     │
                     approval card <── mcp:ask/asksSnapshot   McpUiState.requests (decision DN-3)
                     (askId = requestId)                        │
       mcp:askAnswer ─┐                    mcp:permissionAnswer ┘
                      v
          callFlow.answerPermission ── re-decide now: deny? → withdraw(conduit, reason)
                      │                 else allowed → [grant] → run · denied → denied
                      └─ request expired + grant → grant only, retry notice (never runs)

Claude PostToolUse ─hook socket─> endpoint ─> domain.hookPost ─┐
Codex rollout item_completed ──> codexWatch.onAction ──────────┴─> services → host.recordObserved → activity
```

## Settled decisions — do not re-litigate
- POL-D1 profiles over rules + Activity. POL-D2 (a): observe only, no native deciding.
- **POL-D3 allow**: Lead allows `open_terminal` and `open_session` with no ask.
- POL-D4: Lead acts off screen (`when: 'always'` in the Lead profile).
- POL-D5: kind assignments and kind grants apply only to sessions Conduit launched with a known adapter.
- POL-D6: if the Activity store fails, local principals go ahead with a gap marker. Guests fail closed in v1; with no guests in MVP the engine takes no `auditWritable` input (added with the Guest profile).
- POL-D7: picker defaults by principal; a "until this session ends" grant also expires after 7 days unused.
- POL-D8: Activity is human-only and never readable through MCP. POL-D9: allow/ask/deny. POL-D14: observed lane for Claude and Codex.
- POL-D16: one-use override, local only, never past a floor. POL-D17: one Activity row per raised request, linked by `requestId`.
- POL-D13 (native posture) and POL-D15 (outbound to guests) are v1: not built. Migration never touches launch flags.
- Lead brief: no new UI; the approval card keeps working; the remote principal is a data model only; stop at the spec's MVP.
- REQ-D15: a `permission` request never gets a default and is never routed to a lead.

## Spec staleness
Each line gives the claim, what was measured, and how the plan proceeds.
- **§2.1 "19 tools".** There are 23 (`src/conduit-mcp/tool-policy.ts:37,46`). CON-21 added a `requests` group: `request_input`, `wait_request`, `withdraw_request`, `list_requests`. Their spec is access off/on with no ask (`tool-policy.ts:145-148`), and they skip the gate (`:446`). Migration's "all on" test covers the 14 session and editor tools, plus the messaging and request tools not being off.
- **§4.2 table: Lead `open_terminal` "?".** POL-D3 (locked) makes it **allow**. That turns the migration exception "open_terminal: allow" into a no-op, so an all-on override migrates to **Lead +1** ("only while on screen"), not Lead +2. The acceptance scenario's "Lead +2" text is stale. Reported as DN-1.
- **§4.2 "only while on screen" as one exception.** An exception is per tool (§4.1), but this condition covers every tool with a `when` field. Plan: `Assignment.onScreenOnly: boolean`, counted as one exception in the label.
- **§4.3 floor (e) and the acceptance scenario "Escalation stays on the opener chain".** `answer_request` and `escalate_request` exist nowhere in the tree. REQ §4.8 marks escalation v1 (REQ-D18). Plan: floor (e) has no tool to guard, so it is not built. Reported as DN-4.
- **§4.4 "the answer is `{outcome, grant?, reason?}`" with `allowed`/`denied`.** `RequestOutcome` has neither value, and `AnswerInput` has no `grant` (`src/conduit-mcp/request-types.ts:15,30`). `createSystem` takes no expiry (`request-queue.ts:~268`). Plan: Slice 3 adds them.
- **§2.1 "the kind is the handle prefix".** True (`src/conduit-mcp/handles.ts:49`). Proof of launch exists only in memory: `runtime.defAdapter` (`host.ts:1318` `wiredAtLaunch`). Plan: `launchedCli` = the adapter's CLI kind when `defAdapter` is set, otherwise null.
- **§2.1 the Codex "measured" item names.** Re-measured from `~/.codex/sessions/2026/11/*/rollout-*.jsonl`. Lines are `{type:'event_msg', payload:{type:'item_completed', item}}`:
  - `CommandExecution{command: string[], cwd, exit_code, duration:{secs,nanos}, aggregated_output}`
  - `FileChange{changes: Record<path,{type,content}>}`
  - `McpToolCall{server, tool, arguments, result, duration}`

  Today's parser skips all of them (`src/codex-rollout.ts:100-101`).
- **§2.3 Claude PostToolUse shape "UNVERIFIED".** No fixture exists (`test/fixtures/claude-hooks/`). The hook client drops any stdin over 256 KiB (`resources/conduit-mcp/conduit-hook.cjs:80-90`, `src/contracts/hook-protocol.ts:16`), and PostToolUse carries `tool_response` with file contents. Plan: T0.2 records a real payload, and T4.1 strips content in the client.
- **§4.6 "30 days / 50 MB" shared with History.** The queue implements only the 30 days (`request-queue.ts:12`). Plan: Activity enforces both. Changing History's size cap is REQ's job and is left out (noted in the report).

## Global constraints
- **Gate.** `npm run verify` on every merged tree, exit code captured directly: `npm run verify; echo "exit=$?"`. Never through a pipe. Inner loop: `npm run verify:quick`. Never narrow, skip or ignore a check.
- **Unit tests.** `test/unit/<kebab-name>.test.ts`, vitest, node environment. Run one with `npx vitest run test/unit/<file>`. Use injected `now`, timers and fs. No real waits, and no win32 behaviour: compare paths through the existing folder-key helper (`folderKey`), never raw `\`.
- **Naming.** Kebab-case files. `camelCase` functions, `PascalCase` types, `SCREAMING_SNAKE` constants. Wire args are snake_case. Internal records are camelCase.
- **Node-free modules.** `policy-types.ts` and anything the renderer imports stay Node-free, with type-only imports.
- **Comments explain WHY only.** Prefer a pointer: `// see POL §4.3`.
- **No band-aids.** No `as any`, no `@ts-ignore`, no swallowed errors (log via `deps.warn`), no compatibility shims around a misfit seam.
- **Git and filesystem.** Spawn git only via `runGitBin`; watch directories only via `watchDir`. Neither is expected here.
- **Persisted files.** Every new persisted file gets an entry in `SERVER_FILE_VERSION` (`src/contracts/session-identity.ts:186-197`). A newer or corrupt file makes the store read-only and is never overwritten (the `request-file.ts` precedent).
- **Activity privacy.** Never store a message body, typed text, file contents or command output. Store lengths and paths only. Raw arguments are kept only for asks, in `activity/ask-args.json`, purged at 24 h.
- **User-facing strings.** New ones use the owner's words (UX.md §8). Existing strings are not renamed; the card's "Always for this session" label stays.
- **CHANGELOG.** Every user-facing change gets a line under Unreleased.
- **Commits.** `git -c user.name="$(git log main -1 --format=%an)" -c user.email="$(git log main -1 --format=%ae)" commit`. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- **Apps tested on this machine stay hidden.** Any Electron or browser launched for testing uses `--ozone-platform=headless`. If hiding can't be guaranteed, don't launch. This line goes into every lane brief.
- **Haiku lanes.** They write code and unit tests only, in a worktree under the orchestrator's scratchpad. They never run e2e, never merge, never edit outside their task's `Files:`, and never run `npm install`. `node_modules` is a symlink.

## Out of scope
- All UI: panels, badge rendering, Grants list, Activity view, Allow… picker, Why drawer.
- Exception: the two policy editors switch their data source (T2.4, DN-2).
- Native posture (D13) and guests: Guest profile, Share, guest caps, outbound-to-guest asks (D15), the "after a guest message" condition.
- Remote orchestrate (S8) and any link, peer transport or revoke trigger (NET). The remote principal and peer assignment exist as data and engine branches only.
- `answer_request`, `escalate_request`, floor (e) (DN-4). Deciding native approvals (D2 b/c). Activity export. History's 50 MB cap.

## Contracts

### C1 `src/conduit-mcp/policy-types.ts` — written by the orchestrator in T0.1, frozen after
```ts
import type { CliKind, Move, Reach, ToolName, When } from './tool-policy';

export type Decision = 'allow' | 'ask' | 'deny';
export type BuiltInProfileId = 'observer' | 'worker' | 'lead';
export type ProfileId = BuiltInProfileId | `p-${string}`;          // p- = a human-made copy
/** null = the tool has no such field (TOOL_SPECS). */
export interface ToolRule { decision: Decision; when: When | null; reach: Reach | null; move: Move | null }
export interface Profile { id: ProfileId; name: string; builtIn: boolean; rules: Record<ToolName, ToolRule> }

export type Scope =
  | { kind: 'anywhere' }
  | { kind: 'space'; projectId: string }
  | { kind: 'folder'; path: string }        // real path, matches the folder and below
  | { kind: 'path'; path: string }          // "this target only" for a folder/file target
  | { kind: 'session'; sessionId: string }; // "this target only" for a session target
export interface Exception { tool: ToolName; scope: Scope; rule: Partial<ToolRule> }
export interface Assignment { profileId: ProfileId; exceptions: Exception[]; onScreenOnly: boolean }
export type AssignmentPoint =
  | { kind: 'session'; sessionId: string }
  | { kind: 'peer'; machineId: string }
  | { kind: 'cli'; cli: CliKind }
  | { kind: 'default' };

export type Capability = 'messaging' | 'monitor' | 'drive' | 'orchestrate';
export type Principal =
  | { kind: 'session'; sessionId: string; handle: string; launchedCli: CliKind | null; homeFolder: string | null; projectId: string | null }
  | { kind: 'remote'; handle: string; machineId: string; remoteSessionId: string; trust: 'own'; capabilities: readonly Capability[] };
export interface PolicyTarget {
  sessionId: string | null;   // a session target
  path: string | null;        // the exact file/folder a tool acts on ("this target only")
  folder: string | null;      // the folder the target lives in: a session's cwd, a file's parent, a folder itself ("this folder")
  projectId: string | null;
}

export type GrantWho = { kind: 'session'; sessionId: string } | { kind: 'cli'; cli: CliKind } | { kind: 'peer'; machineId: string };
export type GrantFor = 'session-end' | '1h' | '24h' | 'until-revoked';
export type GrantState = 'active' | 'suspended' | 'expired' | 'revoked';
export interface Grant {
  id: string; who: GrantWho; tool: ToolName; on: Scope; for: GrantFor;
  anchorSessionId: string | null;            // the requester session whose end expires a 'session-end' grant
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
  state: GrantState; endedAt: string | null; requestId: string | null;
}
export interface GrantChoice { who: GrantWho['kind']; on: 'target' | 'folder' | 'anywhere'; for: GrantFor }
export interface OneUseOverride { id: string; sessionId: string; tool: ToolName; target: PolicyTarget; createdAt: string }

export type FloorId = 'master-off' | 'remote-capability' | 'local-to-you';
export type Reason =
  | { by: 'floor'; floor: FloorId }
  | { by: 'deny'; point: AssignmentPoint }
  | { by: 'override'; overrideId: string }
  | { by: 'grant'; grantId: string }
  | { by: 'exception'; point: AssignmentPoint; profileId: ProfileId }
  | { by: 'profile'; point: AssignmentPoint; profileId: ProfileId };

export interface PolicyState {
  profiles: readonly Profile[];               // human copies only; built-ins come from policy-profiles.ts
  assignments: ReadonlyMap<string, Assignment>; // key = pointKey(point)
  grants: readonly Grant[];
  overrides: readonly OneUseOverride[];
}
export interface PolicyInput {
  principal: Principal; tool: ToolName; targets: readonly PolicyTarget[];
  masterOn: boolean; toYou: boolean; now: number;   // auditWritable dropped: no guests in MVP, so nothing reads it
}
export interface PolicyDecision {
  decision: Decision; reason: Reason;
  rule: { when: When | null; reach: Reach | null; move: Move | null };
  grantId: string | null; overrideId: string | null;
}
export type PermissionAnswer =
  | { outcome: 'allowed'; grant?: GrantChoice }
  | { outcome: 'denied'; reason?: string };
```

### C2 Built-ins and engine — `policy-profiles.ts`, `policy-engine.ts` (Slice 1, lane A)
```ts
// policy-profiles.ts
export const BUILT_IN_PROFILES: readonly Profile[];              // observer, worker, lead; §4.2 with DN-1
export function profileById(state: PolicyState, id: ProfileId): Profile | null;
export function pointKey(p: AssignmentPoint): string;            // 'session:<id>' | 'peer:<m>' | 'cli:<k>' | 'default'
export function effectiveRule(profile: Profile, a: Assignment, tool: ToolName, target: PolicyTarget | null): ToolRule;
export function matchesScope(scope: Scope, target: PolicyTarget | null): boolean;   // the one scope matcher; decide() resolves no-target calls first
export const WORKER_PROFILE: Profile;                // fallback for an unknown profileId
// policy-engine.ts
export function decide(state: PolicyState, input: PolicyInput): PolicyDecision;
export function visibleTools(state: PolicyState, principal: Principal, now: number): ToolName[];  // master-off keeps every tool listed (today: messaging_off, not unknown-tool)
export function assignmentFor(state: PolicyState, p: Principal): { point: AssignmentPoint; assignment: Assignment };
export function reasonText(reason: Reason, decision: Decision, names: { profileName(id: ProfileId): string; cliName(k: CliKind): string }): string;
```
- **Worker.** Worker's rules are built from `TOOL_SPECS[*].defaults` (`tool-policy.ts:131-202`), mapping off→deny, ask→ask, on→allow. Worker equals today by construction.
- **Lead.** Lead is Worker with `decision: 'allow'` on `open_session`, `open_terminal`, `send_input`, `close_session` and `attach_folder`, and `when: 'always'` on every tool that has a `when`. Reach and move are unchanged.
- **Observer.** Observer is "deny" except `list_sessions`, `read_inbox`, `read_attachment`, `send_message`, `wait_sessions`, `list_agents` and the four request tools.

Engine invariants:
- **Precedence is exactly POL §4.3:** floors (a, d, c), then explicit denies (passable only by a matching one-use override, never a floor), then active, unexpired, unsuspended grants matching who × tool × scope, then the most specific assignment.
- **Assignment specificity.** A session beats a peer, which beats a kind, which beats the default. Kind is used only when `launchedCli !== null`. A remote principal uses its peer assignment; with none, an own peer is Worker with NET §4.1's orchestrate set (`open_session`, `open_terminal`, `close_session`, `send_input`, `read_screen`) at ask.
- **Within an assignment.** An exception beats the profile, and a narrower scope beats a wider one. On an exact tie the stricter decision wins (deny > ask > allow).
- **Several targets.** The strictest per-target decision wins, and its reason is reported.
- **Remote principals.** `when` is forced to `'always'`, and `reach: 'window'` becomes `'opened'`.
- **`onScreenOnly`.** It forces `when: 'viewing'` on every tool whose rule has a `when`.
- **Defaults.** A target with no session or path matches the caller's `homeFolder`. Floor (c): a local session with `toYou` on `send_message` or `request_input` is always allowed.
- **Every result carries exactly one `Reason`.**
- **Explicit denies (review ruling).** Only exception denies are explicit (step 2). A profile deny is decided at step 4, so a grant can pass it: Guest is a deny profile that Share grants pass (§1 success 5). "Rule" in §4.3 step 2 means the v1 user-made rules. Explicit denies come only from the chosen assignment, which replaces lower ones.
- **Hidden tools.** `visibleTools` hides a tool only when it is denied for every target: a non-master floor, or a profile deny with no non-deny exception and no matching grant.

### C3 Stores — `policy-file.ts`, `grant-store.ts` (Slice 1, lane B)
```ts
// policy-file.ts  → <dir>/policy.json
export interface PolicyFile { version: 1; profiles: Profile[]; assignments: Array<{ point: AssignmentPoint; assignment: Assignment }>;
  overrides: OneUseOverride[]; migratedFrom: 'v0.64' | null; notes: { onScreenOnlyOffered: string[] } }
export function parsePolicyFile(text: string): { ok: true; file: PolicyFile } | { ok: false; reason: 'corrupt' | 'newer' };
export function serializePolicyFile(f: PolicyFile): string;
// grant-store.ts  (pure, injected clock/ids; persisted by the service as <dir>/grants.json {version:1; grants})
export const GRANT_DECAY_MS = 7 * 86_400_000; export const GRANT_EXPIRING_MS = 10 * 60_000; export const GRANT_KEEP_EXPIRED_MS = 86_400_000;
export interface GrantStore {
  load(grants: Grant[]): void; all(): Grant[];
  create(who: GrantWho, tool: ToolName, on: Scope, forDur: GrantFor, anchorSessionId: string | null, requestId: string | null): Grant;
  touch(id: string): void;                                  // lastUsedAt = now
  revoke(id: string): Grant | null;
  sessionEnded(sessionId: string): Grant[];                 // expires grants whose who.sessionId or anchorSessionId matches
  tick(): Grant[];                                          // expires by expiresAt and 7-day decay ('session-end' only); purges expired > 24 h
}
export function grantScopeFor(choice: GrantChoice['on'], target: PolicyTarget, principal: Principal): Scope | null;  // null: nothing to bind to; never widens
export function grantWhoFor(choice: GrantChoice['who'], principal: Principal): GrantWho | null;  // null: kind for a non-launched session
export function isExpiring(g: Grant, now: number): boolean;
```

Review rulings for C3 (lane B, 2026-11-14):
- **Scopes.** `'target'` → session scope if `target.sessionId`, else a path scope on `target.path`, else null. `'folder'` → a folder scope on `target.folder`, else null. Never widens to anywhere.
- **Ended sessions.** `sessionEnded(id)` also expires active or suspended grants whose `on` is `{kind:'session', sessionId:id}` (spec §5.2).
- **Missing tools.** A profile in `policy.json` may omit tools; a missing tool's rule is filled from `WORKER_PROFILE` at parse time, and unknown tool keys are dropped.
- **Unknown fields.** They are ignored everywhere (the reader rule in `session-identity.ts`). A future narrowing field must bump the file version instead.
- **Expiring.** `isExpiring` also covers a `'session-end'` grant within 10 min of its 7-day decay.
- **Ended state.** An ended grant (`expired`/`revoked`) must carry `endedAt`.
- **Engine.** `matchesScope`: a folder scope tests `target.folder`, a path scope tests `target.path`. No-target resolution sets `path = folder = homeFolder`.

### C4 Activity — `activity-log.ts`, `activity-log-fs.ts` (Slice 1, lane C)
```ts
export type ActivityLane = 'conduit' | 'observed' | 'note';
export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'expired' | 'withdrawn' | 'asked' | null;
export interface ActivityEntry {
  v: 1; id: string; at: string; lane: ActivityLane;
  principal: { handle: string | null; sessionId: string | null; machineId: string | null };
  cli: CliKind | null; action: string; target: string | null; summary: string | null;
  decision: Decision | null; decidedBy: string; outcome: ActivityOutcome; durationMs: number | null;
  requestId: string | null; count: number | null;          // count: hourly bucket rows only
}
export const COUNTED_TOOLS: readonly ToolName[];             // list_sessions, list_agents, wait_sessions, read_inbox
export const ACTIVITY_RETENTION_MS = 30 * 86_400_000; export const ACTIVITY_MAX_BYTES = 50 * 1024 * 1024;
export interface ActivityIo { append(day: string, line: string): void; list(): Array<{ day: string; bytes: number }>; remove(day: string): void;
  readArgs(): string | null; writeArgs(text: string): void }
export interface ActivityLog {
  record(e: Omit<ActivityEntry, 'v' | 'id' | 'at'>): string;     // returns id; counted allow rows aggregate per session per hour
  recordAskArgs(requestId: string, args: unknown): void;          // 24 h TTL
  flushCounts(all: boolean): void;   // all=false: finished hours only (timer); all=true: every bucket (service stop)
  purge(): void; writable(): boolean;
  recentDenies(): ReadonlyMap<string, ActivityEntry>;            // last 200 deny rows by id, for allowOnce
}
export function createActivityLog(deps: { io: ActivityIo; now(): number; newId(): string; warn(m: string, e?: unknown): void }): ActivityLog;
export function createActivityIo(dir: string): ActivityIo;       // <dir>/activity/YYYY-MM-DD.jsonl, ask-args.json
```
- **Write failure.** A failed append sets `writable() === false` and logs one warning. The next append that succeeds first writes a `lane:'note', action:'gap'` row covering the unwritten span.
- **Counted rows (review S1-C).** A bucket is keyed by the whole principal (handle, sessionId, machineId), the action, the outcome and the UTC hour. Its row is stamped `at` = the start of that hour and written to that hour's day file. `record()` returns the bucket row's id, assigned when the bucket is created.
- **ask-args.json** is `{version:1; asks: Record<requestId,{at,args}>}`, judged with `judgePersistedVersion('conduit-mcp/activity/ask-args.json')`. If the file is corrupt, newer or unreadable, the ask store is read-only for the process: warn once, never overwrite it.
- **Retention.** `purge()` deletes day files older than 30 days. It then deletes the oldest files until the total is 50 MB or less. Today's file is never deleted, since it is the one being appended to, so today alone can exceed the cap.

### C5 Observed parsers (Slice 1, lane C)
```ts
// src/codex-rollout.ts (add)
export type CodexAction = { kind: 'command'; command: string; cwd: string; exitCode: number | null; durationMs: number | null }
  | { kind: 'file-change'; paths: string[] } | { kind: 'mcp'; server: string; tool: string; durationMs: number | null };
export function rolloutActions(line: unknown): CodexAction[];
// src/claude-tool-actions.ts (create)
export type ClaudeAction = { kind: 'command'; command: string; cwd: string | null } | { kind: 'file-change'; paths: string[] }
  | { kind: 'mcp'; server: string; tool: string };
export function claudeActionsFromPostToolUse(payload: Record<string, unknown>): ClaudeAction[];  // drops mcp__conduit__* (already a Conduit row)
```
Neither parser ever copies output, `aggregated_output`, `content`, `tool_response` or arguments.

### C6 Migration and editor projection (Slice 2, T2.1)
```ts
// policy-migration.ts
export interface LegacyPolicy { global: GlobalPolicy; byCli: CliPolicyLayers; sessions: Array<{ sessionId: string; layer: PolicyLayer; cli: CliKind | null }> }  // cli = cliKindOfHandle(handle), today's layer key
export function migrateLegacyPolicy(legacy: LegacyPolicy): Pick<PolicyFile, 'assignments' | 'migratedFrom' | 'notes'>;
// policy-projection.ts
export function projectLegacyLayer(state: PolicyState, point: AssignmentPoint, lower: AssignmentPoint | null): PolicyLayer;
export function applyLegacyPatch(state: PolicyState, point: AssignmentPoint, lower: AssignmentPoint | null, tool: ToolName, patch: ToolPolicyPatch): Assignment;
```
- **Migration is exact by construction.** For each layer it first tries Lead with `onScreenOnly: true` and no exceptions. It keeps that only if `effectiveRule` equals today's `resolvePolicy` result for all 23 tools and every field. Otherwise it writes Worker plus one anywhere-scoped exception per field that differs.
- **What "today" means for each layer.** Today's value for a session is `resolvePolicy(tool, {session: layer, cli: byCli[cli], global})`. For a kind it is `resolvePolicy(tool, {cli: byCli[k], global})`, and for the default `resolvePolicy(tool, {global})`. The migrated assignment's effective rules (anywhere scope) must equal those for every tool and field, because an assignment replaces the lower points wholesale.
- **Exceptions.** There is one exception object per tool, holding every field that differs (an exception is per action, §4.1). The label counts exception objects, plus 1 for `onScreenOnly`.
- **Projection (DN-2).** `projectLegacyLayer(state, point, lower)` returns, per tool and field, the effective value at `point` only where it differs from the effective value at `lower`. Access is mapped allow→on, ask→ask, deny→off. Below `lower = null` sit Worker's rules. For a session, `lower` is the `cli:<handle kind>` point if it has an assignment, else default; for a kind it is default; for the default it is null. This reproduces today's field-by-field "inherit" display.
- **Legacy patches.** `applyLegacyPatch`: a value sets that field in the tool's anywhere exception. `'inherit'` removes the field, and an empty exception is removed. A point with no assignment yet starts as a copy of `lower`'s assignment (same profile, anywhere exceptions, `onScreenOnly`), so only the patched field changes.
- **What gets migrated.** The global layer migrates to the default assignment only when it differs from the defaults. The CLI layers become kind assignments, and the session layers become session assignments.
- **The on-screen offer.** `notes.onScreenOnlyOffered` lists the session ids that got Lead with `onScreenOnly`. CON-25 shows the one-time offer from it.

### C7 Composer — `policy-service.ts` (Slice 2, T2.2)
```ts
export interface PolicyServiceDeps { dir: string; now(): number; newId(): string; setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void; warn(m: string, e?: unknown): void; legacy(): LegacyPolicy; onChanged(): void }
export interface PolicyService {
  start(): void; stop(): Promise<void>;
  decide(input: Omit<PolicyInput, 'now'>): PolicyDecision;   // also touches a matched grant, consumes a matched override
  visibleTools(p: Principal, masterOn: boolean): ToolName[];
  setAssignment(point: AssignmentPoint, profileId: ProfileId | null): { ok: true } | { ok: false; error: 'unknown-profile' | 'read-only' };
  applyLegacyPatch(point: AssignmentPoint, tool: ToolName, patch: ToolPolicyPatch): { ok: true } | { ok: false; error: 'read-only' };
  createGrant(choice: GrantChoice, p: Principal, tool: ToolName, target: PolicyTarget, requestId: string | null): Grant | null;
  revokeGrant(id: string): boolean;
  allowOnce(activityId: string): { ok: true } | { ok: false; error: 'not-found' | 'not-overridable' };
  sessionEnded(sessionId: string): void;
  activity: ActivityLog;
  ui(): PolicyUiState;
}
```
- **Load and migration.** `start()` reads `policy.json` and `grants.json`. A missing `policy.json` runs `migrateLegacyPolicy(deps.legacy())` and writes it. Legacy keys are never read again and never deleted.
- **Writes and timers.** Writes are coalesced atomically through `atomicWriteFile` at 250 ms. A 60 s timer runs `grants.tick()` and `activity.flushCounts()`, and once an hour `activity.purge()`.

### C8 Renderer seams (Slice 2/3, serial claims)
`src/conduit-mcp/ui-types.ts` adds `policy: PolicyUiState` to `McpUiState`:
```ts
export interface PolicyUiState {
  profiles: Array<{ id: ProfileId; name: string; builtIn: boolean }>;
  sessions: Record<string, { profileId: ProfileId; profileName: string; exceptions: number; source: 'session' | 'cli' | 'default'; label: string | null }>; // label "Lead +1" when non-default
  grants: Array<Grant & { expiring: boolean }>;
  legacy: { global: PolicyLayer; byCli: CliPolicyLayers; sessions: Record<string, PolicyLayer> };   // DN-2 projection
  readOnly: boolean;
}
```
`src/protocol.ts` additions. Each is forwarded by `electron/main.ts:4085-4097` and accepted by `isMcpMessage` (`server/services.ts:382-388`):
- `{type:'mcp:setAssignment'; requestId; point: AssignmentPoint; profileId: ProfileId | null}`, answered by `{type:'mcp:policyResult'; requestId; ok: true} | {…; ok: false; error: string}`
- `{type:'mcp:setPointPolicy'; requestId; point: {kind:'default'} | {kind:'cli'; cli: CliKind}; tool: string; patch: unknown}`, answered by `mcp:policyResult`
- `{type:'mcp:revokeGrant'; requestId; grantId}` and `{type:'mcp:allowOnce'; requestId; activityId}`, both answered by `mcp:policyResult`
- `{type:'mcp:permissionAnswer'; requestId: string; answer: PermissionAnswer}`, answered by the existing `mcp:requestResult`
- Existing `mcp:setToolPolicy` keeps its shape and result. It now routes to `applyLegacyPatch({kind:'session'})`.

### C9 Permission requests (Slice 3)
- **Types** (`request-types.ts`): `RequestKind` gains `'permission'`, `RequestSource` gains `'policy'`, and `RequestOutcome` gains `'allowed' | 'denied'`. `AnswerInput` gains `grant?: GrantChoice`. `RequestRecord` gains `permission: { tool: ToolName; why: string; targets: PolicyTarget[]; lateGrant: Grant['id'] | null } | null`.
- **Queue** (`request-queue.ts`):
  - `createBound(stamp: Stamp, fields: Pick<RequestRecord,'title'|'body'|'permission'>, expiresAt: string): RequestRecord` is uncapped and has no default.
  - `answerLate(id: string, grantId: string): RequestAnswerResult` works only on an `expired` permission. It records `permission.lateGrant` and never changes the state.
  - `validateAnswer` accepts `allowed` with an optional `grant`, or `denied` with an optional `reason`, for `permission` only.
- **Service** (`request-service.ts`):
  - `createPermission(sessionId, fields, expiresAt): RequestRecord`
  - `endPermission(id, end: 'answered' | 'expired' | 'withdrawn', answer: AnswerInput | null, reason: string | null): void`
  - `onPermissionAnswer` dep: `(r: RequestRecord, a: PermissionAnswer, by: AnsweredBy) => Promise<RequestAnswerResult>`. `answerFromRenderer` hands `permission` records to it instead of answering directly.
- **call-flow** (`call-flow.ts`). `ask()` creates the request (askId = requestId) and still emits `mcp:ask` and `mcp:askClosed` exactly as today. The card is unchanged. Card answers map as follows:
  - `approve` → `allowed`
  - `deny` → `denied`
  - `always` → `allowed` + grant `{who:'session', on:'anywhere', for:'session-end'}`
- **Re-decide at answer time.** `decide()` runs again before anything executes:
  - A new deny withdraws the request (`withdrawnBy: 'conduit'`, reason = `reasonText`), and the call returns `tool_disabled` with that reason.
  - A late answer with a grant creates the grant, calls `answerLate`, and appends the notice "You can retry <tool> now" to the requester's inbox through the CON-21 hidden late-answer thread path. It never runs the call.

## Seams with CON-27 (agreed with claude-22, lead-approved, 2026-11-14)
1. `src/contracts/remote-principal.ts` is created **byte-identical** on both branches: `Capability = 'messaging'|'monitor'|'drive'`, `Capabilities`, `RemotePrincipal {kind:'remote'; handle; machineId; trust:'own'}`, `principalAddress`. C1's remote principal becomes `RemotePrincipal & { capabilities: Capabilities }`; C1 drops its own `Capability` type and `remoteSessionId`. Orchestrate tools are denied to remote principals until `orchestrate` joins `Capability` (v1).
2. NET enforces the capability floor at its inbound boundary. POL's floor (d) stays as a second check on `principal.capabilities`, which the composer fills from NET's `capabilitiesOf(machineId)`; null or false means deny.
3. NET's `AuditSink.record` takes a closed union of its 11 kinds. The branch that lands second adds `activityAuditSink(log: ActivityLog): AuditSink`, which writes Activity `note` rows with no bodies or keystrokes, and swaps it into NET's composer.
4. NET's `onRevoked(machineId)` hook: the branch that lands second wires it to `GrantStore.peerRevoked(machineId)` (grants → revoked) and to REQ withdrawing that peer's open requests (`withdrawnBy:'conduit'`, "link revoked").

## Producer/consumer map
| Behaviour changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Tool decision | `policyService.decide` (new) | `host.callTool` → `gateToolCall` → `callFlow.runControl`; tool lists (`syncToolLists`) | both |
| Resolved `when/reach/move` | engine `rule` | `gateToolCall` (when), `inReach` in `app-control-tools.ts:181` & `screen-tools.ts:43` via `ControlCallContext` | both. `inReach` keeps reading `ctx.reach` and is unchanged |
| Policy edits | `mcp:setToolPolicy` (dialog), `mcp:setPointPolicy` (settings, replaces `updateServerSettings{mcpToolPolicy*}`), `mcp:setAssignment` | `policyService` | both: T2.4 switches the producers |
| Legacy layers | sessions.json `mcpToolPolicy`, server-settings `mcpToolPolicy(ByCli)` | migration once; editors **today** | both: editors move to `McpUiState.policy.legacy`, migration reads once. Writers stay (dialog no longer calls them). `setMcpToolPolicy` in `session-manager.ts:325` loses its last caller and is deleted in T2.3 |
| Ask lifecycle | `callFlow.ask` → `requestService.createPermission` | card (`mcp:ask`, `asksSnapshot`, `askClosed` via `server/mcp/index.ts:155-168`), `McpUiState.requests` (DN-3), Activity | both |
| Answers | card `mcp:askAnswer`, new `mcp:permissionAnswer` | `callFlow.answerPermission` | both |
| Grants | `policyService.createGrant` (answers) | engine step 3, `PolicyUiState.grants` | both. Share and peer grants are NET's producer, out |
| Session end | `host.onSessionDeleted` (`host.ts:2270-2285`) | `policyService.sessionEnded` → grants expire, session assignment removed | both |
| Activity rows | host (calls, answers), service (grants, overrides), domain → services → host (observed) | disk only (no reader in MVP; e2e reads files; CON-25 adds the view) | producer only. The consumer is CON-25's, and this is stated, not assumed |
| Codex actions | rollout file (Codex) | `codexWatch.onAction` (new dep beside `onSignal`, `codex-rollout-watch.ts:27`) | consumer only. The producer is not ours: an ambiguous or no bind gives a `note` row "Feed unavailable" for that session |
| Claude actions | Claude Code PostToolUse hook | `endpoint.ts` allow-list → `domain.hookPost` → services → host | consumer plus our hook client. A launch without wiring (`host.ts:2140-2160`) gives "No activity feed" |
| `cliKindOfHandle` kind | handle prefix | today's CLI layer | the CLI layer stops using it. Kind now comes from `launchedCli` (POL-D5, DN-5) |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/policy-types.ts` | create | C1 shared types, Node-free |
| `src/conduit-mcp/policy-profiles.ts` | create | built-in profiles, `pointKey`, `effectiveRule` |
| `src/conduit-mcp/policy-engine.ts` | create | `decide`, `visibleTools`, `assignmentFor`, `matchesScope`, `reasonText` |
| `src/conduit-mcp/policy-file.ts` | create | `policy.json` parse/serialize |
| `src/conduit-mcp/grant-store.ts` | create | grant lifecycle, decay, expiry |
| `src/conduit-mcp/activity-log.ts` | create | rows, hourly counts, gap marker, recent denies, retention |
| `src/conduit-mcp/activity-log-fs.ts` | create | day-file JSONL io, ask-args file |
| `src/codex-rollout.ts` | modify | add `CodexAction`, `rolloutActions` |
| `src/claude-tool-actions.ts` | create | PostToolUse → `ClaudeAction[]` |
| `src/conduit-mcp/policy-migration.ts` | create | v0.64 layers → assignments |
| `src/conduit-mcp/policy-projection.ts` | create | assignment ⇄ legacy layer for the old editors |
| `src/conduit-mcp/policy-service.ts` | create | composer: load, migrate, persist, decide, grants, activity, ui |
| `src/conduit-mcp/tool-policy.ts` | modify | `gateToolCall` takes `{decision, rule}`. `resolvePolicy` callers are replaced; `resolvePolicy` stays for migration |
| `src/conduit-mcp/host.ts` | modify | principal and targets, service wiring, activity on every call, renderer routes, session end |
| `src/conduit-mcp/policy-targets.ts` | create | tool args → `PolicyTarget[]` (real paths via injected resolver) |
| `src/conduit-mcp/ui-types.ts` | modify | `PolicyUiState`, `McpUiState.policy` |
| `src/protocol.ts` | modify | C8 messages |
| `electron/main.ts` | modify | forward C8 messages (case list only) |
| `server/services.ts` | modify | `isMcpMessage`, domain → mcp observed forwarding |
| `src/contracts/session-identity.ts` | modify | `SERVER_FILE_VERSION` entries |
| `src/session-manager.ts`, `server/domain/index.ts` | modify | delete `setMcpToolPolicy` path (last caller gone) |
| `webview/components/mcp-tools-dialog.tsx`, `webview/components/settings-modal.tsx`, `webview/app.tsx` | modify | read `mcp.state.policy.legacy`; settings posts `mcp:setPointPolicy` |
| `webview/use-conduit-mcp.ts` | modify | `setPointPolicy`, `setAssignment`, `answerPermission` posts |
| `src/conduit-mcp/request-types.ts`, `request-args.ts`, `request-file.ts`, `request-queue.ts`, `request-service.ts` | modify | C9 |
| `src/conduit-mcp/call-flow.ts` | modify | ask → permission request, re-decide, late grant |
| `src/contracts/hook-protocol.ts`, `server/mcp/endpoint.ts`, `src/claude-hook-settings.ts`, `src/claude-signals.ts`, `resources/conduit-mcp/conduit-hook.cjs` | modify | PostToolUse event; the client strips `tool_response`/contents and reads up to 4 MiB for this event only |
| `server/domain/codex-rollout-watch.ts`, `server/domain/index.ts` | modify | `onAction` dep, skip replay, forward observed |
| `test/fixtures/claude-hooks/post-tool-use-*.json`, `test/fixtures/codex-rollout/actions.jsonl` | create | measured, scrubbed fixtures (T0.2) |
| `test/unit/policy-*.test.ts`, `grant-store.test.ts`, `activity-log*.test.ts`, `claude-tool-actions.test.ts`, `codex-rollout-actions.test.ts` | create | per task |
| `test/e2e/policy-profiles.e2e.mjs`, `policy-permission-requests.e2e.mjs`, `activity-observed.e2e.mjs` | create | host/IPC proof |
| `test/e2e/conduit-mcp-policy.e2e.mjs`, `conduit-mcp-policy-migrate.e2e.mjs` | modify | "Always" now a grant; migration to profiles |
| `CHANGELOG.md` | modify | Unreleased lines |

## Scripts
None. Nothing repeats enough to be worth a script; the fixture scrub in T0.2 is a one-off done by hand.

## Slices

### Slice 0: Contracts and fixtures (orchestrator)
**Check:** `npx tsc --noEmit -p .` exits 0. Fixtures parse as JSON.
- T0.1: merge the CON-21 tip. Write `policy-types.ts` (C1 minus `GrantChoice` and `PermissionAnswer`) on the lane base branch `con24-s1-base`.
- T0.2 (done: async hook measured, see the run report): fixtures are **scrubbed of home paths, tokens, account and user ids, and file contents** before commit; grep the files for `/home/`, `namemenima`, `account`, `token` and `creator_` before staging. Record a real Claude Code 2.1.325 PostToolUse payload. Run `claude -p` in a scratch folder with a `--settings` hook that tees stdin; this is a CLI, no GUI. Capture Bash, Edit and an MCP call, scrub them, and save as `test/fixtures/claude-hooks/post-tool-use-{bash,edit,mcp}.json`. Also write a scrubbed 6-line Codex `actions.jsonl` covering CommandExecution, FileChange and McpToolCall. If the PostToolUse shape doesn't carry `tool_name`/`tool_input`, stop and report to the lead before Slice 1 lane C.

### Slice 1: Pure core
**Check:** `npx vitest run test/unit/policy-engine.test.ts test/unit/policy-profiles.test.ts test/unit/policy-file.test.ts test/unit/grant-store.test.ts test/unit/activity-log.test.ts test/unit/activity-log-fs.test.ts test/unit/codex-rollout-actions.test.ts test/unit/claude-tool-actions.test.ts` passes, and so does `npx tsc --noEmit`. `npm run verify` exits 0 after each lane merge (fallow-safe placement, see Verification).
**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3

#### Task 1.1 (lane A): built-in profiles and engine
**Files:** create `policy-profiles.ts`, `policy-engine.ts`; test `test/unit/policy-profiles.test.ts`, `test/unit/policy-engine.test.ts`.
**Produces:** C2. **Consumes:** C1; `TOOL_SPECS`, `TOOL_NAMES`, `CliKind` from `tool-policy.ts`.

Failing tests first:
- 'worker equals today's defaults': for every tool, Worker's rule equals `TOOL_SPECS` defaults mapped.
- 'lead allows open_terminal off screen (POL-D3/D4)': `decide` gives `allow` with `rule.when === 'always'`.
- 'master off denies everything with floor master-off'.
- 'local to-you send_message passes an observer deny (floor c)'.
- 'explicit deny beats a matching grant'.
- 'one-use override passes a deny once for its exact target' and 'override never passes a floor'.
- 'grant beats assignment ask'; 'suspended or expired grant is ignored'.
- 'session assignment beats kind beats default'; 'kind assignment ignored when launchedCli is null'.
- 'narrower scope wins; exact tie goes stricter'.
- 'multi-target takes strictest'.
- 'remote own peer with no assignment asks on orchestrate and never applies when'.
- 'remote principal without the capability is denied with floor remote-capability'.
- 'onScreenOnly forces viewing'.
- 'no-target action matches home folder scope'.
- 'every decision has exactly one reason'.
- 'visibleTools hides unconditional denies only'.
- 'reasonText reads "allowed by Lead (session)" and "Ask: Worker (default for codex)"'.

#### Task 1.2 (lane B): policy file and grant store
**Files:** create `policy-file.ts`, `grant-store.ts`; test `test/unit/policy-file.test.ts`, `test/unit/grant-store.test.ts`.
**Produces:** C3. **Consumes:** C1.

Failing tests:
- 'round-trips a policy file'; 'corrupt → corrupt, version 2 → newer'.
- 'session-end grant expires at sessionEnded and after 7 days unused'; 'touch resets decay'.
- '1h grant expires at its time'; 'revoke sets revoked and endedAt'.
- 'tick purges expired after 24 h'; 'isExpiring under 10 min'.
- 'grantWhoFor cli returns null for a non-launched session'.
- 'grantScopeFor target picks session scope for a session target and path scope otherwise'.

#### Task 1.3 (lane C): Activity log and observed parsers
**Files:** create `activity-log.ts`, `activity-log-fs.ts`, `src/claude-tool-actions.ts`; modify `src/codex-rollout.ts` (add only); test `activity-log.test.ts`, `activity-log-fs.test.ts`, `codex-rollout-actions.test.ts`, `claude-tool-actions.test.ts`.
**Produces:** C4, C5. **Consumes:** C1; fixtures from T0.2.

Failing tests:
- 'counted tools aggregate per session per hour, denies still get rows'.
- 'failed append marks unwritable and the next success writes one gap row'.
- 'ask args purge after 24 h'.
- 'purge removes days older than 30 and oldest beyond 50 MB'.
- 'recentDenies keeps the last 200'.
- 'codex command row has the joined command, cwd, exit code, no output'.
- 'codex file change lists paths only'.
- 'claude Bash gives the command; Edit gives the path; mcp__conduit__ is dropped'.
- 'no parser output contains any fixture content or output string' (searches the serialized result for the fixture's content values).

### Slice 2: Engine in the host; migration; editors
**Check:** `npm run verify` exits 0. `npm run e2e:remote -- policy-profiles conduit-mcp-policy conduit-mcp-policy-migrate conduit-mcp-refusals conduit-mcp-control conduit-mcp-control-terminal`, then `--affected`, all PASS.
**Parallel groups:** G1: T2.1 · G2: T2.2 · Serial: T2.3, then T2.4
**Claims (serial lane):** `src/conduit-mcp/host.ts`, `src/conduit-mcp/tool-policy.ts`, `src/conduit-mcp/ui-types.ts`, `src/protocol.ts`, `electron/main.ts`, `server/services.ts`, `src/contracts/session-identity.ts`, `src/session-manager.ts`, `server/domain/index.ts`, `webview/use-conduit-mcp.ts`

#### Task 2.1: migration and projection
**Files:** create `policy-migration.ts`, `policy-projection.ts`; tests `test/unit/policy-migration.test.ts`, `test/unit/policy-projection.test.ts`.
**Consumes:** C2 `effectiveRule`, `BUILT_IN_PROFILES`; `resolvePolicy`, `PolicyLayer`, `GlobalPolicy`, `CliPolicyLayers`, `ToolPolicyPatch` from `tool-policy.ts`. **Produces:** C6.

Failing tests:
- 'all-on override becomes Lead with onScreenOnly and resolves identically for all 23 tools' (the core of acceptance "Upgrade keeps behaviour").
- 'partial override becomes Worker + one exception per changed field'.
- 'default-equal global layer writes no default assignment'.
- 'CLI layer becomes a kind assignment'.
- 'projection of Lead+onScreenOnly reproduces the original all-on layer'.
- 'applyLegacyPatch inherit removes the exception'.

#### Task 2.2: policy service
**Carried from Slice 1 reviews (do first):**
- (a) One copy of no-target resolution. Export `resolveTarget(target: PolicyTarget, principal: Principal): PolicyTarget` from `policy-profiles.ts`; `policy-engine.ts` and `grant-store.ts` both call it, and their private copies are deleted.
- (b) C1 `PolicyDecision` gains `grantIds: readonly string[]`: every grant that allowed a target. The service touches all of them, so a used grant never decays.
**Files:** create `policy-service.ts`, `policy-targets.ts`; tests `test/unit/policy-service.test.ts`, `test/unit/policy-targets.test.ts`.
**Consumes:** C1–C6 (signatures repeated in the brief). **Produces:** C7, plus `resolveTargets(tool: ToolName, args: Record<string, unknown>, deps: { sessionById(id): {id; cwd: string | null; projectId: string | null} | null; realPath(p: string): string | null; handleToId(h: string): string | null }): PolicyTarget[]`.

Failing tests:
- 'missing policy.json migrates from legacy and persists once'.
- 'newer policy.json → readOnly, never written'.
- 'decide touches a matched grant and consumes an override'.
- 'sessionEnded expires grants and drops the session assignment'.
- 'allowOnce on a floor deny → not-overridable'.
- 'activity write failure keeps local decisions working'.
- 'resolveTargets: close_session(handles) → one target per session; attach_folder → real path; open_url → []'.

#### Task 2.3 (serial): host wiring
**Files:** modify `host.ts`, `tool-policy.ts`, `ui-types.ts`, `protocol.ts`, `electron/main.ts` (case list), `server/services.ts` (`isMcpMessage`), `session-identity.ts`, `session-manager.ts` + `server/domain/index.ts` (delete `setMcpToolPolicy`); tests: update `conduit-mcp-host.test.ts`, `conduit-mcp-tool-policy.test.ts`, `session-manager.test.ts`, `server-mcp-wiring.test.ts`.
**Call sites changed:**
- `resolveFor` (`host.ts:1217-1228`) → `policyService.decide`.
- `gateToolCall` (`tool-policy.ts:429`, sole caller `host.ts:1356`).
- `setSessionPolicy` callers `host.ts:1247` (card "always", replaced in Slice 3; until then it calls `createGrant`) and `host.ts:2419`.
- `syncToolLists` (`host.ts:1691`) → `visibleTools`.

Every tool call writes one Activity row with the decision, `reasonText`, outcome and duration. `request_input` rows carry `requestId` (POL-D17). Build the principal from `runtime.defAdapter` (`launchedCli`), `Session.cwd` and `Session.projectId`.

#### Task 2.4 (serial): editors read the projection (DN-2)
**Files:** modify `mcp-tools-dialog.tsx`, `settings-modal.tsx`, `app.tsx` (props at `:5564-5572`), `use-conduit-mcp.ts`; tests: update `mcp-tools-dialog.test.tsx`, `settings-mcp-tools.test.tsx`.
- The dialog's `session.mcpToolPolicy` → `mcp.state.policy.legacy.sessions[id]`.
- `global`/`byCli` → `policy.legacy.global` / `byCli`.
- Settings edits post `mcp:setPointPolicy` instead of `update({mcpToolPolicy…})`.
- No visual change.

**e2e** `test/e2e/policy-profiles.e2e.mjs` (orchestrator writes):
1. Seed `sessions.json` with an all-on v0.64 override. `McpUiState.policy.sessions[id].label === 'Lead +1'` (DN-1). A Worker-equal tool call resolves as before.
2. `mcp:setAssignment` Lead on claude-3. It opens a session with `focus:false` while off screen: no ask, an Activity row "allowed by Lead (session)", and the new session has `label === null`.

### Slice 3: Permission requests
**Check:** `npm run verify` exits 0. `npm run e2e:remote -- policy-permission-requests conduit-mcp-policy asks-no-window requests-agent`, then `--affected`, PASS.
**Parallel groups:** G1: T3.1 · Serial: T3.2
**Claims:** `call-flow.ts`, `host.ts`, `request-service.ts`

#### Task 3.1: queue knows `permission`
**Files:** `request-types.ts`, `request-args.ts`, `request-file.ts`, `request-queue.ts`; tests `request-queue.test.ts`, `request-args.test.ts`, `request-file.test.ts` (existing names).
Failing tests:
- 'createBound expires at its time to expired, never a default'.
- 'answerLate only on an expired permission'.
- 'allowed/denied valid only for permission'.
- 'permission record round-trips the file'.

#### Task 3.2 (serial): ask becomes a request
**Files:** `call-flow.ts`, `request-service.ts`, `host.ts`, `use-conduit-mcp.ts` (`answerPermission`); tests `conduit-mcp-call-flow.test.ts`, `request-service.test.ts`.
Failing tests:
- 'ask creates one permission request whose id is the askId'.
- 'card always → session-end anywhere grant'.
- 'policy turned deny while waiting → withdrawn by conduit, call tool_disabled'.
- 'policy turned allow while waiting does not run until answered'.
- 'late allowed+grant creates the grant, posts a retry notice and never runs'.
- 'cap 3 waiting asks per caller unchanged'.
- 'a waiting permission ask counts once in waitingAsks/awaitingApproval and the tray count while absent from requests.open' (DN-3).
- 'ask and answer each write an Activity row; raw args only in ask-args'.

**e2e** `test/e2e/policy-permission-requests.e2e.mjs`:
1. Worker codex-2 `close_session(claude-4)` with no answer → `approval_timeout`, and claude-4 is still open.
2. `mcp:permissionAnswer {outcome:'allowed', grant:{who:'session', on:'target', for:'1h'}}` → retry closes claude-4, and the Activity row's `decidedBy` starts "allowed by grant".
3. An exception `close_session: deny` on codex-4 refuses → `mcp:allowOnce(rowId)` → the retry closes claude-5, and a second target is refused.
4. `mcp:revokeGrant` on step 2's grant → its state is `revoked` in `McpUiState.policy.grants`, and the next close asks again.

### Slice 4: Observed lane
**Check:** `npm run verify` exits 0. `npm run e2e:remote -- activity-observed auto-resume-codex-session-log auto-resume-claude-resumes-after-reset`, then `--affected`, PASS.
**Parallel groups:** G1: T4.1 · G2: T4.2 · Serial: T4.3
**Claims:** `server/domain/index.ts`, `server/services.ts`, `host.ts`

- **T4.1 Claude hook.**
  - Files: `hook-protocol.ts`, `endpoint.ts` (`HOOK_EVENTS`), `claude-hook-settings.ts` (PostToolUse, matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*`, **`async: true`** — measured: sync adds the client's ~60 ms per call; async adds nothing to the agent's path), `claude-signals.ts` (case → `[]`), `conduit-hook.cjs` (for PostToolUse only: read ≤ 4 MiB, drop `tool_response` and every `content`/`new_string`/`old_string` field, then post). Update `claude-hook-settings.test.ts`.
  - Failing tests: 'PostToolUse is allowed by the endpoint'; 'hook client strips tool_response and contents' (`test/unit/conduit-hook-client.test.ts`).
- **T4.2 Codex watch.**
  - Files: `codex-rollout-watch.ts` (`onAction(sessionId, CodexAction)` dep, skips the replay read, reports `onFeed(sessionId, 'unavailable')` on an ambiguous or no bind after the 30 s bind window); test `codex-rollout-watch.test.ts`.
  - Failing tests: 'replay emits no actions'; 'new item_completed emits one action'; 'ambiguous bind reports unavailable'.
- **T4.1b Claude feed-gap check (lead condition on the async hook).** An async PostToolUse post can be lost without Conduit knowing. On each `Stop` hook (sync, already delivered), the host reads the transcript (`transcript_path`), counts the `tool_use` entries since the previous Stop whose tool names match the PostToolUse matcher, and compares that with the PostToolUse posts received for the session over the same span. A shortfall writes one `note` row ("Feed gap: N actions not reported"). The reader is `src/claude-transcript-tools.ts` (`countMatchedToolUses(jsonl: string, sinceUuid: string | null): {count: number; lastUuid: string | null}`), tested against a scrubbed transcript fixture.
- **T4.3 (serial) wiring.**
  - `server/domain/index.ts` passes `onAction`/`onFeed` and a PostToolUse branch in `hookPost`, then forwards through `server/services.ts` to `host.recordObserved(sessionId, action | {feed:'unavailable'})`. The row reads `lane:'observed'`, `decidedBy:'observed: decided by <CLI>, not Conduit'`.

**e2e** `test/e2e/activity-observed.e2e.mjs`:
1. A Conduit-launched fake codex appends CommandExecution and FileChange items to its rollout (the `auto-resume-codex-session-log` helper pattern). Two observed rows show the command and the path, and the activity files contain neither the output nor the contents.
2. A fake Claude posts a PostToolUse through the hook client → one observed row.

### Slice 5: Close-out (orchestrator)
- **CHANGELOG** (Unreleased):
  - Profiles replace per-tool overrides; existing leads become "Lead +1" with no behaviour change.
  - "Always for this session" now creates a grant that ends with the session or after 7 days unused.
  - Activity log.
- **Run report** at `docs/runs/2026-11-14-CON-24/report.md`.

## Verification
- **Fallow-safe placement (lead process note 1).** Test files are fallow entry points (`.fallowrc.json`), so an export is flagged only when nothing references it, not even a test. Two consequences:
  - Every lane must leave **each new export referenced** by its own tests or by merged code. The lane runs `npm run fallow:check` before handing back.
  - A type lives with its first consumer. `GrantChoice` lives in `grant-store.ts` (S1-B), `PermissionAnswer` in `request-types.ts` (S3), `PolicyUiState` in `ui-types.ts` (S2).
- **`policy-types.ts` placement.** It contains only what the engine consumes. It is committed on a lane base branch `con24-s1-base`, not on the feature branch. Lanes A, B and C fork from that base, and lane A's merge carries it.
- **Merge order in S1:** A first, then B and C. Each merge must reach verify exit 0. A red verify stops the slice.
- **Per task:** the lane's named unit tests, red first, then `npm run verify:quick` in the lane worktree.
- **Per merge** (one lane at a time): `npm run verify; echo "exit=$?"` on the merged tree.
- **Per slice:** the slice's remote e2e names, then `--affected`. Run ids go to the lead.
- **Locally:** at most one scenario by exact name, only on a quiet machine.

## Deviation rule
If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source. A lane reports to the orchestrator, which fixes the contract. A change to C1 or a locked decision goes to the lead first.

## Decisions (resolved by the lead, 2026-11-14)
- **DN-1:** Lead +1. The spec's text is fixed on this branch.
- **DN-2:** projection via `McpUiState.policy.legacy`. Editor edits become exceptions, with no visual change, and the editors stay visible.
- **DN-3:** `permission` stays out of `RequestsUiState` (the Needs you panel) until CON-25. **Waiting permission asks still count** in the status bar's Needs you count and in the tray, through `McpUiState.waitingAsks`/`awaitingApproval` and the CON-21 tray count. Nothing may drop out of a count; T3.2 has the test.
- **DN-4:** floor (e), `answer_request` and `escalate_request` move to REQ v1. Noted in the spec.
- **DN-5:** apply POL-D5, plus one `note` Activity row per migrated kind assignment.
- **DN-6:** a relaunch keeps the grant; only closing or deleting the session ends it.
- **DN-7:** revoke and remote-lead scenarios are covered by engine unit tests only; `revokePeer` is left for NET.
- **DN-8:** matcher plus measurement. **If the hook adds more than about 20 ms per call at the median, stop and report to the lead before S4 ships.**
- **DN-9:** the own-permissions box is not built.
