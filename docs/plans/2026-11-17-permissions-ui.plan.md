# Permissions UI — implementation plan

**Spec:** docs/specs/2026-11-14-policy-and-permissions.md. **Tier:** FULL.

## Goal
Build the approved CON-18 iter-5 permission surfaces on CON-24 machinery; session permissions use a dialog.

## Architecture and data flow
The host remains the authority. Extend the existing policy service with human-only editing/query methods; never duplicate the policy engine in the renderer. Policy snapshots expose complete profiles and assignments. Activity is queried on demand with bounded pagination, separate from frequent state broadcasts. The existing request/answer path owns grant creation and late answers.

UI → useConduitMcp/requestHost → existing WebviewToHost protocol → host validation → policy service/files → reply + state broadcast → UI.

Dominant attributes: no silent widening; explainability; responsive dense desktop UI. No new dependencies, framework or generic policy repository abstraction.

## Settled decisions
- Use the approved screenshots 00–14, 17–24, excluding guest 15/16/25. Screens inspected in contact sheets recorded in .autoloop/evidence.
- Session settings are a modal dialog. Activity is a centre editor tab reachable from Settings, session dialog and palette.
- Use README recommendations. Launch posture is applied only after an explicit profile application; migration alone must never change launch args. Now/later relaunch choice; never interrupt without a click.
- Keep CON-35 remote asks answerable and remote policy mirrors/conflicts intact.
- Existing Lead allows open_terminal and migrated Lead +1 override stale wireframe cells.
- Built-ins read-only, duplicate creates custom profile. Unknown/self-reported kind cannot acquire Lead through kind assignment.
- Grants default to session/target/session-end. Late consent only creates a rule; never executes an expired call.
- Explicit deny override only through recorded Why row; floors never overridable.
- Existing tokens, English strings following existing app patterns, locale time formatting, literal handles and tool names. No content in Activity.

## Spec staleness
CON-24 shipped engine/profiles/grants/audit writer in v0.67.0; neither Activity read queries nor full profile editing nor native profile launch mode exists in the baseline. The spec's earlier behaviour table is historical. CON-35 has remote answer/editing; read-only remote wireframe state is superseded. Grounding references: .autoloop/evidence/code-map.md and ground.md.

## Global constraints
All new source names kebab-case, React components PascalCase, types concrete; comments explain why or cite spec. No as-any, swallowed errors, specificity escalation or !important. Workspace is the pre-created isolated /home/namemenima/projects/.wt/conduit/CON-25 branch CON-25-permissions-ui, base a280cdf2. One active builder at a time because protocol/host/hook/app/styles are shared entry files. Do not install or delete linked dependencies. Full gate under flock /tmp/claude-1000/conduit-gate.lock; remote E2E has no lock. All launches use launchElectron and finishScenario, Linux headless only.

## Contracts, first milestone
- PolicyUiState.profiles becomes Profile[]; add assignments: Array<{point: AssignmentPoint; assignment: Assignment}>; existing legacy/session/grant/readOnly fields remain. emptyPolicyUi and remote projections supply the same shape.
- ActivityIo adds read(day: string, maxBytes: number): string; update real FS, noActivity and every typed test fixture. FS only accepts ISO date names; never permit path traversal.
- ActivityLog.query(input: ActivityQuery): ActivityPage; define node-free types in src/conduit-mcp/activity-query.ts. ActivityQuery fields optional: sessionId, cli, machineId, decision, action, lane, since, before (cursor), limit. ActivityPage {rows: ActivityEntry[]; next: string|null; writable:boolean; error:string|null}. Cursor must preserve equal timestamp rows via timestamp/id composite; max 200 rows; default 100; scan at most retained 30 days and ACTIVITY_MAX_BYTES based on pre-read file sizes, rejecting oversized days with explicit error before reading; return newest first; pending current-hour buckets included without flushing/persisting duplicates. Malformed persisted row/read error becomes explicit error, never silent empty success. No ask args in response.
- Protocol mcp:activity:get {requestId:number, query:ActivityQuery} → mcp:activity {requestId:number,page:ActivityPage}; validate all filters, bounded values and cursor at host. This is owner renderer only, never MCP.
- Existing setAssignment/revokeGrant/allowOnce service and protocol semantics remain unchanged in this slice. New full assignment/profile mutations are moved to milestone 2, where persistence acknowledgement and stale-editor protection will be designed together before exposing editable UI.
- Hook exposes getActivity(query):Promise<ActivityPage|null>, setAssignment(point,profileId,machine?):Promise<boolean>, revokeGrant(grantId,machine?):Promise<boolean>, allowOnce(activityId):Promise<boolean>.
- Human edits in later milestone require expected assignment/profile compare-and-swap, and a persistence failure source through the service; a successful accepted-in-memory legacy reply must not be labelled durably saved. Approved failure/revert behaviour remains in scope.


