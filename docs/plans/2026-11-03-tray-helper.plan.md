# Background tray helper: implementation plan

**Status:** active, Revision 0 (2026-11-03).
**Spec:** `docs/specs/archive/2026-11-03-tray-helper.md` rev 2 (L1–L9 confirmed by the user).
**Tier:** FULL. S0 measurements, lead contracts C1, seven file-disjoint lanes, lead integration, then the e2e lane. Branch `feat/tray-helper` (base `main` 05402956 + spec c7b5e84d).

## Goal
A Windows notification-area helper (`conduit-tray.exe`, Rust) owned by the background-service supervisor shows running / needs-you counts and offers Open Conduit and Stop all agents, independent of the app's lifetime; plus the Jump List fallback, quit copy, the F3a budget fix, CI/packaging and an e2e seam.

## Architecture
The supervisor is the only relay. Server → supervisor: Node IPC on stdio slot 3 (C8a). Supervisor → helper: JSON lines on inherited stdio pipes (C8b). `trayView()` (pure TS) makes every display decision; Rust renders and owns only menu/dialog state, the stop latch and the NIM_ADD retry. `supervise()` becomes interruptible via `stopSignal` (§7a). The helper runs from the stable `runtime/tray/conduit-tray.exe`, swapped by rename from `runtime/<v>/tray/`.

## Data flow
```
server transport.emit tee (sessions.changed | runtime.changed | server.stopping)
 -> trayCounts() -> changed? -> process.send({counts}) (≤ 250 ms)
supervisor hooks.phase/childExit + IPC ready/counts | hc poll (15 s, no ready server)
 -> relay {phase, source} -> trayView() -> changed? -> helper stdin {view}
helper stdout {stopAll} -> relay -> serving: IPC {stopAll,id} -> shell.stopAll() -> stopAllResult -> afterReply exit doneCoreIdle
                                  -> no ready server: stopSignal.abort() -> supervise() wait point -> stopSessions() -> SuperviseExit trayStop
supervise() returns -> relay.finish(exit) -> {stopResult}? -> {exit} -> close stdin -> ≤ 2 s -> process exit 0
app: server.stopping -> lifecycle.noteStopping -> vanished() skips the budget entry (F3a)
```

## Settled decisions
Spec D1–D6, L1–L9 and §7a are authoritative. Plan-level refinements (each is a reading of the code, not a scope change; reject any and the lead amends the contract before C1):
- **P1** Unpackaged source: `CONDUIT_TRAY_BINARY` ?? `<appPath>/build/vendor/tray/conduit-tray.exe` if present. Spec §4 names `native/tray/target/release/…`, but `--target x86_64-pc-windows-msvc` builds into `target/x86_64-pc-windows-msvc/release/`; `tray:build` copies to `build/vendor/tray/` anyway, which is what packaging reads.
- **P2** CI uses the runner's preinstalled rustup + `native/tray/rust-toolchain.toml` + `actions/cache@v4` (already used in e2e.yml), not `dtolnay/rust-toolchain`/`Swatinem/rust-cache`. Fewer third-party actions (verify.yml's gitleaks rationale). Toolchain pin `1.98.1` = the pin e2e.yml:245 already installs for rust-lsp; bump both together.
- **P3** `SuperviseExit` trayStop carries `ok`: `{reason:'trayStop'; ok:true; killed} | {reason:'trayStop'; ok:false; error}` so §7a's "a stopSessions failure is reported as a failed stopResult" has a typed path.
- **P4** After a failed tray stop, `runCli` waits for the helper's own exit up to 60 s (not 2 s), so the error TaskDialog isn't killed under the user; the helper exits after the dialog closes once it has `exit`.
- **P5** Notices: hand-maintained entries in `THIRD_PARTY_NOTICES.txt` + a unit test that every non-root `[[package]]` in `native/tray/Cargo.lock` that ships (not proc-macro/build-only) is named there. Replaces `cargo about` (another tool on every runner).
- **P6** `build.rs` embeds icons + VERSIONINFO through the `embed-resource` build-dependency (the "Other system tray icons" settings list shows FileDescription). Embedding runs only when host and target are Windows; ubuntu only checks/tests.
- **P7** Clippy runs twice: host target and `--target x86_64-pc-windows-msvc` (check-only, no linker), so `cfg(windows)` code is linted on ubuntu. Measured in B-1 (lane G7).
- **P8** IPC `stopAll` while the server is already stopping (`lifecycle.stop` → `late`) answers `{ok:false, reason:'The background service is already stopping.'}`; the view already disables Stop all in `stopping`.

