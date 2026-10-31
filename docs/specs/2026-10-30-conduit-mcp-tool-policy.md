---
status: draft
date: 2026-10-30
---

# Feature Spec: Conduit MCP tool policies

**Tier:** FULL   **Feature type:** non-UI (policy model, MCP tools, host↔renderer protocol), with
a UI surface: the policy editor in Settings and the session dialog, and the approval card.
**Request:**
- "Add more tools to the MCP so the agent can control the app: open/close a session, open/close
  files, go to review mode, attach a folder, open a website, open a commit or branch."
- Then: "We need some sort of a conditional that's not just true or false but also gives us a
  range for when this happens, the behavior of these tools, and who can see and access it."

Builds on [conduit-mcp-control-tools](2026-10-27-conduit-mcp-control-tools.md). This spec reuses
from it: the gate, the rate limiter, placement and `list_changed`. It **replaces** that spec's
boolean switches (`mcpTools`, `mcpToolOverrides`) with policies.

Sibling spec: [conduit-mcp-app-control](2026-10-30-conduit-mcp-app-control.md) (Part B, the seven new tools built on this policy system).

**Two parts, built in order.** Part A, the policy system, comes first, and the three existing
control tools move onto it. Part B, the seven new tools, is built on Part A.

## 1. Problem frame

- **Job:**
  - Let the human decide, per tool, *whether*, *when*, *for which agents*, *against which
    sessions* and *with what screen effect* an agent may act.
  - Tune those choices over time without code changes.
  - Then give agents enough tools to show and arrange things in the app when the human asks.
- **Actors:**
  - the human (sets policies, approves "ask" calls, views the result);
  - the caller (an agent CLI in a session, resolved from its token as today);
  - the MCP host (resolves the policy, gates, asks, executes);
  - the renderer of the caller's window (approval card, UI actions, outcome reports).
- **Success outcomes:**
  - every tool call is allowed, asked or refused by one resolved policy, and the refusal names
    the reason;
  - the Settings and session dialogs show the effective policy and where each field comes from;
  - the new tools do what the equivalent UI action does and return what actually happened.
- **Non-goals:**
  - agent communication surfaces: plan/architecture "show" tools, change map, guided walkthroughs
    (human: "skip for now");
  - GitHub PR review (human: it was only an example);
  - policies keyed on time of day, project, or argument patterns (e.g. URL allowlists);
  - per-project policy layers;
  - reading terminal output, renaming, settings changes over MCP.

## 2. Behavior & states

### 2.1 Policy model (Part A)

Each tool has a **policy** with up to four fields. Some fields don't apply to some tools; the
table in §3.2 says which.

| Field | Values | Meaning |
|---|---|---|
| `access` | `off` · `ask` · `on` | `off`: not listed and refused. `ask`: each call waits for the human's Approve/Deny. `on`: runs. |
| `when` | `viewing` · `always` | `viewing`: only while the caller is on screen in its window (§2.3). |
| `reach` | `self` · `opened` · `window` · `any` | Which sessions a session-targeting tool may act on: the caller only; the caller plus the sessions it opened (`Session.openedBy`); any in the caller's window; any session. |
| `move` | `yes` · `no` | Whether the tool may change which session you are looking at. With `no`, a `focus:true` session open runs as `focus:false`, and `focus_session` is refused. |

**"Who" is the layer**, not a field. A policy resolves **field by field** through three layers,
and the most specific set value wins:

1. **Session override:** `Session.mcpToolPolicy[tool]` (partial). It replaces
   `mcpToolOverrides`.
2. **CLI layer:** `settings.mcpToolPolicyByCli[kind][tool]` (partial). `kind` ∈ `claude`, `codex`,
   `cursor`, `opencode`, `agent`.
3. **Global:** `settings.mcpToolPolicy[tool]` (complete; coerced to defaults).

The master switch `conduitMcp` stays above all three: off means every tool returns
`messaging_off`.

**The CLI kind follows the session's handle.**
- The kind is the persisted handle's prefix (`Session.mcpHandle`, types.ts:114). The prefix is
  minted from the agent definition's adapter at launch (`claimHandle`, conduit-mcp-host.ts:1126
  and :648). In a plain shell it comes from the first `initialize`'s `clientInfo` instead (:770).
