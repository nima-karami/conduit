# Remote over SSH, slice 4: machines and connect tools (CON-39) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.1, §4.2 steps 1 and 6, §4.3 F1/F3, §4.6, §5.1, §5.2, §6, §7, §11 S4 rows) **Tier:** FULL
**Builds on:** slices 2 and 3 (merged on `CON-35-remote-ssh`): `addSshPeer`, `bootstrap`/`link.sshBootstrap`, `SshFailure`, `BootstrapResult`, `controlDir`, `sshArgv`.

## Goal
Agents can `connect_machine`, `list_machines` and `disconnect_machine`, with §5.2's typed errors and hints, inside a 120 s budget. When ssh would prompt, the owner can open a visible needs-person pane, whose ControlMaster the next batch-mode dial reuses. Redials back off to at most 60 s and fire at once on wake. The policy entries (§4.6, RS-D6) are wired once CON-24's profiles are on this branch (Slice 4, gated).

## Architecture
- **One source of truth.** A machine is the existing ssh `LinkRecord` on the controller (`links.json`, slice 2) plus a `machine` metadata block. There is no second registry to drift. Only **pinned** machines are stored.
- **connect_machine.**
  - A known machine is reused when up, else dialled.
  - An unknown ssh target goes through `bootstrap` (slice 3), which pins it.
- **disconnect_machine** closes the connection, clears `enabled` (no redial) and exits the ControlMaster. Remote sessions keep running.
- **Needs-person pane.** It is a normal Conduit terminal session running `ssh -o ControlMaster=yes -o ControlPath=<same dir>/%C -o ControlPersist=8h -- <target>`. Agents only ever get the error and its hint; the owner opens the pane (a C2 method now, the Machines UI in slice 6).

## Data flow
```
agent → MCP connect_machine{machine} → host prepareControl → NetworkPort.connectMachine(machine, signal)
   resolve: name | machineId | ssh target
     known & enabled & up            → { reused:true }
     known (down or disabled)        → enable, redial now, wait up (≤ 30 s)      → result | typed error
     unknown target (passes allowlist)→ bootstrap(target) (≤ 120 s total)       → pins, meta → result | typed error
   errors → toToolError (codes + hints from spec §5.2)
agent → list_machines → NetworkPort.listMachines() → MachineView[] (state, meta, sessions from remote directory)
agent → disconnect_machine{machine} → NetworkPort.disconnectMachine → manager.disconnect(id): enabled=false, close (no `ssh -O exit`: see decision 3)
owner → C2 machines.openNeedsPerson{target} → domain openSession(command = ssh … ControlMaster=yes …)  (visible pane)
manager tick: gap > 3 × tick interval ⇒ wake ⇒ redial every enabled down ssh peer now
```

## Settled decisions — do not re-litigate
- §5.1 tool shapes and §5.2 error codes and hints, verbatim.
- `connect_machine` is idempotent, and concurrent calls share one dial.
- `machine` means a name, a machine id, or an ssh Host.
- `disconnect_machine` never stops remote sessions. An already-down machine is a no-op success; an unknown one is `machine_unknown`.
- Removing a machine is GUI-only (slice 6).
- §7: 120 s budget for `connect_machine`, 30 s for a dial alone. Mode on add is full, with no CLI preselected.
- §4.6/RS-D6 policy rows. §6: two targets that reach one machine id list as one machine.
- Slice 2 per-Host pinning: a second target claiming a known machine id → `identity-conflict`. The hint names the machine it is already added as. Adding the alias is an owner action in slice 6.
- Linger stays as hc leaves it (owner decision pending). `survivesLogout` comes from ensure's measured value (CON-38).

