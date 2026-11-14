# UX: Conduit

How Conduit works for the people and agents who use it. No colours, fonts or sizes: those are
in [UI.md](UI.md). Each load-bearing line carries `[evidence: pointer]`, `[owner, date]` or
`[assumption]`. Paths are relative to the repo root (v0.64.1).

## 1. Product

- **What it is:** a desktop workspace for running many coding-agent CLIs side by side (Claude
  Code, Codex, OpenCode, Kiro, Cursor, or any CLI on PATH). Each agent runs in a real terminal,
  with its files, changes and messages beside it. The agents can message each other and you
  through Conduit's tools. `[evidence: README.md; src/launchers.ts; src/conduit-mcp/tool-policy.ts]`
- **Its heart:** agent terminals that keep running reliably side by side, and seeing at a glance
  which agent needs you. If either breaks, Conduit is pointless. `[owner, 2026-11-14]`
- **Posture:**
  - Sovereign: the window is open all day and you work in it. `[owner, 2026-11-14]`
  - Background: agents keep running with every window closed, and the tray shows their state.
    `[evidence: CHANGELOG 0.52.0; src/tray-view.ts]`
- **Platforms:** desktop only.
  - Linux first, then Windows and macOS. `[owner, 2026-11-14]`
  - Large monitors; 1024 wide is the narrowest that must work. `[owner, 2026-11-14]`

## 2. Users

| User type | Human or agent | Expertise | Accessibility | Context and state | Jobs, in their words |
|---|---|---|---|---|---|
| **The owner** | Human | Expert developer, runs 5–20 agents at once | None stated; English only `[owner, 2026-11-14]` | At a desk for hours, often across two screens. Steps away for unattended runs and comes back to catch up. Dictates most text with Wispr Flow; moves around with the mouse `[owner, 2026-11-14]` | "Keep all my agents moving." "Know the moment one needs me." "See and review what they changed." "Let them hand work to each other." `[owner, 2026-11-14]` |
| **Agents** | Agent | Reads tool schemas, not the screen | Needs stable names and machine-readable state | Running inside a Conduit terminal, often unattended | Message other agents and the human, open helper sessions, ask for a decision and get the answer `[evidence: src/conduit-mcp/tool-policy.ts:6-35]` |
| **Other developers** | Human | Developers, likely less familiar with agent fleets | Unknown | Unknown | Unknown `[assumption]`: whether Conduit is for anyone besides the owner is an open question |

The owner is the user every screen is designed for. Agents are users of the tools, not the
screens. Every feature in §4 names which of them it serves.

## 3. Interfaces

| Interface | Who uses it | Implication |
|---|---|---|
| **Voice (dictation)** | The owner, most of the time `[owner, 2026-11-14]` | Wispr Flow pastes dictated text into the focused field, usually a terminal. Long pasted text must arrive whole and in order (bracketed paste, a cap that refuses instead of truncating `[evidence: docs/specs/2026-11-13-scheduler-auto-resume.md]`). Every place you answer in words (terminal, compose, the request text field) must take a large paste cleanly. **Future:** connect Wispr Flow to Conduit directly, so a spoken command triggers an action without the paste step `[owner, 2026-11-14]` |
| **Pointer** | The owner, to move around `[owner, 2026-11-14]` | Every action has a visible pointer path: no keyboard-only or right-click-only actions for anything core. Frequent targets are large and near where the eye already is |
| **Keyboard** | The owner, secondary | Shortcuts exist and stay (VS Code-style, rebindable `[evidence: webview/shortcuts.ts:21-230]`), but no feature depends on them. The command palette is the keyboard way to reach anything |
| **Agent (tool calls)** | Agents | Tool names, arguments and refusal codes are stable. State is exposed as data (handles, states, request ids), never only as something on screen `[evidence: webview/conduit-mcp-strings.ts:187-230]` |

## 4. Feature register

Frequency · Importance · Trigger · Input · Arrives unasked · Cost of a miss · Users · Place. All
rows are `[assumption]`, drafted from the code and the owner interview, until the owner corrects
them.

