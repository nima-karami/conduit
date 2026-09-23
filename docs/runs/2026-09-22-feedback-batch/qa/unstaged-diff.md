# Runtime QA · Scoped diff tabs (staged / unstaged side of a file)

**When:** 2026-09-22
**Tier:** FULL. The change covers several surfaces (Changes panel, diff tab, Review, persistence) and a restart. It ships to 3 themes and reproduces a user-reported defect.
**Artifact:** desktop app (Electron), driven with Playwright-Electron through `test/e2e/harness.mjs` with `CONDUIT_E2E=1` (hidden window)
**Build under test:** conduit at `G:\awby\projects\conduit-wt-unstaged-diff`, `feat/unstaged-diff` @ `e8aec69`. The tree was clean. `npm run build` was run in the worktree through heavy.sh (EXIT=0).
**Build identity confirmed from the running artifact:** the app was launched from the worktree root (harness `REPO`). The running UI showed the `(Index)` / `(Working Tree)` titles and the `Open staged diff` / `Open unstaged diff` row tooltips, which exist only on this branch.
**Branch base note:** the merge-base with `main` is `3d56a24`, which is older than `main` HEAD `506854d` (the go-basics merge). This build does not include main's Go-files work, and it was not QA'd merged.
**Isolation:** one user-data dir per run and one temp git repo per run, both under `%TEMP%\claude-scratch\qa-unstaged-diff\`. There was no network port. Every app launch was serialised through heavy.sh.
**Configurations driven:** themes `aero`, `aero-dark` and `neon`, all driven, with the theme pre-seeded into `settings.json`. The functional pass ran on the default theme (aero-dark). Windows only.
**Teardown:** every app was closed through `closeApp`/`app.close`. No process with `qa-unstaged-diff` in its command line remains (checked by command line, not by image name). The scratch dir was deleted.

## Scope

The user reported: "if I have a file staged, the unstaged changes aren't visible; it always shows all the changes including both staged and unstaged". Acceptance criteria come from `docs/specs/2026-09-22-scoped-diff-tabs.md` §2, §4 and §7. I wrote an independent probe with my own fixture repo and helpers. I did not re-run the builder's `scoped-diff-tabs.e2e.mjs`.

The fixture held `MM`, `AM`, `MD`, `R`, untracked, an `MM` PNG, an `MM` binary, a real merge conflict (`UU`), and one file forced to become unmerged while its tab was open.

## Verdict

**Works, with 2 issues.** The user's complaint is fixed. Every spec criterion I reached was observed passing. I also observed two defects:

- a missing-highlight defect on `(Working Tree)` tabs;
- constant idle re-reading of open diff tabs, caused by a pre-existing host fsChanged loop.

Under this skill's rule, an observed defect on the surface under test means VERDICT `fail`.

## Criteria

Evidence paths are relative to `G:/awby/projects/conduit/.autoloop/evidence/`.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Staged row of an `MM` file opens `<name> (Index)` showing HEAD→index only | observed pass. Changed lines: `v2='QA_STAGED'` only. | `qa-unstaged-diff-main-02-mm-index.png` |
| 2 | Changes row opens `<name> (Working Tree)` showing index→worktree only | observed pass. Only `v18='QA_UNSTAGED'`; the left side contains the staged line as context. | `…-main-03-mm-worktree-both-tabs.png` |
| 3 | Both tabs open at once; clicking a row again focuses its tab rather than adding one | observed pass. Tab count unchanged on re-click. | `…-main-03` |
| 4 | Row tooltips: `Open staged diff` / `Open unstaged diff`; conflicted rows `Open diff` | observed pass | probe log (rows dump) |
| 5 | `AM`: Index = whole file added; Working Tree = only the post-stage edit | observed pass | `…-main-05-am-worktree.png` |
| 6 | `MD`: Index = staged change; Working Tree = whole index blob deleted | observed pass. Index added `mdStaged` only; WT modified side `''`, 10 lines removed. | `…-main-06-md-worktree-deleted.png` |
| 7 | Rename (`R old -> new`): Index shows `new` as a whole-file add | observed pass (as documented; no rename detection) | probe log |
| 8 | Untracked: `(Working Tree)` = whole file added | observed pass | probe log |
| 9 | Image: each scope shows its own two blobs | observed pass, visually. Index: red (HEAD) → green (index). WT: green → blue (worktree). Both badged "Modified". No hunk controls. | `…-main-07-img-index.png`, `…-main-08-img-worktree.png` |
| 10 | Binary: existing binary notice in both scopes | observed pass | `…-main-09-binary-index.png` |
| 11 | Conflicted row (real `UU`, in both groups) opens the unscoped tab | observed pass. Title exactly `cf.ts`. | `…-main-10-conflicted-row-unscoped.png` |
| 12 | Scoped tab that *becomes* unmerged shows the Conflicted notice, no controls bar, and **Open full diff** opens unscoped | observed pass. The watcher refreshed it without a git action. | `…-main-18-conflicted-notice.png` |
| 13 | Review card "Open side-by-side diff" opens at Review's scope | observed pass. All → `mm.ts` (both markers); Staged → `mm.ts (Index)`; Unstaged → `mm.ts (Working Tree)`. All three side-by-side (toggle reads "Inline view"). | `…-main-11-review-staged.png` |
| 14 | On-disk edit refreshes `(Working Tree)`: no `Loading diff…`, cursor kept | observed pass. Refreshed in 729 ms; cursor stayed on line 18; the **same** Monaco diff editor instance (tagged before the edit) was still mounted; MutationObserver saw 0 `Loading diff…`. | `…-main-12-edit-on-disk-refreshed.png` |
| 15 | Restart restores scoped tabs with scope, title and content | observed pass. All 12 scoped tabs came back in order; mm Index/WT content was correctly scoped, including the pre-restart on-disk edit. | `…-main-13-after-restart.png` |
| 16 | Ctrl+Shift+T reopens a closed `(Index)` tab with its scope | observed pass | probe log |
| 17 | Stage from Changes with both tabs open: WT shows `No unstaged changes in mm.ts.` and stays open; Index gains the hunks; no Loading flash | observed pass | `…-main-14-stage-wt-empty.png` |
| 18 | Unstage from Staged: Index shows `No staged changes in mm.ts.`; WT refills with all changes; no Loading flash | observed pass | `…-main-15-unstage-index-empty.png` |
| 19 | Discard (confirm dialog) with both tabs open: both show their empty notice and stay open | observed pass | `…-main-16-discard-confirm.png`, `…-main-17-discard-wt-empty.png` |
| 20 | Error state: `Couldn't read this diff.` + Retry | observed pass for render, persistence, live region and focus parking. See "What happened" for how it was induced. | `…-err-{aero,aero-dark,neon}-01-error-notice.png`, `-02-error-retry-focused.png` |
| 21 | Regression: unscoped diff from the Changes-row context menu is still HEAD→worktree, titled `mm.ts` | observed pass (both markers changed against HEAD) | `…-main-04-unscoped-ctxmenu.png` |
| 22 | Empty, conflicted and error notices look acceptable in all three themes | observed pass. Same `.viewer__notice` treatment as the existing binary notice: muted left-aligned line, compact action button, visible focus ring on Retry. Nothing clipped, overlapping or unstyled. | `…-theme-{aero,aero-dark,neon}-01-empty-notice.png`, `-02-conflicted-notice.png`, `-03-conflicted-notice-hover.png`, `…-diag-neon-02-baseline-binary-notice.png` |

