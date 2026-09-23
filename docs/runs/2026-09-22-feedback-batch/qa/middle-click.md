# Runtime QA · Middle-click opens in a new background tab

**When:** 2026-09-23
**Tier:** FULL. The change covers many surfaces and a host (main-process) route, is persisted across relaunch, and ships to three themes plus reduced motion.
**Artifact:** desktop app (Electron), dev build (`npm run build` → `out/`)
**Build under test:** conduit at `G:\awby\projects\conduit-wt-middle-click`, `feat/middle-click` @ `34ee9b7`. The tree was clean. `npm run build` exited 0 just before the first run.
**Build identity confirmed from the running artifact:** `app.getAppPath()` = `G:\awby\projects\conduit-wt-middle-click`, `app.getVersion()` = 0.39.0. The feature's own DOM (`.bg-open-status`, `tab--flash`) and host route (`web:openBackgroundTab`) were present and working, and neither exists on main.
**Environment:** Playwright `_electron` through the repo harness (`test/e2e/harness.mjs` `launchApp`/`openSession`/`spyMain`). `CONDUIT_E2E=1`, so the window was hidden. Every run was serialised through `heavy.sh`. Local http fixtures for web tabs ran on ephemeral `127.0.0.1` ports.
**Isolation:** each launch got its own `mkdtemp` user-data dir (`%TEMP%\conduit-ud-*`) and its own temp git repo (`%TEMP%\qa-mc-*`). Relaunches reused the same user-data dir on purpose. The probes lived in `%TEMP%\claude-scratch\qa-middle-click\`. None of the builder's `middle-click-*.e2e.mjs` were run.
**Configurations driven:** win32 (driven). Themes Aero, Aero Dark and Neon (driven). App "Reduce motion" setting, emulated `prefers-reduced-motion: reduce` and emulated `forced-colors: active` (all driven, computed style only). Linux and macOS were not driven.
**Teardown:** every app was shut down by handle through `shutdownApp`, which falls back to a PID-scoped taskkill. No process was killed by name. The scratch dir and the temp repos were removed. The evidence PNGs are kept in `.autoloop/evidence/`.

## Scope

The request: "middle-clicking a file or a link anywhere should open it in a new tab". The acceptance criteria come from `docs/specs/2026-09-22-middle-click-new-tab.md` (§4 edge cases, §7 AC-1…AC-17) and from the conductor's locked behaviour:
- The tab opens pinned and in the background. Active tab, focus, session and Back/Forward stay the same.
- The preview tab is never replaced.
- Already pinned: no duplicate, only a cue. Preview: pinned in place.
- Middle-click on a tab closes it, including when the strip overflows.
- Diffs keep their Index or Working Tree scope.
- Links inside an in-app web tab open as a background web tab, but only on a real middle-click or Ctrl-click.

Fixture: a temp git repo with nested folders and 70+ files, so the explorer tree scrolls. It also had an MM file (`mm.ts`: staged, then modified again), a deleted file, a committed history, dirty files for Review, and a README with file, fragment, https and in-page links.

Every click was a real pointer gesture (Playwright `page.mouse`, CDP input) with a few pixels of jitter between down and up. That jitter is how Windows autoscroll would engage. No builder helpers were used.

## Verdict

**Works, with 1 in-scope failure and 2 minor issues.** A real **Ctrl+click** on a link inside an in-app web tab still goes to the system browser. Middle-click there works.

## Criteria

For each open this table records: new tab (P = pinned, not a preview), whether the active tab, focus, session and Back/Forward stayed the same ("unchanged"), and the announcement.

| # | Criterion / surface | Result | Evidence (probe log line) |
|---|---|---|---|
| AC-1 | Explorer file row, tree scrolled | **pass.** `f65.ts`, then `f66.ts`: P, unchanged, tree `scrollTop` unchanged. "Opened f65.ts in a background tab". Wheel-scrolled tree `h40.ts`: same, `treeScroll` unchanged. | probe-a, probe-m |
| S1 | Nested file `src/deep/nested/inner.ts` | pass. P, unchanged | probe-a |
| AC-2 | Middle on the current preview tab `f60.ts` | pass. Loses `~`, keeps its index, stays active. "Pinned f60.ts" | probe-a |
| L1 | Preview never replaced | pass. `f05.ts`/`f07.ts`/`README.md` stayed preview while new pinned tabs were added | probe-f, probe-m |
| AC-3 | Already-pinned file | pass. Tab count unchanged, `tab--flash` on that tab then cleared (≈600 ms), "f65.ts is already open" | probe-a, probe-cue |
| AC-6 | Folder row `src` | pass. No tab, `aria-expanded` false→false | probe-a |
| §4 | Multi-selection: middle on a selected row and on an unselected row | pass. Opens only that row. Selection (3 paths) and focus unchanged | probe-a |
| AC-11 | Middle-drag 100 px, `f04`→`f08` | pass. No tab, `dragstart` count 0 | probe-a |
| §4 | Explorer row whose file was deleted on disk just before the click | pass. Tab `0vanish.ts` created. Activating it shows "File could not be read." | `qa-middle-click-aero-dark-deleted-file-tab-activated.png` |
| L4 | Middle inside Monaco text | pass (no-op). No tab, buffer length 4790→4790 (no paste). Focus moved from the tab strip into the editor; this surface is out of scope (L4) | probe-a |
| S3 / AC-5 | Search match in the **active** file | pass. "a.ts is already open", cursor and scroll 2:0→2:0 | probe-a |
| S3 | Search match `b.ts:120` | pass. P, unchanged | probe-a |
| S4 | Non-name-only head: no-op. Name-only head `namehit.ts`: opens | pass | probe-a |
| S12 / AC-10 | Quick open file row `f10.ts` | pass. P, unchanged, palette stays open, `.palette__input` keeps focus | probe-a |
| S12 | Palette Recent row: already-open file, and a **closed** file (`g05.ts`) | pass. "namehit.ts is already open". `g05.ts` reopened P in the background | probe-a, probe-a2, `qa-middle-click-aero-dark-palette-recent-after-middle.png` |
| S12 | Palette command row (Theme: Neon) | pass (no-op). Theme unchanged | probe-a |
| S2 | Changes **Staged** row, MM file | pass. `mm.ts (Index)`, P, unchanged | `qa-middle-click-aero-dark-changes-mm-index-worktree.png` |
| S2 | Changes (unstaged) row, same MM file | pass. `mm.ts (Working Tree)`, a second tab with its scope kept | same |
| S2 | Changes row for a deleted file | pass. `gone.ts (Working Tree)` | probe-a |
| S11 | Breadcrumb dropdown file entry `f20.ts` | pass. P, unchanged, menu closes | `qa-middle-click-aero-dark-breadcrumb-menu.png` |
| S11 | Breadcrumb dropdown dir entry `src` | pass (no-op). No tab, menu stays open | probe-a |
| S10 | Markdown link to an open file, and to a not-open file (`far.ts`, `docs/deep.ts#sec`) | pass. "already open" / P, unchanged. The README did not scroll to the fragment (markdown `scrollTop` 0→0) | probe-a, probe-m |
| AC-7 | Markdown `https://` link | pass. `openExternal` called exactly once (0→1), no tab | probe-a |
| S10 | Markdown in-page `#anchor` | pass (no-op) | probe-a |
| S9 | Oversize diff notice "Open file" | pass. `big.txt`, P, diff tab stays active | probe-m |
| S13 | Terminal file link `src/b.ts:12:3`, real mouse over the xterm canvas | pass. `b.ts` P, the terminal stays the view, focus stays in `xterm-helper-textarea`. Activating the tab later lands on **line 12** | probe-b, `qa-middle-click-aero-dark-terminal-links.png` |
| AC-7b | Terminal `https://` link, real mouse | pass. `openExternal` exactly once, no tab | probe-b |
| S13 | Terminal dir link `./src`: middle vs left | pass. Both call `openPath(<root>/src)` once, no tab (the two behave the same, as L3 requires) | probe-c |
| S5/S6/S7 | Review card open, side-by-side, hunk jump | pass. File, diff and file tabs, all P. Review stays active, current hunk and `.review__scroll` unchanged | `qa-middle-click-aero-dark-review.png` |
| S8 | History commit file row `c.txt` | pass. `c.txt @ be567bc` P, History stays active | `qa-middle-click-aero-dark-history.png` |
| S8 | Commit file that is currently the preview (`d.txt`) | pass. "Pinned d.txt @ be567bc", in place | probe-b |
| excl. | Blame lens / references peek list | pass (no-op, excluded). No tab. The blame-lens press moved focus Monaco→BODY (excluded surface, L4) | `qa-middle-click-aero-dark-blame-lens.png`, `qa-middle-click-aero-dark-references-peek.png` |
| AC-13 | Cross-session: palette `sub/z.ts` owned by session B | pass. A's strip unchanged. "Opened z.ts in a background tab in sub". B's strip gets z.ts, B's active view unchanged | `qa-middle-click-aero-dark-session-b-strip.png` |
| AC-17 | Web guest link, **middle** (host-page mouse over the `<webview>`) | pass for the tab: new "QA Two" web tab, background, `openExternal` 0. **Focus moved BODY → `<webview>`** (finding 3) | `qa-middle-click-aero-dark-web-after-middle.png` |
| AC-17 | Same link middle-clicked again | pass. "QA Two is already open", no duplicate | probe-c |
| AC-17 / locked | Web guest link, **Ctrl+left**, real input | **FAIL.** No in-app tab. `openExternal(/four)` was called (system browser) | probe-c, probe-r (finding 1) |
| AC-17 | `target=_blank` left-click | as the spec measured before this change: no tab, no `openExternal` | probe-c |
| AC-17 | Script-dispatched Ctrl-click (no gesture for >1 s) | pass. No in-app tab. It went to the system browser, as the spec intends | probe-c |
| AC-17 | Failed load → Retry → middle | pass. Error page "ERR_CONNECTION_REFUSED" + Retry. After Retry the new guest's middle-click opened a background tab, `openExternal` 0 | `qa-middle-click-aero-dark-web-load-failed.png` |
| AC-8 / T | Middle on a tab closes it, with the strip overflowing (33 tabs, chevron shown) | pass. A visible middle tab, the right-most visible tab, the last tab after scrolling the strip, and the **active** tab all closed. Closing the active tab activated its neighbour, as a normal close does | probe-a, probe-a2, `qa-middle-click-aero-dark-after-middle-close.png` |
| §4 | Many background opens: strip does not scroll, active tab stays in view, cue goes to the chevron | pass. Active tab rect stayed inside the bar. `tabbar__overflow-btn--flash` on for ≈630 ms, no element's `scrollLeft` changed | probe-a2, probe-cue, `qa-middle-click-neon-overflow-chevron-cue.png` |
| AC-9 | Back/Forward | pass. Back-button `disabled` state never changed across ~60 background opens. Alt+Left from README went to `a.ts` (the previous foreground location), not to a background tab | probe-a |
| AC-14 | Announcement strings; two identical already-open clicks | pass. Exact strings for opened / pinned / already-open / "in ‹session›". Identical repeats clear and then re-set the region each time | probe-cue |
| AC-15 | Cue: present then gone within 1 s. Reduced motion → `animation-name: none` and a static outline. Forced colors → outline not `none` | pass. Themes: `tab-flash` animation with a 2px `--tab-flash` outline (accent at 45%). App reduce-motion: `anim=none`, static outline. `prefers-reduced-motion`: `anim=none`. `forced-colors`: `anim=none`, outline a system colour | probe-cue, probe-v |
| A4 | Relaunch: background tabs persist | pass for file and diff tabs. `a.ts`, `b.ts` (background) and `c.ts (Working Tree)` (background) all came back pinned. Web tabs were not restored (finding 4, not caused by this change) | probe-r, `qa-middle-click-aero-dark-relaunch-restored.png` |

