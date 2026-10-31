# Plan: Conduit MCP app-control tools (Part B)

Spec: [2026-10-30-conduit-mcp-app-control.md](../specs/2026-10-30-conduit-mcp-app-control.md)
(FULL, reviewed). Depends on [2026-10-30-conduit-mcp-tool-policy.md](../specs/2026-10-30-conduit-mcp-tool-policy.md)
and builds on the Part A plan [2026-10-30-conduit-mcp-tool-policy.plan.md](2026-10-30-conduit-mcp-tool-policy.plan.md).

**Tier: FULL.** Seven new MCP tools, a new host↔renderer request/response (`mcp:ui` /
`mcp:uiResult`), reach enforcement, a git ref classifier, a module move (`normalizeUrl`), and
session-explicit renderer entry points. Crosses `src/`, `electron/` and `webview/`.

**Planned against `feat/mcp-policy` at `f380287b`.** Part A had not landed any code at planning
time (`git log`: only the spec and Part A plan commits; `src/conduit-mcp/tool-policy.ts`,
`window-waits.ts`, `call-flow.ts`, `src/window-presence.ts` absent). Every Part A name below is
the Part A plan's **Contracts** text; Part B starts only after Part A's S3 is merged on this
branch. Each task re-greps its Part A anchors first; where Part A's landed code differs from its
plan, the code wins and the task applies the deviation rule. v0.50 line numbers were grepped at
`f380287b`; Part A shifts them, so re-grep before editing.

## Goal

An agent can close or focus a session, attach a folder, close its files, open Review, open the
commit history at a ref, and open a URL in an in-app tab — each gated by its Part A policy
(access/when/reach/move), each doing what the matching UI action does to the **caller's** session
without changing which session is active or split, and each returning what actually happened.

## Architecture

