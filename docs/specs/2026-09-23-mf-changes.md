---
status: draft
date: 2026-09-23
---

# Feature Spec: mf-changes — git moves into the Changes tab, per-repo; History per repo

**Tier:** FULL   **Feature type:** UI (+ host IPC)
**One-line request:** "git moves into the Changes tab (9c) + History per repo (12b). Terminal tab row
shows only the terminal tab." (autoloop item `mf-changes`, `.autoloop/tasks.yaml`)

**Builds on:** `.autoloop/locked.md` L3, L4, L8, L9 (mf-model delivers `session.repos` with
`tag`/`folder`, missing folders excluded, and a host `repoRoot` validator). Design:
`.autoloop/handoff/README.md` §9c/12b/12i, screenshots `9c-changes-tab.png`, `12b-history.png`,
`12i-empty-states.png`. **Owned elsewhere:** the Review view's `All repos ▼` chip and grouping
(mf-review, which reads this spec's `RepoChanges`), the Files tab and its `No session` copy
(mf-files), the sidebar card (mf-sidebar).

## 1. Problem frame

- **Job:** in a session that spans several folders and repos, see what changed in each repo, act on
  it (stage, discard, review), and switch branch or read history for any of them without
  re-scoping the whole session. Today the git surfaces show one repo at a time, and they sit in the
  terminal tab row, which reads as belonging to the terminal.
- **Actors:** the user running one or more agent sessions; the host (the git source of truth).
- **Success outcomes:**
  1. The terminal tab row holds only tabs. No repo picker or git band.
  2. The Changes tab lists every detected repo of the session (All repos view), each with its own
     tag, branch chip and Staged/Changes sections, and has one `Review` button.
  3. Stage, unstage, discard, hunk ops and diff-open act on the repo the row belongs to.
  4. A repo's branch chip opens "View history" plus the branch switcher for **that** repo. History
     shows one repo at a time, and its header chip swaps repos.
  5. Every duty the old band had is still reachable (§2.4).
- **Non-goals:** a merged cross-repo history graph; per-section or per-repo review icons; Review's
  grouping, chip or progress (mf-review); detecting repos inside repos (mf-model, §13 D13);
  streaming per-repo results; changing `git-action`'s host confinement.

## 2. Behavior & states

### 2.1 Terminal tab row

`CenterPane` passes no `trailing` to `DocTabs`. `RepoPicker`, `GitIndicatorBar`, `showGitBand` and the
`showGitIndicator` prop are deleted (`center-pane.tsx:197-270`). `DocTabs` keeps its `trailing` slot
API only if another caller uses it. Otherwise the slot goes too, since fallow treats it as dead code.

### 2.2 Changes tab (not in review mode)

Layout, top to bottom:

1. **Header** (`.changes__header`): summary, then `Review` (solid/primary, `.changes__review`),
   refresh (`.changes__refresh`), `···` (`.changes__kebab`, "Git actions").
   - All repos view: `N changes · M repos +a -d`. The `· M repos` segment only renders when M ≥ 2.
   - Active repo view: `N changes +a -d` (as in the 9c screenshot).
   - The diffstat keeps today's ASCII `-` and `diffstat--add/--del` classes.
2. **Repo sections**, in **display order**: home repo, then nested repos sorted by path, then
   attached repos in `roots` order (sorted by path within one folder). Non-repo folders and missing
   folders (L9) never appear.
   - **All repos view:** one `.repo-head` per repo. It shows a chevron (collapse toggle), the
     `IconFolder`, the name (basename of `root`), a tag pill (`Home` / `Nested` / `Attached`) and,
     right-aligned, the branch chip `⎇ main ▼`.
     - When `root !== folder`, a second line `.repo-head__sub` shows
       `<basename(folder)>/<relative path>`, e.g. `room-message-bus/vendor/proto-schemas`.
     - Under the header come today's `Staged` / `Changes` sections and `ChangeRow`s, with the kind
       letter, `dir/` + file and diffstat, unchanged. A repo with no changes shows one muted
       `No changes` line.
   - **Active repo view:** exactly one `.repo-head` for the active repo (`session.activeRepoRoot`),
     laid out as in the 9c screenshot. It has no chevron and no tag. Its name is a picker trigger
     (`.repo-head__picker`, `▼`, plus `IconPin` when pinned) that opens today's
     `RepoPickerMenu`:
     - `Auto (follow context)`, then every repo (name, tag, sub-path), current ✓.
     - Then a separator and `Show all repos`, which sets `changesView = 'all'`.
     - With fewer than 2 repos the name is plain text and has no caret.
3. **No per-section review icons.** `.changes__sectionreview` and the `onReviewScope` prop are
   removed from `ChangesView`. `ReviewNavigator` in review mode keeps its own section icons
   (mf-review's surface).

**Review button:** calls today's `openReviewTab`. It is always enabled when the session has at
least one repo, including on a clean tree, where Review shows its own empty state (the rule from the
review-changes-entry-point spec). Title: `Review changes (<bound combo>)`, rendered with
`comboFor('openReview')` (shortcuts are rebindable). What Review scopes to is mf-review's job.

**Header `···`**: a `View` radio pair (`All repos` / `Active repo`), a separator, then the bulk
items. The menu renders in every state, clean included, because it holds the view toggle.
- **Active view:** today's items for the active repo: Stage all, Unstage all, Stash changes,
  Pop stash, Discard all changes.
- **All view:** Stage all / Unstage all / Discard all span every repo (§4). Stash changes / Pop
  stash stay listed but disabled, titled `Stash is per repo. Right-click a repo header.` (§13 D9).

**Switching to the All view posts `repo:unpin`** when the session is pinned. The All view has no
pin control, and a hidden pin would freeze the repo that shortcuts and fallbacks use (§13 D15).

**Collapse (All view):** each chevron toggles that repo's rows. The state is renderer-local, keyed
by repo root and not persisted. All repos start expanded.

**Auto-follow:** a click on a row, chip or repo header posts `repo:context {sessionId, path: root}`.
The active repo then follows the repo the user is working in (the host ignores it while pinned).

### 2.3 Branch chip and its menu

- **Chip** (`.repo-head__branch`): today's `LabelSegment` content, moved out of
  `git-indicator-bar.tsx` into a shared component. In order it shows:
  1. the worktree prefix (`IconWorktree` + `<worktreeName> /`) when the repo is a linked worktree;
  2. the operation badge (`REBASING`, `MERGING`, …);
  3. `IconBranch`;
  4. the branch, or the 7-char SHA plus a `detached` tag, or a `no commits` tag, or `bare`;
  5. a dirty dot;
  6. `▼`.

  This merges today's worktree and bare segments (`git-indicator-bar.tsx:137-160`) with
  `LabelSegment` into one component. Its data is `session.repoGit[root]` (§3).
  - Before the first interrogation lands, the chip shows a muted `…` and stays inert.
  - If the interrogation failed (the host stores `{kind:'none'}` for the repo instead of dropping
    it), the chip shows muted `no git info`, with the title `Couldn't read this repo's git state`.
    Its menu still offers `View history`, which shows History's error state with Retry.
  - **Accessible name** (always a button now):
    `<OP> Branch <b>[, worktree <w>][, uncommitted changes]. Switch branch or view history`, or
    the detached equivalent. The op, worktree and dirty state are never visual-only.
- **Menu** (portaled `Popover`, anchored to the chip, right-aligned, `-webkit-app-region: no-drag`):
  - `View history` (`IconHistory`), then a separator.
  - `Switch branch` label, then today's `BranchSwitcherMenu` body (filter input plus list, current
    ✓), scoped to that repo.
  - The menu opens for every chip. For unborn or bare repos the switch section shows one disabled
    line, `No branches to switch to`.
- **Switch:** posts `git:switch {sessionId, repoRoot, target}`. The refusal outcomes and copy are
  today's. The success announcement becomes `Switched to <ref>`, using the requested ref. Today it
  is `STR.switchedTo('')`, a bug that is not ported. The refusals:
  refused while the session's terminal is busy, refused when **that repo** is dirty, `Unknown
  branch.`, and the failure toast. The announcement goes through the chip's `aria-live` region.
  On success the host refreshes that repo's GitInfo (`scheduleGitRefresh`, today's), and the
  renderer calls `refreshChanges()` when the `ok:true` result arrives, because the host does not
  push changes itself.
- **View history:** opens or activates the singleton History doc with `repoRoot = root` (§2.5).

### 2.4 Where each old git-band duty goes

| Old duty (band / picker) | New home |
|---|---|
| Branch name, detached SHA, unborn, bare | Branch chip, per repo |
| Worktree badge | Branch chip prefix (`IconWorktree` + name) |
| Operation in progress (REBASING…) | Badge at the start of the branch chip. Text, so not color-only |
| Dirty indicator | Dirty dot in the chip (the chip's accessible name says "uncommitted changes"), plus the rows themselves |
| Branch switcher | Chip menu, lower section |
| History button | Chip menu → `View history`; also `Mod+Shift+G` and the palette |
| Review button | Changes header `Review`; also `Mod+Shift+R` and the palette (these work with the pane collapsed) |
| Repo picker (pin / Auto) | Active repo view: the repo header's picker. All view: not needed (every repo is shown) |
| Setting `showGitIndicator` | **Retired** (§13 D3) |
| Setting `multiRepoPicker` | **Retired**. Detection always runs. `false` migrates to `changesView: 'active'` (§13 D4) |
| Repo picker's `aria-live` / `role=group` | Repo header `role=group` named by repo; the chip's live region |

### 2.5 History (12b)

- The History doc stays a singleton center doc (`GIT_HISTORY_DOC_PATH`) and gains
  `repoRoot?: string` in its doc record.
  - Opened from a chip, it uses that repo.
  - Opened from `Mod+Shift+G` or the palette, it uses `session.activeRepoRoot`, else the first repo
    in display order, else omits `repoRoot` (the host falls back to today's `gitRoot(session)`).
  - A restored doc whose `repoRoot` is no longer a detected repo falls back the same way.
- **Header** (`.gh__head`), in order:
  1. `History`;
  2. the repo chip `.gh__repo`: `IconFolder`, name, `▼`, inert with no caret when the session has one
     repo;
  3. today's `.gh__head-sub` (`N commits` / filtered count);
  4. a spacer;
  5. refresh.
- **Repo chip menu:** the session's repos in display order (name, tag, sub-path), current ✓.
  Picking one retargets the view: it resets paging, the ref filter and the selected commit, keeps the
  search query, and re-requests.
- **Filter bar** unchanged ("Search sha, message, author…", "All branches ▼").
- Every host call from the view carries the view's repo:
  - `git:history {…, repoRoot}`;
  - commit detail `git:commitDiff {root: repoRoot}` (the field already exists);
  - "Review commit" → `onReviewCommit(sha, subject, repoRoot)` → `openReviewForCommit(sha, sid,
    subject, repoRoot)`. The parameter already exists (`app.tsx:667`).
- **Refresh-on-change seam** (`git-history-view.tsx:357`) keys on `session.repoGit[repoRoot]`'s
  fingerprint instead of `session.git`.
- It never merges repos.

### 2.6 Empty and degenerate states (12i)

| Condition | Changes tab shows |
|---|---|
| No active session | `No session` / `Start a session to see its changes here.` Replaces `No project open`, aligned with mf-files D12 |
| Session, detection not settled yet | Header summary `Loading…`, no repo heads |
| Session, zero repos after detection | `No git repos` / `None of this session's folders is a git repository.` No header, as in the 12i mock. Detection re-runs on focus and on `requestProject` |
| ≥1 repo, all clean (All view) | Header (`No changes`, Review, refresh, `···`), then every repo head with its chip, then an EmptyState: `No changes` / `All M repos are clean.` (M ≥ 2) or `The working tree is clean.` (M = 1). §13 D6 |
| Active view, active repo clean | Header, the repo head (picker plus chip), then `No changes` / `The working tree is clean.` |
| Repo's first result not in yet | Repo head, then a muted `Loading…` line |
| Home missing (L9) | The home repo is absent. Other repos render normally |

Review mode (`reviewMode`) still swaps the whole tab to `ReviewNavigator`, unchanged from the
review-mode spec §2.3.

### 2.7 Current behavior (claims this spec changes)

| Claim | How measured | Status |
|---|---|---|
| RepoPicker plus GitIndicatorBar render in `DocTabs` `trailing` | `node test/e2e/run-smoke.mjs git-indicator multi-repo` on a fresh build, both PASS 2026-09-23 (they assert `.git-indicator*` / `.repo-picker__trigger` in the app) | Measured |
| Changes lists one repo (the active one); `requestProject.changesRoot` = `activeRepoRoot` | `multi-repo` PASS above (it asserts that Changes follows the pinned repo and excludes the other) | Measured |
| `detectRepos` never reports a repo inside a found repo | `npx vitest run test/unit/repo-scan.test.ts`: 6/6 pass, incl. "does not descend into a repo once found" | Measured |
| A failing `git status` in `gitChanges` yields `[]` (reads as clean) | source `src/project-info.ts:17-21`, not run | ASSUMED (§13 D11) |
| `git:history`/`refs`/`switch` resolve `gitRoot(session)` only | source `electron/main.ts:2282,2627,2649` | ASSUMED (§13 D19) |
| Row actions, diff-open and hunk ops use `gitRootForSession(active)` | source `app.tsx:1421,2453,3415` | ASSUMED (§13 D19) |
| Theme tokens are `--accent --accent-soft --green --red --amber --danger --text-dim --text-faint`; no `--warn`/`--bad` exist | `grep` over `webview/styles.css` | Measured (§13 D14) |

## 3. Data / interface contract

```ts
// src/types.ts — Session, runtime-only (stripped by serializeSessions like `git` today)
repoGit?: Record<string /* repo root */, GitInfo>;   // REPLACES `git?: GitInfo`
// helper (src/active-cwd.ts or a new src/repo-git.ts):
gitOf(session, root = session.activeRepoRoot): GitInfo | undefined

// src/protocol.ts
interface RepoChanges {                // shape mf-review §3.1 consumes
  root: string;                        // == a session.repos[].root
  name: string;                        // basename(root)
  tag: 'home' | 'nested' | 'attached';
  sub?: string;                        // `<basename(folder)>/<rel>` when root !== folder
  branch?: string;                     // from repoGit, for convenience
  changes: ChangeDTO[];                // paths relative to root (as today)
}
// renderer → host
// requestProject.sessionId and repoRoot on git:history/refs/switch (+ the echo on their results)
// are mf-model's (its §3.2/§3.3). This item adds repoChanges, and is the first caller.
| { type: 'requestProject'; path: string; changesRoot?: string; sessionId?: string }
// host → renderer
| { type: 'project'; …today; repoChanges?: RepoChanges[] }   // present iff sessionId (both views; §13 D20)

// webview/git-intent.ts
type GitActionIntent = { op: IntentOp; path?: string; repoRoot?: string };
// webview/hunk-actions.ts — HunkActionHost.root: string → rootFor(absPath): string
```

- **Trust boundary:**
  - `repoRoot` on any sessionId-keyed git message is validated by mf-model's handlers
    (mf-model §3.3).
    - Omitted: today's `gitRoot(session)`.
    - Unknown: that result's failure shape (`state:'error'` / empty shape + `error:'unknown
      repo'`), and git is never run against the raw path. This item only renders it:
      - History shows its error state.
      - The switcher list shows `No matching branches`.
      - A switch toasts `Couldn't switch branch: unknown repository` and changes nothing.
  - `requestProject` never takes repo paths from the renderer. The host enumerates
    `mgr.get(sessionId).repos`.
  - `git:commitDiff.root` is renderer-chosen and unvalidated today (`main.ts:2331`
    `m.root ?? gitRoot(session)`; mf-model D14 deferred it). History now sends it, so this item
    validates it: it is accepted only if it is in `session.repos` or equals `sessionGitRoot(session)`
    (the terminal-originated path). Otherwise the reply is `git:commitDiffResult` with an error, and
    no git runs (§13 D22).
  - `git-action` IPC keeps today's `writeRoots` containment. The renderer only ever sends a
    `RepoChanges.root`.
- **Host fan-out:**
  - `repoChanges` runs `gitChanges(root)` per repo via `mapWithConcurrency(repos, 4, …)` from
    `src/git-exec.ts`. All git goes through `runGit`/`runGitBin` (`GIT_OPTIONAL_LOCKS=0`), with no
    new spawn path.
  - The active repo's entry reuses the `changes` computation, so it isn't run twice. `changes` stays
    the active repo's list, so existing consumers are unchanged.
  - One reply per request, all repos together (§13 D10).
- **Per-repo GitInfo:**
  - `runGitRefresh(sessionId)` interrogates every present detected repo (concurrency 4) and sets
    `mgr.setRepoGit(id, map)`. The drop-stale check compares the repo set it started with against
    the latest one.
  - HEAD watches: one per repo, for the first 16 repos in display order. Repos beyond that refresh
    on focus, `requestProject` and switch (§13 D8).
  - Its triggers are today's: window focus, a HEAD change, a switch, `repo:pin`/`unpin`/`context`,
    and the repo set changing.
- **Invariants:**
  - `RepoChanges[]` order = display order (§2.2).
  - Every `ChangeRow` knows its `repoRoot`.
  - `openDiff(joinPath(repoRoot, rel))`.
  - `onGitAction({op, path, repoRoot})` → `runGit` uses `intent.repoRoot ?? gitRootForSession`.
  - `rereadOpenDiffs` is scoped to that root.
  - `onChangeContextMenu(e, rel, repoRoot)`.
  - Hunk ops resolve their root per file (`repoForPath(session.repos, abs)` ?? `gitRootForSession`)
    and `stagedPaths`/`conflictedPaths` come from that repo's `RepoChanges`.
- **Settings:**
  - `changesView: 'all' | 'active'` (default `'all'`) is added.
  - `showGitIndicator` and `multiRepoPicker` are removed from `Settings`. `coerceSettings` ignores
    both, and maps a stored `multiRepoPicker: false` (with no stored `changesView`) to
    `changesView: 'active'`.
  - `scheduleRepoScan` loses its `multiRepoPicker` gate (`main.ts:1143`).

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `repoChanges` | host `sendProject` (here) | ChangesView (here), Review/navigator (mf-review), Files git dots (mf-files D13) | Yes (the producer is here). The consumers elsewhere read the pinned shape |
| `session.repoGit` (replaces `git`) | host `runGitRefresh` (here) | branch chips, History seam (here), session card dirty count `session-card.tsx:94` → sum over `repoGit`, and the Review status `src/session-icon.ts:42` (`completedRun && session.git?.dirty`) → `anyRepoDirty(s)`, so changes that exist only in an attached repo still flag the session (here; mf-sidebar may restyle) | Yes |
| `session.repos` with tag/folder, missing excluded | mf-model | display order, heads, validator (here) | **No**, locked L4/L9, delivered first |
| `fsChanged {root}` for every folder | mf-model watcher | `refreshChanges` (unchanged, `app.tsx:1386`) | **No**, locked L6. The consumer already refreshes on any `fsChanged` |
| `GitActionIntent.repoRoot` | ChangeRow, bulk and context menus (here), Review action bar (mf-review) | `onGitAction`/`runGit` (here) | Yes |
| `repoRoot` on history/refs/switch + result echo | chip, History (here) | host handlers + validation (mf-model §3.3) | **No**, locked L3. Safe: mf-model lands first, and absent means today's path |
| `changesView` setting | `···` menu, picker, Settings (here) | ChangesView, badge (here) | Yes |
| History doc `repoRoot` | chip / palette (here) | GitHistoryView, `openReviewForCommit` (Review consumes, mf-review) | Yes |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Double refresh / stale reply | The renderer keeps today's `project.path === activeCwd` gate. It also drops a `repoChanges` reply whose root set no longer matches `session.repos` |
| Switch while a switch is pending | The chip is disabled while `switching` (today). Other repos' chips stay live |
| Switch reply for another repo | Chips filter on `repoRoot` as well as `sessionId` |
| History reply after a repo retarget | Dropped: `repoRoot` ≠ current, or a stale `requestId` |
| 0 / 1 / many repos | §2.6. With 1 repo: no `· M repos`, inert picker, inert History chip |
| Many repos (e.g. 50) | Concurrency 4, each git bounded by `GIT_TIMEOUT`. No cap in MVP; v1 lazy-loads collapsed repos (§6) |
| One repo's git times out | MVP: it reads as clean (today's behavior, §13 D11). v1: an inline `Couldn't read changes` + `Retry` under that head |
| Repo deleted or folder goes missing mid-view | It disappears from `session.repos`, so its head, collapse state and History target drop. History falls back per §2.5 |
| Branch switch in an attached repo while the terminal is busy | Refused `busy` (the gate is per session, as today) |
| Same basename in two repos | The head shows `name`; `title` = full root; the sub-path line tells nested repos apart. Attached collisions get ` — <parent>` (matches mf-files D15) |
| Bulk ops in the All view | Header `···`: `Stage all` / `Unstage all` fan out per repo. `Discard all changes` confirms `Discard all N changes across M repos? This cannot be undone.` `Stash changes` / `Pop stash` are per repo only, via the repo head's context menu, and are shown disabled in the header with a pointer title (§13 D9) |
| Pane collapsed | Review via `Mod+Shift+R`, History via `Mod+Shift+G`, both use the active repo |
| Detached / unborn / bare | Chip per §2.3; `View history` still offered |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Changes view | `all` | Yes: `···` → `View: All repos / Active repo`, the Active picker's `Show all repos`, and a Settings select (replacing the two retired toggles). Global, persisted | A multi-folder session exists to show every repo. Single-repo sessions look the same either way (§13 D1) |
| Repo collapse | expanded | Session-local, not persisted | Cheap to redo; avoids a stale-root store |
| Repo order | home → nested by path → attached in roots order | No | Matches mf-review and mf-files |
| Branch indicator visibility | always | No (setting retired) | It is the only in-pane entry to switch and History |
| Fan-out concurrency | 4 | No | Each unit is a whole `gitChanges`, which itself runs up to `COUNT_CONCURRENCY`=8 file reads (`project-info.ts:13`), so 4×8 bounds the host |
| HEAD watch cap | 16 repos | No | Keeps chips live for realistic sessions without unbounded watchers |

