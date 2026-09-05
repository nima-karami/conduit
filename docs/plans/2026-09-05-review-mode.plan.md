# Review as a mode — implementation plan

**Spec:** `docs/specs/2026-09-05-review-mode.md`  **Tier:** FULL

## Goal

Move every Review control into the Review view (one header, one action bar), delete the in-view file
navigator, and make the right pane's Changes tab render that navigator while Review is the active doc.

## Architecture

Three seams, all renderer-side, no protocol change. (1) A module-singleton external store,
`webview/review-nav-store.ts`, carries the navigator model from `ReviewView` (inside `CenterPane`) to
`RightPane` (a sibling) — the `review-marks-store.ts` shape, so both sides read it with
`useSyncExternalStore` and neither knows the other. (2) A pure reducer, `src/review-mode-layout.ts`,
owns the auto-open / restore decision; `app.tsx` feeds it three events and applies the effects it
returns, so the policy is unit-tested without React. (3) The existing windowed `ReviewFileNav` moves
out of `review-view.tsx` into `webview/components/review-file-nav.tsx` and grows section rows; it is
the only list component, rendered by the new `ReviewNavigator` inside the Changes tab. `ReviewView`
loses its aside and gains a full-width header and a bottom action bar; `ReviewSourceControl` moves
from `CenterPane`'s band slot into that header.

## Data flow

```
app.tsx
 │ reviewMode = activeDoc?.kind === 'review' && centerView === 'editor'          (derived, memo)
 │ reviewDocOpen = docs.some(d => d.kind === 'review')
 │
 ├─ useReviewModeLayout ──► reduceReviewLayout(state, event) ──► effects:
 │      events: {mode on/off, explorerCollapsed}                 update({explorerCollapsed})
 │              {userToggledExplorer}  (from toggleExplorer)      rightPaneRef.showChanges()
 │              {reviewDocClosed}
 │
 ├─ <CenterPane> ── <ReviewView>
 │        header: [panel toggle][ReviewSourceControl + scope][diffstat·meter·count][find][⋯]
 │        cards …  action bar: [notes summary]        [⋯][handoff][Stage all]
 │        │
 │        └─ publishReviewNav(model) every render · publishReviewNav(null) on unmount
 │                        │
 │                        ▼  review-nav-store  (ReviewNavModel | null)
 │                        │
 └─ <RightPane reviewMode onTabShown paneRef> ─── useSyncExternalStore ───► tab === 'changes' &&
          reviewMode ? <ReviewNavigator model changes …> : <ChangesView …>
```

The header's panel toggle needs the pane's shown tab: `RightPane` reports it upward with
`onTabShown`, `app.tsx` holds it in state and passes `paneTab` down through `CenterPane` to
`ReviewView`.

## Settled decisions — do not re-litigate

- Review is a mode: the derived `reviewMode` flag, not the `openReview` dispatch, drives auto-open.
- Restore happens on Review doc **close**, never on tab switch. `toggleExplorer` (the one visibility
  function) clears the memory; selecting the Changes tab does not.
- Auto-open writes the persisted `explorerCollapsed`, like `openGlobalSearch` (`app.tsx:466`).
- The in-view aside is deleted outright, along with `reviewFileListOpen`.
- The navigator stays windowed; section headers are second-height items in the same list.
- No in-review split renderer. The per-card action opens the Monaco diff doc with a non-persisted
  doc-level `sideBySide` override; `diffSideBySide` is written only by the diff tab's own toggle.
- `Accept all` → `Stage all`. `Discard` moves behind the action bar's overflow with the existing
  confirm path (`onGitAction({op:'discardAll'})`).
- Compare is a `Compare refs…` row at the end of the commit picker; the band's Compare button goes.
- Source trigger class renamed `gitband__source` → `review__source`; scope segment
  `gitband__scope` → `review__scope`. Every e2e selector follows (scripted, Slice 5).
- Strings stay per-component `STR` objects (no i18n module exists). One shared plural helper.

## Spec staleness

None — every §2.6 row was re-measured during planning.

## Global constraints

- Gate: `npm run verify` (biome check · both tsconfigs · esbuild · vitest · fallow · audit ·
  security). Never narrowed. `fallow:check` fails on any unused export — delete, don't stub.
- E2E: `node test/e2e/run-smoke.mjs <name>` per scenario, hidden, serially, on a quiet machine.
- Two tsconfigs: `src/**` is shared host+renderer and may not import `node:` or React; `webview/**`
  is renderer-only.
- Naming: components `kebab-case.tsx` exporting `PascalCase`; pure modules `kebab-case.ts`; CSS
  classes BEM-ish `block__elem--mod`; settings keys camelCase in `src/settings.ts` (interface +
  `DEFAULT_SETTINGS` + `coerceSettings`).
- Comments explain WHY only; point at the spec (`// spec 2026-09-05-review-mode §2.1`) instead of
  restating it. Match surrounding density.
- No `!important`, no specificity escalation, no `as any` / `@ts-ignore`.
- Hover reveals nothing at `opacity:0` with live pointer events (`test/unit/hover-overlays.test.ts`
  guards); row actions in the navigator use the `.change__row-actions` visibility recipe already
  used by `ChangeRow`.
- Any overlay reaching `.topbar` declares `-webkit-app-region: no-drag` (menus are portaled
  `.ctxmenu`, already covered).