## Source grounding
- `server/supervise.ts:142` `supervise(): Promise<number>`, linear `for(;;)`; `:183` backoff sleep, `:109-140` `coolDown`, `:198` `stdio:'inherit'`, `:216` `childArgs = [main.js, ...args]` (flags not stripped today).
- `server/hc-cli.ts:120-153` `directStopAll` = list+kill sessions, kill supervisor (`:138-144`), stop core. `directStopSessions` is the same minus `:138-144`.
- `server/main.ts:58` `listen` false → `{code:0}` before compose; `:116-117` "server listening" + `lifecycle.start()` = the `ready` point. `server/compose.ts:146-167` C2 stop route returns `{killed}` + `afterReply`; the IPC route must reuse it, not copy it.
- `server/services.ts:118` sessions go out via `o.emit` = `transport.emit`; compose emits `runtime.changed`/`server.stopping` through the same `transport.emit` (`compose.ts:95`). One tee on the transport sees all three.
- `src/quit-guard.ts:168` `runningSessions(sessions: Session[])` — server holds `SessionView`; C1 generalises it to `<T extends Pick<Session,'status'>>`.
- `electron/runtime-layout.ts:44-60` packaged/unpackaged layouts; `electron/hc-cli.ts:27-32` `supervisorArgs`; `server/runtime-dir/prepare.ts:59` app dir sources.
- `electron/main.ts:2437-2446` packaged always passes `--shim-dir` (seam gate); `:1140` lock, `:4762` second-instance. `webview/app.tsx:705` is the only `quitConfirmCopy` caller.
- `electron/server-lifecycle.ts:350-371` `vanished()`; `:335,341,404` its three callers; `electron/server-events.ts:179` logs `server.stopping` only.
- `build/installer.nsh:126-130` picks a stop dir only if it holds `node.exe` + `server\main.js`, so `runtime\tray` is never chosen; no installer change (spec §11).
- Workflows: **no job runs cargo today.** `e2e.yml:242-248` installs rustup toolchain 1.98.1 (rust-analyzer only) on matching shards, which proves rustup is preinstalled on windows-latest. `verify.yml` (ubuntu) has no Rust step; `release.yml` has none. `test/e2e/ci-affected.mjs:211,220`: a new or non-code changed path under `native/` selects the full suite (acceptable).
- This machine: `cargo`/`rustup` not on PATH yet (rustup stable + MSVC being installed). S0 probes and G1 wait for it.

## Global constraints
Per lane: `npm run verify:quick` + the lane's named vitest files (+ `cargo …` for G1). Integration: `npm run verify` (now includes `tray:check`), `npm run tray:build`, then `npm run e2e:remote -- --full`. Local e2e: one scenario by exact name, `launchElectron`/`finishScenario` only, hidden windows, serial. CLAUDE.md: WHY-only comments, no swallowed errors/`as any`, git via `runGitBin`, no `process.platform` reliance in units (inject platform). Ubuntu units use injected fs/spawn. Scratch only under `%TEMP%\claude-scratch\`, deleted after. No lane edits another owner's path.

## Out of scope
Spec §16 v1/Later/Out-of-scope; macOS (no spawn unless `win32`); C2 auth/collab bootstrap; installer changes.

