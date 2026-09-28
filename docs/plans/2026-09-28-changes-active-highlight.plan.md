# changes-active-highlight — implementation plan

**Spec:** `docs/specs/2026-09-28-changes-active-highlight.md` (incl. §14 D1 override)  **Tier:** FULL

Tier reason: two panels (Changes + Files) gain one shared derived seam fed from `app.tsx`, through
`RightPane`, into `ChangesView` and every `FolderSection`; Files' reveal changes from event-driven
state to derived state.

**Build order:** after sibling `tree-chevrons` has merged. That item restyles `.change` /
`.filerow` rows, adds `TreeChevron`, and moves Changes' repo-collapse state so it survives a tab
switch. Anchors below are from `beb4253`; find code **by name**, not by line. Where this plan says
"the repo-collapse predicate", use whatever expression post-chevrons `ChangesView` uses to compute
`isCollapsed` for a head. `ChangeRow` and the `.change` class survive chevrons (constraint from the
conductor). If chevrons landed a shared "open-file" row modifier, use it instead of `.change--active`
(spec §11), and don't add a parallel class.

## Goal

The Changes list and the Files tree both highlight the file the focused editor tab is showing, and
both work that out from one pure function of the active tab.

## Architecture

`app.tsx` already derives `activeDoc` (session-scoped) and owns `centerView`. A new pure
`activeTarget(doc, centerView)` turns them into `ActiveTarget | null`. It is the single "what is
focused" value, and split-editor will later swap its `doc` argument for the focused group's active
doc. `RightPane` passes it to both panels. **Changes** resolves it to at most one row with
`highlightedChange(heads, target)`. **Files** stops keeping `revealedPath` as component state: each
`FolderSection` derives its highlighted row from the target with `findFileByKey(roots, key)`, and
an effect keyed on the target's identity drives the existing `advanceReveal` ancestor expansion.
Nothing is event-driven, so a tab click, Ctrl+PageUp/PageDown, a close that activates a neighbour,
a session switch and a remount (Changes→Files toggle) all behave the same way.

## Data flow

```
docs.ts reducer ──activeId──► app.tsx  activeDoc (visibleDocs.find)   centerView
                                   └──────────┬──────────────────────────┘
                              activeTarget(activeDoc, centerView)  [webview/active-target.ts]
                                              │ ActiveTarget | null   (useMemo on primitives)
                                              ▼
                                  <RightPane activeTarget=…>
                     ┌────────────────────────┴───────────────────────────┐
             <ChangesView activeTarget>                          <FilesView activeTarget>
   highlightedChange(visibleHeads, target)                     <FolderSection activeTarget> ×N
   [webview/change-highlight.ts]                  revealedPath = findFileByKey(roots, key)?.path
   → ChangeRow active + aria-current              effect[key, collapsed] → advanceReveal (expand
   → layoutEffect[hlId] scrollIntoView nearest      ancestors, readDir) — no setTab, no focus
                                                  layoutEffect[revealedPath, shown] → scroll nearest
```

`openFile`'s explicit `rightPaneRef.revealInTree(path)` stays (D2). It still switches the pane to
Files, clears the search overlay and expands a collapsed section. The highlight it used to set is
now derived.

## Settled decisions — do not re-litigate

- D2: opening a *file* (not a diff) still switches the right pane to Files via `revealInTree`. Unchanged.
- D3: a match in a repo collapsed via its head → no highlight, no auto-expand.
- D4: Active view, match in another repo → no highlight, no active-repo switch.
- D5: `centerView !== 'editor'` → no target (both panels).
- D6: a file tab for an `MM` file highlights the unstaged row only.
- D7: a conflicted file's unscoped diff tab → unstaged row (via `either`), even if the Staged row was clicked.
- **D1 override (conductor):** Files follows the focused tab too: highlight, expand ancestors,
  scroll `nearest`. It never switches the right pane and never moves focus, selection or the roving row.
- Mapping (spec §2 table) and path matching by `folderKey` (spec §2) are as specified.
- Changes scroll rule: scroll only on highlight-identity change or mount, never on a same-target refresh.

## Spec staleness

- Spec §2 says "Center view is Board / Canvas / Plan". `CenterView` is `'editor' | 'board' | 'canvas'`
  (`webview/center-view.ts:7`), and there is no Plan center view. The plan gates on `centerView !== 'editor'`,
  which covers every non-editor view whatever it's called.
