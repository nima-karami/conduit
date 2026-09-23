# Runtime QA · target=_blank links open an in-app web tab

**When:** 2026-09-23
**Tier:** FULL, because the change touches the host security gate (popups enabled for web guests) and needs a negative matrix
**Artifact:** desktop app (Electron dev build, `out/`)
**Build under test:** conduit at `G:\awby\projects\conduit-wt-web-blank-link` `feat/web-blank-link` @ `4745bf8` (clean tree; `npm run build` EXIT=0 before the runs)
**Build identity confirmed from the running artifact:** the running app's webContents list shows `file:///G:/awby/projects/conduit-wt-web-blank-link/out/index.html`, and the freshly built `out/main.js` / `out/webview.js` contain the new `web:openTab` message, which main does not have. The foreground opens seen below can't happen on main, where popups are disabled.
**Environment:** Playwright-Electron through the repo harness (`launchApp` → `runScenario`), `CONDUIT_E2E=1` (hidden window). Real input goes in with `webContents.sendInputEvent` on the guest, from the main process. Local fixture served on `http://127.0.0.1:<ephemeral>` (run 1 used port 60220).
**Isolation:** a harness throwaway `--user-data-dir` (`%TEMP%\conduit-ud-*`) per run; the preview fixture root is `%TEMP%\conduit-qa-wbl-*`; probe scripts are in `%TEMP%\claude-scratch\qa-web-blank\` (deleted).
**Configurations driven:** Windows, default theme, one window. Themes are not in scope (no UI change).
**Teardown:** yes. Each app was closed through the harness `closeApp` / `shutdownApp` (by handle, with a PID-scoped fallback). The fixture server was closed and the scratch dir removed.

**The branch moved during this pass.** `out/` was built at 07:19 from `4745bf8`. At 07:23–07:25 another agent committed `fc9d265` (the system-browser route now also needs a fresh real gesture), `f27e051` (a held Enter no longer re-arms the gate), `b09e988` and `544ccf9` on top, and left an uncommitted edit to `test/e2e/web-blank-link.e2e.mjs`. **This report covers `4745bf8` only.** The `src/webview-guard.ts` changes in `fc9d265`/`f27e051` were not driven. Row 12 (a real Ctrl+click goes external) should still hold under `fc9d265`, but that is not measured.

## Scope

In a real running app, check every locked behaviour in spec `docs/specs/2026-09-23-web-blank-link.md` (AC1–AC5, and AC6 from the user's side) and the extra cases the conductor listed: a button's `window.open`, a delayed `setTimeout` open, two opens from one click handler, a `mailto:` `_blank`, a form with `target=_blank`, and a `_blank` link inside an iframe. Also check that HTML-preview (`conduit-preview:`) guests are unchanged. I wrote my own probe with its own fixture pages. I did not reuse the builder's `web-blank-link` / `middle-click-web` scenarios, only the shared harness and fixture helpers (`clickGuest`, `tabInfo`, `openWebTab`, `serveHtml`, `spyMain`).

For every step the probe recorded: the tab list before and after, the active tab, its preview flag, the `shell.openExternal` spy calls (recorded, not passed through), the `BrowserWindow` count, and the total webContents count (to catch a hidden popup webContents).

## Verdict

`Clean`. Every in-scope behaviour was observed as intended. No extra window or stray webContents appeared at any step.

## Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| AC1 | Real left-click on `_blank` http link → exactly one new web tab, active, not preview, openExternal 0 | observed pass (tabs 1→2, active `QA a`, preview false, ext [], windows 1→1) | `.autoloop/evidence/qa-web-blank-01-left-click-blank.png` |
| AC2 | Real middle-click → background tab | observed pass (tabs 6→7, `QA h` added, active stayed `QA Host Page`, ext []) | `qa-web-blank-05-middle-click.png` |
| AC3 | Real Ctrl+click → openExternal once, no tab | observed pass (ext `["http://127.0.0.1:60220/g"]`, tabs 6→6) | run-1 log |
| AC4 | Script `window.open(u)`, `window.open(u,'x','width=300')`, `a.click()` with no real gesture → no tab, ext 0, no window | observed pass for all three, and also for script `form.submit()` with `target=_blank` (tabs 1→1, ext [], windows 1→1, webContents 2→2) | run-1 log |
| AC5 | Real Enter on a focused `_blank` link → one new active tab | observed pass (tabs 1→2, active `QA g`) | `qa-web-blank-09-enter-new-tab.png` |
| AC6 | Preview guests unchanged | observed: behaviour matches the pre-existing preview branch (see below). Not compared against a main build. | `qa-web-blank-07-preview.png`, `-08-preview-after.png` |
| — | One gesture → at most one tab | observed pass (a button that calls `window.open('/c');window.open('/d')` gave exactly `QA c`, no `QA d`) | run-1 log |
| — | mailto:/non-http `_blank` → nothing | observed pass (tabs 4→4, ext [], active stayed host) | run-1 log |

## What happened

Run 1 (`probe.mjs`) had one session on the worktree and one web tab at `http://127.0.0.1:60220/` (guest viewport 790×713). The rows are 60 px blocks, clicked at x=40.

