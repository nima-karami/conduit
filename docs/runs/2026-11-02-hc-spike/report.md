---
date: 2026-11-02
spec: docs/specs/2026-11-01-hc-runtime-spike.md (rev 9)
phase: A (hc CLI + throwaway Node/PowerShell scripts; no Conduit build)
---

# hc runtime spike — phase A report

**Environment.** hc **0.1.16** (`%LOCALAPPDATA%\Programs\herdr-core\hc.exe`, the only hc binary on the
machine), Windows 11 Pro 10.0.22621, Node 24.18.0, Windows PowerShell 5.1 (no `pwsh` 7), Claude Code
2.1.316, Codex 0.165.0. Every hc call ran in a private `HC_SESSION=conduit-spike-fdc738cc[-*]` with
`HC_TERMINAL_ID/HC_TERMINAL_SOCKET/HC_SCOPE` stripped; the user's default session was never touched.
Raw logs: `raw/*.txt`. The JSON-RPC client was a 100-line throwaway (plain lines and framed mode).

## Verdicts

| # | G | Verdict | One line |
|---|---|---|---|
| M9 | | **PASS** | Nothing Conduit uses needs `sh`; only hc templates do (not used) |
| M10 | | **PARTIAL** | Pane env = core env < fresh registry user/machine vars < `env` spec < hc's `HC_*`; hc adds `TERM_PROGRAM=ghostty`, `TERM=xterm-256color`, `COLORTERM=truecolor` when unset |
| M12 | | **PARTIAL** | hc bundles OpenConsole/conpty 1.24.2607.10001 (node-pty: 1.25.2603); xterm's `buildNumber` only gates at 21376, so the OS build stays right; render check is phase B |
| M13 | G | **NOT MEASURABLE NOW** (version) / **PASS** (path) | No second hc version obtainable; `server restart` from a different binary path keeps live terminals, old holder drains |
| M17 | G | **PASS**, one **FAIL** sub-case | taskkill /T, pane launch with `HC_*` stripped, job with breakaway: all survive. A kill-on-close job **without** `BREAKAWAY_OK` that starts the core kills core, holder, supervisor and child |
| M21 | G | **PASS, premise changed** | Rename-to-`.gc` fails only because of a **cwd**; mapped exe/DLL images don't block it. Works for hc only if the core starts with its cwd in its runtime dir (holders inherit it) |
| M22 | | **FAIL** (spec criterion) | hc honours `XDG_CONFIG_HOME`/`XDG_STATE_HOME` on Windows, but panes inherit ours and `terminal.run.env` can't unset (only set `""`) |
| M23 | | **PASS** | `hc kill` of the supervisor terminal or TerminateProcess of it kills `main.js` (libuv job); hc kills a terminal's whole job, even `detached` grandchildren |
| M24 | G | **PASS** (b, d) / **PARTIAL** (c) | A run whose connection drops before the reply still registers 22–64 ms later (negative lookups first, then `created`); fast exit keeps output + exit code via `terminal.read`; late-after-replacement ordering not forceable, but kill-by-name of the late one works (28 ms) |
| M25 | | **No opt-out** | `HC_*` in `env` are overwritten; no config key suppresses injection or picks the session |
| M26 | | **Answered** | Attach paint carries full SGR (dim etc.) and parses cell-exact in @xterm/headless; `terminal.read` is plain text |
| M27 | G | **FAIL** | On Windows `foreground` is only the terminal's **root** process: typed CLIs (node, claude, codex) never appear; cwd follows cmd `cd` (311–486 ms) but not PowerShell `Set-Location` |
| M28 | | **FAIL** | Node's pipe server accepts SMB-loopback (= remote) clients; no listen option changes it. Default DACL: SYSTEM/Admins/user full, **Everyone and ANONYMOUS read**. hc's own pipe: protected, owner + SYSTEM only, rejects remote |

## Key observations

