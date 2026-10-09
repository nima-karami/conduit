# Run report — language coverage (2026-10-08)

**Shipped: v0.47.1** (v0.47.0 tagged, unpublished — its release gate caught a panel-resize race, fixed in 0.47.1). Spec: [archive/2026-10-08-language-coverage.md](../../specs/archive/2026-10-08-language-coverage.md);
plan: [2026-10-08-language-coverage.plan.md](../../plans/2026-10-08-language-coverage.plan.md) (rev 2).

## What shipped

| Area | What | Evidence |
|---|---|---|
| Recognition | ~100 new names/extensions, prefix rules (`Dockerfile.*`, `.env.*`), shebang detection for plaintext-only names (host-side, ≤256 chars) | unit `lang`, `file-service`; QA r1 |
| Colouring | own grammars: TOML, Groovy, diff, Makefile, CMake, ignore; aliases dotenv→ini, ocaml→fsharp; 17 more Monaco grammars statically loaded; Review/plan/diff-viewer consumers | units on Monaco's real tokenizer; `grammar-linear` (50 ms budget + scaling ratio); e2e `language-coverage`; QA r1/r2 in 3 themes |
| Navigation | basedpyright, rust-analyzer, clangd via the generic registry; ADR 0006 amended | e2e `python-lsp`, `rust-lsp`, `clangd-lsp`, `lsp-trust-multi`, `lsp-missing-servers` |
| Residency | 2 heavy / 4 live caps, LRU eviction awaiting exit, 10 min dormancy, visible-only launch for every server, unsaved-text replay | 30+ fake-clock units; e2e `lsp-residency`, `-replay`, `-launch` |
| Edge cases | >2 MB / invalid-UTF-8 never synced (F12 explains); unterminated `$(` contained to its line; binary `#!` not sniffed | units; QA r1 |

**Gates on the release:** `npm run verify` exit 0 on 53a17e8 (release commit); full remote e2e 186 PASS /
8 EXCLUDED (pre-existing) / 0 FAIL / 0 FLAKY on 91eceec (run 37869659514). ff9b546 (CSS-only toast layout)
and the release/docs commits came after that run; the release workflow runs the full suite again.

**Performance measured (QA, hidden window):** 40 MB log opens in ~240 ms (last 2 MB); ~5 MB Cargo.lock
184 ms; 20k-line Makefile 159 ms, scroll stalls < 24 ms; worst grammar line ≤ ~38 ms for 20k hostile
chars; log separator lines 25 ms → 0.2 ms. Bundle +~25–30 KB total (budget 40 KB).

## Defects caught by gates other than green tests
- Review: diff `@@` compiled to a single `@` in Monarch; unterminated `$(`/`${` leaked to EOF; CMake O(n²);
  three e2e assertions that could not fail (AC-B4, AC-C3, AC-C5); an A→B→A visibility race; exec-bounded
  taskkill fan-out and orphan hang.
- Root cause behind the grammar bugs: a hand-written imitation of Monarch in the units. Replaced by the real
  tokenizer.
- Full remote run: two Go scenarios still assumed Python had no server; a sampler counted reused pids.
- QA: Groovy aliased to Java painted `'…'` strings as invalid.

## Decisions
User: Python/Rust/C++ first; clangd index on (-j=2); limits for all servers. Conductor: shared root watch
deferred (no measured force); eviction waits for process exit; diff bracket change reverted (no-op);
clangd hint Windows-only. All in `goal.md`.

## Follow-ups
- Java/Ruby/PHP/Kotlin/Swift/Lua/Bash/Zig navigation (deferred, reasons in spec).
- Shared recursive watch per root (deferred).
- Trust prompt lists every server's tools even in a one-language folder — consider listing present languages.
- Groovy slashy strings; nested Makefile `define`; Razor's embedded C# (Monaco grammar).
- Non-golden mixed-EOL files open dirty (pre-existing, from v0.46 run).
- A permission classifier denied a builder's `git merge` into its own worktree; integration was done by the
  conductor's normal merge-by-SHA instead.

## Learnings
`learnings-conductor.md` (+ inline lane bullets in `goal.md`).