| # | Action | Tabs | Added | Active (preview?) | openExternal | Windows / webContents |
|---|---|---|---|---|---|---|
| 1 | script `window.open('/b')`, no gesture | 1→1 | – | Host (no) | 0 | 1→1 / 2→2 |
| 2 | script `a.click()` on `_blank` | 1→1 | – | Host | 0 | 1→1 / 2→2 |
| 3 | script `window.open('/b','x','width=300,height=200')` | 1→1 | – | Host | 0 | 1→1 / 2→2 |
| 4 | script `form.submit()` (`target=_blank`) | 1→1 | – | Host | 0 | 1→1 / 2→2 |
| 5 | real left-click `_blank` → `/a` | 1→2 | QA a | **QA a** (no) | 0 | 1→1 / 2→3 |
| 6 | same click again, `/a` already open | 2→2 | – | QA a (existing tab re-activated, no duplicate) | 0 | 1→1 / 3→3 |
| 7 | real left-click button `onclick=window.open('/b')` | 2→3 | QA b | **QA b** | 0 | 1→1 / 3→4 |
| 8 | real left-click button that opens `/c` then `/d` | 3→4 | QA c only | **QA c** | 0 | 1→1 / 4→5 |
| 9 | real left-click `mailto:` `_blank` | 4→4 | – | Host | 0 | 1→1 / 5→5 |
| 10 | real left-click form submit `target=_blank` → `/e?q=1` | 4→5 | QA e | **QA e** | 0 | 1→1 / 5→6 |
| 11 | real left-click `_blank` link inside an iframe → `/f` | 5→6 | QA f | **QA f** | 0 | 1→1 / 6→7 |
| 12 | real Ctrl+click `_blank` → `/g` | 6→6 | – | Host | **1** (`/g`) | 1→1 / 7→7 |
| 13 | real middle-click plain link → `/h` | 6→7 | QA h | Host (background) | 0 | 1→1 / 7→8 |
| 14 | real left-click button that opens `/late2` via `setTimeout` 1 s later | 7→7 | – | Host | 0 | 1→1 / 8→8 |
| 15 | real left-click on inert pad, then script `window.open('/b')` 100 ms later | 7→7 | – | **QA b** (already-open tab activated) | 0 | 1→1 / 8→8 |
| 16 | real Enter on a focused `_blank` → `/a` (already open) | 7→7 | – | QA a (activated) | 0 | 1→1 / 8→8 |
| 17 | real Space on a focused `window.open` button | 7→7 | – | Host | 0 | 1→1 / 8→8 |
| 18 | open `/timer` page, which calls `window.open('/late')` 1 s after load | 7→8 | only the timer tab itself | Timer page | 0 | 1→1 / 8→9 |

Run 2 (`probe2.mjs`, fresh app and profile):

| # | Action | Tabs | Added | Active | openExternal |
|---|---|---|---|---|---|
| 19 | real Enter on a focused `_blank` → `/g` (new URL) | 1→2 | QA g | **QA g** (no) | 0 |
| 20 | real Enter on a focused `window.open('/b')` button | 2→3 | QA b | **QA b** | 0 |
| 21 | real Shift+click on `_blank` → `/a` (spec D1) | 3→4 | QA a | **QA a** | 0 |

The final webContents list in run 1 has exactly one `webview` per tab plus the app window. No `/d`, `/late`, `/late2` or popup webContents exists.

HTML preview (run 1, a second session on a temp root, `page.html` opened from Files as `conduit-preview://<token>/page.html`):

