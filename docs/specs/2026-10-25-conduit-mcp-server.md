---
status: draft
date: 2026-10-25
---

# Feature Spec: Conduit MCP server — sessions message each other

**Tier:** FULL   **Feature type:** UI + host (MCP server, PTY input, persistence)
**One-line request:** "If I open Claude Code, Codex and Cursor in Conduit sessions, I want these agents to
be able to communicate with each other — send a message, pass along a spec, a file, a screenshot —
with priorities, like an inbox, and a notification that goes out to the agent based on priority."
**Mode:** autonomous (user away); decisions taken are in §13.

## 1. Problem frame

- **Job:** let agent CLIs already running in Conduit sessions, and the human, address each other,
  hand over artifacts, and get each other's attention — so work can be split across cheaper agents
  without the human copy-pasting between terminals.
- **Actors:** *agent sessions* (an MCP-capable CLI in a Conduit PTY); *the human* (participant `you`
  and owner of every permission); *the host* (broker; sole source of identity and presence).
- **Success outcomes:**
  - An agent in session A sends B a message with a file attached; B, idle at its prompt, is notified
    with nobody touching anything, and reads the message and the file's content.
  - The human sees every message, can send to any session, and receives messages addressed to `you`.
  - The same tools and delivery work for every MCP-capable CLI; per-CLI code is limited to launch wiring
    and a declared list of blocking-prompt patterns.
- **Substrate, not flow.** Any topology (hub, sub-delegation, mesh) is a call pattern on these
  primitives. Who delegates to whom, handoff templates, approval routing, budgets and escalation are a
  separate later layer (skills / policy).
