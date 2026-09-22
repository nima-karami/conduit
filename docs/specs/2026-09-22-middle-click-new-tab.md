---
status: active
date: 2026-09-22
---

# Feature Spec: Middle-click opens in a new background tab

**Tier:** FULL   **Feature type:** UI
**One-line request:** "middle-clicking a file or a link anywhere should open it in a new tab"

Written in autonomous mode: the conductor's locked decisions (L1–L6 below) are inputs, not open
questions. Everything else I would have asked is an assumption in §12 or a flagged decision in §13.

**Locked (conductor):** L1 middle-click (button 1, on `auxclick`, mousedown default suppressed)
on a file/link surface opens the target as a **pinned, background** tab: the active tab and focus
don't change, and the current preview tab is never replaced. L2 already pinned → no new tab,
brief cue allowed; open as the preview → pinned in place. L3 the target is whatever left-click on
that surface opens; if left-click opens nothing tab-like, middle-click does what left-click does.
L4 middle-click on a tab keeps its behaviour; Monaco text is out of scope. L5 one shared helper,
exhaustive surface list, exclusions give a reason. L6 no keyboard equivalent.

**Conductor ruling (2026-09-22, after review of §13):** D1 is **overruled**: a middle-click on a
link inside an in-app web tab opens that URL as a new background in-app web tab (S14). D2–D5 are
accepted at their defaults. The plan is `docs/plans/2026-09-22-middle-click-new-tab.plan.md`.

## 1. Problem frame

- **Job:** queue several files/diffs to read later without leaving what I'm looking at, which is
  the browser habit. Today every open takes focus and most of them replace the preview.
- **Actors:** one user with a mouse that has a middle button (or a trackpad that maps one).
- **Success outcomes:** middle-clicking N items on any listed surface leaves N new pinned tabs,
  the same active tab, the same focused element, the same center view (editor/board/canvas) and
  the same explorer selection. It never autoscrolls, pastes, or starts a drag. The one exception
  is D4 (terminal commit links run in the foreground, as left-click does).