## 6. Scope slicing

- **MVP:**
  - §2.1–2.6;
  - the protocol in §3 with host validation;
  - per-repo intents, diffs and hunks;
  - retiring the settings, plus migration;
  - the e2e updates in §7.3.
- **v1:** per-repo error state with Retry; lazy-loading collapsed repos beyond 16; persisting
  collapse per session.
- **Vision:** streamed per-repo results; a total commit count in History.
- **Out of scope:** Review grouping and chip (mf-review); a merged history; detecting repos inside
  repos; `rangeDiff`/Compare `repoRoot` (mf-review).

## 7. Acceptance criteria

### 7.1 Declarative

- AC1: `.doctabs` contains no `.git-indicator`, `.repo-picker` or git control in any state.
- AC2: A session with a home repo plus an attached repo, in the All view, renders two `.repo-head`s
  in order (`Home`, `Attached`), each with its own branch chip, and each lists only its own repo's
  changes. The header reads `N changes · 2 repos +a -d`, and the tab badge is N.
- AC3: `changesView='active'` renders one head, the active repo, with a picker. Picking the other
  repo pins it (`repo:pin`) and swaps the list. `Show all repos` returns to the All view. The choice
  survives a restart.
- AC4: Stage, unstage and discard on a row in the non-active repo run `git-action` with that repo's
  root (spy), and only that repo's status changes on disk. Opening that row opens
  `joinPath(repoRoot, rel)`'s diff.
