---
status: active
date: 2026-11-03
---

# Feature Spec: background-service tray helper

**Tier:** FULL (autonomous; rev 2 after architecture review; lead decisions in §Decided). **Type:** native helper + supervisor/server plumbing + small app changes. **Builds on:** ADR 0007, `2026-11-01-three-process-architecture.md`. **Branch:** `feat/tray-helper` from `main` = v0.52.1.

## 1. Problem and outcome

When you quit Conduit, your agents keep running in the background service. That's by design (ADR 0007 §Consequences "Quitting"). But with no window open, nothing shows that work, and the only ways to stop it are reopening Conduit or uninstalling it. **Outcome:** while the background service runs agents, a notification-area icon shows how many are running and how many need you. It offers **Open Conduit** and **Stop all agents**. The app can still quit, update and crash without affecting the icon, the service or the agents.

## 2. Grounding (read from code on `main` 05402956 unless marked; nothing here is a runtime measurement)

| Evidence | Consequence |
|---|---|
| `server/supervise.ts:198` spawns the server `detached:false, stdio:'inherit'`; `:209` `chdir(__dirname)`; `:142-187` restart loop; `:160-164` exits on `SERVER_EXIT.done`/`doneCoreIdle` (`src/contracts/session-identity.ts:156`) | The supervisor owns the server's lifetime, and its lifetime ends with the service. It's the natural owner of the helper. libuv's kill-on-close job (ADR 0007 §7) also covers a non-detached helper child. |
| `electron/runtime-layout.ts:44-52`, `server/runtime-dir/prepare.ts:49-69` copy `node.exe` + `server/` into `userData/runtime/<appVersion>/` (`:59`), hc into `runtime/hc/<v>/` (`:58`) | The helper ships inside the same per-version dir, so it never runs from the install dir. |
| `electron/runtime-gc.ts:12-14` keeps the newest 2 dirs. Only a failed rename (EPERM/EBUSY/EACCES) means "in use". ADR §As built: a cwd blocks the rename, a mapped image doesn't (M21) | The helper must run with its cwd in its runtime dir, or GC could delete the dir under it. |
| `package.json:77-91` `win.extraResources`: `build/vendor/node/node.exe`, `build/vendor/hc`, `out/server` → `runtime/*`. `build/runtime-pins.json:14-21` pins hc as a **prebuilt** release zip with a sha256. `build/fetch-runtime.mjs` downloads it | hc isn't built by us. The helper is the first native code we build, so it needs its own CI build step, not a pin. |
| `.github/workflows/release.yml:31` builds on `windows-latest`, `:44` fetch-runtime, `:61` electron-builder with env-gated `CSC_LINK`. `verify.yml` runs on `ubuntu-latest`. `e2e.yml:174` windows shards, `:202-204` vendor hc onto PATH | Cargo build on windows for release and e2e. Platform-neutral `cargo test` on ubuntu in verify. |
| `docs/WINDOWS-SIGNING.md`: unsigned today, signing-ready via electron-builder secrets | Whether electron-builder signs a non-main `.exe` in `extraResources` is **ASSUMED**, not verified. §12 adds an explicit check. |
| `src/contracts/server-protocol.ts:329-347` `hello`: `auth?` reserved, "C2 is unauthenticated to same-user processes today" (`:334-337`). `:362` frozen `server.stopAll` → `{killed}`, exits `doneCoreIdle`. `:550` `server.stopping` event | On main, any same-user process can stop all over C2. |
| `server/transport/pipe.ts:138` calls `onConnect()` on **accept**. `server/compose.ts:98-102` wires that into `ServerLifecycle.connected()`. `server/lifecycle/shell.ts:45,99-140` idle exit after 10 min only at `connections === 0` | A long-lived extra C2 client (a tray) would hold the server alive forever and needs special-casing. That's a reason not to put the helper on C2 (D1). |
| `server/compose.ts:146-170` routes `server.stopAll` to `lifecycle.stop('stopAll','stopAll')` | One server-side stop transition exists. The helper's stop reuses it. |
| `server/lifecycle/stop-all.ts:22-119` + `server/main.ts:37-51` (`--stop-all`): C2 `hello` (no `auth`) then `server.stopAll`, or `directStopAll` over hc (`server/hc-cli.ts:120-150`, which also kills the supervisor, `:138-144`) on no answer in 5 s. Used by `build/installer.nsh:146` | This is the existing headless stop path and its fallback. |
| **feat/agent-collab-integration** (not on main): `server/transport/app-auth.ts` accepts only `role==='app'` with a per-launch secret. `compose.ts:116` refuses every other `hello`. `server/policy-bootstrap.ts` passes the secret app → supervisor (one-shot file) → server (**stdin**). `electron/policy-key.ts:203-204,253-254` persists it via safeStorage. Its `stop-all.ts:38`: "Uninstall has no app-role secret, so it must stop through the hc fallback" | Once collab merges, C2 is app-only. A helper on C2 would need a new role and token threaded through that bootstrap. The design below needs neither (§6). |
| `server/attention/index.ts:21,73` gives the server its own `needsAttention`. `src/attention.ts:11-13` `attentionSessions`, `src/session-icon.ts:48-56`, `src/quit-guard.ts:168` `runningSessions` are pure, shared derivations | The tray counts with the same functions the app uses. Snooze is app-local (`src/attention.ts:47-60`), so the tray doesn't see it. |
| `electron/server-lifecycle.ts:332-371` counts **every** supervisor end as "vanished" against a 3-per-hour budget (`:59`), then shows `stopped`. `electron/server-events.ts:179` only logs `server.stopping` | A stop-all from the tray while the app is open would burn that budget. This needs a fix (§7 F3). |
| `src/quit-guard.ts:74-84,185-195`: a quit says "Your N agents will keep running after Conduit closes." `electron/main.ts:1973,4085` handle quit-and-stop. `:1140` single-instance lock, `:4762` `second-instance` | §10 changes the copy. §9 relies on the single-instance hand-off. |
| `build/installer.nsh:117-156` stops agents on a real uninstall (not on update, `:154`) by running `--stop-all` from the newest runtime dir | When the service exits, the helper exits too. §11 says what uninstall must also check. |
| Packaged mac: `runtime-layout.ts:47` and `prepare.ts:37-38` hard-code `node.exe`/`hc.exe`. Only `win.extraResources` carries the runtime | **ASSUMED:** the three-process runtime isn't packaged for macOS yet. That settles §13. |

