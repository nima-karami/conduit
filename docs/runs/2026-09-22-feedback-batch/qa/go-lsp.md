# Runtime QA · Go code intelligence via host-managed gopls

**When:** 2026-09-22/23 (two sessions; the second resumed after a usage-limit cut-off)
**Tier:** FULL. Host process lifecycle, IPC, several nav surfaces, relaunch/restore, a missing-binary variant, and three themes.
**Artifact:** desktop app (Electron), driven with Playwright-Electron through `test/e2e/harness.mjs`, hidden (`CONDUIT_E2E=1`)
**Build under test:** `G:\awby\projects\conduit-wt-go-lsp`, `feat/go-lsp` @ `bc66a6d` (clean tree). Rebuilt with `npm run build` through heavy.sh (EXIT=0) before the final pass. An earlier full pass ran on `a6fd47d`. All results below come from the `bc66a6d` run unless marked otherwise.
**Build identity confirmed from the running artifact:** the app reported `app.getVersion()` = 0.39.0 and served the `lsp:statusSnapshot` bridge call, which only this branch has. There is no build stamp, so the sha is confirmed from the tree + a fresh build immediately before launch, not from a banner.
**Environment:** real gopls v0.20.0 (`C:\Users\karam\go\bin\gopls.exe`), Go 1.25.3 (`C:\Program Files\Go\bin\go.exe`). Every launch used a throwaway `--user-data-dir` from the harness. The cold-start run also got a fresh, empty `LOCALAPPDATA`, so the gopls file cache and GOCACHE were both cold, like a first-time user.
**Fixtures (temp, deleted):** `…\qa-go-lsp\fx\solo mod\` (**path with a space**; module `example.com/solo`; packages `main` + `shapes`; interface `Shape` with two implementations `Circle`/`Square`), `…\fx\work\` (`go.work` using `./app` + `./lib`, two modules), `…\fx\tsproj\` (a.ts/b.ts + script.py for regression).
**Configurations driven:** themes `aero-dark` (default), `aero`, `neon`: all three driven (theme ids from `webview/themes.ts`). gopls present / gopls absent: both driven. Fresh launch / relaunch-with-restored-tabs: both driven.
**Teardown:** every app was closed via the harness (`closeApp`/`cleanup`). gopls PIDs were tracked from the app's own status snapshot plus a ParentProcessId walk. Nothing was killed by image name. The one deliberate kill was `taskkill /PID <electron main> /F` on the app I launched. Scratch dir `%TEMP%\claude-scratch\qa-go-lsp` (probe, fixtures, cold LOCALAPPDATA, restore profile, logs) was deleted at the end. Harness-created `conduit-ud-*` dirs in `%TEMP%` are left for the OS, following the harness convention.

## Scope

Spec `docs/specs/2026-09-22-language-server-go.md` §7 (E1–E14 + Gherkin), driven the way a Go developer would use it, with my own probe and fixtures. I did not re-run the builder's `go-lsp.e2e.mjs`. Additions from the coordinator for `bc66a6d`: palette "Restart Go language server" followed immediately by F12 (must land first try, within budget), and a restored tab that was never activated used as a peek/references target. Regression checks: TS F12/references, and `.py` still reports navigation unavailable.

## Verdict

**Clean.** Every in-scope criterion I reached was observed working on `bc66a6d`. Two apparent failures on the way turned out to be caused by my probe, not the product. They were root-caused and re-driven (see Environment faults).

## Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| E1 | Go tab open → exactly one gopls per server root | observed pass: `solo mod` → one server; `go.work` root → **one** server key for both `app` and `lib` modules (`go:…\fx\work`); two roots → two servers | main.log "go.work: one server key", "servers before idle" |
| E2 | Definition / Type Def / Implementation / References / Peek through TS surfaces | observed pass (details below) | 02, 03, 04, 82, 83 |
| E3 | Single location in another file → opens via editor opener, caret on range | observed pass: F12 `shapes.Describe` → `shapes/shapes.go:24 func Describe`; Ctrl+click `Square` → `shapes.go:18 type Square` | 02, 51 |
| E4 | Loading → "Go: loading workspace…", completes when gopls answers | observed pass: cold F12 showed exactly `Go: loading workspace…` inline, then landed | 01 |
| E5 | gopls missing → install message; open/edit/save/hover/breadcrumbs silent | observed pass in all 3 themes | 61, 62, 63 |
| E6 | Crash-restart budget / `crashed` state | **not reached** (see Not covered) | — |
| E7 | Quit / main force-kill → no gopls or descendant alive 5 s later | observed pass for both | main.log "quit:", ctrl.log "force-kill" |
| E8 | 60 s after last Go tab closes → server stops | observed pass: stopped after 59.8 s and 60.8 s (two roots); all 6 recorded PIDs (gopls + child gopls + conhost) dead | main.log "idle stop" |
| E10 | Breadcrumbs show enclosing chain | observed pass: `shapes > shapes.go > (Square).Area`; `… > Shape > Name` in the interface | 08, 11, 15 |
| E11 | Agent edit of unopened file → next nav reflects it | observed pass for a **new** file and a **modified** one | main.log |
| E12 | Caret move before a pending nav resolves → no caret yank, no tab | observed pass | ctrl.log "E12" |
| E13/E14 | Renderer reload in place; same file in two windows | **not reached** | — |
| E9 | Spawn by absolute path, no shell, GOTOOLCHAIN=local | not observed at runtime (unit-test criterion per spec) | — |
| add. | Palette restart → immediate F12 lands first try | observed pass, 3/3 rounds, new PID each time | 71, restart.log |
| add. | Restored, never-activated Go tab as peek/refs target | observed pass | 81, 82, 83 |
| reg. | TS F12 / references still work; `.py` says unavailable | observed pass | 17 |

## What happened (bc66a6d)

1. **Cold start** (empty gopls cache + GOCACHE): opened `main.go`, pressed F12 on `Describe` 1.5 s later. The inline message `Go: loading workspace…` appeared at the caret (`01`), and a "Resolving…" chip showed bottom-right. The nav then landed in `shapes.go:24` after **34.4 s**. The a6fd47d run took 38.1 s. Status stream: `starting → ready (0.5 s) → loading → ready (+31.5 s)`. The message stays up the whole wait, with no timeout and no error. Warm restarts afterwards took ~1.5 s.
2. **Back/Forward** after the jump: Alt+Left → `main.go:11`, Alt+Right → `shapes.go:24`.
3. **Ctrl+F12 on interface method `Shape.Area`**: a peek titled "Locations (2)" listed `(Circle) Area()` and `(Square) Area()` (`03`, and in the other themes `10`, `14`). Ctrl+F12 on the concrete `Circle.Area` jumped to the interface declaration (single result, same file).
4. **Type Definition** (context menu) on `c` → `type Circle struct`.
5. **References** (Shift+F12) on `Describe` → peek "Locations (3)": `main.go` ×2 + `shapes.go` ×1, declaration included (`04`). **F12 on the declaration itself** fell through to the references peek (TS parity).
6. **Ctrl+click** (real mouse, Ctrl held) on `Square` in `main.go` → `shapes.go:18 type Square` (`41`, `51`).
7. **Hover** on `shapes.Describe` → `func shapes.Describe(s shapes.Shape) string / Describe formats a shape. / shapes.Describe on pkg.go.dev` (`05`). On stdlib `fmt.Println` → full signature + doc + `https://pkg.go.dev/fmt#Println` link (`06`).
8. **F12 into stdlib** `fmt.Println` → a new `print.go` tab at `C:\Program Files\Go\src\fmt\print.go:313 func Println`, with breadcrumbs `C: › Program Files › Go › src › fmt › print.go › Println` (`07`). **F12 again from inside GOROOT** (`Fprintln`) → `print.go:302`, so an out-of-root file stays attached to its server.
9. **Breadcrumbs:** see E10 above (`08`).
10. **Unsaved edit:** appended `func addedJustNow()` and a call to it without saving. F12 on the call → `main.go:16 func addedJustNow` (the unsaved line).
11. **Agent-style edits on disk:** a **new** unopened `shapes/triangle.go` (`type Triangle`) was reachable by F12 1.1 s after the write, on the first try. The implementation peek on `Shape.Area` then showed 3 (triangle.go added). **Rewriting** the unopened `util.go` (function renamed and moved to line 6): F12 landed on line 6, first try.
12. **Themes:** `aero` and `neon` each got hover (`09`, `13`), implementation peek (`10`, `14`), breadcrumbs (`11`, `15`), and palette restart → F12 (`12`, `16`). Monaco's hover and peek pick up each theme's colours; nothing was clipped or unreadable.
13. **go.work:** F12 on `greet.Hello` in `app/main.go` → `lib/greet/greet.go:4` (1.4 s including a fresh server start). References on `Hello` from the lib side listed `app/main.go`, i.e. cross-module.
14. **Regression:** TS `b.ts` F12 → `a.ts:1`, and Shift+F12 → peek (4). `.py` F12 → toast `Code navigation isn’t available for Python files.` (`17`).
15. **Idle stop:** closed every Go tab in both sessions. Both servers were gone from the snapshot after 59.8 s / 60.8 s, and all recorded PIDs were dead. Re-opening `main.go` restarted gopls (new PID) and F12 worked.
16. **Quit:** recorded the Go descendants of the Electron main PID (gopls + its child gopls), then `closeApp`. Both were gone within 5 s.
17. **Force-kill** (separate launch): `taskkill /PID <main> /F` without `/T`. Both recorded gopls PIDs were gone within 5 s, so no Job object is needed on this machine.
18. **Palette restart → immediate F12** (added check): 3 rounds. Each landed on `shapes.go:24 func Describe` **on the first F12**, in 1.46–1.49 s, with no toast and no message. The PID changed each round (49592→49756→35516→2164), so each round really restarted gopls (`71`).
19. **Restored, never-activated tab** (added check): launch 1 opened `shapes.go` then `main.go` (both pinned) and quit. Launch 2 on the same profile restored both tabs. After selecting the session and the `main.go` tab, Monaco held **no model for `shapes.go`** (models = `["main.go"]`). Shift+F12 on `Describe` → peek lists `shapes.go (1)`, and expanding and selecting it shows `shapes.go` content with `func Describe` in the preview (`82`). Alt+F12 peek definition → preview of `shapes.go` at line 24 with the text rendered (`83`). F12 → activates the **existing** restored tab at `shapes.go:24` with no duplicate tab (tabs: `shapes.go`, `main.go`).