- A re-mint after a collision (session-registry.ts:17) keeps the prefix. `fake` maps to `agent`.
- **Consequence (stated in the Settings copy):** a shell session where `claude` ran first stays on
  the Claude layer even if `codex` runs there later.
- In a plain shell the prefix comes from self-asserted `clientInfo`, so the CLI layer is a
  convenience, not a security boundary.

### 2.2 Call lifecycle

`received → resolve policy → gate (refused) → validate (refused) → [ask: pending → approved |
denied | expired | cancelled] → execute → [awaiting renderer] → done | error | ui_timeout`

Nothing is retried. A late renderer reply after `ui_timeout` is dropped, and the result says the
outcome is unknown.

### 2.3 The `viewing` condition

- **On screen** means the caller is in its owner window's visible set: the active session or the
  split partner, as the renderer reports with `{type:'visible', ids}`.
- **New host query:** `isOnScreen(sessionId)`.
  - It is **fail-closed**: it is true only if the owner window has reported since its last load
    and the id is in that report.
  - Minimised and background windows count; OS focus is ignored (A2).
  - It must not reuse `gitDemand.isVisible` (that excludes suspended windows), nor the
    "unreported = visible" default in `session-resource-demand`.
- **Per-window readiness (new; today it is one global latch, main.ts:1195):**
  - `did-start-loading` clears that window's visible set and marks it not ready;
  - the renderer's next `ready` marks it ready.
- **Consequence, stated in tool descriptions:** a call that moves the human away ends the
  caller's `viewing` access.
  - Examples: `open_session` with `focus:true`, and `focus_session`.
  - A lead spawning several sessions passes `focus:false` for all but the last.

### 2.4 `ask`: the approval card

