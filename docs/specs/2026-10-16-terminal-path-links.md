---
status: draft
date: 2026-10-16
tier: FULL
supersedes-parts-of: archive/2026-06-17-terminal-path-links.md, archive/2026-06-22-comprehensive-path-links.md
---

# Feature Spec: Terminal path links v2 — multi-repo resolution, edge-case hardening, "Open as new session"

**Tier:** FULL   **Feature type:** UI
**One-line request (verbatim, condensed):** "If there is a path in the chat with an agent … right now we can
click it and it opens the file explorer … There should be the capability to right-click on that path and
… open that in a session … there are times that the agent gives an output that's truncated or gives a
relative path instead of an absolute path. Sometimes the relative paths are the same across multiple
repositories that might be visible to that session … I know we have a dropdown that helps but what happens
in different cases? … map out the different edge cases and essentially fix this and improve this as a whole."

Triage: FULL — two surfaces (terminal link layer + New session dialog entry), a host resolver contract
change, and a 50-row edge-case matrix. UI feature → §8–11 included.

## 1. Problem frame

- **Job:** when any agent (Claude Code, Codex, a shell) prints a path, one gesture gets me to the *right*
  thing — the file at its line, the folder, or a new session rooted there — even when the agent printed
  it relative, truncated, wrapped, or in a tool-header shape, and even when that relative path exists in
  20 repos under my session's folder.
- **Actors:** a user running agent sessions rooted in (a) one repo, (b) a parent folder of ~20 repos,
  (c) a "ticket" folder of git worktrees, (d) a home plus attached folders (mf-model).
- **Success outcomes (observable):**
  1. Every row marked **fix** in §2.2 links and opens the target.
  2. In a parent/ticket session an ambiguous relative path opens a picker whose **first row is the repo
     the agent is working in** (§3.3) and whose rows name the repo/worktree, not just a long relative path.
  3. Right-click on any path link offers **Open as new session**, which opens the New session dialog
     prefilled with the folder (dir) or the file's repo root (file).
  4. No row marked **keep** in §2.2 regresses (incl. today's 82 unit tests in `terminal-links.test.ts` +
     `path-resolve.test.ts`, measured green 2026-10-16).
- **Non-goals:** linking unverified prose (a path that resolves to nothing stays plain); symbol
  navigation; editing agent output; changing URL/commit-link behaviour beyond precedence; remote/SSH
  paths; a settings page for link behaviour.

## 2. Behavior & states

### 2.1 Today's pipeline (measured / inspected 2026-10-16 on `060ab730`)

