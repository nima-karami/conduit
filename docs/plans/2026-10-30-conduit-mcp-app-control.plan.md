# Plan: Conduit MCP app-control tools (Part B)

Spec: [2026-10-30-conduit-mcp-app-control.md](../specs/2026-10-30-conduit-mcp-app-control.md)
(FULL, reviewed). Depends on [2026-10-30-conduit-mcp-tool-policy.md](../specs/2026-10-30-conduit-mcp-tool-policy.md)
and builds on the Part A plan [2026-10-30-conduit-mcp-tool-policy.plan.md](2026-10-30-conduit-mcp-tool-policy.plan.md).

**Tier: FULL.** Seven new MCP tools, a new host↔renderer request/response (`mcp:ui` /
`mcp:uiResult`), reach enforcement, a git ref classifier, a module move (`normalizeUrl`), and
session-explicit renderer entry points. Crosses `src/`, `electron/` and `webview/`.

**Planned against Part A as implemented: `feat/mcp-policy` at `cd0d287e`.** Every Part A
reference cites that code. Revised (r1) after an independent architecture critique against
`cd0d287e`; every r1 item was accepted by the conductor and is folded into the tasks, not
appended. Line numbers were grepped at `cd0d287e`; earlier tasks shift them, so re-grep before
editing.

## Goal

An agent can close or focus a session, attach a folder, close its files, open Review, open the
commit history at a ref, and open a URL in an in-app tab — each gated by its Part A policy
(access/when/reach/move), each doing what the matching UI action does to the **caller's** session
without changing which session is active or split, and each returning what actually happened.

## Architecture

- **The seven tools live in a new `src/conduit-mcp/app-control-tools.ts`**, built **on** Part A's
  machinery in `src/conduit-mcp/control-tools.ts`: every tool goes through the shared `prepared()`
  (reserve → home → `check` → refund unless kept, `control-tools.ts:277-310`). `control-tools.ts`
  keeps the budgets and shared helpers and exposes `prepared` on `ControlHandlers`; the host hands
  it to `createAppControlHandlers`. Target lookup, reach, move and window routing run inside
  `check`, and target/reach/window again inside `exec` (an ask can wait up to 120 s).
- **Git ref work is a new host-only module** `src/conduit-mcp/git-refs.ts`: classify a ref, look up
  one `CommitNode`, find a folder's repo root. Git is an injected `GitCall`, so tests run on fakes
  (pattern: `src/range-preset.ts`).
- **`mcp:ui` is a second `createWindowWaits` instance owned by `call-flow.ts`.** It shares the ask
  path's in-flight keys (`keyOf`, `call-flow.ts:189-194`), so `notifications/cancelled`,
  connection close, window reset and session moves end UI waits on the same code paths as asks.
  The wait's meta records the **routed** session, so a move or delete of a `close_session` target
  ends its wait too. `requestUi` checks the window is ready and treats a throwing send as
  `window_not_ready`, so no call is left unanswered.
- **Routing:** UI actions go to the caller's owner window, except `closeSession`, which goes to the
  **target's** owner window — the only renderer that holds the target's docs and dirty buffers
  (B2). `focus_session` into another window raises that window, as `moveSessionToWindow` does.
- **Ask budget for UI tools:** a UI-routed tool's ask waits `ASK_TIMEOUT_MS[kind] − UI_TIMEOUT_MS`,
  so ask + UI wait stays under the CLI's own call timeout.
- **Renderer:** `webview/mcp-ui.ts` subscribes to `mcp:ui`, plans and runs close-files (pure,
  injected ops, unit-tested), calls a handler set wired in `webview/app.tsx`, and posts
  `mcp:uiResult`. App gains **session-explicit** entry points (`openReviewIn`, `openGitHistoryIn`,
  a `keepActive` file-open option); the existing UI functions become thin wrappers that pass
  `activeIdRef.current`, so UI behaviour and every UI call site are unchanged.
- **The docs reducer gains `shown`** on `open` / `openReview`: a foreground open into a session that
  isn't the shown one lands active in that session's layout without re-pointing
  `DocsState.activeId` (today `openForeground` re-points it, `webview/docs.ts:376-377`, which is
  what a non-active `openWeb` target already does wrong).
- **History reveal:** `webview/history-reveal.ts` holds one pending `CommitNode` keyed by
  (owner session, repo); the history view folds it into its displayed set and selects it the way
  a deep-search hit is selected — at any depth, no paging.
- **`normalizeUrl` moves** from `webview/web-url.ts` to `src/web-url.ts` (with
  `displayTitleForUrl`), so the host validates with the renderer's exact function.
- **No sketches.** Every seam copies a sibling: `git-refs.ts` copies `src/range-preset.ts`'s
  injected-git shape; the UI waits copy the ask waits (`call-flow.ts:99-109`); `webview/mcp-ui.ts`
  copies `webview/mcp-ask-store.ts`'s bridge subscription; the reveal store copies the
  module-singleton subscription in `webview/use-conduit-mcp.ts`.

## Data flow

```
CALL  CLI ─tools/call{id}─► core ─► host.callTool (conduit-mcp-host.ts:777; begin :784; gate :798-808)
   ctx (:819) = {move, reach, ui(w, routed, action) ⇒ flow.requestUi({inflight, caller, routed, w, action})}
   prepareControl (:860-874) — 7 new cases ─► app.prepareX(caller, args, ctx)
      control.prepared(tool, caller, check):  reserve ─► home ─► check ─► PreparedCall{routesUi}
        check: parse ─► resolveTarget(listed only) ─► inReach ─► move ─► routeWindow ─► args/git
      any refusal before hand-out ⇒ refund
   flow.runControl: on ─► run() | ask(timeout ASK_TIMEOUT_MS[kind] − (routesUi ? UI_TIMEOUT_MS : 0)) ─► run()
   run() = exec(token): recheckTarget + routeWindow ─► IO ─► token.keep() on success, else refund
      host-side: focus_session ─► deps.activateSession(target, raise)       (no reply)
                 attach_folder ─► deps.addRoot(target, abs) ─► roots
      UI:  flow.requestUi: windowReady(w)? else window_not_ready
             waitsUi.open({id, key: keyOf(inflight), windowId: w, meta{kind, routedSessionId}}, UI_TIMEOUT_MS)
             try sendToWindow(w, {type:'mcp:ui', requestId, sessionId: caller, action})
             catch ⇒ cancel that wait ⇒ window_not_ready
             ── await ──  answered ⇒ result | expired ⇒ ui_timeout
                          cancelled ⇒ window_not_ready ("outcome unknown"); reply:false ⇒ runNow (:111-114) returns null

RENDERER (routed window)  bridge mcp:ui ─► webview/mcp-ui.ts useMcpUi(handlers)
   closeSession{target}: dirty = dirtyPathsOf(target)
        dirty ⇒ post uiResult{unsaved}      clean ⇒ post uiResult{ok}; post kill{target}   (same turn)
   closeFiles: runCloseFiles(planCloseFiles(...), ops) ─► post uiResult{closed, skipped, truncated?}
   openReview / openGitHistory / openUrl: session-explicit open ─► post uiResult{opened}
   main (:4538-4548) ─► host.handleRenderer(mcp:uiResult, reply, senderId) (:1424)
        ─► flow.answerUi(requestId, senderId, raw): pending().find(id) ─► parseUiResult(meta.kind, raw)
           null ⇒ ignored (the wait times out)

SELF CLOSE  uiResult task: answer ─► microtasks write the reply
            kill task: disposeSession ─► onSessionDeleted (:1388-1393) ─► flow.sessionGone ─► drainConnectionsOf
            (:1088-1094): a connection still answering is closed only after its owed reply

CANCEL  notifications/cancelled / conn close ─► flow.cancelled / connectionClosed (:240-251) ─► both waits, reply:false
        window reset ─► flow.windowReset(w) ─► both waits with windowId === w, reply:true
        session moved/gone(s) ─► asks of caller s; UI waits whose caller or routed session is s; reply:true

OPEN_FILE (changed)  openMcpFile ─► openFileInEditor{sessionId: caller}  (Part A)
   renderer flushOsOpens: source 'mcp' ⇒ planFileOpen (never activates) ⇒ openFile(…, {keepActive})

DOCS  openReviewIn / openGitHistoryIn / openWeb / openFile(keepActive)
        dispatch open|openReview {sessionId: caller, shown: activeIdRef.current}
        reducer: openForeground(...) ─► finalize(focus = shown)
HISTORY  openGitHistoryIn(caller, repoRoot, commit) ─► requestHistoryReveal(caller, repoRoot, commit)
        GitHistoryView (mount / notify) ─► takeHistoryReveal(sessionId, repoRoot) ─► dispatch reveal
```

## Settled decisions — do not re-litigate

- Seven tools: `close_session`, `focus_session`, `attach_folder`, `close_files`, `open_review`,
  `open_git_history`, `open_url`; inputs/results per spec §2.1.
- `mcp:ui` / `mcp:uiResult` request-response; a second `createWindowWaits` instance; 5 s timeout;
  answers bound to the window the request went to; late reply dropped; CLI cancel → no reply;
  window reset → `window_not_ready`.
- Session-explicit renderer entry points; tools never read `activeIdRef` to pick their target and
  never call `setActiveId`, except `focus_session` (and Part A's `focus:true` session open).
- Ref classification per spec §2.2, except (r1) `--end-of-options` goes to `git log` only: older git
  echoes it from `rev-parse`; the leading-`-` guard already blocks option injection there.
- `normalizeUrl` moves to `src/`; host validates, renderer opens an in-app tab, never the OS browser.
- `open_file` opens in the caller's session (Part A's `openMcpFile`; Part B stops the renderer from
  activating it). `open_review` and `open_git_history` always focus their tab (in the caller's
  layout).
- Policy defaults per spec A §3.2 (`TOOL_SPECS` rows). Reach enforcement (`self` / `opened` /
  `window` / `any` via `ownerWindowOf` + `Session.openedBy`) and `move_not_allowed` land here
  (Part A N1). Targets are looked up among **listed** sessions only (Part A N9; `listedSessions`,
  `electron/conduit-mcp-host.ts:382-394`).
- Budgets from Part A: act (`close_session`, `attach_folder`), show (`focus_session`,
  `close_files`, `open_review`, `open_git_history`, `open_url`). A refusal at step 7 or 9 refunds.
- `attach_folder` is `sessionOps.addRoot` unchanged; it never types `/add-dir`.
- `close_session` never confirms beyond the policy; dirty → `unsaved_changes`, nothing closed.
- r1 (accepted): tools in `app-control-tools.ts` on `prepared()`; target/reach/window re-checked at
  run; UI waits carry the routed session; UI-routed asks shrink by `UI_TIMEOUT_MS`; a throwing or
  unready send ends its wait; close-files loop is pure; results capped at 500 with `truncated`;
  reveal keyed by (session, repo); `focus_session` raises a foreign window; act budget label
  "actions".

