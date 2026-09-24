# mf-new-session — implementation plan

**Spec:** `docs/specs/2026-09-23-mf-new-session.md`  **Tier:** FULL

Tier reason: new host subsystem (launcher detection, usage store, custom launchers, folder picker,
probe, preview), six new protocol messages, a rewritten dialog made of five components, and a
public prefill contract that mf-sidebar, mf-files and mf-board consume.

Builds on **mf-model** (landed first; contract = `docs/plans/2026-09-23-mf-model.plan.md` rev 2)
and **mf-changes** (lands before this item). Conductor rulings `.autoloop/locked.md` L11 and L12
override the spec wherever they differ; each override is listed under Spec staleness.

## Goal

Replace the New session dialog with the 9a layout (ranked Launch pills + `More ▾` + custom
command, project chip, Folders list, host-computed "Launches as" preview, Start), backed by
host-side launcher detection, a use counter, a folder picker with an e2e seam, a folder probe and
a preview that runs the same `buildLaunchSpec` `term:start` spawns from.

## Architecture

The host owns everything that touches the machine: a `LauncherHost` (`electron/launcher-host.ts`)
composes the registry from detected shells, detected CLIs, agents.json and custom launchers,
keeps `launchers.json` (usage + custom), and is the only writer of both; a `FolderPicker`
(`electron/folder-picker.ts`) is the one `folder:pick` seam (L11), with `__pickDirHook` under
`CONDUIT_E2E=1`. Probe and preview are pure-with-deps modules in `src/` that `main.ts` calls with
real fs/git. The renderer dialog is a reducer (`webview/new-session-state.ts`) seeded once by a
pure `seedNewSession` (`src/new-session-seed.ts`), plus four presentational parts; every host
round trip goes through one `requestHost` helper (`webview/host-request.ts`), latest-request-wins.
Folder conflicts use mf-model's single validator (`src/folder-validation.ts`) — the dialog gets a
richer view of the same rule, never a second rule.

## Data flow

```
open dialog ─► seedNewSession(prefill, ctx)  (sync, once)
   ├─ post launchers:rescan ─► LauncherHost.rescan() ─► registry.replace ─► postState (only if changed)
   ├─ folder:probe {paths ≤16/msg} ─► probeFolders ─► probeFolder (mf-model) + getGitInfo ─► folder:probeResult
   └─ launch:preview {agentId, home, roots} ─► previewLaunch
          ├ probeFolder(home) → homeMissing
          ├ sessionOps.resolveInitialRoots(home, roots) → presentRoots
          └ buildLaunchSpec (mf-model, same fn term:start uses) → formatCommandLine ─► launch:previewResult
edit (pills / chip / folders) ─► reducer ─► re-probe new folders, re-request preview (latest requestId wins)
+ Add folder… ─► Recent (state.repos)  |  Browse… ─► folder:pick ─► FolderPicker (hook queue | showOpenDialog) ─► folder:picked
+ Custom command… ─► launcher:addCustom ─► LauncherHost.addCustom ─► postState, then launcher:added
Start ─► [project:create ─► project:created | project:opResult] ─► openRepo {path, agentId, roots, projectId, cardId, requestId}
          ─► mf-model openRepo (+ this item: LauncherHost.bump, repos.json home + attached upserts)
          ─► openRepo:result {sessionId | error, droppedRoots} ─► close + toast per dropped root
term:start (mf-model, unchanged) ─► buildLaunchSpec ─► spawn with --add-dir per present root
```

## Settled decisions — do not re-litigate

- Spec D1–D20 as written, except where L11/L12 or mf-model's contract supersede them (Spec
  staleness below).
- **L11:** one `folder:pick` + `__pickDirHook` seam (built here; mf-files' Locate reuses
  `FolderPicker.pick`). Missing prefilled roots pass through the dialog, shown `Not found`, and are
  sent in `openRepo.roots` (host marks them missing — mf-model B1).
- **L12 S10:** ONE metacharacter policy, mf-model's `launchArgsFor`: on win32 a root containing
  one of `" % & | < > ^ !` is skipped for `--add-dir` only when the resolved command is `.cmd`/`.bat`
  (or unresolved), and reported in `skippedAddDirRoots`. The dialog disables Start when the
  preview's `skippedAddDirRoots` is non-empty. No other refusal exists anywhere.
- **L12 openRepo:result:** `{requestId, sessionId?, droppedRoots: DroppedRoot[], error?: 'home-missing'
  | 'invalid-path' | 'unknown-agent'}`, `DroppedRoot = {path, reason: SessionOpReason}` — mf-model owns
  the handler and reply; this item consumes it.
- `NewSessionPrefill` shape exactly as spec §3.1 (mf-board, mf-sidebar and mf-files pass it).
- `projectForNewSession` lives in `src/new-session-seed.ts` (D18); mf-sidebar builds after this
  item and imports it from there.
- Build order is serial per `.autoloop/tasks.yaml`: model > changes > **new-session** > files >
  sidebar > review > live-edits > board.

## mf-model / mf-changes exports this plan depends on

The builder confirms each exists (name and signature) before Slice 1; a mismatch is a stop-and-report
under the deviation rule.

| Export | Where | Used by |
|---|---|---|
| `Session.home`, `.roots`, `.projectId`, `.missingRoots`, `.homeMissing`; `Project` | `src/types.ts` | seed, reducer, dialog |
| `folderKey(p)` | `src/folder-key.ts` | reducer, seed, `findFolderConflict` |
| `placementConflict(candidate, existing)`, `probeFolder(raw, deps)`, `FolderProbeDeps`, `ProbedFolder`, `MAX_ROOTS`, `DroppedRoot`, `SessionOpReason` | `src/folder-validation.ts` | T3.1 (extends), probe, preview, reducer cap, dialog toast |
| `isAncestorOf(root, child)` | `src/owning-session.ts` | `findFolderConflict` |
| `SessionOps.resolveInitialRoots(home, roots)` (instance `sessionOps` in `electron/main.ts`) | `src/session-ops.ts` | preview |
| `presentRoots(s)` | `src/session-folders.ts` | preview |
| `resolveCommand(command, platform)` | `src/shells.ts` | LauncherHost (custom add), preview |
| `launchArgsFor(def, roots, opts)`; module-private `commandLeaf`, `CMD_METACHARS` | `src/launch-args.ts` | T1.2 exports `commandLeaf`; T3.5 exports `firstCmdMetachar` |
| `buildLaunchSpec(req)`, `LaunchRequest`, `LaunchPlan` | `src/launch-spec.ts` | preview |
| `normalizeProjectName` (module-private) | `src/project-store.ts` | T3.5 exports it |
| `openRepo(p, agentId, ownerWindowId, cardId?, extras?)`, `hostPlatform`, `projectStore` | `electron/main.ts` | T1.8 |
| protocol `openRepo {roots?, projectId?, requestId?}`, `openRepo:result`, `project:create`, `project:created`, `project:opResult`, `state.projects` | `src/protocol.ts` | dialog Start |
| `HostPlatform` | `src/lsp-binary.ts` | command-line, shells, launcher-store |
| (mf-changes) `openSession(page, { path, agentId, roots })` | `test/e2e/harness.mjs` | T4.1 |
| existing `getGitInfo(cwd, opts)` | `src/git-info.ts` (routes through `runGitBin`) | probe |

## Spec staleness

- **§3.2 `openRepo:result {droppedRoots?: string[]; error?: string}`** and "replies `error` when a
  root fails validation or `projectId` is dangling" — mf-model: invalid roots are dropped and reported
  as `DroppedRoot[]`; a dangling `projectId` makes the session standalone; `error` is the enum above.
  The dialog toasts `Skipped <basename>: not a valid folder` per dropped root and shows
  `Couldn't start session: <copy>` for an error, copy per error: `home-missing` → `home folder not
  found`, `invalid-path` → `home is not a folder`, `unknown-agent` → `launcher is no longer available`.
- **§3.3 / §2.4 `unsafeArg` + "term:start falls back to not launching"** — L12 S10: the host skips the
  root for `--add-dir` (still spawns); the preview returns `skippedAddDirRoots`; Start is disabled.
  AC8's "nothing is spawned" is proven as "Start disabled; no `openRepo` posted; no new session".
  Custom-launcher args (user-typed) are not guarded, as mf-model's guard covers roots only.
- **§2.3 "one pure `folderConflict` in `src/` over `normalizeRoot`"** — L11 "one folder validator":
  `findFolderConflict` is added to `src/folder-validation.ts` over `folderKey`, and mf-model's
  `placementConflict` is re-expressed through it (T3.1). Lexical only renderer-side; the host's
  realpath check still runs in `openRepo`.
- **§3.2 folder:probe** own path rules + `rev-parse --abbrev-ref` / `--short` — the probe uses
  mf-model's `probeFolder` (one validator; it has no `..`-segment rule, and the probe is read-only)
  and the existing `getGitInfo` interrogation (`src/git-info.ts`, through `runGitBin`, handles an
  unborn branch that `rev-parse --abbrev-ref` fails on). No new git command shape.
