---
status: shaped — awaiting owner decisions
date: 2026-11-14
ticket: CON-10
tier: FULL
version: v4.5
---

# Feature Spec: Requests for user input (CON-10)

**Tier:** FULL   **Feature type:** UI (plus an MCP tool contract)
**Request (verbatim, CON-10):** "When multiple agents run in parallel, requests for user input—such as
approvals, decisions, or messages—can get lost among agent-to-agent chatter. The conduit MCP should let
agents surface these requests through a clear user-facing notification or interface, where the user can
respond (for example, approve or decline) or review and edit text."

## For the user (read this first)

- **The shape:** everything that needs you lands in one **Needs you** queue, apart from agent chatter:
  agent questions, tool approvals, a CLI stuck at its own prompt, a failed auto-resume. Agents ask through
  a new tool. If you don't answer in time, the call returns and your answer reaches the agent later, so a
  slow answer is never a lost one.
- **When you're away:** you set Away. An agent may attach "I'll go with X unless you answer within 2 h".
  Tool approvals never apply themselves. When you're back, a digest shows what was auto-applied and what
  is still open (and, from v1, what lead agents answered).
- **A busy afternoon, 8 agents and 3 asks.** *Today:* codex-2's "which migration?" is message 14 of 30
  in a thread, claude-5's close_session card dies after 120 s while you're at lunch, and codex-4 waits at
  its own prompt behind one icon. *With this:* the chip says "3 need you", and the panel lists codex-4
  ("Open terminal"), the expired close_session ("Allow next time…") and the migration choice.
- **Limits:** tool approvals still expire with the agent's CLI timeout (25–170 s). CLI prompts can be
  *pointed to*, not answered, until POL-D2 says otherwise. Answering from another machine is v1.
- **Depends on:** CON-18 (the approval body, grants, Activity), CON-16 (links, for v1 cross-machine
  answers), CON-15 (the auto-resume request content).
- **Top decisions (my recommendation):**
  1. REQ-D1: one queue for every source → **yes**.
  2. REQ-D21: no more 5 s auto-deny with no window open: an ask waits its full budget in the tray, and
     `you` is one person across your machines → **yes**.
  3. REQ-D15: agent defaults may auto-apply at expiry, never for approvals → **yes**.
  4. REQ-D18: helpers may ask their lead agent first, and the lead answers or escalates to you → **yes, v1**.
  5. REQ-D20: an unread prose message to you with kind `question` shows up in the queue → **yes,
     `question` only**.

This is a **shape** spec, with no implementation plan.

### Shared names

