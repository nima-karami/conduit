# Remote over SSH, slice 6: machines UI and remote panes (CON-41) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.2 removed, §4.3 F1/F5/F6, §9.1–9.3, §10 row 6, §11 S6 rows) **Tier:** FULL
**Builds on (merged on `CON-35-remote-ssh` d0d7716d):** slice 4 machines registry (`MachineView`, `createMachines`, `machines.openNeedsPerson`), slice 5 routed tools (`MonitorSession.openedBy` for minor ≥ 2), CON-27 view relay + drive (`remote.attach/detach/input/resize/close` C2, `remote.data/state` events).

## Goal
The owner sees their machines in the sidebar, adds one from a dialog, sees each remote session under the local lead that opened it (and under its machine) with an "on <machine>" badge, and clicks one to get a live terminal they can type into and close.

## Architecture
- **Server owns all state.** The renderer gets one feed: `network:state` (C2 `network.changed`, already broadcast by `electron/server-events.ts:181`) now carrying `machines: MachineView[]`. Remote sessions are read from each link's `snapshot.sessions`. No renderer-side registry.
- **Owner actions are C2 methods** on the existing `createMachines` (`server/network/machines.ts`), the same code the MCP tools use: connect, disconnect, rename, remove, sshHosts.
- **Remote panes are a separate, lean component** (`RemotePane`), not a mode of `TerminalPane`: TerminalPane is wired to local PTY start/restart/scrollback and a global `windowsPty`, and a remote pane has none of that. RemotePane reuses the terminal theme/font/GPU helpers. Electron routes its messages through a new `electron/remote-panes.ts` that maps viewId → window.
- **Remote rows are not Sessions.** They are injected into the sidebar tree as a third `TreeItem` kind and selected through a separate `activeRemote` state, so no local file/git code ever sees a remote id.
- **B grants drive to its ssh controller** (a link the owner's own SSH login opened already has shell access as that user, so drive adds no power). Without it every remote pane is read-only (`OWN_DEFAULT_CAPABILITIES.drive === false`, link-manager.ts:507).

## Data flow
```
B server ──snapshot frame──▶ A link-manager ──network.changed{links[].snapshot, machines[]}──▶ electron server-events ──network:state──▶ webview network-store
                                                                                                                          │
   webview remote-sessions.ts (pure): links × machines × local sessions(mcpHandle) ──▶ RemoteSessionRow[] ──▶ sidebar tree (under lead) + Machines section
click remote row → app activeRemote={machineId,sessionId} → center-pane renders RemotePane
RemotePane ─remote:attach{requestId}─▶ electron remote-panes ─C2 remote.attach─▶ A view-relay ─view.open─▶ B
          ◀─remote:attached{firstPaint,size,windowsPty,drive}─   ◀─ result
          ◀─remote:data / remote:state (by viewId → window)─  ◀─ C2 events remote.data/state
typing    ─remote:input / remote:resize─▶ C2 remote.input/resize ─drive.input/resize─▶ B (applyHumanInput, audit drive.start peer=A)
Add dialog ─machines:sshHosts / machines:connect{machine}─▶ C2 machines.sshHosts / machines.connect (120 s) ─▶ createMachines.connect
   ssh_needs_person → "Connect" ─machines:openNeedsPerson─▶ C2 machines.openNeedsPerson → local session pane, selected
```

## Settled decisions — do not re-litigate
- §9.1 state catalog and §9.2 interaction inventory: strings and actions as written there (English, in strings modules).
- `removed` is local only; remote sessions keep running (§4.2). Disconnect never stops remote sessions (slice 4).
- Agents can't remove machines; removal is GUI-only (slice 4 plan).
- Last typer sizes; read-only viewers never resize (NET-D10, F5).
- `connect` budget 120 s (§7, slice 4 decision 7).
- Machine badge is text "on <name>", never colour only (§9.2).

## Technical decisions this plan makes
1. **`NetworkState.machines: MachineView[]`** filled in `server/network/index.ts` state() from `machines.list()`. `link.list` and `network.changed` both carry it. Renderer asks once on mount with `network:get` (electron answers with C2 `link.list`).
2. **Remove = forget, not revoke.** `link.revoke` sends `revoked` and B tombstones A, which would refuse every later re-add. New `manager.forget(machineId)`: close the connection without a `revoked` frame, reject pending calls with `peer_revoked`, delete the record (no tombstone), exit nothing on B. `store.remove(machineId)` deletes without a tombstone.
3. **Drive grant:** in `acceptSsh` (link-manager.ts:501), B sends `drive: true` and, if the pinned controller record has `capabilities.drive === false`, updates it to true (`store.update(id,{capabilities})`). A-side records stay `drive: false` (B never drives A; S5 refusal unchanged).
4. **Rename:** `store.update(machineId, { name })`, name trimmed, 1–64 chars, no control chars; else `RpcFault('invalid')`. Only ssh records.
5. **ssh config hosts:** pure `parseSshConfigHosts(text: string): string[]` — `Host` lines (case-insensitive keyword, `Host x y` or `Host=x`), every token that has no `*`, `?` or leading `!`, de-duplicated in file order; `Include` is not followed (logged once, listed in Decisions Needed). C2 `machines.sshHosts` reads `<homedir>/.ssh/config` (missing → `[]`).
6. **Remote session parentage:** a remote session's local parent is the local session whose `mcpHandle === openedBy.handle`, only when `openedBy.machineId === NetworkState.machineId`. Otherwise it has no parent and shows only under its machine.
7. **Remote row key:** `remote:<machineId>:<sessionId>` (navId and React key). Class `remote-session` (never `.session`: `test/unit/sidebar-tree-ui.test.ts:175` counts `.session[role=treeitem]`).
8. **Placement in the tree:** remote rows of a lead render directly after the lead's last local descendant, at depth lead.depth+1, hidden when the lead is folded. A lead with only remote children is foldable: `buildAgentTree` gains an optional input `remoteChildren: ReadonlyMap<string, number>` (lead session id → count) that counts toward `descendantCount` and makes the row foldable; it does not create rows.
9. **Machines section:** a separate `role="tree"` below the Agents tree, hidden unless setting `machinesUi` is true **or** at least one machine exists. Machine row = level 1 treeitem (`aria-expanded`), its sessions = level 2 `remote-session` rows.
10. **Needs-person tracking:** the renderer keeps the last `MachineError` per machine name/target from its own connect calls (`webview/machines-store.ts`), shown on the row until the next successful connect or a state change to `up`.
11. **RemotePane sizing:** opens at the remote size (no fit). On the first keystroke after attach or after a `remote:state` size change, it fits to the pane and sends `remote:resize` before the input. While `drive` is false: no input, a "Read only" note.
12. **Reconnect:** `remote:state` `frozen` → dim the terminal and show "Reconnecting to <name>…" (polite live region); `resyncing` or a new `up` after `down` → detach, clear, re-attach; `exited` → write `\r\n[process exited]\r\n` dimmed, disable input.
13. **Flag:** new setting `machinesUi: boolean`, default `false` (no network UI flag exists, see staleness). Settings › General gets a "Show Machines in the sidebar" toggle.

## Spec staleness
- §10 says each slice ships "behind the network flag". Measured: no such setting exists (`src/settings.ts:196-201` has only bind host, port, self name; `server/services.ts:288` always creates the network). Decision 13 adds a UI-only flag.
- §9.1 "Remote pane … Close session": measured, a remote close is refused while B's own window shows the session (claude-24, CON-40 follow-up). The pane shows the refusal text; no change on B in this slice.
- `electron/server-events.ts:183-184` drops `remote.data`/`remote.state`; the renderer never consumed `network:state` (grep: no subscriber in `webview/`). This plan adds both consumers.

## Global constraints
- Gates: lanes run `node esbuild.mjs && npm run verify:quick`, then `npx fallow --skip health` (dead code: only react/react-dom), then `rm -rf out`. Orchestrator runs full `npm run verify` per merge, exit code captured directly.
- CLAUDE.md rules: comments explain WHY (one-line pointer when the why is in a doc); no `as any`, `as unknown as`, `@ts-ignore`, `!important`, specificity escalation, magic offsets; `confirm/alert/prompt` banned; overlays over `.topbar` need `-webkit-app-region: no-drag`; React `onWheel` is passive; strings in strings modules; semantic tokens only (`--green`, `--amber`, `--red`, `--text-dim`, `--text-faint`, `--border`); CI is ubuntu.
- Never launch a GUI except headless (`--ozone-platform=headless`, via `launchElectron`). Never kill processes by name.
- Tests are vitest under `test/unit/<name>.test.ts`; React components tested with the existing testing setup (see `test/unit/sidebar-tree-ui.test.ts` for the pattern).

## Out of scope
Agent setup / light mode (slice 12), remote files (8–10), remote requests (7), opening a remote session from the GUI (owner `remote.open` — not in §10 row 6), Permissions machine picker (11), Windows remote paths.

## Contracts (orchestrator commits these first)
```ts
// src/contracts/network-state.ts — NetworkState gains:
  /** Added ssh machines (slice 4 registry), for the Machines UI. */
  machines: MachineView[];

// src/contracts/machines.ts — add:
export type MachineActionResult = { ok: true; value: ConnectMachineOk | null } | { ok: false; error: MachineError };

// src/contracts/server-protocol.ts C2 methods — add:
'machines.connect': { params: { machine: string }; result: ConnectMachineResult };
'machines.disconnect': { params: { machine: string }; result: DisconnectMachineResult };
'machines.rename': { params: { machineId: string; name: string }; result: Empty };
'machines.remove': { params: { machineId: string }; result: Empty };
'machines.sshHosts': { params: Empty; result: { hosts: string[] } };

// src/protocol.ts WebviewToHost — add:
| { type: 'network:get' }
| { type: 'remote:attach'; requestId: number; machineId: string; sessionId: string }
| { type: 'remote:detach'; viewId: string }
| { type: 'remote:input'; machineId: string; sessionId: string; data: string }
| { type: 'remote:resize'; machineId: string; sessionId: string; cols: number; rows: number }
| { type: 'remote:close'; requestId: number; machineId: string; sessionId: string }
| { type: 'machines:connect'; requestId: number; machine: string }
| { type: 'machines:disconnect'; requestId: number; machine: string }
| { type: 'machines:rename'; requestId: number; machineId: string; name: string }
| { type: 'machines:remove'; requestId: number; machineId: string }
| { type: 'machines:openNeedsPerson'; requestId: number; target: string }
| { type: 'machines:sshHosts'; requestId: number }
// HostToWebview — add (network:state exists):
| { type: 'remote:attached'; requestId: number; result: RemoteAttachResult }
| { type: 'remote:data'; viewId: string; data: string }
| { type: 'remote:state'; viewId: string; state: 'live' | 'frozen' | 'exited' | 'resyncing'; since: string | null; size: TermGeometry | null }
| { type: 'remote:closed'; requestId: number; error: string | null }
| { type: 'machines:result'; requestId: number; result: MachineActionResult }
| { type: 'machines:needsPersonOpened'; requestId: number; sessionId: string | null; error: string | null }
| { type: 'machines:sshHosts'; requestId: number; hosts: string[] }
export type RemoteAttachResult =
  | { ok: true; viewId: string; firstPaint: string; size: TermGeometry; windowsPty: WindowsPtyInfo | null; drive: boolean }
  | { ok: false; error: string };
```
Error strings in `remote:attached`/`remote:closed`/`needsPersonOpened` are the C2 fault code (`peer_unreachable`, `refused`, …) or `'failed'`; the renderer maps them to text in `webview/machines-strings.ts`.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides |
|---|---|---|---|
| `NetworkState.machines` | index.ts state() | electron `network:state` → webview network-store | both |
| C2 machines.* | c2.ts → createMachines/manager/store | electron main → webview machines-store | both |
| forget (remove) | manager.forget, store.remove | C2 machines.remove; pending calls (calls.ts rejects on removal, already listens to revoke — L1 must make forget reject them too) | both |
| drive grant on B | acceptSsh | drive.ts `allowed()` reads record caps (unchanged) | both |
| remote.data/state events | view-relay (exists) | electron remote-panes → RemotePane | both |
| remote rows | network-store + local sessions | sidebar tree, Machines section, palette | both |
| `buildAgentTree` `remoteChildren` input | sidebar.tsx | agent-tree fold/descendant count; callers: `webview/components/sidebar.tsx` only (grep `buildAgentTree(` before changing) | both |
| setting `machinesUi` | settings.ts default/sanitize | sidebar Machines section, Settings toggle | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/contracts/network-state.ts`, `src/contracts/machines.ts`, `src/contracts/server-protocol.ts`, `src/protocol.ts` | modify (orchestrator) | contracts above |
| `src/network/ssh-config-hosts.ts` | create | `parseSshConfigHosts(text): string[]` |
| `server/network/link-store.ts` | modify | `remove(machineId): boolean` (no tombstone) |
| `server/network/link-manager.ts` | modify | `forget(machineId): boolean`; drive grant in `acceptSsh` |
| `server/network/machines.ts` | modify | `rename(machineId, name)`, `remove(machineId)` |
| `server/network/index.ts` | modify | `machines` in state(); wire C2 deps; `sshHosts()` |
| `server/network/c2.ts` | modify | the five `machines.*` cases with param validation |
| `electron/remote-panes.ts` | create | viewId→window routing for remote panes |
| `electron/main.ts` | modify | renderer message cases for `network:get`, `remote:*`, `machines:*`; window-closed cleanup |
| `electron/server-events.ts` | modify | `remote.data`/`remote.state` → remote-panes |
| `webview/network-store.ts` | create | `useNetworkState(): NetworkState | null` (subscribe + `network:get` once) |
| `webview/remote-sessions.ts` | create | pure `remoteSessionRows(...)` |
| `webview/machines-store.ts` | create | connect/disconnect/rename/remove/openNeedsPerson/sshHosts calls via `requestHost`, last error per machine |
| `webview/machines-strings.ts` | create | every machines / remote pane string |
| `webview/components/remote-pane.tsx` | create | the lean remote terminal |
| `webview/components/center-pane.tsx` | modify | render RemotePane when `activeRemote` is set |
| `webview/components/machines-section.tsx` | create | Machines tree section |
| `webview/components/remote-session-row.tsx` | create | one remote session row (both trees) |
| `webview/components/add-machine-dialog.tsx` | create | Add dialog |
| `src/agent-tree.ts` | modify | optional `remoteChildren` input |
| `webview/components/sidebar.tsx` | modify | inject remote rows, keyboard, mount Machines section |
| `webview/styles.css` | modify | all new classes (one owner: L4) |
| `webview/app.tsx`, `webview/components/modal-layer.tsx`, palette command source, `src/settings.ts`, settings UI | modify (serial) | `activeRemote`, dialog wiring, palette commands, `machinesUi` |
| `test/e2e/net-machines-ui.e2e.mjs` | create | headless app A + server B over fake-ssh |

## Slices

### Slice 0: contracts (orchestrator)
**Check:** `npx tsc -p . --noEmit` (types only; fallow runs after the lanes, which add the importers).

### Slice 1: four parallel lanes
**Parallel groups:** L1: T1 · L2: T2 · L3: T3 · L4: T4 · Serial: Slice 2
**Claims:** none shared between L1–L4 (checked: file sets above are disjoint; `styles.css` is L4's only, L3 uses the class names pinned below).

Pinned CSS classes (L4 writes them, L3 uses them): `.remote-pane`, `.remote-pane-head`, `.remote-pane-body`, `.remote-pane--frozen` (dims the body), `.remote-pane-note` (live-region note), `.machine-badge`, `.machines`, `.machine-row`, `.machine-row-status`, `.remote-session`.

#### Task 1 (L1, server): owner machine actions, forget, drive grant, ssh hosts
**Files:** create `src/network/ssh-config-hosts.ts`; modify `server/network/link-store.ts`, `link-manager.ts`, `machines.ts`, `index.ts`, `c2.ts`; tests `test/unit/ssh-config-hosts.test.ts`, extend `test/unit/network-link-store.test.ts`, `network-link-manager.test.ts`, `network-machines.test.ts`, the c2 test that covers `link.sshAdd` (grep `machines.openNeedsPerson` in test/unit).
**Interfaces — Produces:** `parseSshConfigHosts(text: string): string[]`; `LinkStore.remove(machineId: string): boolean`; `LinkManager.forget(machineId: string): boolean`; `Machines.rename(machineId: string, name: string): void` (throws `RpcFault('invalid')` on a bad name, `RpcFault('not_found')` for an unknown id); `Machines.remove(machineId: string): void`; the C2 methods in Contracts.
**Tests (red first):**
- 'parses Host aliases, skips wildcards and negations' — `parseSshConfigHosts('Host a b\nHost *\nhost=c\nHost !d e?\n')` → `['a','b','c']`.
- 'forget closes without a revoked frame and leaves no tombstone' — after forget: `store.get(id) === null`, `store.byServerKey(key) === null`, no `{t:'revoked'}` sent, pending call rejected `peer_revoked`.
- 'an ssh controller is granted drive on accept' — B accepts an ssh stream; B's record `capabilities.drive === true`; the hello B sent has `drive: true`; an A-side dialed record keeps `drive: false`.
- 'state() lists machines' — `link.list` result has `machines` equal to `machines.list()`.
- 'rename refuses an empty or 65-char name'.
- c2: each `machines.*` validates params (non-string → `invalid`).
- `machines.connect` C2 passes an AbortSignal that aborts at 120 s (reuse the MCP budget constant; grep `120_000` in `src/conduit-mcp/host.ts` or machines.ts and import it, do not copy it).

#### Task 2 (L2, electron): routing
**Files:** create `electron/remote-panes.ts`; modify `electron/main.ts` (message switch near `case 'term:input'`, window-closed handler), `electron/server-events.ts:181-184`; test `test/unit/remote-panes.test.ts`.
**Interfaces — Produces:**
```ts
export interface RemotePanesDeps {
  call<M extends 'remote.attach' | 'remote.detach' | 'remote.input' | 'remote.resize' | 'remote.close'>(method: M, params: ServerMethods[M]['params']): Promise<ServerMethods[M]['result']>;
  sendTo(windowId: number, message: HostToWebview): void;
  log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>): void;
}
export function createRemotePanes(d: RemotePanesDeps): {
  attach(windowId: number, m: Extract<WebviewToHost, { type: 'remote:attach' }>): Promise<void>;
  detach(windowId: number, viewId: string): Promise<void>;
  input(m: Extract<WebviewToHost, { type: 'remote:input' }>): void;
  resize(m: Extract<WebviewToHost, { type: 'remote:resize' }>): void;
  close(windowId: number, m: Extract<WebviewToHost, { type: 'remote:close' }>): Promise<void>;
  data(e: ServerEvents['remote.data']): void;
  state(e: ServerEvents['remote.state']): void;
  windowClosed(windowId: number): void; // detaches every view that window held
};
```
(Use the real C2 method-map type name from `src/contracts/server-protocol.ts`; if it is not `ServerMethods`, use its actual name.) `machines:*` and `network:get` are thin `callServer` cases in main.ts replying `machines:result` / `machines:needsPersonOpened` / `machines:sshHosts` / `network:state`; `machines:connect` uses a 130 s call timeout (check how `callServer` takes a timeout; the default is too short for a 120 s bootstrap).
**Tests:** 'routes data only to the window that attached'; 'a detach for another window's view is ignored'; 'windowClosed detaches its views over C2'; 'attach failure replies ok:false with the fault code'; 'events for unknown viewIds are dropped'.

#### Task 3 (L3, renderer data + pane)
**Files:** create `webview/network-store.ts`, `webview/remote-sessions.ts`, `webview/machines-store.ts`, `webview/machines-strings.ts`, `webview/components/remote-pane.tsx`; modify `webview/components/center-pane.tsx` (new optional prop `activeRemote: RemoteKey | null` and `remoteRows`, renders `<RemotePane>` instead of the local session view when set); tests `test/unit/remote-sessions.test.ts`, `test/unit/machines-store.test.ts`, `test/unit/remote-pane.test.tsx` (or `.ts` matching repo convention).
**Interfaces — Produces:**
```ts
// webview/remote-sessions.ts
export interface RemoteKey { machineId: string; sessionId: string }
export const remoteKeyId = (k: RemoteKey): string => `remote:${k.machineId}:${k.sessionId}`;
export interface RemoteSessionRow {
  key: RemoteKey; id: string; machineName: string; machineState: MachineState;
  session: MonitorSession; parentSessionId: string | null;
}
export function remoteSessionRows(state: NetworkState, localSessions: readonly Pick<Session, 'id' | 'mcpHandle'>[]): RemoteSessionRow[];
// webview/network-store.ts
export function useNetworkState(): NetworkState | null;
// webview/machines-store.ts
export function connectMachine(machine: string): Promise<MachineActionResult>;
export function disconnectMachine(machine: string): Promise<MachineActionResult>;
export function renameMachine(machineId: string, name: string): Promise<MachineActionResult>;
export function removeMachine(machineId: string): Promise<MachineActionResult>;
export function openNeedsPerson(target: string): Promise<{ sessionId: string | null; error: string | null }>;
export function sshHosts(): Promise<string[]>;
export function useMachineErrors(): ReadonlyMap<string, MachineError>; // keyed by MachineView.machine (or the typed target before it exists)
// webview/components/remote-pane.tsx
export function RemotePane(props: { remote: RemoteKey; machineName: string; label: string; visible: boolean; onClosed(): void }): JSX.Element;
// webview/machines-strings.ts
export const MACHINES_STR: { … } // every string in §9.1 rows: Machines group, Machine row, Session row badge "on <name>", Remote pane, Add dialog; state texts per MachineState; error texts per MachineErrorCode; plural "1 session"/"N sessions"
```
`remoteSessionRows` rules: only links with `transport === 'ssh'` and a non-null snapshot; `machineName` from `state.machines` by `machine_id` (fallback link `name`); parent per decision 6; sessions with `status === 'exited'` are kept (the row shows "Exited"); order = machine name, then session label.
RemotePane: decisions 11 and 12; xterm created only after `remote:attached` with `windowsPtyOptions(result.windowsPty)` (`webview/terminal-conpty.ts`); font, theme and GPU through the same helpers TerminalPane imports (`webview/terminal-gpu.ts` for WebGL; read terminal-pane.tsx imports — reuse, never copy logic); header shows label, `on <machine>` badge, "Close session" button (`remote:close`; a non-null error shows its text in `.remote-pane-note`); detach on unmount.
**Tests:** remote-sessions: 'nests under the local lead by mcpHandle when the opener machine is this one'; 'a remote opener from another machine has no parent'; 'non-ssh links and null snapshots give no rows'. machines-store: 'a connect error is kept per machine until a successful connect'. remote-pane: 'creates the terminal only after attach and writes firstPaint'; 'first keystroke sends resize then input'; 'drive false sends no input'; 'frozen shows the reconnecting note'; 'unmount detaches'.

#### Task 4 (L4, sidebar + dialog + styles)
**Files:** create `webview/components/machines-section.tsx`, `webview/components/remote-session-row.tsx`, `webview/components/add-machine-dialog.tsx`; modify `src/agent-tree.ts` (decision 8), `webview/components/sidebar.tsx`, `webview/styles.css`; tests `test/unit/agent-tree.test.ts` (extend), `test/unit/sidebar-tree-ui.test.ts` (extend), `test/unit/machines-section.test.tsx`, `test/unit/add-machine-dialog.test.tsx`.
**Interfaces — Consumes** (exact, from L3; import them, L3's files land in the same merge): `RemoteKey`, `RemoteSessionRow`, `remoteKeyId`, `MACHINES_STR`, `MachineView`, `MachineError`, `MachineActionResult`. L4 must not edit L3's files; until L3 merges, write against these signatures (the orchestrator merges L3 before L4).
**Produces:** new Sidebar props
```ts
remoteRows: readonly RemoteSessionRow[];
machines: readonly MachineView[];
machineErrors: ReadonlyMap<string, MachineError>;
showMachines: boolean;
activeRemoteId: string | null;
onSelectRemote(key: RemoteKey): void;
onAddMachine(): void;
onMachineAction(action: 'connect' | 'retry' | 'disconnect' | 'rename' | 'remove' | 'copyFix', machine: MachineView): void;
```
`AddMachineDialog(props: { hosts: readonly string[]; onSubmit(machine: string): Promise<MachineActionResult>; onOpenNeedsPerson(target: string): void; onClose(): void })`: `role="dialog"`, list of Hosts (buttons), a text field for `user@host[:port]`, Connect (primary); progress in a polite live region ("Connecting to <name>…"); on `ssh_needs_person` shows the reason and a "Connect in a terminal" button (→ onOpenNeedsPerson); other errors show their text + Retry; success closes. Esc closes.
Machines section: decision 9; machine row shows name, OS word, mode, `N sessions`, state text; inline action per §9.1 (up: none; down: "Retry now"; disabled: "Connect"; needs-person error: "Connect" → onMachineAction('connect') which the app turns into openNeedsPerson; incompatible/identity-changed: reason + "Copy fix"/"Remove"); context menu Disconnect, Rename, Remove (Rename uses the existing `RenameInput` pattern in session-card.tsx; Remove asks through the existing ConfirmState flow — never `confirm()`). Arrow keys/Enter as the Agents tree.
Agents tree: decision 7–8; remote row = agent icon (`resolveAgentIcon(session.agent)`), label, state word from `presence`, `.machine-badge` "on <name>"; click → onSelectRemote; ArrowRight on a lead expands into remote children; selected when `activeRemoteId === row.id`.
**Tests:** 'a lead with only remote children is foldable and counts them'; 'remote rows render after the lead's local subtree at depth+1 and hide when folded'; 'remote rows are not .session'; 'selector contract still holds' (existing test passes unchanged); machines-section: 'shows Retry now for down and Connect for a needs-person error'; 'state is text, not colour only'; add dialog: 'submits a typed target and shows the needs-person action'.

### Slice 2: wiring (serial, orchestrator or one lane after L1–L4 merge)
**Files:** `webview/app.tsx` (state `activeRemote: RemoteKey | null`; selecting a local session clears it; `useNetworkState`, `remoteSessionRows`, `useMachineErrors`; Sidebar/CenterPane props; open AddMachineDialog; `onMachineAction` → machines-store, needs-person → `openNeedsPerson(target)` then select the returned local session), `webview/components/modal-layer.tsx` (AddMachineDialog), palette command source (grep `registerCommand\|commands:` in webview — "Add machine", "Connect <name>", "Disconnect <name>"), `src/settings.ts` (`machinesUi`, default false, sanitized boolean), settings UI toggle, `CHANGELOG.md`, `test/e2e/net-machines-ui.e2e.mjs`.
**E2E `net-machines-ui`** (headless `launchElectron`, finish via `finishScenario`): start server B with `startServer('b')`; launch app A with `CONDUIT_SSH_PATH`/`CONDUIT_E2E_SSH_ARGS_PREFIX` set to fake-ssh (see `test/e2e/net-machines.e2e.mjs`) and `machinesUi: true`; over A's C2 (`test/e2e/c2-peer.mjs`, as `asks-no-window.e2e.mjs`) `link.sshAdd` B; start a lead agent on A and route `open_session { machine }` to B as in `test/e2e/net-routed.e2e.mjs`. Assert:
1. the Machines section lists B with "Connected" within 5 s;
2. the remote session row appears under the lead with "on <B name>" within 2 s of open_session returning (S6);
3. click it → `.remote-pane .xterm` shows text from B's session;
4. type a marker into the pane → B's session screen (`read_screen` on B or B's C2) contains it, and B's audit has `drive.start` with `peer` = A's machine id (S6);
5. Disconnect from the row menu → row shows "Disconnected", B's session still `running`.
**Check:** `npm run e2e -- net-machines-ui` locally once; then `npm run e2e:remote` affected.

## Verification
Per lane: lane gates above, exit code captured directly. Per merge into CON-35-ui: `npm run verify`. Runtime: playwright-cli headless screenshots of the Machines section (empty/up/down/needs-person), the Add dialog, a remote pane (live and reconnecting), in Aero Dark and Aero. Then the brief's six merge steps onto `CON-35-remote-ssh`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source. Report leads with the fix that keeps the locked decision.

## Decisions Needed
- [normal] UI flag `machinesUi` (default off, auto-on once a machine exists) stands in for the spec's "network flag" — default taken.
- [normal] S6 "Activity names 'you, from <controller>'": verified as B's audit `drive.start {peer: A}`; B has no Activity string for drive today. Default: audit only; a B-side Activity row is a follow-up.
- [normal] `~/.ssh/config` `Include` is not followed for the Hosts list — default taken; the text field covers it.
- [normal] Remove = forget without tombstone (B keeps A pinned). Default taken; revoke stays a separate, not-surfaced action.
