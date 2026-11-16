# CON-35 gates G1-G9: measurements

Date of measurement: 2026-11-16 (UTC times below). Raw logs are in
`G` = the CON-35 orchestrator's session scratchpad `gates/` (transient; key numbers are copied into this report).
Measurements were taken on a Linux VM (Ubuntu 26.04.1 cloud image, OpenSSH 10.2p1) started by the CON-27 recipe
and re-seeded for CON-35. Its QEMU PID is 199137 (from `~/.cache/conduit-vm/con27/run/qemu.pid`; the
PID in `state.md` is stale). No Windows machine was used.

## 1. Summary

| Gate | What it tests | Status | Result (Linux VM unless noted) | Measured (UTC) |
|---|---|---|---|---|
| G1 | hc core and supervisor from a key-auth SSH session survive disconnect | pending: Windows box later | n/a | n/a |
| G2 | agent CLIs can use stored logins under a network logon | pending: Windows box later | n/a | n/a |
| G3 | stdio bridge byte-transparency with `cmd.exe` and PowerShell | pending: Windows box later | Linux only, as extra evidence: 8/8 transfers byte-identical over sshd, direct and ControlMaster (section 2.5). This is not G3. | 2026-11-16 ~04:36Z |
| G4 | OS/arch probe, Defender/SmartScreen, non-admin vendor CLI installers | pending: Windows box later | n/a | n/a |
| G5 | relayed `windowsPty` renders a Codex/Claude pane without lost lines | pending: Windows box later | n/a | n/a |
| G6 | dead-link detection after sleep, and resume | Linux measured; Windows pending | Dead link detected 16.4 s (master) and 18.3 s (plain ssh) after pause. Resume: fresh ssh 0.38 s, new master 0.13 s after CONT. Single run per path. | 2026-11-16 05:07:01Z-05:07:56Z |
| G7 | Linux server survives logout under `KillUserProcesses` x linger x start method | Linux measured | 16-row matrix. Survivors: see section 2.2. Rows 13-14 confirmed by a fresh-manager re-run (Addendum). | 2026-11-16 04:27:01Z-04:32:07Z |
| G8 | non-admin "only when logged on" scheduled task runs in the logon session | pending: Windows box later | n/a | n/a |
| G9 | Windows payload size, `MaxSessions` default on Win32-OpenSSH, ControlMaster on Win32-OpenSSH | Linux parts measured; Windows pending | Linux payload: 132,607,813 B raw, 47,204,527 B gzip -9 (binaries). `MaxSessions` 10 (`sshd -T`); 10 concurrent sessions over one ControlMaster succeed, 11th and 12th refused. Win32 parts pending; ControlMaster on Win32-OpenSSH is pending. | 2026-11-16 04:19:46Z (payload), 04:33-04:36Z (MaxSessions) |

## 2. Measured gates

### 2.1 G6: dead-link detection and resume (Linux VM, simulated sleep)

Method: a simulated sleep, not a real suspend. The VM's QEMU process is paused with `kill -STOP` and resumed with
`kill -CONT`. The PID is checked against its cmdline first (`qemu-system-x86_64 ... con27`). Each run has a
`trap ... EXIT INT TERM HUP` that sends SIGCONT. Script: `G/g6-rerun.sh`, log: `G/g6-rerun.log`. The earlier
attempt (`G/g6.log`) was aborted because the ControlPath was too long for a Unix socket. Its output is discarded.

The rerun used `ControlPath=/run/user/1000/g6-%C`. Every ssh call used `timeout 30 ssh -F <cfg> -o BatchMode=yes
-o ConnectTimeout=10`, except the 120 s sleep sessions, which used `timeout 120` and the same options.

(a) Plain session, `ServerAliveInterval=5 ServerAliveCountMax=3`, remote `sleep 7001`:

| Step | Result |
|---|---|
| Pause (`kill -STOP`) | 05:07:04.487Z; qemu state `Tl` |
| Local ssh exit | 18.27 s after the pause, rc 255, stderr `Timeout, server 127.0.0.1 not responding.` |
| Resume (`kill -CONT`) | 05:07:22.781Z; qemu state `Rl`, then `Sl` |
| Fresh `timeout 30 ssh vm true` | ok 0.38 s after CONT (1 attempt) |
| Clock, VM minus host (midpoint estimate) | 0.153 s before the pause, 0.179 s after resume |
| Remote `sleep 7001` after resume | still alive (pid 11791). Killed by PID. |

(b) ControlMaster (`ControlPersist=120`, master opened with `-N -f`), mux session `sleep 7002`:

