# Remote over SSH, slice 11: remote rules (CON-46) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` §4.7, §5.3 `policy.*`, §6 (rules row), §8, §11 S11, RS-D16 · **Tier:** FULL
**Builds on:** CON-24 policy (`src/conduit-mcp/policy-*.ts`), CON-40 routed principals, and the CON-42 link pattern (`server/network/requests.ts`).

## Goal
The owner edits B's permission rules from A. A push lands on B when B is up. When B is down, the edit is kept on A as a draft and pushed on reconnect. If B's rules changed in the meantime, B refuses with `policy_conflict` and keeps its own copy. A also shows B's grants and can revoke them. B validates every pushed doc and stays the only enforcer.

## Architecture
```
A (controller)                                   B (remote; owner of its rules)
remote-policy store  ◄── policy.changed {rev, doc, grants} ──  policy-service (rev, remoteDoc)
 per machine: rev, doc, grants,                  on link up (full) + coalesced 250 ms on change,
 draft {baseRev, doc} | null, status             to inbound ssh controller links only
 edit = in-memory PolicyService over the doc
 push ── policy.push {id, baseRev, doc} ──────►  validate (caps + parse) → rev == baseRev ?
      ◄─ policy.pushed {id, ok, rev | error, current?}   store atomically, rev+1, recheck asks : policy_conflict + current
 revoke ─ policy.revoke {id, grantId} ────────►  revokeGrant (audited, by remote)
```
- **B is the sole writer** of its rules and grants. A never stores B's doc as authoritative. It holds a mirror (`rev`, `doc`, `grants`) plus at most one draft per machine.
- **`policy.changed` is an idempotent snapshot**, like `request.mirror`. It carries the full portable doc and B's live grants, so a separate `policy.pull` isn't needed (see staleness).
- **Pushes are call-like:**
  - pending by `id`, 30 s timeout;
  - a drop gives `peer_unreachable`, and the draft stays;
  - **never replayed**: a draft is pushed again only by the reconnect rule below.
- **Reconnect rule (A):** a snapshot arrives from a machine that has a draft, and the draft's `baseRev` equals the snapshot's `rev` → A pushes the draft once. A different rev → status `conflict`, no push.

## Settled decisions — do not re-litigate
- RS-D16 / §4.7: rules live on B, edited from A, pushed when connected. B's copy wins until a push succeeds. Nothing merges silently. Grants stay where they were made, and revoking one from A is a push.
- §8: B validates every doc. A compromised controller can do on B only what B's policy allows.
- CON-40: the controller-at-Lead floor default. A remote never holds `fleet` (engine-enforced, untouched here).

## Technical decisions
1. **Portable doc = `RemotePolicyDoc`** (`src/contracts/remote-policy.ts`): `{ profiles: Profile[]; assignments: Array<{ point: { kind: 'default' } | { kind: 'cli'; cli: CliKind } | { kind: 'peer'; machineId: string }; assignment: Assignment }> }`.
   - Session assignments and one-use overrides reference B-local session ids, so they never travel. A push keeps them untouched on B.
   - Caps, enforced on B:
     - doc ≤ 256 KiB serialized;
     - ≤ 64 profiles and ≤ 256 assignments;
     - names ≤ 80 characters, printable (the CON-27 rule);
     - ≤ 64 exceptions per assignment;
     - scope paths ≤ 1024 characters.
   - Validation reuses policy-file's guards (`isProfile`, `isAssignmentEntry`). Export them; don't copy them. A failing doc is refused `invalid_args`, with the first failing path in the message.
2. **Revision.** `policy.json` gains an optional `rev: number`. Version stays 1, because unknown fields already survive.
   - `rev` increments on every change that alters the portable projection: setAssignment on a non-session point, setPointPolicy, a profile change, or a push. A missing `rev` reads as 0.
   - Grants carry no rev. They ride on every snapshot.
3. **Frames, protocol minor N.** N = 4 if this lands before CON-43's fs frames, else 5. It's agreed with claude-25: whichever merges second takes the next minor. `POLICY_MIN_MINOR = N`.
   - `policy.changed { rev, doc: RemotePolicyDoc, grants: RemoteGrantView[] }`
   - `policy.push { id, baseRev, doc }`
   - `policy.pushed { id, ok: true, rev } | { id, ok: false, error: { code, message, retryable }, current?: { rev, doc } }`
   - `policy.revoke { id, grantId }` → answered by `policy.pushed`, reusing the shape.

   `RemoteGrantView` = `{ id, tool, who: string (display), on, for, createdAt, expiresAt, lastUsedAt }`, with no targets beyond the grant's own `on`. The parse is strict, per link-protocol conventions.
4. **Who may do what:**
   - B serves `policy.push`/`policy.revoke` only from an inbound ssh controller link (`isInboundController`). Others are refused `not_controller` and audited.
   - B sends `policy.changed` only to those links.
   - A accepts `policy.changed`/`policy.pushed` only from links A dialed (`not_dialed`).
   - Minor gate: below N, no snapshot; a push gives `peer_incompatible`.