## Technical decisions this plan makes
1. **Machine metadata on the ssh LinkRecord.** `machine: MachineMeta | null`, present on A-side ssh records only. `links.json` goes to v3; v2 records load with `machine: null` and are shown as unknown os until the next bootstrap or connect refreshes it. Bootstrap writes the meta; connect refreshes `version` from the peer hello.
2. **No pending records.** A target that has never pinned isn't stored. A `needs-person` connect leaves nothing behind.
3. **`enabled`** (meta field, default true). False: the dial loop skips the peer and its state shows `disabled`. `connect_machine` sets it true. Disconnect does not run `ssh -O exit` (review CON-39 T1, B2): the owner's needs-person pane shares the ControlPath, and the batch master expires on its own (ControlPersist 60). An explicit add re-enables a disabled machine before its link attaches (review B1).
4. **Wake detection runs on the server**, because powerMonitor is Electron-only. In the manager's existing tick (link-manager.ts:381-387), a tick that arrives more than 3 × its interval late counts as a wake and redials every enabled, down ssh peer now. The CON-27 backoff cap is already 60 s (link-state.ts:56-59).
5. **Resolving `machine`:**
   1. exact machine id;
   2. exact name; an ambiguous name → `machine_unknown` with a hint listing the candidates' ids;
   3. exact ssh target of a record;
   4. otherwise, a value that passes `isSshTarget` is an unknown target to bootstrap;
   5. else `machine_unknown`.
6. **Errors** join `ToolErrorCode` (`src/conduit-mcp/types.ts`): `machine_unknown`, `ssh_needs_person` (detail `reason`), `ssh_unreachable` (retryable), `ssh_auth_failed`, `remote_unsupported` (os, arch), `install_failed` (step; retryable), `identity_changed`, `identity_conflict`.
   - `peer_incompatible` already exists.
   - `bridge_*` and `ssh_failed` map to `ssh_unreachable` with the detail.
   - The hints are spec §5.2's. For example, `ssh_needs_person`: "ask the human to connect <name> once from Machines".
   - One pure mapper owns all of it: `src/conduit-mcp/machine-errors.ts`.
7. **Budget.** `connect_machine` has a 120 s wall clock (an AbortSignal through bootstrap and the dial). On expiry → `ssh_unreachable` with detail `timeout`; the background work keeps going and its result lands in the record. A dial of a known machine waits at most 30 s for `up`.
8. **Policy before CON-24** (if Slice 4 is still gated when Slices 1–3 merge), `TOOL_SPECS` defaults:
   - `connect_machine` access `ask`, with `alwaysAsk` when the target is unknown. That covers RS-D6 under the legacy table.
   - `disconnect_machine` `ask`.
   - `list_machines` `on`, budget show.

   Slice 4 replaces these with the profile rows.

## Spec staleness
- §4.6 assumes POL profiles exist. Measured: this branch has only the legacy `TOOL_SPECS` table (`src/conduit-mcp/tool-policy.ts:131-202`). CON-24 is not on main (origin/main d520f2c7). Hence Slice 4 is gated (question sent to claude-3).
- §5.2 lists the error codes as existing vocabulary. Measured: none of the ssh codes are in `ToolErrorCode` today (types.ts:10-58). Decision 6 adds them.

## Global constraints
Same as slices 2 and 3:
- **Gates:**
  - `npm run verify`.
  - Lanes run `node esbuild.mjs && npm run verify:quick`, then `npx fallow --skip health` (dead code shows only react/react-dom), then `rm -rf out`.
- **Code rules:**
  - Comments explain WHY.
  - No `as any`, no `as unknown as`, no `@ts-ignore`.
  - Never kill by name.
  - Never run `hc server status`.
  - No GUI.
- **Tests:** CI is ubuntu. Add tools the way the code map shows: TOOL_NAMES group, `TOOL_SPECS`, schema in `tool-schemas.ts`, a dispatch case in `prepareControl`, and the renderer editor reads the spec.

## Out of scope
- Machines UI, add dialog, and alias confirmation (slice 6).
- Routed `call` frames and `{ machine }` on session tools (slice 5).
- Agent CLI install/login panes (slice 12).
- Proof-of-possession (decision logged in blockers).

