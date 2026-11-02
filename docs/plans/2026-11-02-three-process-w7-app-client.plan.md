# W7 "App as client": implementation plan

**Status:** active (2026-11-02). Lead decisions are in the Decisions Needed section below.
**Spec:** `docs/specs/2026-11-01-three-process-program.md` (the `| W7 |` row and its Invariants), `docs/specs/2026-11-01-three-process-architecture.md`, `docs/runs/2026-11-01-three-process-design/main-ts-ownership.md`, and `.autoloop/blockers.md`.
**Tier:** FULL. It touches many modules, adds new seams (the C2 client, C5 factory and lifecycle), runs as serialized lanes over a shared entry file, and changes the renderer contract.

## Goal
Make Electron a client of the Conduit server over C2 and an observer of hc over C5. Remove every place the app writes PTY or server state, and delete node-pty.

## Architecture
`electron/main.ts` keeps the window, editor, git and repo concerns. All of the following move into new single-purpose modules under `electron/`, each with unit tests in `test/unit/`, following the existing convention (for example `test/unit/session-folder-runtime.test.ts` imports `../../electron/...`):
- the C2 connection
- the server lifecycle (start rule, F6, F9)
- the hc observer links
- the session mirror and repo overlay
- the terminal glue
- the event routing

`main.ts` handlers become one-line calls into these modules. The cut-over is atomic by necessity. Once the app starts a server, the server is the only writer of `sessions.json`, `projects.json`, `launchers.json`, `timed-messages.json`, `scrollback-*` and `conduit-mcp/*`. So every server or split row of the ownership map switches in one slice (S2). S2's commits follow the program's "lead review per handler group".

## Data flow
```
renderer ─to-host IPC─► main.ts handle() ─► terminal-host / server-events / settings-mirror
                                              │ C2 call/notify (server-client.ts, 1 conn)
                                              ▼
   server-lifecycle.ts ──hc CLI (hc-cli.ts: run --bg --no-parent / kill, env=coreStartEnv, cwd=coreStartCwd)──► hc core
        │ start rule / F6 wait / F9 watch via hc-events.ts (one events.subscribe{labels:{conduit.instance}})
        ▼
   server ──event{seq,type,data}──► server-events.ts ─► app-session-store.ts (SessionView + overlay → mergeAppOverlay)
                                                    ─► broadcast 'state' / timer:* / mcp:* / Notification / flashFrame
   terminal-host.ts ─sessions.start─► server → {target, generation, prelude?} | {finished, prelude} | refusal
        └─ terminal-link.ts (C5 observe attach, history 2000, PAINT_QUIET_MS/PAINT_MAX_MS) ◄── hc bytes ─► term:data to owner window
```
State lives in three places:
- **Server:** records, rings, settings and tokens.
- **App:** the UI `settings.json` plus the server-key mirror, `windows.json`/`docs.json`/`repos.json`, the overlay `Map<sessionId, AppSessionOverlay>`, the open `TerminalLink`s, and the presence.
- **hc:** PTYs.

## Settled decisions (do not re-litigate)
D3, D4, D6 (no node-pty fallback), D7, D9, D17, D19, D23, D25, D26, D29, D39 and D40 as written. Five more points:
- Focus reports travel only inside `term:input`.
- Session status comes only from `sessions.changed`.
- `sessions.start` refuses only in its result. `sessions.create` refuses only as an RPC error.
- The app never kills a server or supervisor without an explicit user action.
- Every app hc call uses `coreStartEnv`, plus `CORE_START_RUN_FLAGS` for `hc run`. Every call that may start a core runs with cwd `coreStartCwd`.

## Spec staleness (measured)
- **Ownership-map line numbers are about 46 lines low.** `handle()` cases now sit at `electron/main.ts`:
  - `ready` 2974, `openRepo` 3005, `session:*` 3008–3104, `project:*` 3105–3167, `launcher*` 3168–3187, `brief:*` 3210–3233, `folder:probe` 3234, `launch:preview` 3257
  - `repo:pin/unpin/context` 3883–3898, `rename` 3899, `setSessionIcon` 3903, `term:title` 3906, `relaunch` 3909, `kill` 3927, `visible` 3930, `duplicate` 3953, `reorderSessions` 3967, `updateSettings` 3970
  - `term:start` 4371, `timer:*` 4596–4639, `mcp:*` 4640–4649, `term:input/resize/dispose` 4652/4660/4667
  - `mcpInstall:*` handles 5091/5094, `settings:initial` 5156, `before-quit` 5166

  Rows below are cited by message name.
- **The program assigns W8 `test/e2e/harness/**`, but no such directory exists.** The harness is the single file `test/e2e/harness.mjs`. Plan: W8 owns that file.
- **`test/e2e/walking-skeleton.e2e.mjs` (W3b) does not exist**, and `.autoloop/lanes.yaml` has no W3b lane.
- **Runtime-dir preparation and bundled `node.exe`/hc don't exist yet.** They are W9's (`server/runtime-dir/**`, `resources/hc/**`), and W9 hasn't started. This plan runs end to end on the **unpackaged layout** only (see `runtime-layout.ts`). The packaged path needs W9.
- **The W4/W5/W6 lanes are still `running` (unmerged).** W7 starts only after they merge and `server/compose.ts` is wired.
- **`src/window-presence.ts` exports an interface `WindowPresence` whose name collides with C2's `WindowPresence`.** Import C2's as `type WindowPresence as C2WindowPresence`.
- **`Session` has no exit code, and C2 `SessionView` adds none.** Yet `term:exit{code}` needs one (see Decisions).