## What happened

1. I built the worktree, then launched hidden on a fresh profile. I opened a session on the fixture repo and opened the Changes panel. Staged listed 9 rows and Changes listed 7. Rows are at `…-main-01-changes-panel.png`.
2. I drove criteria 1–13 and 21 in order. Each diff's content was read from the mounted Monaco diff editor's line changes per side, not from the page text.
3. **Relaunch scenario:** I closed the app with 12 scoped tabs open and relaunched on the same profile. All 12 came back with titles and scoped content. I then closed `mm.ts (Index)` and pressed Ctrl+Shift+T; it came back scoped.
4. With both mm tabs open in the relaunched app, I ran Stage, then Unstage, then Discard from the Changes panel (criteria 17–19). A MutationObserver on `.center` was armed before each action and recorded 0 `Loading diff…`.
5. **Becomes conflicted:** with `uc.ts (Index)` open, I wrote stage-1/2/3 entries with `git update-index --index-info` (status `UU`). The tab switched to the Conflicted notice on its own, with no controls bar. Open full diff opened the unscoped `uc.ts`.
6. **Error state.** The host catches every read failure internally (`readDiff` `.catch`es each blob and fs read), so I found no real way to make a read throw. I wrapped the main process's `webContents.send` so every `fileDiff` reply for `am.ts` carried `error` while a flag was set.
   - The notice rendered and persisted.
   - The polite live region held the text.
   - Clicking Retry while the reads still failed parked focus on the `.viewer__notice` div, not `<body>`.
   - After the flag was cleared, the tab recovered to the real diff on its own before my second Retry click landed, through the idle refresh loop (Finding 2). **Retry itself returning content was therefore not isolated.**
