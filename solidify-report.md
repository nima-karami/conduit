# Solidify report — Conduit

Audit of the repo against the four highest-leverage agent-readiness categories.
Stack detected: **Node / TypeScript** (Electron + React + esbuild + Vitest),
Node v22, npm v10. Working tree clean at audit time.

| # | Category | Score | Evidence | Proposed change |
|---|----------|-------|----------|-----------------|
| 1 | **Instruction files** | ❌ Missing | No `AGENTS.md` / `CLAUDE.md` / `.cursorrules`. README + `docs/DECISIONS.md` exist but are human-facing prose, not an agent gotcha file. | Add a slim `CLAUDE.md` (~15 lines) of **non-discoverable operational gotchas** only (native rebuild, bridge-name mismatch, Monaco/WebGL/esbuild quirks, shared `board.json` path). Add `AGENTS.md` as a pointer so non-Claude agents find it. |
| 2 | **Deterministic checks** | ❌ Missing | No formatter, linter, dead-code, or complexity tool in devDeps. Only `typecheck` exists. No pre-commit, no CI. | Add **Biome** (format + lint) and **Fallow** (unused code, duplication, circular deps, complexity hotspots, architecture boundaries — supersedes Knip). Config + npm scripts. |
| 3 | **Verify harness** | ⚠️ Weak | `build`, `test:unit`, `typecheck` exist but are scattered; no single command returning one exit code; nothing documented as *the* gate. | Add one `npm run verify` = format-check → lint → typecheck → tests → security, exiting non-zero on any failure. |
| 4 | **Security gate** | ❌ Missing | No SAST anywhere. Highest-risk gap (agents skew functionally-correct but insecure). | Add **Semgrep CE** (`p/javascript`, `p/typescript`, `p/react` rulesets) into `verify` and CI. |

Plus: a **GitHub Actions CI workflow** running `npm run verify` on push/PR (no
`.github/workflows` exists today).

## Tooling rationale (web-confirmed, June 2026)

- **Biome** — modern all-in-one (Rust) formatter+linter; default recommendation
  for new TS projects; single tool replaces ESLint+Prettier with near-zero config.
- **Fallow** — Rust-native codebase intelligence (2026); free static layer covers
  unused code + duplication + circular deps + complexity + architecture boundaries
  in one pass, superset of Knip, built for cleaning AI-generated code.
- **Semgrep CE** — free (LGPL) language-agnostic SAST; diff-aware `semgrep ci`.

## Expected friction

Adding Biome/Knip/Semgrep to an existing repo will surface **pre-existing
violations**. Per the skill, I will wire the gate up and **report** the backlog
rather than silently suppressing rules — you decide fix-now vs. baseline.

## Apply order

1 → 2 → 3 → 4, each gated by your approval. CI workflow lands with category 3.
