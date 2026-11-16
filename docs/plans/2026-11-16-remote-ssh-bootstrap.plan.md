# Remote over SSH, slice 3: bootstrap (CON-38) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.2 steps 2–4, §6, §7, §8; RS-D5, RS-D9, RS-D11, RS-D14) **Tier:** FULL
**Inputs:** `docs/runs/2026-11-16-CON-35/gates.md` (G7 start-method matrix), slice 2 plan `docs/plans/2026-11-16-remote-ssh-stdio-link.plan.md` (merged at 4f4b7489).

## Goal
`link.sshBootstrap { target }` on a controller:
1. probes the remote over ssh;
2. installs or upgrades the controller's exact Conduit version there, verified against the pins, laid out atomically, with old versions retained per §7;
3. starts B's server headless so it survives logout where the OS allows it, and says so when it doesn't;
4. returns the `SshEndpoint` that slice 2's `addSshPeer` dials.

Linux remotes are proven end to end. The Windows remote path is built and unit-tested, and its runtime proof stays **pending: Windows box (G1–G4, G8)**.

## Architecture
Everything before the link runs as **one-shot ssh commands with fixed scripts**: B has no node until install. The scripts are constants in `src/network/remote-scripts.ts`, with an sh family and a PowerShell family. Every value reaches them as base64 argv, never spliced into script text.

1. **Probe:** one command that works under sh, cmd.exe and PowerShell tells the families apart. A family-specific probe then reports os, arch, home, free disk, agent CLIs, logind/linger (Linux), and what Conduit is installed or recorded as running.
2. **Install, into `<B userData>/runtime/<version>.tmp/`:**
   - node and hc: B downloads them from the pinned URL and checks the SHA-256. If the download fails and B's platform equals A's, A pushes its own copies over ssh stdin and B checks the same pins.
   - The server JS is always pushed from A's runtime, with a per-file SHA-256 manifest that B checks.
   - Then the folder is renamed into place.
3. **Ensure:** B's freshly installed node runs `main.js --ensure-server`, a new headless mode. It does what the app's start rule does:
   - garbage-collect old versions;
   - start hc's core under the start method the probe chose;
   - start the supervisor as an hc terminal;
   - wait for C2 `hello` with the secret;
   - restart an older server;
   - print one JSON result line.

The pieces it needs move out of `electron/` into `server/` (spec §4.2.4). Electron then imports them from there.

## Data flow
```
A: C2 link.sshBootstrap{target} → bootstrapMachine(target)            server/network/bootstrap.ts
   1 ssh … -- target '<family probe>'          → parseFamily
   2 ssh … -- target '<sh|ps probe> <b64 args>' → parseProbe → planInstall(local, probe)
        attach | install | upgrade | unsupported | incompatible
   3 install (when needed):
        ssh '<download+verify script> <b64 pins>'          (B fetches node, hc; sha256 vs pins)
          └ fails and B's platform == A's → ssh '<receive script>' < A's node|hc bytes (verified by B)
        ssh '<receive-dir script> <b64 manifest>' < tar of A's runtime/server (B checks each sha256)
        ssh '<finalize script>' : <ver>.tmp → <ver> (atomic rename); a leftover .tmp is removed first
   4 ssh '<node> <runtime>/<ver>/server/main.js --ensure-server --user-data <dir> --start <method>'
        → B: gc → hc server start (wrapped per method) → terminal.run supervisor → C2 hello(auth)
             → server older? server.restart → {"ensure":{"state":"up","version","survivesLogout"}}
   5 result { os, arch, installed, upgraded, reused, survivesLogout, ssh: SshEndpoint }
   then manager.addSshPeer(ssh)  (slice 2)
```

## Settled decisions — do not re-litigate
- §4.2.3: the remote fetches the pinned node and hc and checks SHA-256; the push fallback uses the same pins; the server JS is always pushed from the local build; temp → verify → rename; retention per §7.
- §4.2.4:
  - An equal version that is running → attach.
  - Older → install, then its own `server.restart` (agents survive, ADR 0007).
  - Newer with the same link major → attach, never downgrade.
  - Another major → `incompatible`.