- **§3.2 launch:preview "same path checks, then `buildLaunchSpec({registry, agentId, home, roots,
  exists})`"** — mf-model's `LaunchRequest` is `{registry, agentId, cwd, home, homeMissing, roots,
  exists, resolveCommand, platform}`; the preview passes `cwd: undefined`, `homeMissing` from
  `probeFolder(home)`, and `roots` = `presentRoots` of `sessionOps.resolveInitialRoots(home, roots)`,
  i.e. exactly what `openRepo` + `term:start` will do.
- **D15 "`term:start` is switched to call `buildLaunchSpec`"** — already done by mf-model T7.4; not
  redone.
- **§12 "`project:create` replies `{requestId, id}`"** — mf-model: `project:created {requestId, id}`
  or `project:opResult {requestId, ok:false, reason: 'invalid-name' | 'store-unavailable'}`.
- **§11 tokens `--warn` / `--bad`** don't exist (locked process rule): `--amber` (Not found) and
  `--danger` (errors).
- **§9 "extend `test/unit/drag-region.test.ts`"** — the dialog adds no overlay root: it renders in
  `ModalLayer` (`.modal__backdrop`) and `Popover` (`.popover`), both already in that test's
  `OVERLAY_ROOTS` with `no-drag`. The guard that can actually fail is "the new files never build
  their own layer", added to `test/unit/overlay-sites.test.ts` (T3.10).
- **§2.6 source anchors** (`main.ts:1107`, `:1805-1830`) moved under mf-model; tasks name functions,
  not lines, for `electron/main.ts`.
- **§3.3 "repos.json … same atomic write and before-quit flush as repos.json"** — measured:
  `repos.json` has the atomic async write (`persistFile`) but is NOT in `flushStateSync`
  (`electron/main.ts` `flushStateSync`). `launchers.json` gets both: `persistFile` on change and a
  dirty-gated sync write in `flushStateSync`, like `timedMessages`.
- Measured true: `Popover`'s outside-mousedown ignores `triggerRef` (`webview/components/popover.tsx:103`),
  so a trigger's own onClick toggle closes it; Escape goes through the overlay stack (innermost first).

## Global constraints

- Gate: `npm run verify`, never weakened, narrowed or skipped. Per-task `npx vitest run <file>`.
  `npm run typecheck` runs both tsconfigs.
- Renderer-safe (no runtime `node:*`, no `process`): `src/command-line.ts`, `src/launchers.ts`,
  `src/new-session-seed.ts`, `src/folder-validation.ts`, `src/launch-args.ts`, `src/project-store.ts`.
  Host-only: `src/launcher-store.ts` (pure, but only host imports it), `src/folder-probe.ts`,
  `src/launch-preview.ts`, `src/shells.ts`, `electron/*`.
- Unit tests never depend on `process.platform`, native `path`, or `path.basename` (CI is ubuntu):
  pass `'win32'` / `'linux'` and `path.win32` / `path.posix` explicitly.
- Every new export has a production importer by the end of its slice (fallow). Test-only helpers
  stay module-private and are tested through their public caller.
- Files kebab-case; tests `test/unit/<module>.test.ts`; e2e `test/e2e/<name>.e2e.mjs` on
  `test/e2e/harness.mjs`, hidden, serial, `node test/e2e/run-smoke.mjs <name>` after `npm run build`.
- Comments: WHY only; point at the spec section / ADR instead of restating it.
- No hex in CSS; tokens only (`--accent`, `--accent-soft`, `--accent-2`, `--amber`, `--danger`,
  `--text-dim`, `--text-faint`, `--term-bg`, `--term-surface`, `--border`). New interactive classes
  join the interaction-state vocabulary section of `webview/styles.css` in the rows where `.repo` /
  `.repo--active` sit today (replacing them); `test/unit/state-vocabulary.test.ts` stays unmodified.
- Git only through `runGitBin` (here: via `getGitInfo`). Never kill processes by name.
- Replies go to the requesting window (`replyHere`); state changes arrive on `state`. The host posts
  `state` BEFORE a reply whose id the renderer must find in state (`launcher:added`).
- Copy is verbatim from spec §2 unless this plan pins it.

## Out of scope

Running-session folder edits (mf-files / mf-live-edits); `session:locateFolder` (mf-files, which
calls `FolderPicker.pick`); sidebar `+` buttons and `collapsedProjects` (mf-sidebar); board card
prefill builder (mf-board — it passes `NewSessionPrefill`); codex/cursor-agent context notes;
agents.json editing; Recent filtering; live Windows registry PATH on rescan.

## Contracts

### `src/command-line.ts` (renderer-safe)
```ts
import type { SpawnSpec } from './types';
import type { HostPlatform } from './lsp-binary';
/** win32: CommandLineToArgvW rules (`"` groups; backslashes literal except in a run before `"`,
 *  2n → n + quote toggles, 2n+1 → n + literal `"`). posix: '…' literal, "…" groups with \ escaping
 *  `"`, `\`, `$`, backtick; \ escapes anything outside quotes. Whitespace = space/tab. */
export function splitCommandLine(line: string, platform: HostPlatform): string[];
/** `<leaf> <quoted args>`; leaf = last path segment of spec.command with a trailing .exe/.cmd/.bat
 *  (any case) removed. Quoting is the inverse of splitCommandLine for the same platform:
 *  win32 → an arg that is empty or contains space/tab/`"` is wrapped in `"` with CommandLineToArgvW
 *  escaping; posix → an arg not matching /^[A-Za-z0-9_@%+=:,./-]+$/ is single-quoted, `'` → `'\''`. */
export function formatCommandLine(spec: Pick<SpawnSpec, 'command' | 'args'>, platform: HostPlatform): string;
```
Invariant (tested): `splitCommandLine(argsPart(formatCommandLine({command:'x', args}, p)), p)` equals
`args` for every `p` and a fixture list incl. `''`, `a b`, `C:\a b\`, `say "hi"`, `it's`.

### `src/launchers.ts` (renderer-safe)
```ts
import type { AgentDefinition } from './types';
export type LauncherKind = 'cli' | 'shell' | 'config' | 'custom';
export interface LauncherDTO { id: string; kind: LauncherKind; uses: number; lastUsed?: number }
export const AGENT_CLI_NAMES = ['claude', 'codex', 'cursor-agent', 'gemini', 'aider', 'opencode'] as const;
export const MAX_CUSTOM_LAUNCHERS = 50;   // here (renderer-safe) so the More cap row and the host share it
export interface LauncherSet {
  defs: AgentDefinition[];               // order: shells, clis, config, custom; ids unique (first wins)
  aliases: Record<string, string>;       // 'cli:<name>' → shadowing agents.json id (D20)
  kinds: Record<string, LauncherKind>;   // keyed by defs[].id
}
export function composeLaunchers(parts: {
  shells: readonly AgentDefinition[]; clis: readonly AgentDefinition[];
  config: readonly AgentDefinition[]; custom: readonly AgentDefinition[];
}): LauncherSet;
// Slice 3:
export function preferredShellId(launchers: readonly LauncherDTO[], defaultAgentId: string): string | undefined;
  // defaultAgentId when its kind is 'shell'; else the first 'shell' in launchers order; else undefined
export interface LaunchRanking { row: string[]; shellId?: string; more: string[] }
export function rankLaunchers(
  agents: readonly AgentDefinition[], launchers: readonly LauncherDTO[], preferredShellId: string | undefined,
): LaunchRanking;
```
`composeLaunchers`: invalid defs dropped via `AgentRegistry.isValid`; a config def whose
`commandLeaf(def.command)` equals a CLI name drops the `cli:<name>` def and adds the alias.
`rankLaunchers`: candidates = agents with a DTO; non-shells sorted by `uses` desc, `lastUsed` desc
(absent = 0), then canonical (`cli` in `AGENT_CLI_NAMES` order, then `config` in agents order, then
`custom` in agents order); `row` = first 3; `shellId = preferredShellId` arg; `more` = remaining
non-shells in rank order, then every other shell in agents order.

### `src/launcher-store.ts` (host-only by import; pure)
```ts
import type { AgentDefinition } from './types';
import type { HostPlatform } from './lsp-binary';
export interface LauncherUsage { count: number; lastUsed: number }
export interface LaunchersFile { version: 1; usage: Record<string, LauncherUsage>; custom: AgentDefinition[] }
// cap: MAX_CUSTOM_LAUNCHERS, imported from ./launchers
export function parseLaunchers(blob: string | undefined): LaunchersFile;
  // undefined / not JSON / version !== 1 / wrong shapes → {version:1, usage:{}, custom:[]};
  // usage entries with non-finite count/lastUsed dropped; custom filtered by AgentRegistry.isValid,
  // ids not starting with 'custom:' dropped, capped at 50
export function serializeLaunchers(f: LaunchersFile): string;
export function bumpUsage(f: LaunchersFile, agentId: string, now: number): LaunchersFile;  // new object
export type AddCustomResult = { ok: true; file: LaunchersFile; def: AgentDefinition } | { ok: false; error: string };
export function addCustomLauncher(
  f: LaunchersFile,
  input: { commandLine: unknown; label?: unknown },
  deps: { platform: HostPlatform; resolveCommand: (command: string) => string | undefined;
          takenIds: ReadonlySet<string>; takenLabels: readonly string[] },
): AddCustomResult;
export function removeCustomLauncher(f: LaunchersFile, id: unknown): LaunchersFile | null;  // null = not a custom id
```
`addCustomLauncher` errors (exact copy): non-string or blank after trim → `Enter a command`;
> 1024 chars → `Command is too long (max 1024 characters)`; `custom.length >= 50` →
`Custom launcher limit reached (50)`; `resolveCommand(argv[0])` undefined → `Can't find "<argv[0]>" on PATH`.
Def: `{id: 'custom:' + slug, label, command: <resolved>, args: argv.slice(1), icon: 'terminal',
color: 'green', cwdStrategy: 'workspaceFolder'}`; label = trimmed `input.label` (≤ 80 chars, longer
cut) or the resolved command's leaf without `.exe/.cmd/.bat`; slug = label lower-cased, runs of
`[^a-z0-9]` → `-`, trimmed of `-`, `''` → `cmd`; taken id → `-2`, `-3`…; label taken
case-insensitively → ` (2)`, ` (3)`….

### `src/shells.ts` (host)
```ts
import type { HostPlatform } from './lsp-binary';
export interface CliScanEnv {
  platform: HostPlatform;
  pathDirs: readonly string[];
  homeDir: string;
  join: (...parts: string[]) => string;
  isFile: (p: string) => boolean;         // win32 probe
  isExecutable: (p: string) => boolean;   // posix X_OK probe
}
export function detectAgentClis(env: CliScanEnv): AgentDefinition[];   // ids 'cli:<name>', label = name
export function hostCliScanEnv(): CliScanEnv;                           // process.env.PATH, os.homedir(), fs
```
win32: per name, per dir in PATH order, try `<name>.exe`, `.cmd`, `.bat` — first hit wins; never
`.ps1` or extensionless. posix: dirs = `pathDirs` then `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.npm-global/bin`, `~/.bun/bin` (deduped), bare name with `isExecutable`. Defs
built by the same private builder `toDef` uses (`icon:'terminal'`, `color:'green'`,
`cwdStrategy:'workspaceFolder'`, `args: []`).

### `src/agent-registry.ts`
```ts
export class AgentRegistry {
  constructor(defs: AgentDefinition[], aliases?: Record<string, string>);
  static isValid(d: AgentDefinition): boolean;
  list(): AgentDefinition[];                     // defs only, never alias entries
  get(id: string): AgentDefinition | undefined;  // direct id, else aliases[id] → that def
  resolve(id: string, cwd: string): SpawnSpec;   // via get (so aliases resolve)
  /** In place (SessionManager and every closure keep this instance). true iff defs or aliases changed
   *  (ids, commands, args, labels, order compared). */
  replace(defs: AgentDefinition[], aliases: Record<string, string>): boolean;
}
```

