# Plan: Role brief at launch

Spec: [2026-10-26-conduit-role-brief.md](../specs/2026-10-26-conduit-role-brief.md) (FULL), with
the S0 results in [s0.md](../runs/2026-10-26-role-brief/s0.md).

**Tier: FULL.** The feature adds a host-private store and a new launch-arg seam in the shared spawn
path (`term:start`). It adds four IPC messages and a dialog section, and it crosses `src/`,
`electron/` and `webview/`. Executors are Sonnet subagents and an OpenCode team, so each task is
written to be picked up cold. Planned against `selfhost/cursor` HEAD `31e82f9a` (after Cursor C2/C3).

## Goal

A session created with a role brief launches its CLI with the first user turn
`Read your role brief at <path> and follow it.` exactly once. The brief comes from `agents.json`
or the New session dialog.

## Architecture

- **Pure core:** `src/role-brief.ts`, node-free and renderer-importable. It holds the
  `agents.json` field parser, byte validation, the prompt text, the per-adapter brief args, the
  elided preview args, the spawn decision and the banner text. Each adapter declares its brief
  support in `src/conduit-mcp/adapters.ts` (new `brief` field).
- **Host glue:** `electron/role-brief-host.ts`, `createRoleBriefHost(deps)`, owns all brief IO:
  - the canonical store `<userData>/brief-store/<key>.md`;
  - the exposed copy `<userData>/briefs/<key>/brief.md`;
  - the creation and duplicate transactions;
  - the per-spawn re-materialize and `pending → sent`;
  - delete and the startup sweep;
  - the dialog's probe and agent preview.

  `electron/main.ts` only wires it in. `src/config.ts` splits `agents.json` into definitions,
  which carry no `brief`, and a host-side brief map, so brief text never reaches the renderer's
  `state.agents`.
- **Renderer:** a pure reducer `webview/role-brief-state.ts`, the strings
  `webview/role-brief-strings.ts`, and the component `webview/components/new-session-role-brief.tsx`,
  mounted by `new-session-modal.tsx`. The modal's existing `startBlock` stays unchanged. The modal
  combines it with `briefStartBlock` instead.
- No sketches. Seams copy siblings:
  - the host factory copies `createConduitMcpHost` (`electron/conduit-mcp-host.ts:171`);
  - request/reply copies `folder:probe` and `launch:preview` (`electron/main.ts:2865-2915`);
  - id sanitizing copies `scrollbackFileName` (`src/scrollback-files.ts:13`);
  - the sweep sits beside the scrollback sweep (`electron/main.ts:1920`).

## Data flow

```
CREATE
 dialog ─openRepo{…, brief: BriefRequest}─► main.openRepoRequest
 OS-open / 2nd-instance ─────────────────► main.openRepo(…, {dialog:false})
   roleBriefs.beginCreate({agentId, request, dialog})          [electron/role-brief-host.ts]
     resolve: text | agent def brief (host map) | file (sync read, ≤64 KiB, UTF-8, no NUL)
     id = mgr.mintId(); write brief-store/<key>.md (atomic, sync)
     dialog + error → openRepo:result.error (no session)   silent + error → queueBanner, no brief
   mgr.create(agentId, home, {…, id, brief:'pending'})   (throw ⇒ c.rollback() deletes canonical)
 duplicate ─► roleBriefs.beginDuplicate(srcId) copies canonical→canonical ─► mgr.duplicate(src, {id, brief})

SPAWN  term:start (main.ts:4003) … awaits … isAlive re-check … buildLaunchSpec … cwd aug …
   spec = mcpHost.prepareLaunch(…)                  (MCP args appended)
   scopeArgs = spec.args                            (agent scope never sees brief args)
   b = roleBriefs.prepareSpawn(id, def, spec)       sync: planBriefSpawn → rm+mkdir+copy exposed dir
        spec.args += [--add-dir briefDir]? + ['--', prompt]?(pending only)
   b.banners → scrollbacks.show                     (before pty.start)
   pty.start(spec);  b.commit(pty.isAlive(id))      → mgr.setBrief(id,'sent') → onChange → sessions.json
   scopes.captured(scopeFromSpawnArgs(spec.cwd, scopeArgs, …))

CLI reads <userData>/briefs/<key>/brief.md  (claude via --add-dir; codex: one approval; cursor: silent)

DELETE disposeSession ─► roleBriefs.onSessionDeleted(id) (async rm both)
STARTUP (before any window/2nd-instance) ─► roleBriefs.sweep(live ids ∪ ids in sessions.json on disk)
DIALOG brief:agentPreview / brief:probe / file:pick ─► host ─► replies (latest requestId wins)
       launch:preview{brief:true} ─► previewLaunch appends elided brief args + briefBlocked
```

## Settled decisions — do not re-litigate

- Everything in spec §§2–8. D2–D6 take the spec defaults: snapshot a file brief; `sent` means
  launched; duplicate copies the canonical brief as `pending`; no Settings editor; no header in
  the brief file.
- **D1 (human ruling):**
  - Claude gets `--add-dir <briefDir>`, so it reads silently (S0-6).
  - **Codex reads in place.** S0-2 showed one `Get-Content` approval, and that is accepted.
    **Never `--add-dir` for Codex**, because it makes the dir writable.
  - **Cursor reads in place.** S0-3 showed no approval.
  - fake (e2e) reads in place.
- **`--` is used uniformly** for every adapter, and the prompt is always the last argv entry.
  S0-1: all three CLIs accept it, and Claude needs it. There is no fallback placement.
- **The brief dir is not made read-only.** S0-6 saw no `CLAUDE.md` loading. The per-spawn rebuild
  is the defence.
- **Brief text stays host-side.** `loadAgentsConfig` strips `brief` from the definitions, so it
  never rides `state.agents`. The host holds `ReadonlyMap<agentId, AgentBriefSource>`.
- **File key** = the session id with `/[^\w.-]/g` → `_`, the same transform as
  `scrollbackFileName`. Restored ids are untrusted input.
- **A `sent` launch whose canonical file is missing** clears `brief`, adds no read flag and logs a
  warn, with **no banner**. Nothing was due to be sent. The banner is only for `pending`.