## Spec staleness

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| "For a split-partner caller, the tab activates inside that pane" (§2.1, §5 EARS 2) | The split partner shows only its terminal (`webview/components/center-pane.tsx:348-352`); doc tabs render for the active session only (`DocsState.layouts` per session, `webview/docs.ts:114-120`) | Tab opens active in the caller's own layout; active and split unchanged (B1). Spec §2.1 and §5 updated |
| A split partner's Review/History open leaves the human's view alone | Both are singletons; a foreground open moves them to the opener (`webview/docs.ts:351-357`) | Accepted and documented (B1); pinned by a docs test (T2.1) and e2e (T3.4 ph 5) |
| `close_session` dirty check in "the caller's owner window" (§2.1, §2.3 routing) | Docs and the dirty set are per renderer (`webview/app.tsx:643`, `docState`); a target in another window keeps its docs there | `closeSession` goes to the target's owner window (B2). Spec §2.3 updated |
| `attach_folder`: home or an existing root succeeds; "It is `sessionOps.addRoot`, unchanged" (§2.1) | `addRoot` refuses them with `is-home` / `duplicate` (`src/session-ops.ts:66-81`) | `addRoot` unchanged; `attach_folder`'s exec maps `is-home` and `duplicate` to success, roots unchanged |
| Selection "the way a deep-search hit is selected (git-history-view.tsx:656)" | File is `webview/components/git-history-view.tsx`; :655-659 is the `selectedCommit` lookup over `searchable` (:406-412); selection is component-local; no `git log -1` lookup exists | `reveal` action + `webview/history-reveal.ts`; `lookupCommit`. Spec cite corrected |
| "as the UI does (app.tsx:1003)" | `openGitHistoryTab` is at `webview/app.tsx:1010`; the move is `openForeground`'s transfer (`webview/docs.ts:351-357`) | Unchanged mechanism. Spec cite corrected |
| "Every git call passes `--end-of-options`" (§2.2) | Older git echoes it from `rev-parse` (r1); this machine: `git version 2.42.0.windows.2` | Only `git log` gets it. Spec §2.2 updated |
| `focus_session` "Sends `activateSession`" | A target in another window stays behind; `moveSessionToWindow` raises (`electron/main.ts:2283-2287`) | Raise/focus the target's window when it isn't the caller's (B12). Spec §2.1 updated |
| A non-active open target "just gets the tab" (implicit, §2.4) | `openForeground` → `finalize(…, s)` re-points `DocsState.activeId` (`webview/docs.ts:316-317`, `:376-377`) | `shown` on `open` / `openReview` (T2.1) |
| `open_file` "opens in the caller's session" | Part A sends to the caller, but `planFileOpen` activates on `focus` (`webview/file-open-request.ts:21-24`) and `openFile` switches active for a non-active target (`webview/app.tsx:2419-2422`) | `planFileOpen` never activates; `FileOpenNav.keepActive` (T2.4a) |
| Part A S0 moved here: "whether every CLI accepts the new schemas" | Not measurable in this run (no real-CLI lane) | Flat schemas, pinned by a unit test (B5) |

## Global constraints

- **Gates and cadence** (relevant tests only while building):
  - Per task: the named vitest file(s), red then green (`npx vitest run <file>`); both
    `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.webview.json --noEmit` green after
    every task, except T1.5, which may leave `tsc` red **only** at `electron/main.ts`'s host
    construction (closed by T1.6). New catalog rows don't break `tsc` early: `prepareControl`
    throws on an unhandled name (`conduit-mcp-host.ts:874`).
  - Per slice: the slice's Check, ending in `npm run verify:quick`.
  - **Once, after S3:** `npm run verify`; then `npm run e2e:remote -- conduit-mcp-app-sessions
    conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web conduit-mcp-policy
    conduit-mcp-control`; then `npm run e2e:remote` (`--affected`; `electron/main.ts` changes make it
    the full suite, `test/e2e/ci-affected.mjs:11-18`).
  - Locally at most one e2e by exact name. Never narrow, skip or disable a check; never pipe verify
    output through `tail`; capture exit codes directly.
- **Fallow:** every export below names its caller; a type used only in its own file stays
  unexported. `SESSION_TOOL_NAMES` / `EDITOR_TOOL_NAMES` stay unexported (`tool-policy.ts:12-13`).
- **CI is ubuntu:** unit tests never depend on `\`, drive letters or `process.platform`. Paths in
  tests are POSIX; `folderKey` (`src/folder-key.ts:4`) is the only path comparison.
- **Comments explain WHY only**; spec pointers like `// spec 2026-10-30-conduit-mcp-app-control §2.2`.
  No `as any`, `@ts-ignore`, `!important`, swallowed errors, magic offsets.
- **Naming:** files kebab-case by role; tests `test/unit/<module>.test.ts[x]`; React tests start with
  `// @vitest-environment jsdom`. MCP wire fields `snake_case`; host↔renderer fields `camelCase`.
  Constants `SCREAMING_SNAKE`.
- **Git:** only via `runGit` (`src/git-exec.ts`, imported `electron/main.ts:75`). A value starting
  with `-` never reaches git; `git log` gets `--end-of-options` before the value.
- **Trust boundaries:** every tool argument is validated host-side; every `mcp:uiResult` is
  re-parsed against its wait's action kind and must come from that wait's window. The renderer is
  never load-bearing for policy, reach or routing.
- **No call left unanswered:** any throw between `waitsUi.open` and the send's return ends that wait
  and returns `window_not_ready`.
- **Renderer rules (CLAUDE.md):** no new overlay; no DOM focus moves on tool-driven opens (A4); no
  new class names.
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
- A real-CLI schema-acceptance lane (B5).

## Contracts

### `src/web-url.ts` (moved from `webview/web-url.ts`) — T0.1

Byte-identical bodies of `normalizeUrl(input: string): string | null` and `displayTitleForUrl`,
plus the private `isLocalHost`. `webview/web-url.ts` is deleted.

### `src/conduit-mcp/types.ts` — T1.2

`ToolErrorCode` gains `'unknown_session' | 'out_of_reach' | 'move_not_allowed' | 'bad_ref' |
'bad_url' | 'not_a_repo' | 'attach_refused' | 'unsaved_changes' | 'ui_timeout'`. `RETRYABLE`
unchanged (a `ui_timeout` outcome is unknown; retrying could act twice).

### `src/conduit-mcp/tool-policy.ts` — T1.2

```ts
// unexported, extended (:12-13)
const SESSION_TOOL_NAMES =
  ['open_session', 'open_terminal', 'close_session', 'focus_session', 'attach_folder'] as const;
const EDITOR_TOOL_NAMES =
  ['open_file', 'close_files', 'open_review', 'open_git_history', 'open_url'] as const;
// SESSION_FIELDS (:91) stays ['access','when','move'] for open_session / open_terminal only.
// New rows; every reach row sets `reach` explicitly (offered() falls back to all REACH_VALUES, :151):
//   close_session:  fields ['access','when','reach'],        access ACCESS_VALUES, reach ['self','opened','window','any'], budget 'act',
//                   defaults {access:'ask', when:'viewing', reach:'window'}
//   focus_session:  fields ['access','when','reach','move'], access ACCESS_VALUES, reach ['self','opened','window','any'], budget 'show',
//                   defaults {access:'on',  when:'viewing', reach:'window', move:'yes'}
//   attach_folder:  fields ['access','when','reach'],        access ACCESS_VALUES, reach ['self','opened','window'],       budget 'act',
//                   defaults {access:'ask', when:'viewing', reach:'self'}
//   close_files, open_review, open_git_history, open_url:
//                   fields ['access','when'], access ACCESS_VALUES, budget 'show', defaults {access:'on', when:'viewing'}
```

### `src/conduit-mcp/ui-types.ts` — T1.2

Header comment (`:1-3`) becomes: imports are type-only from node-free modules (`./types`,
`./install-types`, `../git-range`, `../protocol`); the `../protocol` ↔ `ui-types` cycle is
type-only and erased at build, so the renderer still never reaches a node-backed module.

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

export const MAX_CLOSE_RESULTS = 500;
export interface CloseFilesOutcome {
  closed: string[];
  skipped: { path: string; reason: 'unsaved' | 'not_open' }[];
  /** closed + skipped hit MAX_CLOSE_RESULTS; later entries weren't recorded (their tabs still closed). */
  truncated?: true;
}
export type McpUiResult =
  | { kind: 'closeSession'; ok: true }
  | { kind: 'closeSession'; ok: false; unsaved: string[] }        // ≤ 20 paths
  | ({ kind: 'closeFiles' } & CloseFilesOutcome)
  | { kind: 'opened' }                                            // openReview | openGitHistory | openUrl
  | { kind: 'unknownSession' };                                   // the session isn't in this window

// AskSummary (:20) gains:
  | { tool: 'close_session'; target: Handle }
  | { tool: 'focus_session'; target: Handle }
  | { tool: 'attach_folder'; path: string; target: Handle }
  | { tool: 'close_files'; count: number; all: boolean }
  | { tool: 'open_review'; what: string }        // 'working', a short sha, or 'base…head'
  | { tool: 'open_git_history'; ref: string | null }
  | { tool: 'open_url'; url: string }
```

`MAX_CLOSE_RESULTS` callers: `call-flow.ts` `parseUiResult` (T1.3) and `webview/mcp-ui.ts`
`runCloseFiles` (T2.2).

### `src/protocol.ts` — T1.2

```ts
// HostToWebview
  | { type: 'mcp:ui'; requestId: string; sessionId: string; action: McpUiAction }
// WebviewToHost (host re-parses `result` against the wait's action kind)
  | { type: 'mcp:uiResult'; requestId: string; result: unknown }
```

`sessionId` is always the **caller**; `closeSession` names its target in the action.

### `src/conduit-mcp/git-refs.ts` (new, host-only) — T1.1

```ts
import { PRETTY_FORMAT, parseCommits } from '../git-history';   // PRETTY_FORMAT becomes exported (:107)
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
- Input check (`classifyRef`, `lookupCommit`): `value.length === 0 || value.length > MAX_REF_CHARS`
  → `invalid_args`; `value.startsWith('-')` → `bad_ref` (`'a ref may not start with "-"'`), git not
  called.
- `classifyRef`: `git(repoRoot, ['rev-parse', '--symbolic-full-name', value])`. Not ok, or stderr
  matches `/ambiguous/i` → `bad_ref` with stderr's first non-empty line cut to 200 chars. Then
  `git(repoRoot, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`])`; not ok or empty →
  `bad_ref` (`` `${value} is not a commit` ``). Kind from the first stdout line of the first call:
  `refs/heads/x` → `{kind:'branch', ref:'x'}`; `refs/remotes/x` → `{kind:'branch', ref:'x',
  remote:true}`; `refs/tags/x` → `{kind:'tag', ref:'x'}`; anything else (empty, `HEAD`) →
  `{kind:'commit', sha}` from the second call.
- `lookupCommit`: the `^{commit}` verify above → `sha`; then `git(repoRoot, ['log', '-1',
  '--parents', '--decorate=full', `--pretty=${PRETTY_FORMAT}`, '--end-of-options', sha])` →
  `parseCommits(stdout)[0]`; missing → `bad_ref`.
- `repoRootOf`: `git(folder, ['rev-parse', '--show-toplevel'])`; not ok or empty → `not_a_repo`
  (`` `${folder} is not in a git repository` ``); else the trimmed line with `\` → `/`.

### `src/conduit-mcp/call-flow.ts` — T1.3

```ts
export const UI_TIMEOUT_MS = 5_000;
// CallFlowDeps (:47) gains
  /** Sends to one window by id; main guards isDestroyed. May still throw. */
  sendToWindow(windowId: number, msg: HostToWebview): void;
  /** presence.isReady for a window id. */
  windowReady(windowId: number): boolean;