### `src/repo-history.ts`
```ts
/** Move an attached folder to the front, keeping an existing entry's lastAgentId (D14). */
export function upsertAttachedRepo(list: RepoDTO[], entry: { path: string; name: string; lastOpened: number }): RepoDTO[];
```

### `electron/launcher-host.ts`
```ts
export interface LauncherHostDeps {
  registry: AgentRegistry;
  config: readonly AgentDefinition[];          // agents.json as loaded at startup
  detectShells: () => AgentDefinition[];
  detectClis: () => AgentDefinition[];
  readFile: () => string | undefined;          // readBlob(launchersFile())
  persist: (text: string) => void;             // persistFile(launchersFile(), text, 'launchers.json')
  resolveCommand: (command: string) => string | undefined;
  platform: HostPlatform;
  now: () => number;
}
export class LauncherHost {
  constructor(deps: LauncherHostDeps);   // parse file, compose, registry.replace
  rescan(): boolean;                      // re-detect shells + clis; compose; registry.replace → changed
  bump(agentId: string): void;            // bumpUsage + persist; marks dirty
  addCustom(commandLine: unknown, label: unknown): { ok: true; id: string } | { ok: false; error: string };
  removeCustom(id: unknown): boolean;
  dtos(): LauncherDTO[];                  // registry.list() order: {id, kind, uses, lastUsed?}
  pendingFlush(): string | null;          // serialized file when changed this run, else null
}
```

### `electron/folder-picker.ts`
```ts
export interface FolderPickerDeps {
  showOpenDialog: (win: BrowserWindow | null, opts: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>;
  e2e: boolean;                               // process.env.CONDUIT_E2E === '1'
  installHook: (hook: { queue(paths: (string | null)[]): void }) => void;  // global.__pickDirHook = hook
}
export interface FolderPicker {
  /** A queued hook entry answers first (e2e); else the native dialog, parented to win.
   *  A second pick while one is open for the same window resolves null without a dialog. */
  pick(win: BrowserWindow | null, title: string): Promise<string | null>;
}
export function createFolderPicker(deps: FolderPickerDeps): FolderPicker;
```

### `src/folder-probe.ts` (host-only)
```ts
import type { GitInfo } from './types';
import { type FolderProbeResult, MAX_PROBE_PATHS } from './protocol';
export function probeFolders(
  paths: unknown,
  deps: { probe: (raw: unknown) => ReturnType<typeof probeFolder>; gitInfo: (dir: string) => Promise<GitInfo> },
): Promise<FolderProbeResult[]>;
```
Non-array → `[]`; first 16 entries; non-strings skipped; `probeFolder` status `present` →
`exists: true` + `gitInfo(stored)` (kind `branch` → `branch`; `detached` → `branch: sha,
detached: true`; else none); `missing` or a reason → `exists: false`. `path` echoes the input string.
Git calls run through `mapWithConcurrency(…, 4)` (`src/git-exec.ts`); a rejected gitInfo → no branch.

### `src/launch-preview.ts` (host-only)
```ts
import type { LaunchPreviewResult } from './protocol';
export function previewLaunch(
  input: { agentId: unknown; home: unknown; roots: unknown },
  deps: {
    registry: AgentRegistry;
    probe: (raw: unknown) => ReturnType<typeof probeFolder>;
    resolveInitialRoots: (home: string, roots: unknown) => Promise<{ roots: string[]; missing: string[]; dropped: DroppedRoot[] }>;
    exists: (p: string) => boolean;
    resolveCommand: (command: string) => string | undefined;
    platform: HostPlatform;
  },
): Promise<LaunchPreviewResult>;
```
Non-string `agentId`/`home` → `{error:'invalid request', skippedAddDirRoots: []}`; unknown agent
(`registry.get` undefined and not `'shell'`) → `unknown launcher`; probe(home) not `present` →
`homeMissing: true` → `buildLaunchSpec` refuses → `error: 'home-missing'`; a registered non-shell
whose `resolveCommand(def.command)` is undefined → `error: 'not found on PATH'` (the plan is still
computed so `cwd`/`args` are filled). Otherwise `display = formatCommandLine(plan.spec, platform)`,
`cwd/command/args` from `plan.spec`, `skippedAddDirRoots` from the plan. No cwd-reporting
augmentation (D8).

### `src/folder-validation.ts` (T3.1 addition)
```ts
export type FolderConflict = { kind: 'duplicate' | 'inside' | 'contains'; index: number };
/** First existing key that equals (duplicate), is an ancestor of (inside), or is a descendant of
 *  (contains) the candidate, by folderKey + isAncestorOf. */
export function findFolderConflict(candidateKey: string, existingKeys: readonly string[]): FolderConflict | null;
```
`placementConflict(candidate, existing)` is re-implemented as: any candidate key with a `duplicate`
→ `'duplicate'`, else any conflict → `'overlaps'`, else `null` — its mf-model tests stay unmodified
and green.

### `src/launch-args.ts` (T1.2 / T3.5 additions)
```ts
export function commandLeaf(command: string): string;               // was module-private (T1.2)
export function firstCmdMetachar(s: string): string | undefined;    // the CMD_METACHARS test launchArgsFor uses (T3.5)
```

### `src/project-store.ts` (T3.5)
`normalizeProjectName(raw: unknown): string | null` becomes an export (unchanged body).

### `src/new-session-seed.ts` (renderer-safe)
```ts
import type { RepoDTO } from './protocol';
import type { AgentDefinition, Project, Session } from './types';
import type { LauncherDTO } from './launchers';
export interface NewSessionPrefill {
  agentId?: string;
  projectId?: string | null;   // undefined → derive; null → standalone
  home?: string;
  roots?: string[];            // ignored without home
  cardId?: string;
  cardTitle?: string;
}
export interface SeedContext {
  active: Session | undefined;
  sessions: readonly Session[];
  projects: readonly Project[];
  repos: readonly RepoDTO[];
  agents: readonly AgentDefinition[];
  launchers: readonly LauncherDTO[];
  defaultAgentId: string;
}
export interface NewSessionSeed { agentId: string; projectId: string | null; home?: string; roots: string[] }
export function projectForNewSession(active: Session | undefined, projects: readonly Project[]): string | null;
export function agentForHome(home: string | undefined, ctx: Pick<SeedContext, 'repos' | 'agents' | 'launchers' | 'defaultAgentId'>): string;
export function seedNewSession(prefill: NewSessionPrefill, ctx: SeedContext): NewSessionSeed;
```
Rules exactly spec §3.1. `agentForHome`: repos entry with `path === home` whose `lastAgentId` is
registered → it; else `defaultAgentId` if registered; else first `kind:'shell'` launcher; else
`agents[0]?.id ?? ''`. `seedNewSession`: `agentId` = registered `prefill.agentId` else
`agentForHome(home)`; roots deduped by `folderKey`, home's key removed, missing kept; `repos[0]` is
the home in step 3.

### `webview/host-request.ts`
```ts
import type { HostToWebview, WebviewToHost } from '../src/protocol';
/** Posts send(id) with a fresh id and resolves the first reply of one of `types` carrying that
 *  requestId, or null after timeoutMs. Unsubscribes either way. */
export function requestHost<T extends HostToWebview['type']>(
  send: (requestId: number) => WebviewToHost,
  types: readonly T[],
  timeoutMs: number,
): Promise<Extract<HostToWebview, { type: T }> | null>;
```

### `webview/new-session-state.ts`
```ts
export const MAX_DIALOG_FOLDERS = MAX_ROOTS;   // 32 folders total incl. home (spec §2.3); ≤ host limit
export interface FolderProbe { exists: boolean; branch?: string; detached?: boolean }
export interface NewSessionState {
  agentId: string;
  agentPicked: boolean;            // D13: once true, home changes no longer re-pick
  extraPillId?: string;            // picked from More, not in the row
  projectId: string | null;
  pendingProjectName?: string;     // D7: created at Start
  folders: string[];               // [home, ...roots] in add order
  probes: Record<string, FolderProbe>;   // keyed by folderKey
  flashKey?: string;               // duplicate add → existing row highlighted
  hint?: string;                   // `Already covered by <name>` | `Contains <name>`
  phase: 'editing' | 'starting';
  startError?: string;             // `Couldn't start session: <reason>`
  projectError?: boolean;          // `Couldn't create project`
  announce?: string;               // live-region text
}
export type NewSessionAction =
  | { type: 'pickAgent'; id: string; fromMore: boolean }
  | { type: 'addFolder'; path: string }
  | { type: 'removeFolder'; path: string }
  | { type: 'makeHome'; path: string }
  | { type: 'setProject'; projectId: string | null }
  | { type: 'newProject'; name: string }
  | { type: 'probed'; results: FolderProbeResult[] }
  | { type: 'revalidate' }                        // state update: drop dangling projectId / unregistered agent
  | { type: 'start' } | { type: 'startFailed'; reason: string; project: boolean };
