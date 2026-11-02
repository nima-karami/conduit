# ADR 0007 — Three-process split: Conduit app, Conduit server, terminal runtime

**Status:** accepted 2026-11-02 (proposed 2026-11-01, revision 9.1; built on `feat/three-process`,
see §As built) · **Date:** 2026-11-01
**Design:** `docs/specs/2026-11-01-three-process-architecture.md` · **Program:**
`docs/specs/2026-11-01-three-process-program.md` · **Spike:** `docs/specs/2026-11-01-hc-runtime-spike.md`
· **Reviews:** `docs/runs/2026-11-01-three-process-design/`

## Context

Everything Conduit runs lives in the Electron main process: PTYs (`src/pty-host.ts`), the MCP host
(`electron/conduit-mcp-host.ts`), attention, inbox, policy and timers. Two consequences are now the
main limit on Conduit as a daily driver:

1. **Agents die with the app.** `before-quit` flushes state and calls `pty.disposeAll()`. Every
   update, crash or quit ends every agent. Sessions come back `stale` and are relaunched by hand.
2. **The message bus dies with the app.** Persistent terminals alone don't fix (1). If the MCP host
   stayed in Electron, every surviving agent's `conduit` tools would fail while no window is open,
   and its identity would be lost on the next start, because tokens are memory-only today.

Herdr (`herdrdev/herdr-core`, Apache-2.0) has solved the terminal half:
- A long-lived **holder** owns every PTY.
- A **core** keeps a screen per terminal and serves a versioned JSON-RPC + framed API over a named
  pipe.
- Terminals survive viewer quit, core update (exact-screen handover) and core crash.

Its core is deliberately policy-free. Conduit's MCP bus is the part we keep: host-resolved
identity, typed messages, Off/Ask/On policy, a content-free doorbell.

## Decision

Conduit becomes three processes with three lifetimes:

```
Conduit app (Electron, install dir)      UI only. May quit, update or crash at any time.
Conduit server (Node, userData/runtime)  MCP host, inbox, policy, approvals, attention, sessions,
                                         launchers, projects, timers, briefs, settings.
hc core + holder (userData/runtime/hc)   herdr-core, pinned and unmodified. PTYs and screens.
```

1. **herdr-core is a dependency, not a fork.** It is bundled, pinned exact, and run in Conduit's own
   `HC_SESSION`. Fixes go upstream as PRs. We fork only if upstream refuses something we can't work
   around. If the spike fails, we build our own holder/core behind the same `TerminalRuntime`
   contract.
2. **The MCP host moves into the Conduit server, not into hc.** hc refuses policy by design, and
   our policy changes every release.
3. **Nothing long-lived runs from the install dir.** The server runs on a bundled `node.exe` copied
   to `userData/runtime/<version>/`. MCP shims run from a write-once `userData/runtime/shim/`
   that is never swapped; a shim change gets a new path.
   hc runs from `userData/runtime/hc/<version>/`. The installer only replaces files no live process
   holds.
4. **MCP identity survives restarts.** Tokens persist as SHA-256 hashes bound to session ids and are
   written before spawn. Shims speak a frozen protocol (C6): they reconnect and resume with their
   cached `initialize`. A typed shell CLI's notice binding is persisted too, and rebound on resume.
5. **The server is each session's only active viewer; the app observes.** The server holds one
   non-observe attach per live session from spawn or adopt until exit. The app's xterm sizes itself
   and requests that size, which the server applies, so PTY size = xterm size still holds. Output
   goes hc → app directly; the server is not in the output path.
6. **Electron stays for the UI.** The app no longer loads node-pty.
7. **A tiny supervisor runs as a terminal of our own hc session** and is the **only** component
   that restarts the server, with bounded backoff. Living in hc's holder, it survives *End task* and
   tree-kill of the app, which a plain Node spawn can't guarantee on Windows. The holder alone would
   never re-run a crashed server. The server is its non-detached child, so libuv's kill-on-close job
   object ends it with the supervisor. When its crash budget is spent it leaves an exhaustion marker
   and cools down for 30 minutes before trying again; it never exits for good. The supervisor is
   known by a unique hc name per userData and the address the server reports, never by a label. The
   app only starts a supervisor when none runs and no marker exists, and never kills one by itself.
   The server's single-instance lock is its named pipe: no lock file, no pid kills.
8. **No fallback topology in the binary.** The work lives on `feat/three-process` until the spike
   measurements, the full remote e2e and a real installer pass all succeed; rollback = don't merge.
   Only the topology-neutral host refactor (§12) lands on `main` earlier.
9. **The server is the sole PTY writer.** Keystrokes reach it as C2 `term.input`; they, notices,
   timed messages and the add-dir paste all go through its one serialized PtyWriter, each with its
   v0.51 policy. hc's `terminal.send` is never used: it is atomic behind its own quiet gate, so it
   can't host the Enter recheck.