- **Non-goals:** a keyboard equivalent (L6); middle-click inside Monaco (L4), which covers peek,
  references, blame hovers and Ctrl+click navigation; changing what left-click does anywhere;
  opening a second Review tab (it's a singleton).

## 2. Behavior & states

**Primary flow:** pointer over a wired surface → middle button down (default suppressed, no
focus change) → up on the same element → `auxclick` button 1 → the surface calls its normal
opener with `mode: 'background'` → the docs reducer adds or pins the tab **without activating it**
→ the tab gets a brief cue and the polite live region announces the result.

**Outcomes of a background open** (these are the only states, and each maps to an announcement):

| Target's state before | Result | Active tab | Cue / announcement |
|---|---|---|---|
| Not open | New pinned tab appended at the end of the owning session's strip | unchanged | cue on the new tab · "Opened ‹title› in a background tab" |
| Open as the preview tab (active or not) | Same tab, `preview` cleared in place (not moved; a file tab isn't re-keyed) | unchanged | cue · "Pinned ‹title›" |
| Open as a pinned tab, in **any** session's strip | Nothing changes. **No ownership transfer**: a tab in another session's strip stays there | unchanged | cue only if it's in the displayed strip · "‹title› is already open[ in ‹session›]" |
| Target session ≠ active session (new tab) | Tab goes in that session's strip; no session switch | unchanged | no cue (strip not shown) · announcement + " in ‹session name›" (§13 D2) |
| Target is a folder / unsupported / missing | No tab | unchanged | none (see §4) |

A diff tab is always pinned today: `openDiff` passes no mode, and the reducer treats that as
permanent (`docs.ts:212-214`). So the preview row only applies to `file` and `commit-diff` targets.

**Current behavior (measured).** "Probe" = a standalone Electron 43.3.0 page driven by
Playwright `_electron` on win32 (the repo's Electron binary, scratch dir, since deleted). "Source" =
read, not run, and marked ASSUMED.

| # | Claim about today | How measured | Status |
|---|---|---|---|
| C1 | Playwright `click({button:'middle'})` fires `mousedown`→`mouseup`→`auxclick` (button 1) and **no** `click` | Probe: event log on a `div`, a `button` and an `<a href>` | Measured |
| C2 | On Windows, a middle mousedown in a **scrollable** document without `preventDefault` starts autoscroll (scrollY 0→2625 after a mouse move) and **`auxclick` never fires** | Probe: same row with and without a mousedown `preventDefault` | Measured |
| C3 | `preventDefault` on the middle mousedown stops the autoscroll and `auxclick` fires | Probe | Measured |
| C4 | A middle mousedown moves focus to a focusable target (a textarea lost focus to a `<button>`); with `preventDefault` focus stays put | Probe: `document.activeElement` | Measured |
| C5 | Middle-clicking an `<a href="https://…">` in the app window reaches `setWindowOpenHandler` with `disposition: 'background-tab'`; `preventDefault` on that `auxclick` **suppresses the open** | Probe: host handler log | Measured |
| C6 | Middle-clicking a link inside a `<webview>` guest reaches the guest's `setWindowOpenHandler` with `disposition: 'background-tab'` | Probe: `web-contents-created` handler log | Measured |
| C7 | A middle-button press+move on a `draggable` element fires **no** `dragstart`; if the up lands elsewhere, `auxclick` fires on the common ancestor | Probe | Measured |
| C8 | Conduit routes C5 to `openExternalUrl` (system browser), and routes C6 to the system browser for web-view guests but gates or loads in place for HTML-preview guests | Source: `electron/main.ts:999-1002`, `:3748-3761` | ASSUMED |
| C9 | Middle on an explorer **file** row opens it pinned **and active**; on a folder it does nothing. No mousedown suppression, so by C2 it's eaten when the tree overflows | Source `webview/components/right-pane.tsx:1547-1554`; e2e `test/e2e/mouse-nav.e2e.mjs:98` (non-overflowing fixture) | ASSUMED (partly covered by the existing e2e) |
| C10 | Middle on a doc tab closes it through the dirty-confirm path; the Terminal tab gets nothing | Source `webview/components/doc-tabs.tsx:206-216`; e2e `mouse-nav.e2e.mjs:112-140` | Measured by the existing e2e |
| C11 | xterm's `Linkifier` activates a link on **mouseup of any button**, so middle on a terminal link does the same thing as left-click, in the foreground | Source `node_modules/@xterm/xterm/src/browser/Linkifier.ts:220-232` | ASSUMED |
| C12 | No other surface in §9 has a middle handler. On a plain element, middle does nothing except move focus (C4) and possibly start autoscroll (C2). On an element with a real `href`, the C5/C8 host path **already** opens the system browser: markdown external links (`markdown-viewer.tsx:138`) and the Settings About link (`settings-modal.tsx:1115`) | Source grep for `auxclick`/`button === 1` in `webview/`. The only other hits are doc-tabs, right-pane, and app.tsx:2413, a thumb-button (3/4) listener unrelated to this feature | ASSUMED |
| C13 | Linux primary-selection paste on middle-up | Can't run on this win32 machine | ASSUMED |

## 3. Data / interface contract

**`OpenMode`** (`webview/docs.ts:62`) becomes `'preview' | 'permanent' | 'background'`.
`'background'` means pinned and not activated. v1 producers exist for `file`, `diff`,
`commit-diff` and `web` (S14, D1 overruled). The reducer gets **no** `review`/`git-history`
background branch, because nothing produces one (the singleton exclusion in §9). `web` goes
through the same generic `open` background branch as `file` and `diff`; a web tab is never a
preview, so it only ever takes the "new" or "already open" row.

**Reducer (`docsReducer` `open`, `webview/docs.ts:212-261`; `openHistoryDoc` `:158-199`)**,
with `mode: 'background'`:
- Existing id → keep its position and clear `preview`. **No ownership transfer**: `sessionId`
  stays as it is, which is unlike foreground at `:217-229`. `activeId` and `activeBySession` are
  untouched, which keeps `rememberedDoc` (`:203-206`) stable for the owning session.
- New id → append `{…, sessionId: target, preview: false}`; `activeId` and `activeBySession` unchanged.
- The `openCommitFile` action's `pin: boolean` is **replaced** by `mode: 'preview' | 'permanent' |
  'background'`. `pin: true` becomes `'permanent'` and `pin: false` becomes `'preview'`, the same
  mapping `CommitView`'s `(file, pin)` prop and `GitHistoryView` (`:243`) switch to. With
  `background`: an existing pinned id → no-op. A preview slot holding the same path → re-key it
  to pinned in place, and repoint any `activeBySession` entry that named the `@preview` id (the
  bookkeeping `pinDoc` already does at `:372-380`). Otherwise → append a pinned tab. It never activates.
- A pure `backgroundOpenOutcome(state, kind, path, targetSessionId): { outcome: 'opened' |
  'pinned' | 'already-open'; ownerSessionId: string }` is exported for the cue, the announcement
  and the reveal rule. It's computed from the pre-dispatch state.

**Openers in `webview/app.tsx`.** Each one takes the mode and, **in background mode only**:
- **skips** `setActiveId`/`switchSession` (`:1446-1449`, `:1471-1474`), `setCenterView('editor')`
  (`openMatch :1518`, `jumpToHunk :1529`, `openTerminalFileLink :1558`, `openCommitFile :637`)
  and `rightPaneRef.revealInTree` (`:1459`);
- **reveal rule, keyed on mount rather than outcome:** stage `setReveal` (search match / hunk /
  terminal `:line:col`) **only if the target doc is not currently mounted**. Mounted means the
  active doc or the split doc (`center-pane.tsx:357`). A mounted viewer subscribes to
  `revealSubs` (`project-index.ts:65-69`) and would jump, which breaks L2's "nothing changes".
  This covers opened, pinned-in-place and already-open-but-hidden alike, so the line survives until
  the tab is first viewed. `openMatch`, `jumpToHunk` and `openTerminalFileLink` call `setReveal`
  *before* `openFile` today (`:1518`, `:1529`, `:1556`). In background mode those wrappers check
  the mount state first and then decide. **Correction (plan grounding):** there is no split *doc*.
  `center-pane.tsx` renders exactly one `DocView`, for `activeDoc`; its `splitId` is a *session*
  split (`center-pane.tsx:245`). "Mounted" therefore means "is the active doc", nothing else.
- **stale reveal:** a staged reveal is consumed on the doc's first mount and is meant to be. A
  never-viewed background tab opens at the line it was queued for, even when it's later activated
  from a surface that stages nothing (such as a tab or explorer click). A later foreground opener
  that stages its own reveal overwrites it. Closing the doc drops it (`clearReveal(path)`).
- **keeps** `post readFile/readDiff`, `pushRecent` and `indexProjectOnce`.
- The explorer's middle path calls `onOpenFile` only. It must **not** run `onRowClick`'s
  `onContextPath` / `setFocusPath` (`right-pane.tsx:675-676`) or change selection.
- Affected: `openFile :1438`, `openDiff :1469` (gains `opts.mode`), `openCommitFile :636`,
  `openMatch :1516`, `jumpToHunk :1527`, `openTerminalFileLink :1547`, `onOpenReviewDiff :1488`, and
  the palette `fileEntries`/`recentItems` `run` (`:2453-2485`, which gain an optional
  `runBackground`).
- **Signature trap:** center-pane receives the raw `openFile(rawPath, targetSessionId?, mode)`
  as `onOpenFile: (path) => void` (`app.tsx:2989` → `center-pane.tsx:113`). A component that
  calls `onOpenFile(p, 'background')` through it would pass `'background'` as a **session id**.
  Wrap it as `(p, mode) => openFile(p, undefined, mode)`, the way right-pane already does
  (`:3093`), and type every `onOpenFile` prop `(path: string, mode?: OpenMode) => void`.
  If any link in the chain below drops the mode, background mode is lost without any error. Each
  of these props has to carry it:
  - DocView (`doc-view.tsx:35`, `:107`)
  - MarkdownViewer (`:78`, `:538`), including the ref wrapper `openFileStable` (`:547`), which
    forwards only `path` today
  - BreadcrumbBar (`:30`)
  - DiffViewer (`:24`, `:47`)
  - SearchPane's `onOpenFile` / `onOpenMatch` (`:81-82`)
  - ReviewView's `onJumpToHunk` / `onOpenDiff` (`:312`, `:315`)
  - RightPane's `onOpenDiff` (`:120`, `:172`, `:1719`)
  - CommitView / GitHistoryView (above)
  - TerminalPane's positional `onOpenFile(path, line?, col?, originSessionId?)`, which gains a
    trailing `mode?` (`terminal-pane.tsx:66`, `center-pane.tsx:116`, `:270`)

  A unit test on each of these adapters asserts that the mode is forwarded.

**Shared helper `webview/middle-click.ts`** (L5):
- `middleClickProps(onMiddle: () => void): { onMouseDown, onAuxClick }`. `onMouseDown` →
  `preventDefault()` when `button === 1` (C2–C4) and does nothing for other buttons, so left-click
  and drag handlers are untouched. Composition order: an existing consumer `onMouseDown` runs
  **first and is never gated on button**. The helper's suppression runs after it. It never calls
  `stopPropagation` on mousedown, because the context menu's outside-click dismissal relies on
  mousedown bubbling.
  `onAuxClick` → when `button === 1`: `preventDefault()` (C5, which stops the host open),
  `stopPropagation()`, then `onMiddle()`.
- `isMiddleButton(e: { button: number }): boolean`, for the two non-React paths (the xterm
  `activate` callbacks and the `ContextMenu` item rows).
- Handlers attach to the **item element**, never delegated from a container. C7 shows `auxclick`
  lands on the common ancestor when down and up are on different items, and a per-item handler
  correctly ignores that.

**Cue + announce:**
- App state `flashTabId` (cleared after the cue duration) is passed to `DocTabs` as class
  `tab--flash`. It's single-valued: in a burst, only the latest tab flashes, and every open is
  still announced.
- Announcements use a dedicated polite `role="status"` region, not `navLiveRef`, which timers and
  Back/Forward also write to (`app.tsx:720`, `:2361`).
- Each announcement clears the region, then sets the text on the next frame. A repeated
  identical message ("x is already open" twice) is otherwise not re-read.

**Terminal path** (`isMiddleButton`): xterm calls `activate` on **mouseup** (C11), not on
`auxclick`, so the helper's `auxclick` rule doesn't apply. `activate` branches on
`event.button === 1`. Hover state for the mousedown suppression comes from the `hover`/`leave`
callbacks of each link object in `linkProvider` and of the OSC-8 `linkHandler` (xterm's
`_currentLink` is private). They set a pane-local `linkHovered` ref, which a capture-phase
`mousedown` on the terminal element reads.

**`ContextMenu`** (`webview/components/context-menu.tsx:9`): `MenuItem` gains optional
`onMiddleClick?: () => void`, wired through the helper. Only file-list menus set it (§9).

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `open{mode:'background'}` action | app openers | `docsReducer`/`openHistoryDoc` | yes |
| `activeId`/`activeBySession` (must NOT change) | reducer | DocTabs, center-pane, `useNavHistory` (`app.tsx:2365`, records on active change) | yes. Because it doesn't change, no nav-history entry is recorded (AC-9) |
| pending reveal (`project-index.ts:65-75`) | background opener (target not mounted only) | CodeViewer `takeReveal` on first mount | yes. It's also dropped when the doc closes (§3) |
| doc `sessionId` ownership | reducer (foreground transfers, background never does) | tab strip filter, `rememberedDoc` | yes |
| persisted docs (`toPersistedDocs :439`) | reducer | `docs.json` restore | yes, no change needed: background tabs persist as ordinary pinned tabs |
| recents (`pushRecent`) | openers | palette Recent group | yes, a background open counts as a recent |
| `flashTabId` | app openers via `backgroundOpenOutcome` | DocTabs | yes |
| host window-open, app window (C5) | Chromium on middle-click of `<a href>` | `setWindowOpenHandler` (`main.ts:999`) | producer suppressed by the helper's `preventDefault` on wired anchors; handler unchanged |
| host window-open, web-view guest (C6) | Chromium, `disposition: 'background-tab'` | guest `setWindowOpenHandler` (`main.ts:3748`) → new `web:openBackgroundTab` message to the guest's own host window → `WebView` → `openWeb(url, docSession, 'background')` | yes (S14). Only http(s) and only non-preview guests are forwarded; the host decides, the renderer only opens a tab |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Middle on a **folder** item: explorer row, breadcrumb dropdown dir entry | No tab, no expand/collapse, no `readDir`, no selection change. The mousedown is still suppressed, so no autoscroll. This is a **deliberate exception to L3** (§9 "L3 scope") |
| Middle on a terminal **dir** link | Does what left-click does: reveal the folder in the OS file manager. L3 applies, because that link surface's click action is external |
| Explorer **multi-selection**, middle on a selected or unselected row | Opens only that row's file; selection and roving focus unchanged |
| Middle-button **drag** | No `dragstart` (C7). Down on A, up on B → neither opens (per-item handler) |
| File **deleted** between render and click | Tab is created as usual; its not-found state is whatever left-click shows today, seen when activated. The announcement still says "Opened". No toast |
| Target is the **active** tab (pinned) | `already-open`: nothing changes, no reveal staged, cue on the active tab |
| Target is the active **preview** | Pinned in place; stays active (it already was); no reveal jump |
| **Rapid** repeat middle-clicks on one item | First → opened; later ones → already-open. Never a duplicate tab (ids are deterministic) |
| **Many** background tabs → strip overflows | The strip does **not** scroll, and the active tab stays in view. If the new tab lies outside the visible strip, the overflow chevron (`doc-tabs.tsx:316`) gets the cue instead |
| Background tab **closed before ever being activated** | Its pending reveal (if any) is dropped (`clearReveal(path)` on close), so a later open doesn't jump to a stale line |
| Markdown file link with `#fragment` | Opens the file; the fragment scroll (`markdown-viewer.tsx:106-112`) is **skipped**. It would scroll the *current* doc's same-id heading |
| Markdown **external** (`http(s)`) link | `openExternal(url)`, same as left-click. `auxclick` is preventDefault'ed, so the host doesn't also open it (C5), and it opens **exactly once** |
| Markdown in-page `#anchor` / unsupported link | No-op, default prevented |
| Terminal link while a mouse-mode TUI owns the pointer | Unchanged from today: middle-click activates exactly when left-click would |
| Terminal link on **Linux** | Middle keeps xterm's paste and does **not** open (§13 D3) |
| Terminal link with >1 candidate | Middle opens the disambiguation menu (as left does). Middle on a menu row → background open |
| Terminal **commit** link | Does what left-click does (retargets the singleton Review tab, foreground). §13 D4 |
| **Dirty** preview tab pinned by middle-click | Pinned in place; the dirty buffer is kept, no prompt |
| Owning session not active | Tab lands in that session's strip, no switch (§13 D2) |
| No active session (empty state) | Surfaces that could fire have no session; the opener no-ops, same as left-click today |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Background vs foreground | Background | No | L1; browser convention |
| Insert position | End of strip | No | Matches foreground permanent append (`docs.ts:260`); reversible (§12 A1) |
| Cue duration | 600 ms, once | No | Enough to locate; not decorative |
| Palette on middle-click | Stays open, input keeps focus | No | Lets the user queue several files, which is the point of the feature |
| Context-menu file list on middle-click | Closes, like a left-click select | No | Reuses the menu's single dismissal path; reversible |
| Web-view guest links, middle-click (`background-tab`) | New background in-app web tab | No | D1 overruled; browser convention |
| Web-view guest links, any other disposition (left-click `target=_blank`, Shift+click) | Unchanged (system browser) | No | Left-click behaviour is not changed anywhere (§1) |

## 6. Scope slicing

- **MVP:** reducer + openers + helper + cue/announce; surfaces S1–S9 (§9).
- **v1:** S10–S14 (menus, palette, terminal, web-view guest links).
- **Vision:** toast actions; review nav list.
- **Out of scope:** everything under "Excluded" in §9; keyboard equivalent (L6).

## 7. Acceptance criteria

Every AC is drivable in the real app with Playwright `locator.click({button:'middle'})`, which C1
shows dispatches `auxclick`. Common assertion **"unchanged"** means all of: same
`.tab--active` title, same `document.activeElement`, same center view, same explorer selection,
same `window.scrollY` and pane `scrollTop`s.

- **AC-1** Explorer file row (tree made to overflow first): a new non-italic tab exists, unchanged holds.
- **AC-2** Middle on the file that is the current preview tab: it loses `tab--preview` and keeps its index; tab count unchanged.
- **AC-3** Middle on an already-pinned file: tab count unchanged; `tab--flash` appears on it and clears within 1 s; the live region reads "… is already open".
- **AC-4** One per wired surface S2–S13: the expected doc kind (file / diff / commit-diff) appears as a pinned background tab, and unchanged holds. Search match, hunk and terminal `:line` targets open at that line when later activated.
- **AC-5** Middle on a search match for the file in the **active** tab: the editor's cursor/scroll doesn't move.
- **AC-6** Folder row: no tab, the folder's `aria-expanded` unchanged.
- **AC-7** Markdown `https://` link: `shell.openExternal` is called exactly once, and no tab is added. Count the calls **host-side**: `electronApp.evaluate` patches `require('electron').shell.openExternal`. `window.agentDeck` is contextBridge-frozen, so it can't be stubbed.
- **AC-7b** Terminal `https://` link (drive via `window.__termLinkProviders`, passing a `MouseEvent` with `button: 1`): one external open, no tab.
- **AC-8** Middle on a doc tab still closes it (the existing `mouse-nav.e2e.mjs` passes unchanged). This AC also covers `mouse-nav.e2e.mjs:98`, which now must not assume c.txt became active.
- **AC-9** After three background opens, Back (`Alt+Left`) lands on the location before the last *foreground* navigation, not on a background tab.
- **AC-10** Palette file row middle-click: palette still open, input focused, new background tab.
- **AC-11** Middle-button press on a row, move 100 px, release on another row: no tab, no `dragstart`.
- **AC-13** Cross-session (D2): with sessions A (active) and B, open a palette file owned by B with a middle-click. A's strip and active tab are unchanged. After switching to B, the tab is there, pinned, and B's remembered active doc didn't change. The status region reads "… in ‹B name›".
- **AC-14** Announcements: the dedicated status region reads the exact string for each of opened / pinned / already-open. Two identical already-open clicks produce two region updates (the region is cleared in between).
- **AC-15** Cue: `tab--flash` is present, then gone within 1 s. With `data-reduce-motion="true"` on `:root`, and with emulated `prefers-reduced-motion: reduce`, the computed `animation-name` is `none`. Under emulated `forced-colors: active`, the cue's outline is non-`none`.
- **AC-16** Unit: `terminalLinkMiddleAction(button, platform)` returns `'background'` for button 1 on win32/darwin, returns `'ignore'` on linux (D3), and returns `'foreground'` for button 0. This covers the Linux case this machine can't drive.
- **AC-17** Web-view guest (S14): with a web tab showing a local fixture page, a middle-click on
  an `http://` link inside the guest adds a pinned web tab for that URL, owned by the web tab's
  session; the first web tab is still active; `shell.openExternal` is called zero times. A
  left-click on a `target="_blank"` link in the same page calls `shell.openExternal` once and adds
  no tab. Unit: the host routing function returns in-app only for `background-tab` + http(s).
- **AC-12** Unit: `docsReducer` background cases (new / preview→pin / already / commit-diff preview-slot re-key) leave `activeId` and `activeBySession` referentially unchanged.

**EARS**
- *Event:* When the user middle-clicks a wired file surface, the app shall open its target as a pinned tab without changing the active tab, focus or center view.
- *Unwanted:* If the middle button goes down on a wired surface, then the app shall suppress the default so that neither autoscroll, focus change, nor (Linux) primary paste occurs.
- *State:* While the target is already pinned, a middle-click shall change nothing except a transient cue and an announcement.
- *Unwanted:* If a middle-clicked anchor has an `href`, then the app shall stop the host's own background-tab open and perform only the surface's action.

```gherkin
Feature: Middle-click opens in a background tab
  Background:
    Given a project whose explorer tree overflows its pane
    And "a.ts" is the active pinned tab and the editor has focus
  Scenario: queue two files from search
    When I middle-click the match in "b.ts" and then the match in "c.ts"
    Then pinned tabs "b.ts" and "c.ts" exist at the end of the strip
    And "a.ts" is still active and the editor still has focus
    And the pane did not autoscroll
    When I activate "b.ts"
    Then the editor is at the matched line
  Scenario: preview gets pinned, not replaced
    Given "d.ts" is the preview tab
    When I middle-click "e.ts" in the explorer
    Then "d.ts" is still the preview tab and "e.ts" is a new pinned tab
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Wired surface item | rest / hover | unchanged (existing hover) | — |
| Wired surface item | middle pressed | no autoscroll cursor, no focus ring moves | — |
| Doc tab | background-opened / pinned / already-open | `tab--flash` pulse for 600 ms (under reduced motion, a static outline for 600 ms, no animation) | none needed |
| Overflow chevron | target out of view | same cue on the chevron | opens the overflow list as today |
| Background tab later activated | not-found / error / loading | the existing per-kind states, unchanged | existing |
| Folder / unsupported target | — | nothing | — |
No empty/first-run/offline/permission states apply: the feature adds no surface of its own.

## 9. Interaction inventory (UI)

The middle column is left-click → what middle-click opens. Every row uses `middleClickProps`
unless marked *(isMiddleButton)*.

| # | Surface (file:line) | Left-click → middle-click target | Notes |
|---|---|---|---|
| S1 | Explorer file row `right-pane.tsx:1538-1554` | file (preview) → file | **replaces** the existing ad-hoc `onAuxClick`. Folder = no-op |
| S2 | Changes row `right-pane.tsx:128-131` | diff → same diff | scope from `feat/unstaged-diff` carried as-is |
| S3 | Search match `search-pane.tsx:121-127` | file@line → same | reveal only if new (§3) |
| S4 | Search group head, name-only `search-pane.tsx:91-95` | file → file | non-name-only head toggles collapse → middle no-op |
| S5 | Review card open `review-view.tsx:2344-2350` | file@first hunk → same | |
| S6 | Review card side-by-side `review-view.tsx:2352-2362` | diff (sbs) → same | |
| S7 | Review hunk jump `review-view.tsx:2745-2754` | file@hunk → same | does **not** call `onSetCurrent` |
| S8 | Commit files list `commit-view.tsx:147-153` (git history) | commit-diff preview → pinned commit-diff | |
| S9 | Oversize diff "Open file" `diff-viewer.tsx:53-58` | file → file | |
| S10 | Markdown links `markdown-viewer.tsx:87-128` | file → file; http → external; `#` → no-op | §4 rows |
| S11 | Breadcrumb dropdown entries `breadcrumb-bar.tsx:118-128` via `MenuItem.onMiddleClick` | file → file; dir → no-op | |
| S12 | Palette Files + Recent rows `command-palette.tsx:161-172`, entries `app.tsx:2453-2485` | file/diff → same | Sessions/Agents/Commands rows: no-op (L3 scope) |
| S14 | Web-view guest links (host `main.ts:3748`, renderer `web-view.tsx`) | in-page navigation / `target=_blank` → system browser; **middle** (`background-tab`) → new background web tab | host-routed, not `middleClickProps`: the guest is a separate web contents. Preview (HTML viewer) guests are unchanged (ADR 0005) |
| S13 | Terminal path/URL/OSC-8 links `terminal-pane.tsx:179-181, 405-407, 459-472` + path menu | file@line → same; URL → external; dir → reveal; commit → as left | *(isMiddleButton)* in `activate`; capture-phase middle `mousedown` `preventDefault` on the xterm element **only while a link is hovered** (so autoscroll doesn't start). Linux: D3 |
| T | Doc tab `doc-tabs.tsx:206-216` | close (unchanged, L4) | gains only the helper's mousedown suppression, so an overflowing strip can't swallow the close (C2) |

**L3 scope.** L3 applies per *surface*: a link surface whose click goes outside the app
(external URL, OS reveal) keeps doing that on middle-click. On a wired file surface, an **item
that isn't a file target** gets no middle action. That covers folder rows (expand / `readDir`),
non-name-only search heads (collapse toggle), and palette Session/Agent/Command rows (run the
command). The reasons: middle-click has no convention for "expand" or "run", these items have no
middle behaviour today (C9, C12), and making them fire would break §1's "nothing else changes"
for a click aimed at a tab. Their mousedown is still suppressed on wired containers, so there's
no autoscroll and no focus theft.

**Excluded (with reason):**
- **Singleton tab openers:** git indicator History/Review (`git-indicator-bar.tsx:213`, `:225`),
  commit-view "Review commit" (`commit-view.tsx:97`), palette Open Review / Git History commands
  (`app.tsx:2555`, `:2564`). Review and History are singleton tabs that *retarget*, so a
  background open would silently replace the content of an existing tab. Vision slice.
- **Doc-tabs overflow "Open editors" list** (`doc-tabs.tsx:335`): its entries are open tabs, and
  under L4 middle-click there is a tab gesture (close), not an open. Defer so that meaning isn't
  invented here.
- **Settings About link** (`settings-modal.tsx:1115`): the host path (C5/C8) already opens the
  system browser on middle-click, which is what left-click does. It's correct today, so wiring it
  would be churn.
- **"Open externally" buttons** (`html-viewer.tsx:430/471/624/657`, `web-view.tsx:152`) and the
  empty-state repo routes (`empty-state.tsx:127`): action buttons, not file or link items.
- HTML-preview guest links: ADR 0005 confinement lives in the host; out of bounds for a UX feature.
- Plan documents (Milkdown editor): left-click edits and opens nothing. The incidental host path for `<a href>` (C5) is left as is. ASSUMED, not measured in Milkdown.
- Right-click menu commands ("Open diff"/"Open file", `app.tsx:2180-2181`): these are commands, not file lists.
- All toast actions, including plan "Open" (`app.tsx:1607`): a generic `{label, onClick}` action API with dismiss semantics; vision slice.
- Review file-nav list `review-file-nav.tsx:234`, markdown TOC, architecture `onNavigate` `architecture-view.tsx:1010`: they scroll or select within a view and open nothing.
- Board/canvas: none opens a file (grep: no opener calls in `board-view.tsx`/`architecture-view.tsx`).
- Monaco: peek/references, blame, hover links, Ctrl+click (L4).
- Terminal tab and session cards: not files.

Pointer only; keyboard, touch and context-menu paths are unchanged (L6). ARIA: no role changes.

## 10. Accessibility & i18n

- **Keyboard:** no equivalent by decision (L6). This is a pointer accelerator; every target stays reachable by the existing keyboard open.
- **Focus:** unchanged by definition (C4 suppression). The helper must not call `focus()`.
- **Announce:** every background open is announced once via a dedicated polite status region (clear, then set; §3): "Opened ‹title› in a background tab" / "Pinned ‹title›" / "‹title› is already open", plus " in ‹session›" when cross-session. That's one message per click, never batched into a firehose.
- **Color not sole signal:** the cue is supplementary; the announcement and the tab's presence carry the result. Under forced-colors the cue uses `outline` (system `Highlight`), not a background tint.
- **Reduced motion:** honour both `prefers-reduced-motion: reduce` and the app's own setting `:root[data-reduce-motion="true"]` (`styles.css:1991`, `:3777`). Either one gives a static outline for 600 ms with no animation.
- **i18n:** the three strings (plus the session suffix) live in one `MIDDLE_CLICK_STRINGS` const table, the pattern `HTML_VIEWER_STRINGS` uses (`html-viewer.tsx:37`). Titles are interpolated, never concatenated by fragments. No plurals, dates or sorting. RTL: "end of strip" means the logical end.

## 11. Design tokens

- Cue: a new `--tab-flash` semantic token (a `--accent` mix at low alpha) defined for all three themes; forced-colors → `Highlight`. No raw hex. Keyframe duration uses the existing motion token if one exists, else 600 ms is local to the rule.

## 12. Assumptions

- A1 New background tabs append at the strip end, not after the active tab (Chrome's rule). Reversible.
- A2 A background open counts as a recent (`pushRecent`) and warms the file cache (`readFile`).
- A3 The explorer's existing middle-click (pinned + **foreground**) changes to background. That's L1 applied, and it isn't a regression.
- A4 Background-opened tabs persist in `docs.json` like any pinned tab.
- A5 Doc tabs get the mousedown suppression (row T). It keeps L4's behaviour working under overflow.
- A6 Middle-click never switches the center view off Board/Canvas.

## 13. Decisions Needed

- **[resolved: OVERRULED by the conductor, see S14] D1 Web-view guest links.** Middle-click inside an in-app web tab goes to the system browser today (C6/C8). The browser-faithful behaviour is a new background in-app web tab, which means routing `disposition === 'background-tab'` (http(s) only, non-preview guests only) from the host handler to the owning window's renderer. It's a guest-initiated host change and gets its own review. **Default taken: excluded, today's behaviour kept.**
- **[normal] D2 Cross-session targets.** Palette file rows and terminal links resolve an *owning* session (`resolveOwningSession`), which the foreground path switches to. **Default: open in the owning session's strip without switching, and name it in the announcement.** The alternative, always the active session, would duplicate a file across two strips.
- **[normal] D3 Terminal middle-click on Linux.** Primary-selection paste is a strong terminal convention, and xterm already implements it (`CoreBrowserTerminal.ts:360-370`). C11+C13 suggest a middle-click there today both pastes and opens. **Default: on Linux, terminal links ignore button 1 (paste only).** Can't be verified on this machine.
- **[normal] D4 Terminal commit links.** Left-click retargets the singleton Review tab. **Default: middle does the same (foreground)**, since there's no second-Review-tab concept.
- **[normal] D5 Palette stays open on middle-click** (§5). **Default: stays open.**

## 14. Overlaps with in-flight branches (for the planner)

| File | Change here | Overlap |
|---|---|---|
| `webview/docs.ts` | `OpenMode` + background branches in `open`/`openHistoryDoc`; `backgroundOpenOutcome` | `feat/nav-history` edits the open paths; `feat/unstaged-diff` adds `diff@staged:` ids (background must key the same id the foreground does) |
| `webview/app.tsx` | openers' mode plumbing, `flashTabId`, announcer, center-pane `onOpenFile` wrapper, palette `runBackground` | `feat/nav-history` rewrites `openFile`/`openDefinitionFile`/`applyNav` |
| `webview/middle-click.ts` (new) | helper | — |
| `webview/components/{right-pane,search-pane,review-view,commit-view,git-history-view,diff-viewer,markdown-viewer,breadcrumb-bar,context-menu,command-palette,terminal-pane,doc-tabs,center-pane,doc-view}.tsx` | wiring, prop types | `feat/unstaged-diff` touches the Changes row scope in `right-pane.tsx` |
| `webview/project-index.ts` | `clearReveal(path)` | `feat/nav-history` changes `openDefinitionFile`'s signature here |
| `electron/main.ts`, `src/protocol.ts`, `src/webview-guard.ts`, `webview/components/web-view.tsx` | S14 host routing + `web:openBackgroundTab` message | `feat/unstaged-diff` edits `main.ts` (`readDiff` case) and `protocol.ts` (`DiffTabScope`) in other regions |
| `webview/styles.css` + theme tokens | `tab--flash`, `--tab-flash` | — |
| `test/unit/docs*.test.ts`, `test/e2e/middle-click.e2e.mjs` (new), `test/e2e/mouse-nav.e2e.mjs` | AC-12, AC-1..11, AC-8 | — |
| `CHANGELOG.md` | user-facing entry | — |