## What happened

1. Built the worktree and confirmed the running app path and version from the main process.
2. **probe-a** (explorer, preview/pinned/already-open, folder, multi-select, middle-drag, deleted file, Monaco, search, palette, Changes MM, breadcrumbs, markdown, Back/Forward, strip overflow). Results in the table.
3. Three explorer misses in probe-a led to focused repros: **probe-f**, **probe-g** and **probe-h** (finding 2).
4. **probe-b**: terminal links with a real mouse over the rendered cells (hovered first so xterm detects the link), Review, History, blame lens, references peek, cross-session.
5. **probe-c** and **probe-r**: web tab middle and Ctrl, `target=_blank`, the script click, failed load and Retry, the terminal dir link, and the relaunch.
6. **probe-a2**, **probe-cue** and **probe-v**: cue and announcement timing, logged with a MutationObserver. Cue appearance in three themes. Reduced motion and forced colors. Chevron cue.
7. **probe-m**: markdown links to files that were not yet open, the fragment case, and the S9 oversize notice.

**Negative scenarios:** folder rows, the non-name-only search head, palette command rows, the breadcrumb dir entry, Monaco text, the blame lens, the peek list, middle-drag, the script-dispatched Ctrl-click and `target=_blank`. None produced a tab.
**Relaunch scenario:** quit through the harness (with the quit-guard answered), then relaunched on the same user-data dir and selected the session. File and diff background tabs came back pinned. Web tabs did not (finding 4).
**Negative controls:** the explorer-miss repro logged `aux` for every successful open and no `aux` for every miss, so the "opened" checks track the real click. The Ctrl-click probe used a middle-click on the same guest as a control, logged through the same `input-event` listener: middle was recorded and opened a tab, while Ctrl showed `modifiers: []`. The fact that a script click produces no tab shows that the gesture check has teeth.

