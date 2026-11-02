---
status: active
date: 2026-11-01
revision: 9.2 (review history in §Changelog)
---

# Three-process architecture — boundaries, flows, decisions

**Implementation status (2026-11-02):** built on `feat/three-process`, unreleased; ADR 0007 §As
built lists the deviations. Entry points: `server/main.ts` (server entry), `server/supervise.ts`
(supervisor), `server/services.ts` (service composition), `electron/server-lifecycle.ts` (the
app's start rule and reconnects), `electron/terminal-host.ts` (the app's observer panes).

This is the design behind ADR 0007. Workstreams are in `2026-11-01-three-process-program.md`, the
contracts in `src/contracts/`. It says **who owns what, how the flows cross the boundaries, and why**.
Every decision lists its trade-off.

## Goals, quality attributes, non-goals

**Dominant quality attributes, in order:**
1. **Durability.** Agents and their MCP identity survive app quit, app crash (including *End task*
   and tree-kill), app update and server restart.
2. **No UX regression.** Every pane, scrollback replay, approval card, notice and attention signal
   behaves as in v0.51. The editor works even when the terminal engine or the server doesn't.
3. **Containment.** Conduit's policy governs MCP tool calls; agents with a shell can also reach
   Conduit's hc session directly (D16). Every residual path is written down.

**Reuse hc first (D33).** If herdr-core already provides something, Conduit uses it and does not
rebuild it, unless a stated need forces otherwise. The audit is in §Reuse audit.

**Non-goals for this program:**
- Remote machines.
- A second client.
- New MCP tools (`spawn_agent`, `wait_for`, child notes, cascade close).
- Agents surviving a **reboot**. With `keep:false` nothing comes back after a reboot. Sessions are
  `stale` with their scrollback replayed on relaunch, as today, and conversation resume is separate
  work.
- A node-pty fallback inside the new topology. Rollback means not merging the branch (D6).
- Renderer backpressure. hc stream credit is granted when bytes are handed onward, not when xterm
  has rendered them, exactly as today's node-pty path has none: the app grants on hand-off to IPC,
  the server on append to the ring (D20).

**Cold-launch budget:**
- The window paints within today's time + 300 ms. It never waits for the server: it reads only its
  own `settings.json`, whose server keys are the mirror (D7).
- Terminals are ready ≤ 3 s after the window on a warm machine. The first-launch runtime copy under
  Defender is measured against this in M16.

## Ownership rule

> **The server owns everything that must keep working, or stay true, while no window is open.
> The app owns everything about showing and editing.**

| Server (Node daemon) | App (Electron) |
|---|---|
| Session records, **titles** (from hc `title` events, the only producer), cwd, order, scopes, relaunch, **scrollback ring + files** | Windows, layout, **session→window map** (mirrored to the server) |
| Spawn specs, agents registry, launchers, role briefs | Native dialogs, the brief dialog on human-opened sessions |
| Projects, timed messages + limit offers | Editor, Monaco, LSP, Workspace Trust |
| MCP host, inbox, threads, attachments, handles, **token store**, **CLI install entries** | Repo tracking, git, Review, board/plan/architecture files |
| Tool policy, approvals, rate limits | Approval cards, Messages tab (views of server state) |
| Attention and bells (W6); the limit-notice scan and its offers (W4) | OS notifications, flashFrame, attention chip |
| **The only active viewer and the only PTY writer** (D19): size, facts; keystrokes (xterm's focus reports included), notices, timed messages, add-dir paste through one PtyWriter; draft state and the typed tracker | xterm sizing, then **requests** that size; forwards keystrokes and facts (`term.*`) |
| **Server settings** (`ServerSettings`): sole writer of `server-settings.json`, written atomically, private to the server (D7) | **UI settings** (incl. `osAttention`, `logging`, `logLevel`): sole writer of `settings.json`, where it also mirrors the server keys, its only source for them before the snapshot (D7, D25) |
| hc client: spawn, **active attach**, read, label, kill, rm | hc client: attach as an **observer**; the supervisor start and the explicit `hc kill` of it (§hc invariants) |

`docs/runs/2026-11-01-three-process-design/main-ts-ownership.md` splits `main.ts` message by message,
and its internal subscribers subscriber by subscriber (§Internal subscribers).

## Processes and installs

```
<install dir>/Conduit.exe                    app (Electron). Never long-lived outside the app itself.
<userData>/runtime/shim/node.exe + shim.cjs  every MCP shim. WRITE-ONCE path (D2b).
<userData>/runtime/<appVersion>/node.exe     server/supervise.js → server/main.js, an hc terminal (D17).
<userData>/runtime/hc/<hcVersion>/hc.exe     hc core + holder, HC_SESSION=conduit-<h>.
```

- **Preparation.** On a version's first launch the app copies `node.exe`, `server/` and the bundled
  hc. Each target is copied to `<dir>.tmp` and then renamed, so a crash mid-copy never leaves a half
  dir.
- **Shim path.** `runtime/shim/` is written once and never swapped: its `node.exe` and `shim.cjs`
  are immutable. A future shim Node or protocol change goes to a new path (`runtime/shim-2/`) with a
  migration of the CLI config entries; shims already running keep running from the old path. Every
  CLI config entry and per-launch argv points at the current shim path.
- **Liveness and GC (D23).** There are no leases: Node 24 exposes no `fs.constants.UV_FS_O_EXLOCK`
  (measured: undefined). A dir is in use exactly when renaming it to `<dir>.gc` fails. Every
  long-lived process runs with its cwd in its runtime dir and its exe image mapped from it; hc's core
  and draining holders are covered by their mapped images. Only the app runs GC, at startup, under
  Electron's existing single-instance lock (keyed by userData); there is no GC lock file. A dir that
  renames is deleted. The newest two are kept.
- **The server is pure JS.** No native modules: hc owns the PTYs, and `@xterm/headless` is JS. The app
  no longer loads node-pty.
- **Instance names (C4).** `<h>` = the first 16 hex chars of
  `sha256(win32 ? userData.toLowerCase() : userData)`, exactly as `src/conduit-mcp/endpoint-path.ts`
  does today. One algorithm for `\\.\pipe\conduit-server-<h>` (also the server's single-instance
  lock, D17), `\\.\pipe\conduit-mcp-<h>` (unchanged from v0.51), `HC_SESSION=conduit-<h>`, uninstall
  and the CLI-entry migration, and for the supervisor's unique hc name `conduit-server-<h>`. Each e2e
  userData therefore gets its own server and hc session. On POSIX (unit tests on ubuntu CI) the
  server lock mirrors `endpoint-path.ts`: `<userData>/conduit-server.sock`, or
  `<tmpdir>/conduit-server-<h>.sock` past the `sun_path` limit; since a socket file outlives a
  crashed owner, an `EADDRINUSE` whose connect is refused unlinks it and binds again (C4).
- **hc invariants**, kept by every hc call the server makes:
  - `terminal.run` always gets `no_parent`, `no_notify`, `keep:false` and `name: <launchId>`. hc
    refuses a second **live** terminal with that name, but a finished one frees it, so a name is never
    run twice: a core connection lost before the reply leaves the launch `unconfirmed`, and a new
    launch gets a new id (D21). A spawn resolves on the reply or the connection loss, never on a
    clock. `terminal.send` is never used (D19).
  - Labels: `conduit.session`, `conduit.instance`, `conduit.generation`, `conduit.launch`,
    `conduit.role`. Labels only narrow subscriptions; identity comes from the token row (D21), and
    the supervisor is identified by its unique name, never by `conduit.role=server` (D17).
  - **One core-start env builder** (`coreStartEnv`, C4), used by the app's supervisor start and by
    the server's hc client alike: `HC_*` stripped (case-insensitively), `HC_SESSION=conduit-<h>`, our
    XDG dirs (unless M22 fails), and the user's own XDG values captured once into
    `CONDUIT_USER_XDG_*` and passed through, so session specs restore them (D24). `hc run` always
    gets `--bg --no-parent` (`CORE_START_RUN_FLAGS`).
  - `HC_*` is stripped from the server's environment and from the specs it passes. hc still injects
    its own; see D16.
  - **The app's own hc calls** (the supervisor start, `hc kill` of the supervisor, observer
    attaches) use that builder's env; `--no-parent` is `hc run`'s flag per `hc run --help` on 0.1.16.
    A Conduit launched from inside a Conduit or Herdr pane therefore never lands in, or is parented
    to, that pane's session (M17).
  - Our core runs with `XDG_CONFIG_HOME=userData/hc/config` and `XDG_STATE_HOME=userData/hc/state`.
    Session specs have XDG_* overrides stripped and the user's own values (`CONDUIT_USER_XDG_*`)
    restored (D24). **Only if
    M22 passes:** if hc on Windows ignores `XDG_CONFIG_HOME` (its documented config is
    `%APPDATA%\herdr-core\config.toml`) or panes inherit our values (`terminal.run.env` can't unset
    one), Conduit sets no `XDG_*` for its core, which then shares the user's `%APPDATA%\herdr-core`
    config and templates (D24).
  - The server holds one **non-observe** attach per live session, from spawn or adopt until exit. A
    re-attach (server restart, core reconnect) passes the hc record's current `cols`/`rows`,
    `resumed: true` and `history: 2000`, so a reconnect never resizes a PTY. The app attaches with
    `observe: true, history: 2000`.
  - Status words are kept verbatim at the wire (C3) and mapped for the domain: `idle`, `working`,
    `done`, `error`, `blocked` to C1's `ReportedStatus`; `kind` `permission`/`question`/`auth`, else
    `null`. Any other state word means no status.
  - **Outcomes are recorded as soon as hc reports them.** hc is not a store: in pinned v0.1.16 a
    `keep:false` run that times out loses its record (`run.rs`), and finished records are pruned after
    a day or past 500 (`terminals.rs`, `expired`). Conduit records each exit, with the final output
    of a program that ended before the attach, or before a reconcile re-attach (`terminal.read`), then
    `terminal.rm`s it.
