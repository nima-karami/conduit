# Plan: Terminal path links v2

Spec: [2026-10-16-terminal-path-links.md](../specs/2026-10-16-terminal-path-links.md) (FULL).

**Tier: FULL.** The work spans the renderer link layer, the host resolver, the
`resolvePathToken` IPC seam and the New session entry. It adds a new picker and link menu, and
covers a 60-row edge-case matrix. Planned unattended, so every would-be question is in
`## Decisions Needed` with the default taken.

## Goal

When an agent prints a path, one gesture should reach the right target: the file at its line,
the folder, or a new session rooted there. That includes paths printed relative, truncated,
wrapped, quoted, in a tool header or behind OSC 8. When a relative path exists in several
repos, a ranked picker names each repo or worktree.

## Architecture

Detection stays pure in the renderer. It now works on **logical lines** (soft-wrapped rows
joined) and emits ordered alternative raws per token.

Resolution moves out of `electron/main.ts` into a host shell, `electron/path-link-resolver.ts`.
The shell binds a pure async resolver (`src/path-resolve.ts`) to:
- `fs.promises.stat` with concurrency 16;
- the existing `projectFileIndexMeta`;
- the memoised `repoTopLevel`.

The resolver tries the token against **every session root**. The pure root builder
(`src/path-link-roots.ts`) derives those roots from `Session.home/roots/repos/repoGit`. The
resolver dedupes to the deepest root and tags each candidate with its strength. Ranking is
pure and renderer-side, and runs **after** the cache, so session-local signals (last pick,
context root) never get cached. A new `PathCandidatePicker` replaces the multi-candidate
dropdown. A link-aware right-click menu prepends link actions to today's terminal menu.

OSC 8 and `file://` targets (v1) never become paths in the renderer. The renderer forwards the
raw URI, and the host decodes it and confines it against the session's roots (see the
security note under Contracts).

No sketches were made. Every new seam copies a sibling shape:
- the resolver DI follows today's `resolveToken(raw, ctx, stat)` (`src/path-resolve.ts:107`);
- the host shell follows `electron/repo-tracker-host.ts` (deps injected, no `electron` import
  in the testable part);
- the picker's filter and keyboard model follows `webview/components/commit-picker-menu.tsx`,
  and its frame is the existing `Popover` (`webview/components/popover.tsx:41`);
- the link menu builder follows `buildTerminalMenuItems` (`webview/term-menu.ts:39`).

## Data flow

```
xterm buffer rows ──provideLinks(y)──► buildLogicalLine(buffer, y)  [webview/terminal-logical-line.ts]
                                         {text, rowStarts}  (soft-wrap joined, ≤2000 chars)
        ▼
 detectUrlTokens / detectPathTokens(text, cwd)  [webview/terminal-links.ts]
        PathToken{alts[], start, end, line?, col?}  (first 10 by start; >1024 chars skipped)
        ▼
 resolveCache.get(tokens = alts.join('\0'), scope = cwd\0rootsSig)  [webview/terminal-token-cache.ts; TTL 30 s, generation]
        │ miss → post {type:'resolvePathToken', sessionId, requestId, tokens:[{alts}]}   (≤10 tokens, ≤4 alts)
        ▼
 main.ts case 'resolvePathToken' ──► pathLinks.resolve(session, tokens)  [electron/path-link-resolver.ts]
        buildResolveRoots(session, cwdGitRoot)  [src/path-link-roots.ts] → roots[] (userChosen flag), rootsSigOf(session)
        (the pane computes the same rootsSigOf(session) locally from center-pane → lookup scope)
        indexes: projectFileIndexMeta(cwdRoot) (composite union index when non-git) + each attached root
        resolveTokens(tokens, ctx, {stat, topLevel})  [src/path-resolve.ts]
           normalise (~, .., /c/, /mnt/c/, \)  [src/path-token-normalize.ts]
           exact-cwd → exact-root (every root) → suffix (indexes) ; dedupe deepest root ; repoRoot
        ▼ reply {type:'resolvePathTokenResult', sessionId, rootsSig, roots, results}
 reply {requestId, cwd (echo), rootsSig, roots, results} → resolveCache.settle(requestId, echoCwd\0rootsSig, values)
   (settles EVERY pending token of the batch; absent = miss, not cached; stale generation = not stored)
 terminal-pane: fsChanged covering a root → resolveCache.evictWhere(r => r.candidates.length === 0)
        ▼ 0 → plain · ≥1 → link (underline on hover)
 click ─► chooseClickAction(cands) ─► open | picker
           rankCandidates(cands, {roots, contextRootIdx (v1), lastPickRepoRoot})  [webview/path-candidate-rank.ts]
           PathCandidatePicker  [webview/components/path-candidate-picker.tsx + -model.ts]
        ▼ before open: probePathKind(abs)  [webview/path-probe.ts] → null ⇒ stale toast + cache evict
 onOpenFile / onRevealFolder (unchanged consumers) ; notePick(sessionId, repoRoot)  [webview/terminal-link-picks.ts]

 right-click ─► hoveredLinkRef ? buildLinkMenuItems(ctx) ++ buildTerminalMenuItems(ctx) : today's menu
   Open as new session ─► onOpenAsSession(home, sessionId, returnFocusEl) ─► app.tsx setNewSession({home, projectId})

 v1 OSC 8 / file:// ─► classifyLinkUri(uri)  [src/link-target.ts]
   'external' → openExternal (unchanged) · 'file' → post resolvePathToken {alts:[uri], target:'uri'}
     (at activate time, uncached)
   host: decodeFileUri (UNC/device refused) → confineToRoots(path, buildResolveRoots(…).abs)  [src/path-link-confine.ts]
         lexical first (no fs) → realpath under the SAME realpath'd root → 0 or 1 candidate (absPath = realpath)
   'ignore' → nothing
```

State ownership:
- **Host:** no new state. Roots are derived per request from `SessionManager`. The file
  indexes are the existing cache (`src/project-file-index.ts`, 64 entries, 5 s TTL).
  `repoTopLevel` keeps its existing 30 s memo (`electron/main.ts:882`).
- **Renderer, per pane:** the token cache, the current `rootsSig`, `hoveredLinkRef`, and the
  picker state.
- **Renderer, per session (module memory):** the last picked repo root. It survives a pane
  remount but not a restart.

## Settled decisions — do not re-litigate

- **An ambiguous click opens the picker** with the best candidate preselected, and nothing
  auto-opens. (Conductor ruling 1.)
- **An `exact-cwd` hit opens directly**, even when other candidates exist. **Show all matches**
  in the link menu lists the rest. (Spec §5.)
- **Context-root inference is in v1 as a ranking signal only**, never a silent auto-resolve.
  Slice 7 measures it on this machine's real transcripts. If the evidence fails the bar in
  Decisions, the key drops to a tie-breaker. (Ruling 2.)
- **OSC 8 file links set `allowNonHttpProtocols: true`**, behind a security review (Task 8.4).
  Every opened OSC 8 / `file://` target is confined host-side (realpath + `isInsideRoot`
  against one root). If the review cannot sign off, OSC 8 defers to v2. (Ruling 3.)
- **File → Open as new session** targets the file's `repoRoot`. **Dir** targets the folder.
  The action prefills the New session dialog and never launches. (Spec §5.)
- **The candidate cap is 200.** The filter shows at ≥ 9 candidates. Cache TTL is 30 s. The
  context window is 200 logical lines. (Spec §5.)
- **`activeRepoRoot` is not a ranking key** (spec §3.3).
- **Unquoted paths with spaces stay unlinked.** Absolute paths get the v1 extension of ≤ 3
  stats. Bare dir names without a slash stay unlinked. (Spec rows 38, 46.)
- **Nested-repo suffix search never fans `git ls-files` out** over the repos. It uses the
  engine's composite index, which already exists (see Spec staleness).

## Spec staleness

| Spec claim | Measured | How the plan proceeds |
|---|---|---|
| §2.1 Index: a non-git cwd uses `walkFilesAsync(root, 20000)`, which is not gitignore-aware and misses 8 of 26 `src/index.ts`. §3.2 says nested-repo suffix search "waits for the engine's union index" | The engine landed at HEAD. `projectFileIndexMeta` is `createProjectFileIndex({… repoIndex, reposUnder})` (`electron/main.ts:475`). For a `not-repo` root it builds the composite from `reposUnder(folderKey(root))` (`src/project-file-index.ts:42-86`, `src/repo-file-index.ts`) | Suffix search over the cwd root's index **is** the union index. Rows 3 and 42 (full) move into the MVP for free. No new index work |
| §2.1 "56 exts" | `FILENAME_EXTS` has 61 entries (`webview/terminal-links.ts:43-105`) | The allowlist becomes `FILENAME_EXTS ∪ {ext : langFromPath('x.'+ext) !== 'plaintext'}`, and `src/lang.ts` is unchanged |
| §2.3 step 5 "re-checks existence with the existing `pathExists` message" | The only renderer helper, `probePathExists` (`webview/path-probe.ts:17`), returns `false` for a directory | Add `probePathKind` beside it. `probePathExists` delegates to it, keeping its semantics |
| §3.4 "Return focus … (`newSessionReturnFocus`)" | It is set only by `startSessionForCard` (`webview/app.tsx:2039-2051`). The Explorer path never sets it | The terminal path sets it to the pane's xterm textarea before `setNewSession` |
| §3.2 the handler at `main.ts:4202`. §3.4 `explorer-menu.tsx:174`. §2.1 `terminal-pane.tsx` | `electron/main.ts:4214-4230`. `webview/explorer-menu.tsx:172-181`. The pane is `webview/components/terminal-pane.tsx` | Paths in this plan are the measured ones |
| §10 "extract the module-private `announce` in `webview/project-announcer.ts`" | `announce` drives the sidebar's project live region (`webview/project-announcer.ts:16-19`), a different surface | **Overturned.** Focus moves into the picker, so its accessible name ("3 matches for src/index.ts") is announced on open. No second producer for the sidebar region. See Decisions |
| §3.2 `ResolveCtx.index: RootedFile[]` | The index is per root (`ProjectFileIndexMeta.files`). Tagging every file with `rootIdx` copies ~20k objects per request | `ResolveCtx.indexes: Array<{rootIdx; files: IndexedFile[]}>`. Same information, no copy |
| `test/e2e/link-cwd.e2e.mjs:177-183` asserts `b-only.txt` (a sibling repo in the parent session) must NOT resolve | Spec EARS: "resolution shall try the token against every present root" | The assertion changes to: `b-only.txt` has no `exact-cwd` candidate, and its one candidate is `exact-root` in repo-b. The cwd-vs-pin intent is kept (Task 3.3) |

## Global constraints

- **Gate:**
  - `npm run verify` is the gate and the pre-commit hook. The inner loop is
    `npm run verify:quick`. One unit file: `npx vitest run test/unit/<name>.test.ts`.
  - Never narrow, skip or disable a check. Capture exit codes directly, never through `tail`.
- **Comments and fixes:**
  - Comments explain **why** only. When the why lives in the spec, the comment is a one-line
    pointer, e.g. `// see docs/specs/2026-10-16-terminal-path-links.md §3.2`.
  - No band-aids: no `as any`, `@ts-ignore`, swallowed errors, `!important` or magic offsets.
- **Platform-free unit tests.** CI runs on ubuntu.
  - `src/path-resolve.ts`, `src/path-token-normalize.ts`, `src/path-link-roots.ts` and
    `src/link-target.ts` are browser-safe. They import no `node:*` module. Path work is string
    work on forward-slashed input.
  - Platform comes in as `platform: 'win32' | 'posix'` and case as `caseSensitive: boolean`.
    Never read `process.platform` there.
  - Unit fixtures use forward-slash paths. Win32 forms are tested by passing
    `platform: 'win32'` with string fixtures like `G:/work/repoA`, never by running on win32.
- **Host and git:**
  - Git only through `runGit`/`runGitBin` (`src/git-exec.ts`). The resolver gets the toplevel
    through the injected `topLevel` (`repoTopLevel`, `electron/main.ts:882`).
  - No sync fs on the main thread in new code. Every stat is `fs.promises.stat`, including the
    `pathExists` handler from T4.1.
  - The one exception is `realPathLeaf` (sync `realpathSync.native`, `src/path-guard.ts:100`)
    in Slice 8's confinement. It runs once per click, never on resolve or hover, only after
    the lexical and UNC checks have passed. That matches the existing preview and write
    confinement.
  - Folder identity uses `folderKey` (`src/folder-key.ts:4`). Ancestry uses `isAncestorOf`
    (`src/owning-session.ts:82`) on keys normalised the same way.
- **Terminal (CLAUDE.md):**
  - Leave the `windowsPty` option on `new Terminal` (`webview/components/terminal-pane.tsx:232`)
    untouched.
  - Don't inject bytes into the terminal. Link work only reads the buffer.
- **Renderer:**
  - The picker portals to body through `Popover`, so it lives in the overlay stack.
  - New CSS class names are prefixed `pathpick` and never bare generics, per
    `test/unit/monaco-class-collision.test.ts`.
  - If an overlay can sit over `.topbar`, `test/unit/drag-region.test.ts` must stay green:
    give the overlay `-webkit-app-region: no-drag`.
  - Never name state after a DOM global (`open`, `name`, `status`, `event`). Write `pickerOpen`,
    `repoName`.
  - `confirm`, `alert` and `prompt` are lint-banned.
- **Naming:**
  - files are kebab-case beside their siblings;
  - pure cores go in `src/` (shared) or `webview/*.ts` (renderer-only), shells in `electron/`;
  - factories are `createX`, constants `SCREAMING_SNAKE`, types `PascalCase`;
  - tests are `test/unit/<module>.test.ts`;
  - user strings live in `webview/term-link-strings.ts` (`TERM_LINK_STR`), counts use
    `countNoun` (`src/menu-selection.ts:27`), and number formatting uses `Intl.NumberFormat`.
- **E2E:**
  - A scenario is a `test/e2e/<name>.e2e.mjs` using `runScenario` from `test/e2e/harness.mjs`.
    It launches only through the harness and ends only through `finishScenario`.
  - Terminal writes use `writeToTerminal(page, sessionId, data)` (`test/e2e/harness.mjs:1011`).
  - Clicks are **real** `page.mouse` moves and clicks at the link's cell. Copy the cell math in
    `test/e2e/terminal-osc8-link.e2e.mjs:84-120`.
  - Locally, run one scenario by exact name: `npm run e2e -- <name>`. The gated run is
    `npm run e2e:remote`, and any `electron/main.ts` edit means `--full`. Run serially.
  - Executors never run e2e or stress loops. The orchestrator does.
- **Changelog:** user-facing changes go in `CHANGELOG.md`, as the last task.

## Out of scope

- Spec Vision items:
  - Show in Files;
  - Ctrl+click on unlinked text to quick-open;
  - range selection for `:42-50`;
  - a launch-directly modifier.
- Remote/SSH paths, prose words, and changes to URL or commit detection (beyond precedence).
- Engine git-index mtime as ranking key 6. The engine doesn't expose it, so names order
  nested repos and worktrees (see Decisions).
- Wide-character cell mapping. A token's cell span equals its string offsets, as today (see
  Decisions).
- Confining **visible** absolute-path tokens. They open wherever they point, as today and per
  spec §4 "Absolute path outside every root → opens".
- The sidebar live region (see Spec staleness).

## Contracts

### `src/path-token-normalize.ts` (new, pure, browser-safe)

```ts
export type PathPlatform = 'win32' | 'posix';
export interface NormalizeCtx { platform: PathPlatform; homeDir: string /* forward-slashed */ }
/** Backslashes → '/', drive letter upper-cased on win32, `.`/`..` segments resolved,
 *  duplicate '/' collapsed (except a leading '//' UNC prefix), trailing '/' dropped (except a root). */
export function normalizeAbs(p: string, platform: PathPlatform): string;
/** `~` or `~/x` → homeDir[/x]; win32 `/x/…` (one-letter segment) and `/mnt/x/…` → `X:/…`;
 *  any other token unchanged. Returns forward-slashed, NOT yet normalised. */
export function expandToken(raw: string, ctx: NormalizeCtx): string;
export function isAbsoluteToken(p: string, platform: PathPlatform): boolean;  // '/x', 'X:/', '//server/share'
/** Segment-aware join then normalizeAbs. */
export function joinAbs(base: string, rel: string, platform: PathPlatform): string;
/** After folding '\' → '/': starts with '//' (covers '//host', '//?/', '//./', '\\?\UNC\', and
 *  '%5C%5C' once decoded). */
export function isUncLike(p: string): boolean;
```

Invariants:
- `/x/` and `/mnt/x/` map only when `platform === 'win32'`.
- On posix, `/c/foo` stays as it is.
- `normalizeAbs` never climbs above the root: `G:/../a` → `G:/a`, and `/../a` → `/a`.

### `src/path-link-roots.ts` (new, pure, browser-safe)

```ts
import type { Session, GitInfo } from './types';
export type ResolveRootKind = 'cwd-repo' | 'home' | 'attached' | 'nested' | 'worktree';
export interface ResolveRoot {
  abs: string;                 // forward-slashed, as stored on the session / RepoInfo.root
  kind: ResolveRootKind;
  name: string;                // worktreeName ?? last path segment of abs
  branch?: string;             // repoGit[abs].branch, worktrees only
  /** true for home, session.roots and session.repos lying under one of them; for 'cwd-repo' only
   *  when it lies inside a user root. The cwd can be moved by terminal output (OSC 9;9,
   *  trackCwd on by default, electron/main.ts:1519-1543), so a cwd-derived root is untrusted. */
  userChosen: boolean;
}
type SessionRootFields = Pick<Session, 'home' | 'roots' | 'repos' | 'missingRoots'>;
/** Order: cwd-repo (only when it is no other root) → home → attached (session.roots order) →
 *  nested + worktree (by name, localeCompare). Deduped by folderKey; kind precedence for one
 *  folder: worktree (repoGit[abs].isWorktree) > RepoInfo.tag > 'home' (=== session.home) >
 *  'attached' (∈ session.roots) > 'cwd-repo'. Missing roots (session.missingRoots) are skipped.
 *  Capped at REPO_SCAN_CAP + 2 by construction (repos is already capped). */
export function buildResolveRoots(
  session: SessionRootFields & Pick<Session, 'repoGit'>,
  cwdGitRoot: string,
  opts: { platform: PathPlatform; caseSensitive: boolean },
): ResolveRoot[];
/** The user-chosen roots only: home + present session.roots + session.repos[].root that lie
 *  under one of those (lexical, folded per opts). The ONLY input to confinement (Slice 8), UNC-root
 *  admission (resolver rule 2) and the cwd-report gate (T2.4). Never includes the cwd or its repo. */
export function userRootsOf(session: SessionRootFields, opts: { platform: PathPlatform; caseSensitive: boolean }): string[];
/** FNV-1a 32 hex over home, roots, repos[].root and missingRoots (sorted where order-free). Computed
 *  identically by the host (echoed in the reply) and by the pane from center-pane's session, so an
 *  attach / detach / nested-repo discovery changes the LOOKUP scope at once. repoGit is excluded. */
export function rootsSigOf(session: SessionRootFields): string;
```