- **The cmd guard also applies to `sent` launches** (Claude's read flag). It then clears `brief`
  with the same banner.
- **The renderer learns brief support** from `brief:agentPreviewed.supported`. It is a plan
  addition, already written into spec §3.4.

## Spec staleness

| Spec claim | Measured | How the plan proceeds |
|---|---|---|
| §3.4 "the renderer never sees `agents.json`" | `loadAgents` casts the raw JSON (`src/config.ts:17-19`) and the defs reach the renderer in `state.agents` (`src/protocol.ts:415`). An unknown `brief` key would ride along | T3.1 replaces `loadAgents` with `loadAgentsConfig`, which strips `brief` from each def |
| §3.2 "brief `--add-dir` never feeds the agent-scope banner" | `scopes.captured` reads the **final** args (`electron/main.ts:4165-4169`) | T4.2 captures the scope from the args as they were **before** `prepareSpawn` |
| §2.2 step 3 "writes sessions.json immediately" | `mgr.onChange` → `persistFile` is an immediate async atomic write, not debounced (`electron/main.ts:1940-1960`, `:445`) | `mgr.setBrief` emits, and that is the write. No new write path |
| §2.2 step 1 "pre-mint the id through a new `id` option" | `SessionManager.newId` is private (`src/session-manager.ts:66`) | T2.2 adds `mintId()` plus `id`/`brief` on `SessionCreateOpts`. `create` throws on a duplicate id |
| §2.4 "enumerate every `mgr.create` call site" | `mgr.create` has 1 call site (`openRepo`, `electron/main.ts:2181`), and `mgr.duplicate` 1 (`:3594`). `openRepo` has 3 callers: `:2407` dialog, `:4990` OS file-open, `:5003` OS dir-open | Dialog → `dialog:true`. The two OS paths → `dialog:false` (agent default). Duplicate → `beginDuplicate` |
| §7 e2e "type `quit` so the fake exits, and press Relaunch" | The fake never exits by itself (`test/e2e/fixtures/fake-mcp-agent.mjs:162`). Relaunch is the `relaunch` message (`electron/main.ts:3549`, posted directly in `test/e2e/durability.e2e.mjs:121`) | T6.1 adds `quit` and an `ARGV` record to the fake. The e2e waits for `exited`, then posts `relaunch` |
| §3.4 `file:pick { requestId, title }` | `createFolderPicker` has only `pick` (openDirectory), with an e2e queue (`electron/folder-picker.ts:23-41`) | T2.3 adds `pickFile(win, title)`, which shares the same queue and single-open guard |

## Global constraints

- **Gate:**
  - Inner loop: `npm run verify:quick`. One file: `npx vitest run test/unit/<name>.test.ts`.
  - Full `npm run verify` before merge. It is also the pre-commit hook. Never `--no-verify`.
  - Never narrow, skip or disable a check.
  - Capture exit codes directly, never through `tail`/`head`.
- **Comments say why only.** When the why is in the spec, use a one-line pointer
  (`// see docs/specs/2026-10-26-conduit-role-brief.md §3.3`).
- **No band-aids:** no `as any`, `@ts-ignore`, swallowed errors or fallbacks. Every `catch` maps to
  a named `BriefError`/banner or logs through the injected `log`.
- **Node-free:** `src/role-brief.ts`, `src/conduit-mcp/adapters.ts` and `webview/role-brief-*.ts`
  import no `node:*` and no node-backed module, not even type-only. Use `TextEncoder` and
  `TextDecoder('utf-8', { fatal: true })` for bytes.
- **Platform-free unit tests (CI is ubuntu):**
  - `src/role-brief.ts` takes a `resolve` function; tests pass `path.posix.resolve` with posix
    fixtures.
  - Host tests build paths with `path.join(os.tmpdir(), …)` and assert with the same `path.join`.
    Never assert `\` or a drive letter.
- **Host fs:** brief IO is **sync**, deliberately: one ≤64 KiB file at creation, and one
  rm+mkdir+copy per spawn. It must run inside `term:start`'s synchronous block after the
  `isAlive` re-check (spec §4 race row). The probe is async (`fs.promises`). Delete is async.
- **Renderer:**
  - New CSS classes use the `ns-brief` prefix (`ns-brief__mode`, `ns-brief__count`, …). No bare
    generics (`test/unit/monaco-class-collision.test.ts`).
  - Use existing `ns__*` / form / danger tokens. No new colors.
  - Never name state `open`, `name`, `status` or `event`.
  - jsdom tests use `// @vitest-environment jsdom` and the `act`/`createRoot` setup in
    `test/unit/new-session-modal.test.ts`.
- **Naming:** kebab-case files, `createX` factories, `SCREAMING_SNAKE` constants, tests at
  `test/unit/<module>.test.ts(x)`, strings in `BRIEF_STR` (`webview/role-brief-strings.ts`).
- **Fallow:** every new export needs an importer (tests count). `src/protocol.ts` and
  `src/types.ts` are export-ignored.
- **E2E:**
  - Launch only via `launchElectron`/`runScenario`, exit only via `finishScenario`, and run hidden.
  - Executors **never** run e2e. The orchestrator runs `npm run e2e -- role-brief` locally (one
    scenario), then `npm run e2e:remote -- --full`, because `electron/main.ts` and
    `test/e2e/fixtures/**` are FULL triggers.
- **Scripts:** none. No routine repeats across more than a couple of files.

## Out of scope

- The spec's v1 and Vision items: the card line "Role brief sent · Open", a Settings editor, and
  templates.
- Resume, re-send, MCP-set briefs, and CLIs without an initial-prompt arg.
- The parent spec's §3.1 pointer line. Its owner applies it (spec §9).

## Contracts

### `src/types.ts` (T1.1)

```ts
export type BriefState = 'pending' | 'sent';
export type AgentBriefSource = { kind: 'text'; text: string } | { kind: 'file'; path: string }; // path absolute
export type BriefRequest =
  | { kind: 'agent' } | { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'file'; path: string };
export type BriefError = 'brief-unreadable' | 'brief-too-large' | 'brief-invalid' | 'brief-io';
// Session gains:
  /** Role brief state (docs/specs/2026-10-26-conduit-role-brief.md §2.3). Persisted. */
  brief?: BriefState;
```

### `src/protocol.ts` (T1.1)

```ts
// LaunchPreviewResult gains:
  briefBlocked?: string;                         // the cmd metachar, when the launcher is batch-guarded and userData has one
// WebviewToHost:
  openRepo gains `brief?: BriefRequest`            // absent ⇒ { kind: 'agent' }
  launch:preview gains `brief?: boolean`           // true ⇒ append the elided brief args
  | { type: 'brief:probe'; requestId: number; path: string }
  | { type: 'brief:agentPreview'; requestId: number; agentId: string }
  | { type: 'file:pick'; requestId: number; title: string }
// HostToWebview:
  openRepo:result.error: 'home-missing' | 'invalid-path' | 'unknown-agent' | BriefError
  | { type: 'brief:probed'; requestId: number; ok: boolean; bytes?: number; error?: BriefError }
  | { type: 'brief:agentPreviewed'; requestId: number; supported: boolean; has: boolean;
      firstLine?: string; path?: string; error?: BriefError }
  | { type: 'file:picked'; requestId: number; path: string | null }
```

### `src/conduit-mcp/adapters.ts` (T2.1)

```ts
export interface BriefSupport { readAccess: 'add-dir' | 'none' }
// McpAdapter gains (required):  brief: BriefSupport | null;
// claude { readAccess: 'add-dir' } · codex { readAccess: 'none' } · cursor { readAccess: 'none' } · fake { readAccess: 'none' }
```

### `src/role-brief.ts` (new, node-free) (T2.1)

```ts
export const BRIEF_MAX_BYTES = 65_536;
export const BRIEF_PREVIEW_DIR = '…/briefs/<id>';
export function briefPrompt(briefFile: string): string;      // `Read your role brief at ${briefFile} and follow it.`
export function parseBriefField(
  raw: unknown,
  ctx: { agentsDir: string; homeDir: string; resolve: (...p: string[]) => string },
): AgentBriefSource | undefined | 'invalid';
// undefined ⇔ raw === undefined. 'invalid' ⇔ raw is anything other than a string or exactly {file: non-empty string}.
// A string → {kind:'text', text: raw}. A file starting with '~/' → resolve(homeDir, rest); else resolve(agentsDir, file).
export type DecodedBrief = { ok: true; text: string | null } | { ok: false; error: 'brief-too-large' | 'brief-invalid' };
export function decodeBrief(bytes: Uint8Array): DecodedBrief;
// Strip a leading UTF-8 BOM. Invalid UTF-8 or any U+0000 → 'brief-invalid'. Empty after trim → text null.
// More than BRIEF_MAX_BYTES of trimmed UTF-8 → 'brief-too-large'. Otherwise text = the BOM-stripped, untrimmed string.
export function decodeBriefText(text: string): DecodedBrief;  // the same rules for dialog text (encode, then decode)
export function briefByteCount(text: string): number;        // UTF-8 byte length of text.trim()
export function briefArgs(support: BriefSupport, p: { briefDir: string; briefFile: string; sendPrompt: boolean }): string[];
// [...(readAccess==='add-dir' ? ['--add-dir', briefDir] : []), ...(sendPrompt ? ['--', briefPrompt(briefFile)] : [])]
export function briefPreviewArgs(support: BriefSupport): string[];
// briefArgs(support, { briefDir: BRIEF_PREVIEW_DIR, briefFile: `${BRIEF_PREVIEW_DIR}/brief.md`, sendPrompt: true })
export type BriefDrop = { code: 'file-missing' } | { code: 'cmd-metachar'; char: string };
export type BriefSpawnPlan =
  | { kind: 'none' }                                         // no brief, or no support: no args, no fs
  | { kind: 'args'; sendPrompt: boolean }                    // rebuild the exposed dir, then add briefArgs
  | { kind: 'clear'; drop: BriefDrop; banner: boolean };     // brief → absent; banner ⇔ state was 'pending'
export function planBriefSpawn(i: {
  state: BriefState | undefined;
  support: BriefSupport | null;
  canonicalExists: boolean;
  guarded: boolean;                                          // batchGuarded(platform, spec.command)
  briefDir: string;
  briefFile: string;
}): BriefSpawnPlan;
// Order: state undefined or support null → none. !canonicalExists → clear file-missing.
// guarded && firstCmdMetachar(briefPrompt(briefFile)) ?? firstCmdMetachar(briefDir) → clear cmd-metachar.
// Else args, with sendPrompt = state === 'pending'.
export type BriefBannerReason = BriefDrop | { code: BriefError } | { code: 'rebuild-failed' } | { code: 'copy-failed' };
export function briefBanner(r: BriefBannerReason): string;
// '\r\n\x1b[2m— role brief not sent: <reason> —\x1b[0m\r\n'. Reasons:
//   file-missing → 'file missing'; cmd-metachar → `path has "<c>"`; brief-unreadable → "can't read the file";
//   brief-too-large → 'over 64 KiB'; brief-invalid → 'not UTF-8 text'; brief-io → "couldn't save it";
//   rebuild-failed → "couldn't prepare it, will retry next launch"; copy-failed → "couldn't copy it from the original"
```

### `src/session-manager.ts` (T2.2)

```ts
export interface SessionCreateOpts { /* existing */ id?: string; brief?: BriefState }
mintId(): string;                                  // newId() until it is not a live id
create(agentId, home, opts): Session;              // opts.id taken ⇒ throw Error(`Session id in use: ${id}`); sets brief when given
duplicate(id: string, opts?: { id?: string; brief?: BriefState }): Session | undefined;  // forwards both to create
setBrief(id: string, brief: BriefState | undefined): boolean;  // undefined deletes the key; emits only on a change
```

### `src/persistence.ts` (T2.2)

`parseSessions` keeps `brief` only when it is `'pending'` or `'sent'`, and deletes the key
otherwise. `serializeSessions` is unchanged, because `brief` rides the existing spread.

### `electron/folder-picker.ts` (T2.3)

```ts
// FolderPicker gains:
pickFile(win: BrowserWindow | null, title: string): Promise<string | null>;  // queue first; properties ['openFile']; same per-window guard
```

### `src/config.ts` (T3.1)

```ts
export interface AgentsConfig { defs: AgentDefinition[]; briefs: Map<string, AgentBriefSource> }
export function loadAgentsConfig(file: string, opts: {
  homeDir: string; e2e: boolean; warn: (message: string, data?: Record<string, unknown>) => void;
}): AgentsConfig;
// Replaces loadAgents (its only caller is electron/main.ts:1283). Missing/malformed/empty → { defs: [], briefs: new Map() }.
// Each def is returned without its `brief` key. parseBriefField(raw.brief, { agentsDir: dirname(file), homeDir, resolve: path.resolve }):
//   'invalid' → warn('agent brief ignored: invalid shape', { id }) once per def;
//   a source on a def where adapterFor(def, { e2e })?.brief is null/undefined → warn('agent brief ignored: launcher takes no brief', { id });
//   otherwise briefs.set(def.id, source).
```

### `src/launch-preview.ts` (T3.3)

`previewLaunch(input: { agentId; home; roots; brief?: unknown }, deps: { …existing; userData: string;
e2e: boolean })`:
- It finds `support = adapterFor(def, { e2e })?.brief`.
- When `support` is set and `batchGuarded(platform, plan.spec.command)` holds, the result gets
  `briefBlocked = firstCmdMetachar(userData)`, if that finds a char.
- When `input.brief === true`, `support` is set and `briefBlocked` is not set, `args` and
  `display` are formatted from `[...plan.spec.args, ...briefPreviewArgs(support)]`.
- An unsupported launcher is unchanged.

### `electron/role-brief-host.ts` (new) (T3.2)

```ts
export interface RoleBriefHostDeps {
  userData: string;
  agentBriefs: ReadonlyMap<string, AgentBriefSource>;
  mgr: Pick<SessionManager, 'get' | 'setBrief' | 'mintId'>;
  platform: HostPlatform;
  e2e: boolean;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;     // electron/logger.ts
}
export type BriefCreation =
  | { ok: true; id: string; brief: BriefState | undefined; rollback(): void }  // rollback: sync-delete the canonical file
  | { ok: false; error: BriefError };
export interface RoleBriefHost {
  supportFor(def: AgentDefinition | undefined): BriefSupport | null;   // adapterFor(def,{e2e})?.brief ?? null
  beginCreate(i: { def: AgentDefinition; request: BriefRequest | undefined; dialog: boolean }): BriefCreation;
  beginDuplicate(sourceId: string): { id: string; brief: BriefState | undefined; rollback(): void };
  prepareSpawn(sessionId: string, def: AgentDefinition | undefined, spec: SpawnSpec):
    { spec: SpawnSpec; banners: string[]; commit(alive: boolean): void };
  onSessionDeleted(sessionId: string): Promise<void>;
  sweep(keepIds: ReadonlySet<string>): void;
  probe(path: string): Promise<{ ok: true; bytes: number } | { ok: false; error: BriefError }>;
  agentPreview(def: AgentDefinition | undefined): Promise<Omit<Extract<HostToWebview, { type: 'brief:agentPreviewed' }>, 'type' | 'requestId'>>;
}
export function createRoleBriefHost(deps: RoleBriefHostDeps): RoleBriefHost;
```

Behaviour:
- **Paths.** `key = id.replace(/[^\w.-]/g, '_')`. Canonical is
  `path.join(userData, 'brief-store', key + '.md')`. `briefDir` is
  `path.join(userData, 'briefs', key)`, and `briefFile` is `path.join(briefDir, 'brief.md')`.
- **`beginCreate`:**
  - With no support, or with `request` `none`, it returns `{ok, id: mintId(), brief: undefined}`.
  - Otherwise it resolves the source:
    - `request` `text` → `decodeBriefText`;
    - `request` `file` → `readFileSync` then `decodeBrief`;
    - `request` `agent` or `undefined` → `agentBriefs.get(def.id)` (a text or file source), and
      no source → no brief.
  - A read failure is `brief-unreadable`. `text: null` → no brief.
  - It mints the id and writes the canonical file with `mkdirSync` + `atomicWriteFileSync`. A
    write failure is `brief-io`.
  - On error, a `dialog` creation returns `{ok:false, error}` and writes nothing. A silent one
    returns `{ok:true, brief: undefined}` and queues `briefBanner({code: error})` for that id.
  - Success → `brief: 'pending'`.
- **`beginDuplicate`:**
  - It mints an id.
  - A source with `brief` set copies canonical → canonical (`copyFileSync`) and returns
    `'pending'`.
  - A copy failure logs a warn, queues the `copy-failed` banner and returns no brief.
- **`prepareSpawn`:**
  - It runs `planBriefSpawn` with `guarded = batchGuarded(platform, spec.command)`.
  - `args` → `rmSync(briefDir, {recursive, force})`, `mkdirSync`, `copyFileSync(canonical,
    briefFile)`, then appends `briefArgs`.
    - A rebuild throw → no args, state unchanged, a warn log and the `rebuild-failed` banner.
  - `clear` → `mgr.setBrief(id, undefined)`. A banner only when `plan.banner`. A warn log always.
  - The banners include any queued one for the id. Taking them drains the queue.
  - `commit(alive)` → `setBrief(id, 'sent')` only when the plan sent the prompt and `alive`.
- **`onSessionDeleted`** → `fs.promises.rm` of both paths (force). A failure is a warn log.
- **`sweep`:**
  - It lists `brief-store/*.md` and `briefs/*`, and removes each entry whose key is not in
    `{key(id) | id ∈ keepIds}`.
  - An ENOENT dir is skipped silently. Any other error is a warn, and the sweep goes on.
- **`probe`** → `fs.promises.readFile` + `decodeBrief`. Its errors are
  `brief-unreadable` / `brief-too-large` / `brief-invalid`. Empty text gives `{ok:true, bytes:0}`.
- **`agentPreview`:**
  - It returns `supported = supportFor(def) !== null`.
  - `has` is whether `agentBriefs` holds the def's id.
  - `firstLine` is the first non-empty trimmed line, capped at 120 chars, from the text or the
    file read.
  - `path` is set for a file source.
  - `error` is set on a read or decode failure.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `agents.json` `brief` | human | `loadAgentsConfig` → `RoleBriefHost.agentBriefs` | both (T3.1, T4.1) |
| `state.agents` defs | `LauncherHost` from `loadAgentsConfig().defs` | renderer launch row, preview | producer only (now brief-free). Consumers read `id/label/command/args/icon/color` only (`webview/components/new-session-launch-row.tsx`). Unaffected |
| `openRepo.brief` / `openRepo:result.error` | dialog (T5.3) | `openRepoRequest` (T4.1) | both |
| `brief:probe` / `brief:agentPreview` / `file:pick` | dialog component (T5.2, T5.3) | main IPC (T4.1) → `RoleBriefHost` (T3.2) / `FolderPicker` (T2.3) | both |
| `launch:preview.brief` / `briefBlocked` | modal (T5.3) / `previewLaunch` (T3.3) | `previewLaunch` / `briefStartBlock` (T5.1) | both |
| canonical `brief-store/<key>.md` | `beginCreate`, `beginDuplicate` | `prepareSpawn`, `beginDuplicate`, `sweep`, `onSessionDeleted` | both (T3.2) |
| exposed `briefs/<key>/brief.md` | `prepareSpawn` | the CLI's file read | host side. CLI side measured in S0, re-checked in runtime QA |
| `Session.brief` | `mgr.create`/`duplicate`/`setBrief` | `prepareSpawn`, `serializeSessions`/`parseSessions` | both. Renderer: no consumer in MVP (spec §3.5) |
| spawn argv tail | `prepareSpawn` (after `mcpHost.prepareLaunch`) | the CLI parser; `scopeFromSpawnArgs` | both. The scope gets the pre-brief args (T4.2) |
| first CLI turn / Codex read approval | CLI | notice gate (`evaluateGate`) | consumer unchanged: the session is busy, and Codex's approval matches `/enter to confirm or esc to cancel/i` (`src/conduit-mcp/adapters.ts`), so it is blocking |
| `mgr.create` id option | `mintId` | the two `openRepo` OS callers, the dialog and duplicate | every call site is enumerated in T4.1 |
| MCP modules ↛ brief | — | — | provenance test (T3.2) asserts `electron/conduit-mcp-host.ts`, `electron/conduit-mcp-endpoint.ts` and `src/conduit-mcp/*.ts` other than `adapters.ts` import neither `role-brief`, and that no `CONDUIT_TOOLS` schema has a `brief` property |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `BriefState`, `AgentBriefSource`, `BriefRequest`, `BriefError`; `Session.brief` |
| `src/protocol.ts` | modify | the wire additions above |
| `src/conduit-mcp/adapters.ts` | modify | `BriefSupport`, `McpAdapter.brief`, the header pointer to spec §3.2 |
| `src/role-brief.ts` | create | the pure brief core |
| `src/session-manager.ts` | modify | `mintId`, `id`/`brief` create opts, `duplicate` opts, `setBrief` |
| `src/persistence.ts` | modify | `brief` validation in `parseSessions` |
| `src/config.ts` | modify | `loadAgentsConfig` replaces `loadAgents` |
| `src/launch-preview.ts` | modify | brief preview args + `briefBlocked` |
| `electron/folder-picker.ts` | modify | `pickFile` |
| `electron/role-brief-host.ts` | create | brief IO + creation/spawn/delete/sweep/probe/preview |
| `electron/main.ts` | modify | wiring only (T4.1, T4.2) |
| `webview/role-brief-strings.ts` | create | `BRIEF_STR` |
| `webview/role-brief-state.ts` | create | dialog brief reducer + `briefStartBlock` + `briefRequestOf` |
| `webview/components/new-session-role-brief.tsx` | create | the "Role brief" section |
| `webview/components/new-session-modal.tsx` | modify | mount the section, preview flag, openRepo brief, start block, errors |
| `webview/styles.css` | modify | `ns-brief*` rules |
| `test/unit/role-brief.test.ts` | create | the pure core (AC1 parse, 2–4 args, 5 decision, 7 decode) |
| `test/unit/conduit-mcp-adapters.test.ts` | modify | the brief support table |
| `test/unit/session-manager.test.ts`, `test/unit/persistence.test.ts` | modify | AC8 id, AC10 round-trip |
| `test/unit/folder-picker.test.ts` | modify | `pickFile` |
| `test/unit/config-agents.test.ts` | create | `loadAgentsConfig` (AC1 load-level) |
| `test/unit/launch-preview.test.ts` | modify | AC4 preview, AC12 elided args |
| `test/unit/role-brief-host.test.ts` | create | AC2, 5, 6, 7, 8, 9, 10 (delete/sweep) |
| `test/unit/role-brief-provenance.test.ts` | create | AC11 |
| `test/unit/role-brief-state.test.ts` | create | the reducer + block |
| `test/unit/new-session-role-brief.test.tsx` | create | AC12 component |
| `test/unit/new-session-modal.test.ts` | modify | the modal integration |
| `test/e2e/fixtures/fake-mcp-agent.mjs` | modify | an `ARGV` record + `quit` |
| `test/e2e/role-brief.e2e.mjs` | create | the e2e scenario |
| `CHANGELOG.md` | modify | `[Unreleased]` → Added |

## Slices

Order: S1 → {S2 groups} → {S3 groups} → S4 (main.ts lane). S5 (renderer) can start right after S1
and T2.1, in parallel with S3/S4. S6 comes last.

### Slice 1: Contracts

**Check:** `npm run typecheck` passes, and `npx vitest run test/unit/persistence.test.ts` stays
green.

**Parallel groups:** Serial: T1.1
**Claims (serial lane):** `src/types.ts`, `src/protocol.ts`

#### Task 1.1: Wire and model types

**Files:**
- Modify: `src/types.ts`: add the four types and `Session.brief` (Contracts §types).
- Modify: `src/protocol.ts`: add the fields and messages (Contracts §protocol). Import
  `BriefRequest`/`BriefError` from `./types`.

**Interfaces:** Produces exactly the `src/types.ts` and `src/protocol.ts` blocks above.

**Call sites:** the `openRepo:result.error` union widens.
- `START_ERROR` in `webview/components/new-session-modal.tsx:32` is a
  `Record<OpenRepoError, string>`, so typecheck fails until it has the four brief keys.
- Add them in this task, with their final copy:
  - `'brief-unreadable': "can't read the role brief file"`;
  - `'brief-too-large': 'role brief is over 64 KiB'`;
  - `'brief-invalid': 'role brief is not UTF-8 text'`;
  - `'brief-io': "couldn't save the role brief"`.
- T5.3 moves them to `BRIEF_STR`.

**Steps:**
- [ ] Add the types. Run `npm run typecheck`. Expect FAIL at `START_ERROR` (missing keys).
- [ ] Add the four `START_ERROR` entries. Typecheck passes.

### Slice 2: Pure core, session model, file picker

**Check:**
`npx vitest run test/unit/role-brief.test.ts test/unit/conduit-mcp-adapters.test.ts test/unit/session-manager.test.ts test/unit/persistence.test.ts test/unit/folder-picker.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** G1: T2.1 · G2: T2.2 · G3: T2.3
**Claims (serial lane):** none (each task owns its files)

#### Task 2.1: `src/role-brief.ts` + adapter brief support

**Files:**
- Create: `src/role-brief.ts` (Contracts §role-brief). It imports `firstCmdMetachar` from
  `./launch-args`, `BriefSupport` (type) from `./conduit-mcp/adapters`, and the types from
  `./types`.
- Modify: `src/conduit-mcp/adapters.ts`:
  - add `BriefSupport`, and `brief` on `McpAdapter` and on all four entries;
  - add to the header comment: `// Brief support: docs/specs/2026-10-26-conduit-role-brief.md §3.2`.
- Test: `test/unit/role-brief.test.ts` (create), `test/unit/conduit-mcp-adapters.test.ts` (modify).

**Interfaces:**
- Produces: everything in Contracts §role-brief and §adapters.
- Consumes: `BriefState`, `AgentBriefSource`, `BriefError` from `src/types.ts` (T1.1).

**Steps:**
- [ ] Failing tests:
  - `parseBriefField`:
    - a string gives text;
    - `{file:'b.md'}` gives `resolve('/cfg','b.md')`;
    - `{file:'~/b.md'}` gives `resolve('/home/u','b.md')`;
    - `{}`, `{file:1}`, `{file:'x',x:1}`, `7` and `{file:''}` give `'invalid'`;
    - `undefined` gives `undefined`.
  - `decodeBrief`:
    - a BOM is stripped, and the text is otherwise verbatim;
    - `'  \n'` gives `text:null`;
    - 65 536 trimmed bytes are ok, and 65 537 give `brief-too-large`;
    - `[0xff]` gives `brief-invalid`;
    - text containing `\0` gives `brief-invalid`.
  - `briefArgs`:
    - claude support + `sendPrompt` → `['--add-dir', D, '--', 'Read your role brief at F and follow it.']`;
    - `readAccess:'none'` → `['--', prompt]`;
    - `sendPrompt:false` + none → `[]`.
  - `planBriefSpawn` covers each row of its order comment:
    - `guarded` + `%` in `briefDir` → `clear` with `{code:'cmd-metachar', char:'%'}`;
    - `banner` is true only for `pending`.
  - `briefBanner({code:'cmd-metachar', char:'%'})` contains `path has "%"`.
  - `briefPreviewArgs({readAccess:'add-dir'})` →
    `['--add-dir','…/briefs/<id>','--','Read your role brief at …/briefs/<id>/brief.md and follow it.']`.
  - `briefByteCount(' é ') === 2`.
  - `decodeBriefText` matches `decodeBrief` on the same text.
  - adapters: claude `brief.readAccess === 'add-dir'`; codex, cursor and fake `'none'`.
- [ ] Run `npx vitest run test/unit/role-brief.test.ts test/unit/conduit-mcp-adapters.test.ts`.
  Expect FAIL (the module is missing).
- [ ] Implement within the signatures.

#### Task 2.2: Session model

**Files:**
- Modify: `src/session-manager.ts` (Contracts §session-manager).
- Modify: `src/persistence.ts` (`parseSessions` brief validation).
- Test: `test/unit/session-manager.test.ts`, `test/unit/persistence.test.ts` (modify).

**Interfaces:**
- Produces: `mintId(): string`;
  `create(agentId, home, opts: SessionCreateOpts & { id?: string; brief?: BriefState })`;
  `duplicate(id, opts?: { id?: string; brief?: BriefState })`;
  `setBrief(id, brief: BriefState | undefined): boolean`.
- Consumes: `BriefState` from `src/types.ts`.

**Call sites:** `mgr.duplicate(m.id)` at `electron/main.ts:3594` stays valid (opts optional), and
T4.1 changes it.

**Steps:**
- [ ] Failing tests:
  - `create` with `{id:'abc', brief:'pending'}` → `get('abc').brief === 'pending'`;
  - a second `create` with `id:'abc'` throws;
  - `mintId` skips a live id (the stub `newId` returns `'a','a','b'` while `'a'` is live → `'b'`);
  - `duplicate(src, {id:'d', brief:'pending'})` → `get('d').brief === 'pending'`, and with no opts
    → no `brief`;
  - `setBrief(id, undefined)` removes the key and emits; the same value twice emits once;
  - `parseSessions`: `brief:'sent'` round-trips through `serializeSessions`; `brief:'bogus'` →
    the `brief` key is absent.
- [ ] Run the two files. Expect FAIL.
- [ ] Implement.

#### Task 2.3: `FolderPicker.pickFile`

**Files:** Modify `electron/folder-picker.ts`. Test `test/unit/folder-picker.test.ts`.

**Interfaces:** Produces `pickFile(win: BrowserWindow | null, title: string): Promise<string | null>`.

**Steps:**
- [ ] Failing tests:
  - a queued hook entry answers `pickFile` first;
  - otherwise `showOpenDialog` gets `properties: ['openFile']` and the title;
  - a canceled dialog → `null`;
  - a second concurrent `pickFile` for the same window → `null` with no second dialog;
  - `pick` and `pickFile` share the one per-window guard.
- [ ] Run it. Expect FAIL.
- [ ] Implement by extracting the shared body of `pick` into a private `open(win, opts)`.

### Slice 3: Host modules

**Check:**
`npx vitest run test/unit/config-agents.test.ts test/unit/role-brief-host.test.ts test/unit/role-brief-provenance.test.ts test/unit/launch-preview.test.ts`
passes, and `npm run verify:quick` is green.

**Parallel groups:** G1: T3.1 · G2: T3.2 · G3: T3.3
**Claims (serial lane):** none

#### Task 3.1: `loadAgentsConfig`

**Files:** Modify `src/config.ts`: replace `loadAgents` with `loadAgentsConfig` (Contracts
§config). Test: create `test/unit/config-agents.test.ts`. It writes temp `agents.json` files under
`path.join(os.tmpdir(), …)`.

**Interfaces:**
- Produces: `loadAgentsConfig(file, { homeDir, e2e, warn }): AgentsConfig`.
- Consumes:
  - `parseBriefField(raw, { agentsDir, homeDir, resolve })` → `AgentBriefSource | undefined | 'invalid'`;
  - `adapterFor(def, { e2e })` and `McpAdapter.brief: BriefSupport | null`;
  - `AgentBriefSource` from `src/types.ts`.

**Call sites:** `electron/main.ts:35` (import) and `:1283` (`config: loadAgents(agentsFile())`).
T4.1 updates both. Until then typecheck fails, so **T3.1 and T4.1 must land in the same merge**.
The orchestrator merges S3 and S4 together, or T3.1 keeps a one-line `loadAgents` re-export
until T4.1 deletes it. The second is preferred: T3.1 keeps
`export function loadAgents(file: string): AgentDefinition[]` as
`loadAgentsConfig(file, { homeDir: os.homedir(), e2e: false, warn: () => {} }).defs`, and T4.1
removes it.

**Steps:**
- [ ] Failing tests:
  - a claude def with `brief:'x'` → `briefs.get(id)` is `{kind:'text', text:'x'}`, and
    `'brief' in defs[0] === false`;
  - `{file:'b.md'}` resolves next to the agents file;
  - `{}` → no brief, the def is kept, and `warn` is called once;
  - a brief on a `command: 'aider'` def → ignored, with one warn;
  - malformed JSON → `{defs: [], briefs: empty}`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 3.2: `electron/role-brief-host.ts`

**Files:**
- Create: `electron/role-brief-host.ts` (Contracts §role-brief-host).
- Test: create `test/unit/role-brief-host.test.ts` (real fs under a `mkdtempSync(path.join(os.tmpdir(), 'role-brief-'))`
  userData, a stub `mgr` holding sessions in a Map, `platform: 'posix'`, plus one `'win32'` case
  for the guard).
- Test: create `test/unit/role-brief-provenance.test.ts`.

**Interfaces:**
- Produces: `createRoleBriefHost(deps: RoleBriefHostDeps): RoleBriefHost` and `BriefCreation`,
  exactly as in Contracts.
- Consumes:
  - from `src/role-brief.ts`: `planBriefSpawn`, `briefArgs`, `briefBanner`, `decodeBrief`,
    `decodeBriefText`, and the `BriefSpawnPlan`/`BriefBannerReason` types;
  - from `src/conduit-mcp/adapters.ts`: `adapterFor`, `BriefSupport`;
  - from `src/launch-args.ts`: `batchGuarded`;
  - `atomicWriteFileSync` (`src/atomic-write.ts`);
  - `SessionManager.get/setBrief/mintId` (T2.2);
  - `Logger` (`electron/logger.ts`).

**Steps:**
- [ ] Failing tests, one per spec AC:
  - AC2: a claude def; spec args `['--model','opus','--add-dir','/r1','--mcp-config','f','--allowedTools','a,b']`;
    the session is `pending`.
    - The output args end `['--add-dir', briefDir, '--', 'Read your role brief at <briefFile> and follow it.']`.
    - `--add-dir briefDir` occurs once.
    - The input array is not mutated.
  - AC3: codex and fake defs → the args end `['--', prompt]`, with no `briefDir` anywhere.
  - AC4: `platform:'win32'`, `spec.command` ending `.cmd`, and a userData containing `%` → no
    brief args, `brief` cleared, one banner containing `path has "%"`, and the args equal the input.
  - AC5:
    - `pending` + `commit(true)` → `setBrief(id,'sent')`;
    - `commit(false)` → still `pending`;
    - `sent` → claude args end `['--add-dir', briefDir]`, and `commit(true)` does not call
      `setBrief`;
    - `pending` with the canonical file deleted → no args, cleared, banner `file missing`;
    - a session constructed as restored (`status:'stale'`, `brief:'pending'`) sends once.
  - AC6: write `briefs/<key>/CLAUDE.md`, and overwrite `brief.md` with `'edited'`. After
    `prepareSpawn` only `brief.md` exists, and it equals the canonical copy.
  - AC7:
    - `beginCreate` text `'﻿hello '` → the canonical file reads `'hello '`;
    - a whitespace-only text → `brief: undefined`, no file;
    - an oversize file → `{ok:false, error:'brief-too-large'}`, and the `brief-store` dir is empty;
    - a file source edited after `beginCreate` → the canonical file is unchanged;
    - `rollback()` → the canonical file is gone.
  - AC8:
    - the canonical file exists when `beginCreate` returns `ok`;
    - `dialog:false` with an agent file brief that doesn't exist → `{ok:true, brief:undefined}`,
      and the next `prepareSpawn` banners include `can't read the file`.
  - AC9:
    - after an agent edits the exposed `brief.md`, `beginDuplicate` copies the **canonical** text
      and returns `pending`;
    - a missing source canonical → `brief: undefined` + the `copy-failed` banner on the
      duplicate's first `prepareSpawn`.
  - AC10:
    - `onSessionDeleted` removes both paths;
    - `sweep(new Set(['a']))` with `a`, `b` on disk keeps `a` and removes `b`.
  - `probe` and `agentPreview`:
    - the error codes;
    - `firstLine`;
    - `supported:false` for a `cmd.exe` def.
  - AC11 (provenance test):
    - read the source text of `electron/conduit-mcp-host.ts`, `electron/conduit-mcp-endpoint.ts`
      and every `src/conduit-mcp/*.ts` except `adapters.ts`;
    - assert none matches `/role-brief/`;
    - assert `JSON.stringify(CONDUIT_TOOLS)` doesn't contain `"brief"`;
    - walk `src/`, `electron/` and `webview/` and assert that `electron/main.ts` is the only
      importer of `role-brief-host`. This pins every canonical writer behind the host's API.
    - In `role-brief-host.test.ts`, snapshot the `brief-store` dir (names + bytes), run
      `prepareSpawn`, `commit`, `probe`, `agentPreview` and `sweep` with a keep-set holding the
      id, and assert the snapshot is unchanged. Only `beginCreate`/`beginDuplicate` write the
      canonical store.
- [ ] Run both files. Expect FAIL (the module is missing).
- [ ] Implement.

#### Task 3.3: Preview brief args

**Files:** Modify `src/launch-preview.ts` and `test/unit/launch-preview.test.ts`.

**Interfaces:**
- Produces: `previewLaunch(input: { agentId: unknown; home: unknown; roots: unknown; brief?: unknown }, deps: {…existing; userData: string; e2e: boolean })`.
- Consumes:
  - `adapterFor` from `src/conduit-mcp/adapters.ts`;
  - `briefPreviewArgs(support): string[]` from `src/role-brief.ts`;
  - `batchGuarded`, `firstCmdMetachar` from `src/launch-args.ts`.

**Call sites:** `electron/main.ts:2905` (T4.1 passes `userData()` and `e2e`). Typecheck fails
until T4.1, so **T3.3 and T4.1 merge together**. The S3+S4 merge is one integration step.

**Steps:**
- [ ] Failing tests:
  - claude + `brief:true` → `args` end with `briefPreviewArgs({readAccess:'add-dir'})`, and
    `display` contains `…/briefs/<id>`;
  - `brief:false` → unchanged;
  - `win32` + a `.cmd` resolved command + `userData` containing `%` → `briefBlocked === '%'`, and
    no brief args;
  - a shell launcher → no `briefBlocked`, unchanged.
- [ ] Run. Expect FAIL.
- [ ] Implement.

### Slice 4: Host wiring (`electron/main.ts`)

**Check:** `npm run verify:quick` is green. After S4 the orchestrator runs `npm run verify`, then
`npm run e2e -- conduit-mcp-restart`, a regression on the shared spawn path.

**Parallel groups:** Serial: T4.1 → T4.2
**Claims (serial lane):** `electron/main.ts`

#### Task 4.1: Creation, delete, sweep, IPC

**Files:** Modify `electron/main.ts` only.

**Interfaces:** Consumes
- `loadAgentsConfig` (T3.1);
- `createRoleBriefHost`, `RoleBriefHost`, `BriefCreation` (T3.2);
- `mgr.mintId`, `mgr.create(…, {id, brief})`, `mgr.duplicate(id, {id, brief})` (T2.2);
- `folderPicker.pickFile` (T2.3);
- `previewLaunch(input with brief, deps with userData, e2e)` (T3.3);
- the protocol messages (T1.1).

**Call sites (every one):**
- `:35` import → `loadAgentsConfig`. At `:1283`, build `const agentsConfig =
  loadAgentsConfig(agentsFile(), { homeDir: os.homedir(), e2e: process.env.CONDUIT_E2E === '1',
  warn: (msg, data) => log.warn('agents', msg, data) })`, pass `agentsConfig.defs` as `config`,
  and delete the T3.1 `loadAgents` shim.
- After `mgr` (`:1307`), construct `roleBriefs = createRoleBriefHost({ userData: userData(),
  agentBriefs: agentsConfig.briefs, mgr, platform: hostPlatform, e2e, log })`.
- `openRepo` (`:2168`):
  - add the param `brief: { request: BriefRequest | undefined; dialog: boolean } = { request:
    undefined, dialog: false }`;
  - change the return to `{ sessionId: string } | { error: BriefError } | undefined`;
  - body: `const c = roleBriefs.beginCreate({ def: agent, request: brief.request, dialog:
    brief.dialog })`; `!c.ok` → `return { error: c.error }`;
  - `mgr.create(agent.id, p, { cardId, ...extras, id: c.id, ...(c.brief ? { brief: c.brief } :
    {}) })` inside `try`, and on a throw: `c.rollback(); throw err`.
- `openRepoRequest` (`:2407`): pass `{ request: m.brief, dialog: true }`. When the result has
  `error`, answer `{ droppedRoots: [], error }` and return.
- `:4990` `existing ?? openRepo(...)` → `existing ?? openRepo(...)?.sessionId`. Narrow with
  `'sessionId' in r`. A silent creation never returns `error`, because `dialog:false` downgrades
  errors to a banner. Keep the type honest with a narrowing helper
  `const sessionIdOf = (r: ReturnType<typeof openRepo>) => (r && 'sessionId' in r ? r.sessionId : undefined)`.
- `:5003`: the call is unchanged (its return is ignored).
- `case 'duplicate'` (`:3592`): `const d = roleBriefs.beginDuplicate(m.id); const dup =
  mgr.duplicate(m.id, { id: d.id, ...(d.brief ? { brief: d.brief } : {}) }); if (!dup)
  d.rollback();`
- `disposeSession` (`:2602`): add `void roleBriefs.onSessionDeleted(id);`.
- Sweep: directly after the scrollback sweep block (`:1920-1934`) and **not** gated on
  `shouldPersistSessions`:
  - `const onDisk = parseSessions(readBlob(sessionsFile()));`
  - `roleBriefs.sweep(new Set([...mgr.list().map((s) => s.id), ...(onDisk.kind === 'ok' ?
    onDisk.sessions.map((s) => s.id) : [])]))`.
  - It runs before `createWindow` and the `second-instance` registration (`:5015`), which the
    startup order already guarantees.
- IPC in `handle` (next to `folder:pick`, `:2865`):
  - `brief:probe` → `replyHere({ type: 'brief:probed', requestId, ...(r.ok ? { ok: true, bytes:
    r.bytes } : { ok: false, error: r.error }) })`;
  - `brief:agentPreview` → `replyHere({ type: 'brief:agentPreviewed', requestId,
    ...(await roleBriefs.agentPreview(registry.get(m.agentId))) })`;
  - `file:pick` → `replyHere({ type: 'file:picked', requestId, path: await
    folderPicker.pickFile(senderWin, m.title) })`;
  - each one guards `typeof m.requestId !== 'number'` with a `log.warn`, like `folder:pick`.
- `launch:preview` (`:2899`): pass `userData: userData(), e2e: process.env.CONDUIT_E2E === '1'`
  in `deps`. `m` already carries `brief`.

**Steps:**
- [ ] Apply the edits. Run `npm run typecheck`, then `npm run verify:quick`. Both green.
  (Carve-out: glue only. The behaviour is proven by T3.2's units and the S6 e2e.)

#### Task 4.2: Spawn wiring in `term:start`

**Files:** Modify `electron/main.ts` (`case 'term:start'`, `:4146-4170`).

**Interfaces:** Consumes `roleBriefs.prepareSpawn(sessionId, def, spec): { spec; banners; commit(alive) }`.

**Steps:**
- [ ] Immediately after `if (launchDef) spec = mcpHost.prepareLaunch(...)`:
  - `const scopeArgs = spec.args;`
  - `const brief = roleBriefs.prepareSpawn(m.sessionId, launchDef, spec);`
  - `spec = brief.spec;`
- [ ] After `const size = …` and before `pty.start`: `for (const b of brief.banners)
  scrollbacks.show(m.sessionId, b, size);`
- [ ] Right after `pty.start(…)`: `brief.commit(pty.isAlive(m.sessionId));`
- [ ] Change `scopeFromSpawnArgs(spec.cwd, spec.args, …)` to
  `scopeFromSpawnArgs(spec.cwd, scopeArgs, …)`, with the comment
  `// brief --add-dir is not a session root (docs/specs/2026-10-26-conduit-role-brief.md §3.2)`.
- [ ] Nothing between the `isAlive` re-check (`:4095`) and `pty.start` may `await`. Verify by
  reading the block.
- [ ] Run `npm run verify:quick`. Green.

### Slice 5: New session dialog (can run in parallel with S3/S4 after T1.1 + T2.1)

**Check:**
`npx vitest run test/unit/role-brief-state.test.ts test/unit/new-session-role-brief.test.tsx test/unit/new-session-modal.test.ts`
passes, `npm run verify:quick` is green, and `npm run text-fit` is clean (orchestrator).

**Parallel groups:** Serial: T5.1 → T5.2 → T5.3 (each consumes the previous)
**Claims (serial lane):** `webview/styles.css` (T5.2), `webview/components/new-session-modal.tsx` (T5.3)

#### Task 5.1: Brief dialog state + strings

**Files:**
- Create: `webview/role-brief-strings.ts`.
- Create: `webview/role-brief-state.ts`.
- Test: create `test/unit/role-brief-state.test.ts`.

**Interfaces:**
- Produces:

```ts
// role-brief-strings.ts
export const BRIEF_STR = {
  label: 'Role brief', fromAgent: 'From agent', none: 'None', text: 'Text', file: 'File',
  placeholder: 'Tell this session its role…', pathLabel: 'Role brief file', browse: 'Browse…',
  browseName: 'Choose role brief file', checking: 'Checking…', textLabel: 'Role brief text',
  errors: { 'brief-unreadable': "can't read the role brief file", 'brief-too-large': 'role brief is over 64 KiB',
            'brief-invalid': 'role brief is not UTF-8 text', 'brief-io': "couldn't save the role brief" },
  blocked: (c: string) => `The app's data folder contains "${c}", which this launcher can't take. Choose None.`,
  count: (bytes: number) => string,   // `${fmt(bytes/1024)} / 64 KiB`, Intl.NumberFormat maximumFractionDigits 1
  emptyText: 'Type the role brief or choose None', emptyFile: 'Choose a role brief file or choose None',
} as const;
// role-brief-state.ts
export type BriefMode = 'agent' | 'none' | 'text' | 'file';
export interface BriefDialogState {
  supported: boolean; agentHas: boolean; agentFirstLine?: string; agentPath?: string; agentError?: BriefError;
  mode: BriefMode; text: string; path: string;
  probe: { phase: 'idle' | 'checking' } | { phase: 'ok'; bytes: number } | { phase: 'error'; error: BriefError };
}
export type BriefAction =
  | { type: 'agentPreviewed'; supported: boolean; has: boolean; firstLine?: string; path?: string; error?: BriefError }
  | { type: 'launcherChanged' }                 // → initialBriefState() (mode reset, supported false until previewed)
  | { type: 'setMode'; mode: BriefMode } | { type: 'setText'; text: string } | { type: 'setPath'; path: string }
  | { type: 'probing' } | { type: 'probed'; ok: boolean; bytes?: number; error?: BriefError };
export function initialBriefState(): BriefDialogState;          // supported false, mode 'none'
export function reduceBrief(s: BriefDialogState, a: BriefAction): BriefDialogState;
// agentPreviewed sets mode to 'agent' when has, else 'none' — only if the mode is still the default of a fresh launcher.
export function briefStartBlock(s: BriefDialogState, briefBlocked: string | undefined): { reason: string } | null;
// unsupported → null; mode 'none' → null; briefBlocked → blocked(c); agent + agentError → errors[e];
// text: empty trimmed → emptyText, briefByteCount > BRIEF_MAX_BYTES → errors['brief-too-large'];
// file: empty → emptyFile, checking → BRIEF_STR.checking, error → errors[e].
export function briefRequestOf(s: BriefDialogState): BriefRequest | undefined;  // unsupported → undefined; else by mode
```

- Consumes: `briefByteCount`, `BRIEF_MAX_BYTES` (`src/role-brief.ts`); `BriefError`,
  `BriefRequest` (`src/types.ts`).

**Steps:**
- [ ] Failing tests:
  - launcher change resets the mode;
  - `agentPreviewed{has:true}` → mode `agent`;
  - over-cap text blocks with the too-large copy;
  - `briefBlocked:'%'` blocks;
  - a file probe error blocks;
  - `briefRequestOf` per mode;
  - unsupported → `undefined` and no block.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.2: `NewSessionRoleBrief` component + CSS

**Files:**
- Create: `webview/components/new-session-role-brief.tsx`.
- Modify: `webview/styles.css` (append an `ns-brief` block beside the `.ns-preview` rules).
- Test: create `test/unit/new-session-role-brief.test.tsx`.

**Interfaces:**
- Produces:
  `export function NewSessionRoleBrief(p: { state: BriefDialogState; dispatch: (a: BriefAction) => void; onBrowse: () => void; liveId: string }): JSX.Element | null`.
  It returns `null` when `!state.supported`.
- Consumes: `BRIEF_STR`, `BriefDialogState`, `BriefAction`, `BriefMode`, `briefByteCount`.

**Behaviour (spec §8):**
- Markup: `<section className="ns__section ns-brief">` (the e2e targets `.ns-brief [role="radio"]`)
  with `<span id={labelId} className="ns__label">`.
- The `role="radiogroup" aria-labelledby={labelId}` has `role="radio"` buttons using the
  `.ns-pill` look and `aria-checked`. ←/→ move, and Space selects. The modal's frame handler
  already maps Enter on a radio to Start.
- `From agent` is only offered when `agentHas`.
- The text mode is a `<textarea aria-label={BRIEF_STR.textLabel}>`, with the count in
  `aria-describedby`.
- The file mode has a path `<input aria-label={BRIEF_STR.pathLabel}>`, and a `Browse…` button
  with `aria-label={BRIEF_STR.browseName}`.
- Errors render in `role="alert"`. Paths render with `dir="ltr"` and `overflow-wrap: anywhere`.

**Steps:**
- [ ] Failing tests:
  - hidden when unsupported;
  - four radios when `agentHas`, three otherwise;
  - ArrowRight moves `aria-checked`;
  - typing dispatches `setText`;
  - the count shows `0.1 / 64 KiB` for 100 bytes;
  - Browse calls `onBrowse`;
  - an error has `role="alert"`.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 5.3: Modal integration

**Files:** Modify `webview/components/new-session-modal.tsx` and `test/unit/new-session-modal.test.ts`.

**Interfaces:** Consumes T5.1/T5.2 exports, the protocol messages (T1.1) and
`requestHost` (`webview/host-request.ts`).

**Steps:**
- [ ] Failing tests:
  - opening posts `brief:agentPreview` for the selected launcher;
  - a stale `brief:agentPreviewed` (an older requestId, i.e. a superseded launcher) is ignored;
  - `launch:preview` carries `brief: true` iff `briefRequestOf` is not `none`/`undefined`;
  - Start posts `openRepo` with `brief`;
  - `openRepo:result{error:'brief-too-large'}` shows `BRIEF_STR.errors['brief-too-large']`;
  - `briefBlocked` in the preview disables Start with the reason in `ns__reason`.
- [ ] Run. Expect FAIL.
- [ ] Implement:
  - `useReducer(reduceBrief, undefined, initialBriefState)`;
  - on an `agentId` change: dispatch `launcherChanged`, then `requestHost(brief:agentPreview)`
    with a seq ref (latest wins, the same pattern as `previewSeq`);
  - in file mode, a path change → `probing`, then a 250 ms timeout, then `brief:probe` (latest
    wins) → `probed`;
  - `onBrowse` → `requestHost(file:pick, title BRIEF_STR.browseName)` → `setPath`;
  - mount the section between Folders and Launches as;
  - `block = startBlock(...) ?? briefStartBlock(brief, preview.result?.briefBlocked)`;
  - pass `brief: briefRequestOf(brief)` in `openRepo`;
  - `START_ERROR` brief keys now read from `BRIEF_STR.errors`.

### Slice 6: E2E + docs

**Check:** `npm run e2e -- role-brief` passes locally (orchestrator), then
`npm run e2e:remote -- --full` is green, and `npm run verify` is green.

**Parallel groups:** G1: T6.1 → T6.2 · G2: T6.3
**Claims (serial lane):** `test/e2e/fixtures/fake-mcp-agent.mjs` (T6.1), `CHANGELOG.md` (T6.3)

#### Task 6.1: Fake agent records its argv and quits

**Files:** Modify `test/e2e/fixtures/fake-mcp-agent.mjs`.

**Steps:**
- [ ] At startup, right after `recordsFile` is known, add
  `record('ARGV', { argv: process.argv.slice(2) })`. Add `ARGV` to the header's record list.
- [ ] In `submit()`: `if (got === 'quit') { server?.kill(); process.exit(0); }`.
- [ ] Update the header line "Never exits on its own" (`:162`) to "Exits only on a typed `quit`
  or a kill."
- [ ] Carve-out: additive fixture change. It is proven by the T6.2 scenario and by the existing
  `conduit-mcp-*` scenarios staying green remotely.

#### Task 6.2: `test/e2e/role-brief.e2e.mjs`

**Files:** Create `test/e2e/role-brief.e2e.mjs`.

**Scenario** (uses `fakeAgentProfile`, `records`, `until` from `conduit-mcp-helpers.mjs`, and
`openDialog`/`pick`/`browseAdd` from `new-session-folders-helpers.mjs`; their signatures are in
those files):
- `fakeAgentProfile('role-brief')`, then `runScenario('role-brief', …)`.
- `openDialog`, then `pick(page, 'Fake MCP')`, then `browseAdd(app, page, [work])`.
- Click the `Text` radio in `.ns-brief`. Fill the textarea (`[aria-label="Role brief text"]`) with
  `You manage the fake team`. Click `Start session`.
- Wait until `records(sid, 'ARGV')[0]` exists.
- Assert `argv.at(-2) === '--'` and that `argv.at(-1)` matches
  `/^Read your role brief at (.+) and follow it\.$/`.
- Read the captured path with `readFileSync`, and assert it contains `You manage the fake team`.
- `typeLine(page, sid, 'quit')`. Wait until `window.__sessions` shows `status === 'exited'` for
  `sid`. Post `{ type: 'relaunch', id: sid }`, as `test/e2e/durability.e2e.mjs:121` does.
- Wait for a second `ARGV` record. Assert that no entry in it contains `Read your role brief`.
- `finishScenario` through `runScenario`.

#### Task 6.3: Docs

**Files:** Modify `CHANGELOG.md`.

**Steps:**
- [ ] Under `[Unreleased]` → `### Added`, add one entry:
  > **Give a session its role when you create it.** New session has a **Role brief** section
  > (from the agent's `agents.json` `brief`, typed text, or a file). Claude Code, Codex and Cursor
  > sessions start with one turn asking them to read it, and only on the first launch. Codex asks
  > once to allow reading the file.
- [ ] Flip the spec frontmatter `status: active` → `status: implemented` only after S6's check
  passes (orchestrator).

## Verification

- **Per task:** the task's named vitest files, then `npm run verify:quick`.
- **Per slice:** the slice's Check.
- **Merge order:** S1, S2, then S3 and S4 together (T3.1/T3.3 change signatures that main.ts
  consumes), then S5, then S6.
- **Merged tree:** `npm run verify` (full gate), then `npm run e2e -- role-brief`, then
  `npm run e2e:remote -- --full`.
- **Runtime QA (orchestrator, selfhost profile, real CLIs; spec §7), one brief session each for
  claude, codex and cursor:**
  - the first turn is the exact prompt;
  - Claude and Cursor read with no approval, and Codex shows exactly one `Get-Content` approval;
  - each acts on the brief;
  - a Relaunch of each has no turn;
  - Codex in a never-trusted folder: record whether a trust dialog appears and whether the
    prompt survives it.

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked
signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the
work. Never a shim, a second copy, a special case, a widened type, a fallback, or an override
patched in place of its semantic source. The report leads with the fix that keeps the locked
decision. The one sanctioned temporary is T3.1's `loadAgents` delegate, which T4.1 deletes.

## Decisions Needed

- [normal] **Codex trust dialog + positional prompt is unmeasured.** S0 showed no trust dialog for
  Codex. Default taken: ship. Runtime QA checks it. If Codex drops the prompt behind a trust
  dialog, the brief file still exists and the human types "read your role brief" (D3 accepts a
  launched-but-unread brief).
- [normal] **Sweep with restore off reads sessions.json a second time.** That is a cheap sync read
  at startup. Default taken: re-read rather than widen `sessionsParse` (`electron/main.ts:1829`),
  which is deliberately null when restore is off.