// CallFlow (:65) gains
  /**
   * Sends mcp:ui to `windowId` and waits ≤ UI_TIMEOUT_MS for that window's answer. Keyed by the
   * in-flight's call key (keyOf, :189-194), so every cancel path ends it.
   * !windowReady(windowId) or a throwing send ⇒ window_not_ready (no wait left pending);
   * answered ⇒ ok(result); expired ⇒ ui_timeout; cancelled (either reply flag) ⇒ window_not_ready.
   */
  requestUi(r: { inflight: InFlight; callerSessionId: string; routedSessionId: string;
                 windowId: number; action: McpUiAction }): Promise<Result<McpUiResult>>;
  /** false unless the request is waiting, `fromWindowId` is its window, and `raw` parses for its kind. */
  answerUi(requestId: string, fromWindowId: number, raw: unknown): boolean;
```

- A second `createWindowWaits<McpUiResult, UiMeta>` instance, `interface UiMeta { kind:
  McpUiAction['kind']; routedSessionId: string }` (unexported); its `onUnanswered` sends nothing.
  Request ids from `deps.newAskId()`.
- `answerUi`: `w = waitsUi.pending().find((x) => x.id === requestId)` (no new `window-waits` API,
  `window-waits.ts:39`); `!w` → `false`; `parsed = parseUiResult(w.meta.kind, raw)`; `null` →
  `false`; else `waitsUi.answer(requestId, fromWindowId, parsed)`.
- Cancel paths (`:238-260`, `:276-283`): `cancelled(connId, requestId)` and `connectionClosed(connId)`
  also cancel matching UI waits (reply false); `windowReset(w)` cancels UI waits with
  `windowId === w` (reply true); `sessionMoved(s)` / `sessionGone(s)` cancel UI waits with
  `callerSessionId === s || meta.routedSessionId === s` (reply true); `recheck()` leaves UI waits
  alone; `dispose()` disposes both instances. `runNow` (`:111-114`) already returns `null` for a
  cancelled call, so a reply-false end never reaches the CLI.
- `ask` (`:116`) timeout: `ASK_TIMEOUT_MS[c.kind] - (p.routesUi ? UI_TIMEOUT_MS : 0)`.
- Messages: `ui_timeout` `"Conduit's window didn't answer within 5 s; the outcome is unknown"`;
  window gone after the request was sent: `window_not_ready` `"Conduit's window closed or reloaded
  before answering; the outcome is unknown"`; before sending: Part A's `windowNotReady()`.
- Unexported `parseUiResult(kind, v): McpUiResult | null`: `closeSession` → `{kind:'closeSession',
  ok:true}` or `{…, ok:false, unsaved: string[] ≤ 20}`; `closeFiles` → `closed: string[]`,
  `skipped: {path: string, reason: 'unsaved'|'not_open'}[]`, `closed.length + skipped.length ≤
  MAX_CLOSE_RESULTS`, optional `truncated: true`; open kinds → `{kind:'opened'}`; any kind may answer
  `{kind:'unknownSession'}`. Anything else → `null`.

### `src/conduit-mcp/control-tools.ts` (shared machinery) — T1.3 (`routesUi`), T1.4 (rest)

```ts
// T1.3: PreparedCall (:63-69) gains
  /** Its run waits on a renderer (mcp:ui): the ask budget shrinks by UI_TIMEOUT_MS. */
  routesUi: boolean;
// prepared() (:277) sets it from the check result's optional `routesUi` (absent ⇒ false), so the
// three Part A tools are unchanged.

// T1.4
/** Every non-messaging tool (was Extract<3 names>, :234). */
export type ControlTool = Exclude<ToolName, (typeof MESSAGING_TOOL_NAMES)[number]>;
/** Built per call by the host (conduit-mcp-host.ts:819; typed at :864). */
export interface ControlCallContext {           // was unexported {move} (:70-72)
  move: Move | undefined;
  reach: Reach | undefined;
  /** Bound by the host to flow.requestUi with this call's inflight and caller. */
  ui(windowId: number, routedSessionId: string, action: McpUiAction): Promise<Result<McpUiResult>>;
}
export type Fail = { ok: false; error: ToolError };                 // was local
export function fail(code: ToolErrorCode, message: string): Fail;   // was local
export function isFail(v: unknown): v is Fail;                      // was local
/** Object + unknown-key checks only; parseObject (:108) becomes parseKeys + its path/focus checks. */
export function parseKeys(raw: unknown, allowed: readonly string[]): Record<string, unknown> | Fail;
export function parseObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> | Fail;
export interface Token { refund(): void; keep(): void }             // was local; exec calls keep() on success
export type CheckResult<T> =
  | Fail
  | { summary: AskSummary; routesUi?: true; exec: (token: Token) => Promise<Result<T>> };
export interface TargetSession { sessionId: string; handle: Handle; openerSessionId: string | null }
// ControlHandlers (:73-89) gains
  /** The shared reserve → home → check → refund-unless-kept pipeline (:277-310). */
  prepared<T>(tool: ControlTool, caller: Caller,
    check: (who: { sessionId: string; home: string }) => Promise<CheckResult<T>>): Promise<Result<PreparedCall<T>>>;
// ControlDeps (:50-62) gains (main binds the first four; the host binds the rest)
  foldersOf(sessionId: string): { home: string; roots: string[] } | undefined;
  addRoot(sessionId: string, path: string): Promise<SessionOpResult>;
  /** raise: the target's window isn't the caller's (show + focus it, as moveSessionToWindow does). */
  activateSession(sessionId: string, raise: boolean): void;
  git: GitCall;
  targets(): readonly TargetSession[];
  ownerWindowOf(sessionId: string): number | null;
  windowReady(windowId: number): boolean;
// budgets.act label 'opens' → 'actions' (:238)
```

### `src/conduit-mcp/app-control-tools.ts` (new) — T1.4

```ts
import { type ControlCallContext, type ControlDeps, type ControlHandlers,
  fail, isFail, parseKeys, parseObject } from './control-tools';

export interface CloseSessionOutput { closed: string }
export interface FocusSessionOutput { focused: string }
export interface AttachFolderOutput { attached: string; session_id: string; roots: string[] }
export type ReviewSourceOut =
  | { kind: 'working'; scope: McpReviewScope }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint };
export interface OpenReviewOutput { opened: 'review'; source: ReviewSourceOut }
export interface OpenGitHistoryOutput { opened: 'git-history'; selected: string | null }
export interface OpenUrlOutput { opened: string }
export const MAX_CLOSE_PATHS = 50;
export const MAX_URL_BYTES = 2048;

export interface AppControlHandlers {
  prepareCloseSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<CloseSessionOutput>>>;
  prepareFocusSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<FocusSessionOutput>>>;
  prepareAttachFolder(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<AttachFolderOutput>>>;
  prepareCloseFiles(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<CloseFilesOutcome>>>;
  prepareOpenReview(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenReviewOutput>>>;
  prepareOpenGitHistory(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenGitHistoryOutput>>>;
  prepareOpenUrl(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenUrlOutput>>>;
}
export function createAppControlHandlers(deps: ControlDeps, prepared: ControlHandlers['prepared']): AppControlHandlers;
```

Every `prepare*` is `prepared(tool, caller, async (who) => …)`. Inside `check`, in order (spec A
§3.3 step 7; `prepared` reserves first, Part A order): parse (`invalid_args`) → target
(`unknown_session`) → reach (`out_of_reach`) → move (`move_not_allowed`) → window
(`window_not_ready`) → argument checks → `{summary, routesUi?, exec}`. Every refusal refunds.

- **Unexported helpers:**
  - `resolveTarget(v)`: `session` a non-empty string ≤ 128 chars; match a `targets()` entry by
    `handle`, then by `sessionId`; none → `unknown_session` (`` `no session "${v}" in list_sessions` ``).
  - `inReach(reach, callerId, t)`: `self` → `t.sessionId === callerId`; `opened` → that, or
    `t.openerSessionId === callerId`; `window` → `ownerWindowOf(t.sessionId) !== null &&
    ownerWindowOf(t.sessionId) === ownerWindowOf(callerId)`; `any` → true. Refusal `out_of_reach`:
    `self` `'this tool may only act on your own session'`; `opened` `'this tool may only act on your
    session and sessions you opened'`; `window` `'this tool may only act on sessions in your
    window'`. Never names another session.
  - `routeWindow(sessionId)`: `w = ownerWindowOf(sessionId)`; `w === null || !windowReady(w)` →
    `window_not_ready` (Part A `windowNotReady()`); else `w`. Used by **every** UI-routed tool and
    `focus_session`, in both `check` and `exec`.
  - `recheckTarget(targetId, callerId, reach)` (in `exec`, r1 B): still in `targets()` (else
    `unknown_session`), `inReach` (else `out_of_reach`), `routeWindow(target)`.
- **`close_session`:** args `{session}` (`parseKeys`). `check`: target, reach, `routeWindow(t)`.
  Summary `{tool, target: t.handle}`; `routesUi: true`. `exec`: `recheckTarget` → `w`;
  `ctx.ui(w, t.sessionId, {kind:'closeSession', target: t.sessionId})` → `ok:true` ⇒ `keep`,
  `{closed: t.sessionId}`; `ok:false` ⇒ `unsaved_changes` (`` `unsaved changes in:\n${unsaved.join('\n')}` ``);
  `unknownSession` ⇒ `unknown_session`; a `Result` error passes through.
- **`focus_session`:** args `{session}`. `check`: target, reach, `ctx.move === 'no'` →
  `move_not_allowed` (`"focus_session is set to never switch the human's view"`), `routeWindow(t)`.
  `exec`: `recheckTarget` → `activateSession(t.sessionId, ownerWindowOf(t.sessionId) !==
  ownerWindowOf(caller))` → `keep`, `{focused: t.sessionId}`.
