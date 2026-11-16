# CON-35 UI orchestrator state (claude-25; lead claude-3)

Read first after a compaction. Ledger: `.autoloop/` in /home/namemenima/projects/.wt/conduit/CON-35-ui (tasks.yaml, learnings.md, blockers.md, evidence/). Brief: `.autoloop-ui-brief.md`.

## Now (updated ~16:35Z, pausing for usage)
- CON-41 DONE (0599abdb on CON-35-remote-ssh; reported).
- CON-47 DONE-merged (718b90ba; reported). Test fix 2988afbd (net-agent-setup OS-aware) + CSS guard fix 2296ea78 ride the next merge. Blocked: Task 0 installer measurement (owner, blockers.md).
- CON-43: complete on CON-35-ui; verify EXIT=0 at 8d1c6e37; local e2e net-remote-files PASS; sent "CON-43 ready: 8d1c6e37" to claude-24 (carries CON-45 groundwork => minor 5 = CON-45, CON-46 -> 6). NEXT: claude-24's merge SHA -> e2e:remote --affected -> report CON-43 to claude-3. Follow-up: the remote tab's 'Read-only: this file is on <machine>' note wasn't visible in the e2e screenshot — check it renders.
- CON-45: contracts b99e7809 + 55aa0455 (status snapshot null = no repo; Changes polls 5 s + .git watch). Merged: G0 (git-show), G2 (git-client), G3 (electron). G4 merged. G1 (../CON-45-G1, branch CON-45-G1 at 14ecbbfe) fixed both security blockers + no-repo answer, all guards mutation-verified; Opus security re-review running. NEXT after both: Opus re-review G1 (security), merge, then Slice 2 wiring (remote-diff / remote-history viewers, RightPane onOpenRemoteDiff/History with ABSOLUTE paths, skip isRemoteKind in rename/delete closers at app.tsx ~4134), e2e net-remote-git. Link minor 5 is provisional (renumber at merge if CON-46 lands first; minors are cumulative).
- CON-44: plan a640328e + f4f7e956 (CodeViewer shape: injected saves + bufferKey + projectBound + model ownership). Not started.
- Follow-up CON-42-ui (answer UI for mirrored remote asks; machine names on request cards) queued.

## Coordination
claude-24 (server track) agreed: drive grant to inbound ssh controller; forget = local remove (no tombstone). calls.ts settleAbsent already rejects pending calls for removed machines. Their slice 7 edits index.ts frame dispatch (auto-merge expected). Message them before every merge.
