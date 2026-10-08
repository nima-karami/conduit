# Lane B learnings (C# via csharp-ls)

- [instruction-file] Windows PowerShell 5.1 `Get-Content -Raw` reads a BOM-less UTF-8 file as
  ANSI; writing it back mojibakes every `—`/`§`/`→` (it hit `src/lsp-registry.ts`,
  `src/lsp-root.ts` and two test files during a mutation check). Use the Edit tool, or
  `-Encoding utf8`, for any read-modify-write — worth a CLAUDE.md line beside the temp-path rule.
- [docs/specs/2026-10-08-language-support.md] The spec asked one `csharp-lsp` scenario to hold B3
  (180 s ready ceiling) and B4 (60 s idle + 10 s); the harness kills any scenario at 200 s. A spec
  AC that waits on a timer should be checked against `DEADLINE_MS` when it is written.
- [none] csharp-ls 0.28.0 targets net10.0 only (measured from the nupkg's runtimeconfig), so "the
  runner's preinstalled SDK" was the wrong axis for D1 — pinning the SDK with setup-dotnet, as
  setup-go does for gopls, makes B3/B4 gate instead of becoming exclusions.
- [none] Known limitation, accepted unfixed by the lane-B review (finding N4): see the review
  record for its text; the builder's fix brief did not restate it.