10. **Settings split by consumer.** The server owns and solely writes the keys it reads
    (`server-settings.json`, atomically, private to it); the app owns and solely writes the UI keys
    (`settings.json`). The app never strips v0.51's server keys from `settings.json` in this
    program: it mirrors the server's values there, so an older build still reads current ones. That
    mirror is the app's only source for server keys before the snapshot; it never reads the server's
    file.
11. **Spawn recovery never decides from absence.** Every launch has a reservation: a token row with
    a launch id that is also the run's hc name and `conduit.launch` label. A reply resolves it; a
    core connection lost before the reply leaves it `unconfirmed`, and no clock ever does. It is
    never revoked because hc doesn't list it, never retried by itself. A terminal with that name registering at any later time is adopted; otherwise
    a person (Retry launch / Discard) or the calling agent resolves it. A new launch gets a new id,
    and a late registration of the superseded one is killed and logged. Pinned hc registers a run
    only after holder and env preparation, drops a timed-out `keep:false` record, and prunes finished
    records after a day or past 500, so Conduit records every outcome as soon as hc reports it.
12. **The host is refactored to ports on `main` first**, in today's topology with no behaviour
    change, so the branch imports it instead of forking it. The same step moves
    `electron/conduit-mcp-host.ts` to `src/conduit-mcp/host.ts` and `mcp-install.ts` to a
    topology-neutral module, gives the token store its own port over today's in-memory registry, makes
    `prepareLaunch` async behind a launch port, and splits the tool gate so server actions whose
    policy is `on` need no ready window (today only a window's not-ready instant changes).
13. **Reuse hc first.** If herdr-core already provides something, Conduit uses it and does not
    rebuild it, unless a stated need forces otherwise. The architecture's reuse audit lists each case:
    OSC 7501 status is the primary attention source; hc's `foreground` replaces Conduit's cwd and
    typed-CLI scanners (if the spike confirms it on Windows); the scrollback ring, the headless
    screen model, the supervisor and local identity files (rather than hc documents) stay, each for a
    stated reason.
14. **The MCP host runs in-process in the server**, behind C7 ports; agents reach Conduit through
    MCP, not a CLI; the server is TypeScript on bundled Node. The boundaries are wire protocols, so
    each can change later without touching the app, shims or hc.

## Consequences

- **Survival:** agents and their MCP identity survive app quit, crash (incl. *End task*), update and
  server restart. After a reboot nothing comes back, since terminals run with `keep:false`. Sessions
  are `stale` with their scrollback replayed, as today; conversation resume stays separate work.
- **Quitting:** quitting no longer stops agents. A new action, "Quit and stop all agents", does.
  Uninstalling stops them after a prompt; an update never does.
- **Server crashes:** the supervisor restarts the server with backoff; after 5 crashes in 10 min it
  leaves `server-exhausted.json` and waits 30 minutes before trying again (Retry in the app ends the
  wait). During a restart output keeps flowing to the app, but
  keystrokes are dropped and the pane says "Reconnecting — input paused". If no server can run, the
  app still opens: the editor and UI settings work, server settings are read-only, terminals and
  MCP are off, and a banner names the log and offers **Retry**. A hung server waits for an explicit
  **Restart Conduit's background service**; the app never kills it on its own. If the supervisor
  itself vanishes while the app runs, the app starts one again, up to 3 times an hour; with no app
  open, the bus stays down until the next app launch.
- **Typing latency:** keystrokes take one extra local hop through the server (+~1 ms, measured in
  the spike).
- **Resize:** bytes in flight for the old grid still reach the newly sized screen, exactly as with
  node-pty today; ConPTY's post-resize repaint corrects them.
- **hc bumps:** an older core that still serves the hc subset keeps running live agents; only an
  incompatible one asks to restart agents.
- **Downgrade:** an older app never restarts a newer running server; it offers to stop all agents
  through a frozen `server.stopAll`. v0.51 and older can't: the release notes say to quit Conduit
  and stop all agents before installing one, and it reads the server keys mirrored in its own
  `settings.json`.
- **Approvals:** an ask with no app connected for more than 5 s is denied (`ui_unavailable`) and
  recorded in its thread. Nothing is approved without a person. Server actions (opening and
  closing sessions, attaching folders, messaging) whose policy is `on` run with no window open. A
  close with no window open can't check for unsaved editor buffers, which exist only in an open app;
  with a window it refuses on unsaved changes, as today.
- **Unconfirmed launches:** a launch whose hc reply was lost waits as `unconfirmed` for a late
  registration or a person. A superseded launch that registers late runs briefly, as a duplicate,
  until the server kills it (accepted).
- **Stopping:** stop-all and restart first refuse new starts and settle in-flight launches for up
  to 10 s, so "stop all agents" can't return while a launch registers behind it.
- **Notifications:** OS notifications appear only while the app runs.
- **Trust (accepted residual):** hc puts its pipe and session name into every terminal, so a
  shell-capable agent can drive hc directly (type into or kill siblings, or `hc kill` the server's
  supervisor) without Conduit's Off/Ask/On. Its own `hc run` lands in Conduit's session and counts
  against idle exit. Conduit's policy governs MCP tool calls; agents with a shell can also reach
  Conduit's hc session directly. The app ↔ server pipe is likewise open to any same-user process;
  `hello` reserves an optional auth field for later. The release notes say so, and an upstream
  request asks hc for a per-terminal opt-out of env injection.
- **Persisted files** are a cross-version edge too: each versioned server format keeps its existing
  version field, and a server refuses a newer one instead of misreading or overwriting it. A few
  unversioned formats are listed exceptions.
- **"Restore sessions" off** now only stops reopening sessions that aren't running: sessions with a
  live agent are always kept, so they survive a server restart.
- **Repo tracking stays in the app**, merged over the server's session list; the server supplies
  only the working directory.
- **Disk:** about 80 MB per kept runtime version (the newest two are kept; a dir is deleted only once
  it can be renamed, i.e. no process runs from it).
- **A corrupt token store** adopts and kills nothing and shows as degraded, rather than killing
  every agent. MCP answers shims "draining" meanwhile, so they keep retrying instead of giving up.
- **Degraded start:** if hc can't start, the editor and everything else that doesn't need terminals
  still works, and terminals show as unavailable with the log path.
- **New external dependency:** hc's 0.x protocol (one maintainer, weeks old) and its Windows issues.
  Pin exactly; bump only with a remote `--full` e2e.

## As built (2026-11-02)

The decision stands. The build differs from the text above in these places:

- **Cwd and typed-CLI detection don't use hc `foreground`** (decision 13). On Windows it reports
  only a terminal's root process, so typed CLIs never show up, and it misses PowerShell
  `Set-Location` (spike M27 failed). The server runs the ported `CwdScanner` + `cwdGate` and the
  cwd OSC injection on terminal output; typed-CLI detection stays `detectTyped` on `term.input`.
  An upstream request is filed.
- **No separate walking skeleton (W3b).** It never ran as its own lane; the W7 slice 2 e2e set plus
  `test/e2e/server-standalone.e2e.mjs` stand in for it.
- **A discarded screen model is reseeded from an observer attach.** Past the backlog bound the
  server keeps its active attach and reseeds from an observer's paint, because re-taking the
  active attach would feed the ring the same bytes twice or drop the ones in between.
- **The paint cap is armed when the attach is held**, not at the first byte, so a paint with no
  bytes still ends.
- **XDG isolation is kept for our core.** Panes inherit the core's env and hc can't unset a
  variable (M22), so each `XDG_*` the user doesn't have reaches panes as `""`; the user's own
  values pass through unchanged.
- **Every hc call that may start a core runs with cwd `runtime/hc/<hcVersion>`** (M21: a cwd, not
  mapped images, is what blocks the GC rename). The supervisor `chdir`s to its own runtime dir at
  startup for the same reason.
- **The app starts the supervisor with `hc run`** (the CLI, `electron/hc-cli.ts`), env from
  `coreStartEnv` over the app's own env (no `HC_*`, isolated XDG), by its unique name. If `hc run`
  fails for any reason other than the name being taken, it spawns the supervisor directly as a
  detached Node process with the same env.
- **Spawn env sets `TERM_PROGRAM=conduit` and `TERM_PROGRAM_VERSION`** (M10); hc would otherwise
  default to `ghostty`.
- **Accepted residuals added by the spike:** the C2 and MCP pipes accept same-user remote (SMB)
  clients and are readable by any local user (M28); detached processes end with their session
  (M23); a kill-on-close job without breakaway that starts the core takes it down (M17, to be
  re-measured with the real installer).

## Alternatives rejected

- **Fork herdr-app.** It would keep Herdr's thinnest layer and drop Conduit's thickest: no web view,
  editor or LSP in GPUI.
- **Upstream PRs only, no adoption.** Leaves the PTYs in the main process.
- **Build our own runtime now.** It re-solves update handover and crash adoption on ConPTY. Kept as
  the fallback.
- **MCP host inside hc.** A permanent fork, and it ties policy releases to the runtime's.
- **Server on Electron-as-Node from the install dir.** The installer locks or kills it (critique-1 B1).
- **Server as `utilityProcess`.** It dies with the app.
- **A runtime setting with both topologies.** Two code paths in `main.ts` for a fallback that the
  branch already gives us.
- **Native UI (GPUI or similar).** Years of rebuilding; the split leaves room for it later.
- **A separate MCP process.** Another internal protocol and lifecycle; revisit only for crash
  containment, separate scaling or a privilege boundary.
- **A `conduit` CLI as the agent surface.** Codex's sandbox can't run `hc` and Cursor needs an
  allowlist entry, while harnesses launch MCP shims themselves. A thin CLI over the same server stays
  a later option.
- **A server in Go or Rust, or on Bun or Deno.** A rewrite for footprint gains that don't matter for
  one local daemon; Bun and Deno lack the libuv Windows behaviour (pipe first-instance, kill-on-close
  jobs) measured on Node 24.
