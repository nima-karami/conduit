# Plan: Conduit MCP server

Spec: [2026-10-25-conduit-mcp-server.md](../specs/2026-10-25-conduit-mcp-server.md) (FULL).

**Tier: FULL.** This adds a new subsystem with a security surface: a local endpoint, a shim, token
identity, a durable store, PTY injection behind a gate, and launch wiring for several CLIs. It
also adds a new right-pane tab and attention reasons. It crosses `src/`, `electron/`, `webview/`,
`resources/` and packaging. Planned unattended, so every would-be question is in
`## Decisions Needed` with the default taken.

This revision applies the architecture-review rulings and the S0 results (commit `214b4439`,
[s0-screens.md](../runs/2026-10-25-conduit-mcp/s0-screens.md)). The rulings are recorded under
Settled decisions.

## Goal

Agent CLIs running in Conduit sessions, and the human, can message each other: they can send,
attach snapshots and read an inbox through four MCP tools. Idle recipients get one content-free
notice typed into their PTY, and only when a gate proves that is safe.

## Architecture

**The pure core** is `src/conduit-mcp/`. It imports no `electron`, and every module is
unit-tested on ubuntu. It holds:
- the minimal JSON-RPC/MCP server (`json-rpc.ts`) and the tool schemas;
- the four tool handlers over a store interface (`tools.ts`);
- the message store, an append-only log plus content-addressed blobs (`store.ts`, with
  `store-fs.ts` as its node IO). All IO runs through one queue;
- handle slug and counter functions (`handles.ts`);
- the session registry: token↔session, live connections and handle assignment
  (`session-registry.ts`);
- attachment snapshot and confinement;
- the notice gate, a pure decision function;
- the notice text;
- the draft-input reducer;
- per-agent adapter declarations and the screen verdict;
- the notifier state machine;
- the attention-items reducer (`attention-items.ts`);
- the Cursor config editor;
- wire types. All of them live in `types.ts`, except the renderer aggregates in `ui-types.ts`,
  which import only `./types`.

**Shared pure helpers beside their siblings:**
- `src/pty-writer.ts` is the one serialized host writer per session. Timed messages and notices
  both go through it. A notice's full gate runs **inside its slot** (`beforeText`), and the
  positive-echo check runs before Enter (`beforeEnter`).
- `src/mcp-launch.ts` builds the per-CLI launch wiring and sits next to `src/launch-args.ts`.

**Host glue** in `electron/` follows the `createX(deps)` shape of `electron/repo-tracker-host.ts`,
and owns IO only:
- `conduit-mcp-endpoint.ts` is the named pipe / unix socket server and its hello handshake.
- `session-screens.ts` holds the per-session `@xterm/headless` screen models.
- `conduit-mcp-host.ts` composes the pure parts with IO: endpoint, store, screens, the writer,
  the handles file, launch config files and broadcasts.
- `cursor-mcp-link.ts` is the opt-in edit of `~/.cursor/mcp.json`. It is the **last and
  conditional** slice.

`electron/main.ts` only constructs the host and forwards PTY/renderer events to it.

**The shim** is `resources/conduit-mcp/conduit-mcp-shim.cjs`, a dependency-free stdio↔endpoint byte
relay. It sends a hello line with the token first. It answers on its own only when the host can't
be reached (`host_unavailable`). It runs as Conduit's own executable with `ELECTRON_RUN_AS_NODE=1`,
and that variable is set only in the MCP server's env entry.

**The renderer** gets a third right-pane tab, **Messages**, fed by one `mcp:state` broadcast plus
request/reply messages. Attention items from the host join the existing "N need you" chip.

No sketches were made. Every seam copies a sibling:
- the host factory copies `createRepoTrackerHost` (`electron/repo-tracker-host.ts`);
- the writer's DI copies `TimerScheduler` deps (`electron/main.ts:1682-1699`);
- the strings copy `TERM_LINK_STR` (`webview/term-link-strings.ts`);
- request/reply copies `requestHost` (`webview/host-request.ts:8`);
- resource resolution copies `bundledSkillsDir` (`electron/skills-service.ts:19-23`);
- the fake agent copies `test/e2e/fixtures/fake-claude.mjs`.

## Data flow

```
Conduit term:start (main.ts:3951)
  buildLaunchSpec ─► mcpHost.prepareLaunch(sessionId, def, spec)
     adapterFor(def) [adapters.ts] ─► registry.assignHandle ─► write handles.json, THEN mgr.setMcp(mcpHandle)
     registry.mint(sessionId, token) ─► spec.env.CONDUIT_SESSION_TOKEN
     mcpLaunchWiring [src/mcp-launch.ts] ─► args (--mcp-config <userData/conduit-mcp/launch/<id>.json>
                                            | -c mcp_servers.conduit.* | none for cursor)
  pty.start ─► mcpHost.onSpawn(id, cols, rows) ─► screens.start(id)

CLI ──spawns──► <execPath> conduit-mcp-shim.cjs --endpoint <pipe>   (env ELECTRON_RUN_AS_NODE=1, token via PTY env)
  shim ─hello {"conduit":1,"token":…}─► endpoint [electron/conduit-mcp-endpoint.ts]
  shim ⇄ newline-delimited JSON-RPC ⇄ host connection
     registry.resolve(token) ─► McpServerCore.handleLine [json-rpc.ts]
        tools/call ─► ToolHandlers [tools.ts]
            send_message: validate ─► snapshotAttachment [attachments.ts] ─► store.append (IO queue)
                          ─► onStored ─► notifier poke + attention reducer + broadcast mcp:state

PTY output ─► main send cb ─► activity.recordOutput (existing) + mcpHost.onOutput ─► screens.feed
renderer term:input ─► main ─► mcpHost.onRendererInput (draft reducer, inputSeq, lastInputAt) ─► pty.input

notifier tick (500 ms) [notifier.ts]
   pre-check: evaluateGate(...)  — decides only whether to TRY
     try ─► ptyWriter.submit(id, composeNotice(urgent), {
               beforeText:  full evaluateGate in the session's slot   (closed → 'gate-closed', nothing written)
               text ─ SUBMIT_GAP_MS ─
               beforeEnter: evaluateEnterRecheck — requires ScreenVerdict 'notice-echoed'
             }) ─ "\r"                      [src/pty-writer.ts, shared with timed messages]
           submitted ─► store.setStatus(noticed)     withheld ─► attention 'unsent-notice'
     pre-check closed + urgent ─► attention 'urgent-waiting' (once per message)

attention events ─► reduceAttention [attention-items.ts] ─► items in mcp:state
host ─mcp:state (coalesced 150 ms)─► renderer: Messages tab, card badges (incl. gate reason), attention chip
renderer ─mcp:compose / thread:get / attachment:get / allowMore / pause / markRead / retry─► host
```

## Settled decisions — do not re-litigate

These come from the spec and the conductor's locked architecture:
- MCP is the agent interface. There is no MCP SDK; the host speaks a minimal subset.
- The four tools are the MVP ceiling.
- Identity is host-resolved from the per-launch token. No tool takes a `from`.
- The endpoint is a named pipe / unix socket derived from a userData hash, injectable for tests.
- The shim is a byte relay in app resources, run by Conduit's exe with `ELECTRON_RUN_AS_NODE=1`
  in the server env entry only, never the PTY env.
- Launch wiring per spec §3.1:
  - claude: `--mcp-config` with a generated file in userData;
  - codex: `-c mcp_servers.conduit.*`, including `env_vars` and `default_tools_approval_mode='auto'`;
  - cursor: the opt-in Connect/Disconnect edit of `~/.cursor/mcp.json`, with a backup and
    `${env:CONDUIT_SESSION_TOKEN}`.
- The cmd-metachar guard is extended to every adapter. Tripping it means the session launches
  without messaging, never a broken launch.
- Attachments are snapshotted at send time and confined with `isInsideRoot` + `realPathLeaf`
  against the sender's same root (ADR 0005). `conduit-preview:` is not widened. The UI views
  attachments through new IPC.
- The store lives in `userData/conduit-mcp/`.
- Gate conditions, priorities and the notice text are exactly spec §2. `needsAttention` is not a
  gate input.
- The loop guard is 20 agent messages per thread. Rate limit is 60 sends/min. Notice spacing is
  30 s. Idle quiet is 3 s. Limits are 10 MB / 25 MB per file / message.
- The UI is a Messages tab beside Changes/Files. Strings live in `webview/conduit-mcp-strings.ts`.
- E2E uses a fake MCP-capable agent fixture that runs the real shim, enabled only under
  `CONDUIT_E2E`. Real CLIs get local runtime QA.
- The feature stays on `feat/conduit-mcp` and is not released.

**Architecture-review rulings (conductor, settled):**
1. **The gate runs inside the writer slot.** `PtyWriter.submit` takes `beforeText` (the full
   `evaluateGate`, run in the session's slot) and `beforeEnter`. The notifier's pre-check only
   decides whether to try.
2. **The store has one IO queue** inside `createMessageStore`: append, setStatus, allowMore and
   retention all go through it. `load` truncates a torn tail via `rewriteLog` before the first
   append. `mcp:retry` reloads only when `!available()`.
3. **The pre-Enter recheck requires positive evidence.** A new `ScreenVerdict` value,
   `'notice-echoed'`, means the cursor rows show the notice text. Any other verdict withholds the
   Enter and raises human attention.
4. **The draft clears** when the screen reads `empty-input` and there has been no renderer input
   for ≥ `IDLE_QUIET_MS`. `McpSessionBadge` shows the gate's closed reason.
5. **Claude's idle staying output-quiet for ≥ 3 s is ASSUMED.** It is measured in the S9 e2e
   (fake agent) and in runtime QA (real claude). See Decisions.
6. **Pure `src/conduit-mcp/attention-items.ts`** (a reducer) **and
   `src/conduit-mcp/session-registry.ts`** (token↔session, live connections, handle assignment)
   are extracted with unit tests. The host keeps IO only.
7. **Cursor Connect is the last slice, and conditional.** It is built only after S0–S11 are
   verified. S11 (restart e2e + changelog) comes before Cursor (S12).
   - Human-compose attachments (the attach picker and save-as) are cut to v1. The attachment
     **view** stays.
   - Retention is by **age only**. The 1 GB thread-ordered eviction is dropped.
8. **`ThreadSummary` and all wire types live in `types.ts` from T2.1.** `ui-types.ts` imports no
   node-backed module.
9. **The gate reads `SessionActivity`'s output clock.** There is no second `lastOutputAt`.
10. **Handle persistence write order:** the counter (`handles.json`) first, then
    `Session.mcpHandle`. A crash between the two burns a number and never reuses one.

**S0 measured (commit `214b4439`):**
- Claude's blocking prompts carry `Esc to cancel`; its idle screens never do.
- Notice text, then a separate `\r`, became a `read_inbox` turn.
- In `claude-permission.json` the cursor sits at row 7, and the dialog is at rows 17–24. So
  **blocking patterns match any viewport row**, and **empty-input is matched on the cursor row
  only**.
- A fresh idle screen shows the placeholder `❯ Try "fix lint errors"` while the input is empty.
- Claude's trust menu is `❯ No, exit` (no digit; Enter quits), and it is covered by
  `Esc to cancel`.
- Codex idle/approval screens were not captured, so Codex is pull-only. The Codex trust footer
  `enter continue · esc quit` (a notice + Enter trusted the folder) is a declared blocking
  pattern anyway.

## Spec staleness

| Spec claim | Measured | How the plan proceeds |
|---|---|---|
| §3.1 "`<agent>` is the agent definition's `id`" → `claude-1` | Detected CLI ids are `cli:<name>` (`src/shells.ts:190-219`, `src/launchers.ts:12-19`). agents.json ids are arbitrary. The slug rule would give `cli-claude-1` | The handle prefix is the **adapter id** (`claude`, `codex`, `cursor`, `fake`), slugged by the same rule. That matches the spec's own examples |
| §2/§3.1 Cursor CLI is `agent` | `AGENT_CLI_NAMES` lists `cursor-agent` (`src/launchers.ts:12-19`) | The cursor adapter matches both leaves, `agent` and `cursor-agent` |
| §3.1 "The label stays separately editable" | `Session` has `name`, not `label` (`src/types.ts:54`) | `list_sessions.label` = `session.name` |
| §2 "`@xterm/headless` (already a dependency)" | It is a **devDependency** (`package.json:121`), imported only by tests | T6.2 moves it to `dependencies`. In `package-lock.json` it removes `"dev": true` from `node_modules/@xterm/headless` (`:4352`) and moves the root `packages[""]` entry. No `npm install` |
| §3.5 "Rendered screen: PTY output → scrollback ring … replay of the tail" | The scrollback ring exists only when `scrollbackPersistence` is on. The 4 KB tail can't rebuild a repainted screen (`src/pty-host.ts:72`) | Follow §2. The headless model is fed directly from PTY output in the send callback |
| §2 gate "bottom rows / cursor region" | S0: Claude's permission dialog is ~15 rows below the cursor (`claude-permission.json`, cursorY 7, `Esc to cancel` at row 24) | Blocking patterns match the whole visible viewport. Empty-input is matched on the cursor row. Echo is matched on the cursor row plus the 2 rows above |
| §3.5 "Attention: `src/attention.ts` chip" | `src/attention.ts` is renderer-only pure derivation over a boolean `needsAttention`, with no reason model (`webview/components/top-bar.tsx:111-120`) | `attention-items.ts` reduces host events into `McpAttentionItem`s carried by `mcp:state`. `src/attention.ts` gains `attentionEntries()` merging them with session attention |
| §3.5 "PTY input … one serialized per-session writer" | `term:input` writes directly (`electron/main.ts:4180-4185`). Only timer fires are queued (`src/timer-scheduler.ts:77,186-196`) | New `src/pty-writer.ts` serializes host-originated writes across sources. `TimerScheduler`'s queue stays, because it orders its own `sendOnce` awaits. Renderer input stays direct and is observed by the draft reducer |
| §3.1 token "inherited by every process in the session" | `sanitizeChildEnv` (`src/pty-host.ts:53`) doesn't strip `CONDUIT_*`. A Conduit started from inside a Conduit session would hand the outer token to its plain shells | T8.2 strips `CONDUIT_SESSION_TOKEN` there. Only `prepareLaunch` sets it |
| `SessionActivity` exposes output time | `lastOutputAt` is a private entry field (`src/session-activity.ts:62,128`), unreadable from outside | T9.1 adds `SessionActivity.lastOutputAt(id): number \| undefined` (ruling 9). It is fed only by non-inert chunks (`electron/main.ts:1538`), so focus-reply repaints don't count as activity |

## Global constraints

- **Gate:**
  - `npm run verify` is the gate and the pre-commit hook. The inner loop is
    `npm run verify:quick`. One unit file: `npx vitest run test/unit/<name>.test.ts`.
  - Never narrow, skip or disable a check, and never use `--no-verify`. Capture exit codes
    directly, never through `tail`/`head`.
- **Comments:** they explain **why** only. When the why lives in the spec, the comment is a
  one-line pointer, e.g. `// see docs/specs/2026-10-25-conduit-mcp-server.md §2 gate`.
- **No band-aids:** no `as any`, `@ts-ignore`, swallowed errors, `!important` or magic offsets.
  Every `catch` either maps to a named error code or logs through the injected `log`.
- **Platform-free unit tests (CI is ubuntu):**
  - No unit test asserts win32 behaviour by running on win32.
  - `endpointPath` takes `platform: 'win32' | 'posix'` and is tested with string fixtures for both.
  - Socket-based tests get their endpoint from `test/helpers/test-endpoint.ts`. It picks a pipe
    name on win32 and a tmp socket elsewhere, so it runs on both without asserting either.
  - Fixture paths are built with `path.join(os.tmpdir(), …)`.
- **Node-free modules** (renderer-importable, no `node:*` imports, no import of a node-backed
  module, including type-only imports):
  - `src/conduit-mcp/types.ts`, `ui-types.ts`, `notice-gate.ts`, `notice-text.ts`,
    `draft-input.ts`, `adapters.ts`, `screen-verdict.ts`, `tool-schemas.ts`,
    `attention-items.ts`, `session-registry.ts`, `handles.ts`, `cursor-config.ts`;
  - `src/mcp-launch.ts`, `src/attention.ts`.
- **Host:**
  - No sync fs on hot paths. Store IO is `fs.promises`.
  - The exceptions are `realPathLeaf`, which is sync (`src/path-guard.ts:60`) and runs once per
    attachment at send time, and the two `atomicWriteFileSync` writes per launch (handles.json
    on allocation, the launch config).
  - Git is never spawned by this feature. Directory watching is not used.
- **Terminal (CLAUDE.md):**
  - Host-side screens are `@xterm/headless` only. They never touch renderer xterms or WebGL.
  - Host-originated PTY writes go only through `ptyWriter.submit`. Nothing else may call
    `pty.input` for host-originated text.
  - `term:input` and add-dir delivery (`electron/main.ts:2693`) keep their direct writes.
- **Renderer:**
  - New CSS classes are prefixed `mcpmsg` (pane, thread, compose) or `session__mcp` (card).
    Never use bare generics (`test/unit/monaco-class-collision.test.ts`).
  - Overlays use `ModalLayer` / `Popover`, which are already `no-drag`
    (`test/unit/drag-region.test.ts`).
  - Never name state after a DOM global (`open`, `name`, `status`, `event`). `confirm`, `alert`
    and `prompt` are lint-banned.
  - jsdom component tests use the `// @vitest-environment jsdom` header and the manual React
    `act`/`createRoot` setup of `test/unit/confirm-dialog.test.ts`.
- **Naming:**
  - files are kebab-case;
  - factories are `createX`, constants `SCREAMING_SNAKE`, types `PascalCase`;
  - tests are `test/unit/<module>.test.ts(x)`;
  - strings live in `MCP_STR` in `webview/conduit-mcp-strings.ts`, counts use `countNoun`
    (`src/menu-selection.ts:27`), and times use `Intl.DateTimeFormat`.
- **Fallow:**
  - new exports need an importer (tests count);
  - `src/protocol.ts` and `src/types.ts` are export-ignored;
  - the shim gets an `entry` line in `.fallowrc.json`, because it is a real entry point, not
    a widened ignore.
- **E2E:**
  - Scenarios are `test/e2e/<name>.e2e.mjs`. They launch only via `launchElectron`, exit only via
    `finishScenario`, and run hidden.
  - Locally, run one by exact name: `npm run e2e -- <name>`. The gated run is
    `npm run e2e:remote --full` (main.ts and `test/e2e/**` are FULL triggers).
  - Executors **never** run e2e. The orchestrator runs them serially.
- **Changelog:** user-facing changes go in `CHANGELOG.md` `[Unreleased]` (T11.2, T12.2).

## Out of scope

- Spec v1/Vision:
  - observation (`read_session`, screenshots);
  - Cursor/OpenCode **launch** adapters beyond the Connect action;
  - channels, broadcast, TTL, leases, `wait_for_reply`, explicit ack;
  - typed interrupt of a busy agent;
  - native inbox delivery.
- **Cut to v1 (ruling 7):** human-compose attachments (the in-app attach picker over a session's
  roots, and "Save attachment as…"), and size-based retention (1 GB).
- Dedupe of retried sends, and cross-machine delivery.
- Localising the notice line (fixed ASCII by spec).
- Changing `SessionActivity`'s busy heuristic. The gate adds its own conditions; T9.1 only adds a
  read accessor.

## Contracts

### `src/conduit-mcp/types.ts` (new, node-free) — T2.1

```ts
export type Handle = string;                  // '<prefix>-<n>' or HUMAN_HANDLE
export const HUMAN_HANDLE = 'you';
export type Priority = 'fyi' | 'normal' | 'urgent';
export type MessageKind = 'inform' | 'request' | 'question' | 'done';
export type RecipientStatus = 'queued' | 'noticed' | 'read' | 'undelivered' | 'expired';
export type ToolErrorCode =
  | 'not_in_session' | 'unknown_handle' | 'self_target' | 'too_large' | 'too_many'
  | 'path_outside_roots' | 'path_unreadable' | 'not_found' | 'unsupported_media'
  | 'rate_limited' | 'thread_limit' | 'store_unavailable' | 'messaging_off'
  | 'host_unavailable' | 'invalid_argument';
export interface ToolError { code: ToolErrorCode; message: string; retryable: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; error: ToolError };
export function toolError(code: ToolErrorCode, message: string): ToolError;   // retryable ⇔ code ∈ {rate_limited, store_unavailable, host_unavailable}
export interface AttachmentRecord { attachmentId: string; name: string; mime: string; bytes: number; sha256: string }
export interface MessageRecord {
  messageId: string; threadId: string; from: Handle; to: Handle[];
  subject: string; kind: MessageKind; priority: Priority;
  sentAt: string;                              // ISO-8601 UTC
  body: string; attachments: AttachmentRecord[];
}
export interface RecipientState { status: RecipientStatus; noticeCount: number; updatedAt: string }
export interface StoredMessage extends MessageRecord {
  recipients: Record<Handle, RecipientState>;
  expired: boolean;                            // tombstone: body '' and blobs unref'd
}
export type LogRecord =
  | { v: 1; t: 'msg'; msg: MessageRecord }
  | { v: 1; t: 'rcpt'; messageId: string; handle: Handle; status: 'noticed' | 'read' | 'undelivered'; at: string }
  | { v: 1; t: 'allow'; threadId: string; at: string }
  | { v: 1; t: 'expire'; messageId: string; at: string };
export interface ThreadSummary {
  threadId: string; subject: string; firstLine: string; participants: Handle[];
  topPriority: Priority; lastAt: string; messageCount: number;
  unreadFor: Handle[];                          // recipients with ≥1 unread non-expired message
}
// gate + screen (consumed by notice-gate, screen-verdict, badges)
export type ScreenVerdict = 'blocking' | 'notice-echoed' | 'empty-input' | 'unknown';
export type GateClosedReason =
  | 'off' | 'paused' | 'not-running' | 'settling' | 'no-connection' | 'busy' | 'quiet'
  | 'blocking-prompt' | 'no-empty-input' | 'draft' | 'spacing' | 'no-echo';
// tool outputs (wire to agents)
export type Presence = 'busy' | 'idle' | 'exited';
export interface ListSessionsOutput {
  sessions: Array<{ handle: Handle; label: string; agent: string; project: string | null; roots: string[]; presence: Presence; messaging: 'connected' | 'unavailable'; self: boolean }>;
  human: { handle: 'you' };
}
export interface SendMessageOutput { message_id: string; thread_id: string; recipients: Array<{ handle: Handle; status: 'queued' | 'refused'; reason?: ToolErrorCode }> }
export interface InboxMessageOut {
  message_id: string; thread_id: string; from: Handle; to: Handle[]; subject: string;
  kind: MessageKind; priority: Priority; sent_at: string; body: string;   // body is framed
  attachments: Array<{ attachment_id: string; name: string; mime: string; bytes: number }>;
}
export interface ReadInboxOutput { messages: InboxMessageOut[]; remaining: number }
export type ReadAttachmentOutput =
  | { kind: 'text'; attachment_id: string; name: string; mime: string; bytes: number; offset: number; next_offset: number | null; text: string }
  | { kind: 'image'; attachment_id: string; name: string; mime: string; bytes: number; base64: string };
// launch + attention (wire to the renderer)
export type McpUnavailableReason = 'cmd-metachar' | 'unquotable-path' | 'messaging-off' | 'endpoint-down' | 'launch-io';
export type McpAttentionReason = 'urgent-waiting' | 'message-to-you' | 'thread-paused' | 'unread-after-renotice' | 'unsent-notice';
export interface McpAttentionItem {
  id: string;                                  // `${reason}:${handle}:${messageId ?? threadId ?? ''}`
  reason: McpAttentionReason; handle: Handle; sessionId: string | null;
  threadId: string | null; messageId: string | null; at: string;
}
```

- `invalid_argument` is beyond the spec's list. It covers schema failures (missing body, bad
  enum, non-string path). See Decisions.
