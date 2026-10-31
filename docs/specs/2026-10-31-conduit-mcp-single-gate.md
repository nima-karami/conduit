---
status: implemented
date: 2026-10-31
tier: LITE
---

# Feature Spec: Conduit's tool policy is the only approval gate

**Tier:** LITE   **Feature type:** host config writes + launch wiring
**Request (user decision):** Conduit's own MCP tool policy (off/ask/on) must be the ONLY approval gate
in every agent CLI; an `ask` tool must not prompt twice.

## 1. Problem
An `ask` tool double-prompts: the CLI asks for permission, then Conduit's approval card asks. And the
CLI's own MCP call timeout (Codex 60 s, OpenCode 30 s) cuts the human's time on the card short.

## 2. Decisions
1. **Launch wiring** (`src/mcp-launch.ts`): Claude gets `--allowedTools mcp__conduit` (every tool of
   server `conduit`). Codex `-c` flags add `mcp_servers.conduit.tool_timeout_sec=180`. Neither holds a
   cmd metacharacter.
2. **Installed entries**: Codex adds `tool_timeout_sec = 180`; OpenCode adds `timeout: 180000` (ms,
   applies to tool calls). Codex keeps `default_tools_approval_mode = "auto"`. Claude and Cursor
   entries are unchanged.
3. **v0.50 entries stay ours.** `legacyConduitEntry` builds the v0.50 shape; `classifyEntry` counts an
   entry deep-equal to it as `ours` (no new UI state). Startup `repair()` rewrites such a user entry to
   the current shape. Project-scope v0.50 entries are left as they are (they work, with the CLI's
   default timeout).
4. **Permission rules** (`src/conduit-mcp/cli-permissions.ts`, targets in
   `electron/mcp-install-targets.ts`):
   - Claude: `"mcp__conduit"` in `permissions.allow` of `settings.json` in `CLAUDE_CONFIG_DIR`, else
     `~/.claude` (not `~/.claude.json`). Created as `{"permissions":{"allow":["mcp__conduit"]}}` when
     absent.
   - Cursor: `"Mcp(conduit:*)"` in `permissions.allow` of `~/.cursor/cli-config.json`, **only if the
     file exists** (Cursor writes it with fields only it knows).
   - Codex and OpenCode need none (approval mode `auto`; OpenCode allows by default).
   - Written after every successful install or replace (user or project scope); removed on
     user-scope uninstall only. Project remove keeps it: the user entry or another project may need it.
   - Removal drops only our exact string. An emptied `allow: []` stays: the user may have created the
     list and `[]` means the same to the CLI, so this is the minimal diff. `deny` is never touched.
   - Idempotent; never duplicates. Same backup (`<file>.conduit-backup`, once), re-read-once mtime
     guard and atomic write as the entry writes. JSON is strict (as everywhere in the installer): a
     file with comments counts as malformed.
   - Malformed file or failed write: the file is left as is, the MCP entry still installs, and the
     result carries `permissionErrorCode` (logged by main). Not shown in the UI.
5. **One-time migration** at startup, beside `repair()` and under the same gating (packaged, not e2e):
   `migrateGateOnce(settings.mcpGateMigrated, install)` runs `ensureGateRules()` — the rule for each
   CLI whose user entry is ours (v0.50 included). The flag (`mcpGateMigrated`, host-owned: a renderer
   settings write cannot reset it) is set only when every write succeeded, so a failure retries next
   start; after that a rule the user deletes is never re-added.
6. **Ask budget** (`src/conduit-mcp/call-flow.ts`): `askBudgetMs(kind, wiredAtLaunch)` is 170 s for a
   codex session whose Conduit launch carried the wiring (`defAdapter` set, not cursor-global, not
   unavailable); everything else keeps `ASK_TIMEOUT_MS` (codex 50 s, claude 120 s, …).
7. **UI**: one hint under Settings → MCP → Agent CLIs (`MCP_STR.install.singleGate`).

## 3. Residuals (accepted)
- **Cursor without `cli-config.json`**: no rule is written, so Cursor still prompts until it has
  created the file and the user reinstalls (or Cursor's own "always allow" is used).
- **CLI deny rules still win**: a `deny` (or managed policy) matching a Conduit tool beats our allow.
  Not ours to override.
- **Plain-shell codex keeps 50 s**: it may be running a v0.50 entry with the 60 s default.
- **Cursor's ~60 s MCP call timeout is not configurable**: its budget stays 50 s.
- A Conduit-written `settings.json` leaves a `settings.json.conduit-backup` holding `null` (the file
  did not exist), as for every other config the installer creates.

## 4. Tests
Unit: `mcp-launch`, `install-entries` (legacy), `toml-config`, `cli-permissions`,
`mcp-install` (rules, legacy upgrade, `ensureGateRules`, `migrateGateOnce`), `mcp-install-targets`,
`conduit-mcp-call-flow` + `conduit-mcp-host` (170 s budget), `coerce-settings`, `settings-mcp-tab`.
E2E: `conduit-mcp-install` asserts the Claude rule is written on install and removed on uninstall.
