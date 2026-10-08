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
