---
status: active
date: 2026-09-28
---

# Feature Spec: Changes panel highlights the focused tab's file

**Tier:** FULL   **Feature type:** UI
**Item id:** changes-active-highlight
**One-line request (verbatim):** "when a user is inside the Changes tab, and when they have a tab
already open with some changes and that tab is focused, then that file needs to be highlighted on
the Changes panel, the same way that if a tab is open and it's focused, that file gets highlighted
in the Files tab in the file explorer panel."

## 1. Problem frame

- **Job:** glance at the Changes list and see which changed file the editor is currently showing,
  so the list works as a map of "where am I" while stepping through diffs and files.
- **Actors:** one user, one active session, one or more repos in that session's folders.
- **Success outcomes (observable):** with the Changes tab shown, exactly one change row (or none)
  carries the open-file highlight, and it always corresponds to the active center tab.
- **Non-goals:**
  - Changing the Files explorer's highlight (see §2 "Current behavior" — it is *not* focus-driven
    today; making it so is a separate item, D1).
  - Review mode: while the active tab is Review, the Changes tab renders `ReviewNavigator`, which
    has its own current-file state (`review__navrow--active`). Untouched.
  - Row styling / chevrons / row layout — owned by the sibling spec
    `2026-09-28-tree-chevrons.md` (if/when it lands). This spec adds one state only.
  - Keyboard focus / selection in the Changes list (rows are not focusable today; not added here).

## 2. Behavior & states

**Primary flow.** User has the right pane on **Changes**. They click a change row → a diff tab
opens and becomes active → that row is highlighted. They click another editor tab (file tab or diff
tab) whose file is in the list → the highlight moves to that file's row. They click the Terminal
tab, a web tab, History, or a commit-diff tab → no row is highlighted.

**The highlight is derived, not event-driven.** It is a pure function of (active doc, center view,
Changes model). It is recomputed on every render; there is no stored "revealed" state to go stale.
This is deliberately *not* the Files explorer's mechanism (an imperative `revealInTree` fired from
`openFile`), because that mechanism only reacts to *opens* — measured below — and the request is
about the *focused* tab.

### Tab kind → Changes row mapping

The active doc is `activeDoc` in `webview/app.tsx` (`visibleDocs.find(d => d.id === docState.activeId)`
— already session-scoped). The target is computed only while `centerView === 'editor'`.

| Active doc | Target side | Row highlighted |
|---|---|---|
| `diff`, `diffScope: 'staged'` | staged | the **staged** row for that path; none if the path has no staged row |
| `diff`, `diffScope: 'unstaged'` | unstaged | the **unstaged** row for that path; none if no unstaged row |
| `diff`, no `diffScope` (conflicted row, Review "all" diff, reopened tab) | either | unstaged row if present, else staged row |
| `file` | either | unstaged row if present, else staged row |
| `commit-diff`, `review`, `web`, `git-history` | — | none |
| none (Terminal stop, `activeId === null`) | — | none |

Why: a scoped diff tab *is* one side of the change, and `ChangeRow` opens exactly that scope
(`diffScopeForChange`), so clicking a row and seeing that same row light up is the round-trip the
user expects. A file tab shows the working tree, which is the unstaged side; it falls back to staged
when the file is fully staged. A scoped tab whose side has vanished (e.g. staged diff open, then the
user commits) highlights nothing rather than jumping to the other side — the tab itself already
shows "No staged changes in X" (`emptySideNotice`), and highlighting a row that would open a
*different* diff would mislead.

### Path matching (platform-independent)

