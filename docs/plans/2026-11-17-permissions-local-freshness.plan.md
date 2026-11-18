# Local prepared permission freshness — implementation plan

**Tier:** LITE. **Base:** 5d39c20f0f25bc4d640b0498ca980105ba08e952. **Architecture:** scoped PROCEED0 in local-prepared-freshness-design-review.md. Rationale: one existing local-control owner surface, no new public seam or engine; exact host/test/E2E paths. Spec docs/specs/2026-11-14-policy-and-permissions.md, current conditions must hold before side effects. Source guard-chain discovery local-prepared-freshness-discovery.md; first actual assertion-red remains required. Incoming remote receipt companion code review is APPROVE0. Start after root dispatch; one serial mutator.

## Locked outcome
Local calls prepared under broader when/reach/move, caller context or gate facts cannot run after those facts narrow/change while async preparation or an ask waits. Fresh denial/floor/current app gate wins; fresh Ask never runs an initially unasked Allow without human consent. Refuse/release stale preparation rather than mutate prepared closure or repeat reservation/IO. Preserve current grant/override persistence, genuine owner Allow semantics, typed IO failures and exact batch rollback. No new policy floor, reach ordering or renderer security rule.

## File map
Modify src/conduit-mcp/host.ts local control setup/commit/reDecide callbacks and private normalized-condition helper shared with remote if actual signature fits. Modify test/unit/conduit-mcp-host.test.ts actual harness regressions. Extend test/e2e/permissions-ui.e2e.mjs with real pending close ask→full assignment reach narrowing→refused owner receipt/no target closure. Modify CHANGELOG.md with a concise current-permission recheck note; this tracked plan is docs/plans/2026-11-17-permissions-local-freshness.plan.md. No call-flow/public types/protocol changes intended; report if actual contract makes those necessary. Remote companion existing checks unchanged. No GUI changes.

## Contracts/owner implementation
- Capture immutable initial normalized {when,reach,move} before prepare, exact scalar copies. Factor private samePreparedConditions(rule,conditions) over strict when/reach/move equality, consumed by both current remote comparison and new local guard; no second helper/serialization trick. PreparedPolicyConditions is Readonly<Pick<PolicyDecision['rule'],'when'|'reach'|'move'>>. Preserve remote semantics in that mechanical factoring. Capture initial principal scalar identity/context (sessionId,handle,launchedCli,homeFolder,projectId) and current runtime launch generation scalar. Do not hold mutable source object as an equality token.
- Private currentLocalDecision(held:readonly OneUseOverride[]=[]):Result<{input:Omit<PolicyInput,'now'>;decision:PolicyDecision}> resolves current principalOf(sessionId), current messagingOn/master, current unknown-machine forceAsk, current ownerWindowOf/windowReady/onScreen/appConnected and current rules. Compare principal/context/generation to prepared capture and original inflight.signal; refuse changed/aborted/unavailable identity. Reuse gateToolCall with fresh decision/current gate callbacks and same actual routed-call predicate. Preserve original resolved targets: refuse a changed principal context instead of re-resolving a different action target from relative raw args.
- Immutable when/reach/move mismatch refuses all control paths before consume/grant/action, even if access rank unchanged. Current forceAsk newly true also refuses old prepared call/card. No simplistic reach partial-order. No public method/export just for tests.
- Refactor existing private commitResolved(input:Omit<PolicyInput,'now'>=policyInput,decision:PolicyDecision=resolved):AskCommit to accept explicit chosen input/decision while existing request/messaging callers retain defaults; preserve current spent-override retry semantics and actual IO error classification. Actual control commit first currentLocalDecision then commit chosen current input/decision. Initially Allow→current Ask refuses; initially Ask→current Ask can create/retain ask; initially Ask→current Allow may run normally when p.alwaysAsk does not require consent. Existing prepared.alwaysAsk behavior remains.
- reDecide(held) uses fresh helper and records current evidence; failures return existing withdraw with accurate reason string. commitAnswered(held) refreshes again before consume/grant (must not rely on captured master/principal or stale reDecided), committing current input/decision while allowing genuine owner-approved Ask. Existing PolicyCommitResult/AskCommit result shapes preserved; where their false union cannot carry gate code, return policy-changed consistently rather than widen/cast a new error. Owner receipt/tool refusal remains explicit and no action.
- For request/messaging tools no asynchronous prepare precedes their existing direct commitResolved, so no broader lifecycle rewrite. Every changed private call site enumerated: local request branch, local messaging branch, runControl.commit, runControl.reDecide, runControl.commitAnswered. Remote path keeps its already checked fresh-principal/conditions contract.

