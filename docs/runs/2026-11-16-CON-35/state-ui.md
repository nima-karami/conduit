# CON-35 UI orchestrator state (claude-25; lead claude-3)

Read first after a compaction. Ledger: `.autoloop/` in /home/namemenima/projects/.wt/conduit/CON-35-ui (tasks.yaml, learnings.md, blockers.md, evidence/). Brief: `.autoloop-ui-brief.md`.

## Now
CON-41 (slice 6): plan docs/plans/2026-11-16-remote-ssh-machines-ui.plan.md. All four lanes Opus-reviewed and merged into CON-35-ui (L2 9ca0e7fd, L4, L3, L1); lane worktrees removed. Wiring 5025bbdb (app.tsx activeRemote, Sidebar/CenterPane props, AddMachineDialog, palette, machinesUi setting 0602d5e0, CHANGELOG). Running: full verify on CON-35-ui (.autoloop/evidence/con41-verify-ui-1.log); e2e lane CON-41-e2e writing test/e2e/net-machines-ui.e2e.mjs (+ screenshots to scratchpad/shots for the visual check). Next: merge e2e, look at screenshots, merge protocol onto CON-35-remote-ssh (tell claude-24 first), e2e:remote affected, report to claude-3.
Follow-up card queued: CON-42-ui (Needs-you answer UI for mirrored remote permission asks + machine names on request cards), see .autoloop/tasks.yaml.

## Coordination
claude-24 (server track) agreed: drive grant to inbound ssh controller; forget = local remove (no tombstone). calls.ts settleAbsent already rejects pending calls for removed machines. Their slice 7 edits index.ts frame dispatch (auto-merge expected). Message them before every merge.
