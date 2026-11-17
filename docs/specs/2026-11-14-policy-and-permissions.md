---
status: building (CON-24) — MVP decisions locked
date: 2026-11-14
ticket: CON-18 (carries CON-17's policy demand and CON-16's remote machines)
---

# Feature Spec: Policy and permissions — control and visibility

**Tier:** FULL   **Feature type:** UI on a non-UI decision model. This is a **shape** spec: no plan, file
map or code.

**Ticket (verbatim):** "The policy and permission system for Conduit is becoming a critical piece of
work. I believe it needs to be reworked to allow us to have better and greater control and more
visibility over what is happening." It also carries CON-17's "a very strong policy system" and
CON-16's machines acting as one.

**Siblings:**
- NET = [conduit-network](2026-11-14-conduit-network.md): links, peers, revoke, link caps.
- REQ = [user-input-requests](archive/2026-11-14-user-input-requests.md): the request object, its lifecycle,
  the queue and History.

Wireframes: `docs/design-handoff/2026-11-14-shaping/CON-18/`. CLI research with URLs:
`docs/runs/2026-11-14-shaping/cli-permissions.md`.

## For the user (read this first)

**The shape.**
- You give each session, agent kind or own machine a **profile** (Observer, Worker = today, Lead;
  Guest for other people in v1) instead of setting 19+ tools by hand, plus exceptions only where
  needed.
- When an agent needs more, you get a request. Answering wider than "once" creates a **grant** that
  is listed, expires and can be revoked.
- **Activity** records every decision Conduit makes (chatty reads are counted, not listed). A labelled
  lane shows what Claude and Codex agents did natively.

**Before → after:** claude-3 and claude-6 each carry 19 hand-set overrides today (measured). After,
each is one choice, "Lead". Migrated leads show "Lead +1" so nothing changes silently. In v1 the
choice can also set the CLI's own launch posture.

**What Conduit can't control:** shell commands and file edits are approved by each agent's own CLI.
Conduit can set that posture at launch and show what Claude and Codex did. It could decide native
approvals only for Claude Code (not proposed yet) or OpenCode run as a server.

**Top decisions:**
- POL-D4: a Lead acts off screen (yes).
- POL-D13: profiles set the CLI's posture (yes, v1).
- POL-D14: native activity lane in MVP (yes).
- POL-D15: messages to guests ask first (yes).
- POL-D7: grants decay after 7 days unused (yes).

**Depends on:** REQ (request card, lifecycle); NET (own-link peers and manual revoke in MVP, guests in
v1).

## 1. Problem frame

- **Job:** decide what my agents and other people's agents may make Conduit do without per-tool
  tuning, and see afterwards what was asked, decided (by what) and done.
