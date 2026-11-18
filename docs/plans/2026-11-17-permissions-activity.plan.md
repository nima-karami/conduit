# Activity decision trace and replay implementation plan

**Spec:** `docs/specs/2026-11-14-policy-and-permissions.md` §§4.6, 11–12; `.autoloop/evidence/permissions-activity-next-slice.md`. **Tier:** FULL — multiple host, engine, persistence and IPC boundaries; execution starts after shared lifecycle/editor policy and host integration, with the trace storage group eligible for isolated work once reviewed.

## Goal
Produce truthful historical decisions, restart-safe eligible one-use overrides, and bounded current-policy previews for the Activity consumer.

## Architecture and data flow
The deciding server owns trace capture, storage, validation, replay and override issuance. Extend the existing engine and policy service; neither renderer text nor a second precedence implementation is authoritative. A historical trace is immutable evidence; previews are explicitly current-policy evaluations and do not dispatch or commit.

```text
local or authenticated inbound call -> resolveTargets -> policy service / engine
  -> captured decision + bounded typed facts -> Activity record -> JSONL -> validated query
  -> Why consumer / host lookup by activity id -> current principal + engine recheck
  -> existing durable override save -> agent retries -> new actual Activity row
current typed intent or validated saved facts + proposed full assignment
  -> policy service pure engine evaluation -> labelled result / bounded 7-day sample
  -> existing saveAssignment(point, assignment, expectedToken) CAS on Apply
```

## Settled decisions
- Activity is retained locally on the deciding server; inbound remote rows are never returned to a peer. Observed CLI rows have no Conduit decision and retain existing command-display semantics.
- No arbitrary arguments, commands, typed input, contents, message bodies or raw context in trace. Missing, old, malformed, aggregated or unsupported evidence is unavailable, never reconstructed from `decidedBy`.
- Runtime refusal following policy Allow is a separate recorded outcome; do not infer CLI veto. Floors remain enforced; any below-floor rule is explicitly marked educational, not an executed branch.
- Allow once authorizes an agent retry, never dispatches a past action. Eligible: one exact local target, same currently live session generation, exact matching current explicit deny, and live conditions and floors; no remote override.
- Current draft comparison uses the owner engine and current full assignment CAS; remote receiver-owned policy cannot be simulated from local principal handles.

## Measured state and staleness
- `src/conduit-mcp/activity-query.ts:5–17,47–115` already validates UTC `since`, opaque `(at,id)` cursor, filters and limits 1–200; `activity-log.ts:366–433` scans within 50 MiB and returns explicit failure. No second store or cursor.
- `src/conduit-mcp/host.ts:2033–2072,2302–2327` resolves and records local decisions; `:2570–2676` does likewise for authenticated inbound calls; `:2524` also records a separate remote ask. The final inbound row currently saves the initial decision despite later `freshRemotePolicy` rechecks; capture the actual decisive recheck and its timestamp, retaining the initial ask as its own event.
- `policy-service.ts:784–800,999–1037` remembers only deny target in memory, and its allow-once path does not re-evaluate current policy; after restart it cannot recover provenance. Duplicate detection currently compares session/tool and sessionId/path only. This plan replaces that authority source and tightens equality/eligibility, not the durable save machinery.
- `policy-engine.ts:185–286` returns winner and rule, not an evaluated branch trace. Exact skipped branches and counterfactual cannot be derived from `reasonText`; instrument the existing evaluation path. Engine `when/reach/move` are returned as rules; actual runtime checks occur in host/control flow (`host.ts:2074–2080,2125–2170,2205–2206`), so a policy-only preview must label runtime conditions unevaluated unless facts were actually captured.
- Existing policy drafts are not a single map shared by every context: local assignments are in `PolicyState.assignments` keyed by `pointKey` (`policy-service.ts:218,587–604`); receiver documents and offline drafts live in `remote-policy.ts:182–209,592–689`. Preview must overlay the selected full local assignment in a cloned local state only; no remote draft transplanted into local state.
- Git history includes `58bb3a26` and `130eb133` rechecking current authority, and `0e0586f2` persisting remote drafts. Preserve these checks and remote persistence.

