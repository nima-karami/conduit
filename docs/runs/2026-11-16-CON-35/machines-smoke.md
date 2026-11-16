# CON-39 machine tools: runtime smoke against a real sshd (plan VM smoke)

Run: 2026-11-16, 11:22Z to 11:38Z (UTC).
Commit under test: `0bf7782c` (branch `CON-35-remote-ssh`), built from `git archive 0bf7782c`, not from the worktree.
Target: headless Linux VM `conduit-peer` (Ubuntu, x86_64, OpenSSH), host alias `vm`, user `conduit`, passwordless sudo.
Scratch (called `S`): `/tmp/claude-1000/-home-namemenima-projects--wt-conduit-CON-35/7e0abefc-f499-4ed4-883c-1e77266b51a9/scratchpad/smoke39`.
Drivers: `S/bin/` (`start.mjs`, `stop.mjs`, `app.mjs` (one C2 connection), `ctl.mjs`, `say.mjs`, `pane.mjs`, `mcp-call.mjs`, `vm-b.mjs`).
No GUI was launched. Electron did not run. Nothing was committed. `hc server status` was not run. No process was killed by name.

## Summary

| # | Step | Result | Key observation |
|---|------|--------|-----------------|
| 0 | Setup: build, server A without `--e2e`, Lead agent | PASS (with a deviation) | Build ok. A runtime `ready`. The fixture agent is wired only under `--e2e`, so the agent is a real Claude Code 2.1.325 session with Conduit's MCP wiring (see Deviations). |
| 1 | Fresh connect | PASS | Ask raised: `grantable: false`, `newMachine: true`, `source: session`. Result `state up`, `installed true`, `os linux`, `arch x64`. 7.2 s from approve to completion (server log). |
| 2 | `list_machines` | FAIL at the client, PASS on the server payload | Claude Code rejected the result (`structuredContent` is an array, client expects an object), so the agent never saw the rows. The server row: `state up`, `mode full`, `linux`, `x64`, `conduit_version 0.66.1`, `survives_logout true`. The row's `machine` is `conduit-peer`; `vm` is the `target`. |
| 3 | Reused connect | PASS | `reused true`, `installed false`, no new ask (count stayed at 1). |
| 4 | Disconnect | PASS | `state down`. B's session `gwaxi3rooyt` (shell:bash) still `running` on B; B's hc serve/hold/supervise/main alive. `list_machines` shows `state: disabled`. No redial in 70 s. |
| 5 | Reconnect | PASS | `state up`, `reused false`, no new ask. |
| 6a | Needs-person: fresh A, no host key | PASS | `ssh_needs_person`, `reason: host_key_unknown`. Hint: "ask the human to connect vm once from Machines". 0.2 s after approve. |
| 6b | `machines.openNeedsPerson` | PASS | Session `0kpylynca6b` (`conduit:command`). Command: `ssh-vm-nokey ... -o ControlMaster=yes ... -- vm`. Pane exited at once with "Host key verification failed". |
| 6c | Answer the prompt in the pane, then connect over the reused master | NOT VERIFIED | The spec's wrapper config has `BatchMode yes`, so ssh never prompts in the pane, and the pane had already exited. Nothing could be typed into it. |
| 7 | Teardown | PASS | A2, A and B stopped by their own paths. VM `~/.config/conduit` removed (absent at start, so no `.bak`). Linger yes, KUP false, logind drop-in dir empty, all as at start. No process of this run left. |

## Step 0: build, server A, agent, Lead

Build:

```
mkdir -p $S/src && git -C /home/namemenima/projects/.wt/conduit/CON-35 archive 0bf7782c | tar -x -C $S/src
ln -s /home/namemenima/projects/.wt/conduit/CON-35/node_modules $S/src/node_modules
(cd $S/src && node esbuild.mjs)     -> "Done in 1782ms"; out/server/{main,supervise,instance-names}.js present
```

Starting state of the VM (read over one-shot ssh before any change):

```
~/.config/conduit: No such file or directory
loginctl show-user conduit -p Linger --value  -> yes
busctl ... KillUserProcesses                  -> b false
/etc/systemd/logind.conf.d/                   -> exists, empty
/var/lib/systemd/linger/conduit               -> present (mtime 09:12)
```

