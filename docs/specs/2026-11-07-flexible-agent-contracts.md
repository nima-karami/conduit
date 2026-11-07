---
status: active
date: 2026-11-07
---

# Flexible agent contracts — any agent CLI, consistent MCP tools

**One-line request:** an orchestrating agent can open and supervise any agent CLI (e.g. Kiro, which Conduit has no
profile for), and every Conduit MCP tool speaks one consistent, self-explaining contract.

Tier: **FULL** · Feature type: **non-UI** (agent-facing MCP contracts; approval-card strings only).
Inputs: audit `.autoloop/audit-mcp-contracts.md`; spec review (rev 2 folds in its 4 blockers). Decisions are the
lead's (delegated by the user). Shipped specs touched: archive/2026-10-25-conduit-mcp-server,
2026-10-27-conduit-mcp-control-tools, 2026-10-30-conduit-mcp-tool-policy, 2026-10-30-conduit-mcp-app-control.

## 1. Problem frame
**Job.** A lead agent starts helper agents, hands them work, watches them, unsticks them and cleans up — including
CLIs Conduit has never heard of. User: *"If I install Kiro, Conduit doesn't know that profile but it should still be
able to use it. open_session and our tools need to be flexible, robust and professional."*

**Actors.** Lead agent (MCP caller) · helper sessions (known CLI / unknown CLI / plain terminal) · the human
(approval cards, Settings → MCP policies).

**Success outcomes.** (1) `open_session({agent:"kiro"})` works when `kiro` is on PATH. (2) `list_agents` tells a
lead what it can open and what each supports. (3) A first `message` never turns a successful open into an error.
(4) A lead can read a helper's screen and, with approval, type into it. (5) One error vocabulary with fix hints.

**Non-goals.** Free-form launch `args` (open CON-148 decision) · writing other CLIs' MCP config · generic typed
notices for unknown CLIs · one CLI catalog refactor (v1) · new Settings UI.

## 2. Current behavior (code inspection — [I] = inferred from source, not run)
| Claim | Source | Status |
|---|---|---|
| `open_session.agent` is an enum of registered ids; unknown → `unknown_agent` | tool-schemas.ts:148, control-tools.ts:540 | [I] |
| `resolveCommand(cmd, platform)` exists; win32 tries `.exe/.cmd/.bat`; never searches cwd | src/shells.ts:38 | [I] reviewer-checked |
| open_terminal persists its command on the session (`effectiveDef` seam); readers since v0.49 understand it | session-command.ts | [I] |
| `open_session message` fails with `not_messageable` after opening an adapter-less session | control-tools.ts:429; host.ts:547 | [I] |
| `snapshot(id)` returns `{lines, cursorY, cursorX, cursorRowStyles}` for the visible viewport only | server/runtime/session-screens.ts:41 | [I] reviewer-checked |
| `deps.typing` (`TypingPort.write/submit/submitEnter`) is the single PTY writer, reachable from the MCP host | src/contracts/server-ports.ts:178 | [I] |
| bracketed-paste state lives in the domain (`pasteModes`) | server/domain/index.ts:1254 | [I] |
| reach values `self|opened|window|any` exist | tool-policy.ts:44 | [I] |
| `askBudgetMs(kind, wiredAtLaunch)`: claude 120 s, codex 50 s (170 s launch-wired), cursor 50 s, opencode/agent 25 s | call-flow.ts:28–41 | [I] |
| agents.json entries are cast, not validated; a parse error yields an empty set silently | config.ts:36–52 | [I] |

## 3. Behavior