- RS-D9: win-x64 and linux-x64 remotes only. Anything else → `remote_unsupported`.
- RS-D11: one server per userData, shared with B's desktop app. The remote uses the same userData path the desktop app uses on B.
- RS-D14 + G7: the start method comes from linger and KillUserProcesses (below).
- RS-D5: Windows start is "attach to a server in the logon session, else a logged-on-only scheduled task". Built behind gates; pending a Windows box.
- §8: fixed scripts; values as base64 argv; no forwarding; nothing runs unverified.
- Slice 2 contracts stay as merged (`SshEndpoint`, `SshFailure`, `createSshDial`, `addSshPeer`, the C2 secret).

## Technical decisions this plan makes
1. **Family detection.** One command for every shell:
   `echo CONDUIT_FAMILY_$((1+1))_%OS%_$PSHOME`
   - sh → `CONDUIT_FAMILY_2_%OS%_`
   - PowerShell → `CONDUIT_FAMILY_2_%OS%_<path>`
   - cmd.exe → `CONDUIT_FAMILY_$((1+1))_Windows_NT_$PSHOME`

   `parseFamily(stdout) → 'sh' | 'powershell' | 'cmd' | null`. Under `cmd` the Windows scripts run as `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <b64 utf16le>`. Under `powershell` they run the same way, so one invocation form covers both.
