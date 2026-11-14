# Blockers / decisions / waivers

## Decisions (approved by lead claude-3, 2026-11-14 01:49Z) — spike-driven deviations from §13 / R10
- D1 (§13 S1): **chain**. Hooks merge (measured) → inject StopFailure/UserPromptSubmit/Stop/Notification.
  statusLine replaces (measured) → Conduit wrapper forwards `rate_limits` then runs the user's effective
  statusLine (local > project > user) and prints its stdout unchanged. Wrapper must exit fast and still
  print the user's output when the server is unreachable.
- D2 (§13 S3): Codex adapter **ships enabled** with the binding rule in spike.md §S3 (local-date folder +
  next day, realpath cwd, no parent_thread_id, not subagent, timestamp ≥ launch − 5 s, ambiguous → none).
  Lazy file: rules cover the pre-bind window; a later bind must not open a duplicate episode.
- D3 (R10 refinement): once bound, watchDir the bound file's own folder; unbound → current + next-day folders.

- D4 (R13, lead 2026-11-14 02:12Z): busy is not a resume. Attention busy edge only for sessions with
  no live structured adapter, and only if busy holds ≥ 2 s; busy at fire → `waiting`, recheck after 3 s
  quiet, max 2 min, then skip "session kept working". Contract: PreFireVerdict gains `{go:'wait'}`,
  Scheduler gains `recheck(jobId)` (f21a00d6, sent to lane A).
- D5 (lane B): plan widened by two construction-site test edits (conduit-mcp-host.test.ts,
  server-runtime-spawn.test.ts) — approved by conductor.

- D6 (lead 2026-11-14 02:54Z): lane A gated together with E.5/E.6 (its only gate failure is fallow's duplicate
  exports against timer-scheduler.ts, which E.6 deletes). Windows status line: the launcher resolves Git Bash
  (CLAUDE_CODE_GIT_BASH_PATH or src/shells.ts candidates); NEVER a bare `bash` on PATH. No Git Bash → the
  statusLine wrapper is not injected for that launch (user's own status line untouched, no reset-info, rules
  give the reset), logged once per launch, unit-tested.
- D7 (conductor): lane A's Haiku retries ran out with one blocker open; conductor fixed it (3daa3315, reviewed
  APPROVE) instead of quarantining the scheduler core.

- D8 (conductor, integration review round 3): after a server restart, a live Codex session is not
  re-bound to its rollout file (its file sits in an older dated folder and binding watches only new
  files); its restored episode is rules-only until the next launch binds. Claude sessions keep their
  hooks across a restart (the hook client and token live in the surviving CLI). Known limitation,
  listed in the run report.
- D9 (conductor): bracketed-paste mode is read from hc's paint events too (a CLI that enables it at
  startup shows it only there) — found by the claude-resumes-after-reset e2e.

## User decisions
- Executors are Haiku subagents (human, via lead). Risk: weak on slow/flaky suites and diagnosis.

## Quarantined
(none)