- **`attach_folder`:** args `{path, session?}` via `parseObject(raw, ['path', 'session'])`;
  `abs = resolvePath(who.home, path)` (the **caller's** home, spec §2.1); target: `session` →
  `resolveTarget` + reach; absent → the caller (reach trivially holds). Summary `{tool, path: abs,
  target: handle}`. `exec`: `recheckTarget` when a `session` was given; `r = await addRoot(target,
  abs)`; `ok`, `is-home`, `duplicate` ⇒ `keep`, `{attached: abs, session_id: target, roots:
  foldersOf(target)?.roots ?? []}`; `not-found` ⇒ `path_missing`; `not-a-directory` ⇒
  `not_a_directory`; `invalid-path` ⇒ `invalid_args`; `unknown-session` ⇒ `unknown_session`; any
  other reason ⇒ `attach_refused` (`` `can't attach ${abs}: ${reason}` ``).
- **`close_files`:** args exactly one of `paths` (1–`MAX_CLOSE_PATHS` non-empty strings ≤ 4096) or
  `all: true` (`parseKeys(raw, ['paths', 'all'])`); both or neither → `invalid_args`. Each path →
  `resolvePath(who.home, p)`; `routeWindow(caller)`. Summary `{tool, count, all}`; `routesUi: true`.
  `exec`: `routeWindow(caller)` → `ctx.ui(w, caller, {kind:'closeFiles', paths: abs[] | 'all'})` →
  `keep`, `{closed, skipped, truncated?}`.
- **`open_review`:** args `{source: {kind, scope?, ref?, base?, head?}, repo?}`. `working`: only
  `scope` (default `'all'`); `commit`: only `ref`; `range`: only `base`, `head`. `repoRoot =
  resolveRepo(who, repo)`. `commit` → `lookupCommit` → `{kind:'commit', sha, subject, repoRoot}`;
  `range` → `classifyRef(base)` (the literal `'working'` → `bad_ref` `'"working" is only allowed as a
  range head'`), `head === 'working'` → `{kind:'working'}` else `classifyRef`. `routeWindow(caller)`.
  Summary `what`: `'working'`, `sha.slice(0, 7)`, or `` `${base}…${head}` `` (the raw inputs);
  `routesUi: true`. `exec`: `routeWindow(caller)` → `ctx.ui(w, caller, {kind:'openReview', source})`
  → `keep`, `{opened:'review', source: <without repoRoot/subject>}`.
- **`open_git_history`:** args `{repo?, ref?}`. `repoRoot = resolveRepo`; `ref` → `lookupCommit`;
  `routeWindow(caller)`. Summary `{tool, ref: ref ?? null}`; `routesUi: true`. `exec`:
  `routeWindow(caller)` → `ctx.ui(w, caller, {kind:'openGitHistory', repoRoot, commit})` → `keep`,
  `{opened:'git-history', selected: commit?.sha ?? null}`.
- **`resolveRepo(who, repo)`** (unexported): `f = repo === undefined ? who.home :
  resolvePath(who.home, repo)`; `folderKey(f)` must equal `folderKey` of `home` or a root
  (`foldersOf(who.sessionId)`), else `not_a_repo` (`'repo must be your home folder or an attached
  folder'`); then `repoRootOf(git, f)`.
- **`open_url`:** args `{url, focus?}`; `url` a string with UTF-8 length ≤ `MAX_URL_BYTES`, else
  `invalid_args`; `normalizeUrl(url)` (`src/web-url.ts`) `null` → `bad_url` (`'only http and https
  URLs can be opened'`); `routeWindow(caller)`. Summary `{tool, url: normalized}`; `routesUi: true`.
  `exec`: `routeWindow(caller)` → `ctx.ui(w, caller, {kind:'openUrl', url: normalized, focus: focus
  !== false})` → `keep`, `{opened: normalized}`.

### `src/conduit-mcp/tool-schemas.ts` — T1.4

Seven schemas appended in `TOOL_NAMES` order, built only from `type`, `properties`, `required`,
`enum`, `items`, `minItems`, `maxItems`, `maxLength`, `minimum`, `additionalProperties`,
`description` (no `oneOf` / `anyOf` / `allOf` / `$ref` / `const`) — B5:

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

`CONDUIT_INSTRUCTIONS`: re-grep its current text; where it scopes the control tools to "sessions,
terminals or files", that phrase becomes "act on Conduit's windows".

### `electron/conduit-mcp-host.ts` — T1.5

```ts
// ConduitMcpHostDeps (:119-166): the control Omit (:145) becomes
  control: Omit<ControlDeps, 'claimHandle' | 'now' | 'info' | 'agentIds' | 'targets' | 'ownerWindowOf' | 'windowReady'>;
// gains
  /** One window by id; main checks isDestroyed. */
  sendToWindow(windowId: number, msg: HostToWebview): void;
```

- `createControlHandlers` (`:678-689`): build one `controlDeps` object = today's spread plus
  `targets: () => listedSessions().map(({ session: s, handle }) => ({ sessionId: s.id, handle,
  openerSessionId: s.openedBy?.sessionId ?? null }))`, `ownerWindowOf: deps.ownerWindowOf`,
  `windowReady: (w) => deps.presence.isReady(w)`; `const control = createControlHandlers(controlDeps);
  const app = createAppControlHandlers(controlDeps, control.prepared);`.
- `createCallFlow` (`:702`) gains `sendToWindow: deps.sendToWindow`, `windowReady: (w) =>
  deps.presence.isReady(w)`.
- `callTool` (`:819`): `const ctx: ControlCallContext = { move: resolved.policy.move, reach:
  resolved.policy.reach, ui: (w, routed, action) => flow.requestUi({ inflight, callerSessionId:
  sessionId, routedSessionId: routed, windowId: w, action }) }`; `prepareControl` (`:860-874`) types
  `ctx: ControlCallContext` and gains seven cases → `app.prepareX(caller, args, ctx)`.
- `handleRenderer` (`:1424`) gains `case 'mcp:uiResult': flow.answerUi(m.requestId, senderId,
  m.result)` (no reply; a `false` is logged at debug).

### `electron/main.ts` — T1.6

```ts
// createConduitMcpHost({...}) (:1950); control: (:1989-2001) gains
  foldersOf: (id) => { const s = mgr.get(id); return s ? { home: s.home, roots: [...s.roots] } : undefined; },
  addRoot: (id, p) => sessionOps.addRoot(id, p),
  activateSession: (id, raise) => {
    const w = windowFor(id);
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send('to-webview', { type: 'activateSession', sessionId: id });
    if (raise) { if (process.env.CONDUIT_E2E !== '1') w.show(); w.focus(); }   // as moveSessionToWindow, :2283-2287
  },
  git: (cwd, args) => runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.metadata })
    .then((r) => ({ ok: r.ok, stdout: r.stdout, stderr: r.stderr })),
// deps gain
  sendToWindow: (wid, msg) => {
    const w = windows.get(wid);   // :382
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('to-webview', msg);
  },
// mcp:* case list (:4538-4548) gains 'mcp:uiResult'
```

`sessionOps` (`:2470`) is declared after the host (`:1950`); the closure reads it lazily, as
`createMcpSession` / `openMcpFile` already do.

### Renderer — T2.1–T2.4b

```ts
// webview/docs.ts (T2.1): the 'open' action (:123-134) and 'openReview' (:164) gain
  /** The session the window shows. A foreground open into another session lands active in
   *  that session's layout and leaves DocsState.activeId on the shown session. */
  shown?: string;
// openForeground (:342-377): finalize(…, touched, action.shown ?? s); openInBackground unchanged.

// webview/git-history-state.ts (T2.1)
// HistoryState gains
  /** A commit handed over by an MCP open; displayed and selectable at any depth. */
  revealed: CommitNode | null;      // initial null; 'request' keeps it; 'retarget' clears it
// HistoryAction gains
  | { type: 'reveal'; commit: CommitNode }   // → revealed = commit, selectedSha = commit.sha
// 'result': selectionAlive also when selectedSha === state.revealed?.sha
export function displayCommits(state: HistoryState): CommitNode[];
// = dedupeAndSortCommits([...state.commits, ...(query ? searchCommits : []), ...(revealed ? [revealed] : [])]);
//   state.commits as is when there is neither a query nor a revealed commit

// webview/history-reveal.ts (new, T2.1) — one slot, newest wins
export function requestHistoryReveal(sessionId: string, repoRoot: string, commit: CommitNode): void;
/** The pending commit when sessionId matches and folderKey(repoRoot) matches; clears the slot. */
export function takeHistoryReveal(sessionId: string | undefined, repoRoot: string | undefined): CommitNode | null;
export function subscribeHistoryReveal(cb: () => void): () => void;

// webview/mcp-ui.ts (new, T2.2)
export interface McpUiHandlers {
  hasSession(sessionId: string): boolean;
  /** sessionDirty([id]) (webview/app.tsx:547-549). */
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
export interface CloseFilesOps {
  kindOf(id: string): OpenDoc['kind'] | undefined;
  pathOf(id: string): string | undefined;
  isDirty(path: string): boolean;
  /** forceCloseDoc: closes everywhere, pushes the reopen stack. */
  forceClose(id: string): void;
  /** closeDoc's auto-save path without its confirm. */
  closeDirtyUnprompted(id: string): Promise<'closed' | 'needsPrompt'>;
}
export function runCloseFiles(plan: CloseFilesPlan, ops: CloseFilesOps): Promise<CloseFilesOutcome>;

// webview/file-open-request.ts (T2.4a): planFileOpen for source 'mcp' never activates
//   focus → { activate: false, showEditor: true, mode: 'preview' }   (was activate: true, :21-24)

// webview/app.tsx (T2.4a / T2.4b) — local, unexported
interface FileOpenNav { reveal?: CursorPos; record?: boolean; group?: GroupIndex;
  /** Open in targetSessionId without switching the shown session (MCP). */ keepActive?: true }
const openReviewIn: (sessionId: string, source: ReviewSource, group?: GroupIndex) => void;
const openGitHistoryIn: (sessionId: string, repoRoot?: string, reveal?: CommitNode) => void;
const closeDirtyUnprompted: (id: string) => Promise<'closed' | 'needsPrompt'>;
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

`runCloseFiles`: per group, an id whose `kindOf` is `file` and `isDirty(pathOf(id))` →
`closeDirtyUnprompted(id)`; every other id → `forceClose(id)`. A group's path is `closed` when every
id closed, else `skipped {reason:'unsaved'}`; `notOpen` → `skipped {reason:'not_open'}`. Entries
stop being recorded at `closed.length + skipped.length === MAX_CLOSE_RESULTS` (closing continues),
and the outcome then carries `truncated: true`. Never prompts.

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
// tools.description: one entry per new tool, the first sentence of its schema description
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
| Tool catalog rows (7) | `TOOL_NAMES` / `TOOL_SPECS` (T1.2) | gate, `tools/list`, `KNOWN_TOOLS`, Settings + session editors (data-driven by `TOOL_GROUPS` / `TOOL_SPECS`), `MCP_STR.tools.description` (T1.2) | Both; editors need no code change |
| New `ToolErrorCode`s | `types.ts` (T1.2) | `MCP_STR.errors` (T1.2), app-control-tools (T1.4), call flow (T1.3) | Both |
| `PreparedCall.routesUi` | `prepared()` from each check result (T1.3, set by T1.4's tools) | `flow.ask` timeout (T1.3) | Both |
| `mcp:ui` | `flow.requestUi` via `sendToWindow` (T1.3, T1.5, T1.6) | `useMcpUi` (T2.2) mounted in app (T2.4b) | Both. Between S1 and S2 no renderer answers: calls end `ui_timeout` (no e2e runs before S3) |
| `mcp:uiResult` | `useMcpUi` (T2.2) | main case (T1.6) → host (T1.5) → `flow.answerUi` (T1.3) | Both |
| Target lookup / reach | `listedSessions` (unchanged, host `:382-394`) → host `targets()` (T1.5); `ownerWindowOf` (Part A); `Session.openedBy` (unchanged producer, `src/session-manager.ts:129`) | `resolveTarget` / `inReach` / `recheckTarget` (T1.4) | Consumer; producers unchanged on purpose |
| `kill` from an MCP close | `useMcpUi` (T2.2) | main `case 'kill'` → `disposeSession` → `mcpHost.onSessionDeleted` | Producer only; the handler is the UI's own path |
| Self-close reply before the connection closes | renderer posts `mcp:uiResult` then `kill` in one turn (T2.2) | `onSessionDeleted` (`conduit-mcp-host.ts:1388-1393`) → `flow.sessionGone` → `drainConnectionsOf` (`:1088-1094`), which keeps a connection open while it still owes a reply | Both; pinned on the drain path by a host test (T1.5) and e2e (T3.2) |
| Routed session of a UI wait | `requestUi` meta (T1.3) | `sessionMoved` / `sessionGone` cancel (T1.3) | Both |
| `activateSession` + raise from `focus_session` | main `activateSession` dep (T1.6) | renderer handler `webview/app.tsx:707` (unchanged); window show/focus | Producer only: the handler already does exactly `setActiveId` |
| Folder attach | `sessionOps.addRoot` (unchanged) | app-control-tools exec (T1.4) | Consumer only; the tool maps reasons |
| Ref classification / commit lookup | `git-refs.ts` (T1.1) via main `git` dep (T1.6) | app-control-tools (T1.4) | Both |
| `PRETTY_FORMAT` export | `src/git-history.ts` (T1.1) | `git-refs.ts` (T1.1) | Both |
| `normalizeUrl` location | `src/web-url.ts` (T0.1) | `webview/components/web-prompt-modal.tsx:2`, `webview/components/web-view.tsx:4`, `webview/docs.ts:18` (`displayTitleForUrl`), `test/unit/web-url.test.ts:2`, app-control-tools (T1.4) | Both; grep proves no other importer |
| `DocsState.activeId` after a non-shown open | `openForeground` + `shown` (T2.1) | center pane / tab strip (read the shown session) | Both; fixes `openWeb`'s silent mis-point too |
| Review / History singleton owner | session-explicit opens with `sessionId: caller` (T2.4a) | `openForeground` transfer (`webview/docs.ts:351-357`) | Both; a split partner's open takes the singleton off the human's screen (B1, tested) |
| `open` / `openReview` dispatches | `openReviewIn`, `openGitHistoryIn`, `openWeb`, `openFile` (T2.4a) | docs reducer (T2.1) | Both. Other dispatchers (`openDiff`, `retargetGitHistory`, `reopenClosedTab`) omit `shown` ⇒ today's behaviour |
| History reveal | `openGitHistoryIn` → `requestHistoryReveal` (T2.4a, T2.1) | `GitHistoryView` with its `sessionId` prop (`webview/components/center-pane.tsx:303`) (T2.3) | Both |
| `planFileOpen` for `mcp` | `webview/file-open-request.ts` (T2.4a) | `flushOsOpens` (`webview/app.tsx:2700-2715`, T2.4a) | Both; the `os` branch unchanged |
| Act budget label | `control-tools.ts:238` (T1.4) | `rate_limited` message text | Both; `CHANGELOG.md` and `MCP_STR` don't quote it at `cd0d287e` (grep) |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/web-url.ts` | create (move) | `normalizeUrl`, `displayTitleForUrl` shared by host and renderer |
| `webview/web-url.ts` | delete | Moved |
| `src/conduit-mcp/git-refs.ts` | create | Ref classification, single-commit lookup, repo root of a folder |
| `src/conduit-mcp/app-control-tools.ts` | create | The seven tools' check/exec on the shared `prepared` pipeline |
| `webview/mcp-ui.ts` | create | `mcp:ui` subscription, answer posting, close-files planning and loop |
| `webview/history-reveal.ts` | create | One-slot (session, repo) hand-off of a commit to the history view |
| `test/unit/conduit-mcp-git-refs.test.ts`, `test/unit/conduit-mcp-app-control-tools.test.ts`, `test/unit/mcp-ui.test.ts`, `test/unit/history-reveal.test.ts` | create | Unit tests |
| `test/e2e/conduit-mcp-app-helpers.mjs` | create | Git fixture, local HTTP server, split/tab helpers |
| `test/e2e/conduit-mcp-app-sessions.e2e.mjs` | create | close/focus/attach, reach refusal, move:no, self close |
| `test/e2e/conduit-mcp-app-files.e2e.mjs` | create | close_files; open_file stays in the caller without switching |
| `test/e2e/conduit-mcp-app-git.e2e.mjs` | create | open_review / open_git_history incl. split-partner caller and deep commit |
| `test/e2e/conduit-mcp-app-web.e2e.mjs` | create | open_url foreground/background, bad_url |
| `src/git-history.ts` | modify | Export `PRETTY_FORMAT` |
| `src/conduit-mcp/types.ts` | modify | Nine error codes |
| `src/conduit-mcp/tool-policy.ts` | modify | Seven catalog rows (lists stay unexported) |
| `src/conduit-mcp/ui-types.ts` | modify | Header comment; UI action/result types; `MAX_CLOSE_RESULTS`; `AskSummary` variants |
| `src/protocol.ts` | modify | `mcp:ui`, `mcp:uiResult` |
| `src/conduit-mcp/call-flow.ts` | modify | UI waits, `requestUi`, `answerUi`, `UI_TIMEOUT_MS`, deps, UI-routed ask timeout |
| `src/conduit-mcp/control-tools.ts` | modify | `routesUi` (T1.3); `ControlTool` widened, shared helpers exported, `prepared` on handlers, `ControlCallContext`, deps, budget label (T1.4) |
| `src/conduit-mcp/tool-schemas.ts` | modify | Seven schemas; instructions line |
| `electron/conduit-mcp-host.ts` | modify | Control/app deps, flow deps, ctx, prepare cases, `mcp:uiResult` |
| `electron/main.ts` | modify | Control bindings, `sendToWindow`, `mcp:uiResult` case |
| `webview/conduit-mcp-strings.ts` | modify | Errors, descriptions, summaries, warning |
| `webview/docs.ts` | modify | `shown` on `open` / `openReview` |
| `webview/git-history-state.ts` | modify | `revealed`, `reveal`, `displayCommits` |
| `webview/components/git-history-view.tsx` | modify | Consume reveals; `searchable` from `displayCommits`; restore yields to a reveal |
| `webview/file-open-request.ts` | modify | MCP opens never activate |
| `webview/app.tsx` | modify | Session-explicit entries, `keepActive` (T2.4a); `closeDirtyUnprompted`, handler wiring, `useMcpUi` mount (T2.4b) |
| `webview/components/web-prompt-modal.tsx`, `webview/components/web-view.tsx` | modify | Import path |
| `test/unit/web-url.test.ts` | modify | Import path |
| Existing tests: `conduit-mcp-tool-policy.test.ts`, `conduit-mcp-call-flow.test.ts`, `conduit-mcp-control-tools.test.ts`, `conduit-mcp-host.test.ts`, `docs.test.ts`, `git-history-state.test.ts`, `file-open-request.test.ts`, `tool-policy-editor.test.tsx`, `settings-mcp-tools.test.tsx` | modify | New cases; any Part A assertion pinning the catalog's length or group membership, or the `'opens'` label, follows |
| `docs/specs/2026-10-30-conduit-mcp-app-control.md` | modify (done in planning) | §2.1 split partner, focus raise, history cites; §2.2 `--end-of-options`; §2.3 routing; §5 EARS 2 |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

One: the deep-history git fixture (600 commits, a branch, a tag) is generated with `git fast-import`
from a stream built in `test/e2e/conduit-mcp-app-helpers.mjs` (`gitFixture(dir, { commits })`), not
a commit loop — 600 `git commit` spawns would dominate the scenario's runtime on the Windows
runner. Everything else is single edits. Count: 1.

## Slices

Order: **S0 → S1 → S2 → S3.** S0 is independent and may run first.

**Shared-file serialization (exclusive claims):**
- `src/conduit-mcp/types.ts`, `src/conduit-mcp/tool-policy.ts`, `src/conduit-mcp/ui-types.ts`,
  `src/protocol.ts`, `webview/conduit-mcp-strings.ts`: T1.2.
- `src/conduit-mcp/call-flow.ts`: T1.3. `src/conduit-mcp/control-tools.ts`: T1.3 → T1.4.
  `src/conduit-mcp/tool-schemas.ts`: T1.4.
- `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts`: T1.5.
- `electron/main.ts`: T1.6.
- `webview/docs.ts`, `webview/git-history-state.ts`: T2.1. `webview/app.tsx`: T2.4a → T2.4b.
- `test/e2e/conduit-mcp-app-helpers.mjs`: T3.1. `CHANGELOG.md`: T3.6.

---

### Slice 0: Move `normalizeUrl` to `src/`

**Check:** `npx vitest run test/unit/web-url.test.ts` green; `git grep -n "webview/web-url\|from './web-url'\|from '../web-url'" -- webview src test` prints nothing; `npm run verify:quick` green.

**Parallel groups:** G1: T0.1

#### Task 0.1: Move the module

**Files:** Create `src/web-url.ts`; delete `webview/web-url.ts`; modify
`webview/components/web-prompt-modal.tsx:2`, `webview/components/web-view.tsx:4`,
`webview/docs.ts:18`, `test/unit/web-url.test.ts:2` (imports → `../../src/web-url` /
`../src/web-url`).

**Interfaces:** Produces `src/web-url.ts` (`normalizeUrl`, `displayTitleForUrl`). Consumes none.

**Steps:**
- [ ] Port carve-out: byte-identical bodies (`git diff -M --stat` shows a rename). The proof is
  `test/unit/web-url.test.ts` green unchanged except its import line, plus the slice Check.

---

### Slice 1: Host — catalog, git refs, UI waits, tool logic, wiring

**Check:**
- `npx vitest run test/unit/conduit-mcp-git-refs.test.ts test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-call-flow.test.ts test/unit/conduit-mcp-control-tools.test.ts test/unit/conduit-mcp-app-control-tools.test.ts test/unit/conduit-mcp-host.test.ts test/unit/conduit-mcp-json-rpc.test.ts test/unit/tool-policy-editor.test.tsx test/unit/settings-mcp-tools.test.tsx test/unit/mcp-tools-dialog.test.tsx test/unit/approval-card.test.tsx` green;
- both `tsc` projects green;
- `npm run verify:quick` green.

**Parallel groups:** G1: T1.1 · G2: T1.2 · then Serial: T1.3 → T1.4 → T1.5 → T1.6
**Claims (serial lane):** `src/conduit-mcp/types.ts`, `src/conduit-mcp/tool-policy.ts`, `src/conduit-mcp/ui-types.ts`, `src/protocol.ts`, `webview/conduit-mcp-strings.ts` (T1.2); `src/conduit-mcp/call-flow.ts` (T1.3); `src/conduit-mcp/control-tools.ts` (T1.3, T1.4); `src/conduit-mcp/tool-schemas.ts` (T1.4); `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts` (T1.5); `electron/main.ts` (T1.6)

#### Task 1.1: `git-refs.ts`

**Files:** Create `src/conduit-mcp/git-refs.ts`. Modify `src/git-history.ts:107` (`export const
PRETTY_FORMAT`). Test create `test/unit/conduit-mcp-git-refs.test.ts`.

**Interfaces:**
- Produces `GitRun`, `GitCall`, `MAX_REF_CHARS`, `classifyRef`, `lookupCommit`, `repoRootOf`
  (Contracts).
- Consumes `parseCommits(stdout: string): CommitNode[]` (`src/git-history.ts:200`), `RefEndpoint`
  (`src/git-range.ts:12`), `toolError`, `Result` (`src/conduit-mcp/types.ts`).

**Steps:**
- [ ] Record in the test file's header comment the git versions the argv was checked against: this
  machine `git version 2.42.0.windows.2`, and the CI runner's (run `git --version` in the S3 remote
  e2e log and add it there if newer/older). Every argv shape used (`rev-parse --symbolic-full-name
  <v>`, `rev-parse --verify --quiet <v>^{commit}`, `log -1 … --end-of-options <sha>`) works on
  git ≥ 2.24.