- **Actors:** the human (sets policy, answers, may drive a remote pane); a session's agent (Claude,
  Codex, Cursor, OpenCode, Kiro, other); a peer server (`own`/`guest`) and its sessions; each CLI's
  own permission system (a second gate Conduit doesn't own).
- **Success:**
  1. trusting a lead is one choice;
  2. one panel per session or peer answers "what may it do, and why";
  3. every Conduit-decided action has an Activity record;
  4. every decision names one reason;
  5. a guest can do nothing until granted, and grants expire and can be revoked;
  6. the UI states what Conduit can't control.
- **Non-goals:** enforcing inside CLIs; OS sandboxing; time-of-day rules; message DLP; team admin.

## 2. What exists today, and what's wrong with it

### 2.1 Today (read from source unless marked measured)

| Claim | Source |
|---|---|
| 19 tools in groups of 5/8/6. Fields: access off/ask/on, when viewing/always, reach self/opened/window/any, move yes/no | `src/conduit-mcp/tool-policy.ts:6-187` |
| Fields resolve one by one: session > CLI kind > global, plus a master switch. The kind is the handle prefix, self-asserted in a plain shell. Kiro falls under `agent` | `tool-policy.ts:64-75`; archived `2026-10-30-conduit-mcp-tool-policy` §2.1 |
| Defaults: messaging and `list_agents` on; editor and views on while viewing; `read_screen` on (opened); `focus_session` on (window); `open_session`, `send_input` (opened), `close_session` (window) and `attach_folder` (self) ask; `open_terminal` off | `tool-policy.ts:121-187` |
| The card offers Approve / Deny / "Always for this session" (a permanent session override). It appears only in the caller's window | `call-flow.ts:307`; archived spec §3.4 |
| An ask lives as long as the CLI's MCP call (25 / 50 / 120 / 170 s). There are at most 3 waiting asks per caller, and an unanswered ask keeps its rate token | `call-flow.ts:28-44, 289` |
| Launch wiring pre-approves Conduit's tools for **Claude** (`--allowedTools`) and **Codex** (`approval_mode='auto'`) only. Cursor gets a config rule only if its file exists, OpenCode allows by default, and Kiro has no install. **Cursor and Kiro may double-prompt** | `src/mcp-launch.ts:56-103`; archived `2026-10-31-conduit-mcp-single-gate` §2–3 |
| Conduit injects Claude hooks via `--settings` (Stop, StopFailure, UserPromptSubmit, Notification), but not PreToolUse or PermissionRequest | `src/claude-hook-settings.ts:13-35` |
| Conduit binds each Codex session to its rollout file and tails it (CON-11) | `server/domain/codex-rollout-watch.ts` |
| **Measured:** nothing records tool calls or ask outcomes. Today's log has 381 lines and 0 matching ask/approv/denied | `~/.config/conduit/logs/conduit-20261114.log` |
| **Measured:** the global layer equals the defaults and the CLI layer is empty. 2 of 13 sessions (claude-3, claude-6, both leads) set `access:on` on all 19 tools, with when/reach left at defaults | `~/.config/conduit/settings.json`, `sessions.json` |
| **Measured:** claude-3's run (00:32–05:35) made 93 Conduit calls: 15 `open_session` (about 10 within 05:21–22) and 7 `read_screen`, with 0 `caller_not_visible`. Its off-screen work was messaging | its transcript JSONL, parsed |
| **Measured:** Codex rollouts (10 files, client not identified) carry per-turn approval and sandbox settings, plus `CommandExecution` (command, cwd, exit code, duration), `FileChange` (paths) and `McpToolCall` | `~/.codex/sessions/2026/11/*/rollout-*.jsonl`, parsed |

### 2.2 What's wrong

- **Control:**
  - the unit is too small (one intent takes 19 overrides);
  - four jargon fields;
  - no *where* (folder or space);
  - no *who* beyond kind and session;
  - "Always for this session" is a silent, permanent consent leak;
  - asks die in 25–170 s, unrecorded;
  - messaging can't be scoped (fatal across users).
- **Visibility:** no history; no "what can it do?" answer; native actions are invisible.

### 2.3 The CLIs' own permission systems

| CLI | Pre-allow Conduit tools | See / decide native approvals | Action log (observed lane) | Live posture | Posture at launch |
|---|---|---|---|---|---|
| Claude Code | Yes (wired) | Yes, via PreToolUse/PermissionRequest hooks ([hooks](https://code.claude.com/docs/en/hooks)) | Yes: PostToolUse hook / transcript | At launch. Hook field UNVERIFIED | Yes (`--permission-mode`) |
| Codex | Yes (wired) | Partial: injected hooks need user trust; `app-server` replaces the TUI | **Yes, measured** (rollout; vendor: "not a stable interface") | **Yes, per turn (measured)** | Yes (`-s`, `-a`) |
| Cursor | Partial (config file; forum reports matching bugs) | UNVERIFIED (hooks reported not firing on Linux) | No reliable source | No | Partial (`--sandbox`) |
| OpenCode | Partial (default allow) | Only as `opencode serve` | Only as `serve` | No | Config only |
| Kiro | Partial (`--trust-tools` headless only) | UNVERIFIED | No reliable source | No | Partial (`sandbox.json`) |

**What follows:**
- Conduit's own policy is the only layer that behaves the same in all five CLIs, so CON-18 centres on
  it.
- For native actions Conduit can **set** the posture (Claude, Codex), **observe** what was done
  (Claude, Codex) and **decide** approvals (Claude via hooks; OpenCode only when run as a server).
- A CLI's own deny or managed policy always beats Conduit.

## 3. Shape options

| | A: Polish in place | B: Rules only | C: Profiles only | D (add-on): profiles also set native posture |
|---|---|---|---|---|
| Makes possible | Activity, cheapest | Everything, including peers and folders | The measured intent in one click | "Make it a Lead" covers both gates where the CLI allows |
| Rules out | Peers, people, folders; CON-16/17 need a second model | Nothing, but it's a firewall editor | Exceptions, and per-recipient guest rules | Hand-started CLIs. Takes effect at relaunch. Can drift mid-session |
| Cost / risk | Low / no "who" for CON-17 | Medium-high / unused precision (measured CLI layer: empty) | Low-medium / users hit the wall | Low-medium / a profile that loosens a CLI is dangerous, so built-ins never bypass |

**Recommended:** C's surface on B's engine (profiles with exceptions, grants from consent), plus
Activity in MVP, plus D in v1.

## 4. Recommended shape

### 4.1 Shared names (owners per rulings P2)

| Name | Owner | Meaning here |
|---|---|---|
| link, peer, machine id, trust own/guest, capability (messaging/monitor/drive/orchestrate), revoke | NET | a peer is addressed by its machine id. A remote session is the principal `handle@machine-id` |
| request, kinds (`permission`, `attend`), lifecycle, History | REQ | a policy ask is a `permission` request. Its lifecycle is REQ §4.2, including `withdrawnBy: conduit` |
| guest-triggered ask (v1, grantable) / guest request (vision, never grantable) | REQ/NET | used verbatim |
| principal, agent kind, action, target, scope, decision (allow/ask/deny), condition, rule, profile, exception, grant, audit entry / Activity | POL | below |

- **principal:** the human (local, or `you@machine` driving over an own link) · a session (bound to
  the session id) · a peer.
- **Agent kind** is an attribute, not a principal.
- **Scope** is matched against the **target**: anywhere · a space (a Conduit project) · a folder
  (real path) · sessions it opened · its window · named targets. An action with no target matches
  the caller's home folder.
- **Conditions:** "only while on screen" (`when`) · "may switch your view" (`move`) · v1 "soon after
  a guest message" (NET S7).
- **Exception:** a rule on one assignment that overrides its profile for one action.
- **Grant:** a rule created by consent. States: active · expiring · suspended (NET-D20) · expired ·
  revoked.

### 4.2 Profiles

A = allow, ? = ask, – = deny. Reach and conditions are today's unless shown.

| Tool | Observer | Worker (= today) | Lead | Guest (v1) |
|---|---|---|---|---|
| list_sessions, read_inbox, read_attachment | A | A | A | A, filtered to agents shared with that peer (NET) |
| send_message (local or own recipient) | A | A | A | A to shared agents. A guest-triggered ask only if the link opts in (NET-D21) |
| **send_message to a guest recipient** (POL-D15: replies in threads the guest started pass under its Share) | ? | ? | ? | n/a |
| wait_sessions | A | A | A | – (floor) |
| list_agents | A | A | A | – |
| open_session | – | ? | **A** | – (floor) |
| open_terminal | – | – | **?** (POL-D3) | – (floor) |
| read_screen (opened) | – | A | A | – (floor) |
| send_input (opened) | – | ? | **A** | – (floor) |
| close_session (window) | – | ? | **A** | – (floor) |
| focus_session (window) | – | A | A | – (floor) |
| attach_folder (self) | – | ? | **A** | – (floor) |
| Editor & views (6 tools) | – | A | A | – (floor) |
| **Requests:** request_input | A | A | A | – (floor; guest request = vision) |
| wait_request, withdraw_request, list_requests (own requests) | A | A | A | – (floor) |
| answer_request, escalate_request (only an ancestor in the requester's `opened_by` chain, floor (e)) | – | A | A | – (floor) |

- **Lead = Worker + the bold cells, and it may act off screen** (POL-D4).
- **Native posture (option D, v1, POL-D13).** It is applied at (re)launch. "–" means Conduit passes
  nothing.

  | | Observer | Worker | Lead |
  |---|---|---|---|
  | Claude | `--permission-mode plan` | – | `--permission-mode acceptEdits` |
  | Codex | `-s read-only -a on-request` | – | `-s workspace-write -a on-request` |

  Cursor, OpenCode and Kiro get none. A built-in profile never sets bypass, yolo or full access.
- **Ask cost:** under Worker, claude-3's measured run would have raised 15 asks in 5 h, about 10 of
  them within 2 minutes, each expiring after 120 s. Under Lead it raises 0. That burst is why users
  hand-set all-on.
- **Assignment points:** session · peer (an `own` peer in MVP) · agent kind · default.
  - Kind assignments and kind grants apply only to sessions Conduit launched (POL-D5).
  - A spawned session never inherits its opener's profile.
- **Profile lifecycle:**
  - Built-ins are read-only; "Duplicate" makes an editable copy.
  - An edit applies to future calls, and waiting asks are re-decided at answer time (§5.2).
  - Deleting a profile in use requires choosing a replacement.
- **Migration** (exact):
  - Each v0.64 override becomes Worker plus one exception per changed field.
  - An all-`on` override becomes **Lead +1**: "only while on screen" (an assignment-wide condition,
    counted as one exception). POL-D3 = allow makes the former "open_terminal: allow" exception a no-op.
    A one-time note offers to remove the second.
  - The CLI layer becomes kind assignments.
  - off → deny, on → allow.
  - Native posture is never applied by migration.
  - "Always for this session" is retired (R5). Its overrides migrate as above.

### 4.3 Precedence (first match wins)

1. **Floors:**
   - (a) master switch off → deny everything;
   - (b) a guest principal never gets drive, any orchestrate tool, `wait_sessions`, `attach_folder`,
     `focus_session`, Editor & views, or any Requests tool (v1);
   - (c) a local session may always `send_message` or `request_input` to "you";
   - (d) **capability off on this link → deny.** A remote principal gets only tools whose capability
     its link enables. The mapping of all 25 tools to capabilities is NET §4.1 (R21);
   - (e) `answer_request` / `escalate_request` only by an ancestor in the requester's `opened_by`
     chain (REQ's max depth applies), never a sibling or descendant (R19).
2. **Explicit denies** (a deny exception; v1 user-made rules with deny). No ask is raised, and no
   ordinary grant passes it. **A profile deny is not an explicit deny:** it is decided at step 4, so
   a grant can pass it — that is the point of grants (a Share passes the Guest profile). Only
   floors and exception denies sit above grants. **One-use override (POL-D16):** made from that deny's own Why panel, it passes once,
   for that principal, action and target. Never for floors or guests.
3. **Grants** matching principal, action, target scope and time (not suspended).
4. **The most specific assignment:** session > peer > agent kind > default. Within it, its exceptions
   beat its profile, and the narrower scope wins. An exact tie goes to the stricter decision.

**Remote principals (R1, R7):**
- `x@machine-id` takes its **peer's assignment**. With none set, an `own` peer defaults to **Worker,
  with every orchestrate tool at ask**.
- **"Only while on screen" never applies to remote callers.** The ask stands in for it.
- `reach: window` becomes `opened` for remote callers. `opened` matches a cross-machine `opened_by`
  (NET S8).

Floors (a)–(e) sit above explicit denies.

**UI sentence:** "Your 'never' rules win, unless you allow one case from its Why panel. Then
anything you granted. Then the session's own setting, its machine's, its agent kind's, and the
default."

Every decision carries one **reason**. An unconditional deny hides the tool from that agent's list.

### 4.4 Ask → request → grant

1. An ask creates a REQ `permission` request. It carries the principal (with a machine badge), the
   action, a summary of the resolved targets, and the why line ("Ask: Worker (default for Codex)").
2. **Answers (MVP, R5):**
   - **Allow once**;
   - **Deny** (+ an optional reason for the agent);
   - **Allow…**, which creates a grant from three choices:

| who | on | for |
|---|---|---|
| **this session** · this agent kind (Conduit-launched only) · this peer | **this target only** · this folder · anywhere | **until this session ends** · 1 h · **24 h** · until revoked |

   The defaults in bold are preselected by principal type. Local: this session · this target · until
   session ends. Guest: this peer · this target · 24 h.
   - **For outbound to a guest (POL-D15)**, *who* is my session, and *on* reads "this guest session ·
     this peer". 24 h is preselected whenever the target is a guest (N4).
3. **A late answer never runs.** After the call's budget, "Allow next time" creates a grant and
   sends a retry notice. Remote timing is REQ §4.3 (R10).
4. The answer is `{outcome, grant?, reason?}`. Only Conduit creates `permission` requests.
5. **Native CLI prompts:** REQ `attend` (observed). Deciding them depends on POL-D2 (R11).

### 4.5 Remote principals

- **The receiver decides inbound. The sender decides outbound.**
- **Outbound to a guest (POL-D15, R3):**
  - `send_message` whose recipient is a guest principal is its own action, at ask under every
    built-in.
  - Grantable per (my session × guest peer).
  - The ask shows the recipient and the message length, plus a "show message" disclosure for me.
- **Own link (MVP):** messaging and monitor (NET). A remote own session sends and lists under its
  peer's assignment. Remote `wait_sessions` is a monitor read (R16).
  - Orchestrate (v1) follows §4.3's remote rules.
  - Drive is my own action from another GUI, audited as "you, from <machine>".
- **Guest link (v1):**
  - An ungranted target is refused, not asked (NET-D21).
  - "Share <agent> with <peer>" on the link page creates a grant for that peer. It lasts 24 h by
    default (POL-D7) and shows on the agent row and the link page with "Renew" (R24).
  - **Under the POL-D15 default, a Share also covers my agent's replies to that guest inside threads
    the guest started** (R20). Starting a new thread to the guest, or adding attachments, still asks.
  - Guest-triggered asks happen only where the link opts in.
  - Grants default to 24 h and end at revoke. They are suspended on `identity-changed` (NET-D20).
- **Waiting-ask caps (POL owns, R8):** local caller 3 (today) · own remote session 3 · guest session 1
  · guest peer total 5. Link rate and daily caps are NET §5.
- Activity stays on the deciding server and is never sent to the peer.

### 4.6 Activity

- **Rows:** time (UTC, shown local) · principal (+ machine) · agent kind · action · target · summary ·
  decision · decided by · outcome · duration.
- **Counts per session per hour** for `list_sessions`, `list_agents`, `wait_sessions` and
  `read_inbox`, plus a row for every denied one.
- **Privacy:**
  - No message bodies, typed text or file contents. Lengths only.
  - Raw arguments only for asks, for 24 h, and never exported.
- **Observed lane (POL-D14, MVP):** Claude (hook) and Codex (rollout) native commands, file changes
  and MCP calls, labelled "observed: decided by <CLI>, not Conduit".
  - Commands are shown; output is never shown.
  - If a feed breaks it shows "Feed unavailable", never wrong rows.
  - Other CLIs show "No activity feed".
- **Activity and History (POL-D17, answers the former REQ-D14):**
  - Activity is the record of *decided actions*. REQ's History is the record of *requests*.
  - An agent's `request_input` call is one Activity row ("claude-3 raised request r_12") linked to
    its History entry. The request's content and answer stay in History only.
  - One retention for both: 30 days / 50 MB, human only, never readable through MCP (POL-D8).
- **Views:** global (filters: session, kind, machine, decision, action group, time) · per session ·
  per link (v1).
- **Row actions:** Why · Add exception · Allow this once (deny rows, POL-D16) · jump to the session or
  request.
- **Store failure:** local principals proceed with a warning and a gap marker; guest principals are
  refused (POL-D6).

### 4.7 Surfaces

| Surface | Contents |
|---|---|
| Settings → Permissions | master switch; default and per-kind profiles + exceptions; Profiles; Grants (age, last used, revoke); Activity |
| Session → Permissions… (a dialog, owner 2026-11-17) | effective profile + source; exceptions; grants; "Agent's own permissions" (posture at launch, live for Codex, "unknown" if not launched by Conduit); Activity |
| Permission request body (in REQ's card) | why line · summary · raw args · Allow once · Deny (+ reason) · Allow… (who × on × for) |
| Activity | timeline · filters · Why drawer |
| Machine page → Permissions | own (MVP): the peer's profile + exceptions + Activity. v1: capabilities, guest grants, Share |
| Session badge | non-default profile ("Lead +1"); machine badge for remote |

## 5. Behaviour and flows

- **F1, lead:** Permissions… → Lead. The confirm names Conduit's new allows **and**, from v1, the
  native posture ("Relaunch to start Claude in accept-edits"). Helpers open without cards; Activity
  says "allowed by Lead".
- **F2, away:** Worker codex-2's `close_session` ask expires. Later, "Allow next time" → this session ·
  this target · 1 h. The retry matches the grant (step 3 beats the profile at step 4).
- **F3, guest (v1):** `claude-2@alex` messages `claude-3` and is refused (not shared). On alex's link
  page: "Share claude-3 with alex" (24 h) → a grant. Messages to claude-3 now pass as guest-badged
  rows, and claude-3's replies in alex's threads pass too (R20). Other targets stay refused.
- **F4, outbound to a guest (v1):** my codex-2 starts a new thread to `claude-2@alex` → ask ("codex-2 →
  alex, 812 chars"). "Allow… this session · on this peer · 24 h" → later sends pass.
- **F5, remote lead (S8, v1):** `claude-3@linux-box` calls `open_session` on win-box. It isn't refused for
  being off screen: the peer default makes it an ask. "Allow… this session · anywhere · until
  revoked" → later opens pass.
- **F6, why:** a deny row → Why → "Edit exception" or "Allow this once".

### 5.1 States

- **Grant:** active → expiring (< 10 min) → expired | revoked. It can be suspended (identity
  changed, NET-D20) → active | deleted.
  - Grants bind to the session id or machine id, never to a handle.
  - **Decay (POL-D7, R18):** a grant with "until this session ends" also expires after **7 days
    unused**. The Grants list shows age and last use.
- **Request:** REQ §4.2 (R12).

### 5.2 Edge cases

| Condition | Behaviour |
|---|---|
| Policy changes while an ask waits (R18) | Re-decided when the human answers. A deny that appeared since withdraws the request with the reason (REQ `withdrawnBy: conduit`). A change to allow **does not auto-run**; the human still answers |
| Link drops mid-call | REQ §4.3 (R10) |
| A grant names a deleted session | Expires |
| A grant or session vanishes while its panel is open; saving fails | The row shows its new state in place; a failed save reverts the control, with an inline error |
| An agent asks to change policy | There's no such tool |
| A CLI's deny or managed policy | Beats Conduit, and is noted when known |

## 6. Data contract (feature level)

- **Input:** principal (with launch-proven kind) · action · resolved targets · on-screen state ·
  time.
- **Output:** `{decision, reason}`. A guest gets "not allowed" with no reason (NET §4.6).
- **Invariants:** exactly one reason per decision; a late answer never executes; no inheritance by
  spawning; floors are absolute.

| Data | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Profiles, exceptions, assignments | human; migration | engine, badge, tool lists | Yes |
| Grants | permission answers (REQ renders), Share (NET page) | engine, Grants list | Yes |
| Decision + reason | engine | call result, request why line, Activity | Yes |
| Peer id, trust, capabilities, revoke, identity-changed | NET | engine, grant state | No (sibling, agreed) |
| Native posture | profile → launch args | CLI, own-permissions box | Yes (Conduit launches only) |
| Observed native actions | Claude hook; Codex rollout (not ours) | observed lane | **Producer not ours**: fail visibly |

## 7. Defaults

| Item | Default | Configurable |
|---|---|---|
| Profile | Worker (= today) | default / kind / own peer / session |
| Picker | local: this session · target · session end. Guest: peer · target · 24 h | per answer |
| Grant idle decay | 7 days unused | no |
| Expiring warning / expired kept | 10 min / 24 h greyed | no |
| Activity | 30 days / 50 MB; raw ask args 24 h | v1 |

## 8. Possible / not possible / unknown

| Item | Verdict | Source |
|---|---|---|
| Decide and record every Conduit call, local and remote | Possible | §2.1 |
| Keep an ask alive past the CLI's MCP timeout | **Not possible**; "Allow next time" instead | `call-flow.ts:28-41` |
| Set native posture from a profile | Claude and Codex yes; others partial or no | §2.3 |
| Observed native lane | Claude and Codex yes; Cursor and Kiro no | §2.1, §2.3 |
| See live posture drift | Codex yes (measured); Claude UNVERIFIED | §2.1 |
| Decide native approvals | Claude via hooks; OpenCode as server; others not without replacing the TUI | §2.3 |
| One gate for Conduit tools | Claude and Codex yes. Cursor and Kiro may double-prompt | §2.1 |
| Override a CLI's deny or managed policy | **Not possible**, and not wanted | single-gate §3 |
| Prove a shell's agent kind | **Not possible** | archived spec §2.1 |
| Control what a guest does with what it received | **Not possible** | inherent |

## 9. Gaps and trade-offs

- **The second gate stays:** CON-18 sets and shows it, but doesn't own it.
- **Layered precedence can surprise**, mitigated by one sentence and one reason per decision.
- **Counts lose per-call detail** for chatty reads.
- **Codex's rollout format** can change under us.
- **Unsolved:** argument/URL allowlists and negated scopes; policy sync between own servers
  (POL-D10); native decisions beyond Claude.

## 10. Scope slicing

- **MVP:**
  - engine, floors, migration;
  - Observer / Worker / Lead and copies;
  - assignments: default / kind / session / own peer;
  - remote own principals for messaging and monitor (R1);
  - folder and space scopes;
  - picker and grants (R5), "Allow next time", Grants list with decay;
  - Activity with the observed lane (POL-D14);
  - badge and "own permissions".
  - revoke handling: a manual revoke (NET MVP) deletes that peer's grants and withdraws its requests
    via REQ (R22).
- **v1:**
  - Guest profile, guest caps, Share, outbound-to-guest asks (POL-D15);
  - remote orchestrate rules (S8);
  - native posture (POL-D13);
  - the "after a guest message" condition;
  - full rules view, export;
  - POL-D2 (c) if chosen.
- **Vision:** guest request; policy sync; argument patterns.
- **Out of scope:** OS sandboxing, team admin, DLP.

## 11. Acceptance criteria

```gherkin
Feature: Policy and permissions

  Scenario: Upgrade keeps behaviour
    Given a v0.64 override with access "on" for all 19 tools
    When Conduit starts after the upgrade
    Then the session shows "Lead +1" (only while on screen)
    And every tool resolves as before and no native launch flag changes

  Scenario: A lead acts off screen
    Given "claude-3" is a Lead with no exceptions and another session is on screen
    When claude-3 opens a session with focus false
    Then it opens without a request and Activity shows "allowed by Lead (session)"
    And the new session's profile is the default

  Scenario: A grant beats the profile; a late answer never runs
    Given Worker "codex-2" asks to close "claude-4" and nobody answers in time
    Then the call returns approval_timeout and "claude-4" is still open
    When the human picks "Allow next time" for this session, this target, 1 hour
    And codex-2 retries
    Then "claude-4" closes and Activity shows "allowed by grant"

  Scenario: One-use override of an explicit deny
    Given an exception "close_session: deny" on codex-4 refused a close of "claude-5"
    When the human picks "Allow this once" in that row's Why panel
    And codex-4 retries
    Then claude-5 closes, and a second retry on another target is refused

  Scenario: Remote own lead is asked, not refused (S8)
    Given an own link with orchestrate enabled and no peer assignment
    When "claude-3@linux-box" calls open_session on win-box while not on screen there
    Then a permission request is raised instead of "caller_not_visible"
    When the human picks "Allow… this session · anywhere · until revoked"
    Then the next open_session from claude-3@linux-box runs without a request

  Scenario: Outbound to a guest asks (v1)
    Given "claude-2@alex" is a guest principal
    When Worker "codex-2" sends it a message
    Then a permission request names "codex-2 → alex" and the message length

  Scenario: Codex native actions are observed (MVP)
    Given Conduit launched "codex-2"
    When codex-2 runs a command and edits a file
    Then Activity shows two "observed" rows with the command and the path, and no output or contents

  Scenario: Revoke ends a peer's grants (MVP, own peer)
    Given own peer "win-box" holds a grant "this peer · anywhere · until revoked"
    When the link to win-box is revoked
    Then the grant shows "revoked" and win-box's open requests are withdrawn by Conduit

  # REQ v1 (REQ-D18): answer_request / escalate_request and floor (e) are not built in the CON-24 MVP.
  Scenario: Escalation stays on the opener chain
    Given claude-3 opened codex-2 and codex-2 opened codex-5
    When codex-5's request is escalated to claude-3
    Then claude-3 may answer it, and codex-2's sibling session may not
```

- While the audit store is unwritable, the host shall refuse guest-principal actions.
- Activity shall never contain a message body or typed input.

## 12. UI module (tables; designer-CON-18 details it)

| Component | States |
|---|---|
| Permissions panel | default · customised · remote · not launched by Conduit · saving · save failed |
| Grants | first run · active · expiring · suspended · recently expired · revoke (inline Undo 5 s) |
| Activity | first run · filtered-empty · loading · many · gap marker · feed unavailable |
| Request body | live · expired ("Allow next time") · withdrawn |
| Profile change | confirm lists the new Conduit allows and, from v1, the native posture + relaunch |

| Component | Keyboard | ARIA |
|---|---|---|
| Profile picker | arrows | `radiogroup` "Profile for <handle>" |
| Allow… picker | Enter/Space opens each select | labelled selects, defaults announced |
| Answer buttons | never auto-focused | per REQ |
| Activity | arrows; Enter opens Why; Esc returns to the row | `grid` |
| Revoke | Enter; focus moves to the next row | `button` "Revoke grant <n>" |

| Concern | Rule |
|---|---|
| Accessibility | Decisions are never shown by colour alone (text + icon); forced-colors; polite announcements for expiring grants and gaps; badge label "profile Lead, 2 exceptions" |
| i18n | ICU plurals; templated why line; handles and tool names literal; local and relative times; 40% growth; RTL; locale collation in filters |
| Tokens | existing only |

## 13. Relation to other tickets

- **H3 (policy is the shared layer): confirm, amended.** Inbound is the receiver's; outbound is the
  sender's (POL-D15). Own trust never bypasses rules.
- **H4 (ask → request): confirm.** A `permission` request. CON-18 owns the body, picker and grant.
  A late answer never runs.
- **H5 (visibility = audit): confirm, amended.** Activity covers decisions, plus a labelled observed
  lane. It must not imply completeness.
- **H2:** NET's four capabilities. Guests never get drive and get no orchestrate in v1.
- **H1:** a link over a local transport, so nothing extra. **H6:** untouched.
- **Owned elsewhere** (cited, not decided here):
  - REQ: REQ-D21 (attention across machines; the 5 s `ui_unavailable` deny, removed by CON-21), REQ §4.3 (remote-ask timing),
    REQ §4.2 (lifecycle).
  - NET: NET-D4 (own-link drive/orchestrate opt-in), NET-D20 (identity-changed suspends grants),
    NET-D21 (guest bootstrap), link caps (NET §5), NET-D19 (Kiro on Windows), revoke-everywhere and key rotation (v1).

## 14. Assumptions

- A1: "Space" = a Conduit project.
- A2: Conduit-launched kinds are proven; shell kinds are not.
- A3: For Claude, mid-session posture is ASSUMED invisible until the hook field is measured. For Codex
  it's visible per turn (measured). Mirrored in POL-D12.

## 15. Decisions Needed

**Locked by the owner (2026-11-14, CON-24 build):** POL-D1 profiles over rules + Activity · POL-D2 not yet (observed lane only) · **POL-D3 allow**: a Lead opens other sessions *and* plain terminals without asking ("if it has to ask every time, it's not a lead anymore"); a plain terminal runs commands outside any CLI's own approval, which is the accepted cost · POL-D4 yes, a Lead acts off screen · POL-D5, POL-D6, POL-D7 at their defaults · POL-D14 observed lane in MVP for Claude and Codex. POL-D13 and POL-D15 are v1 and stay open. **CON-24 plan rulings (lead, 2026-11-14):** Lead +1 replaces Lead +2 (POL-D3 made the open_terminal exception a no-op); floor (e) and `answer_request`/`escalate_request` move to REQ v1 with escalation; POL-D5 applies to migrated CLI layers, with an Activity note.

- **[high] POL-D1, shape:** **profiles over rules + Activity, D in v1 (default)** / A / B / C.
- **[high] POL-D2, decide native approvals:**
  - **(a) not yet: show and observe only (default).**
  - (b) OpenCode: decide through `opencode serve`. Conduit then runs OpenCode as a server, which
    changes how those sessions launch.
  - (c) Claude via hooks in v1. Puts Conduit in the path of every Claude shell command, so an outage
    blocks the agent or fails open.
  - REQ §6 and F4b follow this choice.
- **[high] POL-D3, Lead's `open_terminal`:** **ask (default)** / allow.
- **[high] POL-D4, Lead off screen:** **yes (default)** / keep "while on screen". Measured:
  claude-3 made no off-screen act calls; its off-screen work was messaging. But Lead is opt-in trust,
  "on screen" is meaningless remotely, and migration stays exact (Lead +1).
- **[high] POL-D5, self-asserted kinds:** **kind assignments and grants apply only to sessions
  Conduit launched (default)** / anyone claiming the kind.
- **[high] POL-D6, audit store failure:** **local fails open with a warning, guests fail closed
  (default)** / all closed / all open.
- **[high] POL-D7, grant duration and decay:** **picker defaults by principal (local: until session
  ends; guest: 24 h), plus expiry after 7 days unused (default)** / a 1 h default / no decay. Decay
  keeps long-lived leads from piling up permanent consent (R18).
- **[normal] POL-D8, Activity access:** **human only (default)** / a lead may read its helpers' Activity.
- **[normal] POL-D9–D12, design defaults (accept as a batch):** D9 allow/ask/deny replace
  on/ask/off · D10 no policy sync between own servers · D11 add a `kiro` kind · D12 label posture
  "at launch" where live posture is invisible.
- **[high] POL-D13, profiles set native posture:** **yes, v1, Claude and Codex, at relaunch, never
  bypass (default)** / no.
- **[high] POL-D14, observed lane timing:** **MVP for Claude and Codex (default)** / v1.
- **[high] POL-D15, outbound to guests (R3):**
  - **(a) ask, except replies inside threads the guest started under a Share (default).** A shared
    agent can answer unattended, but can't start new contact or attach files without you.
  - (b) allow whenever that peer's inbound is granted. Fewer prompts, but a shared agent can then
    send anything to that peer unprompted.
  - (c) deny all outbound. Safest, but sharing becomes one-way and guests never get answers.
- **[normal] POL-D16, one-use override of an explicit deny:** **from its Why panel, once, local only,
  never past a floor (default)** / denies are absolute.
- **[normal] POL-D17, agent requests in Activity (the former REQ-D14):** **one linked Activity row
  per raised request, with content and answer in History only (default)** / full copies in both / no
  Activity row.

## Revision log

Full log: `docs/runs/2026-11-14-shaping/policy-revisions.md`.

- v1: audit, shape, independent review fixes.
- v2: For the user, option D, measured Codex lane, D4 evidence, ask cost.
- v4: cross-spec r2 (N1–N5, N7–N9, N11, N12; R19–R25). Status: shaped.
- v3: cross-spec r1 and rulings (P1–P4, A1/A3/A5–A8/A10/A11/A15–A18, D1–D7, R1/R3/R5–R8/R11/R16/R18),
  plus POL-D17 from REQ. The finding-by-finding mapping is in the full log.