| Action | Result |
|---|---|
| real left-click `_blank` → `./other.html` | nothing. Guest stays on page.html, tabs 1→1, ext 0 |
| real left-click `_blank` → http | nothing, ext 0, no blocked bar |
| real left-click button `window.open('./other.html')` | nothing |
| script `window.open(http)` | nothing |
| real Ctrl+click `_blank` → http | no tab, ext 0. The allow bar appears: "This page wants to load resources from 127.0.0.1." (the existing `gateExternal`/`notifyBlocked` path) |
| real middle-click `_blank` → `./other.html` | guest navigates in place to `conduit-preview://…/other.html` (the existing preview `loadURL` branch). No tab, no window |

Why this is "exactly as on main", by inference rather than measurement: on main no `<webview>` sets `allowpopups`, so `disablePopups` is already `true` for preview guests. The branch now forces the same value from the host, and the preview arm of `setWindowOpenHandler` is byte-identical in the diff. Left-click, button and script opens are dropped by Chromium before the handler (spec M1/M5/M6). The modifier and middle opens reach the unchanged preview arm, and that is what I observed.

**Negative scenario:** rows 1–4, 9, 14, 15-timing, 17 and 18. Opens with no gesture or a stale one, and non-http opens, produced no tab, no openExternal and no window.
**Relaunch scenario:** not applicable. The feature persists nothing new; the web tabs it creates use the existing docs persistence, which this pass did not re-verify.
**Negative controls:** the same probe, with the same spies and counters, reported positive changes where they belong: +1 tab (rows 5, 7, 8, 10, 11, 13, 19–21), openExternal = 1 (row 12), and an active-tab change with no count change (rows 6, 15, 16). So the "nothing happened" rows are measured zeros, not a blind probe.

## Findings

None blocking. Observations for the record:

### 1. Any real click (even on inert page content) arms a 300 ms open window for page script (by design)

**Severity:** latent (by design, per spec L2 / §3)
Row 15: a real click on a plain `<div>`, then `window.open('/b')` from script 100 ms later, was honoured. `/b` was already open, so it re-activated that tab; an unopened URL would have become a new foreground tab. This is the browser-standard "popup allowed in a click handler" semantics, bounded to http(s), one open per gesture, and never the system browser. I'm recording it so nobody reads it as a leak later.

### 2. Space on a focused button does not count as a gesture (spec D2 gap, now measured)

**Severity:** degrades it (keyboard-only users)
Row 17: Space on a focused `window.open` button opened nothing. Enter on the same button (row 20) did. This matches the gap D2 accepts; the spec listed it as "unmeasured", and it is now measured.

## What worked

The left-click foreground tab, Enter, button `window.open`, form `target=_blank` submit, `_blank` inside an iframe, Shift+click (D1), middle-click background, Ctrl+click external, re-clicking an already-open URL re-activating instead of duplicating, and one-open-per-gesture. Every no-gesture path, the 1 s delayed opens and `mailto:` were denied. Popups were never real windows (BrowserWindow count stayed 1 throughout), and preview guests were untouched.

## Not covered

- **Branch tip `544ccf9`.** The `webview-guard.ts` fixes `fc9d265` (external route gated on a fresh gesture) and `f27e051` (held Enter) landed after the build and were not driven. Re-running this probe against a fresh build of the tip is the cheap follow-up.

