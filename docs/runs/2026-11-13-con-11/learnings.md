# Learnings

- Fallow flags a contracts-only file with no importer as an unused FILE even though `src/contracts/*` exports are exempt; a contract committed ahead of its lanes needs a pinning test as its first caller. [implementation-plan]
- The pre-commit hook (lint-staged) backs up into the shared git stash stack; concurrent sessions committing at once could interleave stash entries. [instruction-file]
- A fresh worktree has no node_modules; lanes share the conductor's install via symlink, so briefs must forbid npm install and `git add -A`. [build-and-verify]
- Haiku executors stopped correctly on out-of-map call sites (lane B) and kept to their file maps; the cost was one round-trip. Briefs that list "if X outside your map, stop and report the call sites" pay off. [build-and-verify]
- A mid-flight contract change (R13) reached a running Haiku lane via SendMessage + cherry-pick of a single contract commit; this worked without conflict because the contract file was outside every lane's map. [build-and-verify]
- First-round independent review found blockers in all four Haiku lanes (2, 1, 2, 3) behind executor-reported green checks: an unbound method breaking server start, a floor test that could not fail, a stranded deferred job, a second copy of zone math, oldest-notice-wins. Two blockers were plan defects (cmd.exe shell; lane D could not reach a private helper) — the plan should name every helper a lane needs and whether it may export it. [implementation-plan]
- Executor check lists should include the nearest consumer suites of a changed seam (e.g. server-runtime-races for createTyping), not just the lane's own tests. [build-and-verify]
