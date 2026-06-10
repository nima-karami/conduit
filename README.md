# Conduit

An **agent-agnostic multi-agent terminal dashboard** — a standalone desktop app
(Electron) that launches, groups, and controls multiple CLI-agent sessions
(Claude Code or any CLI) in **real embedded terminals**, with a live git
changes/files panel and customization counts per project.

> Status: standalone **Electron app**. (Previously prototyped as a VS Code
> extension; pivoted because running a real PTY inside the webview sandbox kept
> fighting the platform. See `DECISIONS.md` for the full history.)

## Why

Off-the-shelf tools each missed something: Warp's file explorer was buggy and it
bolts on its own agent; the official Claude Code extension is just a chat pane;
and VS Code's Agents Window routes Claude through Copilot billing. Conduit is a
purpose-built deck for running *your* agents your way — real terminals, your own
auth, multiple sessions grouped by project, themeable.

## Features

- **3-pane shell**: sessions sidebar + customizations · center real terminals ·
  right-hand git Changes/Files.
- **Real embedded terminals** (xterm.js ↔ node-pty) running the actual agent CLI.
- **Multiple concurrent sessions**, kept mounted so switching never kills them.
- **Grouped by project folder**; **launch / rename / kill / relaunch**.
- **Agent registry**: define any CLI agent once; launch from a picker.
- **Live git panel** (`git status` + `--numstat`) and **customization counts**
  (`.claude` agents/skills/instructions/hooks/MCP) for the active project.
- **Status badges**: `running` / `exited` / `stale`; sessions persist across
  restarts (restored as `stale` with a relaunch affordance).

## Develop & run

```bash
npm install
npm start            # builds (main + preload + renderer) and launches the app
```

The window opens empty on first run — click **New** to pick one of the terminals
detected on your machine; it spawns in your home directory.

### Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Build then launch the Electron app |
| `npm run build` | Bundle main, preload, and renderer via esbuild → `out/` |
| `npm run watch` | Rebuild on change |
| `npm run rebuild` | Rebuild `node-pty` against Electron's ABI (fallback; see below) |
| `npm run test:unit` | Vitest unit tests (pure logic) |
| `npm run typecheck` | Type-check host + renderer |

### Visual preview of the UI (no app launch needed)

```bash
npm run build
node tools/render-webview.mjs        # writes out/preview.html with mock data
node tools/preview-server.mjs 5174   # serves out/ at http://127.0.0.1:5174/preview.html
```

The renderer falls back to a small fake shell when `window.agentDeck` is absent,
so the whole UI is visible in the browser (or via `playwright-cli`).

## Configuration

The **New** menu lists the terminals/shells auto-detected on your machine
(PowerShell, Git Bash, cmd, WSL on Windows; zsh/bash/fish/sh elsewhere). New
sessions open in your home directory.

Custom **agents** (Claude Code, Aider, …) are opt-in: add an `agents.json` (an
array of agent definitions) in the app's user-data dir (`app.getPath('userData')`)
and they'll appear in the New menu alongside the shells. Sessions persist to
`sessions.json` in the same place. Example `agents.json`:

```jsonc
[
  { "id": "claude", "label": "Claude Code", "command": "claude", "args": [],
    "icon": "sparkle", "color": "magenta", "cwdStrategy": "workspaceFolder" },
  { "id": "aider", "label": "Aider", "command": "aider", "args": [],
    "icon": "sparkle", "color": "cyan", "cwdStrategy": "workspaceFolder" }
]
```

(Or just type `claude` / `aider` inside any shell session.)

## Native module note

`node-pty` is a native addon and must match Electron's ABI. To avoid requiring a
C++ toolchain, this project depends on **`@lydell/node-pty`** — a maintained fork
that ships prebuilt binaries (including Electron ABIs). If you ever need to
rebuild it from source, install Python + VS Build Tools and run `npm run rebuild`.

## Architecture

The **Electron main process** (`electron/main.ts`) owns all state through small,
unit-tested modules (`AgentRegistry`, `SessionManager`, `Persistence`,
`projectInfo`) plus `PtyHost`, which owns the node-pty processes keyed by session
id. A **React renderer** (`webview/`) renders the dashboard and mirrors host state
over a typed IPC protocol (`window.agentDeck.post/subscribe`, exposed by
`electron/preload.ts` via `contextBridge`); it holds no source of truth.
