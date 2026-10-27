---
status: active
date: 2026-10-27
---

# Feature Spec: Conduit MCP control tools and per-tool switches

**Tier:** FULL   **Feature type:** UI (Settings section, session dialog) + host (MCP tools, launch)
Builds on [conduit-mcp-server](2026-10-25-conduit-mcp-server.md) (identity, handles, error shape)
and [conduit-role-brief](2026-10-26-conduit-role-brief.md) (§3.4: agents never set a brief).

**Request (verbatim, condensed):** "get the MCP server for Conduit functional with the most
important bits first… allowing an agent to open a new session… open a new terminal session
somewhere else and run `cursor agent` or anything… open a file… use one session as the main Claude
session. Then that Claude session could set up work trees and spin up a new Conduit session that I
can use to drive that new ticket folder or specific work tree." Follow-up: "settings… which tools
are available… global control… right-click on a session… override the global settings, opting in
or out of certain MCP tools."

## 1. Problem frame

- **Job:** the human runs one main agent session that sets up worktrees with git and opens a new
  Conduit session there (an agent profile or any command) and files to look at, so the human can
  switch to it and drive it. The human decides which sessions may do this.
- **Actors:**
  - the human (Settings, the session menu);
  - the calling agent (an MCP client in a Conduit session);
  - the host (validates, launches, opens);
  - the renderer (shows and focuses the result).
- **Success outcomes (observable):**
  - With control enabled for the main session, one `open_session` call creates a session in a
    given folder. It sits in the caller's window and project and is active when `focus` is true.
  - `open_terminal` runs a free-form command (e.g. `cursor-agent`) in a new session the same way.
  - `open_file` opens a file, at a line if one is given, in the caller's window.
  - A session without the switch can neither see nor call the control tools.
- **Non-goals:**
  - **Worktree tools.** The agent runs git itself.
  - **An initial task or brief over MCP.** The caller sends the task with `send_message` to the
    returned handle. This keeps role-brief §3.4.
  - Closing, renaming or killing sessions over MCP.
  - Reading terminal output over MCP.
  - Changing settings or switches over MCP.
  - Bringing the OS window to the front.

## 2. Behavior & states

**Primary flow (main Claude → worktree session):**
1. The human enables `open_session` for the main Claude session (right-click → **MCP tools…**), or
   globally in Settings.
2. Claude runs `git worktree add ../wt/TICKET-1 -b TICKET-1`.
3. Claude calls `open_session({path: "../wt/TICKET-1", agent: "codex", focus: true})`.
   - The host resolves the path against the caller's home and validates it.
   - It creates the session through the same path as the New session dialog, with the default
     brief, the caller's project and the caller's window.
   - It activates the session in that window and returns `{session_id, handle, label}`.
4. Optionally, Claude calls `send_message({to:[handle], body: task, kind: "request"})`. This is
   the existing messaging, with provenance framing.
5. The human clicks into the new session and drives it.

**Tool availability (per call and per `tools/list`):**

```
effective(session, tool) = session.mcpToolOverrides?.[tool] ?? settings.mcpTools[tool]
```

- **Gate order on every `tools/call`:**
  1. `not_in_session`
  2. master `conduitMcp` off → `messaging_off`
  3. `effective` false → `tool_disabled`
  4. Only then the tool's own checks. `store_unavailable` applies to the messaging tools only;
     the control tools never touch the message store.

  Tool names reach the gate, never an earlier `invalid_argument` from an unknown-name check.
- **`tools/list`:**
  - With the master on, it returns only the tools effective at the moment it is asked.
  - With the master off, it lists every tool, as today, and each call returns `messaging_off`.
- **Scope of the switches:** they gate **agents only**. The human's own UI paths (compose, the
  Messages tab) are unaffected. The override IPC is validated host-side: the session must exist,
  the tool name must be known, and the value must be a boolean or "inherit".
- On any change that alters a live connection's effective set, the host sends
  `notifications/tools/list_changed` to that connection and advertises
  `capabilities.tools.listChanged: true`. Client support is uneven (see the table below), so the
  call-time check is the guard. The list is a convenience.
  - "Live connection" means one that completed `initialize`.
  - The hook is the existing `mcpHost.refresh()` on settings update, plus the override IPC,
    diffing each connection's previous effective set.