| Step | Result |
|---|---|
| Pause | 05:07:28.663Z |
| Master gone (`ssh -O check` fails) | 16.44 s after the pause |
| Mux session exit | 16.45 s after the pause, rc 255, empty stderr |
| Probe while VM stopped and master dead (`timeout 15 ssh -o ControlPath=... vm true`) | rc 255 after 10.03 s, stderr `Connection timed out during banner exchange`. It failed at ConnectTimeout=10, not at the 15 s wrapper. |
| Resume | 05:07:55.194Z; qemu state `Sl` |
| New master (`ControlMaster=yes -N -f`) | open ok 0.13 s after CONT (1 attempt) |
| Mux probe after resume | completed in 0.43 s; its rc was not captured (see section 4) |
| Remote `sleep 7002` after resume | still alive (pid 12238). Killed by PID. |

Cleanup: `ssh -O exit` returned `Exit request sent.`. No remote sleeps were left, and the control socket was removed.
The remote `sleep 6601` from the earlier aborted attempt was not on the VM when checked at the end of the rerun.

Reading the numbers: ssh detects the dead link about 16-18 s after the pause. Both samples fall in the window that
the keepalive arithmetic gives (5 s interval, 3 unanswered probes: 15 s to 20 s, depending on where the last reply
fell in the interval). This is one sample per path, not a distribution.

### 2.2 G7: KillUserProcesses x linger x start method (Linux VM)

Each row: set `KillUserProcesses` (drop-in `/etc/systemd/logind.conf.d/g7.conf`, then restart `systemd-logind`)
and linger (`loginctl enable-linger/disable-linger conduit`), start `sleep N` from a one-shot ssh session that
exits, wait 15 s, then check `pgrep` from a fresh one-shot session. Methods, from `G/g7-row.sh`:

- a: `nohup sleep N </dev/null >/dev/null 2>&1 &`
- b: `setsid -f sleep N </dev/null >/dev/null 2>&1`
- c: `systemd-run --user --scope sleep N </dev/null >/dev/null 2>&1 &`
- d: `systemd-run --user --unit=g7-rNN sleep N </dev/null >/dev/null 2>&1`

| Row | KillUserProcesses | linger | method | Check (UTC) | Result |
|---|---|---|---|---|---|
| 1 | yes | on | a nohup | 04:27:16 | DEAD |
| 2 | yes | on | b setsid | 04:27:36 | DEAD |
| 3 | yes | on | c scope | 04:27:55 | ALIVE |
| 4 | yes | on | d unit | 04:28:14 | ALIVE |
| 5 | yes | off | a nohup | 04:28:34 | DEAD |
| 6 | yes | off | b setsid | 04:28:53 | DEAD |
| 7 | yes | off | c scope | 04:29:12 | DEAD |
| 8 | yes | off | d unit | 04:29:32 | DEAD |
| 9 | no | on | a nohup | 04:29:51 | ALIVE |
| 10 | no | on | b setsid | 04:30:11 | ALIVE |
| 11 | no | on | c scope | 04:30:30 | ALIVE |
| 12 | no | on | d unit | 04:30:49 | ALIVE |
| 13 | no | off | a nohup | 04:31:08 | ALIVE (see confound) |
| 14 | no | off | b setsid | 04:31:28 | ALIVE (see confound) |
| 15 | no | off | c scope | 04:31:47 | DEAD |
| 16 | no | off | d unit | 04:32:07 | DEAD |

The result summary was checked against the log: DEAD, DEAD, ALIVE, ALIVE / DEAD x4 / ALIVE x4 / ALIVE, ALIVE, DEAD, DEAD.
The `busctl` readback in each row matches the requested `KillUserProcesses` value (true for yes, false for no), and
`loginctl show-user -p Linger` matches the requested linger state.

Confound in rows 13-14: the user manager PID 7969 was started during row 8 and was still running in rows 9-14. It
was gone by row 15, where the manager was PID 9523. Its session (`99 ... manager`) was still present in rows 13
and 14, so their ALIVE results may come from that manager and not from the start method with linger off. Rows
9-12 ran with linger on, so the manager there is expected. Rows 15-16 ran on a new manager. Rows 13-14 need a
rerun from a fresh manager before anyone relies on them.

RESTORE block (from `G/g7-matrix.log`): drop-in removed (empty listing), `KillUserProcesses` false, linger yes,
`systemctl is-system-running` = running, `/var/lib/systemd/linger/conduit` present. This is the state before the
matrix (state.md: linger was already on, KillUserProcesses unset).

### 2.3 Payload (Linux x64, 2026-11-16 04:19:46Z)

Source: `G/payload.txt`. Sizes are from `ls`, `du` and `gzip -9`, on the vendored build in
`/home/namemenima/projects/conduit/build/vendor/`.