- **Uninstall.** `customUnInstall` runs only under `${ifNot} ${isUpdated}`, because the
  electron-builder template calls it during every update too. It prompts first, since this ends
  agents; cancelling cancels the uninstall. A silent uninstall stops agents without a prompt. It runs
  the newest `runtime/<v>/node.exe server/main.js --stop-all --user-data …` present, a C2 client that
  calls `server.stopAll` (F12). Two separate bounds (C2):
  - **No server:** no connection or no `hello` answer within `STOP_ALL_CONNECT_TIMEOUT_MS` (5 s), or
    the connection closes before the reply. Only then does it work against hc directly: it kills the
    labelled `conduit.role=session` terminals, then runs `hc server stop`, but only if no unlabelled
    terminal remains.
  - **Accepted stop:** once `server.stopAll` is written on a live connection, it waits up to
    `STOP_ALL_ANSWER_TIMEOUT_MS` (20 s), longer than the whole transition
    (`LAUNCH_SETTLE_ON_STOP_MS` + `STOP_KILL_PERSIST_BUDGET_MS`, `STOP_TRANSITION_BUDGET_MS`). Past
    it, still connected, it reports that agents could not be stopped and never touches hc, which
    would race the server's own cleanup.

## Connections

```
app main ──C2 JSON-RPC lines (incl. term.input/resize/facts)──► server ──C1──► C3 hc client ──► hc core ◄─ holder ◄─ PTYs
   └──C5 TerminalLink: hc attach as an OBSERVER (framed), output only ◄──────────────────────────────┘   │
agent CLI ─stdio─► shim (runtime/shim) ─C6 frozen, token hello, resume─► server MCP endpoint           │
server/main.js ◄── non-detached child (libuv kill-on-close job) of server/supervise.js, name conduit-server-<h> ┘
```

Inside the server, the W4/W5/W6 seams are C7 (`src/contracts/server-ports.ts`), wired only in the
lead-owned `server/compose.ts` (D27), which also forwards `AttentionPort.onEdge` to C2
`attention.edge` and merges `AttentionPort.statusOf` into every `sessions.changed`. The MCP host is
one module of the server process behind those ports (D35).

**C2 is unauthenticated** to same-user processes: a plain `listen` with libuv's default pipe DACL, so a
shell agent can call it (approve its own asks, flip policy). Accepted residual (D16); `hello.auth` is
reserved for a later credential, and M28 checks that the Node pipe server rejects remote clients.

**Cross-version edges.** These four are the only places an older and a newer build meet (D12):
- **shim ↔ server**: C6, frozen.
- **app ↔ server**: only `hello`, `server.restart` and `server.stopAll`. A mismatch restarts the
  server, **unless the app is older** (D26). Within a generation their fields only grow by optional
  ones, and readers ignore fields they don't know; the frozen test pins the required fields.
  **Order** (`versionOrder`, C2): `SERVER_PROTOCOL_GENERATION` first, then the semver of the app and
  server versions; a release outranks its own pre-release.
- **app/server ↔ hc core**: feature detection. A core is compatible when its `hello.generation`
  matches and `hello.methods` contains the C3 subset; `HC_MIN_CORE_VERSION` is the oldest core known
  to serve that subset (D30).
- **server ↔ its persisted formats** (§Persisted formats): each versioned format keeps its own
  existing version field, listed in `SERVER_FILE_VERSION` (C4); readers ignore unknown fields, and
  `judgePersistedVersion` says `newer` for a newer version: that file is unreadable for the run and
  never overwritten. A newer token store is `degraded: 'token store unreadable'` (D21). The
  unversioned formats are listed as exceptions.

## Flows

**F1 Cold launch.**
1. The app paints the window from `settings.json` alone, and shows terminals as "starting". The
   server keys there are its mirror (D7); on the first v0.52 launch they are v0.51's own values. The
   app never reads `server-settings.json`.
2. It prepares the runtime dirs, runs GC, and connects to the server pipe.
3. **Start rule (D17).** The supervisor is the only component that restarts the server; the app only
   ever *starts* one, and only when no live terminal named `conduit-server-<h>` exists **and** there
   is no `userData/server-exhausted.json`. Then it starts the supervisor **through hc**:
   `runtime/hc/<v>/hc.exe run --bg --no-parent --name conduit-server-<h> --label conduit.role=server … -- runtime/<v>/node.exe server/supervise.js --user-data <dir>`,
   with the `coreStartEnv` env (§hc invariants). That command starts our hc core if needed; hc
   detaches and breaks away from any job. The supervisor reads its own address from the injected
   `HC_TERMINAL_ID` before stripping `HC_*`, and passes it to the server, which reports it as
   `hello.supervisor{name, terminal}`; the app checks a live `conduit-server-<h>` against it. If hc itself
   can't start, the app spawns the supervisor directly and detached, and the server reports
   `runtime: unavailable`. The editor still works. With a marker present, the app goes to F1.6
   instead.
4. Server startup. The server binds its pipe before any slow work, so the app's 20 s `hello` timeout
   bounds only "is a server up", and the server bounds its own startup (D17):
   1. **Lock = the pipe.** `server.listen('\\.\pipe\conduit-server-<h>')` creates the first pipe
      instance (libuv's default for a pipe name); a second listen fails with `EADDRINUSE` (measured on
      Node 24.18). Losing the bind means another server owns this userData: exit 0. There is no lock
      file and nothing is ever killed by pid.
   2. Serve C2 at once with `runtime: starting`. `hello` is answered immediately and carries no
      readiness. Logging uses its defaults until the app's first `server.setLogging`.
   3. Load records and server settings, each versioned file through `judgePersistedVersion`
      (§Persisted formats). On its first v0.52 run it reads v0.51's `settings.json` server keys once
      and writes `server-settings.json` atomically (D7). With `restoreSessions: false`, only
      sessions with a live or unconfirmed terminal are loaded; the rest are not reopened (D40).
   4. Connect to hc. An incompatible core goes to F11 (D30).
   5. `events.subscribe` by `conduit.instance`, then `reconcile()` (D21, D22): matched sessions become
      `running` under the server's active attach, unresolved launches stay `unconfirmed`, the rest
      `stale`, and token hashes rebind. Subscribing first means a launch that registers later is
      adopted from its event.
   6. Start the MCP endpoint, restore persisted CLI bindings (D28), and set `runtime: ready`. While
      runtime is `degraded: 'token store unreadable'`, the endpoint welcomes every hello with
      `draining`, so shims keep retrying; `unknown_token` is sent only after a clean store load (D21).
   7. **Startup deadline.** If runtime hasn't left `starting` within `SERVER_STARTUP_DEADLINE_MS`
      (30 s), the server sets `unavailable: 'startup timeout'` and keeps trying in the background. It
      never restarts itself, and the app only displays the state: it is not another restart authority.
5. The app calls `hello` (20 s timeout), then `events.subscribe`. The snapshot carries sessions,
   server settings, stores, timers, MCP UI state, pending asks and runtime health. The app pushes
   `server.setLogging{logging, logLevel}` on connect and on every change, and on every
   `serverSettings.changed` mirrors the server keys into `settings.json`, as that file's only writer,
   so an older build reads current values (D7, D26). It then sends `ui.presence`, a `term.resize` and
   `term.facts` per open pane, and attaches each pane as an observer.