A row's absolute path is `joinPath(repo.root, change.path)`. Compare `folderKey(rowAbs)` against
`folderKey(doc.path)` (`src/folder-key.ts` → `normalizeRoot`): string-only, folds `\`→`/`, trims
trailing separators, lowercases the **whole** path when it is drive-letter or UNC (the Windows FS is
case-insensitive), and leaves POSIX paths exactly as given. It is already the key
Files uses for change dots (`rowChanges.get(folderKey(node.path))`), so both panels agree on what
"the same file" means. Never branch on `process.platform` (CI is ubuntu; CLAUDE.md).

Row identity is `(repo.root, side, change.path)`. Nested repos cannot list the same absolute path
(the outer repo sees a nested repo only as its gitlink/dir), so exact equality — no prefix logic —
is sufficient; if two heads ever did match, the first head in display order wins.

### States

| State | What the user sees |
|---|---|
| No matching row (target null, or no row matches, or doc kind unmapped) | no row highlighted |
| Match in a visible repo list | that row highlighted, `aria-current="true"` |
| Match in a repo collapsed via its repo head (All view) | nothing highlighted; repo stays collapsed (D3) |
| Match in a repo not shown (Active view, other repo) | nothing highlighted; active repo not switched (D4) |
| Changes still loading for that repo (`head.changes === undefined`) | nothing; highlight appears when the rows land |
| Review mode | Changes tab shows ReviewNavigator; this feature inert |

### Scroll-into-view

When the **target identity** changes (different active doc, or `diffScope` flips) or when
`ChangesView` mounts (user switches Files → Changes), scroll the highlighted row into view with
`block: 'nearest'` inside the Changes scroller (`bodyRef`, `.rightpane__scroll`). A git refresh
that re-renders the same target must **not** scroll — the user may have scrolled away on purpose.
The list is not virtualized, so the row is always mounted (unlike `FolderSection`, which pins the
revealed row into its window).

### Current behavior (measured)

| Claim | How measured | Status |
|---|---|---|
| Files' highlight (`.filerow--revealed`) does **not** follow tab focus: opening package.json then README.md by double-click, then clicking the package.json tab, left the tree state unchanged (README.md `filerow--selected`, no `filerow--revealed` anywhere); active tab was package.json. | Scratch Playwright-Electron scenario on the shared harness against the built app, 2026-09-28 (deleted after) | Measured |
| After a Changes → Files toggle, no Files row is highlighted (FilesView unmounts; `revealedPath` is component state). | Same scenario | Measured |
| Tree double-click opens did not produce `filerow--revealed` either (only selection). Search-result opens do (`test/e2e/explorer.e2e.mjs`). Why tree opens don't reveal was not diagnosed. | Same scenario + existing e2e | Measured (cause not diagnosed) |
| A change row has no active/current state today: its class is the literal `"change"`. | Inspection of `webview/components/changes-view.tsx` `ChangeRow` | Measured by inspection (static literal) |
| `openDiff` does not switch the right pane; `openFile` (non-background) calls `revealInTree`, which switches it to **Files**. So opening a *file* from anywhere while on Changes leaves Changes; activating an existing file tab by tab click does not. | Source reading of `webview/app.tsx` `openFile`/`openDiff`, `right-pane.tsx` `revealInTree`; an independent reviewer's reading agreed, but nothing was run | ASSUMED (D2); the builder confirms it in the e2e |

## 3. Data / interface contract

- **New pure helpers** (unit-testable, no React), suggested home next to `diffScopeForChange` in
  `webview/diff-tab-scope.ts` or a new `webview/change-highlight.ts`:
  - `changeHighlightTarget(doc: { kind: DocKind; path: string; diffScope?: DiffTabScope } | null): { key: string; side: 'staged' | 'unstaged' | 'either' } | null`
    — `key = folderKey(doc.path)`; mapping per the table in §2.
  - `highlightedChange(heads: RepoHeadModel[], target): { root: string; side: 'staged' | 'unstaged'; path: string } | null`
    — resolves `either` to unstaged-then-staged; first head in order wins.
- **`ChangesViewProps`** gains `activeTarget: ReturnType<typeof changeHighlightTarget>`. `RightPane`
  passes it through (`changesProps`). `app.tsx` computes it from `activeDoc` + `centerView`.
- **`ChangeRow`** gains `active: boolean`; renders the active modifier class and
  `aria-current="true"` when true (precedent: `review-file-nav.tsx`).
- **Invariants:** at most one row is active at a time across all heads and both sections; the
  highlight never changes the active repo, collapse state, selection, focus, or scroll position
  except per §2 scroll rule.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| active doc (`docState.activeId` → `activeDoc`) | `docs.ts` reducer via `activate`/`open`/`close` dispatches | new `changeHighlightTarget` → `ChangesView` | Consumer only; producer unchanged and read-only here — safe, the highlight reads the same value the tab bar renders `tab--active` from |
| `doc.path` spelling | `openDiff`/`openFile` (`canonicalPath`) | `folderKey` comparison | Read-only; `folderKey` tolerates any separator/drive-case spelling, so producer spelling changes can't break the match |
| change rows (`RepoHeadModel.staged/unstaged`) | `changesModel()` in `src/changes-view-model.ts` from host git status | `highlightedChange` | Read-only |
| `centerView` | `app.tsx` | target gate | Read-only |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Same path in both Staged and Changes sections (porcelain `MM`) | Scoped diff → its side; file tab / unscoped diff → unstaged row only |
| Scoped diff tab whose side no longer exists (committed / unstaged away) | No highlight (see §2) |
| Conflicted file (`UU`/`AA`…) | The host emits **both** a staged and an unstaged row, both `conflicted` (`src/project-info.ts` `pushSide`), and both open the same unscoped `diff:<path>` tab. The tab therefore can't say which row it came from. `either` → the unstaged row, even when the Staged row was clicked (D7) |
| Staged rename (`origPath`) | Matched on `path` (new name) only; a tab on the old path highlights nothing |
| Deleted file (`D`) | Diff tab matches normally |
| Untracked file (`?`) open in editor | Unstaged row highlighted |
| Preview (italic) tab | Counts as active — highlighted |
| Middle-click / background open | Active tab unchanged → highlight unchanged |
| Session switch | `activeDoc` is session-scoped → recomputes; Changes model switches with it |
| Center view is Board / Canvas / Plan | No highlight (tab not on screen) — D5 |
| Repo root spelled with different drive case or separators than the doc path | Matches (`folderKey`) |
| Directory-name case differs on Windows (e.g. `Src` vs `src`) | Matches (`folderKey` lowercases whole drive-letter paths); on POSIX, case is significant, as on disk |
| Untracked nested repo (listed as one `inner/` dir row) | A file tab inside it matches nothing, which is correct because no row exists for that file |
| Unstaged-side rename / copy (no `origPath` on that side) | Matched on `path` like any other row |
| Git refresh with the same target | Highlight persists, no scroll |
| 0 repos / detecting / no session | Existing empty states; nothing to highlight |
| Many changes (hundreds of rows) | Per-render cost is one linear scan over rows — no memo required, but fine to `useMemo` on `(heads, target)` |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Highlight follows focused tab | on | No | Parity feature; no divergent preference |
| Auto-expand collapsed repo | no | No | Collapse is explicit user intent (D3) |
| Auto-switch active repo in Active view | no | No | Would re-scope the whole panel on a tab click (D4) |
| Scroll on target change | nearest, only on identity change / mount | No | Matches Files' `scrollIntoView({block:'nearest'})` without fighting manual scroll |

## 6. Scope slicing

- **MVP:** derived target + mapping table; `ChangeRow` active class + `aria-current`; styling reuse;
  scroll rule; unit tests for the two helpers; e2e below.
- **v1 (follow-up item, not here):** make Files' highlight focus-driven too (D1).
- **Out of scope:** Review navigator; commit-diff tabs vs History panel; row styling (sibling spec).

## 7. Acceptance criteria

**EARS**
- While the right pane shows the Changes list and the center view is the editor, the Changes list
  shall mark at most one row active, chosen per the §2 mapping from the active tab.
- When the active tab changes, the active row shall move to the new tab's row, or clear if none maps.
- When the active row's identity changes or the Changes list mounts with an active row, the list
  shall scroll it into view (`nearest`); a refresh that keeps the same active row shall not scroll.
- If the active tab is a scoped diff whose side has no row, then no row shall be active.
- The active row shall expose `aria-current="true"`; no other row shall carry it.

**Gherkin (e2e, new `test/e2e/changes-active-highlight.e2e.mjs` on `harness.mjs` + `changes-fixture.mjs`)**

Fixture: temp repo via `commitBase`; `a.txt` modified and staged, then modified again (`MM`);
`b.txt` modified unstaged; `c.txt` unchanged. Open a session there, `waitForRepoGit`, then use
`openChangesPanel` / `changeRow` from `changes-fixture.mjs`. "Exactly one row is active" is
asserted as: the Changes list has exactly one `[aria-current="true"]`, **and** that row is the only
one with the active class. For the multi-repo scenarios, set up the second repo the way
`changes-multi-repo.e2e.mjs` does.

```gherkin
Scenario: clicking a row highlights that row
  When I click the "b.txt" row in the Changes section
  Then exactly one change row is active, and it is "b.txt" under "Changes"