## Contracts — candidate seams for conductor approval
Names below are locked candidate names; fields are allowlisted and are not a serialized `PolicyInput` or `Principal`.

```ts
// src/conduit-mcp/policy-types.ts
export interface DecisionFactsV1 {
  v: 1;
  principal: { kind: 'session'; sessionId: string; launchedCli: CliKind | null;
    generation: number; projectId: string | null }
    | { kind: 'remote'; machineId: string; handle: string; trust: 'own'; controller: boolean;
        capabilities: Capabilities };
  tool: ToolName;
  targets: readonly PolicyTarget[];
  masterOn: boolean;
  toYou: boolean;
  forceAsk: boolean;
}
export interface DecisionTraceV1 {
  v: 1;
  decidedAt: string;
  facts: DecisionFactsV1;
  decision: Decision;
  reason: Reason;
  rule: PolicyDecision['rule'];
  forcedAsk: boolean;
  assignment: { point: AssignmentPoint; profileId: ProfileId; profileName: string } | null;
  runtime: { outcome: 'not-reached' | 'proceeded' | 'refused' | 'unknown'; code: ActivityRuntimeCode | null };
  withoutWinner: { decision: Decision; reason: Reason } | null;
}
// activity-log.ts: ActivityEntry.trace?: DecisionTraceV1; absent for unsupported/aggregate rows.
// policy-engine.ts, pure and never commits:
export function decideWithTrace(state: PolicyState, input: PolicyInput): {
  decision: PolicyDecision; trace: Omit<DecisionTraceV1, 'decidedAt' | 'facts' | 'runtime'>
};
// policy-service.ts, service injects current clock and owns state:
preview(input: DecisionFactsV1, draft: { point: AssignmentPoint; assignment: Assignment | null } | null):
  { ok: true; decision: PolicyDecision; editToken: string } |
  { ok: false; error: 'invalid-value' | 'not-found' | 'read-only' };
replay(draft: { point: AssignmentPoint; assignment: Assignment | null }, expectedToken: string):
  { ok: true; editToken: string; sampled: number; changed: number;
    skipped: { aggregate: number; legacy: number; incomplete: number; remote: number };
    truncated: boolean; since: string } |
  { ok: false; error: 'invalid-value' | 'conflict' | 'unavailable' | 'read-only' };
```

Validation: require canonical UTC timestamp; enum tool/CLI/reason/floor/condition values; exact known keys; control-free IDs and paths at most 512 chars, profile label 128 chars; at most 16 targets; total trace JSON at most 16 KiB. Reject relative paths, NUL, invalid path identities, duplicate ambiguous target identities and malformed fields; sanitize at write and validate at read. If safe facts cannot be represented, omit trace. Parse invalid optional trace as absent, without erasing an otherwise valid legacy row; never use malformed metadata for authority. Explicit allowlist for runtime `code` must be derived from actual typed error codes, not arbitrary messages. `Capabilities`/remote shape must be pinned against `src/contracts/remote-principal.ts` before implementation. Session handle is display-only and never authority; historical paths are not re-resolved from raw args. Restrict exact one-use targets to a single target with non-null `sessionId` or `path`, with all four `PolicyTarget` fields validated and compared; no empty or multi-target override.

Counterfactual: only compute if the exact winning removable exception/grant/override is unambiguously identified, by copying the current decision-time state, removing precisely that winner and invoking the same `decide` with the same facts/time. Otherwise `null`; never disable floor. An exception identity needs engine provenance (assignment point plus exact array index and value at decision time), not `Reason.by === 'deny'` alone. Preserve original historical profile label in trace, never look it up by today's name. For floor, `withoutWinner` is null; any educational underlying result requires an explicitly separate engine API and conductor approval.

Restart lookup must locate the exact persisted row by id using the existing query budget and retention, detect duplicate IDs, reject unavailable/corrupt store, and never accept a target from renderer. Re-fetch live session principal and facts from host; check same session identity/CLI, full exact target, current master and relevant runtime conditions; call engine on current state, require `reason.by === 'deny'` and same denied target. Recheck within synchronous existing `savePolicy` transaction. Persist a consumed activity provenance ID along with the override or equivalent durable CAS marker so the same historical row cannot authorize a second override after restart or consumption. Keep this owner state in the existing v3 policy format introduced by session denials; no new version is needed before either develops a release. In-memory `spent` is insufficient.