### `src/path-resolve.ts` (rewritten, pure, browser-safe)

```ts
export interface IndexedFile { rel: string; abs: string }   // UNCHANGED; imported by src/file-search.ts,
                                                             // src/project-file-index.ts, src/repo-file-index.ts
export type CandidateStrength = 'exact-cwd' | 'exact-root' | 'suffix';
export interface PathCandidate {
  absPath: string;     // normalizeAbs'd
  rootIdx: number;     // index into the reply's roots; -1 = outside every root
  relToRoot: string;   // relative to roots[rootIdx].abs ('' for the root itself); absPath when -1
  repoRoot: string;    // see rules
  relToRepo: string;   // relative to repoRoot (Copy relative path)
  isDir: boolean;
  strength: CandidateStrength;
}
export interface TokenResolution {
  key: string;                 // alts.join('\0')
  candidates: PathCandidate[]; // host order: strength, then root order, then shorter relToRoot (renderer re-ranks)
  truncated: boolean;
  total: number;
  error?: 'timeout' | 'session-gone' | 'invalid';   // 'invalid' = this entry failed host validation
}
export type StatKind = (absPath: string) => Promise<'file' | 'dir' | null>;
export interface ResolveDeps {
  stat: StatKind;
  /** git toplevel of a folder, '' when not a repo (repoTopLevel). */
  topLevel: (dir: string) => Promise<string>;
}
export interface ResolveIndex {
  root: string;
  files: IndexedFile[];
  /** Root indices whose files this index lists completely (the index root itself unless the walk
   *  was capped, plus — for a non-git composite — every repo it unioned). */
  coveredRootIdx: number[];
}
export interface ResolveCtx {
  cwd: string;                 // live cwd, forward-slashed
  cwdGitRoot: string;          // sessionGitRoot(session)
  roots: ResolveRoot[];
  indexes: ResolveIndex[];
  caseSensitive: boolean;
  homeDir: string;
  platform: PathPlatform;
  cap?: number;                // DEFAULT_CANDIDATE_CAP = 200
}
export const DEFAULT_CANDIDATE_CAP = 200;
export const MAX_ALTS = 4;
/** True for '//host…', '//?/…', '//./…' after backslash folding (UNC and device namespaces). */
export function isUncLike(p: string): boolean;
export function resolveTokens(tokens: ReadonlyArray<{ alts: string[] }>, ctx: ResolveCtx, deps: ResolveDeps): Promise<TokenResolution[]>;
```

`isUncLike` lives in `src/path-token-normalize.ts` and is re-exported by `src/path-resolve.ts`.
`src/link-target.ts` and `src/path-link-confine.ts` consume it in Slice 8.

**Index memo:**

```ts
export interface IndexMemo { foldedRels: string[]; absSet: Set<string> }
export function memoFor(files: IndexedFile[], caseSensitive: boolean): IndexMemo;
```

- It is backed by a module-level `WeakMap<IndexedFile[], IndexMemo>`, with one map per case
  mode.
- It is built once per index **array object**. The host's 5 s index cache returns the same
  array while it is warm, so repaints never re-fold 20k paths.
- The resolver is its only production caller.

Rules per token. Try each alt in order and stop at the first alt that yields ≥ 1 candidate.
1. `t = expandToken(alt)`.
2. **UNC and device paths** (`isUncLike(normalizeAbs(t))`):
   - **Never stat them** at resolve or hover time.
   - Lexically under a root with `userChosen === true` whose `abs` is itself UNC (case-folded on
     win32): one `exact-cwd` candidate with `isDir = t.endsWith('/')`. That value is a guess for
     the icon only, because the click probe decides the real kind.
   - A `cwd-repo` root that is not user-chosen never admits a UNC token.
   - Anything else gives no candidates: the token is not linked.
3. **Absolute** (`isAbsoluteToken`): stat `normalizeAbs(t)`.
   - A hit gives one candidate, `strength:'exact-cwd'`. An absolute path is what was asked
     for, so it opens directly (today's rule 1).
   - A miss gives no candidates. Elision is the exception (rule 6).
4. **Relative, exact:**
   - Stat `joinAbs(cwd,t)`, then `joinAbs(cwdGitRoot,t)` when the git root differs. That is at
     most 2 stats, which keeps a file created < 5 s ago linkable (row 53). A hit gives
     `exact-cwd`, which ends that alt's exact phase.
   - **UNC cwd:** these joins are UNC only when the cwd itself is UNC. The cwd-report gate
     (T2.4) only lets the cwd move to a UNC path under a UNC **user** root, so a UNC cwd is
     always user-chosen.
     - The host's stat wrapper races every `isUncLike` path against `UNC_PROBE_BUDGET_MS`
       (500 ms), so an offline share delays only its own token.
     - That timeout counts as a miss.
   - Otherwise, for every other root, in order:
     - **file tokens** under a root some index covers are checked by **membership** of
       `joinAbs(root.abs,t)` (folded) in that index's `absSet`, with no stat;
     - **dir tokens** (trailing `/`), and roots no index covers, are stat'ed, except a UNC root,
       which is never stat'ed (rule 2);
     - every hit gives `exact-root`.
5. **Relative, suffix:** runs only when step 4 found nothing.
   - Segment-aligned suffix match over every index's memoised `foldedRels` (today's
     `rel === needle || rel.endsWith('/'+needle)`). Case-folded unless `caseSensitive`.
   - Files only (`isDir:false`). `strength:'suffix'`.
6. **Elision:**
   - A segment equal to `...` or more dots, or equal to `…`, is an elision. Suffix-search the
     tail after the **last** elision.
   - If the head before the first elision is absolute, keep only candidates whose `absPath` is
     under `normalizeAbs(head)` (row 35).
   - If the first tail segment **began** with `…` (e.g. `…rc/util/a.ts`), that segment matches
     as a segment suffix (row 36).
7. **Dedupe** by `absPath` (case-folded unless `caseSensitive`):
   - keep the strongest strength;
   - `rootIdx` = the deepest root whose `folderKey` `isAncestorOf` the path;
   - `relToRoot` is recomputed from that root.
8. **`repoRoot`:**
   - The deepest root of kind `cwd-repo | nested | worktree | attached | home` containing the
     path, **if** `deps.topLevel(root.abs) !== ''` for that root (memoised per call).
   - Else `deps.topLevel(containing folder)` (a file's parent folder, or a dir itself).
   - Else the containing folder.
   - `relToRepo` is relative to it.
9. Sort by strength, then `rootIdx` (-1 last), then `relToRoot.length`, then `localeCompare`.
   Set `total` = count and `truncated = total > cap`, then slice to `cap`.

Errors: `resolveTokens` never rejects. A throwing `stat` or `topLevel` counts as a miss or as
''. The host shell adds `error`.

### `electron/path-link-resolver.ts` (new host shell; no `electron` import)

```ts
import type { Session } from '../src/types';
export interface PathLinkResolverDeps {
  getSession(id: string): Session | undefined;
  gitRoot(session: Session): Promise<string>;              // sessionGitRoot(session, git)
  /** projectFileIndexMeta(root).files plus `.covered` (T3.4): exactly the roots whose listing was
   *  `kind:'listed'` (git ls-files answered) AND not capped — the git root itself, or, for a non-git
   *  composite, each unioned repo that individually satisfied that rule (the loose non-git walk
   *  never counts). Every other root falls back to stat. */
  fileIndex(root: string): Promise<{ files: IndexedFile[]; coveredRoots: string[] }>;
  /** fs.promises.stat → kind; an isUncLike path is raced against UNC_PROBE_BUDGET_MS (timeout → null).
   *  The SAME wrapper serves resolve and probe. */
  stat(abs: string): Promise<'file' | 'dir' | null>;
  topLevel(dir: string): Promise<string>;                  // repoTopLevel
  homeDir: string; platform: PathPlatform; caseSensitive: boolean;
  // Slice 8 adds: realPathLeaf(t: string): string   (src/path-guard.ts:100, forward-slashed)
}
export interface PathLinkReply {
  cwd: string;                 // the live cwd this reply resolved against (forward-slashed)
  rootsSig: string; roots: ResolveRoot[]; results: TokenResolution[];
}
export interface PathLinkResolver {
  /** Never rejects. Unknown session → {cwd:'', rootsSig:'', roots:[], results: one {key, error:'session-gone'} per entry}. */
  resolve(sessionId: string, tokens: unknown): Promise<PathLinkReply>;   // validated here (see below)
  /** Added in Task 4.1 (its first caller). Click-time existence probe behind the `pathExists` handler: fs.promises.stat;
   *  a UNC-like path races UNC_PROBE_BUDGET_MS and counts as null on timeout. */
  probe(abs: string): Promise<'file' | 'dir' | null>;
}
export const STAT_CONCURRENCY = 16;
export const MAX_TOKENS = 10;
export const UNC_PROBE_BUDGET_MS = 500;
export function createPathLinkResolver(deps: PathLinkResolverDeps): PathLinkResolver;
```

- **Indexes:**
  - `fileIndex(cwdGitRoot)` (or the cwd itself when not a repo), plus one per root of kind
    `attached`. Requests run in parallel. `coveredRoots` map to `coveredRootIdx` through
    `folderKey`.
  - Nested repos are never indexed one by one. The cwd root's composite index already covers
    them.
- **Stats:**
  - A private `withConcurrency(limit)` wrapper is shared by every stat in one `resolve` call.
  - Exact-root answers come from index membership. Stats are only:
    - the ≤ 2 exact-cwd joins;
    - absolute tokens;
    - dir tokens;
    - roots no index covers.

    The worst case is `(2 + uncoveredRoots) × MAX_ALTS × MAX_TOKENS`.
  - UNC absolute tokens are never stat'ed in `resolve` (resolver rule 2). The only UNC stats are
    the exact-cwd joins under a user-chosen UNC cwd, raced against the budget.
- **Validation is per token** (trust boundary, renderer to host). The renderer is never
  trusted for limits.
  - A non-array `tokens` is treated as `[]`.
  - Only the first `MAX_TOKENS` entries are used; the rest are **truncated**, with no result.
    The renderer settles them as misses (cache contract).
  - An entry whose `alts` is not an array of strings, or is empty, yields
    `{key:'', candidates:[], truncated:false, total:0, error:'invalid'}`.
  - In a valid entry, `alts` is cut to its first `MAX_ALTS` (4), and each alt longer than 1024
    chars is dropped. The result's `key` stays the **original** `alts.join('\0')`, because
    that is the renderer's pending token. If no alt survives, the entry is `'invalid'` with
    `key = original alts.join('\0')` when computable.
  - The other entries resolve normally.
- There is no `target` field before Slice 8. Slice 8 adds it to the protocol and to this
  interface together, along with the decode + confine branch.

### `src/protocol.ts` (claimed)

```ts
// WebviewToHost — replaces L1107
| { type: 'resolvePathToken'; sessionId: string; requestId: number; tokens: Array<{ alts: string[]; target?: 'uri' }> }
// HostToWebview — replaces L752
| { type: 'resolvePathTokenResult'; sessionId: string; requestId: number; cwd: string;
    rootsSig: string; roots: ResolveRoot[]; results: TokenResolution[] }
```

The handler always replies, including for an unknown session, a validation failure or a thrown
error. A thrown error gives `results: []` with the same `requestId`, so the renderer can settle
every pending key of that batch.

`target?: 'uri'` is added in Slice 8, not Slice 3, so no field exists before its caller.
`TokenResolution` and `ResolveRoot` are imported as types from `./path-resolve` and
`./path-link-roots`.

### Renderer detection (`webview/terminal-links.ts`, modified)

```ts
export interface PathToken {
  raw: string;          // === alts[0]
  alts: string[];       // 1..MAX_ALTS (4) raws to try, in order (MVP detection emits ≤ 2; row 40 in T9.1 emits 4)
  line?: number; col?: number;
  start: number; end: number;   // 0-based offsets in the LOGICAL line; end exclusive
}
export function detectPathTokens(line: string, activeCwd: string | undefined): PathToken[]; // signature unchanged
export const MAX_LOGICAL_LINE = 2000;
export const MAX_PATH_TOKENS = 10;
export const MAX_TOKEN_LENGTH = 1024;
```

- The `path` field is removed. Its only consumer was the pane, and the host resolves now.
- The rules are the spec §3.1 list, each pinned by a test row (Task 1.1).
- When a relative token's `activeCwd` is falsy, the token is skipped, as today.

### `webview/terminal-logical-line.ts` (new, pure)

```ts
export interface BufferLike {
  length: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}
export interface LogicalLine { text: string; firstRow: number; rowStarts: number[] /* text offset where each row begins */; cols: number }
/** y is 0-based. Walks up while row y is wrapped, down while row y+1 is wrapped. Non-last rows
 *  are read untrimmed (full `cols` width); the last row trimmed. Returns null when text > MAX_LOGICAL_LINE. */
export function buildLogicalLine(buf: BufferLike, y: number, cols: number): LogicalLine | null;
/** Offsets → xterm 1-based inclusive range. */
export function toBufferRange(ll: LogicalLine, start: number, end: number):
  { start: { x: number; y: number }; end: { x: number; y: number } };
```

### Cache (`webview/terminal-token-cache.ts`, modified)

```ts
export function createTerminalTokenCache<T>(
  request: (batch: { id: number; tokens: string[] }) => void,
  opts: {
    capacity: number; timeoutMs: number; ttlMs?: number; now?: () => number;
    /** Negative answers (path cache: 0 candidates) live at most `ttlMs` (pane passes
     *  FILE_INDEX_TTL_MS = 5000, src/project-file-index.ts:11) and are the only values a
     *  stale-generation settle drops. */
    negative?: { is: (value: T) => boolean; ttlMs: number };
  },
): {
  /** Looks up `scope + '\0' + token`; requests the misses as ONE batch (tokens = the bare tokens). */
  get(tokens: string[], scope?: string): Promise<Map<string, T>>;
  /** Batch reply: stores each value under `replyScope + '\0' + token`, then settles EVERY pending
   *  token of batch `id`. A token absent from `values` resolves as absent and is not cached. If the
   *  cache generation moved since the batch was sent, the waiters settle, positive values are
   *  still stored, and only negative values (`negative.is`) are dropped. */
  settle(id: number, replyScope: string, values: Map<string, T>): void;
  /** Unbatched reply (commit cache only, as today): store + settle by token, scope ''. */
  resolve(token: string, value: T): void;
  evict(token: string, scope?: string): void;
  evictWhere(pred: (value: T) => boolean): void;   // drops matches AND bumps the generation
  clear(): void;   // drops values AND bumps the generation
  dispose(): void;
};
```

- A `ttlMs` entry older than its TTL is a miss.
- **Generation:** `clear()` and `evictWhere()` both increment a counter that each batch records
  when it is sent. A `settle` for an older generation **drops its negative answers and stores
  its positive ones**.
  - The invalidation that matters, `fsChanged` evicting misses, is about files that appeared.
    A stale "not there" must not be re-cached, but a found candidate stays valid, because the
    click probe catches deletions (row 55).
- **Negative TTL:** a 0-candidate entry expires after `FILE_INDEX_TTL_MS` (5 s), even with no
  `fsChanged`. That bounds a miss to the same staleness as the host's index. Positive entries
  keep `ttlMs` (30 s).
- **Path scope** = `cwd + '\0' + rootsSig`:
  - for lookups, the pane's `cwdRef`, plus a `rootsSig` the pane computes **locally** with
    `rootsSigOf` from a new `rootsSig` prop. center-pane passes
    `rootsSig={rootsSigOf(s)}` for each session, memoised on
    `s.home/s.roots/s.repos/s.missingRoots`;
  - for stores, the reply's **echoed** `cwd` and host-computed `rootsSig` (the same function
    over the same session fields).

  An attach, detach, nested-repo discovery or root going missing therefore changes the lookup
  scope on the next `state` render: a miss, then fresh resolution. A reply that resolved against
  a different cwd or roots than the renderer assumed is stored under what it actually used.
- Tokens are `alts.join('\0')`. The pane keeps a `Map<batchId, Map<token, alts>>` to build the
  request.