2. **Value passing.** sh: the command is `sh -c '<script>' conduit <b64>…`. The script decodes `$1…` with `base64 -d`, and base64's alphabet is inert inside single quotes. PowerShell: the whole script plus a `$args`-style prelude of base64 values goes into `-EncodedCommand`.
3. **Remote layout** is the app's, so RS-D11 sharing works: `<B userData>/runtime/<version>/{node[.exe], server/…}` and `<B userData>/runtime/conduit-hc/<hcVersion>/conduit-hc[.exe]` (`coreStartCwd`). B's userData default is the desktop app's path for B's platform. Electron names it from package.json's top-level `name` (`conduit`), because `productName` sits only in the build config. Measured on this machine: the installed app uses `~/.config/conduit`. So on Linux it is `${XDG_CONFIG_HOME:-$HOME/.config}/conduit`, and on Windows `%APPDATA%\conduit`.
4. **Start method (Linux, from the probe's `kup` and `linger`, per gates.md G7):**
   - `linger === true` and `systemd-run` present → `scope`: `systemd-run --user --scope --quiet -- <hc> server start`. `survivesLogout = true`.
   - Else `kup === false` → `plain`: hc's own daemonized `server start`, which behaves like `setsid`. `survivesLogout = true`.
   - Else (`kup` true or unknown) → `plain` with `survivesLogout = false`. The result carries it, and slice 6's UI warns.

   **Unproven assumption:** that hc's self-daemonizing `server start` survives like `setsid` under KUP=no. The VM smoke (Slice 5) measures it. If it fails, the task stops and reports (deviation rule).

   **Measured (bootstrap-smoke.md):** hc 0.1.16 runs its core in `user@<uid>.service` units, and `hc server start` turns linger on for the user by itself. So on Linux the server survives logout exactly when linger is on after the start. KillUserProcesses does not matter once linger is on; with linger off, the user manager stops at the last logout and takes hc's units with it. `survivesLogout` is therefore measured after the start (`loginctl show-user -p Linger`, read after the hello), not taken from the probe. The `scope` method stays for start parity, but survival no longer depends on it.
5. **Windows start** (built, unverified): `windows-task`.
   - If a server already answers in the logon session (C2 hello), attach.
   - Else register a per-user scheduled task, "Run only when user is logged on", whose action is `<node> supervise …`, and run it.
   - `survivesLogout = false` by definition: it needs a logon.
   - The script lives in `remote-scripts.ts`. The ensure mode's `--start windows-task` path only waits for C2.
6. **Push transport:** ssh stdin.
   - **Files:** the raw bytes.
   - **The server dir:** a tar stream produced by node's own code (`src/network/tar-pack.ts`: a minimal ustar writer for regular files, ≤ 8 GiB each, no links). It is unpacked on B by the system `tar` (sh), or by the PowerShell script's `tar.exe`, which Windows 10 1803+ ships.
   - B checks every file against the manifest `{ path, sha256, size }[]`. Paths are relative, `/`-separated, with no `..` and no absolute paths, and B re-checks this before writing.
7. **Cross-platform push** (A linux → B windows) is out of this slice. A has only its own platform's node and hc. If B can't download, `install_failed { step: 'download' }` with the hint "B needs internet, or a controller on the same OS". Decisions Needed records it.
8. **Version record.** At start, after listen, the server writes `<userData>/server-version` containing `{"version":"<semver>","linkMajor":<n>}` (0600, atomic; the same writer as `link-endpoint`), and removes it on stop. The probe reads it as a hint only. `--ensure-server`'s C2 hello is authoritative.
9. **Moves (port tasks, behaviour unchanged):**
   - `electron/hc-cli.ts` `supervisorArgs`, `supervisorEnv` and `startSupervisor` move to `server/lifecycle/hc-supervisor.ts`.
   - `electron/runtime-gc.ts` `collectRuntimeGarbage` moves to `server/runtime-dir/gc.ts`.
   - `electron/` re-imports both. No electron import enters `server/`.
10. **Producer for slice 4:** C2 `link.sshBootstrap { target }` → `NetworkService.bootstrap(target)` → `AddSshPeerResult` extended with the bootstrap summary. Slice 4's `connect_machine` calls the same service method.

## Spec staleness
- §4.2.3 says "push the same pins over the channel" without saying which machine holds them. Measured: A holds only its own platform's binaries (`package.json` extraResources). See decision 7.
- §4.2.4 "the 'ensure the server runs' logic moves out of `electron/`". Measured: `electron/server-lifecycle.ts` is pure node with injected deps, but app-shaped (UI states, tray, presence). Only its hc/supervisor/GC primitives move (decision 9). The headless ensure is a new, smaller orchestration.

## Global constraints
- Gate: `npm run verify` (exit captured directly). Lanes run `node esbuild.mjs && npm run verify:quick`, then `npx fallow --skip health` (the dead-code section must show only the pre-existing react/react-dom lines), then `rm -rf out`.
- CI is ubuntu: posix-only tests use `it.skipIf(process.platform === 'win32')`. PowerShell script tests run only when `pwsh` is on PATH (`it.skipIf(!hasPwsh)`).
- Pure logic in `src/network/*.ts`; IO in `server/network/*.ts` and `server/lifecycle/*.ts`. ssh is spawned only through `server/network/ssh-dialer.ts`, plus a new sibling `server/network/ssh-exec.ts` for one-shot commands. Both share `sshArgv` (`src/network/ssh-argv.ts`).
- Comments explain WHY. No `as any`, no `as unknown as`, no `@ts-ignore`, no swallowed errors.
- Never kill by name. No GUI.
- Every ssh call made by tests or smoke runs under a timeout.

## Out of scope
- Machines registry, ControlMaster UI, the needs-person pane, MCP tools, permission asks (slice 4).
- UI warnings for `survivesLogout: false` (slice 6).
- Agent CLI install (slice 12).
- macOS/arm64 remotes (RS-D9 v1).
- Cross-platform push (decision 7).

## Contracts (pinned so the lanes agree; each owned by the first task that needs it)
`src/network/remote-scripts.ts` (T2.1):
```ts
export type ShellFamily = 'sh' | 'powershell' | 'cmd';
export const FAMILY_PROBE: string;                         // the decision-1 command
export function parseFamily(stdout: string): ShellFamily | null;
export interface RemoteCommand { command: string }        // the single string after `-- target`
export function probeCommand(f: ShellFamily): RemoteCommand;
export interface ProbeResult {
  os: 'linux' | 'windows' | 'other'; arch: 'x64' | 'arm64' | 'other';
  home: string; userData: string; freeBytes: number | null;
  kup: boolean | null; linger: boolean | null; systemdRun: boolean;   // linux only; null = unknown
  installed: string[];                                     // version dirs under runtime/
  recorded: { version: string; linkMajor: number } | null; // <userData>/server-version
  agents: string[];                                        // CLI names found on PATH
}
export function parseProbe(stdout: string): ProbeResult | { error: 'bad_probe'; detail: string };
export interface PinFile { url: string; sha256: string; dest: string; archive?: 'tar.gz' | 'zip'; stripComponents?: number; rename?: Record<string, string> }
export function downloadCommand(f: ShellFamily, o: { stagingDir: string; pins: PinFile[] }): RemoteCommand;
export function receiveFileCommand(f: ShellFamily, o: { path: string; sha256: string; size: number }): RemoteCommand;
export interface ManifestEntry { path: string; sha256: string; size: number }
export function receiveTreeCommand(f: ShellFamily, o: { dir: string; manifest: ManifestEntry[] }): RemoteCommand;
export function finalizeCommand(f: ShellFamily, o: { runtimeRoot: string; version: string }): RemoteCommand;
export type StartMethod = 'scope' | 'plain' | 'windows-task';
export function startMethodOf(p: ProbeResult): { method: StartMethod; survivesLogout: boolean };
export function ensureCommand(f: ShellFamily, o: { node: string; mainJs: string; userData: string; method: StartMethod }): RemoteCommand;
```
Every script ends by printing exactly one line, `CONDUIT_RESULT <json>`, where the JSON is `{ "ok": true, … }` or `{ "ok": false, "step": "download" | "checksum" | "disk" | "start" | "unpack", "detail": string }`. `parseResultLine(stdout)` (same file) extracts it.

`src/network/install-plan.ts` (T2.2):
```ts
export type InstallPlan =
  | { kind: 'attach'; version: string }            // recorded ≥ local, same major
  | { kind: 'install'; version: string }           // nothing usable there
  | { kind: 'upgrade'; version: string; from: string }
  | { kind: 'unsupported'; os: string; arch: string }
  | { kind: 'incompatible'; remote: string };
export function planInstall(local: { version: string; linkMajor: number }, p: ProbeResult): InstallPlan;
```
`attach` still runs ensure, which starts it if it isn't running. `install` and `upgrade` skip the copy when `p.installed` already holds `version`.

`src/network/tar-pack.ts` (T2.3): `packTree(files: { path: string; data: Buffer; mode: number }[]): Buffer` (ustar, regular files only); `manifestOf(files): ManifestEntry[]`.

`server/network/ssh-exec.ts` (T4.1):
`sshExec(o: { sshPath: string; sshArgsPrefix?: string[]; controlDir: string | null; target: string; command: RemoteCommand; stdin?: Buffer | Readable; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; failure: SshFailure | null }>`. It reuses `sshArgv` (with `-T`) and `classifySshFailure`. stdout is capped at 1 MiB. The timeout kills the child by its handle.

`server/lifecycle/ensure-server.ts` (T3.2): `runEnsureServer(o: { userData: string; method: StartMethod; version: string; stdout: Writable; … }): Promise<number>`. It prints `CONDUIT_RESULT {"ok":true,"state":"up","version":"…","survivesLogout":bool}` or `{"ok":false,"step":"start","detail":…}`. Exit 0 or 3.

`src/contracts/ssh-link.ts` gains (T4.2):
```ts
export interface BootstrapSummary { os: 'linux' | 'windows'; arch: 'x64'; installed: boolean; upgraded: boolean; reused: boolean; survivesLogout: boolean; version: string }
export type BootstrapResult =
  | { ok: true; machineId: string; ssh: SshEndpoint; summary: BootstrapSummary }
  | { ok: false; error: SshFailure | { code: 'remote_unsupported'; os: string; arch: string } | { code: 'install_failed'; step: 'download' | 'checksum' | 'disk' | 'start' | 'unpack'; detail: string } | { code: 'peer_incompatible'; remote: string } | Extract<AddSshPeerResult, { ok: false }>['error'] };
```
`ServerMethods['link.sshBootstrap']: { params: { target: string }; result: BootstrapResult }`.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides |
|---|---|---|---|
| `server-version` record | server start (`server/main.ts`, after listen) / stop | the probe script on B | both |
| `--ensure-server` mode | `server/main.ts` → `ensure-server.ts` | `bootstrap.ts` via ssh | both |
| moved supervisor/GC helpers | `server/lifecycle/hc-supervisor.ts`, `server/runtime-dir/gc.ts` | `electron/server-lifecycle.ts`, `electron/main.ts` (re-import); `ensure-server.ts` | both (port; existing tests stay green) |
| `link.sshBootstrap` | `server/network/c2.ts` → `NetworkService.bootstrap` | e2e now, slice 4 later | both |
| remote layout on B | install scripts | B's server, B's desktop app (RS-D11) | both: same layout as `prepareRuntime` (measured `server/runtime-dir/prepare.ts:55-104`) |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `server/lifecycle/hc-supervisor.ts` | create (moved) | `supervisorArgs`, `supervisorEnv`, `startSupervisor` from `electron/hc-cli.ts` |
| `electron/hc-cli.ts` | modify | re-import the moved functions; keep the rest |
| `server/runtime-dir/gc.ts` | create (moved) | `collectRuntimeGarbage` from `electron/runtime-gc.ts` |
| `electron/runtime-gc.ts` | delete | moved |
| `electron/main.ts` | modify | imports only |
| `src/server-secret.ts`, `server/lifecycle/server-secret.ts` | modify | `SERVER_VERSION_FILE`, `readServerVersion`, `writeServerVersion`, `removeServerVersion` |
| `server/main.ts` | modify | write/remove `server-version`; `--ensure-server` dispatch (before listen, like `--link-stdio`) |
| `server/lifecycle/ensure-server.ts` | create | headless ensure (decision 3/4) |
| `src/network/remote-scripts.ts` | create | fixed scripts, builders, parsers |
| `src/network/install-plan.ts` | create | `planInstall` |
| `src/network/tar-pack.ts` | create | ustar writer, manifest |
| `server/network/ssh-exec.ts` | create | one-shot ssh |
| `server/network/bootstrap.ts` | create | `bootstrapMachine` orchestration |
| `server/network/index.ts` | modify | `NetworkService.bootstrap` |
| `server/network/c2.ts`, `src/contracts/server-protocol.ts`, `src/contracts/ssh-link.ts` | modify | `link.sshBootstrap`, result types |
| `test/e2e/fixtures/fake-ssh.cjs` | modify | a remote string that is not POSIX-quoted runs through the platform shell (`/bin/sh -c` or `cmd.exe /d /s /c`) |
| `test/e2e/net-ssh-bootstrap.e2e.mjs` | create | bootstrap B into a fresh userData over fake-ssh (push path forced by `CONDUIT_E2E_NO_DOWNLOAD=1` under `--e2e`), then link and message |
| tests per task | create | |

## Slices

### Slice 1: moves and the version record (one lane, serial)
**Check:** every existing test in `test/unit/server-lifecycle.test.ts`, `test/unit/hc-cli.test.ts` and the runtime-gc test passes unchanged except for import paths. New `server-version` tests pass. `npm run verify:quick`.
- **T1.1 (port):** move `supervisorArgs`, `supervisorEnv` and `startSupervisor`, and `collectRuntimeGarbage`, as in the file map. Proof: the existing suites stay green, with only the import-path lines changed in tests.
- **T1.2:** add the `server-version` record (decision 8), written right after the link-endpoint record and removed on stop. Red-first tests: the record holds the version and the link major, mode 0600 (posix), and is gone after stop.

### Slice 2: pure remote logic (parallel with Slice 1; file-disjoint)
**Check:** `npx vitest run test/unit/remote-scripts.test.ts test/unit/install-plan.test.ts test/unit/tar-pack.test.ts`.
**Parallel groups:** G1: T2.1 · G2: T2.2 + T2.3 (one executor).
- **T2.1 `remote-scripts.ts`:**
  - `parseFamily` covers all three samples from decision 1.
  - The sh scripts are **executed in tests** with real `sh` against temp dirs:
    - the probe on this host gives a sane `ProbeResult` (linux, x64, `installed` reads a planted runtime dir, `recorded` reads a planted `server-version`);
    - download is tested with `file://` pins. Use `curl -fsSL` when present, else `wget -q -O`. For tests, a pin URL that is a local path is copied with `cp`: the script treats a URL without `://` as a local path, and **this is test-only behaviour gated by a script argument `allowLocal=1` that bootstrap never sets**. A checksum mismatch → `{ok:false, step:'checksum'}`, and the staging folder is removed;
    - receiveFile with a wrong sha → `checksum`;
    - receiveTree refuses a manifest path containing `..` or starting with `/`;
    - finalize renames `<v>.tmp` → `<v>`, and if `<v>` already exists it removes the tmp and succeeds.
  - PowerShell scripts: builder output is snapshot-tested. They are executed under `pwsh` only when present.
  - `startMethodOf` gets one row per G7 combination (decision 4).
  - Injection tests: values containing `'`, `$()`, a backtick, a space or a newline round-trip as data.
- **T2.2 `install-plan.ts`:** every branch of `InstallPlan`, including a newer same-major recorded version → attach (never downgrade), another major → incompatible, and arm64 → unsupported.
- **T2.3 `tar-pack.ts`:** the output unpacks with the system `tar -x` to identical bytes and modes, and the manifest sha256 values match.

### Slice 3: headless ensure (after Slice 1)
**Check:** `npx vitest run test/unit/ensure-server.test.ts`. A real-process test: run `--ensure-server` against a temp userData using the vendored hc (`build/vendor/hc`, skipped if absent) and `out/server`. It prints `CONDUIT_RESULT {"ok":true,"state":"up",…}`, a second run is idempotent (still up, one supervisor), and teardown uses `--stop-all` with auth.
- **T3.1:** add `--ensure-server` dispatch in `server/main.ts`. Validate `--start scope|plain|windows-task`, else exit 2 with usage on stderr.
- **T3.2 `ensure-server.ts`:**
  1. `collectRuntimeGarbage(runtimeRoot, { appVersion: version, hcVersion })`.
  2. `startCore`, wrapped for `scope` (decision 4) as an argv prefix, never a shell.
  3. `startSupervisor` (moved helper). A `name_taken` result means one is already live.
  4. Poll C2 hello with the secret for up to 30 s.
  5. Compare versions with `versionOrder`:
     - appNewer (our version is newer than the running one) → `server.restart`, then wait for the new hello;
     - appOlder → `{ok:true, state:'up', version: <running>}` (never downgrade);
     - same → up.
  6. Print the result line.
  - `windows-task`: only steps 4–6. The task is registered by the PowerShell script before ensure runs.
  - Red-first unit tests with fakes for each branch.

### Slice 4: controller bootstrap + C2 (after Slices 2 and 3)
**Check:** `npx vitest run test/unit/ssh-exec.test.ts test/unit/bootstrap.test.ts test/unit/network-service.test.ts`, plus `npm run e2e:remote -- net-ssh-bootstrap net-ssh-link` and affected.
- **T4.1 `ssh-exec.ts`:** use fake-ssh.cjs for success, stdin bytes, the timeout kill, and failure classification.
- **T4.2 `bootstrap.ts`:** the decision-flow diagram above. Inputs: `{ target, local: { version, linkMajor, platform: 'linux'|'win32', arch }, runtime: { nodeExe, serverDir, hcExe } (A's own, from RuntimeLayout/prepareRuntime), exec: typeof sshExec, now }`.
  - The push reads A's files and packs `serverDir` with `packTree`.
  - Concurrent calls for one target share one promise.
  - Every failure maps to `BootstrapResult` errors. A leftover `.tmp` is removed at the next probe, by the finalize script's pre-step (spec §6).
  - Unit tests drive a fake `exec` that interprets the RemoteCommands: install, upgrade, attach, unsupported, incompatible, a download failure with push fallback on the same platform, a download failure on a different platform → `install_failed download`, a checksum failure, and an interrupted install whose next run cleans the tmp.
- **T4.3 wiring:**
  - `NetworkService.bootstrap(target)` runs bootstrap, then `addSshPeer(result.ssh)`, and returns `BootstrapResult` with the machineId.
  - C2 `link.sshBootstrap` validates `target` with `sshArgv`'s allowlist (the same rule).
  - `CONDUIT_E2E_NO_DOWNLOAD=1` is honoured only under `--e2e` (as `CONDUIT_E2E_SSH_ARGS_PREFIX` is) and forces the push path.
  - fake-ssh's platform-shell fallback.
  - The e2e `net-ssh-bootstrap`:
    1. A bootstraps a fresh B userData over fake-ssh: `installed: true`, B's `runtime/<v>/` exists, and B's server answers.
    2. A second bootstrap gives `reused: true` with nothing reinstalled.
    3. A message A→B is delivered.
    4. Teardown stops B with `--stop-all` (auth).

  On the Windows runner this exercises the PowerShell scripts through `cmd.exe`, a partial G4 signal; record it as such, not as G4.

### Slice 5: real-sshd smoke on the Linux VM (orchestrator)
Not a lane. On the local VM:
1. Fresh user dir, then `link.sshBootstrap { target: 'vm' }` from a local A, which downloads from nodejs.org/herdr on the VM (internet), checks pins, starts, and links.
2. Bootstrap again → reused.
3. **Logout survival**, each followed by `loginctl terminate-user` (with sudo) of every session other than the check session, or a reconnect after all sessions close, then a check that B still answers:
   - KUP=no, linger on → method `scope`, survives;
   - KUP=no, linger off → `plain`, survives (this proves decision 4's assumption about hc's daemonizing);
   - KUP=yes, linger off → `plain` with `survivesLogout:false`, and B dies at logout.
4. An upgrade: plant an older version record and runtime dir, bootstrap, and observe `upgraded` and `server.restart` with agents surviving.
5. Restore the VM defaults.

Report to `docs/runs/2026-11-16-CON-35/bootstrap-smoke.md`.

## Verification
- Per task: the named vitest files.
- Per lane: verify:quick, fallow dead-code, `rm -rf out`.
- After each merge: the orchestrator runs `npm run verify`.
- After Slice 4: `e2e:remote` affected plus `net-ssh-bootstrap`.
- Slice 5 is the Linux runtime proof. Windows runtime stays **pending: Windows box** (G1–G4, G8).

## Deviation rule
If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece becomes the work. Examples: hc's `server start` doesn't daemonize, the desktop userData name differs, or a moved function has an electron dependency. Never a shim, a second copy, a special case, a widened type or a fallback routed around it. The report leads with the fix that keeps the locked decision.

## Decisions Needed
- [normal] Cross-platform push (A linux → B windows without internet) is out. Default taken: `install_failed download` with a hint. A later card can let A fetch the other platform's pins itself.
- [normal] `survivesLogout: false` (KUP=yes without linger) still starts the server and reports it; enabling linger needs admin, so it's the owner's call (RS-D14). Default taken.
- [high] Windows start (RS-D5 scheduled task) is unverified until G1/G2/G8 run on a Windows box.
