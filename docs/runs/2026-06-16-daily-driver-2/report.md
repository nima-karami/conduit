# Run report — Daily-driver batch 2 (2026-06-16, "E" items)

Second autonomous build-loop pass toward making Conduit a **daily driver**. Three
user-reported items, run **delegated**: the conductor (opus) held architecture + taste
and the ledger; implementation went to fresh-context **sonnet** subagents, **sequential
on `main`** (the items share `right-pane.tsx`, `app.tsx`, `center-pane.tsx`,
`styles.css`, `types.ts` — no parallel fan-out). The conductor split the riskiest item
(E2) into a safe foundation + a quarantined host bet, and independently re-verified +
committed the final feature when its builder left it uncommitted.

Final HEAD (`2269d34`): conductor-run `npm run verify` **EXIT 0** + renderer **esbuild
build EXIT 0** on the merged tree. Unit suite ~1087 → **1136+** (25 osc-cwd + 24
cwd-reporting + 3 active-cwd + breadcrumb tests added).

## Outcome

| Item | Status | Commit | Evidence |
|---|---|---|---|
| **E1** Distinct "root row" in the Files toolbar (session dir name) | **done** | `7b05bf3` | `activeCwd` selector (3 tests); sweep: `.files__root` shows the dir name, title=full path, buttons intact, 0 console errors |
| **E2a** Host parses OSC 7/9;9/1337 cwd reports → live `Session.cwd`; Files/Changes/root-row follow `activeCwd` | **done** | `0930c43` | `osc-cwd` parse+CwdScanner (25 tests, split-chunk safe); sweep: mock `cwd` re-rooted the views while sidebar group stayed on `projectPath`; `trackCwd` setting |
| **E2b** PowerShell/bash emit OSC 9;9 (prompt-preserving injection, recognized shells only) | **needs-human-smoke** | `8592e0d` | `cwd-reporting` augmentation (24 tests); additive/fail-safe merge; live `cd` round-trip crosses the PTY boundary — undriveable in the mock |
| **E3** VS Code-style breadcrumbs: clickable path + in-file symbol segments with sibling dropdowns | **done** | `2269d34` | `breadcrumbs` pure path-relativize + symbol-chain (tests); sweep: path segments + dropdown navigation, symbol segments via the ts.worker, symbol reveal, cursor-driven chain updates, 0 console errors |

**3 done (runtime-verified) · 1 needs-human-smoke (host/PTY boundary).** E2b is not a
failure — its logic is unit-verified and committed; only the real-shell `cd` side effect
can't be observed autonomously. Recipe in `.autoloop/blockers.md`.

## Design decisions taken autonomously (conductor)

- **`projectPath` stays the stable session identity / group key** (sidebar grouping,
  board, recents, owning-session all key off it). The live working directory is a
  **separate new `Session.cwd`** field; one selector `activeCwd(s) = s.cwd || s.projectPath`
  drives what the Files view, Changes view, root row, and breadcrumbs show. Overwriting
  `projectPath` on `cd` would have silently re-grouped sessions and broken those features.
- **cwd detection = passive parse of terminal output** (OSC 7 `file://`, OSC 9;9, OSC 1337
  `CurrentDir=`), host-side where `term:data` already flows, validated against the real FS,
  buffered across chunks. Zero-risk and shell-agnostic.
- **E2 split into E2a (safe) + E2b (risky).** Passive parsing + the view plumbing (E2a) is
  clean and renderer-verifiable. Making *default* shells actually report cwd needs prompt
  injection (E2b), which modifies shell startup — so it was isolated: it keys off the known
  `shell:*` agent ids (not fragile basename parsing), only ever **appends** args/env
  (fail-safe — a recognized shell with `trackCwd` off launches identically), covers
  PowerShell/pwsh (prompt-preserving `-NoExit -Command`) + bash/Git Bash (`PROMPT_COMMAND`),
  and never touches agent commands like `claude`. zsh/fish/cmd/wsl = passive-only in v1.
- **E3 symbols reuse the existing ts.worker** (`getNavigationTree`) the go-to-def action
  already uses — not Monaco's native outline (esbuild bundling caveat, CLAUDE.md). Path-
  segment dropdowns reuse the existing `readDir`/`dirEntries` IPC; no new protocol.

## Gate integrity & the carried-over gate gap

No gate was weakened; existing tests were only added to. The conductor ran the **full
`npm run verify` (EXIT 0) plus `node esbuild.mjs` (EXIT 0)** on the final merged tree —
the latter because `npm run verify` still does **not** bundle the renderer (the gap found
in batch 1). E2a/E2b touch shared `src/` that the renderer imports; the conductor confirmed
`src/osc-cwd.ts` and `src/cwd-reporting.ts` are host-only (not imported by `webview/`), so
no browser-unsafe import leaked in. **Standing recommendation (still open): add
`node esbuild.mjs` to the verify chain.**

## Follow-ups for the user

1. **Human smoke (E2b)** — recipe in `.autoloop/blockers.md`: with `trackCwd` on (default),
   `cd` in a real **PowerShell** and **bash** session should re-root the Files/Changes views
   + root row live (sidebar group unchanged); an **agent (claude)** session is unaffected;
   toggling `trackCwd` off restores identical shell launch. Worth confirming sessions still
   launch normally, since shell-spawn changes couldn't be autonomously driven.
2. **cwd reporting for more shells:** zsh/fish/cmd emit no cwd sequence and aren't injected
   in v1 (passive parsing still applies if they emit). zsh via `precmd`/`ZDOTDIR` and a cmd
   `PROMPT` hack are possible follow-ups.
3. **Harden the gate:** add `node esbuild.mjs` to `npm run verify` (carried from batch 1).

Not pushed — all commits on local `main` (standing rule). `2269d34` is HEAD; this report +
CHANGELOG commit lands on top.