## Global constraints
- **Gate:** `npm run verify:quick` per task. `npm run verify` per slice; it includes `fallow:check`, so a slice may not leave dead exports. Run it on Node `^22.22.2 || ^24.15.0`. E2e runs remote (`npm run e2e:remote`), one local e2e at a time.
- **Naming:** files are kebab-case under `electron/`; classes are PascalCase; factories are `createX`. Tests live in `test/unit/<file>.test.ts` (vitest).
- **Imports:** contracts come from `src/contracts/*` and are never edited by W7. Changes to `src/protocol.ts` and `src/types.ts` are contract changes the lead must approve, and they are listed per slice.
- **Process invariants:**
  - Git runs only through `runGitBin`.
  - Directories are watched only through `watchDir`.
  - The app never writes to an hc stream; `HcStream.write`/`resize`/`facts` are never called from `electron/**`.
  - Kill by unique name only (`names.supervisorName`), never by pid or label.
- **E2e hooks reach the server as argv, never as env.** hc may refresh the env on Windows (M10), so pass `--e2e` to `supervise.js` when `CONDUIT_E2E=1`.

## Out of scope
Server internals (W3–W6), `server/compose.ts` (lead), harness teardown and new e2e scenarios (W8), packaging, runtime-dir preparation and the M16 installer pass (W9), and docs (W10).

