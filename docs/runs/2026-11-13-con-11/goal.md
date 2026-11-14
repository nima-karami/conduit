# CON-11 run — goal

**Outcome:** a Claude Code or Codex session that hits a usage limit is resumed once, ~margin after
reset, by the Conduit server (no window needed); never typed into if it already resumed; long
multi-paragraph messages arrive whole; "needs you" when Conduit can't resume. Spec (locked):
`docs/specs/2026-11-13-scheduler-auto-resume.md` (R1–R12, §13 defaults).

**Gates:** `npm run verify` (conductor runs it, exit code captured directly, no concurrent load);
inner loop `npm run verify:quick`; e2e `npm run e2e:remote` (affected, then `--full` before done);
locally at most one scenario by exact name, headless.

## Run config
- mandate: scope — CON-11 MVP (§6) fully built, gated, reviewed, e2e'd; report to lead claude-3.
- conductor_tier: Opus 5.5 (this session). Orchestrator = claude-8; lead = claude-3.
- executors: **Haiku subagents — user decision (via lead).** Risk: bottom tier is weak on slow/flaky
  suites and diagnosis → Haiku writes code + red-first unit tests only, in own worktree off this
  branch; never e2e, never diagnosis, never shared entry files. Max 4 concurrent; 2 retries then quarantine.
- shared entry files owned by conductor only: server/domain/index.ts, server/compose.ts,
  server/services.ts, settings schema, protocol contracts; Limit monitor also conductor-owned.
- limits: commit only to this branch + lane branches; no push/PR/merge-to-main/release; commit with
  `git -c user.name="$(git log -1 --format=%an main)" -c user.email="$(git log -1 --format=%ae main)"`.
  No Notion/artifact edits. No UI beyond interim textarea. Never kill by name. No global installs.
  GUI apps invisible (headless) — verbatim rule in every GUI-capable subagent brief.
- waivers: none.
- refills: (none yet)

## Phases
spike → plan (implementation-plan) → contracts commit → 4 lanes (build-and-verify) → review
(code-review, non-author) per lane → merge one at a time + full gate → e2e → CHANGELOG → report.
