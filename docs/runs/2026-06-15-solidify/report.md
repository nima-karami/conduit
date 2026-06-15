# Solidify re-audit — 2026-06-15

Re-audit of Conduit against the five-category agent-readiness rubric. The repo was
first solidified on 2026-06-10 (ADR 0001); this pass re-scores against the current
rubric, which now treats **secret scanning** and **runtime QA** as explicit,
separately-scored layers.

**Working tree:** clean (safe to apply). **Stack:** JS/TS, Electron + React, single
`package.json`. **Verify:** `npm run verify` exists and is the CI gate.

## Scorecard

| # | Category | Score | Evidence | Proposed change |
|---|----------|-------|----------|-----------------|
| 1 | Instruction files | **Pass** | `CLAUDE.md` (42 lines, pure operational gotchas — bridge global, native rebuild, Monaco/WebGL/esbuild quirks, `.conduit/board.json` contract, docs-layout contract). `AGENTS.md` delegates to it. Passes the Discoverability Filter. | Add **one** non-negotiable line: the verify gate's checks must never be disabled/downgraded to make progress. (minor) |
| 2 | Deterministic checks | **Weak** | Biome 2.4 (format + lint + kebab filenames) and Fallow 2.92 (dead-code + duplication, gate-blocking; complexity advisory by design — 49-fn backlog, ADR 0001). All run in CI. **No local pre-commit hook** — enforcement is CI + manual `npm run verify` only. | Add a **pre-commit hook** (Husky + lint-staged — JS/TS-only repo) running the fast subset (`biome check`) so issues are caught before push. Complexity stays advisory (documented tradeoff, not re-litigated). |
| 3 | Verify harness | **Pass** | Single `npm run verify` = `check → typecheck → test:unit → fallow:check → audit → security`, non-zero on any failure. Wired as the CI gate. | None. |
| 4 | Security gate | **Weak** | **SAST** ✓ Semgrep (CI-authoritative, local best-effort). **Dep/SCA** ✓ `npm audit --audit-level=high`. **Secret scanning** ✗ **absent** — no gitleaks/trufflehog/detect-secrets anywhere. Rubric requires all three; only two exist. | Add **gitleaks** (secret scanning): CI step (authoritative, with full-history scan) + best-effort local runner wired into `npm run security`, mirroring the existing Semgrep pattern. |
| 5 | Runtime QA / e2e | **Pass** | `test/e2e/paste.e2e.mjs` drives the **real built Electron app** via Playwright's `_electron.launch`, presses a real Ctrl+V, asserts the child received bracketed-paste markers. Documented in `test/e2e/README.md`; deliberately excluded from `verify` (CI is headless Linux, can't run the GUI). Real artifact, observable output. | Add an `npm run test:e2e` convenience script (currently `node test/e2e/paste.e2e.mjs`) so the runnable harness is discoverable. (minor) |

## Summary

The repo is in strong shape: categories 1, 3, 5 pass; 2 and 5 have only minor
polish. The one genuine gap is **Category 4 — secret scanning is missing** (ADR 0001
built only SAST + SCA; the rubric requires a third layer). Highest-value fix.

## Proposed actions, in priority order

1. **Security (Cat 4):** add gitleaks — the real gap.
2. **Deterministic checks (Cat 2):** add a pre-commit hook (Husky + lint-staged).
3. **Instruction files (Cat 1):** add the non-negotiable "never disable the gate" line.
4. **Runtime QA (Cat 5):** add the `test:e2e` script.

Each is gated for individual approval. Deliberate prior decisions (a11y off,
complexity advisory, Semgrep CI-authoritative, e2e out of `verify`) are **not**
re-litigated.
