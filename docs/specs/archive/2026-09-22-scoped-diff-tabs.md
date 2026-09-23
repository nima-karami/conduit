---
status: shipped
date: 2026-09-22
---

# Feature Spec: Scoped diff tabs — open the staged or the unstaged side of a file

**Tier:** FULL   **Feature type:** UI
**One-line request (external user, verbatim):** "it doesn't seem to be able to show unstaged
diff — if I have a file staged, the unstaged changes aren't visible; it always shows all the
changes including both staged and unstaged".

Written in autonomous mode. The conductor's five locked decisions (L1–L5) are the frame. Where a
measurement contradicted an assumption behind one of them, this spec says so and records the
default it took in §13.

## 1. Problem frame

- **Job:** a user who has staged part of a file wants to see *only* what they staged (what the
  next commit will contain), or *only* what they haven't staged yet, straight from the Changes
  panel, the way other git clients do it.
- **Actors:** a developer using the Changes panel and Review; the git working tree, which the
  user, agents and terminals all edit.
- **Success outcomes:**
  - Clicking a row under **Staged** shows HEAD→index for that file. Clicking a row under
    **Changes** shows index→worktree. For an `MM` file the two tabs show different content.
  - Both tabs of one file can be open at once. Their titles say which is which, and they
    survive a restart.
  - Open diff tabs stay current as the tree changes, without being reopened.
- **Non-goals:** changing Review's own scopes, which already work; changing what host
  `readDiff` returns; rename detection; a scope switcher inside a diff tab (§6 Vision); commit
  and range diffs (`commit-diff` is untouched); hunk Stage/Unstage/Discard inside a diff tab
  (§13 D1 — Review already stages hunks).

## 2. Behavior & states

**Scope** (`DiffTabScope = 'staged' | 'unstaged'`; absent means unscoped):

| Scope | Base → side | `readDiff` args | Tab title | Opened from |
|---|---|---|---|---|
| absent | HEAD → worktree | `{}` | `<name>` (unchanged) | context menu, file tree, Review at All, conflicted rows, all other existing openers |
| `staged` | HEAD → index | `{ base:'head', side:'index' }` | `<name> (Index)` | Staged-group row; Review card at Staged |
| `unstaged` | index → worktree | `{ base:'index', side:'worktree' }` | `<name> (Working Tree)` | Changes-group row; Review card at Unstaged |

The args come from `scopeDiffArgs` in `webview/review-scope.ts`. A tab's scope is a
`ReviewScope` other than `'all'`, so a tab and Review share one cache entry per (path, scope).

**Primary flow.** Click the `both.ts` row under Staged: a tab `both.ts (Index)` opens with only
the staged hunks. Click the `both.ts` row under Changes: a second tab, `both.ts (Working Tree)`,
opens next to it with only the unstaged hunks. Clicking either row again re-activates the tab
it already opened. A tab's identity is kind + path + scope.

**Routing rules (L2):**
- A Staged-group row opens `staged`. A Changes-group row opens `unstaged`. An untracked file sits
  in Changes and reads index→worktree; the index has no blob, so the whole file shows as added.
- A **conflicted row**, in either group, opens **unscoped** (§13 D3). Its tooltip stays
  `Open diff`.
- Review's card "Open side-by-side diff" opens at Review's current scope (`all` means unscoped).
  It stays side-by-side, as today.
- The Changes-row context menu "Open diff", the file tree and every other existing opener stay
  unscoped. Reopen-closed-tab (Mod+Shift+T) and palette Recents bring back the scope the tab had.
- Every diff open is a **permanent** tab, as it is today: `openDiff` never passes `mode`. This
  spec keeps it that way, so no preview slot can merge the two scoped tabs.

**Render precedence** for a scoped tab, first match wins: loading → error → **conflicted**
(`unmerged`) → oversize → image → binary → **empty side** → populated. An unmerged read has
`head === work === ''`, so the conflicted check has to come before the empty-side check.