- `host_unavailable` is produced only by the shim.
- The tool-output types live here (ruling 8), so `ui-types.ts` and `src/protocol.ts` never reach
  `tools.ts`.

### `src/conduit-mcp/json-rpc.ts` (new) — T1.1

```ts
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export type JsonRpcId = string | number;
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolCallResult { content: ToolContent[]; isError?: boolean; structuredContent?: unknown }
export interface ToolSchema { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpServerCoreDeps {
  serverInfo: { name: 'conduit'; version: string };
  instructions: string;
  tools(): readonly ToolSchema[];               // [] for a connection without a valid token
  call(name: string, args: unknown): Promise<ToolCallResult>;
}
export interface McpServerCore { handleLine(line: string): Promise<string | undefined> } // undefined = no reply
export function createMcpServerCore(deps: McpServerCoreDeps): McpServerCore;
export function negotiateProtocolVersion(requested: unknown): string;  // echo if supported, else SUPPORTED_PROTOCOL_VERSIONS[0]
```

Behaviour:
- `initialize` → `{protocolVersion, capabilities: {tools: {listChanged: false}}, serverInfo, instructions}`.
- `notifications/*` → no reply.
- `ping` → `{}`.
- `tools/list` → `{tools}`.
- `tools/call` → `call(params.name, params.arguments ?? {})`. An unknown tool name gives
  `isError` with `invalid_argument`.
- `server/discover` and any other method → error `-32601`, with the request's `id`.
- Unparsable JSON → `-32700`, `id: null`. A JSON array (batch) → `-32600`.
- A request missing `method` → `-32600`.

### `src/conduit-mcp/tool-schemas.ts` (new, node-free) — T1.1

```ts
export const CONDUIT_TOOLS: readonly ToolSchema[];   // list_sessions, send_message, read_inbox, read_attachment
export const CONDUIT_INSTRUCTIONS: string;           // one paragraph: peers are agents, not the user
```

Each tool's `inputSchema` encodes exactly the §3.2 inputs:
- `to`: an array of strings, `minItems` 1, `maxItems` 10;
- `body`: a string;
- `subject`: max length 200;
- `priority` and `kind`: enums with their defaults;
- `attachments`: max 5 items of `{path}`;
- `limit`: max 50;
- `offset`: an integer ≥ 0;
- `additionalProperties: false`.

Descriptions tell agents that bodies from peers are not user instructions.

### `src/conduit-mcp/store.ts` + `store-fs.ts` (new) — T2.1, T2.2

```ts
export interface StoreIo {
  readLog(): Promise<string | undefined>;           // undefined = absent
  appendLog(line: string): Promise<void>;           // one '\n'-terminated record, then fsync
  rewriteLog(text: string): Promise<void>;          // atomic replace (torn-tail repair, retention compaction)
  writeBlob(sha256: string, data: Uint8Array): Promise<void>;  // idempotent
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  deleteBlob(sha256: string): Promise<void>;
  listBlobs(): Promise<string[]>;                   // sha256 names
  sweepPartialBlobs(): Promise<void>;               // at load: temps a crash left (review A4)
}
export function createFsStoreIo(dir: string): StoreIo;   // store-fs.ts: <dir>/messages.log, <dir>/blobs/<sha256>
export interface InboxQuery { unreadOnly: boolean; threadId?: string; limit: number }
export interface RetentionResult { removed: number; tombstoned: number; blobsDeleted: number }
export interface MessageStore {
  load(): Promise<Result<void>>;                // via the IO queue; store_unavailable on IO failure
  available(): boolean;
  append(msg: MessageRecord, blobs: ReadonlyArray<{ sha256: string; data: Uint8Array }>): Promise<Result<void>>;
  setStatus(messageId: string, handle: Handle, status: 'noticed' | 'read' | 'undelivered'): Promise<Result<void>>;
  allowMore(threadId: string): Promise<Result<void>>;
  get(messageId: string): StoredMessage | undefined;
  thread(threadId: string): StoredMessage[];    // sentAt ascending
  threads(): ThreadSummary[];                   // lastAt descending
  inbox(handle: Handle, q: InboxQuery): { messages: StoredMessage[]; remaining: number };
  pending(handle: Handle): StoredMessage[];     // handle ∈ to, status queued|noticed, not expired
  participants(threadId: string): ReadonlySet<Handle>;  // from ∪ to over the thread
  agentCountSinceHuman(threadId: string): number;       // messages from ≠ you after max(last you-post, last allow)
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  enforceRetention(now: Date): Promise<Result<RetentionResult>>;
  onChange(cb: () => void): () => void;
}
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function createMessageStore(io: StoreIo, opts?: { maxAgeMs?: number }): MessageStore;
```

Invariants:
- **One IO queue** (ruling 2). `load`, `append`, `setStatus`, `allowMore` and
  `enforceRetention` each enqueue on a single promise chain that survives rejection. No two
  `StoreIo` calls ever overlap.
- **`load`** parses the log line by line. If the final line is torn (no trailing `\n`, or not
  JSON), it calls `rewriteLog(validLines)` **before** the queue accepts any append, so a new
  record never lands glued to a torn tail. It then deletes blobs with refcount 0. If `readLog`
  or `rewriteLog` throws → `store_unavailable`, and `available()` is false. Unparsable lines in
  the middle of the log are skipped (no accepted write produces one).
- `append` writes the blobs first, then the log line. A failed `appendLog` returns
  `store_unavailable` and leaves memory unchanged.
- A status is monotonic: `read` is never downgraded to `noticed`.
- `noticeCount` = the number of `noticed` records for that (message, handle).
- `undelivered` applies only to unread recipients.
- **Retention (age only, ruling 7):**
  - A message older than `maxAgeMs` that is fully read is dropped.
  - One with any unread recipient becomes a tombstone (`expire` record): body cleared, blobs
    unref'd, unread recipients `expired`.
  - Tombstones older than `maxAgeMs` past their expiry are dropped.
  - Blobs at refcount 0 are deleted.
  - Compaction goes through `rewriteLog`.

### `src/conduit-mcp/handles.ts` (new, node-free) — T4.1

```ts
export function slugHandlePrefix(id: string): string;  // lower-case; runs of [^a-z0-9] → '-'; trim '-'
export type HandleCounters = Readonly<Record<string, number>>;
export function allocateHandle(counters: HandleCounters, prefix: string): { handle: Handle; counters: HandleCounters }; // n = counters[prefix]+1, never reused
export function parseHandleCounters(text: string | undefined): HandleCounters;  // invalid → {}
export function serializeHandleCounters(c: HandleCounters): string;
```

### `src/conduit-mcp/session-registry.ts` (new, node-free) — T5.3

```ts
export interface HandleAssignment { handle: Handle; counters: HandleCounters; allocated: boolean }
export function assignHandle(i: {
  current: Handle | undefined; prefix: string; takenByOthers: ReadonlySet<Handle>; counters: HandleCounters;
}): HandleAssignment;   // keep `current` when set and not taken by another session; else allocateHandle
export interface SessionRegistry {
  mint(sessionId: string, token: string): void;        // replaces any previous token for the session
  revoke(sessionId: string): void;                     // token invalid; live connections listed for closing
  resolve(token: string | null): string | null;        // sessionId
  connect(connId: number, sessionId: string): void;    // after a successful initialize
  disconnect(connId: number): void;
  isLive(sessionId: string): boolean;
  connectionsOf(sessionId: string): number[];
}
export function createSessionRegistry(): SessionRegistry;
```

**Write order (ruling 10):** when `allocated`, the host writes `handles.json` (`atomicWriteFileSync`)
**first**, then `mgr.setMcp(id, {mcpHandle})`.

### `src/conduit-mcp/attachments.ts` (new) — T4.2

```ts
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const TEXT_PAGE_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface AttachmentSender { home: string; roots: readonly string[] }
export interface AttachmentSnapshot { name: string; mime: string; data: Uint8Array; sha256: string }
export interface AttachmentFs {
  stat(p: string): Promise<{ size: number; isFile: boolean } | undefined>;  // undefined = missing
  readFile(p: string): Promise<Uint8Array>;
}
export const nodeAttachmentFs: AttachmentFs;
export function snapshotAttachment(sender: AttachmentSender, rawPath: string, fs?: AttachmentFs): Promise<Result<AttachmentSnapshot>>;
export function mimeFor(name: string, data: Uint8Array): string;   // images via mediaKindForPath + imageMime (src/media-kind.ts:30,57); a text-ext set; else utf-8-without-NUL → 'text/plain'; else 'application/octet-stream'
export function textPage(data: Uint8Array, offset: number): { text: string; nextOffset: number | null }; // splits on a UTF-8 boundary ≤ TEXT_PAGE_BYTES
```

The confinement order is fixed:
1. `abs = path.resolve(sender.home, rawPath)`.
2. `root = [sender.home, ...sender.roots].find((r) => isInsideRoot(abs, r))`. If none:
   `path_outside_roots`.
3. `real = realPathLeaf(abs)`. If `!isInsideRoot(real, realPathLeaf(root))`: `path_outside_roots`.
4. `stat(real)`. Missing or not a file: `path_unreadable`. `size > MAX_ATTACHMENT_BYTES`:
   `too_large`.
5. Read the bytes **from `real`**. If the byte length > `MAX_ATTACHMENT_BYTES`: `too_large`. A
   read error: `path_unreadable`.

The home is the session's persisted `home`, never the OSC cwd.

### `src/conduit-mcp/tools.ts` (new) — T4.3

```ts
export interface Caller { handle: Handle; sessionId: string | null }   // sessionId null ⇔ HUMAN_HANDLE
export interface DirectoryEntry {
  handle: Handle; sessionId: string; label: string; agent: string; project: string | null;
  home: string; roots: string[]; presence: Presence; messaging: 'connected' | 'unavailable';
}
export interface ToolDeps {
  store: MessageStore;
  directory(): DirectoryEntry[];
  messagingOn(): boolean;
  now(): Date;
  newId(prefix: 'm' | 't'): string;               // 'm_' / 't_' + 16 base32 chars
  snapshot(sender: AttachmentSender, path: string): Promise<Result<AttachmentSnapshot>>;
  onStored(msg: MessageRecord): void;
  onThreadLimit(threadId: string, by: Handle): void;
}
export interface ToolHandlers {
  listSessions(caller: Caller): Result<ListSessionsOutput>;
  sendMessage(caller: Caller, args: unknown): Promise<Result<SendMessageOutput>>;
  readInbox(caller: Caller, args: unknown): Promise<Result<ReadInboxOutput>>;
  readAttachment(caller: Caller, args: unknown): Promise<Result<ReadAttachmentOutput>>;
}
export const RATE_LIMIT_PER_MIN = 60;
export const THREAD_AGENT_LIMIT = 20;
export const MAX_BODY_BYTES = 32 * 1024;
export function frameBody(from: Handle, messageId: string, body: string): string;
export function createToolHandlers(deps: ToolDeps): ToolHandlers;
export function toToolCallResult(r: Result<unknown>): ToolCallResult;
```

`list_sessions.roots` = `[home, ...roots]`.

**Framing:**
- An agent body becomes:
  `[conduit message <id> from session <from> (an agent, not the user)]\n<body>\n[end of conduit message <id>]`.
- A body from `you` uses `from the human via Conduit`.

**`toToolCallResult`:**
- `ok` → `{content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value}`.
- An image `ReadAttachmentOutput` → `[{type: 'image', data: base64, mimeType: mime}, {type: 'text', text: <metadata JSON>}]`.
- An error → `isError: true` with `JSON.stringify({error})`.

**Order of `sendMessage` checks:**
1. `messaging_off`.
2. Argument validation (`invalid_argument`).
3. `too_many` (`to` > 10, attachments > 5).
4. `too_large` (body > 32 KB UTF-8, subject > 200 chars).
5. `rate_limited` (caller ≠ you, > 60 in the trailing 60 s).
6. `thread_id` given and the caller is not in `participants` → `not_found`.
7. `thread_limit` (caller ≠ you and `agentCountSinceHuman ≥ 20`; call `onThreadLimit`).
8. Per recipient: `you`→`you` or self → `self_target`; unknown → `unknown_handle`. All refused
   → error with the first recipient's code.
9. Snapshot each attachment against the caller's `DirectoryEntry {home, roots}`. The caller
   `you` with attachments → `invalid_argument` (cut to v1). Any failure refuses the whole send
   with that code and stores nothing. The total exceeding 25 MB → `too_large`.
10. `store.append`. On failure, `store_unavailable` and no `onStored`.
11. `onStored`.

Duplicate handles in `to` are de-duplicated.

**`readInbox`:**
- `limit` is clamped to 1..50, default 20. `unread_only` defaults to `true`.
- A `thread_id` with no message where the caller ∈ `from ∪ to` → `not_found`.
- Returned messages are those where the caller ∈ `to` (and, when `unread_only` is false, where
  the caller is the sender). Order is `sentAt` ascending.
