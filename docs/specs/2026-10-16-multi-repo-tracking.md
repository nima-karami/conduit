---
status: proposed
date: 2026-10-16
---

# Feature Spec: Multi-repo tracking that follows the work

**Tier:** FULL   **Feature type:** UI (+ host engine)
**One-line request:** A session rooted in a folder of 10–20 repos, with "ticket folders" of worktrees nested inside it and their own sessions open, tracks everything at once and slows down; make tracking performant and give the user control over (and a sensible default for) what is tracked — including search over huge trees.

Companion artifact (interactive explainer of the options, UIs and architecture): published from
this spec; link in the run notes. Research brief and code findings are summarised in §2.

## 1. Problem frame

- **Job:** "Let me run several agents in parallel across ticket folders, and have every Conduit
  window stay responsive and correct about what changed — without babysitting settings."
- **Actors:** the user (switching between a *parent* session and *ticket* sessions); agents
  editing files in 3–4 ticket folders at once; the host (watcher, repo scan, git runner).
- **Topology (the case this spec is for):**
  `workspace/` (no `.git`) → `repoA/ … repoT/` (20 repos) + `tickets/T-101/{repoA,repoF,…}`
  (git worktrees, `.git` *file*). One session at `workspace/`, one per `tickets/T-1xx/`.
- **Primary load case (user, 2026-10-16):** 3–4 ticket sessions with agents saving **concurrently
  and continuously**, usually with only the parent on screen. Focus says nothing about write
  activity: background sessions keep changing files, and the parent sees every write.
- **Success outcomes (observable):**
  1. An edit in one worktree refreshes **only the repos that changed**, once per burst,
     host-wide, no matter how many sessions overlap it.
  2. In the 36-repo topology, an agent editing continuously never leaves the Changes list more
     than ~1 s behind, and the parent session stays interactive (no refresh-after-refresh loop).
  3. A ticket session reflects `git add` / `git commit` made by its agent within one burst
     (today it can stay stale until focus or switch — §2).
  4. When a session discovers many repos, the user can see what is tracked, pause or resume any
     repo in two clicks, and the choice survives restart.
  5. Search in a non-git parent covers every repo's files (respecting `.gitignore`) instead
     of a capped walk, and can be scoped down.
- **Non-goals:** remote/network fetch policy (autofetch); repos nested *inside* repos (D13 stays);
  a cross-session "ticket" data model (vision only, §6); replacing `fs.watch`.

## 2. Behavior & states

### Current behavior

| Claim about today | How established | Measured / ASSUMED |
|---|---|---|
| A refresh of all 36 repos (status `-uall` + 2 numstats + reading untracked files) takes **~3.2 s** at 4-way concurrency; refreshing only the 4 dirty repos takes **0.55 s**; a single repo takes ~0.31 s | Synthetic topology in OS temp (20 repos × 1,500 files, 4 tickets × 4 worktrees, 5 edits + 20 untracked per worktree), shell timing of the same git commands `gitChanges` runs, git 2.42 on Win11, 2 runs each | **Measured** (git cost only, not the app) |
| `core.fsmonitor=true` + `core.untrackedCache=true` changes the 36-repo time by ~0 (3.1–3.3 s) | Same harness, after warm-up | **Measured** — process spawn, not tree walk, dominates at this repo size |
| A plain walk of the 54k-file parent takes ~0.54 s | Same harness (`find`) | **Measured** |
| Any watcher fire refreshes **every** repo in each visible owning session (`buildRepoChanges` over `s.repos`) | `electron/main.ts:2521-2539`, `src/repo-changes.ts:16` | Code-read → **ASSUMED** at runtime, S0 measures |
| The parent's repo set is its own repos **plus every ticket worktree** (scan continues into non-git ticket folders, depth 4, cap 200) | `src/repo-scan.ts:21-22,68-72` | Code-read → ASSUMED, S0 measures |
| Overlapping sessions are not deduplicated: refresh coalescing is keyed by `(path, changesRoot, sessionId)`; concurrency cap is per call, not host-wide | `electron/main.ts:2538-2539`, `src/repo-changes.ts:16` | Code-read → ASSUMED |
| Background (non-visible) sessions' git work is deferred and caught up on becoming visible. "Visible" = active/split session of each **non-minimized** window; an occluded window counts as visible. The watcher arms on **one project per window** (`projectsByWindow`), a separate notion from visibility — a split session that isn't the window's project may be unwatched | `src/session-resource-demand.ts`, `electron/session-folder-runtime.ts:119-127`, `electron/main.ts:1277-1311, 4738-4744` | Code-read → ASSUMED. Confirms the user's recollection; the catch-up exists; split-unwatched is an S0 check |
| Each repo's per-worktree git-dir `HEAD` is already watched (shared across sessions, **cap 16** per session) and drives the branch-chip path (`gitRefresher` → `interrogateGit`), separate from the Changes path (`refreshProject` → `buildRepoChanges`) | `electron/main.ts:1360-1441`, `src/repo-git-refresh.ts:6` | Code-read |
| A ticket session can stay stale after `git add`/`commit`: the worktree's `index` lives in `<main>/.git/worktrees/<wt>/` (not watched) and a commit moves `refs/heads/<b>` in the main `.git`, not `HEAD` — so neither the folder watch nor the HEAD watch fires. Past 16 repos even HEAD isn't watched | `git worktree` layout + `electron/project-watcher.ts` folder set + HEAD cap | **ASSUMED** — highest-value S0 check |
| A non-git root's quick-open/search index is a BFS walk capped at 20k files that ignores `.gitignore`, re-run `fresh` 500 ms after each burst for indexed roots | `electron/main.ts:496-503, 612`, `webview/app.tsx:2244-2263` | Code-read → ASSUMED |
| The Changes list renders un-virtualized | `webview/components/changes-view.tsx:346-354` | Code-read |
| `changesView: 'all'|'active'` only filters the view — the host computes all repos regardless | `webview/app.tsx:3388`, `src/settings.ts:67`; no host reader | Code-read |
| The watcher deliberately carries **folder indexes, never paths** ("a 10k-event burst costs nothing to hold", L12 S4) | `electron/project-watcher.ts:25` | Code-read — this spec reverses it in a bounded way (§3) |

