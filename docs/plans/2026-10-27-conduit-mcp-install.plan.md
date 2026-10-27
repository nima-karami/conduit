# Plan: Install Conduit MCP for agent CLIs, and let users find it

Spec: [2026-10-27-conduit-mcp-install.md](../specs/2026-10-27-conduit-mcp-install.md) (FULL;
§14 conductor rulings override §13 defaults). S0 results go to
`docs/runs/2026-10-27-mcp-install/s0.md`, runtime QA to `docs/runs/2026-10-27-mcp-install/qa.md`.

**Tier: FULL.** The feature adds a public IPC pair, four config-file writers (JSON and TOML, two
scopes), a new identity path in the MCP host (token for every session, lazy handles from
`clientInfo`, a live notice adapter), typed-command detection, a Settings tab, a banner, a card
indicator and a Messages empty state. It crosses `src/`, `electron/`, `webview/`, `resources/` and
`test/e2e/`, and executors pick tasks up cold. Planned against `feat/mcp-install` HEAD `86e0b9ec`.
Every line number below was grepped at that HEAD; re-grep before editing, since earlier tasks
shift them.

## Goal

After one **Install** per CLI in Settings → MCP, any of `claude`, `codex`, `agent`/`cursor-agent`
or `opencode` started in any Conduit terminal connects to this host, gets a handle and appears in
`list_sessions`; the same CLI outside Conduit lists a healthy `conduit` server with zero tools; and
a user who never opened Settings learns of it from the banner, the card or Messages.

## Architecture

- **Pure cores (node-free, renderer-importable unless noted):**
  - `src/conduit-mcp/install-types.ts`: the CLI catalog (`AGENT_CLIS`), every install wire type,
    the per-CLI entry shapes, `ConfigFormatError`, request coercion, dismissal coercion,
    `needsSetup`.
  - `src/conduit-mcp/install-entries.ts`: builds this build's entry per CLI and classifies any
    existing `conduit` entry (`absent | ours | other-conduit | conflict`), plus the paths an entry
    references (for Repair).
  - `src/conduit-mcp/json-config.ts`: strict JSON parse (BOM, empty), key-path get/set/delete,
    2-space serialize. Generalises `src/conduit-mcp/cursor-config.ts:44-83`.
  - `src/conduit-mcp/toml-config.ts`: TOML basic strings, the Codex table renderer, owned-range
    location, line-range splice with the re-parse guard. Uses `smol-toml` (new dependency).
  - `src/conduit-mcp/client-info.ts`: `clientInfo.name` → `ClientKind`, kind → notice adapter id,
    the newest-live selection rule, and the `initialize` line parser.
  - `src/conduit-mcp/typed-command.ts`: the typed-line tracker and the CLI-line classifier.
- **Host install IO (main process):**
  - `electron/config-file-io.ts`: realpath read, mode-preserving atomic write, exclusive
    first-write backup. Moved out of `electron/cursor-connect.ts:167-205`.
  - `electron/mcp-install-targets.ts`: which file, which key path, which backup path, per CLI
    and scope, from an injected home/env/userData.
  - `electron/mcp-install.ts`: `createMcpInstall(deps)` — `status`, `act`, `userState`, `repair`;
    and `readCursorLaunchEntry` (moved here from `electron/cursor-connect.ts:142`). Synchronous,
    like `createCursorConnect`, so every action is serialised by the main thread (spec §3.5
    "serialised per realpath" holds by construction).
- **MCP host** (`electron/conduit-mcp-host.ts`):
  - `prepareLaunch` mints a token and sets `CONDUIT_SESSION_TOKEN` + `CONDUIT_MCP_ENDPOINT` for
    every session when messaging is on and the endpoint is ready; adapter sessions keep today's
    path exactly.
  - On an `initialize` line from a valid token, **before** the core replies: record the
    connection's `ClientKind`, claim `<kind>-<n>` if the session has no handle, start the screen
    model if none runs, clear detection state.
  - `Runtime.adapter` becomes `defAdapter`; every notice consumer reads
    `noticeAdapterOf(sessionId)` = definition adapter, else the newest live connection's kind.
  - Non-adapter sessions with a token get a `TypedLineTracker`; `tick()` turns an un-initialized
    candidate older than the grace into `notConnected`, with the user install state read through a
    new `installState` dep. `McpUiState` gains `notConnected`.
- **Main** (`electron/main.ts`): creates `mcpInstall` before `mcpHost`, runs `repair()` at startup
  (skipped under `CONDUIT_E2E=1`), registers `mcpInstall:status` / `mcpInstall:act` invoke
  handlers (the `skills-list` precedent, `electron/main.ts:4930-4937`), and passes
  `installState` + `detectGraceMs` to the host.
- **Renderer:** an **MCP** tab in `webview/components/settings-modal.tsx` (rows in
  `webview/components/mcp-install-row.tsx`, project section in
  `webview/components/mcp-project-entries.tsx`, data via `webview/use-mcp-install.ts`); a card
  indicator (`webview/mcp-card-status.ts` + `session-card.tsx`); a banner
  (`webview/mcp-setup-banner-model.ts` + `webview/components/mcp-setup-banner.tsx`, a sibling of
  `AgentScopeBanner` in `center-pane.tsx`); the Messages empty state; palette and card-menu
  entries in `webview/app.tsx`.
- **Shim** (`resources/conduit-mcp/conduit-mcp-shim.cjs:56`): fallback `serverInfo` gains
  `version: 'fallback'`.
- **No sketches.** Every seam copies a sibling: the install IO copies `createCursorConnect`; the
  IPC copies `skills-list`/`skills-install` (preload object + bridge wrapper with preview
  fallback, `webview/bridge.ts:282-295`); the banner copies `AgentScopeBanner`'s placement; the
  row copies `CursorConnectRow`'s focus and live-region behaviour.

## Data flow

```
INSTALL
 MCP tab row ─bridge.mcpInstallAct(req)─► preload invoke 'mcpInstall:act' ─► main handler
   coerceInstallRequest(req) (null ⇒ reject) ─► mcpInstall.act(req)
     projectPath? ⇒ knownHome(projectPath) (null ⇒ errorCode EPROJECT)
     target = userTarget(cli) | projectTarget(cli, root) | claudeLocalTarget(...)
     readConfigText(realpath, strip BOM) ─► parse (JSON | TOML) ─► classifyEntry ─► action valid? (ESTATE)
     backup once (user: <file>.conduit-backup; project: userData/mcp-install-backups/<hash>/…)
     mutate only conduit (setPath/deletePath | spliceConduitTable + guard)
     [claude user file: re-stat; changed ⇒ re-read + re-apply once; changed again ⇒ EBUSY]
     writeConfigAtomic(temp+rename, mode kept) ─► re-read ─► {ok, status} | {ok:false, status, errorCode}
   ok ⇒ mcpHost.onInstallChanged()  (re-reads install state behind every notConnected entry)

SPAWN   term:start ─► mcpHost.prepareLaunch(id, def, spec)
   adapter ⇒ today's path (handle at launch, per-launch wiring, unavailable reasons)
   no adapter && messagingOn && endpointReady ⇒ mint token; env += TOKEN, ENDPOINT;
       r.tracker = createTypedLineTracker()
   ─► pty.start(env = sanitizeChildEnv(process.env) ∪ spec.env)   (src/pty-host.ts:117)
   ─► mcpHost.onSpawn: r.size, r.spawnedAt for every runtime; screens.start only for adapters

TYPED   term:input ─► mcpHost.onRendererInput ─► r.tracker.feed(data) ─► AgentCli[]
   candidate && !registry.isLive(id) ⇒ r.detect = {cli, at: now()}
   tick(): r.detect && now-at ≥ grace ⇒ r.notConnected = {cli, install: deps.installState(cli),
       launch: r.launch, reason: 'no-initialize'} ⇒ broadcast mcp:state

CONNECT CLI expands its entry ─► shim (env token+endpoint) ─► endpoint ─► onConnection
   line = initialize (initializeClientName(line) !== undefined) && valid token ⇒
     kind = clientKindOf(name, {e2e}); connKinds.set(conn.id, {kind, seq})
     no handle ⇒ claimHandle(id, kind)        ← before the reply
     !screens.has(id) && r.size ⇒ screens.start(id, cols, rows)
     r.detect = undefined; r.notConnected (reason no-initialize) = undefined
   ─► core.handleLine ─► reply ─► registry.connect(conn.id, id) (live)
   notices: noticeAdapterOf(id) = defAdapter ?? MCP_ADAPTERS[pickNoticeAdapterId(...)]

UI      mcp:state {sessions (badges, by handle), notConnected (by sessionId)}
   ─► sidebar → session-card indicator (cardMcpStatus)
   ─► center-pane → McpSetupBanner (shouldOfferBanner, BANNER_LEDGER)
   Messages (no threads) ─► bridge.mcpInstallStatus(null) ─► needsSetup ⇒ CTA ⇒ Settings → MCP
```

## Settled decisions — do not re-litigate

From the spec (§1–§12) and the conductor rulings (§14):
- **Repair is MVP (D2 ruling).** At startup, a user-scope entry classified `other-conduit` whose
  referenced exe or shim path **no longer exists** is rewritten to this build's entry, with the
  first-write backup. An entry pointing at existing paths is never touched.
- **Screen model starts at first `initialize` (D6 ruling)** for sessions that get identity
  lazily; such a session reads `unknown` until a full repaint.
- D1: Conduit edits `~/.claude.json` directly with the mtime guard; S0 gates it.
- D3: one handle per session, prefix from the first CLI that connects, kept for life; health
  checks claim one.
- D4: detection from the typed line only. D5: Codex entry carries
  `default_tools_approval_mode="auto"`. D7: no Claude permission edits. D8: OpenCode is install +
  pull-only, no adapter. D9: every S0 item keeps its default until measured. D10: `not-found`
  offers only **Check again**. D11: no global notices setting; the Messaging description explains
  notices.
- Server name `conduit` everywhere; no `--endpoint` in installed entries; endpoint from env.
- Install writes **user** scope by default; project install is secondary and never for Cursor;
  project backups go to `userData`, never the repo.
- Nothing is written without a click, except Repair of this build's own dead entries.
- `mcpInstallSuggest` default on; dismissal permanent per CLI until suggestions are turned back on.
- Banner never modal, never an OS notification, never while messaging is off.
- Fixed CLI order: Claude Code, Codex, Cursor, OpenCode.

## Spec staleness

Measured at `86e0b9ec`; each row says how the plan proceeds.

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| "the `cursorConnect:*` channels are replaced by `mcpInstall`" (§3.5, AC14) | No protocol variants exist. They are invoke channels `cursor-connect:read\|connect\|disconnect` (`electron/main.ts:4940-4942`), preload methods `readCursorConnection`/`connectCursor`/`disconnectCursor` (`electron/preload.ts:54-62`) and bridge wrappers (`webview/bridge.ts:77-79,176-192`) | `mcpInstall:status`/`mcpInstall:act` are invoke channels on a preload `mcpInstall` object, like `skills` (`electron/preload.ts` `skills`, `electron/main.ts:4930-4937`). `src/protocol.ts` is **not edited**. AC14 is checked by grep for `cursor-connect:`, `readCursorConnection`, `connectCursor`, `disconnectCursor`, `CursorConnectRow` (T4.9) |
| `McpSessionBadge` gains `status: 'connected'\|'not-connected'\|null, notConnectedCli?` (§3.6) | Badges exist only for sessions with a handle (`electron/conduit-mcp-host.ts:737`), and a not-connected shell has none. `connected: boolean` already exists (`src/conduit-mcp/ui-types.ts:16-25`) | Badge unchanged. `McpUiState` gains `notConnected: Record<sessionId, McpNotConnected>`. `connected` comes from `badge.connected` |
| Card copy depends on "that CLI's install state" (§2.4) and "the host re-reads on each detection" (§2.3) | No host path reads install state | Host dep `installState(cli)`; `McpNotConnected.install` carries it; `onInstallChanged()` refreshes it after any successful action |
| `mcpInstall:act({cli, scope, action, projectPath?})` (§3.6) | Removing a Claude project entry must say which of the two Claude entries (`local` in `~/.claude.json`, `project` in `<root>/.mcp.json`) | `McpInstallRequest` gains `entryScope?: ProjectScope`, required when `action === 'remove'` |
| "lucide-react `Plug`/`Unplug` added to `webview/icons.tsx`" (§11) | Chrome icons are 16px custom `glyph()`s (`webview/icons.tsx:158-170`, viewBox `0 0 16 16` at `:17`); lucide is used only dynamically for session glyphs (`:520-530`) | `IconPlug`/`IconUnplug` via `glyph()`, with lucide's `plug`/`unplug` path data in a `<g transform="scale(0.6667)">` (T4.1) |
| "the mf-live-edits banner slot" (§2.5) | No generic slot. It is `AgentScopeBanner` (`webview/components/agent-scope-banner.tsx:41`), rendered at `webview/components/center-pane.tsx:354` inside `.termhost__body`, shown iff `session.agentScope` (`:51`, `:59`) | New sibling `McpSetupBanner` in the same `.termhost__body`; "another banner showing" ⇔ `!!session.agentScope` |
| Handles are allocated by `clientInfo` (§2.4, §3.3) | `clientInfo` is never read: the host only re-parses for `method === 'initialize'` **after** replying (`electron/conduit-mcp-host.ts:649-674`, `:1096`); `json-rpc.ts:85-93` ignores it. `claimHandle` takes an `McpAdapter` and uses `adapter.id` as prefix (`:477-507`) | `initializeClientName(line)` (T1.5) runs **before** `core.handleLine`; `claimHandle(sessionId, prefix: string)` (T3.1) |
| Screen model "starts at first initialize" (§14 D6) | It starts only in `onSpawn` for adapter sessions (`:913-920`); terminal size is not stored | Runtime stores `size` from `onSpawn`/`onResize` for every runtime; lazy sessions start at first `initialize` (T3.2) |
| TOML is "parsed for status" with a "re-parse guard" (§3.5) | No TOML parser in the tree (`package.json:140-170`, no `toml`/`smol-toml`/`@iarna/toml` in `node_modules`) | Add `smol-toml` **1.3.1, exact**; main is bundled by esbuild (`esbuild.mjs:11-15`), so no packaging change (T1.4). See Decisions Needed |
| Gherkin background "CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME **unset**" (§7) | The harness merges scenario env over `process.env` (`test/e2e/harness.mjs:328`), so a scenario cannot unset a runner variable | Scenarios set them to `''`; `mcp-install-targets.ts` treats `''` as unset (T2.2 test) |
| Fake CLI "→ the existing `fake` adapter's patterns" (§7) | The `fake` adapter matches by definition id only (`src/conduit-mcp/adapters.ts:90-98`), and `fake-mcp-agent.mjs` reads `--mcp-config`, never Claude's config | `clientKindOf('conduit-e2e-fake', {e2e:true}) === 'fake'` and `noticeAdapterIdOf('fake') === 'fake'` (T1.5); new fixture `test/e2e/fixtures/fake-agent-cli.mjs` (T5.1) |
| Messages CTA "opens Settings → MCP" (§2.6) | The pane's `onOpenSettings` opens **General** (`webview/app.tsx:4599`) | T4.7 points it at `openSettingsAt('mcp')`, which is also right for the messaging-off button now that the master switch moves |
| "Turning `mcpInstallSuggest` on clears the map" (§3.6) | Settings have no transition hook; `coerceSettings` sees one payload | The Suggestions toggle writes both fields in one `update` (T4.3). It is the only producer of `mcpInstallSuggest: true` |
| Settings tab union (§2.1 D9 source claim) | Confirmed at `webview/components/settings-modal.tsx:45`, duplicated at `webview/app.tsx:315` | Both gain `'mcp'` (T4.3, T4.7) |
| `prepareLaunch` leaves non-adapter sessions with nothing (§2.1 D9) | Confirmed: `electron/conduit-mcp-host.ts:862-864` returns `spec` | T3.1 changes it; `test/unit/conduit-mcp-host.test.ts:496` ("prepareLaunch for a plain shell returns spec unchanged") is rewritten |
| Host `serverInfo` carries `version` (§2.1) | Confirmed `electron/conduit-mcp-host.ts:638` (`VERSION = '1'`, `:154`) | No change |

