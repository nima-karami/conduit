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
CLI's own MCP call timeout (Codex 60 s) cuts the human's time on the card short.

## 2. Decisions
1. **Launch wiring** (`src/mcp-launch.ts`): Claude gets `--allowedTools mcp__conduit` (every tool of
   server `conduit`). Codex `-c` flags add `mcp_servers.conduit.tool_timeout_sec=180`. Neither holds a
   cmd metacharacter.
2. **Installed entries**: Codex adds `tool_timeout_sec = 180` and keeps
   `default_tools_approval_mode = "auto"`. Claude, Cursor and OpenCode entries are unchanged. OpenCode
   gets no `timeout`: its docs describe it as the connect/tool-fetch timeout, so 180 s could hold
   startup on a stalled shim, and its ask budget stays 25 s anyway.
3. **v0.50 entries stay ours.** `legacyConduitEntry` builds the v0.50 shape (only codex differs); `classifyEntry` counts an
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
   - Written after every successful install or replace (user or project scope). **Never removed**,
     not even on uninstall: a rule with no `conduit` server is inert, the same string may be the
     user's own, and a project-scope install may still need it. `deny` is never touched.
   - Idempotent; never duplicates. Same backup (`<file>.conduit-backup`, once), re-read-once mtime
     guard and atomic write as the entry writes, except that a file Conduit creates gets no backup
     (there is nothing of the user's to keep). JSON is strict (as everywhere in the installer): a
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
- **Migration covers user-scope installs only**: a v0.50 Claude install that exists only at project or
  local scope gets no rule until it is reinstalled.
- **Nested codex**: a codex started inside a launch-wired codex session inherits the session token but
  not the `-c` flags, so it may run on a v0.50 entry with the 60 s default while the ask budget is
  170 s; the card can then outlive the call.
- **Downgrade**: v0.50 sees an upgraded codex entry as "another Conduit" (Install there fixes it).
- **Retargeted entries take two starts**: repair first repoints a dead other-build entry (keeping its
  v0.50 shape), the next start upgrades it.
- Uninstall leaves the allow rule behind (inert; see §2.4).

## 4. Tests
Unit: `mcp-launch`, `install-entries` (legacy), `toml-config`, `cli-permissions`,
`mcp-install` (rules, legacy upgrade, `ensureGateRules`, `migrateGateOnce`), `mcp-install-targets`,
`conduit-mcp-call-flow` + `conduit-mcp-host` (170 s budget), `coerce-settings`, `settings-mcp-tab`.
E2E: `conduit-mcp-install` asserts the Claude rule is written on install and survives uninstall with
the user's own rules untouched.
