# Plan: Conduit MCP control tools and per-tool switches

Spec: [2026-10-27-conduit-mcp-control-tools.md](../specs/2026-10-27-conduit-mcp-control-tools.md)
(FULL, reviewed r1). S0 results go to `docs/runs/2026-10-27-mcp-control/s0.md`.

**Tier: FULL.** The feature adds three MCP tools, a call-time gate, a new persisted session kind
(`Session.command`) behind one `effectiveDef` seam, a new IPC pair, a Settings section and a
dialog. It crosses `src/`, `electron/` and `webview/`, and executors pick tasks up cold. Planned
against `feat/mcp-control` HEAD `935b32c0`. Every line number below was grepped at that HEAD;
re-grep before editing, since earlier tasks shift them.

## Goal

A human-enabled agent session can call `open_session`, `open_terminal` and `open_file` to create
a session or open a file in its own window and project. Each tool is switchable globally and per
session, and a session without the switch neither sees nor can call it.

## Architecture

- **Pure cores (node-free, renderer-importable):**
  - `src/conduit-mcp/tool-switches.ts` is the tool catalog: names, defaults, coercion, the
    effective-set rule and the gate order.
  - `src/session-command.ts` holds the `command` session kind: `COMMAND_AGENT_ID`, the
    synthesized definition, persistence coercion and **`effectiveDef(session, registry)`**, the
    one seam every launch consumer resolves through.
- **Tool logic:** `src/conduit-mcp/control-tools.ts`, `createControlHandlers(deps)`, is a sibling
  of `createToolHandlers` (`src/conduit-mcp/tools.ts:203`). It owns argument parsing, path
  resolution against the caller's home, kind checks, pre-create validation and the two rate
  windows. It does no IO itself: stat, registry, command resolution and session creation are
  deps.
- **Host:** `electron/conduit-mcp-host.ts` gains:
  - the gate in `callTool`: `not_in_session → messaging_off → tool_disabled`, then
    `store_unavailable` for the messaging tools only;
  - a per-connection effective `tools/list`;
  - a `list_changed` sync over live connections;
  - a `claimHandle` refactored out of `prepareLaunch`, so a created session has its handle
    before the tool returns;
  - the `mcp:setToolOverride` renderer message.
  It builds the control handlers from a `control` dep that `electron/main.ts` supplies.
- **Main:** `electron/main.ts` supplies `createMcpSession` and `openMcpFile`:
  - `createMcpSession` runs the dialog's path, `openRepo`, with a new trailing `mcp` argument.
    That argument skips launcher usage and recents, carries `command` and `openedBy`, and emits
    `suppressAutoSwitch` or `activateSession` around the owner's state post.
  - `openMcpFile` resolves the owning session and sends the extended `openFileInEditor`.
  - `term:start` resolves its definition from the session through `effectiveDef`, not from the
    renderer's `agentId`.
- **Renderer:**
  - two pure helpers, `webview/auto-switch.ts` and `webview/file-open-request.ts`, wired in
    `webview/app.tsx`;
  - a new dialog, `webview/components/mcp-tools-dialog.tsx`;
  - a Tools group in `webview/components/settings-modal.tsx`;
  - the strings in `webview/conduit-mcp-strings.ts`.
- **No sketches.** Every seam copies a sibling:
  - the handler factory copies `createToolHandlers`;
  - request/reply copies `mcp:compose` → `mcp:sent` (`webview/use-conduit-mcp.ts:59`);
  - the dialog copies the `TimedMessageDialog` mount (`webview/app.tsx:4734`) and uses
    `SegmentedRadios` (`webview/components/segmented-radios.tsx`).

## Data flow

```
SWITCHES
 Settings Toggle ─updateSettings{settings.mcpTools}─► main.ts:3706 coerceSettings ─► mcpHost.refresh()
 MCP tools dialog ─mcp:setToolOverride{requestId,sessionId,tool,value}─► mcpHost.handleRenderer
     validate (session exists, isToolName, boolean|'inherit') ─► mgr.setMcpToolOverride ─► persist
     ─► reply mcp:toolOverrideResult ─► syncToolLists()
 syncToolLists(): for each initialized conn: key(effective set) ≠ lastListed[conn] ⇒ send
     {"jsonrpc":"2.0","method":"notifications/tools/list_changed"} ─► shim relay ─► CLI

CALL   CLI ─tools/call─► json-rpc core (name ∈ TOOL_NAMES catalog, else invalid_argument)
     ─► host.callTool: gateToolCall{sessionId, messagingOn, enabled=effectiveTool(...)}
        not_in_session | messaging_off | tool_disabled
        messaging tool && !store.available() ⇒ store_unavailable
     ─► control.openSession/openTerminal/openFile            [src/conduit-mcp/control-tools.ts]
          parse args (invalid_args) → rate windows (rate_limited) → resolvePath(callerHome, path)
          → kindOf (path_missing | not_a_directory | not_a_file) → agent ∈ agentIds() (unknown_agent)
          | resolveCommand(command) (command_not_found)
          → deps.openSession(req) ─► main.createMcpSession
               owner = caller's window ?? primary ?? focused; projectId = caller's (if it exists)
               initial = sessionOps.resolveInitialRoots(home, undefined)
               openRepo(home, agentId|COMMAND_AGENT_ID, owner, undefined, extras,
                        {request: undefined (agent default) | {kind:'none'} (command), dialog: true},
                        mcp{command?, openedBy, name?, focus})
                 roleBriefs.beginCreate → !ok ⇒ brief_unavailable (nothing created)
                 mgr.create(...)            (emits; no window owns it yet)
                 [no bump, no repos.json]
                 focus=false ⇒ owner.send(suppressAutoSwitch{sessionId})
                 assignOwner → postState()  (owner window now sees it)
                 focus=true  ⇒ owner.send(activateSession{sessionId})
          → claimHandle(sessionId) (handle | null) → {session_id, handle, label, agent}
     open_file ─► main.openMcpFile: target = resolveOwningSession(...) ?? caller
          ─► sendToOwner(target, openFileInEditor{path, sessionId, line?, column?, focus})
          ─► renderer planFileOpen ─► setActiveId? / setCenterView? / openFile(path, sid, mode, {reveal})

SPAWN (renderer-driven, unchanged trigger)  term:start{sessionId,…}
     s = mgr.get(id); def = effectiveDef(s, registry)
     agentId 'command' && no s.command ⇒ refuse (stale + banner)
     whenLaunchReady(def) → buildLaunchSpec({def,…}) → cwd aug (def.id) → prepareLaunch(id, def, spec)
     → roleBriefs.prepareSpawn(id, def, spec) → pty.start
```

## Settled decisions — do not re-litigate

From the spec (§1–§5, §12, review r1) and the human's 2026-10-27 rulings:
- The control tools are off globally and the messaging tools on. The effective value is
  `override ?? global`. Overrides are per session, absent means inherit, and they are never
  inherited from the caller or copied by Duplicate.
- **Gate order:** `not_in_session`, `messaging_off`, `tool_disabled`, then the tool's own checks.
  `store_unavailable` applies to messaging tools only.
- With the master on, `tools/list` returns exactly the effective set. With it off, it lists
  everything and every call is `messaging_off`.
- `open_terminal` passes argv with no shell string. `command`/`args` persist, and Relaunch,
  restore and Duplicate re-run them.
- `effectiveDef(session)` is the single launch seam. The `command` id is never registered.
- No path confinement for control tools: the switch is the trust boundary (A1). Paths resolve
  against the caller's **persisted home**, never the OSC cwd.
- A new session goes to the caller's window, else the primary window, and joins the caller's
  project. It gets the definition's default brief, or `brief_unavailable`. MCP opens don't touch
  launcher usage or recents.
- `focus` defaults to true. `suppressAutoSwitch` goes before the introducing state post and
  `activateSession` after it. Nothing about focus is persisted.
- Rate limits are 10 opens/min per caller and 20/min globally, on `open_session` + `open_terminal`.
- New error codes: `tool_disabled`, `unknown_agent`, `path_missing`, `not_a_directory`,
  `not_a_file`, `invalid_args`, `command_not_found`, `brief_unavailable`.
- No idempotency and no rollback after `created`.
- Out of scope: worktree tools, an initial task, close/kill/rename, output reads, settings over
  MCP, confinement.

## Spec staleness

Measured at `935b32c0`; each row says how the plan proceeds.

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| Launch consumers include `resolveLaunchSpec` (§3.3) | `main.ts` never calls it. It's called only inside `buildLaunchSpec` (`src/launch-spec.ts:36`), which takes `registry` + `agentId` and, for an unknown id such as `command`, **falls back to a default shell** (`src/pty-host.ts:291-298`) | T4.1 changes `LaunchRequest` to carry `def` and `resolveLaunchSpec` to take a `def` |
| The synthesized definition has "`cwdStrategy` as shells", and cwd reporting is a consumer (§3.3) | `cwdStrategy` is metadata only and nothing reads it. cwd reporting keys on `shell:*` ids (`src/cwd-reporting.ts:58`, `main.ts:4243`) | The synthesized def sets `cwdStrategy: 'workspaceFolder'` like `terminalDef` (`src/shells.ts`). `cwdReportingAugmentation(def.id, …)` returns null for `command`, so command sessions get no cwd tracking. That is the correct outcome for an arbitrary program |
| `open_session` returns the new session's `handle` (§3.1) | Handles are assigned only in `prepareLaunch` (`electron/conduit-mcp-host.ts:752-771`), at spawn, which the renderer triggers **after** the tool would return | T4.3 extracts `claimHandle(sessionId, adapter)` and calls it at create. `prepareLaunch` then keeps the claimed handle (`assignHandle` keeps a `current` not held by others) |
| The dialog's create path is reusable as is (A3) | `openRepo` (`main.ts:2193`) always bumps launcher usage (`:2225`) and recents (`:2226-2239`). Its definition is `registry.get(agentId) ?? registry.list()[0]` (`:2205`), so a `command` id would silently become the first shell | T4.2 adds a trailing `mcp` argument that skips both side effects and takes the definition from `commandDef` for a command session |
| Tool names reach the gate (§2) | `KNOWN_TOOLS` comes from the static `CONDUIT_TOOLS` (`src/conduit-mcp/json-rpc.ts:42`), so new names would get `invalid_argument` first | T2.2 sets `KNOWN_TOOLS` from `TOOL_NAMES` |
| Claude pre-approval follows the catalog (not stated) | `CLAUDE_ALLOWED_TOOLS` is derived from `CONDUIT_TOOLS` (`src/mcp-launch.ts:35`), so new tools would be auto-approved in Claude. Codex auto-approves the whole server (`src/mcp-launch.ts:56`) | Claude's allowlist stays messaging-only (T2.2). The Codex behaviour is D3 |
| The "MCP tools…" item shows whenever `adapterFor(effectiveDef(session))` matches, even before launch (§4) | The renderer knows MCP only from `McpUiState.sessions`, which lists only sessions **with a handle** (`electron/conduit-mcp-host.ts:617`) | T3.1 adds `McpUiState.switchable: string[]`, computed host-side |
| Out-of-root files open "in the text editor only" (§3.1) | The renderer has no forced-text mode. Every `conduit-preview:` root is already host-confined to `writeRoots()` (`main.ts:3068`, ADR 0005) | The invariant is already enforced host-side, and no new flag is added. See D4 |
| A settings `Toggle` labelled by the tool name and described by its description (§9) | `Toggle` (`webview/components/settings-modal.tsx:807`) takes only `value`/`onChange` | T5.3 adds `labelledBy`, `describedBy` and `disabled` props |
| An "app's polite live region" exists (§10) | No shared announce function. `navLiveRef` (`webview/app.tsx:1245`, rendered at `:4605`) is set directly | T5.4 passes `announce = (t) => { navLiveRef.current && (navLiveRef.current.textContent = t) }` to the dialog |
| list_changed / ASSUMED rows in §2 | `json-rpc.ts` sends `listChanged: false`. The shim relays socket bytes to stdout untouched (`resources/conduit-mcp/conduit-mcp-shim.cjs:123`), so a host-sent notification reaches the CLI | As planned |

