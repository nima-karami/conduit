# Architecture critique — round 7 (fresh Opus critic, 2026-11-02)

Reviewed revision 7 against the product intent (three pillars; the settled three-process decision,
with the server as the home of the pillars). The Codex review of the same revision is in `codex-review-7.md`.

**Verdict: REVISE.** One blocker: the agent launch path crosses the W4↔W5 seam without a C7 port.
Nothing in the design would have to be undone for a task/artifact store or for long-running leads.
A few single-client and co-location assumptions are cheap to fix now.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟡: facts/focus before the first attach; the first-launch server settings |
| 2 | Boundary quality | 🟡: the launch seam; the host stays in `electron/` |
| 3 | Pattern restraint | 🟢 |
| 4 | Data & state modeling | 🔴: token reserve + MCP wiring at launch, the generation allocator, the focus/facts producer, the window-event carrier, two sources for the server keys |
| 5 | Change tolerance | 🟡: presence assumes one app; hello has no extension rule; the app reads the server's private files |
| 6 | Failure & scale realism | 🟡: reconcile races an in-flight spawn; the headless-parse backlog is unbounded |
| 7 | Decision capture | 🟢 |

**Blocker.** The launch seam (`prepareLaunch`, `whenLaunchReady`, `onSessionDeleted`; `conduit-mcp-host.ts:1306`) has no C7 port. Direction: a W5 `LaunchPort`, made async in W0b.

**Should-fix.**
- **S2** No single producer for `generation`.
- **S3** Reconcile on a core reconnect revokes rows that an in-flight spawn owns.
- **S4** The app's own hc calls skip the HC_* strip and `no_parent`. A Conduit launched from a pane parents its supervisor to that pane.
- **S5** The app has two sources for the server keys, and the first v0.52 launch reads a missing file.
- **S6** `term.focus`/`term.facts` have no renderer producer, and the core answers display queries without facts.
- **S7** `onSessionMoved`/`onWindowReset` have no carrier.
- **S8** The headless backlog is unbounded in a month-long daemon.

**Nits.** Move the host to `src/` in W0b. Key presence by connection. Give hello an extension rule. Keep `AttachTarget` opaque (the cloud seam). List supervisor crash with no app as a residual. Name the `attention.edge` wiring.
