# CON-38 bootstrap: runtime smoke against a real sshd (Slice 5)

Run: 2026-11-16, 08:57Z to 09:13Z (UTC). Commit under test: `17b614f3` (branch `CON-35-remote-ssh`), built from `git archive`, not from the worktree.
Target: headless Linux VM (Ubuntu 26.04, OpenSSH 10.2p1, QEMU PID kept running), host alias `vm`, user `conduit`, passwordless sudo.
Scratch (called `S`): `/tmp/claude-1000/-home-namemenima-projects--wt-conduit-CON-35/7e0abefc-f499-4ed4-883c-1e77266b51a9/scratchpad/smoke38`.
Drivers: `S/bin/` (`launch38.cjs`, `stop.cjs`, `c2.mjs`, `c2-peer.mjs`, `c2-auth.mjs`, `row.sh`, `msg38.mjs`). Local server A ran without `--e2e` for the bootstrap steps.
No GUI was launched. Electron did not run. Nothing was committed. `hc server status` was not run.

## Summary

| # | Step | Result | Key observation |
|---|------|--------|-----------------|
| 1 | Fresh bootstrap | PASS | `ok:true`, `installed:true`, 6.53 s. Node and hc sha256 equal the `binSha256` pins. `server-secret`, `link-endpoint`, `server-version` are mode 600. A: ssh link `up`. |
| 2 | Reuse | PASS | `reused:true`, `installed:false`, same machineId `m-7b32f96c`, 0.67 s. File paths, sizes and mtimes on the VM unchanged. |
| 3a | Logout, KUP=no, linger on (method scope, inferred) | PASS | `survivesLogout:true`. B alive at +20 s; hello answered. |
| 3b | Logout, KUP=no, linger off (plain) | FAIL (plan decision 4 falsified) | The bootstrap's own `hc` turned linger on at start. With linger off at logout (set after the start), B died when the user manager stopped (about 10 s after the close). The first run without that reset survived, but only because of linger. |
| 3c | Logout, KUP=yes, linger off (plain) | PASS for the spec as written; FAIL for the as-shipped flag | With linger off at logout, the summary's `survivesLogout:false` was right and B died. As shipped (no reset), `hc` turned linger on, B survived, and the flag still said `false`. |
| 4 | Message A to B over the bootstrapped link | NOT VERIFIED | The fake-agent fixture is wired only under `--e2e`, on A and on B. B is started by the product path with no `--e2e`, so the agents never got wired. |
| 5 | Upgrade (synthetic 0.0.1 server) | PASS for the version swap; agent survival NOT VERIFIED | `upgraded:true`; `server-version` 0.0.1 to 0.66.1; the old server replaced; hc core PIDs unchanged. A 0.66.1 fake agent process disappeared during the upgrade, and this was inconclusive. |
| 6 | Teardown and VM state | PASS | Both servers stopped by their own paths. `~/.config/conduit` and `~/conduit-smoke38` removed. KUP false, linger yes (the starting state). No drop-in. |

Headline for the user: the bootstrap installs and reuses correctly against real sshd, with pinned bytes. Plan decision 4's assumption does not hold. `hc server start` does not survive logout on its own. It survives because it turns linger on for the user, and `survivesLogout` reports the probe's inputs, not the state after the start. The decision for the owner is listed under Findings.

## Step 0: build, server A, C2 client, VM state

Build (`git archive 17b614f3 | tar -x -C $S/src`, `node_modules` symlinked, `node esbuild.mjs`): `Done in 1530ms` and `Done in 1608ms`. `out/server/{main,supervise,instance-names}.js` present. PASS.

Pins check on the host: `vendor/node/node` is v24.18.0 with sha256 `41a74efb…` (equal to `binSha256` for linux-x64). `vendor/hc/conduit-hc` is 0.1.16 with sha256 `8c4c0930…` (equal to its `binSha256`).

Server A (`launch38.cjs` is `launch.cjs` with `--e2e` removed):

```
CONDUIT_SSH_PATH=$S/ssh-vm CONDUIT_NODE_BINARY=/home/namemenima/projects/conduit/build/vendor/node/node \
  node $S/bin/launch38.cjs $S/src <vendored hc> $S/a-ud <vendored node> CONDUIT_SSH_PATH=... CONDUIT_NODE_BINARY=...
-> "status": 0, names.serverEndpoint "/tmp/conduit-server-c10635a2e5868523.sock"
```