## Findings

### 1. Ctrl+click on a link in an in-app web tab opens the system browser, not a background web tab

**Severity:** breaks the flow. It is one of the two gestures the locked behaviour names.
**Affects:** web-tab guests. Middle-click on the same guest works.
**Evidence:** probe-r log.
- Guest `input-event` for the Ctrl+left: `mouseDown left []`, `mouseUp left []`.
- The same happens with `sendInputEvent({..., modifiers:['control']})` sent straight from main.
- `openExternal(http://127.0.0.1:<port>/four)` was recorded, and no tab was added.
- The page itself did see Ctrl: a plain left-click on that link navigates in place and never reaches the window-open handler.

Repro, from a fresh app with one web tab showing a page with `<a href="/four">`:
1. Hold Ctrl and left-click the link.
2. Expected: a new background in-app web tab for `/four`, with `openExternal` not called. Observed: `openExternal` is called once and no tab is added.

**Cause:** `electron/main.ts:3755` records the gesture from the guest's `input-event`. `src/webview-guard.ts:45` `isBackgroundOpenGesture` needs `modifiers` to include control/meta on the left `mouseUp`. Electron (43.3.0, win32) reports an empty `modifiers` array on these mouse `input-event`s, so the Ctrl branch never fires. The route then falls through to `external`. The unit test passes because it feeds a hand-built `input` object with `modifiers: ['control']`.