| Stage | Today | Evidence |
|---|---|---|
| Detection | `detectPathTokens` (`webview/terminal-links.ts`) runs one regex over **one buffer row** (`line.translateToString(true)` in `terminal-pane.tsx` provideLinks). Alternates: POSIX abs, `X:\`/`X:/` abs, `./`, `../`, bare relative with ≥1 `/`, bare filename with an allowlisted extension (56 exts). Trailing `.,;)}]'"` trimmed. `:line[:col]` parsed. URLs detected first; overlapping path tokens dropped. | Ran the pure functions on 50 strings (§2.2) |
| Resolution | Host `resolvePathToken` → `resolvePathTokens(activeCwd(session), sessionGitRoot(session), tokens)` → `resolveToken` (`src/path-resolve.ts`): exact join on cwd, then cwd's git root; else segment-aligned suffix search over `projectFileIndex(root)`, shortest-first, cap 50. `.../` elision → suffix-search the tail. **Session `roots`, `repos`, `activeRepoRoot` are not inputs.** | Ran `resolveToken` with synthetic + real indexes; signature inspected (`electron/main.ts:708`) |
| Index for a non-git cwd | `git ls-files` fails → `walkFilesAsync(root, 20000)` BFS, **not gitignore-aware**. On `G:/awby/projects` (31 entries, real parent-of-many): 26,036 files, index capped at 20,000; `.venv/site-packages` included; **8 of 26 `src/index.ts` files missing** from the index. | `walkFilesAsync` run via esbuild bundle, 936 ms |
| Existence | Host-side `statKind` (`fs.statSync`, main thread), per exact candidate only. Suffix candidates come from the index (not re-stat'ed). | Source-read (ASSUMED) |
| Cache | Renderer `createTerminalTokenCache`, key = **raw token text only**, capacity 2048, no TTL. A 0-candidate answer is cached and never re-requested. | Measured: second `get` issued 0 requests and returned the cached empty result |
| Click: 1 file | `onOpenFile(abs, line, col, sessionId)` → editor tab at position; middle-click = background tab | Source-read (ASSUMED) |
| Click: 1 dir | `revealInExplorer` → `shell.openPath(dir)` (OS file manager) | Source-read (ASSUMED) |
| Click: N | `ContextMenu` dropdown: label = path **relative to the resolve root**, folder/file icon, `Showing first 50 matches…` disabled footer. ↑↓/Home/End/Enter/Esc; no filter, no grouping, no repo names. | Source-read (ASSUMED) |
| Right-click | Terminal content menu only (Copy · Paste │ Find · Clear) — **not link-aware**. | `term-menu.ts` |
| `file://` (regex) | Detected as a URL → `openExternal` → host `openExternalUrl` drops non-allowlisted schemes → **dead click** (underlined, does nothing). | `new URL(...).protocol === 'file:'` not in `EXTERNAL_SCHEMES` (evaluated in node) |
| OSC 8 | xterm's own provider; `linkHandler.activate` → `openExternal`. xterm filters OSC 8 to http(s) (we don't set `allowNonHttpProtocols`), so `file://` / scheme-less OSC 8 targets are not links at all. Claude Code emits OSC 8 for file paths; some versions with a **scheme-less absolute path** target ([anthropics/claude-code#78833](https://claudeissues.com/issue/78833-bug-file-path-osc-8-hyperlinks-lack-file-scheme-clicks-do-nothing-in-vs-code-ter)). | Inspected + docs/runs/2026-09-03 report; whether the visible label then falls through to our regex is ASSUMED |
| Wrapped rows | Not joined. A path split at the wrap yields two tokens: `G:/work/repoA/src/` (resolves to the **dir** → click reveals a folder) and `util/a.ts` (suffix search). | Measured on the two halves |

### 2.2 Flow matrix

Contexts: **S1** single repo (cwd = repo root) · **S2** cwd = repo subdir · **S3** parent of many repos
(cwd non-git; synthetic `repoA`, `repoB`, `T-123/{repoA-wt,repoB-wt}` all containing `src/index.ts`) ·
**S4** ticket folder of worktrees · **S5** home + attached roots. "M" = measured with the pure functions
(synthetic index unless noted), "A" = ASSUMED (source-read only, not run; → §13 runtime-QA list). Verdict: keep / **fix** / new.

| # | Agent prints | Ctx | Today | M/I/A | Target | |
|---|---|---|---|---|---|---|
| 1 | `src/index.ts` | S1 | 1 → opens | M | same | keep |
| 2 | `src/index.ts` | S3 | 4 rows, shortest-first, labels `repoA/src/index.ts`… no repo context | M | ranked picker (§3.3), rows "repoB · src/index.ts"; context repo first from v1 | **fix** |
| 3 | `src/index.ts` | S3 real (`G:/awby/projects`) | 18 of 26 real matches; 8 silently absent (20k cap) | M | MVP: every repo with `src/index.ts` at its root via exact-root joins; v1: all 26 via the engine union index | **fix** |
| 4 | `src/index.ts` | S4 | 2 rows `repoA-wt/…`, `repoB-wt/…` | M | rows show worktree name + branch | **fix** |
| 5 | `src/index.ts` | S5 (home repoA, attached repoB) | only repoA indexed → 1 opens repoA | A | cwd exact (repoA) still opens directly; repoB reachable via link menu **Show all matches** | **fix** |
| 6 | `src/index.ts:42` / `:42:7` | any | line/col honoured | M | same | keep |
| 7 | `src/index.ts:42:7: error` / `…:7)` | any | parsed | M | same | keep |
| 8 | `src/index.ts(42,7)` (tsc/MSBuild) | any | token `src/index.ts(42,7` → 0 → plain | M | link, line 42 col 7 | **fix** |
| 9 | `src/index.ts#L42` / `#L42-L50` | any | token incl. `#L42` → 0 | M | link, line 42 | **fix** |
| 10 | `src/index.ts:42-50` | any | line 42, `-50` ignored | M | same (range select = vision) | keep |
| 11 | `src/index.ts line 42` / `File "x.py", line 42` | any | path links, line dropped | M | line parsed | **fix** |
| 12 | `./src/index.ts` | S1/S3 | as row 1/2 | M | same as 1/2 | keep/fix |
| 13 | `../repoB/src/index.ts` | S1 (cwd repoA) | 1 → opens; but `absPath` keeps `..` (`…/repoA/../repoB/…`) | M (real fs) | same, absPath normalised (dedupes with an already-open tab) | **fix** |
| 14 | `../webview/app.tsx` | S2 | opens; label `src/../webview/app.tsx` | M | label `webview/app.tsx` | **fix** |
| 15 | `G:\work\repoA\src\index.ts` / `G:/…` / `g:/…` | any | 1 → opens | M | same | keep |
| 16 | `/g/work/repoA/src/index.ts` (Git Bash/MSYS) | win32 | 0 → plain | M | map `/x/` → `X:/` on win32, then stat | **fix** |
| 17 | `/mnt/g/work/…` (WSL) | win32 | 0 | M | map `/mnt/x/` → `X:/` on win32 | **fix** |
| 18 | `\\server\share\x.ts` (UNC) | win32 | not detected | M | detect; resolve **without** a blocking stat (§4) | new |
| 19 | `file:///G:/work/repoA/src/index.ts` | any | URL → dead click | M | decode → path → same as row 15 | **fix** |
| 20 | OSC 8, target `file:///…` | any | not a link (xterm filter) | A | open as path (§3.5) | **fix** |
| 21 | OSC 8, target scheme-less `G:/…` (Claude Code #78833) | any | not a link | A | treat as path | **fix** |
| 22 | OSC 8, `https://…` | any | opens browser | M (e2e `terminal-osc8-link`) | same | keep |
| 23 | `~/foo/bar.ts` | any | token resolved as `<cwd>/~/foo/bar.ts` → 0 | M | expand `~` host-side | **fix** |
| 24 | `` `src/index.ts` `` (Codex/plain markdown) | any | token includes backticks → 0 | M | strip backticks | **fix** |
| 25 | `"src/index.ts"` / `'…'` | any | links | M | same | keep |
| 26 | `(src/index.ts)` | any | token `(src/index.ts` → 0 | M | strip unbalanced `(` | **fix** |
| 27 | `● Update(src/index.ts)` / `Read(…)` / `Write(…)` (Claude Code tool header) | any | token `Update(src/index.ts` → 0 — **the most common Claude Code shape is dead** | M | link the parenthesised path | **fix** |
| 28 | `[index](src/index.ts)` markdown link | any | `(src/index.ts` → 0 | M | link the target | **fix** |
| 29 | `app/(group)/page.tsx` (Next.js route group) | any | token kept whole | M | keep balanced parens; try both candidates | keep |
| 30 | `⎿ Read src/index.ts (120 lines)` / `• Edited src/index.ts (+3 -1)` (Codex) | any | links | M | same | keep |
| 31 | `See src/index.ts.` / `src/index.ts, and` | any | trailing punct trimmed | M | same | keep |
| 32 | `…/src/index.ts` (Unicode ellipsis — Claude Code truncation) | any | token kept with `…` → 0 → **plain** | M | treat `…` like `...` (suffix search) | **fix** |
| 33 | `.../src/index.ts` | S3 | 4 (all) | M | same, ranked | fix (rank) |
| 34 | `G:\work\…\src\index.ts` | any | 0 | M | elision; head `G:/work` constrains candidates | **fix** |
| 35 | `G:/work/repoB/.../index.ts` | S3 | head discarded → also returns `repoA/src/index.ts` | M | only candidates under `G:/work/repoB` | **fix** |
| 36 | `…rc/util/a.ts` (truncated mid-segment) | any | 0 (`…` not an elision marker, row 32) | M | first post-elision segment matches as a segment **suffix** | **fix** |
| 37 | `src/util/a…` (tail-truncated) | any | token `src/util/a…` (→ 0 unless it exists) | M | v1: prefix match on last segment if ≤ 10 candidates; else plain | v1 |
| 38 | `repoA/src/my file.ts` (spaces, unquoted) | any | two dead tokens | M | stays unlinked (FP risk) | keep |
| 39 | `"repoA/src/my file.ts"` (quoted, spaces) | any | split → dead | M | quoted span tried whole first | **fix** |
| 40 | `C:/Program Files/x/y.ts` unquoted | any | split into `C:/Program` + `Files/x/y.ts` | M | v1: absolute token extended over spaces until an existing path (≤ 3 stats) | v1 |
| 41 | `index.ts` bare | S1 | 1 | M | same | keep |
| 42 | `index.ts` bare | S3 real | 42 matches in one flat list | M | ranked picker with filter | **fix** |
| 43 | `README`, `Makefile`, `Dockerfile`, `.env` | any | not detected | M | known extensionless names allowlisted | **fix** |
| 44 | `foo.mts`, `x.lua`, `y.tf`, `z.csv`, `log.log` | any | not detected (ext not in the 56) | A | allowlist derived from the language registry | **fix** |
| 45 | `src/` / `webview/` (dir, trailing slash) | S1 | not detected | M | detect; resolves to a dir via exact joins only (the suffix index is files-only) | **fix** |
| 46 | `repoA` (bare dir name, no slash) | S3 | not detected | M | stays unlinked (FP risk) | keep |
| 47 | `G:\work\repoA` / `…\` | any | dir → reveals; label `/` or `repoA//` with trailing slash | M | same action; clean label | fix (label) |
| 48 | `src\index.ts` (relative, backslash) | any | not detected | M | detect | **fix** |
| 49 | `a/src/index.ts` `b/src/index.ts` on `diff --git`/`---`/`+++` lines | any | `a/…`, `b/…` → 0 | M | strip `[ab]/` on diff-header lines | **fix** |
| 50 | `@scope/pkg/index.ts` | any | token kept; 0 unless exists | M | same | keep |
| 51 | `http://localhost:3000/src/index.ts` | any | URL wins | M | same | keep |
| 52 | long path wrapped across 2 rows | any | split; first half may resolve to a **dir** | M (halves) | join soft-wrapped rows (`isWrapped`, ≤ 2000 chars). Claude Code's Ink UI hard-wraps (no `isWrapped`) — fix ASSUMED ineffective there; v1 heuristic: join when a row ends exactly at the last column inside a path token | **fix** |
| 53 | `src/index.ts` after the agent created the file | any | if first seen before creation: 0 cached forever | M | cache entry TTL + invalidate on `fsChanged` | **fix** |
| 54 | `src/index.ts` after a shell `cd` to another repo | S3 | cached answer from the old cwd reused | M (key is token only) | cache key includes resolve context | **fix** |
| 55 | candidate deleted between resolve and click | any | open fails (surface ASSUMED) | A | toast "No longer exists", re-resolve | **fix** |
| 56 | agent prints path in repoB while session cwd = parent (agent cd'd internally; no OSC 7) | S3 | cwd never moves (agents don't emit OSC 7) | A | context-repo inference (§3.3) | new |
| 57 | right-click a dir link | any | terminal menu only | A | link menu with **Open as new session** | new |
| 58 | right-click a file link | any | terminal menu only | A | link menu; Open as new session targets the file's repo root | new |
| 59 | right-click an ambiguous link | any | terminal menu only | A | link menu; actions apply to a picked candidate (§3.4) | new |
| 60 | keyboard-only user wants a link | any | no keyboard path | A | v1 "Open detected link…" palette command | new |

### 2.3 Target flow

1. **Detect** (renderer, pure): per *logical line* (soft-wrapped rows joined), emit tokens with ordered
   alternative raws (e.g. `Update(src/index.ts` → [`src/index.ts`]) and parsed line/col.
2. **Resolve** (host, batched per line, all stats async): candidates of three strengths —
   - `exact-cwd`: token joined to the live cwd, then to the cwd's git root (today's rule 1, unchanged);
   - `exact-root`: token joined to each *other* session root (home, attached, nested repos, worktrees);
   - `suffix`: segment-aligned suffix search (MVP: over the cwd root's index as today, plus attached roots'
     indexes; v1: the engine's union index).
   Each candidate carries `rootIdx`, `relToRoot`, `repoRoot`, `strength`, `isDir`.
3. **Rank** (renderer, pure, *after* the cache — so position- and session-dependent signals never get
   cached): §3.3.
4. **Render**: 0 → plain; ≥1 → underlined on hover.
5. **Click**: an `exact-cwd` hit, or a single candidate overall → open directly (keeps "a terminal is a view
   of its cwd", `src/active-cwd.ts`). Otherwise → `PathCandidatePicker` (§8), row 1 preselected.
   Before opening, the renderer re-checks existence with the existing `pathExists` message; missing → stale.
6. **Right-click** on a link: link menu (§3.4). Elsewhere (incl. URL and commit links): today's terminal
   menu, unchanged.

Token states: `plain` · `resolving` (no underline, never blocks paint) · `link-single` · `link-multi` ·
`picker-open` · `opening` (no visual — the pathExists round-trip is local; > 300 ms shows nothing new) ·
`stale` · `resolve-failed` (= plain, logged once).

## 3. Data / interface contract

### 3.1 Detection (renderer, `webview/terminal-links.ts`)
- `detectPathTokens(logicalLine, ctx)` → `PathToken[]` gains `alts: string[]` (raws to try, in order;
  `raw` = `alts[0]`) and spans in logical-line offsets; the provider maps them to `{x,y}` buffer ranges
  across wrapped rows (VS Code's `getXtermLineContent` + `convertLinkRangeToBuffer` model).
- Limits: logical line > 2000 chars → no path links; the first 10 path tokens by start offset are resolved,
  the rest stay plain; token > 1024 chars skipped (VS Code's constants — proven defaults, no local data).
- Rules (each → a unit test): strip leading `` ` `` / unbalanced `(` `[` `<` (balanced parens such as
  `app/(group)/page.tsx` stay — whole token is `alts[0]`, the post-paren tail `alts[1]`); strip trailing
  `` ` ``; suffixes `:l`, `:l:c`, `(l)`, `(l,c)`, `#Ll`, `#Ll-Lm`, ` line l`, `", line l`; `…` == `...` as an
  elision segment, and a segment *beginning* with `…` is a partial segment; diff-header `[ab]/` strip;
  relative backslash paths; trailing-slash relative dirs; extensionless allowlist (Makefile, Dockerfile,
  Containerfile, Justfile, Procfile, Gemfile, Rakefile, LICENSE, README, CODEOWNERS, dotfiles `.env*`,
  `.gitignore`, `.editorconfig`); extension allowlist sourced from the language registry.

### 3.2 Resolution (host, `src/path-resolve.ts` + `electron/main.ts`)
```ts
// src/protocol.ts — webview → host (replaces today's shape; tokens stay strings for the common case)
{ type: 'resolvePathToken'; sessionId: string; tokens: Array<{ alts: string[] }> }
// host → webview
{ type: 'resolvePathTokenResult'; sessionId: string; rootsHash: string;
  roots: ResolveRoot[]; results: TokenResolution[] }

interface ResolveRoot { abs: string; kind: 'cwd-repo'|'home'|'attached'|'nested'|'worktree';
                        name: string; branch?: string; worktreeOf?: string }
interface PathCandidate { absPath: string; rootIdx: number; relToRoot: string; repoRoot: string;
                          isDir: boolean; strength: 'exact-cwd'|'exact-root'|'suffix' }
interface TokenResolution { key: string;            // alts joined by \0 — the cache key part
                            candidates: PathCandidate[]; truncated: boolean; total: number;
                            error?: 'timeout'|'session-gone' }   // renderer treats any error as plain
interface ResolveCtx { cwd: string; roots: ResolveRoot[]; index: RootedFile[]; caseSensitive: boolean;
                       homeDir: string; platform: 'win32'|'posix'; cap?: number /* 200 */ }
interface RootedFile { file: IndexedFile; rootIdx: number }   // wraps, never mutates, IndexedFile
```
- **Roots** (deduped by `folderKey`): cwd's git root, `home`, present `roots`, `session.repos`. `kind` maps
  from `RepoInfo.tag` (`home|nested|attached`); `worktree` when `session.repoGit[root].isWorktree`, with
  `name = worktreeName`, `branch = repoGit[root].branch`.
- **Dedupe** by normalised `absPath` (case-folded on win32): keep the **deepest** root containing the file
  (a nested repo beats the parent home), which fixes the label, tag pill, `relToRoot` and `repoRoot`.
- **`repoRoot`**: the deepest root of kind cwd-repo/nested/worktree/home-if-git containing the file; else
  `git rev-parse --show-toplevel` in the file's folder (cached per folder); else the containing folder.
  Absolute tokens outside every root get `rootIdx = -1` and the same `repoRoot` fallback.
- **Stats**: every existence check is `fs.promises.stat`, concurrency 16, ≤ 200 roots × ≤ 3 alts per token.
  Paths are normalised (no `.`/`..`), `~` expanded, `/x/` and `/mnt/x/` mapped to `X:/` when
  `platform === 'win32'` (injected; unit tests pass it, never read `process.platform`).
- **Index**: MVP suffix search uses `projectFileIndexMeta` for the cwd root (today) and each attached root —
  a handful of entries, inside `fileIndexCache`'s 64-entry / 5 s TTL budget. Nested repos are reached by
  `exact-root` joins only (cheap stats), which covers the reported case (paths printed relative to a repo
  root). Suffix search over all nested repos waits for the engine's union index
  (docs/specs/2026-10-16-multi-repo-tracking.md §2 "Search") — it must not be built by fanning
  `git ls-files` over 200 repos through the shared cache.
- **Budget**: warm resolve of one line ≤ 50 ms p95 with 30 roots; ≤ 150 ms with 200 roots (stats only).
- UNC / `\\?\`: same async stat with a 500 ms per-path budget (one SMB timeout must not hold the line's other
  tokens; 500 ms is ~10× a LAN stat), else plain.
- Index staleness: a file newer than the 5 s index TTL is still found by the exact joins; only suffix hits
  can lag by ≤ 5 s.

### 3.3 Ranking (pure `rankCandidates`, renderer)
Keys in order: (1) `exact-cwd` > `exact-root` > `suffix`; (2) **context root** (v1): the root containing the
nearest absolute path or `cd <dir>` printed above the token within the last 200 logical lines of this
terminal (≈ one agent turn of output; tunable constant); (3) the root of this session's **last picked
candidate** (renderer state per session, runtime-only); (4) home; (5) attached in add order; (6) nested and
worktrees by name (engine git-index mtime when available); (7) shorter `relToRoot`, then `localeCompare`.
`activeRepoRoot` is deliberately **not** a key: auto-follow moves it on file focus, so opening a pick would
feed back into the ranking key (3) already covers, and `sessionGitRoot` documents that terminal resolution
ignores the pin.

### 3.4 Link context menu (`webview/term-menu.ts` builder)
Hit-test: the provider's `hover`/`leave` already fire per link; replace the boolean `linkHoveredRef` with
`hoveredLinkRef: { kind: 'path'|'osc8-file'|'url'|'commit'; token; resolution? } | null`. `openContextMenu`
reads it; non-path kinds keep today's menu. OSC 8 file links set it from `linkHandler.hover(event, uri)`.

Order follows the consistency spec, with Explorer's placement of **Open as new session** (own group after
Reference, `explorer-menu.tsx:174`):

| Group | File link | Dir link | Ambiguous link |
|---|---|---|---|
| Primary | Open | — (click reveals) | Show all matches |
| Reference | Copy path · Copy relative path · Reveal in Explorer | same | same, each hint `N matches` |
| Session | Open as new session (hint `in <project>`, as Explorer) | same | same, hint `N matches` |
| *(separator)* content | Copy · Paste │ Find · Clear (today's items) | same | same |

- `Copy path` copies the link target; `Copy` copies the terminal selection — adjacent but intentionally
  distinct (object group vs content group). `Copy relative path` is relative to `repoRoot`.
- **Open as new session** → `setNewSession({ home, projectId })` where `projectId` is the **clicked
  terminal's** session project (not `active`'s — split panes), `home` = dir, or for a file its `repoRoot`.
  The host-normalised path is passed in the same form Explorer passes. Never launches directly. Return focus
  to the terminal on dialog cancel (`newSessionReturnFocus`).
- Ambiguous: every item opens the picker in *pick-for-action* mode ("Copy path — pick a match"); the pick
  performs that action. No submenus (ContextMenu has none).
- Show in Files is out of scope (vision): `revealInTree` targets the active session's tree only.

### 3.5 OSC 8 + `file://`
- Set `allowNonHttpProtocols: true`; `linkHandler.activate` dispatches: `http(s)`/`mailto` → `openExternal`
  (unchanged, `window.open` fallback kept for the bridge-less preview only); `file:` → decode → path (line
  from `#L42` / `:l:c` suffix if present) → same open path as an absolute token, incl. the `pathExists`
  re-check (xterm underlines OSC 8 unconditionally, so a missing target ends in the stale toast); scheme-less
  absolute path → same; anything else → ignored. Never `shell.openExternal`/`shell.openPath` on a file
  target. Regex-detected `file://` URLs take the same path. Label ≠ target: the target wins (OSC 8 semantics).

### 3.6 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| path tokens (+alts, spans) | `detectPathTokens` | provider → `resolvePathToken` | yes |
| `resolvePathToken` / `Result` | provider / host handler (`main.ts:4202`) | host / provider | yes |
| roots list | session fields `home`, `roots`, `repos`, `repoGit` | resolver | producer **no** — read-only; mf-model / multi-repo-awareness producers unchanged |
| per-root file index | `projectFileIndexMeta` | resolver; quick-open/search/TS index | producer **no** — called for ≤ a few roots, shape untouched (wrapped as `RootedFile`) |
| union index (v1) | multi-repo engine | resolver | **no** — engine spec owns it; MVP doesn't need it |
| token cache | `webview/terminal-token-cache.ts` | provider | yes — key `alts + cwd + rootsHash`, TTL 30 s, cleared on `fsChanged` for a covered root and on `rootsHash` change |
| ranking inputs (context root, last pick) | renderer | `rankCandidates` | yes |
| hovered link | provider / OSC 8 handler hover | `openContextMenu` | yes |
| New session prefill `{home, projectId}` | link menu | `NewSessionModal` / `seedNewSession` | consumer unchanged (existing shape) |
| open-file request | picker / link | `onOpenFile` → editor | consumer unchanged; existence pre-checked via `pathExists` |

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| 0 candidates | Plain text (unchanged). |
| `exact-cwd` hit, others exist | Open the cwd hit; **Show all matches** in the link menu lists the rest. |
| 1 candidate overall | Open directly. |
| 2–8 | Picker, no filter field (fits without scrolling at ctxmenu row height). |
| 9–200 | Picker with filter field focused (past ~8 rows scanning loses to typing). |
| > 200 (`total` > cap) | Footer "Showing 200 of N" (locale-formatted) + "Search all files…" → Quick open prefilled with the token. |
| Mixed dirs and files | One list; folder icon; dir rows reveal; middle-click on a dir row does nothing (no background reveal). |
| Click while picker open / double click | Replaces the picker; never two. |
| Terminal scroll / resize / session switch while picker open | Picker dismisses (ContextMenu behaviour). |
| Target missing at click (file or dir) | Toast "`<name>` no longer exists"; cache entry evicted; line re-resolves on next paint. |
| `cd` / attach / detach root | `rootsHash`/cwd change → fresh resolution. |
| Same file via two roots | Deepest root wins (§3.2). |
| Worktrees of one repo | Separate rows `repoA-wt · feat/x`; never deduped. |
| 200 roots | Stats only, budget §3.2; no `ls-files` fan-out. |
| UNC share offline | 500 ms budget → plain; nothing blocks the main thread. |
| Line > 2000 chars / > 10 tokens | No host call / first 10 only. |
| OSC 8 `javascript:` or custom scheme | Ignored. |
| Absolute path outside every root | Opens; `repoRoot` via rev-parse fallback. |
| Right-click on URL / commit link | Today's terminal menu, unchanged. |
| Bridge-less preview | No path links (unchanged). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Ambiguous click | picker, best match preselected | no | Wrong-file auto-open is the hassle being fixed; Enter makes the best guess one keystroke |
| `exact-cwd` among many | open directly | no | Today's behaviour; terminal = view of its cwd |
| Open as new session | prefill dialog | no | Explorer parity; dialog picks the agent |
| File → new session home | file's `repoRoot` | no | Agents work at repo root |
| Candidate cap | 200 | no | Filter handles the rest; bounded message size |
| Filter shown at | ≥ 9 candidates | no | Above ~8 rows the list scrolls |
| Cache TTL | 30 s | no | Bounds staleness without re-resolving every repaint |
| Context window | 200 logical lines | no | ≈ one agent turn; measure in v1 |
| Unquoted paths with spaces | not linked (abs: v1 extend, ≤ 3 async stats — one per extra space-separated segment, bounded) | no | FP risk |
| Tail-truncation prefix match | only when ≤ 10 candidates | no | A partial last segment is weak evidence; more than a picker's worth means noise |

## 6. Scope slicing

- **MVP (must):** detection fixes (rows 8, 9, 11, 24, 26–28, 32, 34–36, 39, 43–45, 48, 49, 52 soft-wrap);
  resolver: `exact-root` joins over all session roots, attached-root suffix search, normalisation, `~`,
  `file://` (19), dedupe, `repoRoot` (rows 2, 4, 5, 13, 14, 23, 47); ranking keys 1, 3–7; cache key/TTL
  (53, 54); `PathCandidatePicker`; link menu incl. Open as new session (57–59); stale handling (55).
- **v1 (should):** context-root key 2 (row 56); engine union index (row 3, 42 full); OSC 8 file links
  (20–21); `/c/` + `/mnt/c/` (16–17); tail truncation (37); spaced absolute paths (40); UNC (18); Ink
  hard-wrap heuristic (52); "Open detected link…" palette command + Shift+F10 link-aware menu (60).
- **Vision:** Show in Files; Ctrl+click unlinked path-shaped text → Quick open (VS Code word links); range
  selection for `:42-50`; launch-directly modifier.
- **Out of scope:** remote/SSH paths; prose words; URL/commit detection changes.

## 7. Acceptance criteria

**EARS**
- When a path link with no `exact-cwd` candidate and more than one candidate is activated, the terminal
  shall open the candidate picker with the highest-ranked candidate selected.
- When a path link with an `exact-cwd` candidate is activated, the terminal shall open that candidate.
- When a path link is right-clicked, the terminal shall show the link menu above the terminal content items.
- When **Open as new session** is chosen, the app shall open the New session dialog with home = the directory
  (dir link) or the file's repo root (file link) and the clicked terminal's project.
- While a session has attached roots or nested repos, resolution shall try the token against every present root.
- If the chosen target no longer exists, then the app shall show a toast and not open an editor tab.
- If a link has a `file:` scheme, then the terminal shall open it in-app and never pass it to the OS shell.
- The resolver shall return normalised absolute paths, deduped to the deepest root.
- Resolving one line with 30 roots shall complete in ≤ 50 ms p95 warm (stress lane).

**Gherkin**
```gherkin
Feature: Ambiguous relative path in a parent-of-many session
  Background:
    Given a session whose home is a non-git folder containing repoA, repoB and T-123/repoA-wt, each with src/index.ts
  Scenario: MVP — repos named, last pick first
    Given the user earlier picked a file in repoB from a picker in this session
    When the user clicks "src/index.ts:42"
    Then a picker lists 3 matches labelled "repoB", "repoA", "repoA-wt · <branch>" with "repoB" selected
    And pressing Enter opens repoB/src/index.ts at line 42
  Scenario: v1 — the agent's working repo ranks first
    Given the terminal printed "Bash(cd G:/work/repoA && npm test)" above
    When the user clicks "src/index.ts"
    Then "repoA" is first and selected
  Scenario: Claude Code tool header
    When the terminal shows "● Update(src/index.ts)" and the user clicks the path
    Then only "src/index.ts" is underlined and the picker opens
  Scenario: Truncated path
    When the terminal shows "…/repoB/src/index.ts" and the user clicks it
    Then G:/work/repoB/src/index.ts opens directly

Feature: Open a printed folder as a new session
  Scenario: Directory link
    Given the terminal printed "G:\work\repoB"
    When the user right-clicks it and chooses "Open as new session"
    Then the New session dialog opens with that folder as home and the terminal's project selected
```

Every **fix**/**new** row in §2.2 becomes a table-driven unit test (detection, resolution with injected
stat/platform, ranking). Host/IPC changes get `test/e2e/terminal-path-links-v2.e2e.mjs` (picker, link
menu, Open as new session, stale toast via the `__termLinkProviders` hook), per CLAUDE.md.

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Path link | resolving / plain | plain text | — |
| Path link | link-single / link-multi | underline on hover | click |
| Picker | populated (2–8) | header "`src/index.ts` · 3 matches"; rows: **repoB** `src/index.ts` · tag pill (Home / Attached / Nested / Worktree) · branch for worktrees; v1 context row gets a "Working here" label | Enter/click opens; middle-click background (files) |
| Picker | populated (9–200) | as above + filter input focused | type to narrow |
| Picker | filter-empty | "No matches for "`q`"" | Esc clears filter |
| Picker | truncated (> 200) | footer "Showing 200 of N" + "Search all files…" | Quick open prefilled |
| Picker | pick-for-action | header "`<action>` — pick a match" | pick performs action |
| Picker | anchor | at the click point, flipped/clamped to the viewport like ContextMenu | — |
| Link menu | ideal | §3.4 | — |
| Open | stale | toast "`index.ts` no longer exists" | link re-resolves |
| Resolve | failed / host gone | plain text (logged once) | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Path link | open / choose | click; middle-click background; hover underline (no Alt+click — xterm `altClickMovesCursor`) | v1 (new): "Open detected link…" palette command; Shift+F10 / Menu key link-aware at the cursor cell — neither exists today | tap = click | link menu (§3.4) | canvas text; semantics live in picker/menu |
| Picker | pick, filter, dismiss | click row, middle-click, outside click closes | ↑↓ Home End, Enter, Esc (clears filter, then closes), typing filters | tap row | none | `role="listbox"` + `option`, `aria-activedescendant`; filter `role="combobox"` + `aria-controls`; header `aria-label` "3 matches for src/index.ts" |
| Link menu | §3.4 | right-click on link | inherited ↑↓/Enter/Esc | — | — | inherited `role="menu"` / `menuitem` |

Focus: picking a file moves focus to the editor tab; dismissing the picker/menu or picking a dir returns
focus to the terminal.

## 10. Accessibility & i18n (UI)

- **Keyboard:** picker and menu fully keyboard-operable once open; opening a link without a pointer is a
  real gap today and is closed in v1 (palette command, VS Code *Terminal: Open Detected Link…*).
- **Names:** each picker row's accessible name is the full `repoName / relToRoot`, even when visually
  middle-ellipsised; tag pills are text.
- **Announce:** picker open announces "`N` matches for `<token>`" — extract the module-private `announce`
  in `webview/project-announcer.ts` to a shared helper; stale toast uses the toast live region.
- **Colour:** "Working here" and tags are text, never colour alone. Visible focus on rows and the filter in
  all 3 themes and forced-colors. No motion carries meaning (inherits ContextMenu's fade).
- **i18n:** strings in one constants module beside `term-menu.ts`; counts via `countNoun`
  (`src/menu-selection.ts`); `Intl.NumberFormat` for "200 of N"; `localeCompare` for name ties. Rows
  ellipsise the path, never the repo name; layout tolerates +30%. Path spans `dir="ltr"` inside mirrored
  chrome.

## 11. Design tokens (UI)

Reuse `.ctxmenu` surface/elevation, `--accent-soft` row hover, `.term-path-link`, repo-picker tag pills and
the commit-picker filter input. **New:** `repo-head__tag--worktree` (semantic role "worktree", defined per
theme from existing palette variables — no raw hex). Picker portals to body like ContextMenu.

## 12. Assumptions

- Agents (Claude Code, Codex) don't emit OSC 7, so `session.cwd` stays at launch dir while the agent works
  elsewhere — hence context-root inference rather than cwd.
- The picker is a new component (ContextMenu has no filter/grouping); its filter/keyboard model reuses
  `BranchSwitcherList` / `commit-picker-menu.tsx`.
- `session.repos` lists nested repos and worktrees for a parent home; its bounded scan caps the root list.
- The provider's `hover` fires before a `contextmenu` on the same cell (verify in runtime QA).

## 13. Decisions Needed

- **[high] Ambiguous-click default.** Default: picker with best match preselected. Alternative: auto-open the
  top-ranked candidate and offer "Other matches…" — faster when ranking is right, wrong file when not.
- **[high] Context-root inference** (key 2, v1). ASSUMED that Claude Code/Codex print enough absolute paths or
  `cd` commands above a relative path to make it useful — measure on real transcripts before building it.
- **[normal] File → Open as new session target.** Default: the file's repo root. Alternatives: containing
  folder, or both items.
- **[normal] Suffix search across nested repos waits for the engine union index** (v1). If the engine slips,
  the interim is exact-root joins only (MVP) — not a 200-repo `ls-files` fan-out.
- **[normal] `allowNonHttpProtocols: true`** widens what xterm hands our handler; strict dispatcher §3.5;
  needs a security-review pass.
- **[normal] UNC paths** (v1, async 500 ms budget). Alternative: never link UNC.
- **[normal] `activeRepoRoot` excluded from ranking** (§3.3) — reverse only with a reason that survives the
  auto-follow feedback loop.
- **[normal] Runtime QA list (ASSUMED, source-read only):** rows 5, 20, 21, 44, 52 (Ink hard-wrap), 55, 57–60,
  and the §2.1 Existence / Click / Right-click / OSC 8 rows. Confirm each in the real app before or during
  the build.
- **[normal] Over budget** (~465 lines) only because of the §2.2 matrix, which was requested and doubles as
  the unit-test table.

## 14. Research notes (VS Code)

- Link types and priority (URI → file → folder → word); word links fall back to a workspace search with a
  picker; *Open Detected Link…*: https://code.visualstudio.com/docs/terminal/basics
- Suffix formats (`:l:c`, `(l,c)`, `#l`, `line l, column c`, Python `"f", line l`) and `[abciow12]/` diff
  prefix stripping:
  https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts
- Wrapped-line joining, `MaxLineLength` 2000, `MaxResolvedLinksInLine` 10, trailing-char trimming as extra
  candidates, cwd from shell integration:
  https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLocalLinkDetector.ts
- Word-link opener: exact match first, search across all workspace folders, open only when exactly one result
  ends with the text, else Quick Open prefilled; folders revealed in Explorer:
  https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkOpeners.ts
- xterm `allowNonHttpProtocols`: https://xtermjs.org/docs/api/terminal/interfaces/ilinkhandler/ ; Claude Code
  scheme-less OSC 8 file links:
  https://claudeissues.com/issue/78833-bug-file-path-osc-8-hyperlinks-lack-file-scheme-clicks-do-nothing-in-vs-code-ter ,
  https://claudeissues.com/issue/18717-bug-new-clickable-osc8-file-hyperlinks-do-not-work-in-vscode
- Where Conduit goes further: VS Code gives up on ambiguity (Quick Open); this spec ranks across roots because
  the parent-of-many session is the primary case here.
