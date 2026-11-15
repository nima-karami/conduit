# Feature Spec: Conduit network — linked servers across machines and users (CON-16 + CON-17)

**Tier:** FULL · **Feature type:** mostly non-UI (transport, identity, trust) with UI for pairing,
link state and remote monitoring (§8) · **Status:** `status: shaped — awaiting owner decisions` (v4, 2026-11-14, spec-network). No
implementation plan, by design.
**Siblings:** POL = `2026-11-14-policy-and-permissions.md` (CON-18) · REQ =
`2026-11-14-user-input-requests.md` (CON-10). Rulings: `docs/runs/2026-11-14-shaping/rulings.md`.

> **For the user (read this first)**
>
> **Verdict.** CON-16 and CON-17 are one mechanism: your Conduit servers *link* to each other, and each
> link is `own` (your machine) or `guest` (someone else's), fixed by both sides at pairing. Own links
> ship first; guest links come later behind CON-18's grants and carry message exchange only in v1.
>
> **What MVP feels like.** At your Linux desk you click *Link my machine*, type the three words it
> shows on the Windows box, and confirm the same fingerprint on both. The Linux sidebar then has a
> **Machines** group: `win-box`'s sessions with live terminals, presence and limit state, which you can
> type into if `drive` is on (NET-D18). Your Claude lead can message `opencode-1@win-box`; if the box
> sleeps, messages wait and arrive once.
>
> **MVP limits.** Agents can't open sessions on the other machine (`orchestrate` is v1, and your
> Linux-lead-spawns-Windows-lanes workflow needs it). Remote asks show read-only ("answer on win-box"),
> so an unattended box can't get approvals from Linux until v1 unless pre-granted (REQ-D21). Kiro joins
> only once its MCP setup on Windows is measured (NET-D19). No vendor allows pooling subscriptions, and
> Conduit can't technically stop a guest doing work on their own subscription: NET-D8 is a stance plus a
> terms note, not enforcement. **Size:** MVP ≈ the three-process split; v1 about as much again.
>
> **Top decisions:** NET-D1 one mechanism, two trust levels · NET-D3 MVP over your LAN/tailnet, no
> relay · NET-D4 own links start with messaging + watching · NET-D7 CON-17 v1 = message exchange only ·
> NET-D18 `drive` in MVP. **Depends on:** POL MVP remote principal (R1) · REQ-D21 · POL-D15 (v1).

**Tickets (verbatim excerpts, Notion):**
- CON-16: "the same user should be able to have Conduits running on different machines and control the
  agents locally and remotely... The user can open the Conduit GUI on either machine and attach their own
  interface to view and monitor... My main machine might be running on Linux and could have Claude Code
  and Codex... remote machines might be running on Windows with Kiro CLI and/or Windows with open code.
  All of that should work!... my agents would have the ability to communicate across machines."
- CON-17: "I might want my agent to communicate with another user's agent... pool our resources, tokens,
  knowledge, and systems... there needs to be a permission system for this, a very strong policy system".
- User, 2026-11-14: they "might end up having the same pipeline... the same feature or... totally different."

## 1. Problem frame
- **Job (CON-16):** from whichever machine I'm at, see every agent on all my machines, steer them, and
  let them talk to each other as if it were one Conduit.
- **Job (CON-17):** let my agent work with someone else's agent, only as far as I allow, and let me see
  everything that crossed.
- **Actors:** the owner (a human at a GUI); agents (Claude Code, Codex, Cursor, OpenCode, Kiro or any
  CLI in a Conduit terminal); a peer owner (CON-17); each machine's server (ADR 0007), the only thing
  that acts on that machine.
- **Success outcomes:** (1) linking two of my machines takes one typed code and a confirm on each
  screen, no config files; (2) from Linux I see the Windows sessions live; (3) cross-machine messages
  are neither lost nor duplicated when the link blips; (4) a guest reaches only the agents I shared,
  while the grant lasts, and every crossing is an audit entry naming the peer; (5) revoking stops
  traffic from the revoking side at once.
- **Non-goals:** accounts or a hosted service in MVP/v1; sharing subscriptions or credentials;
  multi-person editing; remote desktop; running a guest's code on my machine; replacing a VPN.

## 2. What exists today
"Source" = read from code or a design record (inference; re-check before a plan). "Measured" = the
spike or this session observed it. Policy and request internals: POL §2, REQ §2.

| Claim | Where | Kind |
|---|---|---|
| Three processes: Electron app (UI only); server (MCP host, inbox, policy, approvals, sessions); hc core+holder (PTYs). The server is the sole PTY writer and the sole active viewer | ADR 0007 §1–9; `docs/runs/2026-11-02-hc-spike/report.md` | Measured (spike) |
| Terminal output goes **hc → app directly**, not through the server. `TerminalLinkFactory` is the seam "a remote server would replace" | `src/contracts/terminal-link.ts:1-17`; archive three-process spec D3 | Source |
| C2 and the MCP endpoint are local named pipes or sockets, one per userData | `src/conduit-mcp/endpoint-path.ts:9-20` | Source |
| C2 is unauthenticated (`hello.auth` is reserved). The Windows pipe accepts same-user/admin SMB clients and is world-readable | `src/contracts/server-protocol.ts:349-353`; ADR 0007 §As built | Measured (spike M28) |
| The session token sits in the PTY env and is stored as SHA-256. Handles are `<cli>-<n>` per server, never reused, **not namespaced by machine**, and easy to guess | `server/mcp/token-file.ts:133`; `src/conduit-mcp/handles.ts:17-24` | Source |
| Messaging tools are off/on only, with no ask. A thread pauses after 20 agent messages | `tool-policy.ts:101-107`; `types.ts:7-8` | Source |
| Waiting asks are denied `ui_unavailable` 5 s after the **last app disconnects**. An app counts only if it has a ready window | `server/mcp/index.ts:41,315-327` | Source |
| The pinned hc protocol defines ssh/`via` **machines** (`machine.add`, `machine/t7`, `ephemeral`, `file.read`). Unknown whether the pinned build implements them | `src/contracts/hc/hc.openrpc.json:328-460,3126-3315` | Protocol text |
| There is no Kiro MCP install target. Kiro can be opened, and it would join messaging only as a generic `agent` with a hand-set entry | `tool-schemas.ts:149`; `agent-resolve.ts:126` | Source |
| The server runs on Linux (this run) and Windows (its primary target) | `list_sessions` here; ADR 0007 | Measured / Source |