- It marks `read` for the caller on each returned message where the caller ∈ `to`.

**`readAttachment`:**
- The message must exist and have the caller ∈ `from ∪ to`, else `not_found`.
- An unknown attachment id or a missing/expired blob → `not_found`.
- An image mime among png/jpeg/gif/webp ≤ 5 MB → image.
- `text/*`, or `mimeFor` = `text/plain`, → a text page.
- Otherwise `unsupported_media`, with the message carrying `name, mime, bytes`.

The human caller gets no rate limit and no thread limit. A human post resets the agent count (it
is a `msg` with `from: 'you'`).

### `src/conduit-mcp/notice-gate.ts` + `notice-text.ts` (new, node-free) — T3.1

```ts
export const IDLE_QUIET_MS = 3_000;
export const NOTICE_SPACING_MS = 30_000;
export interface GateInput {
  now: number; settleMs: number;
  messagingOn: boolean; paused: boolean; running: boolean;
  spawnedAt: number | undefined; connectionLive: boolean;
  busy: boolean; lastOutputAt: number | undefined;     // SessionActivity's clock (ruling 9)
  screen: ScreenVerdict; hasDraft: boolean; lastNoticeAt: number | undefined;
}
export type GateVerdict = { open: true } | { open: false; reason: GateClosedReason };
export function evaluateGate(i: GateInput): GateVerdict;
// order: off, paused, not-running, settling, no-connection, busy, quiet, blocking-prompt, no-empty-input, draft, spacing
export interface EnterRecheckInput {
  messagingOn: boolean; paused: boolean; running: boolean; sameGeneration: boolean;
  connectionLive: boolean; screen: ScreenVerdict; inputSinceText: boolean;
}
export function evaluateEnterRecheck(i: EnterRecheckInput): GateVerdict;
// order: off, paused, not-running (also !sameGeneration), no-connection, draft (inputSinceText),
//        blocking-prompt (screen 'blocking'), no-echo (screen ≠ 'notice-echoed'); open only on 'notice-echoed' (ruling 3)
// notice-text.ts
export function composeNotice(urgent: boolean): string;
// '[conduit] New messages for you (urgent). Use the conduit read_inbox tool.'  (' (urgent)' only when urgent)
```

`ScreenVerdict` and `GateClosedReason` come from `./types`.

### `src/conduit-mcp/draft-input.ts` (new, node-free) — T3.2

```ts
export function stripTerminalReplies(data: string): string;
// removes: DA1 ESC[?…c, DA2 ESC[>…c, CPR ESC[<r>;<c>R, DECRPM ESC[?…$y, focus ESC[I / ESC[O,
// SGR mouse ESC[<b;x;y(M|m), X10 mouse ESC[M + 3 bytes, OSC replies ESC]…(BEL|ESC\), DCS ESC P…ESC\
// keeps: cursor keys (ESC[A, ESCOA …), everything else
export function nextDraftState(hasDraft: boolean, data: string): boolean;
// r = stripTerminalReplies(data); if r === '' → hasDraft;
// i = last index of '\r' or '\x03' in r; i === -1 → true; i === r.length-1 → false; else → true
export function isCountedInput(data: string): boolean;   // stripTerminalReplies(data) !== ''
export function settleDraft(i: { hasDraft: boolean; screen: ScreenVerdict; now: number; lastInputAt: number | undefined; quietMs: number }): boolean;
// ruling 4: false when screen === 'empty-input' and (lastInputAt === undefined || now - lastInputAt >= quietMs); else hasDraft
```

The host passes `quietMs = IDLE_QUIET_MS`, so this module doesn't import `notice-gate.ts` and
Slice 3's groups stay disjoint. `settleDraft` covers a draft the human erased with backspaces,
or one the CLI consumed without our seeing an Enter.

### `src/conduit-mcp/adapters.ts` + `screen-verdict.ts` (new, node-free) — T3.3

```ts
export type McpAdapterId = 'claude' | 'codex' | 'cursor' | 'fake';
export interface ScreenPatterns { blocking: readonly RegExp[]; emptyInput: readonly RegExp[] }  // emptyInput [] ⇒ never 'empty-input' ⇒ pull-only
export type McpWiringKind = 'mcp-config-flag' | 'codex-c-flags' | 'cursor-global';
export interface McpAdapter {
  id: McpAdapterId;
  leaves: readonly string[];       // commandLeaf() values: claude → ['claude'], codex → ['codex'], cursor → ['agent', 'cursor-agent'], fake → []
  ids: readonly string[];          // agent-definition ids: fake → ['e2e-fake-mcp'], others []
  wiring: McpWiringKind;           // claude, fake → mcp-config-flag; codex → codex-c-flags; cursor → cursor-global
  screen: ScreenPatterns | null;   // null ⇒ pull-only
  e2eOnly: boolean;                // fake only
}
export const MCP_ADAPTERS: readonly McpAdapter[];
export function adapterFor(def: Pick<AgentDefinition, 'id' | 'command'>, opts: { e2e: boolean }): McpAdapter | undefined;
export function notifiable(a: McpAdapter): boolean;   // screen !== null && screen.emptyInput.length > 0
// screen-verdict.ts
export interface ScreenSnapshot { lines: readonly string[]; cursorY: number }   // visible viewport rows
export const NOTICE_ECHO_ROWS = 3;   // cursor row + 2 above (a notice can wrap)
export function screenVerdict(patterns: ScreenPatterns | null, s: ScreenSnapshot, expectNotice?: string): ScreenVerdict;
// null → 'unknown'
// 1 any viewport row matches any blocking → 'blocking'
// 2 expectNotice and the whitespace-stripped concatenation of rows [cursorY-2 … cursorY] contains the whitespace-stripped notice → 'notice-echoed'
// 3 lines[cursorY] matches any emptyInput → 'empty-input'
// 4 else 'unknown'
```

Patterns are declared from the S0 fixtures:
- **`claude`**:
  - blocking `/Esc to cancel/` and `/^\s*❯\s*\d+\.\s/`;
  - empty input `/^\s*❯\s*$/` and `/^\s*❯ Try ".*"\s*$/` (the placeholder).
- **`codex`**: blocking `/enter continue · esc quit/i` (measured trust footer), empty input `[]`.
  That makes it pull-only until runtime QA captures idle/approval in Conduit.
- **`cursor`**: `null`.
- **`fake`**: blocking `/Esc to cancel/`, empty input `/^fake❯\s*$/`.

### `src/pty-writer.ts` (new) — T5.1 (type), T6.1 (writer)

```ts
export type SubmitOutcome = 'submitted' | 'no-pty' | 'write-failed' | 'generation-changed' | 'gate-closed' | 'withheld';
export interface SubmitHooks {
  beforeText?: () => boolean | Promise<boolean>;   // ruling 1: runs inside the session's slot
  beforeEnter?: () => boolean | Promise<boolean>;
}
export interface PtyWriterDeps {
  generation(sessionId: string): number | undefined;
  input(sessionId: string, data: string): boolean;
  sleep(ms: number): Promise<void>;
  gapMs: number;                                   // SUBMIT_GAP_MS (src/timed-messages.ts:97)
}
export interface PtyWriter {
  submit(sessionId: string, text: string, hooks?: SubmitHooks): Promise<SubmitOutcome>;
  forget(sessionId: string): void;
}
export function createPtyWriter(deps: PtyWriterDeps): PtyWriter;
```

Per session, submits run strictly one after another (a promise chain that survives rejection).
Each submit, inside its slot:
1. reads `gen`, else `no-pty`;
2. calls `beforeText?.()`. If false (or it rejects): `gate-closed`, and nothing is written;
3. writes `text`, else `write-failed`;
4. sleeps `gapMs`;
5. checks the generation is the same, else `generation-changed`;
6. calls `beforeEnter?.()`. If false (or it rejects): `withheld`, and no `\r`;
7. writes `\r`, else `write-failed`;
8. returns `submitted`.

`deliverTimedMessage` becomes `(id, msg) => writer.submit(id, msg).then((o) => o === 'submitted')`.

### `electron/session-screens.ts` (new) — T6.2

```ts
export interface SessionScreens {
  start(sessionId: string, cols: number, rows: number): void;   // (re)creates; disposes a previous one
  feed(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  dispose(sessionId: string): void;
  snapshot(sessionId: string): Promise<ScreenSnapshot | undefined>;   // awaits pending writes; visible viewport of buffer.active, trimEnd'ed; cursorY relative to the viewport
  has(sessionId: string): boolean;
}
export function createSessionScreens(opts?: { scrollback?: number }): SessionScreens;   // scrollback default 0
```

It uses `new Terminal({cols, rows, allowProposedApi: true, scrollback})` from `@xterm/headless`.

### `src/mcp-launch.ts` (new, node-free) + `src/launch-args.ts` (modified) — T8.1

```ts
// launch-args.ts — new export, used by launchArgsFor and mcp-launch
export function batchGuarded(platform: HostPlatform, resolvedCommand: string | undefined): boolean;
// mcp-launch.ts
export interface McpServerCommand { command: string; args: string[]; env: Record<string, string> }
export type McpLaunchWiring =
  | { ok: true; args: string[]; configJson: string | null }
  | { ok: false; reason: Extract<McpUnavailableReason, 'cmd-metachar' | 'unquotable-path'> };
export function mcpServerCommand(execPath: string, shimPath: string, endpoint: string): McpServerCommand;
// { command: execPath, args: [shimPath, '--endpoint', endpoint], env: { ELECTRON_RUN_AS_NODE: '1' } }
export function mcpLaunchWiring(i: {
  adapter: McpAdapter; platform: HostPlatform; resolvedCommand: string | undefined;
  server: McpServerCommand; configFile: string;
}): McpLaunchWiring;
```

Per wiring kind:
- `mcp-config-flag` → `args = ['--mcp-config', configFile]`, and
  `configJson = JSON.stringify({mcpServers: {conduit: {type: 'stdio', command, args, env}}})`.
- `codex-c-flags` → five `-c` pairs, each value a TOML literal string `'…'`:
  - `mcp_servers.conduit.command='<exe>'`
  - `mcp_servers.conduit.args=['<shim>','--endpoint','<endpoint>']`
  - `mcp_servers.conduit.env={ELECTRON_RUN_AS_NODE='1'}`
  - `mcp_servers.conduit.env_vars=['CONDUIT_SESSION_TOKEN']`
  - `mcp_servers.conduit.default_tools_approval_mode='auto'`
  - A value containing `'` or a newline → `unquotable-path`.
- `cursor-global` → `{ok: true, args: [], configJson: null}`.
- The guard: `batchGuarded(...)` and `firstCmdMetachar` matching any returned arg →
  `cmd-metachar`.

`McpUnavailableReason` comes from `./conduit-mcp/types`.

### `src/conduit-mcp/notifier.ts` (new, node-free) — T5.1

```ts
export type AttentionRaise =
  | { kind: 'urgent-waiting'; handle: Handle; messageId: string }
  | { kind: 'unsent-notice'; handle: Handle }
  | { kind: 'unread-after-renotice'; handle: Handle; messageId: string };
export interface NotifierSession { sessionId: string; handle: Handle; busy: boolean }
export interface NotifierDeps {
  sessions(): NotifierSession[];                            // notifiable adapters only
  pending(handle: Handle): StoredMessage[];                 // store.pending
  precheck(sessionId: string): Promise<GateVerdict>;        // decides whether to TRY (ruling 1)
  submit(sessionId: string, text: string): Promise<SubmitOutcome>;   // writer with beforeText = full gate, beforeEnter = recheck
  markNoticed(handle: Handle, messageIds: string[]): Promise<void>;
  raise(item: AttentionRaise): void;
}
export interface Notifier { tick(): Promise<void>; forget(sessionId: string): void }
export function createNotifier(deps: NotifierDeps, opts: { rearmAll: boolean }): Notifier;
```

Per session, per tick:
- One tick runs at a time per session. A session in flight is skipped.
- **Due** = pending `normal`/`urgent` messages that are `queued`, or that are armed.
- **Arming:** on a busy→idle edge (tracked from `busy`):
  - every `noticed` message with `noticeCount === 1` becomes armed;
  - every `noticed` message with `noticeCount ≥ 2` raises `unread-after-renotice` once and is
    never due again;
  - at construction with `rearmAll`, every `noticed` pending message is armed (restart).
- **Due is non-empty:**
  - `precheck` open → `submit(composeNotice(pending.some(urgent)))`.
    - `submitted` → `markNoticed` for **all** pending ids, fyi included, and disarm them.
    - `withheld` → `raise({kind: 'unsent-notice'})`.
    - `gate-closed`, `generation-changed`, `no-pty` and `write-failed` change nothing; they stay
      due.
  - `precheck` closed → each due `urgent` id not yet raised → `raise({kind: 'urgent-waiting'})`.
- `fyi` alone is never due.

### `src/conduit-mcp/attention-items.ts` (new, node-free) — T5.2

```ts
export type AttentionEvent =
  | { t: 'raise'; raise: AttentionRaise; sessionId: string | null; threadId: string | null; at: string }
  | { t: 'thread-limit'; threadId: string; handle: Handle; at: string }
  | { t: 'status'; messageId: string; handle: Handle; status: RecipientStatus }   // noticed/read/undelivered/expired
  | { t: 'thread-reset'; threadId: string }                                        // allowMore or a you-post
  | { t: 'notice-submitted'; handle: Handle }
  | { t: 'renderer-input'; handle: Handle }
  | { t: 'session-gone'; handle: Handle };
export function reduceAttention(items: readonly McpAttentionItem[], e: AttentionEvent): McpAttentionItem[];
export function youAttention(threads: readonly ThreadSummary[], now: string): McpAttentionItem[];   // one 'message-to-you' per thread with you ∈ unreadFor
export function attentionItemId(reason: McpAttentionReason, handle: Handle, ref: string | null): string;
```

`AttentionRaise` comes from `./notifier`; both files are node-free.

Clearing rules:
- `urgent-waiting` clears on `status` `noticed` or `read` for that message.
- `thread-paused` (from `thread-limit`) clears on `thread-reset`.
- `unsent-notice` clears on `notice-submitted` or `renderer-input` for that handle.
- `unread-after-renotice` clears on `status` `read`.
- `session-gone` drops every item for that handle.
- A `raise` whose id already exists is a no-op (the "once" guarantee).

### `src/conduit-mcp/ui-types.ts` (new, node-free; imports only `./types`) — T9.1

```ts
export type McpGateState = 'open' | 'pull-only' | GateClosedReason;
export interface McpSessionBadge {
  handle: Handle; unread: number; urgent: number; paused: boolean;
  unavailable: McpUnavailableReason | null; connected: boolean;
  gate: McpGateState | null;                       // ruling 4; null when messaging is unavailable
}
export interface McpThreadSummary extends ThreadSummary { paused: boolean; unreadForYou: boolean }
export interface McpThreadMessage extends StoredMessage { attachmentsExpired: boolean }
export interface McpThreadView { threadId: string; paused: boolean; messages: McpThreadMessage[] }
export interface McpUiState {
  enabled: boolean; storeError: string | null; loading: boolean;
  sessions: Record<string, McpSessionBadge>;       // by sessionId
  threads: McpThreadSummary[];                     // newest 500
  attention: McpAttentionItem[];
  youUnread: number; youUrgent: number;
}
export type McpSendResult = Result<SendMessageOutput>;
export interface McpAttachmentPayload { name: string; mime: string; bytes: number; base64: string }
```

### `src/protocol.ts` (claimed) — T9.1, T12.2

```ts
// HostToWebview
| { type: 'mcp:state'; state: McpUiState }
| { type: 'mcp:thread'; requestId: number; thread: McpThreadView | null }
| { type: 'mcp:sent'; requestId: number; result: McpSendResult }
| { type: 'mcp:attachment'; requestId: number; result: { ok: true; value: McpAttachmentPayload } | { ok: false; error: ToolErrorCode } }
| { type: 'mcp:cursor'; requestId: number; status: CursorLinkStatus }              // T12.2
// WebviewToHost
| { type: 'mcp:compose'; requestId: number; to: Handle[]; subject?: string; body: string; priority: Priority; kind: MessageKind; threadId?: string }
| { type: 'mcp:thread:get'; requestId: number; threadId: string }
| { type: 'mcp:markRead'; messageIds: string[] }
| { type: 'mcp:allowMore'; threadId: string }
| { type: 'mcp:pause'; sessionId: string; paused: boolean }
| { type: 'mcp:attachment:get'; requestId: number; messageId: string; attachmentId: string }
| { type: 'mcp:retry' }
| { type: 'mcp:cursor'; requestId: number; action: 'status' | 'connect' | 'disconnect' }   // T12.2
```

The UI reads threads and attachments without a participation filter: the human participates in
every thread (see Decisions).

### `src/types.ts`, `src/settings.ts`, `src/session-manager.ts`, `src/session-activity.ts` (T9.1)

- `Session` gains two persisted fields:
  - `mcpHandle?: string` — assigned at the first launch with an adapter, never reused;
  - `mcpNoticesPaused?: boolean`.
  - Both round-trip through `serializeSessions`/`parseSessions`; T9.1 asserts this in
    `test/unit/persistence.test.ts`.
- `AppSettings.conduitMcp: boolean`, with `DEFAULT_SETTINGS.conduitMcp = true` and
  `coerceSettings` → `bool(payload.conduitMcp, DEFAULT_SETTINGS.conduitMcp)`.
- `RightPaneTab = 'changes' | 'files' | 'messages'`, plus `RIGHT_PANE_TABS` and its persisted
  validation (`src/settings.ts:40,275,491`).
- `SessionManager.setMcp(id: string, patch: Partial<Pick<Session, 'mcpHandle' | 'mcpNoticesPaused'>>): boolean`
  emits change, so sessions.json persists. `duplicate` (`src/session-manager.ts:137-146`)
  builds a fresh session, so it carries no `mcpHandle`; that is asserted.
- `SessionActivity.lastOutputAt(id: string): number | undefined` (ruling 9) returns the private
  entry's `lastOutputAt` (`src/session-activity.ts:62`).

### `src/conduit-mcp/endpoint-path.ts` + `electron/conduit-mcp-endpoint.ts` (new) — T7.1