Scenario: staged vs unstaged diff tabs of the same file
  When I click "a.txt" under "Staged"
  Then the active row is "a.txt" under "Staged"
  When I click "a.txt" under "Changes"
  Then the active row is "a.txt" under "Changes"
  When I activate the "a.txt (Index)" tab
  Then the active row is "a.txt" under "Staged"

Scenario: file tab maps to the unstaged row
  Given "a.txt" is open as a file tab (opened from the Files tab, then Changes re-selected)
  When I activate that file tab from the tab bar
  Then the active row is "a.txt" under "Changes"

Scenario: non-mapping tabs clear the highlight
  When I activate the Terminal tab
  Then no change row is active
  When I open "c.txt" (no changes) as a file tab and return to Changes
  Then no change row is active

Scenario: scroll into view
  Given enough changed files that "zz-last.txt"'s row is below the fold
  When I activate a diff tab for "zz-last.txt" (opened earlier, then scrolled away)
  Then its row is within the Changes scroller's visible rect
  When I scroll the Changes list to the top and click the header Refresh
  Then the scroller's scrollTop is unchanged and the row is still active
  When I switch the right pane to Files and back to Changes
  Then the active row is within the visible rect again

Scenario: scoped side vanishes
  Given the "a.txt (Index)" tab is active and its row highlighted
  When the index is committed in the fixture repo and Changes refreshes
  Then no change row is active

