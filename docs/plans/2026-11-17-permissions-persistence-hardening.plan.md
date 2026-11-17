# Permission persistence security hardening — implementation plan

Requirements: lead security review .autoloop/evidence/security-review-2728a52d.md M1/M2 before next slice; include m1/m2/m5/m7 and safe parts of m4. Own commit, red-first. **Tier:** FULL. **Base:** e09d93c3a78cfe797a8126b5fe83bc43a76b8a41, merged-tree full verify0. **Spec:** docs/specs/2026-11-14-policy-and-permissions.md. New human widening still never retries automatically. Owner main audit exception19f64745 is explicit separate integration, not a feature gate change.

## M1: restrictive state survives recoverable IO failure/restart
- Keep separate pendingConservativePolicy/pendingConservativeGrants flags. A failed tightening candidate remains active in memory even if the store is read-only; never publish a failed widening candidate.
- A failed writable tightening sets pending flag and exposes saveError with active-here/not-saved meaning. Retry ONLY current conservative snapshot on bounded250ms/1000ms/5000ms schedule, at most3 retries per outage. Timer success clears flag/error; exhausted attempts leave explicit error and manual Retry. A new failed human widening candidate is never retained and never scheduled. Repeated mutations in the same outage do NOT reset the retry budget; only a successful save ends/reset that outage.
- stop clears timers and always attempts each writable pending conservative snapshot once, regardless of prior saveErrors. Never overwrite corrupt/newer read-only files. If still unavailable, warn/error remains; software cannot promise persistence through permanent storage failure/process death with no successful write.
- Reconcile on load and when authoritative peer facts become available: expire grants referencing deleted session/target/anchor, including kind grants anchored to missing session; revoke peer grants whose peer is confirmed unpaired. Ordinary time/7-day decay runs at load before decisions/UI. Unknown peer source during startup is not treated as unpaired.
- PolicyServiceDeps.hasSession(id):boolean and peerKnown(id):boolean|null are required injected owner facts (null means network not ready). Host delegates sessions.get and NetworkPort.hasPeer; remote projection no-write service has no sessions/grants and explicit unknown peers. No handle parsing/inference.
- LinkStore.peerKnown(id):boolean|null is the owner fact: current record true; tombstone false; absent on valid/missing baseline false; absent after newer/corrupt baseline null until a successful canonical store write establishes current baseline. Unreadable store fails network initialization, so unavailable NetworkPort is null. NetworkPort.hasPeer delegates this method; no inference from get(id) alone. Never label an unavailable link store confirmed-unpaired. Existing own offline peers count known. Host network-change callback invokes service.reconcilePrincipals() when current facts are ready. No new agent/wire capability.
- PolicyEditResult failure may carry applied:'tightening'; this states effect without pretending disk success. Host always rechecks waiting calls after revoke attempts where tightening may have applied, including network revoke. Error message/snapshot says restriction active here, saving pending; never not-found for IO failure.

## M2: no newly-created grant after refused answer
- Move commitAnswered BEFORE c.grant in local answer continuation. A consume/commit failure returns refusal without creating a new grant. A later grant write failure may leave a one-use consume spent (conservative existing cancel semantics), but never a live new grant/partial batch or executed action.
- Add PolicyCommitResult={ok:true;overrides:OneUseOverride[]}|{ok:false;error:'policy-changed'|'save-failed'|'too-large'|'read-only'}. Change existing PolicyService.commit and CallFlow ControlCall commit/commitAnswered contracts and actual host/test callers. No boolean/global-saveError inference of why commit failed. Tool/owner messages distinguish policy change from persistence failure.
- Preserve initial held-override semantics, grant batch all-or-none and final normal-policy recheck. Remote false-success receipt companion remains explicitly pending; this correction never credits it fixed.

## m5: always settle local owner receipt
ControlCall.grant returns the actual GrantBatchResult including created grant IDs. Add PolicyService.revokeGrants(ids:readonly string[]):PolicyEditResult as one conservative batch and ControlCall.revokeCreatedGrants(ids):PolicyEditResult callback; exact newly-created IDs only, never prior grants. If any post-grant settlement throws before execution, revoke that new batch in memory and persist with M1 pending retry/stop semantics before refusing receipt. A rollback write failure remains visibly revoked here/not saved and cannot leave active newly-created authority in memory.

