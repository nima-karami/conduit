# CON-24 — Permissions machinery (POL MVP), run report

**Branch** `CON-24-permissions-machinery` (not merged to main; `origin/main` v0.66.1 is an ancestor, so main can
fast-forward) · **Spec** `docs/specs/2026-11-14-policy-and-permissions.md` §15 · **Plan**
`docs/plans/2026-11-14-policy-permissions-machinery.plan.md` (every ruling below is recorded there) ·
**Baseline** `baseline.md` · **Learnings** `learnings.md`

## Result
All five slices are built and merged into the branch. No new screens: CON-25 owns those.
- **Final tip:** FINAL_TIP.
- **Verify:** `npm run verify` exits 0 on the final tip.
- **Remote e2e:** run FINAL_AFFECTED (`--affected`) has FINAL_COUNTS, with CI's verify job green (semgrep and gitleaks included).
- **Gate definitions:** identical to main. Against the baseline, only `package.json` (version) and `.fallowrc.json` (owner commit 808d47ac) differ, and both came in from main.

| Spec §15 item | Slice | Proved by |
|---|---|---|
| Profiles (Observer, Worker, Lead) with exceptions, assigned by session, CLI or default | 1, 2 | policy-engine / policy-profiles / policy-service units; `policy-profiles` e2e |
| Today's overrides migrate exactly ("Lead +1"), no silent change | 2 | policy-migration units (every tool, every field); `conduit-mcp-policy-migrate` e2e; probe: 0 effective mismatches |
| Grants with 7-day decay; card "Always" = session grant | 1, 2, 3 | grant-store units; `conduit-mcp-policy` (Always → grant → revoke → asks again) |
| `permission` requests, re-decided at answer time; a late allow grants and never runs | 3 | call-flow / request-service units; `policy-permission-requests` e2e (late path, retry notice, allow-once, revoke) |
| Activity log, privacy (no bodies, output or contents) | 1, 2 | activity-log units; row assertions in every policy e2e |
| Observed lane: Claude Code and Codex native actions | 4 | hook client, transcript reader, rollout watch, feed-gap units; `activity-observed` e2e (secret-text scan) |
| Requests group floors; own-peer remote principal (data model) | 1, 2 | policy-engine floor units; remote-principal contract shared with CON-27 |
| Approval card keeps its contract | 2, 3 | `conduit-mcp-policy`, `asks-no-window`, `requests-agent`, `conduit-mcp-control` e2e |

## How it was built
- **Lanes:** Codex sessions early on. After the owner's 2026-11-15 order, Claude Haiku subagents, each in its own worktree.
- **Reviews:** every lane got fresh Opus reviews until APPROVE: 2–4 rounds per lane, plus re-reviews of every fix.
- **Gate:** the orchestrator ran `npm run verify` after each merge, with its exit code captured directly.
- **e2e:** remote only; nothing was launched on this machine.

## Defects reviews caught that the gates did not
- **Engine and migration:**
  - a session-dialog edit dropped every default customisation;
  - drive-root folder keys mismatched;
  - per-target grants and overrides were mis-scoped.
- **Overrides:**
  - a call refused at the gate spent its one-use override;
  - two concurrent calls could share one override;
  - an approved ask could spend two.
- **Answers:**
  - a withdrawn answer left a live grant;
  - any window, even an unknown one, could answer an ask;
  - a late answer accepted an unknown sender.
- **CON-27 seams:** a peer's uncapped handle reached Activity; a test bound the LAN pairing port.
- **Observed lane:**
  - Claude matches hook names as unanchored substrings, so the hook fired for BashOutput and TodoWrite;
  - notebook cell contents and MCP arguments left the hook client;
  - `PostToolUse` fires only for successful tools, so `PostToolUseFailure` had to be added;
  - real transcripts replay tool calls in `api-request-blob` lines (34 of 35 local transcripts);
  - the gap check counted next-turn tools;
  - a 30 s Codex no-bind timer would falsely report idle sessions, because the rollout is created lazily.

## Deviations from the plan (each a recorded ruling)
- **Grants and requests:**
  - `PostToolUseFailure` joins the observed lane.
  - The feed-gap check matches by `tool_use_id`, over the transcript bytes up to the Stop, read incrementally.
  - Peers can't create requests in v1, so the CON-27 "withdraw a revoked peer's requests" half was dropped; its grants are still revoked.
  - CON-27 seam 3 tees NET's audit into Activity rather than replacing NET's own audit file.
  - `mcp:permissionAnswer` has its own result message (`mcp:permissionResult`) and the card's authority rule.
- **Observed lane:**
  - An observed command is stored as its first line, capped at 200 characters (privacy).
  - The Codex feed reports "unavailable" only for an ambiguous bind; there is no no-bind timer.
- **Deferred to CON-25:**
  - CLI display names in policy reason text;
  - the dialog's CLI-layer display;
  - the dialog's stale confirmed value;
  - "No activity feed" for CLIs without an observed lane;
  - late answers writing an Activity row;
  - `lateGrant` holding one id for multi-target grants.

## Found outside CON-24
- **CON-27 reconnect lost update:** fixed and released separately as **v0.66.1** (`fix/net-reconnect-push`, 42134e27 + 5689d264).
  - Measured: 4 failures in 640 parallel runs before the fix; 0 in 240 after.
  - Follow-ups, not blocking:
    1. a deterministic service-level test of the `reconnected` → snapshot/outbox wiring in `server/network/index.ts`;
    2. `admitInbound` counts resent duplicates toward the 120/min limit before dedupe (pre-existing, rare);
    3. view/drive frames on a swapped connection aren't resynced (low).
- **Pre-commit hook skipped in worktrees:** `core.hooksPath` is `.husky/_`, relative to the worktree, and exists only in the main checkout. Every git worktree silently skips it (see learnings).
- **Quarantine:** `scrollback-inrun` has been quarantined for more than 14 days; the e2e tool flags it for a re-check.

## Accepted residuals
- A send-message or request call refused inside its own checks (invalid args, rate cap, queue refusal) spends its one-use override.
- A spent ask whose re-decide recovers an allow still passes the card-only checks first.
- approval_timeout from the pre-card budget is recorded as `expired`.