- Spec §2 "tree double-click opens did not produce `filerow--revealed`, cause not diagnosed". This
  is still undiagnosed. Task 2.1 reproduces it red and root-causes it before the derived highlight
  lands, because the derived highlight could mask the fault for visible rows while deep reveals
  stay broken. The most likely cause is that `ancestorDirChain` (`webview/file-tree.ts:221`) does
  a case-sensitive prefix test after `canonicalPath` has upper-cased the drive letter
  (`src/canonical-path.ts:18`). That is a hypothesis only; measure it.

## Global constraints

- Gate: `npm run verify`. Run it once before handoff and capture the exit code without a pipe:
  `npm run verify > $env:TEMP\claude-scratch\verify.log 2>&1; $LASTEXITCODE`. Never disable,
  narrow or defer a check.
- Inner loop: `npx vitest related <touched files> --run` + `npm run typecheck` (it checks both tsconfigs).
- e2e: `npm run build`, then only this plan's two scenarios, each run alone:
  `node test/e2e/run-smoke.mjs changes-active-highlight` and `node test/e2e/run-smoke.mjs files-follow-tab`.
  Never the full suite. Run them serially. A PTY-looking failure on a loaded machine gets re-run alone first (CLAUDE.md).
- Comments explain *why* only. Where the reason is in the spec, point to it (`// see changes-active-highlight spec §2`).
- No `process.platform` in the new pure code. CI is ubuntu, so unit tests cover both `G:\r\a.txt` and `/r/a.txt` explicitly.
- Tokens only: `--state-sel-bg` / `--state-sel-hover-bg`. No raw colours, no `!important`, no specificity escalation.
- File naming: kebab-case modules in `webview/`, tests in `test/unit/<module>.test.ts`, e2e in `test/e2e/<name>.e2e.mjs` on `harness.mjs`.
- Renderer guards: nothing here touches `window.agentDeck`.

## Out of scope

Review navigator (`ReviewNavigator` has its own current row). Commit-diff tabs vs the History panel.
Row styling and chevrons (sibling item). Keyboard focusability of change rows. Changing
`openFile`'s pane switch (D2). Split-editor's per-group active tab (that item swaps the `doc`
argument only).

## Contracts

### `webview/active-target.ts` (new, Slice 1)

```ts
import type { DocKind } from './docs';
import type { CenterView } from './center-view';
import type { DiffTabScope } from '../src/protocol';

export type ActiveTargetSide = 'staged' | 'unstaged' | 'either';

export interface ActiveTarget {
  /** The doc's path exactly as the tab holds it (canonicalPath spelling). */
  path: string;
  /** folderKey(path): the only form either panel compares on. */
  key: string;
  side: ActiveTargetSide;
}

export function activeTarget(
  doc: { kind: DocKind; path: string; diffScope?: DiffTabScope } | null,
  centerView: CenterView,
): ActiveTarget | null;
```

The mapping follows spec §2. `centerView !== 'editor'` or `doc === null` gives `null`. `kind: 'file'`
gives `either`. `kind: 'diff'` gives `diffScope ?? 'either'`. `commit-diff` / `review` / `web` /
`git-history` give `null`. `key = folderKey(path)`, with `folderKey` from `src/folder-key.ts`.

### `webview/change-highlight.ts` (new, Slice 1)

```ts
import type { RepoHeadModel } from '../src/changes-view-model';
import type { ActiveTarget } from './active-target';

export interface HighlightedChange { root: string; side: 'staged' | 'unstaged'; path: string }

export function highlightedChange(
  heads: readonly RepoHeadModel[],
  target: ActiveTarget | null,
): HighlightedChange | null;

/** Stable identity for scroll-on-change: `${folderKey(root)}|${side}|${path}`. */
export function highlightId(h: HighlightedChange | null): string | null;
```

- It walks `heads` in order. For each head, a row matches when `folderKey(joinPath(head.repo.root, c.path)) === target.key`
  (`joinPath` from `webview/file-tree.ts`).
- Side `staged` checks `head.staged` only, and side `unstaged` checks `head.unstaged` only. Side `either`
  checks `unstaged` first and then `staged`. The first head that matches wins.