## Global constraints

- **Gates:**
  - Inner loop: the named vitest files (`npx vitest run <file>`), then `npm run verify:quick`.
  - Once after S6: `npm run verify`, then `npm run e2e:remote` (default `--affected`, plus the
    two new scenarios by name).
  - Locally, run only one e2e by exact name: `npm run e2e -- conduit-mcp-control`.
  - Never narrow, skip or disable a check. Never pipe verify output through `tail`.
- **CI is ubuntu.** Unit tests never depend on win32 paths, `\`, drive letters or
  `process.platform`. `control-tools.ts` takes `resolvePath`/`kindOf` as deps, so its tests use
  POSIX fakes.
- **Comments explain WHY only.** Where the why is in the spec, a one-line pointer
  (`// spec 2026-10-27-conduit-mcp-control-tools §3.1`). No `as any`, `@ts-ignore`, `!important`,
  swallowed errors or magic offsets.
- **Naming:**
  - Files are kebab-case and named for their role, with tests at
    `test/unit/<module-name>.test.ts[x]`.
  - React component tests start with `// @vitest-environment jsdom` and follow
    `test/unit/cursor-connect-row.test.tsx` (act + createRoot + `vi.mock('../../webview/bridge')`).
  - Exported constants are `SCREAMING_SNAKE`, types `PascalCase`, functions `camelCase`.
  - MCP wire fields are `snake_case` (`session_id`), as in the existing outputs.
- **Node-free modules** (`src/conduit-mcp/tool-switches.ts`, `src/session-command.ts`,
  `src/conduit-mcp/types.ts`, `src/conduit-mcp/ui-types.ts`) import no `node:*` module, because
  the renderer imports them.
- **Spawning git:** none here. Watching dirs: none here.
- **E2E:**
  - Launch only via `launchElectron`/`runScenario`, exit only via `finishScenario`.
  - E2e runs hidden and serially. Writes go through the harness `typeLine`/`writeToTerminal`.
- **Strings:**
  - All UI copy goes in `MCP_STR` (`webview/conduit-mcp-strings.ts`).
  - Tool names are code identifiers and are never localized.
- **User-facing changes:** add a `CHANGELOG.md` entry, including the downgrade note (§3.3).

## Out of scope

- Everything in spec §6 "v1", "Vision" and "Out of scope".
- Removing the now-unread `agentId` field from `term:start` (`src/protocol.ts:1158`). The host
  stops trusting it, and the renderer keeps sending it.
- A forced-text viewer mode (D4).

## Contracts

### `src/conduit-mcp/tool-switches.ts` (new, node-free) — T1.1

```ts
import { type ToolError, toolError } from './types';

export const MESSAGING_TOOL_NAMES = ['list_sessions', 'send_message', 'read_inbox', 'read_attachment'] as const;
export const CONTROL_TOOL_NAMES = ['open_session', 'open_terminal', 'open_file'] as const;
export const TOOL_NAMES = [...MESSAGING_TOOL_NAMES, ...CONTROL_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type McpToolSwitches = Record<ToolName, boolean>;
export type McpToolOverrides = Partial<Record<ToolName, boolean>>;
export type ToolOverrideValue = boolean | 'inherit';

/** Messaging on, control off (spec §5). */
export const DEFAULT_MCP_TOOLS: Readonly<McpToolSwitches>;
export function isToolName(v: unknown): v is ToolName;
export function isMessagingTool(t: ToolName): boolean;
/** Per key: a missing or non-boolean value takes the default; unknown keys are dropped. Never throws. */
export function coerceMcpTools(v: unknown): McpToolSwitches;
/** Keeps only known names with boolean values; undefined when nothing survives. */
export function coerceToolOverrides(v: unknown): McpToolOverrides | undefined;
export function effectiveTool(overrides: McpToolOverrides | undefined, global: McpToolSwitches, tool: ToolName): boolean;
/** In TOOL_NAMES order. */
export function effectiveTools(overrides: McpToolOverrides | undefined, global: McpToolSwitches): ToolName[];
/** 'inherit' deletes the key; returns undefined when the result is empty. Does not mutate. */
export function withOverride(overrides: McpToolOverrides | undefined, tool: ToolName, value: ToolOverrideValue): McpToolOverrides | undefined;
/** Spec §2 gate steps 1–3; null ⇒ proceed to the tool's own checks. */
export function gateToolCall(i: { sessionId: string | null; messagingOn: boolean; enabled: boolean; tool: ToolName }): ToolError | null;
```

`gateToolCall` returns these errors, in order:
- `not_in_session`: "this MCP connection is not a Conduit session" (the existing text,
  `conduit-mcp-host.ts:496`);
- `messaging_off`: "Conduit messaging is turned off";
- `tool_disabled`: `` `${tool} is not enabled for this session` ``. It never says how to enable
  it.

`tool_disabled` is added by T1.0, which therefore runs before T1.1.

### `src/types.ts` — T1.3

```ts
import type { McpToolOverrides } from './conduit-mcp/tool-switches';
/** argv for an `open_terminal` session; never a shell string (spec A2). */
export interface SessionCommand { command: string; args: string[] }
/** Who opened the session over MCP; both kept because handles can be reused (spec §3.3). */
export interface SessionOpener { handle: string; sessionId: string }
// Session gains (all persisted):
  mcpToolOverrides?: McpToolOverrides;
  command?: SessionCommand;     // only when agentId === COMMAND_AGENT_ID
  openedBy?: SessionOpener;
```

### `src/session-command.ts` (new, node-free) — T1.3

```ts
import type { AgentRegistry } from './agent-registry';
import type { AgentDefinition, Session, SessionCommand, SessionOpener } from './types';

export const COMMAND_AGENT_ID = 'command';
export const MAX_COMMAND_BYTES = 1024;
export const MAX_ARGS = 64;
export const MAX_ARGS_BYTES = 8 * 1024;
/** commandLeaf(c.command) from src/launch-args.ts; the default label (spec D2). */
export function commandLabel(c: SessionCommand): string;
/** {id: COMMAND_AGENT_ID, label: commandLabel(c), command, args: [...args], icon: 'terminal', color: 'green', cwdStrategy: 'workspaceFolder'} */
export function commandDef(c: SessionCommand): AgentDefinition;
/** The one launch seam (spec §3.3): commandDef for a command session, else registry.get(agentId). undefined for an unknown id or a command session without a command. */
export function effectiveDef(s: Pick<Session, 'agentId' | 'command'>, registry: Pick<AgentRegistry, 'get'>): AgentDefinition | undefined;
/** Valid ⇔ command is a non-empty string ≤ MAX_COMMAND_BYTES (UTF-8) and args a string[] with ≤ MAX_ARGS entries and ≤ MAX_ARGS_BYTES total. */
export function coerceSessionCommand(v: unknown): SessionCommand | undefined;
export function coerceOpenedBy(v: unknown): SessionOpener | undefined;
```

### `src/session-manager.ts` — T1.3

```ts
export interface SessionCreateOpts { /* existing */ command?: SessionCommand; openedBy?: SessionOpener }
create(agentId: string, home: string, opts?: SessionCreateOpts): Session
//  agentId === COMMAND_AGENT_ID: requires opts.command, else throws `Unknown agent: command`.
//  opts.command with any other agentId throws `command requires agent ${COMMAND_AGENT_ID}`.
//  Stamps command / openedBy when present. Never sets mcpToolOverrides (spec §3.1 Inheritance).
duplicate(id, opts?): Session | undefined   // also passes src.command; never overrides or openedBy
setMcpToolOverride(id: string, tool: ToolName, value: ToolOverrideValue): boolean  // false ⇔ no such session; emits only on a change
```

### `src/persistence.ts` `parseSessions` — T1.3

Per entry, after the existing `brief` check (`src/persistence.ts:95`):
- `mcpToolOverrides = coerceToolOverrides(s.mcpToolOverrides)`, deleted when undefined;
- `openedBy = coerceOpenedBy(s.openedBy)`, deleted when undefined;
- `command = coerceSessionCommand(s.command)`, deleted when undefined. A `command` session with an
  invalid command is **kept**. It has `agentId: 'command'` and no `command`, and is refused at
  spawn (T4.1).

An entry is never dropped for these fields.

### `src/settings.ts` — T1.2

`AppSettings.mcpTools: McpToolSwitches`. `DEFAULT_SETTINGS.mcpTools = { ...DEFAULT_MCP_TOOLS }`.
In `coerceSettings` (`src/settings.ts:404`), set `mcpTools: coerceMcpTools(payload.mcpTools)`
beside `conduitMcp` (`:524`).

### `src/conduit-mcp/types.ts` — T1.0

`ToolErrorCode` gains `'tool_disabled' | 'unknown_agent' | 'path_missing' | 'not_a_directory' |
'not_a_file' | 'invalid_args' | 'command_not_found' | 'brief_unavailable'`. None of them is
retryable (`rate_limited` already is).

### `src/conduit-mcp/tool-schemas.ts`, `json-rpc.ts`, `src/mcp-launch.ts` — T2.2

```ts
// tool-schemas.ts — CONDUIT_TOOLS is replaced by:
export function toolSchemas(agentIds: readonly string[]): ToolSchema[]   // all 7, TOOL_NAMES order
export const CONDUIT_INSTRUCTIONS: string   // + one sentence: control tools exist only when the human enables them
// json-rpc.ts
const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);
// initialize → capabilities: { tools: { listChanged: true } }
export const TOOLS_LIST_CHANGED: string   // '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}'
// mcp-launch.ts
const CLAUDE_ALLOWED_TOOLS = MESSAGING_TOOL_NAMES.map((t) => `mcp__conduit__${t}`).join(',');
```

Schemas, each `additionalProperties: false`:
- `open_session`: `{path: string, agent: {type: 'string', enum: agentIds}, label?: string
  (maxLength 80), focus?: boolean (default true)}`, required `path` and `agent`.
- `open_terminal`: `{path, command: string (maxLength 1024), args?: string[] (maxItems 64),
  label?, focus?}`, required `path` and `command`.
- `open_file`: `{path, line?: integer ≥ 1, column?: integer ≥ 1, focus?}`, required `path`.