- [ ] Failing tests (a fake `GitCall` that records argv and answers from a table):
  - **'a leading "-" is bad_ref without running git'** — `classifyRef(git, '/r', '-x')` → `bad_ref`;
    recorded calls `[]`; same for `lookupCommit` with `'--output=/tmp/x'`;
  - 'rev-parse argv never carries --end-of-options; git log has it right before the sha';
  - 'branch / remote / tag / sha classification' — `refs/heads/main` → `{kind:'branch',
    ref:'main'}`; `refs/remotes/origin/main` → `{kind:'branch', ref:'origin/main', remote:true}`;
    `refs/tags/v1` → `{kind:'tag', ref:'v1'}`; empty stdout → `{kind:'commit', sha}`; `HEAD` →
    `{kind:'commit', sha}`;
  - 'ambiguous → bad_ref with git's first stderr line, ≤ 200 chars' (a 300-char line is cut);
  - 'not a commit → bad_ref' (verify step fails);
  - 'lookupCommit returns the parsed node' (stdout built with the real `PRETTY_FORMAT`
    separators) and `bad_ref` on an empty log;
  - 'repoRootOf forward-slashes and maps failure to not_a_repo';
  - 'length 0 or > 256 → invalid_args'.
- [ ] Run `npx vitest run test/unit/conduit-mcp-git-refs.test.ts` — FAIL (module missing).
- [ ] Implement; `test/unit/git-history.test.ts` stays green.

