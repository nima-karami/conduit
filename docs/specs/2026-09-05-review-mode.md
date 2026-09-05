---
status: active
date: 2026-09-05
supersedes: archive/2026-06-29-review-changes-polish.md (source picker on the git band), archive/2026-07-02-review-changes-first-class.md (in-view file navigator)
---

# Feature Spec: Review as a mode — one header, the Changes tab as navigator

**Tier:** FULL   **Feature type:** UI   **Mode:** interactive (design settled on the canvas)
**One-line request:** "We need to design the UX around reviewing changes, the placements of its
buttons, etc. It's a little bit fractured right now." → design canvas agreed → "Get this implemented."

Design canvas (four artboards, Aero Dark): https://claude.ai/code/artifact/375f2508-5020-4a18-8747-5813e5b1f4cd

## 1. Problem frame

- **Job:** survey and navigate a changeset (working tree, commit, or range), mark files reviewed,
  stage/discard, leave notes, hand off to the agent, from ONE coherent surface.
- **Actors:** the developer reviewing an agent's (or their own) changes.
- **Success outcomes:**
  - Every Review control lives in the Review view (header, action bar) or in the right pane's
    Changes tab. Nothing Review-specific remains in the doc-tab row.
  - The file list exists once: the Changes tab. Closing it never hides an action.
  - The same verb has one label everywhere (`Stage all`, `Discard all changes`).
- **Non-goals:** a side-by-side renderer inside Review (deferred, user decision 2026-09-05); any
  change to diff computation, notes storage, marks storage, hunk staging, or the compare dialog's
  internals; renaming `window.agentDeck`; i18n infrastructure (none exists; §10).

## 2. Behavior & states

### 2.1 Primary flow

1. User opens Review (band icon, `Mod+Shift+R`, palette, Changes-section icon, session card,
   commit detail, terminal sha link, blame lens, note glyph). The Review doc becomes active.
2. **Review mode** is a derived renderer condition: the active session's active doc is the Review
   doc AND the center view is `editor` (Board/Canvas overlays turn it off). **On the off→on
   transition** (open, tab activation, session switch, restore at launch): if the right pane is
   collapsed it opens (this writes `explorerCollapsed`, the same way global search does) and
   `autoOpenedExplorer` is remembered; the Changes tab is selected even if Files was active
   (non-persisted). The Changes tab renders the **review navigator** (§2.3). The doc-tab row's
   git band shows only branch · History · Review. A source change while the mode is already on
   is not a transition and never re-opens the pane.
3. The Review view shows: header (§2.2) → optional truncation banner → optional find bar → card
   scroller → action bar (§2.4).
4. User navigates by clicking navigator rows (scrolls the card into view), `J`/`K`, or scrolling;
   the navigator's active row follows the anchor. Reviewed checkboxes in the navigator and
   `Mark reviewed` on cards are the same state.
5. **Leaving review mode** (another doc becomes active, or the session changes): the Changes tab
   reverts to the ordinary status list; the pane stays where it is.
6. **Closing the Review doc:** if `autoOpenedExplorer` is still set, the pane collapses again.
   Any visibility toggle by the user (`Mod+Shift+E`, palette, panel menu, or the header toggle
   when it changes visibility) clears `autoOpenedExplorer`; the header toggle merely selecting
   the Changes tab does not. The active tab reverts to the persisted `rightPaneTab`.

### 2.2 Review header (full width, 40px, replaces the aside header + the band's review controls)

