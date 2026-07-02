# Run report — solidify & polish (2026-07-01)

> **RELEASED as v0.19.0** (2026-07-02). CI `verify` + `Release` both green; installer
> `Conduit-Setup-0.19.0.exe` (+ blockmap + `latest.yml`) published to the GitHub release.

Autonomous build-loop run. Goal: solidify Conduit (edge cases, subtle bugs,
underdeveloped flows) and polish the theming/UI, with the north star being **agent
visibility** — reading markdown, mermaid, PDF, and git diffs/history over editing.

> **Retrospective (round 1 stopped too early — ~2-3h of a 24h mandate):** The run
> satisficed. Root cause: I treated an emptied self-made queue as mission-complete,
> optimized for a tidy documented batch over maximal solidification, used "resource-
> mindful / don't-break-things" as cover to defer the hard items (blame, image-diff
> sync, theme-surface, refactors), misjudged budget (stopped at ~half of even a single
> ~5h session), and ran ONE shallow discovery sweep instead of deep per-subsystem
> investigation of real flows. **Round 2 (below)** corrects the operating model: living
> backlog refilled by repeated DEEP discovery; stop only at budget/genuine-solidity;
> bias to DO the hard work; parallelize disjoint subsystems; run simplify + architecture-
> critic on a cadence; auto-resume across the session cap. See `.autoloop/goal.md`.

