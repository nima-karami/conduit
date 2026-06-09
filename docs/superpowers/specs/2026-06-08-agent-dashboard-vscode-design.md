# Agent Deck — a custom multi-agent dashboard for VS Code

**Status:** Approved design (2026-06-08). Spec written for overnight autonomous build.
**Author:** Drafted with Claude during brainstorming; to be reviewed by Nima.

> "Agent Deck" is a working name — rename freely.

## 1. Problem & motivation

The user wants one Windows app to run Claude Code (or *any* CLI agent), browse
files in a good UI, read styled markdown and code, jump to definitions, run
multiple agent sessions in tabs/panes, theme the terminal, and search files
quickly.

Every off-the-shelf option was evaluated and rejected:

- **Warp** came closest, but its file explorer is buggy (stale files), it
  duplicates tabs when reopening a file instead of focusing the existing one,
  it doesn't group tabs/panes by directory, its search is clunky, and it bolts
  on its own agent.
- **Wave Terminal** is block/widget-oriented, has no file-as-tab model and no
  LSP.
- **Official Claude Code VS Code extension** is just a chat pane, not a
  multi-session dashboard.
- **VS Code's built-in Agents Window** has the desired dashboard UX, but routing
  Claude through it is tied to a GitHub Copilot subscription.

**Key realization:** Every feature the user complained was broken elsewhere —
live file tree, deduplicated tabs, directory grouping, fast search, real
go-to-definition (LSP) — VS Code already does correctly and for free. So we do
**not** build those. We build only the *agent-first layer* on top, as a VS Code
extension.

## 2. Goals / non-goals

### Goals (v1)
- A **dedicated full window** (not a sidebar) that replicates the Agents Window
  UX, but is **agent-agnostic** and **Copilot-free**.
- Launch, name, focus, and kill multiple agent sessions.
- **Group sessions by project folder / git worktree.**
- An **agent registry**: define any CLI agent once (Claude Code, aider, custom),
  launch from a picker. This is what makes it truly agent-agnostic.
- Sessions span multiple folders/worktrees in one window (cross-project), like
  the Agents Window.
- Basic status: running / exited; per-session tab color + icon.
- Persist the session list/layout across window reloads.

### Non-goals (v1 — explicitly out)
- **Not forking VS Code.** "Fork the Agents Window" would mean forking the whole
  editor (Cursor/Windsurf path): forever-merging upstream, losing the VS Code
  Marketplace, re-branding to Code-OSS. Wrong-sized effort; contradicts the
  least-effort decision.
- **No proposed APIs** (e.g. `chatSessionsProvider`) — unpublishable and churning.
- **No LSP work** — go-to-definition is VS Code's, already perfect, free.
- **No terminal background images.** We drive *native* VS Code terminals, which
  don't support per-terminal background images. (Accepted tradeoff: chosen over
  embedding xterm.js + pty, which would be far more work.)

### Later phases
- **v2:** Claude-smart status via Claude Code hooks (Notification/Stop) →
  "needs your input" badges + OS notification when an agent is waiting. Generic
  CLIs keep running/exited only.
- **v3:** layout presets, session search/filter, richer theming.

## 3. Architecture

A single VS Code extension (TypeScript). The extension host owns all state and
process/terminal control; a webview renders the dashboard in its own window.

