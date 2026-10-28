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
| Servers from the **user** file load interactively with **no approval step** (`probeuser - enabled`, initialize → `tools/list`). | **Measured** (S0): bare ConPTY, `USERPROFILE` → scratch home |
| Project-file servers are a dead end on Windows. The interactive CLI never connected one (`/mcp list` → `error`), even when approved. The approval key hashes the **resolved** env, so a `${env:CONDUIT_SESSION_TOKEN}` server re-prompts "MCP Server Approval Required" on every session. | **Measured** (S0), inside Conduit and in a bare ConPTY |
| Stdio children get only a Windows env allowlist (APPDATA, PATH, TEMP, USERPROFILE, …) plus the entry's `env`; `CONDUIT_SESSION_TOKEN` itself is absent. `${env:VAR}` resolves from the agent's own env. An unset var stays the **literal** placeholder (present, not empty). | **Measured** (S0 probe log) |
| Idle input row: `  → Plan, search, build anything` at startup, and `  → Add a follow-up` after a turn. A draft replaces the placeholder (`  → hello`). Ctrl+U restores it. While a turn runs the row reads `  → Add a follow-up … ctrl+c to stop`. For ~9 s at turn start it still shows the submitted text. | **Measured** (S0 + lead captures) |
| The cursor parks **3–8 rows below** the input row (5 at startup, 6–7 after a turn or Esc). | **Measured** (S0) |
| Menus also draw `→` rows at or above the cursor: approval menus (`→ Run (once) (y)`), slash autocomplete, `/mcp list`. | **Measured** (S0) |
| Blocking screens, exact text: trust dialog footer `Use arrow keys to navigate, Enter to select, or press the key shown`; `MCP Server Approval Required` (same footer); per-call tool approval `Run this MCP tool?` and shell approval `Run this command?` (menu `→ Run (once) (y)`, no footer); `/mcp list` footer `… Esc to close`. | **Measured** (S0) |
| **Each MCP tool call asks first** ("Run this MCP tool?"). The menu offers `Allowlist MCP Tool (tab)`, which persists in Cursor's own config. | **Measured** (S0) |
| The notice typed with no Enter fits one row at 135 cols (`  → [conduit] New messages…`). A lone `\r` after it **becomes a turn**. | **Measured** (S0) |
| The CLI itself writes `~/.cursor/cli-config.json` (e.g. a prompt-streak counter) while prompts are open. | **Measured** (S0 side effect) |

## 3. Behavior