Conductor: Opus 4.8 (in-session), delegated execution (Opus subagents build to spec
in isolated worktrees; conductor kept architecture + taste and ran all real-app
verification + screenshots). Base: `main` @ v0.18.0 (87dd1bb). All work landed on
`main`; **not released** (release is the user's call).

## Method

Three parallel read-only discovery passes (reading/visibility features, theming/UI,
edge-cases/robustness) built the queue. A recurring theme: **discovery over-flagged;
conductor verification shrank scope.** Several "critical" findings were already
handled or non-bugs — fixed only the real ones, invented nothing. Builds ran
sequentially (one feature → verify → merge) to keep the gate clean, since the
git-history integration test starves under concurrent subagent load.

## Shipped (merged to main, verified)

Every item: merged-tree `npm run verify` EXIT 0, plus a real-app e2e and/or a
conductor-reviewed screenshot. Test count grew 1888 → 1923.

1. **Robustness: bound unbounded host round-trips** — `fa50f1c` / merge `7e6ab66`.
   New `src/with-timeout.ts` primitive (5 unit tests). Terminal link provider no
   longer hangs if the host never replies (3 s timeout + `.catch` so xterm's callback
   always fires); content-search spinner clears via a 15 s watchdog instead of
   spinning forever. Fixes the one real HIGH finding (agent-3 #1).

2. **host-ipc-hardening — investigated, no real defects** — folded search-watchdog
   into `fa50f1c`. Verified each of agent-3's remaining findings against the code:
   `pathExists` try/catch already graceful; `windowId` already guarded by `if(!tw)`;
   pdf `recomputeCurrent` is loop-bounded; `readFile` returns in-band `.error` and
   never rejects (so `Promise.all` is safe); `commitDiff` captures cwd pre-await.
   None were bugs — no changes invented.

3. **Light-theme (Paper) legibility** — `8022d3d` / merge `9e1528c`. Bold markdown
   text was invisible white-on-white (`.md-p strong #fff`→`var(--text)`); the branch-
   filter and rename inputs fell back to a phantom `--vscode-input-background,#2a2a2a`
   that never exists in this app (→`var(--raise)`); accent buttons unified onto
   `var(--on-accent)`. Screenshots reviewed on Paper + midnight. **Downscoped from
   FULL** — see Deferred.

4. **Syntax highlighting in Review Changes diffs** — `6280a9c` / merge `e57ba45`
   (+ conductor fix `a38b7c5`). The primary agent-diff surface is now colored per
   language, reusing the app's existing highlight.js (no new dep) via pure
   `webview/syntax-highlight.ts` (11 unit tests); windowed rows only; one editor-
   matching `--syn-*` palette also adopted by markdown code blocks (replacing
   github-dark). e2e PASS; screenshots of the colored `.ts` diff + plain unknown-ext
   fallback reviewed. **Conductor caught a corruption units missed:** the subagent
   wrote the cache key with a literal NUL byte (source file was binary); fixed with a
   space separator.

5. **Find in rendered Markdown (Ctrl/Cmd+F)** — `627f561` / merge `4ffbfd7` (+ e2e
   fix `c0cda59`). Viewer-scoped find bar via the CSS Custom Highlight API (no DOM
   mutation), `n/total` count, Enter/Shift+Enter cycle+scroll, Esc clears. Pure
   `webview/md-find.ts` mirrors `pdf-find.ts` (14 unit tests). e2e PASS; find-bar
   screenshot reviewed. Conductor fixed the subagent's fragile `.termpane` scoping
   step (ambiguous + hidden) with a terminal-free owns-check.

6. **Export Mermaid diagram (SVG / PNG)** — `71d98ac` / merge `c245a60` (+ conductor
   fix `7361749`). Two overlay toolbar buttons; renderer-only download. Pure
   `webview/mermaid-export.ts` (5 unit tests). e2e PASS (captures the real exported
   SVG). Conductor fixed a synchronous `revokeObjectURL` that could abort the save.

## Post-batch code review (independent, `/code-review high`)

Ran an 8-angle review over the whole run's diff after shipping. No CLAUDE.md
convention violations (comments WHY-only, biome-ignores justified, no band-aids,
hardcoded colors replaced with tokens). Fixed (`7277a20`):
- **md-find offset corruption (real bug, single-viewer):** matching lowercased the
  haystack, but `toLowerCase()` isn't length-preserving (e.g. 'İ' U+0130 → 2 chars),
  so highlight offsets drifted. Now matches case-insensitively over the original text
  via a regex; reuses `escapeRegExp` (exported from content-search). +2 tests.
- **Terminal link timeout 3 s → 10 s:** a slow-but-successful resolve was falling back
  to plain text; the timeout only needs to bound the never-replies case.
- **Review `Line` memoized:** skip re-tokenizing every visible diff row on unrelated
  re-renders (the windowed hot path).

Deferred (in `.autoloop/blockers.md`): split-view markdown-find multi-viewer edge
cases (shared `CSS.highlights` keys, Ctrl+F opening both bars, ranges spanning excluded
subtrees — single-viewer flow is fine); find-controller/find-bar dedup with the PDF
viewer (touches out-of-scope PDF code); mermaid `%`-size fallback (mermaid always emits
a viewBox, unreachable).

7. **Collapsible Markdown outline** — `ca7092b`. Parent headings in the Outline panel
   get a chevron to fold their nested sections. Pure single-pass subtree hiding in
   md-toc.ts (6 unit tests); e2e PASS; outline screenshot reviewed. (Added mid-run as
   a low-risk reading-polish follow-up to markdown-search; image-diff sync-zoom and
   review-blame were passed over as higher-risk/bigger — see Not queued.)

## Deferred — product decision for the user (not auto-landed)

**Should the code editor + terminal SURFACE follow the active theme?** Today
`--code-bg`/`--term-bg` are a single dark default (the surface floats dark on the
animated backdrop on every theme — plausibly intentional). Making it theme-aware
(a light editor on Paper) needs a `surfaceColor:'auto'` sentinel (`src/settings.ts`
+ `webview/settings.tsx`), per-theme `--code-bg`, theme-aware Monaco, and a settings-
picker 'auto' state; it only reaches NEW installs (existing users have a concrete
persisted color). **Recommendation:** worth a follow-up run; default new installs to
'auto', keep a manual override. Reversible. Full design lives in
`docs/specs/archive/2026-07-01-theme-correctness.md`.

## needs-human-smoke

- **Mermaid export — actual OS file write.** Electron shows a native Save dialog for
  the blob download; native dialogs are invisible to the smoke harness, so the write
  itself can't be driven. The produced SVG blob + the UI are verified; only the OS
  save is unobserved. PNG rasterization (`canvas.toBlob`) likewise isn't unit-testable
  under node vitest — code-reviewed, SVG path fully verified.

## Not queued / dropped after verification

- PDF text selection (agent-1 #3) — **already implemented** (textLayer + getTextContent
  + `::selection`). Not a gap.
- Speculative theming rewrites (token-hierarchy, per-token color-picker UI, scrollbar
  settings, border-radius/shadow tokenization) — high churn, low value, taste-risk.
  Explicitly out of scope; theme work kept to correctness.
- Remaining candidates for a future run: collapsible markdown TOC tree; image-diff
  synchronized zoom; review blame attribution; palette "Compare changes" entry;
  tab-scroll v1 kinds (image/pdf/commit-diff scroll, restart-persist).

## Lessons / gotchas

- **Verify discovery claims before building.** ~6 of the flagged "bugs" were already
  handled; the theming "Monaco broken on light theme" was aesthetic, not a legibility
  bug (surface is dark by design). Saved a large speculative refactor.
- **Subagent-written source can be corrupt in ways units pass.** A literal NUL byte
  made a `.ts` file binary yet biome/tsc/vitest stayed green; caught via `git`'s "Bin"
  flag on merge. Now warn every build subagent against literal control bytes and
  spot-check `file <path>`.
- **Native dialogs remain unobservable** ([[playwright-cannot-drive-native-dialogs]]);
  the mermaid e2e verifies the export blob through the real path with a neutralized
  anchor click instead of `waitForEvent('download')`.
- **Never run `npm run verify` under concurrent subagent load** — the git-history
  integration test spawns real git and returns 0 commits when starved (also by
  orphaned e2e electrons). Passes clean in isolation; re-run when idle.
- Worktrees under `.claude/worktrees` (gitignored) with a junctioned `node_modules`;
  never repo-internal `.worktrees/` (breaks `biome check .`).
