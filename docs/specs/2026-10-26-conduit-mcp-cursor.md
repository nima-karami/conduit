---
status: active
date: 2026-10-26
---

# Feature Spec: Cursor sessions join Conduit messaging

Extends [conduit-mcp-server](2026-10-25-conduit-mcp-server.md) §3.1. **Tier FULL, feature type UI**
(Settings row) **+ host** (wiring, screen patterns). Self-hosting backlog item 1.

## 1. Problem frame

A Cursor `agent` session in Conduit today gets a handle and a token, but no MCP server. Its wiring
is `cursor-global`, and `mcpLaunchWiring` returns no args for it (`src/mcp-launch.ts:91`). It also
gets no notices (`screen: null`). So the cheapest executor on the team can't message or be messaged.

- **Job:** a Cursor session can call the four Conduit tools, and it is notified like Claude and Codex.
- **Actors:** the human (opts in once), the Cursor CLI, the host.
- **Success:** after one **Connect Cursor** click, every Cursor session that launches is
  `messaging: connected`. A message to it types a notice that becomes a `read_inbox` turn.
- **Non-goals:**
  - Cursor IDE (the editor) integration.
  - Project-level `.cursor/mcp.json`.
  - Auto-approving anything other than Conduit's own server.
  - Session resume (item 2).

## 2. Measured facts (2026-10-26, Cursor agent 2026.10.22-27dcf5f)

| Fact | How measured |
|---|---|
| No CLI flag or env var takes an MCP config path. The user file is fixed at `homedir()/.cursor/mcp.json`; the project file is `<git root or cwd>/.cursor/mcp.json`. `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR` don't move `mcp.json`. | bundle read: loader `Pe`, `cursor-config/dist/paths.js` |
| Servers from the **user** file get no approval middleware. Project-file servers need a hashed key in `projects/<slug>/mcp-approvals.json`. `--approve-mcps` approves every server. | bundle read; **ASSUMED** until S0 runs it |
| Stdio children get only a Windows env allowlist plus the entry's `env`. `${env:VAR}` in `env` values resolves from the agent's own env; an unset var stays a literal placeholder. | bundle read (`StdioClientTransport`, interpolation regex); **ASSUMED** until S0 |
| Idle screen: the input is the row `  → Plan, search, build anything` (placeholder). The terminal cursor parks **5 rows below it**, on a blank row. A draft replaces the placeholder: `  → hello there`. Ctrl+U clears it back. | live capture in this app (`self-host.mjs screen`), fixtures to be committed (S1) |
| Workspace-trust dialog footer: `Use arrow keys to navigate, Enter to select, or press the key shown` | bundle read + brief's live capture |
| Placeholder after a finished turn, the tool-call approval UI (if any) for an MCP tool from the user file, and notice-then-`\r` becoming a turn | **not measured** → S0 |

## 3. Behavior

### 3.1 Connect / Disconnect (Settings → Agent messaging)
- Row: **Cursor** · state text · one button.
- **States:**
  - `disconnected`: no `conduit` entry. Button: **Connect Cursor**.
  - `connected`: the entry equals what this app would write. Button: **Disconnect**.
  - `stale`: an entry exists but differs, e.g. another Conduit build or a moved install. Button:
    **Connect Cursor**, which rewrites it.
  - `error`: the file is unreadable or not valid JSON. The message names the file. No button,
    and the file is never overwritten.
- **Connect:**
  1. Read `~/.cursor/mcp.json`; a missing file means `{}`.
  2. If no backup exists yet, copy the original once to `mcp.json.conduit-backup`.
  3. Set `mcpServers.conduit` and leave every other key as it was.
  4. Write atomically.
- **Disconnect:** remove `mcpServers.conduit` only, then write atomically. If `mcpServers` is now
  empty, keep it as `{}` rather than deleting the file.
- The state is re-read whenever Settings opens and after each action. The host never caches it.
- Nothing is written without the click (spec decision, blockers.md).

### 3.2 The entry (install-independent endpoint)
```json
"conduit": {
  "command": "<process.execPath>",
  "args": ["<shimPath>"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "CONDUIT_SESSION_TOKEN": "${env:CONDUIT_SESSION_TOKEN}",
    "CONDUIT_MCP_ENDPOINT": "${env:CONDUIT_MCP_ENDPOINT}"
  }
}
```
- **The shim takes its endpoint from `--endpoint`, or else from `CONDUIT_MCP_ENDPOINT`.** The
  endpoint is per userData, and a user file shared by an installed Conduit and a dev build must
  route each session to its own host. The host puts `CONDUIT_MCP_ENDPOINT` in the PTY env of every
  messaging session, beside the token.
- `pty-host` already strips `CONDUIT_SESSION_TOKEN` from a nested Conduit's env
  (`src/pty-host.ts:64`). It strips `CONDUIT_MCP_ENDPOINT` the same way.
- **Outside Conduit** the placeholders stay literal. The shim must treat a value that starts with
  `${` as absent. With no endpoint it answers `initialize` and lists no tools, never crashing;
  with no token every call returns `not_in_session` (existing rule).
- **Stale check:** compare `command`, `args` and `env` by value with the entry this app would write.

### 3.3 Session wiring
- `cursor-global` launches add **no args**. The token and endpoint go in the PTY env, as for the
  other adapters.
- A Cursor session whose user file has no current entry launches as today, with messaging
  `unavailable`. The card reason is new: `cursor-not-connected` → "Messaging unavailable: Connect
  Cursor in Settings". This feature never breaks a launch.

