# CON-11 run report — Scheduler and auto-resume

Branch `CON-11-scheduler-and-auto-resume`, head **c5fe2e59** (base main 94fcef13). Spec:
`docs/specs/2026-11-13-scheduler-auto-resume.md`; plan: `docs/plans/2026-11-13-scheduler-auto-resume.plan.md`;
spike: `spike.md`; decisions: `blockers.md` (D1–D9); learnings: `learnings.md`.
Not pushed, no PR, nothing merged to main.

## What shipped
- **Scheduler** (`src/scheduler.ts`, `src/scheduler-store.ts`): jobs = trigger + action, states and
  bounded history, `scheduler.json` v2 with a one-time v1 migration (R9; `timed-messages.json` left
  untouched), caps that never refuse a resume (R7), ask mode (R8), verify/retry, R13 busy deferral.
- **Limit monitor** (`server/domain/limit-monitor.ts`): episodes (R1), signal priority (structured
  beats rules), reset time from the newest status-line window, pre-fire check (R4/R13), verify
  mapping, "needs you" reasons, rules scan on the rendered screen (R6), offers queue, per-session
  override and mode changes.
- **Claude adapter**: `--settings` hooks (StopFailure `rate_limit`, UserPromptSubmit, Stop,
  Notification quota_auto_resume_*), a status-line wrapper that forwards `rate_limits` then runs the
  user's own status line through Git Bash or `/bin/sh` (never cmd.exe; no wrapper on Windows without
  Git Bash, D6), hook client `resources/conduit-mcp/conduit-hook.cjs` copied content-addressed into
  userData, hook posts authenticated on the MCP endpoint.
- **Codex adapter**: binds a session to its rollout file by `session_meta` (spike S3), tails appended
  lines, replays only the end state on a late bind.
- **Rules fallback**: `userData/limit-rules.json` (created with defaults, reloaded on change), dated
  and countdown resets, CON-151's stuck screens read the same rule set.
- **Delivery**: one bracketed paste, Enter after the echo is quiet (300 ms, ≤5 s, 120 ms floor);
  messages keep line breaks up to 16,000 chars and are refused over it; lines joined (and noted in
  history) for apps without bracketed paste; paste mode tracked for every session, from data and hc
  paints.
- **Settings**: `autoResume` (on/ask/off, migrated from `autoResumeOnLimit`), margin, attempts,
  message, verify window; per-session override; protocol `scheduler.setSessionAutoResume`,
  `scheduler.history`; `timer:state` gains `jobs` and `episodes` (the renderer keeps working).
- **UI**: only the interim multi-line textarea with the `n / 16,000` count (spec §8–11).
- `CHANGELOG.md` Unreleased entry.

## Commits (main..07ad1e8b)
Spec/plan/contracts: ee01dbbf, 00108cce, 5c3c1f2e, 428e18a9, f21a00d6. Lanes (Haiku executors):
A e3db4857 b81ce3e8 b5291a18 (+b913fbe7); B cad64f17 a2791e37 81afea76; C 0be2d3e4 dfb4afd5 472efc82;
D 36a21488 87956382 c367b6bc 4d2a4115. Merges: B 51a19d68 (+d6dde3b8), C 36fceb35, D c0823e5f,
A 31acc345 (+3daa3315 conductor fixes). Integration: d30afb9f, f073a0d3, 27ae0f11, 07ad1e8b,
f19e3ed1 (R5 amended), c5fe2e59 (R5 nits + notice guard).
E2E + changelog: 9d10f508. Docs: 1b6c897a, 7335bcf8.

## Gate
`npm run verify` run by the conductor, exit code captured directly, no concurrent agents:
| Tree | Exit | Log |
|---|---|---|
| S0 contracts 428e18a9 | 0 | evidence/verify-s0.log |
| lane B merged (d6dde3b8) | 0 | evidence/verify-merge-B.log |
| lane C merged (36fceb35) | 0 | evidence/verify-merge-C.log |
| lane D merged (c0823e5f) | 0 | evidence/verify-merge-D.log |
| lane A + E.5/E.6 (d30afb9f) | 0 | evidence/verify-E.log (A gated with E, D6) |
| review round 1 fixes (f073a0d3) | 0 | evidence/verify-E2.log |
| round 2 fixes (27ae0f11) | 0 | evidence/verify-E3.log |
| 07ad1e8b | 0 (753 test files) | evidence/verify-E4.log |
| f19e3ed1 (R5 amended) | 0 (753 test files) | evidence/verify-E5.log |
| **head c5fe2e59** | **0** (753 test files) | evidence/verify-final.log |
Gate definitions vs baseline (`evidence/gate-baseline.txt`): no check weakened; tests only added or
updated with the code they cover (timer-scheduler and limit-notice tests deleted with their modules).