- **Timeouts** still settle as absent (today's behaviour), so a lost reply never wedges a
  token.
- The commit cache passes no `ttlMs` and no scope, and uses `resolve`, so it keeps today's
  behaviour.

### Ranking (`webview/path-candidate-rank.ts`, new, pure)

```ts
export interface RankInputs {
  roots: readonly ResolveRoot[];
  contextRootIdx?: number;     // Slice 7; undefined in MVP
  lastPickRepoRoot?: string;
}
export type RankKey = 'strength' | 'context' | 'lastPick' | 'rootGroup' | 'rootOrder' | 'shorter';
/** Slice 7 may move 'context' to just before 'shorter' (tie-breaker); nothing else reorders. */
export const RANK_KEYS: readonly RankKey[] = ['strength', 'context', 'lastPick', 'rootGroup', 'rootOrder', 'shorter'];
export function rankCandidates(cands: readonly PathCandidate[], inputs: RankInputs): PathCandidate[];
export type ClickAction = { kind: 'none' } | { kind: 'open'; cand: PathCandidate } | { kind: 'pick' };
/** any 'exact-cwd' → open it; exactly 1 candidate → open; 0 → none; else pick. */
export function chooseClickAction(cands: readonly PathCandidate[]): ClickAction;
```

The keys:
- `strength`: `exact-cwd` > `exact-root` > `suffix`.
- `context`: the candidate's `rootIdx === contextRootIdx`.
- `lastPick`: the candidate's `folderKey(repoRoot) === folderKey(lastPickRepoRoot)`.
- `rootGroup`: home and cwd-repo = 0, attached = 1, nested and worktree = 2, outside (-1) = 3.
- `rootOrder`: `rootIdx` ascending. The host already ordered attached by add order and
  nested/worktree by name.
- `shorter`: `relToRoot.length`, then `localeCompare`.

The sort is stable and never mutates its input.

### Picker model (`webview/components/path-candidate-picker-model.ts`, new, pure) + component

```ts
export const FILTER_THRESHOLD = 9;
export interface PickerRow {
  cand: PathCandidate;
  repoName: string;            // roots[rootIdx].name, or last segment of repoRoot when rootIdx === -1
  tag: 'home' | 'attached' | 'nested' | 'worktree' | null;   // cwd-repo / outside → null
  branch?: string;
  accessibleName: string;      // `${repoName} / ${relToRoot}`
  workingHere: boolean;        // rootIdx === contextRootIdx (Slice 7)
}
export function pickerRows(ranked: readonly PathCandidate[], roots: readonly ResolveRoot[], contextRootIdx?: number): PickerRow[];
export function filterRows(rows: readonly PickerRow[], query: string): PickerRow[];  // case-insensitive substring of accessibleName
export function pickerHeading(token: string, total: number, action?: LinkMenuAction): string;
// webview/components/path-candidate-picker.tsx
export type PickerMode = { kind: 'open' } | { kind: 'action'; action: LinkMenuAction };
export interface PathCandidatePickerProps {
  at: { x: number; y: number };
  token: string;               // display text of the link
  rows: PickerRow[];
  total: number; truncated: boolean;
  mode: PickerMode;
  onPick(row: PickerRow, how: 'foreground' | 'background'): void;   // background = middle-click, files only
  onSearchAll(query: string): void;                                 // "Search all files…" (truncated only)
  onClose(): void;                                                  // returns focus to the terminal
}
export function PathCandidatePicker(props: PathCandidatePickerProps): JSX.Element;
```

Picker behaviour:
- It renders in a `Popover at={at}`.
- **Roles and naming:**
  - The list is `role="listbox"` with `role="option"` rows and `aria-activedescendant`.
  - At ≥ `FILTER_THRESHOLD` rows, a filter `<input role="combobox" aria-controls=…>` is
    focused. Otherwise the listbox is focused, and its `aria-label` is `pickerHeading(…)`.
- **Keys:**
  - ↑ ↓ Home End move, and Enter picks.
  - Esc clears a non-empty filter first, then closes. Use the `Popover` `onEscape` prop.
- **Rows:**
  - Row 0 is preselected.
  - A dir row's middle-click does nothing.
  - The truncated footer reads "Showing 200 of N" (`Intl.NumberFormat`), with a "Search all
    files…" row.
  - An empty filter shows "No matches for "q"".
- A worktree tag is a picker-local
  `<span class="repo-head__tag repo-head__tag--worktree">`. Other tags use `RepoTagPill`
  (`webview/components/repo-picker-menu.tsx:23`). `RepoTag` is **not** widened.

### Link menu (`webview/term-menu.ts`, additive)

```ts
export type LinkMenuAction = 'open' | 'showAll' | 'copyPath' | 'copyRelativePath' | 'reveal' | 'openAsSession';
export interface LinkMenuContext {
  target: 'file' | 'dir' | null;   // null = ambiguous (chooseClickAction → pick)
  matchCount: number;              // total
  openAsSessionHint?: string;      // "in <project>"
}
export interface LinkMenuItemSpec { id: LinkMenuAction; label: string; hint?: string; separatorBefore?: boolean }
export function buildLinkMenuItems(ctx: LinkMenuContext): LinkMenuItemSpec[];
```

Order:
1. Primary:
   - file: `open`, then `showAll` when `matchCount > 1`;
   - dir: `showAll` only when `matchCount > 1`;
   - ambiguous: `showAll`.
2. Reference: `copyPath`, `copyRelativePath`, `reveal`. The first one is `separatorBefore`
   when Primary is non-empty. When ambiguous, each has hint `countNoun(n,'match','matches')`.
3. Session: `openAsSession`, `separatorBefore`. Its hint is `openAsSessionHint`, or the count
   when ambiguous.

The pane appends `buildTerminalMenuItems(...)` with `separatorBefore: true` on the first of
those items.

### Pane, center pane and app props (claimed files)

```ts
// webview/components/terminal-pane.tsx — new optional props
onOpenAsSession?: (home: string, originSessionId: string, returnFocus: HTMLElement | null) => void;
openAsSessionHint?: string;
onSearchAllFiles?: (query: string) => void;
// webview/components/center-pane.tsx — new optional props, forwarded per session
onOpenAsSessionFromTerminal?: (home: string, originSessionId: string, returnFocus: HTMLElement | null) => void;
openAsSessionHintFor?: (sessionId: string) => string | undefined;
onSearchAllFiles?: (query: string) => void;
```

In `webview/app.tsx`:
- `onOpenAsSessionFromTerminal` sets `newSessionReturnFocus.current = returnFocus`, then
  `setNewSession({ home, projectId: sessions.find(s => s.id === originSessionId)?.projectId ?? null })`.
- `openAsSessionHintFor(id)` returns `in ${projectName}` for that session's project, built
  like `webview/app.tsx:2053-2054`.
- `onSearchAllFiles(q)` calls `setPalette({ initialQuery: q })`.

### `webview/path-probe.ts` (additive)

```ts
/** 'file' | 'dir' on an existing path, null on a miss or no reply by timeoutMs. */
export function probePathKind(path: string, transport?: ProbeTransport, timeoutMs?: number): Promise<'file' | 'dir' | null>;
// probePathExists(p) ≡ (await probePathKind(p)) === 'file'   (semantics unchanged; app.tsx:245 caller unchanged)
```

### `webview/terminal-link-picks.ts` (new, renderer module state)

```ts
export function notePick(sessionId: string, repoRoot: string): void;
export function lastPick(sessionId: string): string | undefined;
```

### v1 context root (`webview/terminal-context-root.ts`, new, pure; Slice 7)

```ts
export const CONTEXT_WINDOW_LINES = 200;
/** linesAbove: logical lines above the token, NEAREST FIRST (≤ CONTEXT_WINDOW_LINES).
 *  Signals, per line, in order: `cd <dir>` / `cd "<dir>"` / `Bash(cd <dir> && …)` / `git -C <dir>`,
 *  then any absolute path token (detectPathTokens). The first line with a signal whose path is
 *  under some root wins → the deepest such root's index. A relative `cd` resolves against the
 *  previous signal's dir or the cwd. undefined when no signal. */
export function inferContextRoot(linesAbove: readonly string[], roots: readonly ResolveRoot[],
  ctx: { cwd: string; platform: PathPlatform; caseSensitive: boolean }): number | undefined;
```

### v1 OSC 8 / `file://` (Slice 8)

```ts
// src/link-target.ts (new, pure, browser-safe)
export type LinkUriClass = 'external' | 'file' | 'ignore';
/** http/https/mailto → external; file: → file; scheme-less absolute ('/x', 'X:/', 'X:\\') → file;
 *  a scheme-less UNC/device form ('\\host', '//host', '\\?\…', '\\.\…') → ignore;
 *  everything else (javascript:, data:, vscode:, custom, relative) → ignore. */
export function classifyLinkUri(uri: string): LinkUriClass;
/** Hand-parsed (never `new URL`, which collapses `..` — ADR 0005 §4). Accepts `file:///X:/…`,
 *  `file:///abs`, `file://localhost/…`, and scheme-less absolute. Percent-decodes ONCE.
 *  Returns null for:
 *    - a decoded NUL;
 *    - an authority other than '' / 'localhost' (no UNC via `file://host/`);
 *    - a non-absolute result;
 *    - any path that is `isUncLike` either right after decoding OR after normalizeAbs. This covers
 *      `file:////host/x`, `file:///%5C%5Chost/x`, `file:///%5C%5C?%5CUNC%5C…`, `\\?\…`, `\\.\…`
 *      and a bare `\\host`. `\\?\G:\root\x` (scheme-less) is refused the same way, never
 *      unwrapped to `G:/root/x`.
 *  Strips a `#L42` / `:l[:c]` suffix into line/col. Returns forward-slashed and normalizeAbs'd. */
export function decodeFileUri(uri: string, platform: PathPlatform): { path: string; line?: number; col?: number } | null;

// src/path-link-confine.ts (new, host-only; default realPathLeaf from src/path-guard.ts:100)
export interface ConfineDeps {
  realPathLeaf: (t: string) => string;   // forward-slashed result
  platform: PathPlatform; caseSensitive: boolean;
}
/** Order of checks:
 *    1. isUncLike(abs) → null;
 *    2. LEXICAL: the deepest root R with normalizeAbs(abs) under normalizeAbs(R) (case-folded unless
 *       caseSensitive; pure string, no fs) — none → null. Steps 1–2 never touch the fs;
 *    3. real = realPathLeaf(abs), realRoot = realPathLeaf(R); real must be under realRoot (the SAME
 *       R — ADR 0005 §3 amended 2026-09-30); isUncLike(real) → null.
 *  Returns { root: R, real } or null. Callers open `real`, never `abs`. */
export function confineToRoots(abs: string, roots: readonly string[], deps: ConfineDeps): { root: string; real: string } | null;
```

Host branch for `target:'uri'` (Slice 8). It runs **at activate time, uncached**: the renderer
sends one request per click, with no `resolveCache` entry.
1. `decodeFileUri(alts[0])`.
2. `confineToRoots(path, userRootsOf(session, opts), …)`, the **user-chosen roots only**: home,
   `session.roots`, and `session.repos` under them. The cwd's repo counts only when it lies
   inside one of those (it is then already covered by its enclosing user root). It is **never**
   the cwd-derived root. That differs from the resolver's display roots on purpose: the cwd can
   be moved by terminal output (OSC 9;9).
3. A `stat(real)` hit becomes one `exact-cwd` candidate with `absPath = real`, plus line/col
   echoed in a new optional `TokenResolution.line?/col?`.
4. Any refusal gives zero candidates, logged once per token at `log.debug('links', 'uri-refused', {reason})`.
   Refused inputs never reach `stat` or `realPathLeaf` (steps 1–2).

The renderer:
- never calls `openExternal`, `shell.openPath` or `window.open` for a `file`-class URI;
- for an `external` URI, keeps today's call (`webview/components/terminal-pane.tsx:244`).

**Security note** (input to Task 8.4):
- Today the renderer can already `readFile` any path (`electron/main.ts:2873-2882`,
  deliberately unguarded because it is click-triggered).
- The widening is that **untrusted terminal output can now choose a hidden target** (OSC 8
  label ≠ URI). Confinement is therefore enforced where the URI becomes a path, in the host, and
  the renderer only opens host-returned candidates.
- A compromised renderer gains nothing it lacked before.
- **`readGrants` consequence:** a successful `readFile` adds the path to `readGrants`
  (`electron/main.ts:2873-2882`; it gates later writes).
  - Opening an OSC 8 target therefore makes it **savable**.
  - Only confined realpaths may ever reach `readFile` through this path, so the grant can never
    land outside a session root.
- `revealInExplorer` on a returned dir goes through `revealActionFor` (`src/reveal-action.ts:21`),
  so a file never reaches `shell.openPath`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Path tokens (alts, logical spans) | `detectPathTokens` + `buildLogicalLine` | `terminal-pane.tsx` provider | both |
| `resolvePathToken` request/reply shape | `terminal-pane.tsx` / `electron/main.ts:4214` → `path-link-resolver` | host / pane; **also** `test/e2e/terminal-path-links.e2e.mjs:17-30` and `test/e2e/link-cwd.e2e.mjs:161-184`, which post and read the raw IPC | all four (Task 3.3) |
| `PathCandidate`/`TokenResolution` types | `src/path-resolve.ts` | `src/protocol.ts:12,752`, `terminal-pane.tsx:6`; `IndexedFile` (unchanged) by `src/file-search.ts:4`, `src/project-file-index.ts:4`, `src/repo-file-index.ts:4`, `test/unit/file-search.test.ts:6` | both; `IndexedFile` is kept byte-identical |
| Roots list | `Session.home/roots/repos/repoGit/missingRoots` (SessionManager, repo scan, tracker `mergeRepoGit`) | `buildResolveRoots` | consumer only. The producers are read-only and unchanged. The resolver reads `mgr.get(id)` per request, so no caching gets stale |
| Per-root file index | `projectFileIndexMeta` (`electron/main.ts:475`) over `src/project-file-index.ts` + `src/repo-file-index.ts` | resolver, quick-open, search, TS index, `test/e2e/index-repo-set.e2e.mjs` | both. T3.4 adds `covered`/`coveredRepos` additively and no existing field changes, so the other consumers are unaffected. It is called for the cwd root plus attached roots: today's call plus ≤ a few, inside the 64-entry cache |
| Terminal-reported cwd (OSC 9;9) | `CwdScanner` (`src/osc-cwd.ts:129`) via `electron/main.ts:1519-1543` | `mgr.setCwd` / `setAutoRepo` → `Session.cwd` → resolver exact-cwd joins, `sessionGitRoot`, Files/Changes re-root | both. T2.4 gates the producer side. `setCwd`/`setAutoRepo` are unchanged, and an accepted cwd is identical to today's except it is no longer sync and a UNC report outside a UNC user root is refused |
| Token cache batches/scope/TTL/generation | `createTerminalTokenCache` (T3.0) | pane path cache + commit cache (`terminal-pane.tsx:346-350`) | both. The commit cache uses `batch.tokens` + `resolve` with no `ttlMs` or scope, so its behaviour is unchanged |
| `resolvePathTokenResult.requestId` / `cwd` echo | host handler (T3.2) | pane `settle` (T3.3); e2e matchers (T3.3) | both |
| `fsChanged` | host `broadcastFsChanged` (`electron/main.ts:~2208`) | **new** pane subscriber (clears the path cache when `folders` covers a root); existing `folder-section.tsx:365`, `use-change-markers.ts:289` | consumer only. The message is unchanged and the new subscriber only reads it |
| Existence re-check | host `pathExists` (`electron/main.ts:4196`). It becomes async via `pathLinks.probe` in T4.1, with the reply shape unchanged | `probePathKind` (new), `probePathExists` → `app.tsx:245` (nav-history reopen) | both. `probePathExists` semantics are pinned by a test. The reply is still correlated by echoed path, so async ordering is harmless |
| Link menu items | `buildLinkMenuItems` | pane `openContextMenu` (`terminal-pane.tsx:854`) | both. `buildTerminalMenuItems` is unchanged (`test/unit/term-menu.test.ts` stays green) |
| Hovered link | provider `hover`/`leave` + OSC 8 `linkHandler.hover` | `openContextMenu`, `suppressLinkMiddleDown` (`terminal-pane.tsx:205`) | both. `linkHoveredRef` becomes `hoveredLinkRef`, and `suppressLinkMiddleDown` reads `!== null` |
| New session prefill | terminal link menu → `app.tsx` | `NewSessionModal` / `seedNewSession` (`src/new-session-seed.ts:89`) | producer only. It uses the existing `NewSessionPrefill {home, projectId}` shape, which Explorer already sends (`app.tsx:430`) |
| `newSessionReturnFocus` | board-card path (`app.tsx:2040-2051`) + **new** terminal path | `onClose` (`app.tsx:4552-4556`) | both. The consumer is unchanged |
| Open file / reveal | picker / link | `openTerminalFileLink` (`app.tsx:2514`), `revealInExplorer` (`app.tsx:4335`) | producer only. Signatures are unchanged |
| Quick open prefill | picker "Search all files…" | `setPalette` (`app.tsx:454`) | producer only. It uses the existing state shape |
| xterm `linkHandler` dispatch (v1) | xterm OSC 8 | `classifyLinkUri` → `openExternal` (unchanged) / host `uri` branch | both. `test/e2e/terminal-osc8-link.e2e.mjs` pins https (row 22) |
| Regex `file://` URLs (v1) | `detectUrlTokens` (`terminal-links.ts:237`) | pane URL-link `activate` | consumer only. Detection is unchanged and only its activate dispatch changes |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/terminal-links.ts` | modify | Alts, suffix formats, strip rules, `…` elision, diff-header strip, extensionless + registry allowlist, limits; drop `PathToken.path` |
| `webview/terminal-logical-line.ts` | create | Join soft-wrapped rows; offsets ↔ buffer ranges (v1: Ink hard-wrap heuristic) |
| `src/path-token-normalize.ts` | create | `~`, `.`/`..`, `\`, `/x/`, `/mnt/x/` normalisation (platform injected) |
| `src/path-link-roots.ts` | create | Session → ordered, deduped `ResolveRoot[]` (with `userChosen`), `userRootsOf`, `rootsSigOf` |
| `src/cwd-report-gate.ts` | create (T2.4) | Gate for terminal-reported cwds: UNC refusal without fs, async stat, newest-report-wins |
| `test/unit/cwd-report-gate.test.ts` | create (T2.4) | Refusal, async accept, ordering, drop |
| `test/e2e/cwd.e2e.mjs` | modify (T2.4) | A UNC OSC 9;9 report is refused without blocking the main thread |
| `src/project-file-index.ts` | modify (T3.4) | `ProjectFileIndexMeta.covered` |
| `src/repo-file-index.ts` | modify (T3.4) | `RepoFileIndexBuild.coveredRepos` |
| `test/unit/project-file-index.test.ts`, `test/unit/repo-file-index.test.ts` | modify (T3.4) | Coverage cases |
| `src/path-resolve.ts` | modify (rewrite) | Async multi-root resolver: exact-cwd/exact-root/suffix, elision, dedupe, repoRoot |
| `electron/path-link-resolver.ts` | create | Host shell: indexes + coverage, async stat with concurrency, per-token validation, `probe` (async, UNC budget), (v1) uri branch |
| `src/protocol.ts` | modify (claimed) | `resolvePathToken` / `resolvePathTokenResult` shapes; (v1) `target:'uri'` |
| `electron/main.ts` | modify (claimed) | Construct the resolver; route `resolvePathToken`; delete `resolvePathTokens` (L757) and `statKind` (L465) |
| `webview/terminal-token-cache.ts` | modify | Batched `settle`, scope, generation, `ttlMs`, `evict`, `evictWhere`, `clear` |
| `webview/path-candidate-rank.ts` | create | `rankCandidates`, `chooseClickAction`, `RANK_KEYS` |
| `webview/terminal-link-picks.ts` | create | Last picked repo root per session |
| `webview/path-probe.ts` | modify | `probePathKind` |
| `webview/components/path-candidate-picker-model.ts` | create | Rows, filter, heading (pure) |
| `webview/components/path-candidate-picker.tsx` | create | Picker UI on `Popover` |
| `webview/term-link-strings.ts` | create | `TERM_LINK_STR` user strings |
| `webview/term-menu.ts` | modify | `buildLinkMenuItems` |
| `webview/components/terminal-pane.tsx` | modify (claimed) | Provider over logical lines, new IPC shape, cache wiring, picker, link menu, stale toast, `hoveredLinkRef`, (v1) context root + OSC 8 dispatch |
| `webview/components/center-pane.tsx` | modify (claimed) | `rootsSig` (S3) and the three new props, per session |
| `webview/app.tsx` | modify (claimed) | Open-as-session handler with project + return focus; hint; quick-open prefill; (v1) palette command |
| `webview/styles.css` | modify (claimed) | `.pathpick*` picker styles, `.repo-head__tag--worktree` (all 3 themes + forced-colors, from palette variables) |
| `webview/terminal-context-root.ts` | create (Slice 7) | `inferContextRoot` |
| `webview/terminal-bus.ts` | modify (Slice 9) | `TerminalApi.openDetectedLink`, `openDetectedLinkIn` |
| `test/unit/terminal-bus.test.ts` | modify (Slice 9) | `openDetectedLinkIn` case |
| `src/link-target.ts` | create (Slice 8) | `classifyLinkUri`, `decodeFileUri` |
| `src/path-link-confine.ts` | create (Slice 8) | `confineToRoots` |
| `test/unit/terminal-links.test.ts` | modify | Existing cases kept; new table for every detection fix row |
| `test/unit/terminal-logical-line.test.ts` | create | Wrap joining, ranges |
| `test/unit/path-token-normalize.test.ts` | create | Normalisation matrix |
| `test/unit/path-link-roots.test.ts` | create | Kinds, order, dedupe, hash |
| `test/unit/path-resolve.test.ts` | modify (port + extend) | Existing cases ported to async API; resolver matrix |
| `test/unit/path-link-resolver.test.ts` | create | Validation, concurrency, index set, session-gone |
| `test/unit/terminal-token-cache.test.ts` | modify | Batch settle, scope, generation, TTL, evictWhere (T3.0) |
| `test/unit/path-candidate-rank.test.ts` | create | Rank keys, click action |
| `test/unit/path-candidate-picker-model.test.ts` | create | Rows, filter, heading |
| `test/unit/path-probe.test.ts` | create | `probePathKind` + `probePathExists` unchanged |
| `test/unit/term-menu.test.ts` | modify | Link menu cases |
| `test/unit/terminal-context-root.test.ts` | create (Slice 7) | Signal parsing |
| `test/unit/link-target.test.ts` | create (Slice 8) | Classification + hostile decode cases |
| `test/unit/path-link-confine.test.ts` | create (Slice 8) | Pure lexical/UNC/case cases with a never-called realPath spy; fs symlink escape (uses `test/helpers/temp-roots.ts`) |
| `test/e2e/terminal-path-links.e2e.mjs` | modify | New IPC shape |
| `test/e2e/link-cwd.e2e.mjs` | modify | New IPC shape; cwd-vs-pin via strength |
| `test/e2e/terminal-path-links-v2.e2e.mjs` | create | Picker, ranking by last pick, tool-header link, truncation, stale toast (real clicks) |
| `test/e2e/terminal-link-menu.e2e.mjs` | create | Link menu, Open as new session prefill + project + focus return |
| `test/e2e/terminal-osc8-file-link.e2e.mjs` | create (Slice 8) | OSC 8 file target opens in-app; outside-root target refused; `javascript:` ignored |
| `test/e2e/stress/terminal-path-resolve.stress.mjs` | create | 30-root and 200-root warm resolve p95 |
| `docs/runs/2026-10-16-terminal-path-links/context-root-evidence.md` | create (Slice 7) | Measurement result and the ranking decision |
| `CHANGELOG.md` | modify (claimed) | User-facing entry (last) |

## Scripts

- **`%TEMP%\claude-scratch\context-root-measure.mjs`** (one-off, Task 7.2; never in the repo).
  - Args: `--transcripts <dir> --rings <dir> --out <json>`.
  - It bundles `webview/terminal-context-root.ts` and `webview/terminal-links.ts` with the
    repo's esbuild (`node_modules/.bin/esbuild --bundle --platform=node --format=esm`) into the
    temp dir.
  - It replaces hand-reading hundreds of transcript turns. It is deleted after the evidence
    file is written.
- Detection and resolver rows are **table-driven inside the test files**. No generator script
  is needed: a table row is the same size as a generator's input.
- `SCRIPT_CANDIDATES: 1`.

## Slices

MVP is Slices 1–6. v1 is Slices 7–9. Slice 10 is the changelog.

### Slice 1: Detection (pure)

**Check:** `npx vitest run test/unit/terminal-links.test.ts test/unit/terminal-logical-line.test.ts`
passes. Every existing `it` in `terminal-links.test.ts` passes unmodified, except the
assertions on the removed `path` field, which are deleted. `npm run verify:quick` is green.

**Parallel groups:** G1: T1.1 · G2: T1.2
**Claims (serial lane):** none

#### Task 1.1: token rules and alts

**Files:** Modify: `webview/terminal-links.ts`. Test: `test/unit/terminal-links.test.ts`.

**Interfaces — Produces:** `PathToken`, `detectPathTokens`, `MAX_LOGICAL_LINE`,
`MAX_PATH_TOKENS`, `MAX_TOKEN_LENGTH` exactly as in Contracts.

**Call sites:** `webview/components/terminal-pane.tsx:384` (the only consumer). It reads
`.raw/.start/.end/.line/.col` and never `.path`, which was measured by grep. Task 3.3 rewires
it to `alts`.

**Steps:**
- [ ] Failing table `describe('detectPathTokens — v2 matrix')`, one row per spec §2.2 row.
      Key assertion per row: `{alts, line, col, start, end}`.
  - Row 8: `src/index.ts(42,7)` → alts `['src/index.ts']`, line 42, col 7.
  - Row 9: `#L42`, `#L42-L50` → line 42.
  - Row 11: ` line 42`, `File "x.py", line 42` → line 42.
  - Row 24: backticks stripped.
  - Rows 26–28: `(src/index.ts)`, `● Update(src/index.ts)` and `[index](src/index.ts)` →
    `alts[0] === 'src/index.ts'`, and the span covers only the path.
  - Row 29: `app/(group)/page.tsx` → alts `['app/(group)/page.tsx', 'page.tsx']`.
  - Row 32: `…/src/index.ts` → `alts[0] === '…/src/index.ts'`, which the host treats as elision.
  - Rows 34–36: `G:\work\…\src\index.ts` → `alts[0] === 'G:/work/…/src/index.ts'`, and
    `…rc/util/a.ts` is kept whole.
  - Row 39: a quoted span with spaces is whole: `"repoA/src/my file.ts"` →
    `alts[0] === 'repoA/src/my file.ts'`.
  - Row 38: an unquoted span with spaces gives no token for the joined text.
  - Row 43: `README`, `Makefile`, `Dockerfile`, `.env`, `.env.local`, `.gitignore` detected;
    `LICENSE` detected.
  - Row 44: `foo.mts`, `x.lua`, `y.tf`, `z.csv`, `log.log` detected via `langFromPath`. Prose
    `obj.foo` and `version 1.2` still give none.
  - Row 45: `src/` and `webview/` detected with trailing `/`.
  - Row 48: `src\index.ts` → alts `['src/index.ts']`.
  - Row 49: a line starting `diff --git `, `--- ` or `+++ ` with `a/src/x.ts b/src/x.ts` →
    alts `['src/x.ts']` each. The same text on a non-diff line keeps `a/`.
  - Limits: an 11-token line returns 10, and a 1025-char token is skipped.
  - `keep` rows 1, 6, 7, 10, 25, 30, 31, 41, 50, 51 have explicit cases.
- [ ] Run `npx vitest run test/unit/terminal-links.test.ts`. Expect FAIL: there is no `alts`
      and the new suffixes don't parse.
- [ ] Implement:
  - Suffix parsing happens after the path match.
  - Strip leading `` ` `` and unbalanced `(` / `[` / `<`, and record the post-paren tail as
    `alts[1]`.
  - The extensionless set and the allowlist are `FILENAME_EXTS ∪ langFromPath` (`src/lang.ts:305`).
  - Diff-header detection runs on the whole logical line.
  - Delete `PathToken.path` and the private `resolvePath` (L325) once nothing uses it.

#### Task 1.2: logical lines

**Files:** Create: `webview/terminal-logical-line.ts`. Test:
`test/unit/terminal-logical-line.test.ts`.

**Interfaces — Produces:** `BufferLike`, `LogicalLine`, `buildLogicalLine`, `toBufferRange`
(Contracts).

**Steps:**
- [ ] Failing tests, using a fake `BufferLike` built from string rows with `isWrapped` flags:
  - 'joins a row with its wrapped continuations from any row of the group': `y` = the middle
    row gives the same `text` and `firstRow`.
  - 'reads non-last rows untrimmed': a trailing space at the wrap is kept.
  - 'returns null past MAX_LOGICAL_LINE'.
  - 'maps a token spanning the wrap to a two-row range':
    `start {x: 79, y: firstRow+1}`, `end {x: 3, y: firstRow+2}` for cols 80.
  - 'an unwrapped row is its own line'.
- [ ] Run. Expect FAIL (module missing).
- [ ] Implement.

### Slice 2: Resolver core (pure) + cwd-report gate

**Check:**
- `npx vitest run test/unit/path-token-normalize.test.ts test/unit/path-link-roots.test.ts test/unit/path-resolve.test.ts test/unit/cwd-report-gate.test.ts`
  passes.
- Every case ported from the old `path-resolve.test.ts` keeps its `it` name and expected
  candidate set (mapping `relPath` → `relToRoot`, cap 50 → explicit `cap: 50`).
- `npm run verify` is green. `electron/main.ts:757` still compiles against a kept
  compatibility export (see T2.3).
- Orchestrator: `npm run e2e -- cwd`, then `npm run e2e:remote --full` (T2.4 edits
  `electron/main.ts`).

**Parallel groups:** Serial: T2.1, T2.2, T2.3, T2.4. T2.2 consumes T2.1's types, and T2.4
claims `electron/main.ts`.
**Claims (serial lane):** `electron/main.ts`

#### Task 2.1: normaliser

**Files:** Create: `src/path-token-normalize.ts`. Test: `test/unit/path-token-normalize.test.ts`.

**Interfaces — Produces:** `PathPlatform`, `NormalizeCtx`, `normalizeAbs`, `expandToken`,
`isAbsoluteToken`, `joinAbs`, `isUncLike` (Contracts).

**Steps:**
- [ ] Failing table:
  - `G:\work\repoA\..\repoB\x.ts` (win32) → `G:/work/repoB/x.ts` (row 13).
  - `g:/a/./b/` → `G:/a/b`.
  - `/a//b/../c` (posix) → `/a/c`.
  - `/../a` → `/a`.
  - `~` and `~/foo/bar.ts` with `homeDir:'/home/u'` → `/home/u/foo/bar.ts` (row 23).
  - `/g/work/x.ts` win32 → `G:/work/x.ts`, and posix unchanged (row 16).
  - `/mnt/g/work/x.ts` win32 → `G:/work/x.ts` (row 17).
  - `/gx/work` win32 unchanged (two letters).
  - `//server/share/a/../b` keeps the `//` (UNC is normalised, never detected in MVP).
  - `isUncLike`:
    - true for `//host/x`, `\\host\x`, `\\?\UNC\h\s`, `\\.\pipe\x`, `\\?\G:\root\x` and
      `//?/G:/x`;
    - false for `/x`, `G:/x` and `G:\ROOT\x`.
  - `joinAbs('G:/work/repoA/src','../webview/app.tsx','win32')` → `G:/work/repoA/webview/app.tsx`
    (row 14).
  - `isAbsoluteToken('src/x','posix') === false`.
- [ ] Run. Expect FAIL (module missing).
- [ ] Implement with string ops only. A test asserts the file has no `node:` import, by
      reading the source text.

#### Task 2.2: roots builder

**Files:** Create: `src/path-link-roots.ts`. Test: `test/unit/path-link-roots.test.ts`.

**Interfaces — Produces:** `ResolveRootKind`, `ResolveRoot` (with `userChosen`),
`buildResolveRoots(session, cwdGitRoot, opts)`, `userRootsOf(session, opts)`,
`rootsSigOf(session)` (Contracts). **Consumes:** `Session`, `GitInfo` and `RepoInfo` types
(`src/types.ts:54+`, `src/repo-scan.ts:7-19`), `folderKey` (`src/folder-key.ts:4`),
`isAncestorOf` (`src/owning-session.ts:82`), and the **type** `PathPlatform` plus
`normalizeAbs` from T2.1 (`src/path-token-normalize.ts`). That makes T2.2 depend on T2.1, so
Slice 2 runs serially (see below).

**Steps:**
- [ ] Failing tests:
  - 'parent of many':
    - home `/w` (non-git, cwdGitRoot `/w`), repos `/w/repoA`, `/w/repoB` nested, and
      `/w/T-123/repoA-wt` with `repoGit[…].isWorktree` and `worktreeName:'repoA-wt'`,
      `branch:'feat/x'`;
    - result kinds `[home, nested repoA, nested repoB, worktree repoA-wt]`;
    - the worktree has `branch:'feat/x'` and `name:'repoA-wt'`.
  - 'cwd repo that is no root comes first as cwd-repo'.
  - 'home that is also RepoInfo tag home is one entry'.
  - 'attached keep session.roots order'.
  - 'missingRoots skipped'.
  - 'userChosen':
    - home, attached and repos under them are `true`;
    - a `cwd-repo` inside home is `true`;
    - **a `cwd-repo` outside every user root is `false`, and `userRootsOf` omits it**;
    - a `session.repos` entry not under home or roots is `false` and omitted. That can't happen
      by construction, and the test pins the filter.
  - 'userRootsOf win32 folding': with `caseSensitive:false`, repo `G:/W/repoA` under home
    `g:/w` is kept.
  - 'rootsSig changes when a root is attached or detached, a repo is discovered or a root goes
    missing; not when repoGit changes; identical for two sessions with the same fields'.
- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 2.3: async multi-root resolver

**Files:** Modify: `src/path-resolve.ts`. Test: `test/unit/path-resolve.test.ts` (port +
extend).

**Interfaces — Produces:** `IndexedFile` (unchanged), `CandidateStrength`, `PathCandidate`,
`TokenResolution`, `StatKind`, `ResolveDeps`, `ResolveIndex`, `ResolveCtx`,
`DEFAULT_CANDIDATE_CAP`, `MAX_ALTS`, `IndexMemo`, `memoFor`, `resolveTokens`, and the
re-export of `isUncLike`
(Contracts). **Consumes:** T2.1 `normalizeAbs`, `expandToken`, `isAbsoluteToken`, `joinAbs`,
`isUncLike`, `PathPlatform`; T2.2 `ResolveRoot`.

**Call sites:**
- `electron/main.ts:117,757-767` (`resolveToken`, old `TokenResolution`).
- `src/protocol.ts:12,752`.
- `webview/components/terminal-pane.tsx:6` (`PathCandidate.relPath`).

To keep this slice green alone, the old sync `resolveToken`, `ResolveCtx` (renamed
`LegacyResolveCtx`) and the old shapes stay **exported unchanged** until Task 3.3 deletes them,
in the same slice that rewires their callers. This is a planned two-step with its deletion
scheduled, not a fallback.

**Steps:**
- [ ] Port each existing case to `await resolveTokens([{alts:[raw]}], ctx, deps)`, with a fake
      async stat over a `Set` of paths and `topLevel` from a map. Run: the ported cases FAIL
      (function missing).
- [ ] Add the failing matrix using the S3 fixture:
  - home `/w`, repos `repoA`, `repoB`, and `T-123/repoA-wt`;
  - each contains `src/index.ts`;
  - the index files are rel to `/w`.

  Cases:
  - Row 2: `src/index.ts`, cwd `/w` → 3 candidates, all `exact-root`, with `rootIdx`
    respectively repoA, repoB, repoA-wt (exact joins beat suffix). `relToRoot === 'src/index.ts'`.
    The index has `coveredRootIdx` = all three repos, so **the fake stat is called only for the
    2 exact-cwd joins** (assert the stat-call log).
  - 'membership, not stat': a file in a covered root but absent from the index (gitignored) is
    not an `exact-root` hit. A root no index covers is stat'ed. A dir token `src/` is stat'ed
    even in a covered root.
  - 'index memo': `memoFor(files,false) === memoFor(files,false)` (identity), and a new array
    gives a new entry.
  - UNC (rule 2):
    - `//srv/share/a.ts` with no UNC root → 0 candidates and **0 stat calls**;
    - with root `//srv/share` → 1 `exact-cwd` candidate and 0 stat calls;
    - a relative token with a UNC root → membership only, 0 stat calls;
    - `\\?\G:\w\a.ts` → 0 candidates, 0 stat calls.
  - Win32 case: `platform:'win32'`, `caseSensitive:false`, token `G:\W\REPOA\src\index.ts`
    with root `G:/w/repoA` → `rootIdx` repoA.
  - Row 1: cwd `/w/repoA` → exactly 1 `exact-cwd` plus the other two as `exact-root` (the
    click action is decided in the renderer).
  - Row 5: home repoA plus attached repoB, cwd repoA → `exact-cwd` repoA, then `exact-root`
    repoB.
  - Row 13: `../repoB/src/index.ts` from cwd `/w/repoA` → `absPath` `/w/repoB/src/index.ts`
    (no `..`).
  - Row 23: `~/x.ts`.
  - Rows 32 and 33: `…/src/index.ts` and `.../src/index.ts` → 3 suffix candidates.
  - Row 35: `/w/repoB/.../index.ts` → only repoB.
  - Row 36: `…rc/index.ts` → matches the `src` segment suffix.
  - Row 45: `src/` → a dir via exact joins only.
  - Row 47: `/w/repoA/` → `relToRoot ''`, and `isDir`.
  - Dedupe: the same file via home `/w` and nested `/w/repoA` gives one candidate with
    `rootIdx` = repoA.
  - Worktrees of one repo are never deduped (different `absPath`).
  - `repoRoot`:
    - nested → the repo;
    - a file under non-git home outside any repo → `topLevel(folder)` = '' → the containing
      folder;
    - an absolute path outside every root → `rootIdx -1`, and `repoRoot` from `topLevel`.
  - Cap: 250 suffix hits → `candidates.length === 200`, `truncated`, `total === 250`.
  - Case: `caseSensitive:false` matches `SRC/Index.ts`.
  - `alts` fallback: alts `['Update(src/index.ts', 'src/index.ts']` → resolves via `alts[1]`.
  - 4 alts: the 4th alt is tried. (`resolveTokens` trusts its input, since the shell enforces
    `MAX_ALTS`.)
  - A stat that throws → a miss, never a rejection.
- [ ] Implement `resolveTokens` per the Contracts rules. Run both test sets: PASS.

#### Task 2.4: cwd-report gate (UNC refusal + async check)

Today `electron/main.ts:1519-1543` takes a cwd reported by **terminal output** (OSC 9;9, with
`trackCwd` on by default) and runs `fs.existsSync` + `fs.statSync` on it, synchronously, on
the main thread. A printed `\\host\share` therefore makes the main process open an SMB
connection, triggered by content, and block on it.

**Files:**
- Create: `src/cwd-report-gate.ts`.
- Modify: `electron/main.ts` (the `if (settings.trackCwd)` block at L1519-1543).
- Test: `test/unit/cwd-report-gate.test.ts`.
- Modify: `test/e2e/cwd.e2e.mjs` (the existing cwd-tracking scenario).

**Interfaces — Produces:**

```ts
// src/cwd-report-gate.ts (pure core, deps injected)
export interface CwdReportGateDeps {
  stat(abs: string): Promise<'file' | 'dir' | null>;          // fs.promises.stat wrapper
  userRoots(sessionId: string): string[] | null;              // userRootsOf(mgr.get(id)), null = session gone
  accept(sessionId: string, cwd: string): void;               // no-op if cwd === mgr.get(id).cwd; else mgr.setCwd + mgr.setAutoRepo(repoForPath(...)) as today
  platform: PathPlatform; caseSensitive: boolean;
}
export interface CwdReportGate {
  /** Fire-and-forget. isUncLike(cwd) and not lexically under a UNC user root → refused with NO
   *  fs call. Otherwise async stat; accept only if 'dir' AND this is still the newest report for
   *  the session (per-session sequence: a slower older stat never overwrites a newer cwd). */
  report(sessionId: string, cwd: string): void;
  drop(sessionId: string): void;                              // on session dispose
}
export function createCwdReportGate(deps: CwdReportGateDeps): CwdReportGate;
```

**Consumes:** `isUncLike`, `normalizeAbs`, `PathPlatform` (T2.1) and `userRootsOf` (T2.2).

**Call sites:**
- `electron/main.ts:1528-1541`: the sync `existsSync`/`statSync` block is replaced by
  `cwdGate.report(msg.sessionId, newCwd)` for **every** non-null scanner result.
  - The `newCwd !== session.cwd` comparison moves **inside `accept`**, against the session's
    cwd at accept time.
  - Reason: a pre-check at report time would skip a report equal to the current cwd while an
    older, slower report is still in flight. That older report would then win (A → B(slow) → A).
- `cwdGate.drop(id)` sits beside each `cwdScanners.delete(…)` (`electron/main.ts:1573`,
  `:2540`).
- The e2e imports `typeLine` from `test/e2e/harness.mjs` (`:986`). The scenario already uses
  `launchApp` and `tapBridge` (`test/e2e/cwd.e2e.mjs:17-43`).
- The gate is constructed beside `cwdScanners`, with `stat` from `fs.promises.stat`.

**Steps:**
- [ ] Failing unit tests (fake stat, fake timers, `platform:'win32'` string fixtures):
  - '`\\\\evil\\share` with no UNC user root → refused, stat never called, accept never
    called'.
  - '`//?/G:/x` and `\\\\.\\pipe\\x` → refused, no stat'.
  - 'UNC cwd under a UNC home `//srv/share` → stat'ed, accepted when dir'.
  - '**cwd moved outside every user root to a UNC path → refused**. The cwd-repo is never a
    user root'.
  - 'a local dir → accepted after the async stat; a file or miss → ignored'.
  - 'out of order: report A (slow stat) then B (fast) → only B is accepted, A's late result
    is dropped'.
  - '**A→B(slow)→A: B is dropped, cwd stays A**': the session cwd is A; report B (stat
    pending), then report A (stat resolves first); B's late result is dropped. `accept`
    no-ops for A because it equals the current cwd, and the cwd stays A.
  - 'session gone (userRoots null) → nothing accepted'.
  - 'drop() discards an in-flight result'.
- [ ] Run → FAIL. Implement. No sync fs remains in the block.
- [ ] The **red-first proof** is the unit test: a UNC report with no UNC user root leaves the
      stat spy uncalled.
- [ ] **Regression smoke** (not the proof): extend `test/e2e/cwd.e2e.mjs`. It already drives a real PowerShell session through
      OSC 9;9.
  - Before the trackCwd-off step, have the shell print a fake report:
    `typeLine(page, sid, "[Console]::Write([char]27 + ']9;9;\\\\192.0.2.1\\share' + [char]7)")`.
    192.0.2.1 is TEST-NET-1, which never answers SMB.
  - Assert within 3 s that:
    - the session's `cwd` is unchanged (via `tapBridge` state);
    - a main-process round-trip (`app.evaluate(() => 1)`) completes in < 500 ms, meaning the
      main thread was never blocked on SMB.
  - The existing `cd src` positive case proves the async path still moves the cwd.

### Slice 3: Host wiring and the IPC seam

**Check:**
- `npx vitest run test/unit/path-link-resolver.test.ts test/unit/terminal-token-cache.test.ts` passes.
- `npm run verify` is green.
- The orchestrator runs `npm run e2e:remote -- terminal-path-links link-cwd middle-click-terminal terminal-links terminal-commit-link review-multi-repo`,
  which passes. Then `--full`, because `electron/main.ts` changed.
- The multi-candidate dropdown still works with labels from `relToRoot`. The picker comes in
  Slice 4.

**Parallel groups:** G1: T3.1 · G2: T3.0 · G3: T3.4 · Serial: T3.2, T3.3
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/components/terminal-pane.tsx`, `webview/components/center-pane.tsx`

#### Task 3.4: index coverage report

The resolver may answer "not there" from an index only when that index is known to be
complete. That holds for a `git ls-files` listing that answered (`kind:'listed'`) and wasn't
capped, and nothing else.

**Files:**
- Modify: `src/project-file-index.ts` (`ProjectFileIndexMeta` gains `covered: string[]`).
- Modify: `src/repo-file-index.ts` (`RepoFileIndexBuild` gains `coveredRepos: string[]`).
- Test: `test/unit/project-file-index.test.ts`, `test/unit/repo-file-index.test.ts`.

These are the engine's files, and the in-flight `feat/repo-engine` review was modifying them in
the working tree at planning time (`git status`). Build against the reviewed tip, and re-read
both files before editing (deviation rule).

**Interfaces — Produces:**
- `ProjectFileIndexMeta.covered: string[]` (forward-slashed roots):
  - a git root → `[root]` iff its listing was `kind:'listed'` and not capped, else `[]`;
  - a non-git root → `RepoFileIndexBuild.coveredRepos`. A repo is covered only when all three
    hold:
    - **listed:** its own `listRepo` returned a `string[]`;
    - **fresh:** that listing is from this build, not a stale last-good listing reused after a
      failed or timed-out `listRepo`;
    - **not walked:** its files did not come from a walk fallback and were not truncated by
      any cap.

    The loose walk never counts, so a non-git parent itself is never covered;
  - scope `everything` → `[]`, because the walk is not a listing.
- **Memo:** coverage is stored **in the `unions` memo entry**, beside its files, and returned
  unchanged on a memo hit. A cached build never reports `[]`, and never reports more than it
  had when built.
- The change is additive. Existing consumers (quick-open, search, the TS index,
  `test/e2e/index-repo-set.e2e.mjs`) ignore the new field.

**Steps:**
- [ ] Failing tests:
  - 'git root listed, uncapped → covered [root]'.
  - 'git listing failed → walk fallback → covered []'.
  - 'capped → []'.
  - 'composite: repo A listed, repo B `not-repo`/null, repo C truncated → coveredRepos [A]'.
  - 'everything scope → []'.
  - '**memo hit keeps coveredRepos**': build twice with no invalidation. The second (memo) result
    has the same `coveredRepos` as the first.
  - '**stale last-good listing → not covered**': repo A lists, then is invalidated, and its
    next `listRepo` fails, so the index reuses A's last-good files. A is absent from
    `coveredRepos`, while its files are still present.
- [ ] Run → FAIL. Implement.

#### Task 3.0: cache batches, scope, TTL, generation

This task is in Slice 3 because the batch settle is what makes a truncated, invalid or empty
reply release its pending tokens. It has to exist when the new IPC shape lands.

**Files:** Modify: `webview/terminal-token-cache.ts`. Test: `test/unit/terminal-token-cache.test.ts`.

**Interfaces — Produces:** the cache signature in Contracts (`get(tokens, scope?)`,
`settle(id, replyScope, values)`, `resolve`, `evict`, `evictWhere`, `clear`, `dispose`).

**Call sites:** `webview/components/terminal-pane.tsx:346` (path cache, rewired in T3.3) and
`:350` (commit cache). The commit cache's request callback ignores `batch.id` and uses
`batch.tokens`; otherwise it is unchanged.

**Steps:**
- [ ] Failing tests:
  - 'settle resolves every pending token of the batch, absent ones as misses and uncached':
    `get(['a','b'])` with `settle(id, s, Map{a})` → the result has `a` and not `b`, and a second
    `get(['b'])` issues a new request.
  - 'reply scope differs from lookup scope': `get(['a'],'cwd1\0h')` then
    `settle(id,'cwd2\0h',{a})` → the waiter gets `a`; `get(['a'],'cwd1\0h')` re-requests;
    `get(['a'],'cwd2\0h')` hits.
  - 'clear during in-flight: a negative is dropped, a positive is stored':
    - `get(['a','b'])` → `clear()` → `settle` with `a` positive and `b` negative;
    - both waiters get their values;
    - the next `get(['a'])` hits, and `get(['b'])` re-requests.
  - 'evictWhere during in-flight: settle does not store the stale negative':
    - `get(['b'])` → `evictWhere(isNegative)` → `settle(b negative)` → the waiter gets `b`;
    - the next `get(['b'])` re-requests.
    - The same flow with a positive value → stored.
  - 'ttlMs expiry', with an injected `now`.
  - 'negative entries expire after negative.ttlMs (5 s) while positives live for ttlMs (30 s)'.
  - 'evictWhere drops only matching values'.
  - 'timeout still settles as absent'.
  - The existing 2 cases still pass through `resolve` (the commit path).
- [ ] Run → FAIL. Implement.

#### Task 3.1: host shell

**Files:** Create: `electron/path-link-resolver.ts`. Test: `test/unit/path-link-resolver.test.ts`.

**Interfaces — Produces:** `PathLinkResolverDeps`, `PathLinkReply`, `PathLinkResolver`,
`STAT_CONCURRENCY`, `MAX_TOKENS`, `createPathLinkResolver` (Contracts). There is no `probe`
(T4.1) and no `uri` branch (T8.3) yet. **Consumes:** `resolveTokens`, `ResolveCtx`,
`ResolveIndex`, `TokenResolution`, `IndexedFile`, `MAX_ALTS` from `src/path-resolve.ts`;
`buildResolveRoots(session, cwdGitRoot, opts)`, `userRootsOf(session, opts)` and
`rootsSigOf(session)` from `src/path-link-roots.ts`; `PathPlatform` and `isUncLike` from
`src/path-token-normalize.ts`.

**Steps:**
- [ ] Failing tests with fake deps:
  - 'unknown session → one session-gone result per entry'.
  - 'per-token validation':
    - 11 valid tokens → 10 results (truncated);
    - entry 2 with `alts: 5` (non-array) → `error:'invalid'` while entries 1 and 3 resolve;
    - 5 alts → only the first 4 are tried (the fake stat log);
    - a 1025-char alt is dropped and the others are kept;
    - **a trimmed entry keeps the ORIGINAL key**: 5 alts `[a,b,c,d,e]` → `result.key ===
      'a\0b\0c\0d\0e'`, and a dropped long alt is still part of `key`. The renderer's pending
      token is the original join, so it settles;
    - non-array `tokens` → `results: []`.
  - 'UNC stat race': `cwd` and home `//srv/share` (user-chosen), a fake stat that never settles
    for `//` paths → the token resolves as a miss after `UNC_PROBE_BUDGET_MS`, and a second,
    local-only token in the same batch is not delayed (fake timers).
  - '**cwd moved outside every user root → its repo is not a UNC root**': home `G:/w`, cwd
    `//evil/share/repo` (`cwdGitRoot` the same). The token `//evil/share/repo/a.ts` → not linked,
    with 0 stat calls. Relative tokens skip the cwd joins entirely when the cwd is UNC and not
    under a user root: the T2.4 gate makes that state unreachable, and the shell enforces it
    again.
  - 'never more than 16 stats in flight': the fake stat counts concurrency.
  - 'indexes the cwd root plus each attached root, never nested repos': spy on `fileIndex`
    args.
  - 'coveredRoots → coveredRootIdx': a nested repo listed in `coveredRoots` is answered by
    membership, with no stat for it. A nested repo **not** listed (capped, or its listing was
    not `'listed'`) is stat'ed.
  - 'a fileIndex rejection degrades to exact-only': there are no covered roots, so every root
    is stat'ed, with no throw.
  - 'reply carries cwd (the live cwd used), roots and rootsSig'.
- [ ] Run. Expect FAIL.
- [ ] Implement. The concurrency wrapper is private to this file.

#### Task 3.2: protocol + main.ts

**Files:** Modify: `src/protocol.ts` (L752 and L1107 entries, plus the type imports),
`electron/main.ts`:
- construct `const pathLinks = createPathLinkResolver({...})` beside `projectFileIndexMeta`
  (L475), with `stat` = `fs.promises.stat` → `'dir'|'file'|null`;
- `topLevel: repoTopLevel` (L882);
- `fileIndex: async (root) => { const meta = await projectFileIndexMeta(root); return { files: meta.files, coveredRoots: meta.covered }; }`,
  where `covered` comes from T3.4;
- `gitRoot: (s) => sessionGitRoot(s, git)`;
- `homeDir: os.homedir()` forward-slashed;
- `platform: process.platform === 'win32' ? 'win32' : 'posix'`;
- `caseSensitive: process.platform === 'linux'`.

**Interfaces — Consumes:** `createPathLinkResolver`, `PathLinkReply` (T3.1), and
`ProjectFileIndexMeta.covered` (T3.4). **Produces:** the two protocol shapes in Contracts
(without `target`).

**Call sites:**
- The `case 'resolvePathToken'` at `electron/main.ts:4214-4230` becomes
  `replyHere({ type: 'resolvePathTokenResult', sessionId: m.sessionId, requestId: m.requestId, ...(await pathLinks.resolve(m.sessionId, m.tokens)) })`.
  - A non-number `requestId` is answered with `requestId: -1`, which the renderer ignores.
  - The resolver never rejects, so there is always exactly one reply.
- Delete `resolvePathTokens` (L757-767) and `statKind` (L465; it has no other user, per grep).

**Steps:** this is a type-level seam with no new unit test, because T3.1 owns the behaviour.
`npm run typecheck` fails until T3.3 lands, so T3.2 and T3.3 are one commit.

#### Task 3.3: pane on the new shape; delete the legacy resolver; IPC e2es

**Files:**
- Modify: `webview/components/terminal-pane.tsx`:
  - the provider at L371-524;
  - `openPathMenu` at L166-197;
  - the result subscription at L359-364.
- Modify: `webview/components/center-pane.tsx`. Pass `rootsSig={rootsSigOf(s)}` to each
  `TerminalPane` (L341-351).
  - There is no memo. It is FNV over ≤ ~200 short strings per render, and the result is a
    string, so the pane's ref sees an equal value when nothing changed.
  - The pane mirrors it into `rootsSigRef` and never puts it in an effect dependency list.
- Modify: `src/path-resolve.ts` (delete the legacy `resolveToken`, `LegacyResolveCtx` and the
  old shapes).
- Modify: `test/e2e/terminal-path-links.e2e.mjs`, `test/e2e/link-cwd.e2e.mjs`.

**Interfaces — Consumes:**
- `buildLogicalLine` and `toBufferRange` (T1.2).
- `PathToken.alts` (T1.1).
- The new reply shape.
- The T3.0 cache:
  - tokens are `alts.join('\0')`;
  - scope is `cwdRef.current + '\0' + rootsSigRef.current`, where `rootsSigRef` mirrors the
    **new `rootsSig: string` prop**;
  - `request(batch)` posts `{requestId: batch.id, tokens: batch.tokens.map(k => ({alts: altsByBatch.get(batch.id).get(k)}))}`;
  - the reply handler calls `settle(msg.requestId, msg.cwd + '\0' + msg.rootsSig, Map(result.key → result))`
    for results without `error`;
  - `ttlMs: 30_000`, and
    `negative: { is: (r) => r.candidates.length === 0, ttlMs: FILE_INDEX_TTL_MS }`, imported
    from `src/project-file-index.ts:11` (already exported).
- `rootsSigOf(session)` (T2.2), called in center-pane.

**Steps:**
- [ ] Provider:
  - `buildLogicalLine(term.buffer.active, bufferLineNumber - 1, term.cols)`.
  - Detect on `ll.text`.
  - Ranges come from `toBufferRange`.
  - Return only links whose range intersects row `bufferLineNumber`. xterm calls per row, and
    the cache collapses the repeat requests.
  - URL tokens use the same logical line.
- [ ] The dropdown label is `c.relToRoot || c.absPath`. Behaviour is otherwise unchanged.
- [ ] `terminal-path-links.e2e.mjs`:
  - posts `requestId: 1, tokens: [{alts:[…]}]` and matches the reply by `requestId`;
  - `exact.candidates[0].relToRoot === 'webview/app.tsx'` with `strength === 'exact-cwd'`;
  - the other assertions keep their meaning.
- [ ] `link-cwd.e2e.mjs` (step 2, L161-184):
  - posts the new shape with a `requestId`, and matches the reply by it;
  - asserts `a-only.txt` has a candidate with `strength === 'exact-cwd'`;
  - asserts `b-only.txt` has **no** `exact-cwd` candidate, and its candidates all have
    `strength !== 'exact-cwd'`;
  - updates the header comment (L12) to say why (spec §7 EARS "every present root").
- [ ] Delete the legacy exports. `npm run verify`: green.

### Slice 4: Async probe, ranking and the picker

**Check:**
- `npx vitest run test/unit/path-link-resolver.test.ts test/unit/path-candidate-rank.test.ts test/unit/path-candidate-picker-model.test.ts test/unit/path-probe.test.ts`
  passes.
- `npm run verify` is green.
- Orchestrator: `npm run e2e -- terminal-path-links-v2` locally, then
  `npm run e2e:remote -- terminal-path-links-v2 terminal-path-links link-cwd middle-click-terminal review-multi-repo terminal-commit-link`,
  then `--full`, because `electron/main.ts` changed in T4.1.

**Parallel groups:** G1: T4.2 · G2: T4.3 · G3: T4.4 · Serial: T4.1, T4.5, T4.6
**Claims (serial lane):** `electron/main.ts`, `webview/components/terminal-pane.tsx`, `webview/components/center-pane.tsx`, `webview/app.tsx`, `webview/styles.css`

#### Task 4.1: async `pathExists` through `pathLinks.probe`

**Files:**
- Modify: `electron/path-link-resolver.ts` (add `probe` and `UNC_PROBE_BUDGET_MS`).
- Modify: `electron/main.ts` (the `case 'pathExists'` at L4196-4212 becomes
  `const kind = await pathLinks.probe(m.path); replyHere({ type: 'pathExistsResult', path: m.path, exists: kind !== null, isDir: kind === 'dir' })`;
  keep its D11 comment).
- Test: `test/unit/path-link-resolver.test.ts`.

**Interfaces — Produces:** `PathLinkResolver.probe(abs): Promise<'file'|'dir'|null>` and
`UNC_PROBE_BUDGET_MS = 500` (Contracts).

**Call sites:** `pathExists` has one renderer producer today (`webview/path-probe.ts:31-34`)
and gains `probePathKind` in T4.4. The reply shape is unchanged.

**Steps:**
- [ ] Failing tests:
  - 'probe → file / dir / null'.
  - 'a stat that throws → null'.
  - 'a UNC-like path whose stat never settles → null after UNC_PROBE_BUDGET_MS', using fake
    timers.
  - 'a non-UNC path is not raced', so a slow local stat still answers.
- [ ] Run → FAIL. Implement with `deps.stat`, which is `fs.promises.stat` in main.ts. No sync
      fs remains in the handler.

#### Task 4.2: ranking + click action + last pick

**Files:** Create: `webview/path-candidate-rank.ts`, `webview/terminal-link-picks.ts`. Test:
`test/unit/path-candidate-rank.test.ts`.

**Interfaces — Produces:** `RankInputs`, `RankKey`, `RANK_KEYS`, `rankCandidates`,
`ClickAction`, `chooseClickAction`, `notePick`, `lastPick` (Contracts). **Consumes:**
`PathCandidate` (`src/path-resolve.ts`), `ResolveRoot` (`src/path-link-roots.ts`), `folderKey`.

**Steps:**
- [ ] Failing tests:
  - 'strength first': an exact-root beats a suffix with a shorter rel.
  - 'last pick beats root order': the Gherkin MVP, where lastPick repoB gives order repoB,
    repoA, repoA-wt.
  - 'home group before attached before nested/worktree'.
  - 'nested by host order (name)'.
  - 'shorter relToRoot then localeCompare'.
  - 'outside-root (-1) last'.
  - 'context key ranks above lastPick when RANK_KEYS has it second' (MVP inputs leave it
    undefined → no effect).
  - 'does not mutate input'.
  - `chooseClickAction`:
    - 0 → none;
    - 1 → open;
    - an exact-cwd among 3 → open that one;
    - 3 exact-root → pick.
  - `notePick`/`lastPick` keyed by session.
- [ ] Run → FAIL. Implement.

#### Task 4.3: picker model + strings

**Files:** Create: `webview/components/path-candidate-picker-model.ts`,
`webview/term-link-strings.ts`. Test: `test/unit/path-candidate-picker-model.test.ts`.

**Interfaces — Produces:** `FILTER_THRESHOLD`, `PickerRow`, `pickerRows`, `filterRows`,
`pickerHeading` (Contracts).

`TERM_LINK_STR` keys:
- `matches(n)`, `heading(token,n)`, `pickFor(actionLabel)`;
- `showingOf(shown,total)` (uses `Intl.NumberFormat`), `searchAll`, `noMatches(q)`;
- `noLongerExists(name)`;
- `open`, `showAll`, `copyPath`, `copyRelativePath`, `reveal`, `openAsSession`;
- `workingHere`, `worktree`.

**Consumes:** `LinkMenuAction` from `webview/term-menu.ts`. That type is added in T5.1, so this
task declares `pickerHeading(token, total, actionLabel?: string)` with a **string** label, and
T5.1 passes `TERM_LINK_STR[action]`. That way neither task invents the other's type.

**Steps:**
- [ ] Failing tests:
  - Row naming: a worktree row has `tag:'worktree'`, `branch:'feat/x'`, `repoName:'repoA-wt'`.
  - `accessibleName === 'repoB / src/index.ts'`.
  - An outside-root row has `repoName` = the last segment of `repoRoot`.
  - `filterRows` is case-insensitive on `accessibleName`.
  - `pickerHeading('src/index.ts',3) === 'src/index.ts · 3 matches'`.
  - `showingOf(200, 1234)` → `'Showing 200 of 1,234'` under `en-US`.
- [ ] Run → FAIL. Implement.

#### Task 4.4: `probePathKind`

**Files:** Modify: `webview/path-probe.ts`. Test: `test/unit/path-probe.test.ts`.

**Interfaces — Produces:** `probePathKind` (Contracts).

**Steps:**
- [ ] Failing tests with a fake `ProbeTransport` (the host side is T4.1):
  - 'dir → "dir"', 'file → "file"', 'miss → null', 'timeout → null'.
  - '`probePathExists` still false for a dir and true for a file'.
- [ ] Run → FAIL. Implement. `probePathExists` delegates.

#### Task 4.5: picker component + styles

**Files:** Create: `webview/components/path-candidate-picker.tsx`. Modify: `webview/styles.css`
(new `.pathpick`, `.pathpick__filter`, `.pathpick__row`, `.pathpick__row--active`,
`.pathpick__repo`, `.pathpick__rel`, `.pathpick__foot`, `.repo-head__tag--worktree` beside
`.repo-head__tag--attached` at L5808, and the forced-colors block at L5866).

**Interfaces — Produces:** `PickerMode`, `PathCandidatePickerProps`, `PathCandidatePicker`
(Contracts). For `PickerMode.action` it uses `actionLabel: string` until T5.1, then
`LinkMenuAction`. T5.1 changes the type, and the picker only displays it. **Consumes:**
`Popover` (`webview/components/popover.tsx:41`, props `at`, `onClose`, `onEscape`),
`RepoTagPill` (`webview/components/repo-picker-menu.tsx:23`), T4.3.

**Steps:**
- [ ] The behaviour is covered by the model tests (T4.3) and the e2e (T4.6). The component has
      no unit test because the unit env is `node` (`vitest.config` `environment: 'node'`).
- [ ] Copy the filter and keyboard model from `webview/components/commit-picker-menu.tsx`
      (input `role="combobox"`, `aria-activedescendant`). The roles are
      `listbox`/`option`, not `menu`.
- [ ] Accessible names:
  - In both modes, the element that receives focus carries `aria-label={pickerHeading(…)}`:
    the listbox below `FILTER_THRESHOLD`, and **the combobox input** at ≥ 9 rows.
  - The listbox keeps the same `aria-label` in both modes, so the count is announced on open
    either way.
  - T4.6's e2e asserts the focused element's `aria-label` contains "3 matches". A 9-row
    variant is asserted in the model test via the `pickerHeading` output.
- [ ] Styling:
  - The row ellipsises `.pathpick__rel` (middle-ellipsis is not required) and never
    `.pathpick__repo`.
  - Path spans get `dir="ltr"`.
  - Colours come only from existing variables, with `--accent-soft` for the active row.
  - The worktree tag uses palette variables in each of the 3 themes, with no raw hex.
  - `npm run text-fit` and `test/unit/monaco-class-collision.test.ts` must pass.

#### Task 4.6: pane wiring + MVP e2e

**Files:**
- Modify: `webview/components/terminal-pane.tsx`, `webview/components/center-pane.tsx`,
  `webview/app.tsx` (the `onSearchAllFiles` prop only).
- Create: `test/e2e/terminal-path-links-v2.e2e.mjs`.

**Interfaces — Consumes:**
- The T3.0 cache as wired in T3.3 (`evict(token, scope)`, `evictWhere`).
- T4.2 `rankCandidates`, `chooseClickAction`, `notePick`, `lastPick`.
- T4.3 `pickerRows`.
- T4.4 `probePathKind`.
- T4.5 `PathCandidatePicker`.
- Existing `pushToast({message, variant:'info'})` (`webview/toast-store.ts:55`).

**Steps:**
- [ ] Pane state:
  - `rootsRef {hash, roots}` is updated from each reply.
  - A roots change needs no clear: `rootsSig` is part of the scope, so old entries simply
    miss and age out under TTL and LRU.
  - A `subscribe` on `fsChanged`: when any `folders` entry `isAncestorOf`-covers or equals a
    root's key (or the reverse), call
    `resolveCache.evictWhere((r) => r.candidates.length === 0)`.
  - **Only misses are evicted.** A file that just appeared links on the next paint, and
    existing links stay put, because a deleted target is caught by the click probe (row 55).
- [ ] `activate`:
  - `chooseClickAction(rankCandidates(res.candidates, {roots, lastPickRepoRoot: lastPick(sessionId)}))`.
  - `open`: `probePathKind(abs)`. On `null`, show the `noLongerExists` toast, call
    `evict(token, scope)` and stop. Otherwise the **probed** kind decides: a dir calls
    `onRevealFolder` and a file calls `onOpenFile` (the background mode logic as today,
    L457-479). `cand.isDir` is only the icon, which matters for UNC (resolver rule 2).
  - `pick`: open the picker at the click point. A second click replaces it, so there is never
    more than one picker.
- [ ] Picker `onPick`:
  - Run the same probe and stale handling.
  - Call `notePick(sessionId, row.cand.repoRoot)`.
  - Open the file or reveal the dir.
  - Picking a dir, or dismissing, refocuses the terminal (`term.focus()`).
- [ ] The picker closes on terminal scroll (xterm `onScroll` + `.xterm-viewport` scroll, per
      CLAUDE.md), on resize and on session switch (`visible` false). `Popover` covers outside
      scroll, blur and resize.
- [ ] Footer "Search all files…" calls the pane's new `onSearchAllFiles?: (query: string) => void`
      prop with the token. This task adds that prop:
      - to the pane;
      - to `webview/components/center-pane.tsx` (declared near L145-153, forwarded at L341-351);
      - to `webview/app.tsx` as `onSearchAllFiles={(q) => setPalette({ initialQuery: q })}` near
        L4332.
- [ ] The old `openPathMenu` is deleted.
- [ ] E2E `terminal-path-links-v2`:
  - Fixture: a temp non-git parent with `repoA`, `repoB` and a git worktree
    `T-123/repoA-wt` of repoA (branch `feat/x`), each with `src/index.ts`.
  - Open a `shell:cmd` session at the parent (`openSession`), set `window.__terms = {}` before
    mount, and wait for `session.repos` to have 3 entries.
  - Write lines with `writeToTerminal`:
    `src/index.ts:42`, `● Update(src/index.ts)`, `…/repoB/src/index.ts`.

  Steps:
  1. Real hover and click on `src/index.ts:42` → `.pathpick` is visible with 3 `[role=option]`
     rows. The texts include `repoA`, `repoB` and `repoA-wt`, plus `feat/x`. The focused
     element's `aria-label` contains "3 matches".
  2. Press ArrowDown to repoB and Enter → an editor tab opens `repoB/src/index.ts` at line 42
     (check the active doc path and cursor line through the existing harness doc probes used
     by `middle-click-terminal.e2e.mjs`).
  3. Click the same link again → row 0 is repoB, because of the last pick.
  4. Esc closes, and focus returns to `.xterm-helper-textarea`.
  5. Click `Update(src/index.ts)` → only the path cells are a link: hovering the `U` cell shows
     no pointer link, by the provider's `provideLinks` range (assert via `__termLinkProviders`
     ranges) and by a real click at the `U` cell, which opens nothing.
  6. Click `…/repoB/src/index.ts` → it opens directly (a single suffix candidate under repoB).
  7. Stale: delete `repoA/src/index.ts` on disk, click the link, and pick repoA → a toast
     containing "no longer exists" appears and no new tab opens.
- [ ] Orchestrator: `npm run e2e -- terminal-path-links-v2`.

### Slice 5: Link menu + Open as new session

**Check:**
- `npx vitest run test/unit/term-menu.test.ts` passes.
- `npm run verify` is green.
- Orchestrator: `npm run e2e -- terminal-link-menu`, then `npm run e2e:remote --full`.

**Parallel groups:** G1: T5.1 · Serial: T5.2, T5.3
**Claims (serial lane):** `webview/components/terminal-pane.tsx`, `webview/components/center-pane.tsx`, `webview/app.tsx`

#### Task 5.1: menu builder

**Files:** Modify: `webview/term-menu.ts`, `webview/components/path-candidate-picker-model.ts`
and `webview/components/path-candidate-picker.tsx` (`actionLabel: string` →
`action: LinkMenuAction`; `pickerHeading(token,total,action?: LinkMenuAction)`). Test:
`test/unit/term-menu.test.ts`, `test/unit/path-candidate-picker-model.test.ts`.

**Interfaces — Produces:** `LinkMenuAction`, `LinkMenuContext`, `LinkMenuItemSpec`,
`buildLinkMenuItems` (Contracts).

**Steps:**
- [ ] Failing tests:
  - 'file link': ids `[open, copyPath, copyRelativePath, reveal, openAsSession]` with
    separators before `copyPath` and `openAsSession`, and `openAsSession.hint === 'in Proj'`.
  - 'file link with 3 matches': `[open, showAll, …]`.
  - 'dir link single': `[copyPath, copyRelativePath, reveal, openAsSession]`, with no
    separator before `copyPath`.
  - 'ambiguous': `[showAll, copyPath(hint '3 matches'), …, openAsSession(hint '3 matches')]`.
  - `pickerHeading('x',3,'copyPath') === 'Copy path — pick a match'`.
  - Existing `buildTerminalMenuItems` cases unchanged.
- [ ] Run → FAIL. Implement.

#### Task 5.2: pane link menu + app/center wiring

**Files:**
- Modify: `webview/components/terminal-pane.tsx`:
  - `linkHoveredRef` (L162) → `hoveredLinkRef`;
  - `openContextMenu` (L854);
  - `suppressLinkMiddleDown` (L205);
  - the new props.
- Modify: `webview/components/center-pane.tsx` (props near L145-153, and forward at L341-351).
- Modify: `webview/app.tsx` (handlers near `openNewSession` L430, render at L4332-4335).

**Interfaces — Produces:**

```ts
type HoveredLink =
  | { kind: 'path'; key: string; token: string; line?: number; col?: number }
  | { kind: 'osc8-file'; uri: string }        // set from Slice 8 only
  | { kind: 'url' | 'commit' };
```

It is pane-private. The pane, center and app props are as in Contracts. **Consumes:**
`buildLinkMenuItems` (T5.1), `buildTerminalMenuItems` (unchanged), `TERM_LINK_STR`, T4.x.

**Steps:**
- [ ] `openContextMenu`:
  - If `hoveredLinkRef.current?.kind === 'path'`, read the cached resolution with
    `resolveCache.get([token], scope)` (a hit, because it was rendered) and rank it.
  - Compute `target` from `chooseClickAction`: open → `cand.isDir ? 'dir' : 'file'`, pick →
    `null`.
  - Items are `buildLinkMenuItems({target, matchCount: res.total, openAsSessionHint})` mapped
    to `MenuItem` (icons as Explorer's for the same actions,
    `webview/explorer-menu.tsx:153-181`), then the terminal items with `separatorBefore` on
    the first.
  - Any other hovered kind, or none, shows today's menu.
- [ ] Actions:
  - For a single target:
    - `open` → same as click;
    - `copyPath` → `navigator.clipboard.writeText(cand.absPath)`;
    - `copyRelativePath` → `cand.relToRepo`;
    - `reveal` → `onRevealFolder(cand.absPath)`. The host's `revealActionFor` opens a dir and
      selects a file in its folder;
    - `openAsSession` → `onOpenAsSession(cand.isDir ? cand.absPath : cand.repoRoot, sessionId, term.textarea ?? null)`;
    - `showAll` → picker mode `open` with every candidate.
  - Ambiguous: every item opens the picker in `{kind:'action', action}` mode, and the pick
    performs that action on the picked row. The probe runs for `open` and `openAsSession`
    (stale → toast).
- [ ] `center-pane.tsx`: forward `onOpenAsSession={onOpenAsSessionFromTerminal}` and
      `openAsSessionHint={openAsSessionHintFor?.(s.id)}`. `onSearchAllFiles` already landed in
      T4.6.
- [ ] `app.tsx`: implement `onOpenAsSessionFromTerminal` and `openAsSessionHintFor` as in
      Contracts.

#### Task 5.3: link menu e2e

**Files:** Create: `test/e2e/terminal-link-menu.e2e.mjs`.

**Steps:**
- [ ] Fixture: a temp non-git parent with `repoB` (git) holding `src/a.ts`, and a project
      created via `createProject(page,'LinkProj')`. Open a session at the parent in that
      project.
- [ ] `writeToTerminal` an absolute dir line `<parent>/repoB` (forward slashes), plus
      `repoB/src/a.ts`.
- [ ] Right-click the dir link for real (`page.mouse.click(x,y,{button:'right'})` after a
      move) → `.ctxmenu` lists, in order: "Copy path", "Copy relative path", "Reveal in
      Explorer", "Open as new session" with hint "in LinkProj", then "Copy", "Paste", "Find",
      "Clear".
- [ ] Choose "Open as new session" → `.modal.ns` is visible. Its home field equals repoB
      (compare with the `norm()` from `test/e2e/explorer-open-as-session.e2e.mjs`), and its
      project select is LinkProj.
- [ ] Press Escape → focus is on `.xterm-helper-textarea`.
- [ ] Right-click the file link → "Open" is first. Choosing "Open as new session" prefills
      home = repoB (its `repoRoot`).
- [ ] Right-click plain text → today's 4-item menu only (spec AC "Right-click on URL / commit
      link" unchanged; also assert on one URL line).

### Slice 6: MVP budget (stress)

**Check:** the orchestrator runs `npm run test:stress -- terminal-path-resolve` on an idle
machine. The 30-root warm p95 is ≤ 50 ms, and the 200-root warm p95 is ≤ 150 ms. The numbers,
plus the advisory concurrent-`readFile` p95, are recorded in
`docs/runs/2026-10-16-terminal-path-links/report.md`.

**Parallel groups:** Serial: T6.1
**Claims (serial lane):** none

#### Task 6.1: resolve budget scenario

**Files:** Create: `test/e2e/stress/terminal-path-resolve.stress.mjs`.

**Interfaces — Consumes:** `makeRepoFarm(root,{repos,filesPerRepo})`
(`test/e2e/stress/multi-repo-harness.mjs`), `runStress`, `openSession` and `emitReport` from
`test/e2e/stress/harness-stress.mjs`, and `machineIdle`.

**Steps:**
- [ ] Two farms in OS temp: 30 repos × 50 files and 200 repos × 10 files, each repo containing
      `src/index.ts`.
- [ ] Open a session at each parent and wait for `session.repos` to fill.
- [ ] Warm up with 5 posts, then post 50 `resolvePathToken` messages with 10 tokens each
      (mixed exact, suffix and miss). Measure the round-trip in the renderer.
- [ ] **Concurrent readFile latency:**
  - Measure the round-trip of 20 `readFile` posts for a fixed ~50 KB file, twice: alone, and
    interleaved with the 200-root resolve burst.
  - Emit both p95s as `##PERF## readFile.idle` / `readFile.underResolve`.
  - This is **advisory**, with no gate. A ratio above 2× is called out in the report as a
    main-thread contention finding for the orchestrator.
- [ ] Emit `##PERF##` p50/p95. Under load, report SKIPPED rather than loosening (the same rule
      as the multi-repo lane).
- [ ] Make no product change. If the budget fails, the deviation rule applies (a profile
      first, never a raised threshold).

### Slice 7 (v1): Context root, measured first

**Check:**
- `npx vitest run test/unit/terminal-context-root.test.ts test/unit/path-candidate-rank.test.ts`
  passes.
- `docs/runs/2026-10-16-terminal-path-links/context-root-evidence.md` exists with the counts
  and the decision.
- `RANK_KEYS` matches the decision.
- Orchestrator: `npm run e2e -- terminal-path-links-v2` passes with the v1 Gherkin step added.

**Parallel groups:** Serial: T7.1, T7.2, T7.3
**Claims (serial lane):** `webview/components/terminal-pane.tsx`

#### Task 7.1: `inferContextRoot`

**Files:** Create: `webview/terminal-context-root.ts`. Test:
`test/unit/terminal-context-root.test.ts`.

**Interfaces — Produces:** `CONTEXT_WINDOW_LINES`, `inferContextRoot` (Contracts).
**Consumes:** `detectPathTokens` (T1.1), `normalizeAbs`/`joinAbs`/`expandToken` (T2.1),
`ResolveRoot` (T2.2).

**Steps:**
- [ ] Failing tests:
  - `Bash(cd G:/work/repoA && npm test)` above → repoA's index (win32 fixture strings, with
    `platform:'win32'`).
  - `cd repoB` relative to cwd `/w` → repoB.
  - `git -C /w/repoB status` → repoB.
  - The nearest signal wins over a farther one.
  - An absolute path printed under repoA → repoA.
  - A signal outside every root is skipped, and the search continues farther up.
  - No signal → undefined.
  - Lines beyond `CONTEXT_WINDOW_LINES` are ignored.
  - Quoted `cd "/w/my repo"`.
- [ ] Run → FAIL. Implement.

#### Task 7.2: measure on real transcripts (read-only)

**Files:** Create: `docs/runs/2026-10-16-terminal-path-links/context-root-evidence.md`. Scratch
lives only in `%TEMP%\claude-scratch\`.

**Sources, read-only, never copied into the repo:**
- Claude Code transcripts `C:\Users\karam\.claude\projects\*\*.jsonl`. The local count at
  planning time was 20 top-level files.
- Conduit scrollback rings `%APPDATA%\conduit\scrollback-*.json`: `{version:2, segments:[{cols,rows,data}]}`
  of raw ANSI, 5 files of ~400 KB. Only the `.json` files are read, never `*.tmp-*`.

**Method** (the script in `## Scripts`):
1. **Ground truth from transcripts.**
   - For each assistant text block or tool result that prints a **relative** path, find the
     next `Read`/`Edit`/`Write` tool call whose absolute `file_path` ends with that relative
     path. That file's repo (its nearest `.git` ancestor on disk, checked with
     `fs.existsSync`) is the truth.
   - A sample counts as **ambiguous** when that relative path exists under ≥ 2 repos below the
     transcript's cwd. Check on disk, and skip any whose repos no longer exist.
   - Feed `inferContextRoot` the preceding ≤ 200 rendered lines, built from that transcript's
     text and tool inputs and outputs in order, nearest first. The roots are the repos found
     under the cwd.
   - Record hit / miss / no-signal.