| Feature | Frequency | Importance | Trigger | Input | Unasked | Cost of a miss | Users | Place |
|---|---|---|---|---|---|---|---|---|
| Agent terminal (watch, type, paste dictation) | constant | heart | working with an agent | voice, pointer, keyboard | no | lost work | owner | Centre, the session's first tab |
| Agent list with state (Needs you, Working, Done, Idle, Stopped) | constant | heart | "which one needs me?" | pointer | yes (state changes) | annoyance → lost work | owner | Sidebar, Agents |
| Needs you count | constant | heart | glancing at the window | pointer | yes | lost work (an agent stalls) | owner | Status bar |
| Request queue: agent questions, approvals, stuck prompts, failed auto-resumes | several times a session | heart | an agent is blocked on you | pointer, voice (text field) | yes | lost work or harm (a wrong approval) | owner, agents | Right pane, Needs you; pop-up or tab to answer `[owner, 2026-11-14; CON-10]` |
| Start an agent (new session) | several times a session | core | a new task or a helper | pointer | no | annoyance | owner, agents (open_session) | Sidebar +, palette, empty centre |
| Switch between agents | constant | core | following work | pointer | no | annoyance | owner | Sidebar row click |
| Spaces (group agents by project) | daily | supporting | organising a project | pointer | no | annoyance | owner | Sidebar, Spaces |
| Lead and sub-agents tree | several times a session | core | a lead opened helpers | pointer | no | annoyance | owner, agents | Sidebar, indented under the lead |
| Changes (git status per repo) | several times a session | core | "what did it change?" | pointer | no | lost work | owner | Right pane, Changes |
| Review (diff walkthrough) | daily | core | before merging an agent's work | pointer, keyboard | no | harm (bad code merged) | owner | Centre, a Review tab |
| Files and find in files | several times a session | supporting | looking something up | pointer | no | annoyance | owner | Right pane, Files |
| Editor (Monaco) | daily | supporting | a small fix by hand | keyboard | no | lost work (unsaved) | owner | Centre, doc tabs |
| Messages between agents | daily | supporting | following a hand-off | pointer | yes (unread) | annoyance | owner, agents | Right pane, Messages |
| Approval card (today's policy asks) | several times a session | core | an agent's tool call is set to Ask | pointer | yes | harm or lost work | owner | Floating stack; moves into the request queue with CON-18 |
| Auto-resume after a usage limit | daily | core | a limit hits while you're away | none (runs by itself) | yes (only when it can't help) | lost work (hours idle) | owner | Session pill and Schedule dialog `[CON-15 design]` |
| Timed messages | weekly | supporting | "nudge it later" | pointer | no | annoyance | owner | Session menu, Schedule dialog |
| Snooze an agent | weekly | nice to have | an agent nags while you're busy | pointer | no | nothing | owner | Session menu |
| Agent tool policy (what agents may do) | set and forget | core | setting up, or after a surprise | pointer | no | harm | owner | Settings › MCP; per session in its menu |
| Background service and tray | constant (unseen) | heart | always | none | yes (only on trouble) | lost work | owner | Tray, server banner |
| Server banner (service down, restarting) | rare | core | something broke | pointer | yes | lost work | owner | Under the top bar |
| OS notifications | daily | supporting | the window isn't focused | none | yes | annoyance | owner | OS |
| Command palette and search | daily | supporting | reaching anything fast | keyboard | no | nothing | owner | Overlay from the top bar |
| Settings, themes, fonts, density | set and forget | supporting | setting up | pointer | no | nothing | owner | Settings dialog |
| Update and What's new | rare | supporting | a release lands | pointer | yes | nothing | owner | Floating stack, Settings › About |
| Feature board | rare `[assumption]` | nice to have | planning | pointer | yes (proposals) | nothing | owner, agents | Centre overlay |
| Architecture canvas | rare `[assumption]` | nice to have | planning | pointer | yes (proposals) | nothing | owner, agents | Centre overlay |
| Plans (interactive `.conduit/plans`) | weekly | supporting | reviewing an agent's plan | pointer | no | annoyance | owner, agents | Centre, a doc tab |
| Multiple windows | weekly | supporting | two screens | pointer | no | nothing | owner | Palette, session menu |
| Voice commands to Conduit (future) | — | — | speaking a command | voice | no | — | owner | Not built `[owner, 2026-11-14]` |