Descriptions are one sentence each and say that paths are absolute or relative to the session's
home folder. The `open_terminal` description adds "argv, not a shell: use command 'pwsh' with
args ['-c', …] for pipes". If S0 finds a CLI that rejects the enum, `agent` becomes
`{type: 'string'}` and the ids go into its description (A6). That switch is local to
`toolSchemas`.

### `src/conduit-mcp/control-tools.ts` (new) — T2.3

```ts
import type { Caller } from './tools';
import type { Handle, Result } from './types';
import type { SessionCommand, SessionOpener } from '../types';

export const OPEN_RATE_PER_CALLER = 10;
export const OPEN_RATE_GLOBAL = 20;
export const MAX_LABEL_CHARS = 80;
export interface OpenSessionOutput { session_id: string; handle: Handle | null; label: string; agent: string }
export interface OpenFileOutput { opened: string; session_id: string }
export type McpLaunch = { kind: 'agent'; agentId: string } | { kind: 'command'; command: SessionCommand };
export interface McpOpenRequest { callerSessionId: string; openedBy: SessionOpener; home: string; label: string | undefined; focus: boolean; launch: McpLaunch }
export type McpOpenOutcome =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; code: 'unknown_agent' | 'brief_unavailable'; message: string };
export interface McpFileRequest { callerSessionId: string; path: string; line: number | undefined; column: number | undefined; focus: boolean }
export type PathKind = 'dir' | 'file' | 'other' | 'missing';   // stat failure of any errno ⇒ 'missing'
export interface ControlDeps {
  /** Persisted home of a live session; undefined ⇒ not_in_session. */
  homeOf(sessionId: string): string | undefined;
  resolvePath(home: string, p: string): string;
  kindOf(absPath: string): Promise<PathKind>;
  agentIds(): string[];
  resolveCommand(command: string): string | undefined;
  openSession(req: McpOpenRequest): Promise<McpOpenOutcome>;
  openFile(req: McpFileRequest): Promise<{ sessionId: string }>;
  claimHandle(sessionId: string): Handle | null;
  now(): number;
  info(message: string, data: Record<string, unknown>): void;
}
export interface ControlHandlers {
  openSession(caller: Caller, args: unknown): Promise<Result<OpenSessionOutput>>;
  openTerminal(caller: Caller, args: unknown): Promise<Result<OpenSessionOutput>>;
  openFile(caller: Caller, args: unknown): Promise<Result<OpenFileOutput>>;
}
export function createControlHandlers(deps: ControlDeps): ControlHandlers;
```

**Order of checks** (fixed; tests assert it):
1. Args object with only the declared keys; field types and limits. Else `invalid_args`. The
   limits are label ≤ 80 chars, command ≤ 1 KB, args ≤ 64 entries and ≤ 8 KB, and `line` and
   `column` integers ≥ 1.
2. Open tools only: the caller has ≥ 10 opens in the last 60 s, or there are ≥ 20 globally, gives
   `rate_limited`.
3. `homeOf(caller.sessionId)` undefined gives `not_in_session`.
4. `abs = resolvePath(home, path)`; `kindOf(abs)`: `'missing'` gives `path_missing`. For the open
   tools anything but `'dir'` gives `not_a_directory`; for `open_file` anything but `'file'` gives
   `not_a_file`.
5. `open_session`: an `agent` not in `agentIds()` gives `unknown_agent`, whose message lists
   `agentIds().join(', ')`. `open_terminal`: `resolveCommand(command)` undefined gives
   `command_not_found`.
6. `deps.openSession` / `deps.openFile`. An `ok:false` outcome maps to `{code, message}`.
7. Success: record the open time in both windows. `handle = claimHandle(sessionId)`.
   `agent` = the agentId for `open_session`, `commandLabel(command)` for `open_terminal`.
   `info('control open', {tool, caller: caller.handle, sessionId, path: abs})`.

Only successful opens count toward the rate windows.

### `electron/conduit-mcp-host.ts` — T3.1, T4.3

```ts
export interface ConduitMcpHostDeps {
  // existing …
  mgr: Pick<SessionManager, 'get' | 'list' | 'setMcp' | 'setMcpToolOverride'>;
  mcpTools(): McpToolSwitches;
  /** effectiveDef(session, registry), bound in main. */
  defOf(sessionId: string): AgentDefinition | undefined;
  agentIds(): string[];
  control: Omit<ControlDeps, 'claimHandle' | 'now' | 'info' | 'agentIds'>;
}
// unchanged signatures: whenLaunchReady(def), prepareLaunch(sessionId, def, spec), refresh(), handleRenderer(m, reply)
```

Host internals:
- **`callTool(sessionId, name, args)`:**
  - `name` is a `ToolName`, since the core has already checked the catalog.
  - The gate is `gateToolCall({sessionId: handle ? sessionId : null, messagingOn,
    enabled: effectiveTool(session.mcpToolOverrides, deps.mcpTools(), name), tool: name})`.
  - Then `isMessagingTool(name) && !store.available()` gives `store_unavailable`.
  - Then `runTool`.
- **`tools()` for a connection:**
  - `[]` without a valid token.
  - With the master off, `toolSchemas(deps.agentIds())`.
  - Otherwise, the schemas filtered to `effectiveTools(...)`.
  - It records `lastListed.set(conn.id, key)`, where `key = names.join(',')`.
- **`syncToolLists()`:**
  - For every connection in `registry.connectionsOf(sessionId)` across `mgr.list()`, recompute
    the key.
  - If it differs from `lastListed`, call `conns.get(id)?.send(TOOLS_LIST_CHANGED)`, update the
    key, and `log.info('conduit-mcp', 'tools list_changed', {sessionId, handle})`.
  - `refresh()` calls it, and the `mcp:setToolOverride` handler calls it after a change.
  - `lastListed` is deleted in `conn.onClose`.
- **`claimHandle(sessionId, adapter): Handle | null`:** extracted verbatim from
  `prepareLaunch:746-771`. It returns null on the `handles.json` write failure and then sets
  `r.unavailable = 'launch-io'`. `prepareLaunch` calls it, and the control deps use
  `(id) => { const d = deps.defOf(id); const a = d && adapterFor(d, {e2e}); return a ? claimHandle(id, a) : null; }`.
- **`uiState()`** adds `switchable: mgr.list().filter((s) => { const d = deps.defOf(s.id); return !!d && !!adapterFor(d, {e2e}); }).map((s) => s.id)`.
- **`handleRenderer` `mcp:setToolOverride`:**
  - Reply `{ok:false, error}` for:
    - `'unknown-session'` (`!mgr.get`);
    - `'unknown-tool'` (`!isToolName`);
    - `'invalid-value'` (not `true|false|'inherit'`).
  - Otherwise `mgr.setMcpToolOverride`, reply `{ok:true}`, `syncToolLists()`,
    `scheduleBroadcast()`.

### `src/conduit-mcp/ui-types.ts` — T3.1

`McpUiState.switchable: string[]`. These are the session ids whose `effectiveDef` matches an
adapter, which is when the **MCP tools…** item shows (spec §4).

### `src/protocol.ts`

T3.1 owns it in Slice 3:

```ts
// WebviewToHost
| { type: 'mcp:setToolOverride'; requestId: number; sessionId: string; tool: string; value: boolean | 'inherit' }
// HostToWebview
| { type: 'mcp:toolOverrideResult'; requestId: number; ok: true }
| { type: 'mcp:toolOverrideResult'; requestId: number; ok: false; error: 'unknown-session' | 'unknown-tool' | 'invalid-value' }
```

T4.2 owns it in Slice 4:

```ts
// HostToWebview — openFileInEditor (src/protocol.ts:695) becomes:
| { type: 'openFileInEditor'; path: string; sessionId: string; line?: number; column?: number; focus?: boolean }
//   focus absent ⇔ an OS open (unchanged behaviour); present ⇔ an MCP open.
| { type: 'suppressAutoSwitch'; sessionId: string }
```

### `src/launch-spec.ts`, `src/pty-host.ts`, `src/launch-preview.ts` — T4.1

```ts
export interface LaunchRequest { def: AgentDefinition | undefined; cwd; home; homeMissing; roots; exists; resolveCommand; platform }  // registry + agentId removed
export function resolveLaunchSpec(def: AgentDefinition | undefined, cwd: string | undefined, cwdExists: (p: string) => boolean, fallbackCwd: string): SpawnSpec
//   def ⇒ { command: def.command, args: [...def.args], cwd: dir }; undefined ⇒ defaultShellSpec(dir)
```

`LaunchPlan` is unchanged. A command session whose `command` failed coercion
(`agentId === COMMAND_AGENT_ID && !s.command`) is refused in `term:start` (T4.1), the only place
that holds the session. `buildLaunchSpec` only ever receives an already-resolved `def`.

### `electron/main.ts` — T4.1, T4.2

```ts
interface McpOpenExtras { command?: SessionCommand; openedBy: SessionOpener; name?: string; focus: boolean }
function openRepo(p, agentId, ownerWindowId, cardId?, extras?, brief?, mcp?: McpOpenExtras): { sessionId: string } | { error: BriefError } | undefined
async function createMcpSession(req: McpOpenRequest): Promise<McpOpenOutcome>
async function openMcpFile(req: McpFileRequest): Promise<{ sessionId: string }>
const mcpOwnerWindow = (callerSessionId: string): number  // caller's live window ?? primaryWindowId if live ?? focusedWindow()?.id ?? -1
```

### Renderer — T5.1–T5.4

