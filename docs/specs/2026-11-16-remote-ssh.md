---
status: shaped — decisions locked by the owner 2026-11-16; gates G1–G9 next
date: 2026-11-16
ticket: CON-35 (replaces CON-27's transport for own machines; CON-17 stays parked)
---

# Feature Spec: Remote machines over SSH — a fleet of agents you can watch

**Owner ruling (2026-11-16):** "it is pointing to setting up the SSH system for our own machines";
"full Conduit functionality over machine B but from machine A".
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
> **Shape.** Like VS Code: Conduit runs your own `ssh`, detects B's OS and CPU, installs a pinned
> headless Conduit server in your user folder there (no admin), starts it so it outlives the connection,
> and talks to it over the SSH channel's stdio. No port opens anywhere; no pairing or certificates.
> CON-27's frames, outbox, monitor and drive are reused; its pairing and TLS are parked.
>
> **MVP.** Add `win-box` (an ssh Host) once; answer any host-key prompt in a pane; install and log in the
> agent CLIs you pick, in panes you watch. Your lead can then `connect_machine` and open, drive, read and
> close sessions there. You get A's views of B: its sessions under the lead (click, type to take over,
> close) and its files (browse, edit, diff, git history, Review). Agents keep working while the laptop
> sleeps. B's permission rules are edited from A and enforced by B (RS-D16). Light mode: no CLIs on B.
>
> **Windows, honestly:** an admin switches OpenSSH Server on once (on by default only on Server 2025);
> your key goes in the right `authorized_keys`; the box stays awake and logged in; each CLI is logged in
> once there. Conduit checks each and shows the fix. Tailscale SSH can't serve Windows; OpenSSH over a
> tailnet works. **Big unknown:** whether a server started over SSH on Windows survives the disconnect
> and keeps your logins: slice 1 measures it. **Decisions:** locked 2026-11-16 (§13).

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
- **Non-goals:** other people's machines (CON-17); a relay or hosted service; remote desktop; installing
  OpenSSH Server for the user; Windows or macOS as the controller in MVP.

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