**Session creation states (host):** `requested → validated → created`. The tool returns at
`created`.
- Every failure is detected before anything is created: the path, the agent, the command
  resolving (`resolveCommand`), and the brief.
- The spawn itself is renderer-driven: the owner window mounts the pane and sends `term:start`.
  Later spawn problems therefore show in the session exactly as for a UI-made session (stale +
  error) and are not reported to the caller.

**Current behavior (what this changes):**

| Claim | How measured | Status |
|---|---|---|
| `tools/list` is per connection: a forged token gets `[]` | `conduit-mcp-host.test.ts` "invalid token → tools/list []", run 2026-10-27 (pass) | Measured |
| The server declares `tools.listChanged: false` and sends no list_changed | `json-rpc.ts:84`, read | ASSUMED (source read) |
| A session can only run a registered definition (`agents.json`, shells, `custom:` launchers); no per-session command. Launch consumers key on the definition (`term:start` agentId, `resolveLaunchSpec`, `prepareLaunch`, `roleBriefs.prepareSpawn`, cwd reporting); `duplicate` re-creates from `agentId` + `home` | `session-manager.ts:93` throws `Unknown agent`; review r1 traced the call sites | ASSUMED (source read) |
| `autoSwitchSession` defaults to true | `settings.ts`, read | ASSUMED (source read) |
| `parseSessions` passes unknown fields through unvalidated | `persistence.ts:93` | ASSUMED (source read) |
| Only sessions whose definition matches an adapter (claude/codex/cursor) get a handle and MCP | `conduit-mcp-host.ts:737`, `adapters.ts:101` | ASSUMED (source read) |
| With `autoSwitchSession` on, the renderer activates the newest new running session | `app.tsx:~801` | ASSUMED (source read) |
| `openFileInEditor` has no line/column | `protocol.ts:695` | ASSUMED (source read) |
| Mid-session list_changed: Claude Code partial, Cursor CLI ignores it, Codex unknown | web: Cursor forum #161459, claude-code #62058/#31893 | ASSUMED → measured in S0 |

## 3. Data / interface contract

### 3.1 New tools

All paths: absolute, or relative to the **caller's persisted home** (never the OSC cwd, which is
agent output; same rule as attachments).