## Global constraints

- **Gates:**
  - Inner loop: the named vitest files (`npx vitest run <file>`), then `npm run verify:quick`.
  - Once after S5: `npm run verify`, then `npm run e2e:remote -- conduit-mcp-install
    conduit-mcp-install-banner conduit-mcp-cursor-connect`, then `npm run e2e:remote`
    (`--affected`; any `electron/main.ts`/`preload.ts`/`test/e2e/` change already makes it full,
    `test/e2e/ci-affected.mjs:11-18`).
  - Locally, one e2e by exact name only: `npm run e2e -- conduit-mcp-install`.
  - Never narrow, skip or disable a check. Never pipe verify output through `tail`.
- **CI is ubuntu.** Unit tests never depend on win32 paths, `\`, drive letters or
  `process.platform`. Path code takes `platform: HostPlatform` as a parameter; win32 behaviour
  (case-insensitive Claude project keys) is tested by passing `'win32'` with POSIX-shaped fixtures.
- **Never touch the real user HOME in any test, e2e, sweep, S0 or QA.** Unit tests inject
  `homeDir`/`env`/`userDataDir` (`mkdtemp` dirs). E2E scenarios pass
  `env: { HOME, USERPROFILE, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CONFIG_HOME: '' }` with
  `HOME = USERPROFILE = <userDataDir>/home`. `repair()` never runs under `CONDUIT_E2E=1`.
  The visual sweeps get the same isolation (T5.5). S0/QA use scratch config dirs (S0, S6).
- **Comments explain WHY only.** Where the why is in the spec, a one-line pointer
  (`// spec 2026-10-27-conduit-mcp-install §3.5`). No `as any`, `@ts-ignore`, `!important`,
  swallowed errors or magic offsets. A caught error is either returned as an `errorCode` or logged.
- **Naming:**
  - Files kebab-case, named for their role; tests at `test/unit/<module-name>.test.ts[x]`.
  - React component tests start with `// @vitest-environment jsdom` and follow
    `test/unit/cursor-connect-row.test.tsx` (act + createRoot + `vi.mock('../../webview/bridge')`).
  - Exported constants `SCREAMING_SNAKE`, types `PascalCase`, functions `camelCase`.
  - Error codes are upper-case strings: OS codes pass through (`EPERM`, `EACCES`, `EBUSY`,
    `ENOSPC`); ours are `EJSON`, `EJSONC`, `ETOML`, `EUNEDITABLE`, `EGUARD`, `ESTATE`, `EPROJECT`;
    anything else `EINVAL`.
- **Node-free modules** (`src/conduit-mcp/install-types.ts`, `install-entries.ts`,
  `json-config.ts`, `toml-config.ts`, `client-info.ts`, `typed-command.ts`, `ui-types.ts`) import no
  `node:*` module.
- **Spawning git / watching dirs:** none here.
- **E2E:** launch only via `runScenario`/`launchElectron`, exit only via `finishScenario`; hidden
  and serial; writes into terminals through `typeLine`/`writeToTerminal`. Authoring tasks may run
  in parallel; running scenarios never does.
- **Strings:** all UI copy in `MCP_STR` (`webview/conduit-mcp-strings.ts`), under `MCP_STR.install`.
  CLI names are untranslated: `Claude Code`, `Codex`, `Cursor`, `OpenCode`.
- **User-facing changes:** `CHANGELOG.md` Unreleased entry (T5.6).
- **Stack (from the repo):** TypeScript, React 19, Electron 43, vitest, biome, esbuild, npm
  (`package-lock.json`). Gate commands from `package.json:13-40`.

## Out of scope

- Everything in spec §6 "v1" and "Out" (OpenCode notices, Cursor notices in shells, skills, New
  session row, ssh/WSL, Cursor project install, permission-file edits, uninstaller hooks).
- Per-session MCP tool switches for non-adapter sessions: `switchable`
  (`electron/conduit-mcp-host.ts:754-757`) stays adapter-only.
- Making shells wait for the endpoint: `whenLaunchReady` (`:848-859`) stays adapter-only, so a
  shell spawned before the endpoint listens stays tokenless until relaunched (spec §3.1).
- `src/protocol.ts`: no new variants (see staleness row 1).

## Contracts

### `src/conduit-mcp/install-types.ts` (new, node-free) — T1.1

```ts
export const AGENT_CLIS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];
/** Binary leaves per CLI; the first is the command the restart hint names. */
export const CLI_BINARIES: Readonly<Record<AgentCli, readonly string[]>>;
//   { claude: ['claude'], codex: ['codex'], cursor: ['agent', 'cursor-agent'], opencode: ['opencode'] }

export type UserInstallState = 'not-found' | 'not-installed' | 'installed' | 'other-conduit' | 'conflict' | 'error';
/** 'checking' and 'pending' are renderer row states and never cross IPC. */
export type ProjectScope = 'project' | 'local';
export type ProjectEntryState = 'ours' | 'other-conduit' | 'conflict' | 'error';
export interface UserInstall { state: UserInstallState; path: string; errorCode?: string; shadowedBy?: ProjectScope }
export interface ProjectEntry { scope: ProjectScope; state: ProjectEntryState; path: string; errorCode?: string }
export interface ProjectInstall { entries: ProjectEntry[]; installable: boolean; installPath: string | null }
export interface CliInstallStatus { cli: AgentCli; found: boolean; user: UserInstall; project: ProjectInstall | null }
/** clis in AGENT_CLIS order, always four. */
export interface McpInstallStatus { clis: CliInstallStatus[] }

export type McpInstallAction = 'install' | 'uninstall' | 'replace' | 'remove';
export interface McpInstallRequest {
  cli: AgentCli; scope: 'user' | 'project'; action: McpInstallAction;
  projectPath?: string;
  /** Required iff action === 'remove'. */
  entryScope?: ProjectScope;
}
export type McpInstallResult =
  | { ok: true; status: CliInstallStatus }
  | { ok: false; status: CliInstallStatus; errorCode: string };

export type ConfigErrorCode = 'EJSON' | 'EJSONC' | 'ETOML' | 'EUNEDITABLE' | 'EGUARD';
export class ConfigFormatError extends Error { constructor(readonly code: ConfigErrorCode, message: string) }

// Entry shapes (spec §3.4). Placeholders are literal strings.
export interface ClaudeEntry { type: 'stdio'; command: string; args: string[];
  env: { ELECTRON_RUN_AS_NODE: '1'; CONDUIT_SESSION_TOKEN: string; CONDUIT_MCP_ENDPOINT: string } }
export interface CodexEntry { command: string; args: string[]; env: { ELECTRON_RUN_AS_NODE: '1' };
  env_vars: string[]; default_tools_approval_mode: 'auto' }
export interface OpenCodeEntry { type: 'local'; command: string[];
  environment: { ELECTRON_RUN_AS_NODE: '1'; CONDUIT_SESSION_TOKEN: string; CONDUIT_MCP_ENDPOINT: string };
  enabled: true }

export type InstallDismissals = Partial<Record<AgentCli, true>>;
export function isAgentCli(v: unknown): v is AgentCli;
/** Keeps known CLIs whose value is exactly true; unknown keys and non-objects → {}. Never throws. */
export function coerceInstallDismissals(v: unknown): InstallDismissals;
/** null when cli/scope/action are not members, projectPath not a string when present, or remove lacks a valid entryScope. */
export function coerceInstallRequest(v: unknown): McpInstallRequest | null;
/** Some found CLI's user state is 'not-installed' (spec §2.6). */
export function needsSetup(s: McpInstallStatus): boolean;
```

### `src/conduit-mcp/install-entries.ts` (new, node-free) — T1.2

```ts
import type { CursorEntry } from './cursor-config';
export type ConduitEntry = ClaudeEntry | CodexEntry | CursorEntry | OpenCodeEntry;
export const SHIM_LEAF = 'conduit-mcp-shim.cjs';
/** Claude: env token "${CONDUIT_SESSION_TOKEN:-}", endpoint "${CONDUIT_MCP_ENDPOINT:-}".
 *  Codex: env_vars ['CONDUIT_SESSION_TOKEN','CONDUIT_MCP_ENDPOINT'].
 *  Cursor: cursorEntry(execPath, shimPath) (src/conduit-mcp/cursor-config.ts:32), unchanged.
 *  OpenCode: command [execPath, shimPath], "{env:CONDUIT_SESSION_TOKEN}", "{env:CONDUIT_MCP_ENDPOINT}". */
export function conduitEntry(cli: AgentCli, execPath: string, shimPath: string): ConduitEntry;
/** Spec §2.3 "Conduit shape": script leaf === SHIM_LEAF (last segment after '/' or '\\') at
 *  args[0] (claude/cursor/codex) or command[1] (opencode), AND identity forwarded the CLI's way:
 *  claude env holds both vars as "${VAR}" or "${VAR:-}"; cursor "${env:VAR}"; opencode
 *  environment "{env:VAR}"; codex env_vars includes both names. */
export function isConduitShaped(cli: AgentCli, entry: unknown): boolean;
export type EntryClass = 'absent' | 'ours' | 'other-conduit' | 'conflict';
/** undefined → absent; deepEqualConfig(entry, expected) → ours; isConduitShaped → other-conduit; else conflict. */
export function classifyEntry(cli: AgentCli, entry: unknown, expected: ConduitEntry): EntryClass;
/** The exe and shim an entry points at, for Repair; null where the shape has no string there. */
export function entryTargets(cli: AgentCli, entry: unknown): { command: string | null; shim: string | null };
/** Structural equality; Date instances (TOML datetimes) compare by getTime(); arrays by order; object key order ignored. */
export function deepEqualConfig(a: unknown, b: unknown): boolean;
```

### `src/conduit-mcp/json-config.ts` (new, node-free) — T1.3

```ts
export type JsonObject = Record<string, unknown>;
/** Strips one leading U+FEFF; whitespace-only text → {}. JSON.parse failure, or a non-object
 *  top level → throw ConfigFormatError('EJSON'). No comment/trailing-comma tolerance (JSONC → EJSON). */
export function parseJsonConfig(raw: string): JsonObject;
export function getPath(root: JsonObject, keys: readonly string[]): unknown;
/** New root; existing keys keep their position, new ones append; missing parents created as {};
 *  an existing non-object parent → throw ConfigFormatError('EJSON'). Does not mutate. */
export function setPath(root: JsonObject, keys: readonly string[], value: unknown): JsonObject;
/** Removes the leaf only; parents stay, even when empty ({}). No-op when absent. Does not mutate. */
export function deletePath(root: JsonObject, keys: readonly string[]): JsonObject;
/** JSON.stringify(root, null, 2) + '\n'. */
export function serializeJsonConfig(root: JsonObject): string;
```

### `src/conduit-mcp/toml-config.ts` (new, node-free; imports `smol-toml`) — T1.4

```ts
/** TOML basic string: '"' + escape('\\'→'\\\\', '"'→'\\"', U+0000–U+001F and U+007F → \uXXXX) + '"'. */
export function tomlBasicString(v: string): string;
/** '[mcp_servers.conduit]' then command, args, env (inline table), env_vars,
 *  default_tools_approval_mode, one key per line, joined with eol, ending in eol. */
export function renderCodexTable(e: CodexEntry, eol: '\n' | '\r\n'): string;
/** smol-toml parse → value at mcp_servers.conduit (undefined when absent). Parse failure → ConfigFormatError('ETOML'). */
export function readCodexConduit(text: string): unknown;
export type ConduitTableLocation =
  | { kind: 'absent' }
  | { kind: 'range'; start: number; end: number }   // line indices, [start, end)
  | { kind: 'uneditable' };
/** Spec §3.5 step 2: the owned range is the [mcp_servers.conduit] header plus immediately
 *  following [mcp_servers.conduit.*] subtables, up to the next other header (or EOF, trailing
 *  blank lines excluded). 'uneditable' when the parsed doc has mcp_servers.conduit but no such
 *  header exists, or conduit is also defined by dotted keys, inline under [mcp_servers],
 *  [[...]] arrays, or a non-contiguous subtable. Header keys are compared after trimming and
 *  unquoting each dotted segment. */
export function locateConduitTable(text: string): ConduitTableLocation;
/** entry ⇒ replace the owned range (absent ⇒ append, separated by one blank line); null ⇒ remove
 *  it. eol is detected from the text ('\r\n' iff the first line break is CRLF). Guard: re-parse the
 *  result; it must deep-equal (deepEqualConfig) the original parse with only mcp_servers.conduit
 *  changed to `entry` (or deleted), else throw ConfigFormatError('EGUARD'). 'uneditable' → throw
 *  ConfigFormatError('EUNEDITABLE'). Bytes outside the owned range are identical. */
export function spliceConduitTable(text: string, entry: CodexEntry | null): string;
```

### `src/conduit-mcp/client-info.ts` (new, node-free) — T1.5

```ts
import type { McpAdapterId } from './adapters';
export type ClientKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'fake' | 'agent';
/** S0 fills this; empty means Cursor's client is unmapped → 'agent' (spec D9). */
export const CURSOR_CLIENT_NAMES: readonly string[];
/** 'claude-code'→claude, 'codex-mcp-client'→codex, 'opencode'→opencode, CURSOR_CLIENT_NAMES→cursor,
 *  'conduit-e2e-fake'→fake only when opts.e2e; anything else (incl. non-strings) → 'agent'. Exact match. */
export function clientKindOf(name: unknown, opts: { e2e: boolean }): ClientKind;
/** claude|codex|cursor|fake → same id; opencode|agent → null (pull-only). */
export function noticeAdapterIdOf(kind: ClientKind): McpAdapterId | null;
/** Spec §2.4: def ?? noticeAdapterIdOf(newest live kind) ?? null. liveKinds is oldest→newest. */
export function pickNoticeAdapterId(def: McpAdapterId | undefined, liveKinds: readonly ClientKind[]): McpAdapterId | null;
/** undefined: the line is not a JSON-RPC request with method 'initialize' (or not JSON).
 *  string: params.clientInfo.name. null: an initialize without a string name. */
export function initializeClientName(line: string): string | null | undefined;
```

### `src/conduit-mcp/typed-command.ts` (new, node-free) — T1.6