## 3. Design summary

```
Conduit app (install dir)      ── C2 (unchanged) ──┐
                                                  Conduit server (runtime/<v>/server/main.js)
supervisor (runtime/<v>/server/supervise.js) ─────┤  ◄── Node IPC channel (stdio slot 3): C8a
   │  parent of both; the only relay              │
   └── stdio JSON lines: C8b ──► runtime/tray/conduit-tray.exe (stable path; Rust, Windows only)
```

- **D1. Inherited pipes only.** The helper talks only to its parent supervisor, over inherited anonymous pipes; the supervisor reaches its server child over a private Node IPC channel (a fourth stdio slot). The helper never touches C2, hc or a named endpoint and holds **no token**. It can ask for `stopAll` and an app launch; it receives only a rendered view (L1).
- **D2. TS decides, Rust renders.** `trayView()` (`src/tray-view.ts`, pure; strings in `src/tray-strings.ts`) makes **every** visibility, icon, label, enablement and copy decision. The Rust `model` owns only menu/dialog state, the stop latch (one `stopAll` per confirm, ignored until the next `stopResult`) and the NIM_ADD retry; its only text is a fallback tooltip "Conduit".
- **D3. Started once per supervisor lifetime, on the first of:** the first `ready` from a server child, or the first server exit whose code isn't `SERVER_EXIT.done`/`doneCoreIdle` (a crash) — so a new runtime crash-looping after an update still shows the icon and F5/F6 are reachable. A duplicate supervisor never starts one: on win32 its server's EADDRINUSE makes `listen` return false (`pipe.ts:103-104`), `runServer` returns 0 = `done` before any `ready`, and the supervisor returns (`supervise.ts:160`). On exit the supervisor sends `exit` and closes stdin; the kill-on-close job is the backstop.
- **D4. Visible only while there is background work:** ≥1 running session (server counts) or, with no server ready, ≥1 live session terminal in hc. At 0 the icon hides; the helper stays alive until the service's idle exit (10 min, `shell.ts:45`; L9). Shown whether or not a window is open (L2).
- **D5. Confirm is a native TaskDialog** owned by the helper, Cancel default. A two-step menu item was rejected (the menu closes on every click).
- **D6. No toasts or sound in v1** ("OS notifications appear only while the app runs", ADR 0007), so Focus Assist doesn't apply.

## 4. Placement, build and shipping