Server A (no `--e2e`; vendored hc 0.1.16, vendored node, `CONDUIT_SSH_PATH=$S/ssh-vm`, `CONDUIT_NODE_BINARY` set):

```
ssh-vm: #!/bin/sh   exec ssh -F <vm.sshconfig> "$@"
node $S/bin/start.mjs a $S/a-ud $S/ssh-vm
-> {"label":"a","appPid":941186,"supervisor":"conduit-server-d1b1ba72fc194cb3","serverEndpoint":"/tmp/conduit-server-d1b1ba72fc194cb3.sock","runtimeReady":...}
```

`start.mjs` runs `hc run --bg --no-parent --name <supervisor> -- <vendored node> supervise.js --user-data <ud> --hc <hc>` (the net-helpers bring-up without `--e2e`), then attaches an app stand-in (hello, `server.setLogging`, `events.subscribe`, `ui.presence` window 1 ready). `link.list` on A returned `machineId m-689f9dc0`.

Agent: `sessions.create {agentId:"claude-smoke", home:$S/a-ud/work}` (agents.json defines `command: /home/namemenima/.local/bin/claude`), `term.resize`, `sessions.start` gave `{ok:true, generation:1, spawned:true}`. Claude opened its folder-trust prompt; the agent accepted it through `term.input` (Down, Enter). Conduit wired claude with `--settings` (MCP server `conduit` via the shim, from `conduit-mcp/launch/<sid>.settings.json`).

Lead: `mcp.fromRenderer {windowId:1, message:{type:'mcp:setAssignment', requestId:1, point:{kind:'session', sessionId}, profileId:'lead'}}` -> `{"reply":{"type":"mcp:policyResult","requestId":1,"ok":true}}`.

Note: for a session's `window_not_ready` to go away, window 1 must own it. The app stand-in sets `ui.presence` with `ownedSessionIds: [sid]` and `visibleSessionIds: [sid]`. Without it the first call on A2 returned `window_not_ready` (retryable). That was my setup gap, not a product result. It is not counted.

## Step 1: fresh connect. PASS

Prompt sent to the agent at 11:29:27.374Z: "Call the conduit connect_machine tool with machine set to vm. Do not retry. When the call returns, reply with one line: CONNRES followed by the compact JSON ...".