Caveat: the input was synthetic (CDP on the host page, and `sendInputEvent`). A physical Ctrl+click was not driven. Both synthetic paths still delivered Ctrl to the page, while `input-event` dropped it.

### 2. An explorer middle-click occasionally opens nothing (≈7 of ≈160 gestures)

**Severity:** minor. It is intermittent, and nothing tells the user the click was lost.
**Affects:** explorer rows in the virtualized tree. Not seen on any other surface.
**Evidence:** probe-g and probe-f event logs.
- Each miss: `down f61.ts dp=true` → `focusout f60.ts` → `up f61.ts` → **no `auxclick`**.
- probe-h saw a full remount of the visible window some time after a left-click (`removed f38…f69`, `added f31…`).

Repro (probabilistic): scroll the tree to the bottom, left-click a row, wait about 0.8 s, then middle-click the next row. Seen 4 times in that exact sequence and once right after a `scrollIntoView` jump. It did not reproduce in 5 isolated repetitions of the same sequence, or with wheel scrolling and a 120 ms hold.

Expected: a background tab. Observed: nothing, and focus leaves the previously focused row.

**Cause (likely, not proven):** the tree remounts row DOM nodes between mousedown and mouseup. Chromium then fires no `auxclick`, and the per-item handler never runs. The remount predates this change (the row keys were not changed in this diff), and in principle it can eat a left-click the same way. The hidden window's ≈1 s rAF may widen the window for it. It was not measured in a visible window.

### 3. Middle-clicking a link inside a web tab moves focus into the `<webview>`