#### Task 1.2: Catalog rows, codes, wire types, strings

**Files:** Modify `src/conduit-mcp/tool-policy.ts` (`:12-13`, `TOOL_SPECS` `:94-120`),
`src/conduit-mcp/types.ts` (`ToolErrorCode`), `src/conduit-mcp/ui-types.ts` (header `:1-3`,
`AskSummary` `:20`, new types), `src/protocol.ts` (beside `mcp:ask` / `mcp:askAnswer`),
`webview/conduit-mcp-strings.ts` (errors, `tools.description`, `tools.onWarning`, `ask.summary`).
Tests: `test/unit/conduit-mcp-tool-policy.test.ts`, plus any Part A test pinning the catalog
(`tool-policy-editor.test.tsx`, `settings-mcp-tools.test.tsx`).

**Interfaces:**
- Produces the `tool-policy.ts`, `types.ts`, `ui-types.ts`, `protocol.ts` blocks and the `MCP_STR`
  keys (Contracts).
- Consumes `TOOL_SPECS`, `isValidField`, `coercePolicyLayer` (`tool-policy.ts`); `AskSummary`,
  `MCP_STR.ask.summary`; `RefEndpoint` (`src/git-range.ts:12`); `CommitNode` (`src/protocol.ts:267`).

**Steps:**
- [ ] Failing tests in `conduit-mcp-tool-policy.test.ts`:
  - 'Part B defaults match spec A §3.2' — `close_session` `{access:'ask', when:'viewing',
    reach:'window'}`; `focus_session` `{access:'on', when:'viewing', reach:'window', move:'yes'}`;
    `attach_folder` `{access:'ask', when:'viewing', reach:'self'}`; the four editor tools
    `{access:'on', when:'viewing'}`;
  - **'reach any only for focus and close'** — `isValidField('attach_folder','reach','any') ===
    false`; `isValidField('close_session','reach','any') === true`;
    `coercePolicyLayer({open_url:{reach:'self'}})` and `coercePolicyLayer({open_session:{reach:'self'}})`
    are `undefined`;
  - 'groups' — `TOOL_GROUPS` sessions = the five session tools; editor = the five editor tools.
- [ ] Run — FAIL. Implement; both `tsc` green.

#### Task 1.3: UI waits in the call flow

**Files:** Modify `src/conduit-mcp/call-flow.ts`; `src/conduit-mcp/control-tools.ts` (`PreparedCall`
`:63-69` gains `routesUi`; `prepared()` `:277-310` sets it). Test
`test/unit/conduit-mcp-call-flow.test.ts`.

**Interfaces:**
- Produces `UI_TIMEOUT_MS`, `CallFlowDeps.sendToWindow`, `CallFlowDeps.windowReady`,
  `CallFlow.requestUi`, `CallFlow.answerUi`, the UI-routed ask timeout, `PreparedCall.routesUi`
  (Contracts).
- Consumes `createWindowWaits<A, M>(deps)`, `pending()` (`src/conduit-mcp/window-waits.ts:39`);
  `McpUiAction`, `McpUiResult`, `MAX_CLOSE_RESULTS` (T1.2); `HostToWebview` `mcp:ui` (T1.2).

**Call sites:** `createCallFlow` — `electron/conduit-mcp-host.ts:702` (T1.5) and every
`createCallFlow(` in `test/unit/conduit-mcp-call-flow.test.ts` (add `sendToWindow`,
`windowReady`). `PreparedCall` literals in tests (`conduit-mcp-call-flow.test.ts`) gain
`routesUi: false`.

**Steps:**
- [ ] Failing tests (manual timers; `sendToWindow` recorder):
  - 'requestUi sends mcp:ui to the given window and resolves on its answer' — message
    `{type:'mcp:ui', requestId, sessionId: caller, action}` to window 2;
    `answerUi(id, 2, {kind:'opened'})` → `{ok:true, value:{kind:'opened'}}`;
  - **'an answer from another window is ignored'** — `answerUi(id, 1, …) === false`, still waiting;
  - **'a malformed answer is ignored'** — `{kind:'closeFiles'}` (no arrays) → `false`;
    `{kind:'closeSession', ok:false, unsaved: Array(21)}` → `false`; a closeFiles result with 501
    entries → `false`;
  - **'an unready window → window_not_ready, nothing sent, nothing pending'**;
  - **'a throwing sendToWindow → window_not_ready, nothing pending, no timer left'**;
  - '5 s → ui_timeout; a late answer → false';
  - 'windowReset(2) → window_not_ready'; 'sessionMoved(caller) → window_not_ready';
  - **'sessionGone(routed target ≠ caller) ends a closeSession wait'**;
  - **'notifications/cancelled ends the UI wait and runControl returns null'** — `run()` awaits
    `requestUi`; `cancelled(connId, requestId)`; result `null`; no timer pending;
  - 'connectionClosed ends UI waits'; 'recheck leaves UI waits alone'; 'dispose ends both';
  - **'a UI-routed ask waits ASK_TIMEOUT_MS[kind] − 5 s'** — kind `agent`, `routesUi: true`: expires
    at 20 000 ms, not 25 000; `routesUi: false` keeps 25 000.
- [ ] Run — FAIL. Implement; Part A's call-flow and control-tools tests stay green.

#### Task 1.4: Shared machinery, the seven tools, schemas

**Files:** Modify `src/conduit-mcp/control-tools.ts` (`ControlDeps` `:50-62`, `ControlCallContext`
`:70-72`, `ControlHandlers` `:73-89`, helpers `:91-120`, `ControlTool` `:234`, budgets `:237-240`,
`prepared` `:277-310`), `src/conduit-mcp/tool-schemas.ts`. Create
`src/conduit-mcp/app-control-tools.ts`. Tests: `test/unit/conduit-mcp-control-tools.test.ts`
(budget label, schema-keyword test), create `test/unit/conduit-mcp-app-control-tools.test.ts`.

**Interfaces:**
- Produces the `control-tools.ts` (T1.4 part), `app-control-tools.ts` and `tool-schemas.ts` blocks
  (Contracts).
- Consumes `classifyRef`, `lookupCommit`, `repoRootOf`, `GitCall` (T1.1); `McpUiAction`,
  `McpUiResult`, `CloseFilesOutcome`, `McpReviewSource`, `McpReviewScope`, `AskSummary` (T1.2);
  `PreparedCall.routesUi` (T1.3); `normalizeUrl` (`src/web-url.ts`, T0.1); `folderKey`
  (`src/folder-key.ts:4`); `SessionOpResult` (`src/session-ops.ts:14`); `windowNotReady`,
  `MESSAGING_TOOL_NAMES` (`src/conduit-mcp/tool-policy.ts`).

**Call sites:** `createControlHandlers` — `electron/conduit-mcp-host.ts:678` (T1.5) and the
control-tools test; `ControlDeps` main binding — `electron/main.ts:1989-2001` (T1.6);
`ControlCallContext` — host `:819`, `:864` (T1.5); `parseObject` / `fail` / `isFail` — internal
callers in `control-tools.ts` unchanged.

**Steps:**
- [ ] Failing tests in `conduit-mcp-app-control-tools.test.ts` (POSIX fakes; the real
  `createControlHandlers(deps).prepared`; `ctx.ui` a recorder answering from a table):
  - 'target by handle, then id; unlisted → unknown_session, token refunded';
  - **'reach'** — table over `self`/`opened`/`window`/`any` × {caller, opened-by-caller, same window,
    other window}: exactly the allowed cells pass; refusals are `out_of_reach`; the message never
    contains another session's handle or id;
  - **'move no refuses focus_session'** → `move_not_allowed`, refunded, `activateSession` not called;
  - **'every UI-routed tool refuses a null or unready window with window_not_ready'** (close_session
    on the target's window; close_files / open_review / open_git_history / open_url on the caller's);
  - **'run re-checks: target unlisted, out of reach, or its window gone between prepare and run'** —
    each → its code, `ctx.ui` not called, token refunded;
  - 'close_session to a target in another window routes to that window with routedSessionId =
    target'; 'unsaved → unsaved_changes listing the paths'; 'ok → {closed}';
  - 'focus_session raises only when the target's window differs from the caller's';
  - 'attach_folder resolves against the caller's home; is-home and duplicate succeed with roots
    unchanged; overlaps → attach_refused; not-found → path_missing';
  - 'close_files needs exactly one of paths/all; 51 paths → invalid_args; relative paths resolved';
  - 'open_review: working default scope all; commit via lookupCommit; range classifies base and
    head; head "working" allowed; base "working" → bad_ref; repo outside home/roots → not_a_repo;
    result source carries classified endpoints';
  - 'open_git_history without ref → selected null; with ref → the looked-up sha';
  - **'open_url: javascript:, file:, conduit-preview://t/x → bad_url; > 2048 bytes → invalid_args;
    localhost:5173 → http://localhost:5173/; focus defaults true'**;
  - 'routesUi is true for the five UI-routed tools only';
  - 'run failure refunds; success keeps' for one act and one show tool.
- [ ] Failing tests in `conduit-mcp-control-tools.test.ts`: 'the act budget says actions'
  (`more than 10 actions in a minute`); **'schemas use only the allowed keywords'** — walk every
  `toolSchemas([])` input schema; no key outside the Contracts list.
- [ ] Run both — FAIL. Implement; descriptions verbatim; Part A control-tools tests stay green.

#### Task 1.5: Host wiring

**Files:** Modify `electron/conduit-mcp-host.ts` (deps `:119-166`, Omit `:145`;
`createControlHandlers` `:678-689`; `createCallFlow` `:702`; `callTool` ctx `:819`; `prepareControl`
`:860-874`; `handleRenderer` `:1424`). Test `test/unit/conduit-mcp-host.test.ts`.

