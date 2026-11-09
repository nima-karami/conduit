# CON-172 — mid-turn input, measured live (2026-11-09)

Driven through Conduit (open_session / read_screen / send_input / send_message) on this machine.

| Case | CLI | Screen | Typed text + Enter | Conduit notice today |
|---|---|---|---|---|
| Main agent mid-turn | Claude Code 2.1.319 (Haiku 5.5) | spinner above an empty, ruled `❯` box (`claude-mid-turn.json`) | accepted | held (`busy`) |
| Main idle, background subagent running | Claude Code 2.1.319 | `✻ Waiting for 1 background agent to finish`, empty `❯` box (`claude-background-agents.json`); presence `busy` | accepted at once; answered `PONG-A` while the subagent kept running | **held ~30 s until the subagent finished and the turn ended** (the reported bug) |
| Main agent mid-turn | Codex 0.166.0 (gpt-6-luna) | `• Working (… esc to interrupt)` above an empty `›` box (`codex-mid-turn.json`) | accepted; folded into the running turn, no interrupt; quoted verbatim in the final reply | held (`busy`) |

Conclusion: Claude and Codex both take typed input safely mid-turn → `midTurn: 'queues'`. Cursor unmeasured → stays `holds`.