### 3.1 Agent resolution in `open_session`
1. **Registered id** (agents.json profile, custom launcher, `cli:*`, `shell:*`) — unchanged.
2. **Bare command**: `agent` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (no separators/spaces; leading `-`
   impossible) AND its leaf (lowercased, `.exe/.cmd/.bat` stripped) is **not** in the refused list AND
   `resolveCommand(agent, platform)` returns an absolute path → the session opens as a **command session** exactly
   like `open_terminal` (persisted `command` = the **resolved absolute path**, `args: []`), so older app versions read
   it as a terminal session. If the leaf matches a built-in MCP adapter (claude, codex, cursor-agent/agent) that
   adapter applies (wiring, notices, brief, model) as it would for a profile.
   - **Refused leaves** (shells/interpreters/system tools — use `open_terminal` for those): cmd, powershell, pwsh,
     bash, sh, zsh, fish, wsl, node, deno, bun, python, python3, py, ruby, perl, php, wscript, cscript, mshta,
     rundll32, regsvr32, reg, curl, wget, ssh, scp, rm, del, rmdir, git, npm, npx, pnpm, yarn.
     → `invalid_args`, hint "use open_terminal to run shells and tools".
3. Else `unknown_agent`, hint "call list_agents; a bare command must be an agent CLI on PATH", `valid` = first 30
   registered ids.
- The approval card for a bare command shows the **resolved absolute path**; the spawn uses that path (no second
  PATH lookup).
- `label` defaults to the leaf. `agent` in the output = the leaf.

### 3.2 First message
- Preflight before opening: messaging on and store available, else `invalid_args` (unchanged).
- After opening: stored for the new handle through a store append that **skips the `not_messageable` check for the
  opener's first message only** (`send_message` to a `messageable:false` handle stays refused). Delivered by the
  normal notice gate / unread line once an MCP client connects in that session. Cleanup unchanged: on session delete
  pending messages are marked undelivered (host.ts onSessionDeleted).
- Output `message: {id: string}`. A store failure after the open: `message: {id: null, error: {code, message}}` —
  the call is still `ok`. The open never fails because of the message.

### 3.3 Waits
`wait_sessions` clamps `timeout_s` to `floor((askBudgetMs(callerKind, wiredAtLaunch(callerSession)) − ASK_MARGIN) /
1000)` using the same margin the ask path subtracts (call-flow.ts ~254). Unknown/null caller kind → `agent` budget.
When clamped the result adds `clamped_to: <seconds>`. Minimum 1 s.

## 4. Interface contract
Flat schemas (no oneOf/anyOf/$ref/const). Snake_case on the wire. Target inputs accept a handle or a session id.

