Recorded shapes for CON-11. Field names: Claude Code 2.1.325 binary (hook schemas, statusLine docs);
`statusline-startup.json` is a real start-up render (redacted); `rate_limits` follows the binary's
statusLine docs (only present after the first API response). See docs/runs/2026-11-13-con-11/spike.md.

`post-tool-use-{bash,edit}.json` (CON-24): real PostToolUse payloads from Claude Code 2.1.325 (`claude -p`,
2026-11-14), scrubbed — ids zeroed, paths moved under `/work`, contents replaced by `FIXTURE-*` markers.
`post-tool-use-mcp.json` is the same envelope with an MCP tool's `tool_name`/`tool_input`/`tool_response`
written by hand (no MCP call was recorded). `tool_response.originalFile` carries the whole file: never persist it.
