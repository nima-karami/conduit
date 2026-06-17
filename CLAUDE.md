# CLAUDE.md — operational gotchas

Non-obvious things that will bite you. Everything else (structure, stack) is
discoverable by reading the tree.

- **NEVER write redundant comments.** A comment must explain *why* — a non-obvious
  constraint, a gotcha, a reason the code looks odd. Never restate *what* the code
  already says (`// increment i` over `i++`), narrate obvious steps, label sections the
  code structure already makes clear, or repeat a point made elsewhere. If a comment
  would be obvious to anyone reading the line, delete it. Match the surrounding comment
  density; when unsure, fewer comments. This is a hard rule, not a preference.
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
  (needs Python + VS Build Tools).
- **Two tsconfigs** (host + webview): `npm run typecheck` runs both — a change can
  pass one and fail the other.
- **Host/PTY/IPC-boundary items use `npm run test:smoke`** instead of marking `needs-human-smoke` — write a new `test/e2e/<name>.e2e.mjs` scenario on the shared harness (`test/e2e/harness.mjs`).
- **Docs layout is a contract (ADR 0003), not a free-for-all.** `docs/adr/NNNN-slug.md`
  = durable decisions; `docs/specs/YYYY-MM-DD-slug.md` = active feature specs (with
  `status:`/`date:` frontmatter + a row in `docs/specs/INDEX.md`), moved to
  `docs/specs/archive/` via `git mv` once shipped; `docs/plans/*.plan.md` = plans;
  `docs/runs/<date>-<name>/` = per-run report/audit/retro. User-facing changes go in
  root `CHANGELOG.md`. Read `docs/specs/INDEX.md` to find a spec — never glob/read
  the whole archive (it's out of the default path on purpose; see ADR 0003).
