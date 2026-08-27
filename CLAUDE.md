# CLAUDE.md — operational gotchas

Non-obvious things that will bite you. Everything else (structure, stack) is
discoverable by reading the tree.

- **NEVER write redundant comments.** A comment must explain *why* — a non-obvious
  constraint, a gotcha, a reason the code looks odd. Never restate *what* the code
  already says (`// increment i` over `i++`), narrate obvious steps, label sections the
  code structure already makes clear, or repeat a point made elsewhere. If a comment
  would be obvious to anyone reading the line, delete it. Match the surrounding comment
  density; when unsure, fewer comments. This is a hard rule, not a preference.
  - **Don't restate a decision already written in an ADR / plan / spec — link to it.**
    If the *why* lives in `docs/adr/`, `docs/plans/`, or `docs/specs/`, the comment is a
    one-line pointer (`// see ADR 0002 §3`), not a re-explanation. Keep at the code only
    the gotcha that isn't already documented; never paste the rationale, trade-offs, or
    background that the doc already holds. A multi-line essay reproducing a doc is the
    failure this rule names.
- **Fix root causes, not symptoms — no band-aids.** When something's wrong, find *why*
  and fix it at the source; don't paper over it. Concrete smells to avoid: escalating CSS
  specificity to win a cascade fight (`.a .b .c {…}` just to out-rank a rule), relying on
  source order, `!important`, magic offsets that cancel another bug, swallowing an error
  instead of handling it, or `as any`/`@ts-ignore` to silence a real type problem. If a
  reusable thing forces consumers to override it, the *thing* is wrong — fix it there. The
  band-aid usually costs more lines than the real fix and leaves a trap for the next person.
  When the clean fix is genuinely larger, say so and let the user choose — don't silently
  ship the hack.
- **Verify with one command:** `npm run verify` (format-check + lint + dead-code +
  duplication + typecheck + tests + security: SAST/dep-audit/secrets). It's the gate;
  make it green before claiming done. **Never disable, downgrade, narrow, or defer one
  of its checks to make progress** — fix the code, not the check. The same gate runs in
  pre-commit (Husky → lint-staged) and CI (`.github/workflows/verify.yml`).
- **Renderer↔host bridge global is `window.agentDeck`, not `conduit`.** Legacy
  name (`electron/preload.ts` → `exposeInMainWorld('agentDeck')`); renaming it is a
  cross-cutting change, not a quick find-replace. The renderer holds no source of
  truth — all state lives in the Electron main process.
- **Renderer falls back to a fake shell when `window.agentDeck` is absent**
  (`webview/bridge.ts`). That's why the UI renders in a plain browser for preview —
  don't assume host APIs exist at runtime; guard for `undefined`.
- **Code navigation is Monaco's own, and it only works because of the editor opener.**
  Monaco's standalone `ICodeEditorService` refuses to open any URI but the current model's,
  so every built-in navigation command silently no-ops across files until
  `monaco.editor.registerEditorOpener` is registered (`webview/monaco-opener.ts`). This was
  once recorded here as an esbuild bundling problem and a custom `agentdeck.goToDefinition`
  was written around it — that diagnosis was wrong; see the navigation-parity spec §0. Also:
  the goto commands are registered with `registerAction2`, so `editor.getAction('editor.
  action.revealDefinition')` is **null** — reach them through `webview/monaco-commands.ts`.
- **The TS worker is OURS** (`webview/ts.worker.ts`, bundled as `ts.worker.js`): monaco's,
  subclassed to add `getTypeDefinitionAtPosition` / `getImplementationAtPosition`, which its
  worker never exposed and Go to Type Definition / Implementations need.
- **`getDocument` must always be passed our `PDFWorker` explicitly** (`webview/pdf-setup.ts`
  → `pdf-document.ts`). pdf.js adopts the shared `GlobalWorkerOptions.workerPort` into the
  *loading task* whenever `worker` is omitted, so the `task.destroy()` that runs on a document
  switch tears down the **shared** worker — every later load then fails, and the viewer reports
  it to the user as "corrupt or invalid PDF". That is a real bug this repo shipped; it failed 4
  of 5 PDF→PDF switches. The worker is also lazy on purpose — `pdf-setup` is in the eager
  bundle, so building it at module scope spun up the worker on every app launch.
- **A React `onWheel` cannot `preventDefault`** — React binds `wheel` (and `touchstart`/
  `touchmove`) as **passive** on the root, so the call is discarded with a console error. Any
  wheel handler that must suppress the default (zoom stages, the PDF scroll container) binds
  natively with `{ passive: false }`; see `webview/use-pan-zoom-stage.ts`.