export function initialNewSessionState(seed: NewSessionSeed): NewSessionState;
export function reduceNewSession(s: NewSessionState, a: NewSessionAction, ctx: SeedContext): NewSessionState;
export interface StartBlock { reason: string }  // disabled-Start copy
export function startBlock(s: NewSessionState, preview: LaunchPreviewView, agents: readonly AgentDefinition[]): StartBlock | null;
export interface LaunchPreviewView { result?: LaunchPreviewResult; loading: boolean }
```
Reducer rules: `addFolder` on empty list → home, agent re-picked via `agentForHome` unless
`agentPicked`; duplicate → no change, `flashKey`; `inside` → hint `Already covered by <name>`;
`contains` → `Contains <name>`; at 32 → no change. `removeFolder` of home only when it is the only
folder (D5). `makeHome(p)` → `[p, oldHome, ...rest without p]`, agent re-pick unless `agentPicked`,
refused when p's probe says `exists:false`. `newProject(name)` → `normalizeProjectName`; `null` →
no change; case-insensitive match to a project → `setProject(id)`; else `pendingProjectName`.
`start` from `starting` → no change (single flight). `startBlock` order: no agents →
`No terminals found`; zero folders → `Add a folder to start`; home probe `exists:false` →
`Home folder not found`; `preview.result.skippedAddDirRoots` non-empty → `<label> is a <ext> shim
and can't take "<basename>" (contains <firstCmdMetachar>). Rename the folder or use an .exe
install.` (`<ext>` = `.bat` when `preview.result.command` ends in `.bat`, else `.cmd`); else `null`.
Names are `sessionNameFromPath` (`src/session-name.ts`).

### Protocol — `src/protocol.ts`
Shared result shapes live here, so the renderer never type-imports a host-only (`node:*`) module:
```ts
export const MAX_PROBE_PATHS = 16;
export interface FolderProbeResult { path: string; exists: boolean; branch?: string; detached?: boolean }
export interface LaunchPreviewResult {
  cwd?: string; command?: string; args?: string[]; display?: string;
  error?: string;                 // 'home-missing' | 'unknown launcher' | 'not found on PATH' | 'invalid request'
  skippedAddDirRoots: string[];
}
```
Renderer → host (add; delete `browseRepo`):
```ts
| { type: 'launchers:rescan' }
| { type: 'launcher:addCustom'; requestId: number; commandLine: string; label?: string }
| { type: 'launcher:removeCustom'; id: string }
| { type: 'folder:pick'; requestId: number }
| { type: 'folder:probe'; requestId: number; paths: string[] }
| { type: 'launch:preview'; requestId: number; agentId: string; home: string; roots: string[] }
```
Host → renderer:
```ts
| { type: 'launcher:added'; requestId: number; id?: string; error?: string }
| { type: 'folder:picked'; requestId: number; path: string | null }
| { type: 'folder:probeResult'; requestId: number; results: FolderProbeResult[] }
| ({ type: 'launch:previewResult'; requestId: number } & LaunchPreviewResult)
// state: + launchers: LauncherDTO[]
```
Non-number `requestId` on any of these → `log.warn`, no reply. `folder:pick` title: `Add a folder`.

### Components (all `webview/components/`)
```ts
// new-session-modal.tsx
export function NewSessionModal(props: {
  prefill: NewSessionPrefill;
  ctx: SeedContext;                                 // app builds it from state + active + settings
  onClose: () => void;
  onStarted: (sessionId: string, dropped: DroppedRoot[]) => void;
}): JSX.Element;
// new-session-launch-row.tsx
export function NewSessionLaunchRow(props: {
  agents: AgentDefinition[]; launchers: LauncherDTO[]; ranking: LaunchRanking;
  selectedId: string; extraPillId?: string; onPick: (id: string, fromMore: boolean) => void;
  customCount: number;                               // for the 50 cap row
}): JSX.Element;                                     // owns More popover + custom form + launcher:addCustom/removeCustom
// new-session-project-chip.tsx
export function NewSessionProjectChip(props: {
  projects: Project[]; projectId: string | null; pendingName?: string; error?: boolean;
  onSet: (id: string | null) => void; onNew: (name: string) => void;
}): JSX.Element;
// new-session-folders.tsx
export function NewSessionFolders(props: {
  folders: string[]; probes: Record<string, FolderProbe>; repos: RepoDTO[];
  flashKey?: string; hint?: string; atCap: boolean;
  onAdd: (path: string) => void; onRemove: (path: string) => void; onMakeHome: (path: string) => void;
}): JSX.Element;                                     // owns + Add folder popover and folder:pick
// new-session-preview.tsx
export function NewSessionPreview(props: {
  view: LaunchPreviewView; hasFolders: boolean; label: string;
}): JSX.Element;
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Registry contents (+ `cli:*`, custom, aliases) | `LauncherHost` → `AgentRegistry.replace` | `state.agents` (dialog, omni-bar Agents `app.tsx` agentEntries, Settings default terminal `settings-modal.tsx:811`), `SessionManager.create`, `buildLaunchSpec`, OS-open `registry.list()[0]` | both; `AgentDefinition` shape unchanged; shells stay first so `list()[0]` is still a shell (`electron/main.ts` openFileFromOS) |
| `state.launchers` | `LauncherHost.dtos()` in `postState` | dialog only | both |
| `launchers.json` | `LauncherHost` (bump in `openRepo`, custom add/remove) | `LauncherHost` next launch | both |
| repos.json attached upserts | `openRepo` (T1.8) | dialog Recent, `plainShellTarget`/`lastSessionTarget` | both; attached entries never set `lastAgentId`, and `restoreRepos` already tolerates a missing one |
| `NewSessionPrefill` | app callers (T3.11); later mf-sidebar, mf-files, mf-board | `seedNewSession` | in-repo callers here; later callers pass the documented shape (unit-covered via `seedNewSession`) |
| `openRepo {roots, projectId, cardId, requestId}` | dialog Start | mf-model handler + `openRepo:result` | producer here; handler mf-model (+ bump/upserts here) |
| `project:create` | dialog Start (pending project) | mf-model handler → `project:created` / `project:opResult` | producer here |
| `folder:pick` / `__pickDirHook` | dialog Add folder (here); mf-files Locate / Add folder (later) | `FolderPicker` | both for this item |
| `folder:probe` | dialog (here); mf-files missing box (later) | `probeFolders` | both |
| `launch:preview` | dialog | `previewLaunch` → `buildLaunchSpec` (shared with `term:start`) | both |
| `browseRepo` (deleted) | old dialog `onBrowse` (`webview/app.tsx` NewSessionModal mount) | `electron/main.ts` `browseRepo` | both deleted; `grep -rn browseRepo src webview electron test` must return nothing |
| `placementConflict` body | `src/folder-validation.ts` | `src/session-ops.ts` (mf-model) | producer re-expressed; behaviour identical, proven by mf-model's unmodified tests |
| `commandLeaf`, `firstCmdMetachar`, `normalizeProjectName` exported | their mf-model modules | `src/launchers.ts`, reducer | both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/command-line.ts` | create | `splitCommandLine`, `formatCommandLine` |
| `src/launchers.ts` | create | launcher kinds/DTO, `composeLaunchers`, `preferredShellId`, `rankLaunchers` |
| `src/launcher-store.ts` | create | launchers.json parse/serialize, usage bump, custom add/remove |
| `src/shells.ts` | modify | `detectAgentClis`, `hostCliScanEnv` |
| `src/agent-registry.ts` | modify | aliases, `replace` |
| `src/launch-args.ts` | modify | export `commandLeaf`, `firstCmdMetachar` |
| `src/repo-history.ts` | modify | `upsertAttachedRepo` |
| `src/folder-probe.ts` | create | `probeFolders` |
| `src/launch-preview.ts` | create | `previewLaunch` |
| `src/folder-validation.ts` | modify | `findFolderConflict`; `placementConflict` through it |
| `src/project-store.ts` | modify | export `normalizeProjectName` |
| `src/new-session-seed.ts` | create | `NewSessionPrefill`, `projectForNewSession`, `agentForHome`, `seedNewSession` |
| `src/protocol.ts` | modify | messages above; `state.launchers`; delete `browseRepo` |
| `electron/launcher-host.ts` | create | registry composition + launchers.json owner |
| `electron/folder-picker.ts` | create | the one folder-pick seam + `__pickDirHook` |
| `electron/main.ts` | modify | wiring, cases, `openRepo` bump + upserts, flush; delete `browseRepo` |
| `webview/host-request.ts` | create | `requestHost` |
| `webview/new-session-state.ts` | create | dialog reducer + `startBlock` |
| `webview/components/new-session-modal.tsx` | rewrite | dialog frame, seed, preview/probe loop, Start |
| `webview/components/new-session-launch-row.tsx` | create | pills, More, custom form |
| `webview/components/new-session-project-chip.tsx` | create | chip + dropdown + new-project input |
| `webview/components/new-session-folders.tsx` | create | folder rows + Add folder menu |
| `webview/components/new-session-preview.tsx` | create | Launches as box |
| `webview/app.tsx` | modify | `newSession: NewSessionPrefill | null`; callers; mount; `rescan` on open |
| `webview/bridge.ts` | modify | fake-shell replies for the new messages; fake `state.launchers` |
| `webview/mock.ts` | modify | `launchers` in mock state |
| `webview/styles.css` | modify | `.ns*` rules; delete `.repolist`, `.repobrowse`, `.repo`, `.repo--*`, `.repo__icon`, `.repo__name`, `.modal__termlabel` (keep `.repo__path`); vocabulary rows |
| `test/unit/command-line.test.ts`, `launchers.test.ts`, `launcher-store.test.ts`, `detect-agent-clis.test.ts`, `launcher-host.test.ts`, `folder-picker.test.ts`, `folder-probe.test.ts`, `launch-preview.test.ts`, `new-session-seed.test.ts`, `new-session-state.test.ts`, `host-request.test.ts` | create | per module |
| `test/unit/agent-registry.test.ts`, `folder-validation.test.ts`, `repo-history.test.ts` (create if absent) | modify | per task |
| `test/unit/new-session-modal.test.ts` | rewrite | dialog behaviour (replaces the pinned-Browse tests) |
| `test/unit/overlay-sites.test.ts` | modify | new component files in `ALL_FILES`; menus-in-Popover assertion |
| `test/e2e/new-session-folders.e2e.mjs` | create | spec §7 Gherkin |
| `test/e2e/new-session-browse-pinned.e2e.mjs` | delete | subject removed (spec §7) |
| `test/e2e/explorer-open-as-session.e2e.mjs` | modify | assert the Home row path |
| `test/e2e/chamfer-edge.e2e.mjs` | modify | header/inline comments name `.ns-pill--on` instead of `.repo--active`; assertions unchanged |

## Scripts

None. Every edit is a distinct change; the only repeated shape (vocabulary-row renames in
`styles.css`) is three selectors in one file.

## Slices

### Slice 1: Launchers on the host — detection, registry, usage, custom

**Check:** `npx vitest run test/unit/command-line.test.ts test/unit/launchers.test.ts test/unit/launcher-store.test.ts test/unit/detect-agent-clis.test.ts test/unit/agent-registry.test.ts test/unit/repo-history.test.ts test/unit/launcher-host.test.ts test/unit/launch-args.test.ts test/unit/resolve-launch-spec.test.ts`; `npm run typecheck`; `npm run fallow:check`.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.5 · G4: T1.6 · Serial: T1.3 → T1.4 → T1.7 → T1.8
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/bridge.ts`, `webview/mock.ts`