## 5. Places

Each region has one job. Today's layout: `[evidence: webview/app.tsx:5182-5570; src/layout.ts:6]`

| Place | Its job | What lives here | How you get here |
|---|---|---|---|
| **Top bar** | Window identity, getting anywhere, side-panel toggles | Back/Forward, the search omnibar, Files / Changes / Messages toggles with counts, window controls `[evidence: webview/components/top-bar.tsx]` | Always visible |
| **Server banner** | Say the background service is in trouble, and how to fix it | Retry, Stop all agents and continue, Restart agents to update `[evidence: webview/components/server-banner.tsx:16-66]` | Appears by itself |
| **Sidebar** | Choose a scope and an agent; see every agent's state | Spaces (All, each space, No space); Agents tree with status groups and sub-agents; Settings `[evidence: webview/components/sidebar.tsx]` | Always visible; Mod+B hides it |
| **Centre** | Work with the active agent | Its terminal tab first, then its doc tabs (files, diffs, reviews, web, history), splits; Board and Canvas as overlays `[evidence: webview/components/center-pane.tsx; webview/center-view.ts:7]` | Click an agent |
| **Right pane** | Context for the active agent | Files, Changes, Messages; **Needs you** added by CON-10 `[evidence: webview/components/right-pane.tsx]` | Top-bar toggles |
| **Status bar** | Counts for the whole window | This computer, branch, worktree, N agents, the **N need you** button, update progress `[evidence: webview/components/status-bar.tsx]` | Always visible |
| **Floating stack** | Things that arrive unasked and need a decision or an acknowledgement | Approval card, toasts, update card `[evidence: webview/components/toasts.tsx:54-120]` | Appears by itself |
| **Request pop-up / request tab** | Answer one request with room to read it | Header · Context · Answer · Footer; pop-up for light requests, tab beside the agent's terminal for heavy ones `[owner, 2026-11-14; CON-10 iter-7]` | Click a request in Needs you |
| **Dialogs** | One focused task | New session, Settings, Confirm, Schedule, MCP tools… `[evidence: webview/components/modal-layer.tsx]` | From a menu, button or palette |
| **Command palette** | Reach anything by typing | Sessions, agents, files; `>` for commands `[evidence: webview/components/command-palette.tsx]` | The omnibar, Mod+P, Mod+Shift+P |
| **Tray** | State while no window is open | N agents running, M need you, Open Conduit, Stop all agents… `[evidence: src/tray-strings.ts]` | OS notification area |

## 6. Flows

### Start an agent
- **Trigger:** a new task, or a lead needs a helper.
- **Steps:**
  1. Click + in the sidebar's Agents header → the New session dialog opens with the last launcher and folders.
  2. Pick the agent CLI, folders and an optional role brief → Launch.
  3. The agent appears in the sidebar under Working, and its terminal takes the centre.
- **Agents do it too:** `open_session`, which asks you first by default `[evidence: src/conduit-mcp/tool-policy.ts:121-188]`.
- **Done when:** the CLI's prompt is ready in its terminal.
- **Failures → what you see → recovery:** the launch fails → a "Retry launch / Discard" card in the centre → retry, or pick another launcher `[evidence: webview/components/center-pane.tsx:420-446]`.

### Notice and answer what needs you (CON-10, approved design)
- **Trigger:** an agent asks a question, wants an approval, is stuck at its CLI's prompt, or auto-resume can't help.
- **Steps:**
  1. The status bar count goes up. The agent moves to Needs you in the sidebar if it's blocked, and a one-line notice appears if you're elsewhere. Nothing takes focus.
  2. Open Needs you → one card per request: type icon, who's asking, a one-line ask, and why now.
  3. Click a card → a pop-up (light requests) or a tab beside that agent's terminal (heavy ones).
  4. Pick an option or say it in your own words (dictation works here) → Send → the next request loads.