- **Zoomable surfaces must apply their fit before first paint.** Fit computed in a `useEffect`
  paints the content at full size for a frame and then corrects it — which, with a CSS
  transition on `transform`, is a visible animated shrink. Measure the pane and snap to fit in
  `useLayoutEffect`, and gate the content on the hook's `ready` flag for the async-decode case
  (an `<img>`'s natural size can arrive after first paint). See the viewer-robustness spec §3.
- **Project sources reach the TS worker as `extraLibs`, never as a model per file**
  (`webview/ts-project.ts`). The worker resolves modules out of extraLibs, and Monaco
  materialises a model on demand for whichever file a navigation lands in. Re-introducing a
  model per project file is what used to make opening a file janky. Corollary: `setExtraLibs`
  re-versions every entry on each call — use `addExtraLib` and batch.
- **`Terminal.onScroll` does not fire for a wheel scroll.** xterm reports the viewport path
  with `suppressScrollEvent`, so it fires for new output and for `scrollLines()` only. Anything
  keyed on scroll position (the terminal's jump-to-latest control) must ALSO listen to
  `.xterm-viewport`'s own `scroll` event — and an e2e that scrolls via `scrollLines()` takes the
  other path, so it passes against a build no user could operate. Scroll with a real wheel.
- **Claude Code's mouse tracking is version-dependent — don't assume it's off.** Up to 2.1.223
  it was verified to emit only `?2004h`/`?1004h`/`?2031h`, no `?1000h`/`?1002h`/`?1003h`, and
  never the alternate screen; **newer versions do enable mouse tracking** (that's how a killed
  one poisoned a relaunched session's scrollback — see
  `docs/specs/2026-08-20-scrollback-replay-neutralizer.md`). So `shouldHandleWheelLocally`'s
  takeover in `webview/terminal-scroll.ts` can apply to it after all; treat it as any other
  mouse-mode TUI rather than special-casing the tool by name.
- **Any overlay painted over `.topbar` must declare `-webkit-app-region: no-drag`.**
  Electron resolves app-region into a **window-level mask that ignores z-order and ignores
  what is drawn on top**, and the default `none` does *not* cut a hole — only an explicit
  `no-drag` does. A control inside `.topbar`'s rect is therefore dragged, not clicked. This
  shipped: the settings modal's × was dead wherever it overlapped the top bar, and it looked
  theme-specific because Aero's top bar is an inset card reaching 12px further down than
  Neon's full-bleed one (26px of the button swallowed vs 14px). **No e2e can catch this** —
  Playwright's synthesized input bypasses the mask, so every automated probe comes back
  clean while a real mouse fails. `test/unit/drag-region.test.ts` is the guard instead.
- **Don't remove the GPU switches in `electron/main.ts`** (`ignore-gpu-blocklist`,
  `enable-unsafe-swiftshader`) — the shader background needs WebGL on GPU-less /
  blocklisted / headless machines, or it silently breaks.
- **The feature board persists per opened project to `<projectRoot>/.conduit/board.json`**
  (`electron/conduit-fs.ts` `readBoardForProject`/`writeBoardArtifactFile`,
  `electron/board-watcher.ts`, ADR 0002). The host deliberately never reads a repo-root
  `board.json` (the old "overnight agent" surface was removed). An absent/invalid
  `.conduit/board.json` is an EMPTY board — Conduit's own seed is never injected into a
  foreign project.
- **User runtime config is in Electron's userData dir, not the repo:**
  `agents.json` (agent defs) and `sessions.json` (persisted sessions) under
  `app.getPath('userData')`.
- **`node-pty` is `@lydell/node-pty`** (prebuilt binaries, no C++ toolchain). It
  must match Electron's ABI; rebuild from source only via `npm run rebuild`
  (needs Python + VS Build Tools). **Pinned exactly** because it is a pre-release — bump it
  only with the smoke suite, never as part of a routine `npm update`.
- **A loaded machine fails the PTY e2es the way a broken PTY does.** `scrollback`,
  `terminal-drop` and `git-blame` all assert "the shell echoed what we typed", so leftover
  `cmd.exe`/`conhost` from earlier runs starve ConPTY and they fail together — which reads
  exactly like a node-pty/xterm regression and has twice sent someone bisecting the wrong
  package. Re-run a failure ALONE on a quiet machine before believing it. Never clean up by
  killing processes by NAME: the user's own Claude Code sessions run under `cmd.exe`, and a
  blanket `Get-Process cmd | Stop-Process` kills their work. Scenario teardown is already
  PID-scoped (`killAppTree` in `test/e2e/harness.mjs`) — let it do the job.
- **CI `verify` runs on `ubuntu-latest`; only the Release build is Windows.** A unit test
  that passes here because of win32 behaviour — Monaco's `Uri.file` converting `\`, `path`
  joins, drive-letter casing, `process.platform` — goes red in CI. Normalise explicitly in
  the code under test; never rely on the platform. (v0.34.0's first tag failed CI this way.)
- **Two tsconfigs** (host + webview): `npm run typecheck` runs both — a change can
  pass one and fail the other.
- **Host/PTY/IPC-boundary items use `npm run test:smoke`** instead of marking `needs-human-smoke` — write a new `test/e2e/<name>.e2e.mjs` scenario on the shared harness (`test/e2e/harness.mjs`). The runner launches the app **hidden** (`CONDUIT_E2E=1` → `show:false` in `main.ts`) so the suite runs in the background; `attention.e2e.mjs` opts out (it needs a real focusable window). Inner loop: filter to one scenario, e.g. `node test/e2e/run-smoke.mjs quit-guard` (~30s); full suite is the pre-integration regression check.
- **Docs layout is a contract (ADR 0003), not a free-for-all.** `docs/adr/NNNN-slug.md`
  = durable decisions; `docs/specs/YYYY-MM-DD-slug.md` = active feature specs (with
  `status:`/`date:` frontmatter + a row in `docs/specs/INDEX.md`), moved to
  `docs/specs/archive/` via `git mv` once shipped; `docs/plans/*.plan.md` = plans;
  `docs/runs/<date>-<name>/` = per-run report/audit/retro. User-facing changes go in
  root `CHANGELOG.md`. Read `docs/specs/INDEX.md` to find a spec — never glob/read
  the whole archive (it's out of the default path on purpose; see ADR 0003).