All of this is one machine by construction. The archive spec lists these as "known reversals for a
later program"; this feature is that program.

## 3. Shape options
| | A: Federation (**recommended**) | B: Remote GUI | C: Hub |
|---|---|---|---|
| What | Servers hold authenticated links; each GUI talks only to its local server | The app becomes a second client of a remote server's C2 and hc (C5 seam) | Every server dials out to a relay/mailbox |
| Makes possible | Agent↔agent across machines; both trust levels; the receiving server decides; offline queueing; one audit point per machine | Fast CON-16 viewing and typing | Works behind any NAT; offline mailbox; accounts |
| Rules out | — | Agent↔agent messaging; all of CON-17, because C2 is the whole control plane | "No Conduit infrastructure" |
| Cost | High: new protocol, pairing, output relay | Medium. Needs C2 auth; hits the single-app assumptions (resize fights, one presence) | Highest: a service to run, pay for and secure |
| Risk | Relay load; version skew | Handing a person C2 hands them the machine | Holds everyone's metadata |

**Recommendation: A.** Reuse B's seam for the remote pane. Keep C only as a later optional transport
(a relay of end-to-end-encrypted bytes).

## 4. Behaviour & flows

### 4.1 Objects, capabilities, addressing
- **link:** a pairwise record on both servers (peer server key, peer owner key, trust level,
  peer-name, last-known addresses, enabled capabilities). **Non-transitive:** B never forwards
  traffic that didn't start on B; only owner-level events (revocations, owner-key rotation) travel
  between own servers.
- **Capabilities** (CON-18 action groups) a link enables:
  - `messaging`: `list_sessions`, `send_message`, inbox across the link.
  - `monitor`: humans see sessions, presence, output, attention; agents see remote presence and may
    `wait_sessions` on own-link sessions (R16).
  - `drive` (a **human** at a GUI): type into, resize, open and close remote sessions. The receiving
    server can't tell a human from its peer server, so `drive` trusts the peer server.
  - `orchestrate` (**agents** via MCP): `open_session`, `open_terminal`, `close_session`, `send_input`,
    `read_screen` on `x@peer`, under the receiving server's per-tool rules.
- **All 25 tools by capability** (R21), when the target is on a peer:

| Capability | Tools |
|---|---|
| `messaging` | `list_sessions`, `send_message`, `read_inbox`, `read_attachment`; Requests: `request_input`, `wait_request`, `withdraw_request`, `list_requests`, `answer_request`, `escalate_request` |
| `monitor` | `list_agents`, `wait_sessions` (own links) |
| `orchestrate` | `open_session`, `open_terminal`, `close_session`, `send_input`, `read_screen` |
| `drive` | Editor & views (`open_file`, `close_files`, `open_review`, `open_diff`, `open_git_history`, `open_url`), `focus_session`, `attach_folder`: they act on that machine's screen |

  A tool whose capability is off on the link is denied (POL floor "capability off → deny", above
  explicit rules). Escalation and `answer_request` follow the `opened_by` chain (R19, REQ §4.8).
- **Defaults:** own = `messaging` + `monitor`, `drive` and `orchestrate` one opt-in each; guest =
  nothing (never `drive`, no `orchestrate` in v1). Own trust never bypasses per-action rules; a remote
  principal is `handle@machine-id`, assigned by POL (MVP, R1).