### 3.4 Notices: a per-adapter input-row locator
- `ScreenPatterns` gains an optional `inputRow?: RegExp`. When it is set, the **input row** is the
  last viewport row at or above `cursorY` that matches it. When it is unset, the input row is the
  cursor row, which keeps Claude and Codex unchanged.
- Empty-input is tested on the input row. The notice-echo window runs from the input row to
  `max(cursorY, input row + NOTICE_ECHO_ROWS - 1)`, because Cursor's box wraps downward.
- When `inputRow` is set and no row matches, the verdict is `unknown`, so the gate stays closed.
- Cursor patterns (S0 may extend the placeholder list and blocking list):
  - `inputRow: /^\s*→/`
  - `emptyInput: [/^\s*→\s*$/, /^\s*→\s+Plan, search, build anything\s*$/]` plus any measured
    after-turn placeholder.
  - `blocking: [/Use arrow keys to navigate, Enter to select/]` plus any measured tool-approval
    footer.
- The fixed notice text and the gate are unchanged.

## 4. Edge cases

| Condition | Behavior |
|---|---|
| `mcp.json` has comments or trailing commas (not valid JSON) | `error` state, no write |
| `mcp.json` changes between read and write (Cursor IDE edits) | read-modify-write is not locked. Accepted: the window is milliseconds. The write keeps the keys read a moment ago |
| A backup already exists | it is never overwritten (it is the pre-Conduit original) |
| A user-authored `conduit` entry differs | `stale`. Connect overwrites it; the backup still holds the original |
| `~/.cursor` missing | Connect creates the dir and the file |
| Cursor running when Connect is clicked | that session isn't wired until it relaunches. The card reason stays until then |
| Both an installed Conduit and a dev build are present | the last Connect wins the `command`. Each session still reaches its own host via the env endpoint. The other app shows `stale` |
| A plain shell with `agent` in it | it has no `CONDUIT_SESSION_TOKEN` and gets `not_in_session` (existing threat model) |
| Cursor shows a tool-call approval prompt for Conduit tools | if measured in S0, it becomes a blocking pattern; pre-approval goes under Decisions |

## 5. Defaults vs settings
- Connect is off by default (opt-in, because it writes a user file). There is no new setting; the
  entry's existence *is* the state.

## 6. Scope
- **MVP (this spec):**
  - S0 measurement on the real CLI.
  - Shim env endpoint.
  - Connect/Disconnect IPC and the Settings row.
  - The locator and Cursor patterns.
  - Fixtures, units, e2e, and runtime QA with the real `agent`.
- **Out:** project-level wiring, Cursor IDE, pre-approving tools by editing `cli-config.json`
  (Decision D2), resume.

## 7. Acceptance criteria
1. Connect on a missing file creates `~/.cursor/mcp.json` with exactly `mcpServers.conduit`
   (§3.2). The state reads `connected`.
2. Connect on a file with other servers keeps them byte-for-byte equal as parsed values. A backup
   holds the original, and a second Connect doesn't touch the backup.
3. Disconnect removes only `conduit`. Invalid JSON gives `error`, and the file is unchanged.
4. An entry with a different `command` reads `stale`.
5. The shim with no `--endpoint`, `CONDUIT_MCP_ENDPOINT` set and a valid token relays; with a
   literal `${env:…}` endpoint it answers `initialize` with no tools and exits cleanly when stdin
   closes.
6. A nested Conduit's PTY env has neither `CONDUIT_SESSION_TOKEN` nor `CONDUIT_MCP_ENDPOINT`.
7. `screenVerdict` on the committed Cursor fixtures returns `empty-input` for idle, `unknown` for a
   draft, `notice-echoed` for a typed notice, and `blocking` for the trust dialog. Claude and
   Codex fixture results are unchanged.
8. Real CLI (runtime QA, this app): after Connect, a fresh Cursor session lists as `connected`. A
   `send_message` to it from the lead types the notice and submits it; Cursor calls
   `read_inbox`; it can `send_message` back.
9. A Cursor session launched without Connect shows the `cursor-not-connected` reason, and its
   launch is unchanged.

## 8. UI (Settings row)
- **States:** see §3.1. The button is disabled while the action runs, and the state re-reads after.
- **Interaction:** keyboard-reachable button in tab order with a visible focus ring (existing
  `Section` / button primitives).
- **Accessibility:** the state text is in a polite live region, so a click's result is announced;
  `error` is announced with the file path. The button's accessible name is its label.
- **i18n:** all strings go in `webview/conduit-mcp-strings.ts`. `cursorConnect`, `cursorDisconnect`
  and `cursorState` already exist; add `error` and the card reason. The path is shown verbatim
  (LTR).
- **Tokens:** existing Settings tokens only. No new colors.

## 9. Producers / consumers
| Data | Producer | Consumer | Both in scope |
|---|---|---|---|
| `~/.cursor/mcp.json` `conduit` entry | Connect / Disconnect (new) | the Cursor CLI, the stale check | yes |
| `CONDUIT_MCP_ENDPOINT` in the PTY env | host launch (new) | the shim through Cursor's interpolation; pty-host strip | yes |
| Input-row verdict | `screenVerdict` (changed) | notice gate, echo check before `\r` | yes. Claude and Codex keep the cursor-row behavior because `inputRow` is unset |

## 10. Decisions Needed
- **D1 (normal):** Connect writes the user file (the 2026-10-25 decision stands). The approval
  bypass for user-file servers is read from the bundle; S0 must confirm it before the UI ships.
- **D2 (high, only if S0 measures a per-call tool prompt):** default is to leave Cursor's
  per-call approval alone. The notice still works, but each tool call waits for the human.
  Pre-approving through `~/.cursor/cli-config.json` permissions is a second user-file edit;
  queue it for the human.