2. **Rings.**
   - Replay each ring through `@xterm/headless` 6.0.0 (it is in `package.json`) at its
     `cols`/`rows`.
   - For each relative path token in the final buffer, record whether `inferContextRoot`
     returns a root (signal coverage only, since rings carry no ground truth).
3. Record, with no paths or content from the transcripts:
   - per-source counts;
   - signal coverage %;
   - top-1 accuracy on ambiguous samples;
   - the baseline accuracy of `RANK_KEYS` without `context` on the same samples.

**Decision rule** (set here, not by the executor):
- Keep `context` second in `RANK_KEYS` only if **ambiguous samples ≥ 30**, **accuracy ≥ 80 %**
  **and** accuracy > the baseline.
- Otherwise move it to just before `shorter` (tie-breaker), and record which bar failed.

**Steps:**
- [ ] Write the script in temp.
- [ ] Run it.
- [ ] Write the evidence file: a counts table, the bar, and the decision in one line.
- [ ] Delete the scratch files.

#### Task 7.3: wire the context root

**Files:** Modify: `webview/components/terminal-pane.tsx`, `webview/path-candidate-rank.ts`
(`RANK_KEYS` per T7.2), `webview/components/path-candidate-picker-model.ts` (no signature
change; `workingHere` already exists), `test/unit/path-candidate-rank.test.ts`,
`test/e2e/terminal-path-links-v2.e2e.mjs`.