| Name | Owner |
|---|---|
| request, answer, lifecycle states, attention, Away, digest | REQ (this spec) |
| server, link, peer, owner, trust level own/guest, capability messaging/monitor/drive/orchestrate, `handle@<machine-id>`, revoke | NET `2026-11-14-conduit-network.md` |
| principal, rule, grant, profile, audit entry ("Activity"), the who × on × for picker | POL `2026-11-14-policy-and-permissions.md` |
| **guest-triggered ask** (a policy ask caused by a guest action; grantable; v1) · **guest request** (a guest agent's own `request_input` to me; never grantable; vision) | shared wording (R2) |

## 1. Problem frame

- **Job:** "When an agent needs *me*, I find out, see exactly what it needs, answer in one place in
  seconds, and the agent gets the answer, even when ten agents are talking to each other."
- **Actors:** the human (`you`, one person across own links); agent requesters; lead agents (a helper's
  `opened_by`); Conduit itself (policy, Scheduler, observed prompts); later, remote requesters
  (`claude-3@<machine-id>`).
- **Success:**
  1. Every open request is in one place, counted once on the chip and in the tray.
  2. Every answerable kind can be answered without opening the requester's terminal. Observed prompts
     jump to the right terminal.
  3. The requester gets a structured answer whether or not it was still waiting.
  4. Requests that no longer matter leave the open list by themselves.
- **Non-goals:** replacing messaging; a form builder; answering by rule (POL); the link transport (NET);
  mobile.

## 2. What exists today

"Read in source" means inferred from code, not measured at runtime. Behaviour claims the build relies on
are gated by REQ-D9.

| Claim (v0.64.0) | Basis |
|---|---|
| `send_message` kinds `inform\|request\|question\|done`; may address `you` | read in source `src/conduit-mcp/types.ts:4-6` |
| `kind` is only a label: compose and the thread chip, nothing routes on it | read in source `message-compose.tsx:23`, `message-thread.tsx:88,115` |
| A message to `you` raises one `message-to-you` item per thread until read; no answer object | read in source `attention-items.ts:90-102` |
| The chip lists asks, then sessions (`blocked`/`bell`/`stuck`), then message items | read in source `src/attention.ts:104-170` |
| Policy `ask` = non-modal approval card (Approve / Deny / Always for this session, pager, ≤ 3 per caller, never takes focus) | archived `2026-10-30-conduit-mcp-tool-policy.md` §2.4 |
| An ask waits only inside its CLI's MCP call budget (table in POL §2.1), then `approval_timeout` | read in source `call-flow.ts:28-41,147` |
| With no app window connected, waiting asks are denied `ui_unavailable` 5 s after the last app disconnects | read in source `server/mcp/index.ts:41,320-327` |
| OSC 7501 can report `blocked` (`permission\|question\|auth`); it's primary where reported; `blocked` is raised only if the session isn't visible | read in source `terminal-runtime.ts:11-15`, `server/attention/index.ts:250-252` |
| Which CLIs emit OSC 7501 `blocked` at their prompts | **ASSUMED** (REQ-D9) |
| The tray shows "N running, M need you" | archived `2026-11-03-tray-helper.md` §4 |
| CON-11 marks "needs you" when auto-resume can't help | read in source `server/attention/index.ts:52-55` |
| Message retention 30 days; snooze 10 min | read in source `store.ts:67`, `src/attention.ts:42` |
| **Measured, this run:** 79 messages in `messages.log` (01:43–05:46 UTC): 54 inform, 14 done, 6 request, 5 question; **0 to `you`** (the run forbids asking the human). Both of the lead's revision orders to me used `kind: request` for a task, not a question | ran a count over `~/.config/conduit/conduit-mcp/messages.log` |

**What's wrong:**
- There is no request object: a decision is a message with a cosmetic chip, buried in chatter.
- Four surfaces compete for "needs you" (card, session icons, message items, stuck screens), and none of
  them answers a decision.
- Only short blocking asks exist, and with no window open they die after 5 s.
- CLI prompts are trapped in terminals.

## 3. Shape options

| | A. Typed messages | B. Request tool + panel, agent-only | **C. One queue, every source (recommended)** |
|---|---|---|---|
| What | structured fields on `send_message`, answerable in threads | a new object and panel; policy card and session states stay | the request is the single human-attention object; the card becomes a view of waiting requests |
| Makes possible | cheapest; reuses store and notices | answer kinds, lifecycle | one count, one panel, one keyboard flow; link-aware; one audit hook |
| Rules out | lifecycle (messages are immutable); system sources; still inside the chatter | one place to look (a fifth surface) | nothing existing; it reshapes card and chip |
| Cost / risk | low / doesn't solve "lost" | medium / permanent fragmentation | high but sliceable / users relearn the card |

**Why C:** requests get lost because there are too many places to look, and only one place fixes that.
C's cost sits in the object model, which CON-16 and CON-18 need anyway.

## 4. Recommended shape

### 4.1 The request

| Field | Meaning |
|---|---|
| `id`, `origin` | server-scoped id. The origin server is the only writer and owns the clock |
| `requester`, `session` | a handle or `conduit`; the session it concerns |
| `space`, `lead`, `machine` | stamped by the origin at creation so every view can filter without a lookup: the session's space; the root of its `opened_by` chain (a lead and all its sub-sessions share it); the origin machine id (owner, 2026-11-14) |
| `source` | `agent` · `message` (§4.10) · `policy` · `observed` · `cli-prompt` (only if POL-D2 picks deciding) · `scheduler` |
| `kind` | agent-raisable: `confirm` · `choose` · `text` · `review` · `form` (v1). Conduit-only: `permission` · `attend` |
| `to` | `you` (default) or `lead` (§4.8, v1) |
| `title` / `body` / `options` / `draft` / `fields` | requester-written: title ≤ 200 chars, body ≤ 8 KB, 2–8 options, draft ≤ 32 KB, 2–5 fields |
| `thread` | optional; the request also renders inline in that thread |
| `expiresIn` + `default` | optional relative duration, resolved by the origin's clock, and the answer that applies then (§4.7) |
| `priority` | `normal` \| `urgent` |
| `waiting` | a call is blocked on it right now (drives the waiting notice, the session pill's waiting state and the row countdown) |
| `answer` | outcome below, plus `answeredBy` (`you` + window/server · `default` · a lead handle) and time |

| Kind | Type (UI) | Outcomes | Payload | Answer options (designer) |
|---|---|---|---|---|
| `confirm` | Approve | `approved` · `declined` · `answered` | `reason?` ≤ 500 chars, or `text` ≤ 8 KB for "something else" | Yes · No |
| `choose` | Answer | `chosen` · `answered` | `values[]` and/or `text` ≤ 8 KB | the agent's options |
| `text`, `message` | Answer | `answered` | `text` ≤ 8 KB | none; the field is the answer |
| `review`, `form` | Review | `approved` · `edited` · `declined` | edited `text`, `reason?` | Approve with my edits · Approve as written · Reject |
| `permission` | Approve + Conduit mark | `allowed` · `denied` | POL's grant from the who × on × for picker, `reason?` | Allow once · Allow… · Deny |
| scheduler | Answer + Conduit mark | CON-15's | — | CON-15's (Try again at reset · Continue now) |
| `attend` | Approve or Answer (by what the prompt asks) + Conduit mark + "›_ in terminal" | none (Open terminal only) | — | — |
| agent and scheduler kinds | | also `dismissed` (footer **Skip**: "I won't answer") | — | — |

- **Three user-facing types (designer iter-7).** The UI shows the type, never the kind: **Approve** (yes or
  no), **Answer** (pick or reply), **Review** (edit or approve a draft, fill in a form), each with its own icon
  (square ✓ · bubble ? · page). The type says what is asked, not where it opens: the size rule (§4.4) decides
  pop-up vs tab, shown as a separate "⧉ N lines" marker.

- **`permission`.** POL §4.4 owns the body: a Conduit-written action summary, the "why" line, and Allow
  once / Deny / Allow… with the who × on × for picker. **The picker is MVP (R5)**, and "Always for this
  session" goes away (POL §4.2 maps old overrides). REQ owns the chrome, the lifecycle and delivery.
- **Always a way to say something else (owner decision, 2026-11-14).** Every `confirm` and `choose` shows
  a free-text field under its options, and the agent can't turn it off. The human may pick an option, type
  instead (`answered` with `text`), or both (`chosen` with `values[]` and `text`). The agent receives the text
  verbatim. `permission` stays structured (POL owns it), with only its `reason?`.
- **`attend`** is observed. A session is blocked at a prompt Conduit can't answer (OSC 7501 `blocked`, a
  screen pattern, a stuck screen). It's raised only when the session isn't visible (today's rule),
  **replaces** that session's `blocked` chip entry, and is `resolved` when the prompt clears.
- **Anti-spoofing (agreed with both designers).** Only Conduit-authored requests (`permission`, `attend`,
  scheduler) show the solid **⛨ Conduit** chip and the shield badge on the type icon, in fixed slots that no
  agent text can reach; only `permission` has the "Why" line and Allow once · Allow… · Deny. In agent-raised requests, the header is Conduit-written
  ("codex-2 asks you to choose"), and the agent's title, body and options render beneath it as quoted
  content. OS notifications carry no agent text.

### 4.2 Lifecycle (canonical; NET and POL cite this, R12)

```
 open ─┬─ answered    (an outcome above; by you, a lead, or the default at expiry)
       ├─ expired     (expiresIn passed with no default; or a bound call ended: budget, cancel, connection or requester-link loss)
       ├─ withdrawn   (withdrawnBy: requester | conduit; reason: "policy changed", "link revoked", …)
       ├─ superseded  (requester replaced it; links to the new one)
       ├─ resolved    (observed/scheduler/cli-prompt: the condition cleared, or answered in the terminal)
       └─ orphaned    (requester session deleted; the answer can't be delivered)
```

- End states are terminal and are kept in History for 30 days. If the requester isn't running, the
  request stays open and the answer waits in its inbox.
- Row copy: "Withdrawn by claude-3" when the requester withdrew, "Withdrawn by Conduit: link revoked"
  when Conduit did.

### 4.3 Delivering the answer: blocking vs non-blocking

- **`request_input`** (name: REQ-D3) creates the request and waits up to `wait_s`. The default is the
  caller's ask budget minus 10 s (budgets in POL §2.1); `wait_s: 0` returns at once.
  - Answered in time: the call returns `{state:'answered', answer}`.
  - Otherwise: the call returns `{state:'open', request_id}`, and the later answer arrives as an inbox
    message from `you` carrying `request_id`, with a typed notice. The agent also has `wait_request`,
    `withdraw_request` and `replaces: id`.
- **Cancel or retry of an agent request:** the request stays open with `waiting=false`. A repeat call with
  identical content attaches to it and waits again.
- **Bound requests** (`permission`, `cli-prompt`) live and die with their call. Budget end, cancel or
  connection loss → `expired`.
  - On an expired `permission`, "Allow next time…" (POL's picker) creates a grant and **never runs the
    stale action**. The agent gets a notice to retry.
- **Remote asks (R10, v1).** For a call made on server A whose action runs on origin B, A forwards the
  call's remaining budget. B expires the request at that deadline minus a 2 s hop margin. If the link to
  A drops, the call counts as cancelled and the request is `expired`. Viewers on other links see "origin
  unreachable". Late answers never run.
- **No window open (REQ-D21):** asks no longer die after 5 s. A waiting ask stays in the tray ("M need
  you") and raises an OS notification, then expires at its budget.
- **Scheduler answers** go to CON-11, which runs the chosen action. A failure raises a new request.

### 4.4 Where requests show

The list is for finding; the pop-up or tab is for answering (designer `CON-10/iter-7/`).

1. **Needs you panel: a plain list**, a right-pane tab beside Messages (REQ-D6).
   - It opens from the chip, the tray and a shortcut, with Open / History views (plus "Handled by leads" in v1).
   - Default order **soonest-needed**: live waiting call, then urgent, then nearest expiry, then oldest.
     The ⋯ menu also sorts Newest, Oldest and By session (a heading per session).
   - **Minimal two-line cards:** type icon · session and agent · why it matters now (waiting countdown,
     urgent, remote machine + expiry, "⧉ 46 lines" for tab-bound rows, "›_ in terminal", else age), then
     the ask cut to fit. ⋯ → Show adds space, age and machine. Rows never expand or answer: click or Enter opens.
   - **Filters** (⋯): session/agent, lead group (a lead and all its sub-sessions), space, type, machine (owner, 2026-11-14). An active filter is always stated under the header
     ("Filtered: claude-7 · 2 of 9 shown · Clear"); a waiting call is never filtered out; counts ignore
     filters. Filters reset when the window closes; sort and Show persist.
2. **One four-section template** for the pop-up over the editor area (light requests) and the tab (heavy):
   **Header** (type icon, Conduit's sentence naming agent and session, Conduit mark, time left) · **Context**
   (the quoted question plus any command, diff, summary or draft; the only part that varies by type) ·
   **Answer** (one option list from the table in §4.1, the own-words field, and a plain Send that never repeats the pick;
   Ctrl+Enter, or Enter on a picked option) · **Footer** in two fixed zones, never answering: this request
   (Open as tab · Open terminal) | the queue (Skip · **Next: N more →**). Inapplicable actions are omitted.
   - Opens **only from a human click or key**, never on its own; focus goes to its title, not a button.
   - Send answers, shows a one-line receipt, and loads the next request (400 ms guard). Next moves down
     the list and wraps; a call that starts waiting while it's open comes next. Esc closes; the pick and
     typed text stay on the request. Below 1200 px it keeps 560 px and also covers the list.
3. **Tab beside the requester's terminal** for heavy requests, in that session's tab group
   (`[▸ server lane] [Answer: hc events…] [hc-events.ts]`), Context and Answer side by side (for `review`,
   Context is the editable draft). It stays until answered or closed; closing keeps
   edits. Unsent edits survive a reload (ASSUMED feasible).
4. **Size rule.** `review` and `form`: always a tab. `confirm`, `choose`, `text`, scheduler and prose
   questions: a pop-up when the body is ≤ 600 characters and ≤ 8 lines, there are ≤ 4 options, and each
   option description is ≤ 100 characters; otherwise a tab. "Open as tab" works on any pop-up except a
   permission, and the request then stays a tab.
5. **`permission` opens the pop-up; its row has no buttons.** A card can't show the target, where
   it runs and the Why line together, and approving what you can't read is what POL guards against. The
   pop-up carries POL's body as Context; Allow… unfolds the picker inside its option; the field is a note
   sent as `reason`, never an answer; no Skip, no tab. Ctrl+Shift+A focuses Allow once, so it stays two keys.
   `attend` opens the terminal and focuses the CLI's prompt.
6. **Blocked agents, without taking focus:** a **waiting notice** (one line, "claude-3 is waiting for
   your approval · 0:47 · Open"; not answerable) while the requester isn't on screen, and a **session
   pill** in the requester's terminal header ("◉ Waiting on you · 0:46 · 1 request") while it is. Both open
   the pop-up or tab. The status bar shows the shortest live countdown.
7. **Thread link**, if a thread is set: a one-line link in the thread that opens the pop-up or tab.
8. **Sidebar:** a session moves to the "Needs you" group only when it is **blocked on you**: a waiting
   call, an `attend` prompt, an idle agent waiting for its answer, or a failed resume. A session with a
   non-blocking ask stays in Working with an "asks" marker (designer iter-4), so the sidebar doesn't
   duplicate the queue.
- All views show the same object: answering in one removes it everywhere. Requests are not counted in
  Messages unread.

### 4.5 Notification and attention

| Event | In-app | OS |
|---|---|---|
| New request, window focused | chip +1, row, coalesced live announcement; card if waiting | none |
| New request, no window focused | as above | taskbar flash + OS notification, **Conduit's words only** ("claude-3 needs your approval") |
| No window open | — | tray "M need you" + OS notification. Open Conduit lands on the panel |
| `urgent` | pinned at the top; shown as "Urgent" with an icon and text | notifies even when snoozed or Away |
| Burst | one announcement per 10 s ("4 new requests from 3 agents") | same |
| Snooze (10 min/session) | hides that session's non-urgent requests from the chip and card, not from the panel | suppressed |
| Away (§4.7) | unchanged in-app | held except urgent |

### 4.6 Many requests, many agents

- **REQ caps** (sources `agent` and `message`): 5 open per requester, 1 urgent per 10 min, 20 created
  per hour, 50 open per server. Requests mirrored from peers count only at their origin.
- **Caps owned elsewhere:** waiting-ask and guest caps are POL §4.5; link-level rates are NET §5.
- **Dedupe and supersede** keep repeats down (§4.3).
- **Keyboard:** in the list, j/k move, Enter opens the pop-up or tab, `o` opens the terminal, `h` shows
  History. In the pop-up, the answer keys (`a`/`d`/`1–8`) use the 400 ms guard and can be turned off
  (WCAG 2.1.4); Ctrl+Enter sends, → goes to the next request (Alt+→ in a text field), Esc closes and keeps
  typed text. Ctrl+Shift+A opens the soonest waiting request's pop-up from anywhere.
- **No approve-all** for `confirm` or `permission`. "Dismiss all from <session>" is allowed.

### 4.7 Away, defaults and the digest (MVP together, R17)

- **Why both are in MVP:** this user runs unattended runs and comes back hours later. Defaults without a
  digest would hide what was decided. A digest without Away has no period to summarise.
- **Away (MVP: explicit; v1: also suggested after 30 min with no input).**
  - Set from the chip or tray, until a time or "until I'm back". It ends on input in any window, or explicitly.
  - Presence is per owner, merged across own links (REQ-D21). Agents see
    `human: {handle:'you', presence:'here'|'away'}` in `list_sessions` (REQ-D17).
  - Requests without a default wait. Asks expire at their budget and are **never auto-allowed**.
- **Requester defaults.** `request_input(…, expiresIn:'2h', default:…)`.
  - The row shows "Goes with Blue/green at 16:20" (the origin resolves the time and shows it in local
    time). Any answer before then wins.
  - At expiry the default becomes the answer, with `answeredBy: default`. History and the digest show
    "Went with the agent's default".
  - **Allowed** for `confirm`, `choose`, `text`, `review` and `form`. A default gives the agent no power it
    didn't already have, since its tool calls stay under policy.
  - **Never allowed** for `permission` (that would be approval by silence), `attend` or `cli-prompt`.
    `scheduler` requests get one only if CON-15 names a safe default.
- **Digest** at the top of the panel when Away ends: "While you were away (3 h 12 m): 4 auto-applied ·
  2 still open · 5 resolved · 1 expired approval" (from v1 also "· 3 answered by leads").
  - Open requests come first.
  - **Follow up** on an auto-applied or lead-answered row sends a message in the request's thread. It
    can't undo what was done, and the UI says so.

### 4.8 Escalation through a lead agent (v1, REQ-D18)

- **Routing:** `to: 'lead'` sends the request to the requester's `opened_by`. It doesn't count in the
  human's chip.
- **How the lead answers:**
  - The lead sees it through a notice and `list_requests`.
  - It answers with `answer_request`, or calls `escalate_request(note?)`, which re-targets the request to
    `you` with the chain shown ("codex-4 → claude-3 → you").
  - These tools belong to POL's Requests group. `answer_request` and `escalate_request` are allowed for
    **any ancestor in the requester's `opened_by` chain** (up to the max depth below), never a sibling or
    descendant (R19, same words in POL). Across an own link they ride the `messaging` capability (R21).
- **Auto-escalation:** if the current ancestor exits, or doesn't answer within half the remaining time
  (15 min if no expiry), the request moves one level up the `opened_by` chain. Every ancestor on the way
  may answer it. It ends at the human after at most 5 steps (the max depth).
- **The human sees everything leads did:** History, the digest and the "Handled by leads" view, tagged
  "answered by claude-3 (lead)". The human can Follow up but not reverse.
- **Never routed to a lead:** `permission`, `cli-prompt`, `attend` and `scheduler`. An agent approving
  another agent's policy ask would be a self-approval channel.
- Options considered: the human is always the target (floods the human), and leads may answer anything
  (races the human, blurs who decided).

### 4.9 Outside Conduit

- **v1:** another own machine's Conduit GUI (CON-16).
- **Vision, notify-only first:** phone push, an email digest, chat, and moving a run's own board card
  to "Needs you". Per-request board cards would churn the board.
- **Out of scope:** answering from any channel that can't prove it's the owner (an email reply, an
  unauthenticated chat message) (REQ-D19).

### 4.10 Prose questions (REQ-D20)

- An unread `send_message` to `you` with **`kind: question`** shows as a `text` row (source `message`).
  - **Reply** posts an ordinary thread reply, so no agent change is needed.
  - "Not a question" dismisses the row. The message stays in its thread; the row only points to it.
- `request`, `inform` and `done` stay plain messages. Measured in this run (§2), agents use `request` for
  task orders, so surfacing it would add noise. Questions asked only in a terminal are never captured.

## 5. Flows and edge cases

Flows covered by Gherkin (§9) aren't repeated here.

- **F3 Policy ask.**
  1. claude-1 calls `close_session(codex-2)` under ask: a `permission` request appears in the list and
     the waiting notice, and opens in the pop-up.
  2. Allow once runs it. Allow… creates POL's grant, then runs.
  3. No answer in time → `expired` → "Allow next time…".
- **F4a Observed prompt (MVP).** codex-2 stops at its prompt while off screen → an `attend` row → the
  human answers in the terminal → `resolved`.
- **F4b Decided Claude prompt** (v1, only if POL-D2 picks deciding). The `PermissionRequest` hook waits
  on a `cli-prompt` permission request. If the hook gives up, or the human answers in the terminal → `resolved`.
- **F5 Auto-resume can't help.** A `conduit` choose: "still limited after 3 tries" · Resume now · Try
  again at next reset · Open schedule · Dismiss → `resolved` if the session resumes by itself (CON-15).
- **F6 Another machine (v1, own link).** A Linux-origin request shows in the Windows GUI with the origin's
  countdown. The first answer applies at the origin, and the other GUI shows "Answered on <machine>".
  While the link is down, the remote row is read-only.

| Condition | Behaviour |
|---|---|
| Two windows/GUIs answer at once | the origin applies the first; the other sees "Already answered from <where>", input kept for copying |
| Withdrawn or replaced while the human edits | "Withdrawn by …" / "Replaced → open new"; submit disabled; the draft copyable, carried to a same-kind replacement |
| Server restart | `agent` requests stay open (`waiting=false`); bound ones `expired`; `observed`/`scheduler` re-derived from live state |
| Opening a purged request | "This request no longer exists" → History |
| At cap / oversize | `rate_limited` / `too_large` with a hint; the row notes "claude-3 has 5 open requests" |
| A default without `expiresIn` | `invalid_args` |
| Agent text imitating Conduit | quoted under a Conduit requester line; only Conduit kinds get system chrome |
| Secret requested | no secret kind; the panel warns that answers enter the agent's context (REQ-D10) |
| Lead waiting on the human | the helper's request auto-escalates by the timeout rule; the chain shows both |
| Digest after a long absence (> 100 items) | counts and open items first; the rest collapse per session |
| **v1, across links (A20):** lead is remote (`opened_by: claude-3@linux-box`) | the request stays at its origin; the lead answers through the own-link mirror using the `messaging` capability (R21); escalation continues up the chain to `you`, who is the same person on both |
| **v1:** cross-machine thread hits the 20-message pause | shown on the server whose store holds the thread; mirrored read-only to other own GUIs, like requests |
| **v1:** mirrored requests and caps | count only at their origin |
| **v1:** link drops mid-answer | "Sending…", then a visible failure after 10 s with Retry; never applied twice (versioned) |

## 6. Defaults vs settings

| Decision | Default | Configurable? | Why |
|---|---|---|---|
| OS notification | on while no window is focused | existing OS-attention setting | the point is not to miss them |
| Notification text | Conduit's words | no | spoofing, lock-screen privacy |
| `wait_s` | budget − 10 s | per call | short asks feel synchronous |
| Agent request expiry | none | per call | a gap of hours is normal |
| Waiting notice | waiting requests only, one line | no | the rest isn't time-critical |
| Pop-up or tab | the §4.4 size rule; Open as tab always available | no | one rule, predictable |
| Panel order | soonest-needed, flat | no (grouping: v1 candidate) | blocking asks never buried |
| Single-key answers | on, focus-scoped | can be turned off | speed vs accidents |
| Deciding native prompts | follows POL-D2 (default: not yet) | — | owned by POL |

## 7. Possible / not possible / unknown

| Item | Verdict | Basis |
|---|---|---|
| Agent requests of any length | **Possible** (return `open`, deliver via inbox) | today's inbox and notices |
| One tool call blocking past its CLI timeout | **Not possible** | `call-flow.ts:28-41` |
| An ask surviving with no window | **Possible**: the server owns it; the tray and OS notification can show it | `server/mcp/index.ts:320-327` is today's choice, not a limit |
| Seeing that a CLI is prompting (`attend`) | **Possible where it reports** OSC 7501 or matches a screen pattern | REQ-D9 |
| Deciding native prompts per CLI | see **POL §2.3** (Claude: hooks; Codex: hook after one-time hash trust, or `app-server`; OpenCode: only under `opencode serve`; Cursor and Kiro: partial/UNVERIFIED) | `docs/runs/2026-11-14-shaping/cli-permissions.md` |
| MCP elicitation as the mechanism | **Wrong direction** (server asks the client's UI) | https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation |
| Secrets through requests | **Not safe** (the answer enters the agent's context) | same spec forbids form-mode secrets |
| Approve from an OS notification | **Possible, risky** | ASSUMED; REQ-D11 |

## 8. Gaps, trade-offs, relation to other tickets

- **Gaps:** prompts without a usable hook can only be pointed to; prose questions in terminals aren't
  captured; asks still expire; agent text can mislead (only `permission` is Conduit-described); honest
  counts add pressure (ordering, snooze, Away and no approve-all are the trade).
- **H4 (ask → request): confirmed, amended.** Policy is one of six sources. Only bound requests expire
  with a call. A late allow creates a grant and never runs.
- **H6 (CON-15 local, its "needs you" is a request): confirmed.** F5; state `resolved`.
- **H5 (audit):** every ended `permission`/`cli-prompt` writes a POL audit entry (decider, outcome,
  whether it ran; "decided in terminal" when known). An agent request is one Activity row linked to its
  History entry (POL-D17).
- **H1/H2 (links):**
  - Ids carry `origin` from MVP. `you` is one person across own links (REQ-D21).
  - In NET MVP, remote items are read-only in the Machines group. Answering remotely is v1 (F6).
  - A remote `orchestrate` call asks on the receiving server, so cross-machine answering matters early
    (NET's Linux-lead → Windows-lanes workflow).
  - Guest-triggered asks are v1 (grantable, through POL). Guest requests are vision and never grantable.
- **H3: agreed.** POL owns the permission body, grants, Activity and the Requests tool group (R6). REQ
  owns the surface.

| Data / state | Produced by | Consumed by |
|---|---|---|
| agent / message request | `request_input` / an unread `question` to you | list, pop-up/tab, pill, notice, thread link, chip, tray, OS |
| policy request | POL evaluation | same + POL audit |
| observed request | attention (OSC 7501, patterns, stuck screens) | same; **replaces** the `blocked` chip entry |
| scheduler request | CON-11 | same; the answer goes back to CON-11 |
| answer | the human, a lead, or a default | requester (call or inbox); POL grant/audit; CON-11 |
| chip/tray counts | requests + remaining attention | top bar, tray: **producer changes**, both in scope |

## 9. Acceptance criteria

**EARS:**
- The waiting notice shall show only waiting requests and never take focus.
- The pop-up shall open only from a human click or key.
- If two answers arrive, then only the first shall apply.
- While no window is focused, there shall be at most one OS notification per 10 s, in Conduit's words.
- When a waiting agent call is cancelled, the request shall stay open.
- While no app window is open, a waiting ask shall stay answerable until its budget ends.
- A countdown shall be announced only at 30 s left and at expiry.

```gherkin
Feature: Requests for user input
  Background:
    Given sessions "claude-3" and "codex-2" run connected agents, nothing needs the human

  Scenario: A late answer still reaches the agent
    Given "codex-2" calls request_input "choose" with options "Blue/green" and "In place", wait 150 s
    When 150 s pass without an answer
    Then the call returns state "open" with a request id and the request stays in the panel
    When the human picks "Blue/green"
    Then "codex-2" gets a notice and read_inbox shows outcome "chosen" with that request id

  Scenario: Review and edit text
    Given "claude-3" requests a review of a 40-line draft
    When the human edits line 3 and chooses "Approve edited"
    Then "claude-3" receives outcome "edited" with the edited text

  Scenario: Requests stay apart from chatter
    Given 30 agent-to-agent messages arrive and "claude-3" raises one confirm request
    Then the chip reads "1 needs you" and the panel lists exactly that request

  Scenario: An observed prompt counts once
    Given "codex-2" is off screen and reports blocked at a permission prompt
    Then the panel shows "codex-2 is waiting at a prompt in its terminal" and the chip reads "1 needs you"
    When the prompt clears
    Then the request is "resolved" and the chip is hidden

  Scenario: An expired policy ask is allowed for next time
    Given close_session is set to ask and "claude-3" calls it, and nobody answers within 120 s
    Then the call returns approval_timeout and the request shows "Expired"
    When the human picks "Allow next time…" with "this session · this target only · until this session ends"
    Then nothing is closed, "claude-3" gets a notice to retry, and a retried close_session runs without asking

  Scenario: An ask with no window open waits in the tray
    Given no Conduit window is open
    When "claude-3" calls a tool whose policy is ask
    Then the tray shows "1 needs you" and the call is not denied before its budget ends

  Scenario: Away, a default, and the digest
    Given the human sets Away
    And "codex-2" asks "choose" with default "Blue/green" expiring in 1 hour
    When the hour passes without an answer
    Then "codex-2" receives "chosen" "Blue/green" with answeredBy "default"
    When Away ends
    Then the digest shows "1 auto-applied"

  Scenario: A lead answers, and the human sees it afterwards
    Given "codex-4" was opened by "claude-3"
    When "codex-4" asks to lead "Rebase or merge?" and "claude-3" answers "rebase"
    Then the chip does not change and History shows "answered by claude-3 (lead)"

  Scenario: A prose question shows in the queue
    Given "claude-3" sends a message to you with kind "question"
    Then the panel lists it with "Reply"
    When the human replies there
    Then "claude-3" receives an ordinary thread reply and the row closes

  Scenario: Withdrawn while editing
    Given the human is editing a review request
    When the requester withdraws it
    Then the row shows "Withdrawn by claude-3", submit is disabled and the text stays copyable
```

## 10. Scope slicing

- **MVP:**
  - the request object and store (link-aware ids);
  - `request_input` (confirm/choose/text/review) with wait-then-inbox, cancel/retry, withdraw and replace;
  - the list panel, the pop-up, request tabs (review and long requests), the waiting notice, the session
    pill and the thread link;
  - chip and tray counts; OS notifications;
  - `permission` with POL's MVP picker and "Allow next time";
  - no-window asks wait in the tray (REQ-D21);
  - `attend`; `scheduler`; `message` rows for `question`;
  - explicit Away, requester defaults and the digest;
  - owner presence and Away merged across own links, read-only, shipping with NET MVP (R23).
- **v1:** `form`; `to: lead` and escalation; answering from another own GUI; remote-ask timing; the idle
  Away suggestion; `cli-prompt` if POL-D2 picks deciding; guest-triggered asks (with NET/POL).
- **Vision:** guest requests; outside channels (notify-only first); approve-all under a POL rule;
  notification quick actions.
- **Out of scope:** secrets; mobile; rich form inputs; answering by rule.

## 11. UI module (tables only; the designer details it in `docs/design-handoff/2026-11-14-shaping/CON-10/`)

| Component | State | User sees | Action |
|---|---|---|---|
| Panel | first-run / all caught up / loading / server down | purpose line / "All caught up" + last answer time / skeleton rows / "Can't reach the Conduit server…" | docs / History / — / Retry |
| Panel | populated / first run | two-line cards, soonest needed / a legend card above them (types, then markers) | open (pop-up / tab / terminal) · Got it |
| Filter bar | active / matches nothing | "Filtered: claude-7 · 2 of 9 shown · Clear" / "No requests match these filters" + what they hide | Clear · remove one filter |
| Ended-state copy | answered by default / resolved / orphaned | "Went with the agent's default" / "Cleared by themselves" / "Not delivered: the session was closed" | — |
| Digest | after Away | counts line + open first | Follow up · Dismiss |
| History | empty / populated | "Answered and closed requests appear here for 30 days." / newest first, state word + icon | Open thread · Open terminal |
| Card | open / waiting / with default / escalated / tab-bound / terminal | age / "1:42 waiting" / "default 16:20" / "escalated" / "⧉ 46 lines" / "›_ in terminal" | open |
| Card | Conduit-authored | ⛨ Conduit chip before the ask, shield on the icon | open |
| Pop-up / tab | sending / failed / ended / not found / at cap / remote | "Sending…" / cause / banner: state word + who + when, input greyed, text copyable / "no longer exists" / cap note / "Answer this on studio-pc" | Retry / Allow next time… / Copy · Next / History |
| Session pill | 0 / 1 / N / waiting | hidden / "1 request" / "N requests" (menu) / "◉ Waiting on you 0:46" | opens the pop-up or tab |
| Review tab | clean / edited / too large | "3 lines changed" / Send blocked with a reason | options: Approve with my edits · Approve as written · Reject |
| Waiting notice | 1 / N | "claude-3 is waiting for your approval · 0:47 · Open" / "claude-3 and codex-6 are waiting…" | opens the pop-up |
| Chip / status bar | 0 / n | hidden / "n need you"; "1 waiting 0:58" | opens the panel |
| OS notification | — | "claude-3 needs your approval" | focuses the row |

| Component | Pointer | Keyboard | ARIA |
|---|---|---|---|
| Panel list | click; context menu: Open terminal · Dismiss · Copy link | j/k, Enter | `listbox`, rows `option` named "{type}, {session}, {agent}: {ask}, {why-now}" |
| ⋯ menu | click | ↑/↓, →/← submenus, Space toggles, Esc returns to ⋯ | `menu` with `menuitemradio` / `menuitemcheckbox` groups |
| Pop-up / tab | click | focus on title, trapped; tab order follows the sections; `1–8` guarded; Enter on a picked option or Ctrl+Enter; →; Esc returns to the row | `dialog` labelled by Conduit's header; `radiogroup`; footer zones are groups "This request" and "Queue" |
| Review tab | select | standard editing; Ctrl+Enter = Approve edited | multiline `textbox` labelled by the title |
| Waiting notice | click | not focusable by default; Ctrl+Shift+A opens the pop-up (REQ-D13) | `region` "Waiting for your answer" |

| A11y / i18n rule | Applies to |
|---|---|
| Live region: new requests (coalesced), results, countdowns only at 30 s and expiry | panel, pop-up |
| State = word + icon, never colour alone; visible focus in high contrast | all rows and chips |
| After Send, the pop-up loads the next request and announces it; on Esc focus returns to the row; reduced motion = no slide | panel, pop-up |
| Strings externalised; plural-aware counts; ISO-8601 UTC stored, locale shown; +30 % text; RTL mirror; agent text `dir="auto"` | everything |
| Tokens: existing `attention`, `urgent`, `surface-raised`, `focus-ring`; new `agent-content` quote frame | design review |

## 12. Decisions Needed

**Locked by the owner (2026-11-14, CON-21 moved to Todo):** REQ-D1 = C, one queue · REQ-D21 = (a) one human across own links, (b) read-only remote in NET MVP, (c) wait the full budget with tray + OS notification · REQ-D15 = agent kinds only, never approvals · REQ-D20 = `question` only. The rest of this section is still open unless it is marked a design default.

**Real decisions**
- **REQ-D1 [high] Shape.** A typed messages / B agent-only panel / C one queue. Default and
  recommendation: **C**.
- **REQ-D2 [high] Blocked-agent signal.** A one-line waiting notice that opens the pop-up (iter-6) /
  an answerable floating card (v4.1) / none. Default: **one-line notice**.
- **REQ-D4 [high] `attend` vs session `blocked`.** `attend` replaces the chip entry / both counted once /
  no `attend`. Default: **replace**.
- **REQ-D9 [high] What MVP `attend` relies on.** OSC 7501 / screen patterns / both. Default: **both**.
  Gate: measure which CLIs emit OSC 7501 at their prompts before building. (Deciding prompts is POL-D2.)
- **REQ-D11 [high] OS notification quick actions.** None / Approve and Decline on the toast. Default:
  **none**.
- **REQ-D15 [high] Defaults that auto-apply.** Agent kinds only / never / also approvals. Default:
  **agent kinds only**.
- **REQ-D18 [high] Lead routing.** Human always / `to: lead` opt-in with escalation / leads answer
  anything. Default: **opt-in, v1**.
- **REQ-D20 [high] Prose messages to you.** Surface `question` only / `question` + `request` / none
  (nudge only). Default: **`question` only** (measured: `request` is used for orders).
- **REQ-D21 [high] Attention across machines and with no window** (replaces NET-D5).
  - (a) `you` is one human across own links, with presence and Away per owner, merged. Default: **yes**.
  - (b) NET MVP shows remote asks, items and messages to `you` read-only in Machines ("answer on <machine>").
    Default: **read-only in MVP, answerable in v1**.
  - (c) The 5 s no-window deny: keep / **wait the full budget with tray + OS notification** / wait only
    when a remote own GUI is connected. Default: **wait the full budget**. A headless box's asks then
    live for their budget, not 5 s.

**Design defaults** (override only if you disagree):
- REQ-D3: a new `request_input` tool family.
- REQ-D5: `wait_s` = budget − 10 s.
- REQ-D6: the panel is a right-pane tab.
- REQ-D7: no approve-all.
- REQ-D8: caps as in §4.6.
- REQ-D10: no secret kind.
- REQ-D12: no prose nudge in MVP.
- REQ-D13: Ctrl+Shift+A opens the soonest waiting request's pop-up (Allow once focused for a permission),
  else opens the panel with the list focused (designer iter-6; to be checked against existing keymaps).
- REQ-D16: Away explicit in MVP, idle suggestion in v1.
- REQ-D17: presence visible to agents.
- REQ-D19: outside channels are notify-only, in vision.

**Owned elsewhere:** POL-D2 (deciding native prompts); POL-D17 (an agent request is one Activity row
linked to History; was REQ-D14); POL-D15 (outbound messages to guests); NET-D7 (guest v1 scope); POL-D7
(grant durations and decay); POL §4.5 / NET §5 (caps).

## Revision log

- v1: draft, independent review (25 findings), sibling alignment.
- v2 (lead review): "For the user", Away/defaults/digest, lead escalation, outside channels, prose
  questions, anti-spoofing.
- v3 (cross-spec r1 + rulings): finding-by-finding map in
  `docs/runs/2026-11-14-shaping/reviews/req-v3-changes.md`.
- v4 (cross-spec r2): N1/R19 any `opened_by` ancestor may answer or escalate; N3/R21 remote lead uses
  `messaging`; N6/R23 merged presence in MVP with NET; N10 `expired` gloss; N11 lead answers marked v1.
  Designer iter-4: sidebar only for blocked-on-you, the ended-state copy, the Ctrl+Shift+A rule, grouping → v1.
- v4.1 (owner, 2026-11-14): `confirm` and `choose` always offer a free-text answer; the agent can't disable it.
- v4.2 (owner review of designer iter-5 → iter-6): the panel becomes a one-line list; light requests open in a pop-up, heavy ones as a tab beside the requester (size rule §4.4); permission in the pop-up; dock → session pill, floating card → waiting notice, thread card → link.
- v4.5 (owner): REQ-D1, D21, D15, D20 locked at their defaults for the CON-21 build.
- v4.4 (owner, 2026-11-14): requests carry `space`, `lead` (root of the `opened_by` chain) and `machine`; the list filters by session, lead group, space, type and machine. Machinery and UX split into CON-21 and CON-20.
- v4.3 (owner review of designer iter-6 → iter-7): three UI types (Approve · Answer · Review) over the kinds, with a Conduit mark and a separate open marker; two-line cards with ⋯ sort/filter/show; one Header · Context · Answer · Footer template; decline becomes an option, and Skip = `dismissed` (`choose`/`text` drop `declined`).
