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

## Round 2 (deep solidify — corrected operating model)

After the retro, re-ran with 6 deep per-subsystem investigators (traced real flows, ~20
concrete tasks with repros) and a living backlog. Shipped to `main` (pushed; not released):

**Wave 1** (`b265d0f`, verify 1955):
- Shortcuts parity (`90fc9ad`): palette shows key combos; Ctrl+PgUp/PgDn tab switch;
  Ctrl+Shift+G history; Ctrl+Shift+T reopen-closed-tab; built-in nav rows in the cheat-sheet.
- Terminal URL links (`1c189fc`): http(s)/file URLs in the terminal are clickable → open
  externally (reuses the scheme-allowlisted `openExternal`; 18 unit cases).
- Theming Paper legibility (`f32fac3`): **fixed the white-on-white Review-diff regression I
  shipped round 1** (diff body now on the dark code surface) + darkened status palette for
  paper + `--overlay`/`--success/--danger/--yellow` tokens + Monaco selection = theme accent.
  Screenshot-confirmed on Paper (e2e `theming-paper`).

**Wave 2** (`76d1723`, verify 1964):
- git CRLF (`7ccc7aab`): Review/diff no longer show every line changed on autocrlf repos.
- git rename (`cb3f43de`): renamed files show their real diff, not a 100% add.
- session restore-off data-loss (`3d3c383` + `f4dbe60`): turning "reopen previous sessions"
  off no longer wipes the saved list — and (caught by the 4-launch e2e, strengthened `f4dbe60`)
  a mid-session re-enable + quit no longer wipes it either (gate snapshots startup state).

**INCIDENT (recovered):** during a worktree teardown, `git worktree remove --force` did
`rm -rf` through a node_modules **junction**, partially deleting the main checkout's
node_modules (stopped at locked electron DLLs). Fix: killed orphaned electrons, `npm install`
restored it. Lesson (in `.autoloop/blockers.md`): future worktrees do NOT junction node_modules
— walk-up resolves to main; teardown is then safe.

**Wave 3** (verify 1972):
- git BLAME (`7d9d2dd`/merge `8486ed4`): line-level blame lens in the code viewer — active-line
  `author, <relative time> · <summary>`, click → that commit in Review. Host-validated
  `git blame --porcelain`; pure parser (8 tests); e2e + screenshot confirmed. The north-star
  "who/why changed this line" the user asked for.
- explorer virtualization: **BUILT then REVERTED** (`cb62f9f`). Windowing broke search-reveal
  (the revealed row wasn't mounted → no highlight; `explorer.e2e.mjs` failed, passes pre-change).
  Two targeted fixes (pin the revealed row; honor pins when the viewport is unmeasured) didn't
  fully resolve it — a perf-only feature must not ship a correctness regression, so reverted and
  re-queued `blocked` with a debug plan (`.autoloop/tasks.yaml`). The other 4 explorer e2e
  (DnD/gitignore/icons/multiselect) passed with windowing — only reveal broke. Surfaced ONLY by
  driving the real app (units + sibling e2e were green) — the corrected verification working.

**Wave 4** (verify 1995):
- git-based **quick-open** (`3aace24`): Mod+P now lists the full git corpus (uncapped, gitignore-
  respecting) via `projectFileIndex` instead of a 4000-file BFS cap that surfaced gitignored trees.
  Native-separator abs paths kept so reveal-in-explorer still matches. e2e PASS (>4000 + vendor/ excluded).
- **word-level diff** in Review (`e5d9b23`): a one-token edit emphasizes only the changed token
  (`.rline__word`) on both rows, composing UNDER the syntax highlighting (keeps hljs colors + tint).
  Token-LCS, 47 tests; e2e + screenshot confirmed.

**Wave 5** (verify 2003):
- **worktree-aware link/commit resolution** (`6913287`) — the bug you raised. Terminal path AND
  commit tokens now resolve against ONE root derived from the session's live cwd (`sessionGitRoot`
  = rev-parse of activeCwd), not the UI-pinned active repo — so a printed commit in a multi-repo
  workspace links to the RIGHT repo, and clicking it opens Review scoped to that repo. Fish gets
  cwd injection too. 86 unit tests. Full multi-repo+cwd e2e is `needs-human-smoke` (multi-repo
  scan + OSC cwd-tracking are flaky in the hidden harness; the resolution logic is unit-verified).
- **NUL-byte hygiene** (`1a513e1`) — replaced two *pre-existing* stray literal NUL bytes in source
  (`open-file-watcher.ts`, `conduit-specs.test.ts`) with the `\0` escape; both were binary `.ts`.

