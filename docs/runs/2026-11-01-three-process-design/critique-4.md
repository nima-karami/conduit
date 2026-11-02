# Architecture critique — round 4 (fresh Opus critic, 2026-11-01)

Reviewed revision 4. A Codex review of the same revision is in `codex-review-4.md`.

**Verdict: REVISE.** The split is sound and well argued. Two gaps break the brief's own
requirements: nothing produces "attached", though the one-typing-owner invariant (D19) depends on it,
and the three parallel server lanes (W4/W5/W6) have no contracts between them.

| # | Dimension | Score |
|---|---|---|
| 1 | Requirement & QA fidelity | 🟢 |
| 2 | Boundary quality | 🟡: settings placement breaks the rule; the server-internal seams have no contracts |
| 3 | Pattern restraint | 🟡: appEpoch rebind and the copy-don't-import rule add unneeded machinery |
| 4 | Data & state modeling | 🔴: "attached" has no producer; ring reset per resize; a bad token store kills agents |
| 5 | Change tolerance | 🟢 |
| 6 | Failure & scale realism | 🟡: supervisor death, an unanswered `ui.type`, a corrupt `tokens.json` |
| 7 | Decision capture | 🟢 |

**Blockers.**
- **B1** The server lanes have no internal contracts. `ConduitMcpHostDeps` (`conduit-mcp-host.ts:123–173`) is the real seam (mgr, activity, screens, writer, control, pty), and attention is split across W4/W5/W6. Nobody owns the composition root.
- **B2** Nothing produces "this session is attached". After a server restart, presence is missing, so the server would `terminal.send` into a PTY the app is writing to. `ui.type` has no timeout rule either.

**Should-fix.**
- **S1** Settings: ~90% of `AppSettings` is UI state. Making the server their sole writer turns panel drags into RPCs and freezes the UI when the server is down. Split by consumer.
- **S2** The ring is reset by every resize re-attach paint and cut to the observer's N history lines.
- **S3** Consider pinning the first hc release that has `resize_notifications`.
- **S4** After an app relaunch, scrollback above the screen is lost for live sessions: C5 attach has no `history`.
- **S5** Reconcile kills every agent if `tokens.json` is corrupt or missing.
- **S6** Supervisor death while the app runs; is the child killed with it? Orphan lock recovery.
- **S7** The copy-don't-import rule forks ~8k lines and drops their tests.

**Nits.**
- **N1** Two producers for titles.
- **N2** The `unsupported_generation` welcome can never be sent.
- **N3** appEpoch is too much for a 5 s grace.
- **N4** C2 depends on renderer types W7 owns.