Scenario: center view is not the editor
  Given a diff tab is active and its row highlighted
  When I switch the center view to the Board
  Then no change row is active

Scenario: multi-repo
  Given two repos in the session, All view, both with changes
  When I activate a diff tab from repo 2
  Then the active row is in repo 2's list and repo 1's list has none
  When I collapse repo 2's head
  Then no change row is active and repo 2 stays collapsed
  When I switch to Active view with repo 1 active
  Then no change row is active and the active repo is still repo 1
```

**Unit** (`test/unit/`, platform-independent): `changeHighlightTarget` for every `DocKind` and
scope; `highlightedChange` for MM fallback, missing scoped side, first-head-wins, and matching
`G:\r/a.txt` vs `g:/r/a.txt` vs `G:\r\a.txt`, plus a POSIX root.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| ChangeRow | default | as today | click opens diff |
| ChangeRow | active | open-file tint (same as Files' revealed row) | same |
| ChangeRow | active + hover | hover variant of the tint; row actions still reveal on hover | same |
| ChangeRow | active + pointer-at-rest rules | tint survives (see §11) | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| ChangeRow | none new — state only | unchanged | unchanged (rows not focusable) | n/a | unchanged | `aria-current="true"` when active |

## 10. Accessibility & i18n (UI)

- Tint is paired with `aria-current="true"`, so the state is exposed without relying on colour.
- Contrast: reuses `--state-sel-bg`, already validated for the Files row in all three themes; the
  row's kind letter / diffstat colours are unchanged on top of it — verify in Aero/Neon/third
  theme screenshots (`npm run shots`).
- `prefers-reduced-motion`: scroll uses the default (no `smooth`), so nothing to gate.
- No new strings → no i18n surface. RTL: tint is a full-row background; direction-neutral.

## 11. Design tokens (UI)

- Reuse `--state-sel-bg` (rest) and `--state-sel-hover-bg` (hover), exactly as
  `.filerow--revealed` does in `webview/styles.css`. No new tokens, no raw colours.
- New modifier `.change--active` (unless the sibling tree-chevrons spec has landed a shared row
  modifier for the open-file state — then use that one, and do not add a parallel class).
- Add the modifier to the "a fill that carries meaning, and so must survive the pointer" selector
  list next to `.filerow--revealed` (~line 13547), or it will be stripped at pointer rest.

## 12. Assumptions

- `activeDoc` + `centerView === 'editor'` is the right definition of "the focused tab".
- The sibling tree-chevrons change keeps `ChangeRow` as the row component (or its successor accepts
  an `active` prop); this spec only needs a class + attribute on the row element.

## 13. Decisions Needed

1. **D1 (normal)** — The user's premise that Files highlights the *focused* tab is false as measured
   (§2). Default: Changes follows focus (what was asked); Files is left alone and a follow-up item
   "make Files' highlight focus-driven (and survive Changes↔Files toggles)" is recorded. Alternative:
   fold Files into this item, which makes it cross-panel.
2. **D2 (normal)** — Opening a *file* (not diff) from any route switches the right pane to Files via
   `revealInTree`, so the user can only see a file tab highlighted in Changes by activating an
   existing tab or switching back. Default: unchanged. Alternative: suppress the pane switch when on
   Changes — a behaviour change to Files' reveal, out of scope.
3. **D3 (normal)** — Match inside a repo collapsed via its repo head: default no auto-expand, no
   highlight. Alternative: expand (mirrors Files' ancestor expansion) or tint the repo head.
4. **D4 (normal)** — Active-view match in a different repo: default no highlight, no repo switch.
5. **D5 (normal)** — Center view not `editor` (Board/Canvas/Plan): default no highlight.
6. **D6 (normal)** — File tab for an `MM` file highlights the unstaged row, not both. Alternative:
   highlight both rows (breaks "at most one").
7. **D7 (normal)**: a conflicted file has a staged row AND an unstaged row, and both open the
   *same* unscoped diff tab, so clicking the Staged conflicted row highlights the unstaged one.
   Default: accept this (unstaged wins, consistent with `either`). Alternative: highlight both
   conflicted rows as a documented exception to "at most one".

## 14. D1 override (conductor, 2026-09-28)

D1 is **overridden**: the Files explorer also follows the focused tab (VS Code
`explorer.autoReveal`). When the active center tab changes (click, Ctrl+PageUp/PageDown, closing a
tab), the Files tree highlights that file (`.filerow--revealed`), expands its collapsed ancestor
folders and scrolls it into view (`nearest`). It never switches the right pane to Files and never
moves keyboard focus, selection or the roving row. Both panels read one derived "active target"
(`webview/active-target.ts`), so split-editor only swaps its input. §1's first non-goal and §6's
v1 line are superseded by this section. Build detail: `docs/plans/2026-09-28-changes-active-highlight.plan.md`.
