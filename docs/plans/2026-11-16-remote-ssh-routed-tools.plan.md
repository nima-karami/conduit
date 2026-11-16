# Remote over SSH, slice 5: routed session tools (CON-40) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F3/F4, §4.4, §4.5, §4.6, §5.3 `call`/`call.result`, §5.5, §6, §11 S2/S5 rows) **Tier:** FULL
**Builds on:** slices 2–4 merged on `CON-35-remote-ssh` (tip 9d6aa5fe+), plus CON-24's policy engine (merged at efd97325).

## Goal
A lead on controller A uses the six session tools against machine B:
- `list_agents`, `open_session` and `open_terminal` take `{ machine }`;
- `send_input`, `read_screen` and `close_session` take a `handle@machine` address.

A forwards each call in a `call` frame. B runs it under the remote principal `<lead>@<A>`, scoped to that link's controller. Each call is decided twice: A's policy at the origin, then B's floor (default Lead on an ssh-added link). A drop gives `peer_unreachable`, and the call is never replayed. B never routes calls, or sends drive input, toward A.

## Architecture
```
A lead → MCP tool {machine | handle@machine} → host gate (A policy: lead's profile; targets = machine + folder)
       → router (server/network/calls.ts, A side): pending[id], send {t:'call', id, tool, args, principal:{handle}}
B link-manager onFrame → calls.ts (B side) serveCall:
       link must be an inbound ssh controller link (B's record: transport ssh, ssh null), else refuse + audit
       principal := { kind:'remote', handle: frame.principal.handle, machineId: <link's machineId>, controller: true }
       host.callAsRemote(principal, tool, args)   ← B's policy (floor + peer assignment, default Lead)
       → {t:'call.result', id, ok, result | error}
A: resolve pending[id] → tool result (addresses rewritten to handle@B) | error;  link drop → peer_unreachable, never re-sent
```

## Settled decisions — do not re-litigate
- §5.3: `call`/`call.result` `{ id, tool, args, principal }` → `{ id, ok, result | error }`, one result per id. On a drop the caller gets `peer_unreachable`, and the call is never replayed (only messages are).
- §4.6/RS-D4: decided twice; the remote's floor gives the controller **Lead** on an SSH-added link. "Only while on screen" never applies to routed calls.
- §4.5: B never gets `drive` or routed calls on A unless the machine is added the other way round.
- §11 S5: a `call` or `drive` frame from the remote to the controller is refused and audited. S2: a `call` naming any principal other than its link's controller is refused and audited.
- F3: on B, the session is opened as `<lead>@<A>`, with `opened_by` = the lead.
- Asks raised on B for routed calls reach the owner in A's queue: slice 7 (request mirroring).

## Technical decisions this plan makes
1. **Protocol.**
   - `LINK_PROTOCOL.minor = 2`. New frames `call { id, tool, args, principal: { handle } }` and `call.result { id, ok, result?, error? }`, strict-parsed like the others.
   - `tool` must be one of the six. `args` is a JSON object of at most 64 KiB, and the result is capped by the 16 MiB frame limit.
   - A routes only to a peer whose hello reported minor ≥ 2. Otherwise `peer_incompatible`, hint "update Conduit on <machine>".
   - The principal on the wire carries **only a handle**. The machine id always comes from the link, never from the frame.
2. **Remote principal for an ssh controller.**
   - The `Principal` remote variant gains `controller: boolean`: true when B's record for that link is an inbound ssh record (`transport: 'ssh'`, `ssh: null`).
   - Policy changes:
     - `remoteAllows` lets `orchestrate` tools through only when `controller` is true. TLS peers stay denied (CON-27 R21 unchanged).
     - `assignmentFor` uses the **Lead** profile as the default for a controller peer point with no stored assignment, and the existing Worker default (`OWN_PEER_ASSIGNMENT`) for others.
     - `forPrincipal` already makes `when` `always`.
     - `reach: opened` for a remote principal means sessions it opened: `openedBy.machineId === principal.machineId && openedBy.handle === principal.handle`.