```ts
export const DETECT_GRACE_MS = 15_000;
/** Spec §2.5 skip list, compared case-insensitively against the second token. */
export const NON_INTERACTIVE_ARGS: readonly string[];
//   ['--version','-v','--help','-h','mcp','update','doctor','login','logout','config','exec','-p','--print','run']
export interface TypedLineTracker { /** Candidates for each Enter in data, in order. */ feed(data: string): AgentCli[] }
/** Printable (≥ U+0020, ≠ U+007F) appends; '\x7f' and '\b' delete one; '\x03' and '\x15' clear to
 *  an empty known line; '\x1b' or '\t' anywhere mark the line unknown until the next Enter;
 *  '\r' or '\n' ends the line: a known line is classified, then the line resets to empty-known. */
export function createTypedLineTracker(): TypedLineTracker;
/** First token (a leading "…" or '…' token is unquoted); leaf after the last '/' or '\\'; strip
 *  .exe/.cmd/.ps1/.bat (case-insensitive); lower-case; claude→claude, codex→codex,
 *  agent|cursor-agent→cursor, opencode→opencode; null when the second token ∈ NON_INTERACTIVE_ARGS
 *  or the first token isn't one of those. */
export function agentCliOfLine(line: string): AgentCli | null;
```

### `src/settings.ts` — T1.7

`AppSettings` gains `mcpInstallSuggest: boolean` and `mcpInstallPromptDismissed: InstallDismissals`
(beside `mcpTools`, `src/settings.ts:189`). `DEFAULT_SETTINGS`: `true` and `{}` (near `:249-250`).
`coerceSettings` (`:412`, beside `:532-533`): `bool(payload.mcpInstallSuggest, true)` and
`coerceInstallDismissals(payload.mcpInstallPromptDismissed)`.

### Shim — T1.8

`resources/conduit-mcp/conduit-mcp-shim.cjs:56`: `serverInfo: { name: 'conduit', version: 'fallback' }`.

### `electron/config-file-io.ts` (new) — T2.1

```ts
export type ConfigIo = Pick<typeof fs, 'existsSync' | 'lstatSync' | 'statSync' | 'chmodSync' | 'realpathSync'
  | 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'copyFileSync' | 'renameSync' | 'unlinkSync' | 'linkSync'>;
export interface ConfigRead {
  /** null ⇔ the file (lstat) does not exist. BOM stripped. */
  text: string | null;
  raw: Buffer | null;
  /** realpath when it exists, else the given path. */
  realPath: string;
  bom: boolean;
  mode?: number;          // st.mode & 0o7777
  mtimeMs?: number;
  size?: number;
}
export function readConfigFile(io: ConfigIo, filePath: string): ConfigRead;
/** Creates the parent dir; temp `${target}.tmp-${pid}-${seq}` in the same dir with `mode`
 *  (0o666 when undefined) then chmod, then rename; unlinks the temp on failure and rethrows. */
export function writeConfigAtomic(io: ConfigIo, target: string, data: string, mode?: number): void;
/** No-op when backupPath exists. Else exclusive create (link from a 'wx' temp, COPYFILE_EXCL
 *  fallback); EEXIST from a concurrent creator is success; other failures throw. original null
 *  ⇒ the text 'null'. Creates the parent dir. */
export function backupOnce(io: ConfigIo, backupPath: string, original: Buffer | null): void;
/** error.code when a string, ConfigFormatError.code, else 'EINVAL'. */
export function errorCodeOf(error: unknown): string;
```

### `electron/mcp-install-targets.ts` (new) — T2.2

```ts
export interface TargetEnv { homeDir: string; env: Readonly<Record<string, string | undefined>>; userDataDir: string; platform: HostPlatform }
export interface ConfigTarget {
  cli: AgentCli;
  scope: 'user' | ProjectScope;
  path: string;                 // the file shown in the row and edited
  format: 'json' | 'toml';
  keys: readonly string[];      // JSON key path to the conduit entry; TOML is always mcp_servers.conduit
  backupPath: string;
  mtimeGuard: boolean;          // true only for Claude's user file (user and local scope)
}
/** '' counts as unset for every env var.
 *  claude:  $CLAUDE_CONFIG_DIR/.claude.json else ~/.claude.json, ['mcpServers','conduit']
 *  codex:   $CODEX_HOME/config.toml else ~/.codex/config.toml
 *  cursor:  ~/.cursor/mcp.json, ['mcpServers','conduit']
 *  opencode:$XDG_CONFIG_HOME/opencode/opencode.json else ~/.config/opencode/opencode.json, ['mcp','conduit']
 *  backupPath = `${path}.conduit-backup` */
export function userTarget(cli: AgentCli, t: TargetEnv): ConfigTarget;
/** claude <root>/.mcp.json ['mcpServers','conduit']; codex <root>/.codex/config.toml;
 *  cursor <root>/.cursor/mcp.json ['mcpServers','conduit']; opencode <root>/opencode.json ['mcp','conduit'].
 *  backupPath = join(userDataDir, 'mcp-install-backups', sha256(folderKey(root)).slice(0,16),
 *  `${relative path with '/' and '\\' → '__'}.conduit-backup`). */
export function projectTarget(cli: AgentCli, root: string, t: TargetEnv): ConfigTarget;
/** Claude local scope: the key of userJson.projects matching root, or null. Match: both sides with
 *  '\\'→'/', trailing '/' removed, lower-cased when platform === 'win32'. keys =
 *  ['projects', <exact key found>, 'mcpServers', 'conduit']; path/backup = the Claude user file's. */
export function claudeLocalTarget(root: string, userJson: JsonObject, t: TargetEnv): ConfigTarget | null;
/** Paths whose existence marks the CLI as found (spec §2.3): claude: the user file, the config dir
 *  ($CLAUDE_CONFIG_DIR or ~/.claude); codex: $CODEX_HOME or ~/.codex; cursor: ~/.cursor;
 *  opencode: the opencode config dir. */
export function foundMarkers(cli: AgentCli, t: TargetEnv): string[];
/** opencode only: the sibling opencode.jsonc of the user file (its presence ⇒ user state error EJSONC). */
export function openCodeJsoncPath(t: TargetEnv): string;
export function installableInProject(cli: AgentCli): boolean;  // false only for cursor
```

### `electron/mcp-install.ts` (new) — T2.3 (`readCursorLaunchEntry` moves here in T4.9)

```ts
export interface McpInstallDeps extends TargetEnv {
  execPath: string;
  shimPath: string;
  /** Any of CLI_BINARIES[cli] resolves on PATH (main: resolveCommand, src/shells.ts:38). */
  onPath(cli: AgentCli): boolean;
  /** The session home equal (folderKey) to projectPath, or null (spec §3.6 no arbitrary-path oracle). */
  knownHome(projectPath: string): string | null;
  io?: ConfigIo;
}
export interface McpInstall {
  status(projectPath: string | null): McpInstallStatus;
  act(req: McpInstallRequest): McpInstallResult;
  userState(cli: AgentCli): UserInstallState;
  /** Rewrites dead other-conduit user entries (D2 ruling); one row per rewrite or failure. */
  repair(): { cli: AgentCli; path: string; errorCode?: string }[];
}
export function createMcpInstall(deps: McpInstallDeps): McpInstall;
```