- AC5: Chip menu → `View history` opens History with that repo's commits (its subjects appear, the
  other repo's don't). Its header shows `History`, the repo chip and `N commits`. Retargeting via the
  chip shows the other repo's commits.
- AC6: Switching a branch from the attached repo's chip changes only that repo's HEAD. The switch
  result carries `repoRoot`, and the chip updates without a focus change.
- AC7: An unknown-repo reply (mf-model §3.3 failure shape) renders as §3 says. No checkout happens,
  and no other repo is touched (unit test over the chip and History reducers).
- AC8: No per-section review icons exist (`.changes__sectionreview` count 0). There is exactly one
  `.changes__review`, and it opens Review on a clean tree.
- AC9: Empty states render the exact copy in §2.6 for no session, zero repos, and all clean (with 1
  and with 3 repos).
- AC10: A stored `showGitIndicator`/`multiRepoPicker` is ignored without error, and
  `multiRepoPicker:false` yields `changesView:'active'` (unit, `coerce-settings`).
- AC11: Rebase-in-progress, worktree and dirty states render in the chip with an accessible name
  that includes them. These are **new** assertions: no test covers op, worktree or dirty rendering
  today, and `git-indicator.e2e.mjs` checks only the label text.
- AC12: `npm run verify` is green. `test/unit/overlay-sites.test.ts` and `state-vocabulary.test.ts`
  are updated for the new chip, Popover and Review button roles, not loosened.

