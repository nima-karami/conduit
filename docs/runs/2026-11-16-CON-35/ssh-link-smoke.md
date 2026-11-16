# CON-35 ssh stdio link: runtime smoke against a real sshd

Run: 2026-11-16, 06:55Z to 07:04Z (UTC).
Commit under test: `27634faa` (branch `con37-s3`, built from `git archive`, not from the worktree).
Target: a headless Linux VM (Ubuntu 26.04 cloud image, OpenSSH, QEMU PID 199137, host alias `vm`, user `conduit`).
Scratch: `/tmp/claude-1000/-home-namemenima-projects--wt-conduit-CON-35/7e0abefc-f499-4ed4-883c-1e77266b51a9/scratchpad/smoke` (called `S` below).
Drivers written for this run are in `S/bin/` (`launch.cjs`, `stop.cjs`, `c2.mjs`, `c2-peer.mjs`, `c2-auth.mjs`, `msg.mjs`, `poll.mjs`, `step6.sh`).
No GUI was launched. Electron did not run. Nothing was committed.

Every ssh and scp call used `timeout 60 ssh -F <vm.sshconfig> -o BatchMode=yes -o ConnectTimeout=10` (scp under `timeout 300`), except the ssh bridge that the server itself spawns through `CONDUIT_SSH_PATH`, which is a long-lived stdio child and cannot carry a timeout.

## Summary

| # | Step | Result | Key observation |
|---|------|--------|-----------------|
| 1 | Build code under test | PASS | `esbuild.mjs` done in 1653 ms; `out/server/{main,supervise,instance-names}.js` present |
| 2 | Learn the standalone bring-up | PASS | Supervisor via `hc run --bg --no-parent --name <supervisorName>`; hc 0.1.16 |
| 3 | Start B on the VM | PASS | Secret and link endpoint both mode 600; `conduit-link.sock` is a socket |
| 4 | A dials B with `link.sshAdd` | PASS | `{ok:true, machineId:"m-8eff91b9"}` matches B's own id; A `transport ssh`, `state up`; B `links.json` has an ssh record for A with `ssh: null` |
| 5 | Message A to B | PASS | Delivered as a `msg` record in B's `conduit-mcp/messages.log` (fake MCP agent, not the e2e harness) |
| 6a | Link goes not-up while VM is frozen | PASS (caveat) | `degraded/ssh` at +15.0 s after SIGSTOP. It never became `down` or absent |
| 6b | Message enqueued while down | PASS | `status: queued` at +15.4 s, while the VM was still stopped |
| 6c | Link up again after SIGCONT | PASS for "up"; redial NOT VERIFIED | `up/ssh` 67 ms after SIGCONT. The ssh session survived the stall, so no redial happened |
| 6d | Exactly-once delivery | PASS | Queued message count on B = 1 before and after a marker message |
| 7a | Bridge with no secret | PASS | rc 3, stderr `conduit-bridge: no_secret` |
| 7b | Bridge with garbage on stdin, B audit `bridge.refused` | FAIL against the stated expectation | rc 0, no `bridge.refused` line. The bridge sends its own preamble first, so stdin bytes never reach the preamble check. A raw `xxxx` sent to B's link endpoint did produce `bridge.refused` (`bad_preamble`) |
| 8 | Teardown and VM state | PASS | A and B stopped by their own paths; no processes or dirs of mine left on the VM; QEMU `Sl` (running, not stopped) |

Overall: the ssh stdio link is established against a real sshd, carries a message, and delivers a message queued across a VM freeze exactly once. The one failing expectation is step 7b, which rests on a wrong premise about where stdin is checked (details below). Redial after a dropped link is not exercised by this run.

## Step 1: build the code under test

```
mkdir -p $S/src && git -C /home/namemenima/projects/.wt/conduit/CON-35 archive 27634faa | tar -x -C $S/src
ln -sfn /home/namemenima/projects/.wt/conduit/CON-35/node_modules $S/src/node_modules
(cd $S/src && node esbuild.mjs)
```