Behaviour, per CLI, each computed independently (one CLI's failure is its own `error`):
- `found = onPath(cli) || foundMarkers(cli).some(existsSync)`. Not found ⇒ `user.state =
  'not-found'`, file not read.
- User state: read → parse (`parseJsonConfig` / `readCodexConduit` + `locateConduitTable`
  'uneditable' ⇒ `EUNEDITABLE`) → `classifyEntry` → `absent→not-installed`, `ours→installed`,
  `other-conduit`, `conflict`; any throw ⇒ `error` + `errorCodeOf`. OpenCode with
  `openCodeJsoncPath` present ⇒ `error` `EJSONC`.
- Project (only when `knownHome(projectPath)` returns a root): entries from `projectTarget` and, for
  Claude, `claudeLocalTarget`; a present entry maps `ours|other-conduit|conflict`, a parse failure
  `error`; `installable = installableInProject(cli) && no 'project'-scope entry`;
  `installPath = installable ? projectTarget(...).path : null`.
- `shadowedBy` (claude, codex only): the first project entry whose state isn't `ours`, `local`
  before `project`.
- Valid actions (anything else ⇒ `{ok:false, errorCode:'ESTATE'}`, nothing written):

  | scope / action | from state | effect |
  |---|---|---|
  | user `install` | `not-installed`, `other-conduit` | set entry |
  | user `install` | `installed` | no-op `{ok:true}`, no backup touched |
  | user `replace` | `conflict` | set entry |
  | user `uninstall` | `installed`, `other-conduit` | delete entry |
  | project `install` | `installable` | set entry in `projectTarget` |
  | project `remove` + `entryScope` | that entry `ours` / `other-conduit` | delete it |

  A project action with an unknown `projectPath` ⇒ `EPROJECT`. `not-found` ⇒ `ESTATE` (D10).
- Write path (spec §3.5): `readConfigFile` → `backupOnce(target.backupPath, read.raw)` → mutate →
  serialize (JSON via `serializeJsonConfig`, BOM dropped; TOML via `spliceConduitTable`, BOM
  re-prefixed when `read.bom`) → if `target.mtimeGuard`: `statSync(realPath)`; mtime or size
  differs from the read ⇒ re-read and re-apply once, re-check; differs again ⇒ `EBUSY`, nothing
  written → `writeConfigAtomic(realPath, data, read.mode)` → re-read for the result `status`.
- `repair()`: for each found CLI whose user state is `other-conduit`: `entryTargets`; if
  `command` or `shim` is a string that does not `existsSync`, run the user `install` write path.

### `src/conduit-mcp/ui-types.ts` — T3.3

```ts
import type { AgentCli, UserInstallState } from './install-types';
export interface McpNotConnected {
  cli: AgentCli;
  /** The user install state read when this was raised, and on onInstallChanged. */
  install: UserInstallState;
  /** Host launch counter of that session; the banner's once-per-PTY-generation key. */
  launch: number;
  reason: 'no-initialize' | 'cursor-not-connected';
}
// McpUiState gains (only while messaging is on; {} otherwise):
  notConnected: Record<string, McpNotConnected>;   // by sessionId
```

### `electron/conduit-mcp-host.ts` — T3.1, T3.2, T3.3, T4.9

```ts
// ConduitMcpHostDeps gains (T3.3):
  installState(cli: AgentCli): UserInstallState;
  /** Default DETECT_GRACE_MS. */
  detectGraceMs?: number;
// ConduitMcpHost gains (T3.3):
  /** Re-reads installState for every notConnected entry; broadcasts on change. */
  onInstallChanged(): void;
// Runtime (L159-170): `adapter` → `defAdapter: McpAdapter | undefined`; gains
  launch: number;                            // ++ in every prepareLaunch
  size: { cols: number; rows: number } | undefined;
  tracker: TypedLineTracker | undefined;     // only for token-bearing non-adapter sessions
  detect: { cli: AgentCli; at: number } | undefined;
  notConnected: McpNotConnected | undefined;
// closure (T3.1): connKinds = new Map<number, { kind: ClientKind; seq: number }>(); let connSeq = 0;
const claimHandle: (sessionId: string, prefix: string) => Handle | null;   // was (sessionId, adapter)
const noticeAdapterOf: (sessionId: string) => McpAdapter | null;           // T3.2
```

Invariants:
- `prepareLaunch` for a non-adapter session with messaging on and the endpoint ready returns
  `{...spec, env: {...spec.env, CONDUIT_SESSION_TOKEN: token, CONDUIT_MCP_ENDPOINT:
  deps.endpointPath}}`, args unchanged, no handle, no config file, no `unavailable`. Messaging off
  or endpoint down ⇒ `spec` unchanged and no card state.
- A handle exists before the `initialize` reply leaves (`claimHandle` runs before
  `core.handleLine`). A `launch-io` failure there leaves the session handle-less; its calls stay
  `not_in_session` (`:579-584`), as today.
- `directory()` (`:309-326`) `agent` = the newest live connection's kind, else
  `handlePrefix(handle)`.
- Badge `gate` (`:712-733`): `unavailable` ⇒ null; `noticeAdapterOf` null and no live connection
  and no `defAdapter` ⇒ null; `noticeAdapterOf` null or not notifiable ⇒ `'pull-only'`; then paused,
  then `r.gate`.
- A typed candidate is ignored while `registry.isLive(sessionId)` (Decisions Needed).

### `electron/main.ts` — T3.4, T4.9

- Before `createConduitMcpHost` (`:1908`):
  `const mcpInstall = createMcpInstall({ homeDir: os.homedir(), env: process.env, userDataDir:
  userData(), platform: hostPlatform, execPath: process.execPath, shimPath: mcpShimPath(), onPath:
  (cli) => CLI_BINARIES[cli].some((b) => resolveCommand(b, hostPlatform) !== undefined),
  knownHome: (p) => { const k = folderKey(p); return mgr.list().find((s) => folderKey(s.home) ===
  k)?.home ?? null; } })`. Then, unless `process.env.CONDUIT_E2E === '1'`, `for (const r of
  mcpInstall.repair()) log.info|warn('mcp-install', 'repair', r)`.
- Host deps: `installState: (cli) => mcpInstall.userState(cli)`, `detectGraceMs:
  process.env.CONDUIT_E2E === '1' && process.env.CONDUIT_E2E_DETECT_GRACE_MS ?
  Number(process.env.CONDUIT_E2E_DETECT_GRACE_MS) : undefined`.
- Handlers beside `skills-install` (`:4933-4937`):
  `ipcMain.handle('mcpInstall:status', (_e, p: unknown) => mcpInstall.status(typeof p === 'string'
  ? p : null))`; `ipcMain.handle('mcpInstall:act', (_e, v: unknown) => { const req =
  coerceInstallRequest(v); if (!req) throw new Error('invalid mcpInstall request'); const r =
  mcpInstall.act(req); if (r.ok) mcpHost.onInstallChanged(); return r; })`.

### Preload / bridge — T3.4

```ts
// electron/preload.ts, beside `skills`:
mcpInstall: {
  status: (projectPath: string | null): Promise<McpInstallStatus> => ipcRenderer.invoke('mcpInstall:status', projectPath),
  act: (req: McpInstallRequest): Promise<McpInstallResult> => ipcRenderer.invoke('mcpInstall:act', req),
},
// webview/bridge.ts: HostBridge gains the same `mcpInstall` member; exports:
export function mcpInstallStatus(projectPath: string | null): Promise<McpInstallStatus>;
//   no host ⇒ four CLIs, each {found:false, user:{state:'not-found', path:''}, project:null}
export function mcpInstallAct(req: McpInstallRequest): Promise<McpInstallResult>;
//   no host ⇒ {ok:false, status: <that CLI's not-found status>, errorCode:'ENOSYS'}
```

### Renderer — T4.1–T4.8

```ts
// webview/use-mcp-install.ts (new)
export interface McpInstallApi {
  status: McpInstallStatus | null;     // null while the first read is in flight
  refresh(): void;                     // re-reads all four (Check again)
  /** Replaces that CLI's slot with result.status; resolves null when the invoke rejected. */
  act(req: McpInstallRequest): Promise<McpInstallResult | null>;
}
export function useMcpInstall(projectPath: string | null): McpInstallApi;  // reads on mount and when projectPath changes

// webview/components/mcp-install-row.tsx (new)
export interface McpInstallRowProps {
  cli: AgentCli;
  status: CliInstallStatus | null;      // null ⇒ 'checking'
  onAct(req: McpInstallRequest): Promise<McpInstallResult | null>;
  onRecheck(): void;
  /** Focus the row's first enabled button once on mount (opened "at that CLI"). */
  focusOnMount?: boolean;
}
export function McpInstallRow(p: McpInstallRowProps): JSX.Element;

// webview/components/mcp-project-entries.tsx (new)
export function McpProjectEntries(p: { status: McpInstallStatus | null; projectPath: string;
  onAct(req: McpInstallRequest): Promise<McpInstallResult | null> }): JSX.Element;

// webview/mcp-card-status.ts (new, pure)
export type CardMcpStatus =
  | { kind: 'connected'; handle: Handle }
  | { kind: 'not-connected'; cli: AgentCli; install: UserInstallState };
/** null when !enabled; unavailable reasons other than cursor-not-connected win (existing warning);
 *  then not-connected (nc present); then connected (badge.connected); else null. */
export function cardMcpStatus(badge: McpSessionBadge | undefined, nc: McpNotConnected | undefined, enabled: boolean): CardMcpStatus | null;

// webview/mcp-setup-banner-model.ts (new, pure)
export function bannerKey(sessionId: string, nc: McpNotConnected): string;   // `${sessionId}:${nc.cli}:${nc.launch}`
export interface BannerLedger { has(key: string): boolean; mark(key: string): void }
export function createBannerLedger(): BannerLedger;
export const BANNER_LEDGER: BannerLedger;                                    // module singleton
export function shouldOfferBanner(i: { nc: McpNotConnected | undefined; messagingOn: boolean;
  suggest: boolean; dismissed: InstallDismissals; otherBannerShowing: boolean; seen: boolean }): boolean;
//   true ⇔ nc && messagingOn && suggest && !dismissed[nc.cli] && nc.install === 'not-installed'
//          && !otherBannerShowing && !seen

// webview/components/mcp-setup-banner.tsx (new)
export function McpSetupBanner(p: { session: Session; nc: McpNotConnected | undefined;
  messagingOn: boolean; onOpenMcpSettings(cli: AgentCli): void }): JSX.Element | null;

// webview/icons.tsx
export const IconPlug: Icon; export const IconUnplug: Icon;   // glyph('plug' | 'unplug', …)

// webview/components/settings-modal.tsx
type Tab = 'general' | 'mcp' | 'appearance' | 'shortcuts' | 'skills' | 'about';
// SettingsModal props gain: initialCli?: AgentCli

// webview/components/session-card.tsx: props gain `mcpLink?: CardMcpStatus | null`
// webview/components/sidebar.tsx: props gain `mcpNotConnected: Readonly<Record<string, McpNotConnected>>`, `mcpEnabled: boolean`
// webview/components/center-pane.tsx: props gain `mcpNotConnected`, `mcpEnabled: boolean`, `onOpenMcpSettings(cli: AgentCli): void`
// webview/app.tsx: openSettingsAt(tab: SettingsTab, cli?: AgentCli)
```

CSS classes (all added in T4.8): `.mcp-install-row`, `__status`, `__path`, `__note`,
`__actions`; `.mcp-project`, `__entry`, `__warn`; `.mcp-banner` (same in-flow geometry as
`.scope-banner`, `webview/styles.css:9590-9664`), `__msg`, `__actions`; `.session__mcp-link`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| PTY env token + endpoint for every session | `prepareLaunch` (T3.1) | `pty.start` env (`src/pty-host.ts:117`, unchanged); CLI config expansion → shim; `sanitizeChildEnv` strips both for a nested Conduit (`src/pty-host.ts:61-62`, unchanged); every child process (threat model, recorded) | Both. Strip measured unchanged |
| Handle for non-adapter sessions | `claimHandle` at `initialize` (T3.1) | `directory`/`list_sessions`, `badgeOf`/`uiState` (card meta `MCP_STR.cardMeta`, `webview/components/session-card.tsx:87`), compose targets (`webview/conduit-mcp-view-model.ts:69`), notifier, `sessions.json` (`mcpHandle` round-trips via spread, `src/persistence.ts:99-110`) | Both; every consumer reads `mcpHandle` regardless of how it was set |
| `claimHandle` signature | T3.1 | `prepareLaunch` (`:869`, now `adapter.id`), control-tools claim (`:512-516`, now `adapter.id`), new initialize hook | All three in T3.1 |
| Notice adapter | `noticeAdapterOf` (T3.2) | `evaluate` `:357-358`, `submitNotice` `:445`, `confirmSubmit` call `:464-468`, `notifierSessions` `:524`, `badgeOf` `:719`, `onSpawn` `:915` | All six in T3.2 |
| Screen model start | `onSpawn` (adapters, unchanged) / initialize hook (lazy, T3.2) | `screenOf` → gate; `onOutput` feeds (`:922`, no-op without a term); `onExit`/`onSessionDeleted` dispose (`:935`, `:955`) | Both |
| `isInitialize` removal | T3.1 replaces with `initializeClientName` | `:661` only (grep `isInitialize`: definition `:1096` + one use) | Both |
| Typed candidate → `notConnected` | `onRendererInput` → tracker → `tick` (T3.3) | `uiState.notConnected` → card (T4.4), banner (T4.5), card menu (T4.7) | Both. `onRendererInput` is fed by `term:input` (`electron/main.ts:4503`) and e2e `typeLine` (`test/e2e/harness.mjs:986`) |
| `McpUiState.notConnected` (type widening) | `uiState()` (T3.3) | Typed literals that must gain `notConnected: {}`: `webview/bridge.ts:629-639`, `test/unit/conduit-mcp-view-model.test.ts:32-41`, `test/unit/messages-pane.test.tsx:60-69` (all in T3.3); readers: `sidebar.tsx`, `center-pane.tsx`, `app.tsx` (T4.4, T4.5, T4.7). No `.mjs` builds an `McpUiState` (grep `switchable` in `test/e2e`: none) | Both |
| `cursor-not-connected` | `prepareLaunch` (`:878-880`) now also sets `r.notConnected` (T3.3) | card indicator + tooltip, banner (Install = Install Cursor), `MCP_STR.unavailable` copy (T4.1: "Install Conduit for Cursor in Settings → MCP") | Both |
| Install state | `mcpInstall.act` (T2.3), the user, and the CLIs themselves (Claude rewrites `~/.claude.json`) | MCP tab, banner, card copy, Messages empty state, host `installState` | **Producer partly outside our control** — mitigated by re-read on every use, the mtime guard and S0 D1 |
| Cursor launch wiring | `readCursorLaunchEntry` (moved, unchanged logic, T4.9) | `prepareLaunch` `:878` | Both; the import moves from `./cursor-connect` to `./mcp-install` |
| Shim fallback `initialize` | shim (T1.8) | every CLI outside Conduit; `test/unit/conduit-mcp-shim.test.ts:190-200` | Both |
| `cursor-connect:*` removal | T4.9 | `electron/main.ts:278,1949-1953,4939-4942`; `electron/preload.ts:2,54-62`; `webview/bridge.ts:4,77-79,176-192`; `webview/components/cursor-connect-row.tsx`; `webview/components/settings-modal.tsx:38,1008`; `test/unit/cursor-config.test.ts`; `test/unit/cursor-connect-row.test.tsx`; `test/unit/settings-mcp-tools.test.tsx:17`; `test/e2e/conduit-mcp-cursor-connect.e2e.mjs:31,40` (T5.4); `webview/styles.css:7441,7588-7609` (T4.8) | All, across T4.8, T4.9, T5.4 |
| Settings `mcpInstallSuggest` / `mcpInstallPromptDismissed` | MCP tab toggle (T4.3), banner "Don't suggest again" (T4.5) → `updateSettings` → `coerceSettings` (T1.7) | banner (T4.5); renderer settings hydrate (whole object, `webview/settings.tsx`, unchanged) | Both |
| MCP master + tool switches location | moved General → MCP tab (T4.3) | `test/unit/settings-mcp-tools.test.tsx` (opens with `initialTab="mcp"`), text-fit `mcp-tools` scene (`test/e2e/visual/text-fit-sweep.mjs:263`, T5.5) | Both |
| Messages `onOpenSettings` target | `webview/app.tsx:4599` (T4.7) | messages-pane off-state button (`messages-pane.tsx:197`) and new CTA | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/install-types.ts` | create | CLI catalog, install wire types, entry shapes, `ConfigFormatError`, coercions, `needsSetup` |
| `src/conduit-mcp/install-entries.ts` | create | Per-CLI entry builder, Conduit-shape test, classification, Repair targets |
| `src/conduit-mcp/json-config.ts` | create | Strict JSON config parse, key-path edits, serialize |
| `src/conduit-mcp/toml-config.ts` | create | Codex TOML: basic strings, table render, owned range, guarded splice |
| `src/conduit-mcp/client-info.ts` | create | `clientInfo` → client kind → notice adapter; initialize parser |
| `src/conduit-mcp/typed-command.ts` | create | Typed-line tracker and CLI-line classifier |
| `electron/config-file-io.ts` | create | Realpath read, mode-preserving atomic write, first-write backup |
| `electron/mcp-install-targets.ts` | create | Config file, key path and backup path per CLI and scope |
| `electron/mcp-install.ts` | create | Install status/act/userState/repair; `readCursorLaunchEntry` (T4.9) |
| `webview/use-mcp-install.ts` | create | Renderer read/act hook |
| `webview/components/mcp-install-row.tsx` | create | One CLI's user-scope row incl. Replace confirm |
| `webview/components/mcp-project-entries.tsx` | create | Project section: entries, Remove, Install for this project |
| `webview/mcp-card-status.ts` | create | Card indicator derivation |
| `webview/mcp-setup-banner-model.ts` | create | Banner show rule, key, ledger |
| `webview/components/mcp-setup-banner.tsx` | create | The discovery banner |
| `test/e2e/fixtures/fake-agent-cli.mjs` | create | Fake CLI that reads Claude's config by Claude's rules |
| `test/e2e/conduit-mcp-install.e2e.mjs` | create | Install → shell CLI connects → message → uninstall |
| `test/e2e/conduit-mcp-install-banner.e2e.mjs` | create | Detection → not-connected → banner → Don't suggest again |
| `docs/runs/2026-10-27-mcp-install/s0.md` | create | S0 measurements |
| `docs/runs/2026-10-27-mcp-install/qa.md` | create | Runtime QA with real CLIs |
| `test/unit/install-types.test.ts`, `install-entries.test.ts`, `json-config.test.ts`, `toml-config.test.ts`, `client-info.test.ts`, `typed-command.test.ts`, `config-file-io.test.ts`, `mcp-install-targets.test.ts`, `mcp-install.test.ts`, `mcp-install-row.test.tsx`, `mcp-project-entries.test.tsx`, `mcp-card-status.test.ts`, `mcp-setup-banner.test.tsx`, `settings-mcp-tab.test.tsx` | create | Unit tests (all under `test/unit/`) |
| `package.json`, `package-lock.json` | modify | `smol-toml` 1.3.1 exact |
| `src/settings.ts` | modify | Two settings |
| `resources/conduit-mcp/conduit-mcp-shim.cjs` | modify | Fallback `serverInfo.version` |
| `src/conduit-mcp/ui-types.ts` | modify | `McpNotConnected`, `McpUiState.notConnected` |
| `src/conduit-mcp/cursor-config.ts` | modify | Keep `CursorEntry`, `cursorEntry`, `wiresLaunch`, placeholders; delete the rest (T4.9) |
| `src/conduit-mcp/adapters.ts`, `test/unit/conduit-mcp-adapters.test.ts` | modify (conditional) | Claude project-approval blocking pattern + fixture case, only if S0 measures it unmatched (T3.2) |
| `electron/conduit-mcp-host.ts` | modify | Env for all, lazy handles, client kinds, notice adapter, screen at init, detection, `notConnected` |
| `electron/main.ts` | modify | `mcpInstall`, Repair, IPC, host deps (T3.4); remove Cursor connect (T4.9) |
| `electron/preload.ts`, `webview/bridge.ts` | modify | `mcpInstall` bridge (T3.4); remove Cursor connect (T4.9); bridge mock `notConnected` (T3.3) |
| `electron/cursor-connect.ts` | delete | Replaced by `electron/mcp-install.ts` + `electron/config-file-io.ts` (T4.9) |
| `webview/components/cursor-connect-row.tsx`, `test/unit/cursor-connect-row.test.tsx` | delete | Replaced by the MCP tab rows (T4.9) |
| `webview/conduit-mcp-strings.ts` | modify | `MCP_STR.install.*`; cursor copy; remove `cursor*` keys (T4.1; removals in T4.9) |
| `webview/icons.tsx` | modify | `IconPlug`, `IconUnplug` |
| `webview/components/settings-modal.tsx` | modify | MCP tab; MCP group leaves General |
| `webview/components/session-card.tsx`, `webview/components/sidebar.tsx` | modify | Indicator; pass-through |
| `webview/components/center-pane.tsx` | modify | Mount `McpSetupBanner` |
| `webview/components/messages-pane.tsx` | modify | Empty-state CTA |
| `webview/app.tsx` | modify | Tab union, `openSettingsAt(tab, cli)`, palette, card menu, props |
| `webview/styles.css` | modify | New classes; remove `.cursor-connect-row*`, `.set__control--cursor` |
| `test/e2e/conduit-mcp-helpers.mjs` | modify | `isolatedHome`, `FAKE_CLI`, `cliRecords`, `openMcpSettings` |
| `test/e2e/conduit-mcp-cursor-connect.e2e.mjs` | modify | New tab and button names; status via `window.agentDeck.mcpInstall` |
| `test/e2e/visual/text-fit-sweep.mjs`, `test/e2e/visual/shoot.mjs` | modify | Isolated home env; MCP tab navigation |
| Existing tests: `test/unit/conduit-mcp-host.test.ts`, `conduit-mcp-shim.test.ts`, `coerce-settings.test.ts`, `cursor-config.test.ts`, `settings-mcp-tools.test.tsx`, `session-card.test.ts`, `messages-pane.test.tsx`, `conduit-mcp-view-model.test.ts` | modify | Follow the changed contracts + new cases |
| `CHANGELOG.md`, `docs/specs/2026-10-25-conduit-mcp-server.md` (§3.1), `docs/specs/2026-10-26-conduit-mcp-cursor.md` (§3.1), `docs/specs/2026-10-27-conduit-mcp-install.md` (status) | modify | Docs (T5.6) |

## Scripts

- **S0/QA scratch env (one-off):** `%TEMP%\claude-scratch\mcp-install-s0\env.ps1 -Root <dir>` sets
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR` to subdirs of
  `<dir>` for the current pwsh. It replaces re-typing four variables per probe and is the guard
  that keeps every probe off the real config files. Delete after S6.
- **TOML fixture corpus (durable, inside the test):** `test/unit/toml-config.test.ts` holds a
  table of `{name, input, expected | errorCode}` cases driven by one `it.each`, not one hand-written
  test per form.
- No durable scripts: no edit repeats across more than a handful of files.

## Slices

Order: S1 → S2 → S3 → S4 → S5 → S6. **S0 is independent** of S1–S5: it needs the real Claude,
Codex, Cursor and OpenCode CLIs on the human's machine, never CI. Its outputs flip three local
switches; if S0 hasn't run by then, the defaults hold: `CURSOR_CLIENT_NAMES = []` (T1.5), no new
Claude blocking pattern (T3.2), Claude user writes stay direct (T2.3). **S6** (runtime QA) runs
after S5 with the built app.

**Shared-file serialization** (every file below has one owner per slice; slices run in order):
- `electron/conduit-mcp-host.ts`: T3.1 → T3.2 → T3.3 (S3 serial lane); T4.9 (one import line, S4
  serial lane, last).
- `electron/main.ts`, `electron/preload.ts`, `webview/bridge.ts`: T3.4 (S3); T4.9 (S4). T3.3 also
  edits `webview/bridge.ts` (mock `notConnected: {}`), before T3.4 in the same serial lane.
- `src/conduit-mcp/ui-types.ts`: T3.3 only.
- `webview/app.tsx`: T4.7 only. `webview/components/settings-modal.tsx`: T4.3 only (T4.9 removes
  nothing there, T4.3 already dropped the Cursor row).
- `webview/conduit-mcp-strings.ts`, `webview/icons.tsx`: T4.1 (S4 serial first); T4.9 deletes the
  unused `cursor*` keys.
- `webview/styles.css`: T4.8 only.
- `src/settings.ts`: T1.7. `package.json`/`package-lock.json`: T1.4.
- `test/e2e/conduit-mcp-helpers.mjs`: T5.1. `CHANGELOG.md`: T5.6.
- `src/protocol.ts`: **not edited.**

---

### Slice 0: Measure real CLIs (independent)

**Check:** `docs/runs/2026-10-27-mcp-install/s0.md` exists with one row per question below and a
**Decisions** section that sets `CURSOR_CLIENT_NAMES`, the Claude approval pattern (or "none"),
and D1 (direct edit holds / switch to `claude mcp`).

**Parallel groups:** G1: T0.1 (independent of every other slice)
**Claims:** none

#### Task 0.1: Probe D1 and D9

**Files:** Create `docs/runs/2026-10-27-mcp-install/s0.md`. Scratch:
`%TEMP%\claude-scratch\mcp-install-s0\` (env script + config dirs), deleted after S6.

**Steps:**
- [ ] Never touch `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.config/opencode`. Every probe runs
  in a pwsh with the scratch env script dot-sourced; record `echo $env:CLAUDE_CONFIG_DIR` etc. in
  `s0.md` before the first probe. Cursor reads `~/.cursor/mcp.json` only from the home dir, so
  Cursor probes run with `$env:USERPROFILE` and `$env:HOME` pointed at a scratch dir in that one
  shell.
- [ ] **D1:** with a `conduit` entry absent from the scratch `.claude.json`, start interactive
  `claude`, then write the entry into that file with the T2.3 algorithm reproduced by hand (a
  `node -e` that reads, sets `mcpServers.conduit`, writes via temp+rename). Complete one turn,
  `/exit`, and check the key survived. Claude needs auth in a scratch config dir: use
  `ANTHROPIC_API_KEY` if set; otherwise copy only `.credentials.json` into the scratch dir and
  delete it with the dir. If neither works, record "not measured" (default holds).
- [ ] **Cursor `clientInfo.name`:** a logging stdio server (`node -e` that appends the
  `initialize` params to a file) registered in the scratch `~/.cursor/mcp.json`; run `agent`;
  record the name.
- [ ] **Claude dedupe:** scratch user entry `conduit` + `claude --mcp-config <file with conduit>`;
  record `/mcp` listing (one or two `conduit`).
- [ ] **Codex table + `-c`:** scratch `config.toml` with the §3.4 table; `codex exec` with the
  per-launch `-c mcp_servers.conduit.*` flags (`src/mcp-launch.ts:41-59`); record that it starts
  and which values win.
- [ ] **OpenCode:** where it reads the global config on Windows (XDG path vs `%APPDATA%`), and
  whether `<root>/opencode.json` is discovered.
- [ ] **Claude project approval:** a `<root>/.mcp.json` `conduit` entry; screenshot the text of the
  approval prompt; test each line against `MCP_ADAPTERS` claude `screen.blocking`
  (`src/conduit-mcp/adapters.ts:41-53`); record matched / the exact unmatched line.
- [ ] Write `s0.md`: a table per question, then **Decisions**.

---

### Slice 1: Pure cores

**Check:**
- `npx vitest run test/unit/install-types.test.ts test/unit/install-entries.test.ts test/unit/json-config.test.ts test/unit/toml-config.test.ts test/unit/client-info.test.ts test/unit/typed-command.test.ts test/unit/coerce-settings.test.ts test/unit/conduit-mcp-shim.test.ts`
  is green;
- `npm run typecheck` is green; `npm run verify:quick` is green.

**Parallel groups:** Serial (first): T1.1 · G1: T1.2 · G2: T1.3 · G3: T1.5 · G4: T1.6 · G5: T1.8 ·
Serial: T1.4, T1.7
**Claims (serial lane):** `package.json`, `package-lock.json` (T1.4); `src/settings.ts` (T1.7)

#### Task 1.1: `src/conduit-mcp/install-types.ts`

**Files:** Create `src/conduit-mcp/install-types.ts`; test `test/unit/install-types.test.ts`.

**Interfaces:** Produces the whole `install-types.ts` block in Contracts.

**Steps:**
- [ ] Failing tests:
  - 'AGENT_CLIS order is claude, codex, cursor, opencode';
  - 'coerceInstallDismissals keeps known true, drops false/unknown/non-object' —
    `coerceInstallDismissals({codex: true, claude: false, gemini: true})` equals `{codex: true}`;
    `null`, `[]`, `'x'` → `{}`;
  - 'coerceInstallRequest accepts each valid shape and rejects: unknown cli, bad scope, bad
    action, numeric projectPath, remove without entryScope, remove with entryScope "x"';
  - 'needsSetup: true iff some found CLI is not-installed' — a not-found `not-installed` doesn't
    count;
  - 'ConfigFormatError carries its code' — `new ConfigFormatError('EGUARD','m').code === 'EGUARD'`.
- [ ] `npx vitest run test/unit/install-types.test.ts` fails (module missing).
- [ ] Implement.

#### Task 1.2: `src/conduit-mcp/install-entries.ts`

**Files:** Create `src/conduit-mcp/install-entries.ts`; test `test/unit/install-entries.test.ts`.

**Interfaces:**
- Produces the `install-entries.ts` block in Contracts.
- Consumes from T1.1: `AgentCli`, `ClaudeEntry`, `CodexEntry`, `OpenCodeEntry`; from
  `src/conduit-mcp/cursor-config.ts:1-9,32`: `CursorEntry`, `cursorEntry(execPath, shimPath)`.

**Steps:**
- [ ] Failing tests (POSIX paths `/app/conduit`, `/app/res/conduit-mcp-shim.cjs`):
  - 'claude entry is the §3.4 shape' — `env.CONDUIT_SESSION_TOKEN === '${CONDUIT_SESSION_TOKEN:-}'`,
    `type === 'stdio'`, `args` = `[shim]`;
  - 'codex entry forwards both names in env_vars and sets approval auto';
  - 'opencode entry command is [exe, shim] with {env:…} placeholders and enabled true';
  - 'cursor entry equals cursorEntry()';
  - 'classify: undefined → absent; equal → ours; other exe same shape → other-conduit;
    user-authored → conflict' — per CLI;
  - 'shape: claude accepts ${VAR} and ${VAR:-}; rejects a missing endpoint placeholder';
  - 'shape: shim leaf compared on the last segment for both separators' —
    `C:\\x\\conduit-mcp-shim.cjs` is shaped;
  - 'entryTargets returns command and shim per CLI, null for non-strings';
  - 'deepEqualConfig ignores key order and compares Dates by time'.
- [ ] Run; expect FAIL (module missing).
- [ ] Implement.

#### Task 1.3: `src/conduit-mcp/json-config.ts`

**Files:** Create `src/conduit-mcp/json-config.ts`; test `test/unit/json-config.test.ts`.

**Interfaces:** Produces the `json-config.ts` block. Consumes `ConfigFormatError` (T1.1).

**Steps:**
- [ ] Failing tests:
  - 'BOM stripped; whitespace-only is {}';
  - 'comments or trailing commas → EJSON' — `'{"a":1,}'` and `'{//x\n}'` throw with `code === 'EJSON'`;
  - 'array or string top level → EJSON';
  - 'setPath keeps sibling order and creates parents' — `Object.keys` order of the root unchanged
    for an existing `mcpServers`;
  - 'setPath through a non-object parent → EJSON';
  - 'deletePath leaves an empty parent as {}';
  - 'neither mutates its input';
  - 'serialize is 2-space with a trailing newline'.
- [ ] Run; expect FAIL. Implement.

#### Task 1.4: `src/conduit-mcp/toml-config.ts` + `smol-toml`

**Files:**
- Modify `package.json` (`dependencies`, alphabetical) and `package-lock.json`: run
  `npm install --save-exact smol-toml@1.3.1`.
- Create `src/conduit-mcp/toml-config.ts`; test `test/unit/toml-config.test.ts`.

**Interfaces:** Produces the `toml-config.ts` block. Consumes `CodexEntry`, `ConfigFormatError`
(T1.1) and `deepEqualConfig` from T1.2 (`src/conduit-mcp/install-entries.ts`) — so T1.4 runs after
T1.2 (it is in the serial lane).

**Steps:**
- [ ] Failing tests, one `it.each` corpus `{name, input, entry | null, expected | errorCode}`:
  - absent + entry → appended after one blank line; every original byte is a prefix of the output;
  - replace an existing table with a trailing comment line and a following `[profiles.x]`: bytes
    before and after the range identical;
  - table + contiguous `[mcp_servers.conduit.env]` subtable → both replaced/removed;
  - `[mcp_servers."conduit"]` quoted header → located;
  - dotted `mcp_servers.conduit.command = "x"` under `[mcp_servers]` → `EUNEDITABLE`;
  - inline `conduit = { command = "x" }` under `[mcp_servers]` → `EUNEDITABLE`;
  - non-contiguous `[mcp_servers.conduit.env]` after another table → `EUNEDITABLE`;
  - a multi-line basic string containing `[mcp_servers.other]` text inside the conduit range →
    `EGUARD`;
  - CRLF file → inserted lines use CRLF;
  - remove → only the range deleted;
  - invalid TOML → `ETOML`.
  - 'tomlBasicString escapes backslash, quote and controls' —
    `tomlBasicString('C:\\a"b\n') === '"C:\\\\a\\"b\\u000A"'`;
  - 'renderCodexTable round-trips through readCodexConduit to the entry'.
- [ ] Run; expect FAIL. Implement.

#### Task 1.5: `src/conduit-mcp/client-info.ts`

**Files:** Create `src/conduit-mcp/client-info.ts`; test `test/unit/client-info.test.ts`.

**Interfaces:** Produces the `client-info.ts` block. Consumes `McpAdapterId`
(`src/conduit-mcp/adapters.ts:4`). If S0 has run, `CURSOR_CLIENT_NAMES` holds its recorded name.

**Steps:**
- [ ] Failing tests:
  - 'known names map to kinds; unknown → agent; non-string → agent';
  - 'conduit-e2e-fake → fake only with e2e' — `clientKindOf('conduit-e2e-fake', {e2e:false}) === 'agent'`;
  - 'noticeAdapterIdOf: opencode and agent are pull-only';
  - 'pickNoticeAdapterId: definition wins; else newest live; none → null; newest pull-only → null'
    — `pickNoticeAdapterId(undefined, ['claude','opencode']) === null`,
    `pickNoticeAdapterId(undefined, ['opencode','codex']) === 'codex'`;
  - 'initializeClientName: name, null without clientInfo, undefined for tools/list, a notification
    and non-JSON'.
- [ ] Run; expect FAIL. Implement.

#### Task 1.6: `src/conduit-mcp/typed-command.ts`

**Files:** Create `src/conduit-mcp/typed-command.ts`; test `test/unit/typed-command.test.ts`.

**Interfaces:** Produces the `typed-command.ts` block. Consumes `AgentCli` (T1.1).

**Steps:**
- [ ] Failing tests:
  - 'typed claude + Enter → [claude]' — one char per `feed`, then `'\r'`;
  - 'a whole line in one chunk is classified' — `feed('codex\r')` → `['codex']` (e2e `typeLine`
    sends one chunk);
  - 'backspace edits' — `feed('codx')`, `feed('\x7f')`, `feed('\x7f')`, `feed('ex\r')` → `['codex']`;
  - 'an arrow key makes the line unknown' — `feed('\x1b[A')`, `feed('\r')` → `[]`, and the next
    line is known again;
  - 'Tab completion makes it unknown'; 'bracketed paste makes it unknown';
  - 'Ctrl+C clears the line';
  - 'skip list' — `claude --version`, `codex exec x`, `opencode run`, `claude -p hi` → null;
    `claude --model x` → claude;
  - 'paths and extensions' — `C:\\tools\\Claude.EXE`, `./node_modules/.bin/codex.cmd`,
    `"C:\\Program Files\\x\\agent.ps1"` → claude, codex, cursor;
  - 'chained: first command only' — `claude && codex` → claude; `cd x && claude` → null;
  - 'cursor-agent → cursor'.
- [ ] Run; expect FAIL. Implement.

#### Task 1.7: Settings

**Files:** Modify `src/settings.ts` (Contracts block). Test `test/unit/coerce-settings.test.ts`.

**Interfaces:** Consumes `InstallDismissals`, `coerceInstallDismissals` (T1.1). Produces
`AppSettings.mcpInstallSuggest: boolean`, `AppSettings.mcpInstallPromptDismissed: InstallDismissals`.

**Call sites:** `coerceSettings` callers unchanged; `webview/settings.tsx` hydrates the whole
object. Re-run `test/unit/settings-sync.test.ts` and `test/unit/settings-hydrate-dom.test.ts`.

**Steps:**
- [ ] Failing tests: 'absent → true and {}'; 'dismissals drop unknown keys and non-true values';
  'round-trip keeps {codex: true}'.
- [ ] Run; expect FAIL. Implement.

#### Task 1.8: Shim fallback version

**Files:** Modify `resources/conduit-mcp/conduit-mcp-shim.cjs:56`;
`test/unit/conduit-mcp-shim.test.ts:199`.

**Steps:**
- [ ] Change the assertion at `:199` to `serverInfo: { name: 'conduit', version: 'fallback' }`; run
  `npx vitest run test/unit/conduit-mcp-shim.test.ts` — expect FAIL.
- [ ] Implement.

---

### Slice 2: Host install IO

**Check:**
- `npx vitest run test/unit/config-file-io.test.ts test/unit/mcp-install-targets.test.ts test/unit/mcp-install.test.ts test/unit/cursor-config.test.ts`
  is green (all with `mkdtemp` homes; none reads `os.homedir()`);
- `npm run typecheck`, `npm run verify:quick` green.

**Parallel groups:** G1: T2.1 · G2: T2.2 · Serial: T2.3
**Claims:** none (no shared entry file is edited)

#### Task 2.1: `electron/config-file-io.ts`

**Files:** Create `electron/config-file-io.ts`; test `test/unit/config-file-io.test.ts`.
`electron/cursor-connect.ts` is **not** edited here (deleted in T4.9).

**Interfaces:** Produces the `config-file-io.ts` block. Consumes `ConfigFormatError` (T1.1). The
bodies of `writeConfigAtomic` and `backupOnce` are `atomicCursorWrite` and
`createBackupIfMissing` (`electron/cursor-connect.ts:167-205`) with the parent `mkdirSync` added.

**Steps:**
- [ ] Failing tests (real `mkdtemp` dirs):
  - 'missing file → text null, realPath = given';
  - 'BOM stripped and flagged';
  - 'symlinked file reads the target and reports its realpath' — POSIX-only, guarded with
    `it.skipIf(process.platform === 'win32')` exactly as `test/unit/cursor-config.test.ts:304`
    (CI runs it on ubuntu);
  - 'atomic write keeps mode 0600' — same guard, as `test/unit/cursor-config.test.ts:334-344`;
  - 'failed rename unlinks the temp' — injected `io.renameSync` throws `EPERM`; no `*.tmp-*` left;
  - 'backupOnce never overwrites; null original writes "null"; EEXIST race is success'.
- [ ] Run; expect FAIL. Implement.

#### Task 2.2: `electron/mcp-install-targets.ts`

**Files:** Create `electron/mcp-install-targets.ts`; test `test/unit/mcp-install-targets.test.ts`.

**Interfaces:** Produces the `mcp-install-targets.ts` block. Consumes `AgentCli`, `ProjectScope`
(T1.1), `JsonObject` (T1.3), `folderKey` (`src/folder-key.ts:4`), `HostPlatform`.

**Steps:**
- [ ] Failing tests (`homeDir: '/h'`, `userDataDir: '/u'`, `platform: 'posix'` unless stated):
  - 'claude user file honours CLAUDE_CONFIG_DIR; empty string is unset' —
    `{CLAUDE_CONFIG_DIR: '/c'}` → `/c/.claude.json`; `{CLAUDE_CONFIG_DIR: ''}` → `/h/.claude.json`;
  - 'codex honours CODEX_HOME; opencode honours XDG_CONFIG_HOME; cursor ignores env';
  - 'mtimeGuard only for claude user';
  - 'project backups live under userData, never the root' — `backupPath.startsWith('/u/mcp-install-backups/')`,
    distinct for `.mcp.json` and `.codex/config.toml` of the same root;
  - 'claudeLocalTarget matches trailing slash; case-insensitive only on win32' — key `/R/Proj/` vs
    root `/r/proj`: null on posix, matched with `platform: 'win32'`; `keys[1]` is the exact key;
  - 'installableInProject false only for cursor'.
- [ ] Run; expect FAIL. Implement.

#### Task 2.3: `electron/mcp-install.ts`

**Files:** Create `electron/mcp-install.ts`; test `test/unit/mcp-install.test.ts`. Modify
`test/unit/cursor-config.test.ts`: none yet (its `createCursorConnect` cases stay until T4.9).

**Interfaces:**
- Produces the `electron/mcp-install.ts` block (without `readCursorLaunchEntry`).
- Consumes T1.1–T1.4 (`AgentCli`, `McpInstallStatus`, `CliInstallStatus`, `McpInstallRequest`,
  `McpInstallResult`, `UserInstallState`, `ConfigFormatError`; `conduitEntry`, `classifyEntry`,
  `entryTargets`; `parseJsonConfig`, `getPath`, `setPath`, `deletePath`, `serializeJsonConfig`;
  `readCodexConduit`, `locateConduitTable`, `spliceConduitTable`), T2.1 (`ConfigIo`,
  `readConfigFile`, `writeConfigAtomic`, `backupOnce`, `errorCodeOf`), T2.2 (`TargetEnv`,
  `ConfigTarget`, `userTarget`, `projectTarget`, `claudeLocalTarget`, `foundMarkers`,
  `openCodeJsoncPath`, `installableInProject`).
- If S0 recorded that a live Claude clobbers the key (D1 failed), **stop**: the Claude user writer
  becomes a re-plan item (deviation rule).

**Steps:**
- [ ] Failing tests (each with a fresh `mkdtemp` home and userData; `onPath` and `knownHome` fakes):
  - AC4 'install on not-installed: backup once, only conduit added, others deep-equal, mode kept'
    — per CLI; Claude file seeded `{"mcpServers":{"other":{"command":"x"}},"numStartups":3}`;
    `.conduit-backup` equals the original bytes; a second install is `{ok:true}` and the backup's
    mtime is unchanged;
  - AC4 'TOML install keeps bytes outside the owned range identical';
  - AC4 'project install backs up under userData and writes nothing else in the repo' — the root
    contains only the CLI's file afterwards;
  - AC5 'invalid JSON, JSONC, opencode.jsonc present, uneditable TOML, guard failure → error, file
    untouched';
  - AC6 'conflict: install → ESTATE; replace → written'; 'other-conduit: install rewrites without
    confirm';
  - AC7 'uninstall removes only conduit from installed/other-conduit; never deletes the file or the
    backup; empty mcpServers stays {}'; 'uninstall on not-installed → ESTATE';
  - AC7 'project remove deletes only that scope's entry' — Claude `local` under the exact key found;
  - AC8 'mtime guard: changed once → re-applied; changed twice → EBUSY and the file holds the other
    writer's content' — injected `io.statSync` reports a new mtime and `io.readFileSync` returns
    the other writer's text;
  - AC9 'unknown projectPath: status project null; act EPROJECT';
  - 'found: PATH or marker; not-found → Check again only (install → ESTATE)';
  - 'shadowedBy: a non-ours local Claude entry shadows the user row';
  - 'Repair rewrites an other-conduit entry whose shim is gone; leaves one whose paths exist' —
    two entries, one with `/gone/conduit-mcp-shim.cjs`;
  - 'Repair never touches project files';
  - 'cursor row: other-conduit vs conflict split' (spec §3.5 "Changes cursor spec §3.1").
- [ ] Run; expect FAIL. Implement.

---

### Slice 3: Host identity, notices, detection; main wiring

**Check:**
- `npx vitest run test/unit/conduit-mcp-host.test.ts test/unit/conduit-mcp-view-model.test.ts test/unit/messages-pane.test.tsx`
  green;
- `npm run typecheck`, `npm run build`, `npm run verify:quick` green.

**Parallel groups:** Serial: T3.1 → T3.2 → T3.3 → T3.4
**Claims (serial lane):** `electron/conduit-mcp-host.ts` (T3.1–T3.3), `src/conduit-mcp/ui-types.ts`
(T3.3), `webview/bridge.ts` (T3.3 mock line, then T3.4), `electron/main.ts`, `electron/preload.ts`
(T3.4)

#### Task 3.1: Token for every session, lazy handles, client kinds

**Files:** Modify `electron/conduit-mcp-host.ts` (Runtime `:159-170` + `rt` `:227-244` gain
`defAdapter`/`launch`/`size`/`tracker`/`detect`/`notConnected` — rename only, consumers move in
T3.2; `claimHandle` `:477-507`; control claim `:512-516`; `onConnection` `:628-689`; `directory`
`:309-326`; `prepareLaunch` `:861-911`; delete `isInitialize` `:1096-1101`). Test
`test/unit/conduit-mcp-host.test.ts` (harness at `:182`).

**Interfaces:**
- Consumes `ClientKind`, `clientKindOf`, `initializeClientName` (T1.5); `createTypedLineTracker`
  (T1.6).
- Produces `claimHandle(sessionId: string, prefix: string): Handle | null`, `connKinds`, the
  `prepareLaunch` invariant in Contracts.

**Call sites:** `claimHandle` — `:869` (`adapter.id`), `:515` (`adapter.id`), the new initialize
hook (`kind`). `isInitialize` — `:661` only.

**Steps:**
- [ ] Rewrite `'prepareLaunch for a plain shell returns spec unchanged'` (`:496`) as AC1 'a plain
  shell gets token + endpoint and no handle' — env has both, `args` unchanged,
  `mcpHandle === undefined`, no `launch/s1.json`.
- [ ] Failing tests:
  - AC1 'messaging off or endpoint down: a shell gets nothing, uiState shows nothing';
  - AC1 'adapter wiring failure still gives no token' (existing `cmd-metachar` case, unchanged);
  - AC2 'first initialize from claude-code allocates claude-<n> before the reply' — the fake
    connection records `mgr.setMcp` before it receives the `initialize` response;
  - AC2 'unknown client → agent-<n>'; 'second CLI in the same shell keeps the handle';
  - AC2 'the lazily named session is in list_sessions with agent = live kind, else prefix';
  - 'a forged token initialize allocates nothing' (`tools/list` `[]`, existing behaviour kept).
- [ ] Run; expect FAIL. Implement: in `conn.onLine`, before `core.handleLine(line)`:
  `const name = sessionId ? initializeClientName(line) : undefined`; when `!== undefined`, set
  `connKinds`, claim, and keep the post-reply `registry.connect` exactly where it is (`:661`).
  `conn.onClose` also deletes `connKinds`.

#### Task 3.2: Notice adapter from the live client; screen at first initialize

**Files:** Modify `electron/conduit-mcp-host.ts` (`evaluate` `:354-400`, `submitNotice` `:419-470`,
`notifierSessions` `:521-526`, `badgeOf` `:712-733`, `onSpawn` `:913-920`, `onResize` `:926-928`,
the initialize hook from T3.1). Conditional: `src/conduit-mcp/adapters.ts:41-53` and
`test/unit/conduit-mcp-adapters.test.ts` if S0 recorded an unmatched Claude approval line. Test
`test/unit/conduit-mcp-host.test.ts`.

**Interfaces:**
- Consumes `pickNoticeAdapterId(def, liveKinds)`, `noticeAdapterIdOf` (T1.5); `MCP_ADAPTERS`
  (`src/conduit-mcp/adapters.ts:40`); `registry.connectionsOf(sessionId)` (live, initialized
  connections).
- Produces `noticeAdapterOf(sessionId): McpAdapter | null` = the `MCP_ADAPTERS` entry for
  `pickNoticeAdapterId(r.defAdapter?.id, kinds of connectionsOf(sessionId) sorted by seq)`.

**Call sites:** every former `r.adapter` read — `:357`, `:358`, `:445`, `:464-465`, `:524`, `:719`,
`:915` (the last keeps `defAdapter`: spawn-time screens stay adapter-only).

**Steps:**
- [ ] Failing tests:
  - AC3 'a shell running claude gets claude notices' — fake screens; a pending message to the
    lazy handle is typed when the screen matches claude's `emptyInput`;
  - AC3 'opencode / unmapped client → pull-only, nothing typed'; badge `gate === 'pull-only'`;
  - AC3 'no live connection → no notice; badge gate null for a non-adapter session';
  - AC3 'newest live wins; when it closes the previous applies';
  - 'definition adapter still wins in a profile session';
  - D6 'a shell's screen model starts at its first initialize with the last known size, not at
    spawn' — `screens.has('s1')` false after `onSpawn`, true after `initialize`; `start` called
    with the size from `onResize`.
- [ ] Run; expect FAIL. Implement. `onSpawn`/`onResize` store `r.size` (and `r.spawnedAt` in
  `onSpawn`) for every runtime before the adapter early-return.

#### Task 3.3: Detection, `notConnected`, install-state dep

**Files:**
- Modify `src/conduit-mcp/ui-types.ts` (`McpNotConnected`; `McpUiState` `:41-56` gains
  `notConnected`).
- Modify `electron/conduit-mcp-host.ts`: deps `:85-119` gain `installState`, `detectGraceMs`;
  interface `:123-145` gains `onInstallChanged`; `prepareLaunch` (tracker for token-bearing
  non-adapter sessions; `cursor-not-connected` at `:878-880` also sets `r.notConnected` with
  `launch: r.launch`); `onRendererInput` `:941-945` (feed the tracker **before** `noteInput`'s
  `isCountedInput` filter); `tick` `:797` (detection pass **before** the `!notifier` return);
  initialize hook (clear `detect` and a `no-initialize` `notConnected`); `onExit` `:930-939` (clear
  both); `uiState` `:735-759`.
- Typed-literal call sites gain `notConnected: {}`: `webview/bridge.ts:629-639`,
  `test/unit/conduit-mcp-view-model.test.ts:32-41`, `test/unit/messages-pane.test.tsx:60-69`.
- Test `test/unit/conduit-mcp-host.test.ts` (the harness at `:182` supplies `installState: () =>
  'not-installed'` by default and a `detectGraceMs`).

**Interfaces:** Consumes `DETECT_GRACE_MS`, `TypedLineTracker` (T1.6); `AgentCli`,
`UserInstallState` (T1.1). Produces the `ui-types.ts` block, `installState`, `detectGraceMs`,
`onInstallChanged()`.

**Steps:**
- [ ] Failing tests:
  - AC11 'typed codex + no initialize within the grace → notConnected {cli: codex, install,
    reason: no-initialize}' — advance injected `now`, call `tick()`;
  - AC11 'initialize inside the grace → nothing'; 'initialize after → cleared'; 'exit clears';
    'relaunch clears and bumps launch';
  - AC11 'skip-list line is not a candidate' (`codex --help`);
  - 'adapter sessions never detect'; 'a line typed while a CLI is live is ignored';
  - 'messaging off → notConnected {}';
  - 'cursor-not-connected profile launch → notConnected {cli: cursor, reason: cursor-not-connected}';
  - 'onInstallChanged re-reads install state and broadcasts'.
- [ ] Run; expect FAIL. Implement.

#### Task 3.4: Main, preload, bridge wiring

**Files:** Modify `electron/main.ts` (imports near `:203`/`:277-278`; `createMcpInstall` +
`repair` before `:1908`; host deps `:1908-1947`; handlers after `:4937`), `electron/preload.ts`
(beside `skills`), `webview/bridge.ts` (`HostBridge` `:51-90`; wrappers beside `listSkills`
`:282-295`).

**Interfaces:** Consumes `createMcpInstall`, `McpInstallDeps` (T2.3); `CLI_BINARIES`,
`coerceInstallRequest`, `McpInstallStatus`, `McpInstallRequest`, `McpInstallResult` (T1.1);
`resolveCommand` (`src/shells.ts:38`); `folderKey` (`src/folder-key.ts:4`); `onInstallChanged`,
`installState`, `detectGraceMs` (T3.3). Produces the main/preload/bridge blocks in Contracts.

**Steps:**
- [ ] Carve-out (wiring, no unit seam in `main.ts`): the proof is `npm run typecheck` and
  `npm run build` green, then S5's e2e. Confirm by grep that `CONDUIT_E2E_DETECT_GRACE_MS` is read
  only behind `CONDUIT_E2E === '1'` and `repair()` only outside it.
- [ ] Implement per Contracts.

---

### Slice 4: Renderer

**Check:**
- `npx vitest run test/unit/mcp-install-row.test.tsx test/unit/mcp-project-entries.test.tsx test/unit/settings-mcp-tab.test.tsx test/unit/settings-mcp-tools.test.tsx test/unit/mcp-card-status.test.ts test/unit/session-card.test.ts test/unit/mcp-setup-banner.test.tsx test/unit/messages-pane.test.tsx test/unit/cursor-config.test.ts test/unit/mcp-install.test.ts`
  green;
- `grep -rn "cursor-connect:\|readCursorConnection\|connectCursor\|disconnectCursor\|CursorConnectRow\|createCursorConnect" electron src webview test`
  returns nothing (AC14);
- `npm run typecheck`, `npm run verify:quick` green.

**Parallel groups:** Serial (first): T4.1 · G1: T4.2 → T4.3 · G2: T4.4 · G3: T4.5 · G4: T4.6 ·
Serial: T4.7, T4.8, T4.9
**Claims (serial lane):** `webview/conduit-mcp-strings.ts`, `webview/icons.tsx` (T4.1);
`webview/app.tsx` (T4.7); `webview/styles.css` (T4.8); `electron/main.ts`, `electron/preload.ts`,
`webview/bridge.ts`, `electron/conduit-mcp-host.ts` (T4.9). `settings-modal.tsx` is edited only by
T4.3 (inside G1).

#### Task 4.1: Strings and icons

**Files:** Modify `webview/conduit-mcp-strings.ts` (add `MCP_STR.install`; `UNAVAILABLE_CAUSE`
`'cursor-not-connected'` at `:22` → `'Install Conduit for Cursor in Settings → MCP'`;
`settingsTitle` `:162` → `'Messaging'`), `webview/icons.tsx` (`IconPlug`, `IconUnplug` via
`glyph`, beside `IconMail` `:469`).

**Interfaces — produces** `MCP_STR.install`:
- `tab: 'MCP'`; groups `messagingTitle`, `clisTitle: 'Agent CLIs'`, `toolsTitle: 'Tools'`,
  `suggestTitle: 'Suggestions'`; `clisDesc` (includes "Uninstall here before removing Conduit");
  `messagingNotices` (D11 explanation); `suggestToggle`, `suggestDesc`; `masterOffHint:
  'Messaging is off; installed CLIs get no tools.'`;
- `cliName: Record<AgentCli, string>` (`Claude Code`, `Codex`, `Cursor`, `OpenCode`);
  `cliCommand: Record<AgentCli, string>` (`claude`, `codex`, `agent`, `opencode`);
- `state: Record<UserInstallState | 'checking' | 'pending', string>` (`Not installed`,
  `Installed`, `Installed by another Conduit`, `Another "conduit" server`, `Configuration error`,
  `Not found`, `Checking…`, `Working…`);
- buttons `install`, `uninstall`, `useThis: 'Use this Conduit'`, `replace: 'Replace…'`,
  `checkAgain`, `tryAgain`, `remove`, `installProject: 'Install for this project'`; aria
  builders `installAria(cli)` "Install Conduit for Codex", `uninstallAria(cli)` "Uninstall
  Conduit from Codex", likewise for each button;
- `actionFailed(path, code)` "Couldn't update <path>: <code text>"; `errorText: Record<string,
  string>` for `EJSON`, `EJSONC`, `ETOML`, `EUNEDITABLE` ("defined in a form Conduit can't edit"),
  `EGUARD`, `EBUSY`, `ESTATE`, `EPROJECT`, fallback = the code;
- `shadowed(scope)`, `codexTrustNote`, `projectWarn(file)` ("Adds <file> to this project — it
  contains paths on this computer; don't commit it"), `projectNone`, `replaceTitle`,
  `replaceBody(path, backup)`, `cursorNote` (D2 per-tool allowlist note);
- card: `connectedTip(handle)` "Connected to Conduit as claude-3", `notConnectedTip(cli)`,
  `notConnectedInstalledTip(cli)` "Codex didn't connect to Conduit. Restart it in this terminal.";
- banner: `bannerBody(cli)`, `bannerInstall(cli)` "Install for Codex", `bannerDismiss: "Don't
  suggest again"`, `bannerClose`, `bannerInstalled(cli)` "Installed. Restart codex in this
  terminal to connect.", `bannerOpenSettings: 'Open MCP settings'`, `bannerAnnounce(cli)`
  "Conduit setup suggestion for Codex", `bannerRegion: 'Conduit setup'`;
- `setupCommand: 'Set up Conduit MCP…'`; Messages `setupCopy`, `setupButton: 'Set up agent CLIs'`.

**Steps:**
- [ ] Carve-out (copy + glyphs): `npm run typecheck` green; `npm run text-fit` runs in S5.
- [ ] Implement. `cursor*` keys stay until T4.9.

#### Task 4.2: `useMcpInstall`, `McpInstallRow`, `McpProjectEntries`

**Files:** Create `webview/use-mcp-install.ts`, `webview/components/mcp-install-row.tsx`,
`webview/components/mcp-project-entries.tsx`; tests `test/unit/mcp-install-row.test.tsx`,
`test/unit/mcp-project-entries.test.tsx`.

**Interfaces:** Produces the renderer block entries for these three. Consumes
`mcpInstallStatus`, `mcpInstallAct` (T3.4, `webview/bridge.ts`); T1.1 types; `MCP_STR.install`
(T4.1); `ConfirmDialog` (`webview/components/confirm-dialog.tsx`, `focusCancel: true`,
`onCancel` restores focus to the row).

**Steps:**
- [ ] Failing tests (`vi.mock('../../webview/bridge')`):
  - 'checking: no buttons, Checking…';
  - 'each state shows exactly its §2.3 buttons' — `not-found` [Check again]; `not-installed`
    [Install]; `installed` [Uninstall]; `other-conduit` [Use this Conduit, Uninstall]; `conflict`
    [Replace…]; `error` [Check again];
  - 'pending disables buttons and sets aria-busy';
  - 'failure shows actionFailed with the path and the code text, plus Try again';
  - 'Replace… opens a dialog naming the file and backup; focus starts on Cancel; Esc cancels and
    returns focus to the row; Replace calls act with action replace';
  - 'after an action focus moves to the row's first enabled button';
  - 'state text is a polite live region per row';
  - 'buttons are named with the CLI' — `getByRole('button', {name: 'Uninstall Conduit from Codex'})`;
  - project: 'none found shows the commit warning and Install for this project (not for Cursor)';
    'Remove only for ours/other-conduit, with entryScope'; 'Codex row carries the trusted-project
    note'.
- [ ] Run; expect FAIL. Implement.

#### Task 4.3: MCP Settings tab

**Files:** Modify `webview/components/settings-modal.tsx` (`Tab` `:45` gains `'mcp'` after
`'general'`; `TAB_LABELS` `:87-93`; pane switch `:121-141`; new local `function McpTab({settings,
update, projectPath, initialCli})`; move the `SetGroup` at `:998-1010` and `McpToolSwitchRows`
`:843-886` usage into it; remove the `CursorConnectRow` import `:38`; props gain `initialCli`).
Tests: create `test/unit/settings-mcp-tab.test.tsx`; modify `test/unit/settings-mcp-tools.test.tsx`
(render with `initialTab="mcp"`; its `readCursorConnection` mock `:17` becomes an
`mcpInstallStatus` mock).

**Interfaces:** Consumes T4.2 (`useMcpInstall(projectPath)`, `McpInstallRow`, `McpProjectEntries`),
T1.7 settings, T1.1 `AGENT_CLIS`. Produces `Tab` with `'mcp'` and `initialCli?: AgentCli`.

**Steps:**
- [ ] Failing tests:
  - 'MCP nav item sits after General';
  - 'groups in order: Messaging, Agent CLIs, Tools, Suggestions' (spec §12);
  - 'four rows in fixed order Claude Code, Codex, Cursor, OpenCode';
  - 'project section hidden without a project';
  - 'master off: rows usable, hint shown';
  - AC12 'turning Suggestions on clears dismissals in the same update' — `update` called once with
    `{mcpInstallSuggest: true, mcpInstallPromptDismissed: {}}`;
  - 'initialCli focuses that row's first button';
  - 'General no longer contains the messaging master switch'.
- [ ] Run; expect FAIL. Implement.

#### Task 4.4: Card indicator

**Files:** Create `webview/mcp-card-status.ts`; test `test/unit/mcp-card-status.test.ts`. Modify
`webview/components/session-card.tsx` (prop `mcpLink`; render beside the chips at `:193-206`),
`webview/components/sidebar.tsx` (props `mcpNotConnected`, `mcpEnabled` beside `mcpBadges`
`:103`; pass `mcpLink={cardMcpStatus(mcpBadges[s.id], mcpNotConnected[s.id], mcpEnabled)}` at
`:409`); test `test/unit/session-card.test.ts` (fixture `:199-206`).

**Interfaces:** Produces `cardMcpStatus`, `CardMcpStatus`. Consumes `McpSessionBadge`,
`McpNotConnected` (T3.3), `IconPlug`/`IconUnplug` + strings (T4.1).

**Steps:**
- [ ] Failing tests:
  - 'disabled → null'; 'connected badge → connected'; 'nc → not-connected even with a badge';
  - 'unavailable other than cursor-not-connected → null (the existing warning shows)';
  - card: 'connected renders Plug with tooltip "Connected to Conduit as claude-3"', 'not-connected
    renders Unplug; installed → restart copy, else install copy', 'the indicator is role img with
    an aria-label and is not focusable'.
- [ ] Run; expect FAIL. Implement: `<span className="session__mcp-link" role="img"
  aria-label={tip} title={tip}>`.

#### Task 4.5: Banner

**Files:** Create `webview/mcp-setup-banner-model.ts`, `webview/components/mcp-setup-banner.tsx`;
test `test/unit/mcp-setup-banner.test.tsx`. Modify `webview/components/center-pane.tsx` (props;
render `<McpSetupBanner …/>` directly after `<AgentScopeBanner session={s} />` at `:354`).

**Interfaces:** Produces the banner block. Consumes `McpNotConnected` (T3.3), `useSettings()`
(`update`), `mcpInstallAct` (T3.4), strings (T4.1).

**Steps:**
- [ ] Failing tests:
  - AC12 'shows iff every condition holds' — one case per failing condition (messaging off,
    suggest off, dismissed, install ≠ not-installed, agentScope present, already seen);
  - AC12 'another banner showing drops it for that launch (not queued)' — present then cleared
    `agentScope` with the same `launch` → not shown; `launch + 1` → shown;
  - 'close × hides it for that key only';
  - AC12 'Don't suggest again writes mcpInstallPromptDismissed[cli] = true';
  - 'Install success → restart copy; failure → actionFailed + Open MCP settings calls
    onOpenMcpSettings(cli)';
  - 'region role, label "Conduit setup", polite announcement "Conduit setup suggestion for Codex"';
  - 'cursor-not-connected uses the same banner with Install for Cursor'.
- [ ] Run; expect FAIL. Implement. The ledger marks the key on first render that shows **or**
  drops it.

#### Task 4.6: Messages empty state

**Files:** Modify `webview/components/messages-pane.tsx` (`:348-349` branch); test
`test/unit/messages-pane.test.tsx`.

**Interfaces:** Consumes `mcpInstallStatus(null)` (T3.4), `needsSetup` (T1.1), strings (T4.1),
the existing `onOpenSettings` prop (`:27`).

**Steps:**
- [ ] Failing tests: AC13 'no threads + needsSetup → setup copy and Set up agent CLIs, which calls
  onOpenSettings'; 'all installed or none found → firstRun copy, no button'; 'messaging off →
  existing off state'.
- [ ] Run; expect FAIL. Implement: a local `SetupEmptyState` that reads status on mount.

#### Task 4.7: `app.tsx` wiring

**Files:** Modify `webview/app.tsx`: `SettingsTab` `:315` gains `'mcp'`; `openSettingsAt`
`:2599-2602` takes `(tab, cli?)` and a `settingsFocusCli` state passed as `initialCli` at
`:4683-4688`; `settingsCmds` `:4191-4225` gains `{id: 'set:mcp', title: MCP_STR.install.setupCommand,
group: 'Settings', icon: <IconSettings size={14} />, keywords: ['mcp', 'claude', 'codex',
'opencode', 'cursor'], run: () => openSettingsAt('mcp')}`; card menu `messaging` array
(`:2883-2912`) gains `MCP_STR.install.setupCommand` when `mcp.state?.notConnected[s.id]` →
`openSettingsAt('mcp', cli)`; sidebar props at `:4521` (`mcpNotConnected={mcp.state?.notConnected
?? NO_NOT_CONNECTED}`, `mcpEnabled={mcp.state?.enabled ?? false}`); `<CenterPane` `:4402` gains the
same two plus `onOpenMcpSettings={(cli) => openSettingsAt('mcp', cli)}`; right pane
`onOpenSettings` `:4599` → `openSettingsAt('mcp')`. `NO_NOT_CONNECTED` beside `NO_MCP_BADGES`
`:333-334`.

**Interfaces:** Consumes the props produced by T4.3, T4.4, T4.5.

**Steps:**
- [ ] Carve-out (composition root): `npm run typecheck` and the S4 vitest set green; the
  palette/menu paths are exercised by `test/e2e/conduit-mcp-install-banner.e2e.mjs` (T5.3).
- [ ] Implement. Grep for a leftover variable shadowing a DOM global after the edit (CLAUDE.md).

#### Task 4.8: Styles

**Files:** Modify `webview/styles.css`: add the classes listed under Contracts (tokens only:
`--fg-muted` for connected, the existing warning token for conflict/error, the `.scope-banner`
geometry for `.mcp-banner`, paths `overflow-wrap: anywhere` and `direction: ltr`); remove
`.set__control--cursor` (`:7441`) and `.cursor-connect-row*` (`:7588-7609`).

**Steps:**
- [ ] Carve-out (visual): proof is `npm run text-fit` and `npm run shots` in S5 across the three
  themes; `test/unit/monaco-class-collision.test.ts` stays green (no bare generic class names).
- [ ] Implement.

#### Task 4.9: Remove Cursor connect

**Files:**
- Modify `electron/mcp-install.ts`: add `readCursorLaunchEntry(homeDir: string): boolean`
  (body of `electron/cursor-connect.ts:142-152`, parsing with `parseJsonConfig` and
  `wiresLaunch`).
- Modify `electron/conduit-mcp-host.ts:81`: import it from `./mcp-install`.
- Modify `electron/main.ts`: drop the import `:278`, `createCursorConnect` `:1949-1953`, handlers
  `:4939-4942`.
- Modify `electron/preload.ts`: drop `:2` and `:54-62`. Modify `webview/bridge.ts`: drop `:4`,
  `:77-79`, `:176-192`.
- Delete `electron/cursor-connect.ts`, `webview/components/cursor-connect-row.tsx`,
  `test/unit/cursor-connect-row.test.tsx`.
- Modify `src/conduit-mcp/cursor-config.ts`: keep `CursorEntry`, the two placeholders,
  `cursorEntry`, `wiresLaunch`; delete `CursorConfig`, `CursorConnectState`,
  `CursorConnectResult`, `CursorConfigShapeError`, `parseCursorConfig`,
  `isCursorConfigParseError`, `cursorConfigState`, `mergeCursorEntry`, `removeCursorEntry`,
  `serializeCursorConfig`, `isRecord`, `deepEqual`.
- Modify `test/unit/cursor-config.test.ts`: keep `cursorEntry`/`wiresLaunch`/`readCursorLaunchEntry`
  cases (import from `../../electron/mcp-install`); delete the `createCursorConnect` cases (their
  behaviours are covered by `test/unit/mcp-install.test.ts`, T2.3 — confirm each deleted case has
  a counterpart there before deleting it).
- Modify `webview/conduit-mcp-strings.ts`: delete `cursor*` keys `:166-179`, `:208-214`.
- `test/unit/conduit-mcp-host.test.ts` imports neither `cursor-connect` nor `cursor-config`
  (grep at `86e0b9ec`); its `cursor-not-connected` cases (`:394-460`) stay as they are.

**Call sites:** the AC14 grep in the S4 Check, plus `fallow` (dead exports) in S5's `npm run verify`.

**Steps:**
- [ ] Carve-out (removal): proof is the AC14 grep returning nothing, `npm run typecheck`, and the
  S4 vitest set green.
- [ ] Implement.

---

### Slice 5: E2E, visual sweeps, docs

**Check:**
- `npm run e2e -- conduit-mcp-install` passes locally (one scenario);
- `npm run verify` green;
- `npm run e2e:remote -- conduit-mcp-install conduit-mcp-install-banner conduit-mcp-cursor-connect`,
  then `npm run e2e:remote`, green;
- `npm run text-fit` and `npm run shots` produce no new findings for the MCP tab in all three
  themes.

**Parallel groups:** Serial (first): T5.1 · G1: T5.2 · G2: T5.3 · G3: T5.4 · G4: T5.5 · Serial:
T5.6 (authoring only; scenarios are **run** one at a time)
**Claims (serial lane):** `test/e2e/conduit-mcp-helpers.mjs` (T5.1), `CHANGELOG.md` (T5.6)

#### Task 5.1: Fake CLI fixture and helpers

**Files:** Create `test/e2e/fixtures/fake-agent-cli.mjs`; modify `test/e2e/conduit-mcp-helpers.mjs`.

**Interfaces — produces:**
- **Fixture** (`node fake-agent-cli.mjs --records <dir> --name <label>`): config path =
  `$CLAUDE_CONFIG_DIR/.claude.json` when non-empty, else `<os.homedir()>/.claude.json`; reads
  `mcpServers.conduit`; expands `${VAR:-}` and `${VAR}` in `env` from its own env (unset → `''`);
  spawns `command args` with `{...process.env, ...expandedEnv}`; sends `initialize` with
  `clientInfo {name: 'conduit-e2e-fake', version: '1'}`, then `notifications/initialized`, then
  `tools/list`; records `READY {tools}` to `<records>/<label>.jsonl`; prints `fake❯ ` as its idle
  row, with the terminal input handling (raw stdin, echo, Enter, prompt redraw) copied from
  `test/e2e/fixtures/fake-mcp-agent.mjs` so the `fake` adapter's `emptyInput` and echo
  confirmation match it exactly; a typed line containing `[conduit]` calls `read_inbox` and prints each body, recording
  `INBOX {bodies}`; a missing entry records `NO_ENTRY` and exits 3. Records never contain the
  token.
- **Helpers:** `FAKE_CLI` (fixture path); `isolatedHome(userDataDir): {homeDir, env}` with `env =
  {HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CONFIG_HOME:
  ''}`; `cliRecords(dir, label, kind)`; `openMcpSettings(page)` (footer Settings button, then the
  `MCP` nav item).

**Steps:**
- [ ] Carve-out (fixture/harness): proof is T5.2 red before and green after.

#### Task 5.2: `test/e2e/conduit-mcp-install.e2e.mjs`

**Files:** Create `test/e2e/conduit-mcp-install.e2e.mjs`.

**Scenario** `runScenario('conduit-mcp-install', …, {userDataDir: profileDir('mcp-install'), env:
isolatedHome(userDataDir).env})`:
1. **setup:** write `<home>/.claude.json` = `{"mcpServers":{"other":{"command":"x"}}}`; assert
   `app.evaluate(os.homedir())` equals `homeDir` (normalised, as
   `test/e2e/conduit-mcp-cursor-connect.e2e.mjs:23-27`).
2. **install:** `openMcpSettings`; the Claude Code row reads `Not installed`; click `Install
   Conduit for Claude Code`; row reads `Installed`; the file has `mcpServers.conduit` deep-equal to
   the §3.4 Claude entry (exe/shim from `app.evaluate`, as cursor-connect `:43-58`), `other`
   unchanged, `.claude.json.conduit-backup` exists. Close Settings.
3. **connect:** `sid = openSession(page, {path: tmp})` (cmd shell); `typeLine(page, sid,
   `"${process.execPath}" "${FAKE_CLI}" --records "${recordsDir}" --name shell1`)`; `until`
   READY; `mcpState` has `sessions[sid].handle === 'fake-1'` and `.connected === true`; the card
   shows the Plug indicator with name "Connected to Conduit as fake-1".
4. **message:** compose as the human with real clicks, exactly as
   `test/e2e/conduit-mcp-compose.e2e.mjs:59-64` (Messages tab → `New message` → recipient
   `fake-1` → body → `Send`); the host types the notice into the fake's `fake❯` row (the `fake`
   notice adapter via client kind); `until` an `INBOX` record whose bodies include the sent body.