**Steps:**
- [ ] At click or right-click time, collect up to 200 logical lines above the token's
      `firstRow` (nearest first, via `buildLogicalLine` walking up), then call
      `inferContextRoot`. Pass `contextRootIdx` to `rankCandidates` and `pickerRows`. The
      "Working here" label is text.
- [ ] Update the rank test for the decided `RANK_KEYS` order:
  - kept: the Gherkin v1 case puts repoA first even with lastPick repoB;
  - tie-breaker: lastPick wins, and context only splits otherwise-equal rows.
- [ ] E2E step: write `Bash(cd <parent>/repoA && npm test)` then `src/index.ts`, and click.
  - If kept, assert row 0 is repoA with "Working here".
  - If tie-breaker, assert the "Working here" label is on the repoA row.

### Slice 8 (v1): OSC 8 and `file://` targets, confined host-side

**Check:**
- `npx vitest run test/unit/link-target.test.ts test/unit/path-link-confine.test.ts test/unit/path-link-resolver.test.ts`
  passes.
- `npm run verify` is green, including `npm run security`.
- The Task 8.4 review has signed off.
- Orchestrator: `npm run e2e -- terminal-osc8-file-link`, `npm run e2e -- terminal-osc8-link`,
  then `npm run e2e:remote --full`.

