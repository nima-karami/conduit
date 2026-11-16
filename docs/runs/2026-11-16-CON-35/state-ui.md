# CON-35 UI orchestrator state (claude-25; lead claude-3)

Read first after a compaction. Ledger: `.autoloop/` in /home/namemenima/projects/.wt/conduit/CON-35-ui (tasks.yaml, learnings.md, blockers.md, evidence/). Brief: `.autoloop-ui-brief.md`.

## Now (updated ~16:35Z, pausing for usage)
- CON-41 DONE (0599abdb on CON-35-remote-ssh; reported).
- CON-47 DONE-merged (718b90ba; reported). Test fix 2988afbd (net-agent-setup OS-aware) + CSS guard fix 2296ea78 ride the next merge. Blocked: Task 0 installer measurement (owner, blockers.md).
- CON-43: all lanes (T1..T4, R) merged into CON-35-ui; e2e lane CON-43-e2e (worktree ../CON-43-e2e) writing net-remote-files. NEXT: merge e2e, full verify under lock, look at shots43 screenshots, send "CON-43 ready: <sha>" to claude-24 (it merges in its worktree; link minor 4 is CON-43's), then e2e:remote --affected, report.
- CON-45: contracts b99e7809 + 55aa0455 (status snapshot null = no repo; Changes polls 5 s + .git watch). Merged: G0 (git-show), G2 (git-client), G3 (electron). In flight: G1 (../CON-45-G1, B git-serve) fixing 2 security blockers from its review (rename out of denied name leaks via show; .git gitdir pointer escape) + no-repo answer; G4 (../CON-45-G4, renderer) fixing review items. NEXT after both: Opus re-review G1 (security), merge, then Slice 2 wiring (remote-diff / remote-history viewers, RightPane onOpenRemoteDiff/History with ABSOLUTE paths, skip isRemoteKind in rename/delete closers at app.tsx ~4134), e2e net-remote-git. Link minor 5 is provisional (renumber at merge if CON-46 lands first; minors are cumulative).
- CON-44: plan a640328e + f4f7e956 (CodeViewer shape: injected saves + bufferKey + projectBound + model ownership). Not started.
- Follow-up CON-42-ui (answer UI for mirrored remote asks; machine names on request cards) queued.

## Coordination
claude-24 (server track) agreed: drive grant to inbound ssh controller; forget = local remove (no tombstone). calls.ts settleAbsent already rejects pending calls for removed machines. Their slice 7 edits index.ts frame dispatch (auto-merge expected). Message them before every merge.
