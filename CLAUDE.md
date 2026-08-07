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
- **Go-to-definition is a custom worker-backed action** (`agentdeck.goToDefinition`
  in `webview/components/code-viewer.tsx`), *not* Monaco's built-in — esbuild doesn't
  reliably bundle Monaco's native goto. `ts.worker.js` is bundled separately
  (`webview/monaco-setup.ts`). Don't "simplify" back to the built-in action.
- **`Terminal.onScroll` does not fire for a wheel scroll.** xterm reports the viewport path
  with `suppressScrollEvent`, so it fires for new output and for `scrollLines()` only. Anything
  keyed on scroll position (the terminal's jump-to-latest control) must ALSO listen to
  `.xterm-viewport`'s own `scroll` event — and an e2e that scrolls via `scrollLines()` takes the
  other path, so it passes against a build no user could operate. Scroll with a real wheel.
- **Claude Code never enables mouse tracking** (verified against 2.1.223: it emits only
  `?2004h`/`?1004h`/`?2031h`, no `?1000h`/`?1002h`/`?1003h`, and never the alternate screen).
  So `shouldHandleWheelLocally`'s takeover in `webview/terminal-scroll.ts` never applies to it —
  that path is for other mouse-mode TUIs. Don't "fix" Claude Code scrolling there.
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
