<div align="center">

<img src="assets/icon.png" alt="Conduit" width="104" height="104" />

# Conduit

**An agent-agnostic, multi-agent terminal dashboard.**

Run several CLI agents — Claude Code, Codex, Gemini, Aider, or any command-line tool — side by
side in **real embedded terminals**, grouped by project, with git, review and an editor built in.

<p>
  <a href="https://github.com/nima-karami/conduit/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/nima-karami/conduit/actions/workflows/verify.yml/badge.svg" /></a>
  <img alt="Version" src="https://img.shields.io/github/v/release/nima-karami/conduit?label=version&color=d9775c" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4c8a6b" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-3a3f4b" />
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-2b3440" />
</p>

</div>

> **Status:** early but functional, Windows-only releases for now (`v0.51.0`). Conduit is also an
> experiment in autonomous AI development — see [How this project is built](#how-this-project-is-built).

## Why

Most agent tooling assumes one agent in one window. Conduit runs the actual agent CLIs, each in a
real terminal, using **your own auth** — no billing middleman, no chat pane on top of the terminal.

## Features

- **Sessions** — many concurrent terminals (xterm.js ↔ node-pty), kept alive while you switch,
  grouped by project, with a status pill (Busy / Idle / Review / Needs you / Stale). Sessions
  persist across restarts with scrollback replay and one-click relaunch.
- **Launchers** — `claude`, `codex`, `cursor-agent`, `gemini`, `aider` and `opencode` are found on
  your PATH automatically, alongside the detected shells; save any command line as a custom launcher.
- **Multi-folder sessions** — attach extra folders to a session (passed to claude as `--add-dir`);
  Files, Search, Changes and Review cover all of them.
- **Multiple windows** — tear a session out into its own window and move live sessions between
  windows without restarting them.
- **Git** — per-repo Changes panel, branch switcher, commit-history graph.
- **Review** — every change in one stacked view: stage/unstage/discard per hunk, compare refs,
  ignore whitespace, line notes you **Send to agent**.
- **Editor** — Monaco with split view, auto save, quick open, find in files, breadcrumbs, and
  clickable file paths in terminal output.
- **Code navigation** — Go to Definition / Implementations / References for TypeScript/JavaScript
  built in; Go, Python, Rust, C/C++ and C# via their language servers (see below).
- **Viewers** — Markdown (math, Mermaid), HTML preview, images, PDFs, and an in-app web view.
- **Interactive plans** — `.conduit/plans/*.md` opens as an editable document with live `ts` blocks
  and Mermaid diagrams; comment on blocks and send them back to the agent.
- **Timed messages** — send a message to a session on a timer, and optionally auto-resume after a
  usage limit resets.
- **Appearance** — three themes, animated backgrounds, font, density and file-icon-pack settings.

## Install

Download the Windows installer from [GitHub Releases](https://github.com/nima-karami/conduit/releases).
The app updates itself from new releases.

Git features need **git 2.25+** on your PATH.

### Language servers (optional)

Install a server to enable code navigation for that language. Servers run project tools, so each
folder asks for **Workspace Trust** first.

| Language | Install |
|----------|---------|
| Go | `go install golang.org/x/tools/gopls@latest` |
| Python | `pip install basedpyright` |
| Rust | `rustup component add rust-analyzer` |
| C/C++ | `winget install LLVM.LLVM` (clangd) |
| C# | `dotnet tool install --global csharp-ls` |

## Configuration

User config lives in `%APPDATA%\Conduit` (`%APPDATA%\Conduit (dev)` for `npm start` builds):

- `agents.json` — optional array of agent definitions; an entry that runs a detected CLI replaces
  its auto-detected launcher.
- `sessions.json` — persisted sessions.

```jsonc
[
  { "id": "claude", "label": "Claude Code", "command": "claude", "args": [],
    "icon": "sparkle", "color": "magenta", "cwdStrategy": "workspaceFolder" }
]
```

## Development

Requires **Node 22 (≥22.22.2), 24 (≥24.15) or 26+** (`.tool-versions` pins it for asdf/mise).

```bash
npm install
npm start               # build (esbuild → out/) and launch
npm run watch           # rebuild on change
npm run verify          # the gate: format, lint, dead code, typecheck, tests, security scans
npm run e2e:remote      # Playwright-Electron scenarios on GitHub-hosted Windows runners
```

The Electron main process owns all state; the React renderer (`webview/`) mirrors it over IPC and
holds no source of truth. `node-pty` comes from `@lydell/node-pty` prebuilt binaries; `npm run
rebuild` rebuilds it from source (needs Python + VS Build Tools).

## How this project is built

Conduit is an experiment in **loop engineering**: the code is written, tested and reviewed by AI
agents in autonomous build loops. The human role is direction — filing bugs, making product calls,
approving releases. **The code itself is not human-reviewed.** What stands in for review:

- One gate (`npm run verify`) in pre-commit and CI: thousands of unit tests, lint, typecheck,
  dead-code and duplication checks, dependency audit, SAST and secret scanning.
- Changes are verified against the **real built app** with Playwright-Electron scenarios.
- Larger changes get an adversarial review by an independent agent before merge.
- The paper trail is public: specs in [`docs/specs/`](./docs/specs), decisions in
  [`docs/adr/`](./docs/adr), per-run reports in [`docs/runs/`](./docs/runs).

Bug reports are welcome — they are what the next loop run is fed.

## License

[MIT](./LICENSE) © Nima Karami