- `root` is `head.repo.root` exactly as given, and `path` is `change.path`.
- Heads with `changes === undefined` have empty `staged`/`unstaged`, so they match nothing.
- **Callers pass only the visible heads.** `ChangesView` filters out heads for which the
  repo-collapse predicate is true. That filter is what enforces D3.

### `ChangesViewProps` (Slice 1)

Adds `activeTarget: ActiveTarget | null`. `ChangeRow` adds the prop `active: boolean`. When it is
true, the row element gets the class `change--active` (or the chevrons-era shared modifier, see top)
and `aria-current="true"`. When it is false, the row gets neither: no `aria-current="false"`.

### `RightPane` (Slice 1 adds, Slice 2 forwards to Files)

`activeTarget` arrives through the existing `...changesProps` spread in Slice 1, because it is on
`ChangesViewProps`. In Slice 2 it is **destructured explicitly** in `RightPane`'s parameter list and
passed to both `<ChangesView activeTarget={activeTarget} …>` and `<FilesView activeTarget={activeTarget} …>`.

### `webview/file-tree.ts` (Slice 2)

```ts
/** The FILE node whose folderKey equals `key`, descending only into dirs on its prefix path. */
export function findFileByKey(nodes: TreeNode[], key: string): TreeNode | undefined;
```

It descends into a dir `d` only when `key.startsWith(`${folderKey(d.path)}/`)` and `d.children` is
loaded, and returns a node with `kind === 'file' && folderKey(node.path) === key`. It never
expands, loads or allocates per row.

### `FilesViewProps` / `FolderSectionProps` (Slice 2)

Both add `activeTarget: ActiveTarget | null`. `FilesView` forwards it unchanged to every `FolderSection`.

### `FolderSection` behaviour contract (Slice 2)

- The `revealedPath` **state** and its setter are deleted. It is replaced by
  `const revealedPath = useMemo(() => activeTarget && !collapsed ? findFileByKey(roots, activeTarget.key)?.path ?? null : null, [roots, activeTarget?.key, collapsed])`.
- `revealedShown = revealedPath !== null && rows.some(r => r.node.path === revealedPath)`. Pins use
  the same index lookup as today.
- Follow effect: `useEffect(() => { if (!activeTarget || collapsed) return; revealTargetRef.current = activeTarget.path; advanceReveal(); }, [activeTarget?.key, collapsed, advanceReveal])`.
  It runs on mount, so a Files remount reveals. A section that doesn't own the path gets an empty
  `ancestorDirChain` and does nothing. It **never** calls `onToggleCollapsed`, `setSelection`,
  `setFocusPath`, `.focus()` or any `RightPane` tab switch.
- `advanceReveal` keeps its ancestor walk but stops setting a highlight. When the chain completes
  it only clears `revealTargetRef`.
- The scroll layout effect's deps become `[revealedPath, revealedShown]`. It runs only when
  `revealedShown` is true, so a same-target refresh doesn't scroll, and expanding the last
  ancestor (`shown` false→true) does.
- `FolderSectionHandle.revealInTree(absPath)` is unchanged in signature and still expands a
  collapsed section, then calls `advanceReveal` (the explicit-open route, D2).
- Row class: `filerow--revealed` when `node.kind === 'file' && node.path === revealedPath`, as today.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| "focused tab" target | `docs.ts` reducer (`activeId`) + `app.tsx` `centerView` → `activeTarget()` | `ChangesView`, `FolderSection` | consumer + new derivation; reducer read-only |
| Changes row active state | `highlightedChange` over visible heads | `ChangeRow` class/`aria-current`; `changes-fixture.mjs` `rowIndex` (matches `:scope > .change`, unaffected by the added modifier) | both |
| Files highlight (`filerow--revealed`) | was `setRevealedPath` in `advanceReveal`, now derived from `activeTarget` | `FolderSection` row class + pins + scroll; `test/e2e/explorer.e2e.mjs:130` (search-result open → revealed) | both. The explorer e2e still holds because a search-result open → `openFile` → the doc becomes active |
| `revealInTree` explicit route | `app.tsx` `openFile` (sole caller, `webview/app.tsx:1797`, non-background only) | `RightPane` → `FilesView` → `FolderSection` | handle kept; highlight half removed. Every call precedes `dispatchDocs({type:'open'})` of the same path, so the derived highlight lands on the same file |
| `treeNodePath` | `webview/file-tree.ts:247` | only `folder-section.tsx:319` + `test/unit/file-tree.test.ts` | Slice 2 removes the caller, so it deletes the export and its tests (the dead-code gate would flag it) |
| pointer-at-rest fill survival list | `webview/styles.css` (~13547 list) | every `.change` row at rest | adds `.change--active` |

