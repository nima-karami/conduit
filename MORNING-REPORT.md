# Morning report — Agent Deck v1

**Built overnight, 2026-06-08.** v1 is complete, fully verified, and committed.
Working tree is clean. Nothing is half-finished.

## TL;DR

A VS Code extension that opens a **full-window, agent-agnostic dashboard** to
launch/group/control multiple CLI-agent sessions (Claude Code or any CLI) in
**native VS Code terminals** — **no Copilot subscription**. Everything you said
was broken in Warp (file tree, tab dedup, directory grouping, search, go-to-def)
is left to VS Code, which does it correctly; we built only the agent layer.

## Verification — all green ✅

| Gate | Result |
|------|--------|
| `npm run build` | OK (extension + webview + tests bundle) |
| `npm run typecheck` | OK (host + webview) |
| `npm run test:unit` | **15/15 passing** (AgentRegistry, SessionManager incl. restore/relaunch, persistence) |
| `npm run test:int` | **passing** (`@vscode/test-electron`: activation, command, terminals API) |
| Webview visual | **verified** via playwright-cli screenshot (header, agent picker, 2 directory groups, RUNNING/EXITED/STALE badges) |

The integration test caught a real bug overnight (missing `activationEvents`) —
fixed (see DECISIONS #10).

## How to review (5 minutes)

1. Read the spec: `docs/superpowers/specs/2026-06-08-agent-dashboard-vscode-design.md`
2. See the UI without launching VS Code:
   ```
   npm install
   npm run build
   node tools/render-webview.mjs
   node tools/preview-server.mjs 5174
   ```
   Open http://127.0.0.1:5174/preview.html
3. Run it for real: open the folder in VS Code, press **F5**, then run
   **“Agent Deck: Open Dashboard”** from the Command Palette.

## What's done (v1 scope you approved)

- Full-window dashboard webview (auto-moves to its own window — see "needs your eyes")
- Launch / focus / rename (inline ✎) / kill sessions — all reachable from the UI
- Sessions grouped by project folder (cross-project)
- Agent registry (define any CLI agent in `agentDeck.agents`; Claude preconfigured)
- Status badges: running / exited / stale
- Persistence **wired end-to-end**: sessions saved on change, restored on
  activate as `stale`, with a one-click **↻ Relaunch** button (visually verified)
- Per-session terminal tab color + icon

## Needs your eyes (couldn't self-verify overnight)

1. **The auto "open in new window" behavior** (DECISIONS #12). I wired
   `workbench.action.moveEditorToNewWindow` on open, but couldn't visually
   confirm an OS window unattended. If it feels wrong, set
   `agentDeck.openInNewWindow: false`.
2. **Real end-to-end with an interactive Claude session** — I verified the
   `claude` binary resolves and a terminal launches the command, but did not
   drive a live Claude session (would burn your usage / hang on the TUI).
3. **Naming** — "Agent Deck" is a placeholder.
4. **Visual taste** vs. the Agents Window — current styling is clean but minimal.

## Decisions I made autonomously

Full log in `DECISIONS.md` (13 entries). Highlights: pinned `@types/vscode` to
1.120 (1.123 not on npm), Vitest for unit tests, editor-webview + auto
new-window instead of a proposed-API auxiliary window, `.gitattributes` LF
normalization, and the activation-event fix.

## Suggested next steps (need your go-ahead)

- **v2 — Claude-smart status:** detect "needs your input" via Claude Code hooks
  (Notification/Stop) → badges + OS notification. **This is a new feature that
  deserves its own short brainstorm/spec** (how the hook signals the extension —
  file-watch vs. local socket), so I stopped here rather than build it unspecced.
- Minor: 5 `npm audit` dev-dep vulns left as-is (DECISIONS #9); address with care.

## Commit trail

`git log --oneline` — spec/plan → scaffold → 6 TDD modules → webview bridge +
React UI → visual harness → integration test + activation fix → new-window +
gitattributes. One logical commit per task.