Replay: snapshot UTC now once. Factor one bounded visitor out of the existing ActivityLog scanner to share row validation, retention, in-memory aggregate merging and the single 50 MiB physical read budget. Keep the public query limit at 200, but collect a deterministic newest sample of up to 1,001 eligible seven-day entries in one visit. The 1,001st indicates truncation. An invalid row, unreadable day or budget overflow yields unavailable; there is no second scan per page. Count each unsupported row in exactly one skip category; compare engine outcomes under current policy with and without the draft at the *same historical facts and time*, without applying or consuming grants/overrides. Do not infer live reach or screen state. Report changed among evaluated sample, not a population estimate. Current `editToken` must match `expectedToken` before and after evaluation; Apply separately uses existing full assignment CAS. Rows from remote principals are skipped until receiver-side simulation is designed.

## Producer/consumer map
| Behavior | Producer | Consumer | Change |
|---|---|---|---|
| Historical policy evidence | local `host.ts` decision/rechecks and inbound `host.ts` decision/rechecks | Activity store/query, Why | both; remote ask separately recorded |
| Real runtime refusal | `gateToolCall` / control result | Activity Why | capture bounded code separately from decision |
| Aggregation | `activity-log.ts` bucket | timeline, replay | omit trace; skip in sample |
| Observed feed | `claude-tool-actions.ts`, `codex-rollout.ts` | Activity | unchanged; no trace inferred |
| Override | validated saved row + live host principal/conditions | `allowOnce`, durable `savePolicy`, next `commit` | both; no client authority |
| Preview / replay | current service state + validated local draft / historical facts | IPC consumer | pure engine; Apply uses existing CAS |
| Query | `activity-log.ts` | Activity and replay | reuse cursor/budget; no polling on broadcasts |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/policy-types.ts` | modify | trace, facts and preview types |
| `src/conduit-mcp/policy-engine.ts` | modify | instrument actual winner and same-engine counterfactual |
| `src/conduit-mcp/policy-service.ts` | modify | capture, replay, current policy check, durable override transaction |
| `src/conduit-mcp/policy-file.ts` | modify | versioned provenance persistence and validation |
| `src/contracts/session-identity.ts` | modify | persisted policy version only if migration requires it |
| `src/conduit-mcp/activity-log.ts` | modify | bounded trace storage and row lookup |
| `src/conduit-mcp/activity-query.ts` | modify | defensive metadata validation |
| `src/conduit-mcp/host.ts` | modify | local and inbound capture, current facts, IPC handlers |
| `src/protocol.ts` | modify | typed host messages and replies |
| `electron/main.ts` | modify | forward new IPC messages |
| `webview/use-conduit-mcp.ts` | modify | typed producer API to consumer |
| `test/unit/policy-engine.test.ts`, `test/unit/policy-service.test.ts`, `test/unit/policy-file.test.ts`, `test/unit/activity-log.test.ts`, `test/unit/activity-query.test.ts`, `test/unit/conduit-mcp-host.test.ts` | modify | named behavioral fixtures below |
| `test/e2e/permissions-activity.e2e.mjs` | create | restart and actual retry through host IPC |
| `CHANGELOG.md` | modify | user-facing entry when consumer ships |

## Slices and fixture proof
All serial: shared engine, service, schema and host; no file-disjoint parallel group is claimed. Each task starts with the named failing fixture and its single-file `npx vitest run <path>`; implement only after it fails for the intended reason. These are producer slices, with UI consumer and visual acceptance planned by conductor after this seam is locked.

### Slice 1 — historical producer and reader
**Check:** `npx vitest run test/unit/policy-engine.test.ts test/unit/activity-query.test.ts test/unit/activity-log.test.ts test/unit/conduit-mcp-host.test.ts`.
**Serial T1.1:** engine/types: assert explicit scoped deny has the actual assignment and condition rule; grant/override counterfactual equals a direct `decide` after precise winner removal; ambiguous exception gives null; floor cannot be bypassed. Capture decision time at each real evaluation, not row completion. **T1.2:** log/query: round-trip permitted trace across restart; count bucket omits trace; legacy row loads; malformed optional metadata is unavailable; hostile message/argv text never appears in serialized trace. Verify limits and stable cursor on equal timestamps. **T1.3:** host: local recheck changes the captured decisive result; inbound fresh recheck is recorded on receiver and remote ask has its actual decision; runtime refusal after allow stays separate; observed CLI has no trace. Trace unavailable where safe facts absent. Existing callers of `decide` in host at 2071, 2095, 2161, 2238, 2489 and 2591, plus service `commit` at 752, must retain behavior; do not replace rechecks with first decision.

### Slice 2 — restart-safe override
**Check:** `npx vitest run test/unit/policy-file.test.ts test/unit/policy-service.test.ts test/unit/conduit-mcp-host.test.ts`; `npm run e2e:remote -- permissions-activity`.
**Serial T2.1:** persist migration and provenance: old files load; duplicate historical id cannot issue again after restart or after override consumption; failed durable save returns error and does not mark spent. **T2.2:** source exact row from bounded store; current principal mismatch, multi/empty target, changed exception, floor, invalid facts, denied runtime conditions, expired retention and remote rows refuse; exact single local deny succeeds once. Race concurrent issuance and consume calls; no duplicate authority. **T2.3:** host e2e creates explicit deny, records it, restarts host, uses row ID, retries target successfully, retries another target and same row unsuccessfully. The agent itself retries. Test uses `launchElectron` and `finishScenario`; GUI hidden. This task must lock schema migration and live condition ownership with conductor before implementation.

### Slice 3 — pure previews and replay
**Check:** `npx vitest run test/unit/policy-service.test.ts test/unit/conduit-mcp-host.test.ts`.
**Serial T3.1:** preview a safe typed local intent under current selected principal; prove candidate assignment replaces only `pointKey(point)` in cloned current assignment map, does not mutate policy, consume grant/override, touch last-used, or dispatch. Null assignment removes that entry. Unknown principal, invalid point, unsupported target and stale token fail explicitly. **T3.2:** deterministic clock fixture across seven days, more than 1,000 entries, counted and malformed/legacy rows; assert same-fact before/after results, exclusive skipped counters, cursor bounds, truncation and error propagation. No historical liveness guess. **T3.3:** add typed IPC request/reply in `src/protocol.ts`, forwarding in `electron/main.ts`, service handler in host and methods in `webview/use-conduit-mcp.ts`; malformed IPC input fails closed. Existing `mcp:activity:get` and `mcp:allowOnce` callers remain compatible.

## Verification and constraints
Node `^22.22.2 || ^24.15.0 || >=26.0.0`; npm. Run named tests red first and green per slice. Host/IPC changes require remote named e2e. Integrate with `flock /tmp/claude-1000/conduit-gate.lock npm run verify`; record direct exit and remote run id. Never weaken gate. Follow TypeScript sibling naming, existing imports and role placement; comments explain why and point to spec when rationale is documented. UI work must inspect approved screens and use existing tokens; this producer plan does not claim UI completion. No script candidates: no repeated mechanical migration has been specified.

## Deviation rule
If an assumption or signature fails, stop the task and fix the misaligned owner seam; no shim, second engine, widened authority, fallback, or guessed explainer.

## Exact implementation constraints

- Extend the existing undecorated decision result with internal winner provenance, not a second precedence engine. For exception winners retain point, exact index and complete normalized rule and scope. For grants, explicit session denial and overrides retain canonical ID. Only show without-winner when it is unique and removing exactly that record in decision-time state is well-defined; replay the same pure evaluator once using the same captured time and facts. Never remove floors. Use visited decision stages for any explanation of skipped rules; omit unknown provenance.
- Thread call-scoped captured decisions through host local start/current/commit and remote fresh policy, including refused fresh results and the actual service-side commit re-evaluation. A final row's selected evaluation must be the one that authorized or refused the operation, or the result is unavailable. Keep the original Ask event separate. Capture with UTC decision time; do not use terminal event time as decision time. Runtime source distinguishes an eligibility refusal from a result after entering a handler. Only actual typed error-code branches can set its code; do not map arbitrary failure, vendor CLI text or a policy deny to native veto. Historical rows with unsupported target/rule provenance stay readable without trace.
- Resolve a local target to its exact typed authoritative identity before storage; do not include raw command/text, unresolved args or irrelevant caller home in facts. Comparison uses all four normalized target fields including nulls and existing path equality. If the existing engine would need a caller home to evaluate an unresolved target, omit that trace or mark the replay unavailable. No display handle proves authority. Remote snapshot may contain tightly validated trusted link kind, controller fact and three existing capabilities only, and is receiver-owner data. Exclude such rows from local simulation.
- One-use issuance uses dedicated exact lookup of validated Activity id plus recorded UTC at, with the single visitor budget; refuse duplicates, unavailable storage or a known gap. Authenticate C2 owner window of the current local session; require current live generation, same CLI, same master, exact single real target and same explicit deny winner. Reuse the actual pure runtime admission and reach checks for supported tools, including the approved single-target close_session scenario. Require original condition after the override and do not infer action validity from historical flags. Unsupported contexts (new machine, batch, ambiguous source, no target or separately routed call without current trusted facts) remain unoverridable. Never dispatch old arguments. Compare full normalized target identity also at actual engine application and duplicate check. The user’s agent retries normally.
- In the same atomic primary candidate as the one-use override, persist consumed provenance `{id,at}` and a monotone safe expiry watermark. Retain while evidence is within actual 30-day Activity scope, cap active receipts at 4,096 and obey the actual policy byte cap. Refuse when cap hits; never evict a live receipt to authorize reuse. Set cutoff monotonically when pruning, so a wall-clock regression cannot reauthorize an already retired stamp even if disk Activity remains. Validate records and timestamps with the v3 strict scheme. Use the same recovery marker-before-primary path as T1 whenever adding a receipt, so the fallback after lost primary or backup error cannot recover a permissive snapshot missing a committed receipt. Old v2 primary/backup loads as before. Old Activity entries without trace stay unoverridable. Current scope makes process-crash guarantees only.
- `mcp:activity:get` remains the list contract. Add owner review commands for exact row lookup, allowed once, check a request and replay using existing numeric request correlation. Check a request uses an owner-selected session, tool and validated chosen target plus optional full assignment draft; resolve trusted current principal and target in the host. It does not accept saved fact types as input or execute any action. Replay is an estimate under the current policy on captured old facts and time; exclude evaluations requiring unavailable current state, do not consume grants/overrides. Use the existing edit token at preview start and CAS on eventual Apply.

Exact runtime and fixture inventory in .autoloop/evidence/permissions-activity-current-map.md. Material signature seams require independent critique before shared source edits.

## Self-review
#1 Coverage: fixed: scoped this held artifact to producer; UI routing and visual/ARIA remain conductor-owned consumer work.
#2 Placeholder scan: fixed: named explicit unsupported and error cases; unresolved ownership is flagged rather than delegated to executor.
#3 Signature consistency: fixed: distinguished proposed fact type from untrusted IPC; IPC envelope remains a conductor decision.
#4 Placement: ok — all proposed files listed above.
#5 Caller scan: fixed: producer functions first ship with host/service callers in the same slice.
#6 Producer/consumer: ok — local, remote, aggregate, observed, draft and authority paths mapped.
#7 Handoff arithmetic: ok — 3 serial slices, 0 parallel groups, shared paths claimed below.

PLAN: .autoloop/evidence/permissions-activity-plan-held.md
TIER: FULL
SLICES: 3
GROUPS: 0
CLAIMS: src/conduit-mcp/policy-types.ts, src/conduit-mcp/policy-engine.ts, src/conduit-mcp/policy-service.ts, src/conduit-mcp/policy-file.ts, src/contracts/session-identity.ts, src/conduit-mcp/activity-log.ts, src/conduit-mcp/activity-query.ts, src/conduit-mcp/host.ts, src/protocol.ts, electron/main.ts, webview/use-conduit-mcp.ts
SCRIPT_CANDIDATES: 0
