# Runtime QA — Review as a mode

**When:** 2026-09-05, 20:15–21:20 EDT
**Tier:** FULL (multi-surface, layout persistence, relaunch, theme matrix)
**Artifact:** desktop app (Electron), driven hidden via Playwright-Electron

**Build under test:** `conduit` `review-mode` @ `e551a38` (`G:\awby\projects\conduit`).
Tree was **clean** at `git rev-parse` / `git status --short` time and `npm run build` (exit 0)
was run before the first launch.
Confirmed the running app is that build three ways:

1. DOM features that exist only on this branch were present on every launch — `.review__head`
   containing `.review__source` + `.review__scope` (moved off `.tabbar__trail`), `.review__actionbar`,
   and `.rnav` in the right pane. The pre-`review-mode` build renders the source trigger on the
   doc-tab row and has no `.rnav`.
2. `out/webview.js` was hashed before and after each run
   (`0a81ebb0e8480e9d34b42181999c9723813c8aaff5ded6783cf1e0ad86020c3b`) and was unchanged for the
   two runs that used the repo checkout.
3. `app.getVersion()` = `0.37.0`.

**Environment:** Windows 11 Pro 10.0.22621, Node v24.18.0, Electron from the repo's `node_modules`,
Playwright `_electron`, windows launched hidden (`CONDUIT_E2E=1` ⇒ `show:false`).

**Isolation:** every launch got its own throwaway `--user-data-dir` under `%TEMP%`
(`conduit-qa-ud-*`, `conduit-qa2-ud-*`, `conduit-iso-ud-*`) and its own throwaway git fixture repo
(`conduit-qa-repo-*` etc.). One app instance at a time; never more than one Electron alive.
No process was ever killed by image name — every app was closed through the harness's
`closeApp`/`shutdownApp` by handle.

> **Concurrency hazard, recorded because it changed how this pass was run.** At ~20:31 another
> session began editing the very files under test (`webview/components/review-view.tsx`,
> `right-pane.tsx`, `review-navigator.tsx`, `app.tsx`, `center-pane.tsx`, `diff-viewer.tsx`,
> several e2e files) in the same checkout, and at 20:37 it rebuilt `out/`. `out/webview.js` changed
> hash mid-run. Steps that had already completed (evidence `01`–`23`) are on the verified
> `e551a38` bundle — the hash was re-checked before and after those runs and did not move. For
> everything after that point the `e551a38` tree was exported read-only with
> `git archive e551a38 | tar -x` into `%TEMP%\claude-scratch\review-mode-qa\build-e551a38`,
> `node_modules` junctioned in, and built there (`node esbuild.mjs`, exit 0,
> `f428809dbca6da03d4c231fd7f65ebe8df282099fef6f1036fcf61b254d1d910`, verified unchanged across
> every later run). Evidence `24`–`45` is from that isolated build. Three screenshots taken while
> the bundle hash was in flux were **deleted rather than reported**. No git state was touched
> (`git archive` only); no `npm install` was run.

**Configurations driven:** theme `aero-dark` (default), `aero`, `neon`. Working-tree source,
commit source, zero-file repo, 150-file repo. Right pane collapsed / visible-on-Files /
visible-on-Changes. Cold relaunch on the same profile.

**Teardown:** ran. Every app closed via `cleanup()`/`shutdownApp` by handle; a post-run
`Win32_Process` sweep for QA-owned `electron.exe` returned none. The isolated build tree's
`node_modules` junction was removed with `rmdir` **before** deleting the tree (worktree-junction
hazard), and the repo's `node_modules` was verified intact afterwards (510 entries, `electron`
present). All `%TEMP%` fixture repos, profiles and the scratch dir were removed; the driver
scripts were copied into the evidence folder first. Nothing was written inside the repo except
this report and the gitignored `.autoloop/evidence/` tree.

## Scope

Drove the user-facing acceptance criteria of `docs/specs/archive/2026-09-05-review-mode.md`
§7.1 (numbered AC-1…AC-14 in spec order) and §7.2 against the running desktop app: entry and
header composition, review-mode on/off and the right-pane auto-open/restore contract, the pane
navigator (pick / follow / hover actions / stage / reviewed), source picker and commit scope,
`Compare refs…`, `Open side-by-side` and its no-side-effect rule, the zero-file state, Board
view, a cold relaunch, three themes, plus hover/focus states and two deliberate negative
controls.

