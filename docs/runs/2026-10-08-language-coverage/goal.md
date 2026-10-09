# Goal — language coverage (2026-10-08)

**Outcome:** the well-known languages and config formats are recognised and coloured (incl. by filename
and shebang); Python, Rust and C/C++ get Go-parity navigation; language servers are bounded in count and
memory and sleep when nothing visible needs them. Spec: docs/specs/archive/2026-10-08-language-coverage.md (FULL).

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
- Lane B merged by SHA 92e70e9 → 527a8ba. Lane C told to merge 92e70e9.
- Lane A review REQUEST_CHANGES (2 blockers: diff `@@` = literal `@` in Monarch; unterminated `$(`/`${` leaks to EOF).
  Root cause: hand-written Monarch runner diverged from Monaco — units must run on real monarchCompile/MonarchTokenizer.
- Lane C built eb85672 (merged 92e70e9 clean; lane B nits 1+2 fixed). Accepted its design calls: trust with all docs hidden → stopped; request-woken launch dropped if request gives up before resolve (requests come from visible docs in practice). No RSS numbers (remote keeps logs only on failure; servers not installed locally).
- Lane A fixed review (23486a6): real Monarch in units; log grammar perf sent back (not deferred).
- Lane C review REQUEST_CHANGES: blocker AC-C3 replay e2e can't fail (in-place rename); lsp-sync A→B→A dedup race;
  exec-bounded fan-out + orphan hang. Ratified unplanned files (exec-bounded.ts, bridge.ts line).
  Conductor decision: every stop path keeps a record in the budget until its process exits.
- Lane C fixes 127867e (verify 0; remote 37861862146 + 37862759060). Lane A fixes 84c97e6 (log 25 ms→0.2 ms; remote 37862334081). Both in re-review.
- All lanes merged by SHA (S0 e85177c+6fce54f, B 92e70e9, C 9d19d22, A d62a142) → ded8fcc. Full verify exit 0.
- Full remote e2e on ded8fcc (run 37863920675): 183 PASS / 8 EXCLUDED / 2 FAIL (go-files, goto-matrix-feedback,
  both attempts) / 1 FLAKY (lsp-residency); verify job success. Neither failing scenario was in a lane's remote
  list — likely D7 fallout. Root-cause diagnosis dispatched (branch fix-cov-e2e). Release blocked.
- Runtime QA on 6439f41: FAIL on D1 — groovy→java alias paints '…' strings as invalid char literals. All other
  checks PASS (recognition, edge cases, unterminated `$(` typed, missing-server UX, Go background tab, 40 MB log
  243 ms, 5 MB TOML 184 ms, 20k-line Makefile). Fix lane fix-cov-qa: real Groovy grammar; Makefile define bodies;
  bracket colorization off for diff (conductor taste call); install toasts showing literal backticks.
  Not fixed (recorded): Razor C# colouring (Monaco's own grammar); trust prompt lists all 5 toolsets (spec).
- e2e regressions root-caused (no product bug): go-files + goto-matrix-feedback assumed Python unserved (D1 changed it) → Ruby; lsp-residency flake = sampler pid reuse → pid+creation time. Merged 1480f68 (remote 37866063564 PASS).
- fix-cov-qa: Groovy grammar, Makefile define, diff bracket colours off, install-hint code element (4aeb351). Builder's `git merge 774ee8aa` into its worktree was DENIED by the permission classifier — not re-run on its behalf; conductor reviews the lane SHA and integrates via the normal merge into feat, updating go-files expectation there.
- QA r2 on 91eceec: PASS (Groovy, define, install-hint code element, toasts; diff 'rainbow brackets' was a pre-tokenization screenshot, not real). Taste: .toast__code on its own line.
- RELEASE v0.47.0: release commit 53a17e8 verify 0; full remote e2e 186/0 on 91eceec. Report: report.md.
- v0.47.0 release workflow 37871312170 FAILED gate: tree-chevrons-neon AC7 'narrow Files tag clipped' both attempts (passed on 91eceec). Release NOT published. Root-cause diagnosis dispatched (branch fix-chevrons).
- tree-chevrons-neon diagnosed: FLAKE caused by a real product bug — every host `state` broadcast re-hydrates
  settings with a new object → applyToDom rewrites `--right-w` (panel snaps back mid-drag). Re-runs at 4b561b2a and
  91eceec pass (37872727103, 37872750858). Conductor decision: do not re-run the gate to green; fix the source
  (fix-hydrate) and release v0.47.1; v0.47.0 tag stays unpublished.
- v0.47.1: hydrate fix da147e7/2223445/3e8caea (review APPROVE; verify 0; remote 37873945580 + 37875208163). ff main. Not covered: review-mode-pane, split-editor-focus-keep (remote-excluded, need OS focus — not run locally to avoid visible windows); no e2e drags the resize handle (units only).
- RELEASED v0.47.1 (4f930e9, release run 37876053125). v0.47.0 tag unpublished.
