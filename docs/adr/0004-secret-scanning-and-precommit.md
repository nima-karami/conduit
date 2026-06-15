# ADR 0004 — Secret scanning + pre-commit hook (solidify re-audit)

Date: 2026-06-15
Status: Accepted

## Context

A re-audit against the current agent-readiness rubric
(`docs/runs/2026-06-15-solidify/report.md`) found the repo strong on four of five
categories (instruction files, verify harness, deterministic checks, runtime QA) but
with one genuine gap: the security gate had **SAST (Semgrep) + dep audit (`npm audit`)
but no secret-scanning layer** — the rubric requires all three. Two smaller items: no
local pre-commit hook (enforcement was CI + manual `npm run verify` only), and the real
Electron e2e harness lacked a discoverable script. ADR 0001 deliberate decisions (a11y
off, Fallow complexity advisory, Semgrep CI-authoritative, e2e out of `verify`) were
left intact.

## Decision

**1. Secret scanning — gitleaks 8.30.1 (the gap).** Two layers, mirroring the existing
Semgrep pattern:
- **CI is authoritative** (`.github/workflows/verify.yml`): a **pinned binary download**
  (not the marketplace action — gitleaks-action tags, like other action tags, are a
  force-push supply-chain risk) runs `gitleaks git . --redact` over **full history**
  (`fetch-depth: 0` on checkout, 246 commits).
- **Local is best-effort** (`tools/secret-scan.mjs`, wired into `npm run security`):
  `gitleaks dir .` over the working tree via gitleaks on PATH or the pinned Docker
  image, else skips with a notice — keeps `npm run verify` unblocked when gitleaks
  isn't installed.
- **`.gitleaks.toml`** extends the default ruleset (`useDefault = true`) and allowlists
  non-source artifacts (`out`, `dist`, `designs`, `.conduit`, `.vscode-test`,
  `node_modules`, binaries, `package-lock.json`). Validated: both `gitleaks dir .` and
  `gitleaks git .` report **no leaks** on the current tree and full history.

**2. Pre-commit hook — Husky 9.1.7 + lint-staged 17.0.7.** JS/TS-only repo, so the
JS-standard pair (not Lefthook). `.husky/pre-commit` runs `npx lint-staged`, which runs
`biome check --no-errors-on-unmatched` on staged `*.{ts,tsx,js,jsx,mjs,cjs,json,jsonc,css}`.
A `prepare: husky` script installs the hook on `npm install`. CI still runs the full
gate — the hook is the fast local edge, bypassable with `--no-verify`.

**3. Minor polish.** Added `npm run test:e2e` (was a bare `node test/e2e/paste.e2e.mjs`)
so the real-Electron harness is discoverable. Added one non-negotiable line to
`CLAUDE.md`: the verify gate's checks must never be disabled/downgraded to make
progress.

**4. Refactor.** Extracted the shared `has`/`run` spawn helpers into
`tools/scan-helpers.mjs` so `security-scan.mjs` and `secret-scan.mjs` don't trip
Fallow's duplication check (kept at 0%).

## Consequences

- The security gate now has **all three layers** (SAST + dep audit + secret scanning),
  each wired into `npm run verify` and CI.
- Secrets are caught at three points: pre-commit (when gitleaks is local), local
  `verify`, and the authoritative CI history scan.
- `lint-staged@17` warns `EBADENGINE` on Node < 22.22.1 (dev box is 22.14.0) — non-fatal;
  it runs. CI uses Node 22 (latest), no warning.
- `npm run verify` is green: 945 unit tests pass, dead-code/duplication clean, audit at
  the high gate (the 2 pre-existing moderate/low dompurify/monaco advisories from ADR
  0001 remain, below the gate).