## Verdict

**fail** — two in-scope behaviors were observed broken: the Review tab does not survive a
restart (spec §4 "Restart with Review as the active doc"), and the header panel toggle opens the
pane on the *persisted* tab instead of Changes when the pane was collapsed (spec §2.2). Every
other in-scope criterion was observed working.

## Criteria

Evidence paths are relative to `.autoloop/evidence/2026-09-05-review-mode/qa/`.

| # | Criterion (§7.1, in order) | Result | Evidence |
|---|---|---|---|
| AC-1 | Review mode on ⇒ Changes tab renders the review navigator | observed pass | `02`, `18`; `results-main.json` `AC-1`, `AC-1.return` |
| AC-2 | Review mode off ⇒ Changes tab renders the ordinary status list | observed pass | `14` (Board view), `12` (diff tab active); `results-main.json` `AC-2` |
| AC-3 | Mode on + pane collapsed ⇒ open pane, select Changes, don't write `rightPaneTab` | observed pass | `01`→`02`; `results-main.json` `AC-3.open`, `AC-3.tab`, `AC-3.nowrite` (`files`→`files`); `17` (pane already visible on Files ⇒ Changes selected) |
| AC-4 | Review doc closed + `autoOpenedExplorer` set ⇒ collapse the pane | observed pass | `08`; `results-main.json` `AC-4` |
| AC-5 | Any user visibility toggle clears `autoOpenedExplorer` | observed pass | `09`; `results-main.json` `AC-5` |
| AC-6 | Commit / range source ⇒ scope segment buttons carry `disabled` | observed pass | `10`, `20`; `results-probe.json` `AC-6` (`[true,true,true]`), `AC-6.title`, `AC-6.reenable` |
| AC-7 | More rows than fit ⇒ only rows near the viewport mounted | observed pass | `28`; `results-iso.json` `AC-7` — 42 of 150 rows mounted, 3564px bottom spacer |
| AC-8 | Doc-tab row renders no source trigger, scope segment or Compare button | observed pass | `02` (tab row shows only the session tab + `Review Changes`); `results-main.json` `AC-8.a/b/c` |
| AC-9 | Header renders source, scope, diffstat, meter, find, overflow — regardless of pane visibility | observed pass | `02`, `results-main.json` `AC-9.*` incl. `AC-9.indep` (asserted with the pane collapsed) |
| AC-10 | Navigator row activation scrolls the card into view and expands it | observed pass (pointer only) | `04`; `results-main.json` `AC-10`, `AC-10.expand`. Enter/Space activation **not reached** |
| AC-11 | Card anchor change marks the anchored row active | observed pass | `results-main.json` `AC-11.pick`, `AC-11.follow` (`newfile.tsx` → `alpha.ts` on scroll) |
| AC-12 | `Open side-by-side` opens the diff side-by-side and does not write `diffSideBySide` | observed pass | `12`, `13`; `results-main.json` `AC-12.opens`, `AC-12.nowrite` (`true`→`true`), `AC-12.again` |
| AC-13 | `Compare refs…` opens the Compare dialog | observed pass | `11`; `results-main.json` `AC-13`, `AC-13.focus` (focus returns to `.review__source`) |
| AC-14 | Zero files ⇒ the action bar does not render | observed pass | `27`; `results-iso.json` `AC-14`, `AC-14.head`, `AC-14.noChanges`, `AC-14.nav` |

### Extra scenarios from the brief