- **When it runs:** after gate and validation, so the card shows resolved targets (e.g. "close
  `codex-2`, 2 terminals running"). The MCP call stays open while the card waits.
- **Where it appears:** a non-modal card in the caller's owner window, stacked above toasts.
  - It never takes DOM focus, so keys typed into the terminal never answer it.
  - It adds 1 to the top-bar attention chip.
- **Card content:**
  - caller handle and tool;
  - a one-line plain-language summary of the arguments, plus an expandable raw-arguments block;
  - the policy field that caused the ask.
- **Actions:**
  - **Approve:** runs once.
  - **Deny:** returns `denied`.
  - **Always for this session:** writes `access:'on'` into that session's override, then runs.
- **Ending the wait:**
  - **Expiry:** the call returns `approval_timeout` after the ask timeout, which is per caller CLI
    kind and sits below that CLI's documented MCP call timeout (§5).
  - **Cancelled:** the card is removed when any of these happens:
    - the CLI sends `notifications/cancelled{requestId}` (Esc in the CLI, or the CLI's own
      timeout): **no reply is sent** for that request (MCP: the receiver should not respond
      after a cancellation);
    - the caller's connection closes (`conn.onClose`, host:842): there is no one to reply to;
    - the caller session closes, or the window closes or reloads: the call returns `cancelled`.
  - **Prerequisite:** today the JSON-RPC core drops every notification (json-rpc.ts:84), and
    `deps.call` sees neither the request id nor the connection (json-rpc.ts:96, host:806). Both
    get threaded through to the pending-ask map.
  - Calls on one connection already run concurrently (host:813), so a waiting ask doesn't stall
    other calls.
- **When the human can't see it:** if the owner window isn't the OS-focused window, the host also
  flashes its taskbar entry (`flashFrame`), as other attention does.
- **Caller side:** while its ask waits, the caller's session card shows "Waiting for your
  approval", which counts as attention.
- **Several waiting asks:**
  - they show as one card with a "1 of N" pager, oldest first;
  - at most 3 can wait per caller; a 4th returns `rate_limited`.

### 2.5 Primary flow (ask)

1. The human asks "close codex-2".
2. Claude calls `close_session({session:'codex-2'})`.
3. Policy: `ask` / `viewing` / `window`. Gate and reach pass.
4. The card shows "claude-1 wants to close codex-2". Approve → the renderer checks codex-2's
   dirty tabs and closes it in the same turn → `{closed}`.

### 2.6 Current behaviour this depends on

| Claim | How established | Status |
|---|---|---|
| A saved v0.50 settings file holds all 7 `mcpTools` keys, so a user-set `false` can't be told from the default | source: `updateSettings` persists the coerced object, main.ts:3869, settings.ts:540 | read from source |
| Only successful opens are charged to the rate limit; `open_file` isn't limited | source: control-tools.ts:166-185, 223 | read from source |
| CLIs' own MCP call timeouts (how long an `ask` may wait) | — | **ASSUMED**; measured at S0 (D3) |

## 3. Data / interface contract

### 3.1 Types (`src/conduit-mcp/tool-policy.ts`, Node-free; replaces tool-switches' booleans)

```ts
type Access = 'off' | 'ask' | 'on';
type When = 'viewing' | 'always';
type Reach = 'self' | 'opened' | 'window' | 'any';
type Move = 'yes' | 'no';
type ToolPolicy = { access: Access; when?: When; reach?: Reach; move?: Move }; // only applicable fields
type PolicyLayer = Partial<Record<ToolName, Partial<ToolPolicy>>>;
type CliKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'agent'; // handle prefix; 'fake' → 'agent'

resolvePolicy(tool, { session?: PolicyLayer, cli?: PolicyLayer, global: Record<ToolName, ToolPolicy> })
  → { policy: ToolPolicy; source: Record<keyof ToolPolicy, 'session' | 'cli' | 'global'> }
```

- **Coercion:** unknown keys are dropped. A field that doesn't apply to the tool is dropped. An
  invalid value takes the next layer's value. Coercion never throws.
- **Settings:** `settings.mcpToolPolicy` is complete; `settings.mcpToolPolicyByCli?:
  Partial<Record<CliKind, PolicyLayer>>`.
- **Session:** `Session.mcpToolPolicy?: PolicyLayer` (persisted in sessions.json). As today, it is
  never copied to sessions the caller opens.
- **Migration (read-time, one way):**
  - `mcpTools[t] === true`, or an override `true`, → `{access:'on', when:'always'}`. That keeps
    v0.50 behaviour; an off-screen lead keeps working.
  - `false` → the new default (§3.2). v0.50 can't tell a user-set `false` from the default, since
    it persists the full object.
  - Other fields → defaults.
  - Old keys are removed on the next write.
  - Downgrading to v0.50 loses the policies and falls back to v0.50's defaults (stated, accepted).
  - CHANGELOG names the widening (`open_file` off→on) and the new asks.
- **Writers:**
  - The global and CLI layers are written through the existing whole-object `updateSettings`
    (main.ts:3866). It already triggers `mcpHost.refresh()` → `list_changed`. There is one writer,
    with no host-side settings mutation.
  - The session layer uses `mcp:setToolPolicy`, which replaces `mcp:setToolOverride` and keeps its
    `requestId` + result reply (host:1343-1356).

### 3.2 Applicable fields and defaults

| Tool | access | when | reach | move | Notes |
|---|---|---|---|---|---|
| `list_sessions`, `send_message`, `read_inbox`, `read_attachment` | **on** | — | — | — | messaging: access only (`ask` not offered) |
| `open_file` | **on** | viewing | — | — | always opens in the caller's session (app-control spec §3.1) |
| `open_review`, `open_git_history`, `open_url`, `close_files` | **on** | viewing | — | — | act on the caller's own session only |
| `focus_session` | **on** | viewing | window | yes | `move:no` makes it refuse |
| `attach_folder` | **ask** | viewing | self | — | |
| `open_session` | **ask** | viewing | — | yes | was off |
| `close_session` | **ask** | viewing | window | — | |
| `open_terminal` | **off** | viewing | — | yes | arbitrary code execution as the user |

`ask` for messaging tools isn't offered: a card per `read_inbox` is noise. `reach:any` is offered
only for `focus_session` and `close_session`.

The seven new tools (`close_session`, `focus_session`, `attach_folder`, `close_files`, `open_review`, `open_git_history`, `open_url`) are specified in the [app-control spec](2026-10-30-conduit-mcp-app-control.md); the rows above are their policy defaults.

### 3.3 Errors and precedence

1. `not_in_session`
2. `messaging_off`
3. `tool_disabled` (`access:off`)
4. `window_not_ready`
5. `caller_not_visible` (`when:viewing`)
6. `rate_limited`
7. Argument and target checks:
   - `unknown_session`;
   - `out_of_reach` (names the policy's reach, never other sessions);
   - `move_not_allowed`;
   - `bad_ref`, `bad_url`, `not_a_repo`;
   - existing path errors.
8. Ask: `denied`, `approval_timeout`, `cancelled`
9. Execution: `unsaved_changes`, `ui_timeout`

A refusal at steps 1–5 reveals nothing about targets.

**Rate (a deliberate change from v0.50):**
- Two budgets per caller:
  - **act** (`open_session`, `open_terminal`, `close_session`, `attach_folder`): the existing
    10/min per caller and 20/min global;
  - **show** (`open_file`, `close_files`, `open_review`, `open_git_history`, `open_url`,
    `focus_session`): 30/min per caller. `open_file` was unlimited before.
- As today, a refusal at step 7 or 9 refunds the token.
- A denied, expired or cancelled ask keeps its token, which caps card spam.

### 3.4 Host↔renderer messages (new)

| Direction | Message |
|---|---|
| Host→renderer | `{type:'mcp:ask', askId, callerSessionId, callerHandle, tool, summary, args, source: 'session'\|'cli'\|'global'}` (the layer that set `access:'ask'`) |
| Host→renderer | `{type:'mcp:askClosed', askId, outcome}` (cancel/expiry) |
| Renderer→host | `{type:'mcp:askAnswer', askId, answer:'approve'\|'deny'\|'always'}` |
| Renderer→host | `{type:'mcp:setToolPolicy', requestId, sessionId, tool, patch: Partial<ToolPolicy> \| 'inherit'}` (session layer only; replaces `mcp:setToolOverride`, same result reply) |

- **Routing:** everything goes to the caller's owner window. A window close or
  `did-start-loading` fails its pending UI requests with `window_not_ready` and cancels its asks.
- **Pending asks after a reload:** they are cancelled, never re-shown.

### 3.5 Producers / consumers

§3.1 and §3.4 name both sides of every new flow. Only these rows need saying:

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Visible set + readiness | renderer `visible` / `ready`; `did-start-loading` | **new** `isOnScreen`, pending maps | Yes. The existing attention and gitDemand consumers keep their own semantics |
| Codex `default_tools_approval_mode="auto"` | install entry | Codex | Unchanged, on purpose: `ask` is Conduit's own gate, so Codex's auto-approve no longer bypasses the human |

## 4. Edge cases & failure modes

| Condition | Behaviour |
|---|---|
| A policy changes while an ask is waiting | The ask stays and is decided by the human. A change to `off` cancels waiting asks for that tool (`cancelled`). |
| A policy changes the listed tools | `list_changed`, as today (a tool is listed iff `access ≠ off`). |
| The same call is answered in two places | Only one card exists (the owner window). The first answer wins and later ones are ignored. |
| "Always for this session" on a session with a CLI-layer `off` | The session override wins (most specific). |
| "Always for this session", then the CLI layer changes | The session keeps `access:on` for that tool until it is reset to Inherit in the dialog. |
| `when:always` and the ask lands in a background window | The taskbar flashes and the chip counts it. Unanswered, it expires. |
| The CLI user presses Esc while an ask waits | `notifications/cancelled` → the card is removed and the action never runs. |
| The caller switches away while its ask waits | The ask stays. `viewing` was checked at call time and isn't re-checked at approval: the human answering is the consent. |
| A lead opens 3 sessions with `focus:true` and `when:viewing` | The 2nd and 3rd fail `caller_not_visible`. Documented: use `focus:false`, or set `when:always`. |
| `reach:opened` and a target the caller opened before a relaunch | `openedBy` is persisted, so it still counts. |
| A settings file holds an unknown access value or tool name | Coerced to the next layer or the default; the unknown name is dropped. |
| Window reloads mid-call | `window_not_ready` for UI calls; asks are `cancelled`. |
| Rate | Act and show budgets (§3.3). Up to 3 asks can wait per caller. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Per-tool policy | §3.2 table | Global, per CLI, per session | Human ruling: tune later instead of fixing it in code |
| `when` | `viewing` everywhere | Yes | Human ruling: act only for the session being viewed |
| Ask timeout | Per caller CLI kind: claude 120 s, codex 50 s, cursor 50 s, opencode 25 s, agent 25 s (each below that CLI's documented MCP call timeout, D3) | No | A card that outlives the CLI's call would run an action nobody waits for |
| Renderer reply timeout | 5 s | No | Every UI action is a single dispatch |
| Max waiting asks | 3 per caller | No | Card spam guard |
| Close confirms over MCP | None beyond the policy (`ask` is the confirm) | Via `access` | One consent mechanism |

## 6. Scope slicing

- **S0 (measure first):**
  - each CLI's MCP tool-call timeout and whether it sends `notifications/cancelled` on timeout or
    Esc (D3);
  - whether `list_sessions` exposes handle-less sessions (A7);
  - whether every CLI accepts the new schemas.
- **MVP, Part A:**
  - `tool-policy.ts` (types, resolve, coerce, migrate);
  - settings and session persistence;
  - CLI-kind pinning;
  - `isOnScreen` and per-window readiness;
  - the gate on policy;
  - ask: card, chip, answer, cancel;
  - the policy editor in Settings (global plus a CLI picker) and in the session dialog;
  - the three existing tools moved onto policy, with the `open_file` routing change;
  - e2e: off/ask/on, `viewing` refusal, reach refusal, migration from v0.50 settings.
- **v1 (policy):** a per-project layer, and an approvals history list.
- **Out of scope:** argument-pattern policies (URL/path allowlists), time-based policies, and PR
  review.

## 7. Acceptance criteria

**EARS**

- The host shall resolve each policy field independently: session override, then CLI layer, then
  global.
- While a tool's resolved `access` is `off`, `tools/list` shall omit it and a call shall return
  `tool_disabled`.
- When a call's resolved `access` is `ask` and it passes the gate and validation, the caller's
  window shall show a card naming the caller, tool and resolved targets. The tool shall run only
  after Approve.
- If the human denies, or the ask timeout passes, then the call shall return `denied` or
  `approval_timeout`, and nothing shall change.
- When "Always for this session" is chosen, the session's override shall gain `access:'on'` for
  that tool, and the call shall run.
- While `when` is `viewing` and the caller isn't on screen, the host shall return
  `caller_not_visible`. No `mcp:ui`, `mcp:ask`, `openFileInEditor` or `activateSession` message
  shall be sent, and the window's docs, active and split shall be unchanged.
- If a session-targeting call's target is outside `reach`, then the host shall return
  `out_of_reach`.
- While `move` is `no`, a `focus:true` session open shall create the session without activating
  it, and `focus_session` shall return `move_not_allowed`.
- When a window reloads, its waiting asks shall return `cancelled` and its pending UI calls
  `window_not_ready`.
- On first start after upgrade, a v0.50 settings file with `open_session: true` shall resolve to
  `{access:on, when:always}`, and the old keys shall be gone after the next write.
- When the CLI sends `notifications/cancelled` for a call waiting on an ask, the card shall be
  removed and the tool shall not run.

**Gherkin**

```gherkin
Feature: Tool policies

  Scenario: Codex asks before closing a session
    Given close_session resolves to access "ask" for codex sessions
    And "codex-2" is on screen
    When codex-2 calls close_session for "claude-3"
    Then a card in codex-2's window reads "codex-2 wants to close claude-3"
    When the human denies
    Then the call returns "denied" and claude-3 is still running

  Scenario: Session override beats the CLI layer
    Given open_url is "off" for the codex layer
    And codex-2's session override sets open_url access "on"
    Then codex-2's tools/list includes open_url
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Settings → MCP tools | Global layer | Rows grouped **Messaging**, **Sessions** (open_session, open_terminal, close_session, focus_session, attach_folder) and **Editor & views** (open_file, close_files, open_review, open_git_history, open_url), replacing the old "Control" group. Each row has an Access segmented control (Off · Ask · On), plus a "Conditions" disclosure with the applicable When / Reach / Move selects. | Edit |
| Settings → MCP tools | CLI layer | A "Defaults for: All CLIs · Claude · Codex · Cursor · OpenCode · Other" picker above the list. Each field gains **Inherit** and shows the inherited value muted ("On · from All CLIs"). | Edit / Inherit |
| Session MCP tools dialog | Session layer | Same editor; every field has Inherit; the source is shown ("Ask · from Codex"). | Edit / Inherit |
| Row | Field not applicable | The field isn't rendered (no disabled controls) | — |
| Row | `open_terminal` / `close_session` set to On | A one-line warning under the row: "Runs without asking. Codex never asks on its own." | — |
| Approval card | Waiting | Caller handle, tool, summary, a raw-args disclosure, and the reason ("Ask: set for Codex"). Buttons: Deny, Approve, Always for this session. | Answer |
| Caller's session card | Ask waiting | A "Waiting for your approval" badge (attention) | Click → focuses the card |
| Approval card | Several waiting | "1 of N" pager | Prev / next |
| Approval card | Expired or cancelled | The card leaves; a toast reads "Request from codex-2 expired". | — |
| Attention chip | Asks waiting | The count includes asks; clicking it focuses the first card | Click |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Access control | Set Off/Ask/On | Click a segment | Arrows within the radiogroup, Tab between rows | — | `radiogroup`, labelled "<tool> access" |
| Conditions | Expand; set fields | Click | Enter/Space on the disclosure; selects are native | — | `button` with `aria-expanded`; `select` with labels |
| CLI picker | Choose a layer | Click | Arrows | — | `tablist` (the layers are views of one list) |
| Approval card | Approve / Deny / Always / page | Click | Reached via the chip or F6 pane cycling (never auto-focused). Enter activates the focused button. Esc moves focus back without answering. | — | `region` labelled "Agent request"; arrival announced through a polite live region |

No touch target (desktop app). Buttons follow the existing hit-size tokens.

## 10. Accessibility & i18n (UI)

- **Focus:** cards never auto-focus. Enter typed in the terminal can't approve, by construction
  (§2.4).
- **Announcements:** arrival is announced politely: "codex-2 requests close_session". Expiry is
  announced too.
- **Colour:** the "Ask" segment and the card don't rely on colour alone. They carry text labels
  and the reason line. Forced-colors mode uses system colours, with the existing focus ring.
- **Strings:** all new strings go in `webview/conduit-mcp-strings.ts`.
  - The `description` map is `satisfies Record<ToolName,string>`, so all seven new descriptions
    are required.
  - Summaries are built from per-tool templates with placeholders, never concatenated fragments.
  - Tool names and handles stay literal.
- **Layout:** the card is at most 360 px wide and wraps long paths. Raw args are in a scrollable
  monospace block.

## 11. Design tokens (UI)

Existing tokens only (segmented, raised surface, attention accent, danger text, focus ring), in all
three themes.

## 12. Assumptions

- **A1:** On screen = in the window's visible set (active + split).
- **A2:** OS focus and minimised windows are ignored.
- **A3:** `viewing` is checked at call time only; approving an ask is the consent even if the
  human has since switched.
- **A9:** The CLI layer keys on the handle prefix (§2.1). It is a convenience, not a boundary; the
  copy says so.

## 13. Decisions Needed

- [normal] **D1:** Starting defaults (§3.2) change two v0.50 defaults: `open_file` off→on and
  `open_session` off→ask. The default taken is the table, as agreed in chat.
- [normal] **D2:** "Always for this session" writes a persistent override. The alternative is
  in-memory until relaunch. Default: persistent, since it is visible and reversible in the dialog.
- [normal] **D3:** The ask timeout. Resolved from the CLIs' documented limits (research
  2026-10-30; documented, not measured): a per-CLI-kind table (§5), not one flat value.
- [normal] **D4:** Whether the CLI layer ships in the MVP. It is about a third of Part A's UI
  surface, and it keys on a convenience signal. Default: **ship it**, because "who can access it"
  was part of the request. The alternative is global + session layers now and the CLI layer in v1.

## 14. Open questions

None blocking. The reviews (r1 on tools, r2 on policies) are logged in the run report.
