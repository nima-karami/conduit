# Goal — language support fast release (2026-10-08)

**Outcome:** opening Markdown, YAML, golden, log and C# files in the editor "just works":
coloured on first paint, sensible folding, no mutation of byte-exact files, Go-parity code
navigation for C# when a server is installed, and nothing new running for inactive files.

**Gate:** `npm run verify` (full) on the integrated tree; `npm run e2e:remote` for host/LSP items.
**Runtime harness:** built Electron app via `npm run e2e -- <name>` / remote e2e (Playwright-Electron).
**Mandate:** scope — the five file kinds above, released as a version bump. User asked for speed.
**Conductor tier:** Opus 5.5 (session). Builders/reviewers: Opus. Mechanical: Sonnet.
**Waivers:** none.

## Conductor decisions (unattended)
- YAML language server NOT added: the LSP client is nav-only (definition/hover/refs/symbols;
  diagnostics are dropped), and YAML has nearly no navigation — cost without user value.
- C# gets `csharp-ls` via the existing registry (ADR 0006), optional binary, install hint shown.
- "Sleep when inactive" = existing LSP idle stop (60s after last tab closes) covers servers;
  spec audits that nothing new (grammar, worker) runs for an unopened language.

## Spec decisions resolved by conductor (spec: docs/specs/2026-10-08-language-support.md, FULL)
- D1: pin the latest stable `csharp-ls` that the windows-latest preinstalled .NET SDK runs; if it
  cannot run there, AC-B3/B4 go to remote-exclusions with the reason (B1/B2/B5/B6 still gate).
- D2: invalid UTF-8 opens read-only for ALL files — accepted (prevents silent corruption).
- D3: mixed EOL read-only for goldens only — accepted.
- D4: a log over 2 MB shows its tail — accepted.
- D5: line navigation into a tail window shows a toast — accepted.
- D6: C# requires a project marker — accepted.
- Topology: delegated, 2 lanes (A renderer/file-service, B C# LSP), file-disjoint per spec; Opus builders.