The row that is only partly in scope (`docs.ts` reducer) is read-only here. The tab bar renders
`tab--active` from the same `activeId`, so both panels agree with the tab bar by construction.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/active-target.ts` | create | `ActiveTarget` + `activeTarget(doc, centerView)`: the single focused-tab derivation |
| `webview/change-highlight.ts` | create | `highlightedChange` + `highlightId`: resolve the target to one Changes row |
| `test/unit/active-target.test.ts` | create | mapping table, every `DocKind` × scope × centerView |
| `test/unit/change-highlight.test.ts` | create | MM, missing side, first-head-wins, win/POSIX spellings |
| `webview/app.tsx` | modify | compute `activeTarget` (useMemo) next to `activeDoc`; pass to `<RightPane>` |
| `webview/components/right-pane.tsx` | modify | forward `activeTarget` (S1 via spread, S2 explicit to both views) |
| `webview/components/changes-view.tsx` | modify | visible-heads filter, `highlightedChange`, `ChangeRow active`, scroll effect |
| `webview/styles.css` | modify | `.change--active` rest/hover; add to the pointer-at-rest survival list |
| `webview/file-tree.ts` | modify | add `findFileByKey`; delete `treeNodePath` (last caller gone); root-cause fix from T2.1 if it lands here |
| `test/unit/file-tree.test.ts` | modify | `findFileByKey` cases; drop `treeNodePath` cases; regression test for the T2.1 root cause |
| `webview/components/files-view.tsx` | modify | `FilesViewProps.activeTarget`, forward to `FolderSection` |
| `webview/components/folder-section.tsx` | modify | derived `revealedPath`, follow effect, scroll deps, `advanceReveal` no longer highlights |
| `test/e2e/changes-active-highlight.e2e.mjs` | create | spec §7 Gherkin |
| `test/e2e/files-follow-tab.e2e.mjs` | create | Slice 2 acceptance criteria |
| `CHANGELOG.md` | modify | one `### Added` / `### Fixed` entry under `[Unreleased]` |

## Scripts

None. There's no repeated mechanical edit, and the fixtures reuse `changes-fixture.mjs`
(`commitBase`, `git`) and `harness.mjs`.

## Slices

### Slice 1: Changes highlights the focused tab's row

**Check:** `npx vitest run test/unit/active-target.test.ts test/unit/change-highlight.test.ts`
passes. Then, after `npm run build`, `node test/e2e/run-smoke.mjs changes-active-highlight`
passes (every spec §7 scenario).

**Parallel groups:** G1: T1.1 · G2: T1.2 · Serial: T1.3, T1.4
**Claims (serial lane):** `webview/app.tsx`, `webview/components/right-pane.tsx`, `webview/styles.css`

#### Task 1.1: pure derivation + resolution

**Files:**
- Create: `webview/active-target.ts`, `webview/change-highlight.ts`
- Test: `test/unit/active-target.test.ts`, `test/unit/change-highlight.test.ts`

**Interfaces:**
- Produces: `ActiveTarget`, `ActiveTargetSide`, `activeTarget(doc, centerView)`, `HighlightedChange`,
  `highlightedChange(heads, target)`, `highlightId(h)`. Exact signatures are in Contracts above.
- Consumes: `folderKey(p: string): string` (`src/folder-key.ts`), `joinPath` (`webview/file-tree.ts`),
  `DocKind` (`webview/docs.ts`), `CenterView` (`webview/center-view.ts`), `DiffTabScope`
  (`src/protocol.ts`), `RepoHeadModel` (`src/changes-view-model.ts`).

**Steps:**
- [ ] Failing tests in `active-target.test.ts`:
  - 'file tab targets either side': `activeTarget({kind:'file',path:'G:\\r\\a.txt'},'editor')` deep-equals `{path:'G:\\r\\a.txt', key: folderKey('G:\\r\\a.txt'), side:'either'}`.
  - 'scoped diff targets its side': covers staged and unstaged.
  - 'unscoped diff targets either'.
  - 'commit-diff, review, web, git-history target nothing': each gives `null`.
  - 'null doc targets nothing'.
  - 'non-editor center view targets nothing': `'board'` and `'canvas'` with a file doc give `null`.
