# Goal — language coverage (2026-10-08)

**Outcome:** the well-known languages and config formats are recognised and coloured (incl. by filename
and shebang); Python, Rust and C/C++ get Go-parity navigation; language servers are bounded in count and
memory and sleep when nothing visible needs them. Spec: docs/specs/2026-10-08-language-coverage.md (FULL).

**Gate:** `npm run verify` on the integrated tree; `npm run e2e:remote -- --full` before release.
**Conductor tier:** Opus 5.5. Builders/reviewers/QA: Opus. Mechanical: Sonnet.

## User decisions (2026-10-08, asked directly)
- D1: tier-1 servers = Python (basedpyright), Rust (rust-analyzer), C/C++ (clangd). Java etc. deferred.
- D3: clangd background index ON, -j=2 (writes .cache/clangd/ into the repo).
- D7: residency limits + dormancy + "invisible open doesn't launch" apply to ALL servers incl. Go/C#.
## Spec defaults accepted by conductor
- D2 2 heavy / 4 live / 10 min dormancy; D4 rust-analyzer build scripts + proc-macros on (behind trust);
  D5 basedpyright w/ pyright alternate; D6 ship aliased grammars; D8 `.m` stays plain.
## Process rule from the previous run
- Builders commit on a NAMED branch; conductor integrates by the reviewed SHA and asserts ancestry.
- File edits via the Edit tool only (PowerShell read-modify-write double-encodes UTF-8).

## Architecture critic (plan 1d5f6aa): PROCEED_WITH_CHANGES — 9 required, all adopted
- Conductor decisions: eviction awaits evictee EXIT (bounded ~2 s) so AC-C1's cap is real; lane W
  (RootWatchPool) DEFERRED (no measured force, stale-handle bug class); optional suggestions adopted.
- Planner amending the plan; S0 builder unaffected (plan forbids S0 contract changes).
- Lane B deviation 2 accepted: clangd hint stays `winget install LLVM.LLVM` (only Windows is released). Lane C started from lane B SHA during B's review (merge B fixes into C if any).
- Lane B review REQUEST_CHANGES: blocker = AC-B4 'save runs no cargo' cannot fail (no didSave exists). Sent to B (e2e/spec/ADR/comment only). Nits 1 (closeForReopen ordering) + 2 (probe execFile hang) routed to lane C, which owns lsp-manager.ts/main.ts now. Nit 3 (winget-only hint) accepted.
