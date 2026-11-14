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

## User decisions
- Executors are Haiku subagents (human, via lead). Risk: weak on slow/flaky suites and diagnosis.

## Quarantined
(none)