- **A side-by-side run against a main build** for preview guests. Equivalence is argued from the diff plus the observed behaviour matching the unchanged branch. I didn't build main, to avoid touching the main checkout's `out/`.
- **Session ownership with two sessions whose tab strips differ.** Tabs landed in the displayed session's strip. I did not switch to the other session to confirm the new tabs are absent there.
- **A physical mouse/keyboard.** Input came through `sendInputEvent` (the spec's own measurement path), not OS-level input.
- **The Retry-guest race** (an open landing before a retried guest re-adopts its id), and **a busy renderer** pushing a genuine click's open past 300 ms.
- **Relaunch persistence** of tabs opened this way.
- **Themes / visual review:** no UI change. The screenshots were only read for tab state.

## Artifacts

- `G:/awby/projects/conduit/.autoloop/evidence/qa-web-blank-00-host.png`: the fixture host page
- `…-01-left-click-blank.png`: after the real left-click, `QA a` is active and its URL `/a` is in the address bar
- `…-02-button-window-open.png`, `-03-form-submit.png`, `-04-iframe.png`: the new active tabs for rows 7, 10, 11
- `…-05-middle-click.png`: the host tab is still active after a middle-click; the tab strip holds the background tab
- `…-06-final.png`: the final state of run 1
- `…-07-preview.png`, `-08-preview-after.png`: the preview guest before and after the modifier/middle probes
- `…-09-enter-new-tab.png`: Enter on `_blank` → `QA g` active
- The per-row numbers above are copied from the probe's `RESULT` log lines (the scratch logs are deleted).

Round 1 handoff (superseded by Round 2 below): VERDICT pass on `4745bf8`.

---

# Round 2 · tip `617b2a0`

**Build under test:** `feat/web-blank-link` @ `617b2a0` (clean tree). `npm run build` EXIT=0 through `heavy.sh`, rebuilt after HEAD reached `617b2a0`. HEAD was still `617b2a0` after the runs. The tip adds `fc9d265` (the system-browser route for a `background-tab` open now needs a fresh real gesture, and spends it) and `f27e051` (auto-repeat `Enter` no longer re-arms the gate).
**Identity from the running artifact:** the webContents list shows `file:///G:/awby/projects/conduit-wt-web-blank-link/out/index.html`. The fresh `out/main.js` contains `isAutoRepeat`, which `4745bf8` does not have.
**Driving:** same method as round 1: harness `runScenario`, `CONDUIT_E2E=1` (hidden), real `sendInputEvent` into the guest, `shell.openExternal` spied. Held Enter was sent as one `rawKeyDown` plus 8 `rawKeyDown`s with `modifiers:['isAutoRepeat']`, then `keyUp`. Run A is the full table (`qa-web-blank-r2-*.png`). Run B is a fresh app that isolates one anomaly (note 3).
**Teardown:** both apps closed via the harness; fixture server closed; scratch probe dir and preview temp root deleted.

## Round-1 table re-run on the tip (run A)

| Action | Tabs | Added / active | openExternal |
|---|---|---|---|
| script `window.open`, `a.click()`, popup-features `window.open`, `form.submit()`, script-dispatched Ctrl-click on `_blank` (no real gesture) | 1→1 each | – / Host | 0 each |
| real left-click `_blank` /a | 1→2 | QA a / **QA a** (not preview) · `qa-web-blank-r2-01-left-click-blank.png` | 0 |
| same click, /a already open | 2→2 | – / QA a re-activated | 0 |
| real left-click button `window.open('/b')` | 2→3 | QA b / **QA b** | 0 |
| real left-click button `window.open('/c');window.open('/d')` | 3→4 | QA c only / **QA c** | 0 |
| real left-click `mailto:` `_blank` | 4→4 | – / Host | 0 |
| real left-click form `target=_blank` | 4→5 | QA e / **QA e** | 0 |
| real left-click `_blank` in iframe | 5→6 | QA f / **QA f** | 0 |
| real Ctrl+click `_blank` /g | 6→6 | – / Host | **1** (`/g`) |
| real Ctrl+click `mailto:` `_blank` | 6→6 | – / Host | **1** (`mailto:qa@example.com`), see note 2 |
| real middle-click plain link /h | 6→7 | QA h / Host stays active | 0 |
| real click, page `window.open` 1 s later | 7→7 | – | 0 |
| real Shift+click `_blank` /a (already open) | 7→7 | – / QA a re-activated | 0 |
| real Space on focused `window.open` button | 7→7 | – (the D2 gap, unchanged) | 0 |
| real Enter on focused `_blank` /g (new URL) | 12→13 | QA g / **QA g** | 0 |
| `/timer` page, `window.open` 1 s after load | 13→14 | only the timer tab itself | 0 |

BrowserWindow count was 1 at every step. The final webContents list is one `webview` per tab plus the app window: no /d, /x2, /late, /late2, /s400, /m1, /m3 or /t1 guest.

## Security cases

| # | Case | Expected | Observed | Result |
|---|---|---|---|---|
| S1 | real **Ctrl+click** on a button whose handler calls `window.open('/x1');window.open('/x2')` | openExternal exactly 1, no tab | openExternal `["…/x1"]` (1), no tab (run A); again 1, no tab (run B) | pass |
| S2 | real **middle-click** on that button | ≤1 background tab, openExternal 0 | no tab, openExternal 0. A middle-click on a button fires no `click`, so the page never calls `window.open` | pass (nothing opens) |
| S2b | real **middle-click** on a `_blank` link with `onauxclick=window.open('/m2')` and `onclick=window.open('/m3')` | one background tab, openExternal 0 | tabs 7→8, `QA m2` added in the background, Host stays active, openExternal 0. The link's own `/m1` open was denied (gesture spent) · `qa-web-blank-r2-02-middle-auxlink.png` | pass |
| S2c | real **left-click** on the two-open button (run B, fresh) | one foreground tab | tabs 1→2, `QA x1` active, no x2, openExternal 0 | pass |
| S3 | real **Ctrl+click on plain page text** whose `onclick` calls `window.open('/t1')` | ≤1 external | openExternal `["…/t1"]` (1), no tab | pass (note 1) |
| S3b | real Ctrl+click on `_blank` link /m1 with `onclick=window.open('/m3')` | ≤1 external | openExternal `["…/m3"]` (1). The link's own /m1 was not sent. No tab | pass (the page's open wins, spec §4) |
| S4 | real click, then page open **50 ms** later | allowed once | `QA s50` foreground tab | pass |
| S4 | real click, then page open **200 ms** later | allowed once | `QA s200` foreground tab | pass |
| S4 | real click, then page open **400 ms** later | denied | no tab, openExternal 0 | pass |
| S4b | real click, then **two** script opens ~100 ms later | one | one tab (`/s50x`). The second open (`/s200`, already open) did not even re-activate its tab | pass |
| S5 | **held Enter** (1 + 8 auto-repeats) on a focused `_blank` /k | exactly one tab | tabs 11→12, `QA k` active, openExternal 0 · `qa-web-blank-r2-03-held-enter.png` | pass |
| S5b | held Enter on a focused `window.open('/b')` button (/b already open) | no new tab | tabs 12→12, existing QA b re-activated | pass |

