# S0 — captured CLI screens (2026-10-25)

Driver: `@lydell/node-pty` + `@xterm/headless` at 120×36, answering terminal queries
(`term.onData → pty.write`; without that, Claude's dialogs ignore input). Fixtures:
`test/unit/fixtures/conduit-mcp/screens/*.json` (`{cli, version, cols, rows, cursorY, lines}`, user name and
session paths sanitized).

| CLI | Version | Screen | Fixture | Notes |
|---|---|---|---|---|
| claude | 2.1.310 | folder trust | `claude-trust.json` | footer `Enter to confirm · Esc to cancel`; menu `❯ No, exit` (no digit); **default is "No, exit" — Enter quits** |
| claude | 2.1.310 | tool permission | `claude-permission.json` | `Do you want to proceed?`, `❯ 1. Yes`, footer `Esc to cancel · Tab to amend`; **cursor is at row 7, the dialog ~15 rows below** |
| claude | 2.1.310 | idle, fresh | `claude-idle-placeholder.json` | `❯ Try "fix lint errors"` — placeholder shown while input is empty |
| claude | 2.1.310 | idle after a turn | `claude-idle.json` | `❯` alone between rules |
| codex | 0.164.0 | folder trust | (text only, `.autoloop/evidence`) | `› 1. Trust and continue` / `2. Quit`, footer `enter continue · esc quit`. **A notice + Enter here trusted the folder** |

Findings:
- **Notice-as-turn (Claude): measured.** Notice text, then `\r` as a separate write → a turn that called `read_inbox`.
- **Idle vs blocking (Claude): distinguishable.** No idle capture contains `Esc to cancel`; both blocking captures do.
- **The region anchored on the cursor misses the permission dialog** (cursor at row 7, `Esc to cancel` ~row 22). Blocking
  patterns must match the whole visible viewport; empty-input stays anchored on the cursor row.
- **Codex idle/approval: not captured** (the driver's screen went blank after the trust dialog). Codex is pull-only until
  runtime QA captures them in Conduit.
- **Env passthrough:** claude passes the PTY env to its MCP child; codex and cursor strip it (codex `env_vars`,
  cursor `${env:…}` fix it).