## Tasks and checks (serial)
1. Actual red-first host close regression: caller s1, unrelated target s2, initial close Ask/Always/reachany. Target owner null makes legitimate domain-close path visible via h.closes. Raise original ask, narrow same Ask to reachopened, assert tool remains visible/ask pending, answer Allow once. Desired receipt refusal/no closes/no new grant; current code source predicts closure but record red only after observing. A child may be included for context, not required for visibility. npx vitest run test/unit/conduit-mcp-host.test.ts -t exactcase.
2. Actual red-first async prepare tests via existing kindOf barrier (registered fake open_session, not bare executable alwaysAsk): initial Allow/moveyes/focustrue, change same Allow/moveno before releasing directory check; no opens and reservation released. Separately masteroff during prepare, when:'viewing' caller leaves on-screen during prepare, current principal home/project changes. Fresh Ask after initial Allow also refuses; genuine unchanged Ask answer still succeeds, no regressions to held overrides/IO refusal. Use authoritative harness facts/deps, not mock subject. Mutation removing each relevant freshness guard must fail its assertion; restore.
3. Implement owner fresh helper/factoring to make named tests green. Existing local + remote control/grant/flow tests grouped under lock after source freeze, typecheck/Biome/diff. No test/gate narrowing.
4. Root integration E2E permissions-ui exactone under lock; existing fake agents/typed owner edit path raise pending close request at reachany, persist scoped assignment narrowing toopened, answer original request through permissionAnswer, assert truthful refusal and original target still present. No debug endpoint/artificial runtime prepare barrier. Unit covers deterministic asynchronous-prepare gates. Build real current app; launchElectron hidden; finishScenario/harness cleanup. Full npm run verify direct exit; commit; integrity; fresh independent review + remote permissions-ui/permissions-persistence/net-requests/net-policy. Lead security review before final merge.

## Producer/consumer
Current session/runtime/domain/presence/policy facts → fresh local owner input/gate → commit/reDecide/answer callbacks → existing CallFlow receipt/run/release; all changed sides in host. Existing prepare closures consume original move/reach, so tuple mismatch refuses rather than patching derived target/focus. Existing engine remains policy authority. Existing protocol/UI error rendering unaffected; actual owner refusal route verified via E2E.

## Constraints/deviation
One source mutator after remote companion freeze/approval. Existing worktree/branch, no install/main/push except remote temp refs. Shared lock full/grouped/localexactE2E; no fullgate while others test/build; hidden GUI only. WHY comments, no as-any/swallowed errors/type widening. If planned contract wrong stop/report and fix owner, no shim/fallback/reprepare framework. No new transport/CLI/native mode work in this correction.

## Decisions needed
None; refusal of stale prepared authority is conservative existing-policy enforcement. Hand-started Worker-cap ruling remains separate.

## Self-review
#1 Coverage: ok — local ask/unasked conditions, current gates, context and explicit consent checks
#2 Placeholder scan: ok — no unimplemented new interface or runtime debug seam
#3 Signature consistency: ok — private typed inputs; public IO/CallFlow results unchanged
#4 Placement: ok — existing host/host test/permissions-ui E2E, changelog and this plan
#5 Caller scan: ok — private request/messaging defaults and all control callbacks named
#6 Producer/consumer: ok — actual owner facts feed commit/receipt/run/release together
#7 Handoff arithmetic: ok — one serial slice with four dependent tasks; one group
Self-review: 7/7 applicable.

PLAN: docs/plans/2026-11-17-permissions-local-freshness.plan.md
TIER: LITE
SLICES: 1
GROUPS: 1
CLAIMS: src/conduit-mcp/host.ts,test/unit/conduit-mcp-host.test.ts,test/e2e/permissions-ui.e2e.mjs
SCRIPT_CANDIDATES: 0