| State | Trigger | What renders |
|---|---|---|
| Loading | first read of this (path, scope), and nothing has been rendered for this tab yet | the existing `Loading diff…` notice |
| Refreshing | a re-read is in flight, or the cache key was just evicted | the tab's **last rendered diff** stays up. No Loading flash. |
| Error | the read fails (§13 D7) | `Couldn't read this diff.` + **Retry** |
| Conflicted | a scoped read returns `unmerged: true` | `Conflicted file — there is no staged version to compare against.` + **Open full diff**, which opens the unscoped tab. This replaces the diff and the controls bar: no hunk buttons. |
| Oversize / Image / Binary | as today | the existing notices and `ImageDiff`. Image and binary tabs get no hunk actions. |
| Empty side | scoped text read with `head === work` | `No staged changes in {name}.` or `No unstaged changes in {name}.`. The tab stays open and fills again on the next refresh that finds changes. |
| Populated | text with ≥1 change | Monaco diff and the existing controls bar. No hunk actions (§13 D1). |

Unscoped tabs keep every state they have today. They gain refresh (§13 D4) and the
last-rendered hold. They don't get the empty-side notice.

**Current behavior.** Measured 2026-09-22 on a built worktree (`npm run build`), using a
throwaway Playwright-Electron scenario on `test/e2e/harness.mjs`. The temp repo had `both.ts` in
`MM` state: `MARK_STAGED_SIDE` staged, then `MARK_UNSTAGED_SIDE` added on top, unstaged.

| Claim about today's behavior | How it was measured | Measured / ASSUMED |
|---|---|---|
| The host produces separate Staged and Changes rows for an `MM` file | probe: `.changes__section` = `["Staged","Changes"]`, two `.change` rows | Measured |
| Clicking either row opens the same single tab `both.ts`, HEAD→worktree | probe clicked each row and read `monaco.editor.getModels()`. Original = HEAD, modified has both markers; tab list `[…,"both.ts"]` both times. | Measured |
| Host `readDiff` honours `base`/`side` | the existing green `test/e2e/review-scope.e2e.mjs` and `test/unit/file-service-scope.test.ts` | Measured (existing tests) |
| An open diff tab doesn't re-read when the file changes on disk | probe appended a line after opening, waited 6 s; no model contained it | Measured |
| The diff tab has no hunk actions | probe: the `.diff-controls` buttons are Inline view / Previous change / Next change | Measured |
| Diff tabs aren't restored after a restart: `parseDocs` keeps only `kind:'file'` | `test/unit/persistence.test.ts` "drops malformed entries…" passes and asserts a `diff` entry is dropped | Measured |
| After a restart nothing posts `readDiff` for a restored doc | `applyRestore` only dispatches `restore`; confirmed independently by the spec reviewer | Source-inspected, ASSUMED |
| The diff tab has no empty-state notice and ignores `unmerged` | `doc-view.tsx:112-122`, `diff-viewer.tsx` (no `unmerged` branch) | Source-inspected, ASSUMED (§13 D5) |
| The diff editor is rebuilt, losing cursor and scroll, whenever `head`/`work` change; `hasChanges` is read once, synchronously | `diff-viewer.tsx:120,146` | Source-inspected, ASSUMED |
| `AM`, `AD`/`MD` and untracked outcomes in §4 | derived from `src/file-service.ts` `readDiff` (a missing blob reads as `''`) | ASSUMED. The e2e and unit tests in §7 confirm them. |

Two measured facts contradict assumptions behind the locked decisions. Diff tabs have no hunk
actions, though L4 assumed they do; the conductor ruled them out of scope (§13 D1). And diff
tabs don't persist at all, so L1's "persists across restart" needs a change to the host's persistence code. "No host change needed" is therefore
wrong for persistence. §13 carries both.

## 3. Data / interface contract

- **`OpenDoc.diffScope?: 'staged' | 'unstaged'`** (`webview/docs.ts`). Only `kind:'diff'` docs
  have it.
- **Doc id:** `diff:<path>` when unscoped, the same as today, so existing ids and view-state keys
  stay valid. Scoped tabs are `diff@staged:<path>` and `diff@unstaged:<path>`. Ids are opaque;
  nothing parses them. `idOf` takes the scope as an argument, and both `open` and `restore` go
  through it.
- **`DocsAction 'open'`** gains `diffScope?`. The title comes from
  `initialTitle(kind, path, diffScope)`, which is the one place the suffix is built.
