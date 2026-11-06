# Overnight board run — 2026-11-06

Lead: Claude, working the Conduit workboard's To do column while the user slept. Executors: Codex
(gpt-6.1-terra) until its weekly limit, then Cursor (grok-4.6, composer-2.5); Claude Haiku for the last two
gate fixes. Released as **v0.57.0** on the user's go-ahead.

## Shipped in v0.57.0

| Card | What |
|---|---|
| CON-131 | Tray icon with Stop all agents, plus the Jump List entry |
| CON-147 | Each agent shows its own mark, drawn per theme |
| CON-133 | A test that only passes on retry (FLAKY) fails the run, CI and the release gate |
| CON-143 | `e2e:remote --repeat N` proves a flake fix with a pass rate |
| CON-136 | LSP tests wait for the server to finish indexing; rust-lsp works on the runner again |
| CON-137 | `writeToTerminal` waits on a page flag instead of a timer |
| CON-138 | A restored session stays stale after a cold stop instead of showing as exited |
| CON-140 | Unit tests that flaked under load |
| CON-155 | kitty-keys flake |

CON-139 (14 one-off e2e flakes) was parked: each passed 8/8 on remote runners, and with CON-133 any recurrence
now fails the run and gets its own card.

## Still open

- **CON-134** fixed sleeps in e2e: batches 1–3 merged. Three goto-matrix sleeps wait on an app
  "navigation done" signal; later batches not started.
- **CON-135** scrollback after reload: our half is fixed (no terminal size sent before the font loads).
  Blocked upstream on hc's soft-wrap repaint; the scenario stays quarantined.
- Tray helper crate still reports version 0.52.1 (cosmetic; updates swap by hash).

## Real product bugs the e2e work found

- Restored sessions overwritten by a stale kill/lost exit (CON-138).
- Plan edits lost to an agent's save: pending was marked at the keystroke, not at the edit.
- Terminal history recorded at a 27-column, pre-font size.
- Tray helper crashed at load (0xC0000139): no Common Controls v6 manifest.
- The supervisor waited on its own hc stop (20 s timeout); fixed with an `ending` hook.
- MCP host wrote files after `stop()` (ENOTEMPTY on shutdown).
- hc client connection race during redial.
- rust-lsp stalled on the runner without `rust-src`, with no health logging.

## Release facts

- Release commit `3515ae0c`; the tag moved there on the user's instruction after the first attempt was
  blocked by two FLAKY results (paste, status-bar). Haiku fixed both; each passed 16/16 remotely.
- Last full integration run before the gate fixes: 252 pass, 0 fail, 0 flaky.
- Release run 42283966215 published 3 assets.

## Process learnings

- Text sent to Codex with `hc send` can sit in its input box unsubmitted. Press Enter when idle (Tab queues
  while it's working) and re-read the screen.
- Starting several Cursor CLIs at once races on `cli-config.json` (EPERM). Start them one at a time.
- Memory pressure killed the lead's background watchers. On autonomous runs, restart them, never stop.
- Conduit friction from running the build through it became cards CON-148 to CON-154.
- The FLAKY gate caught real problems, and blocked the release twice.