- CI verify runs on Ubuntu: no `\` paths, no `process.platform` in tests.
- User-facing changes → root `CHANGELOG.md` `[Unreleased]`.
- Scratch never lands in the repo.

## Out of scope

Side-by-side rendering inside Review; notes/marks storage; hunk staging; compare dialog internals;
right-pane Files tab; multi-window coordination beyond what the marks store already does.

## Contracts

```ts
// src/plural.ts
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string;
// plural(1,'file') === '1 file'; plural(3,'file') === '3 files'; plural(2,'change') === '2 changes'

// src/review-mode-layout.ts  (pure; no React, no node)
export interface ReviewLayoutState { autoOpened: boolean }
export const INITIAL_REVIEW_LAYOUT: ReviewLayoutState;  // { autoOpened: false }
export type ReviewLayoutEvent =
  | { type: 'mode'; on: boolean; explorerCollapsed: boolean }
  | { type: 'userToggledExplorer' }
  | { type: 'reviewDocClosed'; explorerCollapsed: boolean };
export interface ReviewLayoutEffect { setExplorerCollapsed?: boolean; showChanges?: true }
export function reduceReviewLayout(
  state: ReviewLayoutState, ev: ReviewLayoutEvent,
): { state: ReviewLayoutState; effect: ReviewLayoutEffect };
// mode on + collapsed  → {autoOpened:true},  {setExplorerCollapsed:false, showChanges:true}
// mode on + visible    → state,               {showChanges:true}
// mode off             → state,               {}
// userToggledExplorer  → {autoOpened:false},  {}
// reviewDocClosed + autoOpened + !collapsed → {autoOpened:false}, {setExplorerCollapsed:true}
// reviewDocClosed otherwise → {autoOpened:false}, {}

// webview/review-nav-store.ts
export interface ReviewNavModel {
  source: ReviewSource | undefined;          // undefined ⇒ working tree
  root: string | undefined;                  // ReviewView's effectiveRoot
  files: readonly ChangeDTO[];               // after scope + filter, card order
  totalCount: number;                        // before the text filter
  truncated: boolean;
  activePath: string | null;
  reviewed: ReadonlySet<string>;
  canMark: boolean;                          // marks loaded
  filter: string;
  onPick: (path: string) => void;            // scrollToFile(path)
  onToggleReviewed: (path: string) => void;
  onFilter: (text: string) => void;
}
export function publishReviewNav(model: ReviewNavModel | null): void;
export function subscribeReviewNav(cb: () => void): () => void;
export function getReviewNav(): ReviewNavModel | null;

// webview/components/review-file-nav.tsx  (moved from review-view.tsx; grows sections)
export const NAV_ROW_H = 44;
const NAV_SECTION_H = 28;   // module-private
export type NavSection = { id: 'staged' | 'unstaged'; label: string; files: readonly ChangeDTO[] };
export function ReviewFileNav(props: {
  sections: readonly NavSection[];           // one unlabeled section (label '') for commit/range
  activePath: string | null;
  reviewed: ReadonlySet<string>;
  canMark: boolean;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
  rowActions?: (file: ChangeDTO) => { label: string; op: GitOp; danger?: boolean; title: string }[];
  onAction?: (intent: GitActionIntent) => void;
  onSectionReview?: (scope: ReviewScope) => void;   // the section header's review icon
}): JSX.Element;
// Item model inside: type NavItem = {kind:'section'; section: NavSection} | {kind:'file'; file: ChangeDTO}
// computeWindow({count, scrollTop, viewportHeight, overscanPx, estimate: i => item.kind==='section' ? NAV_SECTION_H : rowH, measured: EMPTY_MAP})
// A section with label '' renders no header item.

// webview/components/review-navigator.tsx  (the Changes tab body in review mode)
export function ReviewNavigator(props: {
  model: ReviewNavModel | null;              // null ⇒ loading state (header only, counts '…')
  changes: ChangeDTO[];                      // for the working-tree kebab (stage/unstage all enablement)
  onAction: (intent: GitActionIntent) => void;
  onRefresh?: () => void;
  onReviewScope: (scope: ReviewScope) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}): JSX.Element;

// webview/components/right-pane.tsx  (additions)
export interface RightPaneHandle { openSearch(): void; revealInTree(path: string): void; showChanges(): void; }
// new props: reviewMode: boolean; onTabShown?: (tab: RightPaneTab) => void
// RightPaneTab is imported from '../../src/settings'; the local `RightTab` alias is deleted.

// webview/docs.ts  (additions)
// OpenDoc gains `sideBySide?: boolean` (diff docs only; never persisted — stripped where reviewSource is).
// Action 'open' gains `sideBySide?: boolean`; the reducer copies it onto the doc (and onto an existing doc it re-activates).

// webview/app.tsx  (signature changes)
const openDiff: (path: string, targetSessionId?: string, opts?: { sideBySide?: boolean }) => void;
// openSplitDiff is deleted; CenterPane's onOpenReviewDiff receives (abs) => openDiff(abs, undefined, { sideBySide: true }).

// webview/components/center-pane.tsx  (prop changes)
// removed: onSetReviewSource is still needed (header) — it is now passed to ReviewView, not ReviewSourceControl.
// added:   paneTab: RightPaneTab; explorerCollapsed: boolean; onTogglePanel: () => void; onShowChanges: () => void;
//          onOpenCompare: () => void  (sets compareOpen; already local state — expose via ReviewView prop instead)

