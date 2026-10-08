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

## Lane B handback (lane-b-csharp@9a77085)
- Remote e2e PASS: csharp-lsp, csharp-lsp-idle, go-lsp (run 37814221069). Gate: verify exit 1 at npm audit only.
- New blocker for release: `npm audit` 2 highs pre-existing at base (http-cache-semantics via electron-builder/got,
  source-map-js via vue/jsdom/postcss). Conductor fixes on the integration branch AFTER lane A finishes
  (shared node_modules junction) — via `overrides`, not by narrowing the audit.
- Relative DOTNET_CLI_HOME → no search dir (spec-literal): accepted; low impact.
- Review dispatched (Opus, read-only).

## Lane A handback (lane-a-language@c58d7ea)
- Remote e2e PASS language-files (run 37816375395). Gate: verify exit 1 at npm audit only (same as base).
- Lane B review: APPROVE, 3 should + 6 nits sent back to lane B builder (N4 recorded as limitation).
- Lane A review dispatched (Opus, read-only).
- Conductor decisions: goldens must NOT reach LSP sync — filter with isGoldenPath in app.tsx at integration.
  Save-refusal copy must name the actual read-only reason (fix in lane A after review). Tail toast on Back/Forward: accepted.
- npm audit: both highs fixable in-range → plain `npm audit fix` (lockfile only) at integration, after lane B frees node_modules.
- npm audit: `npm audit fix` bumped ~50 pkgs (mermaid, milkdown, electron-builder) → reverted; targeted
  `npm update http-cache-semantics source-map-js` (c2cdbf9), audit high exit 0.
- Lane B merged into feat/language-support (5dbacf5).
- Lane A review: REQUEST_CHANGES (blocker: file-service.ts mojibake from PowerShell rewrite; cap race; bare-CR
  golden; tail boundary). Sent back with golden-LSP filter + save-refusal copy (lane A now merges integration first).
- Lane A re-review APPROVE; two should-fixes (2 MB alloc per read = +55% small-file reads; read-only
  seed made goldens "unsaved") fixed in d9fe699/db31d3e, conductor read the diff.
- Lane A merged: 0b34713. FULL `npm run verify` on integrated tree: exit 0.
- Full remote e2e (--full) on 0b34713 + runtime QA (Opus, real app, 3 themes) dispatched.
- Release plan: v0.46.0 (minor — new language support).
- Full remote e2e on 0b34713: 177 PASS / 8 EXCLUDED (pre-existing) / verify job success — run 37821404454.
- Runtime QA on 0b34713: FAIL — D1 mixed-EOL/bare-CR golden opens dirty (close+quit prompt) despite db31d3e's
  unit test; e2e AC-A5 never asserted dirty state. Everything else PASS in 3 themes (40 MB log opens ~1.1 s,
  +18–25 MB). Taste: WARN≈timestamp colour; prose "error" coloured. Sent back for root cause + e2e
  dirty assertion + T1 (muted timestamps) + T2 (level words only uppercase or level-shaped positions).
- NOT_COVERED by QA: visible-window FOUC (hidden window paints ~2 fps — same for pre-existing JSON/C#),
  C# with csharp-ls installed locally (covered by remote e2e csharp-lsp/csharp-lsp-idle).