5. **uninstall:** `openMcpSettings`; `Uninstall Conduit from Claude Code`; file has no
   `mcpServers.conduit`, `other` unchanged, file and backup still exist.

All temp dirs removed with `removeDir`.

#### Task 5.3: `test/e2e/conduit-mcp-install-banner.e2e.mjs`

**Files:** Create `test/e2e/conduit-mcp-install-banner.e2e.mjs`.

**Scenario** with `env: {...isolatedHome(userDataDir).env, CONDUIT_E2E_DETECT_GRACE_MS: '1500',
PATH: `${binDir}${path.delimiter}${process.env.PATH}`}` where `binDir` holds a `claude.cmd`
(`@echo stub-claude`) — so `claude` is found and typing it never runs a real Claude:
1. **setup:** `<home>/.claude.json` = `{}`.
2. **detect:** `sid = openSession(page, {path: tmp})`; `typeLine(page, sid, 'claude')`; `until`
   `mcpState().notConnected[sid].cli === 'claude'`; the card shows Unplug with "Not connected:
   install Conduit for Claude Code in Settings → MCP"; the banner region "Conduit setup" shows
   `Install for Claude Code`.
3. **skip list:** `typeLine(page, sid, 'claude --version')` in a second session → no
   `notConnected` for it after 3 s.
