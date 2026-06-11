# Conduit

**An agent-agnostic, multi-agent terminal dashboard.** Conduit is a standalone
desktop app (Electron) that launches, groups, and controls multiple CLI-agent
sessions — Claude Code, Aider, or any command-line agent — in **real embedded
terminals**, alongside a live git panel and per-project customization counts.

> Status: early but functional (`v0.1.0`). See [`docs/DECISIONS.md`](./docs/DECISIONS.md)
> for the design history and the reasoning behind key technical choices.

## Why

Most agent tooling assumes one agent in one window. Conduit is built for the
opposite: running several CLI agents at once, each in a **real terminal**, using
**your own auth**, grouped by the project they belong to. There's no billing
middleman and no chat-pane abstraction sitting on top of the terminal — just the
actual agent CLIs, side by side, with the git status and `.claude` configuration
for each project visible at a glance.

## Features

- **3-pane shell**: sessions sidebar + customizations · center real terminals ·
  right-hand git Changes/Files.
- **Real embedded terminals** (xterm.js ↔ node-pty) running the actual agent CLI.
- **Multiple concurrent sessions**, kept mounted so switching never kills them.
- **Grouped by project folder**, with **launch / rename / kill / relaunch**.
- **Agent registry**: define any CLI agent once, then launch it from a picker.
- **Live git panel** (`git status` + `--numstat`) and **customization counts**
  (`.claude` agents / skills / instructions / hooks / MCP) for the active project.
- **Status badges**: `running` / `exited` / `stale`. Sessions persist across
  restarts (restored as `stale` with a one-click relaunch).

## Getting started

```bash
npm install
npm start            # builds (main + preload + renderer) and launches the app
```

The window opens empty on first run — click **New** to pick one of the terminals
detected on your machine; it spawns in your home directory.

### Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Build, then launch the Electron app |
| `npm run build` | Bundle main, preload, and renderer via esbuild → `out/` |
| `npm run watch` | Rebuild on change |
| `npm run rebuild` | Rebuild `node-pty` against Electron's ABI (fallback; see below) |
| `npm run test:unit` | Vitest unit tests (pure logic) |
| `npm run typecheck` | Type-check host + renderer |

### Previewing the UI without launching the app

```bash
npm run build
node tools/render-webview.mjs        # writes out/preview.html with mock data
node tools/preview-server.mjs 5174   # serves out/ at http://127.0.0.1:5174/preview.html
```

The renderer falls back to a small fake shell when the host bridge is absent, so
the full UI is visible in a plain browser.

## Configuration

The **New** menu lists the terminals/shells auto-detected on your machine
(PowerShell, Git Bash, cmd, and WSL on Windows; zsh / bash / fish / sh
elsewhere). New sessions open in your home directory.

Custom **agents** (Claude Code, Aider, …) are opt-in: add an `agents.json` — an
array of agent definitions — in the app's user-data directory
(`app.getPath('userData')`), and they'll appear in the New menu alongside the
shells. Sessions persist to `sessions.json` in the same place.

```jsonc
[
  { "id": "claude", "label": "Claude Code", "command": "claude", "args": [],
    "icon": "sparkle", "color": "magenta", "cwdStrategy": "workspaceFolder" },
  { "id": "aider", "label": "Aider", "command": "aider", "args": [],
    "icon": "sparkle", "color": "cyan", "cwdStrategy": "workspaceFolder" }
]
```

(Or simply type `claude` / `aider` inside any shell session.)

## Native module note

`node-pty` is a native addon and must match Electron's ABI. To avoid requiring a
C++ toolchain, Conduit depends on **`@lydell/node-pty`** — a maintained fork that
ships prebuilt binaries (including Electron ABIs). If you ever need to rebuild
from source, install Python + VS Build Tools and run `npm run rebuild`.

## Architecture

The **Electron main process** (`electron/main.ts`) owns all state through small,
unit-tested modules (`AgentRegistry`, `SessionManager`, `Persistence`,
`projectInfo`) plus `PtyHost`, which manages the node-pty processes keyed by
session id. A **React renderer** (`webview/`) draws the dashboard and mirrors
host state over a typed IPC protocol (exposed by `electron/preload.ts` via
`contextBridge`); it holds no source of truth of its own.

## License

[MIT](./LICENSE) © Nima Karami