## S0: Windows measurements (lead, before C1; nothing committed)
Probe kit in `%TEMP%\claude-scratch\tray-probe\`: a Rust bin `tray-probe` (deps `windows-sys` with `Win32_Foundation`, `Win32_UI_Shell`, `Win32_UI_WindowsAndMessaging`, `Win32_System_Threading`, `Win32_System_JobObjects`, `Win32_System_Environment`, `Win32_Security`, `Win32_Storage_FileSystem`, `Win32_System_LibraryLoader`; release profile = spec §4) plus `drive.mjs` (Node, spawns like `spawnServerChild`/F1). Modes, each printing one JSON line per event to stdout:
`icon [--guid G]` hidden top-level window, NIM_ADD + NIM_SETVERSION(4), logs `{added,ok,err}`, `Shell_NotifyIconGetRect` result, re-adds on `TaskbarCreated` (`{readd}`), exits on stdin EOF after NIM_DELETE. · `job` `IsProcessInJob` + `JobObjectExtendedLimitInformation.LimitFlags` (KILL_ON_JOB_CLOSE / BREAKAWAY_OK / SILENT_BREAKAWAY_OK). · `launch <exe> [--breakaway|--shellexec]` with `CreateEnvironmentBlock`, prints `{pid,err}`. · `pipename` prints `GetFileInformationByHandleEx(FileNameInfo)` of stdin/stdout. · `findhandle <name>` walks handle values 4..65536 step 4, `GetFileType==PIPE` + name match, prints matches. · `hold` sleeps until EOF.

| T | Probe (exact) | Pass observation | Selects |
|---|---|---|---|
| T1 | Start the dev hc core (`hc server start`), `terminal.run` `node drive.mjs t1` (as `electron/hc-cli.ts` startSupervisor does); drive spawns `tray-probe icon` `detached:false, windowsHide, stdio pipe` | `{added:true}` and `GetRect` S_OK; icon visible (lead eyeballs once) | Pass: design holds. Fail: STOP, escalate (helper can't live under hc; no fallback in scope) |
| T2 | Under hc as T1: drive spawns `tray-probe job` then `tray-probe launch notepad.exe`; drive `process.exit()`s; after 2 s `Get-Process -Id <notepad pid>` | notepad alive | Pass: plain `CreateProcessW(CREATE_UNICODE_ENVIRONMENT)`. Fail: repeat `--breakaway` → alive ⇒ add `CREATE_BREAKAWAY_FROM_JOB`; `err=5` ⇒ repeat `--shellexec` → alive ⇒ ShellExecuteExW fallback; all die ⇒ STOP (an Open-Conduit app would die with the service) |
| T3 | drive spawns `tray-probe pipename` (stdio pipe) and a Node child with `['inherit','inherit','inherit','ipc']` that spawns `tray-probe findhandle <ipc pipe name>` with `stdio:'inherit'` (as startCore); PowerShell `[IO.File]::Open('\\.\pipe\<name>')` on the helper's stdin name; child prints `process.env.NODE_CHANNEL_FD` | Open fails (231 PIPE_BUSY or 5); `findhandle` finds no match; `NODE_CHANNEL_FD` undefined in the child's `process.env` | Pass: §6 holds. Open succeeds: STOP (capability model broken). Handle found: accepted residual (only `stopAll`), release note line |
| T4 | `cargo build --release` of `tray-probe` (icon mode is ~ the helper's surface); `(Get-Item).Length`; run `icon`, after 5 s `Get-Process -Id` `WorkingSet64`, `PrivateMemorySize64` | ≤ 2 MB, WS ≤ 6 MB | Fail: drop serde_json for a hand parser before G1 starts; budget re-asserted on the real exe by `tray:build` |
| T5 | Copy probe to `%TEMP%\claude-scratch\swap\conduit-tray.exe`, run `icon` from it with cwd = that dir; `Rename-Item` → `.old`; copy a rebuilt probe to `.new`; rename `.new` → `conduit-tray.exe`; `Remove-Item .old` (running); end the probe; `Remove-Item .old` | both renames succeed while running; first delete fails, second succeeds | Pass: §4 swap. Fail: STOP, re-open L6 with the user (versioned path) |
| T6 | With `icon` running (user present), restart Explorer by its PID (`Stop-Process -Id (Get-Process explorer).Id`; it relaunches) | `{readd}` with ok within 10 s; icon back | Fail: add a 2 s re-add poll on `Shell_NotifyIconGetRect` failure in `model` |
| T7 | Plain (no hc) drive spawns `icon`; `Stop-Process -Id <drive> -Force`; then the hc case: `terminal.kill` the drive terminal | helper pid gone ≤ 1 s in both | Fail: helper also exits on stdin EOF (already designed); ghost icon accepted; AC6 test relies on EOF |
| T8 | Static now: confirm `installer.nsh:126-130` skips a dir without `node.exe`. Real pass moves to S9 (packaged build in Windows Sandbox) | `runtime\tray` can't be the stop dir | Fail: add `tray` to the NSIS skip list (G7) |
| T9 | Run `icon` from the T5 path; user enables it in Settings › Personalization › Taskbar › Other system tray icons; record `HKCU\Control Panel\NotifyIconSettings\*` key with that `ExecutablePath` (`IsPromoted=1`); quit; swap in a rebuilt probe (different bytes + VERSIONINFO); rerun | same key reused, `IsPromoted` still 1, icon on the taskbar | Fail: rerun with `--guid` (fixed GUID, same path); pass ⇒ add `guidItem` to the contract (spec §Decisions Needed fallback); fail ⇒ ship, release-note it |
| T10 | `node -e` print `package.json` `build.mac` and `.github/workflows/build-mac.yml` resource steps | no `runtime/` resources for mac | Fail: add `process.platform==='win32'` gate (already planned) and stop; mac stays out |

S0 output: a results table pasted into `docs/runs/2026-11-03-tray-helper/s0.md` (lead) and the selected F4 flag set + T6/T9 branches fixed into C1. Delete the probe kit.

## C1: Contracts (lead commits before any lane starts)
`src/contracts/tray-protocol.ts` — spec §5 verbatim, plus:
```ts
export const TRAY_LIMITS = {
  maxLineBytes: 65_536, tooltipUnits: 127, countsCoalesceMs: 250, hcPollMs: 15_000,
  spawningWaitMs: 10_000, stopAnswerMs: 20_000, exitGraceMs: 2_000, failedStopExitGraceMs: 60_000,
  helperRestartMs: [1_000, 5_000, 30_000], helperGiveUp: { crashes: 3, windowMs: 600_000 },
  nimAddRetryMs: 2_000, nimAddBudgetMs: 60_000, logCapBytes: 1_048_576, seamPollMs: 250,
} as const;
export const SUPERVISOR_TRAY_FLAGS = ['--tray', '--app-exe', '--app-arg', '--app-cwd'] as const; // each takes a value
export const HELPER_ENV_KEYS = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] as const;
export interface TrayViewInput { phase: ServicePhase; source: TraySource; profileLabel: string | null }
```
`server/tray/contracts.ts` — supervisor-internal seams:
```ts
export type SuperviseExit = { reason: 'done' | 'doneCoreIdle' }
  | { reason: 'trayStop'; ok: true; killed: number } | { reason: 'trayStop'; ok: false; error: string };
