---
status: built
date: 2026-10-27
---

# Feature Spec: Install Conduit MCP for agent CLIs, and let users find it

**Tier:** FULL   **Feature type:** UI (Settings tab, banner, card, Messages) + host (env, identity, config writers)
**One-line request:** any agent CLI started in a Conduit terminal, including one typed into a plain
shell, can use the Conduit MCP once the user has installed it for that CLI; users learn it exists
from an **MCP** Settings tab, a first-run prompt, the Messages empty state and a session-card status.
**Mode:** autonomous. Brief: `.autoloop/goal.md` (user decisions 2026-10-27, not re-litigated here).
Builds on [conduit-mcp-server](2026-10-25-conduit-mcp-server.md),
[conduit-mcp-cursor](2026-10-26-conduit-mcp-cursor.md) (the Connect precedent this generalises — and
**changes**, §3.5), [conduit-mcp-control-tools](2026-10-27-conduit-mcp-control-tools.md).

## 1. Problem frame

- **Job:** a user who types `claude`, `codex`, `agent` or `opencode` into any Conduit terminal gets
  the Conduit tools in that CLI, with an identity, without launching through a profile.
- **Actors:** the human; agent CLIs (Claude Code, Codex, Cursor `agent`, OpenCode); the host.
- **Success outcomes:**
  - After one **Install** per CLI, a CLI started in a plain shell session connects, gets a handle
    (`claude-3`), appears in `list_sessions`, and is noticed like a profile session.
  - The same CLI started **outside** Conduit lists a healthy `conduit` server with zero tools.
  - Uninstall removes exactly Conduit's entry; everything else in the file survives.
  - A user who never opened Settings learns of the feature from the banner, the card or Messages.
- **Non-goals:** a New session dialog row; installing skills (agents learn from tool descriptions);
  Cursor IDE; Cursor project-file install (measured dead end on Windows, cursor spec §2); CLIs over
  ssh / WSL; editing any CLI's permission or approval files (Claude `settings.json`, Cursor
  `cli-config.json`); orchestration.

## 2. Behavior & states

### 2.1 Current behavior (measured 2026-10-27 unless marked)

| Claim | How measured | Status |
|---|---|---|
| Shim with no endpoint/token answers `initialize`, `tools/list` → `[]`, `tools/call` → `host_unavailable`, exits 0 on stdin EOF; `''` env values count as absent | piped JSON-RPC into `node resources/conduit-mcp/conduit-mcp-shim.cjs`, vars unset and `''` | Measured |
| **Claude 2.1.312 and OpenCode 2.1.4 reject that fallback `initialize`** (no `serverInfo.version`) → `✘ Failed to connect — INVALID_RESULT` | `claude mcp list` with `CLAUDE_CONFIG_DIR`→scratch holding a `conduit` entry on the real shim; OpenCode probe | Measured — **defect, fixed here (§3.2)** |
| Claude: stdio children inherit the **full** env; `${VAR:-}` unset → `""`; `${VAR}` unset → "Missing environment variables" warning (server still starts) | env-logging probe server, vars set vs unset | Measured |
| Claude `clientInfo.name` = `claude-code` (sends `server/discover` first) | probe log | Measured |
| `CLAUDE_CONFIG_DIR` moves `.claude.json` into that dir | file created at `$CLAUDE_CONFIG_DIR/.claude.json` | Measured |
| Codex 0.164.0: `env_vars` forwards listed vars that are set; unset listed var is absent; unlisted vars stripped. `clientInfo.name` = `codex-mcp-client`. `codex mcp add` has no `env_vars` option | probe via `CODEX_HOME`→scratch + `codex exec`; `codex mcp add --help` | Measured |
| OpenCode 2.1.4: `{env:VAR}` resolves, unset → `""`; full env inherited; `clientInfo.name` = `opencode` | probe via `OPENCODE_CONFIG_CONTENT` | Measured |
| Cursor: user `~/.cursor/mcp.json` loads with no approval; unset `${env:VAR}` stays literal; project file never connects on Windows | cursor spec §2 S0 | Measured (2026-10-26) |
| Forged/unknown token → `tools/list` `[]` | `vitest … conduit-mcp-host.test.ts -t "invalid token"` (pass) | Measured |
| Per-launch wiring names the server `conduit` | `test/unit/mcp-launch.test.ts:45,78` | Measured (unit) |
| `prepareLaunch` leaves non-adapter sessions (shells, `custom:`, `command`) with no token/endpoint/handle; host `serverInfo` carries `version`; Settings tabs are General…About with the MCP group in General | source read (`conduit-mcp-host.ts:638,861`; `settings-modal.tsx:45,87,996`) | ASSUMED → D9 (the build's first unit pins the first) |
| Cursor `clientInfo.name`; Claude dedupe of `--mcp-config` + user `conduit` | — | ASSUMED → D9 |

### 2.2 Primary flows

1. **Install (user scope):** Settings → MCP → *Claude Code* row `Not installed` → **Install** → backup
   if needed → entry written → `Installed`, announced.
2. **Use in a shell:** user types `claude` in a pwsh session. Its PTY env already holds
   `CONDUIT_SESSION_TOKEN` + `CONDUIT_MCP_ENDPOINT` (§3.1). Claude expands the entry, spawns the shim,
   which relays to this host. On `initialize` the host maps `clientInfo` → `claude`, allocates
   `claude-<n>` for the session, and the card shows *Connected*.
3. **Discovery:** `codex` typed in a shell, Codex not installed, no `initialize` within 15 s → card
   *Not connected* + banner **Install for Codex** (§2.5).
4. **Uninstall:** removes exactly Conduit's entry; the backup stays.

### 2.3 Install state per CLI (user scope)

| State | Meaning | Row actions |
|---|---|---|
| `checking` | read in flight | none (`Checking…`) |
| `not-found` | no binary on PATH (existing CLI detection) **and** no config file/dir for it. Either one present = found | **Check again** |
| `not-installed` | found; no `conduit` entry | **Install** |
| `installed` | entry deep-equals this app's entry (§3.4) | **Uninstall** |
| `other-conduit` | entry matches the CLI's **Conduit shape** (below) but differs: another install/build, moved app | **Use this Conduit** (rewrite) · **Uninstall** |
| `conflict` | a `conduit` entry that isn't Conduit-shaped | **Replace…** (in-app confirm) |
| `error` | unreadable, invalid, JSONC comments, wrong shape, or a form Conduit can't edit (§3.5) | **Check again**; never written |
| `pending` | action running | buttons disabled, `aria-busy` |

**Conduit shape** (per CLI): the server's script path (Claude/Cursor `args[0]`, Codex `args[0]`,
OpenCode `command[1]`) has leaf `conduit-mcp-shim.cjs`, **and** identity is forwarded the CLI's way:
Claude/Cursor/OpenCode `env`/`environment` holds both CONDUIT placeholders in that CLI's syntax;
Codex `env_vars` contains both names.