- [ ] Failing tests in `change-highlight.test.ts` (build heads with a small local `head(root, staged[], unstaged[])` factory):
  - 'MM file tab resolves to the unstaged row': gives `{side:'unstaged'}`.
  - 'fully staged file tab falls back to staged'.
  - 'scoped staged diff with no staged row highlights nothing': gives `null`, even when an unstaged row exists.
  - 'first head in order wins'.
  - 'drive-letter spellings match': root `G:\r`, row `a.txt`, target key from `g:/r/a.txt` and from `G:\r\a.txt` both resolve.
  - 'POSIX paths are case-sensitive': root `/r`, target `/R/a.txt` gives `null`, and `/r/a.txt` resolves.
  - 'loading head matches nothing': `changes: undefined`, empty sides.
  - 'highlightId is stable across equal inputs and null for null'.
- [ ] `npx vitest run test/unit/active-target.test.ts test/unit/change-highlight.test.ts`. Expect FAIL (modules missing).
- [ ] Implement to the contracts, then rerun and expect PASS.

#### Task 1.2: e2e scenario authoring

**Files:**
- Create: `test/e2e/changes-active-highlight.e2e.mjs`

**Interfaces:**
- Consumes: the DOM contract. The active row is `.change.change--active[aria-current="true"]`
  (or the chevrons-era modifier), and exactly one or zero exist inside `.rightpane__scroll`.
  Helpers come from `test/e2e/changes-fixture.mjs` (`commitBase`, `git`, `installTabHelpers`,
  `waitActiveTab`, `openChangesPanel`, `changeRow`, `rowIndex`) and `test/e2e/harness.mjs`
  (`runScenario`, `launchApp`, `openSession`, `waitForRepoGit`, `closeApp`, `assert`).

**Steps:**
- [ ] Write every spec §7 Gherkin scenario: row click; staged vs unstaged tabs of an MM file; file
  tab → unstaged; Terminal / clean-file tab clears; scroll into view (80 extra changed files
  `f00.txt…f79.txt` plus `zz-last.txt`, then Refresh doesn't move `scrollTop`, then Files→Changes
  re-scrolls); committing the index clears a scoped-staged highlight; the Board center view clears
  it; multi-repo set up as `changes-multi-repo.e2e.mjs` does (repo 2 highlight, collapse clears
  it, Active view clears it without switching repo). Also add **"closing the active tab moves the
  highlight"**: close the `b.txt` diff tab with `a.txt (Index)` next in line, and the active row
  becomes `a.txt` under Staged.
- [ ] Make one helper `activeRows(page)` that returns `[{file, section}]` for every
  `[aria-current="true"]` in the Changes list, and assert "exactly one" as `length === 1` plus the
  class on that same element.
- [ ] Also assert D2 while here, as spec §2's ASSUMED row: opening `a.txt` from the Files tab
  leaves the right pane on Files (`.rtab--active` text is `Files`).
- [ ] It isn't run yet (needs T1.3/T1.4 built). `node --check test/e2e/changes-active-highlight.e2e.mjs` passes.

#### Task 1.3: wire the target through to ChangeRow