### 4.1 `open_session` (changed)
`agent: string` (no enum; description: "A registered agent id (see list_agents) or an agent CLI's command name on
PATH, e.g. \"kiro\"."). `model` accepted when the resolved definition has a model flag: built-in adapter mapping, or
profile `capabilities.model_flag` (§4.4); a bare command without an adapter can't take a model → `invalid_args`,
hint "add an agents.json profile with capabilities.model_flag, or use one of: <ids that take a model>".
Handle prefix for an adapter-less agent (profile or bare command): slug of profile id or leaf (extension stripped,
lowercase, `[a-z0-9-]`, ≤ 20, trailing `-` trimmed; empty, `you`, `fake`, or a built-in CLI prefix whose leaf
doesn't match → `term`). Output adds `message?` (§3.2).

### 4.2 `list_agents` (new) — group `messaging`, access `on`, no budget, no input
```json
{ "agents": [ { "id": "cli:codex", "label": "Codex", "command": "codex", "source": "detected",
    "model": true, "messaging": "wired", "notices": true, "brief": false } ],
  "bare_commands": true }
```
`source`: profile | launcher | detected | shell. `messaging`: `wired` (adapter injects Conduit MCP at launch) |
`env` (only CONDUIT_* env vars) | `none` (shell). `notices`/`brief`/`model`: from the adapter the definition maps to
(by command leaf), plus `model` true for a profile `model_flag`. Order: profile, launcher, detected, shell; then
label.

### 4.3 `list_sessions` (changed)
Each entry adds `session_id` (string), `opened_by` (handle or null), `home` (absolute folder path), `messageable`
(boolean: definition has an MCP adapter OR a client is live — what send_message accepts), `notices` (`"typed"` |
`"pull"`).

### 4.4 agents.json `capabilities` (new, optional) and validation (changed)
`capabilities.model_flag`: `^--?[A-Za-z][A-Za-z0-9-]{0,30}$` → argv `[model_flag, model]` before any brief `--`. A
built-in adapter's mapping wins. Invalid → field dropped with a warning.
Validation per entry: `id` non-empty string, unique (first wins), not starting `cli:`/`shell:`/`conduit:`;
`command` non-empty, no NUL, not whitespace-only, no leading `-`; `args` string[] (missing → []); `label` string
(missing → id); max 200 entries. Invalid entry → dropped with one `log.warn('agents', …)` (id or index + reason).
Parse error → keep the last successfully loaded set in memory if any (else empty) and `log.error`.

### 4.5 `read_screen` (new) — group `sessions`, budget `show`, access `on`, reach `opened` (choices self|opened|window|any)
Input `session`, `lines` int 1–200 default 60. Output `{session: <handle>, rows: string[], cursor_row: number|null,
cols: number|null, presence: "idle"|"busy"|"exited"}`. Source: `snapshot(id)` viewport; trailing spaces trimmed,
trailing blank rows dropped, then the last `lines` rows. `cursor_row` is relative to `rows` (null if outside).
`cols` from the runtime's current geometry (null if unknown). Snapshot undefined → `rows: []`. Trust boundary:
opener sees its helpers' raw screens unredacted (documented in the description). Targeting the caller's own session
→ `self_target`.

### 4.6 `send_input` (new) — group `sessions`, budget `act`, access `ask`, reach `opened`
Input `session`, `text` (≤ 4000 chars), `keys` (≤ 20 of `enter|tab|esc|backspace|space|ctrl+c`), `submit` bool
(default false). At least one of text/keys.
- Text: rejected (`invalid_args`) if it contains C0 controls other than `\n` (and `\n` only when the target has
  bracketed paste on), DEL, C1 (U+0080–U+009F), or `ESC[200~`/`ESC[201~`. Sent as a bracketed paste when the target
  has bracketed-paste mode on (new dep `bracketedPaste(sessionId): boolean` from the domain), else raw.
- Keys map: enter `\r`, tab `\t`, esc `\x1b`, backspace `\x7f`, space ` `, ctrl+c `\x03`.
- Order: text → keys → if `submit`, `typing.submit`-style Enter (the existing gap), not a raw `\r` glued to a paste.
- Write via `deps.typing.write(sessionId, data, {generation})` with the session's current generation; a false return
  → error `session_restarting` (`retryable: true`). Exited target → `session_exited`. Own session → `self_target`.
- Approval card: "Type into <handle> (<label>, <home>)", the **full** text (scrollable) and the key list; for
  ctrl+c: "may stop the program".
- Output `{session: <handle>, sent_chars: number, keys_sent: number}`.

### 4.7 Errors (changed in every tool)
| Old | New | Where |
|---|---|---|
| `unknown_handle` | `unknown_session` | send_message recipients and errors |
| `invalid_args` for an unknown target | `unknown_session` | wait_sessions |
| `invalid_argument`, `invalid_input` | `invalid_args` | messaging tools |
| — | `self_target` (exists), `session_exited`, `session_restarting` (new) | read_screen, send_input |
Error object gains optional `hint` (one sentence) and `valid` (string[] ≤ 30). The text content renders
`<message> Hint: <hint>` so text-only clients see it. Required hints: unknown_agent, unknown_session (`valid` =
targets **within the caller's reach**), tool_disabled (names the tool's policy in Settings → MCP), not_messageable,
out_of_reach (names the reach setting), model not supported, not_in_session. Renderer strings
(webview/conduit-mcp-strings.ts) follow the renames; a unit test asserts the retired codes appear nowhere in src/
or webview/.

### Producer / consumer (both in scope unless noted)
| Flow | Producer | Consumer |
|---|---|---|
| bare-command open | control-tools prepareOpen + resolveCommand | domain openSession, effectiveDef, relaunch, duplicate, persistence (older readers: command session ✔) |
| first message | control-tools openMessage → store append (bypass flag) | notifier/gate, unread line, read_inbox, onSessionDeleted |
| list_sessions fields | host directory() | tools.ts mapping; target resolution |
| model_flag | config.ts | adapters/model args, list_agents |
| read_screen | session-screens snapshot + runtime geometry | new tool |
| send_input | new tool | TypingPort, domain paste mode, attention (input = activity) |
| error codes/hints | all tools | renderer strings, tests, agents |
| wait clamp | call-flow askBudgetMs + host wiredAtLaunch | session-waits |

## 5. Edge cases
Registered id that is also a PATH command → registered wins · `agent:"C:\\x\\kiro"` → `invalid_args` (separators) ·
`agent:"kiro.cmd"` resolves the shim; persisted path is the shim · bare command leaves PATH later → relaunch uses
the persisted absolute path; missing → command_not_found · two opens of the same bare command → two sessions
(no dedupe in MVP) · first message + close_when_done + exit before connect → undelivered on delete · read_screen
before the screen attaches → `rows: []` · send_input during an approval card for the same session → serialized by
call flow · `\n` without bracketed paste → `invalid_args` hint "submit lines one at a time with submit:true" ·
list_agents with 0 profiles → detected + shells only · duplicate agents.json ids → first wins, warn.

## 6. Defaults
Bare commands allowed (gated by open_session `ask` + refused list + PATH) · read_screen `on`/reach `opened` (read-only,
own helpers) · send_input `ask`/reach `opened` (can press anything; human opts in) · clamp waits rather than refuse ·
no new Settings controls (policies list new tools via the existing per-tool table).

## 7. Scope
**MVP** (this run): §3–§4. Slices: **S1** errors + hints + list_sessions fields + wait clamp + first-message bypass
(contract foundation, first); **S2** bare commands + list_agents + capabilities + agents.json validation;
**S3** read_screen + send_input. S2 and S3 run in parallel after S1 merges.
**v1:** CLI catalog; generic notices for `env` CLIs; Settings "custom MCP client" recipe; idempotency key; `ok` on
list results; rename_session; arrow keys for send_input (needs application-cursor mode).

## 8. Acceptance criteria (EARS; each maps to a unit test unless noted)
- When `open_session` gets an unregistered bare command on PATH, the host shall open a command session with the
  resolved absolute path, and the approval summary shall show that path.
- When the leaf is refused or has separators, the host shall return `invalid_args` with a hint; not on PATH →
  `unknown_agent` with hint and `valid`.
- When `open_session` has `message` and the session opened, the result shall be ok with `message.id` set, also for
  an adapter-less session and on an injected store failure (`message.id` null).
- When a client later connects in that session, `read_inbox` shall return the first message.
- `list_agents` shall return every registry entry with source/messaging/notices/brief/model per §4.2.
- `list_sessions` entries shall include session_id, opened_by, home, messageable, notices.
- While `timeout_s` exceeds the caller's budget, `wait_sessions` shall clamp and report `clamped_to`.
- If an agents.json entry is invalid, only it shall be dropped and a warning logged; a parse error keeps the last set.
- `read_screen` shall return ≤ `lines` trimmed rows, relative `cursor_row`, `cols`, `presence`; out of reach →
  `out_of_reach` + hint.
- `send_input` shall write text (bracketed when on), then keys, then Enter via submit; a false write →
  `session_restarting`; control chars → `invalid_args` (fake TypingPort in tests).
- For unknown targets in send_message, wait_sessions, close_session, focus_session, attach_folder, read_screen,
  send_input the code shall be `unknown_session` with `valid` limited to reach.
- No source file shall contain the retired codes (grep test).
- e2e (remote): open_session with a bare command (a fixture CLI script on PATH in the runner) + message; read_screen
  shows its output; send_input text+submit reaches it.

## Decisions Needed (lead's picks recorded)
- `high` — ship `send_input` (default `ask`, reach `opened`, full text on the card). Alternative: read_screen only.
- `normal` — refused-leaf list for bare commands (§3.1); grows by review.
- `normal` — error renames without an alias period.
- `normal` — adapter-less agents get a slug handle prefix (`kiro-1`) instead of `term-N`.