- **M10/M5 env:** under hc the spawn spec must set `TERM_PROGRAM`/`TERM_PROGRAM_VERSION` explicitly
  (today `sanitizeChildEnv`, `src/pty-host.ts:52`, strips it; hc would default to ghostty and answer
  XTVERSION with it). `PSModulePath` arrives unexpanded. A var can only be overridden, never removed.
- **M17:** Task Manager *End task* = the taskkill /T case (survives). Which real launchers use a job
  without breakaway (installer run-after-finish, CI) is open → re-check in M16.
- **M21:** a GC that renamed a live dir would delete its unmapped files (`conpty.dll`, `OpenConsole`).
  Rule: every hc invocation that may start or restart a core runs with cwd =
  `<userData>/runtime/hc/<hcVersion>`.
- **M22:** without XDG, state is already per session (`%LOCALAPPDATA%\herdr-core\<session>`); only
  config + templates are shared. Config keys in the binary: `shell`, `wait_timeout`, `notes`,
  `notes_quiet`, `headless`, `history_mb`, `socket`, `machine_timeout`, `detach_key`.
- **M24(b):** the caller's disconnect never cancels a run; reply latency ~27 ms.
- **M27:** node run directly as the terminal argv: reported, cwd followed at +2181 ms (one sample);
  sampling ~2/s; `events.subscribe` docs omit `foreground` but the events arrive; `run` reply has no
  `foreground`.
- **Framed mode (C3 client):** control replies arrive **one JSON message per DATA frame without a
  trailing newline**; the attach reply precedes its first DATA frame. Default spawn size 200×120.
  `terminal.run` argv is quoted MSVCRT-style; use `line` for `cmd /c "…"` with embedded quotes.

## Contradictions with the design (resolved in the lead decisions below)

1. D23 "covered by their mapped images" — false; cwd only (M21).
2. D38 `foreground` as the single cwd/typed-CLI source — fails on Windows (M27).
3. D24 `isolateXdg` "absent here too" can't hold in panes (M22).
4. D16 residual understates C2/MCP pipe exposure (M28) — also today's `conduit-mcp-<h>`.
5. Spawn env must carry terminal identity (M10).
6. Detached children die with their hc terminal (M23) — behaviour change vs node-pty.
7. M17 job sub-case.

## Lead decisions (2026-11-02)

- **M27 → D38 fallback:** W4 ports `CwdScanner` + `cwdGate` + the cwd OSC injection onto C1 `data`;
  W5 keeps `detectTyped` on `term.input`. `foreground` is not used. Upstream request filed (below).
- **M22:** keep XDG isolation for our core; for each `XDG_*` the user has **absent**, panes get `""`
  (the XDG base-dir spec treats empty as unset). Users' own values pass through unchanged.
- **M21:** C4 gains a core-start cwd rule: `runtime/hc/<hcVersion>`, applied to every hc invocation
  that may start or restart a core (app's supervisor start, any `hc server restart`).
- **M10:** the C1 spawn env sets `TERM_PROGRAM=conduit` and `TERM_PROGRAM_VERSION=<app version>`
  (generic to CLIs, a sane XTVERSION answer); M4 re-checks display answers in phase B.
- **M17:** accepted residual for now; documented; re-measured with the real installer in M16. If the
  installer's run-after-finish is such a job, the app starts the core through a broker outside the job.
- **M28:** accepted residual; D16 wording corrected (remote SMB clients with credentials; read-only
  open by any user). Never push data to a connection before its `hello`. `hello.auth` stays reserved.
- **M23:** release-note line: background processes started inside a session end with that session.

## Pending (phase B)

M1, M2, M3, M4, M5, M6, M7, M8, M11, M14, M16 (incl. M16-lite), M18, M19, M20; M13 when a second hc
release exists; M27 for `pwsh` 7.

## Upstream requests (collected)

- `foreground` on Windows: the console's foreground process, not the root (M27).
- Per-terminal env-injection opt-out / chosen injected session (M25, D16).
- A way to unset a variable in `terminal.run.env` (M22).
- Template commands without `sh` on Windows (M9).
- Keep `spawn_pending` under `keep:false` (D21) and an end-of-paint marker (D20).