```ts
// webview/auto-switch.ts
export function pickAutoSwitch(added: readonly Pick<Session, 'id' | 'status' | 'createdAt'>[], suppressed: ReadonlySet<string>): string | undefined
// newest running id not in suppressed (the app.tsx:808-810 rule, minus suppressed)
// webview/file-open-request.ts
export interface FileOpenRequest { path: string; sessionId: string; line?: number; column?: number; focus?: boolean }
export interface FileOpenPlan { activate: boolean; showEditor: boolean; mode: OpenMode; reveal?: CursorPos }
export function planFileOpen(r: FileOpenRequest): FileOpenPlan
// focus undefined → {activate:false, showEditor:true, mode:'permanent'}           (OS open, unchanged)
// focus true      → {activate:true,  showEditor:true, mode:'preview', reveal?}     (as openTerminalFileLink)
// focus false     → {activate:false, showEditor:false, mode:'background', reveal?}
// reveal = line === undefined ? undefined : { line, column: column ?? 1 }
// webview/components/mcp-tools-dialog.tsx
export interface McpToolsDialogProps {
  session: Session;                   // label + mcpToolOverrides
  global: McpToolSwitches;            // settings.mcpTools
  masterOn: boolean;                  // settings.conduitMcp
  connected: boolean;                 // mcp.state.sessions[id]?.connected === true
  onChange(tool: ToolName, value: ToolOverrideValue): Promise<boolean>;  // false ⇒ revert + inline error
  onRelaunch(): void;
  announce(text: string): void;
  onClose(): void;
}
export function McpToolsDialog(p: McpToolsDialogProps): JSX.Element
// webview/use-conduit-mcp.ts — ConduitMcpApi gains:
setToolOverride(sessionId: string, tool: ToolName, value: ToolOverrideValue): Promise<boolean>
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `settings.mcpTools` | Settings Tools group (T5.3) → `updateSettings` → `coerceSettings` (T1.2) | host gate + `tools()` + `syncToolLists` (T3.1), dialog Inherit label (T5.2), renderer settings hydrate (`webview/settings.tsx`, whole-object, unchanged) | Both |
| `Session.mcpToolOverrides` | dialog → `mcp:setToolOverride` → `mgr.setMcpToolOverride` (T3.1, T1.3) | gate, `tools()`, sync (T3.1), dialog, persistence (T1.3) | Both. Never produced by create or duplicate (T1.3 test) |
| `Session.command` | `open_terminal` → `createMcpSession` → `mgr.create` (T4.2, T1.3) | `effectiveDef` (T1.3) → `term:start`: `whenLaunchReady`, `buildLaunchSpec`, cwd aug, `prepareLaunch`, `prepareSpawn` (T4.1); `duplicate` (T1.3); `parseSessions` (T1.3); host `defOf` → `switchable`/`claimHandle` (T3.1/T4.3) | Both |
| `agentId === 'command'` read elsewhere | `mgr.create` | `sessionExitAction` (`src/close-decision.ts:37`) treats non-`shell:` ids as agents, so an exited command session keeps its Restart card (wanted for Relaunch). `iconForAgent(undefined)` (`src/session-icon.ts:124`) gives the generic glyph (D2). `launcherHost.bump` / `upsertRepo` are skipped for MCP opens (T4.2) | Measured. No change needed beyond T4.2 |
| `Session.openedBy` | `createMcpSession` (T4.2) | tooltip (T5.4), log (T2.3) | Both |
| A new session's handle | `claimHandle` at create (T4.3) | tool result, `list_sessions`, `mcp:state` badge; `prepareLaunch` keeps it (`assignHandle` `current`) | Both |
| `suppressAutoSwitch` | `openRepo` with `mcp.focus === false`, before `assignOwner`/`postState` (T4.2) | app.tsx autoSwitch effect via `pickAutoSwitch` (T5.4) | Both. `postState` is synchronous (`main.ts:2039-2061`, direct `webContents.send`), so order holds on one webContents |
| `activateSession` on focus | `openRepo` with `mcp.focus === true`, after `postState` (T4.2) | existing `app.tsx:698` handler → `setActiveId` | Producer only. The consumer is unchanged and already handles the existing notification-click producer (`main.ts:1805`) |
| `openFileInEditor` + `line`/`column`/`focus` | `openMcpFile` (T4.2). OS open (`main.ts:1165`, `:1172`) unchanged, sends no new fields | app.tsx handler + `flushOsOpens` via `planFileOpen` (T5.4) | Both |
| `tools.listChanged: true` + notifications | json-rpc init (T2.2), `syncToolLists` (T3.1) | each CLI | **Producer only.** CLI behaviour is outside our control. S0 measures it, and the call-time gate is the guard (spec §3.4) |
| `McpUiState.switchable` | `uiState()` (T3.1) | app.tsx session menu (T5.4) | Both |
| `term:start` def source | `effectiveDef(mgr.get(id), registry)` (T4.1) | was `registry.get(m.agentId)`. The renderer sends `agentId={s.agentId}` (`webview/components/center-pane.tsx:358`), so for registered sessions the def is the same | Host side only. The renderer field is now unread (Out of scope) |
| `CONDUIT_TOOLS` removal | T2.2 | `json-rpc.ts:42`, `mcp-launch.ts:35`, `conduit-mcp-host.ts:546`, `test/unit/conduit-mcp-json-rpc.test.ts:11,18` | All four are updated in T2.2 and T3.1 |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/tool-switches.ts` | create | Tool catalog, defaults, coercion, effective set, gate order |
| `src/session-command.ts` | create | `command` session kind and the `effectiveDef` seam |
| `src/conduit-mcp/control-tools.ts` | create | The three control tools: args, rate windows, validation, outputs |
| `webview/auto-switch.ts` | create | Which new session autoSwitch activates |
| `webview/file-open-request.ts` | create | How an `openFileInEditor` request opens (OS vs MCP) |
| `webview/components/mcp-tools-dialog.tsx` | create | Per-session Inherit/On/Off dialog |
| `test/e2e/conduit-mcp-control.e2e.mjs` | create | Main flow: list_changed, focused/background open, disabled worker, open_file |
| `test/e2e/conduit-mcp-control-terminal.e2e.mjs` | create | `open_terminal`: marker, Relaunch, Duplicate, missing command |
| `docs/runs/2026-10-27-mcp-control/s0.md` | create | S0 measurements |
| `test/unit/conduit-mcp-tool-switches.test.ts`, `test/unit/session-command.test.ts`, `test/unit/conduit-mcp-control-tools.test.ts`, `test/unit/auto-switch.test.ts`, `test/unit/file-open-request.test.ts`, `test/unit/mcp-tools-dialog.test.tsx`, `test/unit/settings-mcp-tools.test.tsx` | create | Unit tests |
| `src/conduit-mcp/types.ts` | modify | New `ToolErrorCode`s |
| `webview/conduit-mcp-strings.ts` | modify | Error strings (T1.0); tool descriptions and dialog/settings copy (T5.2) |
| `src/types.ts` | modify | `SessionCommand`, `SessionOpener`, three `Session` fields |
| `src/session-manager.ts` | modify | create/duplicate with command, `setMcpToolOverride` |
| `src/persistence.ts` | modify | Coerce the three fields |
| `src/settings.ts` | modify | `mcpTools` |
| `src/conduit-mcp/tool-schemas.ts` | modify | `toolSchemas(agentIds)` replaces `CONDUIT_TOOLS` |
| `src/conduit-mcp/json-rpc.ts` | modify | Catalog from `TOOL_NAMES`, `listChanged: true`, `TOOLS_LIST_CHANGED` |
| `src/mcp-launch.ts` | modify | Claude allowlist is messaging-only |
| `src/conduit-mcp/ui-types.ts` | modify | `switchable` |
| `electron/conduit-mcp-host.ts` | modify | Gate, per-conn list, sync, `claimHandle`, control wiring, override IPC |
| `src/protocol.ts` | modify | Override IPC (T3.1); `suppressAutoSwitch` + `openFileInEditor` fields (T4.2) |
| `src/launch-spec.ts`, `src/pty-host.ts`, `src/launch-preview.ts` | modify | `def`-based launch resolution |
| `electron/main.ts` | modify | `term:start` via `effectiveDef`; `openRepo` `mcp` arg; `createMcpSession`, `openMcpFile`; host deps |
| `webview/components/settings-modal.tsx` | modify | Tools group; `Toggle` a11y props |
| `webview/app.tsx` | modify | autoSwitch suppression, open handler, menu item, dialog mount, announce |
| `webview/components/session-card.tsx` | modify | "Opened by" tooltip line |
| `webview/use-conduit-mcp.ts` | modify | `setToolOverride` |
| `test/e2e/fixtures/fake-mcp-agent.mjs` | modify | Record `LIST_CHANGED` and re-list as `TOOLS` |
| `test/e2e/conduit-mcp-helpers.mjs` | modify | `toolsSeen`, `enableToolViaDialog`, `sessions`, `activeSessionId` helpers |
| Existing tests: `test/unit/conduit-mcp-json-rpc.test.ts`, `mcp-launch.test.ts`, `conduit-mcp-host.test.ts`, `persistence.test.ts`, `session-manager.test.ts`, `coerce-settings.test.ts`, `launch-spec.test.ts`, `launch-preview.test.ts` | modify | Follow the changed contracts + new cases |
| `CHANGELOG.md` | modify | User-facing entry + downgrade note |

## Scripts

- **S0 probe server (one-off):**
  - `%TEMP%\claude-scratch\s0-list-changed-server.mjs`, run as
    `node s0-list-changed-server.mjs [--enum-size 60]`.
  - It is a stdio MCP server that lists `ping_a` and `enum_probe` (`agent` enum of N ids).
  - After the first `ping_a` call it adds `ping_b` and sends `notifications/tools/list_changed`.
  - It replaces hand-editing four CLI configs per probe. Delete it after S0.
- No durable scripts: no edit repeats across more than a handful of files.

## Slices

Order: S1 → S2 → S3 → S4 → S5 → S6. **S0 is independent.** It needs the real Claude, Codex,
Cursor and OpenCode CLIs on the human's machine, never CI. It can run any time, and its outputs
flip two local switches (T2.2 enum, T5.2 hint). If S0 hasn't run by then, the defaults are:
**keep the enum** and **show the hint**.

**Shared-file serialization:**
- `electron/main.ts`: T3.1 (the `createConduitMcpHost` call only, S3), then T4.1 → T4.2 → T4.3
  in S4's serial lane.
- `src/protocol.ts`: T3.1 owns it in S3, T4.2 in S4. The slices are sequential, so there is
  never a concurrent edit.
- `webview/app.tsx`: T5.4 only, in S5's serial lane.
- `src/types.ts`: T1.3 only.
- `src/conduit-mcp/types.ts`: T1.0 only.
- `webview/conduit-mcp-strings.ts`: T1.0 in S1, T5.2 in S5.
- `electron/conduit-mcp-host.ts`: T2.2 (two lines, S2), T3.1 (S3), T4.3 (S4).
- `CHANGELOG.md`: T6.4.

---

### Slice 0: Measure CLI behaviour (independent, real CLIs)

**Check:** `docs/runs/2026-10-27-mcp-control/s0.md` exists with one row per CLI × question and a
"Decisions" section that settles D1, A6 and D3.

**Parallel groups:** G1: T0.1 (independent of every other slice)
**Claims:** none

#### Task 0.1: Probe list_changed, enum, approval

**Files:** Create `docs/runs/2026-10-27-mcp-control/s0.md`. Scratch:
`%TEMP%\claude-scratch\s0-list-changed-server.mjs`, deleted after.

**Steps:**
- [ ] Write the probe server (Scripts).
- [ ] For each of Claude Code, Codex, Cursor CLI (`agent`) and OpenCode:
  - register the server;
  - start a session and ask it to call `ping_a`;
  - in the **same** session, ask it to call `ping_b`.
  Record whether `ping_b` is callable without a relaunch (yes / after relaunch / never).
- [ ] With `--enum-size 60`, ask each CLI to call `enum_probe` with the 60th id. Record
  accept / reject / schema error.
- [ ] Codex: test whether a per-tool approval key, e.g.
  `mcp_servers.conduit.tools.open_terminal.approval_mode='prompt'`, overrides
  `default_tools_approval_mode='auto'`. Record the exact key that works, or "none".
- [ ] Write `s0.md`:
  - a table per question;
  - **Decisions:**
    - D1: the hint ships iff any CLI is "after relaunch" or "never";
    - A6: the enum stays iff all four accept it;
    - D3: Codex per-tool approval key or none.
- [ ] Delete the scratch file.

---

### Slice 1: Model — catalog, settings, session fields

**Check:**
- `npx vitest run test/unit/conduit-mcp-tool-switches.test.ts test/unit/session-command.test.ts test/unit/persistence.test.ts test/unit/session-manager.test.ts test/unit/coerce-settings.test.ts`
  is green;
- `npm run typecheck` is green.

**Parallel groups:** Serial (first): T1.0 → T1.1 · then G1: T1.2 · G2: T1.3
**Claims (serial lane):** `src/conduit-mcp/types.ts`, `webview/conduit-mcp-strings.ts` (T1.0);
`src/types.ts` (T1.3)