export interface SuperviseHooks { phase(p: ServicePhase): void; childExit(code: number | null): void }
// supervise.ts SuperviseOptions gains: stopSignal?: AbortSignal; stopSessions?: () => Promise<number>;
//   hooks?: SuperviseHooks; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
export interface ServerChannel {                 // the server child's IPC, as the relay sees it
  send(m: SupervisorToServer): void;
  onMessage(cb: (m: ServerToSupervisor) => void): () => void;
  closed: Promise<void>;
}
export interface TrayArgs { source: string; app: AppLaunch | null }
export interface TrayLog { write(level: 'info' | 'warn' | 'error', who: 'helper' | 'supervisor', message: string): void }
export interface HelperHandle { send(m: SupervisorToHelper): void; exited: Promise<number | null>; pid: number }
export interface HelperLauncher {
  start(onMessage: (m: HelperToSupervisor) => void): Promise<HelperHandle | null>; // null = no binary / gave up
}
export interface TraySeam { mirror(dir: 'in' | 'out', m: object): void; injected(cb: (m: HelperToSupervisor) => void): () => void }
export interface TrayRelay {
  hooks: SuperviseHooks; stopSignal: AbortSignal;
  attachServer(ch: ServerChannel): void;     // per spawned server child
  finish(exit: SuperviseExit): Promise<void>; // stopResult if a tray stop was pending, then exit + grace
}
export interface TrayRelayDeps {
  tray: TrayArgs; launcher: HelperLauncher; view(i: TrayViewInput): TrayView;
  pollRunning(): Promise<number | null>; log: TrayLog; seam: TraySeam | null;
  profileLabel: string | null; now(): number; setTimer(ms: number, cb: () => void): () => void;
}
```
`src/tray-counts.ts` (lead, 3 lines): `trayCounts(sessions: readonly Pick<Session,'status'|…attention fields>[], health: RuntimeHealth['state'], stopping: TrayCounts['stopping']): TrayCounts` over `runningSessions`/`attentionSessions`; `src/quit-guard.ts`: `runningSessions` generic; `QuitConfirmCopyInput.trayHint: boolean` + §10 copy. Tests `test/unit/tray-counts.test.ts`, `test/unit/quit-guard.test.ts` (trayHint on quit/update, unchanged windowClose/quitAndStop).
`test/fixtures/tray-protocol/*.json`: `{ "dir": "toHelper"|"fromHelper", "valid": bool, "line": "<exact JSON line>" }` — `init`, `init-no-app`, `view-running`, `view-needs-you`, `view-hidden`, `stop-result-ok`, `stop-result-fail`, `exit`, `hello`, `shown`, `hidden`, `stop-all`, `opened`, `open-failed`, `log`, `unknown-type` (valid, ignored), `bad-version` (invalid), `oversize` (generated in-test, not a file).
**Check:** `npm run test:unit -- test/unit/tray-counts.test.ts test/unit/quit-guard.test.ts` + `npm run verify:quick`.

## File map / ownership
Test files named with a module share its owner. New paths must be assigned by the lead before an edit.

| Owner | Paths |
|---|---|
| Lead C1 | `src/contracts/tray-protocol.ts`, `server/tray/contracts.ts`, `src/tray-counts.ts`, `src/quit-guard.ts`, `test/fixtures/tray-protocol/**`, `test/unit/tray-counts.test.ts`, `test/unit/quit-guard.test.ts` |
| G1 rust | `native/tray/**` (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `build.rs`, `res/conduit-tray.rc`, `res/*.ico`, `src/main.rs`, `src/protocol.rs`, `src/framing.rs`, `src/model.rs`, `src/win/{mod,icon,menu,dialog}.rs`, `src/launch.rs`, `tests/fixtures.rs`) |
| G2 view | `src/tray-view.ts`, `src/tray-strings.ts`, `test/unit/tray-view.test.ts`, `test/unit/tray-strings.test.ts` |
| G3 supervise | `server/supervise.ts` (until S8 handoff), `server/hc-cli.ts`, `test/unit/supervise-abort.test.ts`, `test/unit/server-shell-supervisor.test.ts`, `test/unit/hc-cli.test.ts`, `test/unit/electron-server-start.test.ts` (only if the return-type change breaks it) |
| G4 relay | `server/tray/{relay,helper-process,install,framing,hc-poll,tray-log,seam,args}.ts`, `test/unit/tray-relay.test.ts`, `test/unit/tray-helper-process.test.ts`, `test/unit/tray-install.test.ts`, `test/unit/tray-protocol-fixtures.test.ts`, `test/unit/tray-hc-poll.test.ts`, `test/unit/tray-log.test.ts`, `test/unit/tray-seam.test.ts`, `test/unit/tray-args.test.ts` |
| G5 server IPC | `server/tray-channel.ts`, `server/main.ts`, `server/compose.ts`, `server/services.ts` (read accessor only, if missing), `test/unit/server-tray-channel.test.ts`, `test/unit/server-compose-stop-all.test.ts` |
| G6 app | `electron/main.ts` (until S8), `electron/jump-list.ts`, `electron/hc-cli.ts`, `electron/runtime-layout.ts`, `electron/server-lifecycle.ts`, `electron/server-events.ts`, `server/runtime-dir/prepare.ts`, `server/lifecycle/stop-all.ts`, `test/unit/jump-list.test.ts`, `test/unit/runtime-layout.test.ts`, `test/unit/runtime-dir-prepare.test.ts`, `test/unit/server-lifecycle.test.ts`, `test/unit/server-shell-stop-all.test.ts` |
| G7 build | `package.json`, `tools/check-rust.mjs`, `tools/tray-build.mjs`, `tools/tray-check.mjs`, `tools/verify-quick.mjs`, `.github/workflows/{verify,release,e2e}.yml`, `.gitignore` (`native/tray/target/`), `THIRD_PARTY_NOTICES.txt`, `test/unit/check-rust.test.ts`, `test/unit/tray-packaging.test.ts`, `test/unit/tray-notices.test.ts` |
| G8 e2e | `test/e2e/tray-*.e2e.mjs`, `test/e2e/tray-helpers.mjs` (starts after S8) |
| Lead S8 | `server/supervise.ts` `runCli` + `spawnServerChild` call site (handoff from G3), `electron/main.ts` tray args/trayHint facts (handoff from G6), `webview/app.tsx:705` trayHint, `CHANGELOG.md`, `docs/specs/INDEX.md`, `docs/runs/2026-11-03-tray-helper/**` |

## Slices
### S1 (G1 rust, after C1) — `native/tray/`
- `protocol.rs`: serde enums mirroring C8b with `#[serde(tag="type")]`; unknown `type` → `Incoming::Unknown(String)`; `v != 1` → `Err(Protocol)`. `framing.rs`: `LineReader` (≤ 64 KiB, error past it). `model.rs`: `Model::new() -> Model`; `fn on_supervisor(&mut self, m: Incoming) -> Vec<Effect>`; `fn on_user(&mut self, e: UserEvent /*MenuOpen|MenuPick(Open|StopAll)|Confirm(bool)|IconSelect|ErrorClosed*/) -> Vec<Effect>`; `fn on_shell(&mut self, e: ShellEvent /*AddResult(bool)|TaskbarCreated|RetryTick*/, now_ms: u64) -> Vec<Effect>`; `Effect = Show(TrayView)|Hide|Send(Outgoing)|OpenConfirm(Confirm)|ShowError{title,body}|Launch(AppLaunch)|ScheduleRetry(u32)|Exit(i32)`; `truncate_utf16(&str, 127) -> String` on char boundary.
- `win/`: hidden top-level window (not `HWND_MESSAGE`), `Shell_NotifyIconW` + `NOTIFYICON_VERSION_4`, `TrackPopupMenuEx` (label = `MFS_DISABLED`, `isDefault` = `MFS_DEFAULT`), `TaskDialogIndirect` (Cancel default, foreground), `SystemUsesLightTheme` icon pick, stdin reader thread → `PostMessageW`. `launch.rs`: `CreateEnvironmentBlock` + flags fixed by T2. `main.rs`: `#![windows_subsystem="windows"]`; non-windows `main` exits `protocol` (bin exists only for `cargo test` on ubuntu).
- Red-first `cargo test` (`model.rs` `#[cfg(test)]` + `tests/fixtures.rs`): every fixture parses/rejects as labelled; oversize line rejected; `v:2` → `Exit(11)`; latch: `StopAll` pick → `OpenConfirm`, `Confirm(false)` → nothing, `Confirm(true)` → one `Send(StopAll)`, second confirm ignored until `stopResult`, `stopResult{ok:false}` → `ShowError` and unlatch; tooltip 127-unit truncation incl. a surrogate pair at the boundary; `exit` → `Hide`, `Send(Hidden)`, `Exit(0)`; `exit` during an open error dialog defers `Exit` until `ErrorClosed` (P4); `TaskbarCreated` while visible → re-add; `AddResult(false)` retries every 2 s, after 60 s `Exit(10)`; `view{visible:false}` → `Hide` once (no duplicate NIM_DELETE); `IconSelect` with `app:null` → nothing.
- **Check:** `cargo fmt --check --manifest-path native/tray/Cargo.toml`, `cargo clippy --locked --all-targets --manifest-path native/tray/Cargo.toml -- -D warnings`, same with `--target x86_64-pc-windows-msvc`, `cargo test --locked --manifest-path native/tray/Cargo.toml`, `cargo build --release --locked --target x86_64-pc-windows-msvc` ≤ 2 MB.