Observed: `Done in 1653ms`. `out/server/` contains `main.js` (1,349,167 B), `supervise.js` (104,552 B), `instance-names.js` (36,559 B), plus maps.

Result: PASS.

## Step 2: how a standalone server is started for tests

Read from `test/e2e/net-helpers.mjs` `startServer`, `test/e2e/net-ssh-link.e2e.mjs`, `test/e2e/c2-peer.mjs`, `test/e2e/c2-auth.mjs`:

- `HC = resolveHcBinary()` returns `build/vendor/hc/conduit-hc` (the vendored binary). `HC_VERSION = '0.1.16'`, checked with `hc --version`.
- Names (`supervisorName`, `serverEndpoint`, `linkEndpoint`, `hcSession`) come from `out/server/instance-names.js` `instanceNames(userData, platform, tmpdir)`.
- Env is `coreStartEnv(parent, names)` plus `CONDUIT_USER_XDG_CONFIG_HOME`, `CONDUIT_USER_XDG_STATE_HOME`, `CONDUIT_USER_XDG_CAPTURED=1`. The cwd is `<userData>/runtime/conduit-hc/0.1.16`.
- Supervisor: `hc run --bg --no-parent --name <supervisorName> --label conduit.role=server -- <node> out/server/supervise.js --user-data <ud> --e2e --hc <hc>`.
- C2 attach: `hello {appVersion, generation:1, auth: <server-secret>}`, `server.setLogging`, `events.subscribe`, `ui.presence` with one ready window.
- Stop: `hc kill <supervisorName>` then `hc server stop` in the same session (`stopHc`). For B the stop path is `main.js --stop-all --user-data <ud> --hc <hc>`, which reads auth from the secret file.

The launcher `S/bin/launch.cjs` copies that bring-up. `S/bin/stop.cjs` copies `stopHc`. `S/bin/c2.mjs` copies `attachApp` and runs a list of calls over one connection.

Result: PASS (learned the path).

## Step 3: start B on the VM

Copy:

```
timeout 300 scp -F vm.sshconfig -q S/src/out/server/*.js S/src/out/server/*.map vm:conduit-smoke/server/
timeout 300 scp -F vm.sshconfig -q /home/namemenima/projects/conduit/build/vendor/hc/conduit-hc vm:conduit-smoke/hc/conduit-hc
```

The first attempt used `CON-35/build/vendor/hc/conduit-hc`, which does not exist in the worktree. The binary was taken from `/home/namemenima/projects/conduit/build/vendor/hc/conduit-hc` as the spec says. `hc 0.1.16` on both host and VM.

Start (detached):

```
setsid -f sh -c "exec ~/g7node ~/conduit-smoke/bin/launch.cjs ~/conduit-smoke ~/conduit-smoke/hc/conduit-hc ~/.conduit-smoke ~/g7node > ~/conduit-smoke/launch-b.out 2>&1"
```

`~/conduit-smoke/out/server` was a symlink to `~/conduit-smoke/server` so the names module resolves. Output: `supervisorName: conduit-server-986a4c30580d7c53`, `hcSession: conduit-986a4c30580d7c53`, `serverEndpoint: /home/conduit/.conduit-smoke/conduit-server.sock`, `status 0`.

Observed after 10 s:

```
-rw------- conduit conduit 43  server-secret      (mode 600)
-rw------- conduit conduit 46  link-endpoint       (mode 600)
srw------- conduit conduit 0   conduit-link.sock   (socket)
srw------- conduit conduit 0   conduit-server.sock (socket)
```

Restart for agents: B was first started with no `agents.json`, which step 5 needs. At 06:59:01Z B was stopped with `stop.cjs` (`hc kill` status 0, `server stop` stopped:true), `agents.json` was written, and it was relaunched at 06:59:07Z with the same command. The userData and the link record survived the restart. Step 5 relied on that second start.

Result: PASS.

## Step 4: A locally, then link.sshAdd