| Scenario | Result | Evidence |
|---|---|---|
| Entry: `.review__head` holds source/scope/sub/meter/find/more; `.review__actionbar` holds stageall/send/barmore | observed pass | `02`; `results-main.json` `AC-9.*`, `BAR.*` |
| Navigator row count = changed files (7 = `git status --porcelain`) | observed pass | `results-main.json` `ROWS` |
| Hover an unstaged row ⇒ Stage + Discard at opacity 1; Stage moves it under `Staged` | observed pass | `05`, `06`, `39`; `results-main.json` `NAV.hover`, `NAV.stage` |
| Reviewed checkbox ⇒ card `Mark reviewed` pressed + meter increments | observed pass | `07`; `results-main.json` `NAV.reviewed` (`0 / 7` → `1 / 7`) |
| Source picker lists Working tree, pinned rows, commits, `Compare refs…` last | observed pass | `19`; `results-probe.json` `PICK.*` |
| Commit source ⇒ flat navigator, no section labels, no row actions, handoff-only action bar | observed pass | `20`; `results-probe.json` `NAV.flat`, `NAV.noRowActions`, `BAR.commit` |
| Board view ⇒ `.rnav` gone, ordinary `.change` rows present; back ⇒ `.rnav` returns | observed pass | `14`; `results-main.json` `AC-2`, `AC-1.return` |
| **Header panel toggle, collapsed ⇒ opens the pane on Changes** | **observed fail** | `03`; `results-main.json` `PANEL.collapsed.opensOnChanges` — see Finding 2 |
| Header panel toggle, visible-on-Files ⇒ selects Changes; visible-on-Changes ⇒ `aria-pressed` | observed pass | `results-main.json` `PANEL.files.label`, `PANEL.files.selectsChanges`, `PANEL.changes.pressed` |
| **Relaunch on the same profile ⇒ Review restored active, pane on Changes** | **observed fail** | `24`–`26`, `44`, `45`; `results-iso.json` `RELAUNCH.*`, `results-restore2.json` — see Finding 1 |
| Theme `aero` | observed pass | `29`–`32`, `styles-aero.json` |
| Theme `neon` | observed pass | `33`–`36`, `styles-neon.json` |
| Focus ring on panel / source / find / ⋯ / Stage all / navigator row (real Tab focus) | observed pass | `37`; `results-iso.json` `A11Y.focusring` |
| Negative controls | both reported failure as intended | `results-main.json` `NEGCTL.1`, `NEGCTL.2` |

## What happened

1. **Fixture.** A git repo with 2 commits and 7 working-tree changes: staged `beta.ts`,
   `epsilon.json`; unstaged `alpha.ts`, `gamma.md`, `zeta.css`, deleted `delete-me.txt`; untracked
   `newfile.tsx`. Row counts were asserted against `git status --porcelain`, not hard-coded.