**Interfaces:**
- Produces `ConduitMcpHostDeps.sendToWindow`, the narrowed `control` Omit, `mcp:uiResult` handling
  (Contracts).
- Consumes T1.3 (`requestUi`, `answerUi`, deps), T1.4 (`createAppControlHandlers`, `prepared`,
  `ControlCallContext`, new `ControlDeps` members), Part A `ownerWindowOf`, `presence.isReady`,
  `listedSessions`.

**Call sites:** `createConduitMcpHost` — `electron/main.ts:1950` (T1.6) and the test harness in
`test/unit/conduit-mcp-host.test.ts`: add `sendToWindow` (recorder) and `control.foldersOf`,
`addRoot`, `activateSession`, `git` fakes.

**Steps:**
- [ ] Failing host tests:
  - **'targets are listed sessions only'** — a session with no handle is `unknown_session` by id
    (spec A7);
  - 'close_session end to end' — policy `{access:'on'}`; `mcp:ui` recorded to the target's window;
    `handleRenderer({type:'mcp:uiResult', requestId, result:{kind:'closeSession', ok:true}}, reply,
    w)` → result `{closed}`;
  - **'self close: the reply is written before the drained connection closes'** — the caller closes
    itself; deliver `mcp:uiResult` in one macrotask and `onSessionDeleted(caller)` in the next; the
    connection receives the reply line for that id and closes only after it (the
    `drainConnectionsOf` path, `:1088-1094`);
  - **'uiResult from a different window is ignored'** → after 5 s (manual timer) `ui_timeout`;
  - 'onWindowReset during a UI wait → window_not_ready'; **'onSessionMoved(target) during a
    close_session wait → window_not_ready'**;
  - **'notifications/cancelled during a UI wait → no reply line'**;
  - 'reach refusal at the host' — `close_session` with session policy `{reach:'self'}` on another
    session → `out_of_reach`, no `mcp:ui` sent;
  - **'an ask for a UI tool expires 5 s early'** (kind `agent`: 20 s);
  - 'tools/list lists the seven tools by default' (none default to `off`).
- [ ] Run — FAIL. Implement. Both `tsc` projects green except `electron/main.ts`'s host construction
  (closed in T1.6).

#### Task 1.6: Main bindings

**Files:** Modify `electron/main.ts`: `createConduitMcpHost({...})` (`:1950`) `control:`
(`:1989-2001`) and deps; `mcp:*` case list (`:4538-4548`) adds `'mcp:uiResult'`.

**Interfaces:** Consumes `ControlDeps.foldersOf/addRoot/activateSession/git` (T1.4),
`ConduitMcpHostDeps.sendToWindow` (T1.5), `runGit`, `GIT_TIMEOUT` (`src/git-exec.ts`, imported `:75`),
`sessionOps` (`:2470`), `windowFor`, `windows` (`:382`).

**Steps:**
- [ ] Wiring carve-out (no main unit harness): the red step is `tsc` naming the missing deps;
  implement exactly the Contracts block; both `tsc` projects green; run the slice Check. Runtime
  proof is S3.

---

### Slice 2: Renderer — session-explicit opens, `mcp:ui` handler, history reveal

**Check:**
- `npx vitest run test/unit/docs.test.ts test/unit/git-history-state.test.ts test/unit/history-reveal.test.ts test/unit/mcp-ui.test.ts test/unit/file-open-request.test.ts test/unit/monaco-class-collision.test.ts` green;
- both `tsc` projects green; `npm run verify:quick` green.

**Parallel groups:** G1: T2.1 · G2: T2.2 · then G3: T2.3 · then Serial: T2.4a → T2.4b
**Claims (serial lane):** `webview/docs.ts`, `webview/git-history-state.ts` (T2.1); `webview/app.tsx` (T2.4a, T2.4b)

#### Task 2.1: Reducer `shown`, history `reveal`, reveal store

**Files:** Modify `webview/docs.ts` (`DocsAction` `open` `:123-134`, `openReview` `:164`;
`openForeground` `:342-377`; the `open` case `:551` and `openReview` case `:661` pass
`action.shown`), `webview/git-history-state.ts`. Create `webview/history-reveal.ts`. Tests
`test/unit/docs.test.ts`, `test/unit/git-history-state.test.ts`, create
`test/unit/history-reveal.test.ts`.

**Interfaces:** Produces `shown?`, `HistoryState.revealed`, the `reveal` action, `displayCommits`, the
reveal store (Contracts). Consumes `dedupeAndSortCommits` (`src/git-search.ts`), `folderKey`.

**Steps:**
- [ ] Failing tests:
  - docs: **'a foreground open into a non-shown session keeps the shown cache'** — shown session A
    with an active file tab; `open` web for B with `shown: 'A'` → `state.activeId` is A's tab; B's
    layout has the web tab active in its target group; `layouts.A` unchanged;
  - docs: **'shown === sessionId behaves exactly like omitting it'** (deep-equal states for an `open`
    and an `openReview`);
  - docs: **'a split partner's openReview takes the Review singleton off the shown session'** —
    Review active in A; `openReview` for B with `shown: 'A'` → A's layout no longer holds
    `REVIEW_DOC_ID`, `state.activeId` is A's next active tab (or `null`), B holds Review active;
  - docs: 'omitting shown keeps today's behaviour' (existing open tests unchanged);
  - history: 'reveal selects and displays a commit outside the loaded set'; 'a refresh result keeps a
    revealed selection'; 'retarget clears revealed';
  - reveal store: 'take returns the commit once for the same session and repo (folderKey)';
    **'a different session or repo gets null and leaves the slot'**; 'newest request wins';
    'subscribers are notified'.
- [ ] Run — FAIL. Implement.

#### Task 2.2: `webview/mcp-ui.ts`

**Files:** Create `webview/mcp-ui.ts`. Test create `test/unit/mcp-ui.test.ts`.

**Interfaces:** Produces `McpUiHandlers`, `useMcpUi`, `CloseFilesPlan`, `planCloseFiles`,
`CloseFilesOps`, `runCloseFiles` (Contracts). Consumes `subscribe`, `post` (`webview/bridge.ts`);
`canonicalPath` (`src/canonical-path.ts:15`); `McpUiAction`, `McpUiResult`, `CloseFilesOutcome`,
`MAX_CLOSE_RESULTS`, `McpReviewSource` (T1.2); `OpenDoc` (`webview/docs.ts`).

**Steps:**
- [ ] Failing tests (bridge mocked, fake handlers and ops):
  - **'closeSession clean posts the result before kill'** — recorded order
    `['post:mcp:uiResult', 'kill:B']`;
  - 'closeSession dirty posts unsaved (≤ 20) and never kills';
  - 'unknown session → unknownSession, no handler called';
  - 'closeFiles posts the awaited outcome'; 'open kinds call their handler and post opened';
  - planCloseFiles: 'file and diff tabs of the session match; other sessions' docs never'; 'unopened
    path → notOpen'; 'all groups every doc by path including @review'; 'a requested path given twice
    is planned once';
  - runCloseFiles: 'clean ids force-close'; **'a dirty file needing a prompt is skipped unsaved, its
    diff tab still closes'**; 'an auto-save close counts as closed'; **'more than 500 entries →
    truncated, every doc still closed'**.
- [ ] Run — FAIL. Implement.

#### Task 2.3: History view consumes reveals