// webview/components/review-view.tsx  (prop changes)
// added: onSetSource: (next: ReviewSource) => void; onOpenCompare: () => void;
//        paneTab: RightPaneTab; explorerCollapsed: boolean; onTogglePanel: () => void; onShowChanges: () => void;
// unchanged: changesRoot, changes, diffs, onRequestDiff, onJumpToHunk, onOpenDiff, onGitAction, onClose, source, sessionId, sessionLabel, viewStateId

// webview/components/review-source-control.tsx  (prop changes)
// added: onOpenCompare: () => void   (forwarded to CommitPickerMenu)
// scope segment: always rendered; `disabled` when source is commit/range.

// webview/components/commit-picker-menu.tsx  (prop changes)
// added: onOpenCompare: () => void   → final row `Compare refs…` (IconCompare), separatorBefore.

// webview/components/segmented-radios.tsx  (prop changes)
// added: disabled?: boolean; title?: string  → every button gets `disabled`; group gets `title` and `aria-disabled`.

// webview/icons.tsx  (addition)
export const IconSplit: (p: { size?: number; className?: string }) => JSX.Element;
// <rect x="2" y="3" width="5" height="10" rx="1.2"/><rect x="9" y="3" width="5" height="10" rx="1.2"/>
```

Invariants: `publishReviewNav(null)` is called from `ReviewView`'s unmount cleanup, always. The
store never holds a model from an unmounted view. `RightPane` renders `ReviewNavigator` iff
`reviewMode`, regardless of whether the model is `null`. `reduceReviewLayout` is the only place the
auto-open memory changes.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Navigator model | `ReviewView` → `publishReviewNav` | `RightPane` → `ReviewNavigator` | both |
| `reviewMode` flag | `app.tsx` (activeDoc kind + centerView) | `RightPane`, `useReviewModeLayout` | both |
| Auto-open / restore of `explorerCollapsed` | `useReviewModeLayout` effects, `toggleExplorer` | layout render, `RightPane` | both; `openGlobalSearch` unchanged (measured `app.tsx:466`, it writes the same key and needs no memory) |
| Non-persisted Changes tab selection | `RightPaneHandle.showChanges()` | `RightPane` local `tab` | both; the re-adopt effect (`right-pane.tsx:1815`) only fires on setting-value change and review mode never writes it |
| Shown tab → header toggle | `RightPane` `onTabShown` | `ReviewView` header via `app.tsx` state → `CenterPane` | both |
| Scope | header segment; Changes-section icons (`onReviewScope`) | `ReviewView` files; navigator sections | both |
| Source | header `ReviewSourceControl` → `onSetReviewSource` | `docs.ts` `openReview`; `CompareDialog` prefill | both (band slot removed, header slot added) |
| Compare dialog open | `CommitPickerMenu` `Compare refs…` → `ReviewView.onOpenCompare` → `CenterPane.setCompareOpen` | `CompareDialog` render (unchanged) | producer side only; consumer measured unchanged (`center-pane.tsx:360-370`) |
| `sideBySide` doc override | card `Open side-by-side` → `openDiff(...,{sideBySide:true})` → docs reducer | `DiffViewer` initial `renderSideBySide` | both |
| `diffSideBySide` setting | `DiffViewer` toggle only | all diff tabs | producer narrowed (Review's write removed); consumer unchanged |
| `reviewFileListOpen` | removed from `src/settings.ts` | `review-view.tsx:585,1572` (removed) | both |
| `Accept all` → `Stage all`, `Discard` → overflow | `ReviewView` action bar → `onGitAction` | `app.tsx` `onGitAction` (unchanged) | producer only; consumer measured unchanged (`app.tsx:2105`) |
| Session card review pill | `session-card.tsx:237-249` gains `IconReview` | — | producer only; presentational |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/plural.ts` | create | `plural(n, singular, pluralForm?)` |
| `src/review-mode-layout.ts` | create | pure auto-open / restore reducer |
| `webview/review-nav-store.ts` | create | navigator model store (publish / subscribe / get) |
| `webview/use-review-mode-layout.ts` | create | React hook: derives events, applies effects (`update`, `rightPaneRef.showChanges`) |
| `webview/components/review-file-nav.tsx` | create (moved) | windowed navigator list with section rows and row actions |
| `webview/git-intent.ts` | create (moved) | `GitOp`, `IntentOp`, `GitActionIntent` types, out of `right-pane.tsx` |
| `webview/components/doc-view.tsx` | modify | pass `initialSideBySide` from the `OpenDoc` to `DiffViewer` |
| `test/unit/review-window.test.ts` | modify | mixed-height window case |
| `docs/runs/2026-09-05-review-mode/report.md` | create (Slice 6) | run report |
| `webview/components/review-navigator.tsx` | create | Changes-tab body in review mode: header, caption, filter, `ReviewFileNav` |
| `webview/components/review-view.tsx` | modify | delete aside/rail/footer/handoff/`ReviewFileNav`; add header, action bar, publish model, `Open side-by-side` |
| `webview/components/review-source-control.tsx` | modify | header placement classes; always-rendered scope segment with `disabled`; `onOpenCompare` |
| `webview/components/commit-picker-menu.tsx` | modify | `Compare refs…` row |
| `webview/components/segmented-radios.tsx` | modify | `disabled`, `title` |
| `webview/components/center-pane.tsx` | modify | remove `ReviewSourceControl` + Compare from the band; `showGitBand` drops `reviewActive`; pass header props to `ReviewView`; `onOpenCompare` |
| `webview/components/git-indicator-bar.tsx` | modify | delete the Compare button and `onOpenCompare` prop |
| `webview/components/right-pane.tsx` | modify | `reviewMode`, `onTabShown`, `showChanges()`, render `ReviewNavigator`; import `RightPaneTab` |
| `webview/components/diff-viewer.tsx` | modify | initial `renderSideBySide` from `doc.sideBySide ?? settings.diffSideBySide` |
| `webview/components/session-card.tsx` | modify | `IconReview` in the review pill |
| `webview/docs.ts` | modify | `OpenDoc.sideBySide`, `open` action field, persistence strip |
| `webview/app.tsx` | modify | `reviewMode`, `paneTab` state, `useReviewModeLayout`, `openDiff` opts, delete `openSplitDiff`, wire new props |
| `webview/icons.tsx` | modify | `IconSplit` |
| `webview/styles.css` | modify | delete aside/rail/foot/handoff/nav rules; add `.review__head` (full width), `.review__actionbar`, `.rnav*`; move `.review__nav*` rules to the pane context; narrow-pane container query |
| `src/settings.ts` | modify | delete `reviewFileListOpen` (3 places) |
| `test/unit/plural.test.ts` | create | |
| `test/unit/review-mode-layout.test.ts` | create | |
| `test/unit/review-nav-store.test.ts` | create | |
| `test/unit/review-scope-control.test.ts` | modify | disabled segment for commit/range |
| `test/unit/review-enter-guard.test.ts` | modify | `.rcard__split` → `.rcard__sbs` |
| `test/unit/settings.test.ts`, `test/unit/coerce-settings.test.ts` | modify | key removed |
| `test/e2e/review-mode-pane.e2e.mjs` | create | Gherkin 1–3 |
| `test/e2e/*.e2e.mjs` (17 files, §7.3), `test/e2e/visual/shoot.mjs` | modify | selectors (scripted) + navigator now in `.right` |
| `tools/rename-selectors.mjs` | create (one-off, deleted at the end of Slice 5) | scripted selector rename across `test/e2e` |
| `CHANGELOG.md` | modify | `[Unreleased]` entry |
| `docs/specs/INDEX.md` | modify (Slice 6) | move the spec row to archive on ship |