## HTML preview on the tip (run A)

Same as round 1. Left-click `_blank` (local and http), button `window.open` and script `window.open` do nothing: the guest stays on `page.html`, no tab, openExternal 0. Real Ctrl+click on an http `_blank` shows the existing "This page wants to load resources from 127.0.0.1." bar with openExternal 0. Real middle-click on a local `_blank` loads `other.html` in the same preview guest. No tabs, windows or external calls. `qa-web-blank-r2-05-preview-after.png`.

## Round-2 notes

1. **A real Ctrl+click anywhere lets the page send one page-chosen URL to the system browser** (S3). This is the spec's residual D4: one open, spent, and only within 300 ms of a real click. Main sent every `background-tab` open external with no gesture check, so this is narrower than main, not new reach.
2. **Ctrl+click on a `mailto:` link sends it to the system mail handler.** This is the pre-existing Ctrl+click → external path, now gated on a real gesture, and `openExternalUrl`'s scheme allowlist admits `mailto:`. A plain left-click on a `mailto:` `_blank` still does nothing, which matches the spec. I'm calling it consistent with L1, not a defect.
3. **Test artifact, not a product defect: a left-click right after a middle-click on non-link content of a scrollable page is swallowed.** In run A, the left-click on the two-open button right after S2's middle-click opened nothing. Run B isolated it. On a scrollable page (scrollHeight 748 > viewport 713), middle-click on a button, then left-click on `window.open('/b')`: nothing. The same left-click again: `QA b` opens. On a non-scrollable page, middle-click then left-click opens at once. That is Chromium's Windows middle-click autoscroll, where the next click only exits autoscroll. The click never produces an open, so the gate isn't involved.

## Round-2 not covered

- A main-build side-by-side for preview guests (argued from the diff, as in round 1).
- Two-session ownership switch; physical OS input (`sendInputEvent` only); the Retry-guest race; a busy renderer pushing a genuine click's open past 300 ms; relaunch persistence of the opened tabs.
- Ctrl+click external with a **stale** gesture. A real Ctrl+click produces its open in the same frame, and page script can't synthesize a `background-tab` (the script-dispatched Ctrl-click above opened nothing), so it can't be driven from real input. It is covered only by the unit tests.

```
QA: G:/awby/projects/conduit/docs/runs/2026-09-22-feedback-batch/qa/web-blank-link.md
BUILD_UNDER_TEST: feat/web-blank-link@617b2a0
VERDICT: pass
NOT_COVERED: main-build side-by-side for preview guests; two-session ownership switch; physical OS input; Retry-guest race / busy-renderer >300 ms; relaunch persistence of opened tabs; stale-gesture Ctrl+click external (not drivable by real input)
```