**Severity:** cosmetic / minor. Spec §7 says "same `document.activeElement`".
**Evidence:** probe-c and probe-r: `focus: BODY → WEBVIEW.webview__frame` on 3 of 3 middle and Ctrl gestures into the guest.

The press lands in a separate web contents, and the host's `middleClickProps` suppression cannot reach it. Either accept this as inherent to S14 or record it in the spec as an exception.

### 4. (Outside this change) Web tabs are written to `docs.json` but not restored after relaunch

**Severity:** existed before this change and is outside the feature's scope. It is recorded because `src/webview-guard.ts`'s comment argues for the gesture check on the grounds that "each in-app tab is persisted and restored on relaunch".
**Evidence:** probe-r. `docs.json` held `web:` and `web:two`, but after relaunch plus session select only the file and diff tabs came back. The foreground-opened first web tab was not restored either, so this does not come from middle-click.

### 5. (Low) The Review side-by-side diff tab has the same title as the file tab

Both appear as "r1.ts", so the strip shows two identical labels. The announcement "Opened r1.ts in a background tab" is also the same for both, so a screen-reader user cannot tell a file open from a diff open. The naming predates this change, but the ambiguity now reaches the announcement.

## Visual / design fidelity

**Baseline:** none. The cue is new UI; its reference is spec §8/§11 (600 ms outline pulse with a `--tab-flash` token, static under reduced motion).
**Comparison:** `qa-middle-click-{aero,aero-dark,neon}-tab-cue.png` (strip crops) and `*-full.png`. These were captured after a real middle-click set the class, with the animation paused at frame 0. A hidden window takes about 1 s per screenshot, longer than the 600 ms cue.
**Result:** a 2px accent outline, inset, clearly visible in all three themes, with no layout shift and the tab label colour unchanged (computed `rgb(154,160,178)` with and without the cue). Reduced motion gives `animation-name: none` and a static outline (computed style). Forced colors give a system-colour outline (computed style).
**Not checked visually:** reduced motion and forced colors. Screenshots with `data-reduce-motion="true"` timed out 3 of 3 times in the hidden window.

## What worked

Every wired surface (S1–S13) and every tab close (T) produced the documented result. That includes an announcement for each open, and diff scopes (Index / Working Tree) kept apart for an MM file. Nothing autoscrolled, pasted, dragged, stole focus (outside finding 3), replaced the preview, switched session, or added a Back/Forward entry.

## Not covered

- **Linux (D3, terminal middle = paste) and macOS.** Only win32 was available.
- **A physical mouse.** All input was synthetic (CDP / `sendInputEvent`), including the Ctrl-click in finding 1.
- **Visible-window timing.** The hidden window runs rAF about every 1 s, so the cue and announcement landed about 1 s after the click here. Their one-frame latency in a visible window was not measured (the user directive was hidden runs).
- **Screenshots under reduced motion and forced colors.** The capture hangs; the evidence for these is computed style only.
- **Terminal OSC-8 links, the multi-candidate disambiguation menu, and commit links (D4).** Not driven.
- **Middle-click pinning a dirty preview tab** (§4). Not driven.
- **HTML-preview guests, the Settings About link, and the singleton openers.** Excluded by the spec; not driven.
- **Whether the explorer miss (finding 2) also eats left-clicks.** Not measured.

## Environment faults

- Hidden (`show:false`) window: `requestAnimationFrame` latency was ≈700–1000 ms, even with `setBackgroundThrottling(false)`. Every rAF-deferred UI (cue, announcement) lags that much under the e2e harness. This is not a product delay.
- Hidden window: `page.screenshot` hangs (30 s timeout) while `data-reduce-motion="true"` is set.

## Decisions needed

- **[normal] Finding 3.** Should focus moving into the `<webview>` on a middle or Ctrl click inside the guest be written into the spec as an S14 exception?

## Artifacts