2. **Entry & header** (`01` → `02`). Right pane collapsed with `Control+Shift+E`, then
   `Control+Shift+R` after clicking `.topbar__logo` (a fresh session focuses the terminal, which
   swallows the shortcut). The pane opened on **Changes 7**, the navigator listed exactly 7 rows
   under `Staged` / `Changes`, and the header read `7 files · +10 −46` with a `0 / 7` meter.
   `.tabbar__trail` held no `.review__source`, `.review__scope` or Compare control. Action bar:
   `⋯`, `Copy as markdown`, `Stage all`. Collapsing the pane again left the header and action bar
   fully intact (AC-9's "regardless of pane visibility").

3. **Panel toggle, three states** (`03`). From collapsed the button's `aria-label` is
   `Show changes panel` — correct. Clicking it opened the pane **on the Files tab**, showing the
   file tree, with `rnav=false, rows=0`. Screenshot `03` shows the file tree in the pane while the
   Review header is still on screen. A second click then selected Changes correctly, and the
   visible-on-Changes state reported `aria-pressed="true"` / `Hide changes panel`. See Finding 2.

4. **Navigator** (`04`–`07`, `39`). Clicking the last row scrolled `newfile.tsx`'s card inside
   `.review__scroll` and left its chevron open; the row went `--active` with `aria-current`.
   Scrolling the card list back to the top moved the active row to `alpha.ts` on its own.
   Hovering the first unstaged row revealed `Stage` and `Discard` at computed opacity `1`;
   clicking `Stage` moved `alpha.ts` under the `Staged` header. Ticking a row's checkbox drove the
   meter `0 / 7` → `1 / 7` and set the card's `Mark reviewed` to `aria-pressed="true"`. `39` shows
   the hover treatment on a staged row (ring + `Unstage` swapped in for the stat).

5. **Close / restore / ownership** (`08`, `09`). With `rightPaneTab` persisted as `files`, opening
   and closing Review left it `files` — review mode never wrote the setting. Closing the Review tab
   collapsed the pane it had auto-opened. After `Control+Shift+E` twice mid-review, closing Review
   left the pane visible.

6. **Scope & source** (`19`, `10`/`20`, `11`, `21`). The picker listed `Working tree`, one pinned
   row (`Last commit …`), two commit rows and `Compare refs…` as the final action row. Selecting
   the base commit put `2bee0b6 base: six files` in the trigger, disabled all three
   `[data-seg]` buttons (wrapper `title` = "A commit or comparison has no staged / unstaged split"),
   turned the navigator into a flat 6-row list with the caption
   `Reviewing commit 2bee0b6: base: six files` and **no** row actions, and reduced the action bar to
   the handoff button alone. `Compare refs…` opened the modal; `Cancel` returned focus to
   `<button class="gh__reffilter review__source">`. Returning to `Working tree` re-enabled the scope
   segment, restored `Stage all` and brought the `Staged` / `Changes` sections back.

7. **Side-by-side** (`12`, `13`). `diffSideBySide` was `true` in this profile; clicking a card's
   `.rcard__sbs` (`aria-label="Open side-by-side diff"`) opened the `alpha.ts` diff tab with two
   panes and the toolbar offering `Inline view`, and the setting was still `true` afterwards.
   Toggling the tab to inline flipped the *global* setting to `false` (as the spec intends), and
   re-activating `Open side-by-side` from the Review card brought the tab back to side-by-side —
   the doc-level override still winning over a `false` global.

8. **Zero files** (`27`). A clean 2-commit repo: header present with `Working tree`, the scope
   segment, `No changes`, no meter; **no `.review__actionbar`**; navigator empty state
   ("No changes / Nothing to review for this source"); card area "Nothing to review".

9. **Windowing** (`28`). 150 changed files ⇒ header `150 files · +150 −0`, navigator header
   `150 changes`, but only **42** `.review__navrow` elements mounted with a 3564px bottom spacer.

10. **Board view** (`14`). Switching to the Feature Board removed `.rnav` and left 7 ordinary
    `.change` rows in the Changes tab; switching back to Editor restored the navigator.

11. **Relaunch** (`24`–`26`, `44`, `45`). Covered in Finding 1.

12. **Themes** (`29`–`36`). `aero` and `neon` were pre-seeded into a fresh profile's
    `settings.json` before first paint (the technique `test/e2e/visual/shoot.mjs` documents).
    Both render the header, action bar and navigator completely: `aero` in light chrome with
    rounded controls, `neon` square-cornered with uppercase labels and cyan accents. No control
    lost its styling in either theme — the one automated "unstyled" heuristic I ran flagged
    suspects, and reading `29`/`33` showed every one of them was a false positive (Chromium
    reports `appearance: auto` for any `<button>`, and Neon's `border-radius: 0` is the theme).

## Negative scenario

The zero-file path (step 8 above) is the criterion's inverse and was driven end to end: a clean
repo produces the empty state, the action bar is genuinely absent from the DOM (not merely
hidden), and the navigator shows its own empty copy rather than a stale list. The commit source
is the second negative for the working-tree affordances — `Stage all`, the bar overflow, the
row-level Stage/Discard and the scope segment all correctly disappear or disable.

## Relaunch scenario

Driven twice, on two independently built copies of `e551a38`, with the **same** `--user-data-dir`
across the quit (the harness's `launchApp` accepts `userDataDir`, so no workaround was needed).

- Before the quit: doc tabs `["alpha.ts", "Review Changes"]`, `Review Changes` active, pane on
  `Changes 7` (`24`, `44`).
- `docs.json` on disk before **and** after the quit flush:
  `{"version":1,"docs":[{"kind":"file","path":"…\\alpha.ts","sessionId":"au1ykp3vf2n"},{"kind":"review","path":"@review","sessionId":"au1ykp3vf2n","active":true}]}`
  — the Review doc *is* persisted, and it is the remembered active one.
- After relaunch and selecting the fixture session (by its `.session` card, the way
  `editor-tabs-persist.e2e.mjs` does it): doc tabs `["alpha.ts"]`. The **file** tab restored; the
  **Review** tab did not. `reviewHead=false`, right pane on `Files` (`26`, `45`).

## Negative controls

Two assertions were deliberately made false while the app was in a known-good state, to prove the
harness can fail:

- `NEGCTL.1` — "`.review__side` exists in the DOM" (that class does not exist in this build) →
  recorded **FAIL**.
- `NEGCTL.2` — "the navigator has exactly 999 rows" → recorded **FAIL**.

Both appear as `FAIL` in `results-main.json`, alongside the real passes from the same page state.
Separately, the two genuine failures below were each reproduced in a second, independently
launched app instance, so neither is a one-shot flake.

## Findings

### 1. A restart loses the Review tab — every non-`file` doc kind is dropped on load

**Severity for the user: medium-high.** The spec's §4 row *"Restart with Review as the active doc
→ Mode turns on at launch"* cannot happen. A user who quits mid-review comes back to the terminal
tab and has to re-open Review; the pane comes back on `Files`. The same bug silently drops
restored `diff`, `git-history`, `web` and `commit-diff` tabs, so it is wider than Review.

**Affects:** all themes, all configurations (the code path is theme-independent; observed on
`aero-dark`, on both the repo build and the isolated build).

**Evidence:** `44-restore2-pre-quit.png`, `45-restore2-after-relaunch.png`,
`results-restore2.json` (`RESTORE.file` pass / `RESTORE.review` fail), `results-iso.json`
(`RELAUNCH.persisted` pass, `RELAUNCH.docRestored` + `RELAUNCH.modeOn` fail), `24`–`26`.

**Repro** (from a fresh profile):
1. Open a repo with changes as a session.
2. Open a file tab, then press `Mod+Shift+R` so `Review Changes` is the active tab.
3. Wait ~1s for the debounced `persistDocs`; confirm `docs.json` in the profile contains
   `{"kind":"review","path":"@review","active":true}`.
4. Quit the app. Relaunch with the same `--user-data-dir`. Select the fixture session in the rail.

**Expected:** both tabs restore; Review is active; review mode turns on and the pane opens on
Changes.
**Observed:** only `alpha.ts` restores. No Review tab, no Review header, pane on `Files`.

**Cause (found):** `src/persistence.ts` `parseDocs()` filters the blob it reads back to
`kind === 'file'` only —

```ts
return parsed.docs.filter(
  (d: unknown): d is PersistedDoc =>
    !!d && typeof d === 'object' &&
    (d as PersistedDoc).kind === 'file' &&      // ← every other kind is dropped here
    typeof (d as PersistedDoc).path === 'string' &&
    typeof (d as PersistedDoc).sessionId === 'string',
);
```

The writer (`webview/docs.ts` `toPersistedDocs`) deliberately persists every
"deterministically-reopenable kind", and the renderer's `restore` reducer (`webview/docs.ts`,
`case 'restore'`) has explicit handling for the singleton `review` / `git-history` ids — so both
ends of the contract expect non-file kinds. Only the host-side re-read rejects them. This is a
pre-existing filter, not something `review-mode` introduced, but `review-mode` is the spec that
now depends on it.

### 2. The header panel toggle opens the pane on the persisted tab, not on Changes

**Severity for the user: medium.** The control is labelled `Show changes panel` and shows the
**file tree** instead. The user has to press it twice to reach the navigator the label promised —
and only if their persisted `rightPaneTab` happens to be `files`, so it is invisible to anyone
whose last tab was already Changes.

**Affects:** all themes; any profile whose persisted `rightPaneTab` is not `changes`.

**Evidence:** `03-panel-toggle-from-collapsed.png` (Review header on screen, pane showing the
`conduit-qa-repo-…` file tree), `results-main.json` `PANEL.collapsed.opensOnChanges`
(`rtab="Files", rnav=false, rows=0`).

**Repro:** open Review; press `Mod+Shift+E` to collapse the pane; with `rightPaneTab` persisted as
`files`, click the header's leftmost icon button.
**Expected (spec §2.2):** "collapsed → `Show changes panel`, opens the pane on Changes".
**Observed:** the pane opens on Files; the navigator is not shown.

**Cause (found):** `webview/components/review-view.tsx` (`onPanelClick`, ~L1629) —

```ts
if (!explorerCollapsed && paneTab === 'files') onShowChanges();
else onTogglePanel();
```

the collapsed branch calls `onTogglePanel()` (= `toggleExplorer`, visibility only) and never
`onShowChanges()`. `app.tsx`'s auto-open effect *does* pair the two, but it fires on the review-mode
off→on transition, and a visibility toggle is explicitly not a transition (spec §2.1) — so nothing
selects Changes on this path. `review-navigator.e2e.mjs` misses it because it re-opens the pane
with `Mod+Shift+E` first and only then clicks `.review__panel`, which takes the
`visible + files → onShowChanges()` branch.

### 3. Uncaught Monaco error when leaving a side-by-side diff tab

**Severity for the user: low** — nothing visibly broke, but it is an unhandled page error in the
renderer, and this repo has a renderer auto-recovery path that these can trip.

**Evidence:** `console.log` — two occurrences, both while switching away from the diff tab:

```
[s5-toggle-and-reopen] PAGEERROR: TextModel got disposed before DiffEditorWidget model got reset
[s7-board-view]        PAGEERROR: TextModel got disposed before DiffEditorWidget model got reset
```

**Repro:** open a card's `Open side-by-side`, toggle the toolbar to inline, click back to the
`Review Changes` tab. **Cause:** not investigated beyond the message (Monaco disposes the text
model before the diff widget's model is reset).

### 4. Hover feedback on the header icon buttons — could not be confirmed either way

**Not reported as a defect.** Measurements contradicted each other on the same build and the same
element: in one run `.review__more` under `aero` moved from `rgba(0,0,0,0)` to
`rgba(27,31,42,0.06)` on hover; in a later run the identical element under `aero`, `aero-dark` and
`neon` reported no change at all while `el.matches(':hover')` was `true`. Cropped before/after
captures of the header (`40`, `41`) show no perceptible difference for the panel toggle. Two
hover behaviors *were* consistently observed working — `.review__stageall` (background shifts on
every run) and `.review__navrow` (visible in `39`, and its Stage/Discard actions reveal at opacity
1). Because a hidden window is a poor place to measure `:hover` compositing, this goes to
**Not covered** rather than into the findings, and wants a human eye on a visible window.

## Visual / design fidelity

**Pixel baseline: none obtainable → not covered.** The design source is a four-artboard canvas at
a `claude.ai/code/artifact/…` URL (spec header); it is not reachable from this environment, and
there is no pre-change build or checked-in screenshot baseline for the Review surface to diff
against. No parity verdict is issued.

**Structural check against §2.2–§2.4 (evidence `15`, `29`, `33`) — matches:**

- §2.2 header, left→right: panel toggle · source trigger (`Working tree ⌄`) · `All / Staged /
  Unstaged` segment; centre: `7 files · +10 −46` · meter bar · `0 / 7 reviewed`; right: find icon ·
  `⋯`. The count text is present in full at this width.
- §2.3 navigator: `7 changes · +10 −46` with refresh + kebab, `Filter files` input, `Staged` and
  `Changes` section headers each with the per-section review icon, rows as checkbox · kind badge ·
  name · `+a −b`, active row highlighted.
- §2.4 action bar: `⋯` · handoff (`Copy as markdown`, the 0-notes label) · `Stage all` as primary,
  and **absent entirely** at zero files (`27`).
- Commit source (`10`, `20`) collapses to exactly what §2.4 specifies: handoff button only, scope
  segment greyed, flat navigator with the `Reviewing commit …` caption.

**Interaction states checked:** `Tab` focus paints a visible ring on the panel toggle, source
trigger, find, `⋯`, `Stage all` and navigator rows in `aero-dark`
(`results-iso.json` `A11Y.focusring`, evidence `37`), and on the scope segment in `aero`
(white 2px + accent 4px double ring) and `neon` (cyan glow). Disabled scope segment renders at
reduced contrast with the explanatory `title`. Hover: confirmed on `Stage all` and navigator rows;
inconclusive on the header icon buttons (Finding 4).

**One observation, not a verdict:** under `aero` (light) the diff card body still renders on a dark
code surface (`29`). The theme runs seed only `{theme, restoreSessions}` into `settings.json`, so
this may be an artifact of the seeding technique rather than product behavior; it is app-wide, not
Review-specific, and was not investigated.

## Not covered

- **Pixel parity with the design canvas** — the four Aero-Dark artboards live at a `claude.ai`
  artifact URL that is unreachable from this environment, and no prior build or baseline image of
  the Review surface exists to diff against.
- **Hover styling on `.review__panel`, `.review__find`, `.review__more`, `.review__source`** — two
  runs on the same build disagreed (Finding 4). Needs a visible window and a human eye.
- **Keyboard activation of AC-10** — rows were activated by click only; `Enter`/`Space` on a
  navigator row, and the §9 keyboard inventory generally (`J`/`K`, scope-segment arrow keys,
  overflow-menu arrow/Esc handling), were not driven.
- **Header overflow menu contents** — `Collapse all`, `Expand all`, `Ignore whitespace`,
  `Keyboard shortcuts` were never opened; only the trigger's presence was asserted.
- **Action-bar overflow contents** — `Discard all changes…` and its confirm dialog were not driven.
- **`Stage all` execution** — the button's presence/absence was asserted, never clicked.
- **Handoff with notes present** — the repo had no notes, so `Send to agent (M)` and its
  0-pending disabled state were never exercised; only the `Copy as markdown` label was seen.
- **Range / compare source** — the Compare dialog was opened and cancelled; a comparison was never
  confirmed, so `<base>…<head>` trigger text, the `Comparing … to …` caption and the range
  navigator are unverified.
- **Narrow-pane layout (<240px stat column hidden, 180px minimum)**, the truncation banner, the
  filter no-match state, and the marks-loading state.
- **`role="status"` announcements** (§2.3) and screen-reader behavior generally.
- **Canvas view** — only Board view was driven for the mode-off transition.
- **Multi-window** and **session-switch** transitions.
- **Restore-on-close after a restart** — unreachable while Finding 1 stands.
- **`npm run verify` and the smoke suite** — explicitly out of scope for this pass.

### Evidence index

`.autoloop/evidence/2026-09-05-review-mode/qa/` — `01`–`23` on the repo build of `e551a38`,
`24`–`45` on the isolated build of `e551a38`; `console.log` (renderer errors/warnings, tagged by
step); `results-main.json`, `results-probe.json`, `results-iso.json`, `results-hover.json`,
`results-restore2.json`; `styles-aero-dark.json`, `styles-aero.json`, `styles-neon.json`;
`scripts/` — the Playwright drivers used, importing `test/e2e/harness.mjs`.

---

## Conductor addendum (after the QA pass, 2026-09-05)

- **Finding 2 (header toggle opened a collapsed pane on the persisted tab):** fixed in `dca1cb8` —
  the collapsed branch of the toggle now opens the pane and selects Changes, and the app defers
  the tab switch a frame so the mounting pane receives it. Proven in the real app by a new step in
  `test/e2e/review-mode-pane.e2e.mjs` (collapse → click `.review__panel` → `.right .rnav` visible,
  active tab `Changes`), passing alone at `dca1cb8`.
- **Finding 1 (Review tab not restored at launch):** pre-existing — `src/persistence.ts`
  `parseDocs` has restored only `file` docs since the editor-tabs-persist feature. Out of this run's
  scope; recorded as a Decisions Needed item in the run report. The spec's §4 "restart" row was
  written on an unmeasured assumption and is marked unsatisfiable today.
- **Finding 3 (`TextModel got disposed` page errors on leaving a side-by-side tab):** console-only;
  recorded as a follow-up.
- Verdict for integration purposes: every in-scope criterion observed working except the two above,
  one fixed and re-proven, one quarantined with a named blocker.