## Producer/consumer map
| Behaviour | Producer | Consumer | Touches |
|---|---|---|---|
| Full editable policy snapshot | policy-service.ui, remote-policy.uiOf | Settings/session profile UI | both; preserve legacy consumers |
| Activity history | existing record/count writer, activity-log-fs | new query, Activity UI | reader and pending bucket projection; writer schema unchanged |
| Profile/assignment edits | human controls, host validation | existing engine, tool lists, waiting asks | both; recheck/sync on edit |
| Consent | approval-card/request-template | existing permissionAnswer and grant store | UI + metadata projection; lifecycle unchanged |
| Native posture | explicit profile selection | launch args, session own-mode display | later milestone both sides |
| Non-default badges/refusals | policy snapshot, Activity | session rows/header and Why | both |

## File map — milestone 1
| Path | Action | Responsibility |
|---|---|---|
| src/conduit-mcp/activity-query.ts | create | node-free query/page shapes and cursor/filter helpers |
| src/conduit-mcp/activity-log.ts | modify | bounded persisted+pending Activity query |
| src/conduit-mcp/activity-log-fs.ts | modify | safe day reading |
| src/conduit-mcp/policy-types.ts | modify | full editable snapshot |
| src/conduit-mcp/policy-service.ts | modify | full policy snapshot |
| src/conduit-mcp/ui-types.ts | modify | empty snapshot |
| src/conduit-mcp/remote-policy.ts | modify | snapshot and noActivity compatibility |
| src/protocol.ts | modify | owner query/edit messages |
| electron/main.ts | modify | forward owner Activity query through existing mcp.fromRenderer boundary |
| src/conduit-mcp/host.ts | modify | trust boundary validation and dispatch |
| webview/use-conduit-mcp.ts | modify | typed request/reply methods |
| test/unit/activity-query.test.ts | create | query ordering/filter/cursor/corruption tests |
| test/unit/activity-log.test.ts | modify | query fixture and pending counts proof |
| test/unit/activity-log-fs.test.ts | modify | read safety and persistence proof |
| test/unit/policy-service.test.ts | modify | full snapshot |
| test/unit/conduit-mcp-host.test.ts | modify | owner query validation/read path |
| test/unit/remote-policy.test.ts | modify | snapshot fixture compatibility |
| test/e2e/permissions-ui.e2e.mjs | create (later integration) | real host query/edit/UI proof |

## Authorized fixture compatibility additions for slice 1
The required ActivityIo.read, PolicyUiState.assignments and ConduitMcpApi methods require mechanical fixture updates. These paths were explicitly authorized before editing; existing behaviour assertions stay intact: test/unit/message-compose.test.tsx, test/unit/message-thread-request-link.test.tsx, test/unit/messages-pane.test.tsx, test/unit/right-pane-remote-changes.test.tsx, test/unit/right-pane-review-kebab.test.ts, test/unit/workbench-chrome.test.ts, test/unit/settings-mcp-tools.test.tsx. Existing ActivityIo fixtures in listed policy/host/log tests receive the bounded reader.

## Slices and topology
One serial group G1, no simultaneous mutators; conductor owns architecture, naming and integration. Baseline gate runs before first mutation. Existing isolated worktree avoids dependency duplication.