| Item | Raw bytes | gzip -9 bytes | Files |
|---|---|---|---|
| node binary (`node/node`, linux-x64 24.18.0) | 123,655,872 | 43,924,407 | 1 |
| hc (`hc/conduit-hc`) | 7,632,024 | 2,959,667 | 1 |
| server bundle (`out/server/main.js`) | 1,319,917 | 320,453 | 1 |
| Binaries sum (node + hc + server) | 132,607,813 | 47,204,527 | 3 |
| Whole `build/vendor` tree | 204,600,166 | not measured | 4,708 |

The node tree alone (`node/`, with share, include and lib) is 196,027,736 B in 4,703 files. The hc tree is
8,572,300 B in 3 files. The Linux payload was measured on Linux only. The Windows size is ASSUMED similar (§2.1
in the spec) and is pending G9.

### 2.4 MaxSessions over one ControlMaster (Linux VM, 2026-11-16 ~04:33-04:36Z)

Setting: `sshd -T` reports `maxsessions 10` (re-read 2026-11-16 ~05:06Z). The sessions are `sleep 30`, run
concurrently over one master (`ControlPersist=300`). Script: `G/mux-maxsessions.sh`. Output directories:
`G/mux-n2`, `mux-n5`, `mux-n10`, `mux-n11`, `mux-n12`, plus a repeat `mux2-n11` and `mux2-n12`.

| N concurrent | Successful (empty stderr) | Refused | Refusal text (stderr) |
|---|---|---|---|
| 2 | 2 | 0 | none |
| 5 | 5 | 0 | none |
| 10 | 10 | 0 | none |
| 11 (run 1) | 10 | 1 (err.6) | `mux_client_request_session: session request failed: Session open refused by peer` |
| 11 (run 2) | 10 | 1 (err.10) | same |
| 12 (run 1) | 10 | 2 (err.11, err.12) | same |
| 12 (run 2) | 10 | 2 (err.8, err.12) | same |

Caveat on `rc` files: every `rc.*` file in all eight runs is 0, including the sessions whose stderr shows the refusal.
So the `rc` values cannot tell the refused sessions apart, and the script's own `ok=` tally (which counts rc 0)
would have counted them as successes. The output of `mux-maxsessions.sh` was not saved to a log. The counts above
come from stderr. Why `rc` is 0 on refusal is not established.

### 2.5 Stdio byte-transparency over sshd (Linux VM, 2026-11-16 ~04:36Z, log mtime)

Script: `G/stdio.sh`, log: `G/stdio.log`. Inputs: `rand64M.bin` (67,108,864 B, sha256 134b9a02...cdae1) and
`allbytes1M.bin` (1,048,576 B, sha256 27cc18f0...46c7, all 256 byte values). The `node` used for the node cases is
the vendored linux-x64 24.18.0 binary, uploaded with scp (rc 0, 1,662 ms) and run as `~/g7node -e
"process.stdin.pipe(process.stdout)"`. The VM has no node on PATH.

| Path | Command | Bytes in = out | Wall | Throughput | SHA-256 |
|---|---|---|---|---|---|
| direct | cat, rand 64 MiB | 67,108,864 | 1,407 ms | 45.47 MiB/s | match |
| direct | cat, all-bytes 1 MiB | 1,048,576 | 639 ms | 1.56 MiB/s (setup-bound) | match |
| direct | node, rand 64 MiB | 67,108,864 | 2,022 ms | 31.65 MiB/s | match |
| direct | node, all-bytes 1 MiB | 1,048,576 | 369 ms | 2.71 MiB/s (setup-bound) | match |
| ControlMaster | cat, rand 64 MiB | 67,108,864 | 1,266 ms | 50.54 MiB/s | match |
| ControlMaster | cat, all-bytes 1 MiB | 1,048,576 | 63 ms | 15.66 MiB/s (setup-bound) | match |
| ControlMaster | node, rand 64 MiB | 67,108,864 | 1,826 ms | 35.04 MiB/s | match |
| ControlMaster | node, all-bytes 1 MiB | 1,048,576 | 125 ms | 7.98 MiB/s (setup-bound) | match |

All eight transfers match on SHA-256, with rc 0 and empty stderr. These are Linux numbers only. G3 is about
`cmd.exe` and PowerShell on Windows.

## 3. Implications for RS-D14 and the spec

These are facts from the measurements above. They are not new design.

- **Start methods per logind and linger state (G7, Linux).** The start methods survive as follows:
  - `KillUserProcesses=yes`, linger on: `systemd-run --user` (scope and unit) survives; `nohup` and `setsid -f` do not.
  - `KillUserProcesses=yes`, linger off: none of the four survive.
  - `KillUserProcesses=no`, linger on: all four survive.
  - `KillUserProcesses=no`, linger off: `nohup` and `setsid` survive (rows 13-14, confirmed by the fresh-manager re-run in the Addendum);
    `systemd-run --user` does not (rows 15-16).

  Taken together: RS-D14's `setsid` alone does not survive `KillUserProcesses=yes`. `systemd-run --user` survives
  only with linger on. Linger is needed for `systemd-run` in both `KillUserProcesses` states that were measured.
  Linger is off by default; the VM had it on before the matrix.