5. **Applying on B** (`policy-service.applyRemoteDoc(baseRev, doc, machineId)`):
   - validate;
   - `baseRev !== rev` → `{ ok:false, code:'policy_conflict', current }`;
   - else replace profiles plus non-session assignments, `rev+1`, flush (atomic, last-good as today), `flow.recheck()` so waiting asks are re-decided (POL §5.2);
   - audit `policy.pushed {machineId, rev}`.

   While `readOnly` (newer or corrupt file), refuse `policy_unavailable`.
6. **Editing on A** (`src/conduit-mcp/remote-policy.ts`).
   - Each edit for machine M runs on an **in-memory PolicyService** loaded from M's draft, or else from its mirrored doc. It reuses every existing edit op and its validation, with no second implementation; `policyIo`, `lastGoodIo` and `grantsIo` are memory io.
   - The result's portable projection becomes M's draft `{ baseRev: <rev the edit started from>, doc }`.
   - M up → push now. M down → status `waiting`.
   - Drafts persist in `<userData>/remote-policy.json` (v1, `SERVER_FILE_VERSION` entry; `{ version:1, drafts: Record<machineId, {baseRev, doc, editedAt}> }`), atomic write. A missing file means no drafts.
   - Statuses: `applied` | `pushing` | `waiting` | `conflict` (with B's `current`) | `refused` (B's message).
   - Conflict actions:
     - "use B's" discards the draft;
     - "re-apply on top" rebases the draft's `baseRev` to B's current rev and pushes the draft doc. The owner explicitly chose to overwrite; B's copy stays until then.
7. **Host and renderer surface.**
   - `mcp:setAssignment`, `mcp:setPointPolicy` and `mcp:revokeGrant` gain optional `machine?: string` (machineId). Absent means local, as today.
   - New `mcp:remotePolicy { machine, action: 'discard' | 'reapply' }`.
   - `McpUiState.policy` gains `machines: RemotePolicyUi[]` = `{ machineId, name, state, rev, status, policy: PolicyUiState (from the in-memory service), conflict: PolicyUiState | null }`.
   - **Machine picker:** the settings MCP tab (`McpToolPolicyRows`) gets a machine select ("This machine" plus connected or drafted machines). The selected machine's `PolicyUiState` feeds the same rows, and edits send `machine`. A status line shows applied / waiting for <name> / conflict, with the two buttons.

## Spec staleness
- §5.3 lists `policy.pull`. Measured: the snapshot `policy.changed`, sent on link up and on change, already carries everything a pull would. A pull frame would have no caller (fallow), so it isn't built.
- The map found no Permissions panel. The profile editor and grant list don't exist in the renderer yet; only the tool rows in Settings do. The picker goes there.

## Producer / consumer
- **B rules change.** Produced by policy-service ops, the push, and B's own GUI. Consumed by the engine (unchanged), and by `policy.changed` via `onRemoteDocChange`. Both sides are in L2/L3.
- **Grants.** Produced by B's ask flow (CON-42 L5 peer grants) and `createGrant`; consumed by B's engine and A's mirror. A's revoke is consumed by B's `revokeGrant` (L2/L3).
- **A drafts.** Produced by host edits with `machine`; consumed by the push and the UI (L4, L5).
- **Machine removal on A** (`machines.remove` / link gone) clears that machine's mirror. It keeps the draft file entry until the owner discards it. That's measured as harmless, since drafts are keyed by machineId.

## File map
| Path | Action | Lane |
|---|---|---|
| `src/contracts/remote-policy.ts` | create: RemotePolicyDoc, RemoteGrantView, caps | L1 |
| `src/contracts/link-protocol.ts` | modify: frames, minor N, POLICY_MIN_MINOR | L1 |
| `src/conduit-mcp/policy-file.ts` | modify: export guards, optional `rev`, `validateRemotePolicyDoc` | L2 |
| `src/conduit-mcp/policy-service.ts` | modify: rev bump, `remoteDoc()`, `applyRemoteDoc()`, `onRemoteDocChange()`, `grantsView()`, remote revoke | L2 |
| `src/conduit-mcp/audit-log.ts` | modify: `policy.pushed`, `policy.refused` kinds | L2 |
| `server/network/policy.ts` | create: B sender/server, A receiver/pending pushes | L3 |
| `server/network/index.ts`, `src/conduit-mcp/remote-routing.ts`, `server/services.ts` | modify: dispatch, NetworkPort `pushPolicy`/`revokeRemoteGrant`, McpNetworkPort `remotePolicySink`/policy source, wiring | L3 |
| `src/conduit-mcp/remote-policy.ts` | create: A store, drafts file, in-memory editing, reconnect rule | L4 |
| `src/conduit-mcp/host.ts`, `src/conduit-mcp/ui-types.ts`, `src/protocol.ts`, `src/contracts/session-identity.ts` | modify: `machine` on edits, `mcp:remotePolicy`, `policy.machines`, file version | L4 |
| `webview/components/settings-modal.tsx`, `webview/use-conduit-mcp.ts` | modify: picker, status, actions | L5 |
| `test/e2e/net-policy.e2e.mjs` | create | L5 |