#### Task 1.0: Error codes

**Files:**
- Modify `src/conduit-mcp/types.ts` (`ToolErrorCode`, `:10-25`).
- Modify `webview/conduit-mcp-strings.ts`: add the eight codes to the map that
  `satisfies Record<ToolErrorCode, string>` (`:138`). Typecheck fails without them.

**Interfaces:** Produces the `ToolErrorCode` members listed in Contracts.

**Steps:**
- [ ] Carve-out (type-only change): the red step is `npm run typecheck` after adding the codes to
  `ToolErrorCode` alone. It fails at the `satisfies` map in `webview/conduit-mcp-strings.ts:138`.
- [ ] Add the codes and their human strings. Copy, e.g. `tool_disabled`: "That tool isn't enabled
  for this session"; `command_not_found`: "Command not found".
- [ ] `npm run typecheck` is green.

#### Task 1.1: `src/conduit-mcp/tool-switches.ts`

**Files:** Create `src/conduit-mcp/tool-switches.ts`. Test
`test/unit/conduit-mcp-tool-switches.test.ts`.

**Interfaces:**
- Produces the whole `tool-switches.ts` block in Contracts.
- Consumes `toolError(code, message): ToolError` (`src/conduit-mcp/types.ts:37`) and the T1.0
  codes.

**Steps:**
- [ ] Failing tests:
  - 'defaults: messaging on, control off' — `DEFAULT_MCP_TOOLS.open_terminal === false && DEFAULT_MCP_TOOLS.send_message === true`;
  - 'coerceMcpTools keeps valid keys, defaults the rest, drops unknown' — `coerceMcpTools({open_file: true, bogus: true, read_inbox: 'yes'})` equals `{...DEFAULT_MCP_TOOLS, open_file: true}`;
  - 'coerceMcpTools of a non-object is the defaults' — for `null`, `[]` and `'x'`;
  - 'coerceToolOverrides drops non-boolean and unknown, undefined when empty';
  - 'override wins over global; absent inherits' — `effectiveTool({open_session: true}, DEFAULT_MCP_TOOLS, 'open_session') === true` and `effectiveTool({send_message: false}, …, 'send_message') === false`;
  - 'effectiveTools is in catalog order';
  - 'withOverride inherit deletes the key and returns undefined when empty; does not mutate';
  - 'gate order': with `sessionId: null` and everything else failing → `not_in_session`; with a session and `messagingOn: false` → `messaging_off`; then `enabled: false` → `tool_disabled`, and the message contains the tool name and not "Settings"; all passing → `null`.
- [ ] `npx vitest run test/unit/conduit-mcp-tool-switches.test.ts` fails (module missing).
- [ ] Implement.

#### Task 1.2: `settings.mcpTools`

**Files:** Modify `src/settings.ts` (`AppSettings` near `:182`, `DEFAULT_SETTINGS` near `:242`,
`coerceSettings` near `:524`). Test `test/unit/coerce-settings.test.ts`.

**Interfaces:**
- Consumes `McpToolSwitches`, `DEFAULT_MCP_TOOLS` and `coerceMcpTools(v: unknown): McpToolSwitches`
  from `src/conduit-mcp/tool-switches.ts`.
- Produces `AppSettings.mcpTools: McpToolSwitches`.

**Call sites:** `coerceSettings` callers are unchanged. Renderer settings hydration
(`webview/settings.tsx`) carries the whole object, so there is no edit there. Re-run
`test/unit/settings-sync.test.ts` and `test/unit/settings-hydrate-dom.test.ts` to confirm.

**Steps:**
- [ ] Failing tests:
  - 'mcpTools absent → defaults';
  - 'mcpTools partial → merged per key';
  - 'mcpTools malformed → defaults';
  - 'round-trip through serializeSettings/restoreSettings keeps open_session: true'.
- [ ] Run. Expect FAIL (field missing).
- [ ] Implement.

#### Task 1.3: Session fields, `effectiveDef`, manager, persistence

**Files:**
- Modify `src/types.ts` (the `Session` interface at `:63`, plus the two new interfaces).
- Create `src/session-command.ts`.
- Modify `src/session-manager.ts` (`SessionCreateOpts` `:39`, `create` `:91`, `duplicate`
  `:149`, new `setMcpToolOverride` beside `setMcp` `:301`).
- Modify `src/persistence.ts` (`parseSessions` `:92-104`).
- Tests: create `test/unit/session-command.test.ts`; modify `test/unit/session-manager.test.ts`
  and `test/unit/persistence.test.ts`.

**Interfaces:**
- Produces the `src/types.ts`, `src/session-command.ts`, `src/session-manager.ts` and
  `src/persistence.ts` blocks in Contracts.
- Consumes from T1.1: `ToolName`, `McpToolOverrides`, `ToolOverrideValue`,
  `coerceToolOverrides(v: unknown): McpToolOverrides | undefined` and
  `withOverride(overrides, tool, value): McpToolOverrides | undefined`.
- Consumes `commandLeaf` from `src/launch-args.ts`.

**Call sites:**
- `mgr.create` is called at `electron/main.ts:2215`.
- `mgr.duplicate` is called at `electron/main.ts:~3691`.
- The signatures only gain optional fields, so both stay valid.

**Steps:**
- [ ] Failing tests in `session-command.test.ts`:
  - 'effectiveDef of a registered session is registry.get' — a fake registry `{get: (id) => defs[id]}`;
  - 'effectiveDef of a command session is commandDef, never registry' — `id === 'command'`, `command`/`args` copied, `label === 'cursor-agent'` for `command: '/usr/bin/cursor-agent'`;
  - 'effectiveDef of a command session without command is undefined';
  - 'commandDef args are a copy';
  - 'coerceSessionCommand': it rejects the empty command, 1025-byte command, 65 args, args over 8 KB, and non-string args, and accepts `{command:'node', args:['-e','x']}`;
  - 'coerceOpenedBy requires both strings'.
- [ ] Failing tests in `session-manager.test.ts`:
  - 'create command without opts.command throws Unknown agent: command';
  - 'create with command on another agent throws';
  - 'create command session stamps command and openedBy, no overrides';
  - 'duplicate carries command, not overrides or openedBy';
  - 'setMcpToolOverride sets, inherit deletes, unknown id → false, no emit when unchanged'.
- [ ] Failing tests in `persistence.test.ts`:
  - 'parseSessions keeps valid mcpToolOverrides/command/openedBy';
  - 'drops malformed ones without dropping the entry';
  - 'command session with invalid command loads stale with agentId command and no command'.
- [ ] Run the three files. Expect FAIL.
- [ ] Implement. `setMcpToolOverride` uses `withOverride` and deletes the key when the result is
  undefined.

---

### Slice 2: MCP server core

**Check:**
- `npx vitest run test/unit/conduit-mcp-json-rpc.test.ts test/unit/mcp-launch.test.ts test/unit/conduit-mcp-control-tools.test.ts`
  is green;
- `npm run typecheck` is green.

**Parallel groups:** G1: T2.2 · G2: T2.3
**Claims:** none. T2.2 touches `electron/conduit-mcp-host.ts` only at its `CONDUIT_TOOLS`
import/use (`:32`, `:546`). T2.3 doesn't touch it, and T3.1 runs after.

#### Task 2.2: Catalog, schemas, list_changed capability, Claude allowlist

**Files:**
- Modify `src/conduit-mcp/tool-schemas.ts`, `src/conduit-mcp/json-rpc.ts` and `src/mcp-launch.ts`.
- Modify `electron/conduit-mcp-host.ts` at `:32` and `:546` only, so the tree keeps compiling
  with today's behaviour (messaging tools only) until T3.1 replaces the line:
  `tools: () => (current() ? toolSchemas([]).filter((t) => MESSAGING_TOOL_NAMES.some((n) => n === t.name)) : [])`.
- Tests: `test/unit/conduit-mcp-json-rpc.test.ts` and `test/unit/mcp-launch.test.ts`.

**Interfaces:**
- Produces:
  - `toolSchemas(agentIds: readonly string[]): ToolSchema[]`;
  - `TOOLS_LIST_CHANGED: string`;
  - `KNOWN_TOOLS = new Set(TOOL_NAMES)`;
  - `initialize` returns `capabilities.tools.listChanged === true`.
- Consumes `TOOL_NAMES`, `MESSAGING_TOOL_NAMES` and `ToolName` from T1.1.

**Call sites:**
- `CONDUIT_TOOLS` is used at `src/conduit-mcp/json-rpc.ts:1,42`, `src/mcp-launch.ts:4,35`,
  `electron/conduit-mcp-host.ts:32,546` and `test/unit/conduit-mcp-json-rpc.test.ts:11,18`.
- All are rewritten, and `CONDUIT_TOOLS` is deleted.

**Steps:**
- [ ] Failing tests:
  - json-rpc 'initialize advertises tools.listChanged true';
  - 'tools/call open_session reaches deps.call (not invalid_argument)', with a stub `call` recording the name;
  - 'unknown name still invalid_argument';
  - 'TOOLS_LIST_CHANGED is a JSON-RPC notification without id';
  - schemas: 'toolSchemas lists 7 in catalog order; open_session.agent.enum equals the given ids; every schema additionalProperties false; open_terminal args maxItems 64';
  - mcp-launch: '--allowedTools lists exactly the four messaging tools'.
- [ ] Run. Expect FAIL.
- [ ] Implement. Apply S0's A6 result if `s0.md` exists; otherwise keep the enum.

#### Task 2.3: `src/conduit-mcp/control-tools.ts`

**Files:** Create `src/conduit-mcp/control-tools.ts`. Test
`test/unit/conduit-mcp-control-tools.test.ts`.

**Interfaces:**
- Produces the whole `control-tools.ts` block in Contracts.
- Consumes:
  - `Caller {handle: Handle; sessionId: string | null}` (`src/conduit-mcp/tools.ts:33`);
  - `Result`, `toolError` (`src/conduit-mcp/types.ts`);
  - `SessionCommand`, `SessionOpener` (`src/types.ts`);
  - `MAX_COMMAND_BYTES`, `MAX_ARGS`, `MAX_ARGS_BYTES`, `coerceSessionCommand` and
    `commandLabel(c): string` (`src/session-command.ts`).

**Steps:**
- [ ] Failing tests, all with fake deps and POSIX paths, `resolvePath = (h, p) => p.startsWith('/') ? p : `${h}/${p}``:
  - 'open_session resolves a relative path against the caller home' — `deps.openSession` receives `home: '/home/main/../wt/T1'` as resolved by the fake;
  - 'missing path → path_missing, file → not_a_directory; openSession never called';
  - 'open_file on a dir → not_a_file';
  - 'unknown agent → unknown_agent listing the registered ids';
  - 'command not resolving → command_not_found, nothing opened';
  - 'extra key → invalid_args'; 'label 81 chars → invalid_args'; 'line 0 → invalid_args'; 'args 65 entries → invalid_args';
  - 'focus defaults to true';
  - 'open_terminal passes {kind:"command", command, args} and the default label is the command leaf';
  - 'success returns {session_id, handle: claimHandle(id), label, agent}'; 'handle null when claimHandle is null';
  - 'brief_unavailable from openSession maps to the error, rate window not charged';
  - 'rate: 10 successful opens by one caller in 60s → 11th rate_limited; at 60s+1 allowed again';
  - 'global: 20 across callers → 21st rate_limited for a fresh caller';
  - 'open_file not rate limited';
  - 'homeOf undefined → not_in_session';
  - 'openedBy is {handle, sessionId} of the caller'.
