---
status: shaped — awaiting owner decisions
date: 2026-11-16
ticket: CON-35 (replaces CON-27's transport for own machines; CON-17 stays parked)
---

# Feature Spec: Remote machines over SSH — a fleet of agents you can watch

**Tier:** FULL · **Feature type:** mostly non-UI (bootstrap, transport, tool routing, policy) plus UI
for machines and remote panes (§9) · Shape spec: no plan, file map or code.
**Siblings:** NET = [conduit-network](2026-11-14-conduit-network.md) (CON-27, shipped dark in v0.66.0) ·
POL = [policy-and-permissions](2026-11-14-policy-and-permissions.md) (built as CON-24 on branch
`CON-24-permissions-machinery`, not on main) · REQ = [user-input-requests](archive/2026-11-14-user-input-requests.md).

**Request (verbatim, CON-35):** "…applications such as VS Code, Cursor… establish an SSH connection…
and then they install some sort of a server or… mini version of themselves on that machine." · "The
main important part is the remote control and management of a fleet of agents across different
machines and that needs a standard system… something that works out of the box and perfectly." ·
Added 2026-11-16: "my agent, or the lead agent, should be able to open up connections to remote
machines… open a session in there… view the files… do everything that we can do currently… remotely
and it would still give me, the user, visibility. If I wanted to click and see what's happening, I could."

> **For the owner (read this first)**
>
> **Verdict.** Do what VS Code does: Conduit runs your own `ssh` (config, keys, agent), detects the other
> machine's OS and CPU, installs a matching headless Conduit server in your user folder there (no admin)
> if it is missing or older, starts it so it outlives the connection, and talks to it over the SSH
> channel's stdin/stdout. No port opens on either machine; no pairing codes or certificates. CON-27's link
> protocol, outbox, monitor and drive run unchanged over that channel; its pairing and TLS are parked.
>
> **MVP.** Add `win-box` (an ssh Host) once from Machines, answering any host-key prompt in a pane;
> pick agent CLIs to install there and log each in, in panes you watch. Then your lead can
> `connect_machine`, `open_session { machine: "win-box" }`, `send_input`, `read_screen`, `wait_sessions`,
> `close_session` and read files there. Its sessions show under it in your sidebar with a `win-box`
> badge: click for the live terminal, type to take over, or close. Close the lid: the agents keep working
> and their messages arrive once when you're back. **Light mode:** no agent CLIs there; the lead works
> through remote terminals and files.
>
> **"Out of the box" on Windows, honestly:** OpenSSH Server switched on once (three admin PowerShell
> lines; on by default only on Server 2025), your key in the right `authorized_keys` (admins use another
> file), the box awake and logged in (RS-D5), each CLI logged in once there. Conduit checks each and
> shows the fix; it can't do the admin step. Tailscale SSH can't serve Windows (Linux/macOS only); plain
> OpenSSH over a tailnet address works. **Big unknown:** whether a process started over SSH on Windows
> survives the disconnect *and* keeps your logins; gates G1–G3 measure it first.
>
> **Top decisions:** RS-D1 shape · RS-D3 park CON-27 pairing/TLS · RS-D4 who decides remote actions ·
> RS-D5 how the Windows server starts · RS-D6 may an agent add a machine · RS-D12/13 CLI install, logins.

## 1. Problem frame
- **Job:** from my Linux desk, I and my Claude lead run, steer, watch and stop agents on my other
  machines as if they were local, starting with one Windows box, growing to a fleet; I can always
  click in and see or take over.
- **Actors:** the owner (human at the local GUI); the **lead** (a local agent using Conduit's MCP
  tools); **remote agents** (Claude Code, Codex, Cursor CLI, OpenCode, any CLI on the remote PATH); the
  **controller** (local server); the **remote server** (owns that machine's sessions, ADR 0007);
  `ssh`/`sshd` (authenticate and carry bytes).
- **Success outcomes:** (1) a machine needs only an ssh Host, no Conduit config there; (2) the lead
  drives a remote session with the same tools as a local one; (3) the owner sees and can click every
  remote session within 2 s; (4) agents survive sleep and SSH drops, nothing lost or duplicated; (5)
  Conduit fixes version skew itself; (6) nothing listens on a network interface on either machine.
- **Non-goals:** other people's machines (CON-17); a relay or hosted service; remote desktop; editing
  remote files in MVP; installing OpenSSH Server for the user; Windows or macOS as the controller in MVP.

## 2. What exists today, and what is unknown

### 2.1 Measured or read (2026-11-15, this worktree)
| Claim | How | Kind |
|---|---|---|
| The server is **not** Electron-as-node: packaged builds run it on vendored Node 24.18.0 (`runtime/node[.exe]`) beside `runtime/server/*.js` and pinned hc 0.1.16 | `package.json` `build.*.extraResources`; `build/runtime-pins.json`; `electron/runtime-layout.ts:53-61` | Read |
| The server bundle is pure JS: `out/server/main.js` 1.32 MB, requires only `node:*` builtins, zero `.node` addons. PTYs live in hc (Rust) | grep of `require("…")` and `\.node\b` in `out/server/main.js` | Measured |
| Per-remote payload: Linux node 123,655,872 B; hc 7,632,024 B; server JS ≈ 1.4 MB | `ls -la build/vendor/*` | Measured (Linux); Windows ASSUMED similar |
| Pins (URL + SHA-256) exist for win-x64, linux-x64, darwin-arm64; none for linux-arm64, win-arm64 | `build/runtime-pins.json` | Read |
| Runtime layout `<userData>/runtime/<appVersion>/`; a server restart keeps agents (hc holds PTYs), a reboot doesn't | `electron/runtime-layout.ts`; ADR 0007 §Survival | Read |
| "Ensure the server runs" (version order, restart) lives app-side in `electron/server-lifecycle.ts`; the supervisor itself (`server/supervise.ts`: restart with backoff, gives up after `SUPERVISOR_GIVE_UP` crashes into an exhaustion marker, optional tray) is a plain Node entry | file read | Read |
| C2 has no file or git methods; file viewing, watchers and git run in the Electron main process | method grep of `src/contracts/server-protocol.ts`; `electron/conduit-fs.ts` | Read |
| CON-27's link connection uses only stream methods (`write`, `end`, `on`, `resume`, `writableLength`, `destroy`) though typed `tls.TLSSocket`; frames are 4-byte-length JSON, 16 MiB cap | grep `sock\.[a-z]*` in `server/network/link-*.ts`; `src/network/frame-codec.ts` | Measured (grep) |
| Link frames: hello/caps, msg/ack/receipt, snapshot, view.* (with `windowsPty`), drive.input/resize/open/close. Nothing for `send_input`, `read_screen` or files | `src/contracts/link-protocol.ts:49-98` | Read |
| Pinned hc has `machine add [--install] [--via]`, `machine update` ("its terminals keep running"), `machine login` ("On Windows: reconnect once its SSH keys work"), `connect` (API over stdio) | `conduit-hc machine --help`, `machine add --help`, `--help` | Measured (CLI text only; no sshd here) |
| This controller: OpenSSH 10.2p1; no sshd, no `~/.ssh/config`, no Tailscale | `ssh -V`; `systemctl is-active ssh`; `which tailscale` | Measured |

### 2.2 External facts (cited, accessed 2026-11-15) and gates
| Fact | Source |
|---|---|
| VS Code Remote-SSH: local `ssh` + `~/.ssh/config`; the remote downloads the server or the client transfers it (`remote.SSH.localServerDownload`); runs as the login user from `~/.vscode-server`, "not wired into any… startup scripts"; random loopback port forwarded over SSH (Unix socket only on Linux/macOS), guarded by a random key; Windows 10/11 remotes via OpenSSH Server; `remote.SSH.remotePlatform` fixes Windows detection. Exact commit pinning is community-reported only | https://code.visualstudio.com/docs/remote/ssh · …/troubleshooting · …/faq |
| Zed: one ControlMaster per project; `~/.zed_server` "version must exactly match"; a proxy that "will start the daemon if it is not running, and reconnect to it if it is"; Windows remotes. JetBrains Gateway: backend IDE remote, thin client | https://zed.dev/docs/remote-development · https://www.jetbrains.com/help/idea/remote-development-overview.html |
| Claude Desktop "SSH sessions" install Claude Code under `~/.claude/remote/` and run tools, terminal, files there; need SFTP and `MaxSessions` ≥ 2. The Claude Code CLI has no remote mode | https://code.claude.com/docs/en/desktop.md |
| Codex (ChatGPT desktop) SSH hosts need Codex installed, signed in, on the login shell's PATH. Headless login: `codex login --device-auth` (beta), copying `~/.codex/auth.json`, port forwarding, or an API key. No documented per-machine login limit for Claude; nothing found for Codex | https://learn.chatgpt.com/docs/remote-connections.md · https://learn.chatgpt.com/docs/auth.md |
| Windows OpenSSH Server: `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, `Start-Service sshd`, `Set-Service sshd -StartupType Automatic`; firewall rule on 22 created; installed by default on Server 2025. Default shell `cmd.exe` (`HKLM:\SOFTWARE\OpenSSH\DefaultShell`). Admins' keys in `%ProgramData%\ssh\administrators_authorized_keys` (strict ACL). No `AllowStreamLocalForwarding`; key-auth sessions have no credentials for outbound auth; PTYs use ConPTY on 1809+ | https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse · …/openssh-server-configuration · …/openssh_keymanagement · https://github.com/PowerShell/Win32-OpenSSH/wiki/TTY-PTY-support-in-Windows-OpenSSH |
| Processes die with a Windows SSH session (job object, kill on close, "intentional"); escapes: `CREATE_BREAKAWAY_FROM_JOB`, WMI `Win32_Process.Create`, a scheduled task, a service | https://github.com/PowerShell/Win32-OpenSSH/issues/1032 · …/issues/1642 |
| Tailscale SSH's server is "only available on" Linux and macOS | https://tailscale.com/kb/1193/tailscale-ssh |

**sshd prerequisites for Conduit:** OpenSSH Server, key auth, `MaxSessions` ≥ 2 (link plus a probe,
install or login pane over one ControlMaster; OpenSSH's default is 10, Windows ASSUMED the same). **No
SFTP**: pushes go through Conduit's own channel.

| Gate — measure on a real Windows 11 box before the plan | Why | Status |
|---|---|---|
| **G1** hc core + supervisor started from a key-auth SSH session survive the disconnect | agents outlive SSH | ASSUMED unknown |
| **G2** agent CLIs in that tree can use their stored logins (DPAPI/Credential Manager under a network logon) | a server whose agents can't log in is useless | ASSUMED risky |
| **G3** a stdio bridge passes bytes untouched with `cmd.exe` and PowerShell as `DefaultShell` | transport | ASSUMED |
| **G4** the OS/arch probe works under both shells; Defender/SmartScreen allow node.exe and hc from `%LOCALAPPDATA%`; the vendor CLI installers run non-elevated | bootstrap | ASSUMED |
| **G5** relayed `windowsPty` renders a Codex/Claude pane in the Linux GUI without lost lines | visibility (CON-27 Tier 3 residual) | ASSUMED |
| **G7** a Linux remote's server survives logout under `KillUserProcesses=yes` (setsid vs `systemd-run --user`; linger usually needs admin) | Linux start (RS-D14) | ASSUMED |
| **G8** a non-admin user can register an "only when logged on" scheduled task from a key-auth session, and it runs in the logon session | RS-D5 (a) | ASSUMED |
| **G9** Windows payload size and `MaxSessions` default on Win32-OpenSSH; whether Win32-OpenSSH supports ControlMaster (v1 Windows controller) | budget, §7 | ASSUMED |
| **G6** dead-link detection after sleep (`ServerAliveInterval` vs the 20 s link timer) and resume after wake | reconnect | ASSUMED |

## 3. Shape options
| | **A: Conduit server over SSH (recommended)** | B: hc machines only | C: CON-27 TLS links | D: VS Code-style port forward |
|---|---|---|---|---|
| What | bootstrap a headless server; link frames over ssh stdio | local hc adds the remote (`machine add --install`); terminals as `win-box/t7` | pairing + TLS; SSH as a documented forward | remote server on a loopback port, `ssh -L` |
| Gives | remote MCP host (remote agents message, get policy), outbox, monitor, drive; SSH the one trust root | terminals with no Conduit on the remote; hc self-installs | built | familiar |
| Rules out | — | remote agents' MCP, remote policy/audit, files beyond 8 MB text; a second control path around Conduit identity | out of the box (pairing per machine, firewall prompts, LAN/tailnet only) | Windows has no stream-local forward; a loopback port any local process can reach, so VS Code needs a random key; stdio (A) has no port at all |
| Cost | medium | low for terminals, high for the rest | UI still unbuilt (CON-28) | medium |

**Recommendation: A (RS-D1).** hc's `machine` feature stays a candidate engine for G1 (if hc already
breaks away on Windows, the bootstrap starts the remote supervisor through hc as the app does), never
a second control path.

## 4. Behaviour and flows

### 4.1 Objects and words
- **Machine:** a remote host keyed by its **machine id** (from the remote server's identity key, as
  CON-27), shown by a local **name** (default: the ssh Host). Fields: ssh target (Host alias or
  `user@host[:port]`), os, arch, remote Conduit version, mode (full | light), state, last seen.
- **Connection:** one ssh child carrying one link. The local side is always the **controller**; the
  link is directional (§4.5). **Address:** `handle@<machine-id>`, shown `handle@win-box` (CON-27 §4.1).

### 4.2 Connection lifecycle
`added → probing → (installing | upgrading) → starting → up ⇄ degraded ⇄ down`; any → `needs-person`
(host key unknown/changed, passphrase, password, MFA), `unsupported` (os/arch) or `failed {step}`;
`removed` is local only (remote sessions keep running).
1. **Dial:** `ssh -T -o BatchMode=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no
   -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPath=<private>
   -o ControlPersist=60 -- <target> <command>`. Every prompt becomes a typed failure; Conduit never
   passes `StrictHostKeyChecking=no`/`accept-new`; a target starting with `-` is refused.
2. **Probe** (one fixed command per shell family, no user text spliced in): os, arch, home, shell
   family, running remote Conduit version and link major, free disk, agent CLIs on PATH.
3. **Install/upgrade** if no compatible server: the remote fetches the pinned node and hc and checks
   SHA-256 (`runtime-pins.json`); without remote internet the controller pushes the same pins over the
   channel. The platform-independent server JS is always pushed from the local build, so the remote
   equals the local version. Temp dir → verify → rename into `<remote userData>/runtime/<version>/`;
   old versions go per §7's retention rule.
4. **Start:** equal version running → attach. Older → install, then its own `server.restart` (agents
   survive, ADR 0007). Newer, same link major → attach, never downgrade. Other major → `incompatible`
   ("update Conduit here"). The remote runs today's `server/supervise.ts` without a tray; the
   "ensure the server runs" logic moves out of `electron/` so the bridge can run it headless. After
   give-up the exhaustion marker shows as `failed {start}` with Retry; after a reboot nothing runs until
   the next dial starts it (agents don't survive reboots today either). Start method: RS-D5 (Windows),
   RS-D14 (Linux).
5. **Link:** the ssh command runs `node <runtime>/server/main.js --link-stdio --user-data <dir>`, a
   bridge that connects to the remote server's local endpoint as the same OS user and pipes link frames
   on stdin/stdout. **The bridge proves it came over SSH:** the server writes a per-start random secret
   to a user-only file; only a bridge that read it (i.e. a process with that user's file access, which
   SSH gave it) can open a link, and the C2 pipe hardening (RS-D8) is a precondition. The remote
   scopes every `principal` in a `call` to that link's controller id and rejects any other. Identity:
   SSH's host-key check authenticates the machine; hello's identity key is pinned per Host, and a changed
   key is `identity-changed` (nothing crosses until the owner re-confirms).
6. **Up:** snapshot, outbox resend, views resync (CON-27). **Down:** the ssh child's exit is the one
   source of `down` (keepalives 5 s × 3 = 15 s, inside the link's 20 s timer, which only shows
   `degraded`); redial with CON-27 backoff (cap 60 s), at once on wake or network change. An expired
   ControlMaster whose key needs a passphrase sends the machine back to `needs-person`.
7. **CON-27 frames on SSH links:** `owner`/`owner.ack` are refused (no owner-key transfer); routed
   `open_session`/`close_session` replace `drive.open`/`drive.close` for agents, which stay the
   owner's GUI path; all other frames as CON-27.
- **Shared userData:** a remote with the desktop app installed keeps one server for both (RS-D11).

### 4.3 Flows
- **F1 Owner adds a machine.** Machines → Add → a Host from `~/.ssh/config` or `user@host`. On
  `needs-person` Conduit opens a visible pane running `ssh -o ControlMaster=yes -o
  ControlPath=<private> -o ControlPersist=8h <target>` for the owner to answer, so the batch-mode retry
  reuses that master. Missing sshd or keys on Windows → the exact commands (§2.2) with Copy.
  Then the mode: **full** (F2) or **light** (F8).
- **F2 Set up agents (full mode).** For each missing CLI the owner ticks, Conduit runs the vendor's
  documented user-level installer in a visible remote pane (Claude Code and Codex both install to a user
  dir; exact commands per OS measured in G4). For each CLI not logged in it opens the CLI's own login
  in a pane (device-code flows such as `codex login --device-auth`). Copying a credential file between
  machines is only an explicit per-CLI owner choice with a warning (RS-D13). Agents can't trigger
  installs (RS-D12).
- **F3 Lead connects.** `connect_machine { machine }` reuses a live connection or dials; returns `up` or
  a typed error (§5.2) within the tool budget.
- **F4 Lead opens and drives.** `list_agents { machine }` → `open_session { machine, agent, folder,
  prompt }` → `codex-2@win-box` → `send_input`, `read_screen`, `wait_sessions`, `close_session`. The
  remote server runs the same tool code as for a local caller, as `claude-3@<controller-id>` with
  `opened_by` = the lead.
- **F5 Owner watches and takes over.** The session shows under the lead with a machine badge and under
  Machines → win-box; click → live pane (view relay with the remote `windowsPty`). Typing, resize and
  close are `drive`; read-only viewers never resize; the last typer sizes (NET-D10).
- **F6 Laptop sleeps.** Link `down`; remote agents continue; their messages queue in the remote outbox
  (24 h) and arrive once on reconnect; panes show "reconnecting", then repaint.
- **F7 Remote agent needs the owner.** Its `request_input` or a permission ask on the remote server
  appears in the local Needs you queue with the machine badge, answerable here (RS-D7).
- **F8 Light mode.** No agent CLIs on the remote; the lead stays on the controller and works through
  `open_terminal { machine }`, `send_input`, `read_screen` and remote file reads (v1: `run_command {
  machine, argv }`, bounded like hc `machine.exec`, and file writes). The headless server still runs
  there (user folder, no admin): surviving terminals, visibility and file reads need it. A zero-install
  mode (raw `ssh` exec) is rejected: nothing survives a drop and the owner sees nothing; the lead can
  already run `ssh` in its own shell for that.
- **F9 Browse remote files.** `open_file { machine, path }` or a path clicked in a remote pane opens a
  read-only remote file tab (MVP); v1 adds the file tree, Changes, diff, Review, git history.

### 4.4 Tool parity with a machine target
"Routed" = forwarded in a `call` frame and run by the remote server under the remote principal.
"Served" = the remote server answers a content request for the local GUI.

| Tool | Machine form | Slice | Note |
|---|---|---|---|
| `connect_machine`, `list_machines`, `disconnect_machine` | new | MVP | §5.1 |
| `list_sessions` | every machine's rows + `machine`, `machine_id`, `address`, `link` | MVP | exists for CON-27 |
| `list_agents`, `open_session`, `open_terminal` | `{ machine }`; folder in the remote's format | MVP | routed |
| `send_input`, `read_screen`, `close_session` | by address | MVP | routed |
| `wait_sessions` | addresses on any machine | MVP | monitor data (exists) |
| `send_message`, `read_inbox`, `read_attachment` | by address | MVP | CON-27, exactly once |
| `list_requests`, `answer_request`, `escalate_request` (on remote agents' requests); `request_input`, `wait_request`, `withdraw_request` stay local to the asker | answerable here | MVP | RS-D7 |
| `focus_session` | focuses the remote pane in the local window (local-only action) | MVP | local UI |
| `open_file`, `close_files` | `{ machine, path }`, read-only | MVP | served `fs.read/stat/list` |
| `open_diff`, `open_review`, `open_git_history` | `{ machine, … }` | v1 | served git; no git in the server today (§2.1) |
| `attach_folder`, file editing, `run_command` | remote paths | v1 | write paths, watch service |
| `open_url` | opens locally; remote `localhost` needs a forward | vision | no forwarding in MVP |

### 4.5 Direction and trust
- The controller may route every tool above, under its policy (§4.6). The remote gets `messaging` +
  `monitor` back and **never** `drive` or routed calls on the controller, unless that machine is added
  the other way round with its own SSH key. Several controllers may connect to one remote; each is its
  own principal with its own outbox.

### 4.6 Policy (POL / CON-24)
- `connect_machine`, `disconnect_machine` join POL's profile table: Observer deny · Worker ask · Lead
  allow for machines already added; **a never-installed machine asks under every profile** (RS-D6).
  Grants can scope **on: this machine**.
- **Routed calls are decided twice:** by the local policy at the origin (the lead's profile; scope =
  machine + folder), then by the remote's floor: the link's capabilities and its policy for the
  controller principal, default **Lead** on an SSH-added link (RS-D4). An ask from either side reaches
  the owner in the local queue. "Only while on screen" never applies to routed calls.
- Activity: the controller records the decision and routing; the remote records what it ran, naming
  `claude-3@<controller>`; no bodies or keystrokes on either side (POL privacy).

## 5. Interface contract

### 5.1 New MCP tools
- `connect_machine { machine: string }` → `{ machine, machine_id, state: "up", os, arch, mode,
  conduit_version, reused, installed, upgraded }`. Idempotent; concurrent calls share one dial;
  `machine` = name, machine id or ssh Host.
- `list_machines {}` → `[{ machine, machine_id, target, state, mode, os, arch, conduit_version,
  agents: string[], sessions, last_seen }]`.
- `disconnect_machine { machine }` → `{ machine, state: "down" }`. Never stops remote sessions; an
  already-down machine is a no-op success; an unknown one is `machine_unknown`. Removing a machine is
  GUI-only (the owner's decision, like adding the first install).
- Existing tools gain an optional `machine` where §4.4 says so; omitted = local.

### 5.2 Errors (agent-visible; each with a `hint`)
| Code | When | Retryable |
|---|---|---|
| `machine_unknown` | not added and not an ssh Host | no |
| `ssh_needs_person` + `reason` (`host_key_unknown`, `host_key_changed`, `passphrase`, `password`, `mfa`) | ssh would prompt | after the owner acts ("ask the human to connect win-box once from Machines") |
| `ssh_unreachable` | DNS, timeout, refused (sshd off), box asleep | yes |
| `ssh_auth_failed` | keys rejected | no |
| `remote_unsupported` + `os`, `arch` | no pin for that platform | no |
| `install_failed` + `step` (`download`, `checksum`, `disk`, `start`) | bootstrap step failed | yes |
| `agent_not_installed` / `agent_not_logged_in` + `machine`, `agent` | `open_session` on a CLI the remote lacks | after the owner sets it up |
| `peer_incompatible`, `peer_unreachable`, `refused` | CON-27, unchanged | as CON-27 |

### 5.3 Link additions (minor bump of major 1)
- `call` / `call.result` `{ id, tool, args, principal }` → `{ id, ok, result | error }`: one result per
  id; on a drop the caller gets `peer_unreachable` and the call is never replayed (only messages are).
- `fs.read` / `fs.stat` / `fs.list` (MVP, read-only, 8 MiB per read → `too_large`; confined by the
  remote to the session's folders, symlinks resolved and rechecked; a fixed deny-list wins even inside
  them: `.ssh`, `.gnupg`, `.claude*`, `.codex`, `.cursor`, `.config/opencode`, `%APPDATA%` credential
  stores, `.env*`) → `refused`; `git.*` (v1).
- `request.mirror` / `request.answer` (F7).

### 5.4 Producers and consumers
| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Machine record, connection state | controller connection manager | `list_machines`, sidebar, policy | yes |
| Remote runtime install, agent CLI setup | bootstrap (controller) | remote server start; remote `list_agents` | yes |
| Remote sessions, presence, attention; pane output; messages | remote monitor, relay, outboxes (exist) | `list_sessions`, sidebar, panes, inboxes | yes |
| Routed calls and results | controller MCP host | remote MCP tools | yes |
| Keystrokes (`drive`) | local GUI | remote PtyWriter | yes (exists) |
| Remote requests and answers | remote request service / local GUI | local queue / remote request service | yes |
| File content | remote `fs.*` | local file tab | yes |
| Policy decisions | local POL; remote floor | Activity on each side | yes |
| CON-27 pairing/TLS state | parked | nothing here | **no**: parked behind its flag (RS-D3); its frames are reused, its listener isn't started |

### 5.5 Invariants
- Nothing listens on a non-loopback interface on either machine; sshd is the only remote entry point.
- Conduit never stores passwords, passphrases or private keys, never enables agent or X11 forwarding,
  never weakens host-key checking, never copies an agent credential without the owner's explicit choice.
- Every downloaded Conduit binary is checked against a pinned SHA-256 before it runs.
- The remote server is the sole writer of its sessions and PTYs. Tool calls are never replayed after
  a drop; messages are delivered exactly once.

## 6. Edge cases and failure modes
| Condition | Behaviour |
|---|---|
| Two `connect_machine` at once, or lead and owner at once | one dial; both get its outcome |
| Host key changed / ssh would prompt | `ssh_needs_person`, never a hang; Conduit never edits `known_hosts` |
| Two aliases reach one machine | same machine id → one machine, extra target recorded |
| Remote reinstalled (new identity key) | `identity-changed` until the owner confirms |
| Disk full / drop mid-install | `install_failed {step}`; temp removed next probe; previous version intact |
| Remote newer, same major | attach, no downgrade; "win-box runs a newer Conduit" |
| Remote desktop app open on that box | one server, same sessions; both GUIs can drive |
| Windows user logged off / box asleep | `ssh_unreachable`, or (RS-D5) `failed {start}` with "log in on win-box" |
| Agent CLI missing, logged out, or its installer fails / wants elevation | `agent_not_installed` / `agent_not_logged_in`; the pane shows the output; never retried elevated |
| Zero / one / many machines | zero: Add only; many: groups collapse; output only for panes on screen |
| Routed call on a `down` machine | `peer_unreachable` at once; messages queue |
| Link drops during `open_session` | `peer_unreachable`; the session, if made, appears on reconnect with `opened_by` = lead; never reopened |
| Remote path formats | kept in the remote's format, shown verbatim, resolved remotely |
| Outbox limits / unsupported platform (arm64, musl) | CON-27 caps (1,000 entries / 64 MiB per peer, 24 h) / `remote_unsupported` (RS-D9) |

## 7. Defaults
| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| ssh binary/config | system `ssh`, `~/.ssh/config`, ControlMaster on (Linux) | ssh path | standard; VS Code/Zed do this |
| Prompts in automated dials | never (BatchMode) | no | an agent call must not hang or answer a prompt |
| Server source | remote downloads pins; push fallback | per machine | push covers offline boxes |
| Version policy | install the local version; attach to local-or-newer with the same link major; never downgrade; keep every version a running session or another controller's last push uses, plus one previous | no | one wire version; rollback; several controllers |
| Mode on add | full, no CLI preselected | per machine | the owner picks CLIs; light is one click |
| Remote → controller | messaging + monitor | no (add the reverse machine) | SSH trust is one-way |
| Routed calls on the remote | floor + controller at Lead | per machine on the remote | the owner's own key |
| New machine by an agent | ask, every profile | POL grant | installing software isn't reversible |
| Remote file reads | 8 MiB, session folders only, credential deny-list | no | bandwidth; no credential leaves the box |
| Tool budget for `connect_machine` | 120 s (first install may need the owner's ask; dial alone 30 s) | no | under Codex's 180 s MCP timeout |

## 8. Security
- **Trust is SSH's:** `known_hosts` authenticates the machine; the user's keys/agent authenticate the
  user. Whoever can SSH in as that user could already run anything; Conduit adds no reach beyond it.
- **Conduit still enforces:** argv hygiene (target after `--`, leading `-` refused, fixed probe and
  install scripts, values as argv or base64, never spliced into cmd/PowerShell text); pinned checksums
  for its binaries; vendor installers only from each vendor's documented command, shown before it
  runs; the directional link (§4.5); policy at both ends (§4.6); CON-27's frame validation, caps and
  printable-string rules; `fs.*` confinement; no forwarding.
- **Surface vs CON-27:** removed — pairing port, TLS listener and bind allowlist, self-signed
  certificates, commit-reveal transcript, owner-key transfer, LAN exposure, firewall prompts. Added —
  the bootstrap (downloads and runs binaries), the stdio bridge, routed calls, remote file reads.
  Unchanged — the local C2 pipe, whose M28 exposure on Windows (world-readable, SMB-reachable) now
  guards a remotely driven machine, so hardening it is MVP (RS-D8).
- **Residual:** a compromised controller can do on the remote what its policy allows (as SSH could); a
  prompt-injected lead is bounded by POL asks; a compromised remote reaches the controller with
  messages and monitor data only.

## 9. UI module (English only, per docs/UX.md §2; the designer details it)

### 9.1 State catalog
| Component | State | What the owner sees | Action |
|---|---|---|---|
| Machines group | first run / empty after a remove | "Add a machine — run agents on your other computers over SSH" / "Add a machine" | Add |
| Machine row | up / connecting / installing / upgrading | name, OS icon, mode, session count, status text ("Installing Conduit 0.67.0…") | open, Disconnect |
| Machine row | needs-person | "win-box needs you: accept its host key" | Connect (opens an ssh pane) |
| Machine row | down | "Offline since 14:02 · retrying" | Retry now |
| Machine row | unsupported / incompatible / identity-changed / failed | reason + one fix line | Copy fix, Re-confirm, Remove |
| Agent setup | per CLI: present / missing / installing / logged out / ready / failed | checklist with panes | Install, Log in, Skip |
| Session row (remote) | any session state | today's row + machine badge, under its opener | click opens pane |
| Remote pane | reconnecting / read-only / driving | last screen dimmed + "Reconnecting to win-box…" / live terminal | type, Close session |
| Remote file tab | loading / loaded / too large / unreadable | read-only badge, machine in the title | Refresh |
| Add dialog | picking / dialing / setup help | Hosts from ssh config; Windows setup commands | Copy, Retry |

### 9.2 Interaction inventory
- **Machine row** (`treeitem`, `aria-expanded`, state as text): click expands, inline Retry/Connect;
  arrows and Enter in the tree; context menu Disconnect, Rename, Remove, Set up agents.
- **Add dialog / agent setup** (`dialog`, live region for progress): list, text field, checkboxes; Tab,
  Enter, Esc. **Remote pane:** as a local terminal, + "Machine details"; live region for reconnecting.
- **Remote file tab:** as a local read-only editor tab (Ctrl+F, scroll, Esc closes find); Refresh is
  a button and a palette command. **Agent setup:** Space toggles a CLI, Enter runs Install/Log in.
- **Machine badge:** text ("on win-box"), never colour only. No touch (desktop only); every action has
  a pointer path; the palette lists Add machine, Connect, Disconnect, Set up agents.

### 9.3 Accessibility, i18n, tokens
- State is text plus icon, never colour alone; changes announced politely; focus stays on the row
  after Retry; existing focus rings and contrast.
- Strings in the existing strings modules; times local; paths verbatim with LTR isolation; counts
  pluralised, not concatenated.
- Semantic tokens only (status-ok / warn / error / muted, a neutral badge, the existing dimmed
  terminal); light, dark and high contrast from the current themes.

## 10. Scope slicing
- **MVP:** Linux controller → one Windows and one Linux remote; Machines add/remove; probe, pinned
  install, upgrade, start (RS-D5); full and light modes; agent setup panes (F2); stdio link carrying
  CON-27 messaging, monitor, drive; the three machine tools; routed session tools; read-only remote
  files; remote requests answerable here; POL rules for connect and routed calls; Activity on both
  sides; C2 pipe hardening; G1–G9 first; e2e: a Linux→Linux remote on CI plus a Windows target in the
  remote e2e, headless.
- **v1:** a fleet with health (CPU, disk, agent counts, last seen); file tree, Changes, diff, Review,
  git history; editing remote files; `run_command`; `attach_folder`; macOS and arm64 remotes;
  Windows/macOS as controller (Win32-OpenSSH lacks ControlMaster — ASSUMED).
- **Vision:** port forwarding (`open_url`); sandbox machines via hc `--via`; a relay for machines
  without SSH reach; cross-user (CON-17). **Out of scope:** installing sshd; storing SSH secrets; a
  hosted service.
- **Size (estimate):** MVP ≈ CON-27 (bootstrap and routing replace pairing/TLS; the rest is reused);
  v1 about as much again, mostly the remote file/git service.

## 11. Acceptance criteria
EARS (MVP):
- When `connect_machine` names a machine with a live connection, the system shall return `reused: true`
  without dialing; when ssh would prompt, it shall return `ssh_needs_person` with the reason within the
  tool budget and shall not write `known_hosts`.
- When the remote has no Conduit server or an older one, the system shall install the local version,
  verified against the pinned SHA-256, and start it; when the remote is newer with the same link major
  it shall attach without downgrading.
- If an install is interrupted, then the previous remote version shall stay runnable and the next probe
  shall remove the partial files.
- While the link is down, remote sessions shall keep running, and messages to the controller shall be
  delivered exactly once after reconnect (within 24 h).
- When the lead opens a remote session, the owner's sidebar shall show it under the lead with the
  machine badge within 2 s, and clicking it shall show the live terminal.
- When the owner types into a remote pane, the input shall reach the remote session and the remote's
  Activity shall name "you, from <controller>".
- If the remote sends a `call` or `drive` frame to the controller, then the controller shall refuse it
  and audit it. The system shall open no listening socket on a non-loopback interface on either machine.
- When an agent calls `connect_machine` for a never-installed machine, the system shall raise a
  permission ask under every built-in profile.
- If a routed call's link drops before its result, then the caller shall get `peer_unreachable` and the
  call shall not be re-sent. The system shall never copy an agent credential unless the owner chose it.
- If the remote's identity key changes, a platform has no pin, or the link majors differ, then
  `connect_machine` shall return `identity-changed` / `remote_unsupported` / `peer_incompatible` and
  nothing shall cross; `open_session` on a CLI missing there shall return `agent_not_installed`.
- When `disconnect_machine` runs, every remote session shall keep running; two ssh targets that reach
  one machine id shall list as one machine.
- When an `fs.read` targets a path outside the session's folders, on the deny-list, or over 8 MiB,
  the remote shall return `refused` / `too_large` and read nothing.
- While a machine is `down` and enabled, redials shall back off to at most 60 s and fire at once on
  wake.
- If a process reaches the remote endpoint without the per-start secret, or a `call` names a principal
  other than its link's controller, then the remote shall refuse it and audit it.
- Where a machine is in light mode, `list_agents { machine }` shall list no agent CLIs, and
  `open_terminal { machine }`, `send_input`, `read_screen` and `open_file` shall work.

```gherkin
Feature: Lead orchestrates a Windows box over SSH
  Background:
    Given win-box is a Host in ~/.ssh/config with OpenSSH Server on and my key authorized
    And the lead claude-3 runs under the Lead profile
    And the owner set up Codex on win-box (installed and logged in) from agent setup
  Scenario: First connection installs Conduit; a lane survives sleep; the owner takes over
    When claude-3 calls connect_machine with machine "win-box" and the owner allows the install ask
    Then the result has state "up", os "windows" and installed true
    When claude-3 opens codex-2@win-box with a long task and the laptop sleeps 30 minutes
    Then codex-2@win-box is still running and its message to claude-3 arrives exactly once
    When the owner clicks codex-2@win-box under claude-3 and types "stop and summarise"
    Then codex-2 receives the text and the owner can close the session from the pane
  Scenario: Unknown host key
    Given win-box's host key is not in known_hosts
    When claude-3 calls connect_machine
    Then it gets ssh_needs_person with reason host_key_unknown and a hint to ask the human
```

## 12. Assumptions
- MVP's controller is Linux with ControlMaster; remotes are reachable by SSH (LAN, tailnet, public).
- CON-24 merges before this plan; POL's profile table and Activity are the policy surface. CON-28
  (machines UI) is superseded by §9 for own machines. Strings and plural helpers exist (not checked; a builder adds them if not, RS-D15).

## 13. Decisions Needed
Format: options → **default taken** → why. (This section and the owner's two addenda push the spec
past the ~400-line FULL budget; nothing below is optional reading for the owner.)
- **RS-D1 [high] Shape.** (a) Conduit server over SSH stdio; (b) hc machines; (c) CON-27 TLS; (d) port
  forward. → **(a)**: only (a) gives remote agents Conduit's MCP, policy and audit with SSH the one root.
- **RS-D2 [high] Gate first.** Measure G1–G9 (G7 on a Linux remote, the rest on a real Windows 11 box; headless) before the plan. →
  **yes**: G1/G2 can change the start method.
- **RS-D3 [high] CON-27 pairing and TLS.** (a) park behind the network flag for CON-17; (b) delete;
  (c) keep both transports live. → **(a)**: reversible, frames reused; delete if CON-17 is dropped.
- **RS-D4 [high] Who decides routed calls.** (a) local POL at the origin, then the remote floor with
  the controller at Lead; (b) remote POL only (controller at Worker, orchestrate at ask); (c) local
  only. → **(a)**: policy lives where the owner sits; (b) raises asks on an unattended box.
- **RS-D5 [high] How the Windows server starts.** (a) attach to a server in the user's logon session
  (desktop app or tray), else a per-user scheduled task "only when logged on" (keeps the user's logins;
  needs a logged-on user); (b) inside the SSH job with breakaway (works logged off; logins per G2);
  (c) a Windows service (admin, no user logins). → **(a), plus (b) where G1/G2 pass.**
- **RS-D6 [high] May an agent add a new machine?** (a) yes, at ask under every profile; (b) owner only.
  → **(a)**: matches "connect… if it's not open"; the ask names the host and the install.
- **RS-D12 [high] Who installs agent CLIs.** (a) the owner, from agent setup, in visible panes; (b) an
  agent too, at ask. → **(a)**: third-party installers from the network; widen later.
- **RS-D13 [high] Agent logins.** (a) the CLI's own login per machine in a pane; credential copy only as
  an explicit per-CLI owner choice with a warning; (b) never copy; (c) copy by default. → **(a)**.
  Multi-machine login terms: none documented for Claude; unknown for Codex.
- **RS-D14 [high] How a Linux remote's server starts.** (a) a detached session (`setsid`) and, where
  `systemd --user` exists, `systemd-run --user --scope`; linger only if the owner enables it; (b)
  require linger. → **(a)**, with G7 deciding whether logout kills it and the UI saying so.
- **RS-D7 [normal] Answer remote requests from the controller in MVP.** (a) yes; (b) read-only
  (REQ-D21 today). → **(a)**: an unattended box otherwise stalls.
- **RS-D8 [normal] Harden the C2 pipe in MVP** (current user only, no remote clients). → **yes**.
- **RS-D9 [normal] Platforms.** win-x64 and linux-x64 in MVP; arm64, macOS in v1. → **as stated**.
- **RS-D10 [normal] Read-only remote files in MVP.** (a) yes; (b) v1. → **(a)**: "view the files".
- **RS-D15 [normal] UI helpers.** If strings/plural helpers are missing, add them in the UI slice. →
  **yes**.
- **RS-D11 [normal] Share userData with the remote's desktop app.** (a) share; (b) separate. → **(a)**:
  two servers would show two fleets.

## Revision log
- v1 (2026-11-16): draft + owner addendum + vendor facts (CLI install/login, light mode, sshd); review.
- v1.1: reviewer fixes — supervisor and Linux start (RS-D14, G7), bridge secret and principal scoping,
  ControlMaster for the needs-person pane, fs deny-list, G8/G9, error-path criteria, frame mapping.
