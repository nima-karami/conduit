# Overnight decision log

Autonomous build decisions, newest last. Review/override anything here.
Policy: **decide & document** — reasonable call at each fork, keep building.

| # | When | Fork | Decision | Reasoning |
|---|------|------|----------|-----------|
| 1 | 2026-06-08 | Project layout | Single extension package at repo root | Simplest; no monorepo needed for one extension |
| 2 | 2026-06-08 | Webview framework | React + esbuild | Stated default in design; fast bundling |
| 3 | 2026-06-08 | Unit test runner | Vitest for pure modules; @vscode/test-electron for integration | Vitest is fast and needs no VS Code; keeps TDD loop tight |
| 4 | 2026-06-08 | Full-window delivery | v1 opens dashboard as editor-area webview; user drags to own window. Auto-open in a dedicated auxiliary window deferred to v1.1 | Stable API has no direct "open webview in aux window"; editor webview + native "Move into New Window" gets the result now without proposed APIs |
| 5 | 2026-06-08 | Execution mode | Inline self-driven overnight, commit per task, screenshot webview via playwright-cli | Continuity + my own visual verification; subagents not needed for this size |
| 6 | 2026-06-08 | Webview verification | Render built bundle with mock state to temp HTML, screenshot with playwright-cli | Can't run a real VS Code webview headless cheaply; this verifies the UI itself |
| 7 | 2026-06-08 | @types/vscode + engine | Pinned both to ^1.120.0 (latest published types) | @types/vscode 1.123 not on npm yet; installed VS Code 1.123 satisfies ^1.120.0 |
| 8 | 2026-06-08 | Webview placeholder at Task 0 | Added minimal webview/index.tsx stub so `npm run build` is green before Task 9 | esbuild builds both bundles; Task 9 overwrites the stub with the real React entry |
| 9 | 2026-06-08 | npm audit | 5 vulns (dev deps) left as-is overnight | `npm audit fix --force` risks breaking changes; flag for morning review |
| 10 | 2026-06-08 | Activation events | Added `"activationEvents": ["onStartupFinished"]` | Integration test caught that the command was never registered without it — real bug, not just a test artifact |
| 11 | 2026-06-08 | Integration test robustness | Test awaits `extensions.getExtension('nima.agent-deck').activate()` before asserting | Avoids race between extension activation and the assertion |
| 12 | 2026-06-08 | Full-window UX | On open, auto-run `workbench.action.moveEditorToNewWindow` (setting `agentDeck.openInNewWindow`, default true, try/catch) | Directly serves the "new window like Agents Window" goal without proposed APIs. NEEDS VISUAL CONFIRMATION in the morning — couldn't verify an OS window overnight |
| 13 | 2026-06-08 | Line endings | Added `.gitattributes` (`* text=auto eol=lf`) + renormalized | Stops the CRLF-normalization warnings; consistent LF in repo |
| 14 | 2026-06-08 | Closed persistence wiring gap | Wired persistence into extension (restore-on-activate as stale, save-on-change) + added `SessionManager.restore`/`relaunch` + a "↻ Relaunch" button on stale rows | The plan created the persistence module + tests but never wired it; v1 scope required it. Now unit-tested (15 total) and visually verified |
