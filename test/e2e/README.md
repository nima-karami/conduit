# End-to-end tests (`test/e2e/`)

These drive the **real built Electron app** via Playwright's Electron driver. They
are **deliberately excluded from `npm run verify`** — vitest only globs
`test/unit/**`, and these need a real GUI (CI is headless Linux). Run them locally.

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
node test/e2e/paste.e2e.mjs
```

Exit code `0` = pass. Requires Playwright (a devDependency, or present in the npx
cache after `npx playwright` has run once). Uses a throwaway `--user-data-dir`, so
it never touches your real Conduit sessions/agents.