A was launched on the host from `S/src` with a temp userData `S/a-ud`, the vendored hc, and `CONDUIT_SSH_PATH=S/ssh-vm`:

```
S/ssh-vm:  #!/bin/sh
           exec ssh -F <vm.sshconfig> "$@"
node S/bin/launch.cjs S/src <hc> S/a-ud <node> CONDUIT_SSH_PATH=S/ssh-vm
```

Start A's C2 (`c2.mjs`, `hello` with A's `server-secret`), then:

```
link.sshAdd {ssh:{target:'vm', node:'/home/conduit/g7node', mainJs:'/home/conduit/conduit-smoke/server/main.js', userData:'/home/conduit/.conduit-smoke'}}
```

Observed at 06:57:32Z:

```
{"ok": true, "machineId": "m-8eff91b9"}
```

B's `link.list` returned `machineId: "m-8eff91b9"` (self), so the ids match. A `link.list` then showed:

```
transport: "ssh", state: "up", name: "conduit-peer", trust: "own"
```

B `network/links.json` (read with one-shot ssh), abbreviated:

```
{"version":2,"links":[{"linkId":"l_9038fef2d31dd9cb","machineId":"m-39133873","name":"Awby",
  "trust":"own","transport":"ssh","ssh":null, ...}],"tombstones":[]}
```

File mode 600. The record for A is there with `ssh: null`, as expected on the bridge side. A's own `links.json` has `"ssh":{"target":"vm","node":"/home/conduit/g7node",...}`.

Restart note: A was restarted at 06:58:36Z to pick up `agents.json` (needed by step 5). After the restart the ssh link came back to `up` on its own at 06:58:41.812Z, about 5 s later, with no new `sshAdd`. That is an observation about the persisted link record, not something this run was testing.

Result: PASS.

## Step 5: message A to B

The spec's preferred harness (`startAgent`/`callTool` from `net-ssh-link.e2e.mjs`) needs a fake MCP agent on each side. That was used:

