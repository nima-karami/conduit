---
status: active
date: 2026-06-19
tier: FULL
type: UI
---

# Git history — multi-branch commit graph + commit inspection

## Problem frame

**Job:** "Let me see the project's git history the way a real git client does —
the branches, how they diverge and merge, the commits — and click any commit to
read it and see its diff, without leaving Conduit for a terminal `git log` or an
external tool."

Today Conduit shows only *where you are* (the branch/worktree indicator in the E3
band) and *what's uncommitted* (the Changes tab). There is **no way to see the
commit history or the branch topology**. `src/repo-history.ts` is unrelated (it's
the recent-folders MRU).

**Actors:** the developer reviewing what happened on the project — their own work,
an agent's commits, branch divergence before a merge.

**Success outcomes:**
- A **full multi-branch commit graph** (all branches/refs, lanes, merges) for the
  active repo.
- Click a commit → inspect it: author, date, full message, changed files, and the
  **diff** (reusing the existing diff viewer).
- Reachable from a button on the **right side of the git indicator bar**.
- Read-only and safe alongside a running shell.

**Non-goals (v1):**
- Any **mutation** (checkout, branch create, reset, cherry-pick) — read-only;
  mutations belong to the branch-switcher (branch-worktree-indicator Slice B) with
  its busy/dirty safety gating.
- Blame, per-file history, commit compare/range-diff, staging from history.
- Editing/rewriting history.

## Decisions (locked / assumed)

- **Visualization = full multi-branch graph** (all refs at once, lanes + merges),
  not a linear list (locked).
- **Read-only** inspect + diff (locked).
- **Entry point:** a button at the **right end of `GitIndicatorBar`**
  (`webview/components/git-indicator-bar.tsx`); opens the graph as a center-pane
  view (a new doc kind, sibling to the board/architecture/review views), scoped to
  the active session's repo (its `cwd`/`projectPath`).
- **Renderer = custom lane layout, not a library (assumed, reversible).** Rationale:
  a from-scratch **pure** lane-assignment over `git log` parent data is unit-testable,
  themes via the app's CSS vars, adds no dependency, and the app already favors
  bespoke renderers (architecture canvas, diff). A graph lib (`@gitgraph/js`/d3) is
  the fallback if lane layout proves too costly — flag, not a blocker.
- **Diff reuse:** a commit's changes render through the existing `FileDiffDTO` +
  diff view (`src/protocol.ts:70/129`); the host produces the diff via `git show`.
- **Git access reuse:** a new host module `src/git-history.ts` mirrors
  `src/git-info.ts` — `execFile('git', [argArray])`, bounded timeout, non-throwing,
  the `gitAvailable` latch, host-only (renderer never imports `node:child_process`).

## Behavior & states

### Graph view
- Loads the active repo's commits across **all refs**:
  `git log --all --parents --date-order --decorate=full --pretty=<stable format>`
  capped to **N** (e.g. 500) with **"load more"** paging.
- Renders a **graph**: each commit is a node placed in a **lane**; edges connect a
  commit to its parents; **merge commits** (≥2 parents) join lanes; **ref labels**
  (branches/tags/HEAD) badge their commits; **HEAD** is marked.
- Each row shows: graph glyph + short SHA + subject + author + relative date +
  ref badges.

### Inspection
- Select a commit → a **detail** region: full SHA, author/committer, dates, full
  message, and the **changed-files list**; selecting a file (or "view diff") opens
  the commit's diff in the diff viewer. Merge commits diff against their **first
  parent** (note shown).

