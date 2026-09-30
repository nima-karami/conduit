# End-to-end tests (`test/e2e/`)

These drive the **real built Electron app** via Playwright's Electron driver. They
are **deliberately excluded from `npm run verify`** — vitest only globs
`test/unit/**`, and these need a real GUI.

- **The suite runs remotely:** `npm run e2e:remote -- --full` or `-- <name…>` shards it across
  GitHub-hosted `windows-latest` runners, retries a failure once (a pass is FLAKY), uploads a
  log, trace and screenshots per failed attempt, and writes the result JSON to
  `$E2E_EVIDENCE_DIR` (else `%TEMP%\conduit-e2e`). Needs a clean committed HEAD and `gh`.
- **Locally, one scenario at a time:** `npm run e2e -- <exact-name>`. More than one refuses
  (`CONDUIT_E2E_LOCAL_FULL=1` is a human-only escape hatch). A second local run waits on the
  machine-wide lock and names the owner; the app runs at BelowNormal priority.
- **Scenarios launch only through `launchElectron` and exit only through `finishScenario`**
  (harness.mjs); `test/unit/e2e-harness-guards.test.ts` enforces both.
- **`remote-exclusions.json`** lists scenarios the hosted runner can't run (no OS focus, small
  display). They are skipped remotely, reported EXCLUDED with the reason, and run locally.

Spec: `docs/specs/2026-09-29-remote-e2e-lean-loop.md`.

## `paste.e2e.mjs` — terminal bracketed paste (Windows)

Regression test for the terminal paste fix in
`webview/components/terminal-pane.tsx`. The app removes the native Edit menu
(`Menu.setApplicationMenu(null)`), so **Ctrl+V has no accelerator** — the terminal
must handle it itself and route through xterm's `paste()`, which applies
**bracketed-paste mode**. Without that, a multi-line paste reaches a TUI (e.g.
Claude Code) as N separate lines and gets garbled.

The test launches the app, runs a bracketed-paste-aware reader in a real shell (it
enables `ESC[?2004h` so xterm brackets, and `ENABLE_VIRTUAL_TERMINAL_INPUT` so
ConPTY forwards the markers), presses a real **Ctrl+V**, and asserts the child
received the paste wrapped in `ESC[200~ … ESC[201~`:

```
Ctrl+V → terminal-pane handler → xterm.paste() (bracketed) → IPC → node-pty → ConPTY → child
```

Run it (Windows only):

```sh
npm run build            # ensure out/ has current code
npm run e2e -- paste
```

Exit code `0` = pass. Requires Playwright (a devDependency, or present in the npx
cache after `npx playwright` has run once). Uses a throwaway `--user-data-dir`, so
it never touches your real Conduit sessions/agents.