`$S/ssh-vm` is `exec ssh -F <vm.sshconfig> "$@"`. The C2 client (`c2.mjs`) does `hello` with A's `server-secret`. `link.list` on A returned `machineId:"m-40fb935b"`, no links. Its `ssh` wrapper is long-lived, so it cannot carry a `timeout`. The one-shot bootstrap ssh calls inside A are not wrapped either. Every host ssh I ran carried `timeout 120 ssh -F … -o BatchMode=yes -o ConnectTimeout=10`.

VM before the run: `ls ~/.config/conduit` gave "No such file or directory", so nothing was moved aside. Defaults: `KillUserProcesses` false, `Linger=yes`, no drop-in. Host reachability from the VM: `curl -I https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` 200 in 0.05 s; `curl -I https://releases.herdr.dev/core/0.1.16/herdr-core-linux-x86_64.tar.gz` 200 in 0.41 s. So the real download path was available. No `--e2e` was used. `CONDUIT_E2E_NO_DOWNLOAD` was not set.

## Step 1: fresh bootstrap. PASS

```
c2.mjs $S/a-ud <server A endpoint> '[["link.sshBootstrap",{"target":"vm"}]]'
start 2026-11-16T08:58:53.340Z   end 2026-11-16T08:58:59.878Z   (6.533 s)
{"ok": true, "machineId": "m-7b32f96c",
 "ssh": {"target":"vm","node":"/home/conduit/.config/conduit/runtime/0.66.1/node",
         "mainJs":"/home/conduit/.config/conduit/runtime/0.66.1/server/main.js",
         "userData":"/home/conduit/.config/conduit"},
 "summary": {"os":"linux","arch":"x64","installed":true,"upgraded":false,"reused":false,"survivesLogout":true,"version":"0.66.1"}}
```

`survivesLogout:true` at this point (KUP=no, linger yes, systemd-run present) means method scope, per the probe rule in `src/network/remote-scripts.ts` (`linger === true && systemdRun` gives `scope`). The method was inferred from the rule, not observed directly.

VM layout (`ls -la`, `stat`, `sha256sum` on the VM):

```
~/.config/conduit/runtime/0.66.1/node          123655872 B  mtime Jun 23 17:48  (archive member time)
~/.config/conduit/runtime/0.66.1/server/       instance-names.js, main.js (1422055 B), supervise.js (104564 B) + maps
~/.config/conduit/runtime/conduit-hc/0.1.16/conduit-hc   7632024 B  mtime Oct 31 21:32  (archive member time)
~/.config/conduit/runtime/shim/conduit-mcp-shim.cjs  node  (node copied on B, mtime now)
sha256 runtime/0.66.1/node          41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c  == binSha256 (linux-x64 node)
sha256 runtime/conduit-hc/0.1.16/conduit-hc 8c4c0930974e2b31978cbbb14b892cd29d5ace917f4c04ce6dfdd5573e1fe193  == binSha256 (linux-x64 hc)
server-secret      600   link-endpoint  600   server-version  600
server-version: {"version":"0.66.1","linkMajor":1}
```

Download versus push: both binaries keep their archive member mtimes (Jun 23, Oct 31), which a plain `cat >` push would not do. The VM also reaches both pin hosts. So the download path ran. This is an inference from the mtimes, not a logged fact.

A's view, `link.list`: `{"machineId":"m-7b32f96c","name":"conduit-peer","transport":"ssh","state":"up","trust":"own"}`. B's `network/links.json` (mode 600) has the record for A with `"transport":"ssh","ssh":null`. PASS.

Observation: B's `server.log` says `hook client missing; Claude hooks not injected` (`runtime/shim/conduit-hook.cjs` absent; the bootstrap pushes only the MCP shim). Not a bootstrap failure, but agent CLIs on B would have no hooks.

## Step 2: reuse. PASS

Snapshot (`find ~/.config/conduit/runtime … -printf "%p %s %TY-%Tm-%Td %TT"`) before and after the second bootstrap, `diff`ed:

```
bootstrap: start 2026-11-16T08:59:31.160Z   end 08:59:31.837Z   (0.673 s)
{"ok": true, "machineId": "m-7b32f96c", ...,
 "summary": {"installed": false, "upgraded": false, "reused": true, "survivesLogout": true, "version": "0.66.1"}}
diff of snapshots: only the `date` line changed (08:59:31 -> 08:59:32). No path, size or mtime changed.
```

Same machineId. Nothing re-downloaded. PASS.

## Step 3: logout survival

Procedure (`S/bin/row.sh`, per row):

