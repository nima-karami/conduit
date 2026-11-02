---
status: active
date: 2026-11-01
revision: 9 (after critique-8 and cursor-review-8)
---

# hc runtime spike — can herdr-core run Conduit's terminals on Windows?

This is phase 2 of `2026-11-01-three-process-program.md` (workstream W2). It runs on the W1 hc
client, through a throwaway harness. The spike feeds two decisions: ADR 0007 §1 (adopt hc, or
build our own runtime behind C1), and whether C1, C3 and C5 change before they freeze. Output:
`docs/runs/2026-11-xx-hc-spike/report.md`, with each measurement's hc version, method, raw numbers
and verdict. No product code ships from it.

## Measurements

Gate measurements: **G** means a failure stops the program at a lead decision point.

| # | What | Pass | |
|---|---|---|---|
| M1 | Spawn Claude Code and Codex via `terminal.run` with the token in `env`; MCP `initialize` resolves the right handle through today's shim. Also a Claude/Codex **typed into a shell session**, across a server update (D28) | Both CLIs join messaging unchanged; the typed shell session survives the update and still gets notices | |
| M2 | Attach → xterm.js first paint after the viewer restarts, mid-session | Cell-exact screen, no lost lines, no re-armed mouse modes | G |
| M3 | Resize with the server as active viewer applying the app's requested sizes, and the app as an observe viewer: grow and shrink rows and cols repeatedly | PTY size always equals the xterm size; no ConPTY repaint loss; the observer never takes over size | G |
| M4 | ConPTY input: Claude's and Codex's query/answer escapes, bracketed paste, `windowsPty` reflow; xterm's focus reports inside `term.input` (no FOCUS frames); display queries (colors, cell size) answered by the core from the facts passed as `display`, incl. a windowless spawn with none | No dropped or garbled input; prompts submit; focus-driven UI behaves as today; display answers match today's or the gap is listed | G |
| M5 | Throughput: 50 MB flood, then interactive latency with keystrokes through the server (`term.input`, one extra local hop); the screen model's 8 MiB backlog bound (D18) under a flood with a slowed parse | No stall; keystroke echo ≤ node-pty + 5 ms p50; past the bound the model is discarded, the notice gate fails closed, W6 re-attaches once the backlog drains and that attach paint reseeds it, and the ring is intact | |
| M6 | `hc` core restart and a core kill with a live agent mid-turn | Agent keeps running; exact screen after handover; the server's active attach (at the record's size, `resumed: true`) and the app's observers reattach by reconcile, not `restarted` (F10); the PTY size never changes; a terminal that finished meanwhile is recorded with its exit code and final output (`terminal.read`), not as `lost` | |
| M7 | Viewer quit → relaunch with 6 live sessions | All six adopted by recorded address + launch id, statuses right | |
| M8 | History: hc's history vs our scrollback ring for the same session; where a paint ends (first paint, >4 MiB repaint); whether hc history could serve a live re-attach, which C5 already uses (D33) | hc replays everything the terminal showed, or the gap is listed; a boundary rule for C1 `paint` is fixed (D20) | |
| M9 | No `sh` on PATH (clean Windows user) | Everything we use works | |
| M10 | Env parity: hc refreshes user/system env for new terminals | Spawned env = node-pty's env given the same spec, or the diff is listed and judged | |
| M11 | The server as sole active viewer: typing latency over `term.input`, xterm's focus reports and the renderer's facts (`term.facts` before `sessions.start`, then `display` on every attach), no size fights with an app observer; notices, timed messages and add-dir through the server's PtyWriter | Echo within M5's budget; focus reports and facts reach the program; the size never flips between viewers; each intent behaves as today (queue-slot gate, echo evidence, Enter withheld on human input or non-echo output) | G |
| M12 | ConPTY build: hc's bundled `conpty.dll`/OpenConsole | Claude/Codex render right; the `windowsPty.buildNumber` to hand xterm is known | |
| M13 | hc bump: a running core hands over to a **different** hc binary | Yes, with live terminals kept; or F11's path is confirmed workable (a compatible older core keeps running, D30) | G |
| M14 | First-attach repaint: spawn at the default size, attach at the pane size | Claude/Codex show a usable screen after one repaint | |
| M15 | Env leakage | **Measured 2026-11-01:** hc 0.1.16 injects `HC_SESSION`, `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID`, `HC_SCOPE` (settles D16) | done |
| M16 | Installer pass: a real NSIS update with live agents, server and hc in `userData/runtime`, and a pre-existing v0.51 user-config shim entry; an update **from** a build that already contains the guarded `customUnInstall`; first-launch runtime copy time under Defender. **M16-lite** (stub server, real one-click update) runs in this phase | Agents, tokens and MCP survive; no locked-file failure; the old entry is migrated; the uninstall hook does nothing on update; the copy fits the 3 s budget or the gap is listed | G |
| M17 | Tree-kill: Task Manager *End task* on Conduit, `taskkill /T`, a launch from inside a job (Windows Terminal, the installer's run-after-finish), and a launch from inside a Conduit or Herdr pane | The supervisor and server (as an hc terminal) and every agent survive; from a pane, the supervisor lands in `conduit-<h>` with no parent (`HC_*` stripped, `--no-parent`) | G |
| M18 | `prelude` replay, then hc's first paint; an app relaunch's observer attach with `history: 2000` on a live session | History stays visible above the new program's screen; scrollback above a live screen survives the app relaunch | |
| M19 | Buffered output during a resize (D31): a program floods output while the app requests repeated size changes, so old-grid bytes are in flight to both the app observer and the server's model | After ConPTY's post-resize repaint settles, both screen models equal hc's screen; paints never counted as activity | G |
| M20 | Server restart with a draft typed before it: draft state unknown | The gate treats it as a draft unless the screen verdict shows an empty input box | |
| M21 | GC rename test (D23; no leases, Node 24 has no `UV_FS_O_EXLOCK`) against a live hc core, a draining holder after an hc bump, and a live server | Renaming each dir to `<dir>.gc` fails while it is in use, and succeeds once it isn't | G |
| M22 | XDG isolation (D24): our core with `XDG_CONFIG_HOME`/`XDG_STATE_HOME` under `userData/hc/`, incl. a user who has **no** XDG set (hc's documented Windows config is `%APPDATA%\herdr-core\config.toml`) | hc reads its config and state there on Windows; panes see the user's own XDG values, or none, not ours. **Fail** (hc ignores `XDG_CONFIG_HOME`, or panes inherit our values, which `terminal.run.env` can't unset): Conduit sets no `XDG_*` for its core, which shares the user's `%APPDATA%\herdr-core` config and templates (D24) | |
| M23 | Supervisor death (D17): `hc kill` of the `conduit-server-<h>` terminal | `server/main.js` dies with it: the supervisor's non-detached child sits in libuv's kill-on-close job object; a job-assignment failure is listed | |
| M24 | Spawn recovery (D21): (a) a second `terminal.run` with the `name` of a live terminal; (b) a run whose core connection drops before the reply, while it is still preparing (holder/env setup before it registers); (c) a superseded launch that registers after its replacement; (d) a program that exits before the server's attach | (a) refused with a stable error kind (the schema lists `name_taken`), and `terminal.get` by that name returns the first; (b) the row stays `unconfirmed` through negative lookups and reconciles, and the later registration is adopted from its `created` event; (c) it is killed and logged, and only a brief duplicate run is observed; (d) `terminal.read` returns its final output, which reaches the ring, and the exit is recorded | G |
|  | **Partly measured 2026-11-01 (hc 0.1.16):** a second `hc run --name X` while X is live fails with kind `name_taken` ("a live terminal is already named …"). Source-read (codex-review-7): a `keep:false` timeout removes the record (`run.rs`), registration follows holder/env preparation, finished records are pruned after a day or past 500 (`terminals.rs`). Still open: (b), (c) and (d). |  |  |
| M25 | Env-injection opt-out (D16): whether hc config already allows suppressing `HC_*` injection per terminal, or choosing the injected session | Answered either way; feeds the upstream request | |
| M26 | Screen model reuse (D33): whether hc's attach paint plus our parse, or `terminal.read`, could replace the server's headless model for `screen-verdict` | Answered either way; `terminal.read` alone lacks the per-cell dim styling the verdict needs | |
| M27 | hc `foreground` (D38): latency and accuracy on Windows for pwsh, cmd, a Claude and a Codex typed into a shell, and a `cd` in each shell; incl. a cwd change while a CLI runs | `foreground.cwd` follows each `cd` within ~1 s and `foreground.argv` names the typed CLI before its MCP `initialize`; **fail**: W4 ports `CwdScanner` + `cwdGate` (and the cwd injection) onto C1 `data`, W5 keeps keystroke inference | G |
| M28 | C2 exposure (D16): whether the Node named-pipe server for `\\.\pipe\conduit-server-<h>` rejects remote clients, and the pipe's effective DACL | Remote clients rejected (by default or by a listen option we then set), DACL recorded; feeds the residual's wording | |

Notes:
- The full M16 needs W9's packaging and runs again in phase 5.
- The harness gives each run its own `HC_SESSION` and stops it at the end. It never kills processes
  by name and never touches the user's own hc session.
- File the upstream request to keep `spawn_pending` under `keep:false` (D21) with the others.
- File the upstream request for an explicit end-of-paint marker (D20) when M8 reports, and the
  env-injection opt-out (D16) when M25 reports.
- If a newer hc release ships `resize_notifications`, the observer path gets a byte-ordered resize.
  Not needed now: resize ordering stays today's, corrected by ConPTY's repaint (D31), and M19 gates
  that.