- `G:/awby/projects/conduit/.autoloop/evidence/qa-middle-click-*.png`, 22 captures. These include the tab cue per theme (`aero`, `aero-dark`, `neon` `-tab-cue` / `-full`), `neon-overflow-chevron-cue`, `aero-dark-{terminal-links,review,history,blame-lens,references-peek,session-b-strip,changes-mm-index-worktree,breadcrumb-menu,markdown,palette-recent-after-middle,deleted-file-tab-activated,after-middle-close,web-tab,web-after-middle,web-load-failed,relaunch-restored}`.
- The probe scripts and JSONL logs were scratch in `%TEMP%\claude-scratch\qa-middle-click\` and were deleted at teardown, as instructed. The key log lines are quoted in the findings above.

```
QA: G:/awby/projects/conduit/docs/runs/2026-09-22-feedback-batch/qa/middle-click.md
BUILD_UNDER_TEST: conduit feat/middle-click@34ee9b7
VERDICT: fail
NOT_COVERED: Linux/macOS (D3); physical-mouse input; visible-window cue/announcement timing; reduced-motion + forced-colors screenshots; terminal OSC-8 / multi-candidate menu / commit links (D4); dirty-preview pin; excluded surfaces (HTML-preview guests, About link, singleton openers)
```

The round-1 verdict above is superseded by Round 2.

---

# Round 2 · `feat/middle-click` @ `1156b7d`

**When:** 2026-09-23
**Build under test:** `G:\awby\projects\conduit-wt-middle-click`, `feat/middle-click` @ `1156b7d`. The tree was clean. I rebuilt it with `npm run build` through `heavy.sh` (EXIT=0), and it ran from `out/` in the worktree, as in round 1.
**Changes since round 1:**
- `62daf45`: the host needs a real **middle** `mouseUp` in the guest within 300 ms (`src/webview-guard.ts`).
- The conductor ruled Ctrl/Cmd+click out of scope; it keeps going to the system browser. Spec §5 was updated to match.
- `right-pane.tsx`: tree rows are now keyed by path only (`windowed.flatMap`), so a window shift no longer remounts them.

**Environment and isolation:** as in round 1. Hidden window (`CONDUIT_E2E=1`), harness `launchApp`, a fresh user-data dir and temp git repo per launch, and every run serialised through `heavy.sh`.
**Teardown:** apps were closed through `shutdownApp`. Two of my own hung or invalid stress runs were stopped with `taskkill /T` on **their node PID** (found by the `stress.mjs` command line), never by process name. The scratch dir and temp repos are deleted.

## Round-2 verdict

**Clean.** Across 199 explorer middle-clicks and 55 left-clicks under tree shifts there were **0 misses**. Web middle-click opens a background tab; Ctrl+click and scripted opens do not. Four other surfaces re-passed.

## R2-1. Explorer reliability at scale (round-1 finding 2)

**Fixture:** 160 files plus `pkg/sub*/` nested folders, so the tree scrolls (scrollHeight 3560 vs 684).

**Gesture:** each one was realistic: an approach move, a press, a 2–4 px wiggle, a 30–150 ms hold, then release.

**Grading:** each gesture was graded against the row actually under the pointer (`elementFromPoint`) at press and at release.
- Same row at press and release: that exact file must be announced (either "Opened …" or "… is already open"). A different file's announcement also counts as a miss.
- Different rows (the per-item rule): nothing may open. This case never came up.

**Harness correction.** The first graded run showed 10/10 "misses" in M1. Each one had fired `auxclick` and opened a **different** file. The cause was the harness, not the app: Chromium's smooth wheel scroll keeps moving the content after the script measures the row, so the pointer ends up over another file. That other file, the one really under the pointer, is what opened. The grading above fixes this. M1 reports the effect separately: in 40 of 40 gestures the content had moved before the press.

| Mode | Shift while clicking | Middle n | Middle misses |
|---|---|---|---|
| M1 | Wheel scroll, then press straight away (half of them without waiting for the scroll to settle) | 40 | **0** |
| M2 | Left-click a row, then middle-click a neighbour after 0/300/800 ms (the exact round-1 miss pattern) | 71 | **0** |
| M3 | Tree scrolled **5 rows while the button is held**, pointer following its row, so the virtual window shifts under the press | 40 | **0** |
| M4 | A file created on disk during the press (sorts below the target) | 20 | **0** |
| M5 | Click-to-reveal: a foreground open of a far file scrolls the tree (e.g. 1320→2842, 2842→990), then middle-click at once | 20 | **0** |
| X | A file created **above** the target during the press. The tree kept the row under the pointer (scrollTop +22 each time), and the pressed file opened | 8 | **0** |
| **Total** | | **199** | **0** (round 1: ≈7 of ≈160) |

**Left path, same shifts (your question: was left-click affected?).** No miss in round 2.

| Mode | Left n | Misses |
|---|---|---|
| L1 wheel scroll, then left-click | 15 | 0 |
| L2 left-click, then left-click a neighbour after 0/300/800 ms | 15 | 0 |
| L4 file created on disk during the press | 10 | 0 |
| L5 reveal, then left-click at once | 10 | 0 |
| X file created above during the press | 5 | 0 |
| **Total** | **55** | **0** |

Round 1 never measured left-clicks, so I can't say from observation whether the old keying also ate left-clicks. By mechanism it would have: a replaced element gets no `click` either. On the fixed build, left-click is clean.

**Negative control not run:** I did not run M3 against the round-1 build to show it misses there, because that would mean checking out `34ee9b7` in the shared worktree. So "0 misses" rests on M3 being a strong stressor. Every M3 gesture shifted the window by 5 rows (110 px) while the button was held.

## R2-2. Web tab (S14, re-ruled)

Clicks were real host-page mouse input over the `<webview>`, with `openExternal` spied host-side.

| Case | Result |
|---|---|
| Middle-click `/two` | **pass.** New background tab "W Two", "W One" stays active, `openExternal` 0 |
| Real Ctrl+left `/four` | **pass (new ruling).** System browser **once** (`openExternal(…/four)`), no tab |
| Script-dispatched Ctrl-click `/five` | **pass.** No tab. One `openExternal` (system browser, as before this feature) |
| Script-dispatched middle `auxclick` `/six` | **pass.** No tab, no `openExternal` |
| Script `window.open('/seven','_blank')` | **pass.** No tab, no `openExternal` |
| Real middle on `/two` (already open), then a script Ctrl-click on `/five` about 50 ms later, inside the 300 ms window | **pass.** "W Two is already open", and the script click went to the system browser and **not** to a tab. The real gesture was used up by its own open |

Round-1 finding 3 (focus BODY → `<webview>` on a middle-click in the guest) still reproduces. It remains a Decision Needed item.

## R2-3. Re-pass of other surfaces (no regression)

| Surface | Result |
|---|---|
| Terminal file link `src/c.ts:20:1`, real mouse | pass. `c.ts` pinned in the background, the terminal stays the view, focus stays in xterm |
| Changes Staged / unstaged rows of an MM file | pass. `mm.ts (Index)` and `mm.ts (Working Tree)`, both background, `a.ts` stays active, focus stays in Monaco |
| Search match `b.ts:120` | pass. Pinned in the background, unchanged |
| Markdown `https://` link | pass. `openExternal` exactly once, no tab |

