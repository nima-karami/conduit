# UI orchestrator state (claude-25) — 2026-11-16 ~19:55Z

## Done
- CON-41, CON-47 (earlier). CON-43: merged 732255e8 on CON-35-remote-ssh, verify 0 (claude-24), e2e:remote run 43928939781 (283 PASS, 1 unrelated flaky).
- CON-45 G1: merged into CON-35-ui at 4f51fb08 after a 4-round independent security re-review (APPROVE at 5c395445 + N6/N7 fixed). Residuals in the git plan.

## In progress on CON-35-ui (not yet merged to CON-35-remote-ssh)
- CON-44: slice 0 (minor 7 fs.write), W1–W5 merged (W5 = attach_folder routed, minor 8), CodeViewer refactor (remote buffers owned by remote-file-saves), save/revert/close by save key, CHANGELOG (CON-43 + CON-44 lines, uncommitted with the e2e).
  - e2e: net-remote-files extended with edit/conflict/deny-write/attach phases (deviation: extended instead of a new net-remote-edit, to avoid duplicating setup). Local run pending (.autoloop/evidence/con44-e2e-local-1.log).
- CON-45 slice 2: lane G5 (remote diff/history views) running in ../CON-45-G5; app.tsx onOpenRemoteDiff/History handlers written (uncommitted); center-pane rendering + doc-tab titles + e2e net-remote-git still to do.

## Next
1. Local e2e green → verify under lock → message claude-24 "merging CON-44" (with CON-45 G1 inside).
2. G5 review/merge → center-pane wiring → net-remote-git e2e → CON-45 merge.
3. Follow-ups: CON-42-ui (answer UI for mirrored remote asks); dirty remote buffer when its session closes; unsaved-files list naming remote keys.
