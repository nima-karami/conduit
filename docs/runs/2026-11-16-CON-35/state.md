# CON-35 orchestrator state (claude-24, Claude-only build loop)

Updated 2026-11-16 ~14:40Z. Read this first after a compaction or handover. Ledger: `.autoloop/` (tasks.yaml, blockers.md, learnings.md, evidence/).

## Branch
`CON-35-remote-ssh` (worktree /home/namemenima/projects/.wt/conduit/CON-35). Tip fe18079d. Never pushed to main (claude-3 owns main/releases).
CON-24@fc6f68bd (independently approved) is merged in at efd97325 so CON-39 could use the profiles.

## Done (each: Opus-reviewed lanes, verify EXIT=0 after every merge, e2e:remote green, reported to claude-3)
- CON-36 slice 1: Linux gates measured -> gates.md (+ fresh-manager G7 re-run). Windows gates pending a box.
- CON-37 slice 2: C2 per-start secret (RS-D8); link over Duplex; ssh records pinned per Host; ssh dialer; --link-stdio bridge + secret-gated endpoint; link.sshAdd. Smoke: ssh-link-smoke.md.
- CON-38 slice 3: bootstrap (probe/install scripts, binSha256 pins, --ensure-server, link.sshBootstrap). Smoke: bootstrap-smoke.md.
- CON-39 slice 4: machines registry (ssh LinkRecord `machine` meta, links.json v3), connect/list/disconnect_machine, §5.2 errors, RS-D6 forced ask, needs-person pane (C2 machines.openNeedsPerson), hello platform/version (link 1.1). Smoke: machines-smoke.md. FINAL e2e on 1a0b063e RUNNING (evidence/con39-final-e2e.log); report to claude-3 when green.

## Open owner decisions (in .autoloop/blockers.md)
- [high] hc 0.1.16 enables linger by itself (RS-D14 conflict; affects local app). Linger left as hc leaves it.
- [high] Windows: start path (RS-D5 task), cmd.exe 8191-char limit (certain), node.exe code-signing vs pins, SMB pipe exposure — all need a Windows box.
- Proof-of-possession for ssh hello; machine-scoped grants (no CON-24 scope kind); cross-platform push; hc re-download.

## Done since
- CON-40 slice 5 (routed session tools): ALL MERGED at a24d5c4f (verify 0). call/call.result frames (link 1.2); ssh controller = Lead remote principal on B, machine tools a 'fleet' class no remote holds; B serveCall/callAsRemote (remote Caller, nullable home, opener union, reach via openedByRemote); A routes list_agents/open_session/open_terminal{machine} and send_input/read_screen/close_session{handle@machine}; routed calls are server actions on A (spec 4.6); addresses resolve on B; never replayed. net-routed e2e PASS (run 43884934893). NEXT STEP: final e2e:remote affected on a24d5c4f, then report CON-40 done to claude-3, then send the call-frame contract to the UI orchestrator.

## Scope split (owner via claude-3, 14:25Z)
- Me (claude-24): server/tool track — slices 5 (CON-40), 7 (CON-42 remote requests), 11 (CON-46 remote rules).
- Second Opus orchestrator (UI/files track) on branch CON-35-ui: slices 6, 8, 9, 10, 12; it messages me before each merge into CON-35-remote-ssh. Send it the call-frame contract (src/contracts/link-protocol.ts call/call.result, ROUTED_TOOLS; plan docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md).
- Run up to 4 Haiku lanes in parallel on file-disjoint work; mutation checks only on security-relevant code.

## Next
CON-42 slice 7 (remote requests): DONE fe18079d + changelog ad7a6570; e2e 43902166996 7/7. Reported.

## VM
~/.cache/conduit-vm/con27, QEMU PID 199137 running idle, defaults restored (KUP false, linger yes, no drop-in). Stop only by its PID when CON-35 is finished.

## How lanes run
Haiku builders in /tmp/claude-1000/-home-namemenima-projects--wt-conduit-CON-35/7e0abefc-f499-4ed4-883c-1e77266b51a9/scratchpad/lanes/<name> (node_modules symlink); gates per lane: `node esbuild.mjs && npm run verify:quick`, `npx fallow --skip health` (dead code empty), `rm -rf out`. Opus review each lane with mutation testing; orchestrator merges --no-ff with main's identity and runs full `npm run verify` per merge. Contracts land with their first importer (fallow). Every ssh call in smokes under `timeout`; never `hc server status`.

## CON-46 slice 11 (remote rules) — in progress (usage pause point, 16:35Z)
- Plan: docs/plans/2026-11-16-remote-ssh-rules.plan.md (25355ed0). Frames at minor 5 (CON-43 fs took 4).
- Merged: L1 frames 9be308a1; L2 B policy service 92a34247 (verify 0; 11 mutants red). Also merged from claude-25: CON-41 0599abdb, CON-47 718b90ba (both verify 0).
- L3 network (branch con46-l3, worktree scratchpad/lanes/c46-l3, first commit e7617010): rebasing onto 92a34247, adding flow.recheck after apply/revoke in host networkPort, policy codes into ToolErrorCode. Merge when its report says verify:quick EXIT=0, then full verify under flock.
- NEXT (not started, held for usage): L4 A store src/conduit-mcp/remote-policy.ts + host `machine` on edits + mcp:remotePolicy + policy.machines + drafts file; make remotePolicySink required. Then L5 picker in settings McpToolPolicyRows + e2e net-policy. Then e2e:remote, changelog, report.
- Follow-up: fallow clone cluster server/network/policy.ts vs requests.ts (shared refuse/settle helpers).