### S2 (G2 view, after C1) — `trayView()`
- `export function trayView(i: TrayViewInput): TrayView`; `export function profileLabelOf(userData: string, appData: string, sep: '/' | '\\'): string | null` (null for `<appData>/Conduit`). All copy in `tray-strings.ts` (plurals via a `plural(n, one, other)`), reusing `attentionChipLabel` for the needs-you clause. Doc comment notes L7 (snooze ignored) as a pointer to spec §8.
- Red-first `test/unit/tray-view.test.ts`: every §8 row (serving 0 hidden; running only; needs-you badge; degraded/starting/unavailable with running ≥ 1 and = 0; spawning/restarting/exhausted with hc ≥ 1 incl. `retryAt` HH:MM, with hc 0 and `none`; stopping visible-before vs not); menu order; Stop all disabled while stopping; `open` is the only `isDefault`; confirm body with/without needs-you clause; tooltip ≤ 127; `profileLabel` null vs set first label. `tray-strings.test.ts`: singular/plural.
- **Check:** `npm run test:unit -- test/unit/tray-view.test.ts test/unit/tray-strings.test.ts`.

### S3 (G3 supervise, after C1) — §7a
- `supervise(o): Promise<SuperviseExit>`; `clock.sleep(ms, signal)` resolves early on abort; `coolDown` takes the signal in the poll loop and write-failure sleep; abort checked at loop top and at W3; stop routine = `stopSessions()` → core stop if `!hasOtherLiveTerminals()` → `{trayStop, ok, killed}`. `hooks.phase('spawning')` before `spawnChild`, `'restarting'` before backoff, `{exhausted, retryAt}` before `coolDown`; `hooks.childExit(code)` after each child exit. `spawnServerChild(…, onSpawn?: (child: ChildProcess) => void)` with `stdio:['inherit','inherit','inherit','ipc']`. `directStopSessions(hc, names): Promise<number>` extracted; `directStopAll` = it + `:138-144` + core stop (behaviour unchanged). `serverChildEnv` deletes `NODE_CHANNEL_FD`/`NODE_CHANNEL_SERIALIZATION_MODE`.
- Red-first `test/unit/supervise-abort.test.ts` (fake clock/marker/core/spawnChild): W1 not aborted while serving; W2 signal clear → no stop; W3 aborted after crash → no respawn, stop routine once, core stop once; W3 `done`/`doneCoreIdle` with a late abort → returns as today, `stopSessions` never called; W4 backoff resolves early; W5 marker removed only when `written`; W5 with `newer` kept; W6 nothing removed; `stopSessions` rejects → `{ok:false}`, logged, returns; hooks order. `hc-cli.test.ts`: `directStopSessions` never kills the supervisor; `directStopAll` unchanged; `serverChildEnv` has no `NODE_CHANNEL_*`. Existing `server-shell-supervisor.test.ts` asserts the new return shape.
- **Check:** `npm run test:unit -- test/unit/supervise-abort.test.ts test/unit/server-shell-supervisor.test.ts test/unit/hc-cli.test.ts`.