## 3. Shape (RS-D1, locked)
**A: a Conduit server on B, CON-27 link frames over the ssh channel's stdio.** Rejected: **hc machines
only** (local hc adds B with `machine add --install`; terminals but no MCP host, policy, audit or files
on B, and a second control path around Conduit identity); **CON-27 TLS links** (pairing per machine,
firewall prompts, LAN/tailnet only); **a VS Code-style port forward** (Windows has no stream-local
forward, and a loopback port any local process can reach needs a key; stdio has no port). hc's
`machine` feature stays a candidate engine for G1 (if hc already breaks away on Windows, the bootstrap
starts B's supervisor through hc as the app does), never a second control path.

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
- **F3/F4 Lead connects, opens and drives.** `connect_machine { machine }` (reuses or dials; `up` or a
  typed error, §5.2) → `list_agents { machine }` → `open_session { machine, agent, folder,
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
- **F8 Light mode.** No agent CLIs on B; the lead works from A through `open_terminal { machine }`,
  `send_input`, `read_screen` and the file views (v1 adds `run_command`). B still runs the headless
  server (user folder, no admin): surviving terminals, visibility and files need it. A zero-install
  mode (raw `ssh` exec) is rejected: nothing survives a drop and the owner sees nothing.
- **F9 Files on B, from A (MVP, RS-D10).** A remote session's folders get the same file tree, file
  tabs, Changes, diff, git history and Review as a local one, served by B's server (its own `watchDir`
  and `runGitBin`, per CLAUDE.md). Editing saves through B's server with the version the editor
  loaded; if the file changed on B since, the save is refused (`conflict`) and the tab offers a diff to
  re-apply (RS-D17). Reads and writes stay inside the session's folders and never touch deny-listed
  paths (§5.3).
  `attach_folder { machine }` adds a B folder to a B session.

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
| `open_file`, `close_files` | `{ machine, path }`; editable, saved through B | MVP | served `fs.*` |
| `open_diff`, `open_review`, `open_git_history` | `{ machine, … }` | MVP | served `git.*`; the server has no git today (§2.1), so B's server gains a git/watch service |
| `attach_folder` | `{ machine, folder }` on a B session | MVP | routed; B watches it |
| `run_command` (light mode) | `{ machine, argv }`, bounded like hc `machine.exec` | v1 | new tool |
| `open_url` | opens on A; a B `localhost` URL gets a port forward over the same ssh | v1 | owner ruling |

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

### 4.7 Where a machine's permission rules live (RS-D16)
- Two layers: **A's rules** say what A's agents may do on B (kept on A, RS-D4); **B's rules** cover
  B's own agents and the floor for controllers (kept and enforced on B). The owner edits both from A:
  the Permissions panel gets a machine picker.
- **Edit while B is up:** A sends `policy.push { baseRev, doc }`; B validates, stores atomically, applies
  to future calls (waiting asks re-decided, as POL §5.2), and acks `{ rev }`. A shows "applied on win-box".
- **Edit while B is down:** A keeps the edit as a pending draft ("waiting for win-box"); B keeps
  enforcing its last copy. On reconnect A pushes the draft automatically.
- **B changed meanwhile** (a person at B's own GUI, or another controller): B's `rev` ≠ `baseRev`, so B
  refuses with `policy_conflict` and its current doc; B's copy stays in force; A shows both and the
  owner re-applies on top of B's. Nothing merges silently.
- **Grants** made by answering asks are stored where the decision was made (B's grants on B); A pulls
  them on connect and on change events, and revoking one from A is a push. Activity stays on each server.
- A fresh install starts with B's built-in defaults plus the controller-at-Lead floor until the first push.

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
- `fs.read` / `fs.stat` / `fs.list` / `fs.watch` / `fs.write { path, data, expect }` (8 MiB per frame
  → `too_large`; `expect` = the content hash the editor loaded, mismatch → `conflict`; confined by B to
  the session's folders, symlinks resolved and rechecked; a fixed deny-list wins even inside them:
  `.ssh`, `.gnupg`, `.claude*`, `.codex`, `.cursor`, `.config/opencode`, `%APPDATA%` credential stores,
  `.env*` → `refused`). `git.status` / `git.diff` / `git.log` / `git.show` (read-only; the owner's git
  actions in Review run as routed calls).
- `policy.push` / `policy.pull` / `policy.changed` (RS-D16).
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
| File content, watches, git state | B's `fs.*`/`git.*` service (new) | A's tree, tabs, Changes, Review | yes |
| File writes | A's editor | B's `fs.write` | yes |
| B's rules and grants | A's Permissions panel (push) / B's asks (grants) | B's policy engine / A's view (pull) | yes |
| Policy decisions | local POL; remote floor | Activity on each side | yes |
| CON-27 pairing/TLS state | parked | nothing here | **no**: parked behind its flag (RS-D3); its frames are reused, its listener isn't started |

### 5.5 Invariants
Nothing listens on a non-loopback interface on either machine. No SSH secret is stored, no forwarding
enabled, host-key checking never weakened, no agent credential copied without the owner's choice.
Every Conduit binary is checked against its pin before it runs. B's server is the sole writer of B's
sessions, PTYs and files. Tool calls are never replayed after a drop; messages arrive exactly once.

## 6. Edge cases and failure modes
| Condition | Behaviour |
|---|---|
| Two `connect_machine` at once, or lead and owner at once | one dial; both get its outcome |
| Host key changed / ssh would prompt | `ssh_needs_person`, never a hang; Conduit never edits `known_hosts` |
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
| Save while the file changed on B | `conflict`; the tab shows a diff; nothing overwritten |
| Rules edited on A while B is down / B edited meanwhile | pending draft pushed on reconnect / `policy_conflict`, B's copy stays |
| Outbox limits / unsupported platform (arm64, musl) | CON-27 caps (1,000 entries / 64 MiB per peer, 24 h) / `remote_unsupported` (RS-D9) |

## 7. Defaults
| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| ssh binary/config | system `ssh`, `~/.ssh/config`, ControlMaster on (Linux) | ssh path | standard; VS Code/Zed do this |
| Server source | remote downloads pins; push fallback | per machine | push covers offline boxes |
| Version policy | install the local version; attach to local-or-newer with the same link major; never downgrade; keep every version a running session or another controller's last push uses, plus one previous | no | one wire version; rollback; several controllers |
| Mode on add | full, no CLI preselected | per machine | the owner picks CLIs; light is one click |
| Routed calls on the remote | floor + controller at Lead | per machine on the remote | the owner's own key |
| New machine by an agent | ask, every profile | POL grant | installing software isn't reversible |
| Remote files | read and write, session folders only, credential deny-list, 8 MiB per frame | no | parity without exposing credentials |
| Where B's rules live | on B, edited from A, B's copy wins until a push succeeds | no | B stays safe while A is offline |
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
  the bootstrap (downloads and runs binaries), the stdio bridge, routed calls, remote file reads and
  writes (confined, deny-listed, conflict-checked), rules pushed from A (B validates every doc).
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
| Remote file tab | loading / loaded / dirty / saving / conflict / too large / refused | machine in the title; conflict shows a diff | Save, Re-apply, Discard |
| Remote Changes / Review / history | as local, plus "win-box offline" | machine badge | as local |
| Permissions (machine picker) | applied / pending / conflict | "applied on win-box" / "waiting for win-box" / both docs | Push, Re-apply |
| Add dialog | picking / dialing / setup help | Hosts from ssh config; Windows setup commands | Copy, Retry |

### 9.2 Interaction inventory
- **Machine row** (`treeitem`, `aria-expanded`, state as text): click expands, inline Retry/Connect;
  arrows and Enter in the tree; context menu Disconnect, Rename, Remove, Set up agents.
- **Add dialog / agent setup** (`dialog`, live region for progress): list, text field, checkboxes; Tab,
  Enter, Esc. **Remote pane:** as a local terminal, + "Machine details"; live region for reconnecting.
- **Remote file tab, Changes, Review:** the local keyboard model unchanged (save shortcut, find, diff
  navigation); Re-apply and Discard are buttons and palette commands. **Agent setup:** Space toggles a CLI, Enter runs Install/Log in.
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
Child-card slices, in dependency order. Each ships on its own behind the network flag with its own e2e
(Linux→Linux remote on CI; Windows remote in the remote e2e; headless).

| # | Slice | Size | Needs | Ships |
|---|---|---|---|---|
| 1 | **Gates G1–G9** | S | — | a measured report; fixes RS-D5/RS-D14 variants |
| 2 | **Stdio link** | M | 1 | link code on any Duplex; ssh dialer; `--link-stdio` bridge with per-start secret; C2 pipe hardening (RS-D8); pairing/TLS parked (RS-D3) |
| 3 | **Bootstrap** | M | 2 | probe, pinned install/upgrade, atomic layout, retention; headless "ensure server"; Linux and Windows start |
| 4 | **Machines + tools** | M | 3 | registry, ControlMaster, needs-person pane; `connect_machine` / `list_machines` / `disconnect_machine`; errors; POL entries |
| 5 | **Routed session tools** | M | 4 | `call` frame, principal scoping, remote floor; `list_agents`, `open_session`, `open_terminal`, `send_input`, `read_screen`, `close_session` |
| 6 | **Machines UI** | M | 4 | sidebar group and rows, add dialog, remote session rows under the opener, remote panes (relay + drive) |
| 7 | **Remote requests** | S | 5 | `request.mirror` / `request.answer`; answer from A |
| 8 | **Remote file browsing** | M | 5, 6 | B's `fs.read/stat/list/watch` with confinement and deny-list; file tree and viewer tabs for B folders |
| 9 | **Remote file editing** | S | 8 | `fs.write` with `expect` and conflicts (RS-D17); `attach_folder { machine }` |
| 10 | **Remote git** | M | 8 | B's `git.*`; Changes, diff, history, Review for B folders |
| 11 | **Remote rules** | M | 5 | RS-D16: `policy.push/pull`, revs, drafts, conflicts, machine picker |
| 12 | **Agent setup + light mode** | S | 6 | CLI install and login panes; full/light choice |

- **v1:** a fleet with health (CPU, disk, agent counts, last seen); `run_command`; `open_url` to B's
  localhost via a forward; macOS and arm64 remotes; Windows/macOS as controller.
- **Vision:** sandbox machines via hc `--via`; a relay for machines without SSH reach; cross-user
  (CON-17). **Out of scope:** installing sshd; storing SSH secrets; a hosted service.

## 11. Acceptance criteria
EARS (MVP; `(Sn)` = the §10 slice that proves it):
- (S4) When `connect_machine` names a machine with a live connection, the system shall return `reused: true`
  without dialing; when ssh would prompt, it shall return `ssh_needs_person` with the reason within the
  tool budget and shall not write `known_hosts`.
- (S3) When the remote has no Conduit server or an older one, the system shall install the local version,
  verified against the pinned SHA-256, and start it; when the remote is newer with the same link major
  it shall attach without downgrading.
- (S3) If an install is interrupted, then the previous remote version shall stay runnable and the next probe
  shall remove the partial files.
- (S2) While the link is down, remote sessions shall keep running, and messages to the controller shall be
  delivered exactly once after reconnect (within 24 h).
- (S6) When the lead opens a remote session, the owner's sidebar shall show it under the lead with the
  machine badge within 2 s, and clicking it shall show the live terminal.
- (S6) When the owner types into a remote pane, the input shall reach the remote session and the remote's
  Activity shall name "you, from <controller>".
- (S5) If the remote sends a `call` or `drive` frame to the controller, then the controller shall refuse it
  and audit it. The system shall open no listening socket on a non-loopback interface on either machine.
- (S4) When an agent calls `connect_machine` for a never-installed machine, the system shall raise a
  permission ask under every built-in profile.
- (S5) If a routed call's link drops before its result, then the caller shall get `peer_unreachable` and the
  call shall not be re-sent. The system shall never copy an agent credential unless the owner chose it.
- (S4) If the remote's identity key changes, a platform has no pin, or the link majors differ, then
  `connect_machine` shall return `identity-changed` / `remote_unsupported` / `peer_incompatible` and
  nothing shall cross; `open_session` on a CLI missing there shall return `agent_not_installed`.
- (S4) When `disconnect_machine` runs, every remote session shall keep running; two ssh targets that reach
  one machine id shall list as one machine.
- (S8) When an `fs.*` call targets a path outside the session's folders, on the deny-list, or over 8 MiB,
  B shall return `refused` / `too_large` and touch nothing.
- (S9) When the owner saves a B file whose content changed on B since it was loaded, B shall refuse with
  `conflict` and leave the file unchanged; otherwise the save shall land on B and show in B's Changes.
- (S10) When the lead or owner opens Changes, a diff, git history or Review for a B folder, the system shall
  show B's git state, and the view shall update when files change on B.
- (S11) When the owner edits B's rules on A while B is down, B shall keep enforcing its previous rules, and
  A shall push the edit on reconnect; if B's rules changed meanwhile, B shall refuse with
  `policy_conflict` and keep its copy.
- (S4) While a machine is `down` and enabled, redials shall back off to at most 60 s and fire at once on
  wake.
- (S2) If a process reaches the remote endpoint without the per-start secret, or a `call` names a principal
  other than its link's controller, then the remote shall refuse it and audit it.
- (S12) Where a machine is in light mode, `list_agents { machine }` shall list no agent CLIs, and
  `open_terminal { machine }`, `send_input`, `read_screen` and the file views shall work.

```gherkin
Feature: Lead orchestrates a Windows box over SSH
  Background:
    Given win-box is a Host in ~/.ssh/config with OpenSSH Server on and my key authorized
    And the lead claude-3 runs under the Lead profile
  Scenario: First connection installs Conduit (S3, S4)
    When claude-3 calls connect_machine with machine "win-box" and the owner allows the install ask
    Then the result has state "up", os "windows" and installed true
  Scenario: A lane survives sleep and the owner takes over (S5, S6)
    Given the owner set up Codex on win-box and claude-3 opened codex-2@win-box with a long task
    When the laptop sleeps 30 minutes and wakes
    Then codex-2@win-box is still running and its message to claude-3 arrives exactly once
    When the owner clicks codex-2@win-box under claude-3 and types "stop and summarise"
    Then codex-2 receives the text, and the owner can close it from the pane
  Scenario: The owner edits a file on win-box (S9, S10)
    Given codex-2@win-box works in C:\src\app
    When the owner opens its file tree on Linux, edits README.md and saves
    Then the file changes on win-box and shows in win-box's Changes for that folder
```

## 12. Assumptions
- MVP's controller is Linux with ControlMaster; remotes are reachable by SSH (LAN, tailnet, public).
- CON-24 merges first (POL's profiles and Activity are the policy surface); §9 supersedes CON-28 for
  own machines; strings and plural helpers exist (not checked; RS-D15 covers it).

## 13. Decisions
**Locked by the owner 2026-11-16** (default taken in v1.1, unless noted):
- **RS-D1** Conduit server over SSH stdio (not hc machines, CON-27 TLS or a port forward).
- **RS-D2** Gates G1–G9 first (G7 on a Linux remote, the rest on Windows 11, headless).
- **RS-D3** CON-27 pairing and TLS parked behind the network flag; frames, outbox, monitor, drive reused.
- **RS-D4** Routed calls: A's policy at the origin, then B's floor with the controller at Lead.
- **RS-D5** Windows start: attach to a server in the logon session, else a "logged-on only" scheduled
  task; inside the SSH job with breakaway only where G1/G2 pass.
- **RS-D6** An agent may add a machine, always at ask, under every profile.
- **RS-D7** Remote requests answerable from A in MVP.
- **RS-D8** C2 pipe hardened in MVP (current user, no remote clients).
- **RS-D9** win-x64 and linux-x64 remotes in MVP; arm64 and macOS in v1.
- **RS-D10 (changed)** Full file parity on B in MVP: browse, view, edit, diff, git history, Review,
  `attach_folder`; writes through B's server, session folders only, same deny-list. `open_url` to B's
  localhost in v1.
- **RS-D11** Share userData with B's desktop app (one server, one session list).
- **RS-D12** Only the owner installs agent CLIs, in visible panes.
- **RS-D13** CLI logins per machine in a pane; credential copy only as an explicit per-CLI choice.
- **RS-D14** Linux start: `setsid`, plus `systemd-run --user --scope` where present; linger only if
  the owner enables it; G7 decides what the UI warns about.
- **RS-D15** Missing UI helpers are added in the UI slice.
- **RS-D16 (new)** B's rules live on B, edited from A, pushed when connected; B's copy wins until a push
  succeeds (§4.7).

**Open (design default, override if you disagree):**
- **RS-D17 [normal] Save conflicts on B.** (a) refuse on a hash mismatch and offer a diff; (b) last
  write wins. → **(a)**: an agent on B may be editing the same file.

## Revision log
- v1 (2026-11-16): draft, owner addenda, vendor facts, reviewer pass. v1.1: reviewer fixes (supervisor,
  Linux start, bridge secret, ControlMaster pane, deny-list, G7–G9, error-path criteria).
- v1.2 (2026-11-16): owner locks; RS-D10 widened to full file parity; RS-D16 (§4.7); §10 child-card
  slices; criteria tagged by slice.