- **Done when:** the agent has the answer, even if it had stopped waiting `[evidence: docs/specs/2026-11-14-user-input-requests.md §4.3]`.
- **Failures:**
  - Answered elsewhere or withdrawn while open → the controls grey out and your text stays copyable.
  - An approval expired → "Allow next time…" creates the rule without running the stale action.

### Catch up after being away
- **Trigger:** back after an unattended run.
- **Steps:**
  1. Look at the status bar count and the sidebar groups → Needs you first, then Done (not seen yet).
  2. Work through Needs you with Next →.
  3. Open each Done agent's Changes, then Review.
- **Done when:** nothing needs you and every Done agent has been seen.
- **Failures:** an agent hit a usage limit → auto-resume retried, or it shows in Needs you with the reason `[evidence: CHANGELOG 0.64.0]`.
- **Gap:** a "while you were away" summary is planned (CON-10 Away and digest), not built.

### Review what an agent changed
- **Trigger:** an agent says it's done.
- **Steps:**
  1. Changes shows its repos, staged and unstaged.
  2. Review opens as a tab: mark files reviewed, add notes, stage or discard per hunk.
- **Done when:** every file is marked reviewed, or the changes are staged.
- **Failures:** "Couldn't read git status" → Retry `[evidence: webview/components/changes-view.tsx:30-50]`.

### Agents hand work to each other
- **Trigger:** a lead splits work across helpers.
- **Steps:**
  1. The lead opens helpers (`open_session`) → they nest under it in the sidebar.
  2. They report back with `send_message` → the threads are visible in Messages.
- **Done when:** the lead has its helpers' reports.
- **Failures:** a thread pauses after N agent messages → "Allow 20 more" `[evidence: webview/conduit-mcp-strings.ts:101-102]`.

### The background service is in trouble
- **Trigger:** the service stops or restarts.
- **Steps:**
  1. A banner says what happened and offers Retry, or Stop all agents and continue.
  2. Terminals show "Reconnecting — input paused".
- **Done when:** the banner clears by itself.
- **Failures:** it stops after repeated crashes → the tray says when it will retry `[evidence: src/tray-view.ts:38-62]`.

## 7. States

| Place | Empty | Loading | Error | Too much | Stale or offline | No permission |
|---|---|---|---|---|---|---|
| Sidebar | "No agents yet" + Start an agent | "Loading agents…" | — | Sub-agents fold; Stopped starts folded | Stale sessions: Relaunch / Close all stale | — |
| Centre | "Point an agent at a directory" + routes | — | Retry launch; process exited; missing home | Tab overflow | "Reconnecting — input paused" | Workspace Trust prompt |
| Changes | "The working tree is clean" | "Updating… · last read X ago" | "Couldn't read git status" + Retry | Per-repo lists | — | — |
| Messages | First-run line; "No messages in this scope" | — | "Messages couldn't be loaded" + Retry | Thread pause + Allow 20 more | — | "Messaging is turned off" + Open Settings |
| Needs you (CON-10) | "All caught up" | — | "Can't reach the Conduit server…" + Retry | Cards; filters; a waiting agent is never filtered out | Remote rows read-only | — |
| Tray | "No agents running" `[assumption]` | Service starting | "stopped after repeated crashes" | — | Service unavailable | — |

Badge counts are not capped today `[evidence: webview/conduit-mcp-view-model.ts:57-60]`.

## 8. Words

| Concept | Name in the UI | Never call it |
|---|---|---|
| A group of agents for one project | **Space** (All, No space) | project `[evidence: CHANGELOG "Projects are called Spaces"]` |
| One running agent CLI in a terminal | **Agent** `[assumption: proposed, owner to confirm]` | session, in the UI (today both are used `[evidence: webview/sidebar-strings.ts:62-130]`) |
| An agent another agent opened | **Sub-agent**; the opener is its **lead** | child, helper (except in MCP message origins) |
| Something that needs the human | **Request**; the list is **Needs you** | notification, decision, approval (for the whole list) `[owner, 2026-11-14]` |
| The three request types | **Approve · Answer · Review** `[owner, 2026-11-14; CON-10 iter-7]` | Permission, Choose, Question, Confirm, Attend, in the UI |
| The right-hand panel | **Side panel** (Files, Changes, Messages, Needs you) | explorer, right pane `[assumption: proposed]` |
| The service that keeps agents running | **Background service** | server, daemon |
| Agent-to-agent communication | **Messages** | MCP, Conduit MCP (in user-facing copy) `[assumption: proposed]` |

