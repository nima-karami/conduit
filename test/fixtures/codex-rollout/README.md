Redacted from real Codex Desktop 0.167.0-alpha rollout files (`session_meta`, `task_started`,
`token_count`, `task_complete`). `limit*.jsonl` are synthetic: the error shape comes from the
openai/codex source (`TurnCompleteEvent.error`, `CodexErrorInfo::UsageLimitExceeded`).
See docs/runs/2026-11-13-con-11/spike.md.