Action results are a union: `{ok:true, status}` | `{ok:false, status, errorCode}` (status = the
re-read, unchanged state; the row shows `actionFailed` with the code). State is re-read on tab open,
**Check again**, after each action, and by the host on each detection. Never cached.

**Shadowing:** if this project has a local/project `conduit` entry that isn't `ours`, the user row
adds "Overridden in this project by <scope> entry" (Claude/Codex precedence makes it win).

### 2.4 Session identity and status

- **Every** session spawned while messaging is on and the endpoint is up gets a fresh token and the
  endpoint in its PTY env (§3.1). Adapter (profile) sessions keep today's per-launch wiring and
  launch-time handle; if their wiring fails (`launch-io`, `cmd-metachar`, …) they get no token, as
  today.
- **Non-adapter sessions** (shells, `custom:`, `open_terminal` commands, OpenCode profiles) get a
  handle lazily: when the host receives the first `initialize` with a valid token for that session it
  allocates the handle **before** replying. Prefix from `clientInfo` (§3.3). The handle persists
  (sessions.json `mcpHandle`) across relaunches and later CLIs (D3). A health check (`claude mcp
  list`) also sends `initialize` and so also claims a handle — accepted (§4).
- ~~**Notice adapter** = the definition adapter if any, else the adapter mapped from the `clientInfo` of
  the **newest live** initialized connection; none live → no notices (existing gate). An unmapped
  client or OpenCode → pull-only (gate closed: no screen patterns).~~ **Superseded by amendment A1
  below:** without a definition adapter, the notice adapter is the *bound* connection's, never the
  newest live one's.