### 3.1 Connect / Disconnect (Settings → Agent messaging)
> **Superseded by [2026-10-27-conduit-mcp-install](2026-10-27-conduit-mcp-install.md) §2.3, §3.5–§3.6:**
> the Cursor row is one of four on Settings → **MCP**; Connect/Disconnect are **Install/Uninstall**,
> through the generic `mcpInstall` status/act channels (the `cursor-connect:*` channels are gone).
> The old `stale` state is split into `other-conduit` (another Conduit's entry: Use this Conduit, no
> confirm) and `conflict` (a server named `conduit` that isn't Conduit: Replace… after a confirm).
> The text below is kept as the original design.

- Row: **Cursor** · state text · buttons. Description: "Adds Conduit to Cursor's user MCP config
  (`~/.cursor/mcp.json`). Cursor's editor reads the same file and will list a Conduit server with no
  tools outside Conduit."
- **States:**

  | State | Meaning | Buttons |
  |---|---|---|
  | `disconnected` | no `conduit` entry, or no file | **Connect Cursor** |
  | `connected` | the entry deep-equals `cursorEntry()` for this app | **Disconnect** |
  | `stale` | a `conduit` entry exists but differs (another Conduit install or build, a moved install, user-authored) | **Connect Cursor** (rewrites) + **Disconnect** |
  | `error` | unreadable, not JSON, or wrong shape (top level or `mcpServers` not an object) | **Check again**; the file is never written |
  | `pending` | an action is running | buttons disabled |

  A failed action (EPERM / EBUSY / EACCES / ENOSPC, or the backup failing) keeps the previous state
  and shows `actionFailed` with the OS error code. The file is left unchanged.
- **Connect:**
  1. Read `~/.cursor/mcp.json` through its realpath, so a dotfile-manager symlink stays a link. A
     missing file means `{}`; a UTF-8 BOM is stripped.
  2. **Backup rule:** if no backup exists and the file has no `conduit` key or has a stale
     `conduit` entry, write the original to `mcp.json.conduit-backup` first (a missing original is
     recorded as the JSON text `null`). An already connected entry is a no-op and creates or touches
     no backup. Backup creation is exclusive; a concurrently created backup is preserved. If backup
     creation fails, abort.
  3. Set `mcpServers.conduit`; every other key stays deep-equal.
  4. Write atomically: 2-space JSON plus a trailing newline.
- **Disconnect:** remove `mcpServers.conduit` only, same write path. If `mcpServers` is now empty it
  stays `{}`; the file is never deleted and the backup is left in place.
- The state is re-read whenever Settings opens, on **Check again**, and after each action. The host
  never caches it.
- Nothing is written without the click (spec decision, blockers.md). The home dir is an injected
  dependency, so tests never touch the real one.

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
- **Outside Conduit** the placeholders stay literal. The shim treats an **empty value, or one that
  starts with `${`**, as absent — for both the endpoint and the token. With no endpoint it answers
  `initialize` and lists no tools, never crashing; with no token every call returns
  `not_in_session` (existing rule).
- The entry is built by a separate `cursorEntry(execPath, shimPath)` (no `--endpoint`, unlike
  `mcpServerCommand`). The stale check deep-compares against it.
- **Consequence (D1):** every Cursor agent run and every Cursor IDE window on the machine spawns
  Conduit's executable as this server. Outside a Conduit session it lists no tools.

### 3.3 Session wiring
- `cursor-global` launches add **no args**. The token and endpoint go in the PTY env, as for the
  other adapters.
- At launch the host reads the user file synchronously (it is small, and the launch path is sync).
  **Any `conduit` entry whose env carries both placeholders** is wired: mint the token, set the env.
  That covers `connected` and a `stale` entry from another build, because any shim plus the env
  endpoint relays to *this* host.
- A missing entry, an entry without the placeholders, or `error` → messaging `unavailable` with a
  new `McpUnavailableReason`, `cursor-not-connected` → "Messaging unavailable: Connect Cursor in
  Settings". This feature never breaks a launch.

### 3.4 Notices: a per-adapter input-row locator
- `ScreenPatterns` gains an optional `inputRow?: { pattern: RegExp; maxAbove: number }`. When it is
  set, the **input row** is the last row in `[cursorY - maxAbove, cursorY]` that matches `pattern`.
  `maxAbove` is the measured park distance plus a wrap allowance (S0). No match → `unknown`, so the
  gate stays closed.
- **Unset `inputRow` keeps today's behavior exactly** (Claude, Codex): empty-input on the cursor
  row, echo window `cursorY - 2 .. cursorY`.
- Set: empty-input is tested on the input row. The echo window starts at the input row and runs in
  the box's measured wrap direction (S0), at most `NOTICE_ECHO_ROWS` rows.
- A mid-turn screen must read `unknown`. S0 captures one and it becomes a fixture. If a mid-turn
  screen still shows an empty `→` row inside the window, the fixture records that, and the gate's
  idle ≥ 3 s condition is what keeps it closed.
- Cursor patterns (S0 may extend the placeholder list and blocking list):
  - `inputRow: { pattern: /^\s*→/, maxAbove: 8 }`. The last match wins, so a menu row below the
    input is the one tested. It has text, and blocking patterns catch it anyway.
  - Echo window: the input row and the 2 rows below it (the box wraps downward).
  - `emptyInput: [/^\s*→\s*(Plan, search, build anything|Add a follow-up)?\s*$/]`. A running turn's
    `… ctrl+c to stop` suffix fails it.
  - `blocking: [/Use arrow keys to navigate, Enter to select/, /MCP Server Approval Required/,
    /Run this (MCP tool|command)\?/, /^\s*→ Run \(once\) \(y\)/, /Esc to close\s*$/]`.
- The fixed notice text and the gate are unchanged.

## 4. Edge cases

| Condition | Behavior |
|---|---|
| `mcp.json` has comments or trailing commas (not valid JSON), or has an invalid shape | `error` state with `EJSON`, no write |
| `mcp.json` changes between read and write (Cursor IDE edits) | read-modify-write is not locked. Accepted: the window is milliseconds. The write keeps the keys read a moment ago |
| A backup already exists | it is never overwritten (it is the pre-Conduit original) |
| A user-authored `conduit` entry differs | `stale`. Connect backs up the stale original when no backup exists, then overwrites it |
| `~/.cursor` missing | Connect creates the dir and the file |
| Cursor running when Connect is clicked | that session isn't wired until it relaunches. The card reason stays until then |
| Both an installed Conduit and a dev build are present | the last Connect wins the `command`. Both apps wire their sessions (placeholder env), and each session reaches its own host via the env endpoint. The other app shows `stale` |
| Conduit uninstalled with the entry left | Cursor shows a failing server. The Settings description warns; the release note says to Disconnect before uninstalling |
| Cursor IDE windows | they spawn the shim, which lists no tools (no token, no endpoint) |
| `mcp.json` is a symlink | read and written through its realpath; the link survives |
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
All file ACs run against an injected home dir.
1. Connect on a missing file creates `.cursor/mcp.json` with exactly `mcpServers.conduit` =
   `cursorEntry()`, as 2-space JSON plus a trailing newline; the backup contains the JSON text
   `null`. The state reads `connected`.
2. Connect on a file with other servers and no `conduit` entry keeps the servers deep-equal and the
   backup holds the original. Connect on a stale `conduit` entry backs up that original before
   overwriting it when no backup exists. A second Connect, or Connect on an already connected entry,
   creates or touches no backup. An existing backup is never overwritten.
3. Disconnect removes only `conduit`, from `connected` and from `stale`. Invalid JSON, a non-object
   top level, or a non-object `mcpServers` gives `error`, and the file is unchanged. A
   BOM-prefixed valid file parses.
4. An entry with a different `command` reads `stale`, and a launch with it is still wired.
4b. A write or backup failure leaves the file unchanged and reports `actionFailed`.
4c. A symlinked `mcp.json` (posix test): the link survives Connect and its target is updated.
5. The shim with no `--endpoint`, `CONDUIT_MCP_ENDPOINT` set and a valid token relays; with a
   literal `${env:…}` endpoint it answers `initialize` with no tools and exits cleanly when stdin
   closes.
6. A nested Conduit's PTY env has neither `CONDUIT_SESSION_TOKEN` nor `CONDUIT_MCP_ENDPOINT`.
7. `screenVerdict` on the committed Cursor fixtures:
   - idle (before and after a turn) → `empty-input`;
   - a draft and a wrapped draft → `unknown`;
   - a typed notice → `notice-echoed`;
   - the trust dialog → `blocking`;
   - mid-turn → `unknown`;
   - an old empty `→` row further than `maxAbove` from the cursor → `unknown`.

   Claude and Codex: every existing fixture result is unchanged, and a new test shows a Claude
   notice wrapped over the 3 rows ending at the cursor still reads `notice-echoed`.
7b. e2e `test/e2e/conduit-mcp-cursor-connect.e2e.mjs`, with HOME/USERPROFILE pointed at a temp dir:
   Settings shows `disconnected` → Connect → `connected` (announced in the live region) → the file
   holds the entry → Disconnect → `disconnected`.
8. Real CLI (runtime QA, this app): after Connect, a fresh Cursor session lists as `connected`. A
   `send_message` to it from the lead types the notice and submits it; Cursor calls
   `read_inbox`; it can `send_message` back.
9. A Cursor session launched without Connect shows the `cursor-not-connected` reason, and its
   launch is unchanged.

## 8. UI (Settings row)
- **States:** the §3.1 table, including `pending`.
- **Interaction:** keyboard-reachable buttons in tab order with a visible focus ring (existing
  `Section` / button primitives). After an action the button set may change; focus moves to the
  row's first button.
- **Accessibility:** the state text is in a polite live region, so a click's result is announced;
  `error` and `actionFailed` are announced with the file path. Disconnect's accessible name is
  "Disconnect Cursor".
- **i18n:** all strings go in `webview/conduit-mcp-strings.ts`. Change `cursorState.stale` to
  "Connected to another Conduit install"; add `error`, `actionFailed`, `checkAgain`, `cursorDesc`,
  the Disconnect aria label and the card reason. The path is shown verbatim (LTR) and wraps with
  `overflow-wrap: anywhere` (check with `npm run text-fit`).
- **Tokens:** existing Settings tokens only. No new colors.

## 9. Producers / consumers
| Data | Producer | Consumer | Both in scope |
|---|---|---|---|
| `~/.cursor/mcp.json` `conduit` entry | Connect / Disconnect (new) | the Cursor CLI, the stale check | yes |
| `CONDUIT_MCP_ENDPOINT` in the PTY env | host launch (new) | the shim through Cursor's interpolation; pty-host strip | yes |
| Input-row verdict | `screenVerdict` (changed) | notice gate, echo check before `\r` | yes. Claude and Codex keep the cursor-row behavior because `inputRow` is unset |

## 10. Doc updates in the same change
- `src/mcp-launch.ts` header and parent spec §3.1: name the Cursor exception (an opt-in edit of
  the user file); parent §3.1's Cursor bullet: env carries endpoint + token placeholders, and
  user-file servers need no approval (replaces "per-project approval follows `agent mcp enable`").

## 11. Decisions Needed
- **D1 (normal, resolved by S0):** Connect writes the user file (the 2026-10-25 decision stands).
  S0 measured that user-file servers need no approval, and the project file is a dead end on
  Windows.
- **D2 (high, measured):** each Conduit tool call asks "Run this MCP tool?". Default: Conduit
  doesn't touch `cli-config.json`, a second user file that the CLI itself also writes. The human
  presses **Allowlist MCP Tool (tab)** once per tool, the first time it's asked; Cursor persists
  that. The Settings description says so. Alternative for the human to choose: Connect also adds
  `Mcp(conduit:*)` to `cli-config.json`'s allow list. Until a tool is allowlisted, a notice turn
  stops at the approval prompt, and the gate reads it as `blocking`.
