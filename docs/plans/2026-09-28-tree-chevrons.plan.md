# tree-chevrons — implementation plan

**Spec:** `docs/specs/2026-09-28-tree-chevrons.md`  **Tier:** FULL

Tier reason: a new shared primitive (`TreeChevron` + `.treechev` / `.treehead` / row custom
properties) consumed by two surfaces, plus a state owner move (Changes collapse → `RightPane`).
Not built: no `treechev`/`treehead`/`TreeChevron` anywhere in `webview/`, `src/`, `test/`; the spec
file is untracked.

Line anchors are from `beb4253`. After an earlier slice lands, find code **by name**, not by line.

## Goal

The Files folder bar and the Changes repo head both lead with the same left-hand chevron, on one
column shared with the depth-0 tree rows, and Changes rows take the Files row metrics; a collapsed
Changes repo survives a tab switch.

## Architecture

One decorative component (`webview/components/tree-chevron.tsx`) and one CSS family replace three
chevron implementations. Geometry lives in custom properties declared once — row geometry on
`.rightpane`, header geometry on `.treehead` — and every consumer computes from them, so the
header chevron centre (+16), the row chevron centre (+16), the header folder glyph (+32), and the
row icon / status-box column (+28) are derived, not literal. Changes' collapsed set moves from
`ChangesView` `useState` to a mutable `Set` owned by `RightPane`, the same shape and lifetime as
`FolderUiCache.collapsed`.

## Data flow

```
RightPane (mounted for the app's lifetime)
 ├─ folderUiRef.current.collapsed : Set<folderKey>      (unchanged)  ─► FilesView ─► FolderSection ─► FolderBar
 └─ changesCollapsedRef.current   : Set<folderKey>      (NEW owner)  ─► ChangesView (prop collapsedRepos)
                                                                          toggle(root): mutate set, bump local tick
                                                                          └─► RepoHead collapsed ─► TreeChevron open={!collapsed}
Tab switch unmounts ChangesView / FilesView; both sets live on in RightPane refs.
```