- [ ] Run. Expect FAIL (module missing).
- [ ] Implement in the fixed check order (Contracts).

---

### Slice 3: Host — gate, lists, list_changed, handles, override IPC

**Check:** `npx vitest run test/unit/conduit-mcp-host.test.ts` is green, and
`npm run verify:quick` is green.

**Parallel groups:** Serial: T3.1
**Claims (serial lane):** `electron/conduit-mcp-host.ts`, `src/protocol.ts`,
`src/conduit-mcp/ui-types.ts`, `electron/main.ts` (the `createConduitMcpHost` call only)

#### Task 3.1: Gate, effective list, list_changed, override IPC, switchable

**Files:**
- Modify `electron/conduit-mcp-host.ts` (`ConduitMcpHostDeps` `:74`, `callTool` `:490`,
  `onConnection` `:534-588`, `uiState` `:615`, `refresh` `:871`, `handleRenderer` `:877`).
- Modify `src/protocol.ts` (add the `mcp:setToolOverride` / `mcp:toolOverrideResult` members).
- Modify `src/conduit-mcp/ui-types.ts` (`switchable`).
- Test `test/unit/conduit-mcp-host.test.ts`. Its `createConduitMcpHost({…})` factory at `:162`
  gains `mcpTools`, `defOf`, `agentIds` and `mgr.setMcpToolOverride`.
- Modify `electron/main.ts` `createConduitMcpHost({…})` (`:1882`): add the three new deps.

**Interfaces:**
- Produces:
  - the `ConduitMcpHostDeps` additions and `McpUiState.switchable`;
  - the two protocol members;
  - `syncToolLists()` (internal), called by `refresh()`.
- Consumes:
  - from T1.1: `effectiveTool`, `effectiveTools`, `gateToolCall`, `isMessagingTool`,
    `isToolName`, `McpToolSwitches`;
  - from T2.2: `toolSchemas(agentIds)`, `TOOLS_LIST_CHANGED`;
  - from T1.3: `mgr.setMcpToolOverride(id, tool, value): boolean`.

**Call sites:** `createConduitMcpHost` is called at `electron/main.ts:1882`. This task adds the
final wiring for its three new deps:
- `mcpTools: () => settings.mcpTools`;
- `defOf: (id) => { const s = mgr.get(id); return s ? effectiveDef(s, registry) : undefined; }`;
- `agentIds: () => registry.list().map((d) => d.id)`.

`control` is **not** part of this task. It enters `ConduitMcpHostDeps` in T4.3, together with
main's real implementation (T4.2), so no stub ever exists. Until then a control tool call that
passes the gate falls through `runTool`'s existing `default` (`invalid_argument`). No test
asserts that interim answer.

**Steps:**
- [ ] Failing host tests:
  - 'gate: master off → messaging_off for open_session and send_message; tools/list lists all 7';
  - 'gate: master on, control default → open_session tool_disabled, list excludes control tools';
  - 'gate: tool_disabled precedes store_unavailable'. Use a store that fails to load: `send_message` disabled by override returns `tool_disabled`, enabled returns `store_unavailable`;
  - 'override true for one session lists open_session only on that connection';
  - 'override change sends list_changed once to an initialized connection, not to an uninitialized one, and not again when the set is unchanged';
  - 'settings change via refresh() sends list_changed to affected connections only';
  - 'mcp:setToolOverride replies unknown-session / unknown-tool / invalid-value / ok';
  - 'uiState.switchable lists sessions whose defOf matches an adapter, before any launch'.
- [ ] Run. Expect FAIL.
- [ ] Implement per Contracts. `lastListed` is keyed by `conn.id` and cleared in `onClose`.

---

### Slice 4: Main wiring — launch seam, MCP create/open, control tools live

**Check:**
- `npx vitest run test/unit/launch-spec.test.ts test/unit/launch-preview.test.ts test/unit/conduit-mcp-host.test.ts`
  is green;
- `npm run verify:quick` is green;
- one local scenario, `npm run e2e -- conduit-mcp-gate` (the existing MCP e2e), passes, which
  proves `term:start` still launches profile sessions with MCP.

**Parallel groups:** Serial: T4.1 → T4.2 → T4.3
**Claims (serial lane):** `electron/main.ts`, `src/protocol.ts` (T4.2),
`electron/conduit-mcp-host.ts` (T4.3)

#### Task 4.1: `term:start` resolves through `effectiveDef`

**Files:**
- Modify `src/launch-spec.ts`, `src/pty-host.ts` (`resolveLaunchSpec` `:283`) and
  `src/launch-preview.ts` (`:42`).
- Modify `electron/main.ts` `case 'term:start'` (`:4103`; the def lookups at `:4191`, `:4199`,
  `:4243`, `:4250`, `:4255`).
- Tests: `test/unit/launch-spec.test.ts` (it imports `resolveLaunchSpec` at `:4`) and
  `test/unit/launch-preview.test.ts`.

**Interfaces:**
- Produces:
  - `LaunchRequest { def: AgentDefinition | undefined; cwd; home; homeMissing; roots; exists; resolveCommand; platform }`;
  - `resolveLaunchSpec(def: AgentDefinition | undefined, cwd: string | undefined, cwdExists: (p: string) => boolean, fallbackCwd: string): SpawnSpec`.
- Consumes `effectiveDef(s, registry): AgentDefinition | undefined` and
  `COMMAND_AGENT_ID = 'command'` from `src/session-command.ts`.

**Call sites (every one):**
- `buildLaunchSpec`: `electron/main.ts:4199` and `src/launch-preview.ts:42`.
  `launch-preview` already holds `def` (`:34`, undefined for `'shell'`).
- `resolveLaunchSpec`: `src/launch-spec.ts:36` and `test/unit/launch-spec.test.ts:35`. Re-grep
  `resolve-launch-spec.test.ts` for any import and update it too.

**Steps:**
- [ ] Failing tests:
  - launch-spec: 'def undefined → default shell spec';
  - 'command def → spawns def.command resolved, args as argv, launchArgsFor applied';
  - 'unresolvable command def → unresolvable with def.command'.
  Update the existing cases to pass `def` (via `registry.get(id)`).
- [ ] Run. Expect FAIL (signature).
- [ ] Implement. In `term:start`:
  - move `const s = mgr.get(m.sessionId)` above the `whenLaunchReady` wait, and
    `const def = s ? effectiveDef(s, registry) : undefined`;
  - after the `isAlive` re-check, `s.agentId === COMMAND_AGENT_ID && !s.command` means: show the
    banner `— can't start: the saved command is invalid —` via `scrollbacks.show`, then
    `pendingRelaunchMarker.delete`, `mgr.setStatus(id, 'stale')`, `log.warn('pty', 'refused', {reason: 'command-invalid'})`
    and `break`;
  - `cwdReportingAugmentation(def?.id ?? s.agentId, spec.args)`;
  - `prepareLaunch(m.sessionId, def, spec)` when `def`;
  - `roleBriefs.prepareSpawn(m.sessionId, def, spec)`.
  `m.agentId` is no longer read in this case. The `pty spawn` log keeps `agentId: s.agentId`.

#### Task 4.2: `openRepo` MCP path, `createMcpSession`, `openMcpFile`, protocol

**Files:**
- Modify `electron/main.ts`: `openRepo` `:2193`; new `createMcpSession` and `openMcpFile` beside
  `openRepoRequest` (`:2410`); `sendOpenFileInEditor` / `flushPendingOsOpens` (`:1162-1175`) to
  carry the optional fields.
- Modify `src/protocol.ts` (`openFileInEditor` `:695`, new `suppressAutoSwitch`).

**Interfaces:**
- Produces:
  - `openRepo(p, agentId, ownerWindowId, cardId?, extras?, brief?, mcp?: McpOpenExtras)`;
  - `createMcpSession(req: McpOpenRequest): Promise<McpOpenOutcome>`;
  - `openMcpFile(req: McpFileRequest): Promise<{ sessionId: string }>`;
  - `mcpOwnerWindow(callerSessionId: string): number`;
  - the protocol members in Contracts.
- Consumes:
  - from T2.3: `McpOpenRequest`, `McpOpenOutcome`, `McpFileRequest`;
  - from T1.3: `commandDef`, `COMMAND_AGENT_ID`;
  - `resolveOwningSession` (`src/owning-session.ts:20`);
  - `sessionOps.resolveInitialRoots(home, roots)`;
  - `probeDeps.longName(p)`.

**Call sites:** `openRepo` is called at `main.ts:2459`, `:5098` and `:5111`. The new param is
trailing and optional, so they are unchanged.

**Behaviour:**
- **`openRepo` with `mcp`:**
  - `agent = mcp.command ? commandDef(mcp.command) : registry.get(agentId)`. It is **no**
    `registry.list()[0]` fallback. A missing agent returns `undefined`, which `createMcpSession`
    maps to `unknown_agent`.
  - It passes `name: mcp.name`, `command: mcp.command` and `openedBy: mcp.openedBy` to
    `mgr.create`, and skips `launcherHost.bump` and the whole repos block.
  - Before `assignOwner`: if `!mcp.focus`,
    `windows.get(ownerWindowId)?.webContents.send('to-webview', {type: 'suppressAutoSwitch', sessionId: id})`.
  - After `postState()`: if `mcp.focus`, the same send with `{type: 'activateSession', sessionId: id}`.
- **`createMcpSession`:**
  - `home = await probeDeps.longName(req.home)`.
  - `initial = await sessionOps.resolveInitialRoots(home, undefined)`.
  - `projectId` is the caller's `projectId` if `projectStore.has` it.
  - Brief: `{request: undefined, dialog: true}` for an agent, `{request: {kind: 'none'}, dialog: true}`
    for a command.
  - A result with `'error'` gives `{ok: false, code: 'brief_unavailable', message: error}`.
    `undefined` gives `unknown_agent`.
  - The label is the created session's `name`.
- **`openMcpFile`:**
  - `target = resolveOwningSession({path, sessions: mgr.list().map(({id, home, roots}) => ({id, home, roots})), openDocs: [], activeId: null}) ?? req.callerSessionId`.
  - `sendOpenFileInEditor(path, target, {line, column, focus})`. The OS-open callers pass no nav.

**Steps:**
- [ ] No unit seam: `main.ts` is untested by units. The proof is S6's e2e plus
  `npm run verify:quick` here.
- [ ] Implement. `npm run typecheck` is green.

#### Task 4.3: `claimHandle` + control tools live

**Files:**
- Modify `electron/conduit-mcp-host.ts`:
  - extract `claimHandle(sessionId: string, adapter: McpAdapter): Handle | null` from
    `prepareLaunch:746-771`, and have `prepareLaunch` call it;
  - add `control: Omit<ControlDeps, 'claimHandle' | 'now' | 'info' | 'agentIds'>` to deps;
  - `const control = createControlHandlers({...deps.control, agentIds: deps.agentIds, claimHandle: claimFor, now, info: (m, d) => deps.log.info('conduit-mcp', m, d)})`;
  - in `runTool`, `open_session` / `open_terminal` / `open_file` go to `control.*`.