**Negative scenario (gopls missing):** launched with PATH = System32 only, and GOPATH/GOBIN/USERPROFILE/HOME pointed at an empty dir. The snapshot showed the server `absent`, pid null. F12 → exactly **one** toast `Go navigation needs gopls — install with \`go install golang.org/x/tools/gopls@latest\``. A second F12 inside the toast's lifetime did not stack a second toast (checked in aero-dark, aero and neon: `61`–`63`). No error toast. Hover showed nothing. Breadcrumbs were path-only. Ctrl+click was silent. Edit + Ctrl+S saved to disk. The palette still offered "Restart Go language server". TS F12 in the same app worked. No gopls/go process sat under the app.

**Relaunch scenario:** the restore flow in step 19 (tabs persisted across relaunch; nav into a restored tab works without duplicating it).

**Negative controls:** the E12 scenario is the control for "nav lands": the same F12 that lands everywhere else was followed by a caret move, and the caret stayed at `main.go:9` with no new tab for 6 s. The missing-gopls launch is the control for the server-state assertions (snapshot `absent` vs `ready`). Two probe checks failed on their first run and were traced to my probe, not the app (below), which shows the hover and Ctrl+click assertions can fail.

## Findings

No product defects observed on `bc66a6d`.

Observations, none blocking:
- **Cold first nav takes ~34 s** (first run ever on the machine, cold caches). The only feedback is the inline `Go: loading workspace…` plus the "Resolving…" chip. The message is clear and stays for the whole wait. It sits inside the spec's 90 s budget. Worth knowing: on a big repo the first F12 will sit there a long time.
- On a **warm** restart (palette restart → F12), the nav lands in ~1.5 s, usually before any loading message renders. The `12`/`16` captures therefore show the landed state rather than the message. The message itself was observed in the text probe in both themes, and visually in `01`.
- A tab opened by a nav landing sometimes paints **without syntax colouring** for a moment (`02`: `shapes.go` in plain text right after the cold landing). It gains colour within ~5 s. The same delayed colouring happens for TS files opened in the same app (the `b.ts`/`a.ts` token-class probe showed only `mtk1` at t+1.5 s), so it is **not specific to this branch**. Not investigated further, per the directive to drive only this feature.