```ts
export function endpointPath(userData: string, platform: 'win32' | 'posix', tmpdir: string): string;
// h = sha256(platform === 'win32' ? userData.toLowerCase() : userData).hex.slice(0, 16)
// win32 → `\\\\.\\pipe\\conduit-mcp-${h}`; posix → `${userData}/conduit-mcp/mcp.sock`, or `${tmpdir}/conduit-mcp-${h}.sock` when that exceeds 100 bytes
export const HELLO_MAX_BYTES = 4096;
export const INBOUND_LINE_MAX_BYTES = 4 * 1024 * 1024;
export interface EndpointConnection {
  readonly id: number;
  readonly token: string | null;              // from the hello line; null when absent/blank
  send(line: string): void;                   // appends '\n'
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
export interface McpEndpoint { listen(): Promise<Result<void>>; close(): Promise<void> }
export function createMcpEndpoint(opts: {
  path: string; onConnection(conn: EndpointConnection): void; log: Pick<Logger, 'debug' | 'warn'>;
}): McpEndpoint;
```

- The hello is the first line, `{"conduit":1,"token":"<hex>"|null}`.
- A malformed hello or one over `HELLO_MAX_BYTES` closes the socket.
- An inbound line over `INBOUND_LINE_MAX_BYTES` closes the connection.
- On posix, `listen` unlinks a stale socket file first.
- `EADDRINUSE` on win32 → `{ok: false, error: host_unavailable}`. The host then marks every
  launch `endpoint-down`.

### Shim — `resources/conduit-mcp/conduit-mcp-shim.cjs` (new) — T7.2

`node <shim> --endpoint <path>`:
- It reads `process.env.CONDUIT_SESSION_TOKEN`.
- It connects and writes the hello. Then it pipes stdin→socket and socket→stdout byte for byte.
  Stdin bytes that arrive before the connect are buffered and flushed after the hello.
- If the connection fails or closes, it switches to fallback: it parses the remaining stdin
  lines and answers each request with an `id`:
  - `initialize` → `{protocolVersion: <echo>, capabilities: {tools: {}}, serverInfo: {name: 'conduit'}}`;
  - `tools/list` → `{tools: []}`;
  - `tools/call` → `isError` text `{"error":{"code":"host_unavailable",…,"retryable":true}}`;
  - anything else → JSON-RPC `-32601`.
- It exits 0 on stdin end.
- It has no `require` except `node:net`.

### `electron/conduit-mcp-host.ts` (new, IO composition) — T9.2

```ts
export interface ConduitMcpHostDeps {
  dir: string;                                   // userData/conduit-mcp
  endpointPath: string; execPath: string; shimPath: string; platform: HostPlatform; e2e: boolean;
  mgr: Pick<SessionManager, 'get' | 'list' | 'setMcp'>;
  pty: Pick<PtyHost, 'isAlive' | 'generation' | 'size'>;
  writer: PtyWriter;
  activity: Pick<SessionActivity, 'statusOf' | 'lastOutputAt'>;
  messagingOn(): boolean;
  projectName(projectId: string | undefined): string | null;
  broadcast(msg: HostToWebview): void;
  log: Pick<Logger, 'debug' | 'warn' | 'error'>;
  // tests only
  now?: () => number; randomToken?: () => string; storeIo?: StoreIo; screens?: SessionScreens; listen?: boolean; tickMs?: number;
}
export interface ConduitMcpHost {
  start(): Promise<void>;    // sweep <dir>/launch/*, store.load, enforceRetention, listen, then tick (500 ms) + retention (6 h) timers
  prepareLaunch(sessionId: string, def: AgentDefinition, spec: SpawnSpec): SpawnSpec;
  onSpawn(sessionId: string, cols: number, rows: number): void;
  onOutput(sessionId: string, data: string): void;      // screens.feed only (the clock is SessionActivity's)
  onResize(sessionId: string, cols: number, rows: number): void;
  onExit(sessionId: string): void;               // registry.revoke + close its connections, delete launch config, screens.dispose
  onRendererInput(sessionId: string, data: string): void;
  onSessionDeleted(sessionId: string): Promise<void>;   // unread → undelivered; notifier.forget; writer.forget; attention session-gone
  refresh(): void;                               // settings changed → rebroadcast
  uiState(): McpUiState;
  handleRenderer(m: Extract<WebviewToHost, { type: `mcp:${string}` }>, reply: (msg: HostToWebview) => void): Promise<void>;
  tick(): Promise<void>;                         // exposed for tests
  stop(): Promise<void>;
}
export function createConduitMcpHost(deps: ConduitMcpHostDeps): ConduitMcpHost;
```

The host owns IO only. All decisions are delegated to `session-registry`, `notice-gate`,
`draft-input`, `screen-verdict`, `notifier`, `attention-items` and `tools`.

**`prepareLaunch`:**
1. `adapter = adapterFor(def, {e2e})`. With no adapter, return `spec` unchanged.
2. `assignHandle({current: session.mcpHandle, prefix: adapter.id, takenByOthers, counters})`.
   When `allocated`, write `<dir>/handles.json` with `atomicWriteFileSync` **first**, then call
   `mgr.setMcp(id, {mcpHandle})` (ruling 10).
3. If messaging is off → `unavailable: 'messaging-off'`, return `spec`.
4. If the endpoint is down → `endpoint-down`, return `spec`.
5. Run `mcpLaunchWiring`. If `!ok` → record the reason, return `spec` unchanged (no token).
6. Otherwise `registry.mint(sessionId, token)`, write `configJson` to
   `<dir>/launch/<sessionId>.json` when present, and return
   `{...spec, args: [...spec.args, ...wiring.args], env: {...spec.env, CONDUIT_SESSION_TOKEN: token}}`.

`ELECTRON_RUN_AS_NODE` never appears in the returned `env`.

**Connections:**
- `registry.resolve(conn.token)` → a sessionId gives caller `{handle, sessionId}`.
  `registry.connect(conn.id, sessionId)` runs after `initialize`.
- Without a valid token, `tools()` is `[]` and `call` → `not_in_session`.
- With messaging off, `call` → `messaging_off`.

**Per-session runtime state** (in the host): `spawnedAt`, `hasDraft`, `inputSeq`, `lastInputAt`,
`lastNoticeAt`, and the last gate state for the badge.

**Gate inputs** (`precheck` and `beforeText`, which are identical):
- `running`: `pty.isAlive`.
- `spawnedAt`. `settleMs`: `PTY_SETTLE_MS` (`src/timed-messages.ts:95`).
- `connectionLive`: `registry.isLive`.
- `busy`: `activity.statusOf(id).busy`. `lastOutputAt`: `activity.lastOutputAt(id)`.
- `screen`: `screenVerdict(adapter.screen, await screens.snapshot(id))`.
- `hasDraft`: `settleDraft({hasDraft, screen, now, lastInputAt, quietMs: IDLE_QUIET_MS})`, and
  a `false` result is written back.
- `paused`: `session.mcpNoticesPaused`. `lastNoticeAt`.

**`beforeEnter`:** `evaluateEnterRecheck` with `sameGeneration`, `inputSinceText` (`inputSeq`
changed since `beforeText`), and `screen = screenVerdict(adapter.screen, snapshot, noticeText)`.

**`onRendererInput`:** if `isCountedInput(data)`, then `inputSeq++`, `lastInputAt = now`, and
`hasDraft = nextDraftState(hasDraft, data)`. It feeds the attention reducer
`{t: 'renderer-input'}`.

**Attention:** every notifier `raise`, store change (`status`, `thread-reset`) and tool
`onThreadLimit` becomes an `AttentionEvent` through `reduceAttention`. `mcp:state.attention` is
`[...reduced, ...youAttention(store.threads())]`.

**Renderer handlers:**
- `mcp:compose` → `tools.sendMessage({handle: 'you', sessionId: null}, args)`, then `mcp:sent`.
- `mcp:attachment:get` → `mcp:attachment` (base64).
- `mcp:markRead` marks `you` read.
- `mcp:allowMore` → `store.allowMore`.
- `mcp:pause` → `mgr.setMcp(id, {mcpNoticesPaused})`.
- `mcp:retry` → `store.load()` **only when `!store.available()`** (ruling 2); otherwise it
  rebroadcasts.

`mcp:state` is broadcast coalesced at 150 ms after any store, connection, attention, gate-state,
pause or `refresh` change.

### `src/attention.ts` (modified) — T10.4

```ts
export interface AttentionEntry { key: string; kind: 'session' | 'message'; sessionId: string | null; threadId: string | null; reason: McpAttentionReason | null; handle: Handle | null }
export function attentionEntries<T extends SessionStateFields & { id: string }>(
  sessions: readonly T[], items: readonly McpAttentionItem[], snoozed: SnoozeMap, now: number,
): AttentionEntry[];   // session entries first (existing order), then items whose sessionId is not snoozed, by `at`
```

`attentionChipLabel(count)` is unchanged and gets `entries.length`.

### `src/conduit-mcp/cursor-config.ts` (new, node-free) + `electron/cursor-mcp-link.ts` (new) — T12.1, T12.2 (conditional)

```ts
export const CURSOR_SERVER_NAME = 'conduit';
export const SHIM_FILE_NAME = 'conduit-mcp-shim.cjs';
export interface CursorEntry { command: string; args: string[]; env: Record<string, string> }
export function cursorEntry(server: McpServerCommand): CursorEntry;   // env adds CONDUIT_SESSION_TOKEN: '${env:CONDUIT_SESSION_TOKEN}'
export type CursorEditResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: 'invalid-json' | 'not-object' | 'foreign-entry' };
export function connectCursorConfig(existing: string | undefined, entry: CursorEntry): CursorEditResult;
export function disconnectCursorConfig(existing: string | undefined): CursorEditResult;
export function cursorLinkState(existing: string | undefined, entry: CursorEntry): 'connected' | 'disconnected' | 'stale';
export type CursorLinkStatus = { state: 'connected' | 'disconnected' | 'stale' } | { state: 'error'; message: string };
// "ours" ⇔ mcpServers.conduit.args includes a path whose basename is SHIM_FILE_NAME; foreign → never overwritten/removed
// electron/cursor-mcp-link.ts
export interface CursorMcpLink { status(): Promise<CursorLinkStatus>; connect(): Promise<CursorLinkStatus>; disconnect(): Promise<CursorLinkStatus> }
export function createCursorMcpLink(deps: { homeDir: string; entry: CursorEntry; now(): Date; log: Pick<Logger, 'warn'> }): CursorMcpLink;
// file = <homeDir>/.cursor/mcp.json; before any write: copy to mcp.json.conduit-backup-<YYYYMMDDHHmmss> (when present); write via atomicWriteFileSync; mkdir .cursor if absent
```

`homeDir` = `process.env.CONDUIT_HOME || os.homedir()`, the `electron/skills-service.ts:26-30`
seam.

### Renderer modules (T10.x)

```ts
// webview/conduit-mcp-strings.ts
export const MCP_STR: {
  tab: 'Messages'; firstRun: string; noUnread: 'No unread messages'; showAll: 'Show all';
  loadError: 'Messages couldn’t be loaded'; retry: 'Retry'; off: 'Messaging is turned off'; openSettings: 'Open Settings';
  newMessage: 'New message'; reply: 'Reply'; allowMore: 'Allow 20 more'; paused: (n: number) => string;
  attachmentExpired: 'Attachment expired'; send: 'Send'; openAttachment: 'Open attachment';
  unread: (n: number) => string; urgentBadge: (n: number) => string;
  status: Record<RecipientStatus, string>; priority: Record<Priority, string>; kind: Record<MessageKind, string>;
  unavailable: Record<McpUnavailableReason, string>;     // "Messaging unavailable: …"
  gate: Record<McpGateState, string>;                     // ruling 4: "Notices held: busy", "Notices held: prompt on screen", …
  attention: Record<McpAttentionReason, (handle: string) => string>;  // 'urgent-waiting' → `urgent message waiting for ${h}`, 'unsent-notice' → `a notice was left unsent in ${h}`
  pauseNotices: (h: string) => string; resumeNotices: (h: string) => string; openMessages: 'Open messages';
  newMessages: (n: number) => string;                     // live region "3 new messages"
  copyBody: 'Copy body'; copyId: 'Copy message id'; markRead: 'Mark read';
  settingsTitle: 'Agent messaging'; settingsDesc: string; cursorConnect: 'Connect Cursor'; cursorDisconnect: 'Disconnect';
  cursorState: Record<'connected' | 'disconnected' | 'stale', string>;
}
// webview/conduit-mcp-view-model.ts (pure)
export interface ThreadFilter { unreadOnly: boolean; handle: Handle | null }
export function visibleThreads(threads: readonly McpThreadSummary[], f: ThreadFilter): McpThreadSummary[];
export function threadAccessibleName(t: McpThreadSummary): string;   // includes unread + priority words
export function newMessageCount(prev: McpUiState | null, next: McpUiState): number;
export function tabBadge(state: McpUiState): { count: number; urgent: boolean } | null;
export function composeTargets(sessions: readonly Session[], state: McpUiState): Array<{ handle: Handle; label: string }>; // 'you' excluded, handled sessions only
// webview/use-conduit-mcp.ts
export interface ConduitMcpApi {
  state: McpUiState | null;
  getThread(threadId: string): Promise<McpThreadView | null>;
  send(req: Omit<Extract<WebviewToHost, { type: 'mcp:compose' }>, 'type' | 'requestId'>): Promise<McpSendResult | null>;
  getAttachment(messageId: string, attachmentId: string): Promise<McpAttachmentPayload | ToolErrorCode | null>;
  markRead(ids: string[]): void; allowMore(threadId: string): void; pause(sessionId: string, paused: boolean): void; retry(): void;
}
export function useConduitMcp(): ConduitMcpApi;   // subscribe(), filter 'mcp:state'; requests via requestHost (10 s timeout)
// webview/components/message-compose.tsx
export interface MessageComposeProps { api: ConduitMcpApi; targets: Array<{ handle: Handle; label: string }>; replyTo: { threadId: string; to: Handle[] } | null; onDone(): void }
export function MessageCompose(p: MessageComposeProps): JSX.Element;
// webview/components/attachment-view-modal.tsx
export interface AttachmentViewModalProps { api: ConduitMcpApi; messageId: string; attachment: AttachmentRecord; onClose(): void }
export function AttachmentViewModal(p: AttachmentViewModalProps): JSX.Element;   // ModalLayer; text in <pre>, image via data: URL, else metadata
// webview/components/message-thread.tsx
export interface MessageThreadProps { api: ConduitMcpApi; threadId: string; onReply(r: { threadId: string; to: Handle[] }): void }
export function MessageThread(p: MessageThreadProps): JSX.Element;
// webview/components/messages-pane.tsx
export interface MessagesPaneProps { api: ConduitMcpApi; sessions: readonly Session[]; filterHandle: Handle | null; onClearFilter(): void; onOpenSettings(): void; initialThreadId: string | null }
export function MessagesPane(p: MessagesPaneProps): JSX.Element;
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Host-originated PTY input | timed messages (`TimerScheduler.deliver`), **new** notifier | `PtyHost.input` → CLI | Both: one `ptyWriter` (T6.1, T9.2). The gate runs in the writer slot (ruling 1) |
| Renderer PTY input | `terminal-pane.tsx:923` `term:input` | `pty.input` + **new** draft reducer | Consumer only. The producer is unchanged, and the reducer observes it. Auto-replies come from the same `term.onData`, which is why `stripTerminalReplies` exists |
| PTY env for the token | **new** `prepareLaunch` | CLI → MCP child (claude), `env_vars` (codex), interpolation (cursor) | Both. `sanitizeChildEnv` strips an inherited token (T8.2) |
| Launch args | `buildLaunchSpec` (`src/launch-spec.ts:31-47`) + **new** `prepareLaunch` | `pty.start` (`main.ts:4108`) | Host side only. `src/launch-preview.ts:37` / `webview/bridge.ts:866` keep calling `buildLaunchSpec` without MCP args. That is measured: the preview shows user-configured args, and MCP args are host-generated per launch |
| PTY output | `PtyHost` onData → main send cb (`main.ts:1520`) | existing scanners + **new** `onOutput` (screens) | Consumer added. The producer is unchanged |
| Output clock / busy | `SessionActivity` (`main.ts:1301`, fed at `:1538`) | **new** gate, `list_sessions` | Consumer plus one read accessor (T9.1). The heuristic is unchanged (spec §3.5 flag) |
| Session handle and pause | **new** `prepareLaunch` / `mcp:pause` via `mgr.setMcp`, plus `handles.json` | sessions.json, cards, tools | Both. Counter first, then handle (ruling 10) |
| Message store | `tools.sendMessage` (agents, `you`) | MCP reads, `mcp:state`, notifier | Both. One IO queue (ruling 2) |
| Attention | `SessionActivity` (boolean) + **new** `reduceAttention` items | `top-bar.tsx` chip via `attentionEntries` | Both |
| Right-pane tab id | `RightPaneTab` (`src/settings.ts:40`) | `right-pane.tsx`, the persisted `rightPaneTab` | Both. `RIGHT_PANE_TABS` validation accepts `'messages'` |
| Settings `conduitMcp` | settings modal → `updateSettings` | host `messagingOn()`, `prepareLaunch`, tools | Both. `main.ts:3555` calls `mcpHost.refresh()` |
| `deliverTimedMessage` signature | `main.ts:1670` | `TimerScheduler` deps (`main.ts:1686`), the only call site | Both. The signature `(id, msg) => Promise<boolean>` is unchanged; no hooks are passed |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/json-rpc.ts` | create | Minimal MCP JSON-RPC server core |
| `src/conduit-mcp/tool-schemas.ts` | create | Four tool schemas + server instructions |
| `src/conduit-mcp/types.ts` | create | Domain types, all wire types, error codes, log records |
| `src/conduit-mcp/store.ts` | create | Append-only log, recipient state, blobs, age retention, one IO queue |
| `src/conduit-mcp/store-fs.ts` | create | Node `StoreIo` over `<dir>/messages.log` + `blobs/` |
| `src/conduit-mcp/notice-gate.ts` | create | `evaluateGate`, `evaluateEnterRecheck` |
| `src/conduit-mcp/notice-text.ts` | create | `composeNotice` |
| `src/conduit-mcp/draft-input.ts` | create | Auto-reply stripping, draft reducer, `settleDraft` |
| `src/conduit-mcp/adapters.ts` | create | Adapter declarations and matching |
| `src/conduit-mcp/screen-verdict.ts` | create | Viewport blocking / cursor-row empty-input / echo verdict |
| `src/conduit-mcp/handles.ts` | create | Handle slug + counter allocation |
| `src/conduit-mcp/attachments.ts` | create | Snapshot + confinement + mime + text paging |
| `src/conduit-mcp/tools.ts` | create | Four tool handlers, framing, MCP result mapping |
| `src/conduit-mcp/notifier.ts` | create | Notice scheduling state machine |
| `src/conduit-mcp/attention-items.ts` | create | Attention reducer |
| `src/conduit-mcp/session-registry.ts` | create | Token↔session, live connections, handle assignment |
| `src/conduit-mcp/endpoint-path.ts` | create | userData-hash endpoint path |
| `src/conduit-mcp/ui-types.ts` | create | Renderer aggregates (imports only `./types`) |
| `src/conduit-mcp/cursor-config.ts` | create (conditional) | Pure `~/.cursor/mcp.json` edit |
| `src/pty-writer.ts` | create | Serialized per-session host writer with gate hooks |
| `src/mcp-launch.ts` | create | Per-CLI MCP launch wiring |
| `src/launch-args.ts` | modify | Extract `batchGuarded` |
| `src/pty-host.ts` | modify | `sanitizeChildEnv` strips `CONDUIT_SESSION_TOKEN` |
| `src/session-activity.ts` | modify | `lastOutputAt(id)` accessor |
| `src/types.ts` | modify (claim) | `Session.mcpHandle`, `mcpNoticesPaused` |
| `src/settings.ts` | modify (claim) | `conduitMcp` setting, `'messages'` tab |
| `src/session-manager.ts` | modify | `setMcp` |
| `src/protocol.ts` | modify (claim) | `mcp:*` messages |
| `src/attention.ts` | modify | `attentionEntries` |
| `electron/session-screens.ts` | create | Headless screen models |
| `electron/conduit-mcp-endpoint.ts` | create | Pipe/socket server + hello |
| `electron/conduit-mcp-host.ts` | create | IO composition |
| `electron/cursor-mcp-link.ts` | create (conditional) | Backup + write `~/.cursor/mcp.json` |
| `electron/main.ts` | modify (claim) | Writer refactor, host construction, event forwarding, `mcp:*` cases |
| `resources/conduit-mcp/conduit-mcp-shim.cjs` | create | Stdio↔endpoint relay + host-unavailable fallback |
| `package.json` | modify (claim) | `@xterm/headless` → dependencies; extraResources `resources/conduit-mcp` |
| `package-lock.json` | modify (claim) | Drop `dev: true` for `@xterm/headless`; root deps move |
| `.fallowrc.json` | modify (claim) | Shim as an entry |
| `webview/conduit-mcp-strings.ts` | create | `MCP_STR` |
| `webview/conduit-mcp-view-model.ts` | create | Pure list/badge/announce helpers |
| `webview/use-conduit-mcp.ts` | create | State subscription + requests |
| `webview/components/messages-pane.tsx` | create | Tab body: list, states, live region |
| `webview/components/message-thread.tsx` | create | Thread view, attachment chips, allow more |
| `webview/components/message-compose.tsx` | create | Compose as `you` (no attachments, v1) |
| `webview/components/attachment-view-modal.tsx` | create | Open attachment (text/image/metadata) |
| `webview/components/right-pane.tsx` | modify (claim) | Messages tab + badge |
| `webview/components/session-card.tsx` | modify | MCP badge, pause glyph, gate reason, unavailable tooltip |
| `webview/components/sidebar.tsx` | modify | Pass `mcpBadges` to cards |
| `webview/components/top-bar.tsx` | modify | Chip from `attentionEntries`, reason title |
| `webview/components/settings-modal.tsx` | modify (claim) | Messaging toggle; Cursor connect (T12.2) |
| `webview/app.tsx` | modify (claim) | Wiring: card menu items, chip → thread, pane filter |
| `webview/bridge.ts` | modify (claim) | Fake shell answers `mcp:*` |
| `webview/styles.css` | modify (claim) | `mcpmsg*`, `session__mcp*` |
| `test/helpers/test-endpoint.ts` | create | Per-platform test endpoint name |
| `test/unit/fixtures/conduit-mcp/screens/*.json` | exists (S0, `214b4439`) | Captured screens |
| `test/e2e/fixtures/fake-mcp-agent.mjs` | create | Fake MCP-capable CLI |
| `test/e2e/conduit-mcp-helpers.mjs` | create | Launch with fake agents, record parsing |
| `test/e2e/conduit-mcp-notify.e2e.mjs` | create | Send → notice → read + attachment snapshot |
| `test/e2e/conduit-mcp-gate.e2e.mjs` | create | Busy / prompt / draft hold notices; idle stays quiet |
| `test/e2e/conduit-mcp-refusals.e2e.mjs` | create | Confinement, participation, token, off, loop guard |
| `test/e2e/conduit-mcp-compose.e2e.mjs` | create | Messages tab, compose, badges, pause, chip |
| `test/e2e/conduit-mcp-restart.e2e.mjs` | create | Persistence + re-arm after relaunch |
| `test/e2e/conduit-mcp-cursor-link.e2e.mjs` | create (conditional) | Connect/Disconnect Cursor with backup |
| `CHANGELOG.md` | modify (claim) | `[Unreleased]` entry |

