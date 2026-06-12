# CLAUDE.md — operational gotchas

Non-obvious things that will bite you. Everything else (structure, stack) is
discoverable by reading the tree.

- **Verify with one command:** `npm run verify` (format-check + lint + typecheck +
  tests + security). It's the gate; make it green before claiming done.
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
- **`board.json` (repo root) is the overnight agent's direct-write surface.** Resolved
  at `__dirname/../board.json`; the overnight agent advances Kanban cards by editing it
  directly. It's committed on purpose — don't gitignore or relocate it. NOTE (G0): the
  **in-app** feature board no longer reads/writes this file — it now persists per opened
  project to `<projectRoot>/.conduit/board.json` (see `electron/board-watcher.ts`,
  `readBoardForProject`, ADR 0002). The root `board.json` and the in-app board are
  intentionally decoupled until convergence is decided; editing the root file no longer
  moves cards in the app.
- **User runtime config is in Electron's userData dir, not the repo:**
  `agents.json` (agent defs) and `sessions.json` (persisted sessions) under
  `app.getPath('userData')`.
- **`node-pty` is `@lydell/node-pty`** (prebuilt binaries, no C++ toolchain). It
  must match Electron's ABI; rebuild from source only via `npm run rebuild`
  (needs Python + VS Build Tools).
- **Two tsconfigs** (host + webview): `npm run typecheck` runs both — a change can
  pass one and fail the other.
- **Docs layout is a contract (ADR 0003), not a free-for-all.** `docs/adr/NNNN-slug.md`
  = durable decisions; `docs/specs/YYYY-MM-DD-slug.md` = active feature specs (with
  `status:`/`date:` frontmatter + a row in `docs/specs/INDEX.md`), moved to
  `docs/specs/archive/` via `git mv` once shipped; `docs/plans/*.plan.md` = plans;
  `docs/runs/<date>-<name>/` = per-run report/audit/retro. User-facing changes go in
  root `CHANGELOG.md`. Read `docs/specs/INDEX.md` to find a spec — never glob/read
  the whole archive (it's out of the default path on purpose; see ADR 0003).