- **`openDiff(path, targetSessionId?, opts?: { sideBySide?, diffScope? })`** runs `path` through
  `canonicalPath`, the same as `openFile`, so the key it shares with Review is spelled the same.
  It then posts `readDiff` with `scopeDiffArgs(diffScope ?? 'all')`.
- **Cache read:** the tab reads `diffs.get(diffKey(doc.path, doc.diffScope ?? 'all'))` in
  `center-pane.tsx`. Cache writes are already keyed by scope (the `fileDiff` handler in
  `app.tsx`). `DocView`/`DiffViewer` hold the **last rendered** `FileDiffDTO` for each tab id and
  keep showing it while the key is missing.
- **Refresh (L3).** One renderer routine, `rereadOpenDiffs(filter)`, posts `readDiff` once for
  each distinct (path, scope) among the open `diff` docs that match the filter. It is triggered
  by:
  - (a) `fsChanged{root}`: docs whose path is under `root`;
  - (b) completion of any Changes-panel git action (stage, unstage or discard a file; bulk
    actions): docs in the acting repo;
  - (c) `invalidateDiff(absPath)` after a hunk op: that path;
  - (d) `restore`: every restored diff doc;
  - (e) `switchSession`: the diff docs that session owns, since `fsChanged` only covers the
    active project.
- **`invalidateDiff` keeps deleting every scope's key** so Review's request-once guard re-fetches
  (`review-view.tsx:612-616`); Review's behavior doesn't change. It then calls (c), which
  re-posts **each scope an open diff tab holds** for that path. Today it re-posts only the
  unscoped key.
- **Ordering:** at most one `readDiff` is in flight per (path, scope). A trigger that arrives
  while one is in flight marks the key dirty, and a single re-post goes out when the response
  lands. This keeps an older response from overwriting a newer one, and it is renderer-only:
  the protocol has no request id.
- **View state across a refresh:** a refresh keeps the tab's cursor, selection and scroll. It
  either updates the diff models in place or restores through the tab's existing view-state
  entry (`viewStateId = doc.id`), clamped to the new line count. The planner picks the mechanism;
  the requirement is that the cursor survives.
- **Navigation:** Prev/Next keep using Monaco's line changes. `hasChanges` is re-derived every
  time Monaco recomputes the diff, not read once after `setModel`. Scoped tabs set
  `ignoreTrimWhitespace: false`, so a whitespace-only side is visible rather than an
  empty-looking populated diff.
- **Persistence:** `PersistedDoc.diffScope?` goes in `src/protocol.ts`, and `toPersistedDocs`
  writes it. **`parseDocs`** (`src/persistence.ts`) accepts `kind:'diff'` as well as `file`. It
  drops an entry whose `diffScope` is present but isn't `'staged'|'unstaged'`, rather than
  widening it to unscoped, which would show different content under the same title.
  `DOCS_VERSION` stays 1 because the change is additive; an older build keeps dropping diff
  entries, as it does now. `sideBySide` still isn't persisted, so a side-by-side tab opened from
  Review comes back using the global setting.
- **Closed tabs:** `ClosedTab.diffScope?`, `toClosedTab`'s `Pick` widened to include
  `diffScope`, and `reopenClosedTab` passes it on to `openDiff`.
- **Recents:** entries become `{ kind, path, diffScope? }`. `pushRecent` takes the scope and
  dedupes on (kind, path, scope). The palette id is `recent:${kind}:${scope ?? 'all'}:${path}`,
  `run` passes the scope, and the subtitle reads `diff (Index)` or `diff (Working Tree)`.
- **Close:** `forceCloseDoc` calls `clearDirty(path)` only for `kind:'file'`. Today, closing a
  diff tab clears the dirty flag of a file tab with the same path, and more diff tabs per path
  would make that easier to hit.
- **Mock bridge (L5):** `webview/bridge.ts` makes `readDiff` depend on `base`/`side`. For at
  least one mock file, the unscoped, staged and unstaged results all differ, and staged `work`
  equals unstaged `head`, so the index is consistent. Unscoped output for every mock file stays
  byte-identical to today.
