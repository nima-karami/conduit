Recorded shapes for CON-11. Field names: Claude Code 2.1.325 binary (hook schemas, statusLine docs);
`statusline-startup.json` is a real start-up render (redacted); `rate_limits` follows the binary's
statusLine docs (only present after the first API response). See docs/runs/2026-11-13-con-11/spike.md.

`post-tool-use-{bash,edit}.json` (CON-24): real PostToolUse payloads from Claude Code 2.1.325 (`claude -p`,
2026-11-14), scrubbed — ids zeroed, paths moved under `/work`, contents replaced by `FIXTURE-*` markers.
`post-tool-use-mcp.json` is the same envelope with an MCP tool's `tool_name`/`tool_input`/`tool_response`
written by hand (no MCP call was recorded). `tool_response.originalFile` carries the whole file: never persist it.

`transcript-tool-uses.jsonl` (CON-24 T4.1b): synthetic content in the 2.1.325 line types listed here, not the full real shape.
The line types it models:
- `assistant`: one content block per line; a main-session `tool_use` (Bash, failed Bash, Edit, MultiEdit, Read, an MCP call,
  Task, BashOutput, TodoWrite, KillBash, NotebookEdit).
- `user` with a `tool_result`: `is_error: true` on the failed Bash.
- `api-request-blob`: only `type`, `hash`, `message` and `sessionId` (synthetic hash, no uuid); its `message.content` replays earlier Bash and Edit `tool_use` blocks. It must not be counted.
- `assistant` with `isSidechain: true`: a defensive case. In 2.1.325 sidechain lines appear in `subagents/*.jsonl`, not in the main transcript file. If one appears in the main file, it must not be counted.

Two lines are malformed on purpose, so the reader's tolerance is tested against real-looking damage: line 4 is truncated JSON
(a transcript cut off mid-write), and line 15 is plain text (a stray line in the file). Both must be skipped without a throw.

All ids are uuid-shaped and synthetic; all text is `FIXTURE-*`. No transcript from a real session was copied.

`post-tool-use-failure-bash.json` (CON-24): a PostToolUseFailure payload with the `error` field. It is hand-written in the
PostToolUse envelope, not recorded from a run. The `error` text is a `FIXTURE-ERROR` marker.
