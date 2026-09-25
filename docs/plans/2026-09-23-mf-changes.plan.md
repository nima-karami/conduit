# mf-changes — implementation plan

**Spec:** `docs/specs/archive/2026-09-23-mf-changes.md`  **Tier:** FULL

Tier reason: new host→renderer contract (`RepoChanges`, `Session.repoGit`) that mf-review and
mf-files consume, host fan-out, settings migration, five renderer surfaces and ~35 e2e files.

## Goal

Git leaves the terminal tab row and lives, per repo, in the Changes tab (All repos / Active repo
views, repo heads with a branch chip whose menu holds View history and the branch switcher), and
History shows one chosen repo at a time — every action (stage, discard, hunk, diff, switch,
history, commit diff) targets the repo its control belongs to.

## Architecture

The host stays the git source of truth: `runGitRefresh` interrogates every detected repo into
`Session.repoGit` (replaces `Session.git`), and `sendProject` fans `gitChanges` out per repo into
`project.repoChanges`. Everything that decides something is pure and renderer-safe in `src/`
(display order, labels, view model, chip model) or a small extracted webview module (History
reducer), and the components only render those models. The tab-row band stays alive through
Slice 5 so every slice keeps the existing e2e suite green; Slice 6 deletes it and migrates the e2e
entry points in the same slice.

## Data flow

```
host                                                                    renderer
────                                                                    ────────
mf-model scan (onFoldersChanged / requestProject)
  └ mgr.setRepos(id, repos) ──changed?──► scheduleGitRefresh(id)
runGitRefresh(id): orderRepos(s.repos, s.roots)
  └ interrogateRepos(roots, interrogateGit, 4) ──► mgr.setRepoGit(id, map) ──state──► session.repoGit
  └ syncHeadWatches(id, first 16 headPaths)  (HEAD change → scheduleGitRefresh)       ├ BranchChip (per head)
                                                                                      ├ session-icon / session-card
requestProject {path, changesRoot, sessionId} ◄──────────── app.tsx (deps: home, cwd, activeRepoRoot, repoSetKey(repos))
sendProject: getProjectInfo(p, changesRoot) → changes
  └ buildRepoChanges(orderRepos(s.repos), …, gitChanges, 4) ──project{…, repoChanges}──► acceptRepoChanges(prev, in, s.repos)
                                                                                        └ changesModel(session, repoChanges, settings.changesView)
                                                                                           ├ RightPane badge
                                                                                           └ ChangesView → RepoHead(s) → ChangeRow(s)
ChangeRow / head menu / header ··· ──GitActionIntent{op,path?,repoRoot?|repoRoots?}──► app onGitAction → runGit / runGitFanOut
  └ ipc git-action {root} (writeRoots containment, unchanged)                            └ refreshChanges + rereadOpenDiffs(root)
BranchChip menu ──git:refs/switch {sessionId, repoRoot}──► mf-model handlers (requestGitRoot) ──result{…, repoRoot}──► chip
                 └ View history → openGitHistoryTab(root) → docs 'open' {repoRoot}
GitHistoryView(repoRoot) ──git:history {repoRoot}──► host;  CommitView ──git:commitDiff {root}──► host (validated here, D22)
```

## Settled decisions — do not re-litigate

- `.autoloop/locked.md` L1–L12 are the frame; spec §13 D1–D22 accepted as picked, except where
  L11 overrides D9 (below).