### S4 (G4 relay, after C1) — `server/tray/`
- `args.ts`: `splitSupervisorArgs(args): { tray: TrayArgs | null; rest: string[] }` (strips all four flags with values); `seamEnabled(args) = args.includes('--e2e') && !args.includes('--shim-dir')` (checked on `rest`). `install.ts`: `installTray({source, stableDir, fs, sha256, tag}): Promise<{exe: string; swapped: boolean; note?: string}>` — spec §4 steps 1–5, fallback order installed → source. `helper-process.ts`: `createHelperLauncher({install, spawn, env, cwd, log, now, setTimer}): HelperLauncher` — `helperEnv(env)` = `HELPER_ENV_KEYS` only; `stdio:['pipe','pipe','pipe']`, `windowsHide`, `detached:false`, cwd stable dir; stderr lines → `TrayLog`; restart 1/5/30 s except exit 0/10/11; give up after 3 in 10 min. `framing.ts`: `LineDecoder`, `parseHelperLine(line): HelperToSupervisor | {type:'unknown'} | Error`. `hc-poll.ts`: `pollRunning(connect): Promise<number | null>` (labels as `hc-cli.ts:127-129`, failure → null). `tray-log.ts`: `createTrayLog(path, fs)`, 1 MB cap, one rotation `tray.log.1`. `seam.ts`: mirror to `<userData>/tray-seam.jsonl`, inject from `tray-seam-in.jsonl` (250 ms poll, consumed offsets). `relay.ts`: `createTrayRelay(deps): TrayRelay` — D3 start on first IPC `ready` or first crash `childExit` (never on 0/`done`/`doneCoreIdle`); phase/source state; `view` sent only on change; hc poll only without a ready server, last good reading kept; F3 routing (serving → IPC `{stopAll,id}` with 20 s timeout / channel close = failure; spawning → wait ≤ 10 s for ready; else abort `stopSignal`); seam `stopAll` skips the confirm; every handler wrapped so nothing throws into `supervise()` (errors → `TrayLog`).
- Red-first: `tray-args` (incl. `--app-arg --e2e` stripped and `seamEnabled` false with `--shim-dir`); `tray-install` (equal hash no-op; swap with target "in use" fake; rename failure → installed; no installed → source; stale `.old`/`.new` sweep, busy one kept); `tray-helper-process` (env allowlist, no `HC_*`/MCP/`CONDUIT_BOOTSTRAP_FILE`; restart budget; exit 10/11 not restarted; oversize line → kill + protocol log); `tray-protocol-fixtures` (every fixture through `parseHelperLine`/TS types); `tray-relay` (D3 triggers incl. crash-before-ready = AC13; never on `done`; F3 each phase; stop latch is Rust's, relay sends one IPC stop per `stopAll`; IPC timeout → `stopResult ok:false`; `finish(trayStop ok)` → `stopResult ok` then `exit`; `finish(done)` → `exit` only; view dedupe; a throwing launcher is logged); `tray-hc-poll`, `tray-log` (rotation at cap), `tray-seam` (mirror both directions, inject once).
- **Check:** `npm run test:unit -- test/unit/tray-*.test.ts`.

### S5 (G5 server IPC, after C1)
- `server/tray-channel.ts`: `startTrayChannel({ proc: Pick<NodeJS.Process,'send'|'on'|'off'|'connected'>, tap: (cb) => () => void, initial(): TrayCounts, stopAll(): Promise<StopOutcome>, log }): { ready(): void; dispose(): void }` — no-op without `proc.send`; counts coalesced 250 ms, sent only on change. `compose.ts`: extract `shell.stopAll(): Promise<{kind:'ok';killed;afterReply}|{kind:'late'}|{kind:'failed';error}>` used by both the C2 route and the channel (one transition). `main.ts`: wrap `transport.emit` with the tap before `createServerServices`/`compose`; `channel.ready()` after `lifecycle.start()` (never on the `listen`-false path); run `afterReply` after `stopAllResult` is flushed (`process.send` callback).
- Red-first `server-tray-channel.test.ts`: no channel → nothing sent; `ready` only after start; counts on sessions/runtime/stopping change, not on unchanged; coalescing; `stopAll` ok/late (P8)/failed replies with the id; `afterReply` after send callback. `server-compose-stop-all.test.ts`: C2 `server.stopAll` result unchanged after extraction.
- **Check:** `npm run test:unit -- test/unit/server-tray-channel.test.ts test/unit/server-compose-stop-all.test.ts` + existing `server-compose*` tests.

### S6 (G6 app, after C1)
- `RuntimeLayout.trayExe: string | null` (packaged win32 → `runtime/<v>/tray/conduit-tray.exe`; unpackaged → P1; non-win32 → null, platform injected). `prepare.ts`: app dir sources gain `join(bundled,'tray')`; `PreparedRuntime.trayExe`. `supervisorArgs(hcExe, {…, tray?: { source: string; app: AppLaunch }})` appends the four flags. `server-lifecycle.ts`: `noteStopping(reason)` stores `orderlyEnd` for `stopAll`/`idle`, kept across `drop()`, cleared on `greeted`; `vanished()` with it set clears it, adds no `vanishedAt`, runs `startRule`. `server-events.ts:179` calls it. `stop-all.ts`: `auth?: Hello['auth']` passed into `hello` (main passes none). `electron/jump-list.ts`: `STOP_ALL_AGENTS_FLAG = '--stop-all-agents'`; `jumpListTasks(execPath: string): Electron.Task[]`; `runStopAllAgents(deps: { confirm(): Promise<boolean>; stopAll(): Promise<{ok:boolean; reason?:string}>; error(msg): Promise<void>; secondInstanceArrived(): boolean }): Promise<'quit' | 'relaunch'>`. `main.ts`: packaged win32 `app.setUserTasks(jumpListTasks(...))`; flag branch after the lock — no window/supervisor/GC; confirm seam under `CONDUIT_E2E=1` + `CONDUIT_E2E_STOP_CONFIRM=accept`; `second-instance` with the flag → confirm in focused window → `stopAllAndContinue()`; pass `tray` + `app` (`process.execPath`, `[app.getAppPath()]` unpackaged, cwd) to the lifecycle.
- Red-first: `server-lifecycle.test.ts` F3a both orderings (C2 close before hc end, and after) → no budget entry; an end with no recorded reason still counts; `orderlyEnd` cleared on `greeted`; supervisorArgs carries tray flags only when `trayExe` set. `runtime-layout.test.ts` (P1, env override, non-win32 null). `runtime-dir-prepare.test.ts` (tray copied, `trayExe`). `jump-list.test.ts` (task fields; cancel → quit without stop; stop failure → error then quit; second-instance → relaunch). `server-shell-stop-all.test.ts` (`auth` reaches hello).
- **Check:** `npm run test:unit -- test/unit/server-lifecycle.test.ts test/unit/runtime-layout.test.ts test/unit/runtime-dir-prepare.test.ts test/unit/jump-list.test.ts test/unit/server-shell-stop-all.test.ts`.

### S7 (G7 build/CI, after C1)
- `tools/check-rust.mjs`: `export function checkRust(spawn): { ok: true } | { ok: false; message: string }`; CLI exits 1 with exactly "Rust toolchain not found: install rustup (https://rustup.rs) to run the tray-helper checks". Never skips. `tools/tray-check.mjs`: preflight → `cargo fmt --check` → clippy host → clippy msvc target (P7) → `cargo test`, all `--locked --manifest-path native/tray/Cargo.toml`, exit codes propagated. `tools/tray-build.mjs`: preflight → `cargo build --release --locked --target x86_64-pc-windows-msvc` → assert ≤ 2 MB → copy to `build/vendor/tray/conduit-tray.exe`; refuses on non-win32. `package.json`: `tray:check`, `tray:build`; `verify` gains `&& npm run tray:check` after `test:unit`; `dist` runs `tray:build` before electron-builder; `win.extraResources` gains `{from:'build/vendor/tray', to:'runtime/tray'}`. `verify-quick.mjs`: adds `tray:check` when a changed file is under `native/`.
- Workflows: `verify.yml` step "Rust tray helper checks" `npm run tray:check` (rustup on ubuntu-latest; toolchain file adds msvc target std + rustfmt/clippy). `release.yml` build job: `actions/cache@v4` (`~/.cargo/registry`, `~/.cargo/git`, `native/tray/target`, key `tray-${{ runner.os }}-${{ hashFiles('native/tray/Cargo.lock','native/tray/rust-toolchain.toml') }}`) → `npm run tray:build` after fetch-runtime; after electron-builder, when `CSC_LINK` is non-empty, `Get-AuthenticodeSignature dist\win-unpacked\resources\runtime\tray\conduit-tray.exe` must be `Valid` (fails the release otherwise; then add signtool to `tray:build`). `e2e.yml` shard: same cache + `npm run tray:build` after `npm run build`.
- **B-1 measurement:** on ubuntu (the verify job's first run on the branch), `cargo clippy --target x86_64-pc-windows-msvc` succeeds without a linker and `build.rs` skips embedding. Fail → move the msvc clippy into the release/e2e Windows steps and say so in the plan.
- Red-first: `check-rust.test.ts` (missing cargo → exact message; present → ok); `tray-packaging.test.ts` (extraResources mapping; `verify` includes `tray:check`; verify.yml/release.yml/e2e.yml contain the steps; `.gitignore` has `native/tray/target/`); `tray-notices.test.ts` (P5).
- **Check:** `npm run test:unit -- test/unit/check-rust.test.ts test/unit/tray-packaging.test.ts test/unit/tray-notices.test.ts`, `npm run tray:check`, `npm run tray:build`.

### S8 (lead integration, after G1–G7 merge by reviewed SHA)
Wire `runCli`: `splitSupervisorArgs` → `childArgs` from `rest`; if `win32 && tray` → `createTrayRelay` with real `trayView`, launcher, `pollRunning`, `TrayLog(<userData>/tray.log)`, seam if `seamEnabled`; `supervise({…, stopSignal, stopSessions: directStopSessions, hooks, spawnChild: spawnServerChild(…, child => relay.attachServer(channelOf(child)))})` → `relay.finish(exit)` → exit 0. `electron/main.ts` hands `layout.trayExe` + app launch to the lifecycle; trayHint host fact → `webview/app.tsx:705`. CHANGELOG Unreleased (tray, Jump List, quit copy, L7 + T3 residual notes). **Check:** `npm run verify`, `npm run tray:build`, `npm run build`, one local `npm run e2e -- tray-helper`.

### S9 (G8 e2e, then lead)
Scenarios (real helper, never the shell UI; read `tray-seam.jsonl`/`tray.log`; cleanup via seam `stopAll`, else `--stop-all`):
- `tray-helper.e2e.mjs` — start a long-running session, quit the app leaving agents running; assert `hello`, `shown`, view tooltip "Conduit — 1 agent running"; inject `stopAll`; assert hc lists no session terminal, the supervisor terminal is gone, the helper pid exited ≤ 2 s, `hidden` mirrored, `tray stopAll id=… killed=1` in `server.log` (AC1, AC3, AC6).
- `tray-helper-restart.e2e.mjs` — kill the helper pid → new `hello` + `shown` within 2 s; relaunch with a bumped version (`CONDUIT_E2E_APP_VERSION` seam if one exists, else a second dev build dir) → `swap` line in `tray.log`, new `hello` whose exe path is `runtime/tray/conduit-tray.exe` (AC8, AC12).
- `tray-stop-app-open.e2e.mjs` — window open, inject `stopAll`; sessions show stale, no "stopped after N times" banner, lifecycle restarts the supervisor, `vanished` budget log absent (AC10).
- `tray-jumplist-stop.e2e.mjs` — with the service running and no app, launch `--stop-all-agents` with the confirm seam; no window created, agents stopped, process exits 0 (AC11).
**Check:** `npm run e2e:remote -- --full` once on the integrated tree.
**Manual QA (lead + user, packaged build in Windows Sandbox):** click/right-click the real icon, menu text and keyboard (Win+B, arrows, Enter, Shift+F10), TaskDialog Cancel/Esc/confirm, Open Conduit cold and with Conduit running (single-instance focus), light/dark and 150% DPI icons, T6 Explorer restart, T8 uninstall (`Get-Process conduit-tray` empty after a stop; `$INSTDIR` removable), T9 across a real installer update.

## GROUPS / CLAIMS
- **Serial:** S0 → C1 → {G1…G7 parallel} → S8 → S9.
- **Parallel lanes:** G1–G7 are file-disjoint (map above); all depend only on C1. G4 and G5 meet only through `ServerChannel`/C8a; G3 and G4 only through `server/tray/contracts.ts`; G6 and G7 only through the `build/vendor/tray` path.
- **Handoffs:** `server/supervise.ts` G3 → lead at S8 (`runCli` only); `electron/main.ts` G6 → lead at S8.

## Verification and acceptance mapping
| AC | Proof |
|---|---|
| AC1/AC2 | S2 view rows; S5 coalescing; S1 hide; `tray-helper` |
| AC3 | S1 latch; S4 F3 routing; S5 stopAll; `tray-helper`; manual cancel |
| AC4/AC13 | S3 W1–W6; S4 D3 crash trigger |
| AC5/AC6 | T2, T7; S8 F9 exit; manual quit/update |
| AC7 | S4 env allowlist; T3; S3 `NODE_CHANNEL_*` |
| AC8 | S4 budget; `tray-helper-restart` |
| AC9 | T8 manual uninstall |
| AC10 | S6 F3a both orderings; `tray-stop-app-open` |
| AC11 | S6 jump-list units; `tray-jumplist-stop` |
| AC12 | T5, T9; S4 install; `tray-helper-restart` |

## Risks → measurement that retires it
| Risk | Retired by |
|---|---|
| Icon can't register from an hc/ConPTY-hosted process | T1 |
| A tray-launched Conduit dies with the service's kill-on-close job | T2 (flag branch) |
| Helper stdio / server IPC pipe openable or inherited by the server's spawns | T3 |
| Binary or RSS over budget; AV heuristics | T4; `tray:build` size assert; release signature check |
| Rename over a running image fails; stale `.old` never freed | T5 |
| Explorer restart drops the icon | T6 |
| Hard kill leaves an orphan helper | T7 (+ EOF exit) |
| Uninstall leaves a running helper | T8 manual pass |
| "Show icon" choice resets per update | T9 (guid fallback) |
| macOS packaging assumption wrong | T10 |
| `cfg(windows)` code unlinted on ubuntu; build.rs needs rc.exe there | B-1 |
| electron-builder doesn't sign extraResources exes | release `Get-AuthenticodeSignature` step |
| Abort races a starting server (W2) / double stop | S3 W-table tests |
| Error dialog killed by service exit | P4 + S1 deferred-exit test |
| Relay error kills server supervision | S4 "never throws into supervise()" test |

## Deviation rule
A failed S0 branch marked STOP halts the build and goes to the user. Any other false assumption: stop that task, the lead amends C1, no shim/second path/widened type. P1–P8 are the only departures from the spec text.

## Decisions Needed
None. T2 (launch flags), T6 (re-add poll) and T9 (`guidItem`) are measurements with pre-agreed branches.

## Self-review
#1 Coverage: AC1–AC13, F1–F12, §7a W1–W6, §6 env/argv, §10 copy, §11, §12 logs mapped. #2 Placeholders: none; `services.ts` accessor and a version-bump seam are "if missing" with owners. #3 Signatures: `SuperviseExit` (P3) consistent across G3/G4/S8. #4 Ownership: every path under one owner; two explicit handoffs. #5 Contracts first: C1 files are the only cross-lane imports.

SLICES: 11 — S0 measurements; C1 contracts; S1 rust; S2 view; S3 supervise; S4 relay; S5 server IPC; S6 app; S7 build/CI; S8 integration; S9 e2e (+ manual QA).
