# Agent Deck

A **Copilot-free, agent-agnostic multi-agent dashboard** for VS Code. Open a
full-window dashboard that launches, groups, and controls multiple CLI-agent
sessions (Claude Code or any CLI) running in **native VS Code terminals** —
without a GitHub Copilot subscription.

> Status: **v1 in progress.** Built as a VS Code extension. See
> `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the
> implementation plan. Autonomous build decisions are logged in `DECISIONS.md`.

## Why

Off-the-shelf tools each missed something: Warp's file explorer is buggy and it
bolts on its own agent; Wave has no file/IDE model; the official Claude Code
extension is just a chat pane; and VS Code's built-in Agents Window routes Claude
through Copilot billing. Everything else (live file tree, deduped tabs, directory
grouping, search, go-to-definition) VS Code already does well — so Agent Deck
builds **only** the agent-first dashboard layer on top.

## Features (v1)

- **Full-window dashboard** webview styled after the Agents Window.
- **Launch / focus / rename / kill** agent sessions.
- **Grouped by project folder** (cross-project in one window).
- **Agent registry**: define any CLI agent once; launch from a picker.
- **Status badges**: `running` / `exited` / `stale`.
- Native terminals → uses your own agent auth (no Copilot).

## Develop & run

```bash
npm install
npm run build        # bundles extension + webview into out/
```

Then press **F5** in VS Code to launch the Extension Development Host, and run
**“Agent Deck: Open Dashboard”** from the Command Palette. Drag the dashboard
tab to its own window (right-click tab → *Move into New Window*) for the
full-window experience.

### Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Bundle extension, webview, and integration tests via esbuild |
| `npm run watch` | Rebuild on change |
| `npm run test:unit` | Vitest unit tests (pure logic, no VS Code) |
| `npm run test:int` | `@vscode/test-electron` integration test (launches VS Code) |
| `npm run typecheck` | Type-check host + webview |

### Visual preview of the webview (no VS Code needed)

```bash
npm run build
node tools/render-webview.mjs        # writes out/preview.html with mock data
node tools/preview-server.mjs 5174   # serves out/ at http://127.0.0.1:5174/preview.html
```

Then open that URL (or screenshot it with `playwright-cli`).

## Configure agents

Add to your VS Code settings (`agentDeck.agents`):

```jsonc
"agentDeck.agents": [
  { "id": "claude", "label": "Claude Code", "command": "claude", "args": [],
    "icon": "sparkle", "color": "terminal.ansiMagenta", "cwdStrategy": "workspaceFolder" },
  { "id": "aider", "label": "Aider", "command": "aider", "args": [],
    "icon": "robot", "color": "terminal.ansiCyan", "cwdStrategy": "workspaceFolder" }
]
```

## Known v1 limitations

- **No terminal background images** — native VS Code terminals don't support
  them (accepted tradeoff; per-session tab color/icon *is* supported).
- **Sessions don't survive a full window reload** — restored sessions are marked
  `stale` with a relaunch affordance rather than pretending they're live.
- **Status is running/exited only.** Claude-smart "needs your input" status via
  Claude Code hooks is planned for v2.

## Architecture

Extension host owns all state through small, unit-tested modules
(`AgentRegistry`, `SessionManager`, `StatusTracker`, `Persistence`) behind a
`TerminalHost` seam. A React webview renders the dashboard and mirrors host state
over a typed `postMessage` protocol; it holds no source of truth. No proposed
APIs, no Copilot, no editor fork.
