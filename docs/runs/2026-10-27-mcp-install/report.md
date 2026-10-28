# Run report: Conduit MCP install and discovery, plus input-box links (2026-10-27)

Spec: [conduit-mcp-install](../../specs/2026-10-27-conduit-mcp-install.md) and
[input-box-links](../../specs/2026-10-27-input-box-links.md) ·
Plan: [plan](../../plans/2026-10-27-conduit-mcp-install.plan.md) · S0: [s0.md](s0.md) · Branch
`feat/mcp-install` (base main `9090737b` = v0.49.0). It contains `fix/input-box-links`, merged in
`2559c67f`.

## Shipped
- **MCP Settings tab.** It holds messaging, the tool switches, and one install row per agent CLI
  (Claude Code, Codex, Cursor, OpenCode), each with status, config path and Install/Uninstall.
  Project-level entries are listed with Remove, and "Install for this project" is offered.
- **Identity in every terminal.** Every Conduit terminal, plain shells included, carries the
  session token in its environment. One static `conduit` entry per CLI forwards it, so typing
  `claude`, `codex`, `agent` or `opencode` in a shell connects that CLI as that session. The handle
  is claimed from the MCP `clientInfo`.
- **Install edits are safe.**
  - The first edit makes a backup.
  - Writes are atomic and keep the file mode, guarded by mtime with a re-check under a race.
  - The Codex TOML splice is guarded and round-trips exactly.
  - Uninstall removes only what Conduit wrote.
  - At startup the installed app repairs entries whose program or script no longer exists, and
    keeps the user's own keys.
- **Outside Conduit the shim reports no tools** instead of a failure. The missing
  `serverInfo.version` was fixed.
- **Discovery:**
  - a first-run banner when an agent CLI that isn't set up is typed;
  - a plug or unplug status on the session card;
  - the Messages empty state, which links to the MCP tab;
  - a palette and card-menu entry.
- **Notices in a plain shell** go only to the agent started there. They bind to the connection
  that the typed CLI line opened (§2.4 A1):
  - Prompts typed while it runs keep the binding.
  - Exit, Ctrl+Z and relaunch unbind it.
  - Ctrl+C or Ctrl+D before connecting clears the line.
  - An untyped Enter, such as a dialog answer, keeps the line for 60 s.
  - For Claude, Claude's ruled input box must be on screen.
  - The lazy host screen model is seeded from a 64 KiB output tail that records resizes (D6
    refined).
- **Input-box links:** what you type, the suggested prompt, the chrome under the box and your
  echoed past prompts no longer link (Claude and Codex agent sessions); agent output stays
  clickable.

## Evidence
- **Remote gate at the final head:** see the integration entry below.
- **Earlier remote runs, all with `verify` success:** at `c6c6fffc`, 217 pass and 0 fail. At
  `412fa07c`, `f7983f52` and `c49b6ad9`, 218 pass and 0 fail (one flaky retry at `c49b6ad9`). The
  input-links branch alone: 215 pass, plus one flake that passed when re-run alone.
- **Local e2e scenarios, one at a time:**
  - new: `conduit-mcp-install`, `conduit-mcp-install-banner`, `terminal-input-box-links`;
  - migrated: `conduit-mcp-cursor-connect`;
  - regression: `conduit-mcp-gate`, `conduit-mcp-control`, the five terminal-link scenarios.
- **Real-CLI QA, run in isolated config dirs.** No user config was written.
  - The full CLI run used Claude 2.1.312, Codex 0.164, Cursor Agent and OpenCode 2.1.4.
  - Two passes used the user's logged-in Claude through a scratch `--mcp-config`:
    - A: fresh trusted shell, delivered.
    - B: relaunch, delivered.
    - C: trust dialog, delivered.
    - D: after `/exit`, held.
    - E: Ctrl+C before connect, held.
    - R: resize, delivered.
    - F1 and F6 both reproduced before their fixes and were gone after.
- **Reviews:**
  - Spec review: 3 blockers, applied.
  - Architecture critic: REVISE, with B1 and B2 applied.
  - Seven code reviews. S1–S3 was REVISE for shell notice spoofing, fixed by the A1 rule; every
    other round was APPROVE. Every should-fix was applied.

## Decisions taken during the run
- **Notice binding (A1)** was re-ruled twice, following measurements.
- **D6:** the host screen model is created lazily and seeded from a 64 KiB tail.
- **Repair** is MVP, runs only for packaged builds, and only touches dead paths.
- **Codex install adds no blank separator line,** so the round trip is exact.
- **Cursor echoed prompts stay linked,** because no reliable signal was found.
- **OpenCode** is install-only and pull-only, with no notice adapter.

## Not covered
- Interactive Codex and Cursor connecting from a shell (both stop at sign-in).
- A `read_inbox` permission prompt (the test Claude ran in auto mode).
- A visual baseline comparison.

## Accepted residuals
These are in spec §2.4 and §14:
- an fzf-style ruled box while a bound Claude is off screen;
- a dialog answered more than 60 s after typing `claude`;
- terminal modes set more than 64 KiB back.

## Side effects on this machine during QA
- One Codex self-update attempt, which failed; Codex is still 0.164.0.
- A Codex daemon (pid 43072) that was left running.

## Learnings
- **[implementation-plan]** Run the plan's fixtures before locking it: two were wrong.
- **[review]** A rule that binds to "the line that started it" needs a lifetime for the line, not
  only the binding.
- **[runtime-qa]** Fake CLIs that initialize at once hide paint-before-initialize bugs. Re-check
  gating against a real logged-in CLI.
- **[memory]** An isolated e2e home needs AppData, or PowerShell writes into the repo.