7. **Negative controls.**
   - The `am.ts (Index)` check that a scoped tab excludes worktree-only content was aimed at a state where it must hold, and it correctly passed. `modified` = staged text only, no `AM_LATER`.
   - A single injected error DTO, without the send wrapper, was overwritten within 108–305 ms by a real re-read. That shows the error assertion can observe both states.

## Findings

### 1. `(Working Tree)` tabs sometimes show the left (index) side without syntax highlighting (low, cosmetic)

- **Repro:** fresh session, open the `mm.ts` row under **Changes**. The left side renders as plain white text; the right side is highlighted.
- **Where it showed up:**
  - It happened 4 times across 2 files (`mm.ts`, `am.ts`) and 2 themes: `…-hl-01-hl-scoped-wt-fresh.png`, `…-main-03`, `…-main-20-fail-error-retry.png`, `…-theme-aero-04-error-notice.png`.
  - Every `(Index)` capture and every unscoped capture highlighted both sides: `…-main-02`, `…-hl-02`, `…-hl-03`, `…-main-04`.
  - Both models report `languageId` `typescript`.
  - After switching back to the WT tab (combined with an `ignoreTrimWhitespace` toggle, so the two are confounded), the left side was highlighted (`…-hl-04`).
- **Root cause not found.** I did not compare against a `main` build, so I can't say whether it predates this branch. It seems specific to the index→worktree scope.

### 2. Every open diff tab re-reads about 2.7 times a second while the app is idle (medium, CPU)

- **Repro:** open any repo and leave it idle.
  - The host emits `project` → `fsChanged` → `project`… about 2.8 times a second, with no diff tab open (28 of each in 10 s).
  - I saw it in both a merging repo and a plain one (`idle-plain`), so it doesn't depend on the merge state.
- **What this branch adds:** trigger (a) re-reads every open diff tab on each `fsChanged`. With 4 scoped tabs open and nothing changing, that was **106–112 `readDiff` replies in 10 s**, each running `git show`. It scales with the number of open diff tabs.
- **Visible side effects:**
  - The Error state heals itself within about 300 ms (step 6).
  - Diff tabs never sit idle.
- **Scope of the fix:** the loop itself is host behaviour this branch doesn't touch; the diff only changes `readDiffReply` in `electron/main.ts`. The branch turns a cheap loop into one that spawns git processes. The likely fix is in the host watcher, where the index write from Conduit's own `git status` shouldn't count as a change. The renderer could also skip re-reads when nothing changed, but that would be a band-aid. The owner should decide.
- **Evidence:** probe logs `idle.log` / `idle-plain.log`, summarised here (the scratch dir was deleted).

### Probe notes, not product defects

- My byte comparison of image blobs failed on the probe's own truncated capture of the image payload. The screenshots show the correct per-scope images (criterion 9).
- Two Retry clicks timed out because the idle loop had already replaced the Error notice. That's Finding 2's side effect, not a dead button.

## Not covered

- **Retry → real content, isolated.** Recovery was observed, but through the refresh loop, not through Retry alone (step 6).
- **Error state from a genuine host failure.** It was induced by rewriting host replies. No natural failure path was found, because the host catches every read error.
- **Palette Recents** carrying the scope and the `diff (Index)` subtitle. Not driven.
- **Trigger (e)**, `switchSession` refresh of another session's tabs. Also hunk-op trigger (c) from Review or the change peek, and bulk Stage all / Unstage all.
- **Whitespace-only side visibility** (`ignoreTrimWhitespace: false`).
- **Oversize** scoped diffs.
- **Linked-worktree index limit** (spec §4 known limit).
- **Keyboard operation of Changes rows** (spec v1, §13 D6).
- **The mock/preview shell's scoped `readDiff`** (L5). The browser preview was not driven.
- **"Explorer context menu":** the file tree has no diff item. The only "Open diff" menu entry is on the Changes row, and that is what was tested (criterion 21).
- **A `main` baseline** for Finding 1 and for the fsChanged loop.
- **macOS/Linux.**