- **Invariants:** a scoped tab never shows HEAD→worktree content. No two tabs share an id.
  `diffKey(p,'all') === p` still holds, so the editor gutter and the other existing consumers
  are untouched.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Row side (`ChangeDTO.staged`, `conflicted`) | host `src/project-info.ts` | `right-pane.tsx` ChangeRow → `openDiff` | Yes. The producer is unchanged and was measured. |
| Scoped `readDiff`/`fileDiff` | renderer `openDiff` and `rereadOpenDiffs`; the host echoes the scope | `app.tsx` cache → `center-pane` → `DocView` | Yes. The host is unchanged. |
| Shared scoped cache key | tab refresh **and** Review's scoped fetch | the tab **and** the Review card | Yes. Review's eviction and re-fetch are unchanged, and the tab re-posts its own keys. |
| `OpenDoc.diffScope` | `docs.ts` reducer | tab title and id, view state, persistence, closed tabs, recents | Yes |
| `PersistedDoc.diffScope` | renderer `toPersistedDocs` → `persistDocs` | host `parseDocs` → `restoreDocs` → reducer `restore` → trigger (d) | Yes. **This changes a host file** (§13 D2). |
| Hunk op (from Review or the editor's change peek) | `applyHunkAction` → host `gitAction` | trigger (c), the Changes list, Review | Yes. Unchanged; diff tabs only refresh on it. |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| **`MM`** | The Staged row opens `(Index)` with only the staged hunks. The Changes row opens `(Working Tree)` with only the unstaged hunks. Both can be open at once. |
| **`AM`** (new file staged, then edited) | `(Index)`: the whole file as added, since HEAD has no blob. `(Working Tree)`: only the edit made after staging. |
| **`AD`/`MD`** (staged, then deleted in the worktree) | `(Index)`: the staged content against HEAD. `(Working Tree)`: the whole index blob as deleted. |
| **Rename** (staged `R old -> new`) | The row path is `new`. `(Index)` shows `new` as a whole-file add, because there is no rename detection; Review's Staged scope does the same today. Documented, not fixed. |
| **Binary** | The existing binary notice, in any scope. Empty-side detection is impossible because the host empties both texts. |
| **Image** | `ImageDiff` of the scope's two blobs; for `AM`, the Index tab shows "added". No hunk actions. |
| **Conflict (`UU`)** | Rows open unscoped. A scoped tab that *becomes* unmerged (a merge started while it was open) shows the Conflicted notice, with no controls bar. |
| **Untracked** | `(Working Tree)` shows the whole file as added. |
| **Whitespace-only side** | Shown, because scoped tabs don't ignore whitespace. |
| Everything staged while `(Working Tree)` is open | After the refresh the tab shows the empty-side notice and stays open. Unstaging brings the content back. |
| Everything unstaged or committed while `(Index)` is open | The tab shows `No staged changes in {name}.` |
| The file is deleted from both disk and the index | The existing `dropDocsFor` closes every tab of that path, in all scopes. |
| Hunk op from Review or the change peek | Every open diff tab of that path refreshes, in each scope it holds (trigger (c)). |
| Several triggers at once | One `readDiff` in flight per key, plus one dirty re-post (§3). |
| A tab owned by an inactive session or another project | Refreshed by (b) and (c), and by (e) when you switch to that session. `fsChanged` covers only the active root. |
| **Linked git worktree** (`.git` is a file, the index lives outside the root) | An external `git add`/`reset` may not fire `fsChanged`. This is a known limit: `(Index)` catches up on the next (b), (c) or (e). |
| Restore with an unknown `diffScope` | `parseDocs` drops the entry. |
| The repo is gone or unreadable on restore | Measured (§13 D7): `readDiff` reads a missing blob as `''`, so this shows the empty-side notice (scoped) or an empty diff (unscoped). The Error state covers a read that throws. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Scope of a Changes-row click | set by the group (L2); conflicted rows open unscoped | No | Matches VS Code and other git GUIs |
| Title suffix | ` (Index)` / ` (Working Tree)` | No | VS Code's wording, which users already know |
| Side-by-side vs inline | the existing `diffSideBySide` setting | Existing | Unchanged |
| Refresh | on, for every open diff tab including unscoped | No | A diff that silently goes stale is the bug being fixed (§13 D4) |
| Whitespace in scoped tabs | shown | No | Displayed ranges must be the ranges git applies |

## 6. Scope slicing

- **MVP (must):** scope in doc identity and title; row routing; Review card routing; reading the
  cache by scope; refresh triggers (a)–(e) with in-flight coalescing and the last-rendered hold;
  error, conflicted and empty-side states; persistence on both the renderer and the host;
  closed tabs and recents carrying the scope; the `clearDirty` fix; the mock bridge.
- **v1 (should):** "Open staged diff" / "Open unstaged diff" in the row context menu; keyboard
  operability of Changes rows (§13 D6).
- **Follow-up (separate spec):** hunk Stage/Unstage/Discard inside diff tabs (§13 D1).
- **Vision (could):** an in-tab Index / Working Tree / All switcher; rename-aware staged diffs;
  watching a linked worktree's index.
- **Out of scope:** host `readDiff`, Review's scopes, `commit-diff`, the editor's gutter peek.

## 7. Acceptance criteria

**Declarative**
- The Staged row and the Changes row of an `MM` file open two distinct tabs whose content
  differs as §2 describes. Their titles carry the suffixes. Unscoped openers produce today's tab
  and title.
- Scoped tabs survive a restart with their scope, title and content intact.
- After a stage or unstage (whole file or hunk), or an edit on disk, every open diff tab shows
  current content after one refresh. `Loading diff…` never appears during a refresh, and the
  cursor line survives it.

**EARS**
- When the user activates a non-conflicted row in the Staged group, the app shall open or focus
  the `staged` diff tab for that path, showing HEAD→index.
- When the user activates a non-conflicted row in the Changes group, the app shall open or focus
  the `unstaged` tab, showing index→worktree.
- When the user activates a conflicted row, the app shall open the unscoped diff tab.
- When the user activates Review's "Open side-by-side diff" while Review is at scope S, the app
  shall open the side-by-side diff tab at S, where `all` means unscoped.
- When the working tree changes, a git or hunk action completes, tabs are restored, or a session
  becomes active, the app shall re-read the affected open diff tabs, each with its own scope.
- While a re-read is pending, the tab shall keep showing its last rendered diff.
- While a scoped tab's side has no changes, the tab shall show the empty-side notice and stay
  open.
- If a scoped read reports the path unmerged, then the tab shall show the Conflicted notice with
  an Open full diff action and no hunk controls.
- If a read fails, then the tab shall show the Error state with Retry.
- When a closed scoped tab is reopened with Mod+Shift+T, or run again from Recents, the app
  shall restore its scope.
- The preview (mock) shell shall return diff content that depends on the scope.

**Gherkin.** These run in the real Electron app on `test/e2e/harness.mjs`, in a new
`test/e2e/scoped-diff-tabs.e2e.mjs`. Tab titles are matched **exactly**, because "both.ts" is a
substring of "both.ts (Index)". Content is read from `monaco.editor.getModels()`, and changed
lines are compared per side. The no-flash check installs a `MutationObserver` on the
center pane *before* the trigger. It records any `Loading diff…` text, and the scenario asserts
the recording is empty.

```gherkin
Background:
  Given a temp git repo with a committed 20-line both.ts
  And line 2 edited to MARK_STAGED_SIDE and staged
  And line 18 edited to MARK_UNSTAGED_SIDE and left unstaged   # git status "MM both.ts", one hunk per side
  And a session open on it with the Changes panel visible

Scenario: Staged and unstaged sides open as separate tabs
  When I click the both.ts row under "Staged"
  Then the active tab's title is exactly "both.ts (Index)"
  And its changed lines include MARK_STAGED_SIDE and not MARK_UNSTAGED_SIDE
  When I click the both.ts row under "Changes"
  Then the active tab's title is exactly "both.ts (Working Tree)" and "both.ts (Index)" is still open
  And its changed lines include MARK_UNSTAGED_SIDE and not MARK_STAGED_SIDE

Scenario: Unscoped opener is unchanged
  When I choose "Open diff" from the both.ts row's context menu
  Then a tab titled exactly "both.ts" shows both markers as changes against HEAD

Scenario: Review card opens at Review's scope
  Given Review is open at the "Unstaged" scope
  When I click "Open side-by-side diff" on the both.ts card
  Then "both.ts (Working Tree)" is active and side-by-side

Scenario: Staging empties the Working Tree tab without a Loading flash
  Given "both.ts (Working Tree)" is open and the Loading observer is armed
  When I stage both.ts from the Changes panel
  Then that tab shows "No unstaged changes in both.ts." and stays open
  And "both.ts (Index)" now contains MARK_UNSTAGED_SIDE
  And the observer recorded no "Loading diff…"

Scenario: An edit on disk refreshes the scoped tab
  Given "both.ts (Working Tree)" is open with the cursor on line 18
  When a line MARK_LATER_EDIT is appended to both.ts on disk
  Then the tab's modified side contains MARK_LATER_EDIT without being reopened
  And the cursor is still on line 18

Scenario: Untracked file
  Given an untracked new.ts
  When I click its row under "Changes"
  Then "new.ts (Working Tree)" shows the whole file as added

Scenario: Conflicted row opens unscoped
  Given conflicted.ts is in a real merge conflict
  When I click its row
  Then a tab titled exactly "conflicted.ts" opens

Scenario: Scope survives restart and reopen
  Given "both.ts (Index)" and "both.ts (Working Tree)" are open
  When the app is relaunched on the same profile
  Then both tabs come back with their titles and scoped content
  When I close "both.ts (Index)" and press Mod+Shift+T
  Then "both.ts (Index)" reopens with the staged content
```

**Unit tests to go with them:**
- `docs.ts` reducer: identity, title and restore with a scope.
- `parseDocs`: accepts `diff` and rejects a bad scope. The existing "file-only" test encodes the
  old D4 decision and has to be updated.
- Persistence round-trip of `preview`/`active` for diff docs.
- Closed-tabs and recents round-trip, including the palette id.
- Render-state precedence (`diffTabState`), including a scoped tab that becomes unmerged.
- Refresh coalescing: two triggers while a read is in flight produce one re-post.
- Mock bridge output per scope.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Changes row | populated | an unchanged row; tooltip `Open staged diff` or `Open unstaged diff`. Conflicted rows keep `Open diff`. | click opens the tab |
| Diff tab | loading / refreshing / error / conflicted / empty / populated | as in §2 | Retry; Open full diff |
| Tab strip | both scoped tabs of one file | `both.ts (Index)`, `both.ts (Working Tree)`, with the branch icon | standard tab actions |
| First-run / permission / offline | n/a | local git only; there is no network or permission surface | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Changes row | open scoped diff | click | as today (§13 D6) | tap | unchanged; "Open diff" stays unscoped | the row's `title` updated |
| Error / Conflicted notice | Retry / Open full diff | click | focusable button | tap | none | `button` |
| Tab | activate / close / reopen | as today | Mod+Shift+T restores the scope | — | as today | the accessible name includes the suffix |

## 10. Accessibility & i18n (UI)

- **Keyboard:**
  - Retry and Open full diff are native buttons in the tab order.
  - Prev/Next are enabled once Monaco has computed the diff: `hasChanges` is re-derived on every
    diff update (§3); today it may start disabled while Monaco is still computing.
  - Changes rows are `div`s with `onClick` today. Whether they can be reached by keyboard is
    ASSUMED to be no; that is v1 (§13 D6) and is not made worse here.
- **Focus:**
  - A background refresh never moves focus.
  - Retry moves focus to its notice container (`tabIndex={-1}`) before re-reading, so focus
    never falls to `body` when the button disappears.
- **Announcements:**
  - Moving into the empty, conflicted or error state is announced through a polite live region
    that stays mounted with the tab, so its text change is read. A `role="status"` node that is
    mounted already holding text often isn't read.
- **Focus visibility, contrast and motion:** Retry and Open full diff use the interaction-state vocabulary's
  focus ring. The scope is spelled out in text and never shown by colour alone. Nothing new
  moves.
- **i18n:**
  - The app has no layer for externalising strings. New copy goes in exported constants in
    `webview/diff-tab-scope.ts`.
  - The title and each notice are **one whole template per scope**, such as
    `No staged changes in {name}.`, never phrases joined together, so word order can change per
    locale.
  - There are no plurals, dates or numbers. RTL follows the tab strip. The suffix adds about
    15 characters, and tab titles already ellipsize.

## 11. Design tokens (UI)

No new tokens. The notices use `.viewer__notice` and `.viewer__notice-action`. Check all three themes with `npm run shots`.

## 12. Assumptions

- The conductor's L1–L5 are binding. The only deviations are in §13, each with its reason.
- Files expected to change (the planner owns the final map):
  - `webview/docs.ts`, `webview/closed-tabs.ts`
  - `webview/components/right-pane.tsx`, `center-pane.tsx`, `doc-view.tsx`, `diff-viewer.tsx`,
    `review-view.tsx` (passes the scope)
  - `webview/app.tsx`: openDiff, onOpenReviewDiff, invalidateDiff, `rereadOpenDiffs` and its
    triggers, recents and the palette, reopen, restore, forceCloseDoc, Changes-row wiring
  - `webview/bridge.ts`, `webview/mock.ts`
  - `src/protocol.ts`, `src/persistence.ts`, `src/file-service.ts` (`readDiffReply`),
    `electron/main.ts`
  - tests, `CHANGELOG.md`
- It is intended that Review and a diff tab share the scoped cache key, so one read serves both.

## 13. Decisions Needed

Resolved by the conductor on 2026-09-22; the plan is `docs/plans/2026-09-22-scoped-diff-tabs.plan.md`.

- **[high] D1 — Diff tabs have no hunk actions today (measured); L4 assumed they do.**
  **Ruling: out of scope.** The report is about *seeing* the unstaged side, and Review already
  stages hunks. Locked decision L4 is dropped from this item: diff tabs get no Stage/Unstage/
  Discard. **Follow-up:** a separate spec for hunk actions in diff tabs (current-hunk mapping,
  `hunkButtonMode`/`applyHunkAction` reuse, whitespace-exact hunks, disabled reasons, focus
  after an op).
- **[normal] D2 — Persistence needs a host-side change. Accepted.** `parseDocs` accepts
  `kind:'diff'` with an optional valid `diffScope`; `PersistedDoc.diffScope` is added. Unscoped
  diff tabs start restoring too, a visible change that goes in CHANGELOG.
  `test/unit/persistence.test.ts`'s file-only assertion is updated to the new contract, not
  deleted.
- **[normal] D3 — Conflicted rows open unscoped. Accepted.** A narrowed scope of an unmerged path
  has no side to show.
- **[normal] D4 — Refresh covers unscoped diff tabs too. Accepted.**
- **[normal] D5 — Scoped empty-side notice added; unscoped tabs unchanged. Accepted.**
- **[normal] D6 — Changes-row keyboard operability is not fixed here. Accepted** (v1 item).
- **[normal] D7 — How `readDiff` reports a failure. Accepted; measured by the planner.**
  `readDiff` swallows every read failure: missing blobs and unreadable files read as `''`. Only
  a throw escapes, and today that becomes a path-less host error modal while the tab stays on
  `Loading diff…`. The host's `readDiff` handler now always replies, mapping a throw to
  `FileDiffDTO.error`, which the tab shows as the Error state. A vanished repo therefore reads as
  empty, not as an error (§4).

## 14. Open questions

None; this spec was written in autonomous mode, and §13 holds the decisions.

## Self-audit

- Every section is filled.
- Every current-behavior claim is either measured or marked ASSUMED, with how it was checked.
- Every producer/consumer row is "Yes"; the host persistence side is in scope (D2).
- The UI module (§8–§11) is filled.
- A fresh-context reviewer's findings were folded in: the refresh contract, triggers (d) and
  (e), ordering, view state, the current-hunk definition, preview, recents ids, repo root,
  tooltips, `canonicalPath`, `clearDirty`, render precedence, the Error state, and the missing
  Gherkin scenarios.
- The spec is over the FULL line cap. Decisions D1 and D7 and the refresh and ordering contract
  account for the excess.