Unit tests, all new unless noted:
- `test/unit/` (core): `conduit-mcp-json-rpc`, `conduit-mcp-store`, `conduit-mcp-retention`,
  `conduit-mcp-notice-gate`, `conduit-mcp-draft-input`, `conduit-mcp-adapters`,
  `conduit-mcp-handles`, `conduit-mcp-attachments`, `conduit-mcp-tools`, `conduit-mcp-notifier`,
  `conduit-mcp-attention-items`, `conduit-mcp-session-registry`;
- `test/unit/` (host and launch): `conduit-mcp-endpoint`, `conduit-mcp-shim`, `pty-writer`,
  `session-screens`, `mcp-launch`, `conduit-mcp-host`;
- `test/unit/` (renderer): `conduit-mcp-view-model`, `message-compose.test.tsx`,
  `messages-pane.test.tsx`;
- conditional: `conduit-mcp-cursor-config`, `cursor-mcp-link`;
- modified: `launch-args.test.ts`, `sanitize-child-env.test.ts`, `persistence.test.ts`,
  `session-manager.test.ts`, `settings.test.ts`, `session-activity.test.ts` (`lastOutputAt`),
  `attention.test.ts`, `session-card.test.ts`.

## Scripts

- The one-off S0 capture script (`%TEMP%\claude-scratch\capture-cli-screens.mjs`) was used and
  deleted in T0.1 (`214b4439`). Runtime QA reuses the same approach if it captures Codex screens
  later.
- Pattern rows, gate rows, draft rows and attention rows are **table-driven inside their test
  files**. No generator.
- `SCRIPT_CANDIDATES: 1` (the S0 capture script, done).

## Slices

The MVP is Slices 0–11, in order. **Slice 12 (Cursor) is conditional:** it is built only after
S0–S11 are verified (ruling 7). Inside a slice the listed groups are file-disjoint, checked
against each task's `Files:`. Across slices the lane is serial.

### Slice 0: Measure the remaining prompt screens — DONE (`214b4439`)

**Check (met):** these exist and are sanitized:
- `test/unit/fixtures/conduit-mcp/screens/claude-idle.json`, `claude-idle-placeholder.json`,
  `claude-permission.json`, `claude-trust.json`;
- `docs/runs/2026-10-25-conduit-mcp/s0-screens.md`.

**Parallel groups:** Serial: T0.1
**Claims (serial lane):** none

#### Task 0.1: capture screens — DONE

Outcome (`s0-screens.md`):
- Claude's idle and blocking screens are distinguishable.
- Notice-as-turn was measured.
- The cursor-anchored region misses the permission dialog. That was the reason for the
  viewport-wide blocking match.
- Codex idle/approval were not captured, so Codex is pull-only.

### Slice 1: MCP JSON-RPC core (pure)

**Check:** `npx vitest run test/unit/conduit-mcp-json-rpc.test.ts` passes, and
`npm run verify:quick` is green.

**Parallel groups:** Serial: T1.1
**Claims (serial lane):** none

#### Task 1.1: JSON-RPC core + tool schemas

**Files:**
- Create: `src/conduit-mcp/json-rpc.ts`, `src/conduit-mcp/tool-schemas.ts`.
- Test: `test/unit/conduit-mcp-json-rpc.test.ts`.

**Interfaces:**
- Produces: `SUPPORTED_PROTOCOL_VERSIONS`, `JsonRpcId`, `ToolContent`, `ToolCallResult`,
  `ToolSchema`, `McpServerCoreDeps`, `McpServerCore`, `createMcpServerCore`,
  `negotiateProtocolVersion`, `CONDUIT_TOOLS`, `CONDUIT_INSTRUCTIONS` (Contracts).
- Consumes: none.

**Steps:**
- [ ] Failing tests:
  - 'initialize echoes a supported protocolVersion' — key assertion: `result.protocolVersion === '2025-06-18'` for that request.
  - 'initialize answers the newest supported for an unknown version' — key assertion: `=== SUPPORTED_PROTOCOL_VERSIONS[0]`.
  - 'server/discover gets method-not-found with its id' — key assertion: `{id: 7, error: {code: -32601}}`.
  - 'notifications get no reply' — key assertion: `handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')` resolves `undefined`.
  - 'tools/list returns deps.tools()', and 'tools/list is empty when deps.tools() is empty'.
  - 'tools/call forwards name and arguments (default {})'.
  - 'parse error → -32700 id null'.
  - 'batch array → -32600'.
  - 'CONDUIT_TOOLS names are exactly the four' — key assertion:
    `['list_sessions','send_message','read_inbox','read_attachment']`.
  - 'send_message schema bounds' — key assertion: `to.maxItems 10`, `attachments.maxItems 5`, `subject.maxLength 200`.
- [ ] Run `npx vitest run test/unit/conduit-mcp-json-rpc.test.ts`. Expect FAIL (module missing).
- [ ] Implement within the signatures.

### Slice 2: Message store

**Check:** `npx vitest run test/unit/conduit-mcp-store.test.ts test/unit/conduit-mcp-retention.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** Serial: T2.1, T2.2
**Claims (serial lane):** none

#### Task 2.1: types + store + fs IO

**Files:**
- Create: `src/conduit-mcp/types.ts`, `src/conduit-mcp/store.ts`, `src/conduit-mcp/store-fs.ts`.
- Test: `test/unit/conduit-mcp-store.test.ts`.

**Interfaces:**
- Produces: all of `types.ts`, including every wire type (ruling 8); `StoreIo`,
  `createFsStoreIo`, `InboxQuery`, `MessageStore` (minus `enforceRetention`, which T2.2 adds),
  and `createMessageStore` (Contracts).
- Consumes: none.

**Steps:**
- [ ] Failing tests. Use an in-memory `StoreIo` fake plus one `createFsStoreIo(tmp)` round-trip.
  - 'append then reload restores messages and states' — key assertion: after `setStatus(noticed)`
    twice and `read`, a fresh store over the same IO has `recipients[h] = {status: 'read', noticeCount: 2}`.
  - 'torn tail is truncated by rewriteLog before the first append' — key assertion: the IO log
    after `load` + `append` is two valid JSON lines, and `rewriteLog` was called before
    `appendLog`.
  - 'IO calls never overlap' — key assertion: an IO fake whose methods resolve on a manual
    trigger records max concurrency 1 across concurrent `append` + `setStatus` + `allowMore`.
  - 'appendLog failure → store_unavailable, nothing in memory' — key assertion: `get(id) === undefined`.
  - 'a rejected IO call does not break the queue'.
  - 'readLog failure → available() false and append → store_unavailable'.
  - 'blobs are written before the log line', using an IO call-order spy.
  - 'orphan blob (refcount 0) deleted on load'.
  - 'read is never downgraded to noticed'.
  - 'undelivered only for unread recipients'.
  - 'pending excludes read, expired and other recipients'.
  - 'agentCountSinceHuman resets on a you-post and on allow'.
  - 'participants = from ∪ to over the thread'.
  - 'threads sorted by lastAt desc with unreadFor'.
  - 'inbox remaining counts beyond limit'.
- [ ] Run. Expect FAIL (module missing).
- [ ] Implement. `store-fs.ts` appends with `fs.promises.appendFile` and then `fsync` through a
      handle. `rewriteLog` uses `atomicWriteFile` (`src/atomic-write.ts:67`), promisified.

#### Task 2.2: retention (age only)

**Files:**
- Modify: `src/conduit-mcp/store.ts` (`enforceRetention`, `RETENTION_MAX_AGE_MS`).
- Test: `test/unit/conduit-mcp-retention.test.ts`.

**Interfaces:**
- Produces: `enforceRetention(now: Date): Promise<Result<RetentionResult>>`, `RetentionResult`,
  `RETENTION_MAX_AGE_MS`.
- Consumes: `createMessageStore(io, {maxAgeMs})` from T2.1.

**Steps:**
- [ ] Failing tests:
  - 'old fully-read message removed and its blob deleted at refcount 0'.
  - 'old unread message becomes an expired tombstone' — key assertion: `expired === true`,
    `body === ''`, recipient status `expired`.
  - 'shared blob survives while another message refs it'.
  - 'a tombstone older than maxAgeMs past expiry is dropped'.
  - 'retention runs through the IO queue' — key assertion: no overlap with a concurrent `append`.
  - 'compaction survives reload'.
- [ ] Run. Expect FAIL (`enforceRetention` missing).
- [ ] Implement.

### Slice 3: Notice decisions (pure)

**Check:** `npx vitest run test/unit/conduit-mcp-notice-gate.test.ts test/unit/conduit-mcp-draft-input.test.ts test/unit/conduit-mcp-adapters.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** G1: T3.1 · G2: T3.2 · G3: T3.3 (disjoint: the shared types `ScreenVerdict`
and `GateClosedReason` come from `types.ts`, landed in T2.1)
**Claims (serial lane):** none

#### Task 3.1: gate + recheck + notice text

**Files:**
- Create: `src/conduit-mcp/notice-gate.ts`, `src/conduit-mcp/notice-text.ts`.
- Test: `test/unit/conduit-mcp-notice-gate.test.ts`.

**Interfaces:**
- Produces: `IDLE_QUIET_MS`, `NOTICE_SPACING_MS`, `GateInput`, `GateVerdict`, `evaluateGate`,
  `EnterRecheckInput`, `evaluateEnterRecheck`, `composeNotice`.
- Consumes: `ScreenVerdict`, `GateClosedReason` (`src/conduit-mcp/types.ts`, T2.1).

**Steps:**
- [ ] Failing table tests. One open row; one row per closed reason, each flipping exactly one
      field of the open row (e.g. `now - lastOutputAt = 2999` → `quiet`; `screen: 'unknown'` →
      `no-empty-input`; `screen: 'blocking'` → `blocking-prompt`; `now - lastNoticeAt = 29_999` →
      `spacing`; `now - spawnedAt < settleMs` → `settling`); and a precedence row.
  - Recheck rows:
    - `notice-echoed` → open;
    - `empty-input` → `no-echo`;
    - `unknown` → `no-echo`;
    - `blocking` → `blocking-prompt`;
    - `inputSinceText` → `draft`;
    - `!sameGeneration` → `not-running`.
  - 'composeNotice is ASCII with no digits' — key assertion: `/^[\x20-\x7e]+$/` and `!/\d/`.
    `composeNotice(true)` contains `(urgent)` and `composeNotice(false)` does not.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 3.2: draft reducer

**Files:**
- Create: `src/conduit-mcp/draft-input.ts`.
- Test: `test/unit/conduit-mcp-draft-input.test.ts`.

**Interfaces:**
- Produces: `stripTerminalReplies`, `nextDraftState`, `isCountedInput`, `settleDraft`.
- Consumes: `ScreenVerdict` (T2.1).

**Steps:**
- [ ] Failing table tests:
  - Each reply form is stripped to `''`: `\x1b[?1;2c`, `\x1b[>0;276;0c`, `\x1b[12;40R`,
    `\x1b[I`, `\x1b[O`, `\x1b[<0;10;5M`, `\x1b[M !!`, `\x1b]11;rgb:0000/0000/0000\x07`,
    `\x1bP>|xterm\x1b\\`, `\x1b[?2004;1$y`.
  - `\x1b[A` (Up) is kept, so the draft becomes `true`.
  - `'fix the'` → `true`; `'fix\r'` → `false`; `'\x03'` → `false`; `'a\rb'` → `true`.
  - A focus report alone keeps the prior state, and `isCountedInput` is false for it.
  - `settleDraft`:
    - `empty-input` and `now - lastInputAt = 3000` → `false`;
    - `empty-input` and 2999 → `true`;
    - `unknown` and 10_000 → `true`;
    - `lastInputAt` undefined and `empty-input` → `false`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 3.3: adapters + screen verdict

**Files:**
- Create: `src/conduit-mcp/adapters.ts`, `src/conduit-mcp/screen-verdict.ts`.
- Test: `test/unit/conduit-mcp-adapters.test.ts`.

**Interfaces:**
- Produces: `McpAdapterId`, `ScreenPatterns`, `McpWiringKind`, `McpAdapter`, `MCP_ADAPTERS`,
  `adapterFor`, `notifiable`, `ScreenSnapshot`, `NOTICE_ECHO_ROWS`, `screenVerdict`.
- Consumes: `ScreenVerdict` (`./types`, T2.1); `commandLeaf` (`src/launch-args.ts:20`);
  `AgentDefinition` (`src/types.ts:29`); `composeNotice` is **not** imported (tests pass the
  literal notice string), which keeps the groups disjoint.

**Steps:**
- [ ] Failing tests:
  - `adapterFor`:
    - `{id: 'cli:claude', command: 'C:/x/claude.exe'}` → `claude`;
    - `cursor-agent` and `agent` leaves → `cursor`;
    - `{id: 'e2e-fake-mcp'}` → `fake` only with `e2e: true`;
    - a `shell:pwsh` definition → `undefined`.
  - S0 fixtures (read with `fs.readFileSync` from `test/unit/fixtures/conduit-mcp/screens/`),
    with `s = {lines, cursorY}`:
    - `claude-idle` → `empty-input`;
    - `claude-idle-placeholder` → `empty-input`;
    - `claude-permission` → `blocking` (dialog 15+ rows below the cursor);
    - `claude-trust` → `blocking`.
  - 'old prompt text above the cursor is not empty-input': `claude-idle` row 5
    (`❯ Use the Bash tool…`) never decides the verdict. Key assertion: the same fixture with
    `cursorY = 5` → `unknown`.
  - 'echo': the `claude-idle` lines with row 13 replaced by
    `❯ [conduit] New messages for you. Use the conduit read_inbox tool.` →
    `screenVerdict(claude.screen, s, notice) === 'notice-echoed'`. Wrapped across rows 12–13 at
    40 cols → still `notice-echoed`. A blocking footer anywhere → `blocking` (precedence).
  - 'codex trust footer is blocking'. `notifiable(codex) === false`, `notifiable(cursor) === false`
    and `notifiable(claude) === true`.
  - 'null patterns → unknown'.