**Wave 6** (verify 2014):
- **non-blocking content search** (`105a450`): the walk was synchronous on the main process (froze
  IPC/PTY/all windows up to 2s/query). Now async-yielding (setImmediate every 200 files, no worker/
  dep), stat-gated reads (no whole-file slurp), per-root generation cancellation of superseded
  queries. 38 tests. (.gitignore-seeding deferred.)
- **git-history error-state + search** (`4747c29`): `getHistory` 3-state (ok/empty/error via git
  exit codes) makes the error+retry UI reachable (a git failure no longer looks like an empty repo);
  load-more works while filtered; an append never wipes loaded rows. 44 tests.

**External PRs reviewed** (comments posted, humanized, not merged — maintainer's call): #1
unix-login-shells (approve; guard the `$SHELL` fallback against dash/sh), #2 macOS traffic lights
(approve; needs a human macOS smoke).

**Wave 7** (verify 2022):
- **session stale hygiene** (`2acc51b`): "Close all stale sessions" (palette + sidebar, running
  untouched) + a startup scrollback-orphan sweep. Renamed `staleRelaunchTargets`→`staleSessionIds`
  (no dup). 23 tests.

**Wave 8** (verify 2035) — reading viewers, from a fresh deep audit:
- **markdown relative images** (`6072e6c`) — the north-star blocker: an agent embedding
  `![](./out/chart.png)` in a report now renders the image (new `md:image` IPC → data URL; missing →
  "Image not found" affordance). e2e + screenshot. The fallow gate caught the subagent's phantom
  transitive deps (hast) in the test → rewrote it to assert on the schema directly.
- **PDF text-layer alignment + first-paint** (`381bee3`): applied the (correctly-derived) glyph
  scaleX so selection/find highlight sit on the text; large PDFs paint after page 1 instead of a
  sequential all-pages scan. pdf-viewer e2e green.

**Wave 9** (verify 2042):
- **gitignore-aware content search** (`1d776ab`): search now drives from the git file set
  (projectFileIndex) so vendored/build trees don't surface matches; non-git fallback preserved;
  caps/cancellation/globs shared via one `visit()`. Completes the async-search work.
- **viewer empty-states** (`197f624`): empty markdown → "Empty document", empty ```mermaid →
  "Empty diagram" (not a red error). BONUS: confirmed + fixed a real **mermaid orphan-node leak**
  (render() throws before its temp-cleanup on parse error; unmount-after-error leaked permanently).

**Wave 10** (verify 2047):
- **image-diff synchronized zoom** (`d77928e`): side-by-side zoom/pan/rotation now linked so you
  can pixel-compare an agent's image edit. Additive `shared` option on usePanZoomStage (default
  path untouched → mermaid overlay + standalone viewer unaffected). Round-1 deferral, finally shipped.
- **markdown remote-image click-to-load** (`65b0bd2`): remote `http(s)` images render behind a
  "Load image from <host>" chip instead of auto-fetching (tracking-pixel privacy); data:/local eager.

**Post-round-2 consolidation review** (3 agents: correctness / integration / cleanup) over the full
`v0.19.0..HEAD` diff (44 files, ~2000 lines) — the user asked to periodically simplify/review. Code
judged "unusually clean" (no band-aids, WHY-only comments, reuse correct). Real findings FIXED
(one commit):
- **[HIGH data-loss, my regression]** the wave-7 scrollback orphan-sweep deleted ALL scrollback when
  `restoreSessions` is off (empty manager → everything looks orphaned) — undermining the wave-2
  data-loss fix. Now gated on the same restore setting (don't sweep when restore is off).
- **[HIGH hardening]** `md:image` read arbitrary on-disk images with no root check, now content-
  triggered by opening a doc. Confined to the open workspace roots (fails closed to broken-image).
- **[MEDIUM, my regression]** git-history: a transient auto-refresh/paging error wiped the loaded
  commit graph to the error screen (and an errored Load-more hid the button). Reducer now preserves
  loaded commits + hasMore on a transient error; only shows the error screen when nothing was loaded.
- **[MEDIUM]** `git:blame` resolved against the pinned repo, so blame failed for a file in another
  repo — now resolves from the file's own directory.
- **[LOW]** preview fake-shell now replies to `git:blame` (was a silent no-op); removed a redundant
  URL-span seed in the terminal link provider (commit/path tokens are already URL-filtered upstream).
Deferred follow-ups (LOW, documented): blame lens→Review opens the pinned repo in split-view multi-
repo (thread the blamed file's root through the click); image-diff linked fit picks the last-mounted
side's fit for unequal-size images (self-corrects on interaction).

Backlog remaining (living, in `.autoloop/tasks.yaml`): pdf rotation, viewer error-branch cleanup,
explorer-virt retry (debug reveal mounting first), zsh/agent cwd tracking, history host-side search.
Product decisions for the user: surface-follows-theme; session relaunch-clarity (a relaunched agent
session looks live but is a fresh process).

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