- **Machine id** (stable, from the peer's server key, e.g. `m-7f3a9c`) behind a local **peer-name**
  (`win-box`). Own servers share names (a clash asks for a rename); guest names are never shared.
- **Address:** canonical `handle@<machine-id>`, shown as `handle@<peer-name>`; tools accept both.
  Bodies are never rewritten; tools hand agents canonical addresses ("quote addresses, not names"); an
  unlinked id → `unknown_session` + hint, never a guess; a bare handle means the reader's local session.

### 4.2 Pairing
1. On A the owner picks **Link my machine** (own) or **Invite someone** (guest). A listens only for the
   pairing window and shows a 3-word one-time code plus its addresses (10 min, 1-min warning; "New
   code" restarts).
2. On B the person enters the code and A's address. A PAKE runs (the code is never sent; a wrong guess
   burns it); server and owner keys are exchanged over the resulting channel.
3. Both screens show the same fingerprint, trust level and peer-name; both confirm. **own:** B must hold
   the owner key or receive it with a confirm on **an existing own machine**; a new machine never
   confirms itself into `own` (NET-D2). **guest:** each side names the other.
4. Failures: expired/used code → "make a new one"; mismatch or decline → nothing stored, audit on both;
   unreachable → "waiting for the other machine" until the window closes; re-pairing a known peer
   replaces the link only after both confirm and never turns guest into own without the own-key rule.
5. **Guest discovery** is out-of-band only (people exchange invite codes); no directory.

### 4.3 Link lifecycle
`pairing → connecting → up ⇄ degraded ⇄ down`; any → `revoked` (terminal).
- **incompatible:** protocol majors differ; nothing crosses; shows which side to update. **Feature
  gap:** "win-box doesn't support <X> — update it" (e.g. mirrored asks, `orchestrate`).
- **identity-changed:** the peer's server or owner key changed; nothing crosses; its grants are
  **suspended** (re-confirm restores, "treat as new peer" deletes; NET-D20).
- **down:** keys kept; last-known addresses retried with backoff; the owner can edit the address
  (sleep, DHCP, Wi-Fi). Tailnet names stay stable.
- **Revoke** (NET's word; also means unpair): either side, emitting an event with the peer id. On the
  revoking side, at once: traffic stops, POL deletes the peer's grants, REQ withdraws its open requests
  (`withdrawnBy: conduit`, REQ §4.2), queued messages become `undelivered`. The other side shows
  "revoked by peer" on next contact. MVP: a lost machine is revoked by hand on each machine.

### 4.4 Scenarios
**S1 — Watch Windows from Linux (own; MVP).** Machines group → `win-box` → its sessions. Panes render
with win-box's `windowsPty` facts (without them ConPTY repaints lose lines). Read-only viewers never
resize; with `drive`, the GUI that last typed sets the size.

**S2 — Agent to agent (own, messaging; MVP).** `claude-3` gets remote rows from `list_sessions` (§4.6)
and sends to `opencode-1@win-box`. win-box applies its inbound rules for the remote principal (POL
MVP), stores the message and notices `opencode-1` as it would locally. Each server counts the agent
messages it carries in a thread; the thread pauses at 20 on either side (where it shows: REQ).

**S3 — Link drops (MVP).** Agents keep running. Outgoing messages stay `queued`, are resent on
reconnect, deduplicated by message id, and `expired` after the TTL. Panes freeze ("win-box unreachable
since 14:02 — output paused") and resync from the current screen. Keystrokes typed while down are
**dropped, never replayed**. Remote `wait_sessions` returns `peer_unreachable`.

**S4 — Guest messaging (CON-17; v1).**
- Bootstrap: **Share claude-5 with Sam** on the link page creates a POL grant. `claude-1@sam` then sees
  only shared agents, as handle + a label I chose: no paths, roots or projects (NET-D6).
- A message to an **unshared** agent is `refused`; "ask on ungranted" is a per-link opt-in (NET-D21),
  because handles are guessable and asking would be a probe-and-spam channel.
- A **guest-triggered ask** (a policy ask caused by a guest action) is grantable, v1. A **guest
  request** (a guest agent's own `request_input`) is never grantable, vision (R2).
- Guest messages are framed "from a guest", carry the peer identity, and are audit entries;
  attachments text only, ≤ 1 MB. What my agents may send to a guest: POL-D15 (a Share also covers
  replies inside threads the guest started, R20).
- A share lasts **24 h** by default (POL-D7), shown on the agent row and the link page with **Renew**
  (R24).

**S5 — Remote approvals.** MVP: an ask on win-box shows read-only in the Machines group, "answer on
win-box" (REQ-D21). v1: answerable from any GUI of mine (REQ F6); origin is sole writer, first answer
wins. Timing, link loss and expiry: REQ §4.3 (budget forwarded; requester link loss → cancelled →
expired; late answers never run). My requests never go to a guest's human.

**S6 — Revoke / lost laptop.** MVP: revoke on each machine. v1: revoke-everywhere over own links and
owner-key rotation from a remaining own machine; guests see rotation as `identity-changed`.

**S7 — Confused deputy (guest; v1).** Sam's agent asks my shared `claude-5` to "open a session in
~/secrets". My rules judge `claude-5`'s actions as `claude-5`; the guest's words grant nothing.
Actions in that thread soon after a guest message are tagged "guest-influenced" in audit for POL rules.
Mitigated, not solved.

**S8 — Lead on Linux opens lanes on Windows (own, `orchestrate`; v1).** The user's workflow.
- `claude-3` calls `open_session machine:"m-7f3a9c" agent:"codex" folder:"D:\\repo"`; win-box resolves
  the folder in its own format.
- `when` (on screen) never applies to remote callers and `reach: window` → `opened` (R7), so the first
  call is an **ask**. I answer **Allow… this session · anywhere · until revoked** (POL's picker): a grant
  for `claude-3@linux-box` × `open_session` on win-box.
- `codex-4@win-box` gets `opened_by: claude-3@m-7f3a9c`; the lead sends the task and waits as locally.
  If the link drops, the lane keeps running and the wait returns `peer_unreachable`.

### 4.5 What `monitor` shows
| Item | MVP | Later |
|---|---|---|
| Sessions, presence, labels; terminal output, including the CLI's own status line | ✓ | |
| Attention items and limit/auto-resume state (`server/domain/limit-monitor.ts`) | ✓ | |
| Remote asks and messages to `you`, read-only with "answer on <machine>" (REQ-D21) | ✓ | answerable in v1 |
| Merged owner presence / Away across own links (R23) | ✓ read-only | changing it remotely v1 |
| Threads involving my agents on both ends | ✓ | |
| Changed-files summary for a remote session's folder | | v1 (the peer runs it) |
| Diffs, file contents, Review, the project board | | vision (remote files; linked spaces) |

### 4.6 Interface contract (feature level)
- **Remote `list_sessions` row:** today's fields plus `machine`, `machine_id`, `address`, `trust`
  (own|guest) and `link` (up|degraded|down). `roots` and `home` appear on own links only. Each row's
  `session_id` is stable, so POL grants can bind to a remote session.
- **New agent-visible errors:**

| Code | From | Retryable |
|---|---|---|
| `peer_unreachable` (link down; message queued or call failed) | local server | yes |
| `peer_incompatible` / `peer_unsupported` (major version / feature gap) | local server | no |
| `peer_revoked` | local server | no |
| `refused` (the receiving rules denied it; guests get no reason) | receiving server | no |
| `rate_limited` (link cap; existing code) | receiving server | yes |

- **Invariants:**
  - Message ids carry their origin and are delivered at most once.
  - The origin server is the sole writer of its own sessions, requests and audit.
  - Routing is non-transitive.
  - No credential, token or subscription material ever crosses a link.

| Data flow | Producer | Consumer |
|---|---|---|
| Remote sessions, presence, attention | Peer server | Local server → `list_sessions`, Machines group |
| Message + receipts | Sender outbox / receiver | Receiver rules → inbox / sender status |
| Pane output | Peer hc → **peer server relay** (new; NET-D9) | Local GUI |
| Keystrokes (`drive`) / tool calls (`orchestrate`) | Local GUI / local agent | Peer PtyWriter / peer per-tool rules |
| Mirrored ask, answer | Origin / answering GUI | REQ surface / origin (v1) |
| Revoke and identity events | Revoking or changed server | Peer; POL grants; REQ requests |
| Shared peer-names | Own servers | Own servers' address display |
| Owner presence / Away (R23) | Each own server | Other own servers (merged, read-only in MVP; REQ-D21) |

### 4.7 Edge cases
| Condition | Behaviour |
|---|---|
| Both sides send while the link is down | Each side queues; per-sender order is kept |
| Clock skew | Each expiry is judged by the object's owner: outbox by the sender, requests by REQ §4.3, grants by POL. Skew affects display only |
| Zero links / many links | With zero, only Settings → Machines exists. With many, the group collapses and output streams only for panes on screen |
| Guest flood | Link rate limit and daily cap (§5) → `rate_limited` + audit. Overflow raises at most one note to me per peer per hour |
| Link revoked mid-action | The peer finishes what it accepted. The result isn't delivered. Audit on both sides |
| Mixed OS paths | Kept in the target's format, shown verbatim, resolved by the target server. Attachments are bytes |
| Handle quoted to a third machine | Resolves only by machine id over a direct link (§4.1) |
| Viewer-only laptop (Conduit, no agents) | A server with zero sessions. Covered |
| Phone or browser | Not covered; vision (NET-D16) |

## 5. Defaults (owned by NET)
| Decision | Default | Configurable | Why |
|---|---|---|---|
| Link listener | Off until the first pairing window. After that, linked peers only. Never on a public interface by default | Settings → Machines | No new port for people who don't use links |
| Own-link capabilities | messaging + monitor; `drive` and `orchestrate` off | One switch each per link | One deliberate click per new power |
| Guest-link capabilities | None; sharing is per agent (S4) | Per link | "very strong policy system" |
| Pairing window | 10 min, single use; "New code" restarts it | No | Security floor. Restarting is the WCAG 2.2.1 extension |
| Outbox TTL | 24 h | Yes | A blip loses nothing; a dead link holds nothing forever |
| Guest link caps | 60 messages/h and 500/day per link | Yes | Limits token burn and spam |
| Guest attachments | Text only, ≤ 1 MB | Yes | Exfiltration surface |
| Remote output | Panes on screen only | No | Bandwidth |

Guest grant durations and waiting-ask caps belong to POL (R8; POL-D7).

## 6. Possible / not possible / unknown
| Item | Status | Source |
|---|---|---|
| Messaging between CLIs that have Conduit's MCP | Possible | Only the routing is new |
| Correct Windows ConPTY rendering in a Linux GUI | Possible, if the `windowsPty` facts are relayed | CLAUDE.md terminal rules |
| Typing into a remote terminal | Possible; costs one network round-trip | — |
| Kiro on Windows joining messaging | **Unknown**: no install target (NET-D19) | §2 |
| Delivery to a machine that is switched off | **Not possible** without a mailbox | — |
| A direct link between two strict NATs | **Not reliably possible** without a relay | https://www.rfc-editor.org/rfc/rfc8445 ; https://tailscale.com/blog/how-nat-traversal-works |
| SSH as the transport to Windows | Possible, with Windows' optional OpenSSH Server | https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse |
| hc `machine` linking as the own-link transport | **Unknown** (unmeasured). It bypasses Conduit's identity and policy | `hc.openrpc.json:3126` |
| Pooling one subscription across people | **Not possible** within vendor terms | §6.3 |
| Stopping a guest from reusing what it learned | **Not possible** | inherent |
| Recovering own identity after losing every machine | **Not possible** without accounts | NET-D2 |

### 6.1 Same machine, different OS user
Works by construction: a second server running under another OS account pairs over a local transport.
hc's `ephemeral`/`via` machines (`docker exec`, a VM's CLI) are a better sandbox story. No dedicated
work.

### 6.2 Network reality
- **LAN direct:** simple, but breaks off the LAN and triggers a Windows firewall prompt.
- **The user's own tailnet** (Tailscale, ZeroTier, WireGuard): zero Conduit infrastructure, and its
  ACLs add a second permission layer. Tailscale can share a node into another tailnet
  (https://tailscale.com/kb/1084/sharing), which is relevant for guests.
- **SSH:** mature auth, but Windows needs OpenSSH Server, and SSH gives a guest too much access.
- **NAT traversal plus a relay** (TURN, https://www.rfc-editor.org/rfc/rfc8656), or a relay Conduit
  hosts: works anywhere, but someone pays for it and metadata is exposed.
- **MVP:** every link is end-to-end authenticated and encrypted whatever the pipe. Connections are
  direct TCP to an address the user gives (LAN or tailnet), and SSH port-forwarding is documented
  (NET-D3).

### 6.3 Vendor terms (CON-17: "pool … tokens")
Accessed 2026-11-14. openai.com returned 403, so the OpenAI terms are UNVERIFIED.

| Vendor | Short quote | Source |
|---|---|---|
| Anthropic consumer | "You may not share your Account login information… You also may not make your Account available to anyone else"; may not "help another person to access or use" the Services | https://www.anthropic.com/legal/consumer-terms §2–3 |
| Claude Code | limits "assume ordinary, individual usage"; no routing "through Free, Pro, Max, or Ultra plan credentials on behalf of their users" | https://code.claude.com/docs/en/legal-and-compliance |
| AWS Kiro | "subscriptions and usage limits are calculated per individual user… each developer needs their own subscription" | https://kiro.dev/blog/new-pricing-plans-and-auto |

Also checked: OpenAI (https://openai.com/policies/terms-of-use, UNVERIFIED), OpenCode
(https://opencode.ai/legal/terms-of-service, "own internal use"), Cursor (https://cursor.com/terms-of-service
§1.5, no lending), Anthropic commercial terms (each end user signs in with their own credentials).

**Reading (not legal advice):**
- **Prohibited:** sharing credentials, or routing A's requests through B's subscription.
- **Grey:** B's own unmodified CLI, logged in as B, doing tasks that A's agent sends. Guest messaging
  enables exactly this, and Conduit can't tell knowledge exchange from delegated work. The grey case
  is therefore the users' responsibility.
- **Fine:** exchanging knowledge.
- **Sanctioned pooling:** Team/Enterprise plans or API billing.

### 6.4 Threat model
| Threat | Own | Guest | Mitigation |
|---|---|---|---|
| Eavesdropping or tampering | ✓ | ✓ | Mutual auth with pinned keys; encryption on every transport |
| Leaked pairing code | ✓ | ✓ | PAKE, single use, 10 min, fingerprints on both screens |
| Compromised peer | Reaches whatever capabilities are enabled | Shared agents only | `drive`/`orchestrate` off by default; revoke; audit |
| Stolen owner key used to mint own links | ✓ | — | A new own machine needs a confirm on an existing one. MVP has only manual revoke on every machine and **no rotation** (v1) |
| Prompt-injected own agent orchestrating | ✓ | — | `orchestrate` is opt-in; ask per tool until granted, and grants are scoped to one agent |
| Lateral movement by a shell agent (D16 already lets it drive its own machine) | Through links, as rules allow | Through shares | The receiving side decides; audit names `agent@peer` |
| Transitive reach | — | ✓ | Non-transitive invariant |
| Handle probing / spamming the owner | — | ✓ | Unshared targets are `refused`, with no ask by default (NET-D21) |
| Injection / confused deputy | low | **high** | Untrusted framing; S7 tagging; POL rules |
| Exfiltration out to a guest | — | ✓ | POL-D15 outbound rule; caps; audit |
| Token burn | — | ✓ | Link caps |
| Impersonation | ✓ | ✓ | Identity is the key; addresses carry the machine id |
| Local pipe exposure (M28) | ✓ | ✓ | Separate authenticated link endpoint; C2/MCP stay local |

### 6.5 As built: pairing and link security (CON-27, lead-approved 2026-11-14)
- **Pairing is numeric comparison, not a PAKE.** Each server sends its Ed25519 key and
  certificate in plain-TCP messages on a pairing port. That port is open only for the 10-minute
  window and only for one attempt. The joiner commits to its key and nonce before it sees the
  opener's, so a man in the middle gets one 2⁻³² guess at the 32-bit fingerprint per window. The
  person comparing fingerprints on both screens is the authentication.
- **Residual: a person who confirms without comparing.** An attacker on the path during the window
  can then pair. CPace would have stopped that, but it was ruled out to avoid owning PAKE code.
- **Residual: passive observers during a window.** Someone watching the LAN during a window sees the
  three words, both self-names, the listen addresses and both public keys. The code is single-use
  and burns on the first connection. A hijacked join shows a fingerprint that won't match.
- **Links use verified TLS.** Each link is TLS 1.3 with mutual certificates, and the only trusted CA
  is the peer's own certificate, pinned at pairing (SAN = machine id). `rejectUnauthorized` stays
  on, and a raw-key pin is checked as well. A revoked peer's certificate stays trusted for 30 days,
  only so its next handshake can be told `revoked`.
- **The fingerprint covers everything each side learns.** It hashes both keys, both nonces and a
  digest of both pair.id messages (machine id, owner key, offered owner key, name, addresses,
  protocol, certificate), so a relay that changes any of them shows each person a different value.
  On a first-ever link the opener offers its new owner public key inside its pair.id; there is no
  separate owner message after the confirm (CON-27 review minor 1).
- **The owner private key never travels in pairing.** It crosses the first verified link once, and
  the receiver accepts it only if it matches the public owner key both people confirmed.

### 6.6 Deviations (CON-27 as built, lead-approved 2026-11-15)
- **Attachments to another machine: 10 MiB per message, not 25 MB.** A link frame is capped at
  16 MiB, and a 25 MB message doesn't fit one frame once base64-encoded. `send_message` to any
  remote recipient fails before anything is stored if the attachments total over 10 MiB; the error
  names the limit. The inbound guard refuses over 10 MiB too, so neither side accepts more than it
  can send. Local messages keep the 25 MB limit.
- **Never all interfaces, never a public address, not even when set explicitly.** §5 says "never on
  a public interface by default"; as built, no setting can bind one. The link and pairing
  listeners bind only loopback, RFC 1918, 100.64.0.0/10 (tailnets) and ULA addresses, whether the
  setting is `auto` or one explicit address; IPv4-mapped spellings are judged as the IPv4 address
  they carry (CON-27 review M1).
- **Monitor shows every local session.** Sessions without an MCP handle appear with no address and
  can't be messaged; agents' `list_sessions` still lists addressable sessions only.

## 7. Acceptance criteria
EARS (MVP unless tagged):
- When both people confirm the same fingerprint, the system shall store the link with the chosen trust
  level on both servers. On a mismatch or a decline it shall store nothing and write an audit entry on
  both.
- When a machine without the owner key requests `own` trust, the system shall require a confirm on an
  existing own machine.
- While a link is down, the system shall keep outgoing messages `queued` until they are delivered or
  the TTL ends, then mark them `expired`. It shall never deliver a message twice.
- When a link is revoked, the revoking server shall stop all traffic on it immediately and emit a
  revoke event carrying the peer id.
- When protocol majors differ, both sides shall show `incompatible` and which side to update. When a
  peer lacks a feature, the GUI shall show "doesn't support <X>".
- The system shall never forward traffic between two links.
- (v1) When a guest targets an agent that isn't shared with it, the receiving server shall return
  `refused` and write an audit entry, unless the link has "ask on ungranted" on.

```gherkin
Feature: Own-machine link (CON-16)
  @mvp Scenario: Watch a remote session
    Given linux-box and win-box are linked "own" with "monitor" enabled and "drive" off
    When I open "opencode-1@win-box" from the Machines group
    Then I see its live output rendered with win-box's terminal facts
    And the input area says it is read-only because "drive" is off

  @mvp Scenario: A message survives a drop exactly once
    Given the own link is down
    When claude-3 on linux-box sends a message to "opencode-1@win-box"
    Then the sender sees "queued — waiting for win-box"
    When the link returns within the TTL and the message is resent twice
    Then opencode-1 receives it once

  @mvp Scenario: The pane freezes and resyncs
    Given I am viewing "opencode-1@win-box"
    When the link drops
    Then the pane shows "win-box unreachable since <time> — output paused" and input is disabled
    When the link returns
    Then the pane shows win-box's current screen

  @mvp Scenario: A remote ask is visible but answered on its machine
    Given an agent on win-box raised an ask
    Then linux-box's Machines group shows it read-only with "answer on win-box"

  @mvp Scenario: A quoted address resolves by machine id
    Given own links linux-box–win-box, linux-box–mac and win-box–mac
    When an agent on mac sends to "codex-2@<win-box machine id>"
    Then it reaches codex-2 on win-box
    When it sends to "codex-2@<an unlinked machine id>"
    Then it gets "unknown_session" with a hint

  @v1 Scenario: A lead opens a lane on another machine
    Given an own link with "orchestrate" enabled and no grant for claude-3 on win-box
    When claude-3 on linux-box calls open_session on win-box with agent "codex" in folder "D:\repo"
    Then a request owned by win-box appears on my GUIs
    When I answer "Allow… this session · anywhere · until revoked"
    Then win-box opens "codex-4" with opened_by "claude-3@linux-box"
    And a later open_session by claude-3 on win-box in folder "D:\other" raises no request

Feature: Guest link (CON-17)
  @v1 Scenario: Nothing visible before sharing
    Given a guest link to "sam" with "messaging" enabled and nothing shared
    When sam's agent calls list_sessions
    Then it sees no sessions of my machine
    When it messages "claude-3" by guessing the handle
    Then it gets "refused" and my audit records the attempt

  @v1 Scenario: A shared agent is reachable and audited
    Given I shared "claude-5" with "sam"
    When "claude-1@sam" messages "claude-5"
    Then claude-5 receives it marked "from a guest"
    And my audit shows peer "sam", agent "claude-1", target "claude-5", decided by the grant

  @v1 Scenario: No transitive reach
    Given linux-box is linked own to win-box, and win-box is linked guest to sam
    When sam's agent addresses a session on linux-box
    Then win-box refuses it and nothing reaches linux-box
```

## 8. UI module (tables for a later designer)
| Component | States / copy | Actions & a11y |
|---|---|---|
| Settings → Machines | First-run explainer · list rows (name, trust badge as text, state, last activity, capabilities) · shared agents with expiry and **Renew** | Link my machine / Invite someone / Share agent… / Revoke (confirm; no undo) / Rename / Copy fingerprint. Focus goes to the row after pairing and back to the list after revoke |
| Pairing dialog | Showing code (countdown, 1-min warning) · entering · connecting · confirm fingerprint · success · expired/used · mismatch · unreachable · cancelled | Enter confirms, Esc cancels. The code is read word by word and can be copied. Expiry is announced `assertive` |
| Machines group | up · degraded · down since <time> · incompatible · doesn't support <X> · identity changed · revoked by peer. Guest machines are labelled "guest" | Tab/arrow navigation. State changes are `aria-live=polite`. Never colour alone |
| Remote pane | live · read-only · frozen · resyncing · exited · driving | Banner text; input disabled where not allowed |
| Remote ask (MVP) | Read-only card: "answer on <machine>" | Opens the request detail |
| Messages | `x@peer`; "from a guest" | — |

- **i18n:** machine and peer names are user text in any script, bidi-safe, truncated with the full
  name shown on focus and hover. Times show in the viewer's time zone. The code words come from a fixed
  list and are not translated.
- **Tokens:** semantic link-state roles (ok, warning, error, neutral) plus a "guest" role, for light,
  dark and high-contrast themes.

## 9. Gaps and trade-offs
- **Output relay:** the server joins the output path for remote viewers: new load, new failure mode (NET-D9).
- **No accounts:** no recovery after losing every machine; weak for teams. **No offline delivery** without a relay.
- **Own trust is high:** a compromised own machine with `drive` reaches all of mine; MVP has no
  rotation and revoke is manual per machine.
- **Guest isolation is policy, not sandboxing:** injection and confused deputies are mitigated, not
  solved; what a guest learns can't be recalled.
- **CON-17 v1 is message exchange:** "tokens" isn't allowed; "systems" (guest `orchestrate`) isn't in v1 (NET-D7).
- **One project on two machines** shows as two groups with two boards (`.conduit/board.json`, ADR 0002)
  and no per-repo view. Vision: **linked spaces** matched by repo remote; boards stay per checkout.
- **Monitor stops at the terminal in MVP** (files, diffs, board need remote files). **Several typists:**
  "last typer sets the size" is simple but jumpy.

## 10. Relation to other tickets
- **H1 (one mechanism, two trust levels):** confirmed, with amendments. Trust is fixed at pairing,
  routing is non-transitive, and same machine with a different user works only by construction.
- **H2:** amended to four capabilities: messaging, monitor, drive (human) and orchestrate (agent).
  Remote `wait_sessions` falls under monitor on own links (R16); `read_screen` falls under orchestrate.
- **H3:** confirmed. The receiving side decides. Outbound to guests is POL-D15. Own trust never
  bypasses rules.
- **H4:** confirmed. REQ owns requests across machines (REQ-D21, REQ §4.2 and §4.3). NET MVP shows them
  read-only.
- **H5:** confirmed. Every link event and every crossing is an audit entry on the deciding server.
- **H6:** agreed. Remote auto-resume state shows under monitor.
- **CON-13:** independent, but the Linux-hub scenario needs a stable Linux build.

**Shared names** (owners per P2):

| Name | Owner |
|---|---|
| server, link, peer, owner, trust level, capability (messaging/monitor/drive/orchestrate), machine id, address, revoke | NET |
| principal, rule, grant, profile, audit entry, guest-triggered ask (policy side) | POL |
| request, answer, lifecycle (REQ §4.2), attention, `you`, guest request | REQ |

**Owned elsewhere:** attention across machines, `you` across own links and the 5 s deny → REQ-D21
(replaces old NET-D5) · remote-ask timing → REQ §4.3 · outbound to guests → POL-D15 · guest grant
durations → POL-D7; waiting-ask caps → POL §4.5 · remote principal in MVP → POL (R1) · remote
`when`/`reach` → POL (R7).

## 11. Scope slicing
- **MVP (CON-16):** `own` links (code pairing, own-key rule, direct TCP on LAN/tailnet); `messaging`,
  `monitor` (§4.5) and `drive` (if NET-D18); machine-id addresses with shared names; outbox with TTL
  and dedupe; all link states incl. feature gaps; manual revoke; audit of link events and crossings;
  remote asks read-only; viewer-only laptops.
- **v1:** `orchestrate` on own links (S8); answering remote asks (REQ F6); guest message exchange via
  shares with link caps, S7 tagging and guest-triggered asks; revoke-everywhere and key rotation;
  changed-files summary; the relay question.
- **Vision:** guest "watch this session"; guest `orchestrate` ("systems"); relay/mailbox; guest requests; sandbox machines; remote files;
  linked spaces; phone/web watching; team identity.
- **Out of scope:** sharing subscriptions or credentials; accounts in MVP/v1; remote desktop.
- **Size (estimate):** MVP ≈ the three-process split (a multi-workstream program): a new authenticated
  protocol, pairing and keys, an output relay, addressing and a sidebar area, no new process. v1 adds
  about as much again.

## 12. Assumptions and next steps
- MVP users reach their machines over a network they control.
- Established cryptography only (a PAKE, and a mutually authenticated encrypted channel). It is named
  here only to judge feasibility.
- **Before a plan:**
  - Measure the pinned hc's `machine` support on Linux and on Windows.
  - Measure Kiro's MCP support on Windows (NET-D19).
  - Re-check every "Source" row in §2.

## 13. Decisions Needed

**Locked by the owner (2026-11-14, CON-27 build):** NET-D1 one mechanism, two trust levels · NET-D2 owner key at pairing · NET-D3 direct over LAN/tailnet, no relay · NET-D4 own links: messaging + monitor by default, `drive` and `orchestrate` each one opt-in · NET-D18 `drive` in MVP, opt-in per link · NET-D19 Kiro only after measuring its Windows MCP setup. Guest decisions (NET-D6, D7, D8, D17, D21) belong to CON-17 and stay open.
Format: options → **default** → why.

- **NET-D1 [high] One feature or two?** (a) one mechanism, two trust levels, two slices; (b) two
  features; (c) one feature with a trust switch. → **(a)**: (c) risks silently upgrading a guest.
- **NET-D2 [high] Proving "same owner".** (a) owner key copied at pairing, confirmed on an existing own
  machine; (b) a Conduit/OIDC account; (c) every link trusted by hand. → **(a)**; revisit (b) for teams.
- **NET-D3 [high] MVP transport.** (a) direct TCP to a user-given address, tailnet/SSH documented;
  (b) NAT traversal + relay; (c) hc ssh machines; (d) a hosted relay. → **(a)**; decide (b) in v1.
- **NET-D4 [high] Own-link defaults.** (a) messaging + monitor; `drive` and `orchestrate` one opt-in
  each; (b) all on. → **(a)**.
- **NET-D6 [high] What a guest sees.** (a) shared agents only, as handle + my label; (b) real labels and
  roots. → **(a)**.
- **NET-D7 [high] CON-17 v1 scope.** (a) message exchange only — please confirm it still serves the
  ticket ("tokens" isn't allowed; "systems" = guest orchestrate is vision); (b) also "watch one
  session". → **(a)**.
- **NET-D8 [high] Subscriptions.** Conduit guarantees no credential or token crosses a link and shows a
  terms note on guest links; it can't tell delegated work from knowledge exchange, so the grey case is
  the users' responsibility. (a) as stated; (b) also block "task-like" messages (unenforceable). → **(a)**.
- **NET-D17 [high] `orchestrate` on own links in v1.** (a) yes, opt-in, ask per tool until granted;
  (b) vision. → **(a)**: it's the user's workflow.
- **NET-D18 [high] `drive` in MVP or v1?** (a) MVP, opt-in per link: it reuses the PtyWriter, needs no
  per-tool policy, and CON-16 asks to "control the agents locally and remotely". Cost: a compromised
  own machine with `drive` on can type into all of mine (§9). (b) v1. → **(a)**.
- **NET-D19 [high] Kiro on Windows in MVP.** (a) a Kiro MCP install target, gated on measuring Kiro's MCP
  support on Windows; (b) generic `agent` with a hand-set entry. → **(a)** ("All of that should work!");
  if the measurement fails, (b) and say so.
- **NET-D21 [high] Guest bootstrap.** (a) unshared targets `refused`; explicit "Share <agent> with
  <peer>"; "ask on ungranted" per-link opt-in; (b) every unshared target asks. → **(a)**: handles are
  guessable.
- **NET-D20 [normal] Grants on `identity-changed`.** (a) suspended (POL §5.1 grant state); re-confirm
  restores, "new peer" deletes; my own key rotation leaves guest grants alone; (b) always deleted. → **(a)**.
- **NET-D11 [normal] Remote agent reads.** (a) own-link `wait_sessions` under monitor (MVP),
  `read_screen` under orchestrate, neither for guests in v1 (R16); (b) humans only. → **(a)**.

**Design defaults (override if you disagree):**
- NET-D9: the peer server relays pane output, so there is one authenticated endpoint per machine.
- NET-D10: read-only viewers never resize; the last typer sets the size.
- NET-D12: same machine, different OS user, works by construction only.
- NET-D13: one Machines group per machine.
- NET-D14: a machine id behind local names, with own servers sharing names. Local names alone break
  once a handle is quoted to a third machine.
- NET-D15: the same project on two machines shows as per-machine groups now; linked spaces are vision.
- NET-D16: phone/web watching is vision.

## Revision log
- v1: draft + fresh reviewer pass (UI module, contract, topology, owner-key theft, S7).
- v2 (lead): "For the user"; `control` → `drive`/`orchestrate` (S8, NET-D17); machine ids (NET-D14);
  same project on two machines, viewer-only, phone/web; §4.5 monitor; size estimate.
- v3 (cross-spec r1 + rulings): A1/R1, A4/R4 → POL/REQ-D21 (remote asks read-only in MVP); A8/R8 link
  caps only; A9/R9 POL picker words; A11/A12/R10, A14/R12 pointers; A15 "revoke", prefixed ids; A16
  "Owned elsewhere"; A17/R14 NET-D18–D21; A18 refused by default; A19/R15 NET-D7/D8 reworded; A21
  feature gaps; B1/R16 `wait_sessions`; B2–B4 limit wording, MVP limits, no rotation, 5 s nuance; B5 cuts.
- v4 (cross-spec r2): N3/R21 all 25 tools mapped + capability-off floor; N5/R22 manual revoke MVP (unchanged); N6/R23 merged presence flow, read-only MVP; N7/R24 share 24 h + Renew; N12 stable remote session id, guest orchestrate in vision; NET-D18 cost clause; status set.
- v5 (CON-27 build): §6.5 as-built security; §6.6 deviations (10 MiB remote attachments; monitor lists every local session).
