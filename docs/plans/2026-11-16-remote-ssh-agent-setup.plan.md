# Remote over SSH, slice 12: agent setup and light mode (CON-47) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F1 tail, F2, F8; §9.1 "Agent setup" row; §9.2; RS-D12, RS-D13; §10 row 12; §11 S12 row) **Tier:** FULL (server C2 + MCP routing + new dialog)
**Builds on:** CON-41 (Machines UI, `machines.*` C2, needs-person pane) on `CON-35-ui`.

## Goal
The owner picks **full** or **light** per machine; in full mode a checklist per agent CLI lets them install a missing CLI and log in to it, each in a visible terminal, and refresh what the machine has. In light mode `list_agents { machine }` lists no CLIs.

## Architecture
- **Panes are local ssh terminals (owner-only), not remote sessions.** The needs-person pane already runs `ssh` on A as a visible Conduit terminal through `openCommand`. A setup pane is the same with `-t` and one fixed remote command from a table on A. Agents can't reach it: it exists only as a C2 method (RS-D12). An install dies if the link drops; that's acceptable for an attended, interactive step, and it needs no new link frames or B-side change.
- **Commands come from a fixed table** (`src/network/agent-setup-commands.ts`) keyed by CLI × OS × step. No user text is spliced in; the remote shell gets one constant string.
- **State is probed, not guessed.** "present" comes from a re-probe (the slice 3 probe already lists CLIs on PATH); login state is **not** detected in v1 (no measured status commands, see staleness). The checklist offers Log in for every present CLI.
- **Mode lives on `MachineMeta.mode`** (already in links.json v3). Light mode is enforced on A where `list_agents`/`open_session { machine }` are routed.

## Data flow
```
Add dialog ok ──▶ Agent setup dialog (mode Full/Light; per-CLI rows)
  mode change ─machines:setMode─▶ C2 machines.setMode ─▶ machines.setMode → store.setMachine(meta.mode) → network.changed
  Install/Log in ─machines:openSetupPane{machineId, cli, step}─▶ C2 machines.openSetupPane
        → setupSshArgv(target, controlPath, command(cli, os, step)) → openCommand (visible local pane) → app selects it
  Refresh ─machines:probeAgents─▶ C2 machines.probeAgents → bootstrap probe (agents only) → store meta.agents → network.changed
agent → list_agents{machine} on A → remote-routing: meta.mode==='light' ⇒ { agents: [] } (no call to B)
agent → open_session{machine, agent} on a light machine ⇒ agent_not_installed (no call to B)
```

## Settled decisions — do not re-litigate
- Only the owner installs CLIs, in visible panes (RS-D12). Logins happen in the CLI's own login in a pane (RS-D13); credential copy is out of scope here (an explicit per-CLI owner choice, not built in this slice).
- Mode on add is full with no CLI preselected (§7, slice 4).
- Light mode: B still runs the headless server; terminals, `send_input`, `read_screen` and files work (F8).