Wrap answer continuation so a throw in reDecide/commit/grant/settle producer resolves the receipt refused before propagating the exception. Every path removes receipt; no action after thrown continuation; do not swallow error. If cleanup itself throws, preserve both errors (AggregateError) and still resolve/refuse receipt in finally. No retry of typed commit IO failure as though it were a policy-changed race. Cancellation/dispose remain idempotent and don't broaden inflight cancellation. Tests cover each throwing callback, owner reply, no run and no leaked receipt.

## Visible outage and manual Retry consumer (same correction slice)
Create webview/components/permission-store-notice.tsx, a pure component receiving local policy saveError/backupWarning/readOnly plus onRetry():Promise<PolicyEditResult|null>. Mount once app-wide immediately after ServerBanner and before workbench in webview/app.tsx. In-flow banner shrinks workbench, never overlays terminal/topbar or steals focus. Add token-only .permission-store-notice styles in styles.css, status/live region + accessible Retry saving current rules button; readonly disables unsafe Retry, null timeout renders local inline error. Backup warning is distinct from failed primary. No dismiss hiding an active outage.

This is an actual persistent visible consumer even with dialogs closed, not snapshot-only groundwork. Modal full-editor placement remains later; global region remains visible in the app frame. No new profile controls yet. Add component tests for save-error/backup/readonly/pending/retry refusal+timeout and no auto-focus. Extend real Electron persistence E2E to capture/inspect banner during actual grant-store obstruction, click explicit Retry and observe disappearance after recovery; record default+narrow/theme variants with existing harness, never preview/fake host as runtime proof.

## m4/m7: atomic writer guarantees, bounded transient locks
- Extend atomicWriteFileSync options with syncData and retryLockedRename booleans (defaults preserve unrelated callers). PolicyIo opts both in. When syncData, create temp exclusively with fd, write through that fd, fsync data, close BEFORE rename. Namespace unchanged on pre-rename failure. Mode0600 for policy stores.
- Cleanup temp on write/fsync/close/rename failure; ignore only ENOENT cleanup, otherwise retain original+cleanup failure in AggregateError. Original file remains complete; no swallowed failures.
- Retry ONLY locked rename errors EPERM/EBUSY/EACCES on a short bounded10/25/50ms schedule; no retry for other errors and no semantic widening retry. Synchronous wait bounded85ms total. Keep async writer behavior/quit supersession intact.
- Directory-entry fsync after rename has committed-but-not-confirmed semantics that current true/throw PolicyIo cannot represent safely. Do not report failed-with-old-memory after a completed rename. This draft deliberately flushes file data before rename and records power-loss directory-metadata durability as remaining m4 detail for separate typed-commit handling; no claim of full sudden-power-loss guarantee.
- Meaningful real FS tests: failed rename preserves previous bytes and cleans all temp entries; failed partial write/fsync cleans temp; fsync occurs before promotion; transient lock then success bounded; permanent/nonlock error propagates. Mutation makes plain writeFileSync fail new test. Do not alter unrelated writer defaults to force every repository file through new blocking fsync.

## File map
Modify src/conduit-mcp/policy-service.ts, policy-types.ts, policy-file-fs.ts, host.ts, call-flow.ts, remote-policy.ts (required fact callbacks only), remote-routing.ts (hasPeer), server/network/index.ts (fact delegate), server/network/link-store.ts (tri-state peerKnown fact), src/atomic-write.ts, src/protocol.ts only for real result metadata/type changes; webview/app.tsx, webview/components/permission-store-notice.tsx(new), webview/styles.css (in-flow global notice).
Modify test/unit/policy-service.test.ts, conduit-mcp-call-flow.test.ts, conduit-mcp-host.test.ts, atomic-write.test.ts, policy-file-fs.test.ts; test/unit/network-link-store.test.ts and test/unit/network-service.test.ts for authoritative tri-state peer fact; test/unit/permission-store-notice.test.tsx(new). Required PolicyServiceDeps/NetworkPort fixture additions mechanically authorized in existing typed fixtures, retaining assertions. Extend test/e2e/permissions-persistence.e2e.mjs with failed revoke/anchor cleanup→storage recovers→cold restart, and commit-failure+grant answer with zero new grants. Real IO error obstruction, hidden Electron, no arbitrary sleep.