- Modify `electron/main.ts` `createConduitMcpHost({...})` (`:1882`):
  - `control: {homeOf: (id) => mgr.get(id)?.home, resolvePath: (h, p) => path.resolve(h, p), kindOf, resolveCommand: (c) => resolveCommand(c, hostPlatform), openSession: createMcpSession, openFile: openMcpFile}`;
  - `kindOf = (p) => fs.promises.stat(p).then((s) => (s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'), () => 'missing' as const)`.
    It doesn't reuse `probeDeps.kind`, because that returns `'dir' | 'not-dir' | 'missing'`
    (`src/folder-validation.ts:31`) and can't tell a file from a socket or device.
- Test `test/unit/conduit-mcp-host.test.ts`.

**Interfaces:**
- Consumes `createControlHandlers(deps: ControlDeps): ControlHandlers` (T2.3), and
  `createMcpSession` / `openMcpFile` (T4.2).
- Produces nothing new outward.

**Steps:**
- [ ] Failing host tests:
  - 'open_session with the switch on calls control.openSession and returns the claimed handle';
  - 'claimHandle at create: a later prepareLaunch keeps the same handle';
  - 'handles.json write failure → handle null, unavailable launch-io';
  - 'open_file routes to control.openFile';
  - 'a control tool with the store down is not store_unavailable' (that gate step is messaging-only).
- [ ] Run. Expect FAIL.
- [ ] Implement.

---

### Slice 5: Renderer — focus, file opens, dialog, settings, menu

**Check:**
- `npx vitest run test/unit/auto-switch.test.ts test/unit/file-open-request.test.ts test/unit/mcp-tools-dialog.test.tsx`
  is green;
- `npm run verify:quick` is green;
- `npm run text-fit` is green (new dialog copy).

**Parallel groups:** G1: T5.1 · G2: T5.2 → T5.3 · Serial: T5.4
**Claims (serial lane):** `webview/app.tsx` (T5.4); `webview/conduit-mcp-strings.ts` (T5.2)

#### Task 5.1: `auto-switch.ts` + `file-open-request.ts`

**Files:**
- Create `webview/auto-switch.ts` and `webview/file-open-request.ts`.
- Tests: `test/unit/auto-switch.test.ts` and `test/unit/file-open-request.test.ts`.

**Interfaces:**
- Produces `pickAutoSwitch`, `FileOpenRequest`, `FileOpenPlan` and `planFileOpen` (Contracts).
- Consumes `OpenMode` (`webview/docs.ts:74`) and `CursorPos` (`webview/editor-nav.ts:9`).

**Steps:**
- [ ] Failing tests:
  - 'newest running added session wins';
  - 'suppressed id is skipped, next newest wins';
  - 'only suppressed → undefined';
  - 'non-running ignored';
  - planFileOpen: each of the three focus cases, exactly as in Contracts; 'line without column → column 1'; 'no line → no reveal'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.2: Strings + `McpToolsDialog`

**Files:**
- Modify `webview/conduit-mcp-strings.ts` (add `MCP_STR.tools`).
- Create `webview/components/mcp-tools-dialog.tsx`.
- Test `test/unit/mcp-tools-dialog.test.tsx`.

**Strings (`MCP_STR.tools`):**
- `groupMessaging: 'Messaging'`, `groupControl: 'Control'`.
- `description: Record<ToolName, string>`. It is shared with T5.3, and the control entries use
  spec §8's exact risk copy:
  - `open_terminal`: "Lets an agent run any program as you, outside its own sandbox."
  - `open_session`: "Lets an agent start sessions from your profiles."
  - `open_file`: "Lets an agent open files in your editor."
- `overrideNote: 'Sessions can override these from their menu (MCP tools…).'`
- `masterOffHint: 'Turn on the Conduit MCP server to use tools'`
- `menuItem: 'MCP tools…'`
- `dialogTitle: (label) => \`MCP tools — ${label}\``
- `inherit: (on: boolean) => \`Inherit (${on ? 'On' : 'Off'})\``, `on: 'On'`, `off: 'Off'`
- `relaunchHint: 'Some agents only see newly enabled tools after Relaunch'`, `relaunch: 'Relaunch'`
- `saveFailed: 'Couldn’t save. Change it again to retry.'`
- `announce: (tool, value, label) => \`${tool} set to ${value} for ${label}\``
- `openedBy: (handle) => \`Opened by ${handle}\``

**Interfaces:**
- Produces `McpToolsDialog(props: McpToolsDialogProps)` and `MCP_STR.tools`.
- Consumes:
  - `ModalLayer` (`webview/components/modal-layer.tsx:14`);
  - `SegmentedRadios<T>({label, value, options, onChange, disabled?})`
    (`webview/components/segmented-radios.tsx`);
  - from T1.1: `TOOL_NAMES`, `MESSAGING_TOOL_NAMES`, `CONTROL_TOOL_NAMES`, `effectiveTool`,
    `ToolOverrideValue`.

**Behaviour:**
- `role="dialog"`, `aria-modal`, labelled by the title.
- One `SegmentedRadios` per tool, labelled by the tool name, with options
  `inherit|on|off` → `'inherit'|true|false`.
- On change it calls `onChange` optimistically. If that resolves `false`, it reverts to the
  persisted value and shows `saveFailed` inline. On success it calls
  `announce(MCP_STR.tools.announce(...))`.
- When `masterOn` is false, every group is disabled and `masterOffHint` shows.
- The relaunch hint and button show when `connected` and the session changed in this dialog,
  **and** the hint is enabled by S0 D1. If `s0.md` is absent, it is enabled.
- Esc and the backdrop call `onClose`. Initial focus is the first radiogroup.

**Steps:**
- [ ] Failing tests (jsdom):
  - 'renders a radiogroup per tool, labelled by the tool name';
  - 'Inherit label shows the global value';
  - 'picking Off calls onChange(tool, false) and announces';
  - 'onChange false reverts the selection and shows the save error';
  - 'master off disables all groups and shows the hint';
  - 'Esc calls onClose';
  - 'relaunch hint only after a change while connected'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.3: Settings Tools group

**Files:** Modify `webview/components/settings-modal.tsx` (`Toggle` `:807`, MCP `SetGroup`
`:930-939`).

**Interfaces:**
- Consumes `MCP_STR.tools` (T5.2), `MESSAGING_TOOL_NAMES`, `CONTROL_TOOL_NAMES` and
  `settings.mcpTools` (T1.2).
- Produces `Toggle({value, onChange, labelledBy?, describedBy?, disabled?})`.

**Behaviour:**
- Under the master toggle there are two sub-sections, Messaging (4) and Control (3).
- Each row has the tool name (`<code>`, with an id), its description (with an id), and a `Toggle`
  with `aria-labelledby`/`aria-describedby`. It is disabled while `!settings.conduitMcp`, and the
  hint shows then.
- `onChange` calls `update({mcpTools: {...settings.mcpTools, [tool]: v}})`.
- The `overrideNote` sits below.

**Steps:**
- [ ] Failing test: create `test/unit/settings-mcp-tools.test.tsx`. No settings-modal DOM test
  exists; the only references are `test/unit/files-drop-claim.test.ts` and
  `test/unit/overlay-sites.test.ts`, which are static scans.
  - 'fresh settings show control switches off';
  - 'toggling open_session posts updateSettings with mcpTools.open_session true';
  - 'master off disables tool switches'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.4: `app.tsx` wiring, card tooltip, hook

**Files:**
- Modify `webview/app.tsx`:
  - the message handler `:698-714` (`activateSession`, `openFileInEditor`; add `suppressAutoSwitch`);
  - the autoSwitch effect `:801-811`;
  - `pendingOsOpensRef` `:1172` and `flushOsOpens` `:2678-2692`;
  - `onSessionContextMenu` messaging group `:2870-2885`;
  - the dialog mount beside `TimedMessageDialog` (`:4734`).
- Modify `webview/components/session-card.tsx` (`:94-112` title).
- Modify `webview/use-conduit-mcp.ts` (`api` `:50`).

**Interfaces:**
- Consumes:
  - `pickAutoSwitch`, `planFileOpen`, `FileOpenRequest` (T5.1);
  - `McpToolsDialog`, `MCP_STR.tools` (T5.2);
  - `McpUiState.switchable` (T3.1);
  - the protocol members (T3.1, T4.2).
- Produces `ConduitMcpApi.setToolOverride(sessionId, tool, value): Promise<boolean>`, built with
  `requestHost(…, ['mcp:toolOverrideResult'], REQUEST_TIMEOUT_MS)`. `null` or `ok:false` gives
  `false`.

**Behaviour:**
- **`suppressedRef = useRef(new Set<string>())`.**
  - `suppressAutoSwitch` adds the id.
  - The effect computes `added` as today. It calls `pickAutoSwitch(added, suppressedRef.current)`
    only when `settings.autoSwitchSession` is on, and then deletes every `added` id from the set
    whether or not the setting is on.
- **`pendingOsOpensRef`** becomes `FileOpenRequest[]`. For a known session, `flushOsOpens` runs
  `const p = planFileOpen(req)`, then:
  - `if (p.activate) setActiveId(req.sessionId)`;
  - `if (p.showEditor) setCenterView('editor')`;
  - `openFile(req.path, req.sessionId, p.mode, p.reveal ? { reveal: p.reveal } : undefined)`.
- **Menu:** if `mcp.state?.switchable.includes(s.id)`, add the item `MCP_STR.tools.menuItem`,
  which opens the dialog with `setMcpToolsFor(s.id)`. It shows even without a badge.
- **Dialog mount:**
  - `const target = sessions.find(...)`; it renders `null` when the session is gone, which
    closes the dialog;
  - `global = settings.mcpTools`, `masterOn = settings.conduitMcp`,
    `connected = mcp.state?.sessions[id]?.connected === true`;
  - `onRelaunch = () => post({type: 'relaunch', id})`;
  - `announce` sets `navLiveRef.current.textContent`;
  - `onClose` restores focus to `.session[data-sessionid="<id>"]`.
- **Card title:** `[mcpTitle, session.openedBy && MCP_STR.tools.openedBy(session.openedBy.handle)].filter(Boolean).join('\n') || undefined`.

**Steps:**
- [ ] The unit seams are T5.1/T5.2. Here the proof is `npm run verify:quick` plus S6's e2e.
- [ ] Implement.

---

### Slice 6: E2E + changelog

**Check:**
- `npm run e2e -- conduit-mcp-control` passes locally (one scenario);
- `npm run verify` is green;
- `npm run e2e:remote -- conduit-mcp-control conduit-mcp-control-terminal`, then
  `npm run e2e:remote` (`--affected`), are green remotely.

**Parallel groups:** Serial (first): T6.1 · G1: T6.2 · G2: T6.3 · Serial: T6.4
**Claims (serial lane):** `CHANGELOG.md` (T6.4)

#### Task 6.1: Fake agent records list_changed; helpers

