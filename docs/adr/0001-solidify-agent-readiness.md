# ADR 0001 — Solidify the repo for human/agent collaboration

Date: 2026-06-10
Status: Accepted

## Context

Conduit is now public and worked on by both humans and AI coding agents. It had
no agent-instruction file, no formatter/linter, no single verify command, and no
security gate. The audit (`solidify-report.md`) scored all four agent-readiness
categories Weak/Missing.

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
unit tests → security, exiting non-zero on any failure. Wired as the CI gate
(`.github/workflows/verify.yml`, push/PR). `npm run analyze` runs Fallow separately.

**4. Security gate.** Adopted **Semgrep** (`p/javascript`, `p/typescript`,
`p/react`). Semgrep has no native Windows build, so:
- **CI is authoritative** — Semgrep runs natively on the Linux runner on every push/PR.
- **Local is best-effort** — `tools/security-scan.mjs` uses Semgrep via PATH or the
  Docker image, otherwise skips with a notice. This keeps `npm run verify` unblocked
  on a Windows dev box without weakening the merge gate.

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
