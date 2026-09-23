# Runtime QA · Editor navigation history (Back/Forward)

**When:** 2026-09-22
**Tier:** FULL. The change spans the top bar, editor, sessions, tabs, center view and multiple windows, with a theme matrix and a reported defect to reproduce.
**Artifact:** desktop app (Electron, dev build from `out/`)
**Build under test:** conduit at `G:\awby\projects\conduit-wt-nav-history`, `feat/nav-history` @ `42ed3f0`, clean tree. `node_modules` is a junction to the main checkout and nothing was installed.
**Build identity confirmed from the running artifact:** `npm run build` ran in the worktree through heavy.sh (EXIT=0). The harness was imported from the worktree, so `REPO` and the launched app were the worktree's `out/`. The running app announced `Editor: <file>, line <n>` in the live region, a string that exists only in this build (the old build announced `Terminal: …`).
**Environment:** Playwright-Electron through `test/e2e/harness.mjs` `launchApp`, with `CONDUIT_E2E=1` so the windows were hidden. There were 6 app launches, serialised through heavy.sh. No ports were involved.
**Isolation:** each launch used a throwaway `--user-data-dir` (`%TEMP%\conduit-ud-*`, from the harness) and its own temp TS project (`%TEMP%\qa-navhist-*`: tsconfig plus `a/b/c/d/e/z/x1/x2.ts`, where `a.ts:12` calls `helperB` from `b.ts:40`, `b.ts:41` calls `helperC` from `c.ts:30`, `c.ts:31` calls the same-file `localFn` at `c.ts:100`, and `d.ts:70` holds a search needle). The relaunch reused its own profile.
**Configurations driven:** themes Aero, Aero Dark and Neon (driven). Platform: win32 only.
**Teardown:** every app was closed through the harness `cleanup()` (pid-scoped). No process was killed by name. The scratch dir `%TEMP%\claude-scratch\qa-nav-history\` and the `qa-navhist-*` projects were deleted. Harness `conduit-ud-*` profile dirs stay in OS temp, as the harness does by convention.

## Scope

The user reported: "the back/forward navigation doesn't seem to work, it seems to switch windows, not where I have navigated so far in code". The spec is `docs/specs/2026-09-22-editor-nav-history.md` (§2, §4 and §7 AC1–AC15). I wrote an independent probe rather than re-running the builder's `editor-nav-history*.e2e.mjs`. It drives a developer's reading path: F12 twice, Ctrl+click within a file, Ctrl+End, a search hit, a tab click, a session switch and the Terminal tab, then Back all the way and Forward all the way. At every step it records the active tab, cursor line (and whether that line is on screen), active session, Back/Forward `disabled`, focus and the live-region text. It then covers every input and the lifecycle edges. Themes in scope: all three.

## Verdict

**Clean.** The user's complaint is fixed. Every in-scope criterion I drove was observed working. I found no defects, only three low-severity UX observations.

## Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| User complaint | Back walks code positions, not sessions/terminals | observed pass. The walk visits a:1 → a:12 → b:41 → c:31 → c:100 → c:151 → d:70 → a:12 → e.ts(S2). No stop lands on a terminal, and the session switch adds no stop | walk log B01–B08, F01–F08; `qa-nav-history-02-walk-tip-terminal.png`, `-03-walk-bottom.png` |
| AC1 | F12 a:12 → b:40; Back → a:12 visible; Forward → b:40 | observed pass | walk 03/B07; life A1–A4 |
| AC2 | Same-file jump >10 lines undoable (Ctrl+End, Ctrl+click, Ctrl+G) | observed pass. Undone: c:100→c:151 (Ctrl+End), c:31→c:100 (Ctrl+click), x2:49→x2:95 (Ctrl+G) | walk B03–B05; life D1–D3 |
| AC3/AC9 | Session switch is not an entry; a cross-session entry switches session | observed pass. S1 e.ts → switch to S2 (no entry) → open z.ts; Back → S1/e.ts; Forward → S2/z.ts | life G1–G5; walk 09/B01 |
| AC4 | Terminal tab is not an entry | observed pass. Back from S2's Terminal tab → a.ts; Ctrl+Tab through the Terminal stop records nothing | walk 11/B01; k K5–K8 |
| AC5/AC6 | Small moves and arrows don't record | observed pass. ArrowDown ×20, a click Δ≤10, typing, 15× Enter, a 30-line insert and 60× Ctrl+Z (cursor 49→29→49) added no entries. One Back from x2 went straight to b:40 | life C1–C5 |
| AC7 | Closed file reopens as a preview at its line | observed pass. a.ts was closed; Back reopened it as a preview tab (`tab--preview`) at line 12, visible | life A3; `qa-nav-history-04-closed-file-reopened-preview.png` |
| AC8 | Deleted file skipped | observed pass. x1.ts was closed and unlinked; Back from x2 → b:40; Forward → x2 | life B1–B3 |
| AC10 | Dead session skipped | observed pass. After S2 was killed (gone from the sidebar), an 11-step Back walk and a 10-step Forward walk never landed in S2, and Forward showed disabled at once | life H1–H3 |
| AC11 | Applying never records | observed pass. Walking Back ×8 then Forward ×8 reproduced the identical stack, and the input matrix stepped exactly one entry per press | walk B/F/IN rows |
| AC12 | Rapid presses | observed pass. 3× Alt+Left with no awaits went e → d → c → a:12, and Alt+Right → c.ts (nothing skipped). 3 concurrent app-command `browser-backward` calls went e → b exactly | win K2–K3; k K2–K3 |
| AC13 | Every input | observed pass for all of these: top-bar button, Alt+Left/Right with the editor focused, Alt+Left with the explorer tree focused, palette "Go back"/"Go forward", and the Windows `app-command` host path. Each moved exactly one entry. The buttons were disabled at launch, both enabled mid-stack, and Forward disabled at the tip | walk IN-back/IN-fwd rows; `-12-launch-both-disabled.png` |
| AC14 | Back from Board/Canvas shows the editor | observed pass. Board then Back → editor view with b:40. Canvas then Forward → editor view with b:12 | life F1–F3; `-06-board-before-back.png`, `-07-canvas-before-back.png`, `-08-after-forward-from-canvas.png` |
| AC15 | Terminal focus: Alt+Arrow ignored; the top-bar Back works and focuses the editor; announcement | observed pass. With xterm focused, Alt+Left/Right did nothing and focus stayed in the terminal. The top-bar Back → d:70 with focus in the editor. The live region read `Editor: d.ts, line 70` (and `Editor: a.ts, line 12` etc. at other steps) | walk T0–T3 |
| R2 | Peek/references pick records; peek-definition does not | observed pass. Same-file refs pick c:31→c:100, then Back → c:31. Cross-file refs pick b:40→a:12, then Back → b:40. Alt+F12 peek plus a >10-line move inside the peek's embedded editor recorded nothing (Back went straight to b:40) | life E1a–E1d; win E2a–E3d; `-05-peek-references.png`, `-13-peek-refs-crossfile.png` |
| R1 | Tab click, Ctrl+Tab, Ctrl+digit, quick open, search hit record | observed pass | walk 07–08; k K5–K12 |
| Per window | A new window and a torn-out window start empty and stay independent | observed pass. Window 2 started with both buttons disabled and built its own history; window 1 was untouched by window 2's Alt+Left. An `app-command` emitted on window 1 moved only window 1. After "Move session to new window", window 1 had both buttons disabled and the torn-out window started empty (one entry, still disabled) | win M1–M4, N1–N4; `-14-window2-fresh.png`, `-15-torn-out-window.png` |
| Relaunch | History not persisted; launch restore records nothing | observed pass. On relaunch with the same profile, 5 tabs were restored and Back/Forward were both disabled | life J1; `-11-relaunch.png` |
| Themes | Button states render in every theme | observed. In Aero, Aero Dark and Neon the button renders enabled at mid-stack, and Forward renders dimmed at the tip | `-09-theme-{aero,aero-dark,neon}-both-enabled.png`, `-10-theme-*-forward-disabled.png` |

## What happened

1. Launch, then the S1/S2 sessions: Back and Forward both disabled.
2. Open a.ts from the tree and click `helperB`@12: one entry, a:1 → a:12 (a Δ11 click is R3).
3. F12 lands on b:40. A click on `helperC`@41 coalesced (Δ1). F12 lands on c:30, and the Δ1 click to 31 coalesced.
4. Ctrl+click `localFn` lands on c:100. Ctrl+End lands on c:151. The search hit lands on d:70.
5. Click the a.ts tab. Switch to S2 in the sidebar. Open e.ts in S2. Click S2's Terminal tab.
6. Back ×8 (button): a:12(S1), d:70, c:151, c:100, c:31, b:41, a:12, a:1. Back went disabled at the bottom. Every step switched to the right session and tab, put the cursor on the right line with the line on screen, and moved focus to the editor.
7. Forward ×8 retraced the same path to e.ts(S2), and Forward went disabled.
8. Input matrix, one step each: button, Alt+Left (editor), Alt+Left (explorer), palette, app-command. Then Forward by button, Alt+Right, palette and app-command. All moved exactly one entry.
9. Terminal focus: Alt+Arrows were no-ops. The top-bar Back navigated and focused the editor.

The full per-step rows (tab, line, visible, session, button states, focus, live text, open tabs) were in the probe's `walk/life/win/k.jsonl`. The key rows are quoted above. The scratch dir was deleted at teardown per instructions.

**Negative scenario:** a deleted file (skipped), a killed session (skipped, never landed in), terminal-focused Alt+Arrows (ignored), and an open palette swallowing app-command: on the first probe run, Back while the palette was open did nothing, which is the modal guard.
**Relaunch scenario:** close, then relaunch against the same user-data dir. Tabs were restored, history was empty, and both buttons were disabled.
**Negative controls:** the probe's expectation check is live. When one of my own expectations was wrong (F3 expected a.ts, because an earlier step of mine had failed and left b:12 as the tip), it reported `MISMATCH tab: want a.ts, got b.ts`. The observed b:12 was the correct tip. I did not run the probe against the pre-change build. The builder's red-first commit `489afc7` is the baseline for that.

## Findings

No defects. Three low-severity UX observations. All three follow the spec as written, so none is a regression:

### 1. Back from a Terminal tab skips the doc you last had open in that session

**Severity:** cosmetic / expectation
Repro:
1. In S2, open e.ts.
2. Click S2's Terminal tab.
3. Press Back.

You land on the previous entry (a.ts in S1), not on e.ts. The index sits on e.ts, and per spec F3 the terminal has no "from" side. A user who reads the terminal and then presses Back may expect e.ts. (walk 11 → B01)

### 2. A Back press can look dead after a session dies

**Severity:** cosmetic
After S2 was killed, the first Back landed on e.ts, which was already active, so nothing visibly changed. Spec §4 allows this ("Apply lands on the same doc … still counts as a step"). (life H1 → H2.1)

### 3. The announcement drops the line number for a doc entry left through a session switch

**Severity:** cosmetic (screen-reader)
B01 announced `Editor: a.ts`, not `…, line 12`, although the cursor was restored to 12. That entry was left by a session switch, which records nothing, so it never got a `pos` (spec §2.2 "to" rule).

## What worked

Everything in the Criteria table: cursor line restore with the line visible, cross-session apply, reopening a closed file as a preview, skipping deleted files and dead sessions, all input paths, the terminal-focus guard, center view restored from Board/Canvas, per-window isolation including a torn-out session, no persistence on relaunch, and all three themes.

## Not covered

- **Physical X1/X2 thumb buttons and the OS delivery of `app-command`.** Only the host→renderer path was driven, by emitting on the BrowserWindow. Needs a human.
- **Non-Windows `auxclick` button-3/4 path.** The machine is win32 and the path is gated off there.
- **Breadcrumb symbol jump, Go to Type Definition and Go to Implementation** as R2 producers. They were not driven, only F12, Ctrl+click and the peek/references pick.
- **Non-file doc entries:** diff, review, web, git-history, commit-diff (including the preview retarget), image/PDF/rendered-markdown/plan entries, and the terminal-link and md-link producers.
- **The 50-entry cap and eviction, and the exact Δ10/Δ11 R4 boundary.** Unit-level only; not driven in the app.
- **A renamed file (A6), and clamping a `pos` past EOF after edits (A4).**
- **Visual baseline.** The spec adds no new visuals ("existing quiet-role ladder"), so I captured the button states per theme but made no side-by-side comparison against a pre-change build.
- **The negative control against the pre-change build.** Not re-run; see `489afc7`.

## Environment faults

- In a hidden window, `page.screenshot` with a `clip` timed out twice (launch shot). Full-window screenshots worked, so all evidence is full-window.
- A file's first open sometimes paints without TS syntax colours for a few seconds (measured: `mtk1` only at +2 s, full tokens at +5 s). This happened for a tree open and for a Back reopen alike, so it is not caused by nav history. It is probably lazy tokenization throttled in a hidden window (`-04-…png`, `-16-reopened-tokenization-check.png`).

## Artifacts

- `G:/awby/projects/conduit/.autoloop/evidence/qa-nav-history-*.png`: 19 full-window captures, numbered 02–16 in order of occurrence (09/10 have one capture per theme). The 01 launch capture failed; see Environment faults.

---

# Round 2 (2026-09-23)

**Build under test:** `feat/nav-history` @ `fd5bf0a`, clean tree. The worktree was rebuilt with `npm run build` through heavy.sh, and `rev-parse` inside the same heavy run printed `fd5bf0a`. An earlier partial pass ran on `f0adcb4` and was cut off. Its burst results matched `fd5bf0a` exactly, and every result below is from `fd5bf0a`.
**How:** my own probe. There were 7 hidden launches, each with its own throwaway profile and temp TS project, serialised through heavy.sh. I ran no unrelated suites.
**Teardown:** every app was closed through the harness `cleanup()` (pid-scoped). The scratch dir `qa-nav-history2` and the `qa-navhist2-*` projects were deleted.

## Verdict (round 2)

**Works, with 1 issue.** Rapid Back/Forward presses sometimes skip history entries. A press can move past two or more entries, most often skipping the other stops in a file it just landed in. Everything else the round-2 fixes touch was observed working.

## Round-2 criteria

| # | Check | Result | Evidence |
|---|---|---|---|
| R2-1 | Re-drive the round-1 reading path end to end, one press at a time | **pass**. Back ×9 went Terminal → S2/e.ts:1 → a:12 → d:70 → c:151 → c:100 → c:31 → b:41 → a:12 → a:1. Forward ×8 went back to e.ts. Every step had the right session, tab, line and live text, with focus in the editor | `qa-nav-history2-01-tip-on-terminal.png`, `-02-bottom.png`, `-03-tip.png` |
| R2-2 | Back from the Terminal tab lands on the current entry first | **pass**. With S2's Terminal tab showing, the first Back landed on S2/e.ts; with S1's Terminal tab showing, Back landed on a.ts:12 with focus in the editor | a-run rows "Back button from S2/(terminal)", "top-bar Back from terminal" |
| R2-3 | Back from the Board lands on the current entry first | **pass**. With the Board open over a.ts:12, Back showed the editor on a.ts:12. Forward from the Board went to the next entry | `-04-board-buttons.png` |
| R2-4 | A single press never lands on what's already showing; the button's enabled state matches whether a press does something | **pass** for single presses. Across roughly 60 single presses (walks, the Board, the Terminal tab, after a session kill, two sessions on one repo) there was no press where the button was enabled and nothing moved. At the bottom and at the tip, Alt+Arrow and app-command in the disabled direction moved nothing. (The only "enabled but nothing moved" rows were Alt+Arrows inside a focused terminal, which is the intended guard.) | a/d runs |
| R2-5 | After killing a session: enabled state and the walk | **pass**. With S2 killed while its entry was the tip, Forward stopped at the last S1 entry and then went disabled. Back walked all 8 S1 entries to a:1 and never landed in S2 | `-05-after-kill-bottom.png` |
| R2-6 | Alt+Arrows in a focused terminal do nothing | **pass**. Tab, session and focus were unchanged, and focus stayed in xterm | a run |
| R2-7 | Back after each kind of edit, then a far click (R3 edit classification per cursor event) | **pass** for 10 of 10 edit kinds: forward-Delete ×3, Ctrl+Delete ×2, Backspace, Replace All (Ctrl+H, then Ctrl+Alt+Enter; line 5 was really rewritten to `RPL_…`), typing, Enter ×15, a 30-line insert, Ctrl+Z ×3, Ctrl+Y ×2, and Ctrl+Shift+K ×12. Each time the far click to line 100 recorded, Back returned to the line the edit had left the cursor on (5 / 20 / 34 / 33 / 34 / 5), and Forward returned to 100 | c run |
| R2-8 | Ctrl+Z then a same-file F12 of more than 10 lines, then Back | **pass** for 3 variants: (1) typing, Ctrl+Z ×2, click, F12 c:31→c:100, then Back → c:31 and Forward → c:100; (2) typing, Ctrl+Z, click and F12 back-to-back, then Back → c:31; (3) an Undo that itself threw the cursor to line 151, then click 31, F12, then Back → c:31 | d run UZ1–UZ10 |
| R2-9 | Two sessions on the same repo (S1 opens a.ts; S2 opens a.ts from the tree; open b.ts; Back ×3) | **pass**. After S2 took over a.ts, Back was disabled (the two a.ts stops merged into one). After b.ts, one Back landed on a.ts and Back then went disabled, so Back never stuck enabled while doing nothing. In a second pass, where S1 left c.ts at line 60 before S2 opened it, a 6-step Back and 6-step Forward walk had no dead press | d run SR1–SR6; `-20-same-repo-after-back.png` |
| R2-10 | Image/PDF/rendered markdown via history, then a text file; nothing steals focus later | **pass, with a note**. Back landed on rendered sample.md, then sample.pdf, then sample.png, and Forward went back through all three; each viewer rendered. Landing on a text file (ed.ts, a.ts) put focus in the editor. Focus was unchanged 3 s after every landing. Leak probe: after Back to the PDF, I typed "zzz" into Search, clicked the a.ts tab and typed again; the search box kept focus and its text, and no editor took focus. Note: on an image/PDF/markdown landing, focus stays on the Back button rather than moving to the viewer (spec §5 says "the doc viewer") | `-10-back-to-rendered-md.png`, `-11-back-to-pdf.png`, `-12-back-to-png.png` |
| R2-11 | Rapid Back ×5 / Forward ×5 with no skipped or doubled entries and no hang | **FAIL**. See Finding R2-A. The app never hung: a renderer round-trip after every burst took under 2 s, a single press after a burst worked, and an overshoot of 15 presses stopped cleanly at the end with the button disabled | a/a2/e/f/g runs |

## Findings (round 2)

### R2-A. Rapid Back/Forward presses skip history entries

**Severity:** degrades the flow. This hits holding the mouse thumb button, fast repeated clicks on Back/Forward, and fast Alt+Left presses. Single presses at a normal pace are correct.
**Affects:** stops in a file the burst has just landed in (the `c:100`/`c:31` stops after landing on `c:151`, and `X:1` after `X:60`). A burst over stops that each sit in a different file with no saved line (all at line 1) was **correct** in every run (b run: 17 bursts, 0 errors). Every input path is affected: app-command, the button, and Alt+Left.
**Evidence (landings read from the live region):**
- g run, stack `a1 a12 b41 c31 c100 c151 a12(tip)`: 4 simultaneous app-command Backs gave landings `c.ts 151 → b.ts 41 → a.ts 12`. That is 3 landings for 4 presses, and c:100 and c:31 were skipped. The same 4 presses spaced 200 ms or 800 ms apart landed correctly (`c151, c100, c31, b41`).
- e run, stack `a1 a60 b1 b60 c1 c60 d1 d60(tip)`:
  - Back ×3 from d:1 gave `c60, b60, a60`; it should give `c60, c1, b60`.
  - Forward ×2 from c:60 gave only `d1`, so one press was dropped.
  - Forward ×7 from a:1 gave `a60, b1, c1, d1, d60`, skipping b60 and c60.
- f run, same stack: one burst of 4 simultaneous app-commands skipped c:1. It also skipped c:1 **once with presses 600 ms apart** (`d1, c60, b60, b1`). Alt+Left at 0/50/150/300/600 ms was correct in that run, but it skipped entries in the a run.
- a run: 5 fast Backs from S2/e.ts (the button clicked 5× in one task, 5 app-commands, or 5 Alt+Left with no waits) all ended on `a.ts:12`, where one-at-a-time presses end on c.ts:31. The mixed burst b,b,b,f,b,b ended on b:41 instead of c:100.
- Each failing burst came with uncaught `pageerror: Canceled` events (1–3 per burst), which a single press never produced. There were 7–8 per run.

Repro, from a fresh app with one session on a TS project:
1. Open a.ts, b.ts, c.ts and d.ts from the tree. In each one, click line 60 right after it opens, so the stack is `a1 a60 b1 b60 c1 c60 d1 d60`.
2. Fire 3 Backs at once: `app.evaluate(({BrowserWindow}) => { const w = BrowserWindow.getAllWindows()[0]; for (let i = 0; i < 3; i++) w.emit('app-command', {preventDefault(){}}, 'browser-backward'); })`.

Expected: the view lands on c:1 (landings d1, c60, c1). Observed: a.ts:60 (landings c60, b60, a60), because c:1 and b:1 were skipped.

The stack itself survives. A slow one-press-at-a-time walk after the bursts shows the same entries in the same order, so this is a stepping bug, not a data-loss bug.

**Cause:** not confirmed. The pattern fits the next queued op judging "is this entry on screen" and the live cursor (`isNavOnScreen` → `currentNavEntry` → `liveCursor`, `webview/app.tsx` ~2423–2445) before the previous landing's staged reveal has reached the Monaco editor. `nextCommit` (`webview/use-nav-history.ts`) waits for React to commit, but the reveal lands later, when the editor mounts or consumes the reveal. A same-file sibling then looks as if it were on screen and gets skipped. The `Canceled` rejections suggest a Monaco operation cancelled mid-landing. The hidden, rAF-throttled test window may widen the timing gap. I did not check the physical-button pace in a visible window, but the skip also happened once with presses 600 ms apart.

### R2-B (note). A big Undo followed by Back returns to the pre-Undo line

From ed.ts:100, Ctrl+Z ×80 moved the cursor to line 11 (an edit, so nothing was recorded). Back then landed on ed.ts:100, the current entry's old position. Spec §2.3 step 0 would first write line 11 into the current entry, and Back would then go to the previous entry. The build's behaviour is defensible ("take me back to where I was before the undo"), but it differs from the spec text. This is a queued decision, not a failure.

## Not covered (round 2)

- The same list as round 1: physical X1/X2 thumb buttons and the OS delivery of app-command; the non-Windows auxclick path; breadcrumb symbol jump, Go to Type Definition and Go to Implementation; history entries for diff, review, web and commit-diff docs; the 50-entry cap; renamed files and clamping a saved line past the end of a file; a visual comparison against a baseline.
- Real-pace thumb-button auto-repeat in a **visible** window, which would tell whether R2-A needs a hidden window's throttling to show up at 200–600 ms spacing.
- Re-running the round-1 theme and multi-window passes on `fd5bf0a` (the round-2 fixes don't touch them).

## Decisions needed (round 2)

- **normal**: R2-B. Should a large non-recorded cursor move (Undo) update the current entry before Back (spec §2.3 step 0), or should Back return to the entry's recorded position as the build does now?
- **normal**: R2-10 note. After landing on an image, PDF or rendered markdown, should focus move to the viewer (spec §5) or stay on the Back button?

---

# Round 3 (2026-09-23)

**Build under test:** `feat/nav-history` @ `ad64eac`, clean tree, rebuilt through heavy.sh. The build and `git rev-parse` ran in the same heavy run. The round was requested against `4d57b31`, but the branch had moved on by the time I built. The commits in between change the page-error handler and the tests; the navigation code is the same.
**How:** one fresh probe (2 hidden launches, heavy.sh, feature-only). For each burst it tracks where every press should land and compares that with the landings the live region announces. It also counts uncaught page errors per burst. Teardown ran through the harness `cleanup()` (pid-scoped). The scratch dir `qa-nav-history3` and the `qa-navhist3-*` projects were deleted.
**Negative control:** this is the same stepping-and-landing check that flagged R2-A on `fd5bf0a`, so it can report a failure.

## Verdict (round 3)

**Clean.** R2-A is fixed. **All 42 bursts landed exactly N stops back or forward, with the exact sequence of landings in between, and there were 0 page errors in both launches.**

## Results

| Check | Result |
|---|---|
| Stack of same-file stops `a1 a60 b1 b60 c1 c60 d1 d60`. Back ×3 / Fwd ×3 / Back ×5 / Fwd ×5 by each input: app-command, 3–5 button clicks in one task, Alt+Left/Right with no waits, and real Playwright clicks on the button | **16/16 exact.** For example, app-command Back ×3 from d:60 landed `d1, c60, c1` and ended on c:1 (round 2 gave `c60, b60, a60`) |
| app-command ×2 and ×7 in each direction; 4 presses 600 ms apart in each direction | **6/6 exact.** ×7 walked all 7 stops each way |
| The worst case repeated: app-command Back ×3 / Fwd ×3, 4 times in a row | **8/8 exact** |
| Overshoot: 12 app-command Backs, then 12 button Forwards | **exact.** It stopped at a:1 with Back disabled, then at d:60 with Forward disabled |
| Round-1 reading path, slow walk | **pass.** Back ×9: S2/e.ts:1 < a:12 < d:70 < c:151 < c:100 < c:31 < b:41 < a:12 < a:1. Forward ×8 retraced it. No dead press, and the line was on screen with focus in the editor at every step |
| The case of 5 fast Backs from the second session's tip (button / app-command / Alt+Left), then 5 fast Forwards | **6/6 exact.** Each landed `a12, d70, c151, c100, c31` (round 2 ended on a:12), and Forward returned to S2/e.ts |
| Cross-session ×8 each way (app-command) | **exact**, both directions |
| Alt+Left/Right in a focused terminal | **pass.** Nothing moved and focus stayed in xterm |
| Page errors | **0** in both launches, including every burst (round 2 had 7–8 `Canceled` errors per run) |
| Responsiveness | The renderer answered within 2 s after every burst, with no hang |

Evidence: `G:/awby/projects/conduit/.autoloop/evidence/qa-nav-history3-01-tip-terminal.png`, `-02-bottom.png`, `-03-end.png`.

## Not covered (round 3)

- Physical X1/X2 thumb buttons, and real-pace auto-repeat in a visible window.
- The non-Windows auxclick path.
- Breadcrumb symbol jump, Go to Type Definition and Go to Implementation.
- History entries for diff, review, web and commit-diff docs.
- The 50-entry cap.
- Renamed files, and clamping a saved line past the end of a file.
- A visual comparison against a baseline.
- Round 2's edit, media, session-kill and same-repo checks, and round 1's theme and multi-window checks, were not re-run on `ad64eac`. The round-3 change touches the landing and page-error paths, not those.