**Files:** Modify `test/e2e/fixtures/fake-mcp-agent.mjs` and `test/e2e/conduit-mcp-helpers.mjs`.

**Interfaces — produces:**
- **Fake:** an incoming line with `method === 'notifications/tools/list_changed'` and no `id`
  calls `record('LIST_CHANGED')`, then `rpc('tools/list')`, then
  `record('TOOLS', {tools: names})`. This goes in the stdout parse loop, before the `waiting`
  lookup. Update the header comment's record list.
- **Helpers:**
  - `toolsSeen(sessionId): string[]`: the last `TOOLS` record's tools, else `READY`'s;
  - `enableToolViaDialog(page, sessionId, tool, value: 'On'|'Off'|'Inherit')`: right-click
    `.session[data-sessionid=…]`, click the menu item `MCP tools…`, click the radio whose label
    starts with `value` inside the group labelled `tool`, press Escape;
  - `sessions(page)`: `window.__sessions`;
  - `activeSessionId(page)`: the id of the `.session` row carrying the selected class from
    `sessionRowClass({selected: true})` (`src/session-dot.ts`).

**Steps:**
- [ ] Carve-out (fixture/harness code). The proof is T6.2's first scenario going red before T6.1
  and green after.

#### Task 6.2: `test/e2e/conduit-mcp-control.e2e.mjs`

**Files:** Create `test/e2e/conduit-mcp-control.e2e.mjs`.

**Scenarios:** `runScenario('conduit-mcp-control', …, {userDataDir: fakeAgentProfile('control')})`
with phases:

1. **setup:**
   - `createProject(page, 'p')`;
   - main = `openFake(page, dirA)` with `projectId`;
   - worker = `openFake(page, dirB)`;
   - `enableToolViaDialog(page, main.sessionId, 'open_session', 'On')`.
2. **list_changed:**
   - `until(() => records(main, 'LIST_CHANGED').length > 0)`;
   - `toolsSeen(main)` includes `open_session`;
   - `toolsSeen(worker)` lacks it.
3. **focused open:**
   - `mkdtemp` a dir;
   - `callTool(main, 'open_session', {path: dir, agent: FAKE_AGENT_ID, focus: true})`;
   - the result has `session_id` and a non-null `handle`;
   - the new session's `home === dir` (normalised `\`→`/`), its `projectId` is main's, and it
     sits in the same window (the only window);
   - `activeSessionId === session_id`;
   - `callTool(main, 'list_sessions')` includes the handle.
4. **disabled worker:**
   - count the sessions;
   - `callTool(worker, 'open_session', …)` gives `error.code === 'tool_disabled'`;
   - the count is unchanged.
5. **background open:**
   - `post({type: 'activateSession'})` is not used; click main's row instead;
   - `open_session` with `focus: false` gives a new session, and `activeSessionId` is still main.
6. **open_file:**
   - `enableToolViaDialog(main, 'open_file', 'On')`;
   - write a 60-line fixture file into `dirA`;
   - `callTool(main, 'open_file', {path: 'fixture.txt', line: 40})`;
   - the active doc tab's title is `fixture.txt`;
   - the Monaco cursor line is 40, read through `window.monaco.editor.getEditors()` →
     the editor whose model URI ends in `/fixture.txt` → `getPosition().lineNumber`. This is the
     same `window.monaco` access as `test/e2e/auto-save-helpers.mjs:99` and
     `test/e2e/editor-nav-history-moves.e2e.mjs:82`.

Every temp dir is removed with the harness `removeDir`.

#### Task 6.3: `test/e2e/conduit-mcp-control-terminal.e2e.mjs`

**Files:** Create `test/e2e/conduit-mcp-control-terminal.e2e.mjs`.

**Scenarios:**
- `runScenario('conduit-mcp-control-terminal', …, {userDataDir: fakeAgentProfile('control-term')})`.
- **Setup:** main = `openFake(page, dirA)`, then `enableToolViaDialog(main, 'open_terminal', 'On')`.
1. **marker:**
   - `callTool(main, 'open_terminal', {path: dirA, command: process.execPath, args: ['-e', "process.stdout.write('CTRL-MARK\\n');process.stdin.on('data',d=>{if(String(d).includes('q'))process.exit(0)})"]})`;
   - `waitForOutput(page, sid, 'CTRL-MARK', 1)`.
2. **relaunch:**
   - `typeLine(page, sid, 'q')`;
   - wait for `status === 'exited'`. The session stays: `sessionExitAction` treats `command` as an
     agent;
   - `post({type: 'relaunch', id: sid})`;
   - `waitForOutput(page, sid, 'CTRL-MARK', 2)`.
3. **duplicate:**
   - `post({type: 'duplicate', id: sid})`;
   - the new id appears, and `waitForOutput(page, dupId, 'CTRL-MARK', 1)`.
4. **missing command:**
   - count the sessions;
   - `callTool(main, 'open_terminal', {path: dirA, command: 'no-such-cmd-xyz'})` gives
     `error.code === 'command_not_found'`;
   - the count is unchanged.

#### Task 6.4: CHANGELOG

**Files:** Modify `CHANGELOG.md` (Unreleased).

**Steps:** One user-facing entry covering:
- agents can open sessions, terminals and files when you enable it;
- the per-tool switches in Settings and the session menu;
- control tools are off by default;
- a downgrade note: "an older build shows `open_terminal` sessions as failed (stale)".

## Verification

- **Per task:** the named vitest file(s), red then green.
- **Per slice:** the slice's Check, which ends in `npm run verify:quick`.
- **After S6, once:** `npm run verify` (full gate). Then remote e2e: the two new scenarios by
  name, then `--affected`.
- Locally, run only one e2e by exact name. Never fan e2e out.
- Capture exit codes directly, never through a pipe or pager.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work.
Never a shim, second copy, special case, widened type, fallback, or an override patched in place
of its semantic source. The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **D3:** Codex auto-approves every Conduit tool (`default_tools_approval_mode='auto'`,
  `src/mcp-launch.ts:56`), so a Codex session with `open_terminal` enabled runs commands with no
  Codex prompt. Claude's allowlist stays messaging-only, so Claude prompts. Default taken: if S0
  finds a per-tool Codex approval key, T2.2 adds it for the three control tools with mode
  `prompt`. Otherwise keep server-wide auto, since the human's switch is the trust boundary (A1).
- [normal] **D1** (spec): Does the Relaunch hint ship? S0 decides. Default when S0 hasn't run:
  show it.
- [normal] **D2** (spec): The `open_terminal` label is the command leaf, with the generic
  terminal glyph via `iconForAgent(undefined)`. `agent` in its result is also the command leaf.
- [normal] **D4:** "Out-of-root files open in the text editor only" has no renderer mechanism.
  Default taken: rely on the existing host confinement of every `conduit-preview:` root to
  session roots (`main.ts:3068`, ADR 0005). An out-of-root HTML/MD file opens in its normal viewer,
  whose root-confined loads are refused. Adding a forced-text mode is a separate change.
- [normal] **D5:** The "Save failed" state covers validation refusals (`mcp:toolOverrideResult`
  `ok:false`) and a host timeout. A `sessions.json` write error is logged by the existing persist
  path and is not surfaced per change.
- [normal] **D6:** `term:start` reads the definition from the session, not `m.agentId`. They are
  equal for every existing producer (`center-pane.tsx:358`), and the field stays in the protocol,
  unread.

## Architecture review r1 amendments (2026-10-27, conductor-accepted; override the task text above)

Report: architecture-critic, REVISE (1 blocker, 5 should-fix, 3 nits), all accepted.

- **B1 · T4.1:** read the session before the `whenLaunchReady` wait **only** to compute `def`.
  Keep the post-await `const s = mgr.get(m.sessionId); if (!s) break` re-read exactly where it is
  (`main.ts:~4189`): it is the kill-race guard, and moving it up spawns an orphaned PTY for a
  session killed during the wait.
- **SF1 · T4.2:** extract a shared `prepareOpen(home, roots, projectId)` used by both
  `openRepoRequest` and `createMcpSession`. It includes the `realKeys.set(folderKey(home), …)`
  step, so the MCP path can't drift from the dialog path (spec A3).
  - Don't grow `openRepo`'s positional arguments. Pass one options object whose `mcp` part
    carries only "skip launcher bump and recents" plus the focus hooks.
  - The definition comes from `effectiveDef`; no second `commandDef ?? registry.get` branch.
- **SF2 · T5.4:** the sidebar and board card agent label use `commandLabel(s.command)` when
  `s.command` is set. Today `agentLabelFor` falls back to the raw id. Consumers:
  `sidebar.tsx:308,394`, `board-card-links.tsx:45`.
- **SF3 · T6.4 + spec §3.3:** downgrade truth. An older build's `resolveLaunchSpec` catches
  `Unknown agent` and launches the default shell in the session's folder. It doesn't fail stale.
  The CHANGELOG/spec note says that.
- **SF4 · T2.3:** rate slots are reserved at check time and released on failure, with a
  concurrency test (11 parallel → 10 OK). Sent to the slice 1–2 executor.
- **SF5 · D3:** Codex approves the whole server automatically, so an `open_terminal`-enabled
  Codex session runs commands **without asking**. The T5.2 Settings and dialog description for
  `open_terminal` adds: "Codex sessions run it without asking." D3 is surfaced to the human in the
  run report. S0, if run, also records Cursor's approval behavior.
- **Nits:**
  - The synthesized definition id is `conduit:command`, and agents.json rejects `conduit:` ids.
    Sent to the executor.
  - `planFileOpen` takes an explicit `source: 'os' | 'mcp'`, not "focus absent".
  - `syncToolLists` gets a one-line pointer: the enum changes are deliberately ignored (A6
    validates live).

## Build deviations (S1–S5, recorded after review r1)

Unplanned files and edits the build was forced into; none changes behaviour beyond the plan.

- **T3.1 call sites missing from the producer/consumer map:** `McpUiState.switchable` made typed
  literals fail to compile: `webview/bridge.ts` (the fake shell's state) and the fixtures in
  `test/unit/conduit-mcp-view-model.test.ts` and `test/unit/messages-pane.test.tsx` (each gained
  `switchable: []`).
- **T3.1 router case:** `electron/main.ts` gained `case 'mcp:setToolOverride'` in the webview
  message router; without it the override IPC never reaches the host.
- **T5.x styles:** `webview/styles.css` carries the MCP tools dialog and Settings Tools group rules.
- **SF2 consumers:** `src/agent-label.ts` and `webview/components/board-view.tsx` were touched so
  the sidebar and board card label a command session by `commandLabel`.
- **ConduitMcpApi fakes:** the host-API fakes in `test/unit/message-compose.test.tsx`,
  `test/unit/messages-pane.test.tsx` and `test/unit/right-pane-review-kebab.test.ts` gained
  `setToolOverride`.
- **Review r1 fixes:**
  - the `open_terminal` default label (spec §3.1/D2, the command leaf) is applied in
    `control-tools.ts`, the one place that parses the tool's args, so `createMcpSession` receives
    it as `req.label` and the returned `label` is the created session's name (no main.ts change);
  - a throw from main's open path maps to the new `open_failed` code at the control-tools
    boundary (catalog + strings). Non-retryable: a retry could repeat a half-done open.