## Learnings (process)

- `[runtime-qa]` A persistent failure can be induced by wrapping `webContents.send` in the main process through `app.evaluate`. It gives a stable Error state that a one-shot injected message doesn't, whenever something re-reads in the background.
- `[CLAUDE.md]` The host's idle `project`↔`fsChanged` churn (about 2.8/s) is worth an operational-gotchas line. Any feature that hangs work off `fsChanged` multiplies it, and it makes transient UI states unobservable in e2e.

---

# Round 2: re-verify after fixes

**When:** 2026-09-22/23
**Build under test:** conduit at `G:\awby\projects\conduit-wt-unstaged-diff`, `feat/unstaged-diff` @ `7c012a3`.
- The tree was clean. `main`'s go-basics is now merged in (merge-base `506854d`).
- The build (`npm run build`, run through heavy.sh) exited 0.
- The HEAD sha was re-checked after the usage-limit interruption; it was unchanged.

**Probe:** my own new probe, `probe.mjs` plus a pixel sampler `hl2*.mjs`, on fresh temp repos. The builder's e2e was not run, and no unrelated suites were run.
**Isolation and teardown:** as in round 1. There was one user-data dir per run, and every launch was hidden and serialised through heavy.sh. No `qa-unstaged-diff2` process remains (checked by command line). The scratch dir was deleted.
**Configurations:** themes aero, aero-dark and neon for the notices; aero and aero-dark for highlighting (the two themes where round 1 saw the defect); the default theme for everything else.

## Verdict

**Clean. Both round-1 defects are fixed as reported, and I saw no regressions.** The residuals below are low severity. One only reproduces with a hand-built index, and the other also shows on the unscoped tab.

## Criteria

Evidence is in `.autoloop/evidence/qa-unstaged-diff2-*`.

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | **Defect A.** Idle event rate in a dirty repo (`M`/`MM`/staged/unstaged), 10 s windows | **Fixed.** 0 `fsChanged`, 0 `project` and 0 `fileDiff` with **0 tabs** and with **4 scoped tabs**. Round 1: 28 `fsChanged` and 106–112 `fileDiff`. | probe log (`idle`, `idleu` runs) |
| R1a | Negative control: a real on-disk edit still triggers a refresh | Pass. One `fsChanged` → 4 `fileDiff` → `project`. | probe log |
| R1b | Real `git merge` conflict (`UU e.ts`), 4 scoped tabs, 10 s | Quiet: 0 events. It stayed quiet after resolving without concluding the merge. The recursive watcher saw one `.git` touch in the whole window. | probe log |
| R2 | **Defect B.** Original side painted plain | **Fixed as reported.** 78 pixel samples: 2 themes × 3 scoped openings × 5–6 rounds, plus an unscoped control. At **≥1 s** after open the original side was coloured in **every** sample; round 1 saw it plain at 2.5 s and later. Residual: see note 1. | `…-hl2-{aero,aero-dark}-0[1-4]-sample-*.png` |
| R3 | External `git add mm.ts` from a child process, with both mm tabs and the Changes panel open | Pass. WT → `No unstaged changes in mm.ts.`, Index gained the unstaged hunk, and the panel row moved. 0.5 s (run 1) and 2.4 s (run 2). | `…-ext-0*-ext-after-add.png` |
| R4 | External `git commit` | Pass. Index → `No staged changes in mm.ts.` and the Staged group emptied. 0.6 s / 3.8 s. | `…-ext-after-commit.png` |
| R5 | External `git checkout -- a.ts` | Pass. The `a.ts (Working Tree)` notice showed and the row disappeared. 0.6 s / 1.5 s. | `…-ext-after-checkout.png` |
| R6 | External `git stash` / `git stash pop` | Pass. Emptied, then refilled with `B_DIRTY` in both the tab and the panel. 0.5–0.8 s. | `…-ext-after-stash*.png` |
| R7 | No `Loading diff…` during any external or in-app refresh | Pass. 0 in both flows. The first open of a new tab is excluded, since a new tab legitimately loads. | probe log |
| R8 | In-app Stage / Unstage / Discard (with confirm) with both scoped tabs open | Pass. Empty notices showed, tabs stayed open and the other side refilled. | `…-ext-*-app-after-discard.png` |
| R9 | Review: All / Staged / Unstaged cards load | Pass. Every rendered card loaded, with no stuck `Loading diff…`. | `…-review-01..03-*.png` |
| R10 | Review hunk **Stage** on a 2-hunk file at Unstaged, then hunk **Unstage** at Staged | Pass. The card went from 2 hunks to 1. At Staged it showed that 1 hunk. After Unstage it dropped out. The open `h.ts (Working Tree)` tab followed both ops and ended with both hunks. | `…-review-04-review-after-hunk-stage.png` |
| R11 | Review read error | Pass. The card shows `Couldn't read this diff.` (no Retry on cards). | `…-review-05-review-error-card.png` |
| R12 | Notices with and without buttons, in aero / aero-dark / neon | Pass. The empty, Conflicted (+ Open full diff) and Error (+ Retry) notices all use `viewer__notice viewer__notice--stacked`. Text and button sit left-aligned, stacked, unclipped, with a visible focus ring. | `…-notices-{aero,aero-dark,neon}-0[1-5]-*.png` |
| R13 | Error state persists while reads keep failing | Pass. It was stable after 2 s in all 3 themes. Round 1 saw it heal within 300 ms because of defect A. | probe log |
| R14 | Retry focus | Pass in all 3 themes. Retry while still failing parks focus on `DIV.difftab`. Retry that succeeds leaves focus on `DIV.difftab` with the diff restored. | `…-notices-*-05-error-retry-focused.png`, `…-06-after-retry.png` |