### 7.2 EARS

- When the session's repo set changes, the host shall recompute `repoGit` and the renderer shall
  re-request `repoChanges`.
- When the renderer sends `requestProject` for a session, it shall include `sessionId`, and the
  host shall reply with `repoChanges` for every present detected repo.
- The renderer shall only send, as `repoRoot`, a root taken from the current `session.repos`, and
  shall never build one from a path.
- When the user activates a row, chip or repo head, the renderer shall post `repo:context` for that
  repo.

### 7.3 Gherkin (the new e2e `changes-multi-repo.e2e.mjs`, real app, hidden)

```gherkin
Scenario: Two repos, one session, per-repo actions
  Given a temp home repo "home" with a modified a.txt and an attached repo "ref" with a staged b.txt
  And a session opened with roots ["ref"]
  When the Changes tab is shown
  Then the terminal tab row has no git controls
  And repo heads read "home · Home" then "ref · Attached", each with a branch chip "main"
  When I unstage b.txt under "ref"
  Then git status in "ref" shows b.txt unstaged and "home" is untouched
  When I open the "ref" chip menu and choose "View history"
  Then the History header shows "ref" and ref's commit subject, not home's
  When I switch "ref" to branch "feature" from its chip
  Then ref's HEAD is feature, home's HEAD is main, and the "ref" chip reads "feature"
```