- **Tool logic stays in `src/conduit-mcp/control-tools.ts`** (Part A's prepare/run shape). Each
  new tool gets a `prepare*` that parses, reserves its budget, resolves the target among
  **listed** sessions (N9), enforces `reach` and `move`, validates arguments, and returns a
  `PreparedCall<T>` whose `run()` does the IO. Main supplies IO through new `ControlDeps`
  members; the host supplies target listing, window lookup and the per-call UI channel.
- **Git ref work is a new host-only module** `src/conduit-mcp/git-refs.ts`: classify a ref,
  look up one `CommitNode`, find a folder's repo root. Git is an injected `GitCall`, so tests run
  on fakes (pattern: `src/range-preset.ts`).
- **`mcp:ui` is a second `createWindowWaits` instance owned by `call-flow.ts`.** It shares the
  ask path's in-flight keys, so `notifications/cancelled`, connection close, window reset and
  session moves end UI waits on the same code paths as asks. `CallFlow` gains `requestUi` and
  `answerUi`; the host routes `mcp:uiResult` with the sender's window id.
- **Routing:** UI actions go to the caller's owner window, except `closeSession`, which goes to
  the **target's** owner window — the only renderer that holds the target's docs and dirty
  buffers (Decision B2).
- **Renderer:** `webview/mcp-ui.ts` subscribes to `mcp:ui`, calls a handler set implemented in
  `webview/app.tsx`, and posts `mcp:uiResult`. App gains **session-explicit** entry points
  (`openReviewIn`, `openGitHistoryIn`, `closeFilesIn`, and a `keepActive` file-open option); the
  existing UI functions become thin wrappers that pass `activeIdRef.current`, so UI behaviour and
  every UI call site are unchanged.
- **The docs reducer gains `shown`** on `open` / `openReview`: a foreground open into a session
  that isn't the shown one lands active in that session's layout without re-pointing
  `DocsState.activeId` (today `openForeground` re-points it, `webview/docs.ts:376-377`, which is
  what a non-active `openWeb` target already does wrong).
- **History reveal:** `webview/history-reveal.ts` hands one pending `CommitNode` to the history
  view, which folds it into its displayed set and selects it the way a deep-search hit is
  selected — at any depth, no paging.
- **`normalizeUrl` moves** from `webview/web-url.ts` to `src/web-url.ts` (with
  `displayTitleForUrl`), so the host validates with the renderer's exact function.
- **No sketches.** Every seam copies a sibling: `git-refs.ts` copies `src/range-preset.ts`'s
  injected-git shape; the UI waits copy Part A's ask waits; `webview/mcp-ui.ts` copies
  `webview/mcp-ask-store.ts`'s subscribe pattern; the reveal store copies the module-singleton
  subscription in `webview/use-conduit-mcp.ts:36-49`.

## Data flow

```
CALL  CLI ─tools/call{id}─► core ─► host.callTool        (Part A: begin, gate steps 1–5)
   host prepare switch (7 new cases) ─► control.prepareX(caller, args, ctx{move, reach, ui})
      parse ─► reserve(budget) ─► resolveTarget(listed only) ─► inReach ─► move ─► args/git
      any refusal after reserve ⇒ release
   flow.runControl (Part A): on | ask(card) ─► run()
      host-side run:  focus_session ─► deps.activateSession(target)            (no reply)
                      attach_folder ─► deps.addRoot(target, abs) ─► roots
      UI run: ctx.ui(windowId, action)            (host binds callerSessionId + inflight)
              = flow.requestUi({inflight, callerSessionId, windowId, action})
                 waitsUi.open({id, key(inflight), windowId}, UI_TIMEOUT_MS)
                 sendToWindow(windowId, {type:'mcp:ui', requestId, sessionId, action})
                 ── await ──  answered ⇒ result | expired ⇒ ui_timeout
                              cancelled reply:true ⇒ window_not_ready | reply:false ⇒ (no reply)

RENDERER (target window)  bridge mcp:ui ─► webview/mcp-ui.ts useMcpUi(handlers)
   closeSession{target}: dirty = dirtyPathsOf(target)
        dirty ⇒ post uiResult{unsaved}         clean ⇒ post uiResult{closed}; post kill{target}   (same turn)
   closeFiles: await closeFilesIn(caller, paths|'all') ─► post uiResult{closed, skipped}
   openReview / openGitHistory / openUrl: session-explicit open ─► post uiResult{opened}
   main ─► host.handleRenderer(mcp:uiResult, reply, senderId) ─► flow.answerUi(requestId, senderId, raw)
        parseUiResult(kind, raw) null ⇒ ignored (wait times out)

CANCEL  notifications/cancelled / conn close  ─► flow (Part A) ─► waitsUi.cancel(key match, reply:false)
        window reset ─► flow.windowReset(w) ─► waitsUi.cancel(windowId === w, reply:true)
        session moved ─► flow.sessionMoved(s) ─► waitsUi.cancel(callerSessionId === s, reply:true)

OPEN_FILE (changed)  openMcpFile ─► openFileInEditor{sessionId: caller}  (Part A)
   renderer flushOsOpens: source 'mcp' ⇒ planFileOpen (never activates) ⇒ openFile(…, {keepActive})

DOCS  openReviewIn / openGitHistoryIn / openWeb / openFile(keepActive)
        dispatch open|openReview {sessionId: caller, shown: activeIdRef.current}
        reducer: openForeground(...) ─► finalize(focus = shown)
HISTORY  openGitHistoryIn(caller, repoRoot, commit) ─► requestHistoryReveal(repoRoot, commit)
        GitHistoryView (on mount / notify) ─► takeHistoryReveal(repoRoot) ─► dispatch reveal
```

## Settled decisions — do not re-litigate

- Seven tools: `close_session`, `focus_session`, `attach_folder`, `close_files`, `open_review`,
  `open_git_history`, `open_url`; inputs/results per spec §2.1.
- `mcp:ui` / `mcp:uiResult` request-response; a second `createWindowWaits` instance (Part A);
  5 s timeout; answers bound to the window the request went to; late reply dropped; CLI cancel →
  no reply; window reset → `window_not_ready`.
- Session-explicit renderer entry points; tools never read `activeIdRef` to pick their target and
  never call `setActiveId`, except `focus_session` (and Part A's `focus:true` session open).
- Ref classification per spec §2.2: leading `-` → `bad_ref` before git; `--end-of-options` on
  every git call; `--symbolic-full-name` decides the kind; `working` only as a range head.
- `normalizeUrl` moves to `src/`; host validates, renderer opens an in-app tab, never the OS
  browser.
- `open_file` opens in the caller's session (Part A routes it; Part B stops the renderer from
  activating it). `open_review` and `open_git_history` always focus their tab (in the caller's
  layout).
- Policy defaults per spec A §3.2 (`TOOL_SPECS` rows). Reach enforcement (`self` / `opened` /
  `window` / `any` via `ownerWindowOf` + `Session.openedBy`) and `move_not_allowed` land here
  (Part A N1). Targets are looked up among **listed** sessions only (Part A N9; `listedSessions`,
  `electron/conduit-mcp-host.ts:347-358`).
- Budgets from Part A: act (`close_session`, `attach_folder`), show (`focus_session`,
  `close_files`, `open_review`, `open_git_history`, `open_url`). A refusal at step 7 or 9
  refunds.
- `attach_folder` is `sessionOps.addRoot` unchanged; it never types `/add-dir`.
- `close_session` never confirms beyond the policy; dirty → `unsaved_changes`, nothing closed.

## Spec staleness

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| "For a split-partner caller, the tab activates inside that pane" (§2.1, §5 EARS 2) | The split partner shows only its terminal (`webview/components/center-pane.tsx:348-352`); doc tabs render for the active session only (`DocsState.layouts` per session, `webview/docs.ts:114-120`) | The tab opens active in the caller's own layout; active and split unchanged; it is shown when the human activates that session (Decision B1) |
| `close_session` dirty check runs in "the caller's owner window" (§2.1, §2.3 routing) | Docs and the dirty set are per renderer (`webview/app.tsx:641`, `docState`); a target in another window (reach `any`) has its docs there | `closeSession` goes to the target's owner window (Decision B2) |
| `attach_folder`: "home or an existing root gives success with roots unchanged", and "It is `sessionOps.addRoot`, unchanged" (§2.1) | `addRoot` refuses them with `is-home` / `duplicate` (`src/session-ops.ts:66-81`) | `addRoot` stays unchanged; `prepareAttachFolder`'s run maps `is-home` and `duplicate` to success with roots unchanged |
| Selection "the way a deep-search hit is selected (git-history-view.tsx:656)" | File is `webview/components/git-history-view.tsx`; :655-659 is the `selectedCommit` lookup over `searchable` (:406-412); selection is component-local `useReducer` state; no single-commit `git log -1` exists | New `reveal` history action + `webview/history-reveal.ts` hand-off; `lookupCommit` in `git-refs.ts` |
| "The singleton moves to the caller's session, as the UI does (app.tsx:1003)" | `openGitHistoryTab` starts at `webview/app.tsx:1006`; the move is `openForeground`'s transfer (`webview/docs.ts:351-357`) | Unchanged mechanism, driven by `sessionId: caller` |
| A non-active open target "just gets the tab" (implicit in §2.4 "UI callers keep their defaults") | `openForeground` → `finalize(…, s)` re-points `DocsState.activeId` to the target's tab (`webview/docs.ts:376-377`, `:316-317`) | `shown` on `open` / `openReview` (T2.1) |
| `open_file` "opens in the caller's session" | Part A sends to the caller, but `flushOsOpens` → `planFileOpen` activates on `focus` (`webview/file-open-request.ts:21-24`) and `openFile` switches active for a non-active target (`webview/app.tsx:2415-2418`) | `planFileOpen` never activates; `FileOpenNav.keepActive` (T2.4) |
| Part A S0 moved here: "whether every CLI accepts the new schemas" | Not measurable in this run (no real-CLI lane) | Flat schemas, no `oneOf`/`anyOf`/`allOf`/`$ref`, pinned by a unit test (Decision B5) |

## Global constraints

- **Gates and cadence** (memory: relevant tests only):
  - Per task: the named vitest file(s), red then green (`npx vitest run <file>`).
  - `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.webview.json --noEmit`: green
    after every task except T1.2–T1.4, which may leave `tsc` red **only** at the host's
    exhaustive prepare switch and `ConduitMcpHostDeps` construction in `electron/main.ts`; T1.5
    and T1.6 close those. No other red is allowed.
  - Per slice: the slice's Check, ending in `npm run verify:quick`.
  - **Once, after S3:** `npm run verify`; then `npm run e2e:remote -- conduit-mcp-app-sessions
    conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web conduit-mcp-policy
    conduit-mcp-control`; then `npm run e2e:remote` (`--affected`; `electron/main.ts` changes make
    this the full suite, `test/e2e/ci-affected.mjs:11-18`).
  - Locally at most one e2e by exact name. Never narrow, skip or disable a check; never pipe
    verify output through `tail`; capture exit codes directly.
- **Fallow:** every export below names its caller; a type used only in its own file stays
  unexported.
- **CI is ubuntu:** unit tests never depend on `\`, drive letters or `process.platform`. Paths in
  tests are POSIX; `folderKey` (`src/folder-key.ts:4`) is the only path comparison.
- **Comments explain WHY only**; spec pointers like `// spec 2026-10-30-conduit-mcp-app-control §2.2`.
  No `as any`, `@ts-ignore`, `!important`, swallowed errors, magic offsets.
- **Naming:** files kebab-case by role; tests `test/unit/<module>.test.ts[x]`; React tests start
  with `// @vitest-environment jsdom`. MCP wire fields `snake_case`; host↔renderer fields
  `camelCase`. Constants `SCREAMING_SNAKE`.
- **Git:** only via `runGit` (`src/git-exec.ts`, imported in `electron/main.ts:75`). Every
  user-supplied ref goes after `--end-of-options`; a value starting with `-` never reaches git.
- **Trust boundaries:** every tool argument is validated host-side; every `mcp:uiResult` is
  re-parsed against the action kind it answers (`parseUiResult`) and must come from the window the
  request was sent to. The renderer is never load-bearing for policy or reach.
- **Renderer rules (CLAUDE.md):** no new overlay; no DOM focus moves on tool-driven opens (A4);
  new class names none.
- **E2E:** launch only via `runScenario` (it calls `launchElectron` / `finishScenario`,
  `test/e2e/harness.mjs:1124`); hidden, serial; terminal writes through the harness helpers.
- **Strings:** all copy in `webview/conduit-mcp-strings.ts` (`MCP_STR`); tool names and handles
  literal.
- **User-facing changes:** `CHANGELOG.md` (T3.6).

## Out of scope

- v1 tools: `detach_folder`, history `query`, `open_file` range highlight, external-browser
  `open_url`.
- Argument-pattern policies (URL/path allowlists), time-based policies, PR review.
- Any change to `sessionOps.addRoot`, the popup gate, webview hardening, the `kill` IPC handler.
- A real-CLI schema-acceptance lane (Decision B5).

## Contracts

### `src/web-url.ts` (moved from `webview/web-url.ts`) — T0.1

Byte-identical bodies of `normalizeUrl(input: string): string | null` and
`displayTitleForUrl`, plus the private `isLocalHost`. `webview/web-url.ts` is deleted.

### `src/conduit-mcp/types.ts` — T1.2

`ToolErrorCode` gains `'unknown_session' | 'out_of_reach' | 'move_not_allowed' | 'bad_ref' |
'bad_url' | 'not_a_repo' | 'attach_refused' | 'unsaved_changes' | 'ui_timeout'`. `RETRYABLE`
unchanged (a `ui_timeout` outcome is unknown; retrying could act twice).

### `src/conduit-mcp/tool-policy.ts` (Part A) — T1.2

```ts
export const SESSION_TOOL_NAMES =
  ['open_session', 'open_terminal', 'close_session', 'focus_session', 'attach_folder'] as const;
export const EDITOR_TOOL_NAMES =
  ['open_file', 'close_files', 'open_review', 'open_git_history', 'open_url'] as const;
// TOOL_SPECS rows (spec A §3.2):
//   close_session:    fields ['access','when','reach'],         all access, reach ['self','opened','window','any'], 'act',
//                     defaults {access:'ask', when:'viewing', reach:'window'}
//   focus_session:    fields ['access','when','reach','move'],  all access, reach ['self','opened','window','any'], 'show',
//                     defaults {access:'on',  when:'viewing', reach:'window', move:'yes'}
//   attach_folder:    fields ['access','when','reach'],         all access, reach ['self','opened','window'],       'act',
//                     defaults {access:'ask', when:'viewing', reach:'self'}
//   close_files, open_review, open_git_history, open_url:
//                     fields ['access','when'], all access, 'show', defaults {access:'on', when:'viewing'}
```

`isValidField(tool, 'reach', v)` is true only for values in that row's `reach` list.

### `src/conduit-mcp/ui-types.ts` (Part A) — T1.2

```ts
import type { RefEndpoint } from '../git-range';
import type { CommitNode } from '../protocol';

export type McpReviewScope = 'all' | 'staged' | 'unstaged';   // structurally = webview ReviewScope
/** Assignable to webview/docs.ts ReviewSource; repoRoot is always set by the host. */
export type McpReviewSource =
  | { kind: 'working'; scope: McpReviewScope; repoRoot: string }
  | { kind: 'commit'; sha: string; subject: string; repoRoot: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint; repoRoot: string };

export type McpUiAction =
  | { kind: 'closeSession'; target: string }
  | { kind: 'closeFiles'; paths: string[] | 'all' }
  | { kind: 'openReview'; source: McpReviewSource }
  | { kind: 'openGitHistory'; repoRoot: string; commit: CommitNode | null }
  | { kind: 'openUrl'; url: string; focus: boolean };

export interface CloseFilesOutcome {
  closed: string[];
  skipped: { path: string; reason: 'unsaved' | 'not_open' }[];
}
export type McpUiResult =
  | { kind: 'closeSession'; ok: true }
  | { kind: 'closeSession'; ok: false; unsaved: string[] }        // ≤ 20 paths
  | ({ kind: 'closeFiles' } & CloseFilesOutcome)
  | { kind: 'opened' }                                            // openReview | openGitHistory | openUrl
  | { kind: 'unknownSession' };                                   // the session isn't in this window

// AskSummary gains (placeholders for MCP_STR.ask.summary):
  | { tool: 'close_session'; target: Handle }
  | { tool: 'focus_session'; target: Handle }
  | { tool: 'attach_folder'; path: string; target: Handle }
  | { tool: 'close_files'; count: number; all: boolean }
  | { tool: 'open_review'; what: string }        // 'working', a short sha, or 'base…head'
  | { tool: 'open_git_history'; ref: string | null }
  | { tool: 'open_url'; url: string }
```

### `src/protocol.ts` — T1.2

```ts
// HostToWebview
  | { type: 'mcp:ui'; requestId: string; sessionId: string; action: McpUiAction }
// WebviewToHost (host re-parses `result` against the request's action kind)
  | { type: 'mcp:uiResult'; requestId: string; result: unknown }
```

`sessionId` is always the **caller**; `closeSession` names its target in the action.

### `src/conduit-mcp/git-refs.ts` (new, host-only) — T1.1

```ts
import { PRETTY_FORMAT, parseCommits } from '../git-history';   // PRETTY_FORMAT becomes exported (T1.1)
import type { RefEndpoint } from '../git-range';
import type { CommitNode } from '../protocol';
import { type Result, toolError } from './types';

export interface GitRun { ok: boolean; stdout: string; stderr: string }
export type GitCall = (cwd: string, args: string[]) => Promise<GitRun>;
export const MAX_REF_CHARS = 256;

/** Range endpoint (spec §2.2). Never called with the literal 'working'. */
export function classifyRef(git: GitCall, repoRoot: string, value: string): Promise<Result<RefEndpoint>>;
/** One commit with parents and full decorations (`git log -1`), at any depth. */
export function lookupCommit(git: GitCall, repoRoot: string, value: string): Promise<Result<CommitNode>>;
/** `rev-parse --show-toplevel` of `folder`, forward-slashed; not_a_repo on failure. */
export function repoRootOf(git: GitCall, folder: string): Promise<Result<string>>;
```

Exact steps:
- Input check (all three ref functions): `value.length === 0 || value.length > MAX_REF_CHARS` →
  `invalid_args`; `value.startsWith('-')` → `bad_ref` (`'a ref may not start with "-"'`), git
  not called.
- `classifyRef`: `git(repoRoot, ['rev-parse', '--symbolic-full-name', '--end-of-options', value])`.
  Not ok, or stderr matches `/ambiguous/i` → `bad_ref` with stderr's first non-empty line cut to
  200 chars. Then `git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options',
  `${value}^{commit}`])`; not ok or empty → `bad_ref` (`` `${value} is not a commit` ``). Kind from
  the first stdout line of the first call: `refs/heads/x` → `{kind:'branch', ref:'x'}`;
  `refs/remotes/x` → `{kind:'branch', ref:'x', remote:true}`; `refs/tags/x` → `{kind:'tag',
  ref:'x'}`; anything else (empty, `HEAD`) → `{kind:'commit', sha}` from the second call.
- `lookupCommit`: the `^{commit}` verify above → `sha`; then `git(repoRoot, ['log', '-1',
  '--parents', '--decorate=full', `--pretty=${PRETTY_FORMAT}`, '--end-of-options', sha])` →
  `parseCommits(stdout)[0]`; missing → `bad_ref`.
- `repoRootOf`: `git(folder, ['rev-parse', '--show-toplevel'])`; not ok or empty → `not_a_repo`
  (`` `${folder} is not in a git repository` ``); else the trimmed line with `\` → `/`.

### `src/conduit-mcp/call-flow.ts` (Part A) — T1.3

```ts
export const UI_TIMEOUT_MS = 5_000;
// CallFlowDeps gains
  /** Sends to one window by id; a closed window drops it. */
  sendToWindow(windowId: number, msg: HostToWebview): void;
// CallFlow gains
  /**
   * Sends mcp:ui to `windowId` and waits ≤ UI_TIMEOUT_MS for that window's answer.
   * Keyed by the in-flight's call key, so every Part A cancel path ends it:
   * answered ⇒ ok(result); expired ⇒ ui_timeout; cancelled reply:true ⇒ window_not_ready;
   * cancelled reply:false ⇒ window_not_ready (never sent: the call returns null upstream).
   */
  requestUi(r: { inflight: InFlight; callerSessionId: string; windowId: number;
                 action: McpUiAction }): Promise<Result<McpUiResult>>;
  /** false unless the request is waiting, `fromWindowId` is its window, and `raw` parses for its kind. */
  answerUi(requestId: string, fromWindowId: number, raw: unknown): boolean;
```

- A second `createWindowWaits<McpUiResult, { kind: McpUiAction['kind'] }>` instance; its
  `onUnanswered` sends nothing (no card).
- `cancelled(connId, requestId)` and `connectionClosed(connId)` also cancel matching UI waits
  (reply false); `windowReset(w)` cancels UI waits with `windowId === w` (reply true);
  `sessionMoved(s)` / `sessionGone(s)` cancel UI waits whose `callerSessionId === s` (reply true);
  `recheck()` does **not** touch UI waits; `dispose()` disposes both instances.
- `requestUi` is one synchronous block from `waitsUi.open` through `sendToWindow` (open first,
  so a same-tick answer finds its wait).
- `ui_timeout` message: `"Conduit's window didn't answer within 5 s; the outcome is unknown"`.
- Unexported `parseUiResult(kind: McpUiAction['kind'], v: unknown): McpUiResult | null`:
  `closeSession` → `{kind:'closeSession', ok:true}` or `{…, ok:false, unsaved: string[] ≤ 20}`;
  `closeFiles` → `closed: string[]`, `skipped: {path: string, reason: 'unsaved'|'not_open'}[]`
  (each ≤ 50 entries, `'all'` ≤ 500); open kinds → `{kind:'opened'}`; any kind may answer
  `{kind:'unknownSession'}`. Anything else → `null`.

### `src/conduit-mcp/control-tools.ts` (Part A shape) — T1.4

```ts
import type { GitCall } from './git-refs';
import type { SessionOpResult } from '../session-ops';

export interface CloseSessionOutput { closed: string }
export interface FocusSessionOutput { focused: string }
export interface AttachFolderOutput { attached: string; session_id: string; roots: string[] }
export type CloseFilesOutput = CloseFilesOutcome;          // from ui-types
export type ReviewSourceOut =
  | { kind: 'working'; scope: McpReviewScope }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint };
export interface OpenReviewOutput { opened: 'review'; source: ReviewSourceOut }
export interface OpenGitHistoryOutput { opened: 'git-history'; selected: string | null }
export interface OpenUrlOutput { opened: string }
export const MAX_CLOSE_PATHS = 50;
export const MAX_URL_BYTES = 2048;

/** A listed session (Part A N9): what target lookup and reach may see. */
interface TargetSession { sessionId: string; handle: Handle; openerSessionId: string | null }  // not exported

// ControlDeps gains (main binds the first four; the host binds the rest)
  /** Home + attached roots of a live session. */
  foldersOf(sessionId: string): { home: string; roots: string[] } | undefined;
  addRoot(sessionId: string, path: string): Promise<SessionOpResult>;
  activateSession(sessionId: string): void;
  git: GitCall;
  /** listedSessions() mapped to TargetSession. */
  targets(): readonly TargetSession[];
  ownerWindowOf(sessionId: string): number | null;
  windowReady(windowId: number): boolean;

// ControlCallContext (unexported; the host builds it per call) becomes
interface ControlCallContext {
  move: Move | undefined;
  reach: Reach | undefined;
  /** Bound by the host to flow.requestUi for this call's in-flight entry. */
  ui(windowId: number, action: McpUiAction): Promise<Result<McpUiResult>>;
}