3. **Remote opener.** `SessionOpener` gains `machineId?: string`. It is persisted (sessions.json stays v1; the field is optional). The snapshot's `MonitorSession` gains `openedBy: { handle: string; machineId: string | null } | null`. A's remote directory maps an opener whose machineId equals A's own id to A's local session, so `list_sessions` on A shows `opened_by` = the lead (spec F3).
4. **Running a tool as a remote principal (B).** `host.callAsRemote(principal, tool, args): Promise<Result<StructuredOutput>>` runs the same prepare/exec path as `callTool`, with:
   - a `Caller` of `{ handle: '<handle>@<machineId>', sessionId: null, remote: principal }`;
   - **no home folder**, so `open_session`/`open_terminal` require an absolute `path` in B's format; a relative path → `invalid_args`;
   - the policy principal = the remote principal;
   - the owner window = none, so routed calls count as server actions and need no ready window;
   - Activity entries carrying `principal.machineId`;
   - an ask decision on B → `refused`, detail `remote_ask`, hint "this needs the owner on <B>; answer it there" (slice 7 replaces this with mirroring).
5. **Routing on A.**
   - The tool schemas gain an optional `machine` for `list_agents`/`open_session`/`open_terminal`. `send_input`/`read_screen`/`close_session` accept `handle@machine` addresses, replacing `remoteTargetRefusal` for these three tools; `focus_session`/`attach_folder` keep refusing.
   - A's gate runs first, with targets = machine + folder.
   - Routing goes through `NetworkPort.call(machineId, tool, args, principalHandle, signal)`.
   - The result's `handle` is rewritten to `handle@<machine name>`, and `session_id` is passed through as B's id.
   - The timeout is the tool's existing budget, or 60 s for send/read/close, whichever is smaller, plus the MCP cancel signal.
   - The machine must be connected (state up). Otherwise `peer_unreachable`, hint "connect_machine <name> first".
6. **Refusals on A (S5).** A serves no `call` frames from a peer it dialed (an A-side ssh record), and refuses `drive.*` frames from it whatever the capability. Each refusal is audited (`call.refused` / `drive.refused`, rate-limited to one line per link per minute, the existing drive throttle). B refuses a `call` whose link isn't an inbound ssh controller link.

## Out of scope
- Asks mirrored to A (slice 7).
- Files (slices 8–10).
- The UI showing remote session rows under the opener (slice 6; this slice supplies the data).
- `wait_sessions` and messaging are unchanged (already routed via monitor/messaging).

