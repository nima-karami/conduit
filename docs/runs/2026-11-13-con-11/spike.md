# CON-11 spike (S1, S3, S4, S5) — 2026-11-13

No model requests were made. Claude Code was run once at start-up only, in a scratch
`CLAUDE_CONFIG_DIR` (nothing under `~/.claude` touched). Codex was settled from the openai/codex
source (shallow clone, `main` @ 9825e4b2, 2026-11-14) and the 10 real rollout files in
`~/.codex/sessions` (read only). Evidence: `evidence/s1/`.

## S1 — `claude --settings`: merge or replace? **Settled (measured)**

Set-up: user settings (`$CLAUDE_CONFIG_DIR/settings.json`) with a `SessionStart` hook and a
`statusLine`; a `--settings` file with its own `SessionStart` hook and `statusLine`. Claude Code
2.1.325 started in a PTY, no prompt sent, killed after 25 s.

| Piece | Result | Evidence |
|---|---|---|
| hooks | **merge**: both `user-hook` and `flag-hook` ran (user first) | `evidence/s1/hook-order.txt` |
| `statusLine` | **replace**: only the `--settings` command ran; screen showed `FLAG_STATUS` | same file (`flag-sl` only) |

**Consequence (§13 [high] S1 decided: chain).** Hooks are injected as specified (they merge, so
the user's own keep running). The status line must be chained: Conduit's wrapper resolves the
user's effective `statusLine` **at each invocation** (precedence `.claude/settings.local.json` >
`.claude/settings.json` (project, from `workspace.project_dir` in the stdin JSON) > user
`$CLAUDE_CONFIG_DIR|~/.claude/settings.json`), runs it with the same stdin, and prints its stdout
unchanged. No user status line → print nothing. This is what §3 "Claude Code adapter" already
describes and what the §7 scenario "User's own Claude hooks and status line keep working" checks.
Policy/managed settings are not chained (can't be read reliably); noted as a limitation.

## S5 — Claude names on 2.1.325. **Settled (from the installed binary + a start-up render)**

- Hook events list includes `StopFailure`; its matcher field is `error`
  (`case"StopFailure":return e.error`). The `error` enum: `authentication_failed,
  oauth_org_not_allowed, account_on_hold, verification_required, billing_error, rate_limit,
  overloaded, invalid_request, model_not_found, server_error, unknown, max_output_tokens,
  cloud_credential_error` → matcher `rate_limit` is valid. Payload also carries
  `error_details?`, `last_assistant_message?`.
- `Notification` matcher field is `notification_type`; the allowed list includes
  `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`.
- statusLine stdin JSON (start-up render captured, `evidence/s1/statusline-startup.json`):
  `session_id, transcript_path, cwd, model, workspace{current_dir,project_dir}, version, cost,
  context_window, …`. **No `rate_limits` at start-up** — the built-in docs say it appears only
  "after first API response, while at least one window is present":
  `rate_limits.{five_hour,seven_day,spend_limit}.{used_percentage (0–100), resets_at (Unix epoch
  seconds)}`. Field names from the binary's docs; the live shape is built from a fixture.

## S2 (remaining) — Codex limit error shape. **Settled (source)**

`EventMsg::TurnComplete` serialises as `task_complete` (alias `turn_complete`); its
`error: Option<ErrorEvent{message, codex_error_info}>`, and `CodexErrorInfo` is snake_case →
`{"type":"event_msg","payload":{"type":"task_complete","turn_id":…,"error":{"message":…,
"codex_error_info":"usage_limit_exceeded"}}}`. The standalone `EventMsg::Error` is **not**
persisted to the rollout (`rollout/src/policy.rs`), so only the task/turn end carries it. Accept
`task_complete` and `turn_complete`. `token_count.rate_limits.rate_limit_reached_type` is an enum
(`rate_limit_reached`, `workspace_owner_credits_depleted`, …).

## S3 — binding a Conduit session to its rollout file. **Settled (source + real files)**

- A Codex `SessionStart` hook would give `session_id` + `transcript_path`, but hooks from
  `-c` (layer `SessionFlags`) are **untrusted** until their hash is trusted in the user's Codex
  state (`hooks/src/engine/discovery.rs` `hook_trust_status`) → needs a trust prompt / writing
  `~/.codex`. Rejected.
- Real files show sub-threads (guardian reviews) write their **own** rollout files with the
  **same cwd**: `session_meta.parent_thread_id` set and `source: {subagent: …}`. A naive
  "newest file with this cwd" binding would grab a sub-thread.
- The file is created **lazily** (`deferred_creation: true`): it appears at the first persisted
  turn, not at launch; its name and dated folder come from the session's creation time in
  **local** time (a 22:10 EST session sits in `11/09` though UTC is 11/10).
- Long sessions keep appending to the original file in the original dated folder.

**Binding rule (to unit-test against recorded `session_meta` lines):** while unbound, watch the
dated folder (`sessions/YYYY/MM/DD`, local date of launch; plus the next day's once it exists);
on each new `rollout-*.jsonl`, read only its first line; bind when `payload.cwd` (realpath)
equals the session's cwd, `payload.parent_thread_id` is absent, `payload.source` is not an
object with `subagent`, and `payload.timestamp ≥ launchAt − 5 s`. If two unbound Conduit Codex
sessions share that cwd and both qualify for one file → bind neither for that file (ambiguous),
log it; those sessions fall back to rules. Once bound, `watchDir` the bound file's folder (it
stays there even after midnight) and tail only appended bytes. `codex resume` (appends to an old
file) is not bound → rules. So the Codex adapter **ships enabled** (the §13 S3 default of
"disabled" does not apply), with rules as the fallback.

## S4 — flush latency. **Settled (source)**

Once materialised, each `AddItems` batch is written and `flush()`ed by the writer task
(`rollout_writer` → `flush_if_materialized`), so a `task_complete` reaches disk within the event
loop's latency (sub-second). Before materialisation nothing is on disk; a limit on the very
first turn still lands, because that turn's items materialise the file. The adapter debounces
watch events ≤ 250 ms and tolerates a partial last line.

## §13 defaults applied

- S1: **not a default — decided "chain"** from the measurement (the spec's §3 design). Risk: the
  chained command runs inside Conduit's wrapper, so its `padding` and refresh behaviour are
  Claude's as before, but a slow user command delays our `reset-info` forward (the forward is
  posted before the user's command runs, so it isn't lost).
- S3: not a default — binding rule above; adapter enabled.
- S5 statusLine `rate_limits` live shape: **from the binary's docs + fixture** (no request
  possible without a model call). Listed in the run report.
- Codex `turn_complete` vs `task_complete`: both accepted (spec's instruction).

## Addendum (planning, 2026-11-13) — empty status line
Measured with the same scratch set-up: a `--settings` statusLine whose command prints nothing
renders the footer identically to no statusLine at all. So the Conduit wrapper is injected for
every Claude launch (needed for `reset-info`), whether or not the user has a status line.
Also from the binary: `statusLine` carries `padding`, `refreshInterval`, `hideVimModeIndicator`;
the wrapper entry copies them from the user's effective status line at launch.

## Addendum (integration review, 2026-11-14) — session_meta size
The real `session_meta` first lines on this machine measure 19,655–22,614 bytes (10 files, sizes
only). Binding reads the first line in 64 KiB chunks up to 1 MiB and logs once when a line exceeds
that; the redacted fixtures (~500 bytes) do not exercise the size.
