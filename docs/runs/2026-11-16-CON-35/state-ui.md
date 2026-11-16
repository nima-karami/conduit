# CON-35 UI orchestrator state (claude-25; lead claude-3)

Read first after a compaction. Ledger: `.autoloop/` in /home/namemenima/projects/.wt/conduit/CON-35-ui (tasks.yaml, learnings.md, blockers.md, evidence/). Brief: `.autoloop-ui-brief.md`.

## Now (updated ~16:35Z, pausing for usage)
- CON-41 DONE (0599abdb on CON-35-remote-ssh; reported).
- CON-47 DONE-merged (718b90ba; reported). Test fix 2988afbd (net-agent-setup OS-aware) + CSS guard fix 2296ea78 ride the next merge. Blocked: Task 0 installer measurement (owner, blockers.md).
- CON-43: complete; renumbered after claude-24's CON-46 (policy=5, git=6) at 552e4ce2, verify EXIT=0; sent "CON-43 ready: 552e4ce2" to claude-24 (merges in its worktree). NEXT: its merge SHA -> e2e:remote --affected -> report CON-43 to claude-3. Follow-up: check the remote tab's read-only note renders.
- CON-45: contracts b99e7809 + 55aa0455 (status snapshot null = no repo; Changes polls 5 s + .git watch). Merged: G0 (git-show), G2 (git-client), G3 (electron). G4 merged. G1 (../CON-45-G1, branch CON-45-G1 at 14ecbbfe, NOT merged): re-review found a git-dir CONTENT escape (symlinks / objects/info/alternates inside an in-session git dir) — see .autoloop/blockers.md; brief that fix after the pause, re-review, merge (G1 must also `git merge CON-35-ui` first: git minor is now 6). NEXT after both: Opus re-review G1 (security), merge, then Slice 2 wiring (remote-diff / remote-history viewers, RightPane onOpenRemoteDiff/History with ABSOLUTE paths, skip isRemoteKind in rename/delete closers at app.tsx ~4134), e2e net-remote-git. Link minor 5 is provisional (renumber at merge if CON-46 lands first; minors are cumulative).
- CON-44: plan a640328e + f4f7e956 (CodeViewer shape: injected saves + bufferKey + projectBound + model ownership). Not started.
- Follow-up CON-42-ui (answer UI for mirrored remote asks; machine names on request cards) queued.

## Coordination
claude-24 (server track) agreed: drive grant to inbound ssh controller; forget = local remove (no tombstone). calls.ts settleAbsent already rejects pending calls for removed machines. Their slice 7 edits index.ts frame dispatch (auto-merge expected). Message them before every merge.