## Notes and residuals

1. **Brief late colouring on open (low, cosmetic, not scope-specific).**
   - Some opens paint the original side plain for a fraction of a second before it colours.
   - In the finer run, samples were plain only at **150 ms**: aero-dark 3/12 WT, 2/6 Index, 1/6 unscoped; aero 6/12, 2/6, 1/6. None were plain at ≥250 ms.
   - The unscoped control shows it too, so it's Monaco's async tokenization, not this branch.
   - One exception, with the first diff opened in a fresh session: a DOM-metric pass captured at about 1.3 s showed the aero-dark original side plain (`…-hl-aero-dark-01-hl-0-mm.ts-Changes.png`) and **both** aero sides plain (`…-hl-aero-01-…`, a tokenizer warm-up).
   - Nothing stays plain. Round 1's "stays plain" defect didn't reproduce.
2. **Hand-built unmerged index still loops (low; not reproducible with a real merge).**
   - I made `uc.ts` unmerged with `git update-index --index-info` (stages 1/2/3, no stat data).
   - The host went back to about 2 `fsChanged` per second (19–20 per 10 s). With 4 scoped tabs open that meant 55–60 `fileDiff` per 10 s.
   - A real `git merge` conflict stayed at 0 (R1b), so ordinary users shouldn't hit this.
   - I didn't find the root cause. Outside the app, none of `status`, `diff --numstat` or `diff --numstat --cached` rewrote `.git/index`, with or without `GIT_OPTIONAL_LOCKS=0`.
3. **Probe errors caught and re-run, not product defects.**
   - My first highlight metric (DOM span classes) read 0 coloured spans on the modified side, which is visibly coloured, so I discarded it for the pixel sampler.
   - The first ext run counted each new tab's first `Loading diff…` as a flash; it was re-run with the first load excluded.
   - The first notices run clicked Retry after the tab had already recovered; the fix was a guarded click.
4. The Changes panel lists a `UU` file with an `M` badge in both groups. That was already true in round 1 and is outside this feature.

## Not covered (round 2)

- A `main`-build baseline for residual 1.
- The root cause of residual 2.
- Palette Recents keeping the scope.
- Refresh on session switch.
- Bulk Stage all / Unstage all.
- Whitespace-only and oversize scoped diffs.
- Linked-worktree index.
- Keyboard use of Changes rows.
- The preview/mock shell.
- An error from a genuine host failure (still induced by rewriting replies).
- macOS/Linux.

## Learnings (round 2)

- `[runtime-qa]` Monaco colour checks: DOM span classes were unreliable inside a diff editor. Cropping the side's `.view-lines` and counting saturated pixels worked, and the modified side is the built-in control.
- `[runtime-qa]` Exclude a new tab's first load from "no Loading flash" counters, or every open reads as a regression.