- **L11 (overrides D9 and §4's discard confirm):** in the All-repos view the header `···` offers
  `Stage all` / `Unstage all` fanned out across repos; `Stash changes`, `Pop stash` and
  `Discard all changes` are listed **disabled** with the title
  `Works on one repo. Right-click a repo header, or switch to Active repo.`; all three are available
  per repo (repo-head context menu, and the Active view's `···`). The cross-repo discard confirm is
  not built.
- **D14 accepted:** tokens `--accent`, `--accent-soft`, `--amber`, `--danger`, `--green`, `--red`,
  `--text-dim`, `--text-faint`. No `--ok/--warn/--bad`, no aliases, no hex.
- **L12:** `repoRoot` on `git:history/refs/switch` (validation + echo) is mf-model's;
  `git:rangeDiff`/`git:resolveRange` `repoRoot` is mf-review's; one Changes refresh per watcher fire
  (B3) — this item adds no per-folder refresh; folder lifecycle has one host hook
  `onFoldersChanged(sessionId)` (S1) — this item adds no new folder-lifecycle site.
- Shapes pinned for downstream (mf-review, mf-files) — byte-exact:
  `RepoChanges`, `project.repoChanges?`, `GitActionIntent.repoRoot?`, `HunkActionHost.rootFor`.
- D1 `changesView` default `'all'`; D3/D4 settings retired; D6 clean tree keeps heads; D8 `repoGit`
  replaces `git`, HEAD watch cap 16; D10 one reply, concurrency 4; D11 failed status reads clean;
  D15 All view posts `repo:unpin`; D16 retarget keeps query; D20 `repoChanges` in both views; D21
  ASCII `-`; D22 `git:commitDiff.root` validated here.

## Spec staleness

- §2.5 "a restored doc whose `repoRoot` is no longer detected": History docs are never persisted
  (`src/persistence.ts:69-70` keeps only `file`/`diff`). The fallback applies to an open History
  whose repo leaves `session.repos`; nothing is persisted.
- §2.3 "the host stores `{kind:'none'}` for the repo instead of dropping it": today it drops
  (`electron/main.ts:1219` `result.info.kind === 'none' ? undefined`). This plan changes it: a
  failed interrogation is stored as `{ kind: 'none' }` in `repoGit`.
- §3 "`gitOf(session, root)` in `src/active-cwd.ts` or `src/repo-git.ts`": placed in
  `src/repo-git.ts`.
- §2.5 History fingerprint "keys on `repoGit[repoRoot]`'s fingerprint": `GitInfo` has no
  fingerprint field (`src/types.ts:18-30`); the view builds one at
  `webview/components/git-history-view.tsx:358`. That builder moves to `repoGitFingerprint`.
- §11 "Review button: the existing solid/primary class": the class is `.btn.btn--primary`
  (`webview/styles.css:4466`); there is no `--solid`.
- §9 header `View` "radio pair": `ContextMenu` has no radio role today (`checked` →
  `menuitemcheckbox`, `webview/components/context-menu.tsx:138`); Slice 4 adds `MenuItem.radio`.
- §7.4 "unit `git-switch` (repoRoot)": `src/git-switch.ts` (`decideSwitch`, `isKnownRef`) takes no
  root and needs none; the renderer side of `repoRoot` is covered by `test/unit/branch-chip.test.ts`
  and `branch-switch.e2e.mjs`. `test/unit/git-switch.test.ts` is unchanged.
- §7.4 "`coerce-settings` update": `test/unit/coerce-settings.test.ts` has no git assertions today
  (measured); the AC10 tests are new there.
- §2.7 D19 ASSUMED rows, measured by source read during planning, all true: host `git:history`
  `:2282`, `git:refs` `:2627`, `git:switch` `:2649` use `gitRoot(session)`; renderer `runGit`
  (`webview/app.tsx:2452`), row diff-open (`:3415`) and the hunk host (`:1421`) use
  `gitRootForSession(active)`; `git:commitDiff` uses `m.root ?? gitRoot(session)` (`:2331`).
- The tasks.yaml `−` (U+2212) in the header: D21 keeps ASCII `-`.
- mf-model is being revised (L12). Its revised plan may move `scheduleRepoScan` and the
  `multiRepoPicker` gate out of `electron/main.ts` into its folder-lifecycle module. Every step
  below that edits "the repo-scan site" means wherever `mgr.setRepos` is called after mf-model lands.

## mf-model exports this plan depends on (builder confirms each exists after mf-model lands)

| Export | Where (mf-model plan) | Used by |
|---|---|---|
| `Session.home: string`, `Session.roots: string[]`, `Session.missingRoots?` | `src/types.ts` | everywhere `projectPath` was |
| `RepoInfo { root; name; folder; tag }`, `RepoTag = 'home'\|'nested'\|'attached'` | `src/repo-scan.ts` | S1+ |
| `folderKey(p: string): string` | `src/folder-key.ts` (renderer-safe) | `repoSetKey`, `orderRepos`, `historyRepoFor`, commitDiff check |
| `requestGitRoot(s, repoRoot: unknown): string \| null` | `src/active-repo.ts` | S5 commitDiff validation |
| `SessionManager.setRepos` comparing `root`/`tag`/`folder` | `src/session-manager.ts` | S1 (made to return `boolean`) |
| `requestProject.sessionId?` + `sendProject(dispatch, p, changesRoot?, sessionId?)`; renderer posts carry `sessionId` | `src/protocol.ts`, `electron/main.ts`, `webview/app.tsx` | S3 |
| `repoRoot?` on `git:history`, `git:refs`, `git:switch` and echoed on their results; `git:refsResult.error?`; failure shapes (`state:'error'`; `branches:[]…error:'unknown repo'`; `ok:false, reason:'failed', message:'unknown repo'`) | `src/protocol.ts`, `electron/main.ts` | S5, S6 |
| `openRepo.roots?: string[]` | `src/protocol.ts` | e2e `openSession({roots})` |
| `onFoldersChanged(sessionId)` host hook (L12 S1) triggering the rescan | mf-model folder-lifecycle module | unchanged; the rescan's `setRepos` result drives S1's refresh |
| `writeRoots()` includes every `s.roots` entry | `electron/main.ts` | `git-action` containment for attached repos (unchanged code) |

If one is missing or differently named, the deviation rule applies — the task stops; no local copy.

## Global constraints

- Gate: `npm run verify` (biome check, both tsconfigs, build, vitest, fallow, audit, security).
  Never weaken, skip, narrow or defer a check. Read its exit code directly; never pipe it through
  `tail`.
- `npm run typecheck` runs both tsconfigs. Renderer-safe (no runtime `node:*`, no `src/git-exec.ts`
  import): `src/repo-display.ts`, `src/repo-git.ts`, `src/changes-view-model.ts`,
  `src/branch-chip.ts`. Host-only: `src/repo-git-refresh.ts`, `src/repo-changes.ts`.
- Unit tests never depend on `process.platform` or platform `path`: CI is ubuntu. Paths in tests
  are strings with explicit forward slashes (and one `C:/`-style case where keys fold).
- Naming: kebab-case `.ts`/`.tsx`; components PascalCase exports; tests
  `test/unit/<module>.test.ts`; e2e `test/e2e/<name>.e2e.mjs` on `test/e2e/harness.mjs`
  (`runScenario`, `launchApp`, `closeApp`, `openSession`, `tapBridge`, `assert`), run hidden and
  serially: `node test/e2e/run-smoke.mjs <name>` after `npm run build`. A new scenario needs no
  registration (the runner globs `test/e2e/*.e2e.mjs`).
- Every new export has a production importer by the end of its slice (fallow). Test-only helpers
  stay module-private and are tested through their public caller.
- Comments: WHY only; point at the spec (`// see docs/specs/archive/2026-09-23-mf-changes.md §2.3`), never
  restate it.
- All user copy in `STR` objects in the component that renders it. Plurals as §10.
- Git only through `runGit`/`runGitBin`; this plan adds no spawn path (fan-out reuses
  `gitChanges`, `interrogateGit`).
- CSS: tokens only; reuse `.btn--primary`, `.iconbtn`, `.ctxmenu__item`, the `files__bar` family;
  anything painted over `.topbar` needs `-webkit-app-region: no-drag` (`.popover` already declares
  it, `webview/styles.css:1089`). Floating chrome over Monaco clears Monaco's own z-indices.
- Virtualized/mapped rows: rows are direct keyed children (`flatMap`, never `[row, extra]`).
- E2E cadence: related units while building; the slice's listed e2e before the slice closes; the
  full suite once at the end (Slice 7). Re-run a PTY-echo failure alone on a quiet machine before
  believing it; never kill processes by name.

## Out of scope

Review grouping/chip/progress and `repoRoot` on `git:rangeDiff`/`git:resolveRange` (mf-review);
Files tab and its `No session` copy (mf-files); sidebar card restyle (mf-sidebar); repo detection
changes (D13); per-repo error state + Retry, lazy-load, persisted collapse (v1); `git-action`
confinement; `electron/preview-protocol.ts`.

## Contracts

### `src/types.ts`
```ts
export interface Session {
  // …mf-model fields unchanged; REMOVED: git?: GitInfo
  /** Runtime-only (stripped by serializeSessions). Keyed by RepoInfo.root exactly as in `repos`.
   *  A failed interrogation is stored as { kind: 'none' }. Absent until the first refresh. */
  repoGit?: Record<string, GitInfo>;
}
```

### `src/protocol.ts`
```ts
import type { RepoTag } from './repo-scan';
export interface RepoChanges {
  root: string;            // == a session.repos[].root, byte-equal
  name: string;            // basename(root)
  tag: RepoTag;
  sub?: string;            // `${basename(folder)}/${root relative to folder}` when folderKey(root) !== folderKey(folder)
  branch?: string;         // repoGit[root].branch when kind === 'branch'
  changes: ChangeDTO[];    // paths relative to root
}
// host → renderer, `project` gains:
  repoChanges?: RepoChanges[];   // present iff the request carried sessionId AND that session's repos are scanned; display order
```

### `src/settings.ts`
```ts
export type ChangesViewMode = 'all' | 'active';
// AppSettings: − showGitIndicator, − multiRepoPicker, + changesView: ChangesViewMode   (default 'all')
// coerceSettings: changesView = oneOf(payload.changesView, CHANGES_VIEWS,
//   payload.changesView === undefined && payload.multiRepoPicker === false ? 'active' : DEFAULT_SETTINGS.changesView)
// module-private: const CHANGES_VIEWS: ChangesViewMode[] = ['all', 'active'];
```

### `src/repo-display.ts` (renderer-safe)
```ts
import type { RepoInfo } from './repo-scan';
/** home → nested (root localeCompare) → attached grouped by folder in `roots` order (folderKey match),
 *  root localeCompare within a folder; a repo whose folder matches nothing sorts last by root. Pure, copies. */
export function orderRepos(repos: readonly RepoInfo[], roots: readonly string[]): RepoInfo[];
/** Order-insensitive identity of a repo set: sorted folderKey(root) joined by '\n'. '' for []. */
export function repoSetKey(repos: readonly { root: string }[]): string;
/** Last non-empty segment of a / or \ path. */
export function repoBaseName(p: string): string;                                             // Slice 3
/** `${repoBaseName(folder)}/${rel}` when root sits below folder (by folderKey), else undefined. */
export function repoSub(repo: Pick<RepoInfo, 'root' | 'folder'>): string | undefined;         // Slice 3
/** repoBaseName(root); an ATTACHED repo whose basename collides with another repo in `all`
 *  gets ` — ${repoBaseName(parent of root)}`. */
export function repoLabel(repo: RepoInfo, all: readonly RepoInfo[]): string;                  // Slice 4
/** doc repoRoot if it is a root of s.repos (folderKey) → that root; else s.activeRepoRoot; else
 *  orderRepos(s.repos, s.roots)[0]?.root; else undefined. */
export function historyRepoFor(
  docRepoRoot: string | undefined,
  s: Pick<Session, 'repos' | 'roots' | 'activeRepoRoot'> | undefined,
): string | undefined;                                                                        // Slice 5
```

### `src/repo-git.ts` (renderer-safe)
```ts
export function gitOf(s: Pick<Session, 'repoGit' | 'activeRepoRoot'>, root: string | undefined = s.activeRepoRoot): GitInfo | undefined;
export function anyRepoDirty(s: Pick<Session, 'repoGit'>): boolean;          // some value .dirty === true
export function dirtyFileCount(s: Pick<Session, 'repoGit'>): number;          // Σ dirtyFiles ?? 0
/** `${kind}|${branch}|${sha}|${dirty?'d':''}|${operation}` — '' for undefined. */
export function repoGitFingerprint(g: GitInfo | undefined): string;
```

### `src/repo-git-refresh.ts` (host-only)
```ts
import type { GitInterrogation } from './git-info';
export const HEAD_WATCH_CAP = 16;
export interface RepoInterrogation { root: string; info: GitInfo; headPath?: string }
/** mapWithConcurrency(roots, limit, …); a thrown interrogate → { root, info: { kind: 'none' } }. Input order kept. */
export function interrogateRepos(
  roots: readonly string[],
  interrogate: (root: string) => Promise<GitInterrogation>,
  limit?: number,   // 4
): Promise<RepoInterrogation[]>;
```

### `src/repo-changes.ts` (host-only)
```ts
export async function buildRepoChanges(input: {
  repos: readonly RepoInfo[];                         // already orderRepos'd
  activeRoot: string | undefined;                     // the changesRoot `activeChanges` was computed for
  activeChanges: ChangeDTO[];
  repoGit: Readonly<Record<string, GitInfo>> | undefined;
  changesFor: (root: string) => Promise<ChangeDTO[]>; // host: gitChanges from src/project-info.ts
  limit?: number;                                     // 4
}): Promise<RepoChanges[]>;
```
The repo whose `folderKey(root) === folderKey(activeRoot)` reuses `activeChanges` (no second
`changesFor`). `changesFor` rejecting → `changes: []` (D11). Output order = input order.

`src/project-info.ts`: `gitChanges(cwd: string): Promise<ChangeDTO[]>` becomes exported (unchanged body).

### `src/changes-view-model.ts` (renderer-safe)
```ts
export interface RepoHeadModel {
  repo: RepoInfo;
  label: string;                     // repoLabel(repo, repos)
  sub?: string;                      // repoSub(repo)
  changes: ChangeDTO[] | undefined;  // undefined = this repo's first result not in yet
  staged: ChangeDTO[];               // [] while loading
  unstaged: ChangeDTO[];
}
export type ChangesModel =
  | { kind: 'no-session' }
  | { kind: 'detecting' }            // session.repos === undefined
  | { kind: 'no-repos' }             // session.repos.length === 0
  | {
      kind: 'ready';
      view: ChangesViewMode;
      heads: RepoHeadModel[];        // all: every repo, display order; active: exactly the active repo
      repos: RepoInfo[];             // every repo, display order (picker rows, repo count)
      activeRoot: string;            // session.activeRepoRoot ?? repos[0].root
      pinned: boolean;               // session.repoPinned === true
      count: number; added: number; removed: number;   // over heads with loaded changes
      loading: boolean;              // some head has changes === undefined
      allClean: boolean;             // !loading && count === 0
    };
export function changesModel(input: {
  session: Pick<Session, 'repos' | 'roots' | 'activeRepoRoot' | 'repoPinned'> | undefined;
  repoChanges: readonly RepoChanges[] | undefined;
  view: ChangesViewMode;
}): ChangesModel;                                                    // Slice 4
/** incoming adopted iff defined and repoSetKey(incoming) === repoSetKey(repos ?? []) with repos defined; else prev. */
export function acceptRepoChanges(
  prev: RepoChanges[] | undefined,
  incoming: RepoChanges[] | undefined,
  repos: readonly RepoInfo[] | undefined,
): RepoChanges[] | undefined;                                        // Slice 3
```
Lookup of a head's changes is by `folderKey(root)`.

### `webview/git-intent.ts`
```ts
export type IntentOp = GitOp | 'discardAll';
export type GitActionIntent = { op: IntentOp; path?: string; repoRoot?: string; repoRoots?: string[] };
// repoRoots (fan-out) and repoRoot are exclusive; repoRoots only with op 'stageAll' | 'unstageAll'.
```

### `webview/changes-actions.ts`
```ts
export type BulkScope =
  | { kind: 'repo'; repoRoot: string }
  | { kind: 'all'; stageRoots: string[]; unstageRoots: string[] };   // roots with ≥1 unstaged / staged change
export function buildBulkMenuItems(
  staged: ChangeDTO[], unstaged: ChangeDTO[],
  onAction: (intent: GitActionIntent) => void, close: () => void, scope: BulkScope,
): MenuItem[];
// repo: today's five items, each intent carrying repoRoot.
// all: Stage all {op:'stageAll', repoRoots: stageRoots} (disabled when empty, title `Stage every changed file in N repos`),
//      Unstage all {op:'unstageAll', repoRoots: unstageRoots} (title `Unstage every staged file in N repos`),
//      Stash changes / Pop stash / Discard all changes: disabled, title STR.perRepoOnly (L11 copy above).
```

### `webview/hunk-actions.ts`
```ts
export interface HunkActionHost {
  /** Repo root owning absPath; '' when none (the op is a no-op). */
  rootFor(absPath: string): string;
  stagedPaths: ReadonlySet<string>;     // folded absolute paths, union over every repo's RepoChanges
  conflictedPaths: ReadonlySet<string>;
  confirmDiscard(state: Omit<ConfirmState, 'onConfirm'>): Promise<boolean>;
  refreshChanges(): void;
  invalidateDiff(absPath: string): void;
}
```
`applyHunkAction`: `const root = host?.rootFor(req.absPath) ?? ''`; `!root` → `{ kind: 'noHost' }`;
the `GitActionRequest.root` is that `root`.

### `webview/components/context-menu.tsx`
`MenuItem` gains `radio?: boolean`: with `checked !== undefined`, `role="menuitemradio"` instead of
`menuitemcheckbox`; `aria-checked` unchanged.

### `webview/docs.ts`
```ts
export interface OpenDoc { /* … */ repoRoot?: string }   // git-history only
// DocsAction 'open' gains repoRoot?: string. For kind 'git-history': a new doc stores it; an existing
// singleton REPLACES its repoRoot with the action's (including undefined → keeps existing only when
// the action omits the key — use `'repoRoot' in action`).
```

### `webview/git-history-state.ts` (extracted from `git-history-view.tsx`)
```ts
export type HistoryAction = /* today's actions */ | { type: 'retarget' };
export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState;
export const initialHistoryState: HistoryState;
// retarget: commits [], hasMore false, searchCommits [], selectedSha null, refFilter null, phase 'loading'; query kept.
/** Drop a git:historyResult unless sessionId matches, repoRoot === msg.repoRoot (both undefined counts), and requestId is latest. */
export function acceptHistoryResult(
  msg: { sessionId: string; repoRoot?: string; requestId?: number; query?: string },
  view: { sessionId: string | undefined; repoRoot: string | undefined; latestReqId: number; latestSearchReqId: number },
): boolean;
```
(`HistoryState` = today's `State` renamed and exported; `isStaleHistory` keeps its module.)

### `src/branch-chip.ts` (renderer-safe)
```ts
export type BranchChipModel =
  | { state: 'unknown' }                                   // repoGit[root] absent → muted '…', inert
  | { state: 'none' }                                      // kind 'none' → 'no git info', menu still opens
  | {
      state: 'ready';
      kind: 'branch' | 'detached' | 'bare';
      text: string;                // branch | 7-char sha | 'bare'
      tag?: 'detached' | 'no commits';
      op?: GitOperation; opLabel?: string;      // 'REBASING' … (moved OPERATION_LABEL)
      worktree?: string;
      dirty: boolean;
      switchable: boolean;         // branch && !unborn, or detached
      accessibleName: string;      // `<OP> Branch <b>[, worktree <w>][, uncommitted changes]. Switch branch or view history`
                                   // detached: `<OP> Detached at <sha>[, …]. Switch branch or view history`; bare: `Bare repository. View history`
    };
export function branchChipModel(g: GitInfo | undefined): BranchChipModel;
export type SwitchOutcome = { announce: string } | { toast: string; variant: 'info' | 'error' };
/** ok → announce `Switched to ${requestedRef}`; busy/dirty → today's copy (info); message 'unknown repo'
 *  → `Couldn't switch branch: unknown repository` (error); other failure → `Couldn't switch branch: ${message}` (error). */
export function switchOutcome(msg: { ok: boolean; reason?: 'busy' | 'dirty' | 'failed'; message?: string }, requestedRef: string): SwitchOutcome;
/** sessionId equal AND folderKey(msg.repoRoot ?? '') === folderKey(repoRoot). */
export function acceptsRepoResult(msg: { sessionId: string; repoRoot?: string }, sessionId: string, repoRoot: string): boolean;
```

### Components (props, all new or changed)
```ts
// webview/components/repo-picker-menu.tsx (changed; RepoPicker adapts in S4, is deleted in S6)
export interface RepoMenuRow { root: string; name: string; tag: RepoTag; sub?: string; checked: boolean }
interface RepoPickerMenuProps {
  rows: RepoMenuRow[];
  auto?: { label: string; checked: boolean };         // absent → no Auto row (History chip)
  footer?: { label: string; onPick: () => void };     // 'Show all repos'; separator before it
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  onPick: (root: string | null) => void;              // null = Auto
  onClose: () => void;
}
// webview/components/repo-head.tsx
export interface RepoHeadProps {
  head: RepoHeadModel; view: ChangesViewMode; tag: RepoTag;
  collapsed: boolean; listId: string; onToggle: () => void;
  picker?: { rows: RepoMenuRow[]; pinned: boolean; onPick: (root: string | null) => void; onShowAll: () => void }; // active view, ≥2 repos
  chip: React.ReactNode;                               // Slice 6 passes <BranchChip/>; Slice 4 passes null
  onActivate: () => void;                              // repo:context
  onContextMenu: (e: React.MouseEvent | React.KeyboardEvent) => void;
}
// webview/components/changes-view.tsx (ChangesView + ChangeRow moved here from right-pane.tsx)
export interface ChangesViewProps {
  model: Exclude<ChangesModel, { kind: 'no-session' }>;
  reviewTitle: string;                                  // `Review changes (<combo>)`
  onReview: () => void; onRefresh: () => void;
  onSetView: (view: ChangesViewMode) => void;
  onOpenDiff: (repoRoot: string, relPath: string, diffScope: DiffTabScope | undefined, mode?: OpenMode) => void;
  onAction: (intent: GitActionIntent) => Promise<void>;
  onChangeContextMenu: (e: React.MouseEvent, relPath: string, repoRoot: string) => void;
  onRepoHeadContextMenu: (e: React.MouseEvent | React.KeyboardEvent, repoRoot: string) => void;
  onRepoContext: (repoRoot: string) => void;
  onPickActiveRepo: (root: string | null) => void;
  renderChip: (repo: RepoInfo) => React.ReactNode;     // Slice 6; Slice 4 passes () => null
}
// webview/components/branch-chip.tsx (Slice 6)
export interface BranchChipProps {
  sessionId: string; repo: RepoInfo; git: GitInfo | undefined;
  onViewHistory: (root: string) => void;
  onSwitched: () => void;                               // app: refreshChanges()
  onActivate: () => void;                               // repo:context
}
// webview/components/branch-switcher-menu.tsx → exports BranchSwitcherList (Slice 6), inline, no portal
export interface BranchSwitcherListProps {
  sessionId: string; repoRoot: string; switchable: boolean; switching: boolean;
  onSelect: (ref: string) => void;
  onArrowUpFromFilter: () => void;                      // focus 'View history'
}
// webview/components/git-history-view.tsx (Slice 5) adds:
//   repoRoot: string | undefined; repos: RepoInfo[]; onRetarget: (root: string) => void;
//   onReviewCommit?: (sha: string, subject: string, repoRoot?: string) => void;
// webview/components/commit-view.tsx: CommitView and the second useCommitFiles site gain root?: string
// webview/shortcuts.ts
export function comboLabel(actionId: string, shortcuts: AppSettings['shortcuts']): string | undefined; // formatCombo(effectiveCombo(…))
```

### Host `git:commitDiff` (D22, Slice 5)
`m.root === undefined` → `gitRoot(session)` (today). Else `requestGitRoot(session, m.root)`; if
`null` and `typeof m.root === 'string'` and `folderKey(await sessionGitRoot(session, run)) ===
folderKey(m.root)` → `m.root`; else reply
`{ type: 'git:commitDiffResult', sessionId, sha: m.sha, files: [], error: 'unknown repo', root: m.root, requestId: m.requestId }`
and run no git. (`run` = the rev-parse runner `main.ts` already passes to `sessionGitRoot`.)

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `Session.repoGit` (replaces `git`) | `runGitRefresh` → `mgr.setRepoGit` | BranchChip; History fingerprint; `session-icon.ts:42` → `anyRepoDirty`; `session-card.tsx:94` → `dirtyFileCount`; `center-pane.tsx:259` (until S6); `persistence.ts` strip; tests `palette-state`, `session-icon`, `persistence` | both, S1 |
| `mgr.setRepos` change → git refresh | repo-scan site (mf-model) | `scheduleGitRefresh` | both, S1 (one call-site edit) |
| `project.repoChanges` | `sendProject` + `buildRepoChanges` | app `acceptRepoChanges` → `changesModel` (here); mf-review; mf-files D13 | producer + first consumer; downstream read the pinned shape |
| `requestProject` re-request on repo-set change | app.tsx effect deps | host `sendProject` | both, S3 |
| `changesView` setting | Settings select, `···` radios, picker `Show all repos` | `changesModel`, badge | both, S2/S4 |
| retired `showGitIndicator` / `multiRepoPicker` | `coerceSettings` | host gates `main.ts:1143, :1203`, `center-pane.tsx:151,204`, `app.tsx:3319`, `settings-modal.tsx:861-878` | all removed, S2 |
| `GitActionIntent.repoRoot/repoRoots` | ChangeRow, bulk menus, head menu (here); Review action bar (mf-review) | `onGitAction` → `runGit` / `runGitFanOut` | both, S4 |
| `HunkActionHost.rootFor` | app.tsx host | `applyHunkAction`, editor peek, Review (mf-review) | both, S4; Review consumes through `applyHunkAction`, unchanged call |
| `repo:context` from rows/heads/chips | ChangesView, RepoHead, BranchChip | host `repo:context` (unchanged, ignored while pinned) | producer only; consumer unchanged, measured `main.ts:2713-2720` |
| `repo:unpin` on All view | `onSetView('all')` | host `repo:unpin` (unchanged) | producer only |
| History doc `repoRoot` | chip `View history`, `Mod+Shift+G`, palette, retarget | GitHistoryView, CommitView, `openReviewForCommit(…, repoRoot)` | both, S5 |
| `git:commitDiff.root` validation | host handler | `use-commit-files.ts` callers (CommitView, ReviewView `:455`) | both; ReviewView's `commitRepoRoot` comes from a commit source stamped with a detected repo or terminal root, both accepted |
| `repoRoot` on history/refs/switch + echo | chip, History (here) | mf-model handlers | producer here; host side is mf-model's |
| DocTabs `trailing` | `center-pane.tsx:245` (only caller, measured) | `doc-tabs.tsx:359` | both removed, S6 |
| `.git-indicator*`, `.repo-picker*` classes | deleted components | e2e (33 files), `state-vocabulary` section, `overlay-sites` | all updated, S6 |

`fsChanged {root}` → `refreshChanges` (`app.tsx:1384-1390`): unchanged consumer; the host still
emits one refresh per fire (L12 B3), and a single `requestProject` returns every repo.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `Session.repoGit` replaces `git` |
| `src/protocol.ts` | modify | `RepoChanges`, `project.repoChanges` |
| `src/settings.ts` | modify | `ChangesViewMode`, `changesView`, retire two settings + migration |
| `src/persistence.ts` | modify | strip `repoGit` (not `git`) |
| `src/session-manager.ts` | modify | `setRepoGit` replaces `setGit`; `setRepos` returns `boolean` |
| `src/session-icon.ts` | modify | Review state via `anyRepoDirty` |
| `src/repo-display.ts` | create | display order, set key, names, sub-path, labels, History target |
| `src/repo-git.ts` | create | per-repo GitInfo readers + fingerprint |
| `src/repo-git-refresh.ts` | create | concurrent per-repo interrogation, HEAD cap |
| `src/repo-changes.ts` | create | per-repo `RepoChanges` fan-out |
| `src/project-info.ts` | modify | export `gitChanges` |
| `src/changes-view-model.ts` | create | `changesModel`, `acceptRepoChanges` |
| `src/branch-chip.ts` | create | chip model, switch outcome copy, result filter |
| `electron/main.ts` | modify | `runGitRefresh`, HEAD watches, gates, `sendProject` fan-out, commitDiff validation |
| `webview/app.tsx` | modify | repoChanges state, model, per-repo git actions/diffs/menus/hunks, fan-out, History opening, view toggle |
| `webview/shortcuts.ts` | modify | `comboLabel` |
| `webview/git-intent.ts` | modify | `repoRoot`, `repoRoots` |
| `webview/changes-actions.ts` | modify | `BulkScope` |
| `webview/hunk-actions.ts` | modify | `rootFor` |
| `webview/docs.ts` | modify | History `repoRoot` |
| `webview/git-history-state.ts` | create | History reducer + result filter (extracted) |
| `webview/components/context-menu.tsx` | modify | `MenuItem.radio` |
| `webview/components/changes-view.tsx` | create | ChangesView + ChangeRow (moved), per-repo layout, header, empty states |
| `webview/components/repo-head.tsx` | create | repo header (chevron, name/picker, tag, sub, chip slot, context menu) |
| `webview/components/repo-picker-menu.tsx` | modify | row model, optional Auto, footer |
| `webview/components/repo-picker.tsx` | modify (S4) → delete (S6) | adapt to new menu props; then removed |
| `webview/components/branch-chip.tsx` | create | chip + Popover menu (View history, switcher) |
| `webview/components/branch-switcher-menu.tsx` | modify | `BranchSwitcherList`, inline, `repoRoot` |
| `webview/components/git-indicator-bar.tsx` | delete (S6) | — |
| `webview/components/right-pane.tsx` | modify | changes props → model; Changes `No session`; badge |
| `webview/components/center-pane.tsx` | modify | S1 `gitOf`; S2 drop `showGitIndicator`; S5 History props; S6 drop `trailing` band |
| `webview/components/doc-tabs.tsx` | modify (S6) | drop `trailing` |
| `webview/components/git-history-view.tsx` | modify | repo chip, `repoRoot` on posts, fingerprint seam, uses git-history-state |
| `webview/components/commit-view.tsx` | modify | `root` into `useCommitFiles` |
| `webview/components/session-card.tsx` | modify | `dirtyFileCount` |
| `webview/components/settings-modal.tsx` | modify | replace two toggles with `Changes view` select |
| `webview/styles.css` | modify | repo head, tags, Review button, chip rename, removals, vocabulary section |
| `webview/bridge.ts`, `webview/mock.ts` | modify | fake `repoChanges`; mock sessions get `repos`/`repoGit` |
| `test/unit/repo-display.test.ts`, `repo-git.test.ts`, `repo-git-refresh.test.ts`, `repo-changes.test.ts`, `changes-view-model.test.ts`, `changes-actions.test.ts`, `git-history-state.test.ts`, `branch-chip.test.ts` | create | per module |
| `test/unit/persistence.test.ts`, `session-manager.test.ts`, `session-icon.test.ts`, `palette-state.test.ts`, `coerce-settings.test.ts`, `hunk-actions.test.ts`, `docs.test.ts`, `overlay-sites.test.ts`, `state-vocabulary.test.ts` | modify | as per slice |
| `test/e2e/harness.mjs` | modify | `openChangesTab`, `openReview` (S4), `openHistory`, `openSession({roots})` (S6) |
| `test/e2e/changes-fixture.mjs` | modify | repo-scoped `changeRow`; `openChangesPanel` delegates to `openChangesTab` |
| `test/e2e/changes-multi-repo.e2e.mjs` | create | §7.3 scenario + AC2/3/4/5/6/8/9 |
| the §7.4 e2e files (listed per task) | modify | new placement, same or stronger assertions |

## Scripts

1. **One-off entry-point swap** — `%TEMP%\claude-scratch\swap-git-entry.mjs` (Slice 6, T6.5),
   `node <path> --dry` (prints per-file match counts and any file with an unmatched
   `git-indicator` reference) then `node <path> --write`. It rewrites, only in the files T6.5
   lists, a `waitForSelector('.git-indicator__review'…)` + `click('.git-indicator__review')` pair
   (either order of options, one blank line allowed between) to `await openReview(page);`, the same
   for `__history` → `await openHistory(page);`, and adds `openReview`/`openHistory` to the file's
   existing `./harness.mjs` import (or adds one). Any remaining `git-indicator` in a listed file is a
   hand edit, never a regex widening. Deleted after T6.5.

## Slices

### Slice 1: Per-repo GitInfo on the host (`repoGit` replaces `git`)

**Check:** `npx vitest run test/unit/repo-display.test.ts test/unit/repo-git.test.ts test/unit/repo-git-refresh.test.ts test/unit/persistence.test.ts test/unit/session-manager.test.ts test/unit/session-icon.test.ts test/unit/palette-state.test.ts`; `npm run typecheck`; `npm run fallow:check`; after `npm run build`: `node test/e2e/run-smoke.mjs git-indicator`, `… branch-switch`, `… multi-repo`, `… repo-rescan`, `… git-history`.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3 · Serial: T1.4 → T1.5
**Claims (serial lane):** `src/types.ts`, `electron/main.ts`, `webview/components/center-pane.tsx`

#### Task 1.1: Display order and repo-set key
**Files:** Create `src/repo-display.ts` (`orderRepos`, `repoSetKey` only), `test/unit/repo-display.test.ts`.
**Interfaces:** Consumes `RepoInfo {root; name; folder; tag}`, `folderKey`. Produces `orderRepos(repos, roots): RepoInfo[]`, `repoSetKey(repos: readonly {root: string}[]): string`.
**Steps:**
- [ ] Failing tests: `'home first, nested by root, attached by roots order then root'` — input shuffled `[att-b2, nested-z, att-a, home, nested-a, att-b1]` with roots `['/r/a', '/r/b']` → roots in that documented order; `'attached folder matched by folderKey (C:/R/A vs c:/r/a)'`; `'repoSetKey ignores order and case-folds drive paths'` — `repoSetKey([{root:'C:/x'},{root:'/y'}]) === repoSetKey([{root:'/y'},{root:'c:/x/'}])`; `'repoSetKey([]) === ""'`.
- [ ] Run `npx vitest run test/unit/repo-display.test.ts` — expect FAIL (module missing); implement.

#### Task 1.2: GitInfo readers
**Files:** Create `src/repo-git.ts`, `test/unit/repo-git.test.ts`.
**Interfaces:** Produces `gitOf`, `anyRepoDirty`, `dirtyFileCount`, `repoGitFingerprint` (Contracts).
**Steps:**
- [ ] Failing tests: `'gitOf defaults to activeRepoRoot'`; `'anyRepoDirty true when only an attached repo is dirty'`; `'dirtyFileCount sums, ignores none'`; `'fingerprint of undefined is empty; differs on dirty and operation'`.
- [ ] Run — FAIL; implement.

#### Task 1.3: Per-repo interrogation
**Files:** Create `src/repo-git-refresh.ts`, `test/unit/repo-git-refresh.test.ts`.
**Interfaces:** Consumes `mapWithConcurrency(items, limit, fn)` (`src/git-exec.ts:98`), `GitInterrogation` (`src/git-info.ts`). Produces `HEAD_WATCH_CAP`, `RepoInterrogation`, `interrogateRepos`.
**Steps:**
- [ ] Failing tests (fake interrogate with controllable promises): `'keeps input order'`; `'a throw becomes kind none, others unaffected'`; `'never more than 4 in flight'`.
- [ ] Run — FAIL; implement.

#### Task 1.4: `repoGit` through types, manager, persistence and readers
**Files:** Modify `src/types.ts` (Session :87-92), `src/session-manager.ts` (`setGit` :200 → `setRepoGit(id: string, repoGit: Record<string, GitInfo> | undefined): void` emitting only when key sets differ or any `sameGit` is false; `setRepos` :232 returns `boolean` = it emitted), `src/persistence.ts` (strip `repoGit: _repoGit` in place of `git: _git`), `src/session-icon.ts` (Pick `'repoGit'`; `completedRun && anyRepoDirty(session)`), `webview/components/session-card.tsx:94` (`dirtyFileCount(session)`), `webview/components/center-pane.tsx:259` (`git={gitOf(active)}`), `webview/components/git-history-view.tsx:357-359` (`repoGitFingerprint(gitOf(session))`), tests `test/unit/persistence.test.ts:32-47`, `test/unit/session-manager.test.ts`, `test/unit/session-icon.test.ts:189-211`, `test/unit/palette-state.test.ts:12`.
**Interfaces:** Consumes T1.2. Produces `Session.repoGit`, `SessionManager.setRepoGit`, `setRepos(): boolean`.
**Call sites:** `setGit` — `electron/main.ts:1204,1219` (T1.5); `setRepos` — the repo-scan site (T1.5); `session.git` readers listed above (all in this task).
**Steps:**
- [ ] Failing tests: persistence `'strips repoGit'` (same shape as today's `git` strip test, now on `repoGit: {'/r': {kind:'branch', branch:'main', dirty:true}}`); session-manager `'setRepoGit emits on a per-repo dirty change, not on an equal map'`, `'setRepos returns true only when it emitted'`; session-icon `'review when an attached repo is dirty and the run completed'`.
- [ ] Run — FAIL; implement; the existing session-icon/palette-state cases move from `git` to `repoGit` with the same expectations.

#### Task 1.5: Host refresh over every repo
**Files:** Modify `electron/main.ts`: `runGitRefresh` (:1197-1220) → order with `orderRepos(s.repos ?? [], s.roots)`; return early (no set) when `s.repos === undefined`; `startKey = repoSetKey(repos)`; `results = await interrogateRepos(repos.map(r => r.root), interrogateGit)`; drop when `!latest || repoSetKey(latest.repos ?? []) !== startKey`; `syncHeadWatches(id, results.slice(0, HEAD_WATCH_CAP).flatMap(r => r.headPath ? [r.headPath] : []))`; `mgr.setRepoGit(id, Object.fromEntries(results.map(r => [r.root, r.info])))` (a `none` info is kept). Keep the `showGitIndicator` gate as `mgr.setRepoGit(id, undefined)` (S2 removes it). Replace `gitWatchers`/`gitWatchedHead` (:1122-1191) with `gitWatchers: Map<string, Map<string, fs.FSWatcher>>` (sessionId → headPath → watcher) and `syncHeadWatches(sessionId, headPaths)` (close absent, open new with today's `fs.watch(…, {persistent:false}, () => scheduleGitRefresh(id))`, error and once-per-session failure log unchanged, `gitTornDown` latch honoured); `teardownGitRefresh` closes every watcher of the session. At the repo-scan site: `if (mgr.setRepos(id, repos)) scheduleGitRefresh(id)`. Modify `test/e2e/git-indicator.e2e.mjs` and `test/e2e/branch-switch.e2e.mjs`: state reads of `session.git` → `session.repoGit[<repo root>]` with the same expected values; git-indicator scenario 3 (non-git cwd) asserts `session.repos` is `[]` and `repoGit` is `{}` or absent (was `git === null`).
**Interfaces:** Consumes T1.1–T1.4.
**Steps:**
- [ ] Carve-out (host wiring): proof is the slice's e2e list.

### Slice 2: Retire `showGitIndicator` / `multiRepoPicker`, add `changesView`

**Check:** `npx vitest run test/unit/coerce-settings.test.ts test/unit/settings.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build: `node test/e2e/run-smoke.mjs git-indicator`, `… multi-repo`, `… settings` (every scenario whose name contains `settings`).

**Parallel groups:** Serial: T2.1 → T2.2
**Claims (serial lane):** `src/settings.ts`, `electron/main.ts`, `webview/app.tsx`, `webview/components/center-pane.tsx`

#### Task 2.1: Settings model
**Files:** Modify `src/settings.ts` (:139-146, :213-214, :459-460 per Contracts), `test/unit/coerce-settings.test.ts`.
**Interfaces:** Produces `ChangesViewMode`, `AppSettings.changesView`.
**Steps:**
- [ ] Failing tests: `'showGitIndicator and multiRepoPicker are dropped'` — `'showGitIndicator' in coerceSettings({showGitIndicator:false}) === false`; `'multiRepoPicker:false with no changesView → active'`; `'stored changesView wins over multiRepoPicker:false'`; `'unknown changesView → all'`; `'default all'`.
- [ ] Run — FAIL; implement.

#### Task 2.2: Consumers of the retired settings
**Files:** Modify `electron/main.ts` (delete the `multiRepoPicker` gate at the repo-scan site, today :1143-1146; delete the `showGitIndicator` gate in `runGitRefresh`, :1203; the comment at :1249), `webview/components/center-pane.tsx` (delete `showGitIndicator` prop :151, destructure :81; `showGitBand = !!active`; always render `GitIndicatorBar`), `webview/app.tsx:3319` (drop the prop), `webview/components/settings-modal.tsx` (:861-878: replace both toggles with `<Section title="Changes view" desc="Show every repo of the session, or only the active one.">` + `<SelectField ariaLabel="Changes view" value={settings.changesView} options={[{value:'all',label:'All repos'},{value:'active',label:'Active repo'}]} onChange={(v) => update({ changesView: v as ChangesViewMode })} />`, same shape as `:888-902`).
**Steps:**
- [ ] Carve-out (removal + wiring): proof is typecheck, fallow and the slice e2e.

### Slice 3: `project.repoChanges` (host fan-out) and its acceptance in the renderer

**Check:** `npx vitest run test/unit/repo-changes.test.ts test/unit/changes-view-model.test.ts test/unit/repo-display.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build: `node test/e2e/run-smoke.mjs multi-repo` (strengthened below), `… repo-rescan`, `… live-watch`, `… idle-fs-quiet`.

**Parallel groups:** G1: T3.1 · G2: T3.2 · Serial: T3.3
**Claims (serial lane):** `src/protocol.ts` (T3.1 adds the `RepoChanges` interface, T3.3 the `project` field; T3.2 never touches it), `electron/main.ts`, `webview/app.tsx`, `webview/bridge.ts`

#### Task 3.1: `buildRepoChanges` + `repoSub`
**Files:** Modify `src/project-info.ts` (`export async function gitChanges`), `src/repo-display.ts` (add `repoBaseName`, `repoSub`), create `src/repo-changes.ts`, `test/unit/repo-changes.test.ts`, extend `test/unit/repo-display.test.ts`.
**Interfaces:** Consumes `RepoChanges` (defined in T3.3 — declare the interface in `src/protocol.ts` in this task's first step; T3.3 only adds the `project` field), `repoBaseName`, `folderKey`. Produces `buildRepoChanges`, `repoBaseName`, `repoSub`.
**Steps:**
- [ ] Failing tests: `'active repo reuses activeChanges, changesFor not called for it'`; `'order = input order'`; `'changesFor reject → changes []'`; `'sub for a repo below its folder: room-message-bus/vendor/proto-schemas'`; `'no sub when root is the folder (case-folded key)'`; `'branch only when kind branch'`; `'at most 4 changesFor in flight'`; `'repoBaseName handles \\ and a trailing /'`.
- [ ] Run — FAIL; implement (concurrency via `mapWithConcurrency`).

#### Task 3.2: `acceptRepoChanges`
**Files:** Create `src/changes-view-model.ts` (only `acceptRepoChanges` in this slice), `test/unit/changes-view-model.test.ts`.
**Interfaces:** Consumes `repoSetKey`, `RepoChanges`, `RepoInfo`. Produces `acceptRepoChanges(prev, incoming, repos)`.
**Steps:**
- [ ] Failing tests: `'matching set adopted'`; `'stale set (repo added since request) keeps prev'`; `'undefined incoming keeps prev'`; `'repos undefined keeps prev'`.
- [ ] Run — FAIL; implement.

#### Task 3.3: Protocol + host + renderer wiring
**Files:** Modify `src/protocol.ts` (`project.repoChanges?`), `electron/main.ts` `sendProject` (after `getProjectInfo`: when `sessionId` and `s = mgr.get(sessionId)` and `s.repos !== undefined` → `repoChanges = await buildRepoChanges({ repos: orderRepos(s.repos, s.roots), activeRoot: changesRoot, activeChanges: info.changes, repoGit: s.repoGit, changesFor: gitChanges })`; include in the dispatch; the catch branch sends `repoChanges: []` only when the session is known and scanned), `webview/app.tsx` (`const [repoChanges, setRepoChanges] = useState<RepoChanges[] | undefined>()`; in the `project` handler :391 `setRepoChanges(prev => acceptRepoChanges(prev, msg.repoChanges, activeRef.current?.repos))`; reset to `undefined` in an effect on `active?.id`; add `repoSetKey(active?.repos ?? [])` and `active?.repos === undefined` to the deps of the requestProject effect :1240 and `refreshChanges` :1255), `webview/bridge.ts` (fake `requestProject`, :826-839: when `msg.sessionId`, add `repoChanges: [{ root: msg.path, name: repoBaseName(msg.path), tag: 'home', changes: mockChanges }]`), `test/e2e/multi-repo.e2e.mjs` (**add:** after the repos settle, the tapped `project` has `repoChanges` with both repo roots in display order, each listing only its own file, and after pinning repo-b `changes` still equals repo-b's entry), `test/e2e/repo-rescan.e2e.mjs` (**add:** after repo-c appears, the next `project` reply's `repoChanges` includes repo-c).
**Steps:**
- [ ] Carve-out (wiring): proof is the slice e2e.

### Slice 4: Changes tab per repo (All / Active views, heads, Review button, actions, hunks)

**Check:** `npx vitest run test/unit/changes-view-model.test.ts test/unit/changes-actions.test.ts test/unit/hunk-actions.test.ts test/unit/repo-display.test.ts test/unit/state-vocabulary.test.ts test/unit/settings.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build, serially: `review-scope`, `multi-repo`, `repo-rescan`, `scoped-diff-tabs`, `editor-nav-history-moves`, `context-menu-order`, `go-files`, `hover-obstruction`, `middle-click-surfaces`, `overlay-modals`, `review-mode-pane`, `review-notes-handoff`, `split-diff-map`, `hunk-staging`, `review-entry-point`.

**Parallel groups:** G1: T4.1 · G2: T4.2 · G3: T4.3 · G4: T4.4 · G5: T4.5 → T4.6 · Serial: T4.7 → T4.8 → T4.9 → T4.10 → T4.11
**Claims (serial lane):** `webview/app.tsx`, `webview/components/right-pane.tsx`, `webview/styles.css`, `webview/mock.ts`, `webview/bridge.ts`, `test/e2e/harness.mjs`

#### Task 4.1: `changesModel` + `repoLabel`
**Files:** Modify `src/changes-view-model.ts`, `src/repo-display.ts` (`repoLabel`), `test/unit/changes-view-model.test.ts`, `test/unit/repo-display.test.ts`.
**Interfaces:** Consumes `orderRepos`, `repoSub`, `folderKey`, `ChangesViewMode`. Produces `RepoHeadModel`, `ChangesModel`, `changesModel`, `repoLabel`.
**Steps:**
- [ ] Failing tests: `'no session → no-session'`; `'repos undefined → detecting'`; `'repos [] → no-repos'`; `'all view: one head per repo in display order, count/added/removed summed'`; `'active view: exactly the active repo; activeRoot falls back to first'`; `'a repo missing from repoChanges → changes undefined, loading true, excluded from count'`; `'allClean only when loaded and zero'`; `'staged/unstaged split per head'`; `'repoLabel: attached collision gets " — parent"; home/nested keep the bare name'`.
- [ ] Run — FAIL; implement.

#### Task 4.2: Intents and bulk scope
**Files:** Modify `webview/git-intent.ts`, `webview/changes-actions.ts`; create `test/unit/changes-actions.test.ts`.
**Interfaces:** Produces `GitActionIntent { op; path?; repoRoot?; repoRoots? }`, `BulkScope`, `buildBulkMenuItems(staged, unstaged, onAction, close, scope)`.
**Call sites:** `buildBulkMenuItems` — `webview/components/right-pane.tsx` ChangesView (moves to changes-view.tsx in T4.7); T4.9 adds app.tsx head/row menus.
**Steps:**
- [ ] Failing tests: `'repo scope: every intent carries repoRoot'`; `'all scope: Stage all → repoRoots = stageRoots; disabled when none'`; `'all scope: Stash, Pop, Discard disabled with the per-repo title'`; `'all scope Stage all title names N repos'`; `'rowActionsFor unchanged'`.
- [ ] Run — FAIL; implement.

#### Task 4.3: Hunk host `rootFor`
**Files:** Modify `webview/hunk-actions.ts` (:69-83, :128-143), `test/unit/hunk-actions.test.ts`.
**Interfaces:** Produces `HunkActionHost.rootFor(absPath): string` (Contracts). Removes `root`.
**Call sites:** `webview/app.tsx:1420-1471` (T4.9).
**Steps:**
- [ ] Failing tests: `'request root is rootFor(absPath)'` — host whose `rootFor` maps `/a/x.ts → /a`, `/b/y.ts → /b`; `applyHunkAction` for `/b/y.ts` sends `root: '/b'`; `'rootFor "" → noHost'`. Existing tests switch `root: '/r'` to `rootFor: () => '/r'`, same assertions.
- [ ] Run — FAIL; implement.

#### Task 4.4: ContextMenu radio role
**Files:** Modify `webview/components/context-menu.tsx` (`MenuItem.radio?`, :138).
**Steps:**
- [ ] Carve-out (one attribute): proof is T4.11's e2e assertion `[role="menuitemradio"]` count 2 in the header `···` of `multi-repo`.

#### Task 4.5: RepoPickerMenu row model
**Files:** Modify `webview/components/repo-picker-menu.tsx` (props per Contracts; rows show name, tag pill `Home|Nested|Attached`, sub-path line; Auto row only when `auto`; `footer` row after a `.ctxmenu__sep`), `webview/components/repo-picker.tsx` (build `rows` from `repos` with `checked: pinned && root === activeRepoRoot`, pass `auto={{label: STR.auto, checked: !pinned}}`, `ariaLabel="Active repo"`).
**Interfaces:** Produces `RepoMenuRow`, the new `RepoPickerMenu` props.
**Steps:**
- [ ] Carve-out (component refactor): proof is `multi-repo` e2e unchanged (it drives `.repo-picker__trigger` / `.repo-picker-menu__row` / `.repo-picker-menu__name`, which keep their classes) plus `overlay-sites` staying green.

#### Task 4.6: RepoHead
**Files:** Create `webview/components/repo-head.tsx`.
**Interfaces:** Consumes `RepoHeadModel`, `RepoMenuRow`, `RepoPickerMenu`. Produces `RepoHead(props: RepoHeadProps)`.
Markup: `div.repo-head[role=group][aria-label="<label>, <Tag>"][title=<root>]` →
All view: `button.iconbtn.iconbtn--sm.repo-head__chev[aria-expanded][aria-controls=listId]` (`IconChevronDown`, rotated when collapsed), `IconFolder`, `span.repo-head__name[dir=ltr]`, `span.repo-head__tag.repo-head__tag--<tag>` (text), chip slot (`margin-inline-start:auto`); second line `span.repo-head__sub[dir=ltr]` when `head.sub`.
Active view: no chevron/tag; `picker` present → `button.repo-head__picker[aria-haspopup=menu][aria-expanded][aria-label="Active repo: <label>[, pinned]"]` (name, `IconPin` when pinned, `IconChevronDown`) opening `RepoPickerMenu` with `auto`, `footer={{label:'Show all repos', onPick: onShowAll}}`; absent → plain `span.repo-head__name`. Focus: picker pick → picker trigger. `onContextMenu` on the group; `Shift+F10`/`ContextMenu` key on the focused chevron/picker call it with the keyboard event. Click on the head (not a control) → `onActivate`.
**Steps:**
- [ ] Carve-out (presentational): proof is T4.11's e2e (`changes-multi-repo` in S7 adds the full DOM assertions; `multi-repo` gains the All-view case here).

#### Task 4.7: ChangesView (moved and rewritten)
**Files:** Create `webview/components/changes-view.tsx` (move `ChangeRow` :119-170 and `ChangesView` :172-329 out of `webview/components/right-pane.tsx`; delete them there).
**Interfaces:** Consumes `ChangesModel`, `RepoHead`, `buildBulkMenuItems`, `BulkScope`, `rowActionsFor`, `MenuItem.radio`. Produces `ChangesView(props: ChangesViewProps)`, `ChangeRow` (module-private unless another file imports it — it does not).
Behaviour:
- `detecting` → `.changes__header` with summary `Loading…` only.
- `no-repos` → `EmptyState title="No git repos" hint="None of this session's folders is a git repository."`, no header.
- `ready` → header `.changes__header`: `span.changes__header-summary[title=<full>]` (`No changes` | `N change(s)[ · M repos] +a -d` with ` · M repos` only in All view and M ≥ 2 | `Loading…` while `loading` and count 0), `button.btn.btn--primary.btn--sm.changes__review[title=reviewTitle]` "Review" (`aria-label="Review changes"`), `.changes__refresh`, `.changes__kebab` opening a `ContextMenu` whose items are `View` radios (`All repos`, `Active repo`; `radio: true`, `checked`) with the last radio followed by `separatorBefore` on the first bulk item, then `buildBulkMenuItems(…, scope)` — All view: `{kind:'all', stageRoots, unstageRoots}` from the heads; Active view: `{kind:'repo', repoRoot: model.activeRoot}`. The menu renders in every `ready` state.
- Body `.right__scroll`: per head `RepoHead` then (unless collapsed) `div#<listId>.repo-head__list` containing, as direct keyed children via `flatMap`, the `Staged`/`Changes` `.changes__section` labels (no review icons) and `ChangeRow`s; a loaded repo with no changes → one muted `.repo-head__empty` `No changes`; a loading repo → muted `.repo-head__empty` `Loading…`.
- After the heads: All view + `allClean` → `EmptyState title="No changes" hint={repos.length >= 2 ? `All ${n} repos are clean.` : 'The working tree is clean.'}`; Active view + `allClean` → `No changes` / `The working tree is clean.`.
- `ChangeRow` intents carry `repoRoot`; `onOpenDiff(repoRoot, rel, …)`; `onChangeContextMenu(e, rel, repoRoot)`; click / middle-click / hover-action on a row also calls `onRepoContext(repoRoot)`.
- Collapse: `useState<ReadonlySet<string>>` of `folderKey(root)`; entries absent from `model.repos` are ignored. Focus stays on the chevron.
- `onSetView('all' | 'active')`: then focus the `···` trigger (radio) or, from the picker's `Show all repos`, the first head's chevron.
**Steps:**
- [ ] Carve-out (component; the logic it renders is unit-tested in T4.1/T4.2): proof is the slice e2e.

#### Task 4.8: RightPane
**Files:** Modify `webview/components/right-pane.tsx`: props replace `changes`, `onOpenDiff`, `onGitAction`, `onChangeContextMenu`, `onRefreshChanges`, `onReviewScope` with `changesModel: ChangesModel` + the `ChangesViewProps` handlers (same names minus `model`); Changes tab branch: `changesModel.kind === 'no-session'` → `EmptyState variant="panel" title="No session" hint="Start a session to see its changes here."`; the Files tab branch keeps today's `No project open` copy (mf-files owns it); badge (:1829-1833) `reviewMode && navModel ? navModel.files.length : changesModel.kind === 'ready' ? changesModel.count : 0`; `test/unit/settings.test.ts:349-356` source scan keeps passing (the `RightPaneTab` import stays).
**Interfaces:** Consumes `ChangesView`, `ChangesViewProps`, `ChangesModel`.
**Call sites:** `webview/app.tsx:3408-3437` (T4.9).
**Steps:**
- [ ] Carve-out (prop plumbing): proof is typecheck + slice e2e.

#### Task 4.9: app.tsx — model, per-repo actions, fan-out, hunks, view toggle
**Files:** Modify `webview/app.tsx`, `webview/shortcuts.ts` (`comboLabel`; the local `comboFor` at :2761 calls it).
- `const changesViewModel = useMemo(() => changesModel({ session: active, repoChanges, view: settings.changesView }), …)`.
- `runGit(op, path?, repoRoot?)` (:2452): `root = repoRoot ?? gitRootForSession(active)`; `rereadOpenDiffs(d => isUnderRoot(root, d.path))`.
- `runGitFanOut(op: 'stageAll' | 'unstageAll', roots: string[]): Promise<void>` beside `runGit`: sequential per root, `gitAction({root, op})`, failure toast `Git (${repoBaseName(root)}): ${error}` and continue, `rereadOpenDiffs` per root, one `refreshChanges()` at the end.
- `discardAll(repoRoot?)` (:2471): its change list is that repo's `repoChanges` entry (else `projectData.changes` when `repoRoot` is undefined).
- `onGitAction: (intent) => Promise<void>` (:2504): `intent.repoRoots` → `runGitFanOut`; else today's confirm flow with `intent.repoRoot` threaded into `runGit`/`discardAll`.
- `onChangeContextMenu(e, rel, repoRoot)` (:2388): `abs = joinPath(repoRoot, rel)`; the bulk tail replaced by `buildBulkMenuItems(repoStaged, repoUnstaged, onGitAction, close, {kind:'repo', repoRoot})` (same items, same order).
- `onRepoHeadContextMenu(e, repoRoot)`: `buildBulkMenuItems(…, {kind:'repo', repoRoot})` + `Copy path` (separatorBefore) + `Reveal in Explorer`, reusing the handlers `onChangeContextMenu` already uses for those two.
- `onOpenDiff(repoRoot, rel, scope, mode)` → `openDiff(joinPath(repoRoot, rel), undefined, { diffScope: scope, mode })`.
- `onRepoContext(root)` → `post({ type: 'repo:context', sessionId: active.id, path: root })`.
- `onPickActiveRepo(root)` → `repo:pin {repoRoot: root}` or `repo:unpin` for `null`.
- `onSetView(view)` → `update({ changesView: view })`; `view === 'all' && active?.repoPinned` → `post({ type: 'repo:unpin', sessionId: active.id })`.
- `reviewTitle = \`Review changes (${comboLabel('openReview', settings.shortcuts) ?? ''})\`` (omit the parens when undefined); `onReview = openReviewTab`.
- Hunk host (:1420-1471): `rootFor = (abs) => repoForPath(active.repos ?? [], abs) ?? (active ? gitRootForSession(active) : '')`; `stagedPaths`/`conflictedPaths` folded over every `repoChanges` entry with its own root (fallback: today's `projectData.changes` against `gitRootForSession`); deps gain `repoChanges`, `active?.repos`.
- Delete `onReviewScope` plumbing; keep `openReviewScoped` only if still referenced (fallow decides).
**Interfaces:** Consumes everything T4.1–T4.8 produce, `repoForPath` (`src/active-repo.ts:5`), `repoBaseName`.
**Steps:**
- [ ] Carve-out (wiring): proof is the slice e2e.

#### Task 4.10: Styles
**Files:** Modify `webview/styles.css`: `.repo-head` (reuse the `.files__bar` family's height/padding/gap; `min-width:0` name, `flex:none` controls), `.repo-head__tag--home` (`--accent` on `--accent-soft`), `--nested` (`--amber` on `color-mix(in srgb, var(--amber) 14%, transparent)`), `--attached` (`--text-dim` on the fill `.git-indicator__tag` uses), `.repo-head__sub`, `.repo-head__empty`, `.repo-head__list`, `.changes__review` (`flex:none`), header summary ellipsis; `@media (forced-colors: active)` tag `1px solid currentColor` border; delete `.changes__sectionreview` (:4908-4916); in the interaction-state vocabulary section (~:12215-12514) add `.repo-head__chev`, `.repo-head__picker` to the rows where `.repo-picker__trigger` sits.
**Steps:**
- [ ] Proof: `npx vitest run test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts` green (the vocabulary "names only surfaces that still exist" test covers the new names).

#### Task 4.11: Preview data, harness, e2e for the new layout
**Files:** Modify `webview/mock.ts` (mock sessions: `repos: [{ root: <projectPath-now-home>, name: '.', folder: <same>, tag: 'home' }]`, `repoGit: { <root>: { kind: 'branch', branch: 'main', dirty: true, dirtyFiles: 3 } }`), `test/e2e/harness.mjs` (`openChangesTab(page)`: Ctrl+Shift+E when `.right` is hidden, click the `.rtab` whose text starts with `Changes`, wait for `.changes__header`; `openReview(page)`: `openChangesTab` then click `.changes__review`, wait for `.review`), `test/e2e/changes-fixture.mjs` (`openChangesPanel` → `openChangesTab`; `rowIndex(sec, f, repo?)` and `changeRow(page, section, file, { repo } = {})` scope to the `.repo-head__list` following the `.repo-head` whose `.repo-head__name` equals `repo`, or the first list when omitted; row identity by `.change__file` text under the named section, unchanged), `test/e2e/review-scope.e2e.mjs` (the `.changes__sectionreview` path → `openReview` + the Review header's `[role="radiogroup"][aria-label="Scope"]` Staged/Unstaged, same card assertions; **add** `document.querySelectorAll('.changes__sectionreview').length === 0`), `test/e2e/multi-repo.e2e.mjs` (**add** All view: two `.repo-head`s in display order, each list holding only its repo's file; the header `···` shows 2 `[role="menuitemradio"]`; `Discard all changes`, `Stash changes`, `Pop stash` carry `aria-disabled`/disabled with the per-repo title), `test/e2e/repo-rescan.e2e.mjs` (**add** repo-c's `.repo-head` appears in the All view), and the row-selector fixes in `context-menu-order`, `go-files`, `hover-obstruction`, `middle-click-surfaces`, `overlay-modals`, `review-mode-pane`, `review-notes-handoff`, `split-diff-map`, `scoped-diff-tabs` — only selectors the nesting breaks (a flat `:scope > .change` / `.changes__section ~ .change` becomes `.repo-head__list .change` / `changeRow`), every assertion kept. Their local `openReview` copies (`review-keymap-persist.e2e.mjs:96`, `review-notes-handoff.e2e.mjs:111`) switch to the harness import.
**Steps:**
- [ ] Run the slice e2e list serially; each passes with its assertion count ≥ before.

### Slice 5: History per repo

**Check:** `npx vitest run test/unit/git-history-state.test.ts test/unit/repo-display.test.ts test/unit/docs.test.ts test/unit/git-history.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build: `git-history`, `git-ref-dropdown`, `multi-repo`, `commit-detail-resize`, `commit-review-bounds`, `review-commit-picker`, `review-commit-source`, `middle-click-review`, `review-tab-state`.

**Parallel groups:** G1: T5.1 · G2: T5.2 · G3: T5.3 · Serial: T5.4 → T5.5
**Claims (serial lane):** `electron/main.ts`, `webview/app.tsx`, `webview/components/center-pane.tsx`, `webview/styles.css`

#### Task 5.1: Extract the History reducer
**Files:** Create `webview/git-history-state.ts` (move `State` → `HistoryState`, `Action` → `HistoryAction`, `reducer` → `historyReducer`, `initialState` → `initialHistoryState` from `webview/components/git-history-view.tsx:125-231`; add `retarget`, `acceptHistoryResult`), modify `webview/components/git-history-view.tsx` (import them; the result subscriber :335-351 uses `acceptHistoryResult`), create `test/unit/git-history-state.test.ts`.
**Interfaces:** Produces `HistoryState`, `HistoryAction`, `historyReducer`, `initialHistoryState`, `acceptHistoryResult` (Contracts).
**Steps:**
- [ ] Failing tests: `'retarget clears commits, selection, ref filter, paging; keeps query'`; `'result for another repoRoot is dropped'`; `'stale requestId dropped (search and list separately)'`; `'unknown-repo result (state error, commits []) for the current repo is accepted → error phase'` (AC7).
- [ ] Run — FAIL; implement (moved code byte-identical apart from the renames).

#### Task 5.2: `historyRepoFor`
**Files:** Modify `src/repo-display.ts`, `test/unit/repo-display.test.ts`.
**Steps:**
- [ ] Failing tests: `'doc repo still detected → kept (key-folded)'`; `'doc repo gone → activeRepoRoot'`; `'no active → first in display order'`; `'no repos → undefined'`.

#### Task 5.3: History doc `repoRoot`
**Files:** Modify `webview/docs.ts` (`OpenDoc.repoRoot`, `open` action, both the foreground and `openBackground` paths for `git-history`), `test/unit/docs.test.ts`.
**Steps:**
- [ ] Failing tests: `'open git-history stores repoRoot'`; `'re-open with another repoRoot retargets the singleton, same id'`; `'re-open without the key keeps the stored repoRoot'`.

#### Task 5.4: View, commit detail, host validation, wiring
**Files:** Modify `webview/components/git-history-view.tsx` (props per Contracts; every `git:history` post adds `...(repoRoot ? { repoRoot } : {})`; a `repoRoot` change dispatches `retarget` then re-requests; `GhHeader` → `History`, `button.gh__repo` (`IconFolder`, `repoLabel`, `IconChevronDown`; inert `span.gh__repo` with no caret when `repos.length < 2`) opening `RepoPickerMenu` (rows from `orderRepos(repos, …)` with tag/sub, no `auto`, `ariaLabel="History repository"`), `.gh__head-sub`, spacer, refresh; `aria-live=polite` region announcing `Showing history for <name>` on retarget; focus returns to `.gh__repo`; refresh seam keys on `repoGitFingerprint(session?.repoGit?.[repoRoot ?? ''])`), `webview/components/commit-view.tsx` (`root?: string` → both `useCommitFiles(sessionId, sha, root)` sites :57, :181; `onReviewCommit(sha, subject)` unchanged at this layer — GitHistoryView wraps it with its `repoRoot`), `webview/components/center-pane.tsx` (:382-387 pass `repoRoot={historyRepoFor(activeDoc.repoRoot, active)}`, `repos={orderRepos(active?.repos ?? [], active?.roots ?? [])}`, `onRetarget={(root) => onRetargetHistory(root)}`; `onReviewCommit` already carries `repoRoot`), `webview/app.tsx` (`openGitHistoryTab(repoRoot?: string)` stamps `repoRoot ?? historyRepoFor(undefined, active)` into the `open` action; `onRetargetHistory(root)` dispatches `open` with that `repoRoot`; the shortcut/palette call it with no argument), `electron/main.ts` `git:commitDiff` (:2312-2347, Contracts §Host), `webview/styles.css` (`.gh__repo` reusing `.gh__head-btn` sizing; `.gh__repo[aria-disabled]` inert look via the state vocabulary; add `.gh__repo` to the vocabulary section beside `.gh__head-btn`).
**Interfaces:** Consumes T5.1–T5.3, `requestGitRoot`, `folderKey`, `sessionGitRoot`, `RepoPickerMenu`.
**Steps:**
- [ ] Carve-out (wiring): proof is T5.5.

#### Task 5.5: e2e
**Files:** Modify `test/e2e/git-history.e2e.mjs` (**add:** `.gh__repo` present; the `git:commitDiff` post observed via the tap carries `root` equal to the repo; a posted `git:commitDiff {root:'<tmp>/nope'}` returns `error:'unknown repo'` and `files: []`), `test/e2e/multi-repo.e2e.mjs` (**add:** open History (today's `.git-indicator__history`, still present in this slice), `.gh__repo` menu lists both repos; picking repo-a shows only repo-a's subjects, picking repo-b only repo-b's, and the search box text survives the retarget).
**Steps:**
- [ ] Run the slice e2e list serially.

### Slice 6: Branch chip in the repo heads; git leaves the tab row

**Check:** `npx vitest run test/unit/branch-chip.test.ts test/unit/branch-menu.test.ts test/unit/overlay-sites.test.ts test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build, serially, every e2e named in T6.5–T6.7.

**Parallel groups:** G1: T6.1 · G2: T6.2 · Serial: T6.3 → T6.4 → T6.5 → T6.6 → T6.7
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`, `webview/styles.css`, `test/e2e/harness.mjs`

#### Task 6.1: Chip model
**Files:** Create `src/branch-chip.ts`, `test/unit/branch-chip.test.ts`.
**Interfaces:** Consumes `GitInfo`, `GitOperation`, `folderKey`. Produces `BranchChipModel`, `branchChipModel`, `SwitchOutcome`, `switchOutcome`, `acceptsRepoResult` (Contracts). `OPERATION_LABEL` moves here from `git-indicator-bar.tsx:42-48` (module-private).
**Steps:**
- [ ] Failing tests: `'undefined → unknown'`; `'kind none → none'`; `'rebase + worktree + dirty: accessible name "REBASING Branch main, worktree wt, uncommitted changes. Switch branch or view history"'` (AC11); `'detached: 7-char sha, tag detached, switchable'`; `'unborn: tag no commits, not switchable'`; `'bare: not switchable'`; `'switchOutcome ok announces "Switched to feature" (not blank)'`; `'switchOutcome unknown repo → "Couldn\'t switch branch: unknown repository", error'` (AC7); `'busy/dirty keep today\'s copy'`; `'acceptsRepoResult rejects another repoRoot and another session'` (AC7).
- [ ] Run — FAIL; implement.

#### Task 6.2: Inline branch switcher list
**Files:** Modify `webview/components/branch-switcher-menu.tsx` → export `BranchSwitcherList` (props per Contracts): posts `git:refs {sessionId, repoRoot}`; accepts `git:refsResult` only via `acceptsRepoResult`; an `error` result or `!switchable` renders one disabled `.git-branch-menu__empty` (`No branches to switch to` when `!switchable`; `No matching branches` for an error or empty filter match); root is `div.git-branch-menu` (no `ctxmenu` class, no portal, no `useEscapeKey`, no outside-mousedown/resize handlers — the Popover owns dismissal); filter input autofocus; ArrowUp in the filter → `onArrowUpFromFilter`; rows keep `disabled={row.disabled}`, `aria-checked={row.current}`, `aria-disabled={row.current || undefined}` (branch-menu.test.ts:57-72 source scan).
**Call sites:** `webview/components/git-indicator-bar.tsx:197-205` — not adapted: the file is deleted in T6.4 of this slice, and `tsc` is a slice-level check.
**Steps:**
- [ ] Proof: `npx vitest run test/unit/branch-menu.test.ts` unchanged and green.

#### Task 6.3: BranchChip + heads
**Files:** Create `webview/components/branch-chip.tsx`; modify `webview/components/changes-view.tsx` (`renderChip` used in each `RepoHead` `chip`), `webview/app.tsx` (`renderChip={(repo) => <BranchChip sessionId={active.id} repo={repo} git={active.repoGit?.[repo.root]} onViewHistory={openGitHistoryTab} onSwitched={refreshChanges} onActivate={() => onRepoContext(repo.root)} />}`).
Chip: `button.branch-chip[aria-haspopup=menu][aria-expanded][aria-label=model.accessibleName]` (`disabled` for `unknown` and while switching) containing, in order: worktree prefix (`IconWorktree` + name + `/`), `span.branch-chip__op`, `IconBranch`, `span.branch-chip__label[dir=ltr]`, `span.branch-chip__tag`, `span.branch-chip__dirty[aria-hidden]`, `IconChevronDown`; `unknown` → muted `…`; `none` → muted `no git info`, `title="Couldn't read this repo's git state"`, name `No git info. View history`. Click toggles with `menuToggleIntent`; `onActivate` on click. Menu: `<Popover anchor={chip rect} align="end" role="menu" className="branch-chip-menu" triggerRef onClose>` with `button.ctxmenu__item[role=menuitem]` `View history` (`IconHistory`) → `onViewHistory(repo.root)` + close, `.ctxmenu__sep`, `span.branch-chip-menu__label` `Switch branch`, `BranchSwitcherList`. Select → post `git:switch {sessionId, repoRoot: repo.root, target:{kind:'branch', ref}}`, `switching=true`; `git:switchResult` filtered by `acceptsRepoResult`; `switchOutcome(msg, ref)` → announce in the chip's `div.branch-chip__live[role=status][aria-live=polite]` or `pushToast`; ok → `onSwitched()`. Esc returns focus to the chip only when opened by keyboard (today's rule).
**Steps:**
- [ ] Carve-out (component; logic in T6.1/T6.2): proof is T6.6's `branch-switch` and `git-indicator`.

#### Task 6.4: Remove the tab-row band
**Files:** Delete `webview/components/git-indicator-bar.tsx`, `webview/components/repo-picker.tsx`; modify `webview/components/center-pane.tsx` (delete `RepoPicker`/`GitIndicatorBar` imports :18,:20, `showGitBand`, the `trailing` prop :245-267, and the `onOpenGitHistory`/`onOpenReview` props if no other use remains), `webview/components/doc-tabs.tsx` (delete `trailing` :73 and :359), `webview/app.tsx` (drop those CenterPane props), `webview/styles.css` (rename the kept `.git-indicator__*` visual rules to `.branch-chip__*` with no value changes; delete `.git-indicator`, `__history`, `__review`, `__live`, `.repo-picker*` except `.repo-picker-menu*`, `.tabbar__trail`; vocabulary section: `.git-indicator__history/__review` removed, `.repo-picker__trigger` → `.repo-head__picker` (if T4.10 already added it, just remove the old), `.git-indicator__branch--switchable` → `.branch-chip`; add `.branch-chip-menu .ctxmenu__item` where `.git-branch-menu__row` rows sit; `@media (forced-colors: active)` gives `.branch-chip__dirty` a `CanvasText` border), `test/unit/overlay-sites.test.ts` (ALL_FILES += `'branch-chip'`, `'repo-head'`, `'changes-view'`; the `it.each` ctxmenu list becomes `['commit-picker-menu', 'repo-picker-menu']` and a new `it('branch-chip renders its menu in a Popover')` asserts `/<Popover/` in `branch-chip.tsx` and no `className="ctxmenu` root in `branch-switcher-menu.tsx`), `test/unit/state-vocabulary.test.ts` (the comment at :151 names `.branch-chip`).
**Steps:**
- [ ] Proof: the slice's unit list + `npm run fallow:check` (no dead exports from the deletions) + `npm run typecheck`.

#### Task 6.5: Harness helpers + scripted entry-point swap
**Files:** Modify `test/e2e/harness.mjs` (`openHistory(page, { repo } = {})`: `openChangesTab`, click the `.branch-chip` inside the `.repo-head` whose `.repo-head__name` equals `repo` (first head when omitted), click the `View history` menuitem, wait for `.gh`; `openSession(page, { path, agentId = 'shell:cmd', roots })` posts `roots` when given), then run the Scripts §1 swap over: `review-card-collapse`, `review-commit-picker`, `review-commit-source`, `review-compact-header`, `review-compare`, `review-diff-syntax`, `review-keymap-persist`, `review-mode-pane`, `review-navigator`, `review-notes-handoff`, `review-row-pixels`, `review-search`, `review-tab-state`, `review-virtualize`, `middle-click-review`, `scoped-diff-tabs`, `split-diff-map`, `word-diff`, `theming-light`, `overlay-popovers`, `commit-detail-resize`, `commit-review-bounds`, `git-ref-dropdown` (all `test/e2e/<name>.e2e.mjs`).
**Steps:**
- [ ] `--dry`, review counts (each file's hits from the research table: 2 per wait+click pair); `--write`; `grep -n "git-indicator" test/e2e` shows only the files T6.6/T6.7 own.
- [ ] Run each swapped scenario serially.

#### Task 6.6: Hand-migrated scenarios (same or stronger)
**Files:** Modify `test/e2e/git-indicator.e2e.mjs` (branch/detached cases read `.repo-head__branch`→ the `.branch-chip` label; non-git → `No git repos` text and zero `.repo-head`; **add** AC1: `.doctabs` has no `.git-indicator`, `.repo-picker`, `.branch-chip` in each case; **add** AC11: a repo with a rebase in progress (`git rebase -i` is not allowed — create the state with a conflicting `git rebase <branch>` so `.git/rebase-merge` exists), a linked worktree (`git worktree add`) and a dirty file → chip text contains `REBASING`, the worktree name, a `.branch-chip__dirty`, and `aria-label` contains `REBASING`, `worktree <name>` and `uncommitted changes`), `test/e2e/git-band-persistence.e2e.mjs` (same docs open; after each, the Changes tab's `.changes__review` and `.branch-chip` are present and clickable, `.doctabs` has no git chrome; clicking `.changes__review` produces `.review`; keep the file name; header comment cites this spec), `test/e2e/branch-switch.e2e.mjs` (UI step via the chip menu; the four outcomes kept; **add** each `git:switchResult` carries `repoRoot` equal to the repo; the success announcement `Switched to feature` appears in `.branch-chip__live`), `test/e2e/multi-repo.e2e.mjs` (run the pin/Auto assertions with `changesView:'active'` set through `window.agentDeck.post({type:'updateSettings', …})` using `.repo-head__picker` and `.repo-picker-menu__row`; the old height-parity check becomes picker vs `.branch-chip` in the same head; History-follows via the History repo chip; keep the All-view case from S4), `test/e2e/review-entry-point.e2e.mjs` (clean tree: `.changes__review` visible in the Changes header and opens `/Nothing to review/`; with the pane collapsed (Ctrl+Shift+E) `Mod+Shift+R` opens Review; negative: `.doctabs` holds no Review/History control; header comment cites this spec and D18), `test/e2e/hunk-staging.e2e.mjs` (`openReview`; **add** a session opened with `roots: [attachedRepo]`, one hunk staged in the attached repo's file → `git -C attachedRepo diff --cached` holds that hunk and the home repo's index is unchanged), `test/e2e/git-history.e2e.mjs` (entry via `openHistory(page)`; the bg-alpha check moves to `.branch-chip`).
**Steps:**
- [ ] Run each serially.

#### Task 6.7: Visual and stress
**Files:** Modify `test/e2e/visual/shoot.mjs` (entries via `openReview`/`openHistory`; **add** a Changes-tab frame in the All view with two repos, per theme), `test/e2e/stress/git-changes-huge.stress.mjs` (`openReview`).
**Steps:**
- [ ] `npm run shots` produces the new frame in all three themes; check tag contrast ≥ 4.5:1 by eye against the token pairs (§10).

### Slice 7: New scenario `changes-multi-repo` + end-of-run sweep

**Check:** `node test/e2e/run-smoke.mjs changes-multi-repo`; `npm run verify` green; then the full e2e suite once, serially (`npm run test:smoke`).

**Parallel groups:** Serial: T7.1
**Claims (serial lane):** none beyond the new file

#### Task 7.1: `changes-multi-repo.e2e.mjs`
**Files:** Create `test/e2e/changes-multi-repo.e2e.mjs` (`runScenario`; temp `home` repo with modified `a.txt`, temp `ref` repo with staged `b.txt` and a `feature` branch, each with a distinct commit subject; `openSession(page, { path: home, roots: [ref] })`).
**Steps:**
- [ ] §7.3 Gherkin, step for step: no git controls in `.doctabs`; heads read `home`·`Home` then `ref`·`Attached`, each chip `main`; unstage `b.txt` under `ref` (via `changeRow(page, 'Staged', 'b.txt', { repo: 'ref' })` hover action) → `git -C ref status --porcelain` shows ` b.txt`-unstaged and `git -C home status --porcelain` is byte-identical to before; `openHistory(page, { repo: 'ref' })` → header `.gh__repo` reads `ref`, ref's subject present, home's absent; switch `ref` to `feature` via its chip → `git -C ref rev-parse --abbrev-ref HEAD` = `feature`, home's = `main`, ref's chip reads `feature` without a focus change.
- [ ] AC2: header `N changes · 2 repos +a -d` and the Changes badge equals N.
- [ ] AC3: `···` → `Active repo`; one head with `.repo-head__picker`; pick `ref` → `session.repoPinned` and the list swaps; `Show all repos` → two heads and `repoPinned` false (D15); set Active again, `closeApp`, relaunch on the same userData → one head.
- [ ] AC4: Discard on `a.txt` (confirm) → only `home` changes on disk; opening `ref`'s row opens a diff tab whose path is `ref/b.txt` (via `window.__docs` or the tab title + `data-tabid`).
- [ ] AC8: `.changes__sectionreview` count 0, exactly one `.changes__review`; after committing everything in both repos, clicking it opens Review's empty state.
- [ ] AC9: all clean with 2 repos → `All 2 repos are clean.`; a third attached clean repo added via `session:addRoot` → `All 3 repos are clean.`; a session on a non-git temp dir → `No git repos` / `None of this session's folders is a git repository.`; single-repo clean session → `The working tree is clean.`; killing every session → `No session` / `Start a session to see its changes here.`
- [ ] L11: in the All view the header `Discard all changes`, `Stash changes`, `Pop stash` are disabled with the per-repo title; the `ref` head's context menu offers them enabled.

## Verification

- Per task: the task's `npx vitest run <file>`; red observed before implementing. `tsc` is a
  slice-level check (a parallel group's type change can break a serial-lane file until that lane
  lands).
- Per slice: `npm run typecheck`, `npm run test:unit`, `npm run fallow:check`, `npm run build`,
  then the slice's e2e list one at a time (`node test/e2e/run-smoke.mjs <name>`), never in
  parallel.
- End of run: `npm run verify` green (exit code read directly), then the full smoke suite once,
  serially. `git status` shows only planned files; the swap script in `%TEMP%\claude-scratch` is
  deleted.

## Deviation rule

If a task's assumption turns out wrong — an mf-model export is missing or shaped differently, a
line reference moved, a locked signature doesn't fit — that task **stops** and fixing the
misaligned piece becomes the work. Never a shim, second copy, special case, widened type, alias
field, fallback, or an override patched in place of its semantic source. An e2e that fails after
the move is fixed at its selector or at the product, never by dropping or loosening an assertion.
The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **`GitActionIntent.repoRoots` and `runGitFanOut` are built here**, not in mf-review
  (mf-review §3.1 says "added by this item"). The Changes header's All-view Stage/Unstage all is
  their first caller and mf-changes builds first; mf-review consumes both unchanged. Shape and
  semantics are mf-review §2.6's (sequential, toast `Git (<name>): <error>` and continue, one
  refresh, `onGitAction` returns a Promise).
- [high] **L11 replaces spec D9 / §4:** no cross-repo discard confirm; header Discard/Stash/Pop
  disabled in All view with `Works on one repo. Right-click a repo header, or switch to Active
  repo.` (mf-review uses its own "Pick one repo…" titles on its surface).
- [high] **Home inside a repo but not at its root** (e.g. `repo/packages/foo`): `detectRepos` finds
  nothing, so Changes shows `No git repos` where today it lists the enclosing repo's changes via
  the cwd fallback. Default: spec §2.6 + L4 (no upward detection, mf-model D8). Reversed by
  mf-model adding upward detection; nothing here changes.
- [normal] AC4's "spy" is proven on disk per repo (git status of both repos) rather than by
  spying the `git-action` IPC; `spyMain` targets main-process APIs, not `ipcMain.handle` channels.
- [normal] Repo-set change → git refresh hangs off `setRepos` returning `boolean` at the one scan
  site, not a new folder-lifecycle hook (L12 S1 untouched).
- [normal] History's `repoRoot` is stamped at open time (`Mod+Shift+G`/palette use the active repo
  then), so auto-follow never silently retargets an open History.
- [normal] `BranchSwitcherMenu` becomes an inline `BranchSwitcherList` inside the chip's
  `Popover`; a nested `.ctxmenu` would be `position: fixed` inside a positioned popover.
  `overlay-sites` drops it from the ctxmenu list and gains a Popover assertion instead.
- [normal] `ChangesView`/`ChangeRow` move to `webview/components/changes-view.tsx` (right-pane.tsx
  is 1.9k lines and a shared claim with mf-files).
- [normal] The tab-row band survives through Slice 5 so each slice runs against a green e2e suite;
  it and the e2e migration land together in Slice 6.
- [normal] `refreshAllGit()` after `updateSettings` (`main.ts:2779`) stays; with the indicator
  setting gone it only costs one debounced refresh per settings save.
- [normal] Header `Stage all` / `Unstage all` titles reuse mf-review's copy (`Stage every changed
  file in N repos`, `Unstage every staged file in N repos`).