### 7.4 Existing e2e scenarios that assert the old placement

They are all **updated to the new placement with the same or stronger assertions**. None is deleted
or weakened. Two new harness helpers (in `test/e2e/harness.mjs`) take the places of the removed
selectors:

- `openReview(page)`: ensure the pane is visible, select Changes, click `.changes__review`.
- `openHistory(page, {repo?})`: open `.repo-head__branch` (the first, or by name), then click
  `View history`.

`openSession` gains `roots` (mf-model's `openRepo.roots`).

| Scenario | Asserts today | Change |
|---|---|---|
| `git-indicator` | `.git-indicator*` DOM for branch, detached, non-git | Same cases on `.repo-head__branch`. Non-git → `No git repos` and zero `.repo-head`. **Add** AC1 and AC11 |
| `git-band-persistence` | Band survives opening a file/markdown/PDF | Same docs open: the Review button and branch chip stay present and operable in the Changes tab, and the tab row has no git chrome. The file keeps its name, and its header cites this spec |
| `branch-switch` | Dropdown via `.git-indicator__branch--switchable`; ok/busy/dirty/bogus | Via the chip menu. All four outcomes kept, plus a `repoRoot` echo |
| `git-ref-dropdown` | History via `.git-indicator__history` | `openHistory(page)`; filter-bar assertions unchanged |
| `git-history` | History from the indicator button, graph, detail, commitDiff | `openHistory(page)`. **Add:** the header repo chip is present; commitDiff carries `root` |
| `multi-repo` | Repo picker pin re-scopes Changes and History; pin survives `repo:context` | Run under `changesView:'active'` with `.repo-head__picker`, keeping every assertion. History-follows is asserted via the History repo chip. **Add** the All-view case: both repos visible at once |
| `repo-rescan` | State-only (`session.repos` gains repo-c) | Unchanged. **Add** one DOM check that repo-c's `.repo-head` appears in the All view |
| `review-entry-point` | Review visible without the Changes tab, clean tree | Review is visible in the Changes header on a clean tree and opens its empty state. `Mod+Shift+R` with the pane collapsed opens Review. Negative: nothing in the tab row. The header comment cites this spec (the rule it guarded is superseded by L8) |
| `review-scope` | Section icons open Review pre-scoped | `openReview` + the Review header's Staged/Unstaged segment. Same card assertions. **Add** `.changes__sectionreview` count 0 |
| `hunk-staging` | Opens Review via `.git-indicator__review` | `openReview`. **Add** one hunk op on a file in the attached repo, asserting that repo's index |
| `review-*` (card-collapse, commit-picker, commit-source, compact-header, compare, diff-syntax, keymap-persist, mode-pane, navigator, notes-handoff, row-pixels, search, tab-state, virtualize), `middle-click-review`, `scoped-diff-tabs`, `split-diff-map`, `word-diff`, `theming-light`, `overlay-popovers`, `commit-detail-resize`, `commit-review-bounds` | `.git-indicator__review` / `__history` as the way in | Swap to `openReview` / `openHistory`; nothing else changes |
| `visual/shoot.mjs`, `stress/git-changes-huge.stress.mjs` | Same selectors | Same helpers. Shots gain a Changes-tab frame in the All view |
| `changes-fixture.mjs` (shared helper: `rowIndex` l.41-50 takes `.changes__section`'s parent and assumes flat `:scope > .change` siblings; `changeRow` l.93 uses `.changes__section ~ .change`) | Flat, single-repo row list | Rewrite to be repo-scoped: `changeRow(page, rel, {repo?})` finds rows inside the matching `.repo-head` group's section list. Same row identity. Its consumers `scoped-diff-tabs` and `editor-nav-history-moves` re-run unchanged on top of it |
| `context-menu-order`, `go-files`, `hover-obstruction`, `middle-click-surfaces` (reach `.change` rows via `.rtab`) | Row DOM under a flat list | Re-run. Fix only the selectors the nesting breaks, and keep every assertion |

Unit tests to update: `branch-menu`, `git-switch` (repoRoot), `overlay-sites` (new Popover sites,
removed repo-picker/git-indicator sites), `state-vocabulary`, `coerce-settings`/`settings`,
`persistence` (`repoGit` stripped).

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Changes header | populated / clean / loading | summary + Review + ↻ + `···` / `No changes` + same / `Loading…` | Review, refresh, menu |
| Repo head | expanded / collapsed / clean / loading | rows / head only / muted `No changes` / muted `Loading…` | chevron, chip, right-click |
| Branch chip | branch / detached / unborn / bare / op / dirty / worktree / unknown / switching | per §2.3; `…` when unknown; disabled while switching | open menu |
| Chip menu | switchable / not switchable / filtering / no match | View history + list / View history + disabled line / filtered list / `No matching branches` (today) | pick, Esc |
| Active picker | ≥2 repos / 1 repo / pinned | caret menu / plain name / pin glyph | pick, Auto, Show all repos |
| History header | multi-repo / single-repo / loading / error | repo chip ▼ / inert chip / today's / today's retry | retarget, refresh |
| Tab | none / zero repos / all clean | §2.6 copy | — |

## 9. Interaction inventory (UI)

| Component | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|
| Review button | click | Tab / Enter; `Mod+Shift+R` global | — | button, name `Review changes` |
| Repo head chevron | click | Enter/Space | head: Stage all · Unstage all · Stash changes · Pop stash · Discard all changes (danger, confirm) · Copy path · Reveal in Explorer, for that repo; Shift+F10 / Menu key on the focused head | button, `aria-expanded`, `aria-controls` the section list; head `role=group`, `aria-label="<name>, <tag>"` |
| Branch chip | click toggles (`menuToggleIntent`) | Enter/Space opens; focus goes to the filter; ArrowUp from the filter reaches `View history`; Esc closes and returns focus to the chip only if opened by keyboard (today's rule) | — | button, `aria-haspopup=menu`, `aria-expanded`; name per §2.3 (includes op, worktree, dirty); `aria-live=polite` result |
| Active picker | click | as chip | — | button, `aria-haspopup=menu`, name `Active repo: <name>[, pinned]` |
| History repo chip | click | Enter opens, arrows move, Enter picks, Esc closes | — | button + `role=menu`/`menuitemradio` `aria-checked` |
| Rows | unchanged (click, middle-click, hover actions) | unchanged | today's row menu, bulk items scoped to the row's repo | unchanged |

Touch is not applicable (desktop Electron). There is no drag.

## 10. Accessibility & i18n (UI)

- Every new control is keyboard-reachable in DOM order: header → each repo head (chevron, chip) →
  rows.
- Focus rings use the existing role ladder (state-vocabulary). The Review button is `solid` and
  the chips are `field`.
- Tags carry text (`Home`/`Nested`/`Attached`), so color is never the only signal. The operation
  badge is text, and dirty status is in the accessible name.
- Contrast ≥ 4.5:1 for tag text on its tint in all three themes (checked in `npm run shots`).
- A switch outcome and a History retarget (`Showing history for <name>`) are announced via
  `aria-live=polite`.
- Reduced motion: no new animation.
- **Focus after view changes:**
  - `Show all repos` / a View radio → the header `···` trigger, or the picker's replacement: the
    first repo head's chevron.
  - Active-picker pick → the picker trigger.
  - History retarget → the History repo chip.
  - Collapse / expand → stays on the chevron.
  - An unmounted focused element never drops focus to `body`.
- Forced colors: the dirty dot gets a `CanvasText` border under `@media (forced-colors: active)`.
  The tags keep their text and gain a 1px `currentColor` border there.
- Header at 340px with ~30% longer strings: the summary ellipsizes first (`min-width:0`), Review,
  ↻ and `···` are `flex:none`, and the full summary goes in `title`. RTL follows the pane's
  existing flex order, and paths and branches stay `dir="ltr"`.
- Header diffstat uses ASCII `-`, like the rows (§13 D21).
- All copy lives in `STR` objects. Plurals: `1 change`/`N changes`, `1 repo`/`M repos`,
  `All M repos are clean.`, `1 commit`/`N commits` (today's).
- Repo names, paths, branches and SHAs are `dir="ltr"` user data. Long names ellipsize, with
  `title` holding the full text. The chip keeps `flex:none` and the name shrinks first.
- Repo sort uses `localeCompare` for nested paths.

## 11. Design tokens (UI)

- **Home tag:** `--accent` text on `--accent-soft`.
- **Nested tag:** `--amber` text on `color-mix(in srgb, var(--amber) 14%, transparent)`.
- **Attached tag:** `--text-dim` on the neutral chip fill already used by `.git-indicator__tag`.
- **Branch chip:** reuses `.git-indicator__*` visual rules, renamed under `.branch-chip`, with no
  new values.
- **Review button:** the existing solid/primary button class.
- The head row reuses the `files__bar` family so Files and Changes heads match (mf-files).
- No hex. Aero, Neon and light all follow from the tokens.

## 12. Assumptions

- mf-model (`docs/specs/2026-09-23-mf-model.md`) delivers:
  - `session.repos[].tag`/`folder`, with missing folders excluded and the list capped at 200;
  - `requestProject.sessionId`;
  - validated `repoRoot` on history/refs/switch, with the echo on their results;
  - `openRepo.roots`, which the e2e uses.

  Its D10 (`multiRepoPicker=false` → `repos=[]`) is resolved here by D4.
- `ReviewNavigator` stays as it is (mf-review extends it).
- The Changes badge = the sum of the changes shown (All view) or the active repo's (Active view).
  In review mode it counts the navigator's files, as today.

## 13. Decisions Needed

The spec runs over the ~400-line FULL cap. The extra length is the §7.4 migration table, which
covers 35+ e2e files that assert the old placement, and these 22 decisions. Both are needed so
the builder doesn't weaken tests or guess.

- **D1 [normal]** Default `changesView`. **Pick: `all`.** The prototype's tweak defaulted to Active
  repo, but the header copy `· M repos`, the one Review button and mf-review's All-repos default
  all assume every repo is visible. A single-repo session is identical either way.
- **D2 [normal]** Where the view toggle lives. **Pick:** a `View` radio pair at the top of the header
  `···`, `Show all repos` in the Active picker, and a Settings select. Global and persisted.
- **D3 [normal]** `showGitIndicator`. **Pick: retire it.** Its "quieter terminal chrome" purpose is
  gone with the band. Keeping it would let a user hide the only in-pane branch switch and History
  entry. Git interrogation always runs.
- **D4 [normal]** `multiRepoPicker`. **Pick: retire it.** Detection must run for multi-folder git.
  `false` migrates to `changesView:'active'`, its closest surviving meaning.
- **D5 [normal]** Worktree, operation and dirty move **into the branch chip** (today's
  `LabelSegment`, rehomed) rather than new head badges.
- **D6 [normal]** Clean tree: **keep the repo heads** above the `All M repos are clean.` text. The
  12i mock shows the text alone, which would remove branch switch and History on a clean tree. That
  is the exact regression the review-changes-entry-point spec once fixed.
- **D7 [normal]** `No git repos` has no header or refresh, per the mock. Detection re-runs on focus
  and `requestProject`.
- **D8 [normal]** Per-repo GitInfo is `Session.repoGit` **replacing** `session.git` (L1's "no two
  fields that must agree"). HEAD watches are capped at 16 repos.
- **D9 [normal]** All-view bulk ops: header Stage/Unstage/Discard span repos, with a count-bearing
  confirm. Stash is per repo only, via the repo head's context menu (no visible per-repo `···`, per
  the mock). In the All view the header lists Stash and Pop disabled, with a title pointing at the
  context menu, so the loss of discoverability stays small.
- **D10 [normal]** `repoChanges` arrives in one reply at concurrency 4. There is no repo cap in the
  MVP.
- **D11 [normal]** ASSUMED from source: a failed `git status` reads as clean. The MVP keeps this;
  the per-repo error state is v1.
- **D12 [normal]** History's `N commits` stays today's loaded or filtered count, not the repo total
  the mock implies.
- **D13 [high]** Measured: `detectRepos` never descends into a found repo, so the mock's Nested
  example (a repo under the home **repo**) can't occur. Nested appears only for repos under a
  non-repo home folder. Changing detection is mf-model's call; this item renders whatever
  `session.repos` holds.
- **D14 [high]** (broken lock item) The lock names `--warn`/`--bad`/`--ok`. The measured tokens are
  `--amber`/`--danger`/`--green`/`--red`. **Pick:** use the real tokens, with no aliases.
- **D15 [normal]** The Active view keeps pin/Auto semantics (`repo:pin`/`repo:unpin`). Row, chip and
  head clicks post `repo:context`. Switching to the All view posts `repo:unpin`, so a pin never
  sits hidden in a view that has no pin control. The alternative was a visible `active` marker on
  a repo head; rejected as extra chrome the mock doesn't have.
- **D16 [normal]** Retargeting History keeps the search query and resets the ref filter, selection
  and paging.
- **D17 [normal]** With no active session, the Changes tab shows `No session` / `Start a session to
  see its changes here.`, aligned with mf-files D12. `No project open` is removed.
- **D18 [normal]** The rule from review-changes-entry-point, "Review visible without opening
  Changes", is superseded by L8. The pane-collapsed path is `Mod+Shift+R` and the palette.
- **D19 [normal]** The §2.7 source-read claims (host git handlers, renderer root resolution) were
  not run. An independent reviewer re-read them and confirmed each line ref. The builder confirms
  them with `multi-repo`/`branch-switch` before changing them.
- **D20 [normal]** `repoChanges` is sent whenever `sessionId` is present, **in both views**, not
  only in the All view. This keeps the Files-tab git dots in attached repos (mf-files D13) and the
  session-level dirty signals correct in the Active view. The cost is the fan-out running always.
- **D21 [normal]** Header diffstat keeps ASCII `-`, like the rows and today's header. The tasks.yaml
  and handoff `−` (U+2212) is treated as typography, not a requirement.
- **D22 [normal]** `git:commitDiff.root` validation (mf-model D14 deferred it) is taken in here,
  because History becomes a renderer caller that picks a root. It is accepted if it is in
  `session.repos` or equals `sessionGitRoot(session)`.
