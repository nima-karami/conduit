<div align="center">

<img src="assets/icon.png" alt="Conduit" width="104" height="104" />

# Conduit

**An agent-agnostic, multi-agent terminal dashboard.**

Launch, group, and control multiple CLI-agent sessions — Claude Code, Aider, or any
command-line agent — in **real embedded terminals**, with a live git panel and
per-project context at a glance.

<p>
  <a href="https://github.com/nima-karami/conduit/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/nima-karami/conduit/actions/workflows/verify.yml/badge.svg" /></a>
  <img alt="Version" src="https://img.shields.io/github/v/release/nima-karami/conduit?label=version&color=d9775c" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4c8a6b" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-3a3f4b" />
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-2b3440" />
</p>

</div>

> **Status:** early but functional, Windows-only for now (`v0.24.0`). See [`docs/runs/`](./docs/runs)
> and [`docs/adr/`](./docs/adr) for the design history and the reasoning behind key technical choices.

## Why

Most agent tooling assumes one agent in one window. Conduit is built for the
opposite: running several CLI agents at once, each in a **real terminal**, using
**your own auth**, grouped by the project they belong to. There's no billing
middleman and no chat-pane abstraction sitting on top of the terminal — just the
actual agent CLIs, side by side, with the git status and `.claude` configuration
for each project visible at a glance.

## Features

- **Three-pane shell** — sessions sidebar + customization counts · center real
  terminals · right-hand git **Changes / Search / Files**.
- **Real embedded terminals** (xterm.js ↔ node-pty) running the actual agent CLI.
- **Multiple concurrent sessions**, kept mounted so switching never kills them.
  Typing `exit` in a plain shell closes its session (warning first if it has open tabs).
- **Multiple windows** — tear a session out into its own window and move live sessions
  between windows with no PTY restart.
- **Grouped by project folder**, with **launch / rename / kill / relaunch**.
- **Agent registry** — define any CLI agent once, then launch it from a picker.
- **Git, end to end** — live `Changes` panel (`git status` + `--numstat`), an in-app
  **branch switcher**, a **commit-history graph**, and a stacked **review-all-changes**
  view — plus **customization counts** (`.claude` agents / skills / instructions /
  hooks / MCP) for the active project.
- **Editor** — embedded Monaco with syntax highlighting for ~70 file types,
  cross-file go-to-definition, breadcrumbs, a global find-in-files search, and clickable
  terminal **path links** (including abbreviated `.../foo.ts` paths from agent output).
- **Rich file viewers** — Markdown (math, Mermaid, alerts, TOC), images (zoom + diff),
  PDFs, and a built-in web view.
- **Explorer** — lazy file tree that shows build/dependency dirs, dims git-ignored
  entries, and offers selectable file-icon packs (none / minimal / colored).
- **Appearance** — themes, animated backgrounds, font + density controls, and
  per-surface zoom.
- **Status badges** — `running` / `exited` / `stale`. Sessions persist across
  restarts (restored as `stale` with a one-click relaunch), with optional scrollback replay.

## Getting started

```bash
npm install
npm start            # builds (main + preload + renderer) and launches the app
```

The window opens to a start screen — click **New session** to pick one of the
terminals detected on your machine; it spawns in your home directory.

### Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Build, then launch the Electron app |
| `npm run build` | Bundle main, preload, and renderer via esbuild → `out/` |
| `npm run watch` | Rebuild on change |
| `npm run verify` | Full gate: format + lint + typecheck + tests + dup/dead-code + audit + SAST |
| `npm run test:unit` | Vitest unit tests (pure logic) |
| `npm run typecheck` | Type-check host + renderer (two tsconfigs) |
| `npm run rebuild` | Rebuild `node-pty` against Electron's ABI (fallback; see below) |

### Previewing the UI without launching the app

```bash
npm run build
node tools/render-webview.mjs        # writes out/preview.html with mock data
node tools/preview-server.mjs 5174   # serves out/ at http://127.0.0.1:5174/preview.html
```

The renderer falls back to a small fake shell when the host bridge is absent, so the
full UI is visible in a plain browser.

## Configuration

The **New** menu lists the terminals/shells auto-detected on your machine
(PowerShell, Git Bash, cmd, and WSL). New sessions open in your home directory.

Custom **agents** (Claude Code, Aider, …) are opt-in: add an `agents.json` — an array
of agent definitions — in the app's user-data directory (`app.getPath('userData')`),
and they'll appear in the New menu alongside the shells. Sessions persist to
`sessions.json` in the same place.

```jsonc
[
  { "id": "claude", "label": "Claude Code", "command": "claude", "args": [],
    "icon": "sparkle", "color": "magenta", "cwdStrategy": "workspaceFolder" },
  { "id": "aider", "label": "Aider", "command": "aider", "args": [],
    "icon": "sparkle", "color": "cyan", "cwdStrategy": "workspaceFolder" }
]
```

(Or simply type `claude` / `aider` inside any shell session.)

## Architecture

The **Electron main process** (`electron/main.ts`) owns all state through small,
unit-tested modules (`AgentRegistry`, `SessionManager`, `Persistence`, `projectInfo`)
plus `PtyHost`, which manages the node-pty processes keyed by session id. A **React
renderer** (`webview/`) draws the dashboard and mirrors host state over a typed IPC
protocol (exposed by `electron/preload.ts` via `contextBridge`); it holds no source of
truth of its own.

Durable decisions live in [`docs/adr/`](./docs/adr); the layout and lifecycle of the
docs tree is itself a contract (see [`docs/adr/0003-docs-layout-and-lifecycle.md`](./docs/adr/0003-docs-layout-and-lifecycle.md)).

### Native module note

`node-pty` is a native addon and must match Electron's ABI. To avoid requiring a C++
toolchain, Conduit depends on **`@lydell/node-pty`** — a maintained fork that ships
prebuilt binaries (including Electron ABIs). If you ever need to rebuild from source,
install Python + VS Build Tools and run `npm run rebuild`.

## License

[MIT](./LICENSE) © Nima Karami