4. **palette:** open the palette, run `Set up Conduit MCP…`, the MCP tab is shown; close.
5. **dismiss:** click `Don't suggest again`; the banner is gone; `until` the settings file in
   `userDataDir` holds `mcpInstallPromptDismissed.claude === true`.
6. **second shell:** `sid2`, `typeLine 'claude'`; `notConnected[sid2]` appears; no banner in
   `sid2`'s pane after 2 s.

#### Task 5.4: Migrate `test/e2e/conduit-mcp-cursor-connect.e2e.mjs`

**Files:** Modify it: Settings → `MCP` nav; the row selector is the Cursor `McpInstallRow`;
`Not connected` → `Not installed`; `Connect Cursor` → `Install Conduit for Cursor`; `Disconnect
Cursor` → `Uninstall Conduit from Cursor`; `window.agentDeck.readCursorConnection()` (`:31`) →
`window.agentDeck.mcpInstall.status(null)` and the Cursor `user.path`. Env gains
`CLAUDE_CONFIG_DIR: ''`, `CODEX_HOME: ''`, `XDG_CONFIG_HOME: ''` (use `isolatedHome`). Assertions on
file bytes are unchanged.

#### Task 5.5: Visual sweeps

**Files:** Modify `test/e2e/visual/text-fit-sweep.mjs` (launch `:518`; `mcp-tools` scene `:263`
clicks the `MCP` nav item before `.settools`), `test/e2e/visual/shoot.mjs` (launch `:530-531`;
`settings` scene `:390-405` adds `clickText('.settings__navitem', 'MCP')` + `shot('settings-mcp')`).
Both launches add `isolatedHome(userDataDir).env` so the MCP tab shows the same rows on every
machine and nothing reads the real config files.