### Slice 1: owner policy/Activity API
Task 1.1: add real day reader and node-free Activity query/page contract. Assertion-red test: newest order and session filters omit unrelated rows; malformed day/cursor rejected.
Task 1.2: query persisted days plus current buckets without writing, stable pagination with tied timestamps, no raw args. Tests: pending read count appears once, cursor has no duplicates, corrupt row returns explicit error.
Task 1.3: full profile/assignment snapshot. Tests: builtin full rules exposed, custom profiles and session/CLI/default/peer assignments projected as defensive copies, legacy unchanged.
Task 1.4: Electron forwarding, host query IPC and renderer hook query/existing mutation methods. Tests: malformed query refused, response exposes sanitized Activity only; existing mutations remain on their current validated paths.
**Check:** flock /tmp/claude-1000/conduit-gate.lock npx vitest run test/unit/activity-query.test.ts test/unit/activity-log.test.ts test/unit/activity-log-fs.test.ts test/unit/policy-service.test.ts test/unit/conduit-mcp-host.test.ts test/unit/remote-policy.test.ts (this multi-file command takes the lock; single-file invocations need none); npm run typecheck. Full gate and runtime checks at slice integration.
**Parallel groups:** G1: 1.1–1.4 serial.
**Claims:** src/protocol.ts, src/conduit-mcp/host.ts, src/conduit-mcp/policy-types.ts, webview/use-conduit-mcp.ts.

## Later milestones (detail after API slice teaches its actual seams)
2. Add grant extend/renew and five-second revoke Undo service producers. Design and implement transactional policy edits with expected-value conflict checks and durable failure semantics, then session dialog + profile/assignment/grant Settings, grant extend/renew and five-second revoke Undo service producers, custom editor, migration note, non-default badges, own remote machine assignment page. Replace old tool settings entry; preserve machine conflict affordances. Add exception editor and check-request path.
3. Extend producer with recorded structured historical decision trace/targets and replay evaluation, then Activity editor tab + filters, observed lane, Why trace, one-use override, exception from event/replay, refused entry links, gaps/errors/loading/empty/pagination. No fake traces: show historical recorded reason, label current evaluation separately when unavailable.
4. Permission body why/deny-reason/deny-for-session, who/on/for picker, expired next-time, narrow inline picker, existing remote answers. Own-mode launch application and honest observed/unknown/drift states.
5. Headless runtime acceptance coverage, independent review, full verify, remote E2E, final commit and report.
These milestones cover every in-scope screen, with screens 17/22 tested against current remote behaviour. No guest capabilities or shares.

## Scripts
One one-off /tmp/con25-contact-sheet.py (--source,--output) builds design/runtime inspection sheets. No production scripting required.

## Verification and done
Behaviour tests red first, then mutation confirmation on fixes. Visual fidelity uses captured baseline before replacement plus headless screenshot inspection. Full verify once per integrated slice with direct exit artifact and shared lock; remote E2E for changed host/IPC and full relevant permissions regressions. Snapshot hashes in .autoloop/gate-baseline.txt prohibit weakened existing checks. Never claim success from a piped command. Independent read-only review and real runtime QA are required before final delivery. Commit on assigned branch only, no push except remote runner refs.

## Deviation rule
If a task assumption is wrong, stop the task and fix the misaligned piece as the work; report to conductor. Never a shim, second copy, special case, widened type, fallback or derived-leaf patch around the semantic source.

## Decisions Needed
None beyond the brief's authorized README recommendations. Record any newly discovered unresolved behaviour before proceeding.

#1 Coverage: ok — detailed first milestone plus explicit remaining approved surfaces
#2 Placeholder scan: ok
#3 Signature consistency: ok
#4 Placement: ok
#5 Caller scan: ok — query and edit methods receive hook callers in same slice
#6 Producer/consumer: ok
#7 Handoff arithmetic: ok — five milestones, one detailed slice, one serial group
Self-review: 7/7 applicable.

PLAN: docs/plans/2026-11-17-permissions-ui.plan.md
TIER: FULL
SLICES: 1
GROUPS: 1
CLAIMS: src/protocol.ts, src/conduit-mcp/host.ts, src/conduit-mcp/policy-types.ts, webview/use-conduit-mcp.ts
SCRIPT_CANDIDATES: 1