- **MaxSessions (G9 Linux part).** `MaxSessions` is 10 on Linux (`sshd -T`). Ten concurrent sessions over one
  ControlMaster succeed. The 11th is refused, and so is the 12th. The spec's assumption of at least 2 holds on Linux.
  Three concurrent sessions (link, probe, install or login pane) fit within 10. Windows (Win32-OpenSSH) is pending.
- **Dead-link detection vs the 20 s link timer (G6, Linux).** With `ServerAliveInterval 5`, `ServerAliveCountMax 3`,
  the ssh child exited 16.4 s (mux master) and 18.3 s (plain session) after the pause, on one run each. The spec's
  link timer is 20 s (§4.2), so the exit landed 1.7 s to 3.6 s inside it on these samples. The spec's text says
  "5 s x 3 = 15 s"; the measured values are above 15 s. The VM's sshd did not kill the remote `sleep` after a
  client-side drop: the sleeping process survived both pauses and was alive after resume (killed by PID).
- **Resume (G6, Linux).** After CONT, a fresh ssh succeeded in 0.38 s and a new master in 0.13 s (one attempt each).
  During the pause, a probe failed with a banner-exchange timeout after 10.03 s (ConnectTimeout=10), not a hang.
- **Payload budget (G9 Linux part).** The Linux binaries per remote are 132,607,813 B raw (47,204,527 B gzip -9),
  of which node is 123,655,872 B raw and 43,924,407 B gzip. The whole `build/vendor` tree is 204,600,166 B in
  4,708 files. Windows is pending; the spec's Windows size is ASSUMED similar.

## 4. Not measured

- **G1, G2, G3, G4, G5, G8:** need a Windows 11 box (headless, per RS-D2). None was available.
- **G9, Windows parts:** Windows payload size, Win32-OpenSSH `MaxSessions` default and ControlMaster support.
- **G3 proper:** stdio on Windows (`cmd.exe`, PowerShell). The Linux stdio runs in section 2.5 are evidence for the
  Linux path only.
- **G6 on Windows, and with a real suspend:** the Linux test is a SIGSTOP of QEMU, which the guest does not see as
  sleep. One run per path. No network-change test.
- **G7 beyond this VM:** one Ubuntu 26.04.1 image and one `systemd` build. One run per row. Rows 13-14 are
  confounded by the user manager (section 2.2).
- **Mux probe rc after resume (G6 b):** the probe was run, but its `rc` was not captured (quoting bug: `echo rc=\$?`
  inside the `time` group printed `rc=$?`). Only its duration (0.43 s) is recorded.
- **MaxSessions refusal `rc`:** the refused sessions show rc 0 in the files. The cause is not established (section 2.4).
- **Earlier scripts without the timeout wrapper:** `vm.sh`, `g7-row.sh`, `mux-maxsessions.sh` and `stdio.sh` ran ssh
  without `timeout` or `BatchMode`. Their logs were kept as recorded and not re-measured. The G6 rerun used the wrapper.
- **Earlier aborted G6 attempt:** `G/g6.log` stopped at the ControlPath error and produced no result. Its remote
  `sleep 6601` was not on the VM at the end of the rerun, and its local ssh process was gone.

## Addendum: G7 rows 13–16 re-run with a fresh user manager (2026-11-16, orchestrator)
The first run's rows 13–14 ran while an earlier row's user manager was still alive. Re-run with `g7-fresh.sh`
(KillUserProcesses=no, linger off; 25 s idle with no session before each start, so the previous manager stops;
manager PID recorded at start and at check; every ssh call under `timeout 40 … -o ConnectTimeout=10`):

| Row | Method | Start mgr | Check mgr | Sessions at check | Result |
|---|---|---|---|---|---|
| 13 | `nohup … &` | 12817 | 12817 | start session 174 still listed | ALIVE |
| 14 | `setsid -f` | 12992 | 12992 | start session 177 still listed | ALIVE |
| 15 | `systemd-run --user --scope` | 13169 | 13270 (new) | only the check session | DEAD |
| 16 | `systemd-run --user --unit` | 13372 | 13485 (new) | only the check session | DEAD |

Every row started under a manager different from the previous row's, so the confound is gone. Rows 13–14 are confirmed
ALIVE: with KillUserProcesses=no, the detached process keeps its logind session listed (closing) after the ssh exits, and
that keeps the user manager alive. Rows 15–16 are confirmed DEAD: without linger, the manager stops when the last session
goes and takes its `--user` units and scopes with it. Defaults restored afterwards: linger yes, no drop-in, no leftover sleeps.
Raw log: the scratchpad's `gates/g7-fresh.log`.