- [ ] Run. Expect FAIL.
- [ ] Implement the patterns as declared in Contracts.

### Slice 4: Handles, attachments, tools

**Check:** `npx vitest run test/unit/conduit-mcp-handles.test.ts test/unit/conduit-mcp-attachments.test.ts test/unit/conduit-mcp-tools.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** G1: T4.1 · G2: T4.2 · Serial: T4.3
**Claims (serial lane):** none

#### Task 4.1: handles

**Files:**
- Create: `src/conduit-mcp/handles.ts`.
- Test: `test/unit/conduit-mcp-handles.test.ts`.

**Interfaces:**
- Produces: `slugHandlePrefix`, `HandleCounters`, `allocateHandle`, `parseHandleCounters`,
  `serializeHandleCounters`.
- Consumes: `Handle` (`src/conduit-mcp/types.ts`, T2.1).

**Steps:**
- [ ] Failing tests:
  - `slugHandlePrefix('Cli:Claude__X')` → `'cli-claude-x'`.
  - 'allocate never reuses' — key assertion: allocating `claude` twice from `{claude: 2}` gives
    `claude-3` then `claude-4`.
  - Invalid JSON → `{}`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 4.2: attachments

**Files:**
- Create: `src/conduit-mcp/attachments.ts`.
- Test: `test/unit/conduit-mcp-attachments.test.ts`.

**Interfaces:**
- Produces: the attachment constants, `AttachmentSender`, `AttachmentSnapshot`, `AttachmentFs`,
  `nodeAttachmentFs`, `snapshotAttachment`, `mimeFor`, `textPage`.
- Consumes: `isInsideRoot(child, root)` (`src/path-guard.ts:38`) and `realPathLeaf(target)`
  (`:60`); `mediaKindForPath(filePath)` and `imageMime(ext)` (`src/media-kind.ts:30,57`,
  already exported, so the file is not modified); `Result`, `toolError` (T2.1).

**Steps:**
- [ ] Failing tests. Use real temp dirs under `os.tmpdir()`. A dir link is
      `fs.symlinkSync(target, link, 'junction')`; the type is ignored on posix.
  - 'relative path resolves against home' — key assertion: `sha256` equals the file's.
  - '../ escaping the roots → path_outside_roots'.
  - 'a link inside a root pointing outside → path_outside_roots'.
  - 'a missing file → path_unreadable'.
  - 'a directory → path_unreadable'.
  - '10 MB + 1 → too_large'.
  - 'reads from the realpath that was checked'.
  - `mimeFor('a.png', …)` → `image/png`; utf-8 text without an extension → `text/plain`; bytes
    with NUL → `application/octet-stream`.
  - `textPage` splits a 3-byte char on the 64 KB boundary without breaking it, and returns
    `nextOffset: null` on the last page.
- [ ] Run. Expect FAIL.
- [ ] Implement in the fixed confinement order (Contracts).

#### Task 4.3: tool handlers

**Files:**
- Create: `src/conduit-mcp/tools.ts`.
- Test: `test/unit/conduit-mcp-tools.test.ts`.

**Interfaces:**
- Produces: `Caller`, `DirectoryEntry`, `ToolDeps`, `ToolHandlers`, `RATE_LIMIT_PER_MIN`,
  `THREAD_AGENT_LIMIT`, `MAX_BODY_BYTES`, `frameBody`, `createToolHandlers`, `toToolCallResult`.
- Consumes:
  - `MessageStore`, `createMessageStore`, `StoreIo` (T2.1);
  - `ListSessionsOutput`, `SendMessageOutput`, `ReadInboxOutput`, `InboxMessageOut`,
    `ReadAttachmentOutput`, `Presence`, `HUMAN_HANDLE`, `Result`, `toolError` (`types.ts`,
    T2.1);
  - `snapshotAttachment(sender, rawPath, fs?)`, `AttachmentSender`, `AttachmentSnapshot`,
    `textPage`, `MAX_IMAGE_BYTES`, `MAX_MESSAGE_ATTACHMENT_BYTES`, `MAX_ATTACHMENTS` (T4.2);
  - `ToolCallResult` (T1.1).

**Steps:**
- [ ] Failing tests. Use an in-memory store, a fixed directory (`claude-1`, `codex-2`), a fake
      clock and a fake snapshot:
  - 'sender is the caller's handle; args.from is rejected as invalid_argument'. This covers the
    EARS rule that the sender is derived from the token.
  - 'valid send → queued + onStored'.
  - 'mixed recipients → per-recipient statuses'.
  - 'all refused → error with first code'.
  - 'self → self_target'.
  - 'unknown → unknown_handle'.
  - 'to has 11 → too_many'.
  - 'body 32 KB + 1 → too_large'.
  - '61st send in 60 s → rate_limited (retryable)', with `you` exempt.
  - 'thread_id without participation → not_found'.
  - '21st agent message → thread_limit + onThreadLimit; a you-post resets'.
  - 'attachment failure stores nothing' — key assertion: `store.threads().length === 0`.
  - 'you with attachments → invalid_argument (v1)'.
  - 'store append failure → store_unavailable, no onStored'.
  - 'messaging off → every tool messaging_off'.
  - 'read_inbox frames bodies' — key assertion: body starts
    `[conduit message m_… from session claude-1 (an agent, not the user)]`; for `you`,
    `from the human via Conduit`.
  - 'read_inbox marks read only for the caller'.
  - 'read_inbox thread_id not participated → not_found'.
  - 'limit clamps to 50'.
  - 'read_attachment non-participant → not_found'.
  - 'text paging with next_offset'.
  - 'png ≤ 5 MB → image content via toToolCallResult'.
  - 'zip → unsupported_media with name/mime/bytes'.
  - 'list_sessions marks self and includes you'.
- [ ] Run. Expect FAIL.
- [ ] Implement in the fixed check order (Contracts).

### Slice 5: Notifier, attention reducer, session registry (pure)

**Check:** `npx vitest run test/unit/conduit-mcp-notifier.test.ts test/unit/conduit-mcp-attention-items.test.ts test/unit/conduit-mcp-session-registry.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** G1: T5.1 · G2: T5.3 · Serial: T5.2 (it consumes T5.1's `AttentionRaise`)
**Claims (serial lane):** none

#### Task 5.1: notifier state machine

**Files:**
- Create: `src/conduit-mcp/notifier.ts`.
- Create: `src/pty-writer.ts` with **only** `export type SubmitOutcome = 'submitted' | 'no-pty' | 'write-failed' | 'generation-changed' | 'gate-closed' | 'withheld';`.
  Its first caller is the notifier; T6.1 adds the writer.
- Test: `test/unit/conduit-mcp-notifier.test.ts`.

**Interfaces:**
- Produces: `AttentionRaise`, `NotifierSession`, `NotifierDeps`, `Notifier`, `createNotifier`,
  `SubmitOutcome`.
- Consumes: `GateVerdict` and `composeNotice(urgent)` (T3.1); `StoredMessage`, `Handle` (T2.1).

**Steps:**
- [ ] Failing tests with fake deps:
  - 'two sends while closed → one notice when open' — key assertion: `submit` called once.
  - 'precheck closed → no submit'.
  - 'gate-closed outcome (closed in the slot) → stays due, no raise'.
  - 'fyi alone never notices; fyi rides the next notice and is marked noticed'.
  - 'urgent while closed raises urgent-waiting once' — key assertion: two ticks give one `raise`.
  - 'urgent text when any pending urgent'.
  - 'withheld → unsent-notice, nothing marked'.
  - 'generation-changed → stays due'.
  - 'busy→idle after notice, still unread → re-notice once'.
  - 'a second cycle unread → unread-after-renotice once, never due again'.
  - 'rearmAll arms noticed pending'.
  - 'no overlapping ticks per session' — key assertion: a slow submit plus a concurrent tick
    gives one submit.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.2: attention reducer

**Files:**
- Create: `src/conduit-mcp/attention-items.ts`.
- Test: `test/unit/conduit-mcp-attention-items.test.ts`.

**Interfaces:**
- Produces: `AttentionEvent`, `reduceAttention`, `youAttention`, `attentionItemId`.
- Consumes: `AttentionRaise` (T5.1); `McpAttentionItem`, `McpAttentionReason`,
  `RecipientStatus`, `ThreadSummary`, `Handle`, `HUMAN_HANDLE` (T2.1).

**Steps:**
- [ ] Failing table tests, one row per clearing rule in Contracts:
  - 'raise twice → one item'.
  - 'urgent-waiting cleared by noticed'.
  - 'thread-paused cleared by thread-reset'.
  - 'unsent-notice cleared by renderer-input'.
  - 'session-gone drops all for the handle'.
  - 'youAttention: one item per thread with you unread'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.3: session registry

**Files:**
- Create: `src/conduit-mcp/session-registry.ts`.
- Test: `test/unit/conduit-mcp-session-registry.test.ts`.

**Interfaces:**
- Produces: `HandleAssignment`, `assignHandle`, `SessionRegistry`, `createSessionRegistry`.
- Consumes: `allocateHandle`, `HandleCounters` (T4.1); `Handle` (T2.1).

**Steps:**
- [ ] Failing tests:
  - 'mint replaces the previous token'.
  - 'revoke → resolve null'.
  - 'resolve(null) → null'.
  - 'isLive only after connect; false after the last disconnect'.
  - 'connectionsOf lists ids'.
  - `assignHandle`:
    - keeps `current` when free;
    - reallocates when `takenByOthers` has it (`allocated: true`, new number);
    - allocates when `current` is undefined.
- [ ] Run. Expect FAIL.
- [ ] Implement.

### Slice 6: Serialized writer + headless screens

**Check:** `npx vitest run test/unit/pty-writer.test.ts test/unit/session-screens.test.ts test/unit/timer-scheduler.test.ts`
passes, and `npm run verify:quick` is green. The timed-messages e2e (`timed-messages`,
`timed-messages-concurrency`) runs in the final remote `--full` sweep, because main.ts changed.

**Parallel groups:** Serial: T6.1, T6.2
**Claims (serial lane):** `electron/main.ts` (T6.1), `package.json` (T6.2), `package-lock.json` (T6.2)

#### Task 6.1: `createPtyWriter` + `deliverTimedMessage` refactor

**Files:**
- Modify: `src/pty-writer.ts` (add `SubmitHooks`, `PtyWriterDeps`, `PtyWriter`,
  `createPtyWriter` beside T5.1's type).
- Modify: `electron/main.ts` (`:1670-1679` `deliverTimedMessage`; construct `ptyWriter` beside it).
- Test: `test/unit/pty-writer.test.ts`.

**Interfaces:**
- Produces: `SubmitHooks`, `PtyWriterDeps`, `PtyWriter`, `createPtyWriter` (Contracts). A
  module-level `const ptyWriter` in main.ts. T9.3 passes it to the host.
- Consumes: `SubmitOutcome` (T5.1); `SUBMIT_GAP_MS` (`src/timed-messages.ts:97`);
  `pty.generation`/`pty.input` (`src/pty-host.ts`).

**Call sites:** `deliverTimedMessage` is used only at `electron/main.ts:1686`
(`TimerScheduler` deps). Its signature `(sessionId: string, message: string) => Promise<boolean>`
is unchanged, and it passes no hooks.

**Steps:**
- [ ] Failing tests with fake deps and a manual `sleep`:
  - 'text, gap, then \r' — key assertion: the input log is `['hi', '\r']`, and `sleep(120)` was
    awaited between them.
  - 'two submits on one session never interleave' — key assertion: the log is
    `['a', '\r', 'b', '\r']`.
  - 'beforeText runs inside the slot' — key assertion: with submit A pending in its gap, B's
    `beforeText` is not called until A's `\r` is written.
  - 'beforeText false → gate-closed, nothing written'.
  - 'different sessions do not block each other'.
  - 'generation change in the gap → no \r'.
  - 'beforeEnter false → withheld, no \r'.
  - 'a rejected hook does not break the chain'.
  - 'no pty → no-pty'.
- [ ] Run. Expect FAIL.
- [ ] Implement. In main.ts, replace the body of `deliverTimedMessage` with
      `ptyWriter.submit(sessionId, message).then((o) => o === 'submitted')`. Keep its doc comment
      (no `mgr.touch`) as a pointer.

#### Task 6.2: session screens + dependency move

**Files:**
- Create: `electron/session-screens.ts`.
- Modify: `package.json` (move `@xterm/headless` 6.0.0 from `devDependencies` to `dependencies`).
- Modify: `package-lock.json` (`packages[""]` deps; remove `"dev": true` at the
  `node_modules/@xterm/headless` entry, `:4352`).
- Test: `test/unit/session-screens.test.ts`.

**Interfaces:**
- Produces: `SessionScreens`, `createSessionScreens` (Contracts).
- Consumes: `ScreenSnapshot` (T3.3).

**Steps:**
- [ ] Failing tests:
  - 'feed then snapshot returns viewport lines and cursorY' — key assertion: after
    `feed('a\r\nb\r\n\x1b[2J\x1b[Hidle❯ ')`, `lines[0] === 'idle❯'` and `cursorY === 0`.
  - 'differential repaint (cursor moves + erase) is reflected'.
  - 'cursorY is viewport-relative after scrolling'.
  - 'resize keeps the model at the new size'.
  - 'start twice disposes the first'.
  - 'snapshot of an unknown session → undefined'.
  - 'alt screen content is what snapshot reads while active'.
- [ ] Run. Expect FAIL.
- [ ] Implement. Then confirm `npm run build` still bundles main. esbuild bundles
      `@xterm/headless` (not external), and `package.json` `build.files` excludes
      `node_modules`, so it must be bundled.

### Slice 7: Endpoint + shim

**Check:** `npx vitest run test/unit/conduit-mcp-endpoint.test.ts test/unit/conduit-mcp-shim.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** Serial: T7.1, T7.2
**Claims (serial lane):** `package.json` (T7.2), `.fallowrc.json` (T7.2)

#### Task 7.1: endpoint path + server

**Files:**
- Create: `src/conduit-mcp/endpoint-path.ts`, `electron/conduit-mcp-endpoint.ts`,
  `test/helpers/test-endpoint.ts`.
- Test: `test/unit/conduit-mcp-endpoint.test.ts`.

**Interfaces:**
- Produces: `endpointPath`, `HELLO_MAX_BYTES`, `INBOUND_LINE_MAX_BYTES`, `EndpointConnection`,
  `McpEndpoint`, `createMcpEndpoint`. `test/helpers/test-endpoint.ts` exports
  `testEndpoint(): string`.
- Consumes: `Result`, `toolError` (T2.1); `Logger` type (`electron/logger.ts`).

**Steps:**
- [ ] Failing tests:
  - `endpointPath('C:/Users/A/AppData/Roaming/Conduit', 'win32', '/tmp')` and the same path with
    a different case give the same pipe name, which starts `\\.\pipe\conduit-mcp-`.
  - posix gives `<userData>/conduit-mcp/mcp.sock`, and a 120-char userData gives the tmpdir form.
  - 'dev and installed userData differ'.
  - Server tests over `testEndpoint()`:
    - 'hello token parsed; lines framed both ways; connection ids unique';
    - 'no hello within the first line → closed';
    - 'oversized hello closed';
    - 'oversized inbound line closes the connection';
    - 'stale posix socket file is unlinked' (runs only when `testEndpoint()` is a path; this
      tests the posix branch, not win32 behaviour).
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 7.2: shim + packaging

**Files:**
- Create: `resources/conduit-mcp/conduit-mcp-shim.cjs`.
- Modify: `package.json` (`build.extraResources` add `{ "from": "resources/conduit-mcp", "to": "conduit-mcp" }`).
- Modify: `.fallowrc.json` (`entry` add `"resources/conduit-mcp/*.cjs"`).
- Test: `test/unit/conduit-mcp-shim.test.ts`.

**Interfaces:**
- Produces: the shim CLI contract (Contracts: Shim).
- Consumes: `createMcpEndpoint`, `testEndpoint()` (T7.1).

**Steps:**
- [ ] Failing tests. Spawn the shim with `process.execPath`, which is node under vitest,
      `[shimPath, '--endpoint', ep]`, and env `CONDUIT_SESSION_TOKEN`:
  - 'hello carries the env token' — key assertion: the server sees `token === 'abc'`.
  - 'bytes relay both ways unchanged' (a 200 KB line round-trip).
  - 'stdin written before connect is delivered after hello'.
  - 'no token → hello token null'.
  - 'host down → initialize answered, tools/list [], tools/call host_unavailable'.
  - 'stdin end → exit 0'.
  - 'shim requires only node:net' — key assertion: a source scan finds `require(` only for
    `'node:net'`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

### Slice 8: Launch wiring

**Check:** `npx vitest run test/unit/mcp-launch.test.ts test/unit/launch-args.test.ts test/unit/resolve-launch-spec.test.ts test/unit/launch-spec.test.ts test/unit/sanitize-child-env.test.ts`
passes (the existing launch tests are unmodified except for the new `batchGuarded` cases), and
`npm run verify:quick` is green.

**Parallel groups:** G1: T8.1 · G2: T8.2
**Claims (serial lane):** none

#### Task 8.1: `batchGuarded` + `mcpLaunchWiring`

**Files:**
- Modify: `src/launch-args.ts` (export `batchGuarded`; `launchArgsFor` uses it at `:38-41`).
- Create: `src/mcp-launch.ts`.
- Test: `test/unit/mcp-launch.test.ts`; Modify: `test/unit/launch-args.test.ts`.

**Interfaces:**
- Produces: `batchGuarded`, `McpServerCommand`, `McpLaunchWiring`, `mcpServerCommand`,
  `mcpLaunchWiring` (Contracts).
- Consumes: `McpAdapter` (T3.3); `McpUnavailableReason` (T2.1); `firstCmdMetachar`
  (`src/launch-args.ts:26`); `HostPlatform` (`src/lsp-binary.ts`).

**Call sites:** `launchArgsFor` behaviour is unchanged. Its callers are `src/launch-spec.ts:43`,
`webview/bridge.ts:866` and `test/unit/launch-args.test.ts`.

**Steps:**
- [ ] Failing tests:
  - claude: args `['--mcp-config', file]`, and `JSON.parse(configJson).mcpServers.conduit.env`
    deep-equals `{ELECTRON_RUN_AS_NODE: '1'}`.
  - codex: exactly five `-c` pairs, in the Contracts order, with TOML literal quoting.
  - 'execPath containing a quote → unquotable-path'.
  - cursor: `args []`, `configJson null`.
  - 'win32 + .cmd + metachar in the config path → cmd-metachar'.
  - 'win32 + .cmd without metachars → ok'.
  - 'posix never guarded'.
  - 'no adapter output contains a token value' (the token is never an arg).
  - `batchGuarded('win32', undefined) === true`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 8.2: strip an inherited token

**Files:**
- Modify: `src/pty-host.ts` (`sanitizeChildEnv`, `:53`).
- Test: `test/unit/sanitize-child-env.test.ts` (modified).

**Interfaces:**
- Produces: `sanitizeChildEnv` drops `CONDUIT_SESSION_TOKEN`.
- Consumes: none.

**Call sites:** `src/pty-host.ts:122-127` (`pty.spawn` env) is the only caller.

**Steps:**
- [ ] Failing test: 'parent CONDUIT_SESSION_TOKEN is not inherited' — key assertion:
      `sanitizeChildEnv({CONDUIT_SESSION_TOKEN: 'x', PATH: 'p'})` has no token and keeps `PATH`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

### Slice 9: Host integration + agent-side e2e

**Check:**
- `npx vitest run test/unit/conduit-mcp-host.test.ts test/unit/persistence.test.ts test/unit/session-manager.test.ts test/unit/settings.test.ts`
  and `test/unit/session-activity.test.ts` pass, and `npm run verify:quick` is green.
- Orchestrator, locally by exact name: `npm run e2e -- conduit-mcp-notify`,
  `npm run e2e -- conduit-mcp-gate`, `npm run e2e -- conduit-mcp-refusals`, each run serially.

**Parallel groups:** Serial (first): T9.1 · then G1: T9.2 · G2: T9.4 · Serial: T9.3
**Claims (serial lane):** `src/protocol.ts`, `src/types.ts`, `src/settings.ts` (T9.1); `electron/main.ts` (T9.3)

#### Task 9.1: wire aggregates, protocol, session/settings fields, activity clock

**Files:**
- Create: `src/conduit-mcp/ui-types.ts`.
- Modify: `src/protocol.ts` (the `mcp:*` members except `mcp:cursor`).
- Modify: `src/types.ts` (`Session.mcpHandle?`, `mcpNoticesPaused?`).
- Modify: `src/settings.ts` (`conduitMcp`; `RightPaneTab` + `'messages'`, `RIGHT_PANE_TABS`,
  validation `:491`).
- Modify: `src/session-manager.ts` (`setMcp`).
- Modify: `src/session-activity.ts` (`lastOutputAt(id)`).
- Test: `test/unit/persistence.test.ts`, `test/unit/session-manager.test.ts`,
  `test/unit/settings.test.ts`, `test/unit/session-activity.test.ts` (all modified).

**Interfaces:**
- Produces: all `ui-types.ts` types; the protocol members (Contracts); `SessionManager.setMcp`;
  `AppSettings.conduitMcp`; `RightPaneTab` with `'messages'`; `SessionActivity.lastOutputAt`.
- Consumes: `SendMessageOutput`, `McpUnavailableReason`, `McpAttentionItem`,
  `GateClosedReason`, `ThreadSummary`, `StoredMessage`, `Result`, `Handle`, `Priority`,
  `MessageKind`, `RecipientStatus`, `ToolErrorCode`, `AttachmentRecord` (all `types.ts`, T2.1).
  There is no import of `tools.ts` or `store.ts` (ruling 8).

**Call sites:**
- `RightPaneTab` is consumed by `webview/components/right-pane.tsx:108`. Its ternary at
  `:200-256` renders the Files branch for `'messages'` until T10.6 adds the branch, which
  typechecks because of the ternary's `else`.
- `bridge.ts` mock state's `settings` gets `conduitMcp` through `DEFAULT_SETTINGS`.

**Steps:**
- [ ] Failing tests:
  - 'mcpHandle and mcpNoticesPaused round-trip sessions.json'.
  - 'duplicate does not copy mcpHandle'.
  - 'setMcp emits change'.
  - 'conduitMcp defaults true and coerces'.
  - "rightPaneTab 'messages' survives restoreSettings".
  - 'lastOutputAt reflects recordOutput and is undefined for an unknown id'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 9.2: `createConduitMcpHost` (IO composition)

**Files:**
- Create: `electron/conduit-mcp-host.ts`.
- Test: `test/unit/conduit-mcp-host.test.ts`.

**Interfaces:**
- Produces: `ConduitMcpHostDeps`, `ConduitMcpHost`, `createConduitMcpHost` (Contracts).
- Consumes (signatures repeated from earlier tasks):
  - `createMcpServerCore(deps: McpServerCoreDeps): McpServerCore`; `CONDUIT_TOOLS`,
    `CONDUIT_INSTRUCTIONS` (T1.1).
  - `createMessageStore(io, opts?)`, `createFsStoreIo(dir)`, `MessageStore` (T2.1/T2.2).
  - `evaluateGate(i: GateInput): GateVerdict`, `evaluateEnterRecheck(i): GateVerdict`,
    `IDLE_QUIET_MS`, `composeNotice(urgent: boolean): string` (T3.1).
  - `nextDraftState(hasDraft, data)`, `isCountedInput(data)`, `settleDraft(i)` (T3.2).
  - `adapterFor(def, {e2e})`, `notifiable(a)`, `screenVerdict(patterns, s, expectNotice?)` (T3.3).
  - `parseHandleCounters`, `serializeHandleCounters` (T4.1).
  - `snapshotAttachment(sender, rawPath)` (T4.2).
  - `createToolHandlers(deps: ToolDeps): ToolHandlers`, `toToolCallResult` (T4.3).
  - `createNotifier(deps: NotifierDeps, {rearmAll: boolean}): Notifier` (T5.1).
  - `reduceAttention(items, e)`, `youAttention(threads, now)` (T5.2).
  - `createSessionRegistry()`, `assignHandle(i)` (T5.3).
  - `PtyWriter.submit(sessionId, text, {beforeText, beforeEnter})` (T6.1).
  - `createSessionScreens()` (T6.2).
  - `createMcpEndpoint({path, onConnection, log})` (T7.1).
  - `mcpServerCommand(execPath, shimPath, endpoint)`, `mcpLaunchWiring({adapter, platform, resolvedCommand, server, configFile})` (T8.1).
  - `McpUiState`, `McpSessionBadge`, `McpGateState` and the protocol members (T9.1);
    `SessionActivity.lastOutputAt` (T9.1).
  - `atomicWriteFileSync` (`src/atomic-write.ts:33`); `PTY_SETTLE_MS` (`src/timed-messages.ts:95`).

**Steps:**
- [ ] Failing tests. Use a real endpoint on `testEndpoint()`, a temp `dir`, fake
      mgr/pty/activity, a real `createPtyWriter` over a fake pty, an injected `now` and
      `tickMs: 0`, and call `tick()` by hand.
  - 'prepareLaunch for fake adds --mcp-config and a token; config file written without the
    token; env has no ELECTRON_RUN_AS_NODE'.
  - 'prepareLaunch for a plain shell returns spec unchanged'.
  - 'messaging off → unchanged + unavailable messaging-off'.
  - 'guard trip → unchanged + unavailable cmd-metachar'. This covers the EARS rule that the
    session launches without the server.
  - 'handle allocation writes handles.json before setMcp' — key assertion: the call-order spy
    shows `atomicWriteFileSync(handles.json)` before `mgr.setMcp`. Covers ruling 10.
  - 'a duplicate holder gets a new handle'.
  - 'a socket with a valid token sends; recipient gets queued; mcp:state broadcast'.
  - 'invalid token → tools/list [] and not_in_session'.
  - 'onExit revokes the token and deletes the launch config'.
  - Notice path:
    - 'idle prompt fed + quiet + settled + live connection → notice text, gap, the screen fed
      the echo → "\r" written';
    - 'no echo on screen after the gap → no "\r", unsent-notice attention' (ruling 3);
    - 'gate closes between precheck and slot (renderer input) → gate-closed, nothing written'
      (ruling 1);
    - 'blocking screen 15 rows below the cursor → no submit';
    - 'renderer input "fix the" → no submit until "\r"';
    - 'draft cleared after empty-input + 3 s without input' (ruling 4);
    - 'focus report input does not count as draft';
    - 'paused → no submit; badge gate "paused"';
    - 'codex session gets a handle but badge gate "pull-only" and never a submit'.
  - 'onSessionDeleted marks unread undelivered'.
  - 'store load failure → mcp:state storeError and tools store_unavailable; mcp:retry reloads;
    mcp:retry while available does not reload'.
  - 'restart: a new host over the same dir re-arms a noticed unread message'.
  - 'mcp:compose as you'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 9.3: main.ts wiring

**Files:**
- Modify: `electron/main.ts`.

**Interfaces:**
- Consumes: `createConduitMcpHost(deps)` (T9.2); `endpointPath(userData, platform, tmpdir)`
  (T7.1); `ptyWriter` (T6.1); the shim path resolver, below.

**Steps:**
- [ ] Add `const mcpShimPath = () => app.isPackaged ? path.join(process.resourcesPath, 'conduit-mcp', 'conduit-mcp-shim.cjs') : path.join(__dirname, '..', 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs')`
      (the `electron/skills-service.ts:19-23` pattern).
- [ ] Construct `mcpHost` after `mgr`, `pty`, `activity`, `settings`. The deps are:
  - `dir: path.join(userData(), 'conduit-mcp')`;
  - `endpointPath: endpointPath(userData(), process.platform === 'win32' ? 'win32' : 'posix', os.tmpdir())`;
  - `execPath: process.execPath`, `e2e: process.env.CONDUIT_E2E === '1'`;
  - `broadcast` to every window with `'to-webview'`.
- [ ] `void mcpHost.start()` after `mgr.restore` (`:1860`).
- [ ] Forward the events:
  - `term:start` (`:4040-4108`): `spec = mcpHost.prepareLaunch(m.sessionId, def, spec)` after the
    trackCwd augmentation and before `pty.start`, with `def = registry.get(agentId)`. Then
    `mcpHost.onSpawn(...)` after `pty.start`.
  - The PtyHost send callback on `term:data` calls `mcpHost.onOutput`.
  - `endProcessEpisode` (`:1594`, used on exit and restart) calls `mcpHost.onExit`.
  - `term:resize` alive branch calls `mcpHost.onResize`.
  - `term:input` calls `mcpHost.onRendererInput` before `pty.input`.
  - `disposeSession` (`:2557`) calls `void mcpHost.onSessionDeleted(id)`.
  - `updateSettings` (`:3555`) calls `mcpHost.refresh()`.
  - `ready` (`:2606`) does `replyHere({type: 'mcp:state', state: mcpHost.uiState()})`.
  - `case 'mcp:compose' … 'mcp:retry'` → `void mcpHost.handleRenderer(m, replyHere)`.
  - `before-quit` (`:4672`) calls `void mcpHost.stop()`.
- [ ] Gate: `npm run verify:quick`, plus `npx vitest run test/unit/conduit-mcp-host.test.ts`.
      No new unit test, because the wiring is proven by T9.4's e2e. That is the carve-out: host
      wiring is proven by e2e (CLAUDE.md).

#### Task 9.4: fake agent fixture + agent-side scenarios

**Files:**
- Create: `test/e2e/fixtures/fake-mcp-agent.mjs`, `test/e2e/conduit-mcp-helpers.mjs`.
- Create: `test/e2e/conduit-mcp-notify.e2e.mjs`, `test/e2e/conduit-mcp-gate.e2e.mjs`,
  `test/e2e/conduit-mcp-refusals.e2e.mjs`.

**Interfaces:**
- Produces:
  - Fixture CLI: `node fake-mcp-agent.mjs --mcp-config <file>`. Every record ends in
    ` <<END>>` (the `fake-claude.mjs` convention):
    - `FAKE-MCP READY tools=<csv>`
    - `FAKE-MCP INPUT <json line>` for every submitted line
    - `FAKE-MCP INBOX <json>` after a `[conduit] …` line triggers `read_inbox`
    - `FAKE-MCP RESULT <json>` for `call <tool> <json>`
    - `FAKE-MCP PROMPT-ENTER` if Enter arrives while its permission prompt is up
  - Fixture screen:
    - The prompt `fake❯ ` is echoed on the cursor row, so the notice echo is visible.
    - `permit` prints `Allow tool?` / `❯ 1. Yes` / `2. No` on the cursor rows, then **10 blank
      lines**, then `Esc to cancel` at the bottom. This mirrors S0's cursor-far-from-footer
      layout. It stays up until `1`, `2` or Esc.
    - `busy <ms>` prints a line every 100 ms.
    - Idle prints nothing.
  - The fixture spawns the server from the config's `mcpServers.conduit` with
    `{...process.env, ...entry.env}`, then runs `initialize` → `notifications/initialized` →
    `tools/list`.
  - Helpers:
    - `launchWithFakeAgents(label)` writes agents.json
      `[{id: 'e2e-fake-mcp', label: 'Fake MCP', command: process.execPath, args: [fixture], icon: 'terminal', color: 'green', cwdStrategy: 'workspaceFolder'}]`
      into `profileDir(label)` and launches via `launchApp({userDataDir})`.
    - `openFake(page, path)` → `{sessionId}`, waiting for `FAKE-MCP READY`.
    - `records(page, sessionId, kind)` parses `__capBy` with line breaks stripped.
- Consumes: harness `runScenario`, `launchApp`, `profileDir`, `openSession`, `typeLine`,
  `waitForOutput`, `tapBridge`, `finishScenario` (`test/e2e/harness.mjs`).

**Steps:**
- [ ] `conduit-mcp-notify`, the Gherkin "Idle agent is notified…" scenario:
  - A sends `call send_message {"to":["fake-2"],"priority":"normal","kind":"request","subject":"spec","body":"see","attachments":[{"path":"spec.md"}]}`.
  - The test then **rewrites `spec.md`**.
  - Within 5 s, exactly one `FAKE-MCP INPUT` starting `[conduit] New messages for you.` appears
    in B.
  - B's `INBOX` body starts `[conduit message` … `from session fake-1 (an agent, not the user)`.
  - B's `call read_attachment` returns the **original** text.
- [ ] `conduit-mcp-gate`:
  - (a) B `busy 8000`; A sends urgent. No `[conduit]` INPUT in B during busy. The `.attnchip`
    title or text contains `urgent message waiting for fake-2`. After idle, exactly one notice.
  - (b) B `permit`; A sends normal. No INPUT and no PROMPT-ENTER in B for 8 s. The footer is
    10+ rows below the cursor.
  - (c) The human types `fix the` without Enter (a `term:input` post with no `\r`); A sends. No
    notice for 8 s. Then `\x03` → a notice within 5 s.
  - (d) **Measures ruling 5 on the fake.** An idle B with no traffic receives no
    activity-driving output for 10 s. Key assertion: the session never reads busy in
    `window.__sessions`. Runtime QA repeats this on real claude, and the run report records the
    measurement.
  - Fresh sessions per case (30 s spacing).
- [ ] `conduit-mcp-refusals`:
  - `../../.ssh/id_rsa` → `path_outside_roots`, and B's inbox stays empty.
  - A junction inside the root pointing outside → `path_outside_roots`.
  - C, not in the thread, calls `read_inbox {"thread_id": <t>}` → `not_found`.
  - The shim spawned directly (`ELECTRON_RUN_AS_NODE=1` electron + shim, no token) →
    `tools/list` empty and `tools/call` `not_in_session`.
  - The settings toggle off via `updateSettings` → `messaging_off`.
  - 21 alternating agent sends in one thread → `thread_limit`.
- [ ] The orchestrator runs each by exact name locally, serially.

### Slice 10: Renderer — Messages tab, badges, chip

**Check:**
- `npx vitest run test/unit/conduit-mcp-view-model.test.ts test/unit/message-compose.test.tsx test/unit/messages-pane.test.tsx test/unit/attention.test.ts test/unit/session-card.test.ts test/unit/drag-region.test.ts test/unit/monaco-class-collision.test.ts`
  passes, and `npm run verify:quick` is green.
- Orchestrator: `npm run e2e -- conduit-mcp-compose`, then `npm run shots` reviewed in all three
  themes for the Messages tab (visual-fidelity check).

**Parallel groups:** Serial (first): T10.1 · then G1: T10.3 · G2: T10.4 · G3: T10.5 · then Serial: T10.2, T10.6, T10.7
**Claims (serial lane):** `webview/components/right-pane.tsx`, `webview/app.tsx`, `webview/bridge.ts`, `webview/styles.css`, `webview/components/settings-modal.tsx` (T10.6)

#### Task 10.1: strings, view model, hook

**Files:**
- Create: `webview/conduit-mcp-strings.ts`, `webview/conduit-mcp-view-model.ts`,
  `webview/use-conduit-mcp.ts`.
- Test: `test/unit/conduit-mcp-view-model.test.ts`.

**Interfaces:**
- Produces: `MCP_STR`, `ThreadFilter`, `visibleThreads`, `threadAccessibleName`,
  `newMessageCount`, `tabBadge`, `composeTargets`, `ConduitMcpApi`, `useConduitMcp` (Contracts).
- Consumes: `McpUiState`, `McpThreadSummary`, `McpThreadView`, `McpSendResult`,
  `McpAttachmentPayload`, `McpGateState` (T9.1); `subscribe`/`post`
  (`webview/bridge.ts:125,129`); `requestHost` (`webview/host-request.ts:8`); `countNoun`.

**Steps:**
- [ ] Failing tests:
  - 'unread filter'.
  - 'handle filter keeps threads with that participant'.
  - 'accessible name says "unread" and "urgent"'.
  - 'newMessageCount counts only new unread-for-you or new threads'.
  - 'tabBadge null at 0; urgent flag'.
  - 'composeTargets excludes sessions without a handle'.
  - `MCP_STR.attention['urgent-waiting']('codex-2') === 'urgent message waiting for codex-2'`.
  - 'every McpGateState has a gate string'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 10.3: compose + attachment view

**Files:**
- Create: `webview/components/message-compose.tsx`,
  `webview/components/attachment-view-modal.tsx`.
- Test: `test/unit/message-compose.test.tsx`.

**Interfaces:**
- Produces: `MessageComposeProps`, `MessageCompose`, `AttachmentViewModalProps`,
  `AttachmentViewModal` (Contracts).
- Consumes: `ConduitMcpApi`, `MCP_STR` (T10.1); `ModalLayer`; `SelectField`
  (`webview/components/select-field.tsx:24`); `SegmentedRadios`
  (`webview/components/segmented-radios.tsx:10`); `AttachmentRecord` (T2.1).

**Steps:**
- [ ] Failing jsdom tests:
  - 'Ctrl+Enter sends with selected recipients, priority, kind' — key assertion: `api.send` is
    called with `{to: ['codex-2'], priority: 'urgent', kind: 'request', body: 'x'}`, with no
    `attachments` key.
  - 'Esc cancels'.
  - 'failure lists per-recipient reasons'.
  - 'priority is a radiogroup with labelled options'.
  - 'reply prefills thread and recipients'.
  - 'attachment view renders text in pre, image as img with a data URL, unsupported as metadata'.
- [ ] Run. Expect FAIL.
- [ ] Implement. CSS class names here are used and defined in T10.6.

#### Task 10.4: attention entries + chip

**Files:**
- Modify: `src/attention.ts`, `webview/components/top-bar.tsx`.
- Test: `test/unit/attention.test.ts` (modified).

**Interfaces:**
- Produces: `AttentionEntry`, `attentionEntries` (Contracts). `TopBar` gets the new props
  `attentionItems?: readonly McpAttentionItem[]` (default `[]`) and
  `onOpenThread?: (threadId: string) => void`. The chip title is the first entry's reason text
  (`MCP_STR.attention`) or the existing "Go to <name>".
- Consumes: `McpAttentionItem`, `McpAttentionReason`, `Handle` (T2.1); `MCP_STR` (T10.1);
  `SnoozeMap`, `applySnooze` (`src/attention.ts`).

**Call sites:** `TopBar` is rendered in `webview/app.tsx:4580`. T10.6 passes the new props.

**Steps:**
- [ ] Failing tests:
  - 'session entries first, then items by at'.
  - 'items of a snoozed session are hidden'.
  - 'count includes items' — key assertion:
    `attentionChipLabel(attentionEntries(s, items, …).length) === '2 need you'`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 10.5: session card badge

**Files:**
- Modify: `webview/components/session-card.tsx`.
- Test: `test/unit/session-card.test.ts` (modified).

**Interfaces:**
- Produces: `SessionCard` prop `mcp?: McpSessionBadge`. It renders:
  - `session__mcp` with `{unread}`, plus the urgent icon and text;
  - a pause glyph `session__mcp-paused`;
  - `sr-only` text for each (the card is a div; `:150-152`);
  - the root `title` gets `MCP_STR.unavailable[reason]` when `unavailable`, else
    `MCP_STR.gate[gate]` when `gate` is neither `'open'` nor `null` (ruling 4).
- Consumes: `McpSessionBadge`, `McpGateState` (T9.1); `MCP_STR` (T10.1).

**Steps:**
- [ ] Failing tests:
  - 'unread count in the accessible text'.
  - 'urgent shows icon + word'.
  - 'paused glyph labelled'.
  - 'unavailable tooltip "Messaging unavailable: …"'.
  - 'gate reason tooltip, e.g. "Notices held: prompt on screen"'.
  - 'no badge without mcp'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 10.2: Messages pane + thread view

**Files:**
- Create: `webview/components/messages-pane.tsx`, `webview/components/message-thread.tsx`.
- Test: `test/unit/messages-pane.test.tsx`.

**Interfaces:**
- Produces: `MessagesPaneProps`, `MessagesPane`, `MessageThreadProps`, `MessageThread`
  (Contracts).
- Consumes: `MessageCompose`, `AttachmentViewModal` (T10.3); `ConduitMcpApi`, `visibleThreads`,
  `threadAccessibleName`, `newMessageCount`, `composeTargets`, `MCP_STR` (T10.1);
  `ContextMenu`/`MenuItem` (`webview/components/context-menu.tsx:16`).

**Steps:**
- [ ] Failing jsdom tests, one per spec §8 state:
  - first-run text;
  - loading skeleton (`state === null`);
  - store error + Retry calls `api.retry`;
  - server off + Open Settings;
  - "No unread messages" + Show all;
  - populated list as `listbox`/`option`, with ↑/↓/Home/End/Enter;
  - a thread is a `log` of `article`s showing per-recipient states;
  - paused → "Paused after 20 agent messages" + Allow 20 more calls `api.allowMore`;
  - expired attachment chip;
  - Open attachment shows the view modal;
  - opening a thread calls `markRead` for you-unread ids;
  - the live region announces "3 new messages" at most once per 5 s (fake timers).
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 10.6: serial wiring (claims)

**Files:**
- Modify: `webview/components/right-pane.tsx`:
  - a third `rtab` "Messages" with `tabBadge`;
  - a `'messages'` body branch rendering `MessagesPane`;
  - the handle interface (`:29-35`) adds `showMessages(filterHandle: Handle | null, threadId?: string): void`.
- Modify: `webview/app.tsx`:
  - `useConduitMcp()` once;
  - `Sidebar` `mcpBadges={api.state?.sessions ?? {}}`;
  - `onSessionContextMenu` (`:2827-2940`) adds "Open messages" and "Pause notices / Resume
    notices" (only for sessions with a handle);
  - TopBar `attentionItems` / `onOpenThread` → `rightPane.showMessages(null, threadId)`.
- Modify: `webview/components/sidebar.tsx`: a `mcpBadges: Record<string, McpSessionBadge>` prop,
  passed as `mcp={mcpBadges[s.id]}` at `:387`.
- Modify: `webview/bridge.ts`: `mockHost` answers `ready` with an `mcp:state`
  (`enabled: true`, empty) and replies to each `mcp:*` request with an empty/ok result.
- Modify: `webview/styles.css`: the `mcpmsg*` and `session__mcp*` rules, using the existing
  tokens only (spec §11).
- Modify: `webview/components/settings-modal.tsx`: a `SetGroup` "Agent messaging" with
  `<Toggle value={settings.conduitMcp} onChange={(v) => update({ conduitMcp: v })} />`.
- Test: `test/unit/drag-region.test.ts` and `test/unit/monaco-class-collision.test.ts`
  (existing, must stay green).

**Steps:**
- [ ] Implement the wiring.
- [ ] Run the slice's check. This is the visual-fidelity carve-out: proof is `npm run shots`
      reviewed by the orchestrator in T10.7, not a new failing unit test.

#### Task 10.7: compose e2e + visual review (orchestrator)

**Files:**
- Create: `test/e2e/conduit-mcp-compose.e2e.mjs`.

**Steps:**
- [ ] Scenario:
  - Open two fakes. Click the **Messages** tab.
  - New message → recipients `fake-1` → Send. The thread appears and fake-1 is noticed.
  - fake-1 sends to `you` with an attachment → the chip text includes the reason, the tab badge
    shows 1, opening the thread clears it, and Open attachment shows the text.
  - Card menu → Pause notices → a send to the paused fake gives no notice for 8 s, and the card
    shows the pause glyph.
  - fake-2 `permit` → its card tooltip shows the gate reason.
  - Every click is a real click.
- [ ] Orchestrator: run by exact name, then `npm run shots` and review the three themes.

### Slice 11: Restart durability + changelog

**Check:**
- Orchestrator: `npm run e2e -- conduit-mcp-restart` passes locally.
- Then the MVP gate: `npm run verify` (exit code captured) and **one**
  `npm run e2e:remote --full`.

**Parallel groups:** G1: T11.1 · G2: T11.2
**Claims (serial lane):** `CHANGELOG.md` (T11.2)

#### Task 11.1: restart scenario

**Files:**
- Create: `test/e2e/conduit-mcp-restart.e2e.mjs`.

**Steps:**
- [ ] Use `launchApp({userDataDir})` twice with the same profile:
  - fake-1 → fake-2 send while fake-2 is `busy`;
  - quit via `closeApp`;
  - relaunch, then relaunch the sessions;
  - the thread is intact in Messages, fake-2 has the same handle, and exactly one notice
    arrives after the gate opens.

#### Task 11.2: changelog

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`).

**Steps:**
- [ ] Write one bold-lead entry: agents in sessions can message each other and you; the
      Messages tab; notices only when idle and safe; Codex reads its inbox on request.
- [ ] No version bump (not released; Decisions).

### Slice 12: Cursor connect — CONDITIONAL, last (ruling 7)

**Precondition:** S0–S11 are verified, meaning the MVP gate in Slice 11 is green and runtime QA
on real claude/codex is done. If the precondition isn't met, this slice is not started, and the
run report records Cursor as deferred.

**Check:**
- `npx vitest run test/unit/conduit-mcp-cursor-config.test.ts test/unit/cursor-mcp-link.test.ts`
  passes, and `npm run verify:quick` is green.
- Orchestrator: `npm run e2e -- conduit-mcp-cursor-link`, then a remote run by name:
  `npm run e2e:remote conduit-mcp-cursor-link`, plus the affected set.

**Parallel groups:** Serial: T12.1, T12.2
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/components/settings-modal.tsx`, `webview/bridge.ts`, `CHANGELOG.md` (T12.2)

#### Task 12.1: pure config edit

**Files:**
- Create: `src/conduit-mcp/cursor-config.ts`.
- Test: `test/unit/conduit-mcp-cursor-config.test.ts`.

**Interfaces:**
- Produces: `CURSOR_SERVER_NAME`, `SHIM_FILE_NAME`, `CursorEntry`, `cursorEntry`,
  `CursorEditResult`, `connectCursorConfig`, `disconnectCursorConfig`, `cursorLinkState`,
  `CursorLinkStatus`.
- Consumes: `McpServerCommand` (T8.1).

**Steps:**
- [ ] Failing tests:
  - 'absent file → creates {mcpServers: {conduit}}'.
  - 'keeps other servers and unknown keys'.
  - "entry env has the literal '${env:CONDUIT_SESSION_TOKEN}'".
  - 'foreign conduit entry → foreign-entry, untouched'.
  - 'disconnect removes only ours'.
  - 'invalid JSON → invalid-json'.
  - 'stale when our entry points at another shim path'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 12.2: host link + protocol + settings UI + changelog line

**Files:**
- Create: `electron/cursor-mcp-link.ts`; Test: `test/unit/cursor-mcp-link.test.ts`.
- Modify: `src/protocol.ts` (both `mcp:cursor` members).
- Modify: `electron/main.ts` (`case 'mcp:cursor'`, constructing the link with
  `homeDir: process.env.CONDUIT_HOME || os.homedir()` and
  `entry: cursorEntry(mcpServerCommand(process.execPath, mcpShimPath(), endpoint))`).
- Modify: `webview/components/settings-modal.tsx` (Connect Cursor / Disconnect with a status
  line).
- Modify: `webview/bridge.ts` (mock `mcp:cursor` → `disconnected`).
- Modify: `CHANGELOG.md` (add Cursor to the T11.2 entry).
- Create: `test/e2e/conduit-mcp-cursor-link.e2e.mjs`.

**Interfaces:**
- Produces: `CursorMcpLink`, `createCursorMcpLink` (Contracts).
- Consumes: `connectCursorConfig`, `disconnectCursorConfig`, `cursorLinkState`,
  `CursorLinkStatus`, `cursorEntry` (T12.1); `mcpServerCommand` (T8.1); `atomicWriteFileSync`.

**Steps:**
- [ ] Failing tests (temp home):
  - 'connect writes the entry and a timestamped backup of the prior file'.
  - 'no prior file → no backup, .cursor created'.
  - 'disconnect backs up then removes'.
  - 'error status carries the reason'.
- [ ] Run. Expect FAIL.
- [ ] Implement.
- [ ] E2E: run with `CONDUIT_HOME` set to a temp dir. Settings → Connect Cursor → the file has
      the entry and a backup exists → Disconnect → the entry is gone and other servers are
      intact.

## Execution order

```
S0 (DONE 214b4439) → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 [MVP gate + QA] → S12 (conditional)
```

- Shared files across slices:
  - `electron/main.ts`: S6, S9, S12.
  - `src/protocol.ts`: S9, S12.
  - `package.json`: S6, S7.
  - `webview/bridge.ts` / `settings-modal.tsx`: S10, S12.
  - `CHANGELOG.md`: S11, S12.
- Inside a slice, groups are file-disjoint as listed. Dispatching them in parallel is optional;
  one executor in task order is equally valid.
- One commit per task. Message `feat(conduit-mcp): <task>` or `test(conduit-mcp): …`. The
  pre-commit hook runs; never bypass it.

## Verification

- **Per task:** the named `npx vitest run <files>`, then `npm run verify:quick`. Nothing broader.
- **Per slice:** the slice's named check. E2E named in a slice is run by the orchestrator,
  locally, by exact name, serially, and never by an executor.
- **Once, after S11** (the MVP gate):
  - `npm run verify`, with the exit code captured directly;
  - then **one** `npm run e2e:remote --full` (main.ts and `test/e2e/**` changed);
  - a failure confirmed remotely is bisected; a local-only PTY failure is re-run remotely first
    (CLAUDE.md).
- **Runtime QA** (orchestrator, local, real CLIs, after the MVP gate, before S12):
  - `claude` sessions `claude-1` + `claude-2`, plus `codex-1`:
    - a send with an attachment → notice → `read_inbox`;
    - a permission prompt (dialog far below the cursor) is never answered;
    - a draft blocks;
    - **idle claude stays output-quiet ≥ 3 s** (ruling 5; record the measurement, including any
      periodic repaint such as a status-line clock);
    - Codex calls run without a Codex approval prompt (`default_tools_approval_mode`);
    - try capturing Codex idle/approval in Conduit for later patterns.
  - If S12 is built: a Cursor connect against the real `~/.cursor/mcp.json` with a backup
    verified, then Disconnect.
- **Before each commit:** `git status` shows only the task's files.
- **Rollback:** revert per slice. The global Settings toggle turns the feature off at runtime.

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked
signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the
work. Never route around it with a shim, a second copy, a special case, a widened type, a
fallback, or an override patched in place of its semantic source. The report leads with the fix
that keeps the locked decision.

## Decisions Needed

- **[high] Claude idle staying output-quiet ≥ 3 s is ASSUMED** (ruling 5).
  - If the real CLI repaints periodically while idle (a spinner, clock or status line),
    `SessionActivity` reads it as busy, the gate's `busy`/`quiet` conditions never open, and
    Claude becomes pull-only in practice.
  - It is measured in T9.4(d) (fake) and in runtime QA (real claude).
  - If it fails, the fix belongs in the producer's inert-output classification
    (`scanInertOutput`, `src/terminal-output.ts:22`), not in a gate exception. That would be a
    new task under the deviation rule.
- **[high] Prompt detection.**
  - Claude's patterns are evidenced by S0: blocking on any viewport row, empty-input on the
    cursor row.
  - Codex is pull-only (`emptyInput: []`), and its trust footer is declared blocking anyway.
  - Cursor is pull-only.
  - A pattern miss in QA is fixed by adding the captured screen as a fixture and a pattern, not
    by relaxing the gate.
- **[high] Cursor is conditional and last** (ruling 7). If `${env:…}` interpolation measures
  broken, or S12's precondition isn't met, Cursor is reported as v1.
- **[normal] The handle prefix is the adapter id** (`claude`, `codex`, `cursor`, `fake`), not the
  definition id (Spec staleness).
- **[normal] `invalid_argument` is added** to the error codes for schema failures. The spec's list
  had no code for a malformed call.
- **[normal] The human sees every thread and attachment.** UI reads skip the participation filter
  (spec §1: "The human sees every message"). Agent reads keep it.
- **[normal] `launch-io` is added to `McpUnavailableReason`** (review B7). A handles.json or
  launch-config write failure is a local IO fault, not a down endpoint; the card names it
  separately so the cause is honest.
- **[normal] The human may post into any existing thread** (review A5). `send_message` from `you`
  with a `thread_id` skips the participation check but still needs the thread to exist
  (`participants(threadId).size > 0`), else `not_found`. Agents keep spec §3.2: a thread they have
  no message in is `not_found`.
- **[normal] Human-compose attachments are cut to v1** (ruling 7; this overturns spec §6's MVP
  "Attach…" and §9's "Save attachment as…"). `send_message` from `you` with attachments →
  `invalid_argument`. Agents' attachments and the human's attachment view stay.
- **[normal] Retention is by age only** (ruling 7; this overturns spec §3.4's "or 1 GB").
- **[normal] Recipient state is log events, not a second file.** One append-only log holds
  messages, states, allows and expiries, behind one IO queue.
- **[normal] The launch preview doesn't show MCP args.** MCP wiring is host-generated per launch
  and carries userData paths. The card's "Messaging unavailable" covers the failure case.
- **[normal] The shim answers by itself only when the host is down** (`host_unavailable`).
- **[normal] Unknown protocol versions get the newest supported one** (MCP version negotiation).
- **[normal] `SubmitOutcome` lands in T5.1 as a type in `src/pty-writer.ts`.** Its first caller is
  the notifier, and the writer joins it in T6.1.
- **[normal] An unsent notice leaves its text in the CLI input** (spec §13). Ruling 3 makes this
  rarer, but when it happens the human gets attention, and no line-clear key is guessed.
- **[normal] `TimerScheduler`'s own queue stays.** The writer orders all host-originated writes
  across sources. Timed messages pass no gate hooks.
- **[normal] The guard trips only when a guarded launch (win32 .cmd/.bat or unresolvable) would
  receive an MCP arg containing a metachar.** This reads spec §3.1 "would trip the guard"
  literally.
- **[normal] The branch is `feat/conduit-mcp`, with no release and no version bump** (spec §13).
- **[normal] Numbers are reversible:** age retention, loop guard, rate, spacing, the 500 ms tick
  and `NOTICE_ECHO_ROWS`.