**Parallel groups:** G1: T8.1 · G2: T8.2 · Serial: T8.3, T8.4, T8.5
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/components/terminal-pane.tsx`

#### Task 8.1: classify + decode

**Files:** Create: `src/link-target.ts`. Test: `test/unit/link-target.test.ts`.

**Interfaces — Produces:** `LinkUriClass`, `classifyLinkUri`, `decodeFileUri` (Contracts).

**Steps:**
- [ ] Failing table. `classifyLinkUri`:
  - `https://x`, `HTTP://x` and `mailto:a@b` → external.
  - `file:///G:/a.ts`, `G:/a.ts`, `G:\a.ts` and `/a.ts` → file.
  - `javascript:alert(1)`, `JAVASCRIPT:…`, ` javascript:` (leading space), `data:text/html,…`,
    `vscode://…`, `src/a.ts` and `` → ignore.
  - Scheme-less `\\host\x`, `//host/x`, `\\?\UNC\h\s\x`, `\\.\pipe\x` and `\\?\G:\root\x` →
    ignore.

  `decodeFileUri`:
  - `file:///G:/w/a%20b.ts#L42` win32 → `{path:'G:/w/a b.ts', line:42}`.
  - `file:///w/a.ts:3:4` posix → line 3, col 4.
  - `file://localhost/w/a.ts` → `/w/a.ts`.
  - `file://evil/share/a` → null.
  - `file:///w/%2e%2e/etc/passwd` → `/etc/passwd`. Decode then normalise; confinement (T8.2)
    is what refuses it, and this case pins that the decoder never hides `..`.
  - `file:///w/a%00b` → null.
  - `file:///w/%252F` → the literal `%2F` name, because it is decoded once.
  - `file:relative` → null.
  - UNC and device forms → null:
    - `file:////host/share/x` (empty authority, then a `//` path);
    - `file:///%5C%5Chost/x` and `file:///%5c%5chost%5cx`;
    - `file:///%5C%5C%3F%5CUNC%5Ch%5Cs` (decodes to `\\?\UNC\h\s`);
    - `file:///%5C%5C.%5Cpipe%5Cx`;
    - `file:///%2F%2Fhost/x` (decodes to `//host/x`);
    - `file:///G:/../../%2F%2Fhost/x` (UNC-like only after `normalizeAbs`);
    - scheme-less `\\host\x`, `\\?\G:\root\x` (never unwrapped to `G:/root/x`) and `\\.\x`.
  - `G:\ROOT\x` scheme-less, win32 → `{path:'G:/ROOT/x'}`. Case is kept, and confinement folds
    it (T8.2).