## What worked

Everything in the Criteria table marked "observed pass", including the path with a space, go.work multi-module, GOROOT targets and navigation from within them, and file-watcher pickup of agent edits.

## Not covered

- **E6 crash/restart budget and the `lsp-crashed` message:** I had no safe way to crash only *this app's* gopls. Killing by PID would have been possible, but I prioritised the added checks and didn't drive it. The fix-round item "exit-before-initialize → crashed" and the "crashed server's watcher closed" item are likewise **not driven**.
- **E13** renderer reload in place, **E14** same file in two windows: not driven.
- **`lsp-loading-timeout` (90 s)** and the ready-but-hung per-request timeout: not driven (would need a stalled gopls).
- **`lsp-no-root`** (Go file outside every project): not driven.
- **Root-marker re-homing** (agent runs `go mod init` / adds `go.work` while tabs are open): not driven.
- Fix-round items "roots confined lexically+realpath" (symlink/junction roots) and "request during ordered stop restarts gopls" (a request landing *inside* the 2 s shutdown window) were not specifically targeted. Palette restart → immediate F12 passed 3/3, which exercises the neighbourhood but not a guaranteed mid-stop race.
- **E9 spawn hygiene** (absolute path, no shell, `GOTOOLCHAIN=local`, stripped relative PATH): not inspected at runtime.
- **Hover link click → external browser:** not clicked (it would open the user's real browser). The link `https://pkg.go.dev/fmt#Println` was observed present.
- Visual baseline: no pre-change build exists to compare against (new surface). Theme screenshots were read for legibility only.

## Environment faults

- **My probe's pointer placement, not the app:** Monaco's measured glyph width (`fontInfo.typicalHalfwidthCharacterWidth` = 7.148 px) differs from the rendered JetBrains Mono width (~7.8 px/char) in this hidden window. A point computed with `editor.getScrolledVisiblePosition` drifts right by about 0.65 px per column. On `a6fd47d`, that made my Ctrl+click on `Square` land on the wrong token and read as a failure. Placing the pointer from the rendered DOM glyph fixed it, and the same Ctrl+click then passed. TS Ctrl+click showed the identical drift. The builder's e2e `pointOn` has the same weakness; it only passes because its targets sit at low columns.
- **Sticky hover in my probe:** moving the mouse diagonally across `shapes.` opened a package hover that then covered the target line, so the `Describe` hover never showed. With a direct pointer move, both hovers appeared. The product behaves the same way (Monaco keeps a hover while the pointer is over it).
- One transient lock wait on the shared heavy.sh lock (other executors' `verify` runs). No effect on results.

## Decisions needed

None from this pass. (Spec §13's open decisions, trust posture and the hover-link route, are not QA's to settle. The hover link is present but was not clicked.)

## Learnings

- `[test/e2e/harness.mjs / goto-matrix.mjs]` Build pointer coordinates from the rendered DOM glyph, not from `getScrolledVisiblePosition`. The measured and rendered char widths diverge in hidden windows, and a mid-line Ctrl+click or hover silently hits the wrong token.
- `[runtime-qa]` Hover probes must move the pointer straight to the target. A diagonal approach triggers an intermediate hover that covers the target line.
- `[none]` A fresh `LOCALAPPDATA` in the launched app's env gives a true cold gopls start (file cache + GOCACHE) without touching the user's own caches.

## Artifacts

- `G:/awby/projects/conduit/.autoloop/evidence/qa-go-lsp-*.png`: 27 captures. 01–17 main pass (01 cold loading message; 03/10/14 implementation peek in aero-dark/aero/neon; 04 references peek; 05/06 hover Describe/Println; 07 GOROOT tab; 08/11/15 breadcrumbs per theme; 09/13 hover aero/neon; 12/16 post-restart landing aero/neon; 17 .py toast). 41, 51, 52: Ctrl+click and hover re-driven with DOM-located pointer. 61–63: missing-gopls toast in each theme. 71: palette restart → F12 landed. 81–83: restored-tab relaunch, references peek into the never-activated tab, peek definition into it.
- Probe logs (main, ctrl, fix, missing, restart, hover, restore) were in the scratch dir and deleted with it. The key lines are quoted above.

---

# Workspace Trust (round 3)

**When:** 2026-09-23
**Build under test:** `G:\awby\projects\conduit-wt-go-lsp`, `feat/go-lsp` @ `c5eea47` (main merged in + Workspace Trust, spec `docs/specs/2026-09-23-workspace-trust.md`). Rebuilt with `npm run build` through heavy.sh (EXIT=0) immediately before driving. The tree had two uncommitted edits, both unit tests (`test/unit/lsp-manager.test.ts`, `test/unit/workspace-trust.test.ts`). They were not mine and they are not part of the app bundle.
**How:** my own probe (not the builder's `go-lsp.e2e.mjs`), hidden, **one app at a time**, each closed via the harness `closeApp`/`cleanup`. Fixtures were in a temp dir and are now deleted:
- `fx\parent\alpha`: a module with 2 packages
- `fx\parent\beta`: a sibling module
- `fx\denied mod`: a module whose path has a space

The user-data dir was fixed across launch A → relaunch B, so the trust store persisted between them. Launch C was a separate profile with gopls hidden. gopls processes were checked only as descendants of the app's own main PID. Nothing was killed. The user's installed Conduit was not touched.
**Themes:** aero-dark, aero, neon. All driven.

**Verdict: Works, no defects.** One keyboard observation below; it isn't specific to Trust.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| T1 | First Go file in an untrusted folder → prompt; no gopls | observed pass: state `restricted`, pid null; **no gopls/go under the main PID**. The prompt reads "Do you trust the authors of the files in this folder?", shows the folder and "Go navigation runs tools from this project (gopls, go list).", and has 3 buttons: Trust / Trust Parent Folder / Don’t Trust | 101 |
| — | F12 before answering | observed pass: toast "Restricted Mode: trust this folder to enable Go navigation." with a **Trust Folder…** action; the caret doesn't move. Ctrl+click is silent | DOM; toast visible in 103 |
| — | Hover / breadcrumb while Restricted | observed pass: hover shows the same sentence as one line; the breadcrumb shows `main.go › Restricted Mode` | 102, 103, 104 |
| — | Toast action "Trust Folder…" | observed pass: the prompt is (re)shown | DOM |
| T2 | Trust → gopls starts, F12 lands; Back/Forward records the Go jump | observed pass: ready in ~1.5 s. F12 `util.Greet` → `util/util.go:4`, Alt+Left → `main.go:6`, Alt+Right → `util.go:4`. Breadcrumbs then show the symbol chain (`util › util.go › Greet`) | A log |
| — | Trust Parent Folder covers a sibling | observed pass: `…\fx\parent` recorded; opening `parent\beta\main.go` raised **no prompt** and gopls started | A log |
| — | Don’t Trust | observed pass: `denied mod` stays `restricted`, pid null, and F12 gives the Restricted toast. Closing and reopening the file raised **no automatic prompt** in that session | A log |
| — | Deny is session-only | observed pass: after relaunch on the same profile, `denied mod` **prompts again** | 131 |
| T3 | Manage Workspace Trust → Remove kills that gopls tree | observed pass: "Manage Workspace Trust" reopens the palette as `>Workspace Trust: Remove` and lists `Workspace Trust: Remove …\fx\parent`. Clicking it killed **all 6 recorded PIDs** (2× gopls + child gopls + conhost, for alpha and beta) within 10 s. Both roots went back to `restricted` and F12 gives the Restricted toast again | 105 |
| — | Trust Current Folder (palette) | observed pass: raises the prompt for the active file's folder. **Trust** (not Parent) recorded only `…\parent\alpha`; alpha → ready, beta stayed `restricted` | A log |
| T4 | Relaunch → trusted folder starts without a prompt | observed pass: the store held `…\parent\alpha`; gopls went ready with no prompt and F12 landed | B log |
| T5 | Renderer can't trust an un-prompted folder | observed pass: `lsp:trustAnswer` with a bogus prompt id → `{ok:false}`; `lsp:trustRequest` for `C:/Windows/System32/x.go` → `{ok:false}`; trusted list still empty | A log |
| — | gopls missing + untrusted | observed pass: state `absent`, **no trust prompt**, F12 → the install toast | 141 |
| — | Quit (both launches) | observed pass: every recorded gopls/go descendant (incl. a `go.exe`) was gone within 5 s | A/B logs |
| — | Screen-reader semantics | observed pass (DOM): the prompt has `role="dialog"`, `aria-modal="false"`, `aria-live="polite"`, and `aria-labelledby` points at the question heading. The buttons are real `<button>`s with titles ("Trust everything under <parent>", "Stay in Restricted Mode: no language server runs here"). The toast has `role="status"` | A log |
| — | Keyboard operation | observed pass with one caveat: from the tab strip, **2 Tab presses** reach the Trust button, and **Enter on a focused "Trust Parent Folder"** answers the prompt. Caveat below | A log |

**Keyboard caveat (observation, not a Trust defect):** the prompt doesn't take focus when it appears. That is by design: it is non-modal. From inside the Monaco editor, Tab and Shift+Tab stay in the editor, which is Monaco's standard behaviour (Ctrl+M toggles Tab focus mode). So a keyboard user who is typing needs to leave the editor first, for example via the tab strip, to reach the prompt. Nothing in the prompt is mouse-only once it has focus.

**Visuals** (read, all three themes):
- The prompt is a card above the editor with the primary "Trust" button accented and legible in each theme (`101` aero-dark, `103` aero, `104` neon; neon uppercases the buttons).
- The folder path is truncated with an ellipsis in the card. The full path is on the Trust Parent button's tooltip, and in the prompt's `title`.
- The "Restricted Mode" breadcrumb is tinted as a warning in each theme.
- The Restricted toast was captured on screen in aero (`103`). In aero-dark and neon it was confirmed in the DOM, but it had already been dismissed when the screenshot was taken.

**Not covered (Trust):**
- Clicking the "Restricted Mode" breadcrumb segment to re-raise the prompt (its handler exists; not clicked).
- Two prompts queued at once ("only one shows at a time").
- A trust decision when the workspace root is a symlink or junction.
- A real NVDA/Narrator pass. Screen-reader semantics were checked from the DOM only.
- Trust across multiple windows.

**Evidence:** `G:/awby/projects/conduit/.autoloop/evidence/qa-go-lsp-101…105-trust-*.png`, `qa-go-lsp-131-trust-relaunch-denied-prompts-again.png`, `qa-go-lsp-141-trust-missing-untrusted-install-toast.png`. The probe and its logs lived in the scratch dir, which has been deleted; the key lines are quoted above.