#### Task 1.1: `splitCommandLine`
**Files:** Create `src/command-line.ts` (`splitCommandLine` only), `test/unit/command-line.test.ts`.
**Interfaces:** Produces `splitCommandLine(line: string, platform: HostPlatform): string[]`.
**Steps:**
- [ ] Failing tests: `'win32 keeps backslashes: C:\\tools\\aider.exe --x'` → `['C:\\tools\\aider.exe','--x']`; `'win32 quotes group: "C:\\a b\\c.exe" -m'`; `'win32 2n backslashes before a quote'` (`a\\\\"b c"` → `['a\\b c']`); `'win32 2n+1 → literal quote'` (`a\\"b` → `['a"b']`); `'posix single quotes literal'` (`'a\\b c'` → `['a\\b c']`); `'posix double quotes group, backslash escapes quote'`; `'posix backslash escapes a space outside quotes'`; `'tabs and runs of spaces separate'`; `'empty → []'`.
- [ ] Run `npx vitest run test/unit/command-line.test.ts` — FAIL (module missing); implement.

#### Task 1.2: `composeLaunchers` (+ export `commandLeaf`)
**Files:** Create `src/launchers.ts` (`LauncherKind`, `LauncherDTO`, `AGENT_CLI_NAMES`, `MAX_CUSTOM_LAUNCHERS`, `LauncherSet`, `composeLaunchers`); modify `src/launch-args.ts` (export `commandLeaf`, body unchanged); create `test/unit/launchers.test.ts`.
**Interfaces:** Consumes `AgentRegistry.isValid`, `commandLeaf(command: string): string`. Produces the `launchers.ts` Slice 1 contract.
**Steps:**
- [ ] Failing tests: `'order shells, clis, config, custom; kinds keyed by id'`; `'duplicate id: first wins'`; `'agents.json {id:my-claude, command:claude} hides cli:claude and aliases it'` (AC9 half); `'config C:\\x\\claude.cmd shadows too; codex config does not shadow claude'`; `'invalid defs dropped'`.
- [ ] Run — FAIL; implement. `test/unit/launch-args.test.ts` stays green.

#### Task 1.3: launchers.json store
**Files:** Create `src/launcher-store.ts`, `test/unit/launcher-store.test.ts`.
**Interfaces:** Consumes `splitCommandLine` (T1.1), `MAX_CUSTOM_LAUNCHERS` (T1.2), `AgentRegistry.isValid`, `HostPlatform`. Produces the `launcher-store.ts` contract.
**Steps:**
- [ ] Failing tests: `'undefined / not JSON / version 2 → empty file'`; `'bad usage entries dropped, non-custom ids dropped'`; `'serialize → parse round-trips'`; `'bumpUsage increments and stamps lastUsed, returns a new object'`; `'add: blank → Enter a command'`; `'add: 1025 chars → too long'`; `'add: 51st → Custom launcher limit reached (50)'`; `'add: unresolvable → Can\'t find "aider" on PATH'`; `'add: resolved absolute command, args after argv[0], default label = leaf without .exe'`; `'add: taken id → custom:aider-2; taken label (case-insensitive) → aider (2)'`; `'remove: non-custom id → null'`.
- [ ] Run — FAIL; implement.

#### Task 1.4: `detectAgentClis`
**Files:** Modify `src/shells.ts` (`CliScanEnv`, `detectAgentClis`, `hostCliScanEnv`; extract the def literal in `toDef` into a private builder both use); create `test/unit/detect-agent-clis.test.ts`.
**Interfaces:** Consumes `AGENT_CLI_NAMES` (`src/launchers.ts`, T1.2 — which is why this task runs in the serial lane after it). Produces `detectAgentClis(env: CliScanEnv): AgentDefinition[]`, `hostCliScanEnv(): CliScanEnv`.
**Steps:**
- [ ] Failing tests (injected `isFile`/`isExecutable`, `path.win32.join` / `path.posix.join`): `'win32 prefers .exe over .cmd in the same dir'`; `'win32 .cmd found when no .exe'`; `'win32 .bat found'`; `'win32 claude.ps1 and extensionless claude are ignored'`; `'win32 first PATH dir wins'`; `'posix bare name with X_OK'`; `'posix ~/.local/bin probed even when not on PATH'`; `'ids cli:<name>, label name, args [], icon terminal, cwdStrategy workspaceFolder'`; `'none found → []'`.
- [ ] Run — FAIL; implement.