- **Conductor amendment A1 (2026-10-27, review of S1–S3, blocker B-1) — notices in a session without
  a definition adapter.** A live client is no proof the CLI owns the screen: `code .` hands the token
  to an IDE whose Claude connects as `claude-code` while the shell prompt (`❯ ` under starship/pure)
  passes Claude's idle check, and Conduit would type into the shell. Such a session is **bound**
  when its last typed command line was detected (§2.5 tracker) as agent CLI X and a client whose
  kind maps to X (`claude-code`→claude, `codex-mcp-client`→codex, Cursor→cursor) initializes after
  that line. The binding attaches to **that connection**, once per typed line:
  - While the bound connection is live, typed lines do not unbind: they are prompts to the agent.
  - The binding ends when the bound connection closes, on Ctrl+Z (the CLI is suspended and the
    shell has the prompt), or on PTY exit/relaunch. A new binding needs a new typed line.
  - **The typed line has a lifetime too (review S5 SF-1, conductor ruling).** Ctrl+C (`\x03`) or
    Ctrl+D (`\x04`) typed while the session is unbound drops the stored line: that is how a CLI that
    never connected is left (Ctrl+C at the trust dialog, an uninstalled `claude`), and its line must
    not bind a client that initializes later (an editor's Claude, `code .` typed earlier). A
    Ctrl+C inside a CLI that hasn't connected yet also drops it; that session stays pull-only until
    the next typed CLI line (fails safe).
  - **Only a line with printable typed content replaces the stored line (runtime QA F6, conductor
    ruling 2026-10-27).** An Enter alone or after arrow keys only (escape-sequence bytes are not
    typed characters) answers the starting CLI's own dialog (trust, login, onboarding, a picker), so
    it keeps `claude` stored and the client that initializes afterwards binds. Measured before the
    fix: answering Claude's trust dialog with Down, Enter left that whole run pull-only.
  - **A `claude` binding admits a notice only into Claude's ruled input box (review S5 SF-1,
    conductor ruling).** Claude's bare `❯ ` row is also a starship/pure shell prompt, so for a session
    without a definition adapter bound to a `claude` client the gate additionally requires the box
    on the host screen model: a `─` rule above, the `❯`/`!` row under it, and a rule below the
    cursor — the same `inputBoxTop` shape the renderer uses to unlink the box
    (`src/input-box-rows.ts`, spec 2026-10-27-input-box-links §2). Without it the screen reads
    `unknown` (gate `no-empty-input`). A plain shell prompt draws no rules, so it never qualifies.
    Profile sessions and other CLIs' bindings are unchanged. Claude draws the box before it
    initializes, so the model sees it only because it is seeded from the output tail (D6 refined, §14).
  - **Residuals (final review, accepted).** A TUI that draws a Claude-like ruled box (fzf
    `--layout=reverse --border=horizontal --prompt='❯ '`) passes the gate while a `claude` client
    stays bound off-screen (a tmux/zellij window switch, no Ctrl+Z/exit to unbind it). A Ctrl+C/D
    anywhere in an input chunk (even after a CLI line in the same chunk, or inside a bracketed
    paste) clears the stored line: fails safe, pull-only until the next CLI line.
  - Other connections (an IDE's Claude from `code .`, a second client) never bind and never affect
    notices, even while the bound one is live or after it closes.

  An unbound session is **pull-only**: messages queue for `read_inbox`, nothing is typed. A bound
  one's notice adapter is the bound connection's, and the screen check still gates every notice.
  Profile (adapter) sessions are unchanged. (Re-ruled by the conductor 2026-10-27, replacing a first
  version under which any typed line unbound, so a prompt to the agent silenced it.)
- **Card status indicator** (new, beside the handle):

  | Status | When | Shows |
  |---|---|---|
  | none | no handle and no detected CLI; or messaging off | nothing |
  | `connected` | ≥ 1 live initialized connection | lucide `Plug`, muted; tooltip "Connected to Conduit as claude-3" |
  | idle | has handle, no live connection, no reason | nothing new; messages queue |
  | `not-connected` | detected CLI (§2.5) without `initialize` within the grace, or `cursor-not-connected` | lucide `Unplug`; tooltip "Not connected: install Conduit for Codex in Settings → MCP", or, when that CLI is already `installed`, "Codex didn't connect to Conduit. Restart it in this terminal." |
  | `unavailable` | existing reasons | warning icon + existing text |

  `not-connected` clears on the session's next `initialize`, exit, or relaunch.

### 2.5 Agent-CLI detection and the first-run banner

- **Detection (typed line):** only in non-adapter sessions. The host already sees renderer input per
  session; it rebuilds the line since the last Enter from printable input and Backspace. Any escape
  sequence (arrows, history, Tab completion, bracketed paste) marks the line unknown. On Enter, the
  first token's leaf (strip path and `.exe`/`.cmd`/`.ps1`, case-insensitive) in
  `claude | codex | agent | cursor-agent | opencode` → candidate, **unless** the line's next token is
  one of `--version -v --help -h mcp update doctor login logout config exec -p --print run`
  (non-interactive invocations). Chained commands count only by their first command. Missed by
  design: aliases, `npx`/`bunx`, history recall, paste, IME composition (D4).
- **Not connected:** candidate + no `initialize` from that session within `DETECT_GRACE_MS` (15 s;
  injectable for e2e) → `not-connected`, then the banner rules run.
- **Banner** (top of that session's terminal pane, the mf-live-edits banner slot; non-modal) shows
  iff: messaging on; `mcpInstallSuggest` on; the CLI is not in `mcpInstallPromptDismissed`; its user
  state is `not-installed`; no other banner is showing for that session (if one is, this one is
  dropped for that PTY generation, not queued).
  - Copy: "**Codex** isn't connected to Conduit. Install Conduit for Codex so agents you start in any
    terminal can message each other and you." Actions: **Install for Codex** (primary) ·
    **Don't suggest again** · close ×.
  - Install success → "Installed. Restart codex in this terminal to connect." Failure → `actionFailed`
    + **Open MCP settings**.
  - **Don't suggest again** sets `mcpInstallPromptDismissed[cli]`; × hides it for this session only.
    At most one banner per CLI per session per PTY generation.
  - Its appearance is announced in a polite live region ("Conduit setup suggestion for Codex"). Since
    focus is usually in xterm, the same actions are reachable by keyboard from the command palette
    ("Set up Conduit MCP…") and the card context menu.
  - Profile Cursor sessions with `cursor-not-connected` use the same banner (Install = Install Cursor).
- Never: a modal, an OS notification, a banner while messaging is off.

### 2.6 Messages tab empty state (no threads)

- Some found CLI is `not-installed` → "Agents in your sessions can message each other and you.
  Install Conduit for your agent CLIs so ones started in any terminal can join." + **Set up agent
  CLIs** (opens Settings → MCP).
- All found CLIs installed, or none found → today's `firstRun` copy, no button.
- Messaging off → existing off state (unchanged).

## 3. Data / interface contract

### 3.1 PTY env for every session
- `prepareLaunch` sets `CONDUIT_SESSION_TOKEN` (fresh per PTY generation, revoked on exit —
  unchanged) and `CONDUIT_MCP_ENDPOINT` for **every** session when messaging is on and the endpoint is
  ready. Non-adapter sessions get no args, no config file, no handle at launch. A shell spawned while
  messaging was off stays tokenless until relaunched (no card state).
- `ELECTRON_RUN_AS_NODE` never enters the PTY env; `pty-host` keeps stripping both vars from a nested
  Conduit (both unchanged).
- The host-side screen model of a token-bearing session starts at its first `initialize`, seeded
  from a 64 KiB tail of its output kept since spawn (D6 as ruled and refined, §14).
- **Threat model (same class, wider reach):** every process started in a Conduit terminal can speak
  as that session — including a GUI app launched from it (`code .`, `cursor .` when not already
  running), whose terminals and IDE agents inherit the token until that PTY exits. Such processes
  already run as the user; the new reach is messaging other agents (provenance-framed) and, where
  enabled, control tools. Recorded, not mitigated.

### 3.2 Shim fix
- The fallback `initialize` reply gains `serverInfo.version` (a fixed string, `"fallback"`; the shim is
  a static resource). Claude and OpenCode then list `conduit` as connected with 0 tools outside Conduit.

### 3.3 `clientInfo` mapping (`src/conduit-mcp/client-info.ts`)
- `claude-code → claude` · `codex-mcp-client → codex` · `opencode → opencode` · Cursor's name (D9) →
  `cursor` · in e2e only, `conduit-e2e-fake → fake`. Anything else → prefix `agent` (no unbounded
  counter keys, no look-alike handles).
- The result is a **client kind**, not an `McpAdapterId`: `claude|codex|cursor|fake` select that
  adapter's screen patterns; `opencode|agent` are pull-only. **No OpenCode adapter is added**, so
  `adapterFor` is unchanged and OpenCode profiles stay non-adapter sessions.
- `clientInfo` is self-asserted by a token holder; it only names that session's own handle and picks
  its patterns, which the gate still checks against the screen.

### 3.4 The installed entries (server name `conduit` everywhere)
`<exe>` = `process.execPath`, `<shim>` = the shim's absolute path in this build. No `--endpoint`: the
endpoint comes from env, so dev and installed builds share one entry (cursor spec §3.2).

| CLI | User file | Project file (`<root>`) | Entry |
|---|---|---|---|
| Claude | `$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json`, `mcpServers.conduit`; local scope `projects[<key>].mcpServers.conduit` read for this project | `<root>/.mcp.json` | `{type:"stdio", command:<exe>, args:[<shim>], env:{ELECTRON_RUN_AS_NODE:"1", CONDUIT_SESSION_TOKEN:"${CONDUIT_SESSION_TOKEN:-}", CONDUIT_MCP_ENDPOINT:"${CONDUIT_MCP_ENDPOINT:-}"}}` |
| Codex | `$CODEX_HOME/config.toml` else `~/.codex/config.toml`, `[mcp_servers.conduit]` | `<root>/.codex/config.toml` (read by Codex only in trusted projects; row says so) | `command`, `args=[<shim>]`, `env={ELECTRON_RUN_AS_NODE="1"}`, `env_vars=["CONDUIT_SESSION_TOKEN","CONDUIT_MCP_ENDPOINT"]`, `default_tools_approval_mode="auto"` (D5) |
| Cursor | `~/.cursor/mcp.json` (existing `cursorEntry`) | detect + Remove only | unchanged |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` else `~/.config/opencode/opencode.json`, `mcp.conduit` (Windows path → D9) | `<root>/opencode.json` | `{type:"local", command:[<exe>,<shim>], environment:{ELECTRON_RUN_AS_NODE:"1", CONDUIT_SESSION_TOKEN:"{env:CONDUIT_SESSION_TOKEN}", CONDUIT_MCP_ENDPOINT:"{env:CONDUIT_MCP_ENDPOINT}"}, enabled:true}` |

- `<root>` = the Settings modal's `projectPath` (the active project's home, as the Skills tab).
- Env-dependent paths resolve from the **main process** env. If the user sets `CLAUDE_CONFIG_DIR` etc.
  only in a shell profile, the CLI reads a different file; the row always shows the path it edits,
  and this case is listed in §4, not detected.
- Claude local-scope keys are matched by normalised path (forward slashes; case-insensitive on win32);
  Remove deletes under the exact key found.
- **TOML values** are TOML basic strings (`"…"`), escaping `\` → `\\`, `"` → `\"` and control
  characters as `\uXXXX` — so any Windows path is representable (unlike the per-launch literal-string
  path, which refuses quotes).

### 3.5 Write algorithm (all CLIs, both scopes) — the Cursor algorithm, generalised
1. Read through realpath (symlinks survive); missing file → empty document; strip a UTF-8 BOM.
2. Parse: strict JSON (`opencode.jsonc`, comments or trailing commas → `error`). TOML is parsed for
   status and written by **line-range splice**: the owned range is the `[mcp_servers.conduit]` header
   plus the immediately following contiguous `[mcp_servers.conduit.*]` subtables, up to the next other
   header. `error` ("defined in a form Conduit can't edit") when `conduit` is also defined anywhere
   else: dotted keys, an inline `conduit = {…}` under `[mcp_servers]`, `[[…]]` arrays, non-contiguous
   subtables. **Guard:** after splicing, re-parse; the result must equal the original parse with only
   `mcp_servers.conduit` changed, else abort with `error` (catches header-like text in multi-line
   strings). Bytes outside the owned range are unchanged. Install appends the table with no blank
   separator line (only an EOL if the file lacks one), so install → uninstall restores the file byte
   for byte, the user's own trailing blank lines included.
3. Backup on the first write only: exclusive create of a backup (missing original → text `null`);
   never overwritten; failure aborts. User files: `<file>.conduit-backup` beside it. **Project files:
   backups go to `userData/mcp-install-backups/<hash(root)>/`**, never into the repo.
4. Mutate only Conduit's key/table. Atomic write (temp + rename, same dir); temp and backup copy the
   original's file mode (0600 stays 0600). JSON keeps 2-space + trailing newline. For `~/.claude.json`
   re-stat before rename; if mtime/size changed since the read, re-read and re-apply once, else fail
   `EBUSY` (D1).
5. Re-read and classify; return the union of §2.3.
- **Uninstall/Remove** deletes only Conduit's key/table, only from `installed`/`other-conduit`
  (project: `ours`/`other-conduit`); never deletes a file; an empty `mcpServers` stays `{}`.
- Actions are serialised per **realpath** (Claude user + local scope share one file).
- Home, env and fs are injected; tests never touch real user files.
- **Changes cursor spec §3.1:** a differing Cursor `conduit` entry splits into `other-conduit`
  (rewrite, no confirm) and `conflict` (Replace… with confirm); "Connect/Disconnect" become
  "Install/Uninstall"; the `cursorConnect:*` channels are replaced by `mcpInstall`.

### 3.6 IPC and settings
- `mcpInstall:status(projectPath|null) → {clis: CliInstallStatus[]}`;
  `CliInstallStatus = {cli: 'claude'|'codex'|'cursor'|'opencode', found, user: {state, path,
  errorCode?, shadowedBy?}, project: null | {entries: {scope:'project'|'local', state:
  'ours'|'other-conduit'|'conflict'|'error', path}[], installable: boolean}}`.
- `mcpInstall:act({cli, scope:'user'|'project', action:'install'|'uninstall'|'replace'|'remove',
  projectPath?}) → {ok:true, status} | {ok:false, status, errorCode}`. `replace` is the only action on
  `conflict`.
- **Both** channels resolve `projectPath` host-side against a known project/session home; anything
  else → `project: null` / refused (no arbitrary-path oracle).
- Settings: `mcpInstallSuggest: boolean` (default true); `mcpInstallPromptDismissed:
  Partial<Record<'claude'|'codex'|'cursor'|'opencode', true>>` (coerced; unknown keys dropped).
  Turning `mcpInstallSuggest` on clears the map.
- `McpSessionBadge` gains `status: 'connected'|'not-connected'|null`, `notConnectedCli?`.

### 3.7 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| PTY env token + endpoint | `prepareLaunch` (changed: all sessions) | CLI config expansion → shim; nested-Conduit strip; every child process | yes; strip unchanged |
| Handle | `claimHandle` at launch (adapters) / at first `initialize` (new) | `list_sessions`, card meta, Messages, notifier, sessions.json | yes |
| Notice adapter | definition, else live `clientInfo` kind (new) | screen verdict, gate, echo confirm | yes |
| Install state | CLI config files (Conduit, the user, the CLIs themselves) | MCP tab, banner, card copy, Messages empty state | **no — flagged:** CLIs also write these files (Claude rewrites `~/.claude.json` while running). Mitigated by re-read on every use, the mtime guard and the D1 S0 test |
| Typed-command candidate | renderer input (existing `onRendererInput`) | `not-connected`, banner | yes |
| Shim fallback `initialize` | shim (changed) | every CLI outside Conduit | yes |
| Cursor launch wiring | `readCursorLaunchEntry` (unchanged) | Cursor profile sessions | yes |

## 4. Edge cases & failure modes

| Condition | Behavior |
|---|---|
| Install clicked twice / two windows | serialised per realpath; second sees `installed` → no-op, no backup touch |
| One shell runs `claude`, exits, then `codex` | same handle (`claude-3`); notice adapter follows the live client; `list_sessions` `agent` = live client kind, else handle prefix |
| Nested `claude -p` / `codex exec` inside a CLI | same session; ~~newest live connection picks patterns; a mismatch reads `unknown` (gate closed); when it ends the previous live one applies~~ superseded by A1 (§2.4): in a shell only the bound connection picks patterns, a nested client never binds; a profile session keeps its definition adapter |
| `claude mcp list` / `codex mcp list` in a shell | initializes with the token → the shell gets a handle and burns a counter number; it shows in `list_sessions` while connected. Accepted (D3) |
| `claude --version`, `codex --help` etc. | not a candidate (skip list); no status, no banner |
| CLI shows its trust / project-approval prompt for > 15 s | `not-connected` may show briefly; clears on `initialize`. Banner only if `not-installed` |
| Profile Claude + user entry also installed | per-launch `--mcp-config` `conduit` + user `conduit`, both → this host via env; dedupe ASSUMED (D9) |
| Dev build + installed build | one entry, last Install's `command` wins; each session reaches its own host by env; the other app shows `other-conduit` |
| Conduit uninstalled or moved with entries left | every CLI run lists a failing `conduit`. Tab description + CHANGELOG: "Uninstall here before removing Conduit". Update path stability: D2 |
| User-defined `conduit` | user scope `conflict` → **Replace…**; project scope → "not written by Conduit", no Remove |
| `~/.claude.json` changed between read and rename | re-apply once, else `EBUSY` + **Try again** |
| Config dir missing, binary found | Install creates dir + file |
| `CLAUDE_CONFIG_DIR`/`CODEX_HOME` set only in a shell profile | Conduit edits the main-env path the row shows; the CLI may read another. Not detected (D9) |
| Project install | adds a file holding this machine's absolute paths to the repo; the row says "Adds <file> to this project — it contains paths on this computer; don't commit it". Claude asks to approve project servers on next start; if that screen isn't matched by Claude's blocking patterns, S0 adds it |
| No project open / multi-root | project section hidden / `<root>` = project home only |
| ssh / WSL CLI in a shell | env not forwarded / Windows exe → never connects; may be flagged `not-connected` (D4) |
| GUI app launched from a Conduit shell | inherits the token (§3.1 threat model) |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Install target | user scope | per click (project secondary) | user decision 2026-10-27 |
| Writes without a click | never | no | user files |
| Suggest-install banner | on | `mcpInstallSuggest` | discovery; one switch silences all |
| Banner dismissal | permanent per CLI | cleared by turning suggestions back on | never nag |
| Token for all sessions | whenever messaging is on | master switch | brief |
| Claude per-call approval (shell sessions) | Claude asks per tool | no | D7 |
| Codex approval mode in entry | `auto` | no | per-launch parity (D5) |
| Detection grace | 15 s | e2e override only | CLIs initialise MCP within seconds |

## 6. Scope slicing

- **S0 (measure first):** D1, D2, D9 items.
- **MVP:** §3.1 env for all; lazy handles + client kinds + notice adapter; shim fix; MCP tab with four
  CLIs (user install/uninstall/replace/use-this, project entries + Remove, Install for this project
  for Claude/Codex/OpenCode); detection + card status + banner + palette/menu entries; Messages empty
  state; Cursor row migrated; CHANGELOG (Added + "MCP settings moved to their own tab"); docs: parent
  spec §3.1 and cursor spec §3.1 updated; units + 2 e2e + runtime QA.
- **v1:** startup Repair of this build's own stale paths (unless D2 promotes it); OpenCode notices;
  Cursor notices in shells.
- **Out:** skills, New session row, ssh/WSL, Cursor project install, permission-file edits,
  uninstaller hooks.

## 7. Acceptance criteria

All file ACs run against an injected home/env/userData.

**EARS**
1. When a session spawns with messaging on, the host shall put a fresh token and the endpoint in its
   PTY env, whatever its definition; an adapter session whose wiring failed shall get neither.
2. When the first valid-token `initialize` arrives for a session without a handle, the host shall
   allocate `<kind>-<n>` before replying, persist it, and list the session in `list_sessions`;
   unknown clients shall get prefix `agent`.
3. While a session has live connections, its notice adapter shall be the definition adapter, else the
   kind of the connection **bound under amendment A1 (§2.4)**; with no live bound connection or a
   pull-only kind, no notice shall be typed.
4. When Install runs on `not-installed`, the host shall back up (first time; project backups in
   userData), add only Conduit's entry, keep every other key deep-equal (TOML: bytes outside the owned
   range identical), and preserve the file mode.
5. If the file is invalid, JSONC, or defines `conduit` in an uneditable form, or the TOML re-parse
   guard fails, then the host shall report `error` and not write.
6. If the entry is `conflict`, Install shall be unavailable and **Replace…** shall write only after an
   in-app confirmation. If `other-conduit`, **Use this Conduit** shall rewrite without a confirm.
7. When Uninstall/Remove runs, the host shall remove only Conduit's entry, from `installed` /
   `other-conduit` / `ours` only, never deleting the file or the backup.
8. If the file changed between read and rename twice, the action shall return `{ok:false,
   errorCode:'EBUSY'}` and the file shall hold the other writer's content.
9. If `projectPath` isn't a known project/session home, `status` shall return `project: null` and
   `act` shall refuse.
10. When the shim has no usable endpoint, it shall answer `initialize` with `serverInfo.{name,
    version}` and list zero tools (unit; runtime QA with real Claude/OpenCode/Codex outside Conduit).
11. When a live connection initializes, the card shall show `connected`; when a typed candidate gets
    no `initialize` within the grace, `not-connected` with the copy for that CLI's install state; it
    shall clear on `initialize`, exit or relaunch. A skip-list invocation shall not be a candidate.
12. The banner shall show iff §2.5's conditions hold, at most once per CLI per session per PTY
    generation; **Don't suggest again** shall persist and suppress it until suggestions are turned
    back on, which clears the map. Settings coercion shall drop unknown keys.
13. Where no threads exist, the Messages tab shall show the setup copy + **Set up agent CLIs** iff
    some found CLI is `not-installed`, else today's copy.
14. The Cursor row shall behave per §2.3 through `mcpInstall`, and no `cursorConnect:*` channel shall
    remain.

**Gherkin**
```gherkin
Feature: A CLI typed into a shell joins Conduit messaging
  Background: an isolated HOME (+ CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME unset) with a
              .claude.json holding an unrelated server "other"
  Scenario: install, connect, message, uninstall
    Given Settings → MCP shows Claude Code "Not installed"
    When the user clicks Install
    Then .claude.json has mcpServers.conduit, "other" unchanged, and a .conduit-backup exists
    When a pwsh session runs the fake CLI
    Then the card shows "fake-1" and Connected
    When the human sends it a message
    Then the fake CLI receives the notice and its read_inbox returns the body
    When the user clicks Uninstall
    Then mcpServers.conduit is gone and "other" is unchanged
  Scenario: discovery banner, dismissed for good
    Given Claude Code is found and not installed
    When the user types "claude" + Enter in a shell and nothing initializes within the grace
    Then the card shows Not connected and the banner offers "Install for Claude Code"
    When the user chooses Don't suggest again
    Then settings record the dismissal and a second shell typing "claude" shows no banner
```

**Fake CLI contract** (`test/e2e/fixtures/fake-agent-cli.mjs`, run with `node`): reads the Claude
config by Claude's rules, expands `${VAR:-}` from its env, spawns the entry, sends `initialize` with
`clientInfo {name:'conduit-e2e-fake'}` (→ the existing `fake` adapter's patterns), then prints
`fake❯` as its idle row; a typed line containing `[conduit]` makes it call `read_inbox` and print the
bodies.

**Tests:** units — each editor (JSON merge/remove, TOML splice incl. comments, subtables, every
`error` form, the re-parse guard, path escaping), BOM, symlink + mode (posix), backup rules incl.
project backups in userData, mtime guard, shape classification per CLI, client kinds, lazy handle,
notice-adapter selection, typed-line parser (Backspace, escapes, paste, skip list, `.cmd`, paths),
shim fallback, settings coercion. e2e `conduit-mcp-install.e2e.mjs`, `conduit-mcp-install-banner.e2e.mjs`.
Runtime QA: real `claude`, `codex`, `opencode` in a pwsh session after Install; each outside Conduit.

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| MCP tab | first open | groups render at once; CLI rows `Checking…` | — |
| CLI row | §2.3 states | name, state text, edited path (LTR, wraps), shadowing note | per §2.3 |
| CLI row | `actionFailed` | "Couldn't update <path>: <code>" | **Try again** |
| Project section | no project | hidden | — |
| Project section | none found | "No Conduit entries in this project." + commit warning | **Install for this project** (not Cursor) |
| Project section | entries | per entry: scope, path, state | **Remove** (ours/other-conduit) |
| Master off | — | rows usable; hint "Messaging is off; installed CLIs get no tools." | — |
| Replace dialog | open | file + backup path | **Replace** / **Cancel** |
| Banner | shown / installing / installed / failed | §2.5 copy / busy text / restart hint / error + link | per §2.5 |
| Card indicator | §2.4 | icon + tooltip | non-interactive |
| Card context menu, palette | `not-connected` / always | "Set up Conduit MCP…" | opens MCP tab at that CLI |
| Messages empty | §2.6 | copy | **Set up agent CLIs** |

Each row loads and fails alone; no page-level error state.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Settings nav "MCP" (after General) | open tab | click | Tab, Enter/Space | tap | — | existing nav button pattern |
| CLI row buttons | install/uninstall/replace/use/remove/check | click | Tab, Enter/Space | tap | — | names include the CLI ("Uninstall Conduit from Codex"); `aria-busy` while pending |
| Row state text | — | — | — | — | — | polite live region per row |
| Replace dialog | confirm/cancel | click | focus starts on Cancel; Esc cancels; focus returns to the row | tap | — | `role="dialog"`, labelled |
| Banner | install/dismiss/close | click | palette command (focus is in xterm); Tab order inside the banner | tap | — | `role="region"` "Conduit setup"; appearance + outcome announced |
| Card indicator | — | hover tooltip | part of the card's accessible name | — | "Set up Conduit MCP…" | not a control |
| Messages CTA | open settings | click | Enter/Space | tap | — | button |

## 10. Accessibility & i18n

- Everything keyboard-operable; visible focus via existing primitives (forced-colors safe). After a row
  action focus moves to the row's first enabled button (cursor spec precedent).
- Status never colour-only: `Plug` / `Unplug` / warning shapes + text in tooltip and accessible name.
- Live regions announce row results (with the file path), the banner's appearance and outcome. No motion.
- Strings in `webview/conduit-mcp-strings.ts` (`MCP_STR.install.*`); CLI names untranslated; counts via
  `countNoun`; paths LTR verbatim with `overflow-wrap:anywhere`; +30% text tolerated (`npm run
  text-fit`); RTL mirrors via existing flex. Fixed CLI order (Claude Code, Codex, Cursor, OpenCode),
  no sorting. `cursor-not-connected` copy → "Install Conduit for Cursor in Settings → MCP".

## 11. Design tokens

Existing Settings, banner and card tokens only (`--fg-muted` for connected; existing warning token for
`unavailable`/`conflict`/`error`). Icons: lucide-react `Plug` and `Unplug` added to `webview/icons.tsx`
(not there today). Checked in all three themes with `npm run shots`.

## 12. Assumptions

- MCP tab order: Messaging (master) · Agent CLIs (rows + project section) · Tools (moved switches +
  override note) · Suggestions (`mcpInstallSuggest`).
- `projectPath` for the project section is the value the Skills tab receives.
- Cursor keeps its D2 note (per-tool allowlist on first call) in the row description.

## 13. Decisions Needed

- **D1 [high]** `~/.claude.json` is rewritten by running Claude processes. Default: Conduit edits it
  directly with the mtime guard (testable without a `claude` binary; measured: `claude mcp add-json`
  stores placeholders literally but refuses an existing name, so it can't update in place). **S0**
  installs during a live interactive Claude, completes a turn, and checks the key survives. If it is
  clobbered: switch to `claude mcp remove/add-json -s user` and show "Restart running Claude sessions".
- **D2 [high]** Entries hold absolute `<exe>`/`<shim>` paths. If the packaged path changes on
  auto-update, every install silently breaks after an update. Default: S0 measures it; if it moves,
  the v1 Repair becomes MVP (rewrite only this build's own entries, on start, when `other-conduit` and
  the shim path is under this app's install root).
- **D3 [normal]** One handle per session, prefixed by the first CLI that connects, kept for life;
  health checks claim one too. Alternative: allocate only after a `tools/call`. Default: keep simple.
- **D4 [normal]** Detection from the typed line only (no process enumeration exists; Windows
  enumeration is costly). Misses aliases, `npx`/`bunx`, history, paste, IME; may flag ssh/WSL CLIs.
- **D5 [normal]** Codex entry includes `default_tools_approval_mode="auto"` (per-launch parity), so
  control tools, when enabled, are auto-approved too. Default: parity.
- **D6 [normal]** A headless screen model for every token-bearing session from spawn (memory per
  shell). Alternative: start at first `initialize` and accept `unknown` until a full repaint.
- **D7 [normal]** No edits to Claude permissions: shell-started Claude asks once per tool; profile
  sessions keep `--allowedTools`.
- **D8 [normal]** OpenCode: install + pull-only identity in MVP (measured `{env:}` works), no adapter;
  notices deferred until its patterns are captured.
- **D9 [normal]** S0 measurements, each with the default kept until measured: Cursor `clientInfo.name`
  (default: unmapped → `agent`, pull-only); Claude dedupe of `--mcp-config` + user `conduit` (default:
  keep per-launch injection unchanged); Codex accepts the installed table with `-c` overrides (default:
  as specified); OpenCode global path on Windows and project-file discovery (default: XDG path,
  `<root>/opencode.json`); Claude's project-approval screen vs its blocking patterns (default: add it
  if unmatched); the three source-read claims of §2.1 (default: as read; first build unit pins them);
  shell-profile-only config env vars (default: not detected).
- **D10 [normal]** Should `not-found` CLIs offer "Install anyway"? Default: no, only Check again.
- **D11 [normal]** The brief moves "notices" to the MCP tab, but no global notices setting exists
  (settings.ts has only `conduitMcp` and `mcpTools`; source read). Default: nothing to move; the
  per-session pause stays in the session menu, and the tab's Messaging description explains notices.
  Alternative: add a global "Type notices into idle sessions" switch.

## 14. Conductor rulings (2026-10-27)

- **D1:** default as written. The S0 check gates it, and a failed S0 switches to the
  `claude mcp` CLI.
- **D2:** Repair is **MVP** whatever S0 measures. At startup, a Conduit-owned entry whose
  referenced exe or shim path **no longer exists** is rewritten to this build's paths, with a
  backup. Entries that point at an existing path, such as another live Conduit build, are never
  touched, so a dev build and the installed build never fight over them.
- **D6:** the **alternative** is taken. A session's screen model starts at its first MCP
  `initialize`, not at spawn. Hidden shell sessions cost renderer and host memory, which is already
  a measured problem, so a session reads `unknown` until a full repaint.
  **Refined (conductor ruling 2026-10-27, runtime QA F1):** Claude paints its ruled input box ~1 s
  before it sends `initialize` and afterwards repaints only changed cells. A model started empty at
  `initialize` never saw the box, so every new PTY read `unknown` and held notices until the user's
  first prompt. The host therefore keeps a bounded **tail of the last 64 KiB of PTY output** (UTF-8
  bytes, oldest trimmed) from spawn for every token-bearing session that has no model yet; it needs
  no xterm instance. When the model starts lazily it is **seeded by replaying that tail** at the
  session's current cols/rows, then live output continues. There is still no headless model before
  `initialize`. A PTY exit or relaunch (new generation) drops the tail. Pinned by the measured bytes
  in `test/unit/fixtures/conduit-mcp/claude-box-before-initialize.json`.
- **D3, D4, D5, D7, D8, D9, D10, D11:** defaults as written.
