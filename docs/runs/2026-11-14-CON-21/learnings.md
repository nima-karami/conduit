# CON-21 learnings

- [implementation-plan] fallow's dead-code check fails on exported symbols with no consumer, and test files count as entry points. A "pure modules first" slice therefore leaves intermediate merges red on unused exports until the consumer lands. Plan the contract types in the same lane as their first consumer, or expect the transient.
- [build-and-verify] Git identity isn't configured here. A bare `git merge --no-ff` fails with "Committer identity unknown", and a verify chained after it then runs on the unmerged tree. Use the `merge-verify.sh` helper (identity flags + per-merge verify ledger).
- [build-and-verify] Repo-wide guard tests (`hc-network-guard`, the tool-schema keyword whitelist) only fire in the full suite, so a lane's named check misses them. Lane briefs that add tool schemas or new string literals should name `npx vitest run test/unit/hc-network-guard.test.ts test/unit/conduit-mcp-control-tools.test.ts` as part of the check.