**Root cause (stated as hypothesis until S0):** work scales with *repos in every visible owning
session* per burst, not with *repos that changed*. At 36 repos a burst costs ~3.2 s against a
300 ms throttle, so with K agents editing, the parent never goes idle.

### Prior art (research brief, sources in run notes)

VS Code: bounded auto-detect (`git.repositoryScanMaxDepth` 1, `git.autoRepositoryDetection`),
worktree detection **off** by default (`git.detectWorktrees`), sticky `git.ignoredRepositories`
via *Close Repository*, `git.statusLimit` 10k, autofetch gated on `whenIdleAndFocused`.
JetBrains: *detected ≠ registered* — an "unregistered VCS roots" notification with **Add roots /
Ignore**, greyed rows in Directory Mappings. GitKraken: named workspaces with checkbox repo
picks. Git: fsmonitor + untrackedCache (big wins on 100k+-file repos; measured no win here).
@parcel/watcher / Watchman: one watcher per root, coalesced events, **events carry paths**.

### Target model

Three ideas, layered. Each stands alone; together they are the recommendation.

1. **Engine — refresh what changed, once (invisible).** A host-wide `RepoTracker` keyed by repo
   realpath **absorbs both git paths** (Changes `gitChanges` and branch-chip `interrogateGit`).
   Each raw watcher event is mapped **on arrival** to a repo index (longest-prefix over the known
   repo roots; `<main>/.git/worktrees/<wt>/…` → worktree `<wt>`; `<main>/.git/refs/heads/<b>` →
   every worktree on branch `<b>`), so a fire holds a bounded set of repo indexes — never paths —
   keeping L12 S4's memory bound. Only dirty repos refresh, single-flight per repo, a
   **host-wide** cap of 4, results fan out to every subscribing session. For each tracked linked
   worktree the host watches its git-dir `index` + `HEAD` and the main repo's `refs/heads` (one
   shared watch per main `.git`, no 16 cap).
   **Per-repo cooldown:** while writes keep arriving, a repo refreshes at most once per 1 s, with
   a guaranteed trailing refresh after its last write — so continuous agent writes cost
   O(active repos), not O(bursts). **Background subscribers:** every snapshot lands in the
   tracker's cache for all sessions containing that repo, visible or not; a background session
   switching in renders from cache (no catch-up git) and refreshes only repos dirtied since.

   Estimated from the measured per-repo timings, 4 agents writing for 5 s with the parent on
   screen: today ≈ 1.6 full 36-repo passes, git busy ~100 %, changes visible after 3–6 s;
   engine + cooldown ≈ 60 git processes, git busy ~55 %, changes visible in < ~1 s. S0 measures
   both in the real app.