- [ ] Run → FAIL. Implement by hand (no `new URL`). Call `isUncLike` (`src/path-token-normalize.ts`)
      on the decoded path **and** on the normalised path.

#### Task 8.2: confinement

**Files:** Create: `src/path-link-confine.ts`. Test: `test/unit/path-link-confine.test.ts`.

**Interfaces — Produces:** `ConfineDeps`, `confineToRoots` (Contracts). **Consumes:**
`realPathLeaf` (`src/path-guard.ts:100`, forward-slashed by the caller), `normalizeAbs`,
`isUncLike`, `PathPlatform` (`src/path-token-normalize.ts`), and `isAncestorOf`
(`src/owning-session.ts:82`) on folded keys.

The lexical step is pure string work with platform and case injected. It does **not** call
`isInsideRoot`, whose `path.resolve` and win32 folding depend on the running OS and would make
the win32 cases untestable on ubuntu.

**Steps:**
- [ ] Failing **pure** tests, with a spy `realPathLeaf` (identity unless a mapping is given),
      `platform:'win32'` and string fixtures:
  - 'outside every root → null, and realPathLeaf is never called'.
  - 'UNC/device input → null, and realPathLeaf is never called', for each of `//host/x`,
    `\\host\x`, `//?/G:/root/x`, `\\?\G:\root\x`, `//./pipe/x`, `\\?\UNC\h\s\x`.
  - '`G:\ROOT\x` with root `G:/root`, caseSensitive:false → {root:'G:/root', real}'; the same
    with `caseSensitive:true` → null (and no realPathLeaf call).
  - '`..` escape (`G:/root/../other/x`) → null, and realPathLeaf is never called'.
  - 'nested roots → deepest'.
  - 'realpath leaves the root → null and NOT re-homed to the other root it lands in': the spy
    maps `G:/root/a/link/x` → `G:/other/x`, with `G:/other` also a root.
  - 'realpath that is UNC-like → null'.
  - 'root itself realpath'd': root `G:/root` maps to `H:/real-root`, and the file maps under it
    → ok, with `real` returned.
- [ ] Failing **fs** tests on real temp dirs via `test/helpers/temp-roots.ts`, as
      `test/unit/path-guard.test.ts` uses it, with the default `realPathLeaf`:
  - a symlink inside root A pointing into B → null;
  - a missing leaf under the root → the root (realPathLeaf walks up).
  - Skip the symlink case only where the helper itself reports symlinks unsupported.
- [ ] Run → FAIL. Implement in the Contracts order: steps 1–2 touch no fs.

#### Task 8.3: host `uri` branch + protocol field + pane dispatch

**Files:**
- Modify: `src/protocol.ts` (add `target?: 'uri'` to the `resolvePathToken` token entries).
- Modify: `src/path-resolve.ts` (`TokenResolution` gains `line?: number; col?: number`).
- Modify: `electron/path-link-resolver.ts`:
  - the token entry gains `target?: 'uri'`, and the `uri` branch lands per Contracts;
  - `PathLinkResolverDeps` gains `realPathLeaf: (t: string) => string`; main.ts passes
    `realPathLeaf` from `src/path-guard.ts:100`, forward-slashed;
  - the confinement roots are `userRootsOf(session, {platform, caseSensitive})` (T2.2), never
    the cwd-derived root.
- Modify: `electron/main.ts` (pass `realPathLeaf` into `createPathLinkResolver`).
- Modify: `test/unit/path-link-resolver.test.ts`.
- Modify: `webview/components/terminal-pane.tsx`:
  - `new Terminal({... allowNonHttpProtocols: true ...})` beside `linkHandler` at L241.
  - `linkHandler.activate` → `classifyLinkUri`:
    - external → today's code;
    - ignore → return;
    - file → **at activate time and uncached**, post one
      `{type:'resolvePathToken', requestId, tokens:[{alts:[uri], target:'uri'}]}` and await
      the matching `requestId` reply, with `LINK_RESOLVE_TIMEOUT_MS`. A timeout means nothing
      opens. Then run the same probe/stale/open path as an absolute token, using
      `candidates[0].absPath` (the realpath) and the reply's line/col.
  - The pending-reply helper is a pane-private `requestOnce(tokens): Promise<PathLinkReply | null>`.
    The path cache never sees uri targets.
  - `linkHandler.hover` sets `hoveredLinkRef = {kind:'osc8-file', uri}` for file-class URIs. A
    right-click resolves through `requestOnce` the same way before building the link menu.
  - The URL-token `activate` for a regex `file://` URL (row 19) takes the same file branch
    (confined, uncached).
  - The `window.open` fallback runs **only** for external-class URIs.

**Steps:**
- [ ] Failing resolver tests:
  - 'uri inside home → one exact-cwd candidate whose absPath is the realpath, with line'.
  - 'uri outside every root → zero; stat and realPathLeaf never called'.
  - 'UNC-form uri (`file:////h/s/x`) → zero; stat and realPathLeaf never called'.
  - 'javascript: as uri → zero'.
  - 'realpath escape → zero': the spy `realPathLeaf` maps into a sibling root.
  - 'a uri under a nested repo is confined to that repo': the roots come from `userRootsOf`.
  - **'cwd moved outside every user root → its repo is not a confinement root and not a UNC
    root'**:
    - fixture: home `/w`; the session's live cwd and `cwdGitRoot` are `/elsewhere/repoX`
      (moved by an OSC 9;9 report);
    - `file:///elsewhere/repoX/a.ts` → zero candidates;
    - with home `//srv/share` and cwd `//evil/share/repo`, the token `//evil/share/repo/a.ts`
      → not linked (resolver rule 2) and the uri → refused;
    - stat and realPathLeaf are never called in either case.
  - 'a uri entry in a mixed batch does not affect the other entries'.
- [ ] Implement. `npm run verify`.