**Steps:** run `npm run text-fit` and `npm run shots` for `aero`, `aero-dark`, `neon`; review the
MCP tab and banner-free settings shots; fix any finding in T4.8's CSS.

#### Task 5.6: Docs and CHANGELOG

**Files:**
- `CHANGELOG.md` Unreleased (`:7`): **Added** — install Conduit for Claude Code, Codex, Cursor and
  OpenCode from the new MCP tab; agents started in any terminal join messaging; discovery banner,
  card status, Messages prompt; Repair of entries left by a moved install. **Changed** — "MCP
  settings moved to their own tab"; Cursor "Connect" is now "Install". **Fixed** — the `conduit`
  server outside Conduit no longer shows as failed in Claude Code and OpenCode. Note: "Uninstall
  here before removing Conduit".
- `docs/specs/2026-10-25-conduit-mcp-server.md` §3.1: every session gets token + endpoint; lazy
  handles from `clientInfo`.
- `docs/specs/2026-10-26-conduit-mcp-cursor.md` §3.1: Connect/Disconnect → Install/Uninstall via
  `mcpInstall`; `stale` split into `other-conduit`/`conflict`.
- `docs/specs/2026-10-27-conduit-mcp-install.md` front matter `status: built`.

---

### Slice 6: Runtime QA with real CLIs (after S5)