2. **Tracked set — detected ≠ tracked (explicit control).** Each session has per-repo tracking
   state `tracked | paused`. Home repo and attached roots are always tracked. Nested repos are
   tracked by default **up to a threshold (8)**; past it, the rest start *paused* and a one-time
   banner says so. Paused repos are listed (name, branch, "paused"), cost nothing, and refresh
   once on expand or on Resume.
3. **Attention tiers (adaptive).** Among tracked repos: **hot** = contains the focused tab, the
   agent's cwd, or a file changed in the last 10 min → refreshed per burst; **warm** = every other
   tracked repo → coalesced to at most one refresh per 5 s and computed as *counts only* while
   the Changes tab is hidden. A paused repo that gets an edit shows an "activity" dot and an
   inline **Track** — it is never auto-resumed (the user's choice holds).
   Tier inputs: focused-tab path from the renderer (`repo:attention`); agent cwd from the host's
   existing session-cwd tracking; recent change from the tracker's own fire history.

**Union rule (overlapping sessions).** Tracking is per session home, git work is per repo: a repo
runs git iff **some visible session tracks it** (warm cadence applies only then; nothing runs for
repos tracked only by non-visible sessions). A session where that repo is paused still shows it
paused, but with the shared snapshot labelled "tracked by T-101 · as of 12:04" — current data is
fine to show because it costs nothing extra. *Refresh once* on a paused row is an explicit,
one-shot user action and the only exception to "no git while paused".

**Initial pick past the threshold:** rank nested repos by the mtime of their git-dir `index`
(cheap stat, available on first scan), then by name; home and attached repos don't count toward
the limit.

**Search** follows the tracked set: in a non-git root the index is the union of tracked repos'
`git ls-files --cached --others --exclude-standard` plus loose files outside repos; a scope
chip offers **Tracked repos** (default) · **This repo** · **Everything** (the old walk, capped).

### States (per repo, per session)

`detected` → (`tracked` ⇄ `paused`); tracked repos are `hot` ⇄ `warm`;
any repo → `missing` (folder vanished) → `detected` on reappearance; refresh outcomes
`fresh | refreshing | stale(since) | error(reason)`. Per-session: `scanning`, `over-threshold`
(banner shown once).

## 3. Data / interface contract

- **Persisted (userData `repo-tracking.json`, keyed by session home realpath → repo realpath):**
  `{ v: 1, homes: { [home]: { paused: string[], tracked: string[] } } }`. Only explicit user
  choices are stored; defaults are recomputed. Survives session close/reopen of the same home.
- **Host → renderer:** `repoChanges` becomes incremental: `{ type:'repoDelta', sessionId,
  repos: { [root]: RepoSnapshot | {removed:true} } }` where `RepoSnapshot = { tracking, tier,
  state, counts:{staged,unstaged,untracked}, changes?: ChangeDTO[] , refreshedAt }`.
  `changes` is present only while some window has demand: the Changes tab, Review, or a diff tab
  for a file in that repo open (ref-counted per window; two windows = two refs). Consumers
  (`changes-view`, `review-navigator`, `review-view`, `center-pane`, `right-pane`, `app.tsx`)
  render counts + a row skeleton while `changes` is absent and demand has just been raised.
  Host and renderer ship in one build, so `repoChanges` → `repoDelta` needs no wire migration.
- **`changesView` setting:** unchanged — stays a pure view filter, independent of tracking.
- **Index/LSP roots:** the non-git search index and the TS source index cover tracked repos +
  loose files; go-to-definition's on-demand `resolveModule` still reaches paused repos.
- **Renderer → host:** `repo:setTracking {sessionId, root, tracking}`, `repo:refresh {root}`,
  `changes:subscribe {sessionId, detail: boolean}`.
- **Invariants:** at most one in-flight `gitChanges` per repo host-wide; a repo absent from every
  visible session's tracked set runs no git; `RepoSnapshot.counts` and `changes` come from the
  same git run; a paused repo's last snapshot is shown with its `refreshedAt`, never as current.
- **Errors:** git timeout/failure → `state:'error'` with the `GitResult` reason, last good
  snapshot kept, retried on next fire; tracking-file parse error → defaults + one log line.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| fs fire → dirty repos | `ProjectWatcher` (must carry paths + worktree git-dirs) | `RepoTracker` | yes |
| repo snapshots | `RepoTracker` (`gitChanges`, `interrogateGit`) | Changes tab, Review navigator, repo picker, branch chip, diff tabs re-read | yes |
| tracked/paused set | Changes tab menu, banner, palette, Settings | `RepoTracker` subscription, search index, LSP/TS index root set | yes |
| visibility / panel demand | renderer (`changes:subscribe`, `visibleSessions`) | `RepoTracker` tiering, detail gating | yes |
| file index for non-git roots | `projectFileIndexMeta` | quick-open, Ctrl+Shift+F, TS index | yes |
| tier inputs (focused path, cwd) | renderer `repo:attention`; host session cwd | `RepoTracker` tiering | yes |
| `fsChanged` broadcasts | watcher | Explorer re-read, TS incremental index | Explorer: **no** — unchanged, safe because it reads only expanded dirs. TS incremental index: **yes, MVP** — invalidated by dirty repo, no fresh 20k re-walk |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Parent and ticket sessions both visible, same worktree | One git run; both sessions get the snapshot (same `refreshedAt`) |
| Burst touches 0 repos (loose file in parent) | No git runs; Explorer/search invalidation only |
| 1 repo, 0 nested | Identical to today: no banner, no tracking UI beyond the menu item |
| > threshold nested repos | First 8 by recent activity (then name) tracked; rest paused; banner once per home |
| Scan cap (200) hit | Unchanged from today (first 200 found are used). Idle repos cost one watch and no git; first snapshots fill progressively (home/attached first, then by git-dir `index` mtime) |
| Worktree whose main repo is outside every root | Its git-dir is watched by absolute path (HEAD + index only); if the path is unreachable, falls back to refresh on focus |
| Branch checkout / `npm install` storm | Coalesced per repo; `node_modules` already filtered; one refresh per repo per burst |
| Paused repo edited by an agent | Activity dot + "Track" action; no git run until the user acts |
| User pauses the home repo | Not offered — home and attached roots are always tracked (menu item disabled with reason) |
| Home is itself a repo with nested repos | Home tracked; nested follow the threshold as usual |
| Attached root added/removed mid-session | Rescan; new root's repo tracked; removed root's repos drop from the session (choices kept on disk) |
| Symlinked / junctioned home | Keyed by realpath; the same folder via two paths shares choices |
| Repo deleted / worktree pruned | `missing` with **Remove**; no auto-expiry (nothing to persist a clock for) |
| Same repo paused in parent, tracked in ticket | Union rule (§2): runs while the ticket session is visible; parent row shows "tracked by T-101" |
| Two windows toggle the same repo | Last write wins; both update via `repoDelta` |
| git hangs | Existing `GIT_TIMEOUT` → `error`, snapshot kept, other repos unaffected |
| Tracking file corrupt | Defaults; file rewritten on next user choice |
| Tracking file write fails | Choice applies for this run; toast "Couldn't save tracking choice — it will reset on restart" |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Engine (dirty-repo refresh, shared tracker) | on | no | Pure efficiency, no behaviour to prefer |
| Per-repo refresh cooldown under continuous writes | 1 s + trailing refresh | no | Bounds git to active repos; < 1 s staleness |
| Snapshots for background sessions | cached, no git of their own | no | Instant, correct view on switch |
| Repo count limit | **keep `REPO_SCAN_CAP` = 200** and depth 4 as today | no | User, 2026-10-16: don't raise it until a stress test proves the engine performs at 200; the S0/S-final stress lane includes a 200-repo scenario |
| Worktree git-dir watching | on for tracked worktrees | no | Fixes stale ticket sessions |
| Warm-tier cadence | 5 s | no (v1) | Keeps cold repos honest without per-burst cost |
| Hot window | 10 min since last change | no | Matches an agent's working stretch |
| Detail gating when Changes hidden | on | no | Line counts nobody looks at are pure waste |
| Search scope in non-git root | Tracked repos | per-search chip, remembered per session | Fast and gitignore-aware |
| fsmonitor | off | out of scope v1 | Measured no gain at this size |

## 6. Scope slicing

- **S0 (measure first):** a stress scenario reproducing the topology in the real app
  (`npm run test:stress`): count git processes and main-thread lag per burst with parent+ticket
  visible; confirm the stale-ticket claim. Gate for everything below — if a claim in §2 measures
  false, re-spec that part.
- **MVP (must):** Engine (fires mapped to repo indexes → dirty-repo refresh, host-wide
  `RepoTracker` single-flight + cap absorbing `interrogateGit`, worktree `index`/`refs` watch,
  incremental `repoDelta`); detail gating; TS incremental index invalidated by dirty repo.
  Plus per-repo cooldown, cached snapshots for background sessions, progressive initial fill.
  Repo cap stays 200.
- **Stress lane (must, user 2026-10-16):** scenarios in `npm run test:stress` for (a) the
  4-agent ticket topology and (b) 200 repos at the cap with 4 writers, run before (baseline)
  and after the engine; structural invariants gate, timings recorded in the run report.
- **v1 (should):** search scope chip + union index.
- **Parked (user, 2026-10-16 — "not sure how effective"):** tracked set (threshold, banner,
  Pause/Track, Settings, persistence, union rule) and hot/warm tiers. Build only if S0 re-run
  after the MVP shows, in the 4-agent scenario, p95 lag > 1 s or git busy > 70 %. §8–§11 rows
  for these surfaces stay as the ready design, **minus the auto-track limit**: if revived,
  everything is tracked by default and pausing is manual only (user, 2026-10-16).
- **Vision (could):** "Ticket" awareness — a nested folder that is another session's home shows
  as one collapsed group in the parent ("T-101 · 4 repos · open session"); named repo sets
  (GitKraken-style) reusable across sessions.
- **Out of scope:** autofetch, nested-in-repo detection, fsmonitor, a custom watcher.

## 7. Acceptance criteria

EARS:
- When a burst of file changes lands under one repo, the host shall run git only for that repo,
  once, regardless of how many visible sessions include it.
- While no window shows a session's Changes or Review, the host shall not line-count untracked
  files for that session's repos.
- When a tracked linked worktree's index, HEAD or branch ref changes, the owning sessions shall
  receive an updated snapshot within one watcher throttle window (300 ms) plus that repo's git time.
- While a tracked repo is warm and a session tracking it is visible, the host shall refresh it at
  most once per 5 s; while no session tracking it is visible, not at all.
- Lag is measured in the S0 stress scenario as (snapshot `refreshedAt` − last fs event time),
  p95 ≤ 1 s with 4 agents editing in the 36-repo topology.
- When a session's scan finds more nested repos than the auto-track limit, the session shall track
  the limit's worth, pause the rest, and show the over-threshold banner once per home.
- While a repo is paused in every visible session that contains it, the host shall run no git
  commands for it, except one run per explicit *Refresh once*.
- If a paused repo receives file changes, then the Changes tab shall mark it with an activity
  indicator and offer Track, without resuming it.
- Where the root is not a git repo, quick-open and content search shall use the tracked repos'
  git listings by default and honour `.gitignore` (fixture: a repo whose `.gitignore`d `dist/`
  holds a matching string returns no `dist/` hit under Tracked repos, and one under Everything).

```gherkin
Feature: Ticket work stays fast
  Background:
    Given a parent session over 20 repos and 4 ticket folders of worktrees
    And a ticket session for T-101 is visible beside the parent

  Scenario: One agent edit refreshes one repo once
    When an agent saves a file in tickets/T-101/repoA
    Then exactly one git status runs, for tickets/T-101/repoA
    And both sessions show the change within 1 second

  Scenario: A commit inside a ticket is seen
    When the T-101 agent runs git commit in repoA
    Then the T-101 Changes list drops the committed files without a focus change

  Scenario: Pausing a repo stops its work
    Given the parent (no home repo, no attached roots) tracks 8 of 36 repos, 28 paused
    When the user pauses repoC
    Then no git process runs for repoC on later edits
    And repoC stays listed as Paused after restart
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Changes repo header | tracked·hot / warm | Name, branch chip, counts; warm shows nothing extra | Menu: Pause tracking |
| | paused | Dimmed name, "Paused" pill, last-known counts greyed with "as of 12:04" | Track (inline), Refresh once |
| | paused + activity | Paused pill + accent dot "changed since paused" | Track |
| | paused, tracked elsewhere | Paused pill + live counts "tracked by T-101 · as of 12:04" | Track |
| Changes tab | scanning | Existing repo headers stay; "Looking for repositories…" line under the last header | — |
| Pause all nested | done | Toast "Paused 28 repositories" | Undo |
| | refreshing | Counts kept, thin progress under header (no spinner swap) | — |
| | error | "Couldn't read git status — timed out" inline | Retry |
| | missing | "Folder not found" | Remove |
| Over-threshold banner | shown | "Found 36 repositories. Tracking 8 that changed most recently." | Choose repositories… · Track all · Dismiss |
| Repo picker sheet | populated | Checklist grouped Home / Attached / Nested (ticket folders as sub-groups), search box, counts "8 of 36 tracked" | Done · Track all · Pause all nested |
| | empty filter | "No repositories match 'xyz'" | Clear |
| Changes tab (none tracked) | blank | "All 36 repositories are paused." | Choose repositories… |
| Search scope chip | default / narrowed | "Tracked repos ▾" / "repoA ▾" / "Everything ▾ (may be slow)" | Change scope |
| Settings → Git | list | Auto-track limit field; per-home list of paused repos | Edit, Resume |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Repo header | pause/track/refresh | click Track; ⋯ menu | Enter on header toggles collapse; Shift+F10 menu | n/a (desktop) | Pause tracking · Track · Refresh now · Reveal | `button` + `aria-expanded`; pill text, not colour |
| Banner | choose/track all/dismiss | click | Tab order; Esc dismisses | n/a | — | `role="status"` |
| Picker sheet | toggle, filter, bulk | click rows, group checkbox | ↑↓ move, Space toggle, Ctrl+A all **only while the list has focus** (the filter box keeps native select-all), Esc closes the sheet (topmost-only via `ModalLayer`) | n/a | — | `ModalLayer`, `role="dialog"`, rows `checkbox`, group tri-state `aria-checked="mixed"`; virtualized past 100 rows |
| Scope chip | change scope | click → `Popover` menu | Enter/↓ opens, arrows, Enter picks | n/a | — | `menu`/`menuitemradio` |
| Palette | "Git: Choose Tracked Repositories…", "Git: Pause/Track Repository" | — | palette | — | — | — |

## 10. Accessibility & i18n (UI)

- Every action keyboard-reachable (table above); focus returns to the repo header after the
  picker closes; after Pause/Track focus stays on the same row's toggle (rows never re-sort on
  toggle). Picker sorts with locale collation (`Intl.Collator`). Paused/hot/activity states always carry text or an icon with an accessible name,
  never colour alone; dimmed paused rows still meet 4.5:1 for the name.
- Live region (existing Changes live region) announces "repoC paused", "Tracking 8 of 36
  repositories", refresh errors. No state is conveyed only by animation; progress line honours
  `prefers-reduced-motion` (static).
- Strings go through the existing string tables; counts use the plural helper (`countNoun`);
  "as of" times use locale time formatting; labels tolerate +30 % (pill truncates the repo name,
  never the state word). RTL: layout mirrors; no directional semantics.

## 11. Design tokens (UI)

Existing roles only: `--text-dim` for paused names, `--accent` for the activity dot, existing tag
pill (`.treehead` tag) for Paused, `--warn` family for error, `--layer-*` for the picker. All three
themes (Default, Paper, Neon) checked via `npm run shots`.

## 12. Assumptions

- Threshold 8 and hot window 10 min are starting values, tuned after S0.
- Ticket folders are plain folders of linked worktrees (no `.git` of their own).
- Persisting by home realpath (not session id) is right: the user reopens the same ticket folder
  as new sessions.
- Explorer behaviour is unchanged; only git and indexing work is re-scoped.

## 13. Decisions Needed

- **Decided (user, 2026-10-16):** shared engine first; tracked set parked pending S0 after MVP.
  The two former `high` items (what happens past the threshold; auto-resume on activity) are
  parked with it.
- **[normal]** Cooldown length: 1 s (spec) vs 0.5 s (fresher, ~2× git) vs 2 s (cheaper).
- **[normal]** Parent sessions and ticket folders: show worktrees inside a folder that is another
  session's home as normal repos (spec MVP) vs collapse them into a ticket group (vision).
- **[normal]** Search default in a non-git root: Tracked repos (spec) vs Everything.
- **[normal]** The watcher change reverses L12 S4 ("never paths") in a bounded form (repo
  indexes on arrival). Default taken: do it; architecture-critic reviews the plan before build.
- **[normal]** All §2 rows marked ASSUMED (incl. split-session unwatched) are verified in S0
  before MVP build starts.