## Checks/topology
One serial mutator. Single-file named suites; grouped under shared lock. Red-first M1 failure recovered before stop+restart and orphan-session/peer load cleanup; pending retry exhaustion/readonly; failed widening never timer-written. M2 commit primary fail creates zero grants, no action, real error. Throwing continuation receipt resolves/refuses and propagates throw. Atomic FS failure asserts old bytes/temp cleanup. Mutation checks core paths. Full verify detached/shared lock on integrated owner-audit baseline; runtime real cold restart; independent code/security confirmation before further source slice.

## Deferred minors/risks
m3 legacy route CAS retirement with UI; m6 throwaway remote token blank/stable owner token with remote controller slice. Directory metadata fsync nuance above disclosed for review. Remote incoming receipt fix remains separate planned companion, no unsafe action currently after failed grant, but wrong success receipt remains tracked.

## Deviation rule
If contract wrong stop and fix owner. No generic boolean adapter, no lost cleanup, no unbounded retry, no discarded read-only tightening, no automatic retry of failed widening. Unplanned source path requires root authorization.

## Workspace and integration
Single active mutator in /home/namemenima/projects/.wt/conduit/CON-25, branch CON-25-permissions-ui. Pre-created isolated worktree, no dependency install/visible GUI or main ref changes. Exact test E2E path belongs integration lane after backend/notice freeze; no concurrent source writers. Gate unchanged; only owner-authorized audit integration19f64745 in baseline. No push except remote temporary refs.

## Producer/consumer callers
PolicyService.commit→host ControlCall callbacks and callAsRemote paths→CallFlow initial/answered commits; update all actual return consumers to typed result. Commit IO errors are not policy-change retries.
PolicyIo→atomicWriteFileSync→filesystem; existing default/async atomic callers keep behavior, policy opts stronger data flush/rename retries. Existing writer tests retain callbacks/quit supersession checks.
LinkStore.peerKnown→NetworkPort.hasPeer→host PolicyServiceDeps.peerKnown→load/network-change reconciliation. Unknown never becomes confirmed deletion.
PolicyService.saveError/backupWarning→PermissionStoreNotice in App→retryPolicy→current conservative snapshot. Real notice caller introduced same slice; no dead component.
Grant batch IDs→CallFlow post-grant failure cleanup→owner revokeGrants→M1 pending tightening→persist/restart. Previous grants untouched.

## Review correction at 4f63abde
The grant owner must roll back exact newly-created IDs if saveGrants publication callbacks throw before IDs return to CallFlow. Factor shared revokeGrants, preserve original/aggregate throwing cleanup errors, apply conservative memory/pending state before failure notification. Tests cover remote listener/onChanged throws, rollback IO outage/recovery/restart, prior grants preserved. PolicyIo consumer test injects only actual node:fs rename failure, requires prior bytes/temp cleanup and fails under plain-write mutation. Authorized correction file map: policy-service.ts, policy-service.test.ts, policy-file-fs.test.ts, CHANGELOG.md and this plan. Real missing E2E remains root integration-owned.

Runtime correction exact coverage: real close_session multi-target Ask with newly persisted override added after initial ask commit; primary policy obstruction during allowed answer with grant refuses receipt/save-failed, no new grant or target closure. Real session-end anchor removal while grants primary obstructed expires memory, recovery writes expired state, cold restart no active authority/anchor. Existing Electron paths only, no debug endpoint.

## Self-review
#1 Coverage: ok — M1/M2 plus selected minor consumers/proofs, deferred items explicit
#2 Placeholder scan: ok
#3 Signature consistency: ok
#4 Placement: ok
#5 Caller scan: ok
#6 Producer/consumer: ok
#7 Handoff arithmetic: ok — one serial source slice plus integration proof task
Self-review: 7/7 applicable.

PLAN: docs/plans/2026-11-17-permissions-persistence-hardening.plan.md
TIER: FULL
SLICES: 1
GROUPS: 1
CLAIMS: src/conduit-mcp/policy-service.ts, src/conduit-mcp/host.ts, src/conduit-mcp/call-flow.ts, src/atomic-write.ts, src/protocol.ts, webview/app.tsx, webview/styles.css
SCRIPT_CANDIDATES: 0