### States
`loading` · `ready` (graph) · `empty` (repo has no commits / unborn HEAD) ·
`not-a-repo` (cwd isn't a git repo → friendly message, not the graph) ·
`error/timeout` (bounded failure → message + retry) · `git-missing` (same latch as
the indicator → feature hidden/disabled) · `loading-more` (paging) ·
`commit-selected` (detail + diff).

### Refresh
- Re-interrogate on the same seams as the indicator (cwd change, HEAD watch,
  window focus) — debounced; no busy-polling. New commits/branches appear on
  refresh.

## Data / interface contract

- **Host `src/git-history.ts` (pure parse + bounded spawn):**
  - `parseCommits(stdout): CommitNode[]` where
    `CommitNode = { sha; parents: string[]; refs: string[]; author; email?; date: number; subject; body? }`
    — **pure**, unit-tested against canned `git log` output.
  - `assignLanes(commits): GraphLayout` — **pure** lane assignment (commit → lane
    index, edges with from/to lanes incl. merges) — the core testable algorithm.
  - `getHistory(cwd, { limit, before? })` — bounded `execFile` git log → parsed.
  - `getCommitDiff(cwd, sha)` — `git show`/`git diff <sha>^ <sha>` → existing
    `FileDiffDTO` shape (reuse, don't reinvent).
- **Protocol (new `WebviewToHost`):** `git:history` `{ sessionId, limit?, before? }`,
  `git:commitDiff` `{ sessionId, sha, path? }`.
- **Protocol (new `HostToWebview`):** `git:historyResult`
  `{ sessionId, commits, layout, hasMore }`, and commit diffs reuse the existing
  `fileDiff` message.
- **New doc kind** `git-history` (like `web`/`review`): owns its center-pane view,
  one per repo, kept mounted like other docs.

### Invariants
- Read-only: the module spawns only non-mutating git subcommands.
- Bounded + non-throwing (the `git-info` discipline); never blocks the UI.
- Renderer stays node-free; all git work is host-side.

## Edge cases & failure modes

- **Huge/old repos:** cap to N commits + page; lane layout is O(commits·lanes) —
  bound lanes shown and degrade gracefully past a width cap.
- **Many branches:** ref badges can crowd a commit — cap visible badges with a
  "+k" overflow.
- **Unborn HEAD / zero commits:** `empty` state, not an error.
- **Detached HEAD:** HEAD marker sits on the bare commit (no branch badge).
- **Merge commits:** ≥2 parents → multiple edges; diff vs first parent (labeled).
- **Binary / renamed / deleted files** in a commit diff: rely on the existing diff
  viewer's handling.
- **Worktrees / submodules:** interrogate the active cwd's repo; `--all` covers
  linked-worktree branches via the common dir.
- **Not a repo / git missing / timeout:** dedicated states; reuse the
  `gitAvailable` latch so a git-less machine never spawns.
- **Concurrent refresh while paging:** newest interrogation wins; stale results
  dropped (guard by request id).
- **Theme switch:** lane colors come from CSS vars and recolor live.

## UI module (feature type = UI)

- **State catalog:** loading, ready, empty, not-a-repo, error, git-missing,
  loading-more, commit-selected (covered above).
- **Interaction inventory:** open from indicator button; scroll/virtualize long
  graphs; click a commit (select); click a file or "view diff"; "load more";
  keyboard up/down to move selection, Enter to open diff, Esc to clear selection;
  copy-SHA affordance.
- **Accessibility:** the commit list is a keyboard-navigable list
  (`role=listbox`/rows), selection follows focus, the graph glyphs are decorative
  (`aria-hidden`) with the textual SHA/subject as the accessible name; diff opens in
  the existing (already-accessible) viewer.
- **i18n:** commit data (messages, authors, refs) is user content rendered as-is;
  chrome strings ("History", "Load more", "View diff", "Changed files", state
  messages) go through the same literal path as existing UI.
- **Design tokens:** lanes/nodes/edges and ref badges use existing theme CSS vars
  (branch = indicator's branch color, merge/HEAD/dirty reuse the indicator's
  `--blue`/`--amber` palette) so the graph matches the app and light themes.

## Scope slicing

**MVP — Slice A:** `git-history.ts` (parseCommits + assignLanes + getHistory +
getCommitDiff); the `git-history` doc kind + center-pane graph view; the indicator
button; click commit → detail + diff (reuse); states (loading/empty/not-a-repo/
error); paging. *Verifiable:* open on this repo → graph shows `main` + branches with
the right topology; clicking a known commit shows its real diff; merge commit shows
multi-parent edges.

**v1 — Slice B:** ref/branch filter + search (by sha/message/author); copy-SHA,
"reveal commit" (open on the host's default git viewer is out — keep in-app);
virtualization for very long graphs; refresh-on-change wired to the indicator's
seams.

**Vision:** per-file history & blame; commit compare/range diff; and **mutations**
(checkout/branch/cherry-pick) — but those land with, and behind, the
branch-switcher Slice B safety model, not here. **Out of scope:** history rewriting.

## Acceptance criteria

- **WHEN** the graph opens on a repo with multiple branches, it **SHALL** render a
  node per commit placed in lanes, with edges to each commit's parents and ref
  badges on branch/tag tips, HEAD marked.
- **WHEN** a commit is selected, the view **SHALL** show its full message + changed
  files; **WHEN** a changed file (or "view diff") is chosen, the existing diff
  viewer **SHALL** open that file's diff for the commit.
- **WHEN** the active cwd is not a git repo, the view **SHALL** show the not-a-repo
  state, not an error or an empty graph.
- **WHEN** a merge commit is selected, its diff **SHALL** be computed against its
  first parent and labeled as such.
- All git interrogation **SHALL** be bounded and non-throwing; a timeout shows the
  error/retry state and never blocks the UI.

```gherkin
Scenario: Inspect a commit's diff from the graph
  Given the history graph is open on a repo
  And the graph shows commit C that changed file "src/foo.ts"
  When I click commit C
  Then I see C's author, date, full message, and "src/foo.ts" in its changed files
  When I click "src/foo.ts"
  Then the diff viewer opens showing C's changes to src/foo.ts

Scenario: Branch topology is visible
  Given a repo with branch "feature" merged into "main"
  When the history graph loads
  Then "feature" and "main" appear as labeled lanes
  And the merge commit shows edges to both parents
```

## Self-audit

Spine: problem ✓, behavior/states ✓, data/interface contract ✓, edge cases ✓,
defaults vs settings ✓ (no new user settings — read-only feature), scope slicing
✓, acceptance (EARS + Gherkin) ✓. UI module walked: state catalog ✓, interaction
inventory ✓, accessibility (keyboard list nav, decorative graph + textual accessible
name) ✓, i18n (user-content commits vs literal chrome) ✓, design tokens (lanes/badges
reuse indicator palette + theme vars) ✓. Architecture/library choice flagged as a
reversible decision, not buried. No unaddressed items.