The ask (from the event stream, owner route to the agent's session):

```
11:29:34.881Z ui.post route={kind:"owner",sessionId:"95zyxpsm3r6"}
  message={type:"mcp:ask", askId:"r_5t6fbr5aipqe", tool:"connect_machine",
           summary:{tool:"connect_machine", machine:"vm", newMachine:true},
           args:{machine:"vm"}, source:"session", grantable:false}
```

`grantable: false` (RS-D6 forced ask, no Always offered).

Answer, through the app's C2 path (`mcp.fromRenderer`, sent 11:30:20.130Z, about 45 s after the ask):

```
mcp.fromRenderer {"windowId":1,"message":{"type":"mcp:askAnswer","askId":"r_5t6fbr5aipqe","answer":"approve"}}
-> {"ok":true,"result":{}}
```

Result (the agent's reply line, whitespace removed by `pane.mjs` and the TUI's line wrap):

```
CONNRES {"machine":"conduit-peer","machine_id":"m-e05b5517","state":"up","os":"linux","arch":"x64",
         "mode":"full","conduit_version":"0.66.1","reused":false,"installed":true,"upgraded":false}
```

Server log: `tool call connect_machine ok:true` at 11:30:27.302Z. The connect ran 7.2 s after approve (20.13 to 27.30). The call started at the ask (11:29:34.9), so the whole call took 52.4 s, of which about 45 s was my approve latency.

Result: PASS (state up, installed true, linux, x64, ask with `grantable: false`).

## Step 2: `list_machines`. FAIL at the client; server payload PASS

The agent called `list_machines` at 11:28:16 (server log `tool call list_machines ok:true`). Claude Code's client rejected the result. The pane text:

```
conduit list_machines returned structuredContent as an array, but the MCP schema expects a record
(object), so the result failed validation
```

Cause (source): `src/conduit-mcp/tools.ts:666` returns `structuredContent: r.value`. For `list_machines`, `r.value` is `network.listMachines()`, an array (`prepareListMachines` in `src/conduit-mcp/machine-tools.ts:110`). MCP `structuredContent` must be an object. The tool declares no `outputSchema` (`tool-schemas.ts:471`), but Claude Code still enforces the object rule. The e2e (`net-machines.e2e.mjs`) does not catch this: its fake agent does not validate. So a real agent cannot use `list_machines` at all.

Server payload, read by running Conduit's own shim with the agent's endpoint and token (`S/bin/mcp-call.mjs <claude pid> list_machines`). This bypasses Claude's client, so it shows the server's payload, not what the client accepted:

```
[{"machine":"conduit-peer","machine_id":"m-e05b5517","target":"vm","state":"up","mode":"full",
  "os":"linux","arch":"x64","conduit_version":"0.66.1","agents":[],"sessions":0,
  "last_seen":"2026-11-16T11:31:41.946Z","survives_logout":true}]
```

Notes: the spec expected `name vm`. The row's `machine` is the machine's own name (`conduit-peer`); `vm` is the `target`. `sessions: 0` is what A reports while the link is up with no snapshot sessions; the count is not the same as B's view (see step 4).

Result: FAIL for the agent-visible tool (client validation error). PASS for the server row values.

## Step 3: reused connect. PASS

Asks before: 1. Sent 11:31:47.953Z.

```
REUSERES {"machine":"conduit-peer","machine_id":"m-e05b5517","state":"up","os":"linux","arch":"x64",
          "mode":"full","conduit_version":"0.66.1","reused":true,"installed":false,"upgraded":false}
```

Server log `tool call connect_machine ok:true` at 11:31:54.593Z (6.6 s after send, which includes the model's turn). Asks after: 1 (no new ask).

Result: PASS.

## Step 4: disconnect. PASS

B's session before the disconnect: created over a one-shot ssh with B's own node (nothing copied to the VM):

```
timeout 120 ssh -F $VMCFG -o BatchMode=yes -o ConnectTimeout=10 vm \
  "UD=/home/conduit/.config/conduit OP=create /home/conduit/.config/conduit/runtime/0.66.1/node --input-type=module -" < S/bin/vm-b.mjs
-> {"sessionId":"gwaxi3rooyt","started":{"ok":true,"generation":1,"spawned":true}}
```

The one-shot client does `hello` (machineId `m-e05b5517`), then `sessions.create {agentId:"shell:bash"}`, `term.resize`, `sessions.start`. The list op before the disconnect gave `sessions: [{id:"gwaxi3rooyt", agentId:"shell:bash", status:"running"}]`.

Disconnect, sent 11:32:20.769Z:

```
DISCRES {"machine":"conduit-peer","state":"down"}
```

Server log `tool call disconnect_machine ok:true` at 11:32:26.835Z (6.1 s after send, including the model's turn).

After the disconnect, from the VM:

```
vm-b.mjs OP=list -> {"machineId":"m-e05b5517","sessions":[{"id":"gwaxi3rooyt","agentId":"shell:bash","status":"running"}]}
pgrep -af conduit-hc ->
  29867 .../conduit-hc serve
  29873 .../conduit-hc hold --socket .../conduit-1a816e09d8ccec97.holder.1b2cc8b7.sock
  29880 .../node .../server/supervise.js --user-data /home/conduit/.config/conduit ...
  29890 .../node .../server/main.js --user-data /home/conduit/.config/conduit ...
```

A's `link.list`: the link to `m-e05b5517` is `state: "down"` (`since 11:32:26.834Z`). `list_machines` (through the agent's shim) gave the row with `state: "disabled"`.

No redial: `sleep 70`, then at 11:33:56.7Z the link was still `down`, `lastActivity` still 11:32:26.780Z, no dial lines in A's server.log after 11:32:26, and `pgrep -af link-stdio` on the VM found no bridge.

Result: PASS (state down; B's session alive; `disabled`; no redial).

## Step 5: reconnect. PASS

Asks before: 1. Sent 11:34:03.484Z.

```
RECONRES {"machine":"conduit-peer","machine_id":"m-e05b5517","state":"up","os":"linux","arch":"x64",
          "mode":"full","conduit_version":"0.66.1","reused":false,"installed":false,"upgraded":false}
```

Server log `tool call connect_machine ok:true` at 11:34:08.403Z (4.9 s after send). Asks after: 1.

Result: PASS.

## Step 6: needs-person. PASS for 6a and 6b; 6c NOT VERIFIED

Setup: server A stopped by its own path (`stop.mjs a`: app SIGTERM on its captured PID, then `hc kill` and `hc server stop`, both `ok`). A2 started with a fresh userData and a wrapper whose config has `UserKnownHostsFile $S/empty_known_hosts` (`vm-nokey.cfg`, a copy of `vm.sshconfig` with that one line changed; `BatchMode yes` and `StrictHostKeyChecking yes` kept):

```
node $S/bin/start.mjs a2 $S/a2-ud $S/ssh-vm-nokey
-> {"label":"a2",..."runtimeReady":true}
```

A claude session was started on A2 the same way as on A (trust prompt, Lead). Then, sent 11:36:15.254Z, `connect_machine vm`. The first attempt (11:35:06) returned `window_not_ready` because window 1 did not own the session yet (setup gap, see Step 0). After `ui.presence` with `ownedSessionIds`, the ask:

```
11:36:19.258Z ui.post route={kind:"owner",sessionId:"b2p2flowv6"}
  message={type:"mcp:ask", askId:"r_3nv6jse6jewk", tool:"connect_machine",
           summary:{tool:"connect_machine",machine:"vm",newMachine:true}, source:"session", grantable:false}
```

Approve, sent 11:36:23.630Z: `mcp.fromRenderer {"windowId":1,"message":{"type":"mcp:askAnswer","askId":"r_3nv6jse6jewk","answer":"approve"}}` -> ok.

### 6a: `ssh_needs_person`. PASS

```
NEED2RES {"error":{"code":"ssh_needs_person","message":"ssh needs a person to answer (host_key_unknown) before it can reach vm",
          "retryable":false,"hint":"ask the human to connect vm once from Machines","reason":"host_key_unknown"}}
```

Server log `tool call connect_machine ok:false code:ssh_needs_person` at 11:36:23.828Z, 0.2 s after approve.

### 6b: `machines.openNeedsPerson`. PASS

```
timeout 150 node ctl.mjs $S/state/a2 call machines.openNeedsPerson '{"target":"vm"}'
-> {"ok":true,"result":{"sessionId":"0kpylynca6b"}}
```

`events.subscribe` snapshot for that session:

```
id: 0kpylynca6b   agentId: conduit:command   status: exited
command.command: $S/ssh-vm-nokey
command.args: -o ControlMaster=yes -o ControlPath=/run/user/1000/conduit-ssh-44b8bda3355be845/%C
              -o ControlPersist=8h -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -- vm
```

The pane's text (persisted scrollback):

```
No ED25519 host key is known for [127.0.0.1]:47422 and you have requested strict checking.
Host key verification failed.
```

### 6c: answer `yes` and connect over the reused master. NOT VERIFIED

Reason: the wrapper's config keeps `BatchMode yes` (as the spec's copy does), so ssh never asks for the host key in the pane. The pane had already exited at this point, so nothing could be typed into it. I did not change the wrapper's batch mode, to keep to the spec's cfg. A follow-up would need a wrapper without `BatchMode` for the pane, and a check that bootstrap still fails cleanly without a tty.

## Step 7: teardown. PASS

- A2 stopped by its own path: `stop.mjs a2` (app SIGTERM on its PID, `hc kill` ok, `hc server stop` ok). A stopped the same way earlier (`stop.mjs a`).
- Before stopping A2, the captured candidates (ours by path or hc instance name) were listed. After the stop, the only match was my own shell, and the claude processes of A (pid 941637) and A2 (pid 948533) were gone.
- B stopped by its own path on the VM:

```
~/.config/conduit/runtime/0.66.1/node ~/.config/conduit/runtime/0.66.1/server/main.js \
  --stop-all --user-data ~/.config/conduit --hc ~/.config/conduit/runtime/conduit-hc/0.1.16/conduit-hc
-> rc=0; pgrep afterwards: none of ours
```

- VM: `rm -rf ~/.config/conduit` (it was absent at the start, so there was no `.bak` to restore). `~/.config` is empty again, as at the start.
- VM logind read-back after teardown: `Linger yes`, `KillUserProcesses b false`, `/etc/systemd/logind.conf.d/` empty (dir exists), `/var/lib/systemd/linger/conduit` present with mtime 09:12 (unchanged by this run). VM is running (`uptime` 7:19).
- Host: stale sockets removed by exact path (`/tmp/conduit-server-*`, `/tmp/conduit-link-*`, `/tmp/conduit-mcp-*` for the two instances `d1b1ba72fc194cb3` and `44b8bda3355be845`), and their empty ControlPath dirs under `/run/user/1000/`.
- `git status --short` in the worktree was empty before this report was written. The only change since is this report file, which is not committed.

Result: PASS.

## Deviations from the spec

- **No fixture agent.** The spec says start A without `--e2e`. The fake MCP agent (`e2e-fake-mcp`) is wired only under `--e2e` (`src/conduit-mcp/adapters.ts`, `e2eOnly: true`). So the agent is a real Claude Code 2.1.325 session (model Opus 5.5, auto mode), launched by Conduit with its own MCP wiring. It was told what to call through `term.input`. Its result lines are read from the pane (`pane.mjs` over the server's persisted scrollback, ANSI stripped, whitespace removed). Claude's transcript saving was off here (the `CLAUDE_CODE_CHILD_SESSION` marker was inherited from my environment), so the pane was the only record.
- **Trust prompt.** Each new work dir in Claude Code asks "Do you trust this folder?". I accepted it through `term.input` (Down, Enter). That writes a project entry into the user's `~/.claude.json` for the two scratch work dirs (`a-ud/work`, `a2-ud/work`). I did not revert it.
- **Owner window.** The app stand-in sets `ui.presence` with `ownedSessionIds` for the agent's session. Without it the agent's call returns `window_not_ready`.
- **Step 2 payload.** Read by running Conduit's shim with the agent's own endpoint and token (`mcp-call.mjs`). That is the server's payload, not Claude's view.
- **Session on B.** Created by a one-shot C2 client piped to B's own node over ssh. Nothing was copied to the VM. It was removed with the rest of `~/.config/conduit`.
- **Timing.** The agent's own turn adds a few seconds to the durations I quote from the agent's side. Server-log times are used where I quote a server duration.

## Observations for the owner

1. **`list_machines` cannot be used by a real Claude Code agent (step 2).** The result's `structuredContent` is an array (`src/conduit-mcp/tools.ts:666` with `listMachines()`), and Claude Code rejects non-object `structuredContent`. The fake-agent e2e does not catch it. A fix would change the shape of that one result (or wrap it as an object), which is a product decision, so it is left to the owner.
2. **`survives_logout` is `true` on this VM** (row, step 2). Not re-measured here.
3. **`sessions: 0` in the `list_machines` row** while B has a running session (step 2 and step 4). The count is A's view while the link is up with no snapshot session. The owner may want to know it can read 0 for a live machine.
4. **The row name.** The row's `machine` is the machine's own name (`conduit-peer`), and the ssh alias is `target: vm`. The spec's step 2 said `name vm`. Whether `machine` should be the alias is for the owner.

## NOT VERIFIED

- **6c.** Typing `yes` into the needs-person pane and connecting over the reused master. The spec's wrapper keeps `BatchMode yes`, so ssh never prompts in the pane, and the pane exits at once (see 6c).
- **Redial after a dropped link** (not one of this run's steps; out of scope).

## Final summary

| # | Step | Result |
|---|------|--------|
| 0 | Setup (A without `--e2e`, real claude agent, Lead) | PASS (deviation: real claude, not fixture) |
| 1 | Fresh connect (ask grantable false; up, installed, linux, x64; 7.2 s after approve) | PASS |
| 2 | `list_machines` | FAIL at client (structuredContent array); server row PASS |
| 3 | Reused connect (no ask) | PASS |
| 4 | Disconnect (down; B session running; disabled; no redial in 70 s) | PASS |
| 5 | Reconnect (up, reused false) | PASS |
| 6a | `ssh_needs_person` host_key_unknown, hint | PASS |
| 6b | `machines.openNeedsPerson` (session, ssh wrapper, ControlMaster=yes) | PASS |
| 6c | Answer `yes` in pane; connect over reused master | NOT VERIFIED (BatchMode yes, pane exited) |
| 7 | Teardown (A, A2, B by own paths; VM config removed; logind as at start) | PASS |