| Cluster | Contents |
|---|---|
| Left | panel toggle (icon button; three states: collapsed → `Show changes panel`, opens the pane on Changes; visible on Files → `Show changes`, selects the Changes tab; visible on Changes → `Hide changes panel`, collapses; `aria-pressed` only in the third) · source trigger (existing `ReviewSourceControl` trigger + `CommitPickerMenu`) · scope segment `All / Staged / Unstaged` (for commit/range the three buttons carry the `disabled` attribute, are not focusable, and the wrapper's `title` explains a commit has no staged split) |
| Center | `N files · +a −d` · reviewed meter · `r / N reviewed` (count text shrinks to `r / N` when the header is narrow) |
| Right | find (icon button, toggles the find bar) · overflow menu: `Collapse all`, `Expand all`, `Ignore whitespace` (checked item), `Keyboard shortcuts` |

- Source trigger label: `Working tree` · `<sha7> <subject>` (ellipsised, max-width 170px) ·
  `<base>…<head>`. Full text in `title`. The narrative line is removed.
- The commit picker gains a final row **`Compare refs…`** (compare icon) that opens the existing
  `CompareDialog`. The band's Compare button is removed.

### 2.3 Review navigator (the Changes tab while review mode is on)

| Part | Working source | Commit / range source |
|---|---|---|
| Tab badge | count of files listed | same |
| Header row | `N changes · +a −d` · refresh · kebab (Stage all / Unstage all / Stash / Pop / Discard all) — unchanged | `N files · +a −d`; refresh and kebab hidden |
| Caption | none | one line: `<sha7> <subject>` or `Comparing <base> to <head>` |
| Filter | input `Filter files` + shown/total count; same state as Review's file filter | same |
| Sections | `Staged`, `Changes` (existing labels + per-section review icon, which sets scope) | one flat list, no section labels |
| Row | reviewed checkbox · kind badge · name over dir · `+a −d`; hover swaps the stat for `Stage`/`Unstage` · `Discard` (existing row actions); click → scroll to card; active row highlighted; reviewed rows dimmed | same minus the hover actions |

- The rows listed are exactly the files Review lists (after scope + filter). When scope is
  `staged` the `Changes` section is empty and omitted (and vice versa).
- **Windowed**, as the in-view navigator is today: the existing `ReviewFileNav` (uniform 44px
  rows, `computeWindow`, arithmetic active-row follow-scroll that works while the row is
  unmounted) moves into the pane unchanged in behavior; section header rows are items of a
  second height in the same windowed list. `review-virtualize.e2e.mjs` remains the guard.
- Narrow pane (min width 180px): name/dir ellipsise; below 240px the stat column is hidden and
  the hover actions still fit.
- The pane's heading carries a visually hidden `role="status"` line that reads
  `Reviewing working tree` / `Reviewing commit <sha7>` / `Comparing <base> to <head>` when the
  mode turns on and `Changes` when it turns off.

### 2.4 Action bar (bottom of the Review view, full width, 44px)

| Part | Working source | Commit / range source |
|---|---|---|
| Left | `N notes · M pending` when the repo has ≥1 note, else empty | same |
| Right | overflow (`Discard all changes…`, confirm) · handoff button (`Send to agent (M)` / `Copy as markdown`, disabled at M = 0) · `Stage all` (primary) | handoff button only |

- Hidden when the changeset has zero files (the empty state stands alone).
- `Accept all` is renamed `Stage all`; it stages every changed file, as today.

### 2.5 Cards

- Card header: chevron · kind · path · stat · `Open file` · **`Open side-by-side`** (icon-only,
  new split glyph, `title` + `aria-label`; absent on binary and image cards, where a split view is
  meaningless) · `Mark reviewed`. The text button `Split` is removed.
- `Open side-by-side` opens the Monaco `diff` doc for that file starting in side-by-side mode
  **without writing the global `diffSideBySide` setting**. The diff tab's own toggle still writes
  the global setting, as today. The override is not persisted: a diff doc restored at launch opens
  in the global mode.

### 2.6 Current behavior (measured 2026-09-05 by reading and tracing source; the row's file:line is the measurement)

| Claim | Measured at | Status |
|---|---|---|
| Source trigger + scope segment render on the git band only while Review is active | `center-pane.tsx:218-224`, `review-source-control.tsx:31,60-68` | Measured |
| Collapsing the aside removes Collapse/Expand all, Ignore whitespace, `?`, diffstat, meter, filter, Accept all, Discard, Send to agent | `review-view.tsx:1606-1759`; no key binding for the last four in `review-keymap.ts:32-47` | Measured |
| `Split` flips the global setting | `app.tsx:1352-1358` `update({diffSideBySide:true}); openDiff(path)` | Measured |
| Review has no side-by-side renderer | no `DiffViewer`/monaco import in `review-view.tsx` | Measured |
| Right pane visibility = `explorerCollapsed` setting, persisted; toggled by `Mod+Shift+E`, palette, panel context menu | `src/settings.ts:81,182`, `app.tsx:249-252,719,2431-2439,2150-2162` | Measured |
| Active right tab = `rightPaneTab` setting, persisted only on explicit tab click; imperative reveals switch without persisting | `right-pane.tsx:1802-1843`, `src/settings.ts:108,202` | Measured |
| Changes list data = `projectData.changes` for the active session's `activeRepoRoot`; rows already show +/− | `app.tsx:967-970,2889`, `right-pane.tsx:140-143` | Measured |
| Review's working-tree files are the same `changes` array | `review-view.tsx:425-428` | Measured |
| Review view unmounts when another doc is active (tab-state memory exists because of it) | `view-state-store.ts:17,48-69`, review-fidelity T1 | Measured |
| `ChangeRow` has no keyboard handling and is not focusable | `right-pane.tsx:112-376` (plain `div onClick`) | Measured |
| Send to agent exists only when the repo has ≥1 note | `review-view.tsx:1738` | Measured |
| In-view navigator is windowed (44px rows, follow-scroll computed arithmetically) | `review-view.tsx:175,1973-2030`; `review-virtualize.e2e.mjs` | Measured |
| Global search already force-opens the pane by writing `explorerCollapsed` | `app.tsx:466` | Measured |
| Source changes re-dispatch `openReview`; tab activation / session switch / restore do not | `app.tsx:530-538`, `docs.ts:298-326` | Measured |
| `CenterPane` stays mounted under the Board/Canvas overlays | `app.tsx:2981,2995` | Measured |
| `RightPane` re-adopts `rightPaneTab` whenever the setting value changes | `right-pane.tsx:1815-1819` | Measured |
| `RightPaneHandle` exposes `openSearch`, `revealInTree` only | `right-pane.tsx:1829-1843` | Measured |
| Plurals are inline ternaries; no helper exists | `right-pane.tsx:275` | Measured |

## 3. Data / interface contract

- **Review navigator model** (renderer-only, published by `ReviewView`, consumed by `RightPane`):
  `{ source, root, files: {path, kind, added, removed, staged}[], shownCount, totalCount,
  activePath, reviewed: Set<path>, canMark, filter, onPick(path), onToggleReviewed(path, on),
  onFilter(text) }`. Absent (`null`) when Review is not mounted → Changes tab is the ordinary
  status list. Published via a small external store (pattern: `review-marks-store.ts`).
- **Review mode flag** (derived in `app.tsx`, passed as a prop): `reviewMode = activeDoc?.kind ===
  'review' && centerView === 'editor'`. `RightPane` renders the navigator iff `reviewMode`; while
  `reviewMode` is on and the model is still `null` (first frame, or changes not yet delivered) it
  renders the navigator's loading state, never the status list.
- **Review-mode layout memory** (renderer-only, not persisted): `{ autoOpenedExplorer: boolean }`.
  Set on the off→on transition when the pane was collapsed; cleared by `toggleExplorer` (the one
  function every visibility toggle goes through); consumed when the Review doc leaves the docs
  state.
- **Right pane tab visibility → header:** `RightPane` reports its shown tab through a new
  `onTabShown(tab)` prop; `RightPaneHandle` gains `showChanges(): void` (non-persisting, like
  `revealInTree`). The mid-review re-adopt effect only fires when the setting value changes, and
  review mode never writes it.
- **Model lifecycle:** `ReviewView` publishes on every render and clears on unmount; the store
  holds one model or `null`. The model carries `activePath`; the navigator component owns the
  follow-scroll math as today.
- **Diff doc override:** `OpenDoc` gains `sideBySide?: boolean` (not persisted). `DiffViewer`
  initial mode = `doc.sideBySide ?? settings.diffSideBySide`; after the user toggles, the global
  setting drives it as today.
- **Removed:** setting `reviewFileListOpen` (interface, defaults, coercer; unknown keys are
  dropped by `coerceSettings`, so no migration).
- **Invariants:** exactly one file list is rendered for Review at a time; header + action bar are
  independent of pane visibility; the `rightPaneTab` setting is never written by review mode.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Navigator model | `ReviewView` (files, anchor, marks, filter) | `RightPane` Changes tab | yes |
| `explorerCollapsed` auto-open / restore | `app.tsx` on `openReview` dispatch and on Review doc close | `app.tsx` render, `RightPane` | yes |
| Non-persisted Changes-tab selection | `app.tsx` → `RightPaneHandle.showChanges()` | `RightPane` | yes |
| Shown right-pane tab | `RightPane` `onTabShown` | header panel toggle | yes |
| `reviewMode` flag | `app.tsx` (active doc + center view) | `RightPane`, auto-open effect | yes |
| `explorerCollapsed` (also written by global search) | `toggleExplorer`, `openGlobalSearch`, review auto-open/restore | layout render | yes; global search unchanged |
| Scope | header segment, Changes-section icons | `ReviewView` file filter, navigator sections | yes |
| `Compare refs…` → `CompareDialog` open | `CommitPickerMenu` row | `CenterPane` `compareOpen` | yes |
| `sideBySide` doc override | card `Open side-by-side` → `openDiff` | `DiffViewer` | yes |
| `diffSideBySide` global setting | `DiffViewer` toggle only (Review no longer writes it) | every diff tab | yes |
| Reviewed marks | unchanged (`review-marks-store`) | navigator checkbox + card button | unchanged |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Pane collapsed by user mid-review, then Review closed | Stays collapsed; no restore (user took over). |
| User switches to the Files tab mid-review | Allowed; header toggle shows off; clicking it selects Changes. |
| Review doc active, session switched (Review belongs to the other session) | Review mode off for the new session; navigator model cleared because `ReviewView` unmounted. |
| Zero files (clean tree / empty commit) | Header still renders (source, scope, `No changes`); navigator shows the existing Changes empty state; action bar hidden. |
| Host truncated the changeset | Banner below the header as today; navigator counts reflect listed files. |
| Filter excludes everything | Navigator shows `No files match`; cards show the existing filtered-out empty state. |
| Commit source with `repoRoot` different from the pane's active repo | Navigator lists the review's files (model carries `root`); row hover actions absent; header kebab hidden. |
| Long commit subject | Trigger ellipsises at 170px; center cluster shrinks; right cluster never clips. |
| Rapid source changes / repeated `openReview` | Not a mode transition; no re-open. |
| Entering Review with the pane visible on Files | Changes tab selected (non-persisted); `autoOpenedExplorer` stays false. |
| Board or Canvas view opened mid-review | `reviewMode` off: navigator reverts to the status list; pane untouched; returns when the editor view is back. |
| Review doc closed / session switched while a menu (source picker, overflow, action-bar overflow) is open | Menus close with their owner; `CommitPickerMenu` refocuses its trigger only if it is still connected. |
| Focus after `Discard` removes the focused navigator row | Focus moves to the navigator list container. |
| Focus when the header toggle collapses the pane while focus is inside it | Focus returns to the header toggle. |
| Compare dialog closed | Focus returns to the source trigger. |
| Repo picker changes `activeRepoRoot` mid-review | `changes` swaps for Review and navigator alike (same array); marks key follows `effectiveRoot`. |
| Watcher delivers a new `changes` array during `Stage all` | Existing behavior: list re-renders; the in-flight action completes on the host. |
| Restart with Review as the active doc | Mode turns on at launch: pane opens if collapsed and the memory is set, so closing Review restores. |
| One file / one note | Singular labels (`1 file`, `1 note`) via the shared plural helper. |
| Pane narrower than 240px | Stat column hidden; hover actions remain. |
| `Stage all` / hunk actions fail | Existing error path (message banner) unchanged. |
| Notes not yet loaded | Handoff button disabled with today's tooltip. |
| Reduced motion | No new animation; meter width transition already respects existing CSS. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Auto-open the pane on entering Review | on | no | Review is a mode; the navigator is part of it. Restore-on-close keeps it polite. |
| Which tab shows on entry | Changes, not persisted | no | Same non-persisting rule as `revealInTree`. |
| `reviewFileListOpen` | removed | — | No in-view list remains. |
| `reviewIgnoreWhitespace` | unchanged | yes (menu item) | Existing setting. |
| `diffSideBySide` | unchanged | yes (diff tab toggle) | Review stops writing it. |

## 6. Scope slicing

- **MVP (this slice):** §2.1–2.6 and §3 in full; removal of the aside, `reviewFileListOpen`,
  band Compare, band `ReviewSourceControl`; `Accept all` → `Stage all`; session card review icon;
  tests updated (§7.3).
- **v1 (follow-up):** in-review side-by-side renderer with a header `Unified / Split` segment.
- **Vision:** navigator grouping by directory; multi-select in the navigator.
- **Out of scope:** everything in §1 non-goals.

## 7. Acceptance criteria

### 7.1 EARS

- While review mode is on (Review is the active doc and the center view is `editor`), the Changes
  tab shall render the review navigator.
- While review mode is off, the Changes tab shall render the ordinary status list.
- When review mode turns on and the right pane is collapsed, the app shall open the pane and
  select the Changes tab without writing `rightPaneTab`.
- When the Review doc is closed and `autoOpenedExplorer` is set, the app shall collapse the pane.
- When the user toggles pane visibility by any route, the app shall clear `autoOpenedExplorer`.
- While the source is a commit or range, the scope segment's buttons shall carry `disabled`.
- While the navigator lists more rows than fit, only rows near the viewport shall be mounted.
- The doc-tab row shall not render a review source trigger, scope segment, or Compare button.
- The Review header shall render the source trigger, scope segment, diffstat, reviewed meter,
  find toggle and overflow menu regardless of right-pane visibility.
- When a navigator row is activated (click, Enter, Space), Review shall scroll that file's card
  into view and expand it.
- When the card anchor changes, the navigator shall mark the anchored file's row active.
- When `Open side-by-side` is activated, the app shall open the diff doc in side-by-side mode and
  shall not change the `diffSideBySide` setting.
- When `Compare refs…` is activated in the source picker, the app shall open the Compare dialog.
- If the changeset has zero files, then the action bar shall not render.

### 7.2 Gherkin (key flows)

```gherkin
Feature: Review as a mode
  Background:
    Given a repo with 3 unstaged and 1 staged change
    And the right pane is collapsed

  Scenario: Entering Review opens the navigator
    When the user presses Mod+Shift+R
    Then the right pane is visible on the Changes tab
    And the Changes tab lists 4 rows with reviewed checkboxes
    And the doc-tab row shows no source trigger

  Scenario: Closing Review restores the pane
    Given the user entered Review from a collapsed pane
    When the user closes the Review tab
    Then the right pane is collapsed
    And rightPaneTab in settings is unchanged

  Scenario: User owns the pane
    Given the user entered Review from a collapsed pane
    And the user pressed Mod+Shift+E twice (collapse, then re-open)
    When the user closes the Review tab
    Then the right pane stays visible

  Scenario: Side-by-side without side effects
    Given diffSideBySide is false
    When the user activates "Open side-by-side" on a card
    Then a diff tab opens rendering side by side
    And diffSideBySide is still false
```

### 7.3 Tests to add / update

- Unit: `review-scope-control.test.ts` (segment disabled for commit/range); new
  `review-nav-store.test.ts` (publish/clear, absent model); new `review-mode-layout.test.ts`
  (pure auto-open/restore decision); `panel-visibility.test.ts` unchanged; `settings.test.ts` and
  `coerce-settings.test.ts` (key removed); `review-keymap.test.ts` unchanged.
- Unit (update): `review-enter-guard.test.ts` (fixture uses the new split icon button class).
- E2E (update, all of them reference removed selectors): `review-entry-point`,
  `review-navigator` (rows now in the right pane), `review-search` (filter in the pane),
  `review-commit-picker` (Compare row), `review-compare`, `review-scope` (header segment),
  `split-diff-map` (no global flip), `band-alignment`, `git-band-persistence`,
  `review-tab-state`, `review-keymap-persist`, `review-commit-source`, `commit-review-bounds`,
  `link-cwd`, `terminal-commit-link`, `review-virtualize` (navigator rows in the pane), and
  `test/e2e/visual/shoot.mjs`. The source trigger's class becomes `review__source` everywhere.
  New: `review-mode-pane.e2e.mjs` (Gherkin 1–3).

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| Changes tab (review mode) | loading (model `null` or changes undelivered) | header with source caption, counts as `…`, empty list area | wait |
| Changes tab (review mode) | populated | sections/flat list with checkboxes, active row | click row, tick checkbox |
| Changes tab (review mode) | error (git failure) | existing Changes error/empty copy; Review's card area shows its error state with Retry | Retry in Review |
| Changes tab badge | review mode | count of listed files | — |
| Changes tab (review mode) | empty | existing `No changes` empty state + header | — |
| Changes tab (review mode) | filter no-match | `No files match` line under the filter | clear filter (Esc) |
| Changes tab (review mode) | marks loading | checkboxes disabled, `Loading diff…` title (as today) | wait |
| Header scope segment | disabled | 0.4 opacity, `title` explains commit has no staged split | — |
| Header panel toggle | collapsed / visible-on-Files / visible-on-Changes | off / off with `Show changes` tooltip / on (`aria-pressed`) | open / select Changes / collapse |
| Review header | loading (changes undelivered) | source + scope render; counts `…`; meter empty | wait |
| Review header | error / non-git project | source trigger only; card area shows the existing error state | Retry |
| Action bar | working / commit / hidden | §2.4 | — |
| Handoff button | 0 pending | disabled, tooltip | — |
| Card `Open side-by-side` | default / hover | icon button, `title` | opens diff tab |
| Source picker | open | rows + `Compare refs…` | pick / Esc |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Navigator row | pick, toggle reviewed, stage/unstage, discard | click row; hover shows actions | Tab to row (button), Enter/Space pick; checkbox Space; actions Tab-reachable | tap | none | `<li>` in `<ul aria-label="Changed files">`; row `button` with `aria-current` on active; checkbox `aria-label="Mark <name> reviewed"` |
| Header panel toggle | toggle | click | Enter/Space; `Mod+Shift+E` also toggles pane | tap | — | `aria-pressed`, `aria-label` |
| Scope segment | choose | click | arrows within radiogroup (existing) | tap | — | `radiogroup` (existing); `aria-disabled` when disabled |
| Find toggle | open/close find | click | `/`, `Mod+F` (existing) | tap | — | `aria-pressed`, `aria-label="Search changed lines"` |
| Overflow menu | 4 items | click | Enter/Space open; arrows; Esc | tap | — | `menu` / `menuitemcheckbox` for Ignore whitespace |
| Action bar overflow | Discard all… | click | as above | tap | — | `menu` |
| `Compare refs…` row | open dialog | click | arrows/Enter (existing menu) | tap | — | `menuitem` |
| `Open side-by-side` | open diff | click | Enter/Space | tap | — | `aria-label` |
| Navigator filter | type, clear | click | Esc clears then blurs (existing) | tap | — | `aria-label="Filter files"`; count span `aria-live="polite"` |
| Navigator header refresh / kebab / section review icons | existing | click | Tab, Enter/Space (existing buttons) | tap | kebab is the menu | existing `aria-label`s |

No drag interactions are added. `J`/`K` remain bound to the card scroller only; inside the
navigator, Tab moves between rows and Enter/Space activates.

## 10. Accessibility & i18n (UI)

- Every new icon-only control has `aria-label` and `title`; pressed states via `aria-pressed`.
- Navigator rows become focusable buttons (today's `ChangeRow` is not); focus ring uses the
  existing `--focus-ring`; active row uses background + border, not colour alone (checkbox +
  dimming mark reviewed).
- Live region: reuse Review's existing message banner for `Stage all` / discard outcomes; the
  navigator announces nothing new (row activation moves visible content only).
- Reduced motion: no new transitions.
- i18n: **no i18n module exists** (measured: no `i18n`/strings file; ad-hoc per-file `STR`
  objects in git components). New strings follow the `STR` object convention in each component;
  plural forms (`1 note` / `N notes`, `1 file` / `N files`, `N changes`, `M pending`) go through
  one small shared helper (no helper exists today; inline ternaries are the only precedent).
  Layout tolerates +30% label growth: header clusters shrink center first; action bar wraps
  labels never (buttons `white-space: nowrap`, bar scrolls horizontally if forced). RTL is not
  supported by the app today; not addressed here.

## 11. Design tokens (UI)

Existing tokens only: `--panel`, `--raise`, `--border`, `--border-2`, `--text*`, `--accent`,
`--state-*`, `--r-ctl`, `--diff-*`, `--green/--red`. New CSS classes: `.review__head`
(repurposed, full-width), `.review__actionbar`, `.rnav*` for the pane navigator (reusing
`.review__navrow/*` rules moved out of the aside). New icon: `IconSplit` (two rects) in the
16-grid stroke style; Neon variant not required (rect icons already get `rx` via CSS).

## 12. Assumptions

- Restore-on-close, not restore-on-tab-switch, to avoid the pane flapping when alternating
  between Review and a file tab.
- Row hover actions in the navigator reuse `ChangeRow`'s existing Stage/Discard handlers.
- The per-section review icons in the Changes header stay and set scope.
- Notes summary text appears only when the repo has notes; the handoff button is always present
  (disabled at 0) so the bar's shape is stable.
- `Discard all changes…` keeps the existing confirm dialog.
- The palette command and shortcut for Review are unchanged.
- `review-source-control.tsx` keeps its component; it moves from the band into the header.
- Auto-open writes the persisted `explorerCollapsed` (the only visibility mechanism; global
  search already does this). A crash mid-review leaves the pane open, as with global search.
- `Stage all` has no in-flight state (none exists for git actions today); unchanged.

## 13. Decisions Needed

None open. Split renderer deferred by user decision (2026-09-05); side-effect fix kept in scope.

## 14. Open questions

None.
