# ADR 0001 — Solidify the repo for human/agent collaboration

Date: 2026-06-10
Status: Accepted

## Context

Conduit is now public and worked on by both humans and AI coding agents. It had
no agent-instruction file, no formatter/linter, no single verify command, and no
security gate. The audit (`docs/runs/2026-06-10-solidify/audit.md`) scored all four
agent-readiness categories Weak/Missing.

## Decision

**1. Instruction files.** Added `CLAUDE.md` (operational gotchas only — bridge
name, native rebuild, Monaco/WebGL/esbuild quirks, shared `board.json`) and an
`AGENTS.md` pointer. Deliberately kept slim; discoverable structure is not duplicated.

**2. Deterministic checks.** Adopted **Biome 2.4** (formatter + linter, pinned) and
**Fallow 2.92** (codebase intelligence — unused code, duplication, cycles,
complexity). Style aligned to existing code (single quotes, semicolons, 2-space,
width 100).
- The web **a11y rule group is disabled** (`biome.json`). Conduit is a single-user
  desktop Electron UI, not a public web page; the ~115 a11y findings (button
  types, click-handler keyboard pairs, svg titles) were high-churn / low-value
  here. Correctness, suspicious, style, and complexity rules remain enforced.
- **Filenames are kebab-case**, enforced by Biome `useFilenamingConvention`. Every
  component/module/test was renamed (`CommandPalette.tsx` → `command-palette.tsx`,
  `sessionManager.ts` → `session-manager.ts`, `useEscapeKey.ts` → `use-escape-key.ts`)
  via `git mv` (history preserved) with imports rewritten — one convention repo-wide.
- All other lint findings were **fixed**, not suppressed: React hook deps wrapped
  in `useCallback`, `forEach` callbacks given block bodies, non-null assertions
  replaced with guards/throws, array-index keys replaced with stable keys. Three
  justified inline `biome-ignore`s remain (a `gl.useProgram` WebGL false positive;
  a static per-character key) plus seven CSS `noDescendingSpecificity` ignores
  (reordering risked visual regressions with no test coverage).
- **Fallow is partially blocking.** Its **dead-code and duplication** checks are
  gate-blocking (`npm run fallow:check` = `fallow --skip health`), now that both are
  clean: `fallow fix` dropped redundant `export` keywords (a no-cross-module-consumer
  export becomes a local, not deleted), the last unused type export was de-exported,
  and the duplicated Escape-key effect and rAF render loop were extracted into shared
  `useEscapeKey` / `runRenderLoop` modules (0% duplication). Its **complexity/health**
  check stays **advisory** (`npx fallow health`, `continue-on-error` in CI) — 49
  functions exceed the threshold (a large pre-existing backlog) and average
  maintainability is "good", so it informs via the dashboard rather than blocking.
  Note the earlier false-positive caveat: a "dead" export may be used within its own
  module; use `// fallow-ignore-next-line unused-exports` or `ignoreExports` for
  genuinely intentional public surface.

**3. Verify harness.** Added a single `npm run verify` = Biome check → typecheck →
unit tests → Fallow (dead-code/dupes) → npm audit → security, exiting non-zero on
any failure. Wired as the CI gate (`.github/workflows/verify.yml`, push/PR).
`npm run analyze` runs Fallow separately.

**4. Security gate.** Two complementary layers:
- **SAST — Semgrep** (`p/javascript`, `p/typescript`, `p/react`) over first-party
  code. No native Windows build, so **CI is authoritative** (runs natively on the
  Linux runner) and **local is best-effort** (`tools/security-scan.mjs` uses Semgrep
  via PATH or Docker, else skips with a notice) — keeps `npm run verify` unblocked on
  Windows without weakening the merge gate.
- **SCA — `npm audit --audit-level=high`** (`npm run audit`) over the dependency tree,
  **blocking on high/critical across all deps** (incl. dev). Reaching zero required
  major upgrades (`electron 31→42`, `vitest 2→4`, `esbuild`, `@electron/rebuild 3→4`);
  validated by app boot + a manual smoke test since the unit suite can't catch
  Electron ABI/runtime breakage. `monaco-editor` was held at 0.55 (the forced fix
  downgraded it to 0.53 and broke the build; its remaining dompurify advisory is only
  *moderate*, below the gate). 2 moderate prod advisories remain by design.

## Consequences

- One command (`npm run verify`) is the self-correction loop for agents and humans;
  CI enforces it plus Semgrep on every change.
- Formatting churn touched ~70 files once (committed as a checkpoint).
- a11y is intentionally unenforced; if Conduit ever ships an accessible/web surface,
  re-enable the `a11y` group in `biome.json` and burn down the backlog.
- Fallow now blocks on dead-code and duplication regressions (kept at zero), while
  complexity drift is surfaced via the advisory health dashboard rather than blocked.
- A local Semgrep baseline was not captured during this pass (no Python/Docker
  daemon available); the first authoritative scan runs in CI.