1. Set logind state with sudo: drop-in (`/etc/systemd/logind.conf.d/g7.conf` written or removed), `systemctl restart systemd-logind`, `loginctl enable-linger|disable-linger conduit`. Read back with `busctl … KillUserProcesses` and `loginctl show-user conduit -p Linger --value`.
2. Stop A by its own path (`stop.cjs`: `hc kill` then `hc server stop`). Capture by PID any ssh master or bridge whose cmdline holds A's ControlPath leaf `conduit-ssh-c10635a2e5868523` and kill it. That master is `ControlPersist=60`, so it outlives A for a minute.
3. Stop B by the documented path: `node main.js --stop-all --user-data ~/.config/conduit --hc <vm hc>`, rc 0.
4. Start A again (`launch38.cjs`), then `link.sshBootstrap` (B starts with the method the probe picks).
5. Record B's processes, cgroups, user manager and sessions.
6. Close every session: stop A again (this closes the link's bridge) and kill any captured ControlMaster by PID. Confirm no host ssh to the VM remains, and list VM sessions.
7. Wait 20 s, then a fresh one-shot ssh check: pgrep lookup (excluding the check's own shell), user manager, `server-version`, socket. Then a hello over an `ssh -L` unix-socket tunnel (`link.list` against B).

Note on listings: `loginctl list-sessions` run from ssh always includes that ssh's own session. The session 187 (`class manager`) is the user manager's own session, created by logind when it restarts.

### 3a: KUP=no, linger on (method scope, inferred). PASS

Setup readback: `KUP=b false linger=yes dropins=[]`. Bootstrap during this row: `reused:true, installed:false, survivesLogout:true` (time 09:02:36.545 to 09:02:37.133).

```
close time 09:02:41.224Z   (host: no ssh to the VM left; the one ControlMaster was killed by PID 682437 of the captured set)
check-time 09:03:01.615Z (20 s after close)
user manager: 13485 (lstart 05:13:13) still running, user state active (linger yes)
B procs: conduit-hc serve 21766, conduit-hc hold 21772, supervise.js 21779, main.js 21789 (all running)
socket: conduit-server.sock present; server-version {"version":"0.66.1","linkMajor":1}
hello via tunnel: link.list answered, machineId m-7b32f96c (B), link to m-40fb935b (A)
```

The first run of this row had a tunnel error: the `-L` spec used a long socket path, which OpenSSH refused ("Bad local forwarding specification"). The row was rerun with the socket under `$XDG_RUNTIME_DIR`. The first run had B alive and no hello. The result above is the rerun.

### 3b: KUP=no, linger off (plain). FAIL

This row ran twice. The two runs differ on one point, and that point is the finding.

**3b-i (as specified: linger off before the start, nothing else touched).** `KUP=b false linger=no`. The bootstrap gave `survivesLogout:true`. Afterwards linger was on again:

```
linger file after bootstrap: /var/lib/systemd/linger/conduit 2026-11-16 09:03:29.685 (created at the bootstrap start)
Linger=yes
user manager 13485 still running (lstart 05:13:13)
check at 09:03:54: B procs alive (conduit-hc serve/hold, supervise.js, main.js); server-version 0.66.1
hello via tunnel: answered, machineId m-7b32f96c, link to m-40fb935b
```

The file was created by `hc`, not by sudo. The journal shows no `sudo` command at 09:03:29. The vendored `conduit-hc` binary contains the messages `hc: turned on linger for <user>, so the core outlives your logins` and `hc: the core stops when your last login ends; sudo loginctl enable-linger <user> keeps it`, and the `loginctl enable-linger` call they guard. So `hc server start` turned linger on by itself, and B's survival in 3b-i is due to linger, not to the plain start. This run also was not a valid test of "linger off at logout".

**3b-ii (the same row, with linger switched off again after the start, before the close).** Added step: `sudo loginctl disable-linger conduit` after the bootstrap, read back as `Linger now=no`.

```
row start 09:05:17 (setup); B started 09:05:33 by the bootstrap (reused:true, survivesLogout:true)
linger file after bootstrap: 2026-11-16 09:05:34.094 (hc created it again)
post-start: disable-linger -> Linger now=no, linger file gone
close time 09:05:39.533Z
journal: 09:05:49 user@1000.service stopping; hc-serve-0ac6ac3b.service and hc-hold-0a9f0e1f.service stopped
         ("Unit process 24296 (MainThread) remains running after unit stopped" for hc-hold)
         user manager 13485 stopped; user@1000.service deactivated
check at 09:06:00: user manager is a new pid 24608 (started by the check session); no B process
lookup (excluding the check's own shell): empty; tunnel hello: error, no answer
```

Result: B did not survive logout under KUP=no with linger off. The user manager stopped about 10 s after the last session closed, and took the hc units (B's `hc serve`, `hc hold`, `supervise.js`, `main.js`) with it. Plan decision 4's assumption ("hc's daemonizing `server start` survives like `setsid`") is false on this VM. The `setsid` analogy does not hold, because hc places B in its own transient units under `user@1000.service` (`app.slice/hc-*.service`), and those units end with the user manager.

### 3c: KUP=yes, linger off (plain). Spec row PASS; as-shipped flag FAIL

**3c-i (with the post-start linger reset, the spec's state at logout).** Setup readback: `KUP=b true linger=no dropins=[g7.conf]`.

```
bootstrap: reused:true, installed:false, survivesLogout:false  (ok:true, machineId m-7b32f96c)
linger file after bootstrap: 2026-11-16 09:06:40.419 (hc created it)
post-start: disable-linger -> Linger now=no
close time 09:06:45.856Z
check at 09:07:06 (new user manager pid 25956): no B process; hello: error
```

B died at logout, which is what the row expects. The flag `survivesLogout:false` was correct for this state.

**3c-ii (as shipped: linger off before the start, no reset).** Same setup, no post-start reset.

```
bootstrap: ok:true, reused:true, survivesLogout:false
linger file after bootstrap: 2026-11-16 09:07:33.090 (created by hc)
B processes after close: conduit-hc serve 26859 / hold 26868 / supervise.js 26876 / main.js 26886 (alive)
check at 09:07:58.419: user manager 25956 (lstart 09:07:05) still running, user state active
hello via tunnel: answered, machineId m-7b32f96c, link to m-40fb935b
```

B survived logout, while the summary said `survivesLogout:false`. The flag comes from the probe's `kup` and `linger` before the start, not from the state after it. In practice, when KUP=yes and linger is off, the start turns linger on, and the server then survives. The flag is wrong for the state the server actually ends in.

### 3 not run

KUP=yes with linger on, which is the `scope` case under KUP=yes. Not in the spec's three rows.

## Step 4: messaging A to B. NOT VERIFIED

Attempted. The earlier smoke's `msg.mjs` was adapted into `S/bin/msg38.mjs`. Both sides got the fixture agent `e2e-fake-mcp` (`agents.json` on A and on B, the fixture copied to the VM). A's session spawned, but its records show `unwired`, with `tools: []`, and no `send_message`:

```
records: {"kind":"ARGV","argv":["--records", ".../a-ud/records"]}  {"kind":"READY","tools":[]}
```

Cause: `src/conduit-mcp/host.ts` wires the fixture agent only through `adapterFor(def, { e2e })`, which is `true` only under `--e2e`. The earlier smoke ran with `--e2e` on both sides. The bootstrap's B start has no `--e2e`, so with the product path B's agents cannot be wired. Running B with `--e2e` would test a different start path, so I did not do it. The earlier smoke (`docs/runs/2026-11-16-CON-35/ssh-link-smoke.md`, step 5) delivered a message over a hand-made link, not over a bootstrapped one. This run did not show it over a bootstrapped link.

The fake-agent session on B from this attempt was killed by the later `stop-all` (B's `server.log`: `runtime: kill t9 (stop all)`).

## Step 5: upgrade. PASS for the version swap; agent survival NOT VERIFIED

No real older release was available, so a synthetic 0.0.1 server was built. It is the same source with `package.json` `"version"` set to `0.0.1` (copy in `S/src-old`, not in the worktree). Its `main.js` is 1 byte smaller than 0.66.1's.

Steps:

```
# staged on the VM:
~/.config/conduit/runtime/0.0.1/node   (cp of the pinned 0.66.1 node)
~/.config/conduit/runtime/0.0.1/server/{main.js,supervise.js,instance-names.js}  (scp from S/src-old)
# B stopped by stop-all (rc 0), then the old server's own ensure:
runtime/0.0.1/node runtime/0.0.1/server/main.js --ensure-server --user-data ~/.config/conduit --start plain --survives-logout no --hc <hc> --shim-dir ~/.config/conduit/runtime/shim
-> CONDUIT_RESULT {"ok":true,"state":"up","version":"0.0.1","survivesLogout":false}
server-version: {"version":"0.0.1","linkMajor":1}
```

Bootstrap from A (0.66.1 code):

```
start 09:11:32.227Z   end 09:11:33.513Z   (1.29 s)
{"ok": true, "machineId": "m-7b32f96c", "summary": {"installed": false, "upgraded": true, "reused": true, "survivesLogout": true, "version": "0.66.1"}}
server-version: {"version":"0.66.1","linkMajor":1}
```

The old `server` processes (pids 28254 and 28264, 0.0.1 node) were replaced by 0.66.1 processes (28512, 28522, 28534). The hc core (`conduit-hc serve` 28238, `hold` 28246) kept its PIDs across the upgrade. `server.log` shows the new server listening.

Agent survival, NOT VERIFIED: the only agent process on B was from the step-4 attempt. Its session was killed by `stop-all` at 09:11:15 (`server.log`: `runtime: kill t9 (stop all)`). A 0.66.1 fake-agent process (pid 28279, started 09:11:22, args `…/conduit-smoke38/fake-mcp-agent.mjs`) was present before the upgrade and gone after it. Its cause is not established, and `sessions.json` lists the session as `stale`. So this run cannot say whether agents survive the upgrade. The unit tests cover this path; this run did not prove it.

## Step 6: teardown and VM state

```
# B: its own path
main.js --stop-all --user-data ~/.config/conduit --hc <vm hc>  -> stop-all rc=0
# A: its own path
stop.cjs -> hc kill conduit-server-c10635a2e5868523 status 0, hc server stop {"stopped":true}
# host: one captured ControlMaster (ControlPath leaf c10635a2e5868523) killed by PID 685852; lookup afterwards: 0 matches
# VM: rm -rf ~/.config/conduit ~/conduit-smoke38   (no .bak existed; ~/.config/conduit was absent at the start)
# VM defaults:
sudo rm -f /etc/systemd/logind.conf.d/g7.conf ; sudo systemctl restart systemd-logind ; sudo loginctl enable-linger conduit
KUP = b false   (busctl)      Linger = yes   (loginctl show-user conduit -p Linger --value)
/etc/systemd/logind.conf.d/ : empty (the directory existed at the start; the drop-in did not)
/var/lib/systemd/linger/conduit present (was present at the start)
pgrep -u conduit -af "conduit|fake-mcp": only the check's own sshd-session
```

Left running: the VM (QEMU) and nothing else of mine. The host tunnels were closed (`kill` by PID). No Electron, no GUI, no commit.

Left on the VM by someone else, not touched: `~/g7node`, `~/bin`, `~/conduit` (dates before this run).

## Findings for the owner

1. **Plan decision 4 is false on this VM.** Under KUP=no with linger off at logout, a plain start does not survive. B's hc core runs in units under `user@1000.service`, which stop with the user manager (3b-ii).
2. **`hc server start` turns linger on for the user.** The vendored `conduit-hc` does this (`loginctl enable-linger`, message "turned on linger for <user>, so the core outlives your logins"), at each start where linger was off. This is what made 3b-i and 3c-ii survive. It is a persistent system change the user did not ask for, and it happens silently in the bootstrap. The owner has to decide whether that is acceptable. If it is, `survivesLogout` must be read after the start, not from the probe.
3. **`survivesLogout` is computed from the pre-start probe.** As shipped, 3c-ii reports `false` for a server that survives. A flag that is wrong for the state it describes should not be shipped. Options (for the owner to choose): read linger after the start, or stop relying on the flag for the plain path.
4. **Messaging and upgrade agent survival are not proven by this run** (steps 4 and 5). Both need `--e2e` or a working agent CLI on the server side.

## Deviations from the spec

- Rows 3b and 3c were run with and without a linger reset after the start. The reset is an addition to test the spec's "linger off at logout" claim as stated. Both variants are kept and reported.
- The first run of row 3a had a tunnel error (`-L` with a long socket path), so hello was not checked. It was rerun with the socket under `$XDG_RUNTIME_DIR`, and the rerun is reported. Rows 3b and 3c used the fixed driver.
- Step 4 ran the fixture agent on both sides with the product start path. It was not wired, so it is NOT VERIFIED, not re-run with `--e2e`.
- Step 5 used a synthetic 0.0.1 build, not a real older release.
- The ssh wrapper for A (`ssh -F <cfg> "$@"`) and A's bootstrap ssh calls cannot carry `timeout` (long-lived bridge). Every host-side ssh call did.

## NOT VERIFIED

- Step 4 messaging over the bootstrapped link: fixture agents not wired without `--e2e`; not re-run with `--e2e`, to keep the product start path.
- Agents surviving the upgrade (`server.restart`): inconclusive; see step 5.
- Windows: out of scope (pending Windows box).
- KUP=yes with linger on (not in the spec's rows).
- Redial after a dropped link: not exercised.