## Contracts (orchestrator commits `src/contracts/machines.ts` first; the rest belong to the tasks)
```ts
// src/contracts/machines.ts
import type { LinkState } from './link-protocol';
export type MachineMode = 'full' | 'light';
export interface MachineMeta {
  os: 'linux' | 'windows'; arch: 'x64'; version: string; mode: MachineMode;
  agents: string[]; enabled: boolean; survivesLogout: boolean;
}
export type MachineState = LinkState | 'disabled';
export interface MachineView {
  machine: string; machine_id: string; target: string; state: MachineState; mode: MachineMode | null;
  os: string | null; arch: string | null; conduit_version: string | null; agents: string[];
  sessions: number; last_seen: string | null; survives_logout: boolean | null;
}
export interface ConnectMachineOk {
  machine: string; machine_id: string; state: 'up'; os: string; arch: string; mode: MachineMode;
  conduit_version: string; reused: boolean; installed: boolean; upgraded: boolean;
}
export type MachineErrorCode =
  | 'machine_unknown' | 'ssh_needs_person' | 'ssh_unreachable' | 'ssh_auth_failed' | 'remote_unsupported'
  | 'install_failed' | 'identity_changed' | 'identity_conflict' | 'peer_incompatible';
export interface MachineError { code: MachineErrorCode; detail: Record<string, string | null>; candidates?: string[] }
export type ConnectMachineResult = { ok: true; value: ConnectMachineOk } | { ok: false; error: MachineError };
export type DisconnectMachineResult = { ok: true; value: { machine: string; state: 'down' } } | { ok: false; error: MachineError };
```
`NetworkPort` (`src/conduit-mcp/remote-routing.ts`) gains:
- `listMachines(): MachineView[]`
- `connectMachine(machine: string, signal: AbortSignal): Promise<ConnectMachineResult>`
- `disconnectMachine(machine: string): Promise<DisconnectMachineResult>`