- **Non-goals:** orchestration; cost tracking; headless/ACP agents; native CLI inboxes (`codex queue`,
  Claude cross-session messaging — declined by the user for now); cross-machine delivery; agents outside
  Conduit sessions. **Cursor and OpenCode are v1** (no launch adapter yet; `cursor-agent` and `opencode`
  aren't installed here).

## 2. Behavior & states

**Primary flow.**
1. Conduit launches an agent session with a per-session token and the `conduit` MCP server registered
   (§3.1). The session has a stable **handle** (`claude-1`, `codex-2`) shown on its card.
2. Agent A calls `list_sessions`, then `send_message(to: ["codex-2"], priority: "normal", kind:
   "request", subject, body, attachments: [{path: "docs/spec.md"}])`.
3. The host validates, snapshots the attachment, stores the message, returns per-recipient status.
4. B is busy → the notice waits. When B's notice gate opens, the host types **one content-free notice**
   into B's PTY.
5. B calls `read_inbox` → the message with provenance framing; `read_attachment` → the snapshot.
   B replies with `send_message(thread_id: …)`.
6. The human sees the thread in the Messages tab throughout.

**Message lifecycle (per recipient):** `queued` → `noticed` → `read`. Side states: `refused` (at send:
unknown/deleted handle, self, limits) · `undelivered` (recipient session deleted while unread — kept,
visible to the human) · `expired` (retention removed it unread — tombstone visible to the human).
A reply in the thread is the acknowledgement; there is no separate ack in MVP.

**Re-notice:** a `noticed` message still unread after the recipient's next busy→idle cycle is
re-noticed once; still unread after that → the human gets an attention signal and no more notices are
sent for it. After a host restart, unread messages re-arm a notice.

**Notice gate (per recipient session)** — open only when **all** hold:

| Condition | Why |
|---|---|
| Session running, PTY spawned ≥ `PTY_SETTLE_MS` ago, and its MCP connection is **live** | a plain shell (never connects) is never typed into; no notice before the CLI is up |
| Presence `idle` for ≥ 3 s | not mid-turn |
| The **bottom rows / cursor region** of the session's host-side screen model match **none** of the CLI's declared blocking-prompt patterns, and do match its declared empty-input pattern | a notice + Enter into a permission prompt would approve it. Matching only the bottom region means an old prompt in scrollback can't count. A CLI with **no declared patterns gets no notices** (pull-only + human attention) |
| No human draft: no renderer input since the human's last Enter / Ctrl+C, other than terminal auto-replies (DA/DSR/focus/mouse reports). Any key counts, including Up-arrow history recall | the notice would append to a half-typed or recalled line and submit it |
| Notices not paused for the session; ≥ 30 s since its last notice | user control; bounded interruption |

`needsAttention` is deliberately **not** a gate input: it clears whenever the session is visible and is
set after every finished run (measured in `src/session-activity.ts`), so it is wrong both ways.

| Priority | Gate open | Gate closed |
|---|---|---|
| `fyi` | no notice; counted into the next notice; or pulled | same |
| `normal` | notice now | held until it opens |
| `urgent` | notice now | held **and** the human gets one attention signal "urgent message waiting for codex-2" |

**Notice text** (fixed, ASCII, no digits, no peer text):
`[conduit] New messages for you (urgent). Use the conduit read_inbox tool.` — `(urgent)` only when an
urgent one is pending. It is written the way timed messages are: the text, then `SUBMIT_GAP_MS`, then
the Enter waits for a positive echo, polling every 50 ms (`ECHO_POLL_MS`) up to 2 s (`ECHO_WAIT_MS`);
only a `no-echo` verdict keeps it waiting, any other closure withholds at once. Codex 0.164 renders typed
text 220-350 ms after the write, so for Codex the unsent-notice window is up to ~2.1 s, and a human Enter
inside it yields an `unsent-notice` attention item (safe, possibly noisy). The `\r` is bound to the PTY generation, through one serialized writer per session shared with timed messages.
**The whole gate is re-checked before the `\r`.** If it closed during the gap, no `\r` is sent: the text
stays in the input and the human gets one attention signal ("a notice was left unsent in codex-2").

**Screen model:** every session that has messaging gets a host-side `@xterm/headless` terminal (already
a dependency). It is fed from the PTY's output, resized with the PTY, reset on spawn and disposed with
the session. Today's host keeps only a 4 KB raw tail (`src/pty-host.ts:72`), which can't rebuild a
differentially repainted screen.

**Loop guard:** a thread accepts at most 20 agent messages since the human last posted in it; beyond that
`send_message` returns `thread_limit` and the human sees "thread paused" with **Allow 20 more**.

**Current behavior relied on:**

| Claim | How measured | Status |
|---|---|---|
| Claude 2.1.310 passes the PTY env (incl. `CONDUIT_SESSION_TOKEN`) to a stdio MCP child from `--mcp-config` | probe server logged its env, `claude -p … --mcp-config` (S0, 2026-10-25) | **Measured** |
| Codex 0.157.0 strips that env var from MCP children by default; `-c mcp_servers.<n>.env_vars=['CONDUIT_SESSION_TOKEN']` passes it | same probe via `codex exec -c …` with and without `env_vars` | **Measured** |
| A minimal hand-rolled MCP server (`initialize`, `tools/list`, `tools/call`) is accepted by both CLIs; Claude first tries `server/discover` (2026-07-28) and falls back | probe transcript | **Measured** |
| Claude treats a tool result framed "from session X (an agent, not the user)" as non-user content | probe: haiku declined to act on the peer's request without user confirmation | **Measured** (one run) |
| The installed `claude` and `codex` are native `.exe`, not `.cmd` shims | `ls` of their bin dirs | **Measured** (npm-installed CLIs are `.cmd` — handled in §3.1) |
| `needsAttention` clears on visibility and arms on run-end | `src/session-activity.ts:156-269` read | ASSUMED (inspection) |
| `busy`/`idle` is an output-activity heuristic | `electron/main.ts:1299,1529,1752` read | ASSUMED |
| Claude: a notice typed at the idle prompt, then `\r` as a separate write, becomes a turn that calls `read_inbox` | node-pty + `@xterm/headless` driver, interactive `claude --mcp-config` (S0) | **Measured** |
| Claude's blocking prompts (folder trust, tool permission) render an `Esc to cancel` footer and a `❯` menu; its idle prompt has neither. The trust dialog's default is "No, exit" — an Enter there quits | screens captured by the same driver (`--permission-mode default`) | **Measured** |
| A driver that doesn't answer terminal queries (DA/DSR) leaves Claude's dialogs unresponsive | first driver run vs. the second with `term.onData → pty.write` | **Measured** (test-harness note; Conduit's xterm answers them) |
| Codex (0.164.0, now logged in) and Cursor `agent` (2026.10.22, a `.cmd` shim; MCP config only from `.cursor/mcp.json` / `~/.cursor/mcp.json`, servers need approval) — prompt screens and notice-as-turn | not yet measured | **ASSUMED** → §13 |

## 3. Data / interface contract

### 3.1 Wiring and identity
- The host listens on a local endpoint scoped to its userData (Windows named pipe
  `\\.\pipe\conduit-mcp-<hash(userData)>`; a socket path in userData elsewhere), so a dev build and the
  installed app never collide. Unit tests inject the endpoint (CI is ubuntu).
- A shim script shipped in app resources is the stdio MCP server each CLI spawns. It is a **byte relay**
  (stdio ↔ endpoint) that first sends the session token; all MCP handling lives in the host. Run with
  Conduit's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node is needed.
- **Per-launch registration, never editing the user's CLI config:**
  - `claude`: `--mcp-config <generated json>`; the file lives in userData, is written per session, holds
    no token (the token reaches the child through the PTY env), and is deleted when the session ends.
  - `codex`: `-c mcp_servers.conduit.command=…`, `…args=[…]`, `…env_vars=['CONDUIT_SESSION_TOKEN']`,
    `…env={ELECTRON_RUN_AS_NODE='1'}`, and `…default_tools_approval_mode='auto'` (Conduit's own tools
    only), so Codex doesn't raise its own prompt on every call.
  - `cursor` (`agent`): it has no per-launch flag (documented). Settings gets an opt-in **Connect Cursor**
    action that adds one `conduit` entry to `~/.cursor/mcp.json` (backed up first, removable through a
    matching **Disconnect** action). The entry's env is `{"CONDUIT_SESSION_TOKEN": "${env:CONDUIT_SESSION_TOKEN}"}`,
    which uses Cursor's documented interpolation. Outside Conduit the shim gets no token and lists no
    tools. Per-project approval follows Cursor's own `agent mcp enable`; Conduit never passes
    `--approve-mcps` (that would approve every server).
  - `ELECTRON_RUN_AS_NODE` goes only in the server's own env entry, **never in the PTY env**. Otherwise
    any Electron app started from that shell would run as Node.
  - The token is inherited by every process in the session, including a nested CLI, which then speaks
    as that session. That is accepted under the threat model below.
  - The existing cmd metacharacter guard is extended to every adapter and to the shim/exe path
    arguments. Today `launchArgsFor` returns early for anything that isn't `claude`. If a launch would
    trip the guard (`.cmd`/`.bat`), the session launches **without** the server and its card says
    "Messaging unavailable: <reason>". This feature never breaks a launch.
  - Generated config files left over from a crash are swept at app start.
- **Identity is host-resolved, never self-asserted.** No tool takes a `from`. The token is random per
  session generation (re-minted on relaunch), invalid once the PTY exits. Threat model: prevents
  confusion and accidental cross-talk between same-user processes; not a defence against a hostile local
  user (who can read process env). `list_sessions` therefore shows every session's roots to every agent.
- A shim with no or invalid token answers every call with `not_in_session`.
- **Handles:** `<agent>-<n>`. `<agent>` is the agent definition's `id`, lower-cased with runs of
  characters outside `[a-z0-9]` collapsed to `-`. `n` comes from a persisted per-agent counter that never
  reuses a number. Only sessions with a messaging adapter get a handle; plain shells don't. Existing
  `sessions.json` entries get one lazily on their next launch. The label stays separately editable.

### 3.2 Tools (MVP: four — every tool costs every agent context)

| Tool | Input | Output |
|---|---|---|
| `list_sessions` | — | `[{handle, label, agent, project, roots[], presence: busy\|idle\|exited, messaging: connected\|unavailable, self}]` + `{handle:"you"}` |
| `send_message` | `to: handle[]` (1–10, may include `you`), `body` (≤ 32 KB), `subject?` (≤ 200), `priority: fyi\|normal\|urgent` (default `normal`), `kind: inform\|request\|question\|done` (default `inform`), `thread_id?`, `attachments?: [{path}]` (≤ 5) | `{message_id, thread_id, recipients: [{handle, status: queued\|refused, reason?}]}` |
| `read_inbox` | `unread_only?` (true), `thread_id?`, `limit?` (20, ≤ 50) | `{messages: [{message_id, thread_id, from, to[], subject, kind, priority, sent_at (ISO-8601 UTC), body, attachments: [{attachment_id, name, mime, bytes}]}], remaining}`; marks returned messages `read` for the caller |
| `read_attachment` | `message_id, attachment_id, offset?` | text (UTF-8, 64 KB pages with `next_offset`) · image content (png/jpeg/gif/webp ≤ 5 MB) · else metadata + `unsupported_media` |

- **Participation invariant:** every read checks, **per message**, that the caller is in that message's
  recipients ∪ sender, else `not_found` (no existence oracle). Someone added to a thread later sees only
  the messages addressed to them. Sending into a `thread_id` the caller has no message in is refused.
- **Server turned off globally** while sessions are live: every call returns `messaging_off`; no notices.
- **Provenance framing:** every body `read_inbox` returns is wrapped as content *from session `<handle>`
  (an agent, not the user)*; messages from `you` are framed as from the human via Conduit.
- `kind` is a small typed field so later flows can route without parsing prose; extensible later.
- **Errors:** `{error: {code, message, retryable}}`; codes `not_in_session`, `unknown_handle`,
  `self_target`, `too_large`, `too_many`, `path_outside_roots`, `path_unreadable`, `not_found`,
  `unsupported_media`, `rate_limited` (> 60 sends/min per sender), `thread_limit`, `store_unavailable`,
  `messaging_off`.
  Per-recipient refusals are statuses, not an error, unless every recipient is refused.

### 3.3 Attachments
- **Snapshot at send, never a live path** — a path means a different file (or nothing) in another
  worktree, repo or sandbox. The receiver reads the snapshot through `read_attachment`.
- **Confinement:** a relative `path` resolves against the sender session's persisted `home` (never the
  OSC-reported cwd, which is agent-controlled output). It must lie inside one of the **sender's** roots,
  checked with `isInsideRoot` **and** `realPathLeaf` against that root (ADR 0005 rule); the bytes are read
  from the realpath that was checked. Any widening is a security change.
- Limits 10 MB per file, 25 MB per message, read asynchronously. Blobs are content-addressed (sha256) and
  ref-counted.
- The UI gets attachments through a new IPC that applies the same participation check (`you` is a
  participant). It does **not** widen `conduit-preview:` (ADR 0005). "Save attachment as…" writes go
  through the existing write guard.

### 3.4 Storage
- `userData/conduit-mcp/`: an append-only message log (atomic per record, crash-safe, reloaded on start),
  per-recipient state, and `blobs/<sha256>`. Not in the project: sessions span projects, no repo noise.
- Retention: 30 days or 1 GB, oldest threads first, read before unread; removed-unread leaves an
  `expired` tombstone. Blobs are deleted when their refcount reaches 0.

### 3.5 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Presence busy/idle | existing activity tracker | **new** gate, `list_sessions` | **No — flagged:** producer unchanged; the gate adds its own conditions (screen patterns, draft, settle) instead of trusting idle alone |
| PTY input | renderer `term:input`; timed messages; **new** notifier | the CLI | **Yes:** one serialized per-session writer for host-originated input; the draft tracker observes renderer input |
| Rendered screen | PTY output → scrollback ring | **new** blocking-prompt check | Yes; read-only replay of the tail at the session's size |
| Attention | BEL/run-end tracker; **new**: urgent-waiting, messages to `you`, loop guard, unread after re-notice | `src/attention.ts` chip, icons | Yes |
| Message store | host (agents' `send_message`, human compose) | MCP reads, Messages tab | Yes |
| Handle + counter | session creation | `sessions.json` restore, cards, tools | Yes |
| Launch args / env / generated config | **new** adapters beside `src/launch-args.ts` | CLI and its MCP child | Yes (measured, §2) |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Two senders to one target at once | Stored in host order; one coalesced notice |
| Agent retries a send | Two messages (no dedupe in MVP); distinct `message_id`s |
| Many recipients, some refused | Per-recipient statuses; the rest queue |
| Recipient exited but the session still exists | Queued; noticed after relaunch once its gate opens (same handle, new token) |
| Recipient session deleted | Unread → `undelivered`, visible to the human; new sends `unknown_handle` |
| Recipient never goes idle / always shows a prompt | `normal` waits; `urgent` raises the human once (attention snooze rules apply) |
| Human typing or holding a draft | Gate closed until Enter / Ctrl+C |
| CLI with no measured prompt patterns | Never typed into; human attention for `normal`/`urgent`; agent can still pull |
| Two agents replying to each other forever | `thread_limit` at 20; human sees "thread paused" |
| Attachment too large / outside roots (incl. symlink or `..`) / missing / unreadable | Whole send refused with the code; nothing stored |
| Binary / unknown media | Stored; `read_attachment` returns metadata + `unsupported_media` |
| Store write fails | `store_unavailable` (retryable); no notice for an unstored message |
| Host restart | Store reloads; unread messages re-arm notices; tokens re-minted at relaunch |
| Shim can't reach the host | The shim answers `host_unavailable` (the PTYs normally die with the host anyway) |
| Gate closes inside the submit gap | No `\r`; the text stays in the input; one human attention signal |
| Notice written while the PTY is restarting | Generation check drops the Enter; the notice re-arms |
| Second Conduit instance (dev + installed) | Separate endpoints by userData; no cross-talk |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Server for adapter-backed agent sessions | on | global off in Settings; per-session pause of notices | the feature is the point; pause is the escape hatch |
| Priority / kind | `normal` / `inform` | per message | a nudge by default, not silence |
| Idle quiet | 3 s | no | above the busy window; retune from QA |
| Notice spacing | 30 s / session | no | bounds interruption cost (each notice is a paid turn) |
| Urgent while gate closed | hold + alert the human | no | typing into a busy CLI is unmeasured |
| Thread loop guard | 20 agent messages | lift per thread in UI | stops paid ping-pong |
| Observation of other sessions | denied | v1 per-pair, time-limited grants | user: deny by default, user may grant |
| Attachment limits | 10 MB / 25 MB | no | bounds store and reader context |
| Retention | 30 days / 1 GB | no (MVP) | bounded store |

## 6. Scope slicing

- **S0 (measure — done for wiring, §2):** env passthrough, MCP handshake. **Remaining S0, first slice of
  the build:** capture Claude's blocking-prompt screens (permission prompt, folder-trust dialog) and its
  idle prompt; confirm a notice + Enter at the idle prompt becomes a turn that calls `read_inbox`. Same
  for Codex if its turns can run here.
- **MVP:** endpoint + shim + identity + handles; the four tools; snapshot attachments with confinement;
  durable store + retention; notice gate (all conditions), re-notice, loop guard, rate limits; urgent →
  human attention; Claude and Codex adapters; **Messages** tab in the right pane (threads, compose as
  `you`, in-app attach picker over the session's roots), unread/urgent badges on session cards, per-session
  pause; Cursor through the opt-in Connect action; e2e scenarios for send → notice → read and the
  refusal paths. E2E runs on a **fake MCP-capable agent fixture**: a small script CLI with declared
  prompt patterns that runs the real shim, enabled only under `CONDUIT_E2E`, because the remote runner
  has no logged-in Claude or Codex. Real CLIs are checked in local runtime QA.
- **v1:** observation (`read_session` scrollback text; `screenshot_session`) behind deny-by-default,
  per-pair, time-limited grants with a visible "being observed" indicator; Cursor + OpenCode adapters;
  channels and broadcast; TTL; advisory file leases; watch/subscribe; `wait_for_reply`; explicit ack.
- **Vision:** typed interrupt of a busy agent (measured per CLI); native-inbox delivery as an
  optimisation; peer exit monitors; flow recipes as skills.
- **Out of scope:** flow, cost, cross-machine, ACP/headless.

## 7. Acceptance criteria

**EARS**
- When an agent calls `send_message` with a valid handle, the host shall store the message, return
  `queued` for that recipient, and show it in the Messages tab.
- The host shall derive the sender from the calling connection's token; no input sets it.
- If an attachment path resolves outside the sender's roots (incl. via symlink or `..`), then the host
  shall refuse the whole send with `path_outside_roots` and store nothing.
- If a session calls `read_inbox` with a thread or `read_attachment` with a message it isn't part of,
  then the host shall return `not_found`.
- While a recipient's gate is closed, the host shall not write to its PTY.
- When a recipient with pending `normal`/`urgent` messages has its gate open, the host shall type exactly
  one notice, containing no peer text, and mark those messages `noticed`.
- If the rendered screen of the recipient matches a blocking-prompt pattern, then no notice shall be typed.
- While the human has a draft in the recipient, no notice shall be typed.
- If an `urgent` message is pending while the gate is closed, then the human shall get one attention signal.
- The host shall never type into a session without a live MCP connection, nor into one whose CLI has no
  declared prompt patterns.
- If a thread reaches 20 agent messages since the human last posted, then sends to it shall return
  `thread_limit` until the human allows more.
- If the store can't be written, then `send_message` shall return `store_unavailable` and no notice shall be sent.
- If the gate closes between the notice text and its `\r`, then no `\r` shall be written, and the human
  shall get one attention signal.
- While messaging is turned off globally, every tool shall return `messaging_off`.
- Where notices are paused for a session, the host shall send it none; messages still queue.
- When a shim connects without a valid token, every call shall return `not_in_session`.
- When Conduit restarts, messages and states shall be intact and unread messages shall re-arm notices.
- If the launch would trip the cmd metacharacter guard, the session shall launch without the server and
  show "Messaging unavailable".

**Gherkin**
```gherkin
Feature: Conduit MCP server
  Background:
    Given sessions "claude-1" and "codex-2" are running with messaging connected

  Scenario: Idle agent is notified and reads a message with an attachment
    Given "codex-2" is idle at its prompt with no draft
    When "claude-1" sends a normal request to "codex-2" attaching "docs/spec.md"
    Then within 5 seconds one notice line is typed into "codex-2"
    And "codex-2"'s read_inbox returns the message framed as from "claude-1"
    And read_attachment returns the content docs/spec.md had at send time

  Scenario: Busy agent is not interrupted
    Given "codex-2" is producing output
    When "claude-1" sends an urgent message to "codex-2"
    Then nothing is written to "codex-2"'s terminal while it is busy
    And the human sees "urgent message waiting for codex-2"
    And when "codex-2" goes idle one notice line is typed

  Scenario: Permission prompt is never answered by a notice
    Given "claude-1" is showing a permission prompt
    When "codex-2" sends a normal message to "claude-1"
    Then nothing is written to "claude-1"'s terminal

  Scenario: Exfiltration attempt is refused
    When "codex-2" sends a message attaching "../../.ssh/id_rsa"
    Then the send fails with "path_outside_roots" and no message is stored

  Scenario: Human draft blocks the notice
    Given the human has typed "fix the" into "codex-2" without pressing Enter
    When "claude-1" sends a normal message to "codex-2"
    Then no notice is typed until the human presses Enter or Ctrl+C
```

## 8. State catalog (UI) — the **Messages** tab in the right pane (beside Changes / Files)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Messages tab | First-run | "Agents in your sessions can message each other and you. Messages appear here." | **New message** |
| | Populated | Threads newest first: subject/first line, participants, priority chip, unread dot, time | Open thread |
| | Empty (filter) | "No unread messages" | Show all |
| | Loading | tab chrome + row skeletons | — |
| | Store error | "Messages couldn't be loaded" + cause | Retry |
| | Server off | "Messaging is turned off" | Open Settings |
| Thread | Populated | each message: from → to, kind, priority, per-recipient state (queued/noticed/read/undelivered/expired), attachments | Reply · Open attachment |
| | Paused (loop guard) | "Paused after 20 agent messages" | **Allow 20 more** |
| | Attachment expired | "Attachment expired" in place of the chip | — |
| Compose (as `you`) | idle / sending / failed | recipients (handle + label), priority, kind, body, **Attach…** (in-app picker over the selected session's roots); failure lists per-recipient reasons | Send · Retry |
| Tab label | unread / urgent / to-you | count badge; urgent badge with icon + text | — |
| Session card | unread / urgent / paused / unavailable | count badge; urgent badge (icon + text); pause glyph; "Messaging unavailable" in its tooltip | Open Messages filtered to it |
| Attention chip | urgent waiting · message to you · thread paused · unread after re-notice | joins the existing "N need you" chip with its reason | Jump to thread |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Thread list | open, unread filter, mark read | click | ↑/↓, Enter, Home/End | n/a (desktop app) | Mark read · Copy message id | `listbox`/`option` + `aria-selected`; unread and priority in the name |
| Thread view | reply, open attachment, allow more | click | Tab follows messages; Enter on attachment | n/a | Copy body · Save attachment as… (in-app) | `article` per message inside a `log` |
| Compose | recipients, priority, kind, attach, send | click | Ctrl+Enter send, Esc cancel | n/a | — | labelled fields; priority `radiogroup` |
| Card badge / menu | open filtered, pause/resume notices | click | via the card's existing menu | n/a | Pause notices · Open messages | badge text in the card's accessible name |

No drag interactions. Overlays over `.topbar` get `-webkit-app-region: no-drag`. Attach uses an in-app
picker, not a native dialog (Playwright can't drive those).

## 10. Accessibility & i18n (UI)

- Keyboard-operable throughout; visible focus that survives forced colours; icon-only controls labelled
  ("Pause notices for codex-2").
- New messages and send results announced in one polite live region, throttled to one summary per 5 s
  ("3 new messages"); urgent rides the existing attention announcement.
- Priority and state never colour-only: chip text + icon.
- Strings in `webview/conduit-mcp-strings.ts` (pattern of `term-link-strings.ts`); counts via `countNoun`;
  times via `Intl.DateTimeFormat`, stored ISO-8601 UTC; +30% text tolerated; RTL mirrors the list, message
  text direction follows content; sorted by time.
- The notice line is machine-facing text for the agent, deliberately fixed English ASCII, not localised.

## 11. Design tokens (UI)

Existing semantic roles in all three themes: surface/raised, text/muted, accent (unread), the attention
role (urgent, with icon + label), existing badge tokens, focus ring. A new role is a design-review call.

## 12. Assumptions

- MCP is the agent interface (user, 2026-10-25); generic delivery only.
- Name: "Conduit MCP server" (user). One human participant `you`.
- userData storage; four tools is the MVP ceiling.
- No MCP SDK dependency: the host speaks the measured minimal subset; protocol version is negotiated by
  echoing a supported client version.

## 13. Decisions Needed

- [high] **Prompt detection is the injection-safety linchpin.** Default taken: per-CLI declared screen
  patterns, built from captured screens; a CLI without measured patterns is pull-only. If Claude's
  prompts can't be told apart from its idle prompt, Claude becomes pull-only too and the MVP's
  auto-notice is reported as not achieved.
- [high] **Codex and Cursor prompt patterns** must be captured the same way as Claude's before either
  gets notices; until then each is pull-only. (Codex was unblocked mid-run: the user installed 0.164.0
  and logged in.)
- [high] **Cursor wiring has no per-launch flag** (documented). Default taken: an explicit, reversible
  **Connect Cursor** opt-in that writes one global entry using `${env:…}` interpolation. Nothing is
  written without that click. If the interpolation measures broken in QA, Cursor drops to v1.
- [normal] A notice left unsent (gate closed inside the submit gap) leaves its text in the CLI's input
  rather than guessing a per-CLI line-clear key.
- [normal] Feature lands on `feat/conduit-mcp`, not main, and is not released — new subsystem with a
  security surface; the user merges.
- [normal] Retention, loop-guard and rate numbers — reversible.

## 14. Open questions

None blocking; S0 results may reopen §2.