**Check:** `docs/runs/2026-10-27-mcp-install/qa.md` records, for `claude`, `codex`, `opencode`:
Install from the built app → typed in a cmd/pwsh session → handle + Connected → a human message
read via `read_inbox`; and each CLI **outside** Conduit listing `conduit` connected with 0 tools
(AC10). Every run uses scratch config dirs.

**Parallel groups:** Serial: T6.1
**Claims:** none

#### Task 6.1: Real-CLI QA

**Files:** Create `docs/runs/2026-10-27-mcp-install/qa.md`.

**Steps:**
- [ ] Start the dev build from a pwsh with the S0 scratch env dot-sourced, so Install writes the
  scratch files and every Conduit terminal inherits the same variables. Record the four env values
  first. Never run Install against the real home.
- [ ] Per CLI: Settings → MCP → Install; type the CLI in a new shell session; record handle,
  Connected, a delivered message; exit; run the CLI's list command outside Conduit (`claude mcp
  list`, `codex mcp list`, `opencode mcp list`) in the scratch env; record the `conduit` line.
- [ ] Banner: type `codex` with Codex uninstalled; record the banner and the restart copy after
  Install.
- [ ] Delete the scratch dir.

## Verification

- **Per task:** the named vitest file(s), red then green.
- **Per slice:** the slice's Check, ending in `npm run verify:quick`.
- **After S5, once:** `npm run verify` (full gate). Then remote e2e: the three scenarios by name,
  then `--affected` (full, since `main.ts`/`preload.ts`/`test/e2e/` changed).
- Locally, one e2e by exact name only; never fan e2e out.
- Capture exit codes directly, never through a pipe or pager.
- `git status` after each slice shows only the slice's files; no scratch artifacts in the tree.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **D1** (spec): if S0 finds a running Claude clobbers the key, the Claude user writer
  switches to `claude mcp remove/add-json -s user` plus "Restart running Claude sessions". Default
  taken: direct edit with the mtime guard; T2.3 stops for re-plan if S0 fails.
- [normal] **New dependency `smol-toml` 1.3.1 (exact)** for TOML status, the re-parse guard and
  `readCodexConduit`. Alternative: a hand-written TOML subset parser, which the guard would then
  depend on. Default taken: the dependency (bundled into main by esbuild; `npm run audit` gates it).
- [normal] **Typed candidates are ignored while the session has a live MCP connection.** Without
  this, `codex …` typed as a prompt into a connected Claude in the same shell would raise a false
  "Codex isn't connected" after 15 s. Default taken: ignore while live.
- [normal] **D6 scope:** the ruling's "starts at first `initialize`" is applied to sessions that
  get identity lazily. Profile (adapter) sessions keep starting their screen model at spawn, as
  today, so their notices are unchanged. Default taken: as stated.
- [normal] A lazily started screen model is disposed at PTY exit, not when the last connection
  closes. Default taken: keep until exit (cheaper than restart churn for repeated CLI runs).
- [normal] **Repair** covers user scope only and never runs under `CONDUIT_E2E=1`, so no e2e (and
  no visual sweep) can rewrite a real config file. It is unit-tested with injected IO. Repair reads
  `~/.claude.json` synchronously at startup (it can be several MB). Default taken: as stated.
- [normal] **Shells don't wait for the endpoint:** `whenLaunchReady` stays adapter-only, so a
  shell opened in the first moments after start stays tokenless until relaunched.
- [normal] **TOML byte preservation:** a UTF-8 BOM is re-prefixed and CRLF files get CRLF inserts.
  JSON files are re-serialized without a BOM (the Cursor precedent).
- [normal] **S0/QA auth:** Claude in a scratch `CLAUDE_CONFIG_DIR` needs credentials; S0 uses
  `ANTHROPIC_API_KEY` or copies only `.credentials.json` into the scratch dir and deletes it after.
- [normal] Shells get no per-session MCP tool switch (`switchable` stays adapter-only); their tool
  set is the global switches.
- [normal] The banner's "PTY generation" is the host's `launch` counter (bumped per
  `prepareLaunch`), not `pty.generation`, because the `cursor-not-connected` case is raised before
  the PTY exists.

## Architecture review r1 amendments (2026-10-27, conductor-accepted; override the task text above)

Verdict REVISE (report: architecture-critic). The trust model is accepted: anything holding the
token already runs as the user, the token is revoked at PTY exit, and notices still need a real
idle-screen match.

- **B1 · T3.1:** apply `whenLaunchReady` to **every** definition while messaging is on, bounded at
  3 s. Otherwise persistent shells restored at startup launch before the endpoint listens and stay
  unwired. Drop that out-of-scope bullet and add a unit test.
- **B2 · T3.1:** a session whose definition has no adapter, i.e. one that got its handle lazily,
  appears in `directory()`/`list_sessions` and the card badges **only while it has a live
  connection or has message history**. A health check (`claude mcp list`) must not permanently
  enrol a shell. AC2 test: health check, then close → absent.
- **S1 · T3.3:** `switchable` = adapter sessions **or** any session with a handle, so a shell can
  get per-session tool overrides.
- **S2 · T1.5:** `pickNoticeAdapterId` = the newest live connection whose kind **maps** to an
  adapter. Unmapped kinds are skipped, and the screen check stays the guard. Sent to the slice 1
  executor.
- **S3 · T3.4:** `repair()` runs only when `app.isPackaged`. A dev build must never rewrite entries
  to its own worktree path.
- **S4 · T2.3:**
  - `status()` resolves PATH lookups once per call.
  - `onInstallChanged` re-reads only the CLIs that currently show not-connected.
  - No repeated synchronous re-reads of a multi-MB `~/.claude.json` on the main thread.
- **N1:** "Install for this project" targets the folder of the active session's roots, not only
  known session homes.
- **N2:** xterm focus and device-attribute replies don't count as typed input for detection.
- **N5:** a shell's next launch clears `r.unavailable` after a failed lazy claim.
- **N3 kept:** the project-scope extras stay in the MVP. The user asked for project entries to be
  shown with Remove.
- **N4:** smol-toml is **1.9.1** exact, the current release (1.3.1 is from 2024).