## Producer/consumer map
| Behavior | Produced by | Consumed by | Sides |
|---|---|---|---|
| `machine` meta on ssh LinkRecord, links.json v3 | link-store (bootstrap, connect) | list_machines, network.changed view, slice 6 UI | both (renderer has no consumer yet) |
| `enabled` / `disabled` state | manager.disconnect / connect | dial loop, MachineView | both |
| new ToolErrorCodes | machine-errors.ts | MCP results; renderer approval card shows only tool names | both; measured: the renderer has no switch over ToolErrorCode (grep before you change it) |
| `machines.openNeedsPerson` C2 | server/network/c2.ts → domain openSession | slice 6 UI, e2e | both (the UI comes later) |
| wake redial | manager tick | dial loop | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/contracts/machines.ts` | create (orchestrator) | contracts above |
| `src/network/link-file.ts`, `server/network/link-store.ts`, `src/contracts/session-identity.ts` | modify | `machine` meta, v3, `setMachine(id, patch)` |
| `server/network/link-manager.ts` | modify | `disconnect(id)`, `enable(id)`, the `enabled` dial skip, wake redial, `waitUp(id, ms, signal)` |
| `server/network/bootstrap.ts` | modify | write meta after pinning (os, arch, version, agents, survivesLogout, mode `full`) |
| `server/network/machines.ts` | create | `createMachines({ manager, store, bootstrap, directory })`: resolve, list, connect, disconnect (no master exit, review B2) |
| `server/network/index.ts` | modify | the NetworkPort machine ops, C2 `machines.openNeedsPerson` |
| `server/network/c2.ts`, `src/contracts/server-protocol.ts` | modify | `machines.list`, `machines.openNeedsPerson` |
| `src/conduit-mcp/machine-errors.ts` | create | `machineToolError(e: MachineError, name: string): ToolError` |
| `src/conduit-mcp/types.ts` | modify | new codes, RETRYABLE additions |
| `src/conduit-mcp/tool-policy.ts`, `tool-schemas.ts`, `control-tools.ts`, `host.ts` | modify | three tools: name group, specs, schemas, prepare/dispatch, 120 s budget |
| `src/conduit-mcp/remote-routing.ts` | modify | NetworkPort additions |
| `test/e2e/net-machines.e2e.mjs` | create | over fake-ssh: link.sshAdd B, then `connect_machine` (reused), `list_machines`, `disconnect_machine` (B's sessions alive), `connect_machine` again (redials), `machine_unknown`. Runs on the Windows runner: no bootstrap. |

## Slices
### Slice 1: registry and manager (one lane)
**Check:** `npx vitest run test/unit/network-link-file.test.ts test/unit/network-link-store.test.ts test/unit/network-link-manager.test.ts test/unit/bootstrap.test.ts test/unit/network-machines.test.ts`.
- **T1.1:** meta plus v3:
  - parse v1/v2/v3;
  - a tls record with `machine` is corrupt;
  - `setMachine`.
- **T1.2:** manager `disconnect` / `enable` / `waitUp`, the `enabled` skip and wake redial. Use fake timers: a 10× late tick → immediate dial.
- **T1.3:** bootstrap writes the meta.
- **T1.4:** `machines.ts` resolve/list/connect/disconnect, red-first:
  - resolution order;
  - an ambiguous name;
  - reused;
  - a down machine → redial and wait;
  - unknown target → bootstrap;
  - needs-person → typed error and nothing stored;
  - a disconnect of a down machine is a no-op;
  - disconnect keeps B's sessions (manager close only);
  - two concurrent connects share one run;
  - the abort at 120 s.

### Slice 2: MCP tools and errors (after Slice 1's contracts; file-disjoint from Slice 1's server/ files)
**Check:** `npx vitest run test/unit/conduit-mcp-machine-tools.test.ts test/unit/machine-errors.test.ts test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-host.test.ts`.
- Map every §5.2 row to its code and hint.
- Add the three tools with decision 8's defaults.
- A host test drives each tool against a fake NetworkPort, including `alwaysAsk` for an unknown target and the 120 s budget (fake timers).

### Slice 3: needs-person pane and e2e (after Slices 1–2)
**Check:** `npx vitest run test/unit/network-service.test.ts`, plus `npm run e2e:remote -- net-machines net-ssh-link` and affected.
- C2 `machines.openNeedsPerson { target }`:
  - validates the target with `isSshTarget`;
  - opens a terminal session whose command is the ssh argv: `-o ControlMaster=yes -o ControlPath=<controlDir>/%C -o ControlPersist=8h -- <target>`, through the same `controlDir` the dialer uses (no BatchMode; the person answers);
  - returns the session id.
- A unit test checks the command argv and that the control dir is shared.
- The e2e `net-machines` (file map).

### Slice 4: policy rows (gated on CON-24 being on this branch)
Wire §4.6:
- `connect_machine` and `disconnect_machine`: Observer deny · Worker ask · Lead allow for added machines.
- A never-installed machine asks under every profile (RS-D6).
- Grants can scope "on: this machine".
- `list_machines` follows `list_sessions`' row.

Planned in detail once CON-24's profile API is on the branch.

## Verification
- Per task: the named tests.
- Per lane: verify:quick and fallow.
- After each merge: `npm run verify`.
- After Slice 3: `e2e:remote` affected plus `net-machines`.
- A VM smoke:
  - `connect_machine` to the VM by Host alias;
  - `disconnect_machine` → remote sessions alive;
  - reconnect;
  - a fresh known_hosts entry missing → `ssh_needs_person host_key_unknown`, then `machines.openNeedsPerson` → the pane opens, and once answered (by the smoke, interactively through the pane's input) the next `connect_machine` succeeds over the reused master.

## Deviation rule
If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece becomes the work. Examples: the tick cadence makes wake detection unreliable, or the domain can't open a command session from the network module. Never a shim, a second copy, a special case, a widened type or a fallback routed around it. The report leads with the fix that keeps the locked decision.

## Decisions Needed
- [high] Merge CON-24 into CON-35 now (recommended), or build Slice 4 after CON-24 reaches main. Asked claude-3 on 2026-11-16.
- [normal] A second ssh target for a known machine is `identity_conflict`, with a hint naming the existing machine. Owner alias confirmation comes in slice 6. Default taken.