## Scripts

`tools/rename-selectors.mjs <from> <to> [...pairs]` — rewrites literal selector strings across
`test/e2e/**/*.mjs`: `.gitband__source`→`.review__source`, `.gitband__scope`→`.review__scope`,
`.rcard__split`→`.rcard__sbs`, `.review__nav .review__navrow`→`.right .review__navrow`,
`.review__nav`→`.rnav`, `.review__foot .review__accept`→`.review__actionbar .review__stageall`,
`.review__foot .review__discard`→`.review__actionbar .review__more`. Deleted after Slice 5 (a
one-off; the repo's `tools/` holds only durable scripts).

## Slices

### Slice 1: Pure seams

**Check:** `npx vitest run test/unit/plural.test.ts test/unit/review-mode-layout.test.ts test/unit/review-nav-store.test.ts` green; `npm run typecheck` green.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3 · Serial: none

#### Task 1.1: `plural`
**Files:** Create `src/plural.ts`; Test `test/unit/plural.test.ts`.
**Interfaces:** Produces `plural(n, singular, pluralForm?)` as in Contracts.
**Steps:**
- [ ] Failing test: 'plural picks singular at 1 and the plural form otherwise' — `plural(1,'file')=='1 file'`, `plural(0,'file')=='0 files'`, `plural(2,'match','matches')=='2 matches'`.
- [ ] Run the test — expect FAIL (module missing). Implement.

#### Task 1.2: `reduceReviewLayout`
**Files:** Create `src/review-mode-layout.ts`; Test `test/unit/review-mode-layout.test.ts`.
**Interfaces:** Produces the reducer exactly as in Contracts.
**Steps:**
- [ ] Failing tests, one per transition line in Contracts (six), plus 'mode on twice sets the memory once'.
- [ ] Run — expect FAIL. Implement as a pure switch; no mutation of the input state.

#### Task 1.3: `review-nav-store`
**Files:** Create `webview/review-nav-store.ts`; Test `test/unit/review-nav-store.test.ts`.
**Interfaces:** Produces `publishReviewNav`, `subscribeReviewNav`, `getReviewNav`.
**Steps:**
- [ ] Failing tests: 'publish notifies subscribers and get returns the model'; 'publish(null) clears'; 'unsubscribe stops notifications'; 'publishing an identical reference does not notify'.
- [ ] Run — expect FAIL. Implement (`Set<Listener>`, module-level `let model`).

### Slice 2: Navigator in the right pane (rendered beside the still-present aside)

**Check:** `npm run typecheck` green; `npm run test:unit` green; `node test/e2e/run-smoke.mjs review-navigator` **after** its selectors point at `.right .review__navrow` (edit that one scenario by hand here; the scripted rename comes in Slice 5).

**Parallel groups:** G1: T2.1 · G2: T2.2 · Serial: T2.3, T2.4
**Claims (serial lane):** `webview/components/right-pane.tsx`, `webview/app.tsx`, `webview/styles.css`

#### Task 2.1: Move `ReviewFileNav` out, add sections and row actions
**Files:** Create `webview/components/review-file-nav.tsx`; Modify `webview/components/review-view.tsx` (delete the local `ReviewFileNav`, `NavRow`, `NAV_ROW_H` at ~175 and ~1955–2108; import the moved component and render it in the aside with `sections=[{id:'unstaged',label:'',files}]` so behavior is unchanged this slice).
**Interfaces:** Produces `ReviewFileNav`, `NavSection`, `NAV_ROW_H` as in Contracts (`NAV_SECTION_H` stays module-private). Consumes `computeWindow` (`webview/review-window.ts:36`), `ChangeDTO`, and `GitActionIntent` / `GitOp` / `IntentOp`, which this task moves from `right-pane.tsx:~80-90` into a new `webview/git-intent.ts` (types only); `right-pane.tsx` imports them from there and keeps re-exporting `GitActionIntent` so `app.tsx:52` and `center-pane.tsx` compile unchanged.
**Call sites:** `review-view.tsx:1707-1714` (the only renderer of `ReviewFileNav`).
**Steps:**
- [ ] Port test: `node test/e2e/run-smoke.mjs review-virtualize` and `review-navigator` green before and after the move (byte-identical row markup: keep `data-path`, `.review__navrow`, `.review__check`, `.review__navbtn`).
- [ ] Add the `NavItem` flattening, `NAV_SECTION_H`, the section header row (`.rnav__section` with label + optional review icon button `aria-label="Review <label> changes"`), `rowActions`/`onAction` rendering `.change__row-actions` inside the row when provided. Keep the arithmetic follow-scroll; it must index into items, not files.
- [ ] Unit: extend `test/unit/review-window.test.ts` with 'computeWindow with mixed estimate heights offsets section rows correctly' (two heights, assert `padTop` after scrolling past one section).

#### Task 2.2: `ReviewNavigator`
**Files:** Create `webview/components/review-navigator.tsx`.
**Interfaces:** Produces `ReviewNavigator` as in Contracts. Consumes `ReviewFileNav` (T2.1), `ReviewNavModel` (T1.3), `plural` (T1.1), `EmptyState` (`./empty-state`), `MenuState`/`MenuItem` (`./context-menu`), `conciseSourceLabel`/`reviewSourceLabel` (`../review-commit`), `IconRefresh`, `IconMore`, `IconReview`.
**Steps:**
- [ ] Header: reuse `.changes__header` / `.changes__header-summary`; working → `plural(n,'change') · +a −d`, refresh, kebab with the same five items `ChangesView` builds (`right-pane.tsx:216-268`; move that item-list builder into an exported `buildBulkMenuItems(staged, unstaged, onAction, close)` in `right-pane.tsx` and call it from both places — one owner). Commit/range → `plural(n,'file') · +a −d`, no refresh/kebab, caption line `.rnav__caption` with `reviewSourceLabel(source)`.
- [ ] `model === null` → header with `…` counts, `role="status"` line, no list.
- [ ] Filter row: `.review__filter` input `aria-label="Filter files"` bound to `model.filter`/`model.onFilter`; count `aria-live="polite"` `shown of total` when filter non-empty; Esc clears (stop propagation) as `review-view.tsx:1692-1699` did.
- [ ] Sections for working: `[{id:'staged',label:'Staged',files: files.filter(f=>f.staged)}, {id:'unstaged',label:'Changes',files: !staged}]`, dropping empty ones; commit/range: one section, label `''`. `rowActions` for working = the same arrays `ChangesView` passes to `ChangeRow` (staged → Unstage/Discard, unstaged → Stage/Discard, untracked → Stage file/Delete: copy the exact `{label, op, title}` triples from `right-pane.tsx` ~`:320-360` into an exported `rowActionsFor(change)` in `right-pane.tsx` and consume it).
- [ ] Empty: no files and no filter → `EmptyState title="No changes" hint="Nothing to review for this source."`; filter with no match → `.rnav__nomatch` `No files match`.
- [ ] Visually hidden `role="status"` `.sr-only` line: `Reviewing working tree` / `Reviewing commit <sha7>` / `Comparing <base> to <head>`.

#### Task 2.3: Right pane wiring
**Files:** Modify `webview/components/right-pane.tsx` (props, handle, render branch, `onTabShown`, delete local `RightTab`), Modify `webview/styles.css` (`.rnav*`, `.rnav__section`, `.rnav__caption`, `.sr-only` if absent, narrow container query `@container (max-width: 240px) .right .review__navstat { display:none }` — the `.right` already `container-type: inline-size`? if not, add it on `.right`).
**Interfaces:** Consumes `ReviewNavigator` (T2.2). Produces `RightPaneHandle.showChanges()`, props `reviewMode`, `onTabShown`.
**Call sites:** `app.tsx:2874-2912` (`<RightPane …>`), `app.tsx:462` (`rightPaneRef`).
**Steps:**
- [ ] `showChanges()` = bare `setTab('changes')` (non-persisting, beside `revealInTree` at `:1828-1843`).
- [ ] `useEffect(() => onTabShown?.(tab), [tab, onTabShown])`.
- [ ] Render: `tab === 'changes' ? (reviewMode ? <ReviewNavigator model={useSyncExternalStore(subscribeReviewNav, getReviewNav)} changes onAction={onGitAction} onRefresh={onRefreshChanges} onReviewScope onChangeContextMenu/> : <ChangesView …/>)`.
- [ ] Badge: in review mode the badge count is `model?.files.length ?? changes.length`.
- [ ] Unit: `test/unit/settings.test.ts` keeps passing (it reads `right-pane.tsx`); add 'RightPaneTab is imported from settings, no local alias' as a source-text assertion there.

#### Task 2.4: App wiring (no layout policy yet)
**Files:** Modify `webview/app.tsx` (derive `reviewMode`; `paneTab` state; pass `reviewMode`, `onTabShown` to `RightPane`), Modify `webview/components/review-view.tsx` (publish the model: `useEffect` on a `useMemo`'d `ReviewNavModel`; cleanup `publishReviewNav(null)`).
**Interfaces:** Consumes `publishReviewNav` (T1.3). `reviewMode = activeDoc?.kind === 'review' && centerView === 'editor'` where `activeDoc` is the same value `CenterPane` receives.
**Steps:**
- [ ] Model fields: `files` = the `files` array after filter (`review-view.tsx:460-466`), `totalCount = allFiles.length`, `truncated` from the existing banner condition, `activePath` (`:1329-1334`), `reviewed` (`:657`), `canMark = marks.loaded`, `filter = fileFilter`, `onPick = scrollToFile`, `onToggleReviewed`, `onFilter = setFileFilter`.
- [ ] Check: with Review active, the right pane's Changes tab shows the navigator and the aside still shows its own — both lists track the same active row while scrolling.

### Slice 3: Header, action bar, aside removal

**Check:** `npm run verify` green; `node test/e2e/run-smoke.mjs review-navigator` green with its footer assertions retargeted (hand-edit: `.review__actionbar .review__stageall`, `.review__actionbar .review__more`); visual look at Review in the built app against the canvas (Working tree + Commit source artboards) — screenshots to the scratch dir, not the repo.

**Parallel groups:** G1: T3.1 · G2: T3.2 · Serial: T3.3, T3.4
**Claims (serial lane):** `webview/components/review-view.tsx`, `webview/styles.css`, `webview/app.tsx`, `webview/components/center-pane.tsx`

#### Task 3.1: Segmented radios `disabled`; source control in header form
**Files:** Modify `webview/components/segmented-radios.tsx`, `webview/components/review-source-control.tsx`; Test `test/unit/review-scope-control.test.ts`.
**Interfaces:** Produces `SegmentedRadios` `disabled?`, `title?`; `ReviewSourceControl` prop `onOpenCompare: () => void`; classes `review__source`, `review__scope`.
**Call sites:** `center-pane.tsx:219-224` (removed in T3.4), `review-view.tsx` (added in T3.3); `segmented-radios` other callers (settings modal) unaffected by optional props.
**Steps:**
- [ ] Failing test: 'scope segment renders disabled buttons for a commit source' — every `[data-seg]` has `disabled`, group `aria-disabled="true"`, title text contains 'commit'. And 'working source renders enabled'.
- [ ] Implement. Docblock at `review-source-control.tsx:11-17` rewritten to point at spec 2026-09-05 §2.2 (it currently records the reversed decision).
- [ ] `close()` guards `triggerRef.current?.isConnected` before focusing.

#### Task 3.2: `Compare refs…` row; `IconSplit`; session card icon
**Files:** Modify `webview/components/commit-picker-menu.tsx` (prop `onOpenCompare`, final row with `IconCompare`, `separatorBefore`), `webview/icons.tsx` (`IconSplit`), `webview/components/session-card.tsx` (`<IconReview size={13}/>` before the label at `:245`).
**Interfaces:** Produces `CommitPickerMenu` prop `onOpenCompare`, `IconSplit`.
**Call sites:** `review-source-control.tsx` (forwards `onOpenCompare`).
**Steps:**
- [ ] `Compare refs…` row uses the existing row renderer; selecting it calls `onOpenCompare()` then `onClose()`.
- [ ] Register `IconSplit` in `CHROME_ICONS` as siblings are (`glyph('split', …)`).

#### Task 3.3: Review header + action bar; delete the aside
**Files:** Modify `webview/components/review-view.tsx`, `webview/styles.css`.
**Interfaces:** Consumes `ReviewSourceControl` (T3.1), `IconSplit` (T3.2), `plural` (T1.1), `handoffLabel` (`src/review-handoff.ts:65`), `computeReviewProgress` (`webview/review-stats.ts:43`), `MenuState`/`ContextMenu`. Produces new `ReviewView` props: `onSetSource`, `onOpenCompare`, `paneTab`, `explorerCollapsed`, `onTogglePanel`, `onShowChanges`.
**Steps:**
- [ ] Delete: `.review__side` aside, `.review__rail`, `navToggle` (`:1565-1576`), `.review__foot`, `.review__handoff`, `.review__narrative`, in-view `ReviewFileNav` render, `reviewFileListOpen` reads/writes (`:585`, `:1572`), the per-card `.rcard__split` button (`:2380-2389`). Delete their CSS (`styles.css` 9299–9314, 9432–9437 narrative, 9481–9517 foot, 10197–10202 handoff, `.gitband__*` 9701–9720, `.rcard__split`). Keep and re-scope `.review__filter*`, `.review__nav*`, `.review__navrow*` to the pane (`.right .review__…`).
- [ ] Header `.review__head` (full width, 40px, `display:flex; gap:8px; padding:0 12px; border-bottom:1px solid var(--border)`): left `.review__panel` toggle (`iconbtn`, glyph = sidebar rect with right divider `M9.5 3v10`; state per spec §2.2 from `paneTab`/`explorerCollapsed`; click → `explorerCollapsed ? onTogglePanel() : paneTab==='files' ? onShowChanges() : onTogglePanel()`), `<ReviewSourceControl source sessionId onSetSource onOpenCompare/>`; center `.review__stats` (`.review__sub` diffstat via `plural`, `.review__meter`, `.review__count` — `r / N reviewed`, and via `@container (max-width: 900px)` the word `reviewed` hidden); right `.review__find` iconbtn (`aria-pressed={searchOpen}`, toggles the find bar) and `.review__more` iconbtn opening a `ContextMenu` with `Collapse all`, `Expand all`, `Ignore whitespace` (checked → render `IconCheck` as the item `icon`; `aria-checked` via a `checked?: boolean` item field added to `MenuItem` if absent), `Keyboard shortcuts` (`hint:'?'`).
- [ ] Action bar `.review__actionbar` (44px, `border-top`, hidden when `files.length === 0`): left `.review__notes` `plural(n,'note') · plural(m,'pending')` when `repoNotes.length > 0`; right: working → `.review__more` iconbtn (menu: `Discard all changes…` danger → `onGitAction({op:'discardAll'})`), handoff `btn review__send` (existing label logic; **always rendered**, disabled at 0), `btn btn--primary review__stageall` `Stage all` → `onGitAction({op:'stageAll'})`; commit/range → handoff only.
- [ ] Card header: `Open side-by-side` = `button.rcard__sbs.iconbtn.iconbtn--sm` with `IconSplit size={13}`, `aria-label`/`title` "Open side-by-side diff", rendered only when `onOpenDiff && !diff?.binary && !isImage`; click `onOpenDiff(abs)`.
- [ ] Focus rules (spec §4): after the panel toggle collapses the pane, focus stays on the toggle (it is the actor); `ContextMenu` returns focus to its trigger on close (existing behavior — verify, don't add).
- [ ] Esc chain unchanged (`:372-389`); the header `⋯` menu closes on Esc through `ContextMenu`'s own `useEscapeKey` before the chain runs.

#### Task 3.4: Center pane + app wiring; band slimmed; layout policy
**Files:** Modify `webview/components/center-pane.tsx`, `webview/components/git-indicator-bar.tsx`, `webview/app.tsx`; Create `webview/use-review-mode-layout.ts`.
**Interfaces:** Consumes `reduceReviewLayout` (T1.2), `RightPaneHandle.showChanges` (T2.3), `ReviewView` props (T3.3). Produces
`useReviewModeLayout(input: { reviewMode: boolean; reviewDocOpen: boolean; explorerCollapsed: boolean; setExplorerCollapsed: (v: boolean) => void; showChanges: () => void }): { userToggledExplorer: () => void }` — the returned callback is what `toggleExplorer` calls before flipping the setting.
**Call sites:** `center-pane.tsx:163-236` (band), `:316-336` (`ReviewView`), `:360-370` (`CompareDialog` stays; `onOpenCompare={() => setCompareOpen(true)}` now passed to `ReviewView`); `git-indicator-bar.tsx:249-261` (Compare button deleted, `onOpenCompare` prop deleted, `STR` entries `:37-38` deleted, `compareEnabled` deleted if unused); `app.tsx:249-252` `toggleExplorer` dispatches `userToggledExplorer`; `app.tsx:2802` `onOpenReviewDiff`.
**Steps:**
- [ ] `showGitBand = !!active && (indicatorOn || repoPickerVisible)` — `reviewActive` deleted. Remove the `ReviewSourceControl` import and slot.
- [ ] Hook: `useEffect` on `reviewMode` → dispatch `{type:'mode', on, explorerCollapsed}`; on `reviewDocOpen` true→false → `{type:'reviewDocClosed', explorerCollapsed}`; apply effects: `setExplorerCollapsed !== undefined → update({explorerCollapsed})`, `showChanges → requestAnimationFrame(() => rightPaneRef.current?.showChanges())` (rAF because the pane may mount this frame, as `openGlobalSearch` does). State in a `useRef<ReviewLayoutState>`.
- [ ] `toggleExplorer` and `togglePanel('explorer')` both route through one function that also dispatches `userToggledExplorer`. `onTogglePanel` prop for the header = that function.
- [ ] `openDiff(path, targetSessionId?, opts?)` — add `sideBySide` to the dispatch; delete `openSplitDiff`; `onOpenReviewDiff={(abs) => openDiff(abs, undefined, { sideBySide: true })}`.
- [ ] `docs.ts`: `sideBySide?` on `OpenDoc` and on the `open` action; the reducer copies it when creating or re-activating a diff doc; `serializeDocs`/restore strips it (same place `reviewSource` is stripped, `docs.ts:409`).
- [ ] `DiffViewer` receives only the `FileDiffDTO` (`doc-view.tsx:74`). Add prop `initialSideBySide?: boolean` to `DiffViewer` and `TextDiffViewer`; `doc-view.tsx:74` passes `initialSideBySide={doc.sideBySide}` from the `OpenDoc` it already holds; `diff-viewer.tsx:68` becomes `renderSideBySide: initialSideBySide ?? settings.diffSideBySide`. The live-apply effect at `:117-123` stays keyed on the setting; the toolbar's pressed state at `:147-153` reads the editor's current option, not the setting, so it matches what is painted.
- [ ] `docs.ts` `toPersistedDocs` (`:412`) already projects to `PersistedDoc`; confirm `sideBySide` is not a `PersistedDoc` field so it is dropped by construction.
- [ ] `src/settings.ts`: delete `reviewFileListOpen` at `:112`, `:204-206`, `:440`; update `test/unit/settings.test.ts` / `coerce-settings.test.ts` expectations.

### Slice 4: Menus and edge behavior

**Check:** `npm run verify` green; manual: open source picker, close Review with it open → no focus error in devtools console; Board view while Review active → Changes tab shows status list.

**Parallel groups:** Serial: T4.1

#### Task 4.1: Edge cases from spec §4
**Files:** Modify `webview/components/review-view.tsx`, `webview/components/review-navigator.tsx`, `webview/components/review-file-nav.tsx`.
**Steps:**
- [ ] Focus after a row's `Discard` removes the focused row: `ReviewFileNav` keeps `scrollerRef` focusable (`tabIndex={-1}`); when the focused `data-path` disappears from `sections`, focus the scroller (`useEffect` diffing the previous path set).
- [ ] Compare dialog close returns focus to `.review__source` (pass `triggerRef` focus in `onOpenCompare`'s close path: `ReviewView` focuses `.review__source` in a `useEffect` when `compareWasOpen` flips false — simplest: `CenterPane`'s `onCancel`/`onCompare` call a `returnFocus` that queries `.review__source` inside the review root).
- [ ] Header container query for the narrow center (`.review { container-type: inline-size }`): at `max-width: 900px` hide the word `reviewed`; at `max-width: 720px` hide the meter.

### Slice 5: Test migration

**Check:** `node test/e2e/run-smoke.mjs` full suite green, serially, on a quiet machine; `npm run verify` green.

**Parallel groups:** Serial: T5.1, T5.2, T5.3

#### Task 5.1: Scripted selector rename
**Files:** Create `tools/rename-selectors.mjs`; Modify every `test/e2e/*.e2e.mjs` listed in spec §7.3 and `test/e2e/visual/shoot.mjs`.
**Steps:**
- [ ] Script: args are `from to` pairs; walks `test/e2e/**/*.mjs`; literal replace; prints per-file counts; exits 1 if a `from` string was found nowhere (typo guard).
- [ ] Run with the seven pairs from **Scripts**; commit the diff; **delete the script** (one-off).

#### Task 5.2: Scenario logic updates
**Files:** Modify `test/e2e/review-entry-point.e2e.mjs` (assert band has History + Review only, no `.git-indicator__compare`), `review-navigator.e2e.mjs` (rows live under `.right`; the aside-collapse steps at `:56-58` become: press `Mod+Shift+E` → `.right` detached, header + action bar still present → press again), `review-search.e2e.mjs` (filter lives in `.right .review__filterinput`), `review-commit-picker.e2e.mjs` (`onBand` assertion inverted: trigger is inside `.review__head`; add: last row is `Compare refs…`), `review-compare.e2e.mjs` (open via picker row instead of the band button), `review-scope.e2e.mjs` (segment inside `.review__head`; commit source → buttons disabled), `split-diff-map.e2e.mjs` (read `diffSideBySide` from the settings file before/after: unchanged), `review-keymap-persist.e2e.mjs`, `review-tab-state.e2e.mjs` (filter round-trip through the pane), `review-virtualize.e2e.mjs` (navigator row count under `.right`), `band-alignment.e2e.mjs` / `git-band-persistence.e2e.mjs` (drop `compare` expectations), `visual/shoot.mjs:175-182`.
**Steps:**
- [ ] Each scenario alone: `node test/e2e/run-smoke.mjs <name>`; fix the assertion, never the product, unless the product is wrong — then stop and report.

#### Task 5.3: `review-mode-pane.e2e.mjs`
**Files:** Create `test/e2e/review-mode-pane.e2e.mjs`.
**Steps:**
- [ ] Gherkin 1: collapse the pane (`Mod+Shift+E`), `Mod+Shift+R` → `.right` visible, `.rtab--active` text `Changes`, `.right .review__navrow` count 4, `.tabbar__trail .review__source` absent.
- [ ] Gherkin 2: close the Review tab → `.right` detached; settings file `rightPaneTab` unchanged from the run's initial value.
- [ ] Gherkin 3: enter from collapsed, `Mod+Shift+E` twice, close Review → `.right` still visible.
- [ ] Board view mid-review → `.right .rnav` absent, `.right .change` rows present; back to editor → `.rnav` present.

### Slice 6: Ship

**Check:** `npm run verify` green on the merged tree; `git status` shows only intended files.

#### Task 6.1: Changelog, docs, archive
**Files:** Modify `CHANGELOG.md` (`[Unreleased]`: Review header/action bar, Changes tab as navigator, Compare in the picker, `Stage all`, `Open side-by-side` no longer flips the global setting, `reviewFileListOpen` removed), `docs/specs/INDEX.md` (row → Shipped, `git mv` spec to `docs/specs/archive/`), `docs/runs/2026-09-05-review-mode/report.md` (short run report per ADR 0003).
**Steps:**
- [ ] `git mv docs/specs/2026-09-05-review-mode.md docs/specs/archive/`; fix the INDEX link.

## Verification

Per task: the named vitest file(s) + `npm run typecheck`. Per slice: the slice **Check**. Before
integration: `npm run verify` (never piped), then the full smoke suite serially. Exit codes read
directly.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. Report leads with the fix that keeps the locked decision.