**Copy rules:**
- Conduit's own words lead. Agent text is shown quoted, never styled as Conduit's, so an agent can't make its request look like a system permission `[evidence: docs/specs/2026-11-14-user-input-requests.md §4.1]`.
- Short labels, key word first, no welcome text.
- Name things by what you recognise ("needs you", "changes"), not by how they're built.
- OS notifications carry Conduit's words only, never agent text.
- Errors say what happened and the fix, with a button for the fix.

## 9. Rules for this product

- **Nothing steals focus.** Anything that arrives unasked shows a count, a mark or a one-line notice. A pop-up opens only from your click or key. You may be mid-dictation in a terminal (Interrupt in proportion; Raskin: modes).
- **One place per fact.** The Needs you count lives in the status bar; other places link to it and don't repeat it (One place per fact).
- **Every core action has a pointer path**, and every answer field takes long dictated text whole (Signifiers; the owner's interfaces).
- **The heart is always in view:** the agent list and the active terminal never get covered by anything that isn't a request you opened (Posture: sovereign).
- **Never move frequent controls.** Sidebar order, the terminal tab's position and the status bar items stay put (Raskin: habituation).
- **Always show what's happening:** agent states, the background service's state, waiting countdowns (Nielsen: system status).
- **Undo over confirm**, except where an action can't be undone (stopping agents, approving a tool call) (Norman: design for error).
- **Dense is fine; noisy isn't.** The owner is an expert, but things must not get lost: fewer types, clear icons, details on demand (Hick's law; owner feedback on CON-10, 2026-11-14).
- **Agents get data, not pixels.** Every state an agent may need is in a tool result, with stable names.
- **Feel like the products the owner likes:** VS Code for layout and editing, iOS and Apple for calm and clarity, Notion for readable, unhurried documents `[owner, 2026-11-14]` (Conventions).

## 10. Decisions and open questions

| Date | Decision | By | Why |
|---|---|---|---|
| 2026-11-14 | Requests: a one-line card list in Needs you; answer in a pop-up, or a tab beside the agent; three types; one four-section layout; free text always on | owner | The sidebar answer cards felt crammed; too many types (CON-10 iter-6 → iter-7) |
| 2026-11-14 | Filter requests by session, lead group, space, type and machine | owner | Scale: many agents across spaces and machines |
| 2026-11-14 | Main interfaces are voice (dictation) and pointer; keyboard is secondary | owner | How the owner works |
| 2026-11-14 | UX.md and UI.md live in `docs/`; the wireframe kit in `docs/design/` | owner | Keep design docs with the rest of the docs (ADR 0003 doesn't list a design folder yet) |
| earlier | Agents keep running with the window closed; a three-process split | owner | Long unattended runs `[evidence: docs/adr/0007-three-process-split-and-terminal-runtime.md]` |
| earlier | Agents run their own CLIs on the owner's subscriptions; no API-key chat UI | owner | Subscriptions can't power the SDK `[evidence: docs/specs/INDEX.md]` |

**Open questions, most blocking first:**
1. **Agent or session?** The UI uses both for the same thing. Proposed: "Agent" everywhere you see it, "session" only inside the code.
2. **Is Conduit only for you, or for other developers too?** That changes how much explaining the empty states and first run should do.
3. **The feature register (§4):** correct how often, how important and the cost of a miss, especially for the Board and Canvas. Are they still wanted?
4. **Voice commands:** which actions would you want to speak first? For example "answer yes", "next request", "open claude-3".
5. **Side panel naming:** "Side panel" for the right-hand panel, retiring "Explorer"?
6. **OS light/dark:** should Conduit follow the OS setting? Today it doesn't (see UI.md).