```
┌────────────────────────── VS Code ──────────────────────────┐
│                                                              │
│  Extension Host (Node)                  Auxiliary Window     │
│  ┌────────────────────────┐             ┌─────────────────┐  │
│  │ SessionManager (model) │ ◀──postMsg──▶│ Dashboard       │  │
│  │  - sessions[]          │             │  webview (React)│  │
│  │  - create/focus/kill   │             │  - grouped list │  │
│  │ AgentRegistry          │             │  - status       │  │
│  │ StatusTracker          │             │  - controls     │  │
│  │ Persistence(globalState)│            └─────────────────┘  │
│  └───────────┬────────────┘                                  │
│              │ window.createTerminal / show                   │
│        ┌─────▼───────────────────────────┐                   │
│        │ Native VS Code terminals (panel) │  ← claude, etc.   │
│        └─────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

## 4. Components

Each component has one purpose, a defined interface, and is testable in
isolation. The pure-logic ones (SessionManager model, AgentRegistry,
StatusTracker state machine, Persistence serialization) are unit-tested without
a running VS Code; the VS Code-coupled wiring is covered by the extension test
host.

### 4.1 AgentRegistry
- **Purpose:** resolve user-defined agent definitions.
- **Input:** settings (`agentDeck.agents`) — array of `{ id, label, command,
  args[], icon, color, cwdStrategy }`. Ships with a default `claude` entry.
- **Output:** validated `AgentDefinition[]`; resolves an agent + a target
  folder/worktree into a concrete `{ command, args, cwd, env }` spawn spec.
- **cwdStrategy:** `workspaceFolder` | `gitWorktree` | `prompt`.
- Pure logic. Unit-tested.

### 4.2 SessionManager
- **Purpose:** source of truth for sessions; the only thing that mutates the
  session set.
- **Session model:** `{ id, name, agentId, projectPath, worktree?, terminalId,
  status, createdAt }`.
- **Operations:** `create(agentId, target)`, `focus(id)`, `rename(id, name)`,
  `kill(id)`, `list()`, grouping selector `groupByProject()`.
- Holds the model as pure data; terminal side effects are injected via a thin
  `TerminalHost` interface so the model is unit-testable with a fake host.

### 4.3 TerminalHost (VS Code adapter)
- **Purpose:** the only place that touches `vscode.window` terminals.
- **Interface:** `create(spec): TerminalHandle`, `focus(handle)`,
  `dispose(handle)`, `onDidClose(cb)`, sets tab `color`/`iconPath`.
- Real impl wraps `vscode.window.createTerminal`; fake impl used in unit tests.

### 4.4 StatusTracker
- **Purpose:** compute session status.
- **v1:** `running` (terminal alive) / `exited` (`onDidCloseTerminal`) /
  `active` (focused). Pure state machine fed by host events.
- **v2 hook:** accepts external "needs-input"/"idle" signals from the Claude
  hooks bridge.

### 4.5 Persistence
- **Purpose:** serialize/restore the session list across reloads via
  `globalState`.
- **Reload reconciliation:** native terminals may not survive a full reload;
  on activate, mark restored sessions as `stale` and offer one-click relaunch
  rather than pretending they're live.
- Pure (de)serialization is unit-tested.

### 4.6 Dashboard webview
- **Purpose:** the full-window UI. React + TypeScript, bundled with esbuild.
- Opens via command `agentDeck.openDashboard`, placed so it can be dragged to /
  opened in its own (auxiliary) window. Styled after the MIT-licensed Agents
  Window (reference the look; copy MIT components where helpful — do not fork
  the editor).
- **Renders:** sessions grouped by project/worktree; each row shows name, agent
  icon/color, status badge.
- **Controls:** New session (agent picker → target picker), focus, rename, kill.
- **Comms:** typed `postMessage` protocol with the host; webview holds no source
  of truth, only mirrors host state.

## 5. Data flow

1. **New session:** webview → `create` message → host resolves agent + cwd via
   AgentRegistry → SessionManager creates terminal via TerminalHost → model
   updated → host posts new state → webview re-renders.
2. **Focus:** webview → `focus` → host reveals/focuses the native terminal.
3. **Exit:** TerminalHost `onDidClose` → StatusTracker → SessionManager updates
   status → host posts state → webview re-renders.
4. **Reload:** activate → Persistence restores list → sessions marked `stale` →
   webview shows relaunch affordance.

## 6. Error handling

- **Missing agent binary:** AgentRegistry resolution fails fast; webview shows an
  inline error on that agent; session not created.
- **Terminal creation failure:** surfaced as a toast + dashboard error row.
- **Webview/host message mismatch:** protocol is versioned; unknown messages are
  logged and ignored, never crash the host.
- **Persistence corruption:** invalid stored state is discarded with a logged
  warning; extension starts empty rather than failing to activate.

## 7. Testing strategy

- **Unit (no VS Code):** AgentRegistry resolution, SessionManager operations
  with a fake TerminalHost, StatusTracker transitions, Persistence round-trip.
  TDD for all of these.
- **Integration (extension test host, `@vscode/test-electron`):** terminal
  create/focus/kill, command registration, activation, reload reconciliation.
- **Webview UI:** component tests; visual verification via Playwright screenshots
  of the rendered dashboard HTML (the build harness renders the webview bundle
  in a headless browser and screenshots it).
- **Launch verification:** use a harmless stub agent (echo/sleep) for automated
  launch tests; verify the real `claude` binary resolves, but do **not** drive
  interactive Claude sessions in automation.

## 8. Tech choices

- TypeScript, React, esbuild, `@vscode/test-electron`, Playwright (dev only).
- No proposed APIs; targets stable VS Code 1.123+.

## 9. Open items for human review (morning)

- Name ("Agent Deck"?).
- Whether to pull Claude-hooks status (v2) forward into v1.
- Final dashboard visual taste vs. the Agents Window reference.
- Any scope/constraint to move.

See `DECISIONS.md` for choices made autonomously during the build.
