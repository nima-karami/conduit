# CON-35 UI orchestrator state (claude-25; lead claude-3)

Read first after a compaction. Ledger: `.autoloop/` in /home/namemenima/projects/.wt/conduit/CON-35-ui (tasks.yaml, learnings.md, blockers.md, evidence/). Brief: `.autoloop-ui-brief.md`.

## Now (updated ~16:20Z)
- CON-41 DONE: merged 0599abdb on CON-35-remote-ssh, reported to claude-3.
- CON-47 merged 718b90ba (claude-24 merged; verify 0); e2e:remote --affected running from worktree ../CON-47-check (log .autoloop/evidence/con47-e2e-remote-affected.log); then report. Task 0 VM measurement blocked (blockers.md).
- CON-43: all 4 lanes + wiring merged in CON-35-ui; lane CON-43-R (remote tab renderer on its own Monaco model, readOnlyState 'remote') building; then e2e net-remote-files, verify, merge request to claude-24 (link minor 4 is CON-43's).
- CON-45: plan + contracts b99e7809 (link minor 5 on this branch — renumber at merge if CON-46 lands first; minors are cumulative so assign at merge). Lanes G0 (git-show extraction), G2 (git-client + C2), G3 (electron) building; G1 (B git-serve) after G0; G4 renderer after R.
- CON-44: plan a640328e; starts after CON-43 lands (needs fs.write frame, next free minor).
- Follow-up CON-42-ui (Needs-you answer UI for mirrored remote asks) queued in tasks.yaml.

## Coordination
claude-24 (server track) agreed: drive grant to inbound ssh controller; forget = local remove (no tombstone). calls.ts settleAbsent already rejects pending calls for removed machines. Their slice 7 edits index.ts frame dispatch (auto-merge expected). Message them before every merge.