**Files:**
- Modify: `webview/app.tsx`. Next to `const activeDoc = …` (~1190), add
  `const activeTargetValue = useMemo(() => activeTarget(activeDoc, centerView), [activeDoc?.kind, activeDoc?.path, activeDoc?.diffScope, centerView])`
  (biome may require the object as a dep. If so, build the doc arg from the three primitives
  inside the memo, and don't suppress the lint). Pass `activeTarget={activeTargetValue}` on `<RightPane>` (~3660).
- Modify: `webview/components/right-pane.tsx`. No code change is needed in S1 beyond the type, because
  `activeTarget` rides `...changesProps`. Confirm with typecheck.
- Modify: `webview/components/changes-view.tsx`:
  - Destructure `activeTarget`.
  - `const visibleHeads = model.kind === 'ready' ? model.heads.filter(h => !<repo-collapse predicate>(h)) : []`.
  - `const hl = useMemo(() => highlightedChange(visibleHeads, activeTarget), […])`.
  - `const hlId = highlightId(hl)`.
  - `row(c, side)` passes `active={hl !== null && hl.root === root && hl.side === (side === 's' ? 'staged' : 'unstaged') && hl.path === c.path}`.
  - `ChangeRow` renders the class + `aria-current`.
  - Scroll: `useLayoutEffect(() => { if (hlId === null) return; bodyRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [hlId])`.
    Place it **above** the `no-repos` early return, alongside the existing `useLayoutEffect`, to
    keep hook order stable.

**Interfaces:**
- Consumes: `activeTarget(doc, centerView): ActiveTarget | null`,
  `highlightedChange(heads: readonly RepoHeadModel[], target: ActiveTarget | null): HighlightedChange | null`,
  `highlightId(h: HighlightedChange | null): string | null`.
- Produces: `ChangesViewProps.activeTarget: ActiveTarget | null`.

**Call sites:** `ChangesView` is rendered only in `right-pane.tsx` (via the spread). `ChangeRow` is
file-local. `RightPane` is rendered only in `app.tsx`.

**Steps:**
- [ ] `npm run typecheck`. Expect FAIL until app.tsx passes the prop, then PASS.
- [ ] `npx vitest related webview/components/changes-view.tsx webview/app.tsx --run` stays green.

#### Task 1.4: styling

**Files:**
- Modify: `webview/styles.css`. Add `.change--active { background: var(--state-sel-bg); }` and
  `.change--active:hover { background: var(--state-sel-hover-bg); }` beside the `.change` rules
  (~5347). Add `.change--active` to the "a fill that carries meaning, and so must survive the
  pointer" list next to `.filerow--revealed` (~13547). If a later `.change` state rule (hover,
  press) would out-rank the modifier, fix the ordering at the rule itself, the way
  `.filerow--revealed:not(.filerow--selected)` spells out precedence. Don't raise specificity.