**Files:** Modify `webview/components/git-history-view.tsx` (`searchable` `:406-412` →
`displayCommits(state)`; a `useLayoutEffect` after the restore effect `:460-499` that on mount and on
`subscribeHistoryReveal` notify calls `takeHistoryReveal(sessionId, repoRoot)` with its props and
dispatches `reveal`; the restore's `select` is skipped when a reveal was taken).

**Interfaces:** Consumes `displayCommits`, `reveal`, `takeHistoryReveal`, `subscribeHistoryReveal`
(T2.1).

**Steps:**
- [ ] Wiring carve-out: no new unit test; the state logic is pinned by T2.1's cases, the view wiring
  by T3.4 phase 4. `tsc` green.

#### Task 2.4a: App — session-explicit entry points

**Files:** Modify `webview/app.tsx`, `webview/file-open-request.ts` (`:21-24`). Test
`test/unit/file-open-request.test.ts`.

**Interfaces:** Produces `openReviewIn`, `openGitHistoryIn`, `FileOpenNav.keepActive` (Contracts).
Consumes `shown`, `requestHistoryReveal` (T2.1).

**Edits (exact; line numbers at `cd0d287e`):**
- `FileOpenNav` (`:322-326`) gains `keepActive?: true`. In `openFile` (`:2390`): when
  `nav?.keepActive`, skip the `setActiveId` / `switchSession` branch (`:2419-2422`), pass `shown:
  activeIdRef.current ?? ''` on the `open` dispatch, and run `recordNav` and `revealInTree` only
  when `effectiveSessionId === activeIdRef.current`.
- `flushOsOpens` (`:2700-2715`): for `req.source === 'mcp'`, `if (p.showEditor && req.sessionId ===
  activeIdRef.current) setCenterView('editor')`; call `openFile(req.path, req.sessionId, p.mode, {
  ...(p.reveal ? { reveal: p.reveal } : {}), keepActive: true })`. The `os` branch is unchanged.
- `openReviewIn(sessionId, source, group?)`: the body of today's `openReviewScoped` (`:930-942`) with
  `sessionId` as a parameter, `group ?? openTargetGroup(docStateRef.current, sessionId)`, `shown:
  activeIdRef.current ?? ''`, its view side effects only when `sessionId === activeIdRef.current`.
  `openReviewScoped(scope, repoRoot?, group?)` becomes `openReviewIn(activeIdRef.current ?? '',
  workingSource(scope, repoRoot), group)`. `setReviewSource`'s range branch (`:993-1000`) calls
  `openReviewIn(activeIdRef.current ?? '', s)`.
- `openGitHistoryIn(sessionId, repoRoot?, reveal?)`: the body of `openGitHistoryTab` (`:1010-1024`)
  with `sessionId` as a parameter, `shown`, `recordNav` + `setCenterView('editor')` only when
  `sessionId === activeIdRef.current`; when `reveal` is given, `requestHistoryReveal(sessionId,
  repoRoot, reveal)` **before** the dispatch. `openGitHistoryTab(repoRoot?)` becomes
  `openGitHistoryIn(activeIdRef.current ?? '', repoRoot)`.
- `openWeb` (`:2509`): add `shown: activeIdRef.current ?? ''` to both dispatches (`:2515`, `:2519`).
  Signature unchanged.

**Call sites (signature changes):**
- `openFile` — signature unchanged (`FileOpenNav` gained an optional field); only `flushOsOpens`
  passes `keepActive`.
- `openReviewScoped` — unchanged signature; callers `:944` (`openReviewTab`), `:990`
  (`setReviewSource` working), the right-pane `onReviewScope={openReviewScoped}` (re-grep, ~`:4644`)
  unchanged.
- `openReviewForCommit` — untouched (UI commit links keep activating their session); callers `:991`,
  `:4472`, `:4489` unchanged.
- `openGitHistoryTab` — unchanged signature; callers `:1363`, `:3885`, `:4621` unchanged.
- `openWeb` — unchanged signature; callers `:2536`, `:4468`, `:4733` unchanged; new MCP caller
  (T2.4b).
- `setActiveId` — no new caller.

**Steps:**
- [ ] Failing test in `file-open-request.test.ts`: 'a focused MCP open never activates' —
  `planFileOpen({source:'mcp', focus:true, …})` → `activate === false`, `showEditor === true`,
  `mode === 'preview'`.
- [ ] Run — FAIL. Implement the edits; app wiring is proven by S3 (no app-level unit harness).

#### Task 2.4b: App — close paths and `useMcpUi` mount

**Files:** Modify `webview/app.tsx`.

**Interfaces:** Produces `closeDirtyUnprompted`. Consumes `useMcpUi`, `planCloseFiles`,
`runCloseFiles`, `McpUiHandlers`, `CloseFilesOps` (T2.2); `openReviewIn`, `openGitHistoryIn`
(T2.4a); `dirtyCloseStep` / `afterCloseSave` (`webview/auto-save-policy.ts:186`, `:198`);
`sessionDirty` (`:547-549`); `forceCloseDoc` (`:2186`).

**Edits (exact):**
- `closeDoc` (`:2205`): extract its dirty branch into `closeDirtyUnprompted(id): Promise<'closed' |
  'needsPrompt'>` (the `dirtyCloseStep` → `close` / `save` + `afterCloseSave` path, `:2241-2263`);
  `closeDoc` shows its confirm on `'needsPrompt'` exactly as today.
- Mount `useMcpUi({ hasSession: (id) => sessionsRef.current.some((s) => s.id === id),
  dirtyPathsOf: (id) => sessionDirty([id]), kill: (id) => post({ type: 'kill', id }), closeFiles:
  (id, target) => runCloseFiles(planCloseFiles(docStateRef.current.docs, id, target), { kindOf:
  (d) => docStateRef.current.docs.find((x) => x.id === d)?.kind, pathOf: (d) =>
  docStateRef.current.docs.find((x) => x.id === d)?.path, isDirty: (p) => getDirtySnapshot().has(p),
  forceClose: forceCloseDoc, closeDirtyUnprompted }), openReview: (id, src) => openReviewIn(id,
  src), openGitHistory: (id, root, c) => openGitHistoryIn(id, root, c ?? undefined), openUrl: (id,
  url, focus) => openWeb(url, id, focus ? undefined : 'background') })` beside the other bridge
  subscriptions.

**Call sites:** `closeDoc` — unchanged signature; caller `:2273` unchanged. `closeTabsByUser`
(`:1406`, `:3051`, `:4449`) and `requestKill` (`:2993`, `:3206`, `:3991`, sidebar `onKill`) untouched.
`sessionOps.addRoot` (`src/session-ops.ts:66`) untouched; new caller via main (T1.6).
`activateSession` handler (`:707`) untouched; new producer via main (T1.6).

**Steps:**
- [ ] Wiring carve-out: the loop's logic is T2.2's tested `runCloseFiles`; `closeDoc`'s existing tests
  and the slice Check stay green; runtime proof is T3.3.

---

### Slice 3: E2E + changelog

**Check (end of feature, once):** `npm run verify` green; `npm run e2e:remote --
conduit-mcp-app-sessions conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web
conduit-mcp-policy conduit-mcp-control` green; `npm run e2e:remote` (`--affected`) green. During the
slice: `node --check <file>` for each `.mjs`, and `npm run verify:quick`.

**Parallel groups:** Serial first: T3.1 · then G1: T3.2 · G2: T3.3 · G3: T3.4 · G4: T3.5 · G5: T3.6
**Claims (serial lane):** `test/e2e/conduit-mcp-app-helpers.mjs` (T3.1); `CHANGELOG.md` (T3.6)

All scenarios: `runScenario('<name>', fn, { userDataDir: fakeAgentProfile('<name>') })`, fakes via
`openFake`, calls via `callTool` / `startCall` + `resultAfter` + `clickAskAnswer` +
`setSessionPolicy` (`test/e2e/conduit-mcp-helpers.mjs`), `activeSessionId(page)`, cleanup by `kill`
posts as `conduit-mcp-control.e2e.mjs` does.

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
2. **move:no** — click A; `setSessionPolicy(A,'focus_session',{move:'no'})`; call → `move_not_allowed`;
   after 1 s active still A.
3. **reach refusal** — `setSessionPolicy(A,'close_session',{access:'on', reach:'self'})`;
   `close_session({session: B.handle})` → `out_of_reach`; B still listed; then `reach:'opened'` with
   D opened by A via `open_session` → ok for D, `out_of_reach` for C.
4. **unknown** — `close_session({session:'nope-9'})` → `unknown_session`.
5. **attach (ask)** — default policy; `startCall(A,'attach_folder',{path:'sub'})`; `.askcard` names A
   and `attach_folder`; `clickAskAnswer('approve')` → `roots` contains `sub`'s path; repeat call → ok,
   `roots` unchanged.
6. **close dirty** — open `fixture.txt` in C via C's own `open_file` (C active), make it dirty (type
   into Monaco, auto-save off via settings); click A; A `close_session({session: C.handle})` →
   `unsaved_changes` naming `fixture.txt`; C still exists.
7. **close clean** — revert C's buffer; call → `{closed: C}`; C gone within 5 s.
8. **self close** — A `close_session({session: A.handle})` → RESULT `{closed: A}` recorded; A gone.
9. **cleanup.**

#### Task 3.3: `conduit-mcp-app-files`

**Files:** Create `test/e2e/conduit-mcp-app-files.e2e.mjs`.

**Phases** (A active):
1. **open_file stays put** — `splitWith(page, B.name)`; B `open_file({path:'a.txt'})` → ok; active
   still A; split bar still B; `shownTabs` has no `a.txt`; click B → `a.txt` tab shown.
2. **close_files clean** — A opens `a.txt`, `b.txt`; `close_files({paths:['a.txt','missing.txt']})` →
   `closed` = [a], `skipped` = [{missing, not_open}]; `a.txt` tab gone; reopen-closed-tab shortcut
   brings `a.txt` back.
3. **close_files dirty, auto-save off** — dirty `b.txt` → `skipped` [{b, unsaved}]; tab still open, no
   dialog (`.modal` absent).
4. **close_files dirty, auto-save on** — set auto-save on; dirty `b.txt` → `closed` [b]; file on disk
   has the typed text.
5. **all** — open Review in A (`open_review` working) and `a.txt`; `close_files({all:true})` → no tabs
   left in A, `closed` includes `@review`.
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
4. **deep commit** — `open_git_history({ref: shas[0]})` (beyond the 500-commit page,
   `src/git-history.ts:40`) → `selected === shas[0]`; the `History` tab is active and its detail pane
   shows subject `c1`.
5. **split partner** — B in the same repo; Review active in A; `splitWith(page, B.name)`; B
   `open_review(working)` → ok; active still A, split still B; A's tab strip no longer has
   `Review Changes` (the singleton moved, B1); click B → `Review Changes` is B's active tab.
6. **cleanup.**

#### Task 3.5: `conduit-mcp-app-web`

**Files:** Create `test/e2e/conduit-mcp-app-web.e2e.mjs`.

**Phases:** `httpFixture()`:
1. **foreground** — `open_url({url})` → `{opened}` equals the normalised URL; a web tab is active in A.
2. **background** — `open_url({url: url + 'x', focus:false})` → ok; the active tab is unchanged; the
   new tab exists.
3. **bad_url** — `javascript:alert(1)`, `file:///c:/x`, `conduit-preview://t/x` → `bad_url`; no new
   tab (the tab count is the assertion; an OS-browser launch isn't observable).
4. **cleanup** — `close()` the server.

#### Task 3.6: CHANGELOG

**Files:** Modify `CHANGELOG.md` (`## [Unreleased]`). One `### Added` entry: seven agent tools —
close or focus a session, attach a folder, close files, open Review, open the commit history at a
ref, open a URL in a Conduit tab — each with its own policy (`close_session` and `attach_folder` ask
by default). One `### Changed` entry: an agent's `open_file` and every new open land in the agent's
own session and never switch the session you're looking at; a Review or History opened by a
split-screen agent moves to that agent's session.

## Verification

- **Per task:** named vitest file(s) red then green; both `tsc` projects (T1.5 may be red only at
  `electron/main.ts`'s host construction, closed by T1.6).
- **Per slice:** the slice's Check, ending in `npm run verify:quick`.
- **Once, after S3:** `npm run verify`; `npm run e2e:remote -- conduit-mcp-app-sessions
  conduit-mcp-app-files conduit-mcp-app-git conduit-mcp-app-web conduit-mcp-policy
  conduit-mcp-control`; `npm run e2e:remote` (`--affected`). A local failure is confirmed remotely
  before bisecting.
- At most one local e2e by exact name. Exit codes captured directly, never through a pipe.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality (including Part A code that differs from what this plan cites) — that task
**stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special
case, widened type, fallback, or an override patched in place of its semantic source. The report
leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **B1:** The split partner has no editor pane (only its terminal), so "the tab opens in that
  pane" can't be met literally. Default taken: the tab opens active in the caller's own layout;
  active and split stay unchanged; the human sees it on activating that session. A Review/History
  singleton opened by a split partner leaves the human's screen (documented, tested).
- [high] **B2:** `close_session`'s dirty check must run where the target's docs live. Default taken:
  `closeSession` goes to the **target's** owner window; its readiness is checked at prepare and
  again at run.
- [normal] **B3:** `attach_folder` reason mapping: `is-home` / `duplicate` → success, roots unchanged;
  `not-found` → `path_missing`; `not-a-directory` → `not_a_directory`; `invalid-path` →
  `invalid_args`; the rest → new code `attach_refused`.
- [normal] **B4:** Window reset/close/move after `mcp:ui` was sent → `window_not_ready` with "the
  outcome is unknown"; CLI cancel / connection close → no reply; late reply → dropped.
- [normal] **B5:** Per-CLI schema acceptance not measured. Default: flat schemas with no
  `oneOf`/`anyOf`/`allOf`/`$ref`/`const`, pinned by a unit test; combinations validated host-side.
- [normal] **B6:** `repo` resolves to the git toplevel of the home or a root; a home outside any repo
  → `not_a_repo` (the UI's active-repo fallback isn't used).
- [normal] **B7:** Every classified ref is also verified as `^{commit}` (a tag on a tree is
  `bad_ref`). `rev-parse` gets no `--end-of-options` (r1); the `-` guard covers it.
- [normal] **B8:** `close_files` with `all:true` reports each closed doc's path, including `@review` /
  `@git-history` and web URLs; results cap at 500 with `truncated: true`. A diff tab of a dirty path
  closes; the path is reported `unsaved` because its file tab stayed.
- [normal] **B9:** `unsaved_changes` carries its ≤ 20 paths in the message (`ToolError` has no data
  field).
- [normal] **B10:** `ui_timeout` is not retryable: the outcome is unknown and a retry could act twice.
- [normal] **B11:** A UI-routed tool's ask waits `ASK_TIMEOUT_MS[kind] − 5 s` (agent/opencode 20 s,
  codex/cursor 45 s, claude 115 s), so ask + UI wait fits the CLI's own timeout.
- [normal] **B12:** `focus_session` into another window raises and focuses that window (as a moved
  session does); within the caller's window nothing is raised.