In every case the session and the Back button state were unchanged.

## Round-2 findings still open

- **Finding 3 (minor, Decision Needed):** a middle-click inside a web page moves focus into the `<webview>`.
- **Finding 4 (not from this change):** web tabs are not restored on relaunch.
- **Finding 5 (low):** a side-by-side diff tab has the same title and announcement as the file tab.

## Round-2 not covered

- **M3 against the round-1 build**, as a negative control.
- **Physical mouse.** All input was CDP-synthetic.
- **A visible window.** It has different rAF and scroll timing.
- **Everything already listed under round-1 Not covered**, which still applies.

## Round-2 environment faults

The hidden window still runs rAF about every 1 s, so every announcement landed ≈1 s after release. My first two stress runs are **harness defects**, not app results:
- one ran with no per-gesture logging and was stopped by PID;
- one graded against a row the smooth scroll had moved away.

```
QA: G:/awby/projects/conduit/docs/runs/2026-09-22-feedback-batch/qa/middle-click.md
BUILD_UNDER_TEST: feat/middle-click@1156b7d
VERDICT: pass
NOT_COVERED: Linux/macOS (D3); physical-mouse input; visible-window timing; M3 negative control against the round-1 build; reduced-motion + forced-colors screenshots; terminal OSC-8 / multi-candidate menu / commit links (D4); dirty-preview pin; excluded surfaces (HTML-preview guests, About link, singleton openers)
```