## Contracts (new seams, real types)
```ts
// electron/server-client.ts — one C2 connection (no reconnect inside; lifecycle reopens)
export class ServerCallError extends Error { constructor(readonly kind: ServerErrorKind | 'disconnected' | 'timeout' | 'protocol', msg: string) }
export interface ServerClientOptions { endpoint: string; appVersion: string; connect?: () => Duplex; log: AppLog }
export type AppLog = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
export class ServerClient {
  constructor(o: ServerClientOptions);
  open(): Promise<ServerMethods['hello']['result']>;            // connect + hello{appVersion, generation: SERVER_PROTOCOL_GENERATION} within APP_HELLO_TIMEOUT_MS
  call<M extends ServerMethod>(m: M, p: ServerMethods[M]['params']): Promise<ServerMethods[M]['result']>; // rejects ServerCallError('disconnected') at once when not open; -32000 → kind from data.kind
  notify<N extends ServerNotification>(n: N, p: ServerNotifications[N]): boolean; // false = dropped (not open); never buffered (D29)
  subscribe(h: { snapshot(s: ServerSnapshot): void; event(e: ServerEventEnvelope): void }): Promise<void>; // events.subscribe; drops seq <= snapshot.seq; on `missed` re-subscribes and calls snapshot again
  onClose(cb: (why: 'eof' | 'error') => void): () => void;
  close(): void;
}
// electron/hc-cli.ts — the hc CLI, for the calls that may start a core
export interface HcCliDeps { hcExe: string; env: Record<string, string>; coreCwd: string;
  execFile(file: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> }
export function startSupervisor(d: HcCliDeps, a: { names: InstanceNames; nodeExe: string; superviseJs: string; userData: string; serverArgs: string[] }): Promise<{ ok: true } | { ok: false; reason: string }>;
//   argv = ['run', ...CORE_START_RUN_FLAGS, '--name', names.supervisorName, '--label', 'conduit.role=server', '--label', `conduit.instance=${names.instance}`, '--', nodeExe, superviseJs, '--user-data', userData, ...serverArgs]
export function killSupervisor(d: HcCliDeps, names: InstanceNames): Promise<{ ok: boolean; reason?: string }>; // ['kill', names.supervisorName]
// electron/hc-events.ts — one app-wide hc subscription, resubscribed on missed/ended/reconnected
export function createHcEvents(hc: HcClient, labels: Record<string, string>, log: AppLog): {
  on(terminal: string, cb: (e: HcEvent) => void): () => void; ready(): Promise<void>; close(): void };
// electron/runtime-layout.ts
export interface RuntimeLayout { nodeExe: string; superviseJs: string; hcExe: string; hcVersion: string; coreCwd: string }
export function runtimeLayout(i: { packaged: boolean; userData: string; appVersion: string; appPath: string; env: NodeJS.ProcessEnv }): RuntimeLayout;
//   packaged: runtime/<appVersion>/node.exe, runtime/<appVersion>/server/supervise.js, runtime/hc/<HC_PINNED_VERSION>/hc.exe
//   unpackaged: env.CONDUIT_NODE_BINARY ?? 'node', <appPath>/out/server/supervise.js, env.CONDUIT_HC_BINARY ?? 'hc'; coreCwd = coreStartCwd(runtimeRoot, hcVersion) in both (mkdir -p)
// electron/runtime-gc.ts — under app.requestSingleInstanceLock(), before the start rule
export interface RuntimeGcDeps { readdir(d: string): Promise<string[]>; rename(a: string, b: string): Promise<void>; rmrf(d: string): Promise<void> }
export function collectRuntimeGarbage(runtimeRoot: string, keep: { appVersion: string; hcVersion: string }, d: RuntimeGcDeps): Promise<{ removed: string[]; inUse: string[] }>;
//   candidates: runtime/<semver> and runtime/hc/<semver> beyond the newest two (versionOrder semantics; current always kept),
//   plus leftover *.gc / *.tmp. Never shim* dirs (D2b). In use = rename to `<dir>.gc` throws (EPERM|EBUSY|EACCES); renamed → rmrf.
// electron/server-lifecycle.ts — start rule, versionOrder, F6, F9, explicit actions
export type ServerLifecycleState =
  | { state: 'connecting' } | { state: 'connected'; hello: ServerMethods['hello']['result'] }
  | { state: 'reconnecting' }                                         // C2 down, supervisor live: input paused
  | { state: 'unavailable'; reason: 'exhausted' | 'hello-timeout' | 'restart-wait-timeout' | 'start-failed'; logPath: string; detail?: string }
  | { state: 'downgrade'; serverVersion: string }                     // D26
  | { state: 'stopped'; reason: string; logPath: string };            // F9 budget spent
export interface ServerLifecycleDeps { names: InstanceNames; layout: RuntimeLayout; userData: string; appVersion: string; serverArgs: string[];
  client: () => ServerClient; hc: HcClient; hcEvents: ReturnType<typeof createHcEvents>; cli: HcCliDeps;
  markerExists(): Promise<boolean>; deleteMarker(): Promise<void>; spawnDetachedSupervisor(): void; now(): number; log: AppLog }
export function createServerLifecycle(d: ServerLifecycleDeps): {
  start(): Promise<void>; current(): ServerLifecycleState; client(): ServerClient | null;
  onState(cb: (s: ServerLifecycleState) => void): () => void; onConnected(cb: (c: ServerClient) => void): () => void;
  retry(): Promise<void>; restartService(): Promise<void>; stopAllAndContinue(): Promise<void>;
  stopAll(): Promise<{ ok: boolean; killed?: number }>; dispose(): void };
export const VANISHED_RESTART_BUDGET = { attempts: 3, windowMs: 60 * 60_000 } as const;
// electron/terminal-link.ts — C5
export function createTerminalLinkFactory(d: { hc: HcClient; hcSession: string; hcEvents: ReturnType<typeof createHcEvents>; log: AppLog }): TerminalLinkFactory;
//   attach → hc.attach({terminal: target.terminal, observe: true, history, cols, rows}); FirstPaint = bytes until PAINT_QUIET_MS quiet, capped at
//   PAINT_MAX_MS after the first byte (empty if no byte within PAINT_MAX_MS), replay = [{length, geometry: size}]; credit(n) after each data() hand-off;
//   size(): hcEvents 'size' for target.terminal; mismatch vs requested size logged; closed(): HcStreamEnd → (reason, exit_code, restartable = reason==='disconnected')
// electron/app-session-store.ts — server views + D39 overlay (repo logic ported from SessionManager:403–495)
export interface SessionFolderDiff { sessionId: string; kind: 'added' | 'removed' | 'changed'; homeChanged: boolean; cwdChanged: boolean }
export class AppSessionStore {
  applyServer(views: SessionView[]): SessionFolderDiff[];    // drops overlays of vanished ids
  list(): AppSessionView[]; get(id: string): AppSessionView | undefined; generationOf(id: string): number | null;
  setRepos(id: string, repos: RepoInfo[]): boolean; setRepoGit(id: string, g: Record<string, GitInfo> | undefined): void;
  mergeRepoGit(p: ReadonlyArray<{ sessionId: string; root: string; info: GitInfo }>): void;
  setAutoRepo(id: string, root: string | undefined): void; pinRepo(id: string, root: string): void; unpinRepo(id: string): void;
  onChange(cb: () => void): () => void }
// electron/settings-mirror.ts (pure)
export function mirrorServerKeys(ui: AppSettings, server: ServerSettings): AppSettings;       // server keys overwritten, never stripped
export function uiOnly(incoming: AppSettings, current: AppSettings): AppSettings;             // updateSettings: server keys kept from `current`
export function serverPatchOf(patch: Partial<AppSettings>): Partial<ServerSettings>;          // picks SERVER_SETTINGS_KEYS
// electron/terminal-host.ts — term:* glue (S2)
export function createTerminalHost(d: { call: ServerClient['call'] | null getter; notify: ...; links: TerminalLinkFactory; store: AppSessionStore;
  sendToOwner(sessionId: string, m: HostToWebview): void; log: AppLog }): {
  start(m: Extract<WebviewToHost, { type: 'term:start' }>): Promise<void>; input(sessionId: string, data: string): void;
  resize(sessionId: string, g: TermGeometry): void; facts(sessionId: string, f: DisplayFacts): void; dispose(sessionId: string): void;
  show(sessionId: string, data: string): void; sessionsChanged(prev: AppSessionView[], next: AppSessionView[]): void;
  serverConnected(): void; hcReconnected(): void };
// electron/server-events.ts — one switch over ServerEvents (S2)
export function createServerEventRouter(d: { store: AppSessionStore; terminals: ReturnType<typeof createTerminalHost>; broadcastState(): void;
  sendToWindow(id: number, m: HostToWebview): void; ownerWindowOf(sessionId: string): number | undefined; raiseWindow(id: number): void;
  onServerSettings(s: ServerSettings): void; onStores(s: Partial<DataStores>): void; onRuntime(h: RuntimeHealth): void;
  notifyAttention(sessionId: string, kind: ServerEvents['attention.edge']['kind']): void; flash(sessionId: string): void;
  place(e: ServerEvents['sessions.opened']): void }): { snapshot(s: ServerSnapshot): void; event(e: ServerEventEnvelope): void };
```
`createTerminalHost`'s `d.call` and `d.notify` are getters onto the lifecycle's current `ServerClient` (null while down), so the store and terminal host survive reconnects. Its exact form: `client: () => ServerClient | null`.