## Contracts (each lands with its first importer)
```ts
// src/contracts/link-protocol.ts
| { t: 'call'; id: string; tool: RoutedTool; args: Record<string, unknown>; principal: { handle: string } }
| { t: 'call.result'; id: string; ok: true; result: Record<string, unknown> }
| { t: 'call.result'; id: string; ok: false; error: { code: string; message: string; retryable: boolean; hint?: string } }
export const ROUTED_TOOLS = ['list_agents','open_session','open_terminal','send_input','read_screen','close_session'] as const;
export type RoutedTool = (typeof ROUTED_TOOLS)[number];
// src/contracts/remote-principal.ts: RemotePrincipal gains controller: boolean
// src/types.ts: SessionOpener gains machineId?: string
// NetworkPort: call(machine: string, tool: RoutedTool, args: Record<string, unknown>, principalHandle: string, signal: AbortSignal): Promise<Result<StructuredOutput>>
// McpNetworkPort: callAsRemote(principal: RemotePrincipal & { capabilities: Capabilities }, tool: RoutedTool, args: Record<string, unknown>): Promise<Result<StructuredOutput>>
```

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/contracts/link-protocol.ts` | modify | the frames, ROUTED_TOOLS, minor 2 |
| `server/network/calls.ts` | create | A-side router (pending, timeout, drop) + B-side serveCall (link check, principal, audit) |
| `server/network/index.ts`, `link-manager.ts` | modify | dispatch `call*` frames; NetworkPort.call; A-side refusal of call/drive from dialed peers |
| `src/contracts/remote-principal.ts`, `src/conduit-mcp/policy-engine.ts`, `policy-types.ts` | modify | `controller`; orchestrate for controllers; Lead default; reach for remote openers |
| `src/types.ts`, `server/domain/*` (opener persistence), `src/contracts/link-protocol.ts` MonitorSession, `server/network/monitor-publisher.ts`, `src/network/remote-directory.ts` | modify | remote opener end to end |
| `src/conduit-mcp/host.ts`, `control-tools.ts`, `screen-tools.ts`, `app-control-tools.ts`, `tool-schemas.ts`, `remote-routing.ts` | modify | callAsRemote; `machine` args and address routing on A |
| `test/e2e/net-routed.e2e.mjs` | create | over fake-ssh (no bootstrap; link.sshAdd, Lead assignment as net-machines does). Lead on A: list_agents{machine} → open_session{machine, agent, path} on B → read_screen / send_input by address → close_session; B shows opened_by; kill the bridge mid-call → peer_unreachable and B ran it at most once; B sending a call frame to A is refused. Runs on the Windows runner. |

## Slices
### Slice 1: protocol, principal, policy (parallel groups G1/G2; file-disjoint)
- **G1:** link-protocol frames, minor 2, parse tests.
- **G2:** RemotePrincipal `controller`, the policy-engine changes, the opener type, the reach rule. Engine tests:
  - a controller peer is Lead by default: open_session allowed, orchestrate allowed;
  - a TLS peer is still denied orchestrate;
  - a controller with a stored stricter assignment follows it;
  - reach opened matches the remote opener only.
- **Check:** `npx vitest run test/unit/link-protocol.test.ts test/unit/policy-engine.test.ts test/unit/policy-profiles.test.ts`.

### Slice 2: B serves calls (after Slice 1)
- `calls.ts` serveCall.
- `host.callAsRemote`, including the absolute-path rule, `remote_ask`, and Activity with machineId.
- Opener persistence plus the snapshot field.
- **Check:** unit tests for serveCall (a non-controller link is refused and audited; a principal handle with `@` or non-printable characters is refused), callAsRemote per tool, and monitor-publisher openedBy.

### Slice 3: A routes calls (after Slice 2)
- `calls.ts` router.
- `NetworkPort.call`.
- Tool args and address routing.
- The A-side refusal of call/drive from dialed peers.
- The directory's openedBy mapping.
- The `net-routed` e2e.
- **Check:** unit tests for the router (timeout, drop → peer_unreachable with no resend, a late result ignored, minor < 2 → peer_incompatible), host routing per tool, and `npm run e2e:remote -- net-routed net-machines net-ssh-link` plus affected.

## Verification
- Per lane: verify:quick, fallow, `rm -rf out`.
- Per merge: `npm run verify`.
- Then e2e:remote affected plus `net-routed`.
- A VM smoke: a real Claude Code lead on A opens a Codex or terminal session on the VM, types into it, reads its screen and closes it, with the link drop tested.

## Deviation rule
If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece becomes the work. Examples: prepare paths can't run without a home folder, or the policy engine has no seam for `controller`. Never a shim, a second copy, a special case, a widened type or a fallback routed around it. The report leads with the fix that keeps the locked decision.

## Decisions Needed
- [normal] An ask on B for a routed call returns `refused`/`remote_ask` until slice 7 mirrors asks to A. Default taken. Under the default Lead floor, none of the six tools asks.
- [normal] Routed results name sessions `handle@<machine name>`, with B's own session id. Default taken.
- [normal] Follow-up, not in this slice: a revoke while B is running a routed call does not stop that call; only its reply is lost. Stopping it would mean cancelling the call's budget from the link's revoke path.
- [normal] Follow-up, not in this slice: `createFromApp` used to drop an opener whose machineId was malformed; it now keeps it as a local opener. Harmless today, but the app path should refuse a malformed machineId outright.