#### Task 1.5: Registry aliases + `replace`
**Files:** Modify `src/agent-registry.ts`, `test/unit/agent-registry.test.ts`.
**Interfaces:** Produces the `AgentRegistry` contract.
**Call sites of the constructor:** `electron/main.ts` (T1.8), `test/unit/*.test.ts` that build a registry (second arg optional — untouched).
**Steps:**
- [ ] Failing tests: `'get follows an alias; list never includes it'`; `'resolve through an alias'` (AC9 half: a persisted `cli:claude` resolves `my-claude`'s command); `'replace mutates in place — a held reference sees new defs'`; `'replace returns false for an equal set, true for a changed arg/label/order/alias'`.
- [ ] Run — FAIL; implement.

#### Task 1.6: `upsertAttachedRepo`
**Files:** Modify `src/repo-history.ts`; modify `test/unit/repo-history.test.ts` (create it if absent).
**Steps:**
- [ ] Failing tests: `'keeps an existing lastAgentId and moves to front'`; `'new entry has no lastAgentId'`; `'capped at 20'`.
- [ ] Run — FAIL; implement.

#### Task 1.7: `LauncherHost`
**Files:** Create `electron/launcher-host.ts`, `test/unit/launcher-host.test.ts`.
**Interfaces:** Consumes `composeLaunchers`, `LauncherSet`, `LauncherDTO`, `parseLaunchers`, `serializeLaunchers`, `bumpUsage`, `addCustomLauncher`, `removeCustomLauncher`, `AgentRegistry.replace`. Produces the `LauncherHost` contract.
**Steps:**
- [ ] Failing tests (fakes): `'constructor composes shells+clis+config+custom into the registry'`; `'rescan returns false when detection is unchanged, true and replaces when a CLI appears'`; `'bump persists usage; dtos carry uses/lastUsed'`; `'addCustom success persists, registers, returns id; error passes through'`; `'addCustom takenIds/labels include every registry def'`; `'removeCustom of a custom id unregisters and persists; other id → false'`; `'pendingFlush null until a change'`; `'a bad launchers.json reads as empty'`.
- [ ] Run — FAIL; implement.

#### Task 1.8: Protocol + host wiring
**Files:** Modify `src/protocol.ts` (`launchers:rescan`, `launcher:addCustom`, `launcher:removeCustom`, `launcher:added`, `state.launchers: LauncherDTO[]`), `electron/main.ts`, `webview/bridge.ts` (fake state `launchers` built as `agents.map(a => ({id: a.id, kind: 'shell', uses: 0}))`; fake `launcher:addCustom` replies `{error: 'Not available in preview'}`), `webview/mock.ts` (`launchers: []` in mock state).
`electron/main.ts`:
- `launchersFile = () => path.join(userData(), 'launchers.json')` beside `agentsFile`.
- Replace `new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())])` with `const registry = new AgentRegistry([])` and `const launcherHost = new LauncherHost({ registry, config: loadAgents(agentsFile()), detectShells, detectClis: () => detectAgentClis(hostCliScanEnv()), readFile: () => readBlob(launchersFile()), persist: (t) => persistFile(launchersFile(), t, 'launchers.json'), resolveCommand: (c) => resolveCommand(c, hostPlatform), platform: hostPlatform, now: Date.now })` before `new SessionManager(registry)` (move `hostPlatform`'s declaration above it if mf-model left it lower).
- `postState` adds `launchers: launcherHost.dtos()`.
- `openRepo(…)`: after the session is created (never on a refusal), `launcherHost.bump(agent.id)`; repos.json: `upsertAttachedRepo` for each accepted root in reverse order, then today's home `upsertRepo`, one `persistFile`.
- Cases: `launchers:rescan` → `if (launcherHost.rescan()) postState()`; `launcher:addCustom` → result; on ok `postState()` then `replyHere({type:'launcher:added', requestId, id})`, else `replyHere({…, error})`; `launcher:removeCustom` → `if (launcherHost.removeCustom(m.id)) postState()`.
- `flushStateSync`: `const lf = launcherHost.pendingFlush(); if (lf) write(launchersFile(), lf, 'launchers.json')`.
**Interfaces:** Consumes `LauncherHost`, `detectAgentClis`, `hostCliScanEnv`, `upsertAttachedRepo`, `resolveCommand`, `hostPlatform`.
**Call sites:** `registry` users unchanged (`mgr`, `resolveLaunchSpec`/`buildLaunchSpec`, `openRepo`, `openFileFromOS`).
**Steps:**
- [ ] Carve-out (host wiring): proof is the slice check plus Slice 4's e2e (row, ranking, alias, custom).

### Slice 2: Folder picker, probe, preview on the host

**Check:** `npx vitest run test/unit/command-line.test.ts test/unit/folder-probe.test.ts test/unit/folder-picker.test.ts test/unit/launch-preview.test.ts`; `npm run typecheck`; `npm run fallow:check`.

**Parallel groups:** G1: T2.1 · G2: T2.3 · Serial: T2.2 → T2.4 → T2.5 (T2.2 and T2.4 each add a type to `src/protocol.ts`)
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/bridge.ts`

#### Task 2.1: `formatCommandLine`
**Files:** Modify `src/command-line.ts`, `test/unit/command-line.test.ts`.
**Interfaces:** Produces `formatCommandLine(spec: Pick<SpawnSpec, 'command' | 'args'>, platform: HostPlatform): string`.
**Steps:**
- [ ] Failing tests: `'leaf drops .exe/.cmd/.bat any case'` (`C:\\x\\claude.CMD` → `claude`); `'win32 path with a space quoted'` (`--add-dir "D:\\a b\\c"`); `'win32 trailing backslash before closing quote doubled'`; `'posix quote with \'\\\'\''`; `'round trip with splitCommandLine for each platform over the fixture list'`; `'no args → leaf only'`.
- [ ] Run — FAIL; implement.

#### Task 2.2: `probeFolders`
**Files:** Create `src/folder-probe.ts`, `test/unit/folder-probe.test.ts`; modify `src/protocol.ts` (add `MAX_PROBE_PATHS` and `FolderProbeResult` only; T2.5 adds the messages).
**Interfaces:** Consumes `probeFolder` (via the injected `probe`), `mapWithConcurrency` (`src/git-exec.ts`), `GitInfo`. Produces `FolderProbeResult` and `MAX_PROBE_PATHS` (in `src/protocol.ts`), `probeFolders`.
**Steps:**
- [ ] Failing tests (fake probe, fake gitInfo): `'present repo on a branch → exists + branch'`; `'detached → short sha, detached:true'`; `'present non-repo → exists, no branch'`; `'missing and invalid → exists:false, gitInfo never called'`; `'17 paths → 16 results'`; `'non-array → []'`; `'gitInfo rejects → exists, no branch'`.
- [ ] Run — FAIL; implement.

#### Task 2.3: `FolderPicker`
**Files:** Create `electron/folder-picker.ts`, `test/unit/folder-picker.test.ts`.
**Interfaces:** Produces `FolderPickerDeps`, `FolderPicker`, `createFolderPicker`.
**Steps:**
- [ ] Failing tests (fake dialog, fake window objects): `'e2e: hook installed; queued paths answer picks in order, null included'`; `'e2e with empty queue → native dialog'`; `'not e2e → hook never installed'`; `'cancelled → null'`; `'second pick for the same window while one is open → null, dialog shown once'`; `'dialog called with {properties:[openDirectory], title} and the window'`.
- [ ] Run — FAIL; implement.

#### Task 2.4: `previewLaunch`
**Files:** Create `src/launch-preview.ts`, `test/unit/launch-preview.test.ts`; modify `src/protocol.ts` (add `LaunchPreviewResult` only).
**Interfaces:** Consumes `buildLaunchSpec(req: LaunchRequest): LaunchPlan`, `presentRoots(s)`, `formatCommandLine`, `AgentRegistry`, `DroppedRoot`, `probeFolder` type. Produces `LaunchPreviewResult` (in `src/protocol.ts`), `previewLaunch`.
**Steps:**
- [ ] Failing tests (real `AgentRegistry`, fake probe/resolveInitialRoots): `'claude + present root → display "claude --add-dir <R>", cwd = home'` (AC4 unit half); `'missing root excluded from args'`; `'win32 claude.cmd + root x&y → skippedAddDirRoots [x&y], arg absent'`; `'claude.exe + x&y → passed'`; `'home missing → error home-missing'`; `'unknown agent → unknown launcher'`; `'unresolvable command → not found on PATH with args filled'`; `'shell → shell display, no --add-dir'`; `'non-string home → invalid request'`; `'display === formatCommandLine(buildLaunchSpec(same).spec)'` (spec §1 outcome).
- [ ] Run — FAIL; implement.

#### Task 2.5: Protocol + host wiring
**Files:** Modify `src/protocol.ts` (`folder:pick`, `folder:probe`, `launch:preview`, `folder:picked`, `folder:probeResult`, `launch:previewResult`), `electron/main.ts`, `webview/bridge.ts` (fake replies: `folder:picked {path: null}`; `folder:probeResult` with `exists: true` for every path; `launch:previewResult {error: 'Not available in preview', skippedAddDirRoots: []}`).
`electron/main.ts`:
- `folderPicker = createFolderPicker({ showOpenDialog: (w, o) => (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o)), e2e: process.env.CONDUIT_E2E === '1', installHook: (h) => { (global as Record<string, unknown>).__pickDirHook = h; } })` beside the `__osOpenColdHook` block.
- `folder:pick` → `replyHere({type:'folder:picked', requestId, path: await folderPicker.pick(senderWin, 'Add a folder')})`.
- `folder:probe` → `probeFolders(m.paths, { probe, gitInfo: (d) => getGitInfo(d, { timeoutMs: GIT_TIMEOUT.metadata }) })` (`probe` = mf-model's host probe closure).
- `launch:preview` → `previewLaunch(m, { registry, probe, resolveInitialRoots: (h, r) => sessionOps.resolveInitialRoots(h, r), exists: fs.existsSync, resolveCommand: (c) => resolveCommand(c, hostPlatform), platform: hostPlatform })`.
**Steps:**
- [ ] Carve-out (wiring): proof is Slice 4's e2e (Browse via hook, branch, preview text, guard).

### Slice 3: The dialog

**Check:** `npx vitest run test/unit/folder-validation.test.ts test/unit/session-ops.test.ts test/unit/launchers.test.ts test/unit/host-request.test.ts test/unit/new-session-seed.test.ts test/unit/new-session-state.test.ts test/unit/new-session-modal.test.ts test/unit/overlay-sites.test.ts test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts test/unit/launch-args.test.ts test/unit/project-store.test.ts`; `npm run typecheck`; `npm run fallow:check`; `grep -rn "browseRepo" src webview electron test` returns nothing; in a browser preview (`playwright-cli`, served over HTTP, screenshots to `%TEMP%\claude-scratch`) the dialog renders in all three themes with no console error.

**Parallel groups:** Wave A — G1: T3.1 · G2: T3.2 · G3: T3.3 · G4: T3.4 · Serial: T3.5 · Wave B — G5: T3.6 · G6: T3.7 · G7: T3.8 · G8: T3.9 · Serial: T3.10 → T3.11 → T3.12
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/app.tsx`, `webview/bridge.ts`, `webview/styles.css`, `test/unit/overlay-sites.test.ts`

#### Task 3.1: `findFolderConflict`
**Files:** Modify `src/folder-validation.ts`, `test/unit/folder-validation.test.ts`.
**Interfaces:** Consumes `folderKey`, `isAncestorOf`. Produces `FolderConflict`, `findFolderConflict(candidateKey: string, existingKeys: readonly string[]): FolderConflict | null`.
**Call sites:** `placementConflict` callers (`src/session-ops.ts`) — behaviour unchanged.
**Steps:**
- [ ] Failing tests: `'equal key → duplicate with index'`; `'candidate under an existing → inside'`; `'candidate above an existing → contains'`; `'/a vs /ab → null'`; `'win32 case/slash variants → duplicate'`.
- [ ] Run — FAIL; implement; re-express `placementConflict`; `npx vitest run test/unit/session-ops.test.ts test/unit/folder-validation.test.ts` green with mf-model's tests unmodified.

#### Task 3.2: `preferredShellId` + `rankLaunchers`
**Files:** Modify `src/launchers.ts`, `test/unit/launchers.test.ts`.
**Interfaces:** Produces `preferredShellId`, `LaunchRanking`, `rankLaunchers` (Contracts).
**Steps:**
- [ ] Failing tests: `'no history, claude+codex detected → row [cli:claude, cli:codex], shell pinned'` (AC1 unit); `'3 codex + 1 claude → row [cli:codex, cli:claude]'` (AC2 unit); `'tie on uses → lastUsed desc → canonical order'`; `'gemini, aider, config entries never push the shell out'` (D16); `'more = remaining non-shells in rank order then other shells'`; `'preferredShellId: defaultAgentId shell → it; non-shell default → first shell; none → undefined'`.
- [ ] Run — FAIL; implement.

#### Task 3.3: `requestHost`
**Files:** Create `webview/host-request.ts`, `test/unit/host-request.test.ts` (`vi.mock('../../webview/bridge')` for `post`/`subscribe`).
**Interfaces:** Produces `requestHost` (Contracts).
**Steps:**
- [ ] Failing tests (fake timers): `'resolves the reply with its requestId, ignores others'`; `'accepts any of several types'`; `'null after timeout and unsubscribed'`; `'ids increase per call'`.
- [ ] Run — FAIL; implement.

#### Task 3.4: Seed
**Files:** Create `src/new-session-seed.ts`, `test/unit/new-session-seed.test.ts`.
**Interfaces:** Consumes `folderKey`, `Session`, `Project`, `RepoDTO`, `LauncherDTO`. Produces `NewSessionPrefill`, `SeedContext`, `NewSessionSeed`, `projectForNewSession`, `agentForHome`, `seedNewSession`.
**Steps:**
- [ ] Failing tests (AC7 unit rows): `'{} with active in a live project → that project, its most recent session's home+roots'`; `'{} with active standalone → null project, repos[0] home'`; `'{home: dir} (explorer) → project derived from active, home dir, roots []'`; `'{agentId} (omni-bar) → that agent when registered'`; `'board prefill {home, roots, projectId:null, cardId} → standalone, folders as given, missing root kept'` (D17); `'dangling prefill projectId → derived'`; `'roots without home ignored'`; `'roots dedupe by key and drop home'`; `'agent: prefill → home lastAgentId → defaultAgentId → first shell → agents[0]'`; `'projectForNewSession: live → id; standalone, dangling, no active → null'`; `'no folders anywhere → home undefined, roots []'`.
- [ ] Run — FAIL; implement.

#### Task 3.5: Dialog reducer
**Files:** Create `webview/new-session-state.ts`, `test/unit/new-session-state.test.ts`; modify `src/project-store.ts` (export `normalizeProjectName`), `src/launch-args.ts` (export `firstCmdMetachar`, used by `launchArgsFor` itself).
**Interfaces:** Consumes `findFolderConflict`, `folderKey`, `MAX_ROOTS`, `agentForHome`, `SeedContext`, `NewSessionSeed`, `normalizeProjectName(raw: unknown): string | null`, `firstCmdMetachar(s: string): string | undefined`, `FolderProbeResult`, `LaunchPreviewResult` (both `src/protocol.ts`), `sessionNameFromPath`. Produces the `new-session-state.ts` contract.
**Steps:**
- [ ] Failing tests: `'first folder added becomes home and re-picks the agent'`; `'after pickAgent, a home change keeps the agent'` (D13); `'duplicate add flashes the existing row'`; `'inside → Already covered by <name>; contains → Contains <name>'`; `'32 folders → add ignored'`; `'home × only when it is the only folder'`; `'makeHome swaps: [B, A, C]'` (AC6 unit); `'makeHome on a Not found row refused'`; `'newProject: blank/81 chars ignored; case-insensitive match selects existing; else pending'`; `'start while starting → unchanged'`; `'revalidate: deleted project → null; unregistered agent → agentForHome'`; `startBlock`: `'no agents → No terminals found'`, `'no folders → Add a folder to start'`, `'home missing → Home folder not found'`, `'skipped x&y with claude.cmd → the .cmd shim message naming "x&y" and "&"'` (AC8 unit), `'otherwise null'`.
- [ ] Run — FAIL; implement.

#### Task 3.6: Launch row
**Files:** Create `webview/components/new-session-launch-row.tsx`.
**Interfaces:** Consumes `LaunchRanking`, `LauncherDTO`, `AgentDefinition`, `requestHost`, `Popover` (`align: 'end'`, `width: 210`, `triggerRef` = the More button), `MAX_CUSTOM_LAUNCHERS` (`src/launchers.ts`) compared with `customCount`. Produces `NewSessionLaunchRow` (Contracts).
Markup: `div.ns-launch[role=radiogroup][aria-label=Launch]` of `button.ns-pill[role=radio][aria-checked]` (roving tabindex, Arrow keys move and select; selected adds `ns-pill--on chamfer--sm`), label `Shell` for the shell pill, the extra pill before `button.ns-more[aria-haspopup=menu][aria-expanded]` (`More`, `IconChevronDown`). Menu: `div.ns-more-menu` in `Popover` with `div[role=group][aria-label="Found on this machine"]` header text, rows `.ctxmenu__item[role=menuitemradio]` with `span.ns-more__tag` (`PATH` | `shell` | `config` | `custom`), a custom row's trailing `button[aria-label="Remove <label>"]` posting `launcher:removeCustom`, last `.ctxmenu__item.ns-more__custom[role=menuitem]` `+ Custom command…` (disabled `Custom launcher limit reached (50)` at the cap). Form: `div.ns-custom` with mono `input[aria-label=Command][placeholder="e.g. aider --model sonnet"]`, `input[aria-label=Label]`, `Add` (disabled while validating) and `Cancel`; `Add` → `requestHost((id) => ({type:'launcher:addCustom', requestId: id, commandLine, label}), ['launcher:added'], 5000)`; success → `onPick(id, true)` and close form, focus `More`; error (or timeout → `No reply from host`) in `div.ns-custom__error`. Zero agents → `span.ns-launch__empty` `No terminals found`.
**Steps:**
- [ ] Covered by T3.10's modal tests (component carve-out: no standalone test; its behaviour is asserted through the modal).

#### Task 3.7: Project chip
**Files:** Create `webview/components/new-session-project-chip.tsx`.
**Interfaces:** Consumes `Project`, `Popover` (`align: 'start'`). Produces `NewSessionProjectChip` (Contracts).
Markup: set → `div.ns-chip` with `button.ns-chip__body[aria-label="Project: <name>"]` (`in <name>`, `IconChevronDown`; Delete key = ×) and `button.ns-chip__remove[aria-label="Remove from project"]`; pending → `in <name>` with `.ns-chip--pending`; standalone → `button.ns-chip.ns-chip--none` `No project`, `IconChevronDown`. Menu `div.ns-projects`: `No project`, projects by `order` (current `aria-checked`), then after `.ctxmenu__sep` `+ New project…` which becomes `input[aria-label="Project name"]` (Enter → `onNew`, Esc reverts). `error` → `span.ns-chip__error` `Couldn't create project`.
**Steps:**
- [ ] Covered by T3.10's modal tests (carve-out as T3.6).

#### Task 3.8: Folders list
**Files:** Create `webview/components/new-session-folders.tsx`.
**Interfaces:** Consumes `FolderProbe`, `RepoDTO`, `folderKey`, `sessionNameFromPath`, `requestHost`, `Popover`, `IconPlus`, `IconFolder`. Produces `NewSessionFolders` (Contracts).
Markup: `ul.ns-folders[role=list]`, bounded height with internal scroll; each `li.ns-folder[role=listitem]` (`.ns-folder--home` for index 0, `.ns-folder--flash` when its key is `flashKey`): `span.ns-folder__dot`, `span.ns-folder__name`, `span.ns-folder__path.repo__path` (`\u200e<path>\u200e` + ` · <branch>` in `span.ns-folder__branch` once probed), home → `span.ns-folder__home` `Home`; attached → `button.ns-folder__make[aria-label="Make <name> home"]` `Make home` (hidden when Not found) and `button.ns-folder__remove[aria-label="Remove <name>"]` `×` (home shows × only when alone); `exists:false` → `span.ns-folder__missing` `Not found`. Hint under the list: `div.ns-folders__hint`. Last row `button.ns-folders__add[aria-haspopup=menu]` `+ Add folder…` (disabled `Folder limit reached (32)` when `atCap`). Menu `div.ns-addmenu`: `div[role=group][aria-label=Recent]` with up to 10 `state.repos` entries whose key isn't listed, each `.ctxmenu__item[role=menuitem]` name + faint `.repo__path`; none → faint `No recent folders`; then `Browse…` → `requestHost((id) => ({type:'folder:pick', requestId: id}), ['folder:picked'], 120000)` → non-null path → `onAdd`. Focus: after add → that row's first button; after × → next row or Add.
**Steps:**
- [ ] Covered by T3.10's modal tests (carve-out as T3.6).

#### Task 3.9: Preview box
**Files:** Create `webview/components/new-session-preview.tsx`.
**Interfaces:** Consumes `LaunchPreviewView`. Produces `NewSessionPreview` (Contracts).
Markup: `div.ns-preview` (`.ns-preview--busy` while loading, last value kept) with `span.ns-preview__cwd` `<cwd>>` and `span.ns-preview__cmd` = `display` split on `/(\s+)/`, tokens starting `--` wrapped in `span.ns-preview__flag`; `title` = `command`; wraps, never scrolls sideways. No folders → `Add a folder to see the command`; `error` → faint `span.ns-preview__error` `Can't resolve <label>: <error>`.
**Steps:**
- [ ] Covered by T3.10's modal tests (carve-out as T3.6).

#### Task 3.10: Modal
**Files:** Rewrite `webview/components/new-session-modal.tsx`; rewrite `test/unit/new-session-modal.test.ts` (same harness style as today; `vi.mock('../../webview/bridge')` capturing `post` and driving replies through the mocked `subscribe`); modify `test/unit/overlay-sites.test.ts` (`ALL_FILES` += `'new-session-launch-row'`, `'new-session-project-chip'`, `'new-session-folders'`, `'new-session-preview'`; add `it('new-session menus render in a Popover')` asserting `/<Popover/` in the launch-row, chip and folders sources and no `position: fixed` inline style).
**Interfaces:** Consumes everything in T3.2–T3.9 plus `DroppedRoot`, `openRepo:result`, `project:created`, `project:opResult`. Produces `NewSessionModal` (Contracts).
Behaviour: seed once (`useState(() => initialNewSessionState(seedNewSession(prefill, ctx)))`, reducer via `useReducer` with the latest `ctx` in a ref; a `revalidate` dispatch on each `ctx` change). On mount: post `launchers:rescan`; probe every folder (batches of 16; new folders probed on add); preview requested on every agent/folder change via `requestHost(…, ['launch:previewResult'], 5000)`, applying only the latest request's reply. Frame: `ModalLayer onDismiss={onClose}` > `div.modal.ns[role=dialog][aria-modal][aria-labelledby]`: head `New session` + faint mono `Esc` (`span.ns__esc`), subtitle `Start a session for "<cardTitle>"` when set; `Launch` label + row; chip; `Folders` + list; `Launches as` + preview; footer `Cancel` (`.btn`) and `Start session` (`.btn--primary`, `aria-describedby` → `span.ns__reason` holding `startBlock(...).reason`); `div.ns__error` for `startError`; `div.ns__live[aria-live=polite]` for `announce`. Enter = Start only when `e.target` is the `.modal` itself or a `[role=radio]` (an `onKeyDown` on the frame, no window listener). Start: dispatch `start`; if `pendingProjectName` → `requestHost(project:create …, ['project:created','project:opResult'], 5000)` → failure/timeout → `startFailed(project:true)`; then `requestHost((id) => ({ type: 'openRepo', path: folders[0], agentId, roots: folders.slice(1), projectId: createdId ?? state.projectId /* null = standalone */, cardId: prefill.cardId, requestId: id }), ['openRepo:result'], 5000)` → `sessionId` → `onStarted(sessionId, droppedRoots)`; `error`/timeout → `startFailed` with the copy in Spec staleness (timeout → `no reply from host`). Focus on open: the selected pill.
**Steps:**
- [ ] Failing tests: `'opening posts launchers:rescan, one folder:probe, one launch:preview'` (EARS 1); `'row shows claude, codex, Shell with no history'`; `'More opens with the header and tags, a second click closes it'`; `'Enter in the custom Command input does not start'`; `'Enter on the frame starts once; a second Enter while starting posts nothing'` (EARS 2 + edge case); `'missing home disables Start with Home folder not found'` (EARS 3); `'preview skippedAddDirRoots → Start disabled, message names the folder'`; `'removing the chip → openRepo without projectId'`; `'picking a project → openRepo projectId'` (AC5 unit); `'pending project → project:create then openRepo with the new id'`; `'openRepo:result error keeps the dialog open with Couldn\'t start session: home folder not found'`; `'stale preview reply ignored'`; `'Make home changes the preview request home'` (AC6 unit).
- [ ] Run `npx vitest run test/unit/new-session-modal.test.ts test/unit/overlay-sites.test.ts` — FAIL; implement.

#### Task 3.11: App wiring, callers, `browseRepo` removal
**Files:** Modify `webview/app.tsx`, `src/protocol.ts` (delete `browseRepo`), `electron/main.ts` (delete `browseRepo` function and case), `webview/bridge.ts` (delete any `browseRepo` fake if present).
`webview/app.tsx`: `newSession` state type becomes `NewSessionPrefill | null`; `openNewSession(home?: string)` → `setNewSession(home ? { home } : {})` (explorer `openAsSession` and header +/Ctrl+N/palette/empty state keep calling it); omni-bar agent → `{ agentId: a.id }`; board card menu → `{ home: active?.home, roots: active?.roots ?? [], projectId: active?.projectId ?? null, cardId: card.id, cardTitle: card.title }` (home omitted when no active); mount `<NewSessionModal prefill={newSession} ctx={{ active, sessions, projects: state?.projects ?? [], repos: state?.repos ?? [], agents, launchers: state?.launchers ?? [], defaultAgentId: settings.defaultAgentId }} onClose={() => setNewSession(null)} onStarted={(_, dropped) => { setNewSession(null); for (const d of dropped) pushToast({ message: \`Skipped ${sessionNameFromPath(d.path)}: not a valid folder\`, variant: 'error' }); }} />`. The existing `knownIds` effect activates the new session — no extra code.
**Call sites of `NewSessionModal` props:** only this mount.
**Steps:**
- [ ] Carve-out (wiring): proof is `npm run typecheck`, `grep -rn "browseRepo" src webview electron test` empty, `npm run fallow:check`, and Slice 4's e2e.

#### Task 3.12: Styles
**Files:** Modify `webview/styles.css`.
Add `.ns`, `.ns__esc`, `.ns-launch`, `.ns-pill`, `.ns-pill--on` (white fill from the surface token, `--accent` border and text), `.ns-more` (dashed border), `.ns-more-menu`, `.ns-more__tag`, `.ns-more__custom` (accent, top border), `.ns-custom`, `.ns-custom__error` (`--danger`), `.ns-chip` (accent-soft tint), `.ns-chip--none` (neutral dashed), `.ns-chip--pending`, `.ns-chip__remove`, `.ns-chip__error`, `.ns-projects`, `.ns-folders` (bordered, `max-height` with `overflow-y: auto`), `.ns-folder`, `.ns-folder--home`, `.ns-folder__dot` (filled `--accent` for home, hollow otherwise), `.ns-folder__branch`, `.ns-folder__home` (accent pill), `.ns-folder__make`, `.ns-folder__remove`, `.ns-folder__missing` (`--amber`), `.ns-folder--flash`, `.ns-folders__add` (dashed top border, accent), `.ns-folders__hint`, `.ns-addmenu`, `.ns-preview` (`--term-bg` / `--term-surface`, mono, `white-space: pre-wrap; overflow-wrap: anywhere`), `.ns-preview--busy` (dimmed), `.ns-preview__cwd` / `__error` (faint), `.ns-preview__flag` (`--accent`), `.ns__reason`, `.ns__error` (`--danger`). Delete `.repobrowse`, `.repolist`, `.repo`, `.repo--active`, `.repo--active:hover`, `.repo__icon`, `.repo--active .repo__icon`, `.repo__name`, `.repo--browse`, `.modal__termlabel`; keep `.repo__path`. In the interaction-state vocabulary section, `.repo` → `.ns-pill`, `.ns-folders__add`, `.ns-folder__make`, `.ns-folder__remove`, `.ns-more`; `.repo--active` → `.ns-pill--on`. `@media (forced-colors: active)`: `.ns-pill--on` and the Home pill get a `1px solid CanvasText` border; the focus ring survives. Sizes from `.autoloop/handoff/screenshots/9a-new-session.png` and `.autoloop/handoff/Conduit Multi-Folder Sessions.dc.html` 9a, expressed in tokens (no hex).
**Steps:**
- [ ] Visual-fidelity carve-out: baseline = the handoff 9a screenshot (already captured, earlier than this step); proof = a side-by-side of the browser-preview dialog (Aero light, Aero dark, Neon) against it, screenshots in `%TEMP%\claude-scratch`, deleted after; plus `npx vitest run test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts test/unit/shell-tokens.test.ts` green.

### Slice 4: End-to-end proof and scenario updates

**Check:** `npm run build`, then one at a time: `node test/e2e/run-smoke.mjs new-session-folders`, `… explorer-open-as-session`, `… chamfer-edge`, `… overlay-modals`, `… overlay-popovers`, `… multi-folder-model`, `… cwd`; then `npm run verify` exit 0 (read directly, never piped). A PTY-echo failure is re-run alone on a quiet machine before it is believed.

**Parallel groups:** G1: T4.1 · G2: T4.2
**Claims (serial lane):** none (each task owns disjoint files)

#### Task 4.1: `new-session-folders.e2e.mjs`
**Files:** Create `test/e2e/new-session-folders.e2e.mjs` (standalone launch like `new-session-browse-pinned` did, because it seeds userData: `launchApp({ userDataDir, env })`, `closeApp`, Windows-only SKIP).
Setup: temp stub dir with `claude.cmd` and `codex.cmd` = `@echo off` / `echo STUB-ARGS:%*` / `ping -n 60 127.0.0.1 >nul`; `env.PATH` = stub dir; `%SystemRoot%\System32`; the directory of the `git.exe` the test process resolves (`where git`, first line) — git is needed for the probe's branch. Folders: A = `git init -b main` + one commit; B plain; C named `x&y`.
Scenarios (spec §7 Gherkin, same or stronger):
- [ ] **multi-folder claude session in a project:** create project `RMB pipeline` via `project:create`; open from the header `+`; `.ns-launch .ns-pill` texts `claude`, `codex`, `Shell` (AC1); `__pickDirHook.queue([A, B])` via `app.evaluate`, `+ Add folder…` → `Browse…` twice; A row is `.ns-folder--home` with `· main`, B has `Make home` and `×`; `.ns-preview` textContent equals `<A>> claude --add-dir <B>` (AC4); chip → `RMB pipeline`; Start; tapped `openRepo:result` has `sessionId`; `state` session has `home` A, `roots` [B], that `projectId`, `agentId` `cli:claude` (AC5); terminal (`term:data`) prints `STUB-ARGS:--add-dir <B>` (AC4 spawn half, exactly one `--add-dir`).
- [ ] **Make home:** reopen, add A and B, click `Make B home` → B is home, preview cwd reads `<B>>` (AC6).
- [ ] **More toggles; ranking follows use:** post `openRepo` with `cli:codex` ×3 and `cli:claude` ×1 (`requestId` set); reopen → pills `codex`, `claude`, `Shell` (AC2); click `More ▾` → `Found on this machine` visible, its right edge within 1px of the button's (AC3), rows carry tags, last row `+ Custom command…`; second click closes it.
- [ ] **batch-file guard:** claude selected, attach A then C → Start disabled, `.ns__reason` contains `x&y`; clicking Start posts no `openRepo` and no session appears (AC8).
- [ ] **alias:** relaunch with `agents.json` = `[{id:'my-claude', label:'my-claude', command:'claude', args:[], icon:'terminal', color:'green', cwdStrategy:'workspaceFolder'}]` and a seeded `sessions.json` session with `agentId: 'cli:claude'` → the pill row shows `my-claude`, no `cli:claude` in `state.agents`; relaunching that session prints `STUB-ARGS` (AC9).
- [ ] **custom command:** `More ▾` → `+ Custom command…`, Command `codex --x` → Add → an extra selected pill `codex (2)` and `state.agents` has a `custom:` id; `launchers.json` in userData holds it after `closeApp`.
- [ ] **board card prefill:** `.conduit/board.json` in A with card `Move RMB to CI` (shape as `test/e2e/visual/fixture-repo.mjs` writes it); `openSession(page, { path: A, roots: [B] })` (mf-changes harness); open the board, card menu `Start session for this card` → subtitle `Start a session for "Move RMB to CI"`, folders A and B; Start → new session `cardId` equals the card id (AC7 e2e half).
- [ ] Run `node test/e2e/run-smoke.mjs new-session-folders` after `npm run build` — expect PASS.

#### Task 4.2: Existing scenarios
**Files:** Delete `test/e2e/new-session-browse-pinned.e2e.mjs`; modify `test/e2e/explorer-open-as-session.e2e.mjs` (the `.repo--active .repo__path` read → `.ns-folder--home .ns-folder__path`, same `norm(...) === norm(join(dir, 'pkg'))` assertion; **add** the row has no `.ns-folder__missing`); modify `test/e2e/chamfer-edge.e2e.mjs` (comments naming `.repo--active` / "selected repo row" → `.ns-pill--on` / "selected launch pill"; the survey and assertions unchanged — the selected pill carries `chamfer--sm` so it is surveyed).
**Steps:**
- [ ] Run `node test/e2e/run-smoke.mjs explorer-open-as-session` and `… chamfer-edge` after `npm run build` — expect PASS.

## Verification

- Per task: its `npx vitest run <file>`, red observed before green.
- Per slice: the slice's Check; `npm run typecheck` (a parallel task's type change can break a
  serial-lane file until that lane lands).
