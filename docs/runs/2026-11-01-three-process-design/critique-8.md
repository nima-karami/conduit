# Architecture critique — round 8 (fresh Opus critic, 2026-11-02)

Reviewed revision 8 through three lenses: the plumbing, reuse-hc-first, and fit with the product intent.

**Verdict: REVISE.** The plumbing is careful. The blocker: only main.ts's *renderer messages* were
inventoried, so its internal subscribers on the PTY output stream and on folder/repo state have no
owner or cross-process flow. The reuse audit also misses hc's `foreground`, `doc.*` and `turn`.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟡: unowned output scanners; less history after relaunch; the C2 residual is unlisted |
| 2 | Boundary quality | 🟡: core start env split between app and server; the start rule trusts a forgeable label |
| 3 | Pattern restraint | 🟡: timeout-driven unconfirmed machinery; the unused `conduit.parent` |
| 4 | Data & state modeling | 🔴: C1 `data` consumers beyond ring/attention unassigned (cwd, paste mode, scopes); the user's XDG values have no producer; stopAll vs unconfirmed rows |
| 5 | Change tolerance | 🟡: persisted files are an unlisted cross-version edge; C2 has no client identity |
| 6 | Failure & scale realism | 🟡: an exhausted or killed supervisor with no app leaves the bus down forever |
| 7 | Decision capture | 🟡: "exactly three" edges is wrong; the audit is incomplete; 300–450-word cells with provenance tags |

**Blocker B1.** The `term:data` subscribers (`main.ts:1585–1633`): bells and inert scan, bracketed-paste
tracking, `scopes.output`, the limit scan, scrollback, `CwdScanner` → `cwdGate` → `setCwd`/`setAutoRepo`.
Also `SessionFolderRuntime.onFoldersChanged` (scope recompute + file-index prune) and `folders.focused()`.
None of these is in the ownership map. Direction: an "internal subscribers" table: owner + event per row.

**Should-fix.**
- **S1** hc `foreground` (`{pid,name,argv,cwd}` ~2/s, implemented on Windows in `foreground.rs`) would replace cwd OSC injection + `CwdScanner` + `cwdGate`, and typed-command keystroke inference. Add an audit row + M27.
- **S2** The audit omits `doc.*` (record why not: any same-user agent can `doc.set`) and `turn` (a native run-end).
- **S3** C2 is an unauthenticated control plane: plain `listen`, default DACL, no reject-remote; a shell agent can approve its own asks or flip policy. Add it to D16; optional `hello.auth`; verify libuv's remote behaviour.
- **S4** The start rule, the F6 wait and Restart key on the forgeable `conduit.role=server` label. Direction: a unique supervisor `name` + the address recorded via `hello`.
- **S5** Core start env has no single owner: XDG isolation is skipped when the app starts the core, and the user's XDG originals aren't captured.
- **S6** stopAll should mark pending launches `superseded`, not leave them `unconfirmed`.
- **S7** The 10 s confirm timeout manufactures unconfirmed launches. Resolve on reply or on connection loss only. Upstream request: keep `spawn_pending` under `keep:false`.
- **S8** Persisted server files are a fourth cross-version edge: schema version per file, ignore unknown fields, refuse a newer one.
- **S9** An exhausted supervisor should cool down (30–60 min) instead of exiting.
- **S10** Legibility: rules into cells, mechanics into flows, provenance into a changelog, lane rows as bullet lists.

**Nits.**
- **N1** Drop `conduit.parent`.
- **N2** A relaunch after a cold spawn loses the pre-reboot ring in the pane.
- **N3** The settings seed after downgrade → edit → re-upgrade.
- **N4** The server's headless xterm query answers are discarded.
