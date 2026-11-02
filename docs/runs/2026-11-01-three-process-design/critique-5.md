# Architecture critique — round 5 (fresh Opus critic, 2026-11-01)

Reviewed revision 5 (server as sole writer and active viewer, app as observer).

**Verdict: REVISE.** The core split holds up: server as sole writer, hc unforked, hashed token rows, a
frozen shim edge. The problem is the server's lifecycle. There are several restart authorities, a
lock that kills by pid, and timeouts that collide, which makes durability self-defeating. Several
cross-lane producer/consumer seams also lack an ordering rule.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟡: QA #3 is reworded rather than met (hc lets an agent bypass `send_message: off`) |
| 2 | Boundary quality | 🟡: C7 covers half of W4↔W5; W7 is a serial god-lane |
| 3 | Pattern restraint | 🟡: the liveness stack overlaps itself |
| 4 | Data & state modeling | 🟡: settings seed race; whole-object `updateSettings`; ring resets under load |
| 5 | Change tolerance | 🟡: copy-then-delete forks the host; MIN core = pinned defeats feature detection |
| 6 | Failure & scale realism | 🔴: duelling restarts, unverified pid kill, unspecified re-attach size |
| 7 | Decision capture | 🟢 |

**Blockers.**
- **B1** Restart authorities contradict each other. The supervisor backs off (up to 30 s, giving up after 5 crashes), while the app waits 15 s and then starts a second supervisor. A supervisor that gave up gets restarted by the app, so crash loops are unbounded. The app's 5 s hello timeout races the server's 5 s lock wait. F6 starts a new supervisor before the old one exits.
- **B2** The orphan rule kills a pid from a lock file that can survive a reboot, while the pid itself may have been reused (e.g. the user's `cmd.exe`). The named pipe (FIRST_PIPE_INSTANCE) is already an exclusive singleton, and a hung server is reachable through its role=server terminal.

**Should-fix.**
- **S1** Settings seed race: the app strips server keys before the server has seeded them. The renderer's whole-object `updateSettings` can revert another window's policy change.
- **S2** Re-attach size is unspecified, so a reconnect can resize every PTY. Use the hc record's size, or `resumed`.
- **S3** The ring resets on ">4 MiB behind", which a flood or a slow headless parse triggers. Grant credit on ring append, or add a gap marker instead of a reset.
- **S4** C7 lacks the domain deps: defOf, agentIds, projectName, installState, messagingOn, toolPolicy, ControlDeps.
- **S5** Copying `conduit-mcp-host.ts` forks it on a long-lived branch. Refactor it to ports on main first.
- **S6** Containment: no upstream request for an env-injection opt-out, and QA #3 is overstated.
- **S7** `HC_MIN_CORE_VERSION = PINNED` makes every hc bump stop agents unless M13 passes.
- **S8** Keystrokes during a C2 outage are undefined; buffering could answer a prompt late.
- **S9** No end-to-end path exists until W7. Build a thin vertical slice after W3.

**Nits.**
- **N1** The mirror file duplicates `server-settings.json`.
- **N2** `.gc.lock` duplicates the single-instance lock and has the same pid-reuse flaw.
- **N3** Rows whose address hc doesn't know.
- **N4** Uninstall `--stop-all` semantics.
- **N5** The idle exit stops the core from inside it.
- **N6** Name the job-object mechanism (libuv kill-on-close).
- **N7** Drop the superseded rows.