**Steps (visual-fidelity carve-out):**
- [ ] `npm run build`, then `node test/e2e/run-smoke.mjs changes-active-highlight`. Expect PASS.
- [ ] Screenshot an active change row in all three themes (the `npm run shots` mechanism, or a
  one-off Playwright capture to `$env:TEMP\claude-scratch\`). Check that the tint matches a
  `.filerow--revealed` row, that the kind letter and diffstat stay legible, and that the tint
  survives the pointer resting on the row. Delete the shots afterwards.

### Slice 2: Files tree follows the focused tab (D1 override)

**Check:** `npx vitest run test/unit/file-tree.test.ts` passes. Then, after `npm run build`,
`node test/e2e/run-smoke.mjs files-follow-tab` passes, **and**
`node test/e2e/run-smoke.mjs explorer` still passes (search-result open → revealed), **and**
`node test/e2e/run-smoke.mjs changes-active-highlight` still passes.

**Acceptance criteria (D1 override):**
- AC-F1: When the active tab changes to a `file` or `diff` tab (click, Ctrl+PageDown/PageUp, a
  close that activates a neighbour), the Files tree has exactly one `.filerow--revealed`, the row
  for that path. Nested attached sections that both contain the path are the exception, and each
  shows its own row.
- AC-F2: Collapsed ancestor folders of that file are expanded (`aria-expanded="true"`), and the row
  is within the Files scroller's visible rect.
- AC-F3: Activating a tab never changes `.rtab--active`. If the pane showed Changes, it still shows
  Changes. Opening a *file* still switches to Files (D2, unchanged).
- AC-F4: Activating a tab doesn't move keyboard focus into `.rightpane`, and `.filerow--selected`
  / the roving `tabindex="0"` row are unchanged.
- AC-F5: When a tab maps to no file (Terminal, web, History, commit-diff, Review) or the center view
  is not the editor, no `.filerow--revealed` exists.
- AC-F6: When the Files tab mounts (Changes→Files), the active tab's file is revealed and scrolled into view.
- AC-F7: A Files refresh that keeps the same target doesn't change the scroller's `scrollTop`.
- AC-F8: A section collapsed via its folder bar stays collapsed when a tab in it is activated.
  When the user expands it, the file is revealed.
- AC-F9: When a search query is active in the Files search box, activating a tab doesn't clear it.
- AC-F10: When a file is opened by tree double-click, the tree shows `.filerow--revealed` on it.
  This is the spec §2 measured defect.

**Parallel groups:** G1: T2.2 · G2: T2.3 · Serial: T2.1 (first), T2.4
**Claims (serial lane):** `webview/components/right-pane.tsx`, `CHANGELOG.md`

#### Task 2.1: reproduce + root-cause the tree-open non-reveal (runs first)

**Files:**
- Modify: whichever file holds the root cause. The expected candidate is `webview/file-tree.ts`
  (`ancestorDirChain`). Anything outside this plan's file map is a stop-and-report.
- Test: `test/unit/file-tree.test.ts`

**Steps:**
- [ ] On the current tree, `npm run build`. Write a throwaway probe in `$env:TEMP\claude-scratch\`
  on `harness.mjs`: open a session on a temp dir and double-click a nested file in Files. Log the
  session root string, the doc path after `canonicalPath`, `ancestorDirChain(docPath, root)`, and
  whether `sectionFor` resolves. Measure. Don't infer.
- [ ] Write a failing unit test that pins the measured cause. If the cause is drive-letter or
  separator case, that is `ancestorDirChain('G:\\r\\src\\a.ts','g:/r')` returning a non-empty chain.
- [ ] Fix at the source. If it is `ancestorDirChain`, make its containment test compare
  `folderKey(file)` against `folderKey(root)` + `/`, and build the chain from `rootPath` + the
  file's segments as today. No second matcher and no fallback path.
- [ ] Delete the probe. `npx vitest related webview/file-tree.ts --run` is green.

#### Task 2.2: `findFileByKey`

**Files:**
- Modify: `webview/file-tree.ts` (add `findFileByKey`)
- Test: `test/unit/file-tree.test.ts`

**Interfaces:**
- Produces: `findFileByKey(nodes: TreeNode[], key: string): TreeNode | undefined`
- Consumes: `folderKey(p: string): string` (`src/folder-key.ts`)

**Steps:**
- [ ] Failing tests:
  - 'finds a nested file by key across drive-case and separator spellings': the tree is built with
    `G:\r\src\a.ts` and `key = folderKey('g:/r/src/a.ts')` returns that node.
  - 'returns undefined for a dir key'.
  - 'does not descend into unloaded children': `children: undefined` gives undefined.
  - 'POSIX is case-sensitive'.
- [ ] Run and expect FAIL, implement, then PASS.

#### Task 2.3: e2e scenario authoring

**Files:**
- Create: `test/e2e/files-follow-tab.e2e.mjs`

**Interfaces:**
- Consumes: the DOM contract. The revealed row is `.filerow--revealed` with `data-path`, and its
  name is in `.filerow__name`. Folder rows carry `aria-expanded`. The pane tabs are `.rtab` /
  `.rtab--active`. The Files scroller is `.rightpane__scroll--files`. Tab helpers come from
  `changes-fixture.mjs` (`installTabHelpers`, `waitActiveTab`). The fixture repo uses `commitBase`
  + `git`.

**Steps:**
- [ ] Fixture: a temp git repo with `a.txt`, `src/deep/x.ts`, and `f00.txt…f79.txt` (pushes the
  lower rows below the fold) plus `zz.txt`. `b.txt` is modified unstaged.
- [ ] One step per AC-F1…F10. Key asserts:
  - F1: after a tab click and after Ctrl+PageDown, the single revealed row's `.filerow__name` is the tab's file.
  - F2: collapse `src` by hand, activate `x.ts` tab, then `src` and `deep` have `aria-expanded="true"` and the row rect is inside the scroller rect.
  - F3: switch the pane to Changes, click the `a.txt` tab, and `.rtab--active` text is still `Changes`.
  - F4: before activation record `document.activeElement` and the `.filerow--selected` paths, then after it `!activeElement.closest('.rightpane')` and the selected paths are unchanged.
  - F5: the Terminal tab gives zero revealed rows.
  - F6: Changes→Files gives revealed + in view.
  - F7: scroll to top, click the folder bar Refresh, and `scrollTop` is unchanged.
  - F8: collapse the section bar, activate a tab, and the section is still collapsed. Expand it and the row is revealed.
  - F9: type a query and activate a tab, and the input value is unchanged.
  - F10: double-click `src/deep/x.ts` gives it `.filerow--revealed`.
  - Also: a `b.txt` diff tab (from Changes) active → switch to Files → `b.txt` revealed.
- [ ] `node --check test/e2e/files-follow-tab.e2e.mjs`.

#### Task 2.4: derive Files' highlight from the target

**Files:**
- Modify: `webview/components/right-pane.tsx`. Destructure `activeTarget` explicitly and pass it
  to both `<ChangesView>` and `<FilesView>`.
- Modify: `webview/components/files-view.tsx`. Add `FilesViewProps.activeTarget` and forward it to
  each `<FolderSection>`.
- Modify: `webview/components/folder-section.tsx`. Apply the Contracts "FolderSection behaviour
  contract" exactly: delete the `revealedPath` state, derive it with `findFileByKey`, add the
  follow effect, change the scroll effect deps, and stop `advanceReveal` setting a highlight.
- Modify: `webview/file-tree.ts` + `test/unit/file-tree.test.ts`. Delete `treeNodePath` and its
  tests once `folder-section.tsx` no longer imports it, and fix the comment at ~244 that names it.
- Modify: `CHANGELOG.md`. Add under `[Unreleased]` → `### Added`: "**The Changes and Files lists
  follow the tab you're on.** The file in the focused tab is highlighted in Changes (the staged or
  unstaged row that tab shows) and in Files, where its folders open and it scrolls into view.
  Neither list takes focus or switches tabs to do it." Under `### Fixed`, add the F10 line only if
  T2.1 found a real defect: "Opening a file from the Files tree highlights it there again."