## Contracts pinned for parallel lanes
```ts
// L2 → L3 (B source, via McpNetworkPort, delegating to policyService)
policyDoc(): { rev: number; doc: RemotePolicyDoc; grants: RemoteGrantView[] };
onPolicyDocChange(fn: () => void): () => void;
applyRemotePolicy(baseRev: number, doc: unknown, machineId: string):
  { ok: true; rev: number } | { ok: false; code: 'policy_conflict' | 'invalid_args' | 'policy_unavailable'; message: string; current?: { rev: number; doc: RemotePolicyDoc } };
revokeRemoteGrant(grantId: string, machineId: string): { ok: true } | { ok: false; code: 'not_found'; message: string };
// L3 → L4 (A)
NetworkPort.pushPolicy(machineId: string, baseRev: number, doc: RemotePolicyDoc): Promise<Result<{ rev: number }> & { current?: { rev: number; doc: RemotePolicyDoc } }>;
NetworkPort.revokeRemoteGrant(machineId: string, grantId: string): Promise<Result<null>>;
McpNetworkPort.remotePolicySink(): { apply(machineId: string, snap: { rev: number; doc: RemotePolicyDoc; grants: RemoteGrantView[] }): void; setLinkState(machineId: string, s: 'up' | 'down' | 'gone'): void };
```

## Slices and lanes
- **L1, protocol** (serial, small). Frames, contracts, caps, the parse tests. Check: `npx vitest run test/unit/link-protocol.test.ts`.
- **L2 (B policy service) ∥ L3 (network), file-disjoint.**
  - L3 implements the McpNetworkPort members by delegating to `policyService` through the host's networkPort literal. **Claim: L3 owns host.ts's networkPort() literal lines only.** L2 doesn't touch host.ts.
  - L2 tests:
    - rev bumps only on portable changes;
    - apply on a matching rev replaces profiles and non-session assignments, and keeps session assignments and overrides;
    - a stale rev gives policy_conflict with current;
    - each cap is refused;
    - readOnly gives policy_unavailable;
    - recheck runs.
  - L3 tests:
    - snapshot on up and on change, to controllers only;
    - push or revoke from a non-controller is refused and audited;
    - A ignores snapshots from links it didn't dial;
    - timeout and drop give peer_unreachable with no replay;
    - minor gate.
  - **Mutants (security):**
    - the controller-only serve;
    - the dialed-only accept;
    - the conflict check;
    - a cap check;
    - session assignments surviving a push.
- **L4, A store and host** (after L2 and L3). Tests:
  - an edit while up pushes and shows applied;
  - an edit while down is a draft, persisted, and survives a restart;
  - reconnect with a matching rev pushes once;
  - a mismatch gives conflict, with no push;
  - discard;
  - reapply;
  - revoke routes to B;
  - local edits are unchanged without `machine`.
- **L5, picker and e2e** (after L4).
  - Picker tests (settings-mcp-tools).
  - e2e `net-policy` (fake-ssh, Lead):
    1. A sets B's default point to Observer via `mcp:setAssignment {machine}`. B's snapshot shows rev+1, and a B-local agent's tool now refuses.
    2. Kill the bridge, edit on A → status waiting. B still enforces the old rules. Reconnect → pushed, applied.
    3. Edit on A while down, while B changes its own rules locally → reconnect gives conflict. B keeps its copy; reapply lands.
    4. A peer grant on B is visible on A, revoked from A, and gone on B.

## Verification
- Per lane: under `flock /tmp/claude-1000/conduit-gate.lock`, run `node esbuild.mjs && npm run verify:quick`, then fallow. Finish with `rm -rf out`.
- Per merge: `flock … npm run verify`.
- After L5: `e2e:remote` with net-policy, plus affected.

## Deviation rule
If an assumption turns out wrong, that task stops and the misaligned piece becomes the work. One example: PolicyService can't run on memory io. Never a shim, second copy, widened type, or fallback.

## Decisions Needed
- [normal] `policy.pull` isn't built; the snapshot replaces it. Default taken.
- [normal] Drafts persist on A across restarts. Default taken; the owner's edits shouldn't vanish.
- [normal] "Re-apply on top" overwrites B's newer rules only on an explicit owner click. There's no field-level merge (RS-D16: nothing merges silently).
- [normal] A push changes B's default and per-CLI points too (B's own agents), and peer points. Session-level choices stay B-local.