Header geometry (from the header's left edge, Aero at font-scale 1):

```
| pad 4 | chevron button 24 (glyph 12 centred → centre +16) | gap 4 | folder glyph 13 @ +32 | gap 4 | name @ +49 …
Row:  | --tree-pad 10 | chevron/spacer 12 (centre +16) | --tree-gap 6 | icon / status box @ +28 | gap 6 | name …
```

## Settled decisions — do not re-litigate

- **D1** Tiny `TreeChevron` + `TreeChevronSpacer` component, `.treechev` / `.treehead` classes, row
  custom properties. No shared `TreeRow` component.
- **D2** Only the chevron button toggles a header; name click keeps its current meaning.
- **D3** Changes rows stay non-focusable, no tree role.
- **D4** Changes home head drops the accent-6% fill; all heads use the neutral overlay.
- **D5** Active-diff highlight is the sibling item's (`changes-active-highlight`, built after this).
  `ChangeRow` stays the row component and `.change` stays its root class so `.change--active` lands
  on the converged row. Do not rename, split or wrap `ChangeRow`.
- **D6** Files and Changes collapse caches stay separate.
- Chevron glyph everywhere: `IconChevron` 12px, `rotate(90deg)` when open, 0.1s, `none` under
  reduced motion. Header chevron centre = depth-0 row chevron centre. Row height 22px. Scroll gutter
  6px. Row radius `--r-card`. Row name mono 12px. Tag = `RepoTagPill`'s treatment.

## Spec staleness

- Spec §3 says the reduced-motion guard comes "from `.files__bar-chev`": true (`webview/styles.css`
  6714–6718). No stale claims found; the measured table in spec §2 was taken as given (it was
  measured in the running app on 2026-09-28).
- Spec §3 names `TreeChevronSpacer()` with no arguments. A header spacer (inventory row 23) must be
  the 24px button width, not the 12px row slot, so the plan gives it a `size` argument (Contracts).
  Additive, same component — not a re-litigation of D1.
- Spec inventory row 9 says the tag takes `RepoTagPill`'s CSS and "each surface keeps its own
  narrow-hiding". Plan: `FolderBar` renders `RepoTagPill` itself; Files' clip rule is re-targeted to
  `.files__root > .repo-head__tag` (mirrors Changes' existing `.repo-head > .repo-head__tag`), and
  `.files__tag` disappears entirely. This touches `test/e2e/mf-files.e2e.mjs` (two `.files__tag`
  queries).

## Global constraints

- Gate: `npm run verify` (exit code captured, never piped). Typecheck runs both tsconfigs.
- Never touch the git worktree state beyond the files in the file map; do not commit unless the
  conductor's build step says so.
- **No redundant comments** (CLAUDE.md). New CSS comments only for a non-obvious *why*; point at the
  spec (`/* see docs/specs/2026-09-28-tree-chevrons.md §2 row 6 */`) rather than re-explain it.
- **Delete, never override.** Every CSS rule named "delete" below is removed outright. No
  `!important`, no selector whose only purpose is to out-rank another, no property defined on both
  `.treehead` and `.files__bar`/`.repo-head` (each property lives in exactly one rule, so nothing
  depends on source order).
- Class names are Conduit shapes (`treechev`, `treehead`); never `twistie` or another bare generic
  name (`test/unit/monaco-class-collision.test.ts`).
- Colours only via existing tokens; no raw hex. Radii only via `--r-*` tokens.
- Custom properties in a React `style` use the repo's existing pattern:
  `style={{ ['--depth' as string]: depth }}` (precedent `webview/components/animated-bg.tsx:113`).
- Tests: vitest, jsdom via `// @vitest-environment jsdom`, React via `createRoot` + `act`
  (pattern: `test/unit/change-row-drag.test.ts`). e2e on `test/e2e/harness.mjs`, launched hidden.
- Tests must be CI-safe on Linux (no win32 path assumptions in unit tests).

## Out of scope

Review navigator (`.rcard__chev`), sidebar project groups (`.proj__chevron`), markdown TOC, every
`IconChevronDown` used as a menu caret (incl. `.repo-head__caret`), Files tree keyboard/behaviour,
Changes "View as tree", Changes row keyboard nav, `.change--active`, the missing-folder box
(`.files-missing__tag`).

## Contracts

### `webview/components/tree-chevron.tsx` (new)

```ts
import { IconChevron } from '../icons';

/** Decorative: the enclosing button / treeitem owns aria-expanded. */
export function TreeChevron({ open }: { open: boolean }): JSX.Element
//   → <IconChevron size={12} className={open ? 'treechev treechev--open' : 'treechev'} />

export function TreeChevronSpacer({ size = 'row' }: { size?: 'row' | 'head' }): JSX.Element
//   → <span className={size === 'head' ? 'treechev-spacer treechev-spacer--head' : 'treechev-spacer'} aria-hidden="true" />
```

Use whatever element return type the neighbouring components use (they omit it — omit it too).

### `ChangesViewProps` (`webview/components/changes-view.tsx`) — one new required field

```ts
/** Collapsed repos, keyed by folderKey(root). Owned and mutated in place so it outlives this
 *  view (RightPane holds it, like FolderUiCache). */
collapsedRepos: Set<string>;
```

`RightPane`'s own props become `Omit<ChangesViewProps, 'model' | 'collapsedRepos'> & {…}` so
`webview/app.tsx` is unchanged.

Invariants: a repo is collapsible only in the All view (`model.view === 'all' && collapsedRepos.has(folderKey(root))`,
exactly as today's `isCollapsed`); the set is never cleared (not on `ChangesModel` refresh, tab
switch, or session switch); a stale key for a removed repo is harmless.

### CSS custom properties

On `.rightpane` (row geometry, consumed by `.filerow`, `.change`, `.changes__section`, `.repo-head__empty`, `.treechev-spacer`):

| Property | Value |
|---|---|
| `--tree-row-h` | `calc(22px * var(--font-scale))` |
| `--tree-pad-y` | `2px` |
| `--tree-pad` | `10px` |
| `--tree-indent` | `14px` |
| `--tree-gap` | `6px` |
| `--tree-chev` | `12px` |

On `.treehead` (header geometry): `--treehead-lead: 24px` (the `.iconbtn--sm` width the chevron
button occupies), `--treehead-gap: 4px`.

Row chevron colour channel: `.treechev { color: var(--tree-chev-color, currentColor) }`;
`.filerow { --tree-chev-color: var(--text-faint) }`. The header button sets no channel, so its
glyph follows the `.iconbtn` quiet-role ladder via `currentColor` (spec inventory row 4).

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Changes collapsed set | `ChangesView.toggle` (today `useState`) → after: mutates `RightPane`'s `changesCollapsedRef.current` | `ChangesView` render → `RepoHead collapsed` / `listId` | both (Slice 4) |
| Files collapsed set | `FilesView.toggleCollapsed` → `FolderUiCache.collapsed` (`files-view.tsx:662`) | `FolderSection` → `FolderBar` | consumer only (glyph); producer unchanged — measured: `FolderBar` still receives `collapsed: boolean` and `onToggle` |
| `first-chevron` focus target | `ChangesView.setView(..., 'first-chevron')` (`changes-view.tsx:209`, `:387`) | `querySelector('.repo-head__chev')` (`changes-view.tsx:197`) | both: button keeps class `repo-head__chev`; only its CSS goes |
| Folder-row detection by chevron class | `folder-section.tsx` rows emit `.filerow__chev` (→ `.treechev`) | `test/e2e/middle-click-explorer.e2e.mjs:355`, `test/e2e/tabbar-overflow.e2e.mjs:67` (`!r.querySelector('.filerow__chev')`) | both (Slice 1) |
| Files tag element | `FolderBar` `.files__tag` (→ `RepoTagPill` `.repo-head__tag`) | `test/e2e/mf-files.e2e.mjs:87,97` | both (Slice 2) |
| `.rightpane__scroll` gutter | `styles.css` rule | Changes body, **and** `search-pane.tsx:185,492` search results | both: search results also move from 8px to 6px — intended (the Search results live in the Files tab, whose gutter is the reference) |
| `.repo-head__tag` pill | `RepoTagPill` (`repo-picker-menu.tsx:23`) | `RepoHead`, `RepoPickerMenu` rows, and (new) `FolderBar` | CSS unchanged; new consumer only |
| `.repo-head--home` class | `RepoHead` className | CSS rules (both deleted) | producer keeps emitting it (harmless, used by nothing after); do not remove it from TSX — sibling items may key on it |

Negative claims measured by recursive grep over `webview/`, `src/`, `test/` (incl. `test/e2e/visual/`):
`files__bar-chev`, `repo-head__chev--collapsed`, `files__collapse` have no consumer outside the files
this plan edits; `filerow__chev` only the two e2e files above; `files__tag` only `mf-files.e2e.mjs`.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/components/tree-chevron.tsx` | create | `TreeChevron`, `TreeChevronSpacer` |
| `webview/components/folder-section.tsx` | modify | rows use `TreeChevron`/`TreeChevronSpacer`; `--depth` style var replaces `paddingLeft` literals (lines 1012, 1035–1040, 1111, 1114) |
| `webview/components/folder-bar.tsx` | modify | chevron button first; `TreeChevron`; `treehead` class; `RepoTagPill`; drop `STR` |
| `webview/components/repo-head.tsx` | modify | `TreeChevron`; `treehead` class; head spacer in Active view |
| `webview/components/changes-view.tsx` | modify | `ChangeRow` leads with `TreeChevronSpacer`; `collapsedRepos` prop replaces `useState` |
| `webview/components/right-pane.tsx` | modify | owns `changesCollapsedRef`; passes it |
| `webview/styles.css` | modify | new `.treechev*`, `.treehead`, custom properties; deletions listed per slice |
| `test/unit/tree-chevron.test.ts` | create | component + header-structure tests |
| `test/unit/tree-chevron-css.test.ts` | create | stylesheet guard: old rules gone, guard present |
| `test/unit/changes-view-collapse.test.ts` | create | collapse cache survives remount; row spacer; Active spacer |
| `test/unit/change-row-drag.test.ts` | modify | pass `collapsedRepos: new Set()` (line ~49) |
| `test/e2e/middle-click-explorer.e2e.mjs` | modify | line 355 `.filerow__chev` → `.treechev` |
| `test/e2e/tabbar-overflow.e2e.mjs` | modify | line 67 `.filerow__chev` → `.treechev` |
| `test/e2e/mf-files.e2e.mjs` | modify | lines 87, 97 `.files__tag` → `.repo-head__tag` |
| `test/e2e/tree-chevrons.e2e.mjs` | create | AC1–AC10, AC12 (geometry part), AC13 in aero, aero-dark, neon |
| `CHANGELOG.md` | modify | one `### Changed` bullet under `[Unreleased]` |

## Scripts

None. The only repeated edit is three one-line selector swaps in e2e files — by hand.

## Slices

All slices run **serially, one executor, in order**. `webview/styles.css` is edited by Slices 1–3
and `changes-view.tsx` by Slices 3–4; the remaining disjointness (Slice 4 vs 1–2) is not worth a
second lane on a change this size.

**Parallel groups:** Serial: S1 → S2 → S3 → S4 → S5
**Claims (serial lane):** `webview/styles.css`, `webview/components/changes-view.tsx`, `CHANGELOG.md`

### Slice 1: primitive + Files tree rows

**Check:** `npx vitest related webview/components/tree-chevron.tsx webview/components/folder-section.tsx --run`
green (incl. new `tree-chevron.test.ts` T1 cases, `tree-chevron-css.test.ts` row cases) and
`npm run typecheck` green.

#### Task 1.1: `TreeChevron` component + CSS family

**Files:**
- Create: `webview/components/tree-chevron.tsx`
- Modify: `webview/styles.css` (the `.filerow`/`.filerow__chev` block ~6593–6615; `.rightpane` ~4802)
- Test: `test/unit/tree-chevron.test.ts`, `test/unit/tree-chevron-css.test.ts`

**Interfaces:**
- Produces: `TreeChevron({ open }: { open: boolean })`, `TreeChevronSpacer({ size }: { size?: 'row' | 'head' })`
  (contracts above); CSS classes `.treechev`, `.treechev--open`, `.treechev-spacer`,
  `.treechev-spacer--head`; custom properties on `.rightpane` (table above).

**Steps:**
- [ ] Failing tests in `test/unit/tree-chevron.test.ts` (jsdom):
  - `'TreeChevron renders a 12px chevron marked open only when open'` — `open` → svg has classes
    `treechev treechev--open`, `width="12"`; `!open` → `treechev` without `treechev--open`.
  - `'TreeChevronSpacer is a hidden 12px slot, or the head column with size head'` — classes
    `treechev-spacer` / `treechev-spacer treechev-spacer--head`; `aria-hidden="true"`.
- [ ] Failing tests in `test/unit/tree-chevron-css.test.ts` (reads `webview/styles.css` as text, as
  `monaco-class-collision.test.ts` does):
  - `'the old row chevron rules are deleted'` — no occurrence of `filerow__chev`.
  - `'.treechev rotates 90deg when open and snaps under reduced motion'` — a rule
    `.treechev--open` with `transform: rotate(90deg)`; inside an `@media (prefers-reduced-motion: reduce)`
    block, a `.treechev` rule with `transition: none`.
- [ ] Run `npx vitest run test/unit/tree-chevron.test.ts test/unit/tree-chevron-css.test.ts` — expect FAIL (module/rules absent).
- [ ] Create the component per contract.
- [ ] CSS: **delete** `.filerow__chev`, `.filerow__chev--open`, `.filerow__chev-spacer`. In their place add:
  `.treechev { flex: none; color: var(--tree-chev-color, currentColor); transition: transform 0.1s; }`,
  `.treechev--open { transform: rotate(90deg); }`,
  `.treechev-spacer { flex: none; width: var(--tree-chev); }`,
  `.treechev-spacer--head { width: var(--treehead-lead); }`,
  `@media (prefers-reduced-motion: reduce) { .treechev { transition: none; } }`.
  Add the six row custom properties to the existing `.rightpane` rule.
- [ ] Run the two tests — PASS.

#### Task 1.2: Files tree rows on the primitive and the row properties

**Files:**
- Modify: `webview/components/folder-section.tsx` (row render ~1003–1041; draft row ~1109–1115)
- Modify: `webview/styles.css` (`.filerow` rule ~6593)
- Modify: `test/e2e/middle-click-explorer.e2e.mjs:355`, `test/e2e/tabbar-overflow.e2e.mjs:67`

**Interfaces:**
- Consumes: `TreeChevron({ open }: { open: boolean })`, `TreeChevronSpacer()` from
  `webview/components/tree-chevron.tsx`; custom properties `--tree-row-h`, `--tree-pad-y`,
  `--tree-pad`, `--tree-indent`, `--tree-gap` on `.rightpane`.

**Steps (port carve-out: proof is the existing suite staying green + the Slice 5 e2e geometry):**
- [ ] Folder row: `<IconChevron size={12} className="filerow__chev …" />` → `<TreeChevron open={node.expanded} />`;
  file row / draft row `<span className="filerow__chev-spacer" />` → `<TreeChevronSpacer />`.
  Remove `IconChevron` from the `../icons` import (line 55) — this was its only use.
- [ ] Both `style={{ paddingLeft: 10 + depth * 14 }}` → `style={{ ['--depth' as string]: depth }}`.
- [ ] `.filerow`: `gap: var(--tree-gap)`; `padding: var(--tree-pad-y) 8px var(--tree-pad-y) calc(var(--tree-pad) + var(--depth, 0) * var(--tree-indent))`;
  add `min-height: var(--tree-row-h)` and `--tree-chev-color: var(--text-faint)`. Leave the rest of the rule.
- [ ] Swap `.filerow__chev` → `.treechev` in the two e2e files.
- [ ] `npx vitest related webview/components/folder-section.tsx --run`; `npm run typecheck`.

### Slice 2: header convergence (Files bar + Changes head)

**Check:** `npx vitest related webview/components/folder-bar.tsx webview/components/repo-head.tsx --run`
green incl. the new header cases below; `npm run typecheck` green.

#### Task 2.1: `.treehead` and both header components

**Files:**
- Modify: `webview/components/folder-bar.tsx`, `webview/components/repo-head.tsx`
- Modify: `webview/styles.css` (`.repo-head` block ~5469–5605; `.files__bar-chev`/`.files__bar`/`.files__tag` block ~6706–6792; field role lists ~13650 and ~13698)
- Modify: `test/e2e/mf-files.e2e.mjs:87,97`
- Test: `test/unit/tree-chevron.test.ts`, `test/unit/tree-chevron-css.test.ts`

**Interfaces:**
- Consumes: `TreeChevron({ open }: { open: boolean })`, `TreeChevronSpacer({ size }: { size?: 'row' | 'head' })`;
  `RepoTagPill({ tag }: { tag: RepoTag })` from `webview/components/repo-picker-menu.tsx`
  (`FolderSectionModel['kind']` is `'home' | 'attached'`, assignable to `RepoTag`).

**Steps:**
- [ ] Failing tests, appended to `test/unit/tree-chevron.test.ts`:
  - `'FolderBar leads with the collapse button'` — render `FolderBar` (noop handlers, a home
    section); `.files__bar`'s `firstElementChild` is `button.files__collapse` containing
    `svg.treechev`; collapsed=false → `treechev--open` and `aria-expanded="true"`; the bar also has
    class `treehead`; the tag is a `.repo-head__tag.repo-head__tag--home` with text `Home`.
  - `'RepoHead leads with the chevron in All and a head spacer in Active'` — All view:
    `firstElementChild` is `button.repo-head__chev` containing `svg.treechev`, collapsed=true → no
    `treechev--open`; Active view: `firstElementChild` is `span.treechev-spacer--head`, no
    `.repo-head__chev`; root has class `treehead` in both.
- [ ] Failing cases in `test/unit/tree-chevron-css.test.ts`:
  - `'old header chevron, tag and home-fill rules are deleted'` — no `files__bar-chev`,
    `repo-head__chev` (anywhere — also gone from the role lists), `files__tag`, `.repo-head--home`,
    `.repo-head--active .repo-head__sub`.
  - `'.files__bar no longer justifies its content'` — the `.files__bar {…}` rule body has no `justify-content`.
- [ ] Run — expect FAIL.
- [ ] `folder-bar.tsx`: move the collapse `<button>` to be the **first** child of `.files__bar`
  (before `.files__root`); its content becomes `<TreeChevron open={!collapsed} />`; root
  className `treehead files__bar`; tag span → `<RepoTagPill tag={section.kind} />`; delete `STR`
  and the `IconChevronDown` import. `collapseRef`, labels, `aria-*`, `onKeyDown` unchanged.
- [ ] `repo-head.tsx`: root className `treehead repo-head repo-head--${tag} repo-head--${view}`;
  chevron button className `iconbtn iconbtn--sm repo-head__chev` (drop the `--collapsed` modifier),
  content `<TreeChevron open={!collapsed} />`; when `view !== 'all'` render
  `<TreeChevronSpacer size="head" />` in the chevron's place. Keep `IconChevronDown` for `.repo-head__caret`.
- [ ] CSS, add before the `/* ---------- repo head` section:
  `.treehead { --treehead-lead: 24px; --treehead-gap: 4px; display: flex; align-items: center; gap: 2px var(--treehead-gap); min-height: 32px; padding: 3px 4px; border-radius: var(--r-sm); background: rgba(var(--overlay), 0.035); font-family: var(--font-ui); font-size: calc(12px * var(--font-scale)); }`
  and `.treehead > .iconbtn { flex: none; }`.
- [ ] CSS deletions (remove the declaration or rule, never override):
  - `.repo-head`: delete `display`, `align-items`, `gap`, `min-height`, `padding`, `border-radius`,
    `background`, `font-family`, `font-size` (keep `container`, `flex-wrap`, `margin`).
  - `.repo-head--home { background … }` — delete rule.
  - `.repo-head__chev { … }` and `.repo-head__chev--collapsed svg { … }` — delete rules.
  - `.repo-head__glyph`: delete `margin-inline-start`; `color` → `var(--accent)`.
    `.repo-head--home .repo-head__glyph` — delete rule.
  - `.repo-head__sub`: `padding-inline-start` → `calc(var(--treehead-lead) + 2 * var(--treehead-gap) + 13px)`
    (13px = the folder glyph's rendered size). `.repo-head--active .repo-head__sub` — delete rule.
  - `.files__bar-chev`, `.files__bar-chev--open`, and the reduced-motion `@media` block holding only
    `.files__bar-chev` — delete.
  - `.files__bar`: delete `display`, `align-items`, `justify-content`, `gap`, `min-height`,
    `padding`, `border-radius`, `background` (keep `container`). `.files__bar > .iconbtn` — delete
    (moved to `.treehead > .iconbtn`).
  - `.files__tag`, `.files__tag--home`, `.files__tag--attached` — delete. In
    `@container files-bar (max-width: 200px)` change the selector `.files__tag` →
    `.files__root > .repo-head__tag` (same clip declarations). In the `@media (forced-colors: active)`
    list `.files__tag, .files-missing__tag` drop `.files__tag` (the existing `.repo-head__tag`
    forced-colors rule covers it).
  - Remove `.repo-head__chev,` from both field role selector lists (~13650 and ~13698).
- [ ] `test/e2e/mf-files.e2e.mjs:87,97`: `.files__tag` → `.repo-head__tag`.
- [ ] Run the Slice 2 check.

### Slice 3: Changes rows on the row metrics

**Check:** `npx vitest related webview/components/changes-view.tsx --run` green incl.
`'change rows lead with a row spacer'`; `npm run typecheck` green.

#### Task 3.1: `ChangeRow` leading spacer + row CSS

**Files:**
- Modify: `webview/components/changes-view.tsx` (`ChangeRow`, ~63–128)
- Modify: `webview/styles.css` (`.rightpane__scroll` ~5341, `.change` ~5347, `.change__path` ~5395, `.changes__section` ~5446, `.repo-head__empty` ~5593, `.rightpane__scroll--files` ~5647)
- Test: `test/unit/changes-view-collapse.test.ts` (create; harness copied in shape from `test/unit/change-row-drag.test.ts` — `changesModel(...)` from `src/changes-view-model`, `createElement(ChangesView, {...})`)

**Interfaces:**
- Consumes: `TreeChevronSpacer()`; custom properties `--tree-row-h`, `--tree-pad-y`, `--tree-pad`, `--tree-gap`, `--tree-chev`.

**Steps:**
- [ ] Failing test `'change rows lead with a row spacer'` — every `.change`'s `firstElementChild` has
  class `treechev-spacer` (not `--head`), and its second child is `.change__kind`. The file's
  render helper takes no cache yet; Task 4.1 adds `collapsedRepos` to it.
- [ ] Run — FAIL.
- [ ] `ChangeRow`: insert `<TreeChevronSpacer />` as the first child of `.change`. Nothing else in
  `ChangeRow` changes; `.change` stays the root class.
- [ ] CSS:
  - `.rightpane__scroll` `padding: 2px 8px 12px` → `2px 6px 12px`; `.rightpane__scroll--files`
    `padding: 6px 6px 12px` → `padding-top: 6px`.
  - `.change`: `gap` → `var(--tree-gap)`; `padding` → `var(--tree-pad-y) 8px var(--tree-pad-y) var(--tree-pad)`;
    `border-radius` → `var(--r-card)`; add `min-height: var(--tree-row-h)`.
  - `.change__path` `font-size` → `calc(12px * var(--font-scale))`.
  - `.changes__section` `padding` → `8px 8px 4px calc(var(--tree-pad) + var(--tree-chev) + var(--tree-gap))`.
  - `.repo-head__empty` `padding` → `5px 8px 3px calc(var(--tree-pad) + var(--tree-chev) + var(--tree-gap))`.
- [ ] Run the Slice 3 check.

### Slice 4: Changes collapse outlives the tab

**Check:** `npx vitest related webview/components/changes-view.tsx webview/components/right-pane.tsx --run`
green incl. the two collapse cases; `npm run typecheck` green.

#### Task 4.1: move the collapsed set to `RightPane`

**Files:**
- Modify: `webview/components/changes-view.tsx` (`ChangesViewProps` ~42; `ChangesView` state ~183, `toggle` ~260)
- Modify: `webview/components/right-pane.tsx` (props type ~62; refs ~139; `<ChangesView …>` ~228)
- Modify: `test/unit/change-row-drag.test.ts` (~49: add `collapsedRepos: new Set()`)
- Test: `test/unit/changes-view-collapse.test.ts`

**Interfaces:**
- Produces: `ChangesViewProps.collapsedRepos: Set<string>` (keyed by `folderKey(root)`, mutated in place).
- Consumes: `folderKey` from `src/folder-key` (already imported in `changes-view.tsx`).

**Call sites** of `ChangesView` (every one must pass the prop): `webview/components/right-pane.tsx:228`,
`test/unit/change-row-drag.test.ts:49`, `test/unit/changes-view-collapse.test.ts` (new).
`webview/app.tsx` renders `RightPane`, not `ChangesView` — unchanged via the `Omit`.

**Steps:**
- [ ] Failing tests in `test/unit/changes-view-collapse.test.ts` (two repos `/w/home` home +
  `/w/ref` attached, each with one change, `view: 'all'`):
  - `'a collapsed repo stays collapsed across a remount with the same cache'` — shared
    `const cache = new Set<string>()`; click the second `.repo-head__chev` → its `aria-expanded`
    is `"false"` and `cache.has(folderKey('/w/ref'))`; unmount; render again with the same
    `cache` → the second `.repo-head__chev` has `aria-expanded="false"` and no `.repo-head__list`
    follows that head.
  - `'the cache is not consulted in the Active view'` — `cache` pre-seeded with the home key,
    `view: 'active'` → the head's list is rendered and no `.repo-head__chev` exists.
- [ ] Run — FAIL (prop ignored; state is local).
- [ ] `ChangesView`: add `collapsedRepos` to props and destructuring; delete
  `const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(…)`; add
  `const [, setCollapseTick] = useState(0);` in the same position (above the `no-repos` early
  return); `toggle(root)` mutates `collapsedRepos` (add/delete `folderKey(root)`) then
  `setCollapseTick((t) => t + 1)`; `isCollapsed` reads `collapsedRepos.has(folderKey(root))`.
- [ ] `RightPane`: beside `folderUiRef`, `const changesCollapsedRef = useRef<Set<string>>(new Set());`
  (extend the existing "owned here so it outlives …" comment to cover both refs rather than
  adding a second one); props type `Omit<ChangesViewProps, 'model' | 'collapsedRepos'>`;
  `<ChangesView model={changesModel} collapsedRepos={changesCollapsedRef.current} {...changesProps} />`.
- [ ] `change-row-drag.test.ts`: add `collapsedRepos: new Set()`. `changes-view-collapse.test.ts`'s
  render helper takes a `cache: Set<string>` argument and passes it as `collapsedRepos` (the Slice 3
  case passes `new Set()`).
- [ ] Run the Slice 4 check.

### Slice 5: running-app proof, changelog, gate

**Check:** `node test/e2e/run-smoke.mjs tree-chevrons` passes (after `npm run build`), then
`middle-click-explorer`, `tabbar-overflow`, `mf-files`, `changes-multi-repo` each pass **alone**;
`npm run text-fit` reports no new right-pane overflow; `npm run verify` exits 0.

#### Task 5.1: `test/e2e/tree-chevrons.e2e.mjs`

**Files:**
- Create: `test/e2e/tree-chevrons.e2e.mjs`

**Interfaces:**
- Consumes: `launchApp({ userDataDir })`, `openSession(page, { path, roots })`, `openChangesTab`,
  `assert`, `makeLog` from `test/e2e/harness.mjs`; `git`, `commitBase` from `test/e2e/changes-fixture.mjs`.

**Shape:** multi-launch, like `test/e2e/changes-multi-repo.e2e.mjs` (its win32 guard at ~28–30,
per-launch `launchApp({ userDataDir })` at ~671, cleanup-before-`process.exit(code)` at ~689–693).
One launch per theme in `['aero', 'aero-dark', 'neon']`; each gets a fresh `mkdtempSync` userDataDir
seeded with `settings.json` = `{ version: 1, settings: { theme, restoreSessions: false } }`
(what `test/e2e/visual/shoot.mjs` `seedProfile` writes).

**Fixture:** temp root with git repos `home` and `ref`; each: `src/deep/a.ts` committed, then
modified (unstaged), plus new `src/new.ts` staged. Session: `openSession(page, { path: home, roots: [home, ref] })`.
Temp dirs removed at the end (use `removeDir`).

**Assertions per theme** (±1px; all geometry from `getBoundingClientRect`, same pane width):
- AC1: every `.files__bar`'s `firstElementChild` is `button.files__collapse`; its left < `.files__root-icon` left.
- AC2: centre x of the first `.files__bar .treechev` == centre x of the first `.repo-head .treechev`
  (Changes tab) == centre x of the `.treechev` in the `src` depth-0 folder row (`.filerow[aria-level="1"]`).
- AC3: `.files__root-icon` x == `.repo-head__glyph` x in All view == in Active view (switch via
  `.changes__kebab` → menu item `Active repo`, then back via `All repos`).
- AC4: every `.treechev` in each tab has `width` 12; expanded ones compute `transform`
  `matrix(0, 1, -1, 0, 0, 0)`, collapsed `none` (collapse one Files bar and one Changes head first).
  Assert no `.files__bar-chev` / `.filerow__chev` exists.
- AC5: `page.emulateMedia({ reducedMotion: 'reduce' })` → `.treechev` `transitionDuration` `0s`;
  `'no-preference'` → `0.1s`.
- AC6: first `.change` height == a leaf `.filerow` height == 22; equal computed `borderRadius`;
  equal left; `.change__kind` left == depth-0 file row's icon left (the first child after the
  spacer: `.filerow[aria-level="1"]` with no `.treechev`, its second element child).
- AC7: `.files__bar` and `.repo-head` (home) equal `backgroundColor`, `minHeight` `32px`,
  `borderRadius`, `paddingLeft`; home tags in both equal `fontSize`, `fontWeight`, `padding`,
  `borderRadius`. Then set the right pane so the bar is ≤200px wide (drag or set the pane width the
  way `test/e2e/visual/text-fit-sweep.mjs` narrows panes) and assert `page.getByText('Home', { exact: true })`
  inside `.files__bar` has count ≥1 while its bounding box is ≤1px.
- AC8: collapse `ref` on Changes → Files → Changes: `aria-expanded="false"`; collapse `ref` on
  Files → Changes → Files: `aria-expanded="false"`.
- AC9: real click on `.files__root-name` and on `.repo-head__name` leaves `aria-expanded`
  unchanged; focus each header chevron, `page.keyboard.press('Enter')` flips it, `'Space'` flips it back.
- AC10: hover a `.change` → `.change__row-actions` rect inside the row rect; real click on its
  `Stage` action → that file appears under the `Staged` section.
- AC12 (geometry part): at bar widths 200 and 280, `.treechev` of each header does not intersect
  any other visible header child's rect.
- AC13: `page.emulateMedia({ forcedColors: 'active' })` → header and row `.treechev` computed
  `color` is not `rgba(0, 0, 0, 0)` / `transparent`, in both tabs.

**Steps:**
- [ ] `npm run build`, then `node test/e2e/run-smoke.mjs tree-chevrons` — it must pass; a failure
  is a product defect to fix in Slices 1–4's files, never an assertion to loosen.
- [ ] Sanity-check the scenario can fail: temporarily revert one geometry value locally (e.g.
  `.treehead` `padding-left`), see AC2 go red, restore. Leave no trace.

#### Task 5.2: changelog, touched scenarios, gate

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, add `### Changed` with one bullet in the file's
  voice: the expand/collapse arrow on Files folder bars now sits on the left like the Changes
  tab's, both tabs use the same arrow, row height and spacing, and a collapsed repo on Changes
  stays collapsed when you switch tabs).

**Steps:**
- [ ] Run alone, one at a time: `node test/e2e/run-smoke.mjs middle-click-explorer`,
  `… tabbar-overflow`, `… mf-files`, `… changes-multi-repo`. A red one is re-run alone once on a
  quiet machine before it is believed (CLAUDE.md PTY note); never kill processes by name.
- [ ] `npm run text-fit` — no new right-pane overflow finding versus `main`.
- [ ] `npm run verify` with the exit code captured: in PowerShell
  `New-Item -ItemType Directory -Force "$env:TEMP\claude-scratch" | Out-Null; npm run verify *> "$env:TEMP\claude-scratch\verify.log"; $LASTEXITCODE` — must be `0`. Read the
  log file, never pipe the command.
- [ ] `git status` shows only the file-map paths (plus the conductor's untracked specs).

## Verification

- Per task: `npx vitest related <files touched> --run` + `npm run typecheck`.
- Per slice: the slice's **Check**.
- Once before handoff: Slice 5 (new e2e + the four touched/AC10 scenarios, each alone, after
  `npm run build`; `npm run text-fit`; `npm run verify` exit 0 via `$LASTEXITCODE`). Never the full
  e2e suite.
- Review checklist (AC11, not mechanical): no new `!important`; no selector added only to out-rank
  another; every old chevron/tag/fill rule deleted, not overridden; no property set on both
  `.treehead` and `.files__bar`/`.repo-head`.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality (e.g. the header glyph does not land on +32, a `.change` is not 22px with the
properties above, `.filerow` rows are not flush with the bar) — that task **stops** and fixing the
misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback,
magic offset, or an override patched in place of its semantic source. Report leads with the fix that
keeps the locked decision.

## Decisions Needed

- [normal] Search results (`.search__results`, also `.rightpane__scroll`) move from an 8px to a 6px
  side gutter with the Changes body. Default taken: accept — they render in the Files tab, whose
  gutter is the reference. Reversible by giving search its own padding.
- [normal] The Files bar's right-hand icon cluster widens by 6px (gap 2px → 4px via `.treehead`)
  and Changes' name/tag/chip gap tightens 6px → 4px, so the header has one gap. Default taken: one
  shared 4px column gap (the spec puts gap in `.treehead`). If the ≤280px bar hides extras too
  early in `text-fit`, revisit here, not with a per-surface gap.
- [normal] Header spacer width: `TreeChevronSpacer` gains `size: 'head'` (24px) for the Changes
  Active view (spec row 23) — the spec's zero-arg signature could not hold a 24px column.