- **Crate:** `native/tray/`, one crate `conduit-tray` (edition 2021, pinned `rust-toolchain.toml`). Modules `protocol` (C8b serde mirror) and `model` (D2 only), both platform-neutral; `win` (`cfg(windows)`: a hidden **top-level** window — `HWND_MESSAGE` never receives `TaskbarCreated` — `Shell_NotifyIconW` + `NOTIFYICON_VERSION_4`, `TrackPopupMenuEx`, `TaskDialogIndirect`) and `launch` (`cfg(windows)`). Deps: `windows-sys`, `serde`, `serde_json` only; `#![windows_subsystem="windows"]`; release `opt-level="z"`, `lto`, `panic="abort"`, `strip`; budget ≤ 2 MB. `build.rs` embeds the `.ico` variants and a `VERSIONINFO` with the app version.
- **Identity and stable path (L6):** the icon is keyed by `hWnd`+`uID`, no `guidItem`. Windows keys the "show on taskbar" choice by exe path (**ASSUMED**, S0-T9), so the helper always runs from `runtime/tray/conduit-tray.exe`. The per-version copy `runtime/<appVersion>/tray/conduit-tray.exe` is only the swap source (`prepare.ts:59` gains `join(bundled,'tray')`; `PreparedRuntime` gains `trayExe`).
- **Swap** (new `server/tray/install.ts`, pure with injected fs), run by the supervisor just before it spawns the helper — i.e. only on the D3 trigger, by one supervisor per instance: (1) try to unlink stale `conduit-tray.exe.*.old` / `*.new` (still in use → stays till next time); (2) same sha256 as the installed file → done; (3) copy the source to `conduit-tray.exe.<pid>.<rand>.new`, flush; (4) rename the installed file to `….old` — works with an image still mapped (a cwd blocks a rename, a mapped image doesn't: M21; S0-T5); (5) rename `.new` → `conduit-tray.exe`. On any failure: run the existing installed binary if any, else the source directly, and log.

  `runtime/tray/` isn't a semver dir, so app GC never touches it (`runtime-gc.ts` candidates); the helper's cwd `runtime/tray/` pins no version dir. A downgrade's supervisor installs its own older binary — helper, supervisor and server always share one version.
- **Dev/e2e:** unpackaged, the app passes `CONDUIT_TRAY_BINARY` (or `native/tray/target/release/conduit-tray.exe` if present) as the source `--tray <path>` in `supervisorArgs` (`electron/hc-cli.ts:27-32`). No `--tray`, no helper.
- **Build/CI:** `npm run tray:build` = `cargo build --release --locked --target x86_64-pc-windows-msvc` → `build/vendor/tray/`; `package.json win.extraResources` gains `build/vendor/tray` → `runtime/tray`. `release.yml` (windows) and the `e2e.yml` windows shards add `dtolnay/rust-toolchain` + `Swatinem/rust-cache` (SHA-pinned, cached by `Cargo.lock`) then `tray:build`. `verify.yml` (ubuntu) and `npm run verify` run `tools/check-rust.mjs` then `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (L5); the preflight fails with "Rust toolchain not found: install rustup (https://rustup.rs) to run the tray-helper checks" — it never skips.
- **Signing:** with `CSC_LINK` set, a release step asserts `Get-AuthenticodeSignature` = `Valid` on the exe; if electron-builder doesn't sign extraResources exes (unknown, ASSUMED), `tray:build` signs with `signtool` behind the same secrets. Runtime copies carry no Mark-of-the-Web, so SmartScreen doesn't apply; AV heuristics are the residual. `THIRD_PARTY_NOTICES.txt` gains the crate notices (`cargo about`).

## 5. Contracts (new `src/contracts/tray-protocol.ts`, C8; Rust mirrors C8b)

```ts
export const TRAY_PROTOCOL_VERSION = 1;

// ── C8a: server ⇄ supervisor, Node IPC (process.send / 'message') ──
export interface TrayCounts {
  running: number;        // runningSessions(view).length (quit-guard.ts:168)
  needsYou: number;       // attentionSessions(running).length — server needsAttention, no snooze (L7)
  health: RuntimeHealth['state'];
  stopping: ServerEvents['server.stopping']['reason'] | null;
}
export type ServerToSupervisor =
  | { type: 'ready' }                                   // after the pipe bound (instance owner)
  | { type: 'counts'; counts: TrayCounts }              // on change, coalesced ≤ every 250 ms
  | { type: 'stopAllResult'; id: number; ok: true; killed: number }
  | { type: 'stopAllResult'; id: number; ok: false; reason: string };
export type SupervisorToServer = { type: 'stopAll'; id: number };

// ── trayView() input (supervisor-internal): the unknown state is typed, never a fake 0 ──
export type ServicePhase =
  | { phase: 'serving' }                                // a ready server child
  | { phase: 'spawning' } | { phase: 'restarting' }     // child not ready yet / backoff sleep
  | { phase: 'exhausted'; retryAt: string } | { phase: 'stopping' };
export type TraySource =
  | { source: 'server'; counts: TrayCounts }            // only while phase = serving
  | { source: 'hc'; running: number }                   // F2 poll; needs-you unknown
  | { source: 'none' };                                 // no reading yet
export function trayView(i: { phase: ServicePhase; source: TraySource; profileLabel: string | null }): TrayView;

// ── C8b: supervisor ⇄ helper, one JSON object per line, UTF-8; stdin = to helper, stdout = from ──
export type SupervisorToHelper =
  | { type: 'init'; v: 1; app: AppLaunch | null }
  | { type: 'view'; view: TrayView }
  | { type: 'stopResult'; ok: true } | { type: 'stopResult'; ok: false; title: string; body: string }
  | { type: 'exit' };
export interface AppLaunch { exe: string; args: string[]; cwd: string }
export interface TrayView {
  visible: boolean;
  icon: 'normal' | 'needsYou' | 'warning';
  tooltip: string;                                      // ≤ 127 UTF-16 units (szTip)
  items: TrayItem[];
  confirm: { title: string; body: string; confirm: string; cancel: string };
  openFailed: { title: string; body: string };          // `{reason}` placeholder
}
export type TrayItem =
  | { kind: 'label'; text: string }                     // rendered MFS_DISABLED
  | { kind: 'separator' }
  | { kind: 'action'; id: 'open' | 'stopAll'; text: string; enabled: boolean; isDefault?: true };
export type HelperToSupervisor =
  | { type: 'hello'; v: 1; helperVersion: string; pid: number }
  | { type: 'shown' } | { type: 'hidden' }             // NIM_ADD / NIM_DELETE succeeded
  | { type: 'stopAll' }                                 // only after the user confirmed
  | { type: 'opened' } | { type: 'openFailed'; reason: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
export const TRAY_EXIT = { asked: 0, shellUnavailable: 10, protocol: 11 } as const;
```

**Rules.** Unknown `type`s are ignored and logged. A `v` mismatch exits `protocol` and isn't restarted. Skew can't arise anyway, because the supervisor installs its own version's binary before every spawn (§4). Lines over 64 KiB are protocol errors. The helper validates `id ∈ {open, stopAll}` and truncates the tooltip; otherwise it renders what it's sent. Fixtures in `test/fixtures/tray-protocol/*.json` are parsed by both vitest and `cargo test`.

## 6. Security and capability (replaces a token lifecycle)

- **No token exists:** nothing to mint, rotate, leak or log. libuv creates the helper's stdio pipes and the server's IPC slot at spawn, and neither has a name anyone can open. That they're connected single-instance pipes is **ASSUMED** (S0-T3).
- **A hostile same-user process** can kill the helper or supervisor, which it already can via hc (an ADR residual), or show a fake icon, which gains it nothing. It can't impersonate the helper. Stopping isn't an escalation (lead decision 4), and any process can launch Conduit.
- **Data:** C8a carries counts only: no names, paths or content.
- **Env:** the helper gets only `SystemRoot`, `TEMP`/`TMP`, `USERPROFILE`, `LOCALAPPDATA` and `APPDATA`: no `HC_*`, MCP token or `CONDUIT_BOOTSTRAP_FILE`. Node deletes `NODE_CHANNEL_FD` from the server's `process.env` (**ASSUMED**, `setupChildProcessIpcChannel`); a unit test asserts `serverChildEnv` has no `NODE_CHANNEL_*`. S0-T3 also checks that the server's own spawns (`startCore`) don't inherit the IPC handle. If they do, a leaked handle grants only `stopAll` (accepted, and stated in the release notes).
- **Argv:** the supervisor strips its own flags (`--tray`, `--app-exe`, `--app-arg`, `--app-cwd`, each with its value) before building `childArgs` (`supervise.ts:215-217`). The server's parsing ignores unknown flags (`argValue`/`args.includes`, `server/lifecycle/cli-args.ts:1-10`, `server/main.ts:37,70`). Stripping is still required: a dev `--app-arg` whose value is `--e2e` would match `args.includes('--e2e')`. Unit-tested.
- **Collab interaction: none.** C2 auth, `hello`, `policy-bootstrap` and the server's stdin are untouched. The IPC is its own slot (`[stdin,'inherit','inherit','ipc']`).
- **Rejected: a C2 `tray` role with a supervisor-minted token.** It needs a Rust named-pipe JSON-RPC client, a role in the frozen `hello`, tray peers excluded from the idle count (`pipe.ts:138`) and `reloadAgents`, and a second secret in collab's bootstrap. Even then it couldn't report or stop while the server is down.

## 7. Flows

**F1 start.** On the D3 trigger, if `win32` and `--tray` resolves to a file, the supervisor swaps the binary (§4) and spawns the helper (`detached:false`, `windowsHide`, `stdio:['pipe','pipe','pipe']`, cwd `runtime/tray/`, minimal env). It sends `init`, and the helper replies `hello`. `app` comes from new supervisor args `--app-exe`/`--app-arg`/`--app-cwd`, which the app fills from `process.execPath` (plus `app.getAppPath()` unpackaged). They aren't secret, so hc persisting argv is fine. `profileLabel` is null for the packaged default userData, otherwise "Conduit (<userData leaf>)".

**F2 readings.** While a ready server is serving, it sends `TrayCounts` on each `sessions.changed` coalesce and on `runtime.changed`/`server.stopping`, only when the counts changed (source `server`). Otherwise the supervisor polls `terminal.list` with labels `conduit.instance` + `conduit.role:'session'` every 15 s, as `server/hc-cli.ts:127-129` does (source `hc`). A failed poll keeps the previous reading (`none` before the first). A `view` is sent only when `trayView()`'s output changes.

**F3 Stop all from the tray.**
1. A TaskDialog opens (foreground, owned by the hidden window). Cancel or Esc does nothing. Confirm sends `stopAll` and engages the Rust latch.
2. **`serving`:** the relay sends `{stopAll,id}`. The server runs `lifecycle.stop('stopAll','stopAll')`, the same transition as C2 (`compose.ts:146-170`), replies and exits `doneCoreIdle`. `supervise()` takes its normal path (`:161-162`: stops the idle core, returns `{reason:'doneCoreIdle'}`). The relay sends `stopResult ok`, then F9 follows.
3. **No ready server** (`restarting`, `exhausted`, or a crash exit before the next spawn): the relay aborts `stopSignal`, and `supervise()` handles it at its current wait point (§7a).
4. **`spawning`:** wait up to 10 s for `ready`, then go to step 2. If the child exits first, go to step 3. Otherwise fail with "The background service is starting. Try again in a moment."
5. **Failure** (`ok:false`, the 20 s `STOP_ALL_ANSWER_TIMEOUT_MS`, or the IPC closing before the reply): an error TaskDialog, "Couldn't stop the agents: {reason}", and the latch is released. Nothing is ever killed behind a live server.

**F3a app open during a tray stop.** `server-events.ts:179` also calls a new `lifecycle.noteStopping(reason)`, which stores `orderlyEnd` for `stopAll`/`idle`. The value is kept across `drop()` and cleared on `greeted`. The check lives in `vanished()` (`server-lifecycle.ts:350-371`), where both routes end: the watch (`:335,341`), and `lostConnection` finding the supervisor absent (`:403-404`). With `orderlyEnd` set, `vanished()` clears it, adds **no** `vanishedAt` entry (`:359-360`) and runs `startRule`. Sessions show as stale.

**F4 Open Conduit** (the default item; also icon click and `NIN_SELECT`/`NIN_KEYSELECT`). The env comes from `CreateEnvironmentBlock`, never from the supervisor, whose env carries hc's XDG values. The launch flags depend on S0-T2, which checks whether a helper child outlives the supervisor's kill-on-close job (libuv may already set `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`). If it survives, use a plain `CreateProcessW(…, CREATE_UNICODE_ENVIRONMENT)`. If not, add `CREATE_BREAKAWAY_FROM_JOB`, and on ACCESS_DENIED fall back to `ShellExecuteExW`. If Conduit is already running, the single-instance hand-off focuses it (`main.ts:1140,4762`). A missing exe gives `openFailed`, "Conduit isn't installed at {path}".

**F5 crash.** `restarting` during the backoff (`session-identity.ts:141`): a `warning` icon and "Background service restarting. Agents keep running." Stop all goes through F3 step 3.

**F6 exhausted.** `exhausted` during the 30-min cooldown: a `warning` icon and "Background service stopped after repeated crashes. Retrying at {HH:MM}." Open Conduit (its banner has Retry) and Stop all both work.

**F7 helper crash.** Any exit other than `asked`/`shellUnavailable`/`protocol` restarts the helper after 1 s, then 5 s, then 30 s. After 3 crashes in 10 min, the supervisor gives up for its lifetime. The relay runs beside the restart loop, never inside it: its errors are logged and never thrown into `supervise()`, and its **only** way in is `stopSignal` (§7a).

**F8 shell.** A failed `NIM_ADD` retries every 2 s for 60 s, then the helper exits `shellUnavailable`. `TaskbarCreated` re-adds the icon. Win+B reaches it, including in overflow.

**F9 service exit** (idle, stopAll, restart, uninstall, tray stop). When `supervise()` is about to end, `runCli` sends `exit`, closes stdin, waits up to 2 s and exits 0. On an idle-core end the `exit` goes out **before** the core stop: the supervisor is then the last hc terminal and `hc server stop` waits on it, so sending `exit` after it never happens (found in S9, fixed 0460340f). On a hard kill, the job ends the helper; a ghost icon may linger until hovered (accepted).

**F10 app update.** NSIS replaces only the install dir and never touches `runtime/`. On the new app's first launch, `server.restart` (appNewer, `server-lifecycle.ts:313-316`) ends the old server, supervisor and helper. The new supervisor swaps the binary (§4) and starts it at the **same path**, so the user's "show icon" choice survives (S0-T9). Agents survive.

**F11 downgrade.** An older app never restarts a newer server (D26). A supervisor from before the helper shows no icon. **F12 profiles.** Each userData instance (`instance-names.ts`) has one supervisor, one `runtime/tray/` and one icon, told apart by `profileLabel`.

## 7a. Interrupting `supervise()` (today a linear `for(;;)`, `supervise.ts:152-186`)

**Options and result.** `SuperviseOptions` gains `stopSignal?: AbortSignal` and `stopSessions?: () => Promise<number>`. `stopSessions` is `directStopSessions`: `directStopAll` without the supervisor kill (`server/hc-cli.ts:138-144`), factored out of `:120-150`. `supervise()` returns `Promise<SuperviseExit>`:

```ts
type SuperviseExit = { reason: 'done' | 'doneCoreIdle' } | { reason: 'trayStop'; killed: number };
```

`runCli` maps every result to exit 0.

**Where the signal is honoured.** `clock.sleep(ms, signal)` resolves early on abort. `coolDown` takes the signal in its poll loop (`:131-133`) and its write-failure sleep (`:118-121`). The loop checks `signal.aborted` at the top of each iteration, before `spawnChild`.

**Stop routine.** Run `stopSessions()`; stop the core if no other terminal is live (as `:162` does); return `{trayStop, killed}`.

A `stopSessions` failure is logged and reported as a failed `stopResult`. `supervise()` still returns; it never silently continues.

| Wait point when the abort arrives | Behaviour |
|---|---|
| W1 `spawnChild` running, `serving` | Not aborted: F3 step 2 goes over IPC. |
| W2 `spawnChild` running, not ready (F3 step 4 timed out) | The signal stays clear and the error is shown, so no kill races a starting server. |
| W3 the child exited, before the done/backoff decision | `done`/`doneCoreIdle` return as today (the relay reports `ok`). Otherwise, if aborted: no respawn; run the stop routine. |
| W4 backoff `sleep` (`:183-185`) | Resolves early; no respawn; run the stop routine. |
| W5 `coolDown` poll | Exits. Removes the marker only if this supervisor wrote it (`state==='written'`, `:134-139`), then runs the stop routine. |
| W6 `coolDown` write-failure sleep | As W5. Nothing was written, so nothing is removed. |

## 8. States → view (`trayView()`)

| phase / source | visible | icon | tooltip / first label |
|---|---|---|---|
| serving, server, running = 0 | no | — | — |
| serving, server, running ≥ 1, needsYou = 0 | yes | normal | "Conduit — 3 agents running" |
| serving, server, needsYou ≥ 1 | yes | needsYou (dot badge) | "Conduit — 3 agents running, 1 needs you" (`attentionChipLabel`, `src/attention.ts:20-23`) |
| serving, health degraded / starting / unavailable | if running ≥ 1 | warning | + "Background service degraded" / "…starting…" / "…unavailable" |
| spawning / restarting / exhausted, hc running ≥ 1 | yes | warning | "3 agents running" + the F5/F6 line; no needs-you line (unknown) |
| any non-serving phase, hc 0 or none | no | — | — |
| stopping | if it was visible | normal | "Stopping agents…"; Stop all disabled |

**Menu,** top to bottom: `profileLabel`, whenever it isn't null; "N agents running", plus "N need you" when known and > 0; the phase or health label; a separator; **Open Conduit** (the bold default); **Stop all agents…**.

There's no Quit item (L3). The icon is never the only signal: the tooltip and labels say the state in words, and the icon variants differ in shape (dot badge, warning glyph). Light and dark variants follow `SystemUsesLightTheme`.

**Confirm copy:** "Stop all agents?" / "3 agents are running in Conduit's background service (1 needs you). Stopping ends them. Anything they haven't saved is lost." The needs-you clause is dropped when it's unknown or 0. Buttons: "Stop all agents" / "Cancel".

**A11y:** the menu and TaskDialog are native (MSAA/UIA). By keyboard: Win+B, then arrows, then Enter to open Conduit or Shift+F10/Apps for the menu.

**i18n:** all strings live in `src/tray-strings.ts`. English only, since there's no i18n framework today.

## 9. Jump List fallback (when the helper isn't running), L4

**Registration.** At startup the packaged win32 app calls `app.setUserTasks` with one task: program `process.execPath`, arguments `--stop-all-agents`, title "Stop all agents", description "Stop every agent Conduit is running in the background", and Conduit's icon.

**No Conduit running.** The instance takes the single-instance lock but creates **no window**, starts no supervisor and runs no GC. It then: confirms with a native `dialog.showMessageBox`; calls `stopAll()` (`server/lifecycle/stop-all.ts`) with a new `auth` option for the app's credential (none on main; the safeStorage launch secret on collab). That's the headless path and hc fallback uninstall already uses; shows an error box if the stop fails, then quits, or relaunches normally if a `second-instance` arrived meanwhile.

**Conduit running.** The primary receives `second-instance` with the flag, confirms in its focused window and runs `stopAllAndContinue()` (`server-lifecycle.ts:479-493`).

**Why not `node.exe server\main.js --stop-all`:** on collab it has no credential, so it always waits 5 s and then kills through hc behind a live server (collab `stop-all.ts:38`). Its path also points into a version dir that GC deletes.

## 10. Quit dialog copy (`src/quit-guard.ts:74-84,185-195`)

`QuitConfirmCopyInput` gains `trayHint: boolean`, true on packaged win32. For `quit`/`update` the body becomes: "Your 2 agents will keep running after Conduit closes. Stop them any time from Conduit's icon in the notification area." An update then adds "Conduit will relaunch to install the update." `windowClose`/`quitAndStop` are unchanged. CHANGELOG: an entry under Unreleased.

## 11. Uninstall

There's no new step.
- `ConduitStopAgents` (`installer.nsh:117-151`) stops the server, so the supervisor and helper exit (F9). A supervisor with 0 agents still answers `--stop-all`.
- AC9 is checked in the real installer pass (S0-T8).
- If the stop fails, the helper may keep running from `%APPDATA%\…\runtime\tray`. It never blocks removing `$INSTDIR`, and its Open Conduit then reports "not installed".

## 12. Logging

- **`<userData>/tray.log`:** written only by the supervisor, 1 MB cap, one rotation. It holds the helper's `log` messages plus helper events: swap, spawn, exit code, restart, give-up, tray stop; each line: ISO time, level, `helper|supervisor`, message.
- **`server.log`:** keeps its single writer, which logs `tray stopAll id=… killed=…`.

## 13. macOS (L8)

macOS is out of MVP and v1. Packaged macOS doesn't ship the three-process runtime (§2; ASSUMED, confirmed in S0-T10), and no helper spawns unless `win32`. Once the runtime ships there, a later slice adds an `NSStatusItem` from the same crate (`cfg(target_os="macos")`). `protocol` and `model` are already platform-neutral.

## 14. Testing

**Rust unit tests (`cargo test`, ubuntu + windows).** C8b fixtures parse; an unknown `v` or an over-long line is rejected; the latch emits `stopAll` only after a confirm, once until `stopResult`; the tooltip is truncated at 127 UTF-16 units, on a char boundary; `exit` → `hidden` → exit 0; `TaskbarCreated` → re-add; the NIM_ADD budget → `shellUnavailable`.

**TS unit tests (vitest, ubuntu).** `trayView()` over every §8 row, including the `hc` source with an unknown needs-you count and `profileLabel` null vs set; `trayCounts()` ≡ `runningSessions`/`attentionSessions`; **`supervise()` at each wait point W1–W6:** no respawn after an abort; `stopSessions` and the core stop each called once; the marker removed only if written (W5) and kept on W6; a late abort after `done` ignored; failures logged and surfaced; **Helper lifecycle:** the D3 triggers (first `ready`, first crash exit, never on `done`); the restart budget; the relay never throws into `supervise()`; **`install.ts`:** an equal hash is a no-op; the swap succeeds while the target is in use; the failure fallback; the stale-file sweep; arg stripping, including an `--app-arg --e2e` value; **F3a:** whether C2 closes before hc ends the supervisor or after, `vanished()` adds no budget entry; an end with no recorded reason still counts; `quitConfirmCopy` with `trayHint`; `serverChildEnv` carries no `NODE_CHANNEL_*`; the shared fixtures.

**E2E** (remote windows runner; the real helper, never the shell tray UI).

*Seam gate.* The seam is honoured only for a dev-build supervisor, and both conditions must hold: `--e2e` is set **and `--shim-dir` is not**. The packaged app always passes `--shim-dir`, because `prepared` exists only when `app.isPackaged` (`electron/main.ts:2406,2437-2446`). Collab uses the same test (collab `server/main.ts:89,216`); the supervisor's `__dirname` isn't under `names.runtimeRoot`.

*Seam behaviour.* The supervisor mirrors every C8b message to `<userData>/tray-seam.jsonl` and accepts injected `HelperToSupervisor` lines from `tray-seam-in.jsonl` (polled every 250 ms). An injected `stopAll` skips the native confirm, which the Rust latch test covers.

*Scenarios.*
- **`tray-helper.e2e.mjs`:** start a long-running session and quit the app. Assert `hello`, `shown` and "1 agent running". Inject `stopAll`. Assert the terminal is gone (hc list), the supervisor ended, the helper exited and `hidden` was logged.
- **`tray-helper-restart.e2e.mjs`:** kill the helper pid and assert it's restarted and `shown`. Relaunch with a bumped version and assert a swap line in `tray.log` and a new `hello` from the same stable path.
- **`tray-jumplist-stop.e2e.mjs`:** run `--stop-all-agents` with the confirm seam. Assert no window opened and the agents stopped.

## 15. Acceptance criteria

**EARS**
- **AC1.** While the service runs ≥1 session on Windows, the system shall show one icon per profile whose tooltip states the running count, and the needs-you count when known.
- **AC2.** When the running count reaches 0, the helper shall hide the icon within 1 s and keep running until the service exits.
- **AC3.** When the user confirms Stop all agents, the service shall end every session terminal, exit and remove the icon; on cancel nothing shall change.
- **AC4.** If no server is ready when Stop all is confirmed, the supervisor shall stop the sessions through hc at its current wait point, without respawning a server.
- **AC5.** When Conduit quits, crashes or updates, the helper, service and agents shall keep running, and the installer shall never wait on a helper file.
- **AC6.** When the service exits, the helper shall exit within 2 s, or be ended by the job on a hard kill.
- **AC7.** The helper shall never connect to C2, MCP or hc, and shall never receive a token, connect secret or policy key.
- **AC8.** If the helper crashes, the supervisor shall restart it at most 3 times in 10 min, with server supervision unaffected.
- **AC9.** When Conduit is uninstalled (not updated), no `conduit-tray.exe` shall survive a successful stop.
- **AC10.** While a window is open, a tray-initiated stop shall not count against the app's vanished-supervisor budget.
- **AC11.** Where the helper isn't running, the Jump List task shall stop all agents without opening a window.
- **AC12.** When the runtime updates, the helper shall run from the same `runtime/tray/conduit-tray.exe`, so the user's taskbar visibility choice persists.
- **AC13.** If a new runtime's server crashes before its first `ready`, the helper shall still start and show F5/F6.

**Gherkin**
```gherkin
Scenario: Stop background agents from the tray with no window open
  Given Conduit quit while 2 agents were running
  When I choose "Stop all agents…" in the Conduit tray menu and confirm "Stop all agents"
  Then both agents' terminals end, the icon disappears and the background service exits
Scenario: Stop while the service is crash-looping
  Given the server is in its restart backoff and hc reports 2 live sessions
  When I confirm "Stop all agents"
  Then no server is respawned, both sessions end and the icon disappears
Scenario: App update keeps the tray and its taskbar setting
  Given "always show" is set for the Conduit icon and 1 agent is running
  When Conduit installs an update and relaunches
  Then the icon returns from the same path, still always shown, and the agent never stopped
Scenario: Cancel does nothing
  When I choose "Stop all agents…" and press Esc
  Then no agent is stopped and the menu item stays enabled
```

## 16. Scope

**S0 (measure on Windows first):** **T1** the icon appears under an hc-hosted supervisor; **T2** a helper child survives the supervisor's job, which decides F4's flags; **T3** the pipes are single-client and not inherited by the server's spawns; **T4** size ≤ 2 MB and RSS ≤ 6 MB; **T5** the swap renames over a running image, and the stale `.old` is deleted once free; **T6** `TaskbarCreated` re-adds the icon; **T7** kill-on-close ends the helper; **T8** a real installer uninstall; **T9** the "show icon" choice survives a swap at the same path; **T10** the packaged macOS layout carries no runtime.

**MVP:** S0, C8, and server IPC with counts; the relay, the helper lifecycle and §7a; the stable path and swap; the Rust helper; F3a and the quit copy; packaging and CI, including the rustup preflight; the e2e seam and its scenarios; the Jump List.

**v1:** A `trayIcon: 'whenRunning'|'never'` server setting; an in-app notice after a tray stop; a pending-asks line; explicit signing.

**Later:** A macOS menu-bar extra; Focus-Assist-aware toasts; a per-agent submenu; Localization.

**Out of scope:** Stopping a single agent, or approving asks, from the tray; showing names or content in the tray; starting a stopped service from the tray; Linux, and auto-start at login; changes to C2 auth or to collab's bootstrap; Collab's existing uninstall hc fallback.

## Decided (lead, pending user confirmation)

- **L1** Relay over inherited pipes: no token, no C2 change (D1, §6).
- **L2** The icon stays visible while a Conduit window is open, as long as agents run.
- **L3** No Hide/Quit item in MVP. Windows' overflow covers the clutter, and v1 adds a `trayIcon` setting.
- **L4** The Jump List runs `Conduit.exe --stop-all-agents` (§9).
- **L5** The Rust checks run in `npm run verify`, failing clearly with "install rustup" when Rust is missing (§4).
- **L6** The stable `runtime/tray/` path ships in MVP (§4), confirmed by S0-T5/T9.
- **L7** The needs-you count ignores app-local Snooze. This is documented in the release notes and in `src/tray-view.ts`.
- **L8** macOS is deferred; S0-T10 confirms the packaging reading.
- **L9** At 0 agents the helper stays alive, hidden, until the service's idle exit.

## Decisions Needed

None. S0-T2 (F4's flags) and S0-T9 (whether the stable path keeps the setting) are measurements, not decisions. If T9 fails, the fallback is a `guidItem` on the now-stable path, measured again.

## Changelog

- **rev 2 (2026-11-03), after the architecture review (REVISE):** `supervise()` becomes interruptible (§7a): `stopSignal`, a typed `SuperviseExit`, and behaviour plus tests per wait point. F7 is reworded; D3 also starts the helper on the first crash exit; the stable `runtime/tray/` path and its swap move into MVP; the profile label shows whenever the profile isn't the default; the Rust `model` is limited to the menu, dialog, latch and retry; `TraySource` is typed: the hc source carries no needs-you count; the F3a fix lives in `vanished()`, tested in both orderings; `init.seam` and `unconfirmed` are dropped; the supervisor strips its own flags before forwarding args; the seam has a two-condition gate; breakaway depends on the S0-T2 result; Q1–Q9 become the lead's L1–L9.
- **rev 1 (2026-11-03):** first draft.