| Tool | Input | Output |
|---|---|---|
| `open_session` | `path` (dir), `agent` (definition id; the schema's `enum` lists the user-visible ids registered when `tools/list` ran: agents.json, shells, `custom:` launchers; never the e2e fake outside e2e or the internal `command` id), `label?` (≤ 80), `focus?` (default `true`) | `{session_id, handle: string\|null, label, agent}` |
| `open_terminal` | `path` (dir), `command` (≤ 1 KB), `args?: string[]` (≤ 64 entries, ≤ 8 KB total), `label?`, `focus?` (default `true`) | same as above |
| `open_file` | `path` (file), `line?` (1-based), `column?` (1-based), `focus?` (default `true`) | `{opened: path, session_id}` |

- **`open_session`:**
  - `agent` covers the shells (`shell:pwsh`, `shell:gitbash`, …).
  - The session gets the definition's default brief, exactly as the New session dialog's
    default. No brief parameter exists.
  - If that brief can't be prepared, the tool refuses with `brief_unavailable` rather than
    launching without the human's brief.
- **`open_terminal`:**
  - `command` and `args` are passed to the PTY spawn as argv, never through a shell string.
    Pipes and `&&` therefore need an explicit shell, e.g. `command: "pwsh", args: ["-c", "…"]`.
  - The session persists `command`/`args`, so **Relaunch** and restore re-run the same command.
  - If the command's leaf matches an adapter (`claude`, `codex`, `agent`/`cursor-agent`), the
    session gets MCP wiring and a handle like a profile session. Otherwise `handle` is `null`.
  - The default label is the command leaf.
- **`open_file`:**
  - It opens in the doc tabs of the session that owns the path (the existing
    `resolveOwningSession`, the same as an OS open). Otherwise it opens in the **caller's**
    session; it never creates a session.
  - It opens in the window of the session it opens in.
  - `focus: true` activates that session and the file's tab; `false` opens the tab in the
    background.
  - `openFileInEditor` gains `line?`, `column?` and `focus?`. The renderer routes MCP opens
    through `openFile(…, {reveal})` and the `'background'` mode (as `openTerminalFileLink` does)
    instead of the OS-open flush's forced editor/`'permanent'`. OS opens are unchanged.
  - **Out-of-root files** (the path is in none of the target session's roots) open in the text
    editor only. No viewer that would mint a `conduit-preview:` root outside a session's roots
    (ADR 0005 unchanged).
- **Placement:**
  - A new session belongs to the caller's owner window. If that window is gone, it goes to the
    primary window.
  - It joins the caller's `projectId`; with none, there's no project.
  - Its roots are the existing initial-roots resolution for that home.
- **Inheritance:** a session created by these tools starts with **no overrides**: global defaults
  only. It never inherits the caller's overrides, so a control switch can't spread on its own.
  Duplicate doesn't copy overrides either.
- **Side effects shared with the dialog path:** MCP opens do **not** bump launcher usage and do
  **not** add the folder to recents (`repos.json`). An agent loop must not churn the human's
  launcher ranking or recents.
- **Focus mechanics:**
  - **`focus:false`:** the host sends a transient `suppressAutoSwitch{sessionId}` to the owner
    window **before** the state post that introduces the session. It's the same webContents, so
    the order holds. The autoSwitch effect skips that id. Nothing is persisted.
  - **`focus:true`:** the host sends `activateSession{sessionId}` **after** that state post, so it
    works whether `autoSwitchSession` is on or off.

### 3.2 Errors

The existing `{error: {code, message, retryable}}` shape. New codes:

| Code | Meaning | `message` content |
|---|---|---|
| `tool_disabled` | Not effective for the caller | Names the tool. Doesn't say how to enable it (agents shouldn't nag) |
| `unknown_agent` | `agent` is not registered | Lists the registered ids |
| `path_missing` | Path not found | — |
| `not_a_directory` / `not_a_file` | Wrong kind of path | — |
| `invalid_args` | Malformed input | — |
| `command_not_found` | `command` doesn't resolve on PATH or as a path | Nothing is created |
| `brief_unavailable` | The definition's default brief can't be prepared | Nothing is created |
| `open_failed` | Conduit threw while opening (added at build, review r1) | The thrown message; the rate slot is not charged |

Reused codes: `not_in_session`, `messaging_off`, `rate_limited`.

**Rate limits** on `open_session` + `open_terminal`:
- at most 10 per caller per minute;
- at most 20 per minute across all callers, which caps fan-out when control is on globally.

### 3.3 Settings and persisted state

- **`settings.mcpTools: Record<ToolName, boolean>`** in `settings.json`, coerced per key. Missing
  or invalid keys take the defaults: the four messaging tools `true`; `open_session`,
  `open_terminal`, `open_file` `false`. An unknown key is dropped.
- **`Session.mcpToolOverrides?: Partial<Record<ToolName, boolean>>`** in `sessions.json`. An absent
  key means inherit.
- **`Session.command?: {command: string; args: string[]}`**, only for `open_terminal` sessions.
  - **One seam:** `effectiveDef(session)` (main) returns the registered definition, or, for a
    `command` session, a synthesized definition (internal id `command`, label = command leaf,
    generic terminal icon, `cwdStrategy` as shells).
  - Every launch consumer resolves through this seam: the `term:start` spec,
    `resolveLaunchSpec`, `whenLaunchReady`, `prepareLaunch`/`adapterFor`,
    `roleBriefs.prepareSpawn` and cwd reporting. The renderer's `agentId` prop is not trusted
    for the command.
  - The `command` id is **never registered**, so it never appears in `registry.list()`, the New
    session dialog, launchers, the `open_session` enum, or the OS-open default.
  - `mgr.create` accepts it only alongside a `command`.
  - **Duplicate** carries `command`; Relaunch and restore use it.
  - **Why not a `custom:` launcher:** those are user-curated entries in the launcher menu.
    Creating one per call would pollute the human's launchers and outlive the session.
- **`Session.openedBy?: {handle, sessionId}`** records the caller at open time. Handles can be
  reused later, so both are stored. It feeds the log and the tooltip ("Opened by claude-1").
- **Persistence:**
  - `parseSessions` explicitly coerces all three new fields. Malformed values are dropped, never
    fatal. A `command` session with an invalid `command` loads as stale with an error.
  - **Downgrade:** an older build's `resolveLaunchSpec` falls back on `Unknown agent`, so it
    launches the default shell in the session's folder. Harmless; noted in CHANGELOG.

### 3.4 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `mcpTools`, `mcpToolOverrides` | Settings UI, session MCP tools dialog | `tools/list`, call gate, list_changed sender, dialog's "inherits On/Off" text | Yes |
| New session | MCP host via the shared create path | `mgr`, persistence, renderer state post, handle assignment (`prepareLaunch`), autoSwitch effect | Yes. The autoSwitch effect must honor `focus:false` (§4) |
| `Session.command` | `open_terminal` | launch spec, relaunch, restore, persistence, adapter matching | Yes |
| `openFileInEditor` + `line`/`column` | MCP host (new); OS open (unchanged, no line) | renderer doc-open path, editor reveal | Yes. The OS-open producer is unchanged and sends no line |
| `activateSession` | MCP host when `focus` | renderer `setActiveId` | Yes |
| list_changed | host on settings/override change | each CLI (support varies) | **No (flagged):** CLI behavior is outside our control. Call-time gate + "Relaunch to apply" hint (§8) |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| `focus:false` while `settings.autoSwitchSession` is on | The new session is **not** activated. The host marks it as created without focus, and the autoSwitch effect skips it. |
| The caller's window was closed (session moved or window gone) | The session goes to the primary window. |
| The caller session exits right after the call | The session is still created; the result goes to a dead connection; nothing is rolled back. |
| Path inside the caller's roots vs. elsewhere | No confinement: any existing dir/file. The switch is the trust boundary (§12 A1). |
| Path is a file for `open_session`, or a dir for `open_file` | `not_a_directory` / `not_a_file`. |
| Relative `..` escapes | Resolved normally against the home. Allowed, since there's no confinement. |
| Duplicate calls (agent retries) | No idempotency: each call creates a session. Rate limit 10/min caps runaways. |
| `agent` removed from `agents.json` between list and call | `unknown_agent`, with the current ids. |
| `command` not found on PATH | `command_not_found`; nothing is created. |
| Spawn fails later (after `created`) | The session shows stale + error, as for a UI-made session. The caller isn't told; it can see `presence` via `list_sessions` when it has a handle. |
| Default brief unreadable | `brief_unavailable`; nothing is created. |
| Fan-out: control on globally, children open children | Per-caller 10/min plus the global 20/min. |
| The human disables a tool mid-call | A call that passed the gate completes; the next call is refused. |
| Override set on a session with no MCP (plain shell) | The **MCP tools…** item shows only when `adapterFor(effectiveDef(session))` matches, including before the session has ever launched, so the human can pre-enable it. |
| A `command` session matching an adapter | Gets a handle and MCP. Its effective tools are the global defaults. |
| Restore of a `command` session | Relaunches the persisted command, the same as profile sessions (stale/auto-relaunch rules unchanged). |
| `open_file` on a huge or binary file | The existing editor/viewer guards apply (bounded read, viewers). |
| `line` past EOF | The editor clamps to the last line. |
| Master `conduitMcp` off | Every call returns `messaging_off` (gate step 2); `tools/list` lists everything, as today. |
| Message store unavailable | Messaging tools return `store_unavailable`; control tools still work. |
| Many windows: the caller in window B | The session and file open in window B. Window A is untouched. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Control tools globally | Off | Settings, per tool | `open_terminal` is arbitrary code execution as the user, outside the caller's sandbox: it could even edit Conduit's own settings. The human opts in |
| Messaging tools globally | On | Settings, per tool | Today's behavior |
| Per-session override | Inherit | Session menu → MCP tools… | Enable control for the main session only |
| `focus` | `true` | Per call | The point is for the human to drive the new session |
| Project/window | The caller's | No | A worktree of the same repo belongs with its parent |
| Brief for `open_session` | The definition's default | No (role-brief §3.4) | Briefs are human-authored only |
| Rate limit | 10 opens/min/caller, 20/min global | No | Runaway guard, not policy |
| Recents/launcher usage for MCP opens | Not touched | No | An agent loop must not reorder the human's lists |

## 6. Scope slicing

- **S0 (measure first):**
  - per CLI (Claude, Codex, Cursor, OpenCode), whether a mid-session `list_changed` makes a newly
    enabled tool callable without relaunch;
  - whether a schema `enum` with ~10 ids is accepted by all four;
  - which defines the "Relaunch to apply" hint.
- **MVP:**
  - `open_session`, `open_terminal`, `open_file`;
  - the call-time gate;
  - `mcpTools` and overrides;
  - the Settings toggles;
  - the MCP tools dialog;
  - list_changed;
  - `focus`;
  - an e2e for the main flow.
- **v1:**
  - `focus_session({handle})`;
  - "Opened by" shown in the sidebar, not only the tooltip;
  - a per-project default for switches.
- **Vision:** an orchestration skill that drives worktree + session + task end to end (outside
  Conduit, per the control-panel principle).
- **Out of scope:**
  - worktree tools;
  - an initial task/brief;
  - close/kill/rename over MCP;
  - terminal output reads;
  - settings over MCP;
  - confinement of control paths.

## 7. Acceptance criteria

**EARS:**
- When an MCP client calls a tool not effective for its session, the host shall return
  `tool_disabled` and perform no action.
- When `tools/list` is requested, the host shall return exactly the caller's effective tools.
- When a switch change alters a live connection's effective set, the host shall send
  `notifications/tools/list_changed` on that connection.
- When `open_session` succeeds, the host shall create a session of the given definition in the
  resolved directory, in the caller's window and project, with no overrides, and return its id,
  handle (or null) and label.
- When `open_terminal` succeeds, the host shall spawn `command` with `args` as argv, without a
  shell, and persist both so a relaunch runs the same command.
  - Note (review r1): on Windows a command that resolves to a `.cmd`/`.bat` (npm-installed CLIs)
    is re-parsed by cmd.exe. That grants nothing extra, since the caller already chooses the
    program (A1), but the args are not literally passed as argv there.
- While `focus` is false, the renderer shall not change the active session, including under
  `autoSwitchSession`.
- When `open_file` is given `line`, the editor shall reveal and place the cursor at that
  line/column.
- If the path does not exist or is the wrong kind, then the host shall return `path_missing` /
  `not_a_directory` / `not_a_file` and create nothing.
- If a caller exceeds 10 opens in a minute, then the host shall return `rate_limited`.

**Gherkin (e2e, fake MCP agent):**

```gherkin
Feature: Main session opens a worktree session
  Background:
    Given Conduit runs with a session "main" of the e2e fake MCP agent
    And open_session is enabled for "main" only via its MCP tools dialog
    # the fake records list_changed and re-lists (fake-agent extension)

  Scenario: Enabling a tool reaches the live connection
    Then main's fake received list_changed
    And main's re-listed tools include open_session

  Scenario: Open a focused session in a new folder
    When "main" calls open_session with a temp dir and agent "e2e-fake-mcp"
    Then a new session appears in main's window and project, rooted at that dir
    And it is the active session
    And the result's handle appears in list_sessions

  Scenario: A session without the switch can't open sessions
    Given a second session "worker" with default switches
    Then worker's tools/list lacks open_session
    And worker's call to open_session returns tool_disabled and no session appears

  Scenario: Background open
    When "main" calls open_session with focus false
    Then the active session is still "main"

  Scenario: Arbitrary command and relaunch
    Given open_terminal is enabled for "main"
    When "main" calls open_terminal with the test's absolute Node path and args ["-e", "<print marker, wait>"]
    Then the new session's terminal shows the marker
    And after Relaunch it shows the marker again
    And Duplicate produces a session that shows the marker

  Scenario: Missing command creates nothing
    When "main" calls open_terminal with command "no-such-cmd-xyz"
    Then it returns command_not_found and the session count is unchanged

  Scenario: Open a file at a line
    Given open_file is enabled for "main"
    When "main" calls open_file with a fixture file and line 40
    Then the file's tab is active with the cursor on line 40
```

Declarative:
- The Settings MCP section shows a switch per tool, with the control tools off on a fresh profile.
- The session MCP tools dialog shows each tool as Inherit (On/Off) / On / Off and saves on
  change.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Settings → MCP → Tools | Ideal | Two groups: **Messaging** (4 switches) and **Control** (3 switches, each with a one-line description of what it allows); a note that sessions can override | Toggle |
| | Master off | Tool switches disabled (not hidden), with the hint "Turn on the Conduit MCP server to use tools" | Turn the master on |
| | First run | Control tools off. Descriptions state the risk plainly. `open_terminal`: "Lets an agent run any program as you, outside its own sandbox." `open_session`: "Lets an agent start sessions from your profiles." | — |
| Session menu | Session has a handle | **MCP tools…** item | Opens the dialog |
| | No handle (plain shell) | Item absent | — |
| MCP tools dialog | Ideal | Title "MCP tools — <label>"; a row per tool: name, description, a segmented control **Inherit (On) / On / Off**, the inherited value in the Inherit label | Change, Close |
| | Changed while the agent is connected | Inline hint "Some agents only see newly enabled tools after Relaunch", plus a **Relaunch** button (shown only if S0 finds a CLI that ignores list_changed) | Relaunch |
| | Master off | Rows disabled + the same hint as Settings | — |
| | Save failed (persist error) | Inline error; the control reverts to the persisted value | Retry by changing again |
| | Session closed while the dialog is open | The dialog closes | — |
| Sidebar session | Opened by MCP | Tooltip line "Opened by <handle>" | — |

No loading/empty/offline states: everything is local and synchronous.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Settings tool switch | Toggle | Click | Tab, Space | Tap | — | `switch`, `aria-checked`, labelled by the tool name, described by its description |
| Session menu item | Open dialog | Click | Menu arrows, Enter | Tap | It is the context menu | `menuitem` |
| Dialog segmented control | Pick Inherit/On/Off | Click | Tab into a group, arrows move, Space selects | Tap | — | `radiogroup` labelled by the tool name; each option `radio` |
| Dialog Relaunch | Relaunch session | Click | Enter | Tap | — | `button` |
| Dialog | Close | Click ×, backdrop | Esc; focus returns to the session row | Tap | — | `dialog`, `aria-modal`, labelled by the title |

## 10. Accessibility & i18n (UI)

- **Keyboard:** everything is keyboard-operable. Focus opens on the first radiogroup and returns
  to the sidebar session row on close.
- **Visible focus:** uses the existing token focus ring, including in forced-colors mode.
- **Not color-only:** state is text ("Inherit (On)"), not color alone.
- **Announcements:** a change announces "<tool> set to Off for <label>" via the app's polite live
  region.
- **Strings:** all in `MCP_STR`, no hardcoded copy; tool descriptions are shared between Settings
  and the dialog.
- **Layout:**
  - Rows wrap for ~30% longer strings; nothing truncates meaning.
  - The segmented control mirrors under RTL.
  - Tool names (`open_session`) are code identifiers and not localized; their descriptions are.

## 11. Design tokens (UI)

Reuse the existing Settings `Toggle`, segmented/radio control, dialog and hint tokens (muted text,
warning hint). No new colors. The three themes come from the token system.

## 12. Assumptions

- **A1:** No path confinement for control tools. The switch, not the path, is the trust decision.
  - Enabling `open_terminal` for a session is equivalent to giving it a shell as the user; that
    includes editing `settings.json`/`sessions.json` and elevating itself at next start.
  - Attachments stay confined, because they read bytes into another agent.
  - `open_file` shows out-of-root files in the text editor only (§3.1).
- **A2:** `open_terminal` uses argv, not a shell string, to avoid quoting/injection ambiguity
  across shells. A shell is opt-in via `command`.
- **A3:** New sessions use the same create path as the New session dialog (validation, roots,
  brief default, project), so behavior can't drift between UI-made and MCP-made sessions.
- **A4:** "Focus" means the active session in its Conduit window. No OS foreground stealing.
- **A5:** The MCP tools item is only for sessions with a handle; plain shells have no MCP client.
- **A6:** The `agent` schema enum is a snapshot at `tools/list` time; the call validates against
  the live registry. S0 checks that every CLI accepts an enum of up to ~60 ids; if one doesn't,
  the enum is dropped and the ids are listed in the description.

**Review r1 (2026-10-27, independent):** 5 blockers, all accepted and applied:
- the `effectiveDef` seam;
- no `launch_failed`, pre-checks instead;
- the master-off rule;
- duplicate keeps `command`;
- the gate runs before the store check.

The should-fixes were applied too (§2, §3, §4, §7, A1).

## 13. Decisions Needed

- [normal] **D1:** Does the "Relaunch to apply" hint ship? Default: decided by S0 (shown only if
  some CLI ignores list_changed).
- [normal] **D2:** The `open_terminal` session's sidebar icon/label. Default: the command leaf as
  the label, the generic terminal icon.

## 14. Open questions

None blocking. The human ruled on 2026-10-27:
- control tools off globally;
- free-form commands allowed (as their own switchable tool);
- no first task (use `send_message`);
- a `focus` flag;
- global per-tool settings plus per-session overrides from the session menu.