Behaviour rules at the seams:
- **`term.input` while down:** `notify` returns false and the keystrokes are dropped (D29).
- **`input` generation:** comes from `store.generationOf`. With no generation, the input is dropped.
- **Attaching an observer:** on `sessionsChanged`, any mounted pane that has no link (or whose link's generation differs from `runtime.generation`) and is `status==='running' && runtime.spawn==='live'` gets `sessions.start`, then an observer attach. This covers relaunch, the timed relaunch, F9 reconnect and an MCP open.
- **`restartSeq` bump:** close the link only. The remount's `term:start` re-attaches.
- **Exit:** a `running→exited` transition emits `term:exit{code}` using the code from the link's cached CLOSE `exit_code`. A link CLOSE alone never changes status.
- **`hcReconnected`:** re-attach every live pane with `history: 0`.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| Session list and status | W4 `sessions.changed` + compose `statusOf` | store → `state` broadcast → renderer | consumer (both app hops) |
| Repo fields | app scans, `repo:*`, cwd diff | `mergeAppOverlay` → `state` | both |
| PTY bytes | hc | C5 link → `term:data` → xterm | consumer |
| Host-composed bytes | W4 `ScrollbackPort.show` → `term.show` | terminal-host → `term:data` | consumer |
| Keystrokes, size, facts | renderer `term:input/resize/facts` | `term.*` → W5/W6 | producer (renderer + app); server side measured in C2 |
| Server settings | W4 `serverSettings.changed` | mirror → `settings.json` + `state.settings` | consumer; renderer producer of `updateServerSettings` |
| UI logging | app `updateSettings` | `server.setLogging` → server logger | producer |
| Presence | app windows and owner map | W5 mirror (`ui.presence`) | producer |
| Folder suspect | app watcher (`SessionFolderRuntime.suspect`) | W4 health via `folders.suspect` | producer |
| OS resume | Electron `powerMonitor` (main.ts:1778–1779) | W4 timers via `system.resumed` | producer |
| Attention | W6 → compose `attention.edge/flash` | app Notification/flashFrame gated by `osAttention` | consumer |
| Timers | W4 `timers.fired` → `timers.changed` | `timer:fired` → `timer:state` | consumer |
| MCP UI and asks | W5 `ui.post`, `approvals.changed`, snapshot `pendingAsks` | owner window | consumer; producer of `mcp.fromRenderer` |
| Placement | W4 `sessions.opened` (before `sessions.changed`) | app placement + `suppressAutoSwitch` | consumer |
| Titles | hc `title` → server (N1) | `state.sessions[].name` | renderer `term:title` producer **removed** |

The server sides of these rows are owned by W4/W5/W6 and pinned by C2. The plan verifies them at the e2e level only.

## File map
| Path | Action | Responsibility |
|---|---|---|
| `electron/agent-scope-tracker.ts` → `src/agent-scope-tracker.ts` | move | the server imports it (W4) |
| `electron/launcher-host.ts` → `src/launcher-host.ts` | move | W4 |
| `electron/role-brief-host.ts` → `src/role-brief-host.ts` | move | W4 |
| `electron/persistence-write-gates.ts` → `src/persistence-write-gates.ts` | move | W6 |
| `src/windows-pty-info.ts` | create | `windowsPtyInfo` and `currentWindowsPty`, moved out of `src/pty-host.ts` |
| `src/launch-spec.ts` | modify | absorbs `resolveLaunchSpec`, `defaultShellSpec` and `sanitizeChildEnv` from `src/pty-host.ts` |
| `electron/server-client.ts` | create | C2 connection |
| `electron/hc-cli.ts` | create | hc CLI `run`/`kill` |
| `electron/hc-events.ts` | create | shared hc subscription |
| `electron/runtime-layout.ts` | create | binary and script paths |
| `electron/runtime-gc.ts` | create | D23 GC |
| `electron/server-lifecycle.ts` | create | start rule, F6, F9, actions, states |
| `electron/terminal-link.ts` | create | C5 factory |
| `electron/app-session-store.ts` | create | mirror + D39 overlay |
| `electron/settings-mirror.ts` | create | D7 pure merges |
| `electron/terminal-host.ts` | create | `term:*` glue |
| `electron/server-events.ts` | create | event routing |
| `electron/session-folder-runtime.ts` | modify | health removed (W4); reads `AppSessionStore`; `suspect` → `deps.suspect(sessionId, path)` |
| `electron/main.ts` | modify (claim) | handlers per the ownership map |
| `src/protocol.ts`, `src/types.ts` | modify (claim, lead) | renderer contract (listed per slice) |
| `webview/components/terminal-pane.tsx` | modify | `term:facts`; `term:title` removed; input-paused overlay (S4) |
| `webview/settings.tsx` | modify | key-scoped `updateServerSettings` |
| `webview/bridge.ts` | modify (claim) | dev fake host for the new messages |
| `webview/app.tsx`, `webview/components/server-banner.tsx` (new), `webview/components/center-pane.tsx`, `webview/quit-responder.ts` | modify/create | S4 states |
| `package.json` | modify (claim) | remove `@lydell/node-pty` |
| `src/pty-host.ts`, `electron/session-screens.ts`, `electron/conduit-mcp-endpoint.ts`, `electron/conduit-mcp-runtime-ports.ts`, `electron/launch-claims.ts` | delete | superseded |
| `test/unit/{pty-host-generations,pty-host-io,session-screens,launch-claims,conduit-mcp-runtime-ports,conduit-mcp-endpoint}.test.ts` | delete | covered by the server's ports |
| `test/unit/{pty-host-windows-pty,resolve-launch-spec,sanitize-child-env,launch-spec}.test.ts` | modify | import from the new homes |
| `test/unit/{conduit-mcp-host,conduit-mcp-shim,scrollback-store}.test.ts` | modify | retarget to `server/mcp/endpoint.ts`, `server/runtime/session-screens.ts` and W6's runtime fake |
| `test/unit/{server-client,hc-cli,hc-events,runtime-layout,runtime-gc,server-lifecycle,terminal-link,app-session-store,settings-mirror,terminal-host,server-events}.test.ts` | create | new |
| `test/e2e/*.e2e.mjs` (list in S3/S4) | modify | PTY-in-hc semantics |

## Scripts
1. A one-off `move-module.mjs <from> <to>`, kept in OS temp. It does a `git mv` and rewrites import specifiers across `electron/`, `server/`, `src/` and `test/unit/`. It replaces four hand moves (T1.1).

The e2e edits differ per scenario, so they're not scripted.

## Slices

### Slice 1: moves + client kit (the app is unchanged and still runs on node-pty)
**Check:** `npm run verify`, plus the new unit tests listed below green. `npm run e2e:remote -- session-bootstrap terminal-links paste` stays green; this is the no-behaviour-change proof.
**Parallel groups:** G1: T1.2 · G2: T1.3 · G3: T1.4 · G4: T1.5. Serial: T1.1 runs first (it edits `main.ts` imports and `server/**` imports).
**Claims:** `electron/main.ts` (T1.1 import lines only).
- **T1.1 Moves.** Move the four files to `src/` (script #1). Move the helpers out of `src/pty-host.ts` into `src/windows-pty-info.ts` and `src/launch-spec.ts`. `src/pty-host.ts` re-imports them for now, until S2 deletes it. Call sites: `electron/main.ts:249,284,311,158`; `server/domain/**` (W4) and `server/runtime/**` (W6) imports; `src/launch-spec.ts:4`; `test/unit/{agent-scope-tracker,launcher-host,role-brief-host,persistence-write-gates,launch-spec,resolve-launch-spec,sanitize-child-env,pty-host-windows-pty}.test.ts`. Test: the existing tests stay green unchanged in meaning.
- **T1.2 `server-client.ts`.** Fake server: `net.createServer` on a POSIX socket in tmpdir.
  - `'open resolves hello and sends generation'` — key assertion: the request's `params.generation === SERVER_PROTOCOL_GENERATION`.
  - `'call while closed rejects disconnected without writing'`.
  - `'notify while closed returns false and writes nothing'`.
  - `'-32000 maps data.kind'` — key assertion: `err.kind === 'server_stopping'`.
  - `'missed triggers events.subscribe and a second snapshot'`.
  - `'events with seq <= snapshot.seq are dropped'`.
  - `'hello timeout rejects timeout'` (fake timers).
- **T1.3 Lifecycle stack.** Covers `hc-cli.ts`, `hc-events.ts`, `runtime-layout.ts`, `runtime-gc.ts` and `server-lifecycle.ts`, using `src/hc-client/testing/fake-hc.ts`.
  - `'startSupervisor argv uses CORE_START_RUN_FLAGS, unique name, cwd coreCwd, env without HC_*'`.
  - `'start rule: live conduit-server-<h> → connect only, no run'`.
  - `'start rule: marker present → unavailable exhausted, no run'`.
  - `'role label alone does not count as live'` (a terminal labelled `conduit.role=server` under another name).
  - `'hc core unreachable → runs start (name_taken on run is treated as live)'`.
  - `'appNewer → server.restart{update}, waits finished of hello.supervisor.terminal, then start rule'`.
  - `'restart wait past SERVER_RESTART_EXIT_WAIT_MS → unavailable restart-wait-timeout'`.
  - `'appOlder → downgrade, no restart'`.
  - `'stopAllAndContinue → server.stopAll, wait finished, start rule'`.
  - `'finished of supervisor without marker → start rule, 4th within the hour → stopped'`.
  - `'retry deletes marker then applies start rule'`.
  - `'restartService kills by supervisorName then starts'`.
  - `'C2 close with live supervisor → reconnecting, reopen with backoff 500ms→5s'`.
  - `'hc run failure → spawnDetachedSupervisor'`.
  - GC tests: `'rename failure keeps dir'`, `'newest two kept, current always'`, `'shim dirs never touched'`.
  - Layout tests: packaged vs unpackaged paths.
- **T1.4 `terminal-link.ts`.**
  - `'first paint ends after PAINT_QUIET_MS quiet'`.
  - `'first paint capped at PAINT_MAX_MS'`.
  - `'attach is observe:true with history arg'`.
  - `'credit returned after data hand-off'`.
  - `'disconnected close is restartable; exited is not'`.
  - `'never calls write/resize/facts'` — key assertion: spy count 0.
- **T1.5 `app-session-store.ts`.** Port the repo-field cases of `test/unit/session-manager.test.ts` (`setRepos`/`pinRepo`/`setAutoRepo`/`mergeRepoGit`).
  - `'overlay wins over a snapshot carrying repo fields'`.
  - `'vanished session drops overlay'`.
  - `'diff flags homeChanged and cwdChanged'`.

### Slice 2: the cut-over (main.ts is a C2 client; node-pty deleted)
App state: when S2 ends, the app runs end to end on the unpackaged layout. Not working until S4:
- the `unavailable`/`downgrade`/`stopped` UI (states are logged; terminals show "starting")
- Retry launch / Discard
- the input-paused overlay (input is already dropped)
- "Quit and stop all agents"

Intermediate commits typecheck and pass their unit tests but are not run.

**Check:** `npm run verify` green. Then `npm run e2e:remote` with W8's harness teardown landed. These must pass: `session-bootstrap`, `paste`, `resize-history`, `terminal-links`, `terminal-input-box-links`, `terminal-late-font`, `terminal-exit-focus`, `attention`, `attention-signal-arm`, `attention-signal-quiet`, `timed-messages`, `conduit-mcp-control`, `conduit-mcp-notify`, `conduit-mcp-gate`, `conduit-mcp-policy`, `conduit-mcp-refusals`, `conduit-mcp-app-sessions`, `sidebar-projects`, `new-session-folders-start`, `multi-window`, `cwd`, `logging`, `scrollback-inrun`, `hc-client`. The MCP e2e are red today because of the gen-2 shim; they go green here. The S3 list is known red until S3.
**Parallel groups:** G5: T2.1a · G6: T2.1b · G7: T2.1c. Serial: T2.2–T2.9.
**Claims:** `electron/main.ts`, `src/protocol.ts`, `src/types.ts`, `webview/bridge.ts`, `package.json`.
- **T2.1a `settings-mirror.ts`** with tests (`'never strips server keys'`, `'uiOnly keeps current server keys'`).
- **T2.1b `terminal-host.ts`** with tests:
  - `'resize and facts are sent before sessions.start'` (order on the fake client).
  - `'spawned:false attaches with no prelude'`.
  - `'cold start writes term.show then prelude as term:data{replay} then attaches'`.
  - `'finished writes prelude, emits term:exit, attaches nothing'`.
  - `'refusal writes prelude only'`.
  - `'link CLOSE does not change state'`.
  - `'running→exited emits term:exit with cached code'`.
  - `'input dropped while client null'`.
  - `'relaunched live session with mounted pane re-attaches'`.
- **T2.1c `server-events.ts`** with tests:
  - `'sessions.opened{focus:false} applied before the session first appears in state'`.
  - `'timers.fired → timer:fired before timer:state'`.
  - `'ui.post owner route resolves owner window; raise focuses it'`.
  - `'attention.edge with osAttention off → no Notification'`.
- **T2.2 Lifecycle wiring** (rows `ready`, `settings:initial`, `updateSettings`, `updateServerSettings` new).
  - In `main.ts` after the single-instance lock: `collectRuntimeGarbage` → `createServerLifecycle(...).start()`. `serverArgs` is `['--e2e']` when `CONDUIT_E2E=1`.
  - On connect: `server.setLogging{logging, logLevel}`, `subscribe(router)`, `ui.presence`, then `term.resize`/`term.facts` per open pane.
  - Settings: `settings.json` is the app's alone. `settings:initial` is answered from it. `serverSettings.changed` mirrors via `mirrorServerKeys` and persists. `updateSettings` goes through `uiOnly`. `updateServerSettings` → `serverSettings.patch`; on failure, re-broadcast the mirror.
  - Delete the app's server-settings migration and seeding.
- **T2.3 Sessions** (rows `openRepo`, `rename`/`setSessionIcon`, `reorderSessions`, `session:addRoot/removeRoot/setHome/setProject`, `session:locateFolder` (split), `relaunch`, `session:restart` (split), `session:addDirsToAgent` (split), `session:dismissAgentScope`, `duplicate` (split, placed in the source window), `kill`).
  - Each becomes a C2 call. Results become today's reply messages with the same `requestId`.
  - `openRepo:result.droppedRoots: []` (see Decisions).
  - Delete `SessionManager`/`sessionOps`/`scopes`/`restartSeq`/`startRefusals`/`launchGenerations`, `sessions.json` persistence and `buildStartupModel` from the app.
  - The `state` broadcast comes from `AppSessionStore.list()` plus the stores from the snapshot and `data.changed`.
- **T2.4 Terminal** (rows `term:start` (split), `term:input`, `term:resize`, `term:facts` new, `term:dispose` (app, move-window swallow kept), `term:title` removed).
  - Route all of these through `terminal-host`.
  - Delete `PtyHost`, `ptyWriter`, `CwdScanner`/`cwdGate`, bell, inert and paste scans, `scrollbacks`, the `activity` sweep, `limitEpisodes`, `coldStartsInFlight`, `preSpawnSizes` and `pendingRelaunchMarker`. These are every W4/W6 internal-subscriber row.
  - cwd → `setAutoRepo(id, repoForPath(repos, cwd))` on the `cwdChanged` diff (ported from main.ts:1373).
- **T2.5 Folders and repos** (internal rows: `SessionFolderRuntime` app half, `suspect`; `repo:pin/unpin/context`, `repoScanner` → `store.setRepos`). The folder runtime is driven by `store.applyServer` diffs. `suspect` → `folders.suspect` per session and path. Port `test/unit/session-folder-runtime.test.ts` minus its health cases, which W4 owns.
- **T2.6 Stores** (rows `project:*`, `launchers:rescan`, `launcher:*`, `launch:preview`, `folder:probe`, `brief:probe`, `brief:agentPreview`, `timer:*`). These become C2 calls. Delete the app's `ProjectStore`, `LauncherHost`, `AgentRegistry` loading, `TimerScheduler` and `roleBriefs`. `powerMonitor` resume and unlock-screen → `system.resumed`.
- **T2.7 MCP and presence** (rows `mcp:*` → `mcp.fromRenderer{windowId, message}`, `mcpInstall:status/act` → `mcp.installStatus/installAct`, `visible` (split) → `ui.presence{windows}` on every visible, ready, focus or owner change, coalesced per tick).
  - Delete `mcpHost`, `mcpInstall`, the token store, `createMcpEndpoint`, `createMcpRuntimePorts` and `launchClaims`. This supersedes the w0b launch-claim residual.
  - Snapshot `pendingAsks` → re-post `mcp:ask` to the owners.
  - `onWindowReset`/`onSessionMoved` are now derived server-side from presence.
- **T2.8 Attention.** `attention.edge` → today's Notification builder, gated by `osAttention` + `shouldRaiseOsAttention`. `attention.flash` → `flashFrame` on the owner window. Delete the sweep at about main.ts:1826.
- **T2.9 Retire.**
  - Delete the five files and six tests listed in the file map. Retarget the three tests.
  - Remove `@lydell/node-pty` from `package.json`.
  - `pty:windowsPty` now imports from `src/windows-pty-info.ts`.
  - `before-quit` no longer disposes PTYs: it flushes app files, closes links and closes the client.
  - Renderer protocol (lead):
    - `src/protocol.ts`: add `{type:'term:facts'; sessionId; facts: DisplayFacts}` and `{type:'updateServerSettings'; patch: Partial<ServerSettings>}`; remove `term:title`.
    - `src/types.ts`: add `runtime?: SessionRuntime` to `Session`.
  - `webview/components/terminal-pane.tsx`: post `term:facts` (fg/bg/cursor from the theme, `cell` from xterm's render dimensions) immediately before `term:start` and on theme or font change; remove `onTitleChange`.
  - `webview/settings.tsx`: `update()` posts `serverPatchOf(patch)` as `updateServerSettings` immediately; UI keys stay on the debounced `updateSettings`.
  - `webview/bridge.ts`: accept both new messages.

### Slice 3: e2e alignment for PTY-in-hc (test files only; can run in parallel with S4)
**Check:** the full `npm run e2e:remote` is green except W8-owned new scenarios.
**Files:** existing `test/e2e/*.e2e.mjs` and helpers below. Not `harness.mjs` (W8), and not `quit-guard`/`dirty-quit*` (S4).
- **(A) Direct-launch scenarios that bypass `launchApp`/`shutdownApp` would leak a server, core and agents.** Switch them to `launchApp({userDataDir})` plus `shutdownApp`, or call W8's per-userData stop at the end: `background-resources`, `commit-detail-resize`, `durability`, `editor-tabs-persist`, `multi-folder-model`, `multi-window-restore`, `nested-repo-resources`, `recent-folders-prune`, `repo-tracker-fanout`, `resize-history`, `review-keymap-persist`, `scrollback-geometry`, `scrollback-inrun`, `scrollback-mode-neutralize`, `scrollback-restore`, `scrollback`, `session-restore-toggle`, `sidebar-dnd`, `terminal-late-font`, `timed-messages-concurrency`, `timed-messages`; helpers `coverage-capture.mjs`, `git-probe.mjs`.
- **(B) Relaunch on the same userData now finds sessions live, not `stale`.** Where the scenario's subject is cold restore or a stale relaunch, call W8's stop-all between launches; otherwise assert the live re-attach: `durability`, `multi-window-restore`, `session-restore-toggle` (D40: live sessions persist even with `restoreSessions:false`), `scrollback-restore`, `scrollback`, `scrollback-geometry`, `scrollback-mode-neutralize`, `conduit-mcp-restart`, `changes-multi-repo` (AC3), `mf-live-edits` (E5–E7), `multi-folder-model` (relaunch phases; direct `term:start` posts at :671/:903 stay valid, but the can't-start text now arrives via `term.show`).
- **(C) Spawn and refusal evidence moved from the app log to `<userData>/server.log`:** `mf-live-edits` (:626 reads `conduit-e2e-logs`), `logging` (level now also reaches the server via `server.setLogging`).
- **(D) MCP shim command/paths:** `conduit-mcp-helpers.mjs` `conduitCommand` changes from Electron `execPath` plus the resources shim to `runtime/shim/node.exe` plus `shim.cjs`. Also `conduit-mcp-install`, `conduit-mcp-install-banner`, `conduit-mcp-cursor-connect`, `conduit-mcp-policy-migrate` (the seed now migrates into `server-settings.json`; `settings.json` keeps the mirror), and `role-brief`.
- **(E) Exit status now comes only from `sessions.changed`, so the timing shifts:** `exit-closes-session`, `terminal-exit-focus`, `attention-signal-arm` (the transient `exited`), `conduit-mcp-control-terminal` (`statusOf` exited, then relaunch), `dirty-quit-windows` (:83 waits for `exited`; edited in S4).
- **(F) `droppedRoots`:** `multi-folder-model` (:329), `new-session-folders-start`/`-guard`.
- Comment-only references to `PtyHost.input` in `harness.mjs` (:387) and the `mode con` probe (:1026) still hold behaviourally (the server applies the size). They are flagged to W8, not edited.

### Slice 4: lifecycle UX, recovery and quit
**Check:** `npm run verify`. New unit tests: `test/unit/server-banner.test.tsx` (each `ServerUiState` renders its text and actions) and an extended `test/unit/quit-responder.test.ts` (`stopAgents` passes through). These e2e must pass: `quit-guard`, `dirty-quit`, `dirty-quit-saves`, `dirty-quit-windows`, `settings-quit-flush`. Then a manual runtime-QA pass:
- `hc kill conduit-server-<h>` → restart, with input paused shown and then resumed
- the fourth kill within an hour → "Conduit's background service stopped" with Retry
- a marker file → unavailable, and Retry deletes it
- an older app → downgrade, with Stop all agents and continue

**Claims:** `electron/main.ts`, `src/protocol.ts`, `webview/app.tsx`, `webview/bridge.ts`.

Renderer protocol (lead):
- **HostToWebview:** add `{type:'server:state'; state: ServerUiState}`, where `ServerUiState = ServerLifecycleState` minus `hello`, plus `runtime?: RuntimeHealth`. It is defined in `src/protocol.ts`, because C2 imports protocol and not the reverse.
- **WebviewToHost:** add `server:retry`, `server:restartService`, `server:stopAllAndContinue`, `session:retryLaunch{sessionId}` and `session:discardLaunch{sessionId}`. `quitDecision` gains `stopAgents?: boolean`.
- `confirmQuit.running` is unchanged in shape; the dialog text now says agents keep running.

UI changes:
- **`webview/components/server-banner.tsx`:** the unavailable banner (log path + Retry), the downgrade banner ("A newer Conduit is running its agents" + Stop all agents and continue), the stopped banner (reason + log path + Retry), and runtime `degraded`/`starting` notices.
- **Command palette in `app.tsx`:** "Restart Conduit's background service" and "Quit and stop all agents".
- **`terminal-pane.tsx`:** "Reconnecting — input paused" overlay while the state is not `connected`.
- **`center-pane.tsx`:** Retry launch and Discard when `session.runtime?.spawn === 'unconfirmed'`. A retry result goes through the same terminal-host start path.

Main-process changes:
- `quitDecision{stopAgents:true}` → `lifecycle.stopAll()` (bounded by `STOP_ALL_ANSWER_TIMEOUT_MS`), then quit.
- On a plain quit, agents keep running (F4).
- `server:retry`, `server:restartService` and `server:stopAllAndContinue` map to the lifecycle methods. The explicit restart is the only path that runs `hc kill`.

## Verification
- **Per task:** `npm run verify:quick` plus the task's tests, with the exit code captured directly.
- **Per slice:** `npm run verify`, then the slice's e2e list remote.
- **Merged tree:** full `npm run e2e:remote`, then the lead's runtime QA with real Claude and Codex sessions (phase 5).

S1 may merge on its own. S2 merges once S3 is green, or with S3's red list declared, at the lead's call. S4 merges after its check.

## Deviation rule
If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece becomes the work. Examples: a C2 result shape differs from the contract; W5 has no `createMcpEndpoint` to retarget the tests to; `hc run` lacks `--label`. Never a shim, second copy, special case, widened type or fallback routed around it. The report leads with the fix that keeps the locked decision, sent as a contract request to the lead where the contract is the problem.

## Decisions Needed
- **[high] Runtime prep and GC overlap with W9.** W9 owns `server/runtime-dir/**` ("the GC rename test" plus preparation); W7 owns "runtime GC under the lock". Default taken: W7 builds `electron/runtime-gc.ts` and calls it, and the packaged layout assumes W9 has prepared `runtime/<v>`. Until W9 lands, only the unpackaged layout (`CONDUIT_NODE_BINARY`/`CONDUIT_HC_BINARY`/`out/server`) runs.
- **[high] W8's harness teardown is needed before S2's e2e check.** A per-userData `server.stopAll` plus a supervisor kill is required, or every scenario leaks a server, core and agents. Default: S2's e2e check waits for it, and S3 uses W8's helper. The `test/e2e/harness/**` path in the program is stale.
- **[high] Supervisor cwd (D23).** `hc run` from `coreStartCwd` makes the supervisor's cwd the hc dir, not `runtime/<v>`, so GC could rename `runtime/<v>` from under it (mapped images don't block, M21). Default: pass `hc run --cwd runtime/<v>` if 0.1.16 has it. Otherwise ask W3 to `process.chdir(__dirname)` in `server/supervise.ts`.
- **[high] Ownership of existing e2e scenario files.** These are unowned in the program. Default: W7 edits them (S3/S4) and W8 owns only `harness.mjs` plus new scenarios.
- **[high] W4/W5/W6 must be merged and `compose.ts` wired before S2.** W3b (walking skeleton) never ran. Default: S2's e2e set stands in for it.
- **[normal] `term:exit` needs an exit code that `SessionView` lacks.** Default: cache the observer CLOSE `exit_code` and emit only on the `sessions.changed` transition; with no cached code, no exit line. Request: `exitCode?: number | null` on `SessionView`.
- **[normal] `sessions.create` drops `droppedRoots`.** Default: `openRepo:result.droppedRoots: []`, so the toast for dropped roots is lost. Request: an optional `droppedRoots` in the C2 result.
- **[normal] Re-attach after an hc core reconnect (F10) uses `history: 0`** so the scrollback isn't duplicated in the same xterm.
- **[normal] `src/mcp-launch.ts` keeps `env: {ELECTRON_RUN_AS_NODE:'1'}`.** It's harmless under `node.exe`, and changing it would alter the CLI install entries. Change it only on W5's request.
- **[normal] `sanitizeChildEnv` moves to `src/launch-spec.ts`.** Confirm W6's spawn env applies it (`VSCODE_*`/`CURSOR_*`/`TERM_PROGRAM` strip, M10), or the strip silently regresses.
- **[normal] E2e knobs go to the server as argv.** `--e2e` is chosen; `CONDUIT_E2E_DETECT_GRACE_MS` must also become argv in W5. The arg names need confirming with the W4/W5 owners.
- **[normal] Where "Quit and stop all agents" lives.** Default: a button in the quit dialog (`quitDecision.stopAgents`) plus a command-palette entry (no native menu: `Menu.setApplicationMenu(null)`).
- **[normal] Logs and diagnostics.** Default: Reveal logs and Copy diagnostics include `<userData>/server.log`.
- **[normal] S2 is one atomic cut-over** because of the two-writer hazard on server files. Its intermediate commits are not runnable.

```
#1 Coverage: ok — the 27 W7-row clauses and 8 blocker items each map to S1–S4 (start rule/F6/F9/GC → S1+S2+S4; overlay/folders → S1+S2; UX states, Retry/Discard, quit-stop → S4; deletions/moves → S1+S2)
#2 Placeholder scan: fixed: named the refusal/timeout kinds and the backoff (500 ms→5 s); exit-code and droppedRoots gaps moved to Decisions with defaults
#3 Signature consistency: fixed: terminal-host takes `client: () => ServerClient | null` throughout
#4 Placement: ok — every new file is in the file map under electron/ or src/, tests under test/unit/
#5 Caller scan: fixed: S1 kit modules get their first caller in S2 within the same lane (contract-pinned signatures; S1 alone is mergeable as inert code — flagged to the lead); runtime-gc is called in T2.2
#6 Producer/consumer: ok — server sides pinned by C2, owned by W4–W6, verified by the S2 e2e set
#7 Handoff arithmetic: ok — 4 slices; groups G1–G7 plus S3∥S4 = 9; 6 claims; 1 script
```
