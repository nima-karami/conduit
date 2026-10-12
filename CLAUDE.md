# CLAUDE.md — operational gotchas

Only what will bite you and isn't discoverable from the tree. Rationale lives in the linked
spec/ADR/test, not here.

## Rules

- **Comments explain WHY, never what.** If the why lives in `docs/adr|specs|plans`, the comment
  is a one-line pointer (`// see ADR 0002 §3`), not a re-explanation. Hard rule.
- **Fix root causes, no band-aids**: no specificity escalation, source-order reliance,
  `!important`, magic offsets, swallowed errors, `as any`/`@ts-ignore`. If a reusable thing forces
  consumers to override it, fix the thing. If the clean fix is bigger, say so and let the user choose.
- **Gate: `npm run verify`** (also pre-commit and CI). Never disable, narrow or defer a check.
  Inner loop: `npm run verify:quick`. CI runs on **ubuntu** — never rely on win32 behaviour
  (`path`, `\`, drive-letter casing, `process.platform`) in a unit test; normalise in the code.
- **E2E runs remotely**: `npm run e2e:remote` (`--affected` default, `--full`, or names). Locally
  only ONE scenario by exact name: `npm run e2e -- <name>`. Launch only via `launchElectron`, exit
  only via `finishScenario`. Host/PTY/IPC changes get a `test/e2e/<name>.e2e.mjs`, not a
  "needs human smoke". Quarantine only by a reviewed edit to `test/e2e/quarantine.json`.
- **A loaded machine fails PTY e2es like a broken PTY does.** Confirm a local failure remotely
  before bisecting. Never kill processes by name — the user's own Claude sessions run in `cmd.exe`.
- **Docs layout is ADR 0003.** Find specs via `docs/specs/INDEX.md`; never glob the archive.
  User-facing changes go in `CHANGELOG.md`.

## Gotchas

**Host / platform**
- Bridge global is `window.agentDeck` (legacy name; renaming is cross-cutting). All state lives in
  the main process. Without the bridge the renderer runs a fake shell (`webview/bridge.ts`) — guard
  host APIs for `undefined`.
- Spawn git only via `runGitBin` (`src/git-exec.ts`, sets `GIT_OPTIONAL_LOCKS=0`); otherwise our
  own `git status` rewrites the index and the watcher loops.
- Watch directories only via `watchDir` (`electron/watch-dir.ts`): a deleted watched dir loops
  ~80k events/s on Windows and pins the dir.
- `node-pty` is `@lydell/node-pty`, **pinned exactly** (pre-release, ConPTY-only — it ignores
  `useConpty`). Bump only with a remote `--full` e2e run.
- Keep the GPU switches in `electron/main.ts` (`ignore-gpu-blocklist`, `enable-unsafe-swiftshader`).
  `disableDomainBlockingFor3DAPIs` is deliberately NOT called (web-tab safety).
- User config is in `app.getPath('userData')` (`agents.json`, `sessions.json`); the board is
  `<project>/.conduit/board.json` (ADR 0002) — a missing one is an empty board.

**Security (host-enforced; the renderer is never load-bearing)**
- `conduit-preview:` confinement is in `electron/preview-protocol.ts`: one token per root = one
  origin; every path checked with `isInsideRoot` AND `realPathLeaf` against **that token's** root;
  URL hand-parsed because `new URL()` collapses `..`. Any widening is a security change (ADR 0005).
- Web-tab popups are on; only `createGuestOpenGate` (`src/webview-guard.ts`) — a fresh real
  gesture per open — keeps them from being a page→OS-browser channel.

**Terminal**
- PTY size must equal the xterm's size, and every `Terminal` needs the host's `windowsPty`
  (without it a rows-grow loses lines to ConPTY's repaint).
- The persisted scrollback ring holds exactly what the terminal was shown; bytes we inject
  mid-stream are framed `ESC7…ESC8` (xterm runs DECRC on `?1049l`, `ESC[r` homes the cursor).
- WebGL addons only through `webview/terminal-gpu.ts` — a GPU-process restart wipes the shared
  glyph atlas. See `docs/runs/2026-10-11-render-triad/report.md`.
- `Terminal.onScroll` doesn't fire for wheel scrolls; also listen to `.xterm-viewport` `scroll`,
  and e2e must scroll with a real wheel. Claude Code's mouse tracking depends on its version.
- E2E writes into an xterm go through `writeToTerminal` (harness) — a bare
  `page.evaluate(() => new Promise(r => term.write(d, r)))` flakes on the runner.

**Monaco**
- Cross-file navigation only works because of `registerEditorOpener` (`webview/monaco-opener.ts`).
  Goto commands are `registerAction2` — `getAction()` returns null; use `webview/monaco-commands.ts`.
- The TS worker is ours (`webview/ts.worker.ts`). Project sources go in as `extraLibs`, never a
  model per file; use batched `addExtraLib` (`setExtraLibs` re-versions everything).
- Monaco's DOM is in our cascade: no bare generic class names, no global resets inside it
  (guard: `test/unit/monaco-class-collision.test.ts`; `npm run text-fit`). Floating chrome must
  beat Monaco's own z-index (`.minimap` is 5).

**Renderer / React**
- Any overlay over `.topbar` needs `-webkit-app-region: no-drag` — the drag mask ignores z-order
  and no e2e can see it (guard: `test/unit/drag-region.test.ts`).
- React `onWheel` is passive; bind natively with `{ passive: false }` to `preventDefault`
  (`webview/use-pan-zoom-stage.ts`).
- Zoomable surfaces apply their fit in `useLayoutEffect`, gated on `ready`, never `useEffect`.
- Always pass our `PDFWorker` to `getDocument` (`webview/pdf-setup.ts`); omitting it lets a
  document switch destroy the shared worker.
- Virtualized list rows are direct keyed children — `flatMap`, never `[row, extra]` per row.
- A leftover variable named after a DOM global (`name`, `status`, `open`, `event`) still
  type-checks; grep when renaming state (`confirm`/`alert`/`prompt` are lint-banned).