6. **Server unavailable (D25).** With an exhaustion marker, or when `hello` still gets no reply, the
   app enters `server: unavailable`: a banner with the log path and **Retry**, server settings
   read-only from its own mirror in `settings.json`, UI settings working, terminals and MCP off,
   editor and everything else working. **Retry** deletes the marker, then applies the start rule
   (F1.3); a supervisor still cooling down (F9) sees the marker gone within
   `SUPERVISOR_MARKER_POLL_MS` and retries at once, so the start rule finds it live. The app never kills a server or supervisor by itself. A hung server is recovered only by
   an explicit action, **Restart Conduit's background service**: `hc kill` of the terminal named
   `conduit-server-<h>` (with the app's hc env rule, §hc invariants), then F1.3.

**F2 Open a terminal pane.**
1. The renderer posts `term:start{cols,rows}` (unchanged), preceded by the new lead-owned
   `term:facts{sessionId, facts}` (W7 implements it). Its xterm already has that size.
2. The app sends `term.resize{sessionId, cols, rows}` and `term.facts{sessionId, facts}`, then
   `sessions.start{sessionId}`. C2 is one ordered pipe, so size and facts reach the server first; it
   keeps the last of each per session. The server keeps one start in flight per session, and refuses
   it with `server_stopping` while stopping (D32). **Error channels:** `sessions.start` and
   `sessions.retryLaunch` refuse only in their result (`ok: false`); `sessions.create` refuses only as
   an RPC error; MCP opens, which are not C2 calls, refuse in MCP's tool-result envelope (F3). A start that never spawns also shows its text (today's can't-start
   line) through `ScrollbackPort.show` → C2 `term.show`, before the reply.
   **Already live:** the reply is `spawned: false` with no prelude; the app attaches as an observer
   with `history: 2000`, and no second `terminal.run` happens. Otherwise:
   1. **W4 allocates** `generation` and `launchId` through C7 `SessionStorePort.allocateLaunch`, the
      single producer: it increments the session record's persisted `lastGeneration` (sessions.json),
      so a generation is never reused after a server restart.
   2. W4 calls W5's C7 **`LaunchPort`**: `whenLaunchReady()`, then
      `prepareLaunch(sessionId, def, spec, {generation, launchId})`. W5 resets the session's
      per-launch host state, reserves the token row through its own `TokenStorePort.reserve` (hash,
      generation, launch id, state `reserved`, `hcAddress: null`, persisted before the run; a previous
      `unconfirmed` row becomes `superseded`), and injects the MCP env and argv (shim path). W4 never
      calls `TokenStorePort`.
   3. W4 calls C1 `spawn(sessionId, spec, labels, {generation, launchId})`; W6 never derives either
      id from labels. W6 runs `terminal.run` with `name: <launchId>` and `conduit.launch=<launchId>`:
      - **Reply:** the launch is resolved. `resolveAddress` makes the row `live`; W6 takes the active
        attach at the requested size (else hc's default) with the last facts as `display`, held until
        exit. Its first paint is `paint{cause:'attach'}`.
      - **The program ended before that attach** (hc attaches only to live terminals): W6 reads its final output with
        `terminal.read`, appends it to the ring, records the exit at once and returns `finished`.
      - **Core connection lost before the reply:** the row becomes `unconfirmed` and
        `sessions.start` returns the refusal `spawn_unconfirmed`. No clock resolves a spawn: a
        timeout would only manufacture unconfirmed launches for slow runs. Nothing retries it,
        nothing lists hc and retries, and absence never revokes it (D21). A terminal with that name
        registering at any later time is adopted (late confirmation). The session shows **Retry
        launch** / **Discard** (`sessions.retryLaunch`, `sessions.discardLaunch`).
   4. Returns `{target, generation, prelude?}`, or `{finished: {exitCode, reason}, prelude}` for a
      program that already ended. `prelude` comes from C7 `ScrollbackPort.replayForColdStart` (W6)
      with today's semantics: the in-memory ring first, and the replay's tail recorded. It holds the
      stored scrollback when a stale session cold-spawns, framed `ESC7…ESC8` as today, and for a
      finished start the output `terminal.read` gave. The relaunch marker, ConPTY replay padding and
      role-brief banners are host-composed bytes: W4 sends them through `ScrollbackPort.show`, which
      appends them to the ring and emits `term.show` (D18).
3. The app writes `term.show` bytes and `prelude` into the xterm, then attaches as an observer with
   `history: 2000`. hc's first paint follows. A `finished` start shows as an exited session with its
   output; the app attaches nothing. **Status comes only from `sessions.changed`:** a CLOSE on an
   observer link is never read as an exit (an in-place `sessions.restart` retires the old process,
   keeps the status `running` and bumps `restartSeq`; the remounted pane's `sessions.start` spawns).
4. A program that painted before the server's first attach gets one repaint (M14).
5. **Keystrokes** go renderer → app main → `term.input{sessionId, generation, data}` → the server's
   `onRendererInput` (`detectTyped`, `nextDraftState`, `inputSeq`, attention via C7, `mgr.touch`) →
   its PtyWriter's raw write → hc. **Focus** has one producer, as today: xterm's own focus-report
   bytes inside `term.input`; the server never sends FOCUS frames. **Resize and facts** go
   `term.resize` / `term.facts` → the server's attach. The move-window swallow stays in the app.
6. **Input while C2 is down (D29).** The app **drops** keystrokes while C2 is disconnected and never
   buffers them, since a late keystroke could answer a prompt nobody saw. The pane shows
   "Reconnecting — input paused" until C2 is back.

**F3 Spawn without a window.** MCP `open_session`/`open_terminal`, relaunch-all and timed messages
use the same server-internal create and `sessions.start`. The server emits `sessions.opened` for
placement **before** the `sessions.changed` that first lists the session, so the app applies
`focus: false` (today's `suppressAutoSwitch`) before showing it; a session created while no app ran
goes to the focused (else first) window at launch. The
server's attach keeps hc's default size until an app requests one, and passes the session's last
known facts as `display`, or none.
- **The tool gate splits server actions from window actions** (D8). Server actions (`open_session`,
  `open_terminal`, `close_session`, `attach_folder`, plus messaging) run with no ready owner window
  when policy resolves to `on` (`when: viewing` still refuses a caller that isn't on screen). Window actions (`open_file`, `close_files`, `open_review`,
  `open_git_history`, `open_url`, `focus_session`) still need one, else `window_not_ready` /
  `ui_unavailable`. `ask` still needs a window: denied after the 5 s grace. The split is W0b's change
  to `gateToolCall` (`src/conduit-mcp/tool-policy.ts`) on `main`; in v0.51's topology it only changes
  behaviour during a window's not-ready instant.
- **An MCP spawn that can't confirm** returns the tool error `spawn_unconfirmed` with a structured
  `sessionId` (C7 `DomainOpenOutcome`) to the calling agent; one during the stopping transition
  returns `server_stopping` (retryable). These travel in MCP's tool-result envelope; C2 refuses
  through RPC errors and start results instead (F2). To try again the agent first calls
  `close_session` on that session, which discards the unconfirmed launch (its row revoked: killed on
  its `created` event if it registers late), then opens a new one, so a late registration never
  leaves two agents running. Left alone, the unconfirmed one keeps Retry launch / Discard for a
  person and is adopted if it registers late (D21).
- **`close_session` without a window.** The server-local close is C7 `DomainPort.closeSession`
  (shared with C2 `sessions.remove`): kill or retire the terminal, revoke its tokens, remove the
  session. W0b changes the handler (`src/conduit-mcp/app-control-tools.ts`): with the target's owner
  window ready it keeps today's renderer close and dirty-buffer check (`unsaved_changes` on any dirty
  buffer; the tool has no force option today); with no ready window it calls `closeSession` with no
  dirty check, since editor buffers live only in an open app.

**F4 App quit or crash.**
- Observers detach, C2 drops, and everything else keeps running. The server keeps the last size.
  W5 calls `AttentionPort.clearAll`: no window is watching any session now.
- Asks are denied with `ui_unavailable` only if no app reconnects within **5 s** (D8).
- The server goes idle only when it has had no app for 10 min, no live session, no pending timer
  and **no `reserved` or `unconfirmed` token row** (such a run may still register). "No live
  session" counts **every** terminal in our hc session, labelled or not, except the supervisor's
  own, so agents' own `hc run` work keeps it alive (D16). It persists and exits with
  `SERVER_EXIT.doneCoreIdle`. The supervisor then checks that the session has no other live terminal
  and runs `hc server stop` as its own last action; on `SERVER_EXIT.done`, or with any other
  terminal live, it just exits.
- **A connect aborts the idle exit.** If any C2 client connects while the server is exiting idle,
  it aborts the exit and serves. An app launch that still hits the closing pipe counts as "server
  vanished" and reapplies the start rule (F9).

**F5 App relaunch.** Same as F1 with live sessions. hc paints exact screens with 2000 history lines
above them, and nothing goes stale. Draft state, the typed tracker and `inputSeq` never left the
server, so the notice gate is unaffected.

**F6 App update.**
1. The installer replaces only the install dir. `customUnInstall` does nothing during an update.
2. The new app prepares `runtime/<new>`, sees `versionOrder` = `appNewer`, and calls
   `server.restart{reason:"update"}`.
3. The old server runs the stopping transition without the kill (D32): it refuses new starts,
   settles in-flight launches for up to 10 s (any still pending become `unconfirmed`), persists,
   replies, closes its endpoints and exits `SERVER_EXIT.done`; its supervisor exits too.
4. The app **waits for the supervisor's terminal to reach `finished`**: the `conduit-server-<h>`
   terminal at the address `hello.supervisor` reported (hc events, up to 30 s),
   and only then applies the start rule (F1.3). If the wait times out, it shows `server: unavailable`
   with **Retry** (F1.6). The new server reconciles terminals, rebinds tokens, restores CLI
   bindings (D28), and adopts or late-confirms every `unconfirmed` launch (D21).
5. Shims reconnect with `resume` (C6). Requests never written fail with `host_unavailable`
   (retryable); requests written but unanswered fail with `outcome_unknown` (not retryable: "may
   have completed"). The server sends `tools/list_changed`. A shim whose agent starts while no
   server answers enters FALLBACK after `SHIM_INITIAL_CONNECT_DEADLINE_MS` (2 s) and resumes on its
   first successful connect (C6). A shim cut off with its `initialize` still pending re-sends it on
   reconnect, never fails it with `outcome_unknown`, and past the same deadline answers it locally,
   exactly once, then resumes; a shim that fell back before any `initialize` connects with
   `resume: null`. A resume's `initialized` says whether the shim actually read
   `notifications/initialized`; when false the server waits for it. A resume hello that would exceed
   64 KiB is never sent: the shim answers `reinitialize_required` once and falls back permanently.

**F7 Approval.**
1. Policy says `ask`, so `approvals.changed` carries the pending list.
2. The app shows the card in the owner window and answers through
   `mcp.fromRenderer{windowId, mcp:askAnswer}`. The first answer wins, and the asking window is
   checked against the presence mirror. W5 keys that mirror, and its window-id namespace, by C2
   connection.
3. **Window events come from presence** (W5). The host's `onSessionMoved` fires when a session's
   owning window changes between two `ui.presence` updates; `onWindowReset` fires when a window
   disappears from presence or goes `ready: false`. Both cancel that window's or session's asks, as
   main.ts does today (`onSessionMoved` at main.ts:2312, `onWindowReset` at 5175). An app disconnect
   is not a reset: its asks wait out the grace (step 4).
4. Within the 5 s grace, every pending wait rebinds to its session's owner window in the latest
   presence; a session that moves during the grace rebinds too. The snapshot's `pendingAsks` are
   answerable, not just displayable.
5. When the grace expires, the ask is denied with `ui_unavailable` and the thread record is appended
   (W5).

**F8 Server typing (D19).** Every write is the server's, on its active attach, through its one
serialized PtyWriter (`src/pty-writer.ts`, over C1 `input`). The v0.51 host logic moves unchanged in
meaning, and **each intent keeps its own policy**:

| Intent | Path | Policy, as today |
|---|---|---|
| Human keystrokes | `term.input` → `onRendererInput` → raw write | `detectTyped`, `nextDraftState`, `inputSeq`, attention clear, `mgr.touch`; never queued behind a submit gap |
| Notices | `submitNotice` → `PtyWriter.submit` | `beforeText` at the **queue slot**: screen verdict, idle, draft, connection, policy; captures `inputSeq` and the admitting adapter. `beforeEnter`: echo evidence, Enter withheld on input since the text or non-echo output |
| Timed messages | the bare writer: `PtyWriter.submit` without hooks | no notice gate, no `mgr.touch` |
| Add-dir paste | `runAddDir` (W4) → `DraftPort.noteHostInput` → `TypingPort.write` | its own gate (exists, alive, not busy, typeable, bracketed paste); before the write, `runAddDir` itself calls W5's C7 `DraftPort.noteHostInput` (today's `noteHostInput`, as main.ts:3019 does), so the paste counts as a draft and withholds an in-flight Enter. `TypingPort.write` is a plain writer, so W6 never calls back into W5 |

- The ring, the screen model (W6's `TerminalRuntime.screen()`, per-cell dim styling for
  `screen-verdict`) and attention are fed from the server's own ordered active stream. Credit is
  granted when bytes are appended to the ring, which is cheap and synchronous; the headless screen
  model is fed off that path and coalesced, so a slow parse never holds the stream back (D18, D20).
  `screen()` resolves only after every `data` received before the call has been parsed, so
  `beforeEnter`'s echo recheck reads a screen that includes the echo.
- **The parse backlog is bounded.** Past `SCREEN_BACKLOG_MAX_BYTES` (8 MiB) of unparsed output for one
  session, the server discards that model and marks it unknown: `screen()` returns null, so the
  notice gate fails closed. Credit is granted on ring append, so no hc gap paint follows by itself:
  **when the backlog drains, W6 drops its active attach and attaches again**, and that
  `paint{cause:'attach'}` reseeds the model. The ring is unaffected (D18).
- **Screen-model lifecycle (C7 `ScreenPort`, W6 provides, W5 calls).** A model costs memory, so it
  starts only once a CLI shows up (today's D6 ruling). On `spawned` (which, with `size` and `exit`,
  replaces the host's onSpawn, onResize and onExit), W5 calls `ensure(id, {seedTail: false})` for a
  session with a defined adapter, and `keepTail(id)` for a tracked shell. On the first CLI
  `initialize` it calls `ensure(id, {seedTail: true})`: the model is seeded from the kept tail, since
  a CLI paints before it initializes. On `exit` and deletion, `release(id)`. The host also reacts to
  `exit` with the token revoke, the connection close and `removeConfig`, as today. The host gets only
  `get`, `screen` and `on` of `TerminalRuntime`; it never writes raw input.
- **Resize ordering is today's (D31).** node-pty has the same in-flight race today: bytes written
  for the old grid reach the newly sized xterm, and ConPTY's own repaint after the resize is the
  corrective paint. The design keeps exactly that behaviour, for the app observer and for the
  server's screen model alike, and relies on ConPTY's post-resize repaint; nothing fences bytes
  against a resize. M19 gates it with output buffered during a resize.
- Visibility and ownership come from `ui.presence`; "attached" no longer matters for typing. W5
  keeps the presence mirror and forwards each `ui.presence` to `AttentionPort.setVisible` /
  `dropWindow`, so the attention decisions stay W6's.
- After a **server** restart draft state is unknown; it counts as a draft unless the screen verdict
  shows an empty input box (M20). A typed shell CLI's notice binding comes back from
  `bindings.json` (D28), so its notices keep their adapter.
- **Accepted residual:** the server's headless model answers terminal queries too, and those answers
  are discarded; only hc's own answers (from `display`) reach the program.

**Internal subscribers.** `main.ts` also subscribes to its own PTY output and folder state, outside
any renderer message. Each concern gets exactly one subscriber after the split; the full list, with
`main.ts` lines, is in `main-ts-ownership.md`.

| Concern (main.ts today) | Owner | Consumes |
|---|---|---|
| Bells, inert-output scan, busy/attention (`countBareBells`, `scanInertOutput`, `activity.recordOutput`) | W6 | its own active stream (C1 `data`, never `paint`) |
| Notice-gate screen model (`mcpHost.onOutput`) | W6 | its own active stream, coalesced |
| Scrollback ring (`scrollbacks.append`) | W6 | its own active stream; host-composed bytes via `ScrollbackPort.show` |
| `lastLine` | W4 | C1 `data` → `tailLines` |
| Limit-notice scan (`scanForLimitNotice`; arms timers per `autoResumeOnLimit`) | W4 | C1 `data` → `tailLines` |
| Bracketed-paste tracking (`pasteModes`; read by `runAddDir`) | W4 | C1 `data` |
| Agent scopes (`scopes.output`, `scopes.ended`) | W4 | C1 `data`, `exit` |
| Live cwd (`CwdScanner` → `cwdGate` → `setCwd`) | W4 | a ported `CwdScanner` + `cwdGate` + the cwd OSC injection on C1 `data` (D38; M27 failed) |
| Typed CLI in a shell (`detectTyped`) | W5 | `detectTyped` on `term.input`, as today (D38; M27 failed) |
| Folder mutation → scope recompute (`onFoldersChanged` → `scopes.recompute`) | W4 | its own session ops |
| Folder health (`FolderHealth` → `setFolderHealth`), incl. the recheck on window focus (`folders.focused()`) and on a watch suspect | W4 | its own session ops; the focused window's shown session from `ui.presence`; C2 `folders.suspect{sessionId, path}`, rechecked only for that session's own folders |
| Folder mutation → watchers, repo scans, plan reconcile, file-index prune (`pruneFileIndexes`) | W7 (app) | `sessions.changed` (home/roots diff) |
| Watch loss or rename → `suspect` | W7 (app) | its own watchers; sends C2 `folders.suspect` per affected session and path |
| Repo detection, manual pin, editor context and the active repo (`setRepos`, `pinRepo`, `repo:context`, `setAutoRepo` → `resolveActiveRepo`) | W7 (app) | its own scans and `repo:*`; `cwd` from `sessions.changed` for the sub-repo follow; kept in the app overlay (D39) |
| Session status, busy and attention in the UI | W7 (app) | `sessions.changed` only (compose merges `statusOf`) |

**F9 Server crash.** The supervisor runs `server/main.js` as a **non-detached** child. libuv puts
such children in its kill-on-close job object, so the child dies with the supervisor while the
server stays pure JS. The supervisor is the only restart authority: backoff 1/2/5/10/30 s;
`SERVER_EXIT.done` or `doneCoreIdle` means "don't restart". C2 drops; output keeps streaming to observers, and the panes show input
paused (D29). The app does not restart anything: while a live `conduit-server-<h>` terminal exists
it just reconnects. The restarted server re-attaches at the record's size with `resumed: true`
(`paint{cause:'gap'}`), and shims resume. After 5 crashes in 10 min the supervisor writes
`userData/server-exhausted.json` (`{at, retryAt, lastExitCode, logPath}`) atomically and **cools
down** for `SUPERVISOR_EXHAUSTED_COOLDOWN_MS` (30 min); it never exits for good, since with no app
open nothing else would restart the bus. Then it deletes the marker, resets its budget and tries
again. Meanwhile the app shows F1.6; **Retry** deletes the marker, which ends the cooldown at the
next poll.
- **Supervisor vanished.** A `finished` event for the `conduit-server-<h>` terminal with no exhaustion marker, while an app is
  connected or connecting (an agent's `hc kill`, D16; a launch that hit a closing pipe, F4), makes the
  app reapply the start rule (F1.3). Budget: 3 attempts per hour per app session. Past it the app
  shows "Conduit's background service stopped" with the reason, the log path and **Retry**.
- **Residual: a crash mid-notice.** A server crash between a notice's text and its Enter leaves the
  doorbell text in the agent's input box. After the restart the draft state is unknown, so it counts
  as a draft (F8) and later notices hold, fail-closed, until the person clears it.

**F10 hc core crash or restart (D22).** The holder restarts the core. Every stream ends with
`disconnected`; the server is unaffected (its own terminal lives in the holder). On reconnect: fresh
hello → `events.subscribe` (snapshot first) → `reconcile()`, which re-attaches each surviving tracked
terminal at the record's `cols`/`rows` with `resumed: true` (`paint{cause:'gap'}`). One that
finished meanwhile is not attached (hc refuses with `finished`): its `exit_code`/`reason` and final
output (`terminal.read` into the ring) are recorded, `exit` is emitted and the record `terminal.rm`ed;
`lost` is only for `not_found`. Then `resynced`. It skips every row an in-flight spawn in this
process owns, and never revokes an `unconfirmed` or `superseded` row on a negative lookup (D21).
App observers get
`closed('disconnected', restartable:true)` and reattach when the app's hc client reconnects. A
compatible core whose `hello.version` ≠ the pinned one (e.g. `hc update` run in a pane) sets runtime
health `degraded: 'core replaced'`, shown to the user (D24); an incompatible one goes to F11.

**F11 hc version bump (D30).**
1. A running core older than the bundled hc is handed over to the new binary **opportunistically**,
   when M13 shows that is possible.
2. Otherwise an older core that is still **compatible** (`hello.generation` plus the C3 subset in
   `hello.methods`) keeps running with live agents; the bundled hc takes over once the core next
   stops.
3. Only an **incompatible** core blocks: the server reports `runtime: unavailable` with "terminal
   engine update pending" and offers **Restart agents to update**. That is an explicit F12 followed
   by a fresh core.

**F12 Stop everything.** "Quit Conduit and stop all agents", and an older app's **Stop all agents and
continue** (D26), call the frozen `server.stopAll`, which runs the stopping transition (D32):
1. Enter `stopping`: C2 creates and starts, MCP opens and runtime spawns are refused with
   `server_stopping`.
2. Wait up to `LAUNCH_SETTLE_ON_STOP_MS` (10 s) for in-flight launches to resolve; any still pending
   becomes `superseded` (C1 `beginStopping('stopAll')`), and so does every `unconfirmed` row left from
   an earlier restart: a late registration is killed, never adopted.
3. Kill every `conduit.role=session` terminal (never the supervisor), deleting their token rows and
   bindings.
4. Persist.
5. Reply.
6. Exit `SERVER_EXIT.doneCoreIdle` (no row is `reserved` or `unconfirmed` now). The supervisor runs
   `hc server stop` only on `doneCoreIdle` and with no other terminal left in the session, then
   exits.

`server.restart` runs the same steps without step 3, and with still-pending launches left
`unconfirmed` (C1 `beginStopping('restart')`) for the replacement to adopt. Uninstall's `--stop-all` is a C2 client of
`server.stopAll`, with a direct-hc fallback only when no server answers within 5 s or the
connection closes before the reply; an accepted stop gets 20 s (§Processes and installs).

## Decisions and trade-offs

| # | Decision | Over | Trade-off we accept |
|---|---|---|---|
| D1 | MCP host lives in **our** server, not in hc | MCP inside hc | One more process; no permanent fork |
| D2 | Server on a **bundled `node.exe` in `userData/runtime/<v>/`**; hc likewise | Electron-as-Node from the install dir, which the installer locks or kills; `utilityProcess`, which dies with the app | ~80 MB per kept runtime version on disk |
| D2b | Shims on a **write-once** `runtime/shim/`; a change goes to a new path (`runtime/shim-2/`) with a config-entry migration | Versioned shim paths, which GC deletes under long-lived agents; a rename-swap, which leaves a gap with no `node.exe` | Old shim dirs linger while any agent uses them |
| D3 | Terminal output **hc → app directly**; the app attaches as an **observer** and never types or resizes. C5's `AttachTarget` is opaque to app code; `TerminalLinkFactory` is the seam a remote server would replace | Relaying output through the server | The app carries an hc client |
| D4 | **Server owns spawn and size**; the app's xterm sizes itself and **requests** that size (`term.resize`), which the server applies, so PTY size = xterm size holds. With no app, the last size stays | Renderer-driven spawn; the app as the size owner | One repaint when a program paints before the first attach |
| D5 | C2 is **plain JSON-RPC lines** | Framed C2 | None |
| D6 | **No node-pty fallback**; the work stays on `feat/three-process` until the gate | A runtime setting with two topologies | A long-lived branch to rebase |
| D7 | **Settings split by consumer.** `ServerSettings` (the keys the server reads, listed in C2) live in `server-settings.json`, written only by the server, atomically; UI keys stay in `settings.json`, written only by the app. `osAttention` is a UI key (the server emits attention edges unconditionally; the app decides on OS notifications), and so are `logging`/`logLevel`: the app pushes them with C2 `server.setLogging{logging, logLevel}` on connect and on every change, and the server logs with defaults until then. **Migration:** the server seeds its file from v0.51's `settings.json` once. The app **never strips** v0.51's server keys from `settings.json` in this program: it mirrors them there on every `serverSettings.changed`, as that file's only writer, so an older build reads current values (D26). **The app's one source for server keys** is that mirror (v0.51's values on the first launch), then the snapshot and `serverSettings.changed`; it never reads `server-settings.json`, which is private to the server. **Renderer protocol (lead-owned, W7 implements):** server keys travel as a key-scoped `updateServerSettings{patch}` → C2 `serverSettings.patch`; `updateSettings` carries UI keys only, so a stale window can't revert another window's policy change | The server as sole writer of every setting (panel drags become RPCs; the UI freezes with the server down); two writers of one file; stripping after a migration ack (a ≤ v0.51 downgrade then reads defaults and loses its policy) | Two files and one renderer message; the server keys sit twice on disk, the app's copy at most one `serverSettings.changed` behind; `restoreSessions` is server-owned, so the app reads it from its mirror |
| D8 | Asks with no app for **>5 s** are denied with `ui_unavailable`; within the grace, pending waits **rebind** to the session's owner window in the latest presence. **Server actions run windowless:** `gateToolCall` splits the tools. Server actions (`open_session`, `open_terminal`, `close_session`, `attach_folder`, plus messaging) run with no ready owner window when policy resolves to `on`; window actions (`open_file`, `close_files`, `open_review`, `open_git_history`, `open_url`, `focus_session`) still need one, else `window_not_ready` / `ui_unavailable`. `ask` always needs a window. W0b makes the split on `main`, with unit tests; in v0.51's topology it changes behaviour only during a window's not-ready instant. A windowless `close_session` goes through C7 `DomainPort.closeSession` with no dirty-buffer check; with a ready owner window the renderer's dirty check stays | Queue; launch the app; per-launch epochs on window ids; every non-messaging tool needing a window (blocks unattended lead agents) | Agents are denied asks while you're away; nothing is approved without a person; an `on` server action now also runs during a window's not-ready instant; a windowless close can't see unsaved buffers, which exist only in an open app |
| D9 | OS notifications **only while the app runs** | Server notifications | No pings while closed |
| D10 | Own hc session, **bundled pinned hc**, sanitized env, fixed flags | Shared Herdr session; hc from PATH | Bigger installer |
| D11 | Update = **server restart**; shims **resume** (C6) | Hot swap | A few seconds of retryable MCP errors, and `outcome_unknown` for calls cut mid-flight |
| D12 | **Four cross-version edges**, each with its own rule (§Connections): shim ↔ server, app ↔ server, app/server ↔ hc core, server ↔ its persisted files | One released-schema ritual for everything | Four small surfaces, the wire ones tested on recorded bytes, the files by `judgePersistedVersion` over their existing version fields |
| D15 | **Token hashes persist**, written before spawn | Memory only; plaintext | A process that can read the agent's env could replay its token, as today |
| D16 | **Residual: hc is a same-user control plane.** Measured: hc injects `HC_SESSION`, `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID` and `HC_SCOPE` into every terminal, so a shell agent can drive hc directly, incl. `hc kill` of the supervisor. An agent's own `hc run` lands in Conduit's session and counts against idle exit (F4). Conduit's policy governs MCP tool calls, not this. An upstream request asks for a per-terminal opt-out of env injection or a configurable injected session; M25 checks whether hc config already allows it. The app's own hc calls use the one core-start env (`coreStartEnv`) and `hc run --no-parent`, so a Conduit launched from a pane stays out of that pane's session (M17). **C2 is a same-user control plane too:** a plain `listen` with libuv's default pipe DACL, no client identity, so a shell agent can call C2 (approve its own asks, flip policy). No auth machinery now; `hello.auth` is reserved as an optional field under the extension rule. **M28 measured the exposure and it is wider than "same-user":** Node's pipe server accepts remote SMB clients that hold the user's or an administrator's credentials, and the default DACL gives Everyone and Anonymous read, so any user can open the pipe read-only; no listen option changes it (today's `conduit-mcp-<h>` pipe has the same exposure). So the server never pushes data to a connection before its `hello` | Obscurity (impossible); a broker in the byte path; C2 auth now (the same agent can read the app's env or files) | Accepted and documented in the release notes. **Also residual:** a supervisor killed with no app open leaves the bus down until the next app launch. **M17 residual:** a launcher that runs the app inside a kill-on-close job object without `BREAKAWAY_OK` and that starts the core takes core, holder, supervisor and agents down with it (measured); re-checked with the real installer in M16, and if its run-after-finish is such a job the app starts the core through a broker outside it |
| D17 | **hc hosts a tiny supervisor, the only restart authority.** `server/supervise.js` runs as the hc terminal named `conduit-server-<h>` (unique per userData; also labelled `conduit.role=server`, for logs and skips only). It runs `server/main.js` as a **non-detached** child, which libuv places in its kill-on-close job object (no native module), and restarts it with backoff 1/2/5/10/30 s. After 5 crashes in 10 min it writes `userData/server-exhausted.json` atomically and **cools down 30 min**, then retries; it never exits for good. `SERVER_EXIT.done` / `doneCoreIdle` = don't restart; any other exit is a crash. **Identity:** the start rule, the F6 wait and Restart key on that unique name plus the address `hello.supervisor` reports, never on the forgeable label. The app only **starts** a supervisor (no live `conduit-server-<h>` and no marker); with a marker it shows unavailable + **Retry**, which deletes the marker. The app never kills a server or supervisor by itself; a hung server is recovered only by the explicit **Restart Conduit's background service** (`hc kill` of `conduit-server-<h>`, then a start). **Lock = the pipe:** the first-instance `\\.\pipe\conduit-server-<h>` bind; losing it (`EADDRINUSE`) = exit 0. No lock file, no pid kills. **Startup is bounded by the server itself:** the pipe is bound before slow work and `hello` is answered at once, so the app's 20 s `hello` timeout only bounds "is a server up"; a server still `starting` after 30 s reports `unavailable: 'startup timeout'` and keeps trying. A supervisor that vanishes without a marker while an app is connected or connecting is restarted by that app's start rule, at most 3 times per hour per app session (F9) | A plain detached spawn, which Task Manager *End task* takes down with the app; the holder alone, which never re-runs a `keep:false` command; the app as a second restart authority (unbounded crash loops); a pid lock file (pid reuse); the `conduit.role=server` label as identity (any agent can set it); exiting for good when exhausted (with no app open the bus never comes back) | The supervisor shows in `hc ls`; an agent can `hc kill` it (D16); without hc it runs as a plain spawn without tree-kill survival; a hung server waits for a person; a server that keeps crashing retries every 30 min. **Release-note line (M23, a change from node-pty):** background processes started in a session end with it, since hc kills a terminal's whole job, even `detached` grandchildren |
| D18 | **Scrollback ring stays**, fed from the server's active stream and replayed as `prelude` on cold spawns. `data` appends, and the append is what grants hc credit; the headless screen model is fed off that path, coalesced. **Host-composed bytes** (relaunch marker, ConPTY replay padding, role-brief banners, can't-start lines) go through `ScrollbackPort.show`: appended to the ring and sent as C2 `term.show`, so the ring holds exactly what the pane was shown. On `paint{cause:'gap'}` (core reconnect, server-restart re-attach, >4 MiB behind) the ring **appends** a gap marker plus the paint as a new segment; it **never resets**, and never on a resize either. A re-attach asks for 2000 history lines, capped by the 256 KiB ring (`SCROLLBACK_CAP_BYTES`). **The screen model's backlog is bounded:** past 8 MiB unparsed for one session (`SCREEN_BACKLOG_MAX_BYTES`), the server discards that model, the notice gate fails closed (F8), and once the backlog drains W6 re-attaches so the attach paint reseeds it; the ring is unaffected. The ring stays rather than hc's history (D33): hc prunes finished records and nothing survives a reboot | Retiring the feature; appending paints without a marker; resetting on a gap; an unbounded parse queue in a month-long daemon; host-composed bytes typed through `TypingPort` (they would reach the program) | Output during a server restart is covered only by the re-attach's history; a replay can show a repeated screen after the marker; after a discarded model, notices hold until the re-attach. **Accepted residual:** a relaunch after a cold spawn shows only what this run's ring holds, not the pre-reboot ring the cold spawn replayed |
| D19 | **The server is the sole writer and the sole active viewer; the app is an observer.** The server holds one non-observe attach per live session from spawn or adopt until exit, sets the size, and performs every write through its serialized PtyWriter over C1 `input`: keystrokes (`term.input`), notices, timed messages, add-dir. Each intent keeps its v0.51 policy (F8). hc `terminal.send` is never used: it is atomic behind its own quiet gate, so it can't host the Enter recheck | Two writers in two processes (no serialization point); the app as the attached writer (needs an attach handshake and a remote queue-slot gate); `terminal.send` (no Enter recheck, would submit add-dir) | Keystrokes take one extra local hop (+~1 ms; M5 measures echo); a server restart freezes typing, not output |
| D20 | **Paint vs data.** C1 `paint` (an attach's first paint, the >4 MiB-behind repaint) is distinct from `data` and carries `cause: 'attach' \| 'gap'`; attention and activity never count paints. The boundary rule is measured (M8) and C5's `FirstPaint` uses the same one. An upstream request asks for an explicit end-of-paint marker. The server grants credit on ring append, never on the screen model's parse, so it falls >4 MiB behind only when the process itself stalls; the parse backlog behind that has its own 8 MiB bound (D18) | Treating every byte as output; credit on parse | A heuristic boundary until upstream adds the marker |
| D21 | **Adopt by recorded address + launch identity; spawn recovery never decides from absence or a clock.** Every launch has a reservation: a `TokenRecord` with `launchId`, the `conduit.launch` label and hc `name` = launchId (32 hex), and a `state` (`reserved` → `live`, or `unconfirmed` / `superseded`). W4 allocates `generation` (from the record's persisted `lastGeneration`) and `launchId` (`SessionStorePort.allocateLaunch`), W5 reserves the row inside `LaunchPort.prepareLaunch`, W6 runs and records. **A reply resolves the launch; a core connection lost before it** makes the row `unconfirmed`: never revoked on a negative lookup, never retried automatically, never produced by a timeout. The server subscribes to hc events before reconciling, so a terminal with that name registering later is adopted (late confirmation). An unconfirmed launch is otherwise resolved only explicitly: by a person (**Retry launch** / **Discard**), or, for an MCP spawn, by the calling agent, which gets `spawn_unconfirmed`. **A new launch** gets a new launchId and token; the old row becomes `superseded`, and if that launch registers later the server kills and logs it. **Absence proves nothing:** pinned v0.1.16 registers a run only after holder and env preparation, a `keep:false` timeout removes the record, and finished records are pruned after a day or past 500; so Conduit records every outcome as soon as hc reports it. W5 is the **sole owner of `tokens.json`** behind `TokenStorePort`; `revoke({sessionId})` removes every row of the session. **Reconcile** (start and every reconnect): (1) read the rows; unreadable, refused (newer version) or missing while labelled terminals live → `degraded: 'token store unreadable'`, adopt nothing, kill nothing, MCP welcomes `draining`; (2) skip rows an in-flight spawn in this process owns; (3) `live` rows: live → adopt; **finished → no attach, record `exit_code`/`reason`, `terminal.read` into the ring, emit `exit`, `terminal.rm`**; `not_found` → exit `lost`, revoke; (4) `reserved` (from a dead process) and `unconfirmed` rows: `terminal.get` by name, found → adopt, not found → stays `unconfirmed`; (5) `superseded` rows found live → kill, log, revoke; (6) only after a clean load, kill `conduit.role=session` terminals that match no row, never `conduit.role=server`. **Between reconciles**, a `created` event for a `conduit.role=session` terminal with no row is killed at once. An unconfirmed or superseded row is revoked only by explicit discard, session removal, or once a superseded launch's late terminal is killed | Highest label generation (labels are forgeable); killing on a failed load; a listing or `terminal.get` miss as proof of absence; a confirm timeout (a slow run becomes unconfirmed); list-then-retry by the same name (it can run twice); relying on hc's `spawn_pending` claim (dropped under `keep:false` in v0.1.16; upstream request filed) or on hc keeping finished records; W6 writing the token file; a generation derived from labels or held only in memory | One more write per spawn; a corrupt store leaves orphans running and MCP draining until a person acts; an unconfirmed launch waits for a person or its caller. **Accepted residual:** a superseded launch that registers late runs briefly, as a duplicate, until the server kills it |
| D22 | **Reconnect = reconcile.** `reconcile()` runs at start and after every `resynced`; `restarted` means only a `keep:true` replacement, which Conduit never uses | Once-only adopt; waiting for `restarted` | A full list per reconnect |
| D23 | **The rename test is the whole liveness check**: a dir that can't be renamed to `<dir>.gc` is in use (cwd only: mapped exe/DLL images do not block the rename, M21). **Core-start cwd rule:** every hc call that may start or restart a core (the app's supervisor start, any `hc server restart`) runs with cwd = `coreStartCwd(runtimeRoot, hcVersion)` = `<runtime>/hc/<hcVersion>`, since the core inherits the caller's cwd and its holders inherit the core's. GC by the app only, under Electron's existing single-instance lock (keyed by userData) | Leases with `UV_FS_O_EXLOCK` (Node doesn't expose it); `.inuse` files (libuv opens with `FILE_SHARE_DELETE`); native locks; a `.gc.lock` pid file (duplicates the single-instance lock, with pid reuse) | GC may keep a dir one launch longer than needed |
| D24 | **hc session hygiene, one env builder.** `coreStartEnv` (C4) is the only env for starting our core, from the app or the server: `HC_*` stripped, `HC_SESSION=conduit-<h>`, our own `XDG_CONFIG_HOME`/`XDG_STATE_HOME` under `userData/hc/`, and the user's original XDG values captured once into `CONDUIT_USER_XDG_*` and passed through, so session specs get them back. A replaced core version is `degraded`. **M22 result:** hc honours the XDG variables on Windows, but panes inherit ours and `terminal.run.env` can only set a variable, never unset it. Isolation is kept; for each `XDG_*` the user has **absent**, panes get `""` (the XDG base-dir spec treats empty as unset), and `coreStartEnv` captures it as `""` in `CONDUIT_USER_XDG_*`. The user's own values pass through unchanged. **If M22 fails** (hc on Windows ignores `XDG_CONFIG_HOME`, its documented config being `%APPDATA%\herdr-core\config.toml`; or panes inherit our values, which `terminal.run.env` can't unset), the builder sets no `XDG_*`, and our core shares the user's `%APPDATA%\herdr-core` config and templates: accepted and documented | Sharing the user's Herdr templates, `config.toml` and state unconditionally; an env per caller (the app's start skipped isolation, and nothing captured the originals) | Panes still inherit `HC_SESSION`, so agents' own hc use counts as ours (F4 counts all terminals); on an M22 fail, a user's hc config also applies to Conduit's core |
| D25 | **`server: unavailable` is a defined app state**: banner + log path + **Retry**, server settings read-only from the app's own mirror in `settings.json` (D7; it also answers the sync `settings:initial` IPC), UI settings, editor and everything else working, terminals and MCP off. Entered on an exhaustion marker, a `hello` timeout (20 s) or an F6 wait timeout. Retry deletes the marker and applies the start rule; a hung server needs the explicit **Restart Conduit's background service** (D17) | An undefined failure; killing by process name; the app reading the server's private `server-settings.json` (two sources for one key, and a missing file on the first v0.52 launch) | Server settings are read-only until a server runs, and show the last mirrored values |
| D26 | **Downgrade:** an app older than the running server never restarts it. It shows "A newer Conduit is running its agents" and offers **Stop all agents and continue** through the frozen `server.stopAll` (token cleanup, supervisor exit, as in F12). **≤ v0.51** has no server client and can't do that: the release notes say "Quit Conduit and stop all agents before installing an older version", and the server keys mirrored in `settings.json` (D7) give it current values | Restarting into the older server | Running an older build needs an explicit stop; a ≤ v0.51 build installed over live agents runs beside them unaware |
| D27 | **Server-internal ports (C7)**: `SessionStorePort` (incl. `allocateLaunch`, the single producer of `generation` and `launchId`) and `DomainPort` (W4); `AttentionPort` (incl. `setVisible`/`dropWindow`/`clearAll`), `TypingPort` (a plain writer), `ScreenPort` and `ScrollbackPort` (W6); `TokenStorePort`, `DraftPort` and **`LaunchPort`** (`whenLaunchReady`, async `prepareLaunch(sessionId, def, spec, {generation, launchId})`, `onSessionDeleted`; the host's launch seam at `conduit-mcp-host.ts:1306`) (W5). W5's `McpHostDeps` = the session, domain, attention, typing, screen and token ports, `Pick<TerminalRuntime, 'get' \| 'screen' \| 'on'>` and the C2 event sink; W4 consumes `LaunchPort`, `DraftPort` and `ScrollbackPort` and never `TokenStorePort`; W6 consumes `TokenStorePort`. No port calls back into its caller: `runAddDir` calls `DraftPort` itself. The lead owns them and `server/compose.ts`, which also forwards `AttentionPort.onEdge` to C2 `attention.edge`. Attention is W6's alone, input- and visibility-driven decisions included. The host reaches these ports already on `main` (W0b, with `TokenStorePort` over today's in-memory registry and `prepareLaunch` made async), so W5 imports it rather than copying it | Lanes agreeing on seams as they go; one lane owning the wiring; copying the host onto the branch (a fork on a long-lived branch); the host holding all of `TerminalRuntime` (raw input past the PtyWriter); W4 reserving tokens itself (a second writer of identity) | One more contract file to keep in step; a refactor on `main` before the branch |
| D28 | **The admitted shell-CLI binding survives resume.** The server persists it in `conduit-mcp/bindings.json` (`{sessionId, generation, cli, clientInfoName}`), written when the host admits a typed-command binding and deleted with the session or a new generation. On a resume of the same token and generation, the first connection whose `initialize.clientInfo.name` matches is rebound; other clients sharing the token stay secondary, as today | Losing the binding (a typed Claude/Codex shell gets no notices after an update); binding every resumed client (a secondary client takes over) | One more small file; a resumed client that renamed itself loses its binding |
| D29 | **Input is dropped while C2 is down.** The app never buffers keystrokes; the pane shows "Reconnecting — input paused" | Buffering, which can answer a prompt late | Keystrokes typed during a server restart are lost, visibly |
| D30 | **Core compatibility is feature detection.** Compatible = `hello.generation` matches and `hello.methods` contains the C3 subset. `HC_MIN_CORE_VERSION` is the oldest core known to serve it (`0.1.16`, the only one verified). A handover to a newer bundled hc is opportunistic (M13); only an incompatible core leads to "Restart agents to update" | Minimum = pinned (every hc bump stops agents unless M13 passes) | A compatible older core runs without newer feature-detected calls until it next stops |
| D31 | **Resize ordering is today's.** Bytes in flight for the old grid reach the newly sized screen in the app observer and in the server's model, exactly as with node-pty; ConPTY's post-resize repaint corrects both. No fence | A byte fence or `resize_notifications` (unavailable on the pinned path) | Brief old-grid output after a resize, as today; M19 gates that both models settle equal |
| D32 | **A stopping transition** shared by C2, MCP creation and runtime spawning. On `server.stopAll` and `server.restart`: (1) refuse new starts with `server_stopping`; (2) wait up to 10 s (`LAUNCH_SETTLE_ON_STOP_MS`) for in-flight launches to resolve; still pending then: `unconfirmed` on restart (the replacement adopts them), `superseded` on stopAll, together with earlier `unconfirmed` rows (a late registration is killed); (3) kill (stopAll only); (4) persist; (5) reply; (6) exit. **Busy rows:** idle exit and `hc server stop` wait while any token row is `reserved` or `unconfirmed`; the server signals that with its exit code (`SERVER_EXIT.doneCoreIdle` only when none remain), since the supervisor never reads `tokens.json` | Endpoint close plus process exit (a launch registering after the kill enumeration survives "Stop all agents"); waiting without bound; leaving stopAll's pending launches `unconfirmed` (a core stop destroys them and the next server offers Retry for a process that is gone) | A stop or update can take up to 10 s longer; a launch superseded by stopAll that registers after the server exits runs until the core stops or the next server kills it |
| D33 | **Reuse hc first.** If herdr-core already provides something, Conduit uses it and does not rebuild it, unless a stated need forces otherwise. Each case is in §Reuse audit, with its reason or spike check | Rebuilding hc features inside the server for uniformity | Conduit's behaviour follows hc's in those areas, bounded by the pin (D10) |
| D34 | **Attention: OSC 7501 is primary.** Wherever hc's terminal record is `reported`, the program's own status (C1 `status`) drives attention; Conduit's output heuristics apply only to programs that don't report. W6 owns both | Heuristics for every program; status only | Two paths in W6's attention, chosen per terminal |
| D35 | **The MCP host runs in-process in the server**, as its own module behind C7 ports | A separate MCP process (another internal protocol and lifecycle) | A host crash takes the server down with it. Revisit only for crash containment, separate scaling or a privilege boundary |
| D36 | **Agents reach Conduit through MCP**, not a CLI. Measured: Codex's sandbox cannot run `hc`, and Cursor needs an allowlist entry, while harnesses launch MCP shims themselves | A `conduit` CLI as the agent surface | Scripts and non-MCP agents have no surface yet; a thin `conduit` CLI over the same server is a later option |
| D37 | **The server is TypeScript on bundled Node.** It reuses ~8.8k lines and ~74 unit test files, and shares contract types with the app. The boundaries are wire protocols (C2, C6, C3), so a later port to Bun or Rust is possible without touching the app, shims or hc | Go and Rust (a rewrite; their footprint gains don't matter for one local daemon); Bun and Deno (D17 and D23 rely on libuv's Windows behaviour, pipe first-instance and kill-on-close jobs, measured on Node 24) | ~80 MB of `node.exe` per runtime version (D2) |
| D38 | **Cwd and typed-CLI detection stay ours; hc `foreground` is not used.** M27 failed: on Windows `foreground` is only the terminal's root process, so typed CLIs never appear and PowerShell `Set-Location` is not followed. The fallback is in effect: W4 ports `CwdScanner` + `cwdGate` + the cwd OSC injection (`src/cwd-reporting.ts`) onto C1 `data` and sets the live cwd from it, and the app derives the sub-repo follow from that (D39); W5 keeps `detectTyped` on `term.input`. An upstream request asks for the console's foreground process | `foreground` as the single source (fails on Windows, M27) | The scanners and the injection are ported as today, with their known limits |

| D39 | **Repo state stays in the app.** Repo detection, the manual pin, the editor context and the active repo they resolve to stay together in W7, as today's `SessionManager` logic. The server supplies only `cwd` (D38) in `SessionView`, which never carries the app's fields (`APP_SESSION_FIELDS`, C2). The app keeps an overlay keyed by sessionId and merges it onto every `sessions.changed` and snapshot (`mergeAppOverlay`: the overlay wins), so a server snapshot never clobbers repo state | The server deriving the active repo (needs the app's scans, pins and editor context over new C2 methods); two copies of the session merged by last writer | The server and MCP never see the active repo; nothing there reads it today |
| D40 | **`restoreSessions: false` only stops reopening.** The server always persists sessions with a live or unconfirmed terminal, with their `lastGeneration`, since a running agent and its launch counter outlive the server. With the setting off, sessions with no live terminal are neither written nor reopened on server start. **Migration:** a v0.51 user with it off starts with no sessions, as today; live sessions made after the upgrade persist | Porting v0.51's gate, which skips loading and writing `sessions.json` (token rows and live hc terminals would survive a server restart with no session record or launch counter); ignoring the setting (reopens stale sessions the user opted out of) | With the setting off, `sessions.json` still exists while agents run |

**Removed decisions.**
- D13 removed in rev 6: superseded by D19 (the server is the only writer).
- D14 removed in rev 6: superseded by D19 (input metadata is computed server-side from `term.input`).

## Persisted formats

Every format the server owns after the split, with its existing version rule (D12). A format in
`SERVER_FILE_VERSION` (C4) refuses a newer version through `judgePersistedVersion`: unreadable for
the run and never overwritten. Where today's reader treats a newer version as empty and overwrites it
later, the change is made in the shared reader by **W0b** on `main` (it then also holds in v0.51's
topology); a reader that moves with its lane is changed by that lane.

| Format | Owner | Version field | Today, on a newer version | After the split |
|---|---|---|---|---|
| `sessions.json` | W4 | `version: 1` | empty, and the next write replaces it | refuse; reader `src/persistence.ts`, W0b. Persistence per D40 |
| `server-settings.json` | W4 | `version: 1` (new file) | n/a | refuse |
| `projects.json` | W4 | `version: 1` | `future`: left untouched, project writes blocked | unchanged; already refuses |
| `launchers.json` | W4 | `version: 1` | empty, backed up to `launchers.corrupt.json`, then replaced | refuse; reader `src/launcher-store.ts`, W0b; `launcher-host`'s write block, W4 |
| `timed-messages.json` | W4 | `version: 1` | empty, and the next write replaces it | refuse; reader `src/timed-messages.ts`, W0b |
| `conduit-mcp/tokens.json` | W5 | `version: 1` (new file) | n/a | refuse → `degraded: 'token store unreadable'` (D21) |
| `conduit-mcp/bindings.json` | W5 | `version: 1` (new file) | n/a | refuse |
| `conduit-mcp/messages.log` | W5 | `v: 1` per record | the record is skipped, and torn-tail repair or compaction rewrites the log without it | refuse: a newer record makes the store `store_unavailable` for the run, with no repair, compaction or append; `src/conduit-mcp/store.ts`, W0b |
| `scrollback-<id>.json` | W6 | `version: 2` (reads 1) | no replay, and the next persist replaces it | refuse: no replay and that session's ring is not persisted for the run; reader `src/scrollback-persistence.ts`, W0b |
| `server-exhausted.json` | W3 | `version: 1` (new file) | n/a | refuse = treated as present (the app shows unavailable + **Retry**) |
| `agents.json` | W4 | none | n/a | **exception:** user-authored, read only, never written by Conduit |
| `conduit-mcp/handles.json` | W5 | none | n/a | **exception:** a flat counter map whose numbers are never reused; a shape change takes a new file name |
| Attachment blobs | W5 | none | n/a | **exception:** content-addressed bytes |
| Per-launch MCP configs | W5 | none | n/a | **exception:** written per launch, deleted on exit |
| CLI install entries | W5 | none | n/a | **exception:** keys in third-party CLI config files, edited by key under `install-entries`' merge rules |
| `*.corrupt.json`, `*.bak.json` | each owner | as copied | n/a | **exception:** backups, never read back |

App-owned files (`settings.json`, `windows.json`, `docs.json`, `repos.json`, `review-marks.json`)
keep their rules; no server writes them.

## Reuse audit (D33)

What herdr-core provides, what Conduit does with it, and why.

| hc provides | Conduit's choice | Reason / spike check |
|---|---|---|
| OSC 7501 program status | **Primary** attention source wherever `reported`; Conduit's output heuristics only for programs that don't report | D34; W6 |
| Terminal history and finished snapshots | The scrollback ring stays | hc prunes finished records after a day or past 500, and nothing survives a reboot. M8 checks whether hc history could serve a live re-attach, which C5 already uses |
| A screen per terminal | The server's headless model stays | `terminal.read` gives text without the per-cell dim styling `screen-verdict` needs. M26 checks whether attach paint plus our parse can be replaced |
| Parent links, `wait`, notes | Future `spawn_agent`/`wait_for` build on hc's, not new machinery | Deferred |
| SSH machines and `--via` transports | The future cloud and remote path uses hc's | Deferred |
| Unique names, labels | Used for spawn identity | D21 |
| `keep` | Not used | It never reruns a command, so the supervisor stays (D17) |
| `terminal.send` | Not used | Atomic, with its own quiet gate (D19) |
| `foreground` (`{pid, name, argv, cwd}`, ~2/s, implemented on Windows) | **Not used (M27)**; hc still emits it, and C1 documents the event as unused | D38; the root process only on Windows, so `CwdScanner` + `cwdGate` + the injection are ported into W4 and `detectTyped` stays in W5 |
| `doc.get` / `doc.set` (documents that survive a core restart) | Not used: tokens, CLI bindings, server settings and identity stay in the server's local files | F1 answers `hello` before hc is up, so a down core must not take identity with it; and any same-user agent can `doc.set` our session's documents (D16) |
| `turn` (bumps when the status leaves `working`) | Not used | It is derived from the same OSC 7501 status attention already consumes (D34), so as a second run-end signal it would only double-count; nothing to measure |
| Identity, policy, structured messages | Conduit's | hc has none, by design |

## Single-app and local assumptions (to change before multi-operator or cloud)

None of these changes now; each is a known reversal for a later program.
- The app restarts the server on a version mismatch (D26, F6).
- The app supplies the whole presence (`ui.presence`), and the server mirrors it per connection.
- `AttentionPort.clearAll` runs on app disconnect.
- The app bootstraps and garbage-collects the runtimes under its own userData (F1, D23).
- The app attaches to hc's local pipe (C5; `TerminalLinkFactory` is the seam, D3).
- Board, plan, architecture and review files are app-owned; a report or artifact store that must
  stay true with no window open moves that row to the server.
- The app paints server settings from its local `settings.json` mirror (D7); a remote client has
  no mirror and must paint defaults or wait for the snapshot.
- `term.resize` and `term.facts` keep one last value per session, with no notion of a focused
  client; a second typing or resizing client would fight over them.
- C2 and the MCP endpoint are local named pipes only; a reachable endpoint keeps C6's bytes but
  changes the shim's dial path, a `runtime/shim-2/` migration (D2b), not a change to the processes.

## Spike measurements added to M1–M9

| # | What | Gate |
|---|---|---|
| M10 | Env parity with node-pty, given hc's Windows env refresh | |
| M11 | The server as sole active viewer: typing latency over `term.input`; xterm's focus reports inside `term.input` reach the program, with no FOCUS frames; facts sent before `sessions.start` arrive as `display` on the first attach, and a windowless spawn attaches with the last known facts or none; no size fights with an app observer; the server-side submit transaction matches today's | G |
| M12 | hc's ConPTY build vs Claude/Codex rendering and `windowsPty.buildNumber` | |
| M13 | A running core hands over to a **different** hc binary | G |
| M14 | First-attach repaint after spawn at the default size | |
| M15 | Env leakage. **Measured:** see D16 | done |
| M16 | Real NSIS update with live agents, a v0.51 user-config shim entry, and runtime dirs in userData; incl. an update **from** a build that already has the guarded uninstall hook, and the first-launch copy time under Defender vs the 3 s budget. **M16-lite runs in phase 2** with a stub server | G |
| M17 | Tree-kill, *End task*, and launch from inside a job (Windows Terminal, the installer's run-after-finish): supervisor, server and agents survive. Plus Conduit launched from inside a Conduit or Herdr pane: the supervisor lands in `conduit-<h>` with no parent | G |
| M18 | `prelude` replay followed by hc's first paint keeps the history visible above the new screen; an app relaunch's observer attach with `history: 2000` keeps scrollback for live sessions | |
| M19 | Output buffered during a resize (D31): both screen models, the app observer's xterm and the server's, equal after ConPTY's repaint settles | G |
| M20 | Notice gate after a server restart with draft state unknown: an empty input box is recognised, a restored draft is not overwritten | |
| M21 | The GC rename test fails against a live hc core, a draining holder and a live server, and succeeds once each is gone | G |
| M22 | hc honours `XDG_CONFIG_HOME`/`XDG_STATE_HOME` on Windows; panes don't inherit our values; incl. a user with no XDG set. A fail means no `XDG_*` for our core (D24) | |
| M23 | `hc kill` of the `conduit-server-<h>` terminal also ends `server/main.js`: the supervisor's non-detached child sits in libuv's kill-on-close job object | |
| M24 | hc refuses a second live terminal with the same `name`, and with which error kind (the schema lists `name_taken`) (D21). Plus the late-confirmation path: a run whose reply is dropped while it is still preparing registers later and is adopted from its `created` event; a superseded launch that registers late is killed; a fast exit before the attach keeps its output through `terminal.read` | G |
| M25 | Whether hc config already allows suppressing its env injection, or choosing the injected session (D16) | |
| M26 | Whether hc's attach paint plus our parse could replace the server's headless screen model for `screen-verdict` (per-cell dim styling), and the cost of the 8 MiB backlog bound (D18, D33) | |
| M27 | hc `foreground` on Windows: latency and accuracy for pwsh, cmd, a Claude/Codex typed into a shell, and a `cd` in each; enough for the live cwd and typed-CLI detection (D38) | G |
| M28 | The Node named-pipe server for C2 rejects remote clients (or the listen options that make it), and the pipe's effective DACL is recorded (D16) | |

## Changelog

- **Rev 9.2** (spike phase A, `docs/runs/2026-11-02-hc-spike/report.md`): D38 fallback in effect (M27 failed); D23 core-start cwd rule `coreStartCwd` replaces the mapped-images reasoning (M21); D24 absent user XDG becomes `""` in panes (M22); D16 pipe-exposure residual corrected (M28); M17 residual: a kill-on-close job without breakaway that starts the core kills it (re-checked in M16; broker if the installer does this); spawn env sets `TERM_PROGRAM=conduit` (M10); background processes started in a session end with it (M23).

- **Rev 9.1** (codex-review-9): windowless `close_session` through `DomainPort.closeSession`; the MCP
  open outcome carries `spawn_unconfirmed` (with `sessionId`) and `server_stopping`; repo state
  stays in the app behind an overlay (D39); C2 `folders.suspect`; `restoreSessions: false` only
  stops reopening (D40); `--stop-all` separates its connect bound from the accepted-stop wait;
  §Persisted formats over the existing version fields (`SERVER_FILE_VERSION`,
  `judgePersistedVersion`); semver pre-release ordering.

- **Rev 9** (critique-8, cursor-review-8): internal subscribers table; hc `foreground` for cwd and
  typed CLIs (D38, M27); reuse rows for `doc.*` and `turn`; C2 residual + reserved `hello.auth`
  (M28); supervisor identity by unique name; one core-start env (`coreStartEnv`); spawns resolve on
  reply or connection loss only; stopAll supersedes pending launches; busy rows block idle exit and
  `hc server stop`; reconcile of finished terminals; persisted `lastGeneration`; `timers.fired`;
  `ScrollbackPort.show` + `term.show`; one error channel per method; start semantics
  (`spawned:false`, `sessions.opened` ordering, status only from `sessions.changed`); shim
  `initialized` as read and `reinitialize_required` → permanent fallback; backlog-drain re-attach;
  persisted files as the fourth cross-version edge; exhausted supervisor cools down; POSIX server
  socket; `versionOrder`; four more single-app assumptions; `conduit.parent` dropped.
- **Rev 8** (critique-7, codex-review-7): reuse hc first (D33), MCP host in-process (D35), MCP as
  the agent surface (D36), TypeScript server (D37); absence never resolves a launch (D21); the
  windowless tool-gate split (D8); the stopping transition (D32).
- **Rev 1–7**: critique-1–6 and codex-review-3–6, in `docs/runs/2026-11-01-three-process-design/`.