#### Task 8.4: security review (gate for this slice)

**Files:** none. The output is the review's verdict, recorded in
`docs/runs/2026-10-16-terminal-path-links/report.md` under "OSC 8 security review".

**Steps:**
- [ ] A reviewer that did not write T8.1–T8.3 (`code-review` / `security-review` skill, Opus)
      checks the diff against this list.
  1. No path is built from a URI in the renderer.
  2. `new URL` is not used for `file:`.
  3. Decoding happens once.
  4. A host other than `''`/`localhost` is refused.
  5. Every UNC and device form is refused before any fs call, both after decoding and after
     normalising: `//`, `\\`, `//?/`, `//./`, `file:////`, `%5C%5C`, `\\?\UNC\`, `\\.\`.
  6. Lexical containment runs first and touches no fs. Realpath containment is checked against
     the **same** root, compared with that root's realpath, and the realpath is what opens.
  7. A refused target never reaches `stat`, `realPathLeaf` or `readFile`.
  8. `shell.openPath`/`openExternal`/`window.open` are never reached for a file-class URI.
  9. Dirs only go through `revealActionFor`.
  10. `javascript:`/`data:` are dropped before any dispatch, including in the bridge-less
      preview's `window.open` path.
  11. Limits are enforced host-side, per token.
  12. **`readGrants`:** opening a target calls `readFile`, which adds the path to `readGrants`
      (`electron/main.ts:2873-2882`), making it savable. Confirm that only a confined realpath
      can reach that `readFile` through the OSC 8 / `file://` path, and that no grant is added
      for a refused or unconfined target.
  13. Uri targets are resolved at activate time and never cached, so no stale confinement
      answer outlives a root change.
- [ ] **Blocker outcome:** if the reviewer finds containment that cannot be made clean, revert
      T8.3's `allowNonHttpProtocols` and `linkHandler` changes. Keep T8.1/T8.2 only if they
      have a caller: the regex `file://` dispatch keeps them, so they stay. Record "OSC 8
      deferred to v2" in the report and in Decisions. Rows 20 and 21 stay as today.

#### Task 8.5: OSC 8 e2e

**Files:** Create: `test/e2e/terminal-osc8-file-link.e2e.mjs`.

**Steps:**
- [ ] Copy the setup of `test/e2e/terminal-osc8-link.e2e.mjs` (it writes OSC 8 through
      `window.__terms[s].write` and uses `spyMain(app,[{api:'openExternal'}])`). Terminal
      writes go through `writeToTerminal`.
- [ ] Cases, each a real click at the label's cells:
  1. `ESC]8;;file:///<home>/src/a.ts#L3 ESC\ label ESC]8;; ESC\` → an editor tab opens
     `src/a.ts` at line 3. `openExternal` gets 0 calls.
  2. A scheme-less `<home>/src/a.ts` target → opens.
  3. A target outside the session roots (a second temp dir) → no tab opens, and `openExternal`
     gets 0 calls.
  4. `javascript:window.__pwned=1` → `window.__pwned` stays undefined, and no tab or external
     call happens.
  5. A regex-detected visible `file:///<home>/src/a.ts` → opens in-app.
  6. A visible `file:///<outside>/x.ts` → nothing opens. This pins the confined-`file://`
     asymmetry (see Decisions).
  7. An OSC 8 target `file:////localhost/c$/x` (UNC form) → nothing opens, and the host log
     shows `uri-refused`.
  8. The existing https case stays covered by `terminal-osc8-link`.

### Slice 9 (v1): Remaining matrix rows

**Check:** the named unit files pass, `npm run verify` is green, and the orchestrator runs
`npm run e2e -- terminal-path-links-v2` with the palette step added.

**Parallel groups:** G1: T9.1 · G2: T9.2 · Serial: T9.3
**Claims (serial lane):** `webview/components/terminal-pane.tsx`, `webview/app.tsx`

#### Task 9.1: resolver extras (rows 18, 37, 40)

**Files:** Modify: `webview/terminal-links.ts`, `src/path-resolve.ts`, plus their tests
(`test/unit/terminal-links.test.ts`, `test/unit/path-resolve.test.ts`). The UNC click-budget
case goes in `test/unit/path-link-resolver.test.ts`, with no change to
`electron/path-link-resolver.ts`.

**Steps:**
- [ ] Failing tests:
  - Row 37: a trailing `…` on the last segment (`src/util/a…`) adds a prefix match on the last
    segment over the indexes, kept only when there are ≤ 10 candidates, else none.
  - Row 40: an absolute token followed by up to 3 space-separated segments
    (`C:/Program Files/x/y.ts`) is detected with alts `[joined-3, joined-2, joined-1,
    shortest]`, longest first: 4 alts = `MAX_ALTS`. The resolver stops at the first existing
    alt (≤ 4 stats).
  - Row 18 (UNC):
    - `\\server\share\x.ts` is detected as a token (forward-slashed to `//server/share/x.ts`).
      Device forms `\\?\…` and `\\.\…` are **not** detected.
    - Resolution is resolver rule 2 (already built in T2.3). It links only when lexically under
      a UNC session root, with **no stat at resolve or hover time**. Otherwise it is plain text.
    - The click probe goes through the host `probe` with `UNC_PROBE_BUDGET_MS` (T4.1).
    - Tests:
      - the token is detected;
      - a session with root `//server/share` gives one candidate and 0 stat calls;
      - without that root, the token is not linked and gets 0 stat calls;
      - the click on an offline share is already covered by T4.1's probe-budget test. The pane
        treats the `null` as stale (T4.6), so nothing new is needed here.
- [ ] Implement.

#### Task 9.2: Ink hard-wrap heuristic (row 52)

**Files:** Modify: `webview/terminal-logical-line.ts`, `test/unit/terminal-logical-line.test.ts`.

**Steps:**
- [ ] Failing test: a row that is **not** `isWrapped`, whose string length is exactly `cols`
      and whose last char is a path char (`PC` class), joins the next row when that row starts
      (after up to 2 leading spaces, Ink's indent) with a path char. Neither condition alone
      joins.
- [ ] Implement inside `buildLogicalLine`, behind the same 2000-char limit.

#### Task 9.3: keyboard path (row 60)

**Files:**
- Modify: `webview/terminal-bus.ts`. Add `openDetectedLink(): void` to `TerminalApi` (L17),
  and add `export function openDetectedLinkIn(sessionId: string): boolean`, which returns false
  when no terminal is registered (it mirrors `requestTerminalFocus`, L101).
- Modify: `test/unit/terminal-bus.test.ts` (one case: it calls the registered api and returns
  false when there is none).
- Modify: `webview/components/terminal-pane.tsx` (implement `openDetectedLink` in its
  `registerTerminal` api).
- Modify: `webview/app.tsx`. Add one `PaletteEntry`
  `{ id: 'cmd:terminal-open-link', title: 'Terminal: Open Detected Link…', group: 'Commands', run: () => openDetectedLinkIn(activeId) }`
  in `commandItems` (`webview/app.tsx:3703`). It is listed only when `hasLiveTerminal(activeId)`.
- Modify: `test/e2e/terminal-path-links-v2.e2e.mjs`.
- `center-pane.tsx` is untouched.

**Steps:**
- [ ] The palette command opens the picker in `open` mode over the links of the active
      terminal's visible rows. It collects up to 10 resolved path tokens from the cache,
      deduped by key, with each row labelled by its token. Picking one runs the click action.
- [ ] Shift+F10 / ContextMenu key in the terminal opens the link menu for the link under the
      cursor cell if there is one, else today's menu, with `keyboard: true`.
- [ ] E2E step: open the palette (`openPalette(page,'Terminal: Open Detected Link')` from
      `test/e2e/middle-click-surfaces-helpers.mjs:180`), press Enter, then Enter → a tab
      opens.

### Slice 10: Changelog

**Check:** `npm run verify` is green, and `git status` shows only `CHANGELOG.md`.

#### Task 10.1: CHANGELOG

**Files:** Modify: `CHANGELOG.md`.

**Steps:**
- [ ] Add one user-facing entry:
  - links now work for tool headers, backticks, `…` truncation, `(l,c)` and `#L`;
  - ambiguous paths open a picker naming the repo or worktree, with the last pick first;
  - right-click a path to Open as new session;
  - the OSC 8 and `file://` links (or "deferred", per T8.4);
  - the remaining v1 rows.

## Execution order

```
(feat/repo-engine reviewed + merged) → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10
```

- The build starts **after** the in-flight review of `feat/repo-engine` (planned against HEAD
  `ca1c8ea0`). Rebase onto the reviewed tip first.
- If that review changes `projectFileIndexMeta`, `reposUnder`, `Session.repos`/`repoGit`, or
  `repoTopLevel`, Tasks 3.1 and 3.4 re-read those signatures before building. T3.4 edits
  `src/project-file-index.ts` and `src/repo-file-index.ts`, which the review was changing at
  planning time. T2.4 re-reads `electron/main.ts:1519-1543`.
- Under the deviation rule, any mismatch stops the task.
- **Solo and serial across slices.** S3–S5 and S7–S9 all edit
  `webview/components/terminal-pane.tsx`. S2, S3, S4 and S8 edit `electron/main.ts`, and S3
  and S8 edit `src/protocol.ts`. S4, S5 and S9 edit `webview/app.tsx`. S3 edits the engine's
  `src/project-file-index.ts` and `src/repo-file-index.ts`.
- Inside a slice, the listed parallel groups are file-disjoint, which was checked against each
  task's `Files:` list. The serial lane runs after them.
- Dispatching the groups in parallel is optional. A single executor running the tasks in order
  is equally valid.

## Verification

- **Per task:** the named vitest files, then `npm run verify:quick`.
- **Per slice:**
  - `npm run verify`, with the exit code captured directly.
  - Then the slice's e2e: locally by exact name, then `npm run e2e:remote`. Use `--full` for
    S2, S3, S4 and S8, which touch `electron/main.ts`, and for S5, which crosses the New
    session flow.
  - Serial, run by the orchestrator.
- **Slice 6:** the stress lane, local and idle.
- **Before each commit:** `git status` shows only the task's files, with no scratch from
  T7.2.
- **Runtime QA** (spec §13 list), by the orchestrator after S5 and again after S8, driving the
  built app:
  - rows 5, 20, 21, 44, 52 (Ink), 55, 57–60;
  - that the provider's `hover` fires before `contextmenu` on the same cell (spec §12). If not,
    `openContextMenu` hit-tests by calling the provider for the row under the pointer.
- **Rollback:** revert per slice. The renderer and host ship together (the IPC shape changes in
  S3), and there is no feature flag.

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked
signature doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the
work. Never route around it with a shim, a second copy, a special case, a widened type, a
fallback, or an override patched in place of its semantic source. The report leads with the fix
that keeps the locked decision.

## Decisions Needed

- **[high] OSC 8 ships in v1 behind the Task 8.4 review** (ruling 3).
  - Confinement is clean: the host decodes and confines with the ADR 0005 same-root rule.
  - Default taken: build it. If the review blocks, revert only the xterm option and the
    `linkHandler` change, and record "deferred to v2".
- **[high] Context-root bar** (ruling 2).
  - Keep it as key 2 only with ≥ 30 ambiguous samples, ≥ 80 % top-1 accuracy, and better than
    the ranking without it. Otherwise it becomes the tie-breaker.
  - With 20 local transcripts the sample may be thin. Too few samples means tie-breaker, the
    conservative side.
- **[normal] Confinement applies to every URI-shaped target:** OSC 8 targets and `file://`
  URLs, **including a visible `file://` URL** (critic nit, conservative).
  - **The asymmetry is deliberate:**
    - a visible plain absolute path (`G:/elsewhere/x.ts`) still opens outside every root, as
      today (spec §4; `readFile` is unconfined at `electron/main.ts:2873`);
    - the same file printed as `file:///G:/elsewhere/x.ts` does not open.
  - Reason: one confined URI path, with no second, unconfined decode path for visible URLs.
    The cost is a dead click on a visible out-of-root `file://` URL, pinned by T8.5 case 6.
  - The confinement root set is **user-chosen roots only**: `userRootsOf(session)`, meaning
    home, `session.roots`, and `session.repos` under them (re-check blocker).
    - The cwd's repo is **never** a confinement or UNC root in its own right. OSC 9;9 output
      can move the cwd (`trackCwd` on by default), so a cwd-derived root is attacker-steerable.
    - A cwd repo inside a user root is still covered by that enclosing root.
    - The global `repos.json` list is excluded.
  - URI targets resolve at activate time, uncached, and open the **realpath**, checked against
    the same root's realpath.
- **[normal] UNC and device paths:**
  - **Never stat'ed** at resolve or hover time.
  - Linked only when lexically under a UNC **user-chosen** root; otherwise not linked at all
    (critic blocker 2; the spec's named alternative).
  - The click probe is async and budgeted at 500 ms (`UNC_PROBE_BUDGET_MS`, T4.1).
  - Exact-cwd joins under a UNC cwd are reachable only for a user-chosen UNC cwd, because the
    T2.4 gate refuses any other UNC cwd report. Those joins are raced against the same 500 ms
    budget.
  - **The cwd-report gate (T2.4, folded into Slice 2):**
    - a terminal-reported UNC cwd outside every UNC user root is refused with no fs call;
    - every other cwd report is checked with an async stat, and the newest report wins;
    - **every** scanner result is reported, and the equals-current-cwd check runs inside
      `accept`, so A→B(slow)→A leaves the cwd at A;
    - the unit test (stat spy never called) is the red-first proof, and the `cwd.e2e.mjs`
      extension is a regression smoke.
    - Consequence: a user who types `cd \\server\share` in a session with no UNC root won't
      see the cwd follow. That is accepted; attaching the share as a root restores it.
  - Device forms (`\\?\`, `\\.\`) are never detected, and every URI decode refuses UNC and
    device forms (blocker 1).
  - This replaces the spec's "UNC with a 500 ms stat budget at resolve".
- **[normal] Per-token validation, `MAX_ALTS = 4`, `MAX_TOKENS = 10`** (blocker 3).
  - A bad entry yields `error:'invalid'` and the rest resolve. A trimmed entry keeps its
    **original** `alts.join('\0')` key.
  - More than 10 tokens are truncated.
  - Every reply carries `requestId`. `settle` releases every pending token of the batch, and
    absent ones count as uncached misses, so no token waits out the 10 s timeout on an
    empty/refused/invalid reply.
- **[normal] The cache is scoped by `cwd + rootsSig`.**
  - `rootsSig = rootsSigOf(session)` is computed locally by the pane from center-pane's session
    for lookups, and echoed by the host for stores. An attach, detach or repo discovery misses
    at once.
  - The reply's **echoed** cwd is the store scope.
  - A generation counter is bumped by `clear()` **and** `evictWhere()`. A stale-generation
    settle drops only its negatives and still stores its positives.
  - 0-candidate entries live at most `FILE_INDEX_TTL_MS` (5 s); positives live 30 s.
  - `fsChanged` evicts only 0-candidate entries.
  - The cache rework moved from Slice 4 to Slice 3 (T3.0), because the batch settle has to
    land with the new IPC shape.
- **[normal] Exact-root is answered by index membership**, but only for roots whose listing was
  `kind:'listed'`, fresh (not a stale last-good listing) and not walked or capped. Each
  composite repo is judged on its own, and the loose non-git walk never counts. T3.4 adds
  `covered` to the engine's index meta and stores it in the `unions` memo entry, so a memo hit
  keeps it.
  - Every other root falls back to stat.
  - A `WeakMap`-memoised `absSet` and `foldedRels` exist per index array.
  - Stats are only the ≤ 2 exact-cwd joins, absolute tokens, dir tokens and roots no index
    covers.
  - Consequence: a gitignored file in a **non-cwd** root is not an exact-root hit (it is still
    found from the cwd by its exact join).
- **[normal] `pathExists` becomes async** (`fs.promises.stat` via `pathLinks.probe`, T4.1). The
  reply shape is unchanged.
- **[normal] Slice 6 records concurrent `readFile` latency** as advisory. A ratio above 2× is
  reported, not gated.
- **[normal] Sync `realPathLeaf` stays** for click-time confinement only (Global constraints
  exception).
- **[normal] Row 19 (`file://` regex URL) moved from MVP to Slice 8.** It needs the same
  decode and confine, and building it twice would be a second copy.
- **[normal] Rows 16 and 17 (`/c/`, `/mnt/c/`) pulled into the MVP normaliser** (T2.1). They are
  pure string mapping inside a module being written anyway (overturns the spec's v1 placement).
- **[normal] Rows 3 and 42 (full) are MVP**, because the engine's composite index already
  exists (Spec staleness).
- **[normal] The live-region extraction was dropped** (overturns spec §10). The picker's focused
  `aria-label` announces the count on open.
- **[normal] `link-cwd` e2e semantics change.** A sibling repo's file now resolves as
  `exact-root`. The test keeps the cwd-vs-pin intent via `strength`.
- **[normal] `PathCandidate.relToRepo`** is added beyond spec §3.2, for "Copy relative path"
  (relative to `repoRoot`) without renderer path math.
- **[normal] `ResolveCtx.indexes` is per index** (`ResolveIndex` with `coveredRootIdx`) instead
  of `RootedFile[]` (no 20k-object copy).
- **[normal] Ranking key 6 orders by name only.** The engine exposes no git-index mtime.
- **[normal] A token's cell span = string offsets** (today's assumption). Wide characters before
  a path on the same logical line shift its underline.
- **[normal] The worktree tag is picker-local** (`repo-head__tag--worktree` span). `RepoTag`
  (`src/repo-scan.ts`) is not widened, since it is the scan's type.
- **[normal] The last pick lives in renderer module memory, per session.** It survives a pane
  remount, not a restart (spec: runtime-only).
- **[normal] File → Open as new session = `repoRoot`** (spec default kept). For a file under a
  non-git folder that becomes the containing folder.
- **[normal] A slice-local two-step in S2→S3.** The legacy sync resolver stays exported for
  exactly one slice so S2 is green alone, and T3.3 deletes it.
- **[normal] Dispatching the parallel groups is optional.** Across slices the lane is serial.