- `agents.json` on A and B registers `e2e-fake-mcp` running `test/e2e/fixtures/fake-mcp-agent.mjs --records <dir>`.
- The shim (`resources/conduit-mcp/conduit-mcp-shim.cjs`) was copied to `~/resources/conduit-mcp/` on the VM, because B derives its resource root from `~/conduit-smoke/server/`. It was removed at teardown.
- `S/bin/msg.mjs start` creates an A session, sends `term.resize`, `sessions.start`, waits for `READY` with `send_message`. Result: session `da7hhroxc17`, generation 1.
- B session created with one-shot `c2.mjs` on the VM: `sessions.create` gives `1zm56aqknvv`, then `!term.resize` and `sessions.start` give generation 1. B's records show `READY` with `send_message`.
- `msg.mjs list` on A polled `list_sessions` until B's session appeared (`fake-1@m-8eff91b9` after about 20 s).
- `msg.mjs send "smoke-1 A to B over ssh"` (A's `send_message` tool call):

```
{"status": "queued", "message_id": "m_27kvqle4ravyicrr", "recipients": [{"handle":"fake-1@m-8eff91b9","status":"queued"}]}
```

B `conduit-mcp/messages.log` (read over ssh, 3 lines at the time) contains:

```
{"v":1,"t":"msg","msg":{"messageId":"m_jok4wmtjawjcevrk","originMessageId":"m_27kvqle4ravyicrr",
 "from":"fake-1@m-39133873","to":["fake-1"],"kind":"inform","body":"smoke-1 A to B over ssh",...}}
{"v":1,"t":"rcpt","messageId":"m_jok4wmtjawjcevrk","handle":"fake-1","status":"noticed",...}
{"v":1,"t":"rcpt","messageId":"m_jok4wmtjawjcevrk","handle":"fake-1","status":"read",...}
```

Result: PASS.

## Step 6: dead link and exactly-once

Captured QEMU PID `199137` from `~/.cache/conduit-vm/con27/run/qemu.pid`. Its cmdline was checked for `con27` before the first signal. `S/bin/step6.sh` ran under a trap `EXIT INT TERM` that sends SIGCONT when the pid is in state T. `S/bin/poll.mjs` reads A's `link.list` once a second.

Before: B `messages.log` had 1 line with `originMessageId` (step 5).

Timeline (UTC):

| Time | Event |
|------|-------|
| 07:00:52.279 | `kill -STOP 199137`; qemu state `Tl` |
| 07:00:52.340 | poll: `up/ssh` (first sample) |
| 07:01:07.359 | poll: `degraded/ssh`, +15.0 s |
| 07:01:07.368 | `msg.mjs send "smoke-2 queued while link down"`: `status: queued`, `message_id: m_5piu3margproonwg` |
| 07:01:07.542 | `kill -CONT 199137`; qemu state `Sl` |
| 07:01:07.609 | poll: `up/ssh`, +67 ms after CONT |
| 07:01:07.943 | queued message seen on B (`count=1`) |
| after | marker `smoke-2 marker` sent, seen on B (`count=1`) |
| end | final count of `m_5piu3margproonwg` on B = 1; B has one `msg` record for body `smoke-2 queued while link down` |

Results:

- **6a dead-link detection: PASS, with a caveat.** The link left `up` at +15.0 s, but to `degraded`, not `down`. Within the 60 s window it never reached absent or `down`. Read literally, "not up" is met. The stall did not produce a dead-link drop.
- **6b enqueue while down: PASS.** Enqueued while the state was `degraded`, 15 s into the freeze.
- **6c link up after SIGCONT: PASS for "up", redial NOT VERIFIED.** The state returned to `up` within 67 ms of SIGCONT. The ssh session survived the 15 s stall (the vm config has no `ServerAliveInterval`, and TCP resumed when the VM did), so no redial happened and the redial path is not exercised here. The e2e `net-ssh-link` scenario covers the redial with a killed bridge; this run did not repeat that.
- **6d exactly once: PASS.** The queued message was delivered once (`count=1`) and remained `1` after the marker message, which drains the outbox in the same way the e2e does.

Result: PASS for 6a (not-up), 6b, 6d. PASS for 6c "up". Redial is NOT VERIFIED.

## Step 7: bridge failure paths

7a, exactly as specified:

```
timeout 30 ssh -F vm.sshconfig -o BatchMode=yes -o ConnectTimeout=10 vm \
  '~/g7node ~/conduit-smoke/server/main.js --link-stdio --user-data /tmp/nonexistent-ud' </dev/null
```

Observed: rc 3. stdout empty. stderr `conduit-bridge: no_secret`.

Result: PASS (code 3, `no_secret`).

7b, as specified:

```
printf 'xxxx' | timeout 30 ssh -F vm.sshconfig -o BatchMode=yes -o ConnectTimeout=10 vm \
  '~/g7node ~/conduit-smoke/server/main.js --link-stdio --user-data ~/.conduit-smoke'
```

Observed: rc 0. stdout is a bridge `hello` frame from B (`{"t":"hello","machineId":"m-8eff91b9",...}`). stderr empty. B `network/audit.jsonl` has no `bridge.refused` line (count 0).

Why this is a FAIL against the expectation: `server/lifecycle/link-stdio-bridge.ts` writes its own valid `{t:'bridge', v:1, secret}` preamble to the endpoint before it pipes stdin. The server's preamble check (`server/network/stdio-link-endpoint.ts` `admit`) sees only that valid preamble. The `xxxx` bytes go after it, into the link protocol, not into the preamble check. So garbage on stdin cannot produce a `bridge.refused` line by design. The expectation in the spec was based on a wrong premise.

Supplementary check (not part of the spec, to show the refusal path does audit): `xxxx` written directly to B's `conduit-link.sock` by a node one-liner on the VM. Audit before: 7 lines. Audit after gained:

```
{"v":1,"at":"2026-11-16T07:01:58.168Z","kind":"bridge.refused","peer":null,"detail":{"reason":"bad_preamble"}}
```

Result: step 7b as specified FAIL. The refusal path itself PASS (supplementary, `bad_preamble`).

## Step 8: teardown and VM state

A stopped with the same `stop.cjs` used by `stopHc`:

```
hc kill conduit-server-d6fdac0ccd57afc9 -> status 0
hc server stop -> status 0 {"stopped":true}
```

Afterwards no processes matched my A userData path. Before the stop, `ps` matched 3 of my node processes (supervisor, server, and a fake agent), all gone after the stop.

B stopped with its own path:

```
~/g7node ~/conduit-smoke/server/main.js --stop-all --user-data ~/.conduit-smoke --hc ~/conduit-smoke/hc/conduit-hc
-> stop-all rc=0
```

Cleanup notes:

- Host: one leftover ssh ControlMaster from A (`ssh: /run/user/1000/conduit-ssh-d6fdac0c... [mux]`, PID 437878) was killed by PID after its cmdline matched my A instance. Stale host sockets in `/tmp/conduit-*-d6fdac0ccd57afc9.sock` and the empty `/run/user/1000/conduit-ssh-d6fdac0ccd57afc9/` directory were removed.
- Host: an extra `hc serve` (PID 16686, default session) was started by one of my own `hc ls` calls on the VM. It was killed by PID after I confirmed it was not the B core. Other `hc` processes on the host (user's own sessions) were not touched.
- VM: `rm -rf ~/conduit-smoke ~/.conduit-smoke ~/resources`. `~/resources` did not exist before the run and held only `conduit-mcp/` (two files), which I had copied in.
- VM: final `pgrep -af "conduit-smo[k]e|/home/conduit/resources"` returned only its own bash command. The bracket pattern avoids self-matching on the literal text; no other process remained.
- VM stays running: QEMU PID 199137 state `Sl`, not `T`. The VM was never stopped or killed.

Result: PASS.

## Deviations from the spec

- B needed a second start (06:59) to add `agents.json`. A needed one (06:58) for the same reason. Both reconnected on their own.
- Messaging used a small driver (`S/bin/msg.mjs`), not the e2e helpers, because `startAgent`/`callTool` live in a harness that also mutates env and registers exit hooks. The calls are the same ones: `sessions.create`, `term.resize`, `sessions.start`, `list_sessions`, `send_message`.
- `resources/conduit-mcp` was copied to the VM and removed at teardown.
- The first `scp` of the hc binary used the wrong path (`CON-35/build/vendor`) and failed; it was redone from the path the spec gives.
- Step 7b, the spec's stdin-garbage check, does not exercise the preamble check (see step 7). Reported as FAIL against that expectation.

## NOT VERIFIED

- **Redial after a dropped link** (6c). The ssh session survived the 15 s stall, so no new bridge was spawned. To verify, a run would need to kill the bridge (as the e2e does) or cut the TCP path long enough for ssh to exit.
- **Real dead-link detection by ssh.** The vm config has no `ServerAliveInterval`, so detection by ssh itself was not tested here. The only "not up" came from the link's `degraded` state, which I observed rather than explained.
- **Windows and the e2e suite.** Not run; out of scope for this smoke.

## Orchestrator notes (2026-11-16)
- Step 7b's expected result was wrong in the brief, not in the code: the bridge always writes its own valid preamble, so garbage on its stdin goes to the link (and fails the hello), never to the preamble check. The refusal path is proven by the raw-endpoint probe in 7b and by the e2e (`net-ssh-link` phase 4).
- Redial over real sshd is not exercised here (the 15 s freeze ended before ssh's 5 s × 3 keepalive gave up; gates.md G6 measured 16–18 s). Redial after a dropped link is proven on Windows by `net-ssh-link` phase 3 (bridge killed, exactly-once after redial), run 43820106726.
- Code under test was 27634faa; the merged slice adds only c423f380 (pending-set eviction), which does not touch the paths smoked here.