## Reviews (independent, fresh Opus reviewer per round, never the author)
| Item | Rounds | Final |
|---|---|---|
| Lane A Scheduler | 3 (2+1+1 blockers) → conductor fix 3daa3315 | APPROVE |
| Lane B Delivery | 3 (2, 3, 0 blockers) | APPROVE |
| Lane C Claude | 3 (1, 1, 0) | APPROVE |
| Lane D Codex+rules | 2 + 2 follow-up deltas (3, 0, 1, 0) | APPROVE |
| Integration (monitor + wiring) | 3 (4+1, 3, 0 blockers) | APPROVE (round-3 follow-ups in 07ad1e8b) |
| R5 amendment (07ad1e8b..f19e3ed1) | 1 (0 blockers, 4 nits) | APPROVE |

## E2E
Scenarios (spec §7): `auto-resume-claude-resumes-after-reset`, `-cli-resumed-by-itself`,
`-codex-session-log`, `-long-multiline-message`, `-retries-run-out`, `-no-bracketed-paste`,
`-server-restart`, `-user-hooks-and-statusline`, `-works-with-no-window`; plus the textarea check in
`timed-message-dialog-ui`. Fake `claude` runs the configured hooks with recorded payloads (R11).

**Local (Linux, headless `--ozone-platform=headless`, one scenario per invocation, hc from the main
checkout via CONDUIT_HC_BINARY)** at the head code: all 10 **PASS**. Two runs failed first and
exposed real product bugs, both fixed with unit tests: unbracketed resume (paste mode only in hc's
attach paint) and a job never firing after a server restart (adopt did not count as the PTY coming
back). One failure was a fixture length bug (6,002 vs 6,000 chars).

**Remote (Windows runners), run by the lead from a session where the human approved the push** (this
machine's `origin` is a local path, and this session's permission check refused an agent-relayed
approval):
- `--full` at 07ad1e8b, run **43553416254** (windows-latest shards; verify job passed): 265 PASS,
  9 EXCLUDED, 1 SKIP (paste-linux), 1 QUARANTINED-FAIL (scrollback-inrun, already quarantined),
  1 FAIL. All nine `auto-resume-*` and `timed-message-dialog-ui` **PASS on Windows**. FAIL:
  `conduit-mcp-midturn`, deterministic 2/2 — a notice into a busy session waited 5 s because R5
  put the echo-quiet wait on every submit. Fixed by the R5 amendment (D10) at f19e3ed1; locally
  `conduit-mcp-midturn` PASS.
- Re-run at f19e3ed1, run **43555129096**: **31/31 PASS**, 0 fail, verify job success — every
  `conduit-mcp-*`, `auto-resume-*`, `timed-message*`, plus `add-dir` and `typing-through-server`,
  including `conduit-mcp-midturn`.
- c5fe2e59 changes only a test harness, a helper name, a comment and the spec (behaviour-free; the
  lead ruled no further remote run); `npm run verify` exit 0 on it.
- Platforms: the remote scenario shards ran on windows-latest; Linux coverage is the local headless
  run above (all 10 PASS) plus the ubuntu verify job.

## Deviations from the spec (all recorded in blockers.md)
- D1 S1: hooks merge, status line replaces → chain (spec §3 design). D2: Codex adapter enabled
  with the `session_meta` binding. D3: a bound session watches its file's own folder.
- D4 R13 (lead): busy is not a resume — the attention edge counts only for rules-only sessions and
  after 2 s; busy at fire defers (3 s quiet, ≤2 min) instead of skipping.
- D6: lane A gated with E.5/E.6; Windows status line never through a bare `bash`; no Git Bash → no
  wrapper for that launch (logged).
- D7: lane A's last blocker fixed by the conductor after the executor's retries ran out.
- D10 (R5 amended, lead): the echo-quiet wait is opt-in (`settle: 'quiet'`), Scheduler deliveries only;
  notices and every other submit keep the fixed 120 ms gap.
- `SignalSource` gained `attention` and `human-input` (R3/R4 name them).
- Settings copy: "Off never looks" → "Off never resumes" (the old copy became false).
- Claude hooks ride on the MCP wiring: with Conduit messaging off (or the endpoint down) no hooks are
  injected — rules apply; logged per launch.

## Known limitations
- After a server restart a live **Codex** session is not re-bound to its rollout file; its restored
  episode is rules-only until its next launch (D8). Claude keeps its hooks across a restart.
- Paste mode after a server restart is whatever hc's gap paint shows; if hc omits modes there, the
  next resume is sent unbracketed (for `Continue` this is harmless).
- The statusLine `rate_limits` live shape is built from Claude Code 2.1.325's own docs and fixtures
  (it is absent until the first API response; spike S5). The Codex limit-error shape is from the
  openai/codex source; no real limit was observed.
- Old hook-client copies in `userData/conduit-mcp/hooks` are never cleaned up (one small file per
  client version).

## R5-amendment nits
Landed in c5fe2e59: the host harness's echo-quiet wait never resolves and counts calls (a notice that
opted in fails 43 host tests — mutation-verified); helper renamed `settleBeforeEnter`; `settle` doc is a
spec pointer; the original R5 points to its amendment.

## Quarantined
None.

## Model use
Conductor: Opus 5.5. Executors: Haiku (user decision) for lanes A–D. Code mapping and e2e authoring:
Sonnet. Reviews: Opus, fresh context each round.