// ControlHandlers gains
  prepareCloseSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<CloseSessionOutput>>>;
  prepareFocusSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<FocusSessionOutput>>>;
  prepareAttachFolder(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<AttachFolderOutput>>>;
  prepareCloseFiles(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<CloseFilesOutput>>>;
  prepareOpenReview(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenReviewOutput>>>;
  prepareOpenGitHistory(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenGitHistoryOutput>>>;
  prepareOpenUrl(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenUrlOutput>>>;
```

Order inside every `prepare*` (spec A §3.3 step 7): parse (`invalid_args`) → reserve the tool's
budget (`rate_limited`) → caller home (`not_in_session`) → target (`unknown_session`) → reach
(`out_of_reach`) → move (`move_not_allowed`) → argument checks → summary. Any refusal after the
reservation releases it; `run()` refunds on failure (Part A rule).

- **Target lookup** (`close_session`, `focus_session`, `attach_folder`): `session` must be a
  non-empty string ≤ 128 chars; match a `targets()` entry by `handle`, then by `sessionId`; none →
  `unknown_session` (`` `no session "${v}" in list_sessions` ``). `attach_folder` without
  `session` targets the caller (by `caller.sessionId`, not via `targets()`).
- **Reach** (unexported `inReach(reach, callerId, t, deps)`): `self` → `t.sessionId === callerId`;
  `opened` → that, or `t.openerSessionId === callerId`; `window` → `ownerWindowOf(t) !== null &&
  ownerWindowOf(t) === ownerWindowOf(callerId)`; `any` → true. Refusal `out_of_reach`, message by
  reach: `self` `'this tool may only act on your own session'`; `opened` `'this tool may only act
  on your session and sessions you opened'`; `window` `'this tool may only act on sessions in your
  window'`. Never names other sessions.
- **Move:** `focus_session` with `ctx.move === 'no'` → `move_not_allowed` (`"focus_session is set to
  never switch the human's view"`).
- **`close_session`:** args `{session}`. After reach: `w = ownerWindowOf(target)`; `null` or
  `!windowReady(w)` → `window_not_ready`. Summary `{tool, target: t.handle}`. `run()`:
  `ctx.ui(w, {kind:'closeSession', target: t.sessionId})` → `ok:true` ⇒ `{closed: t.sessionId}`;
  `ok:false` ⇒ `unsaved_changes` (`` `unsaved changes in:\n${unsaved.join('\n')}` ``);
  `unknownSession` ⇒ `unknown_session`; a `Result` error passes through.
- **`focus_session`:** args `{session}`. `w = ownerWindowOf(target)`; `null` or not ready →
  `window_not_ready`. `run()`: `activateSession(t.sessionId)` → `{focused: t.sessionId}`.
- **`attach_folder`:** args `{path, session?}`; `path` via Part A's `parseObject` rules;
  `abs = resolvePath(callerHome, path)` (the **caller's** home, spec §2.1). Summary `{tool, path:
  abs, target}` (target = handle, or the caller's handle). `run()`: `r = await addRoot(target,
  abs)`; `ok`, `is-home`, `duplicate` ⇒ `{attached: abs, session_id: target, roots:
  foldersOf(target)?.roots ?? []}`; `not-found` ⇒ `path_missing`; `not-a-directory` ⇒
  `not_a_directory`; `invalid-path` ⇒ `invalid_args`; `unknown-session` ⇒ `unknown_session`;
  `overlaps` / `filesystem-root` / `too-many` / any other ⇒ `attach_refused` (`` `can't attach
  ${abs}: ${reason}` ``).
- **`close_files`:** args exactly one of `paths` (array of 1–50 non-empty strings ≤ 4096) or
  `all: true`; both or neither → `invalid_args`. Each path → `resolvePath(home, p)`. Summary
  `{tool, count, all}`. `run()`: `w = ownerWindowOf(caller)`, `null` ⇒ `window_not_ready`;
  `ctx.ui(w, {kind:'closeFiles', paths: abs[] | 'all'})` → `{closed, skipped}`.
- **`open_review`:** args `{source: {kind, scope?, ref?, base?, head?}, repo?}`. `working`: only
  `scope` (default `'all'`); `commit`: only `ref`; `range`: only `base`, `head`. `repoRoot` =
  `resolveRepo(caller, repo)` (below). `commit` → `lookupCommit` → `{kind:'commit', sha, subject,
  repoRoot}`; `range` → `classifyRef(base)` (the literal `'working'` → `bad_ref` `'"working" is
  only allowed as a range head'`), `head === 'working'` → `{kind:'working'}` else `classifyRef`.
  Summary `what`: `'working'`, `sha.slice(0,7)`, or `` `${base}…${head}` `` (the raw inputs).
  `run()`: `ctx.ui(ownerWindowOf(caller), {kind:'openReview', source})` → `{opened:'review',
  source: <McpReviewSource without repoRoot/subject>}`.
- **`open_git_history`:** args `{repo?, ref?}`. `repoRoot` = `resolveRepo`; `ref` →
  `lookupCommit`. Summary `{tool, ref: ref ?? null}`. `run()`: `ctx.ui(w, {kind:'openGitHistory',
  repoRoot, commit})` → `{opened:'git-history', selected: commit?.sha ?? null}`.
- **`resolveRepo(caller, repo)`** (unexported): `f = repo === undefined ? home : resolvePath(home,
  repo)`; `folderKey(f)` must equal `folderKey` of `home` or of a root (`foldersOf(caller)`), else
  `not_a_repo` (`'repo must be your home folder or an attached folder'`); then
  `repoRootOf(git, f)`.
- **`open_url`:** args `{url, focus?}`; `url` a string whose UTF-8 length ≤ 2048, else
  `invalid_args`; `normalizeUrl(url)` (from `src/web-url.ts`) `null` → `bad_url` (`'only http and
  https URLs can be opened'`). Summary `{tool, url: normalized}`. `run()`: `ctx.ui(w,
  {kind:'openUrl', url: normalized, focus: focus !== false})` → `{opened: normalized}`.

### `src/conduit-mcp/tool-schemas.ts` — T1.4

Seven schemas in `TOOL_NAMES` order, built only from `type`, `properties`, `required`, `enum`,
`items`, `minItems`, `maxItems`, `maxLength`, `minimum`, `additionalProperties`, `description`
(no `oneOf` / `anyOf` / `allOf` / `$ref` / `const`) — Decision B5:

| Tool | properties (required **bold**) |
|---|---|
| `close_session` | **`session`** string |
| `focus_session` | **`session`** string |
| `attach_folder` | **`path`** (PATH), `session` string |
| `close_files` | `paths` array of string, maxItems 50; `all` boolean |
| `open_review` | **`source`** object {**`kind`** enum working/commit/range, `scope` enum all/staged/unstaged, `ref`, `base`, `head` strings maxLength 256}; `repo` string |
| `open_git_history` | `repo` string; `ref` string maxLength 256 |
| `open_url` | **`url`** string maxLength 2048; `focus` (FOCUS) |

Descriptions (verbatim):
- `close_session`: `"Close a Conduit session from list_sessions (handle or id), including your own. Refuses with unsaved_changes when it has unsaved files; nothing is closed then."`
- `focus_session`: `"Switch the human's view to a session from list_sessions. This moves the human away from your session, which can end your on-screen access."`
- `attach_folder`: `"Attach a folder to a session (yours by default) so its agent can work there. Paths are absolute or relative to your home folder."`
- `close_files`: `"Close your session's tabs for these paths (or all:true for every tab). Unsaved files are saved first when auto-save is on, otherwise skipped."`
- `open_review`: `"Open Review in your session for the working tree, one commit, or a range (base…head; head may be \"working\"). repo is your home (default) or an attached folder."`
- `open_git_history`: `"Open the commit history in your session, optionally selecting the commit at ref (branch, tag or sha)."`
- `open_url`: `"Open an http(s) URL in a Conduit web tab in your session. Never opens your browser."`

`CONDUIT_INSTRUCTIONS` (`:152`): `"Tools that open sessions, terminals or files exist only when the
human enables them."` → `"Tools that act on Conduit's windows exist only when the human enables
them."`

### `electron/conduit-mcp-host.ts` — T1.5

```ts
// ConduitMcpHostDeps.control becomes
  control: Omit<ControlDeps, 'claimHandle' | 'now' | 'info' | 'agentIds' | 'targets' | 'ownerWindowOf' | 'windowReady'>;
// ConduitMcpHostDeps gains
  sendToWindow(windowId: number, msg: HostToWebview): void;
```

- `createControlHandlers` gains `targets: () => listedSessions().map(({ session: s, handle }) =>
  ({ sessionId: s.id, handle, openerSessionId: s.openedBy?.sessionId ?? null }))`,
  `ownerWindowOf: deps.ownerWindowOf`, `windowReady: (w) => deps.presence.isReady(w)`.
- `createCallFlow` gains `sendToWindow: deps.sendToWindow`.
- The prepare switch gains seven cases: `ctx = { move: policy.move, reach: policy.reach, ui: (w,
  action) => flow.requestUi({ inflight: f, callerSessionId, windowId: w, action }) }`.
- `handleRenderer` gains `case 'mcp:uiResult': flow.answerUi(m.requestId, senderId, m.result)`
  (no reply; a `false` is logged at debug).

### `electron/main.ts` — T1.6

```ts
// createConduitMcpHost({...}) control: gains
  foldersOf: (id) => { const s = mgr.get(id); return s ? { home: s.home, roots: [...s.roots] } : undefined; },
  addRoot: (id, p) => sessionOps.addRoot(id, p),
  activateSession: (id) => sendToOwner(id, { type: 'activateSession', sessionId: id }),
  git: (cwd, args) => runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.metadata })
    .then((r) => ({ ok: r.ok, stdout: r.stdout, stderr: r.stderr })),
// deps gain
  sendToWindow: (wid, msg) => windows.get(wid)?.webContents.send('to-webview', msg),
// mcp:* case list (~:4519-4525) gains 'mcp:uiResult'
```

`sessionOps` (`:2445`) is declared after the host (`:1937`); the closure reads it lazily, as
`createMcpSession` / `openMcpFile` already do.

### Renderer — T2.1–T2.4

```ts
// webview/docs.ts (T2.1): the 'open' action and the 'openReview' action gain
  /** The session the window shows. A foreground open into another session lands active in
   *  that session's layout and leaves DocsState.activeId on the shown session. */
  shown?: string;
// openForeground: finalize(…, touched, action.shown ?? s)   (openInBackground unchanged)

// webview/git-history-state.ts (T2.1)
// HistoryState gains
  /** A commit handed over by an MCP open; displayed and selectable at any depth. */
  revealed: CommitNode | null;      // initial null; 'request' keeps it; 'retarget' clears it
// HistoryAction gains
  | { type: 'reveal'; commit: CommitNode }   // → revealed = commit, selectedSha = commit.sha
// 'result': selectionAlive also when selectedSha === state.revealed?.sha
export function displayCommits(state: HistoryState): CommitNode[];
// = dedupeAndSortCommits([...state.commits, ...(query ? searchCommits : []), ...(revealed ? [revealed] : [])])
//   (state.commits returned as is when there is neither a query nor a revealed commit)

// webview/history-reveal.ts (new, T2.1)
export function requestHistoryReveal(repoRoot: string, commit: CommitNode): void;   // one slot, newest wins
/** The pending commit when folderKey(repoRoot) matches; clears the slot. */
export function takeHistoryReveal(repoRoot: string | undefined): CommitNode | null;
export function subscribeHistoryReveal(cb: () => void): () => void;

// webview/mcp-ui.ts (new, T2.2)
export interface McpUiHandlers {
  hasSession(sessionId: string): boolean;
  /** sessionDirtyPaths for one session (webview/app.tsx:545-548). */
  dirtyPathsOf(sessionId: string): string[];
  kill(sessionId: string): void;
  closeFiles(sessionId: string, target: readonly string[] | 'all'): Promise<CloseFilesOutcome>;
  openReview(sessionId: string, source: McpReviewSource): void;
  openGitHistory(sessionId: string, repoRoot: string, commit: CommitNode | null): void;
  openUrl(sessionId: string, url: string, focus: boolean): void;
}
export function useMcpUi(h: McpUiHandlers): void;
export interface CloseFilesPlan { groups: { path: string; ids: string[] }[]; notOpen: string[] }
export function planCloseFiles(
  docs: readonly Pick<OpenDoc, 'id' | 'kind' | 'path' | 'sessionId'>[],
  sessionId: string,
  target: readonly string[] | 'all',
): CloseFilesPlan;

// webview/file-open-request.ts (T2.4): planFileOpen for source 'mcp' never activates
//   focus → { activate: false, showEditor: true, mode: 'preview' }   (was activate: true)

// webview/app.tsx (T2.4)
interface FileOpenNav { reveal?: CursorPos; record?: boolean; group?: GroupIndex;
  /** Open in targetSessionId without switching the shown session (MCP). */ keepActive?: true }
const openReviewIn: (sessionId: string, source: ReviewSource, group?: GroupIndex) => void;
const openGitHistoryIn: (sessionId: string, repoRoot?: string, reveal?: CommitNode) => void;
const closeFilesIn: (sessionId: string, target: readonly string[] | 'all') => Promise<CloseFilesOutcome>;
```

`useMcpUi` rules: subscribes once (handlers via a ref); for each `mcp:ui`: if
`!hasSession(action.kind === 'closeSession' ? action.target : sessionId)` → post
`{kind:'unknownSession'}`. `closeSession`: `d = dirtyPathsOf(target)`; `d.length` → post
`{kind:'closeSession', ok:false, unsaved: d.slice(0, 20)}`; else post `{kind:'closeSession',
ok:true}` **then** `kill(target)`, in the same synchronous turn. `closeFiles`: await, post the
outcome. Open kinds: call the handler, post `{kind:'opened'}`. Every post is
`post({type:'mcp:uiResult', requestId, result})`.

`planCloseFiles`: `paths` → per distinct requested path (`canonicalPath`, `src/canonical-path.ts:15`),
the session's docs of kind `file` or `diff` whose `path` equals it; none → `notOpen`. `'all'` →
every doc of the session, grouped by `doc.path`, in docs order.

`MCP_STR` keys (exact copy, T1.2):

```ts
// errors (satisfies Record<ToolErrorCode, string>)
unknown_session: 'no such session',
out_of_reach: 'that session is outside what this tool may reach',
move_not_allowed: 'this tool may not switch your view',
bad_ref: 'that git ref could not be resolved',
bad_url: 'only http and https URLs can be opened',
not_a_repo: 'that folder is not a git repository of the session',
attach_refused: 'that folder could not be attached',
unsaved_changes: 'the session has unsaved files',
ui_timeout: 'Conduit’s window didn’t answer in time',
// tools.description: one entry per new tool, same text as the schema descriptions' first sentence
// tools.onWarning gains: close_session: 'Runs without asking. Codex never asks on its own.'
// ask.summary gains
close_session: (s) => `Close ${s.target}`,
focus_session: (s) => `Switch your view to ${s.target}`,
attach_folder: (s) => `Attach ${s.path} to ${s.target}`,
close_files: (s) => (s.all ? 'Close all of its tabs' : s.count === 1 ? 'Close 1 tab' : `Close ${s.count} tabs`),
open_review: (s) => `Open Review for ${s.what}`,
open_git_history: (s) => (s.ref === null ? 'Open the commit history' : `Open the commit history at ${s.ref}`),
open_url: (s) => `Open ${s.url} in a Conduit tab`,
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Tool catalog rows (7) | `TOOL_NAMES` / `TOOL_SPECS` (T1.2) | gate, `tools/list`, `KNOWN_TOOLS`, Settings + session editors (Part A, data-driven), `MCP_STR.tools.description` (T1.2) | Both; the editors need no code change (driven by `TOOL_GROUPS` / `TOOL_SPECS`) |
| New `ToolErrorCode`s | `types.ts` (T1.2) | `MCP_STR.errors` (T1.2), control-tools (T1.4), call flow (T1.3) | Both |
| `mcp:ui` | `flow.requestUi` via `sendToWindow` (T1.3, T1.5, T1.6) | `useMcpUi` (T2.2) mounted in app (T2.4) | Both. Between S1 and S2 no renderer answers: calls end `ui_timeout` (no e2e runs before S3) |
| `mcp:uiResult` | `useMcpUi` (T2.2) | main case (T1.6) → host (T1.5) → `flow.answerUi` (T1.3) | Both |
| Target lookup / reach | `listedSessions` (unchanged) → host `targets()` (T1.5); `ownerWindowOf` (Part A); `Session.openedBy` (unchanged producer, `src/session-manager.ts:129`) | `inReach` (T1.4) | Consumer; producers unchanged on purpose |
| `kill` from an MCP close | `useMcpUi` (T2.2) | main `case 'kill'` → `disposeSession` → `mcpHost.onSessionDeleted` (`electron/main.ts:3824-3826`, `:2824`) | Producer only; the handler is the UI's own path |
| Self-close reply before kill | renderer posts `mcp:uiResult` then `kill` in one turn (T2.2) | main handles each IPC message as its own task; the answer's microtask chain writes the reply before the `kill` task runs `closeConnectionsOf` (`electron/conduit-mcp-host.ts:949-951`) | Both; pinned by a host test (T1.5) and e2e (T3.2) |
| `activateSession` from `focus_session` | main `activateSession` dep (T1.6) | renderer handler `webview/app.tsx:705-708` (unchanged) | Producer only: the handler already does exactly `setActiveId` |
| Folder attach | `sessionOps.addRoot` (unchanged) | control-tools run (T1.4) | Consumer only; the op keeps its semantics, the tool maps reasons |
| Ref classification / commit lookup | `git-refs.ts` (T1.1) via main `git` dep (T1.6) | control-tools (T1.4) | Both |
| `PRETTY_FORMAT` export | `src/git-history.ts` (T1.1) | `git-refs.ts` (T1.1) | Both |
| `normalizeUrl` location | `src/web-url.ts` (T0.1) | `webview/components/web-prompt-modal.tsx:2`, `webview/components/web-view.tsx:4`, `webview/docs.ts:18` (`displayTitleForUrl`), `test/unit/web-url.test.ts:2`, control-tools (T1.4) | Both; grep proves no other importer |
| `DocsState.activeId` after a non-shown open | `openForeground` + `shown` (T2.1) | center pane / tab strip (read the shown session) | Both; fixes `openWeb`'s silent mis-point too |
| `open` / `openReview` dispatches | `openReviewIn`, `openGitHistoryIn`, `openWeb`, `openFile` (T2.4) | docs reducer (T2.1) | Both. Other dispatchers of `open` (`openDiff` `webview/app.tsx:2481`, `retargetGitHistory` `:1027`, `reopenClosedTab` via `openWeb`/`openFile`) omit `shown` ⇒ today's behaviour |
| History reveal | `openGitHistoryIn` → `requestHistoryReveal` (T2.4, T2.1) | `GitHistoryView` (T2.3) | Both |
| `planFileOpen` for `mcp` | `webview/file-open-request.ts` (T2.4) | `flushOsOpens` (`webview/app.tsx:2696-2715`, T2.4) | Both; the `os` branch unchanged |
| Session layout of the caller | session-explicit entries (T2.4) | center pane when that session is shown | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/web-url.ts` | create (move) | `normalizeUrl`, `displayTitleForUrl` shared by host and renderer |
| `webview/web-url.ts` | delete | Moved |
| `src/conduit-mcp/git-refs.ts` | create | Ref classification, single-commit lookup, repo root of a folder |
| `webview/mcp-ui.ts` | create | `mcp:ui` subscription, answer posting, close-files planning |
| `webview/history-reveal.ts` | create | One-slot hand-off of a commit to the history view |
| `test/unit/conduit-mcp-git-refs.test.ts`, `test/unit/mcp-ui.test.ts`, `test/unit/history-reveal.test.ts` | create | Unit tests |
| `test/e2e/conduit-mcp-app-helpers.mjs` | create | Git fixture, local HTTP server, split/dirty helpers for the four scenarios |
| `test/e2e/conduit-mcp-app-sessions.e2e.mjs` | create | close/focus/attach, reach refusal, move:no, self close |
| `test/e2e/conduit-mcp-app-files.e2e.mjs` | create | close_files; open_file stays in the caller without switching |
| `test/e2e/conduit-mcp-app-git.e2e.mjs` | create | open_review / open_git_history incl. split-partner caller and deep commit |
| `test/e2e/conduit-mcp-app-web.e2e.mjs` | create | open_url foreground/background, bad_url |
| `src/git-history.ts` | modify | Export `PRETTY_FORMAT` |
| `src/conduit-mcp/types.ts` | modify | Nine error codes |
| `src/conduit-mcp/tool-policy.ts` | modify | Seven catalog rows |
| `src/conduit-mcp/ui-types.ts` | modify | `McpUiAction`, `McpUiResult`, `CloseFilesOutcome`, `McpReviewSource`, `McpReviewScope`, `AskSummary` variants |
| `src/protocol.ts` | modify | `mcp:ui`, `mcp:uiResult` |
| `src/conduit-mcp/call-flow.ts` | modify | UI waits, `requestUi`, `answerUi`, `UI_TIMEOUT_MS`, `sendToWindow` dep |
| `src/conduit-mcp/control-tools.ts` | modify | Seven `prepare*`, target/reach/move, new deps and outputs |
| `src/conduit-mcp/tool-schemas.ts` | modify | Seven schemas; instructions line |
| `electron/conduit-mcp-host.ts` | modify | Control deps, flow dep, prepare cases, `mcp:uiResult` |
| `electron/main.ts` | modify | Control bindings, `sendToWindow`, `mcp:uiResult` case |
| `webview/conduit-mcp-strings.ts` | modify | Errors, descriptions, summaries, warning |
| `webview/docs.ts` | modify | `shown` on `open` / `openReview` |
| `webview/git-history-state.ts` | modify | `revealed`, `reveal`, `displayCommits` |
| `webview/components/git-history-view.tsx` | modify | Consume reveals; `searchable` from `displayCommits`; restore yields to a reveal |
| `webview/file-open-request.ts` | modify | MCP opens never activate |
| `webview/app.tsx` | modify | Session-explicit entries, `closeDoc` split, `closeFilesIn`, `keepActive`, `useMcpUi` mount |
| `webview/components/web-prompt-modal.tsx`, `webview/components/web-view.tsx` | modify | Import path |
| `test/unit/web-url.test.ts` | modify | Import path |
| Existing tests: `conduit-mcp-tool-policy.test.ts`, `conduit-mcp-call-flow.test.ts`, `conduit-mcp-control-tools.test.ts`, `conduit-mcp-host.test.ts`, `docs.test.ts`, `git-history-state.test.ts`, `file-open-request.test.ts`, `tool-policy-editor.test.tsx`, `settings-mcp-tools.test.tsx` | modify | New cases; any Part A assertion that pins the catalog's length or group membership follows the rows |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

One: the deep-history git fixture (600 commits, a branch, a tag) is generated with `git
fast-import` from a stream built in `test/e2e/conduit-mcp-app-helpers.mjs`
(`gitFixture(dir, { commits })`), not a commit loop — 600 `git commit` spawns would dominate the
scenario's runtime on the Windows runner. Everything else is single edits. Count: 1.

## Slices

Order: **S0 → S1 → S2 → S3.** S0 is independent of Part A and may run first.

**Shared-file serialization (exclusive claims):**
- `src/conduit-mcp/types.ts`, `src/conduit-mcp/tool-policy.ts`, `src/conduit-mcp/ui-types.ts`,
  `src/protocol.ts`, `webview/conduit-mcp-strings.ts`: T1.2.
- `src/conduit-mcp/call-flow.ts`: T1.3. `src/conduit-mcp/control-tools.ts`,
  `src/conduit-mcp/tool-schemas.ts`: T1.4.
- `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts`: T1.5.
- `electron/main.ts`: T1.6.
- `webview/docs.ts`, `webview/git-history-state.ts`: T2.1. `webview/app.tsx`: T2.4.
- `test/e2e/conduit-mcp-app-helpers.mjs`: T3.1. `CHANGELOG.md`: T3.6.

---

### Slice 0: Move `normalizeUrl` to `src/`

**Check:** `npx vitest run test/unit/web-url.test.ts` green; `git grep -n "webview/web-url\|from './web-url'\|from '../web-url'" -- webview src test` prints nothing; `npm run verify:quick` green.

**Parallel groups:** G1: T0.1

#### Task 0.1: Move the module

**Files:** Create `src/web-url.ts`; delete `webview/web-url.ts`; modify
`webview/components/web-prompt-modal.tsx:2`, `webview/components/web-view.tsx:4`,
`webview/docs.ts:18`, `test/unit/web-url.test.ts:2` (imports → `../src/web-url` /
`../../src/web-url`).

**Interfaces:** Produces `src/web-url.ts` (`normalizeUrl`, `displayTitleForUrl`). Consumes none.

**Steps:**
- [ ] Port carve-out: byte-identical bodies (`git diff -M --stat` shows a rename). The proof is
  `test/unit/web-url.test.ts` green unchanged except its import line, plus the slice Check.

---

### Slice 1: Host — catalog, git refs, UI waits, tool logic, wiring

**Check:**
- `npx vitest run test/unit/conduit-mcp-git-refs.test.ts test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-call-flow.test.ts test/unit/conduit-mcp-control-tools.test.ts test/unit/conduit-mcp-host.test.ts test/unit/conduit-mcp-json-rpc.test.ts test/unit/tool-policy-editor.test.tsx test/unit/settings-mcp-tools.test.tsx test/unit/mcp-tools-dialog.test.tsx test/unit/approval-card.test.tsx` green;
- both `tsc` projects green;
- `npm run verify:quick` green.

**Parallel groups:** G1: T1.1 · G2: T1.2 · then G3: T1.3 · then Serial: T1.4 → T1.5 → T1.6
**Claims (serial lane):** `src/conduit-mcp/types.ts`, `src/conduit-mcp/tool-policy.ts`, `src/conduit-mcp/ui-types.ts`, `src/protocol.ts`, `webview/conduit-mcp-strings.ts` (T1.2); `src/conduit-mcp/call-flow.ts` (T1.3); `src/conduit-mcp/control-tools.ts`, `src/conduit-mcp/tool-schemas.ts` (T1.4); `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts` (T1.5); `electron/main.ts` (T1.6)

#### Task 1.1: `git-refs.ts`

**Files:** Create `src/conduit-mcp/git-refs.ts`. Modify `src/git-history.ts:107` (`export const
PRETTY_FORMAT`). Test create `test/unit/conduit-mcp-git-refs.test.ts`.

**Interfaces:**
- Produces `GitRun`, `GitCall`, `MAX_REF_CHARS`, `classifyRef`, `lookupCommit`, `repoRootOf`
  (Contracts).
- Consumes `parseCommits(stdout: string): CommitNode[]` (`src/git-history.ts:200`), `RefEndpoint`
  (`src/git-range.ts:12`), `toolError`, `Result` (`src/conduit-mcp/types.ts`).

**Steps:**
- [ ] Failing tests (a fake `GitCall` that records argv and answers from a table):
  - **'a leading "-" is bad_ref without running git'** — `classifyRef(git, '/r', '-x')` → `bad_ref`;
    recorded calls `[]`; same for `lookupCommit` with `'--output=/tmp/x'`;
  - 'every call passes --end-of-options before the value' — each recorded argv has
    `'--end-of-options'` at `indexOf(value-bearing arg) - 1`;
  - 'branch / remote / tag / sha classification' — `refs/heads/main` → `{kind:'branch',
    ref:'main'}`; `refs/remotes/origin/main` → `{kind:'branch', ref:'origin/main', remote:true}`;
    `refs/tags/v1` → `{kind:'tag', ref:'v1'}`; empty stdout → `{kind:'commit', sha}`;
    `HEAD` → `{kind:'commit', sha}`;
  - 'ambiguous → bad_ref with git's first stderr line, ≤ 200 chars' (a 300-char line is cut);
  - 'not a commit → bad_ref' (verify step fails);
  - 'lookupCommit returns the parsed node' (stdout built with the real `PRETTY_FORMAT`
    separators) and `bad_ref` on an empty log;
  - 'repoRootOf forward-slashes and maps failure to not_a_repo';
  - 'length 0 or > 256 → invalid_args'.
- [ ] Run `npx vitest run test/unit/conduit-mcp-git-refs.test.ts` — FAIL (module missing).
- [ ] Implement; `test/unit/git-history.test.ts` stays green.

#### Task 1.2: Catalog rows, codes, wire types, strings

**Files:** Modify `src/conduit-mcp/tool-policy.ts` (`SESSION_TOOL_NAMES`, `EDITOR_TOOL_NAMES`,
`TOOL_SPECS`), `src/conduit-mcp/types.ts` (`ToolErrorCode`), `src/conduit-mcp/ui-types.ts`,
`src/protocol.ts` (beside Part A's `mcp:ask` / `mcp:askAnswer`), `webview/conduit-mcp-strings.ts`
(errors, `tools.description`, `tools.onWarning`, `ask.summary`). Tests:
`test/unit/conduit-mcp-tool-policy.test.ts`, plus any Part A test that pins the catalog
(`tool-policy-editor.test.tsx`, `settings-mcp-tools.test.tsx`).

**Interfaces:**
- Produces the `tool-policy.ts`, `types.ts`, `ui-types.ts`, `protocol.ts` blocks and the
  `MCP_STR` keys (Contracts).
- Consumes Part A: `TOOL_SPECS`, `ToolSpec`, `isValidField`, `coercePolicyLayer`, `AskSummary`,
  `MCP_STR.ask.summary` (`satisfies { [K in AskSummary['tool']]: … }`); `RefEndpoint`
  (`src/git-range.ts:12`); `CommitNode` (`src/protocol.ts:267`).

**Steps:**
- [ ] Failing tests in `conduit-mcp-tool-policy.test.ts`:
  - 'Part B defaults match spec A §3.2' — `close_session` `{access:'ask', when:'viewing',
    reach:'window'}`; `focus_session` `{access:'on', when:'viewing', reach:'window', move:'yes'}`;
    `attach_folder` `{access:'ask', when:'viewing', reach:'self'}`; the four editor tools
    `{access:'on', when:'viewing'}`;
  - 'reach any only for focus and close' — `isValidField('attach_folder','reach','any') ===
    false`; `isValidField('close_session','reach','any') === true`;
    `coercePolicyLayer({open_url:{reach:'self'}})` is `undefined`;
  - 'groups' — `TOOL_GROUPS` sessions = the five session tools; editor = the five editor tools.
- [ ] Run — FAIL. Implement. Expected `tsc` red only at the host prepare switch (closed in T1.5).

#### Task 1.3: UI waits in the call flow

**Files:** Modify `src/conduit-mcp/call-flow.ts`. Test `test/unit/conduit-mcp-call-flow.test.ts`.

**Interfaces:**
- Produces `UI_TIMEOUT_MS`, `CallFlowDeps.sendToWindow`, `CallFlow.requestUi`, `CallFlow.answerUi`
  (Contracts).
- Consumes `createWindowWaits<A, M>(deps)` (Part A `src/conduit-mcp/window-waits.ts`); `McpUiAction`,
  `McpUiResult` (T1.2); `HostToWebview` `mcp:ui` (T1.2).

**Steps:**
- [ ] Failing tests (manual timers; `sendToWindow` recorder):
  - 'requestUi sends mcp:ui to the given window and resolves on its answer' — message
    `{type:'mcp:ui', requestId, sessionId: caller, action}` to window 2;
    `answerUi(id, 2, {kind:'opened'})` → `{ok:true, value:{kind:'opened'}}`;
  - **'an answer from another window is ignored'** — `answerUi(id, 1, …) === false`, still waiting;
  - **'a malformed answer is ignored'** — `answerUi(id, 2, {kind:'closeFiles'})` (no arrays) →
    `false`; `{kind:'closeSession', ok:false, unsaved: Array(21)}` → `false`;
  - '5 s → ui_timeout; a late answer → false';
  - 'windowReset(2) → window_not_ready'; 'sessionMoved(caller) → window_not_ready';
  - **'notifications/cancelled ends the UI wait and runControl returns null'** — a `runControl`
    whose `run()` awaits `requestUi`; `cancelled(connId, requestId)`; the result is `null` and
    no timer is left pending;
  - 'connectionClosed ends UI waits'; 'recheck leaves UI waits alone'; 'dispose ends both
    instances'.
- [ ] Run — FAIL. Implement; Part A's call-flow tests stay green.

#### Task 1.4: Tool logic and schemas

**Files:** Modify `src/conduit-mcp/control-tools.ts`, `src/conduit-mcp/tool-schemas.ts`. Test
`test/unit/conduit-mcp-control-tools.test.ts` (the schema-keyword test lives here too; it imports
`toolSchemas` from `src/conduit-mcp/tool-schemas.ts`).

**Interfaces:**
- Produces the `control-tools.ts` and `tool-schemas.ts` blocks (Contracts).
- Consumes `classifyRef`, `lookupCommit`, `repoRootOf`, `GitCall` (T1.1); `McpUiAction`,
  `McpUiResult`, `CloseFilesOutcome`, `McpReviewSource`, `McpReviewScope`, `AskSummary` (T1.2);
  `normalizeUrl` (`src/web-url.ts`, T0.1); `folderKey` (`src/folder-key.ts:4`); `SessionOpResult`
  (`src/session-ops.ts:14`); Part A `PreparedCall<T>`, `reserve`/budgets, `Move`, `Reach`.

**Call sites:** `createControlHandlers` — `electron/conduit-mcp-host.ts:643-654` (T1.5);
`ControlDeps` main binding — `electron/main.ts:1962-1977` (T1.6).

**Steps:**
- [ ] Failing tests (POSIX fakes; `ctx.ui` a recorder answering from a table):
  - 'target by handle, then id; unlisted → unknown_session, token refunded';
  - **'reach'** — table over `self`/`opened`/`window`/`any` × {caller, opened-by-caller, same
    window, other window}: exactly the allowed cells pass; refusals are `out_of_reach` and the
    message never contains another session's handle or id;
  - **'move no refuses focus_session'** → `move_not_allowed`, refunded, `activateSession` not
    called;
  - 'close_session to a target in another window sends the UI action to that window' (`ctx.ui`
    recorded with the target's window id); 'unready target window → window_not_ready';
    'unsaved → unsaved_changes listing the paths'; 'ok → {closed}';
  - 'focus_session run calls activateSession once → {focused}';
  - 'attach_folder resolves against the caller's home; is-home and duplicate succeed with roots
    unchanged; overlaps → attach_refused; not-found → path_missing';
  - 'close_files needs exactly one of paths/all; 51 paths → invalid_args; relative paths
    resolved against home';
  - 'open_review: working default scope all; commit via lookupCommit; range classifies base and
    head; head "working" allowed; base "working" → bad_ref; repo outside home/roots →
    not_a_repo; result source carries classified endpoints';
  - 'open_git_history without ref → selected null; with ref → the looked-up sha';
  - **'open_url: javascript:, file:, conduit-preview: (no digit) → bad_url; > 2048 bytes →
    invalid_args; localhost:5173 → http://localhost:5173/; focus defaults true'**;
  - 'run failure refunds; success keeps' for one act and one show tool;
  - **'schemas use only the allowed keywords'** — walk all `toolSchemas([])` input schemas;
    no key outside the Contracts list.
- [ ] Run — FAIL. Implement; descriptions verbatim.

#### Task 1.5: Host wiring

**Files:** Modify `electron/conduit-mcp-host.ts` (deps interface `:106-142` as Part A left it;
`createControlHandlers` `:643-654`; `createCallFlow` construction; the prepare switch;
`handleRenderer`). Test `test/unit/conduit-mcp-host.test.ts`.

**Interfaces:**
- Produces `ConduitMcpHostDeps.sendToWindow`, the narrowed `control` Omit, `mcp:uiResult`
  handling (Contracts).
- Consumes T1.3 (`requestUi`, `answerUi`, `sendToWindow` dep), T1.4 (seven `prepare*`, new
  `ControlDeps` members), Part A `ownerWindowOf`, `presence.isReady`, `listedSessions`.

**Call sites:** `createConduitMcpHost` — `electron/main.ts:1937` (T1.6) and the test harness
`harness(opts)` (`test/unit/conduit-mcp-host.test.ts:146`): add `sendToWindow` (recorder),
`control.foldersOf`, `addRoot`, `activateSession`, `git` fakes.

**Steps:**
- [ ] Failing host tests:
  - **'targets are listed sessions only'** — a session with no handle is `unknown_session` by
    id (spec A7);
  - 'close_session end to end' — policy `{access:'on'}`; `mcp:ui` recorded to the target's window;
    `handleRenderer({type:'mcp:uiResult', requestId, result:{kind:'closeSession', ok:true}}, reply, w)`
    → result `{closed}`;
  - **'self close: the reply line is written before the connection closes'** — the caller closes
    itself; deliver `mcp:uiResult` in one macrotask and `onSessionDeleted(caller)` in the next;
    the connection received the reply line for that id before its close;
  - **'uiResult from a different window is ignored'** → after 5 s (manual timer) `ui_timeout`;
  - 'onWindowReset during a UI wait → window_not_ready';
  - **'notifications/cancelled during a UI wait → no reply line'**;
  - 'reach refusal at the host' — `close_session` with session policy `{reach:'self'}` on
    another session → `out_of_reach`, no `mcp:ui` sent;
  - 'tools/list includes the seven tools by default except none are off' (defaults are on/ask).
- [ ] Run — FAIL. Implement. Both `tsc` projects green except `electron/main.ts`'s host deps
  (closed in T1.6).

#### Task 1.6: Main bindings

**Files:** Modify `electron/main.ts`: `createConduitMcpHost({...})` `control:` (`:1962-1977`) and
deps; `mcp:*` case list (`~:4519-4525`) adds `'mcp:uiResult'`.

**Interfaces:** Consumes `ControlDeps.foldersOf/addRoot/activateSession/git` (T1.4),
`ConduitMcpHostDeps.sendToWindow` (T1.5), `runGit`, `GIT_TIMEOUT` (`src/git-exec.ts`, imported
`:75`), `sessionOps` (`:2445`), `sendToOwner` (`:993-996`), `windows` (`:381`).

**Steps:**
- [ ] Wiring carve-out (no main unit harness): the red step is `tsc` naming the missing deps;
  implement exactly the Contracts block; both `tsc` projects green; run the slice Check. Runtime
  proof is S3.

---

### Slice 2: Renderer — session-explicit opens, `mcp:ui` handler, history reveal

**Check:**
- `npx vitest run test/unit/docs.test.ts test/unit/git-history-state.test.ts test/unit/history-reveal.test.ts test/unit/mcp-ui.test.ts test/unit/file-open-request.test.ts test/unit/monaco-class-collision.test.ts` green;
- both `tsc` projects green; `npm run verify:quick` green.

**Parallel groups:** G1: T2.1 · G2: T2.2 · then G3: T2.3 · then Serial: T2.4
**Claims (serial lane):** `webview/docs.ts`, `webview/git-history-state.ts` (T2.1); `webview/app.tsx` (T2.4)

#### Task 2.1: Reducer `shown`, history `reveal`, reveal store

**Files:** Modify `webview/docs.ts` (`DocsAction` `open` `:123-134`, `openReview` `:164`;
`openForeground` `:342-377`; the `open` case `:551` and `openReview` case `:661` pass
`action.shown`), `webview/git-history-state.ts`. Create `webview/history-reveal.ts`. Tests
`test/unit/docs.test.ts`, `test/unit/git-history-state.test.ts`, create
`test/unit/history-reveal.test.ts`.

**Interfaces:** Produces `shown?`, `HistoryState.revealed`, the `reveal` action, `displayCommits`,
the reveal store (Contracts). Consumes `dedupeAndSortCommits` (`src/git-search.ts`), `folderKey`.

**Steps:**
- [ ] Failing tests:
  - docs: **'a foreground open into a non-shown session keeps the shown cache'** — shown session A
    with an active file tab; `open` web for B with `shown: 'A'` → `state.activeId` is A's tab; B's
    layout has the web tab active in its target group; `layouts.A` unchanged;
  - docs: 'openReview with shown moves the singleton to B without re-pointing activeId';
  - docs: 'omitting shown keeps today's behaviour' (existing open tests unchanged);
  - history: 'reveal selects and displays a commit outside the loaded set' —
    `displayCommits(reveal(state))` contains it; `selectedSha === commit.sha`;
  - history: 'a refresh result keeps a revealed selection'; 'retarget clears revealed';
  - reveal store: 'take returns the commit once for a matching repo (folderKey), null otherwise';
    'newest request wins'; 'subscribers are notified'.
- [ ] Run — FAIL. Implement.

#### Task 2.2: `webview/mcp-ui.ts`

**Files:** Create `webview/mcp-ui.ts`. Test create `test/unit/mcp-ui.test.ts`.

**Interfaces:** Produces `McpUiHandlers`, `useMcpUi`, `CloseFilesPlan`, `planCloseFiles`
(Contracts). Consumes `subscribe`, `post` (`webview/bridge.ts:137`); `canonicalPath`
(`src/canonical-path.ts:15`); `McpUiAction`, `McpUiResult`, `CloseFilesOutcome`,
`McpReviewSource` (T1.2); `OpenDoc` (`webview/docs.ts`).

**Steps:**
- [ ] Failing tests (bridge mocked, fake handlers):
  - **'closeSession clean posts the result before kill'** — recorded order
    `['post:mcp:uiResult', 'kill:B']`;
  - 'closeSession dirty posts unsaved (≤ 20) and never kills';
  - 'unknown session → unknownSession, no handler called';
  - 'closeFiles posts the awaited outcome'; 'open kinds call their handler and post opened';
  - planCloseFiles: 'file and diff tabs of the session match; other sessions' docs never';
    'unopened path → notOpen'; 'all groups every doc by path including @review'; 'a requested
    path given twice is planned once'.
- [ ] Run — FAIL. Implement.

#### Task 2.3: History view consumes reveals

**Files:** Modify `webview/components/git-history-view.tsx` (`searchable` `:406-412` →
`displayCommits(state)`; a `useLayoutEffect` after the restore effect `:460-499` that on mount and
on `subscribeHistoryReveal` notify calls `takeHistoryReveal(repoRoot)` and dispatches `reveal`;
the restore's `select` is skipped when a reveal was taken). No new unit test: the state logic is
pinned by T2.1's `git-history-state` cases; the view wiring is proven by T3.4 phase 4.

**Interfaces:** Consumes `displayCommits`, `reveal` (T2.1); `takeHistoryReveal`,
`subscribeHistoryReveal` (T2.1).

**Steps:**
- [ ] Wiring carve-out: `tsc` + T2.1's tests; proof in S3 phase "deep commit".

#### Task 2.4: App — session-explicit entries, close paths, file opens, mount

**Files:** Modify `webview/app.tsx`, `webview/file-open-request.ts` (`:21-24`). Test
`test/unit/file-open-request.test.ts`.

**Interfaces:** Consumes T2.1 (`shown`, `requestHistoryReveal`), T2.2 (`useMcpUi`,
`planCloseFiles`), `McpUiHandlers`; `dirtyCloseStep` / `afterCloseSave`
(`webview/auto-save-policy.ts:186`, `:198`); `sessionDirtyPaths` (`webview/unsaved-files`).

**Edits (exact):**
- `FileOpenNav` (`:320-324`) gains `keepActive?: true`. In `openFile` (`:2388`): when
  `nav?.keepActive`, skip the `setActiveId` / `switchSession` branch (`:2415-2418`), pass
  `shown: activeIdRef.current ?? ''` on the `open` dispatch (`:2437`), and run `recordNav` and
  `revealInTree` only when `effectiveSessionId === activeIdRef.current`.
- `flushOsOpens` (`:2696-2715`): for `req.source === 'mcp'`, `if (p.showEditor &&
  req.sessionId === activeIdRef.current) setCenterView('editor')`; call `openFile(req.path,
  req.sessionId, p.mode, { ...(p.reveal ? { reveal: p.reveal } : {}), keepActive: true })`. The
  `os` branch is unchanged.
- `openReviewIn(sessionId, source, group?)`: the body of today's `openReviewScoped` (`:926-936`)
  with `sessionId` as a parameter, `group ?? openTargetGroup(docStateRef.current, sessionId)`,
  `shown: activeIdRef.current ?? ''`, and its view side effects only when `sessionId ===
  activeIdRef.current`. `openReviewScoped(scope, repoRoot?, group?)` becomes
  `openReviewIn(activeIdRef.current ?? '', workingSource(scope, repoRoot), group)`.
  `setReviewSource`'s range branch (`:989-996`) calls `openReviewIn(activeIdRef.current ?? '',
  s)`.
- `openGitHistoryIn(sessionId, repoRoot?, reveal?)`: the body of `openGitHistoryTab`
  (`:1006-1020`) with `sessionId` as a parameter, `shown`, `recordNav` + `setCenterView('editor')`
  only when `sessionId === activeIdRef.current`; when `reveal` is given,
  `requestHistoryReveal(repoRoot, reveal)` **before** the dispatch. `openGitHistoryTab(repoRoot?)`
  becomes `openGitHistoryIn(activeIdRef.current ?? '', repoRoot)`.
- `openWeb` (`:2505`): add `shown: activeIdRef.current ?? ''` to both dispatches (`:2510`,
  `:2515`). Signature unchanged.
- `closeDoc` (`:2201`): extract its dirty branch into `closeDirtyUnprompted(doc): Promise<'closed'
  | 'needsPrompt'>` (the `dirtyCloseStep` → `close` / `save` + `afterCloseSave` path,
  `:2237-2259`); `closeDoc` shows its confirm on `'needsPrompt'` exactly as today.
- `closeFilesIn(sessionId, target)`: `planCloseFiles(docStateRef.current.docs, sessionId, target)`;
  per group: non-dirty ids → `forceCloseDoc(id)` (reopen stack); a dirty `file` doc →
  `closeDirtyUnprompted`; a path is `closed` when every id closed, else `skipped:
  'unsaved'`; `notOpen` → `skipped: 'not_open'`. Never prompts, never `closeTabsByUser`.
- Mount `useMcpUi({ hasSession: (id) => sessionsRef.current.some((s) => s.id === id),
  dirtyPathsOf: (id) => sessionDirty([id]), kill: (id) => post({ type: 'kill', id }), closeFiles:
  closeFilesIn, openReview: (id, src) => openReviewIn(id, src), openGitHistory: (id, root, c) =>
  openGitHistoryIn(id, root, c ?? undefined), openUrl: (id, url, focus) => openWeb(url, id, focus ?
  undefined : 'background') })` beside the other bridge subscriptions.

**Call sites (signature changes):**
- `openFile` — signature unchanged (`FileOpenNav` gained an optional field); only
  `flushOsOpens` passes `keepActive`.
- `openReviewScoped` — unchanged signature; callers `:940` (`openReviewTab`), `:986`
  (`setReviewSource` working), `:4640` (right-pane scope) unchanged.
- `openReviewForCommit` — untouched (UI commit links keep activating their session); callers
  `:987`, `:4468`, `:4485` unchanged.
- `openGitHistoryTab` — unchanged signature; callers `:1359`, `:3881`, `:4615` unchanged.
- `openWeb` — unchanged signature; callers `:2532`, `:4464`, `:4725` unchanged; new MCP caller.
- `closeDoc` — unchanged signature; caller `:2269` unchanged. `closeTabsByUser` (callers `:1402`,
  `:3047`, `:4445`) and `requestKill` (callers `:2989`, `:3202`, `:3987`, `:4533`) untouched.
- `setActiveId` — no new caller.
- `sessionOps.addRoot` (`src/session-ops.ts:66`) — untouched; new caller via main (T1.6).
- `activateSession` handler (`:705-708`) — untouched; new producer via main (T1.6).

**Steps:**
- [ ] Failing test in `file-open-request.test.ts`: 'a focused MCP open never activates' —
  `planFileOpen({source:'mcp', focus:true, …}).activate === false`, `showEditor === true`,
  `mode === 'preview'`.
- [ ] Run — FAIL. Implement the edits; app wiring is proven by S3 (no app-level unit harness).

---

### Slice 3: E2E + changelog

**Check (end of feature, once):** `npm run verify` green; `npm run e2e:remote --
conduit-mcp-app-sessions conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web
conduit-mcp-policy conduit-mcp-control` green; `npm run e2e:remote` (`--affected`) green. During
the slice: `node --check <file>` for each `.mjs`, and `npm run verify:quick`.

**Parallel groups:** Serial first: T3.1 · then G1: T3.2 · G2: T3.3 · G3: T3.4 · G4: T3.5 · G5: T3.6
**Claims (serial lane):** `test/e2e/conduit-mcp-app-helpers.mjs` (T3.1); `CHANGELOG.md` (T3.6)

All scenarios: `runScenario('<name>', fn, { userDataDir: fakeAgentProfile('<name>') })`, fakes via
`openFake`, calls via `callTool` / Part A's `startCall` + `resultAfter` + `clickAskAnswer` +
`setSessionPolicy` (`test/e2e/conduit-mcp-helpers.mjs`), `activeSessionId(page)`, cleanup by
`kill` posts as `conduit-mcp-control.e2e.mjs` does.

#### Task 3.1: Helpers

**Files:** Create `test/e2e/conduit-mcp-app-helpers.mjs`.

**Interfaces (used by T3.2–T3.5):**
```js
/** git init + fast-import: `commits` linear commits on main (message `c<n>`), branch `feature`
 *  at c<n-1>, lightweight tag `v1` at c1; returns { dir, shas } (shas[0] = c1). */
export async function gitFixture(dir, { commits })
/** A loopback http server answering 200 "<title>ok</title>"; returns { url, close }. */
export async function httpFixture()
/** Splits `partnerName` beside the active session via the palette ("Split with: <name>"),
 *  using openPalette (test/e2e/middle-click-surfaces-helpers.mjs:180); waits for .termhost__bar. */
export async function splitWith(page, partnerName)
/** Names of the shown session's tabs (`.tabbar [role="tab"]`). */
export async function shownTabs(page)
```
**Steps:** [ ] Implement; `node --check`.

#### Task 3.2: `conduit-mcp-app-sessions`

**Files:** Create `test/e2e/conduit-mcp-app-sessions.e2e.mjs`.

**Phases** (fakes A, B, C; A active; `setSessionPolicy` sets `{access:'on'}` where a phase is not
about `ask`):
1. **focus** — A `focus_session({session: B.handle})` → `{focused: B}`; `activeSessionId === B`.
2. **move:no** — click A; `setSessionPolicy(A,'focus_session',{move:'no'})`; call →
   `move_not_allowed`; after 1 s active still A.
3. **reach refusal** — `setSessionPolicy(A,'close_session',{access:'on', reach:'self'})`;
   `close_session({session: B.handle})` → `out_of_reach`; B still listed; then `reach:'opened'`
   with B opened by A via `open_session` → ok for that one, `out_of_reach` for C.
4. **unknown** — `close_session({session:'nope-9'})` → `unknown_session`.
5. **attach (ask)** — default policy; `startCall(A,'attach_folder',{path:'sub'})`; `.askcard`
   names A and `attach_folder`; `clickAskAnswer('approve')` → `roots` contains `sub`'s path;
   repeat call → ok, `roots` unchanged.
6. **close dirty** — open `fixture.txt` in C via C's own `open_file`, make it dirty (type into
   Monaco, auto-save off via settings), A `close_session({session: C.handle})` →
   `unsaved_changes` naming `fixture.txt`; C still exists.
7. **close clean** — revert C's buffer; call → `{closed: C}`; C gone within 5 s.
8. **self close** — A `close_session({session: A.handle})` → RESULT `{closed: A}` recorded; A gone.
9. **cleanup.**

#### Task 3.3: `conduit-mcp-app-files`

**Files:** Create `test/e2e/conduit-mcp-app-files.e2e.mjs`.

**Phases** (A active):
1. **open_file stays put** — `splitWith(page, B.name)`; B `open_file({path:'a.txt'})` → ok;
   active still A; split bar still B; `shownTabs` has no `a.txt`; click B → `a.txt` tab shown.
2. **close_files clean** — A opens `a.txt`, `b.txt`; `close_files({paths:['a.txt','missing.txt']})`
   → `closed` = [a], `skipped` = [{missing, not_open}]; `a.txt` tab gone; reopen-closed-tab
   shortcut brings `a.txt` back.
3. **close_files dirty, auto-save off** — dirty `b.txt` → `skipped` [{b, unsaved}]; tab still open,
   no dialog (`.modal` absent).
4. **close_files dirty, auto-save on** — set auto-save on; dirty `b.txt` → `closed` [b]; file on
   disk has the typed text.
5. **all** — open Review in A (`open_review` working) and `a.txt`; `close_files({all:true})` →
   no tabs left in A, `closed` includes `@review`.
6. **cleanup.**

#### Task 3.4: `conduit-mcp-app-git`

**Files:** Create `test/e2e/conduit-mcp-app-git.e2e.mjs`.

**Phases** (`gitFixture(dir, {commits: 600})`; A's home = the repo):
1. **review working** — `open_review({source:{kind:'working'}})` → `{opened:'review',
   source:{kind:'working', scope:'all'}}`; a `Review Changes` tab is active; `document.activeElement`
   equals what it was before the call (A4).
2. **review range** — `{kind:'range', base:'v1', head:'feature'}` → source base `{kind:'tag',
   ref:'v1'}`, head `{kind:'branch', ref:'feature'}`; `head:'working'` → `{kind:'working'}`.
3. **bad refs** — `base:'-x'` → `bad_ref`; `ref:'nope'` (commit) → `bad_ref`; `base:'working'` →
   `bad_ref`; `repo:'..'` → `not_a_repo`.
4. **deep commit** — `open_git_history({ref: shas[0]})` (beyond the 500-commit page) →
   `selected === shas[0]`; the `History` tab is active and its detail pane shows subject `c1`.
5. **split partner** — B in the same repo; `splitWith(page, B.name)`; B `open_review(working)` →
   ok; active still A, split still B; A's tabs unchanged; click B → `Review Changes` is B's active
   tab.
6. **cleanup.**

#### Task 3.5: `conduit-mcp-app-web`

**Files:** Create `test/e2e/conduit-mcp-app-web.e2e.mjs`.

**Phases:** `httpFixture()`:
1. **foreground** — `open_url({url})` → `{opened}` equals the normalised URL; a web tab is active
   in A.
2. **background** — `open_url({url: url + 'x', focus:false})` → ok; the active tab is unchanged; the
   new tab exists.
3. **bad_url** — `javascript:alert(1)`, `file:///c:/x`, `conduit-preview://t/x` → `bad_url`; no new
   tab; no OS browser launch (`shell.openExternal` is not observable — the tab count is the
   assertion).
4. **cleanup** — `close()` the server.

#### Task 3.6: CHANGELOG

**Files:** Modify `CHANGELOG.md` (`## [Unreleased]`). One `### Added` entry: seven agent tools —
close or focus a session, attach a folder, close files, open Review, open the commit history at a
ref, open a URL in a Conduit tab — each with its own policy (`close_session` and `attach_folder`
ask by default); one `### Changed` entry: an agent's `open_file` and every new open land in the
agent's own session and never switch the session you're looking at.

## Verification

- **Per task:** named vitest file(s) red then green; both `tsc` projects (T1.2–T1.4 may be red
  only at the named host/main seams).
- **Per slice:** the slice's Check, ending in `npm run verify:quick`.
- **Once, after S3:** `npm run verify`; `npm run e2e:remote -- conduit-mcp-app-sessions
  conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web conduit-mcp-policy
  conduit-mcp-control`; `npm run e2e:remote` (`--affected`). A local failure is confirmed remotely
  before bisecting.
- At most one local e2e by exact name. Exit codes captured directly, never through a pipe.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality (including a Part A seam that landed differently from its plan) — that task
**stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special
case, widened type, fallback, or an override patched in place of its semantic source. The report
leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **B1:** The split partner has no editor pane (only its terminal), so "the tab opens in
  that pane" can't be met literally. Default taken: the tab opens active in the caller's own
  layout; active and split stay unchanged; the human sees it on activating that session.
- [high] **B2:** `close_session`'s dirty check must run where the target's docs live. Default
  taken: `closeSession` goes to the **target's** owner window (spec routes everything to the
  caller's); an unready target window → `window_not_ready`.
- [normal] **B3:** `attach_folder` reason mapping: `is-home` / `duplicate` → success, roots
  unchanged; `not-found` → `path_missing`; `not-a-directory` → `not_a_directory`; `invalid-path`
  → `invalid_args`; the rest → new code `attach_refused`.
- [normal] **B4:** "window reset → no reply" in the brief read as: window reset/close/move →
  `window_not_ready` (spec §2.3), CLI cancel / connection close → no reply, late reply → dropped.
- [normal] **B5:** Per-CLI schema acceptance (Part A S0 item moved here) was not measured. Default
  taken: flat schemas with no `oneOf`/`anyOf`/`allOf`/`$ref`/`const`, pinned by a unit test; the
  combinations are validated host-side.
- [normal] **B6:** `open_review` / `open_git_history` `repo` resolves to the git toplevel of the
  home or root; a home that isn't inside a repo returns `not_a_repo` by default (the UI's
  active-repo fallback is not used).
- [normal] **B7:** Every classified ref is also verified as `^{commit}` (a tag on a tree is
  `bad_ref`).
- [normal] **B8:** `close_files` with `all:true` reports each closed doc's path, including the
  sentinels `@review` / `@git-history` and web URLs. A diff tab of a dirty path closes; the path is
  reported `unsaved` because its file tab stayed.
- [normal] **B9:** `unsaved_changes` carries its ≤ 20 paths in the error message (`ToolError` has
  no data field).
- [normal] **B10:** `ui_timeout` is not retryable: the outcome is unknown and a retry could act
  twice.
- [normal] **B11:** Part A code had not landed when this plan was written; every Part A name is
  from its plan's Contracts, re-grepped per task.