- End of item: `npm run build`, the Slice 4 e2e list serially, then `npm run verify` exit 0 read
  directly. `git status` shows only the files in the file map.
- This item's dialog-touching regression set for the run-end sweep: `new-session-folders`,
  `explorer-open-as-session`, `chamfer-edge`, `overlay-modals`, `overlay-popovers`,
  `multi-folder-model`, `cwd`, `visual/shoot.mjs new-session` frame.

## Deviation rule

If a task's assumption turns out wrong — an mf-model export is missing or shaped differently, a
locked signature doesn't fit, a reply arrives in another shape — that task **stops** and fixing the
misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback,
or an override patched in place of its semantic source (in particular: no second folder-conflict
rule, no second metacharacter check, no dialog-side command formatting). The report leads with the
fix that keeps the locked decision.

## Decisions Needed

- [normal] **Custom launchers whose command leaf is `claude` get `--add-dir`** because mf-model's
  `launchArgsFor` matches by command basename (L5); L5's "custom: no flag" is read as "custom
  non-claude commands". Default taken: follow `launchArgsFor`.
- [normal] **`launchers:rescan` re-detects shells and CLIs only;** agents.json is read once at
  startup, as today. Default taken: no agents.json reload (non-goal: changing its semantics).
- [normal] **Detection cost:** ~6 names × 3 extensions × PATH dirs of sync `existsSync` per dialog
  open, on the main process. Measured cheap in principle; not benchmarked. Default taken: sync.
- [normal] **A corrupt launchers.json reads as empty and is overwritten on the next bump** (same as
  repos.json). Default taken: no corrupt-file backup.
- [normal] **OS-open sessions (`openFileFromOS` → `openRepo`) bump usage** of the shell they use,
  because every host creation counts (spec §3.3). Default taken: count them.
- [normal] **A second concurrent `folder:pick` from one window resolves `null`** (mf-files §4
  "ignored host-side"), rather than queueing. Default taken: null.
- [normal] **Dialog folder cap = `MAX_ROOTS` (32) folders including home**, one below the host's
  home + 32 roots. Default taken: the spec's 32-folder copy, sourced from the one constant.
- [normal] **Preview tinting splits `display` on whitespace;** a quoted path containing ` --x` would
  tint that fragment. Cosmetic only. Default taken: accept.
- [normal] **ASSUMED (spec D3):** Electron's node-pty spawns a `.cmd` directly with quoted args as
  Node 24 did; `new-session-folders` proves it with the stub. If it fails, the fix belongs in
  mf-model's spawn path (`%ComSpec% /d /s /c`), not here.