**Interfaces:**
- Consumes: `ActiveTarget` (`webview/active-target.ts`: `{ path: string; key: string; side: 'staged'|'unstaged'|'either' }`),
  `findFileByKey(nodes: TreeNode[], key: string): TreeNode | undefined`.
- Produces: `FilesViewProps.activeTarget: ActiveTarget | null`, `FolderSectionProps.activeTarget: ActiveTarget | null`.

**Call sites:** `FilesView` is rendered only in `right-pane.tsx`. `FolderSection` is rendered only
in `files-view.tsx` (~737). `FolderSectionHandle.revealInTree` is called only from
`files-view.tsx:281`, and `FilesViewHandle.revealInTree` only from `right-pane.tsx:157`.

**Steps:**
- [ ] `npm run typecheck` fails until every prop is forwarded, then passes.
- [ ] `npx vitest related webview/components/folder-section.tsx webview/components/files-view.tsx webview/file-tree.ts --run` is green.
- [ ] `npm run build`, then run the three scenarios in the Slice 2 Check, each alone. All pass.
- [ ] `npm run verify` with the exit code captured to a log (Global constraints). Exit 0.

## Verification

- Per task: the named unit tests + `npm run typecheck`.
- Per slice: that slice's Check (e2e scenarios alone, after `npm run build`).
- Before handoff: one `npm run verify`, exit code from `$LASTEXITCODE` into a log, never piped.
  `git status` shows only the file map's paths.

## Deviation rule

If a task's assumption turns out wrong, that task **stops** and fixing the misaligned piece becomes
the work. Examples: the post-chevrons `ChangesView` has no single repo-collapse predicate, the
T2.1 cause lies outside `file-tree.ts`, or `activeDoc` isn't the only focused-tab source. Never
answer with a shim, a second matcher, a special case, a widened type, a fallback, or an override
patched in place of its semantic source. Report the fix that keeps the locked decisions.

## Decisions Needed

- [normal] Files for a section collapsed via its folder bar: the default is **not** to auto-expand
  (AC-F8), mirroring D3 for Changes. The explicit open route still expands it (unchanged).
  Alternative: expand it, as `revealInTree` does.
- [normal] Files when the target is null (Terminal/web/History tab, non-editor center view): the
  default is **clear** the highlight (AC-F5), consistent with Changes and with derived state.
  Alternative (VS Code-like): keep the last file highlighted, which needs stored state again.
- [normal] Files follows `diff` tabs (both scopes) as well as `file` tabs. VS Code reveals a diff
  editor's modified resource. Default: yes.
- [normal] While a Files search query is active, focus-follow updates the hidden tree silently and
  doesn't scroll when the search is cleared. Default: accept. Alternative: re-scroll on search clear.