## Technical decisions this plan makes
1. **C2 methods** (owner only): `machines.setMode {machineId, mode}`, `machines.openSetupPane {machineId, cli, step: 'install'|'login'}` → `{ sessionId }`, `machines.probeAgents {machineId}` → `{ agents: string[] }`. Unknown machine → `RpcFault('not_found')`; a non-ssh record or a machine with no `os` → `invalid`; `openSetupPane` on a light machine → `invalid`.
2. **`setupSshArgv`** in `src/network/ssh-argv.ts`: `personSshArgv` plus `-t` before `--` and the command after the target. Same ControlPath (`<controlDir>/%C`) so it reuses the batch/needs-person master.
3. **Command table** (Linux measured in Task 0 on the con27 VM; Windows rows from vendor docs, marked unmeasured in the file and in gates.md G4):
   - install: claude `curl -fsSL https://claude.ai/install.sh | bash`; codex `npm install -g --prefix "$HOME/.local" @openai/codex` (needs npm on B — if absent the pane shows npm's own error; we don't push our pinned node's npm in v1); cursor `curl https://cursor.com/install -fsS | bash`; opencode `curl -fsSL https://opencode.ai/install | bash`.
   - login: claude `claude` (first run prompts login), codex `codex login --device-auth`, cursor `cursor-agent login`, opencode `opencode auth login`.
   - Each command is followed by `; echo; echo "[done — press Enter to close]"; read _` so the owner sees the result before the pane closes.
   - Task 0 may change any Linux row; the table is the single source.
4. **Probe refresh** reuses the slice 3 probe command (`probeCommand` in `src/network/remote-scripts.ts`) over the batch ssh path and writes only `meta.agents`. The probe's PATH misses `~/.local/bin` in a non-interactive shell (exploration finding): the probe script prepends `$HOME/.local/bin` to PATH for the `command -v` checks only.
5. **Hardcoded `'full'` fixes:** `server/network/machines.ts:228` reads `meta.mode`; `link-manager.ts:212-224` already keeps an existing block (verify; only the no-block default stays `full`).
6. **Light-mode filter** is a pure function `agentsForMode(mode: MachineMode | null, agents: string[]): string[]` plus `modeOf(machine): MachineMode | null` in `server/network/machines.ts`. The one-line wiring where routed `list_agents` results come back on A (host.ts `prepareRouted` or remote-routing.ts `nameOnMachine`) and the `open_session` refusal are done by the orchestrator **after** CON-42 merges (claude-24's L5 lanes own remote-routing.ts and host.ts now; agreed 2026-11-16 15:32Z). Until then the lane builds and tests the functions only.

## Spec staleness
- §4.3 F2 defers install commands to gate G4. Measured: G4 was never run (`docs/runs/2026-11-16-CON-35/gates.md:16,199`); no command is recorded anywhere. Task 0 measures the Linux rows on the VM; Windows rows stay vendor-doc, unmeasured.
- §9.1 lists per-CLI states "logged out / ready". Measured: no login-status detection exists (`src/`, `server/` grep). v1 shows present/missing/installing(pane open)/failed(probe after install still missing) and always offers Log in for present CLIs. Logged-out/ready detection is a Decision Needed.

## Global constraints
Same as CON-41 (`docs/plans/2026-11-16-remote-ssh-machines-ui.plan.md` §Global constraints), plus: every esbuild / full vitest / verify / e2e run goes through `flock /tmp/claude-1000/conduit-gate.lock …`; lanes run only tsc, biome and named vitest; the orchestrator runs the gate.

## Out of scope
Credential copy (RS-D13 option), Windows measurement, push-install of npm/node for Codex, login-state detection, an MCP tool for setup (agents never install).

## Contracts (orchestrator commits first)
```ts
// src/contracts/machines.ts
export type AgentSetupStep = 'install' | 'login';
// src/contracts/server-protocol.ts
'machines.setMode': { params: { machineId: string; mode: MachineMode }; result: Record<string, never> };
'machines.openSetupPane': { params: { machineId: string; cli: AgentCli; step: AgentSetupStep }; result: { sessionId: string } };
'machines.probeAgents': { params: { machineId: string }; result: { agents: string[] } };
// src/protocol.ts WebviewToHost
| { type: 'machines:setMode'; requestId: number; machineId: string; mode: MachineMode }
| { type: 'machines:openSetupPane'; requestId: number; machineId: string; cli: AgentCli; step: AgentSetupStep }
| { type: 'machines:probeAgents'; requestId: number; machineId: string }
// HostToWebview: setMode → existing machines:result; openSetupPane → existing machines:needsPersonOpened shape renamed? NO: new
| { type: 'machines:paneOpened'; requestId: number; sessionId: string | null; error: string | null }
| { type: 'machines:agents'; requestId: number; agents: string[] | null; error: string | null }
// src/network/agent-setup-commands.ts
export function setupCommand(cli: AgentCli, os: 'linux' | 'windows', step: AgentSetupStep): string;
// src/network/ssh-argv.ts
export function setupSshArgv(o: { target: string; controlPath: string; command: string }): string[] | { error: 'bad_target' };
```

## Producer/consumer map
| Behavior | Produced by | Consumed by | Sides |
|---|---|---|---|
| meta.mode change | machines.setMode | MachineView.mode (row), routing filter, connect result | both |
| setup pane | C2 openSetupPane → openCommand | app selects the local session | both |
| meta.agents refresh | machines.probeAgents | MachineView.agents → setup dialog rows | both |
| light filter | machines.modeOf | remote-routing list_agents/open_session | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/contracts/machines.ts`, `server-protocol.ts`, `src/protocol.ts` | modify (orchestrator) | contracts |
| `src/network/agent-setup-commands.ts` | create | the command table |
| `src/network/ssh-argv.ts` | modify | `setupSshArgv` |
| `src/network/remote-scripts.ts` | modify | probe PATH includes `$HOME/.local/bin` |
| `server/network/machines.ts` | modify | setMode, modeOf, probeAgents, connect result mode |
| `server/network/needs-person.ts` | modify | `createSetupPane` beside `createNeedsPerson` (shared control-dir prep) |
| `server/network/c2.ts`, `server/network/index.ts` | modify | three C2 cases + deps |
| `src/conduit-mcp/remote-routing.ts` or `host.ts` | modify (orchestrator, after CON-42 merges) | one-line light filter call |
| `electron/main.ts`, `electron/machine-replies.ts` | modify | three renderer cases |
| `webview/machines-store.ts` | modify | setMode, openSetupPane, probeAgents |
| `webview/components/agent-setup-dialog.tsx` | create | mode + checklist |
| `webview/components/machines-section.tsx` | modify | row menu "Set up agents" |
| `webview/machines-strings.ts` | modify | strings |
| `webview/app.tsx` | modify (serial) | open the dialog after add, from the row and the palette |
| `docs/runs/2026-11-16-CON-35/gates.md` | modify (Task 0) | G4 Linux rows |

## Slices
### Slice 0 (orchestrator): contracts + Task 0 measurement
Task 0: on the con27 VM (ask claude-24 first; headless; every ssh under `timeout`), run each Linux install and login command as the VM user, record exit code, install path, whether the binary is on a non-interactive PATH, and the login prompt shape. Update the table and G4.

### Slice 1: three parallel lanes
**Parallel groups:** S: server (agent-setup-commands, ssh-argv, remote-scripts, machines, needs-person, c2, index + tests; NOT remote-routing.ts/host.ts) · E: electron (main.ts cases, machine-replies + tests) · W: webview (machines-store, agent-setup-dialog, machines-section menu, strings + tests). Serial: app.tsx wiring + e2e by the orchestrator.
**Checks:** S — `machines.setMode` round-trip; `openSetupPane` argv equals `['-o','ControlMaster=yes',…,'-t','--',target, command]` with the table command; light `list_agents` returns `[]` without a call to B (mock NetworkPort.call not called); probe PATH test. E — reply mapping tests. W — dialog: mode toggle posts setMode; Install shown for missing, Log in for present; Refresh calls probeAgents; light mode hides the checklist.
**E2E** `net-agent-setup` (headless, fake-ssh): add B, open Set up agents, switch to Light → `list_agents { machine }` from a Lead agent returns no agents; switch to Full; Install on a CLI opens a local terminal whose argv (read from the session's command in A's C2 sessions list) ends with the table command.

## Verification
Lane: tsc + biome + named vitest. Orchestrator: full verify under the lock per merge, headless screenshots of the dialog (full, light), e2e local once then `e2e:remote`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source.

## Decisions Needed
- [high] Running vendor `curl | bash` installers on B from Conduit's table (owner-triggered, visible). Default taken: yes, as RS-D12 describes; commands pinned in one file.
- [normal] Login state ("logged out / ready", §9.1) not detected in v1. Default: always offer Log in.
- [normal] Codex install needs npm on B; v1 doesn't provide it. Default: the pane shows npm's error.
