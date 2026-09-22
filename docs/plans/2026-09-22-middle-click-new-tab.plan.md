# Middle-click opens in a new background tab — implementation plan

**Spec:** `docs/specs/2026-09-22-middle-click-new-tab.md` (87c8b99, amended with this plan)  **Tier:** FULL

Tier reason: a new public contract (`OpenMode 'background'`) crossing ~20 files, a new host→renderer
message (S14), and parallel executors intended.

## Goal

Middle-click on every file/link surface in the spec's §9 (S1–S14) opens its target as a pinned tab
without activating it, with a tab cue and a polite announcement, and without moving focus, the
center view, the explorer selection, or any scroll position.

## Architecture

One pure reducer branch (`mode: 'background'` in `docs.ts`) does the tab bookkeeping. Every
opener in `app.tsx` takes the mode and, in background mode, skips its activation side effects and
reports the pre-dispatch outcome to one feedback hook (flash + status region). Surfaces reach the
openers through a single helper (`webview/middle-click.ts`); the two paths that aren't React
events (xterm `activate`, the web-view guest) use `isMiddleButton` and a host-routed message.

## Data flow

```
 surface item (React)                       xterm link activate            web-view guest <a> (middle)
  mousedown b1 → preventDefault               event.button → terminal-       Chromium → guest setWindowOpenHandler
  auxclick  b1 → preventDefault+stop          LinkMiddleAction()             (main.ts:3748) disposition 'background-tab'
        │ middleClickProps(onMiddle)                 │                             │ webGuestOpenRoute() = 'in-app-background'
        ▼                                            ▼                             ▼ sendToGuestHost → 'web:openBackgroundTab'
  onOpenFile(p,'background') / onOpenDiff /   onOpenFile(p,l,c,sid,'background')  WebView (guestId match) → onOpenInBackground(url)
  onOpenMatch / onJumpToHunk / commit file           │                             │
        └──────────────────────┬─────────────────────┴─────────────────────────────┘
                               ▼
  app.tsx opener(…, mode='background')
    1. r = backgroundOpenOutcome(docStateRef.current, kind, path, targetSession)   ← pre-dispatch
    2. stage reveal only if r.id !== docStateRef.current.activeId
    3. post readFile/readDiff, dispatchDocs({type:'open', …, mode:'background'}), pushRecent, indexProjectOnce
       (NO setActiveId/switchSession, NO setCenterView, NO revealInTree, NO nav record)
    4. feedback.report({ id, title, outcome, sessionName })
                               ▼
  docsReducer: append pinned / clear preview in place / no-op — activeId & activeBySession untouched
  useBackgroundOpenFeedback: flashTabId (600 ms) → DocTabs `tab--flash` (or chevron if clipped)
                             statusRef text cleared, then set on next frame
```

## Settled decisions — do not re-litigate

- L1–L6 as locked in the spec header.
- **D1 overruled (conductor):** a web-view guest middle-click (`disposition: 'background-tab'`)
  opens the URL as a background in-app web tab (S14). Every other disposition, including left-click
  on `target=_blank`, keeps going to the system browser. HTML-preview guests are untouched.
- D2 cross-session: the tab lands in the owning session's strip, no switch, suffix " in ‹name›".
- D3 Linux: terminal links ignore button 1. D4 terminal commit links: foreground, as left-click.
- D5 palette stays open on a middle-click.
- `openCommitFile`'s `pin: boolean` becomes `mode: OpenMode` end to end (spec §3).
- New background tabs append at the strip end (A1). A background open counts as a recent (A2).
- The explorer's existing middle-click changes from foreground to background (A3).

Plan-level decisions (no spec input needed):
- `backgroundOpenOutcome` also returns the post-dispatch `id` and the `title`, so the opener has
  everything the feedback needs from one pre-dispatch read.
- Feedback lives in a hook, not inline in `app.tsx`, because `app.tsx` is being rewritten by two
  other branches and the hook is independently testable.
- The explorer folder rows, non-name-only search heads and non-file palette rows use
  `middleClickProps(null)`: mousedown suppressed, auxclick swallowed, no action.
- Unit adapter tests (jsdom) cover the leaf components that render standalone with plain props:
  SearchPane, DiffViewer (oversize notice), BreadcrumbBar/ContextMenu, CommandPalette, CommitView,
  DocTabs. RightPane, ReviewView, MarkdownViewer, TerminalPane, CenterPane, DocView and WebView
  pull in Monaco/xterm/`<webview>`/host state and are proven by the e2e scenarios instead, which
  assert the resulting tab is a background tab (a dropped mode yields an active tab, so the
  assertion fails). This replaces the spec's "a unit test on each adapter" for those seven.
- S14 routing is a pure function in `src/webview-guard.ts` (Electron-free, already home of
  `isHttpUrl`), called only from the **non-preview** branch of the existing guest handler. The
  preview branch is not edited.

## Spec staleness

- Spec §3 reveal rule: "the active doc or the split doc (`center-pane.tsx:357`)". Measured: no
  doc split exists; `center-pane.tsx` renders one `DocView` for `activeDoc`, and `splitId`
  (`center-pane.tsx:245`) is a **session** split. The plan's rule is `id !== activeId`. Amended
  in the spec in the same commit.
- Spec §3 said the reducer gets no `web` background branch. Superseded by the D1 ruling; the
  generic branch covers `web`. Amended.
- `feat/nav-history` and `feat/unstaged-diff` currently carry only spec+plan (and, for
  unstaged-diff, host/protocol code) — their `app.tsx`/`docs.ts` rewrites are **not yet on any
  branch**. All line numbers below are current `main` (13e0681); Slice 0 re-anchors them.

## Global constraints

- Gate: `npm run verify` (format-check, lint, dead-code, duplication, typecheck both tsconfigs,
  unit tests, security). Never narrow, skip or defer any part of it.
- Node: `^22.22.2 || ^24.15.0 || >=26.0.0` (`package.json` engines). Unit tests: vitest,
  `test/unit/**/*.test.ts`, default env `node`; a React test opts in with the first line
  `// @vitest-environment jsdom` and renders with `createRoot` + `act` (see
  `test/unit/popover.test.ts`).
- E2E: `npm run build` first, then `node test/e2e/run-smoke.mjs <filter>`; scenarios run hidden and
  **serially**, each must finish well under the runner's 210 s per-scenario timeout (budget ≤120 s).
  Launch via `launchApp`, end via `closeApp` (`test/e2e/harness.mjs`); host spies via `spyMain(app,
  [{ api: 'openExternal' }])` + `getSpyCalls`. Fixture repos: `mkdtempSync(join(tmpdir(), …))` +
  `execFileSync('git', …)`, as `test/e2e/review-scope.e2e.mjs:110` does. Never kill processes by name.
- Naming: files kebab-case; hooks `use-*.ts` exporting `useX`; string tables `SCREAMING_CASE`
  const objects of functions (pattern: `HTML_VIEWER_STRINGS`, `html-viewer.tsx:37`).
- Comments: WHY only; point at the spec (`// spec 2026-09-22-middle-click §3`) rather than
  restating it. No redundant comments (CLAUDE.md hard rule).
- Styling: tokens only, no raw hex; honour both `prefers-reduced-motion` and
  `:root[data-reduce-motion="true"]` (`styles.css:1991`); forced-colors uses `Highlight`.
- Security: nothing renderer-side is load-bearing for S14. The host decides what is forwarded
  (http(s) only, non-preview guests only); `will-attach-webview` still refuses any non-http(s) src.
- Export only what another module imports within the same slice: the `fallow` dead-code check in
  `verify` fails an unused export. Types used only inside their module (`BackgroundOpenReport`,
  `BackgroundOpenFeedback`, `WebGuestOpenRoute`, `MiddleClickProps`) stay unexported unless an importer
  exists; `TAB_FLASH_MS` stays module-private and the tests use 600.
- `CHANGELOG.md` is **not** touched by this build (the conductor owns it).

## Out of scope

Keyboard equivalent (L6); middle-click inside Monaco (L4); singleton openers (Review, History,
"Review commit"); doc-tabs overflow "Open editors" list; Settings About link; "Open externally"
buttons; HTML-preview guest links; Milkdown plan docs; right-click menu commands; toast actions;
review nav list, markdown TOC, architecture/board navigation (spec §9 "Excluded").

## Contracts

### `webview/docs.ts`

```ts
export type OpenMode = 'preview' | 'permanent' | 'background';
export type BackgroundOutcome = 'opened' | 'pinned' | 'already-open';
export interface BackgroundOpenResult {
  outcome: BackgroundOutcome;
  /** The session whose strip holds the tab after the open (existing owner, or the target). */
  ownerSessionId: string;
  /** The doc id after the dispatch (a commit-diff preview slot re-keys to its pinned id). */
  id: string;
  title: string;
}
export function backgroundOpenOutcome(
  state: DocsState, kind: DocKind, path: string, targetSessionId: string,
): BackgroundOpenResult;

// DocsAction change:
| { type: 'openCommitFile'; sha: string; file: string; sessionId: string; mode: OpenMode }
// openHistoryDoc(state, kind: 'commit-diff', path, title, sessionId, mode: OpenMode): DocsState
```

Reducer invariants for `mode: 'background'` (both `open` and `openHistoryDoc`):
- the returned `activeId` and `activeBySession` are the **same references** as the input's;
- an existing id keeps its array index and `sessionId`; only `preview` is cleared;
- a new id is appended as `{ …, sessionId: target, preview: false }` (no `preview` key set true);
- commit-diff: pinned id exists → state unchanged (same object); preview slot's `path === path` →
  re-key that slot to the pinned id in place and repoint every `activeBySession` value equal to
  `previewId('commit-diff')` to the pinned id — **this is the one case where `activeBySession`
  gets a new object** (and `activeId` too, if it was the preview id); otherwise append pinned.
  AC-12's "referentially unchanged" applies to the other cases; the test asserts the re-key case
  explicitly instead.
- `sideBySide` from the action is applied exactly as foreground does.

`backgroundOpenOutcome`: `id = idOf(kind, path)` (the same `idOf` the reducer uses — after the unstaged-diff rebase it must take the same `diffScope`
argument the reducer's `open` passes). Outcome: doc with `id` exists and `preview` → `'pinned'`;
exists and not preview → `'already-open'`; commit-diff preview slot with `path === path` →
`'pinned'`; else `'opened'`. `ownerSessionId` = the existing doc's `sessionId`, else
`targetSessionId`. `title` = existing doc's title, else `initialTitle(kind, path)`.

### `webview/middle-click.ts` (new)

```ts
import type { MouseEventHandler } from 'react';
import type { BackgroundOutcome } from './docs';

export function isMiddleButton(e: { button: number }): boolean;          // button === 1
export function suppressMiddleMouseDown(e: { button: number; preventDefault(): void }): void;
export interface MiddleClickProps<T extends Element = Element> {
  onMouseDown: MouseEventHandler<T>;
  onAuxClick: MouseEventHandler<T>;
}
/** `onMiddle: null` = suppress the gesture on a non-target item (folder, collapse head). */
export function middleClickProps<T extends Element = Element>(
  onMiddle: (() => void) | null,
  onMouseDown?: MouseEventHandler<T>,
): MiddleClickProps<T>;
export type TerminalLinkMiddleAction = 'foreground' | 'background' | 'ignore';
/** `platform` is `navigator.platform`; /linux/i → middle is paste (D3). */
export function terminalLinkMiddleAction(button: number, platform: string): TerminalLinkMiddleAction;
export const MIDDLE_CLICK_STRINGS: {
  opened: (title: string) => string;            // "Opened ‹title› in a background tab"
  openedIn: (title: string, session: string) => string;   // "… in a background tab in ‹session›"
  pinned: (title: string) => string;            // "Pinned ‹title›"
  pinnedIn: (title: string, session: string) => string;
  alreadyOpen: (title: string) => string;       // "‹title› is already open"
  alreadyOpenIn: (title: string, session: string) => string;
};
export function backgroundOpenAnnouncement(
  outcome: BackgroundOutcome, title: string, sessionName: string | null,
): string;
```

`middleClickProps` behaviour: `onMouseDown(e)` → call the consumer's `onMouseDown?.(e)` first,
unconditionally, then `suppressMiddleMouseDown(e)`; never `stopPropagation` on mousedown (the
context menu's outside-click dismissal needs it). `onAuxClick(e)` → if `button !== 1` return;
`preventDefault()`, `stopPropagation()`, then `onMiddle?.()`. Never calls `focus()`.
`terminalLinkMiddleAction`: 0 → `'foreground'`; 1 → linux ? `'ignore'` : `'background'`; else `'ignore'`.

### `webview/use-background-open-feedback.ts` (new)

```ts
import type { RefObject } from 'react';
import type { BackgroundOutcome } from './docs';
const TAB_FLASH_MS = 600;   // module-private
export interface BackgroundOpenReport {
  id: string; title: string; outcome: BackgroundOutcome; sessionName: string | null;
}
export interface BackgroundOpenFeedback {
  flashTabId: string | null;
  statusRef: RefObject<HTMLDivElement | null>;
  report: (r: BackgroundOpenReport) => void;
}
export function useBackgroundOpenFeedback(): BackgroundOpenFeedback;
```

`report`: sets `flashTabId = r.id` and (re)starts one timer that clears it after `TAB_FLASH_MS`;
sets `statusRef.current.textContent = ''`, then on the next `requestAnimationFrame` sets it to
`backgroundOpenAnnouncement(r.outcome, r.title, r.sessionName)`. A pending frame from an earlier
report is cancelled. Unmount clears the timer and the frame. `report` is stable (`useCallback`, []).

### `webview/project-index.ts`

```ts
export function clearReveal(path: string): void;   // reveals.delete(key(path)); no subscriber call
```

### `webview/app.tsx` openers (current-main signatures → new)

```ts
openFile(rawPath: string, targetSessionId?: string, mode: OpenMode = 'preview'): void
openDiff(path: string, targetSessionId?: string, opts?: { sideBySide?: boolean; mode?: OpenMode }): void
openCommitFile(sha: string, file: string, mode: OpenMode): void
openMatch(abs: string, line: number, column: number, mode?: OpenMode): void
jumpToHunk(abs: string, line: number, mode?: OpenMode): void
onOpenReviewDiff(path: string, mode?: OpenMode): void
openTerminalFileLink(path: string, line?: number, col?: number, originSessionId?: string, mode?: OpenMode): void
openWeb(url: string, targetSessionId?: string, mode?: OpenMode): void
// private, app.tsx
const reportBackgroundOpen: (kind: DocKind, path: string, targetSessionId: string) => void;
const stageRevealUnlessActive: (kind: 'file', path: string, pos: { line: number; column: number }, mode: OpenMode | undefined) => void;
```

- `reportBackgroundOpen` reads `docStateRef.current` **before** the dispatch, computes
  `backgroundOpenOutcome`, resolves `sessionName` = `sessions.find(s => s.id === r.ownerSessionId)?.name`
  only when `r.ownerSessionId !== activeIdRef.current`, else `null`, and calls `feedback.report`.
- `stageRevealUnlessActive`: foreground (`mode !== 'background'`) → `setReveal` exactly as today.
  Background → `setReveal` only when `idOf('file', canonicalPath(path)) !== docStateRef.current.activeId`.
- In background mode every opener skips: `setActiveId`/`switchSession`, `setCenterView('editor')`,
  `rightPaneRef.current?.revealInTree`; it keeps `post readFile|readDiff`, `pushRecent`,
  `indexProjectOnce`.
- `forceCloseDoc` (`app.tsx:1342`) calls `clearReveal(doc.path)` for a closed `file` doc.
- `PaletteEntry` (`command-palette.tsx:7`) gains `runBackground?: () => void`.

**Post-rebase re-anchor (Slice 0):** `feat/nav-history` changes `openFile` to
`(rawPath, targetSessionId?, mode?, nav?: FileOpenNav)` with `FileOpenNav = { reveal?; record? }`
and moves `setReveal` inside `openFile`; it also records nav in `openDiff`/`openWeb`/`openCommitFile`.
After the rebase: background mode **forces `record: false`** in every opener, and the
`stageRevealUnlessActive` rule moves into `openFile`'s reveal step (`nav.reveal` staged only when
not background or not active); `openMatch`/`jumpToHunk`/`openTerminalFileLink` then pass
`{ reveal }` instead of calling the helper. `feat/unstaged-diff` makes `openDiff`'s opts
`{ sideBySide?; diffScope? }` → add `mode?` alongside; `onOpenReviewDiff(path, scope)` →
`onOpenReviewDiff(path, scope, mode?)`; right-pane `onOpenDiff(relPath, diffScope)` →
`onOpenDiff(relPath, diffScope, mode?)`. The background id must be computed with the same
`diffScope` the dispatch uses.

### Component props (every hop carries the mode)

```ts
// center-pane.tsx
onOpenFile?: ((path: string, mode?: OpenMode) => void) | undefined;              // was (path) => void, :113
onOpenFileAt?: (path: string, line?: number, col?: number, originSessionId?: string, mode?: OpenMode) => void;
onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
onOpenReviewDiff: (absPath: string, mode?: OpenMode) => void;
onOpenCommitFile?: (sha: string, file: string, mode: OpenMode) => void;
onOpenWeb?: (url: string, targetSessionId: string, mode: OpenMode) => void;      // new, S14
// app.tsx:2989 passes onOpenFile={(p, mode) => openFile(p, undefined, mode)}
// doc-view.tsx :35 and :107, markdown-viewer.tsx :78 and :538, diff-viewer.tsx :24 and :47
onOpenFile?: ((path: string, mode?: OpenMode) => void) | undefined;
// markdown-viewer.tsx :547
const openFileStable = useCallback((path: string, mode?: OpenMode) => onOpenFileRef.current?.(path, mode), []);
// makeMarkdownLink / createMarkdownComponents (:367, :381): onOpenFile param typed the same
// breadcrumb-bar.tsx :30
onOpenFile: (path: string, mode?: OpenMode) => void;
// search-pane.tsx :81-82, :152
onOpenMatch: (abs: string, line: number, column: number, mode?: OpenMode) => void;
onOpenFile: (abs: string, mode?: OpenMode) => void;
// review-view.tsx :312, :315, :2138, :2143
onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
onOpenDiff?: (absPath: string, mode?: OpenMode) => void;
// right-pane.tsx :120 (ChangeRow), :172 and :1719 (ChangesView / RightPane)
onOpenDiff: (relPath: string, mode?: OpenMode) => void;
// commit-view.tsx :49, git-history-view.tsx :243
onOpenFile: (file: string, mode: OpenMode) => void;
onOpenCommitFile?: (sha: string, file: string, mode: OpenMode) => void;
// terminal-pane.tsx :66
onOpenFile?: (path: string, line?: number, col?: number, originSessionId?: string, mode?: OpenMode) => void;
// context-menu.tsx MenuItem
onMiddleClick?: () => void;
// doc-tabs.tsx
flashTabId?: string | null;
// web-view.tsx
export function WebView(props: { url: string; onTitle?: (title: string) => void; onOpenInBackground?: (url: string) => void }): JSX.Element;
```

### S14 host contract

```ts
// src/webview-guard.ts
export type WebGuestOpenRoute = 'in-app-background' | 'external';
/** Non-preview guests only. In-app only for a middle/Ctrl-click on an http(s) URL. */
export function webGuestOpenRoute(url: string, disposition: string): WebGuestOpenRoute;
// = disposition === 'background-tab' && isHttpUrl(url) ? 'in-app-background' : 'external'

// src/protocol.ts HostToWebview, beside 'html:guestKey'
| { type: 'web:openBackgroundTab'; guestId: number; url: string }
```

`electron/main.ts:3748` non-preview branch becomes: `if (webGuestOpenRoute(url, disposition) ===
'in-app-background') sendToGuestHost(contents, { type: 'web:openBackgroundTab', guestId, url });
else openExternalUrl(url); return { action: 'deny' };` (`disposition` destructured from the
handler details alongside `url`). The preview branch above it is byte-identical. `sendToGuestHost`
targets `guest.hostWebContents` only — never broadcast (a multi-window app must not open the tab
in another window).

`WebView`: on the `<webview>`'s `did-attach`, store `el.getWebContentsId()` in a ref (the
html-viewer pattern, `html-viewer.tsx:257-262`); `subscribe` to host messages and, for
`web:openBackgroundTab` whose `guestId` equals the ref, call
`onOpenInBackground?.(normalized)` where `normalized = normalizeUrl(msg.url)`; drop it when
`normalizeUrl` returns `null` or no guest id is known yet. `center-pane.tsx:316` passes
`onOpenInBackground={(url) => onOpenWeb?.(url, d.sessionId, 'background')}`.

Consequences recorded: Chromium also reports Ctrl+click as `background-tab`, so Ctrl+click in a
guest opens a background in-app tab too (browser convention). Shift+click (`new-window`) and
left-click `target=_blank` (`foreground-tab`) stay external. A background web tab's `WebView`
mounts hidden immediately (`center-pane.tsx:180`, web docs are always mounted), so the page
loads in the background like a browser tab.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `open{mode:'background'}` | app openers | `docsReducer` `open` | both |
| `openCommitFile{mode}` (was `pin`) | `app.tsx:636` ← `git-history-view.tsx:845` ← `commit-view.tsx:152` (+ its dblclick) | `docsReducer` `openCommitFile` → `openHistoryDoc` | both; every call site listed in Task 2.3 |
| `activeId`/`activeBySession` unchanged | reducer | DocTabs, center-pane, nav history (`app.tsx:2365`) | both — no active change ⇒ no nav record |
| pending reveal | `stageRevealUnlessActive` (post-rebase: `openFile`) | `code-viewer.tsx` `takeReveal` on mount, `subscribeReveal` while mounted; `markdown-viewer.tsx:760,776,794` | both; the markdown consumer is unaffected: same API, fewer stagings |
| `clearReveal` | `forceCloseDoc` | reveal map | both |
| doc `sessionId` | reducer (background never transfers) | strip filter, `rememberedDoc` (`docs.ts:203`) | both |
| persisted docs | reducer | `toPersistedDocs` (`docs.ts:439`) | producer only; consumer unaffected: background tabs are ordinary pinned docs (measured: `toPersistedDocs` writes `preview` only when true, `docs.ts:446`) |
| recents | openers `pushRecent` | palette Recent group | both (A2) |
| `flashTabId` | `useBackgroundOpenFeedback` | DocTabs `tab--flash` / chevron | both |
| status text | `useBackgroundOpenFeedback` | screen readers via `role="status"` region | both |
| host window-open, app window (C5) | Chromium | `main.ts:999` | producer suppressed by `middleClickProps` on wired anchors; handler unchanged |
| host window-open, web guest (C6) | Chromium `background-tab` | `main.ts:3748` → `web:openBackgroundTab` → `WebView` → `openWeb` | both (S14) |
| `web:openBackgroundTab` | `main.ts` | `WebView` only | both; `html-viewer.tsx`'s subscriber filters by `type` (`html-viewer.tsx:223`) so it ignores the new type — measured |
| xterm `activate` button | xterm Linkifier (mouseup, any button) | terminal-pane link objects + `linkHandler` | consumer only; producer is vendor code, unchanged |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/docs.ts` | modify | `OpenMode 'background'`; background branches in `open` and `openHistoryDoc`; `openCommitFile.mode`; `backgroundOpenOutcome` |
| `webview/middle-click.ts` | create | gesture helper, `isMiddleButton`, `terminalLinkMiddleAction`, strings + announcement |
| `webview/use-background-open-feedback.ts` | create | flash id + timer, status region write (clear-then-set) |
| `webview/project-index.ts` | modify | `clearReveal(path)` |
| `webview/app.tsx` | modify | openers' mode plumbing, `reportBackgroundOpen`, `stageRevealUnlessActive`, status region, palette `runBackground`, prop wiring, `clearReveal` on close |
| `webview/styles.css` | modify | `--tab-flash` token, `.tab--flash`, `.tabbar__overflow-btn--flash`, reduced-motion + forced-colors variants |
| `webview/components/doc-tabs.tsx` | modify | `flashTabId` → class on tab or chevron; mousedown suppression on tabs (row T) |
| `webview/components/right-pane.tsx` | modify | S1 explorer row (replace ad-hoc `onAuxClick`), S2 Changes row |
| `webview/components/center-pane.tsx` | modify | prop types carry mode; `onOpenWeb` → `WebView` |
| `webview/components/doc-view.tsx` | modify | `onOpenFile` type (two sites) |
| `webview/components/markdown-viewer.tsx` | modify | S10 link middle-click; `openFileStable` forwards mode |
| `webview/components/diff-viewer.tsx` | modify | S9 oversize "Open file" |
| `webview/components/search-pane.tsx` | modify | S3 match rows, S4 group head |
| `webview/components/review-view.tsx` | modify | S5, S6, S7 |
| `webview/components/commit-view.tsx` | modify | S8; `(file, mode)` |
| `webview/components/git-history-view.tsx` | modify | `onOpenCommitFile` mode pass-through |
| `webview/components/breadcrumb-bar.tsx` | modify | S11 dropdown entries set `onMiddleClick` |
| `webview/components/context-menu.tsx` | modify | `MenuItem.onMiddleClick` wired via the helper |
| `webview/components/command-palette.tsx` | modify | S12 rows; `PaletteEntry.runBackground`; palette stays open |
| `webview/components/terminal-pane.tsx` | modify | S13 `activate` branches; hover ref; capture mousedown; path menu rows |
| `webview/components/web-view.tsx` | modify | S14 guest id + `web:openBackgroundTab` subscriber |
| `src/webview-guard.ts` | modify | `webGuestOpenRoute` |
| `src/protocol.ts` | modify | `web:openBackgroundTab` |
| `electron/main.ts` | modify | guest handler non-preview branch |
| `test/unit/docs.test.ts` | modify | AC-12 cases |
| `test/unit/middle-click.test.ts` | create | helper, AC-16, strings |
| `test/unit/use-background-open-feedback.test.ts` | create | flash timer, clear-then-set |
| `test/unit/doc-tabs-flash.test.ts` | create | DocTabs class + chevron fallback + tab mousedown suppression |
| `test/unit/middle-click-surfaces.test.ts` | create | jsdom adapters: SearchPane, DiffViewer oversize |
| `test/unit/middle-click-menus.test.ts` | create | jsdom adapters: ContextMenu `onMiddleClick`, BreadcrumbBar |
| `test/unit/middle-click-palette.test.ts` | create | jsdom adapter: CommandPalette row stays open, `runBackground` |
| `test/unit/middle-click-commit-view.test.ts` | create | jsdom adapter: CommitView `(file, mode)` |
| `test/unit/webview-guard.test.ts` | modify | `webGuestOpenRoute` table |
| `test/e2e/middle-click-fixture.mjs` | create | shared: fixture repo writer, `snapshotUnchanged(page)`, `tabInfo(page)`, `statusText(page)` |
| `test/e2e/middle-click-explorer.e2e.mjs` | create | S1 + AC-1,2,3,6,9,11,14,15 |
| `test/e2e/middle-click-surfaces.e2e.mjs` | create | S2,S3,S4,S9,S10,S11,S12 + AC-4,5,7,10,13 |
| `test/e2e/middle-click-review.e2e.mjs` | create | S5,S6,S7,S8 + AC-4 |
| `test/e2e/middle-click-terminal.e2e.mjs` | create | S13 + AC-4 terminal `:line`, AC-7b |
| `test/e2e/middle-click-web.e2e.mjs` | create | S14 + AC-17 |
| `test/e2e/mouse-nav.e2e.mjs` | modify | `:98` expects background (c.txt not active) — AC-8 |
| `docs/specs/2026-09-22-middle-click-new-tab.md` | modify (done, this commit) | D1 ruling, S14, AC-17, staleness corrections |

## Scripts

- `anchors.mjs` (one-off, `%TEMP%\claude-scratch\`, Slice 0): args = worktree root; holds the
  list of `{file, pattern}` pairs for every line this plan cites (openers, prop lines, handler
  lines) and prints the current line number or `MISSING` for each. Replaces re-reading ~40 cites
  by hand after the rebase. Delete after Slice 0.

## Slices

### Slice 0: Rebase onto main and re-verify the plan's anchors

**Check:** `git log --oneline main..HEAD` shows only this branch's commits on top of a `main` that
contains both `feat/nav-history` and `feat/unstaged-diff` merges; `node %TEMP%\claude-scratch\anchors.mjs
<worktree>` prints no `MISSING`; `npm run verify` exits 0.

**Parallel groups:** Serial: T0.1, T0.2

#### Task 0.1: Rebase

**Files:** none edited except conflict resolution in `docs/specs/INDEX.md` if both sides added rows (keep both).

**Steps:**
- [ ] Confirm both branches are merged: `git branch --merged main` lists `feat/nav-history` and
      `feat/unstaged-diff`. If either is not, **stop and report** — this item is sequenced after them.
- [ ] `git rebase main`; `npm ci` only if `package-lock.json` changed; `npm run verify` — expect exit 0.

#### Task 0.2: Re-anchor

**Files:** Modify: `docs/plans/2026-09-22-middle-click-new-tab.plan.md` (line numbers only, plus a
"Re-anchored at <sha>" line under the Spec line).

**Steps:**
- [ ] Write and run `anchors.mjs`. For each moved cite, update the number in this plan.
- [ ] Confirm the post-rebase shapes named under "Post-rebase re-anchor" in Contracts: `openFile`'s
      `FileOpenNav`, `openDiff`'s `diffScope`, `onOpenReviewDiff(path, scope)`, right-pane
      `onOpenDiff(relPath, diffScope)`, `idOf`'s scope argument. If any differs from what is written
      there, update the Contracts section to the real shape **before** Slice 1 (a signature fix, not
      a behaviour change) and note it under Spec staleness.
- [ ] Commit `docs(plan): re-anchor middle-click plan after rebase`.

### Slice 1: Background open, end to end, from the explorer

**Check:** `npx vitest run test/unit/docs.test.ts test/unit/middle-click.test.ts
test/unit/use-background-open-feedback.test.ts test/unit/doc-tabs-flash.test.ts` passes; `npm run build
&& node test/e2e/run-smoke.mjs middle-click-explorer mouse-nav` passes; `npm run verify` exits 0.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3 · G4: T1.4 · Serial: T1.5, T1.6
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`, `webview/components/right-pane.tsx`, `webview/styles.css`

#### Task 1.1: Reducer background branches

**Files:**
- Modify: `webview/docs.ts` (`OpenMode` :62, `DocsAction.openCommitFile` :127, `openHistoryDoc` :158-199, `open` :212-261, `case 'openCommitFile'` :353, new export `backgroundOpenOutcome`)
- Test: `test/unit/docs.test.ts` (new `describe('docsReducer — background open')`)

**Interfaces:** Produces `OpenMode`, `BackgroundOutcome`, `BackgroundOpenResult`,
`backgroundOpenOutcome(state, kind, path, targetSessionId)`, `openCommitFile{mode: OpenMode}` —
exactly as in Contracts.

**Call sites:** `openCommitFile` action dispatched only at `webview/app.tsx:639` (updated in T1.5 to
`mode: pin ? 'permanent' : 'preview'` so this task stays compilable; T2.3 changes the app signature).
Existing tests using `pin:` in `test/unit/docs.test.ts:265-331` switch to `mode`.

**Steps:**
- [ ] Failing tests: 'background open of a new file appends a pinned tab and keeps activeId/activeBySession
      references' — `next.activeId === prev.activeId && next.activeBySession === prev.activeBySession`,
      last doc `preview !== true`; 'background open of the preview file clears preview in place' —
      same index, `preview` falsy, references unchanged; 'background open of a pinned doc in another
      session does not transfer ownership' — `sessionId` unchanged, `next.docs === prev.docs` or
      deep-equal; 'background open of a web url appends a web tab'; 'background commit-diff re-keys the
      matching preview slot and repoints activeBySession'; 'background commit-diff with pinned id is a
      no-op' — `next === prev`; 'backgroundOpenOutcome reports opened / pinned / already-open with owner
      and title'.
- [ ] `npx vitest run test/unit/docs.test.ts` — expect FAIL (mode/export absent).
- [ ] Implement within the Contracts invariants.

#### Task 1.2: Gesture helper and strings

**Files:**
- Create: `webview/middle-click.ts`
- Test: `test/unit/middle-click.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:** Produces `suppressMiddleMouseDown`, `middleClickProps`,
`MIDDLE_CLICK_STRINGS`, `backgroundOpenAnnouncement` as in Contracts. `isMiddleButton` is written here
but stays **module-private** until T3.1 exports it; `terminalLinkMiddleAction` is added in T3.1.
Consumes `BackgroundOutcome` from `webview/docs.ts` (type `'opened' | 'pinned' | 'already-open'`).

**Steps:**
- [ ] Failing tests: 'mousedown button 1 is default-prevented, button 0 is not'; 'consumer onMouseDown
      runs first for every button'; 'mousedown never stops propagation'; 'auxclick button 1 prevents,
      stops and calls onMiddle once'; 'auxclick button 2 does nothing'; 'onMiddle null still prevents
      and stops'; 'announcement strings' — exact text for all six variants.
- [ ] Run — expect FAIL (module missing). Implement.

#### Task 1.3: Feedback hook

**Files:**
- Create: `webview/use-background-open-feedback.ts`
- Test: `test/unit/use-background-open-feedback.test.ts` (jsdom, `vi.useFakeTimers()`, stub `requestAnimationFrame`)

**Interfaces:** Produces (exported) only
`useBackgroundOpenFeedback()` as in Contracts. Consumes `backgroundOpenAnnouncement(outcome, title,
sessionName)` from `webview/middle-click.ts`.

**Steps:**
- [ ] Failing tests: 'report sets flashTabId and clears it after 600 ms'; 'a second report restarts the
      timer and replaces the id'; 'status text is cleared synchronously and set on the next frame';
      'two identical reports produce two non-empty writes separated by an empty one' (AC-14);
      'unmount cancels the timer and frame'.
- [ ] Run — expect FAIL. Implement.

#### Task 1.4: Tab cue and tab mousedown suppression

**Files:**
- Modify: `webview/components/doc-tabs.tsx` (tab element :200-216: add `flashTabId` → `tab--flash`;
  `onMouseDown={suppressMiddleMouseDown}` on the tab, existing `onAuxClick` close unchanged; overflow
  chevron :316: `tabbar__overflow-btn--flash` when the flashed tab is clipped)
- Test: `test/unit/doc-tabs-flash.test.ts` (jsdom)

**Interfaces:** Produces DocTabs prop `flashTabId?: string | null`. Consumes
`suppressMiddleMouseDown(e: { button: number; preventDefault(): void }): void` from `webview/middle-click.ts`.

Clipped test: in a `useLayoutEffect` on `flashTabId`, read the tab element's
`getBoundingClientRect()` against the strip's; any part outside → flash the chevron instead. Never
scroll the strip.

**Steps:**
- [ ] Failing tests: 'flashTabId adds tab--flash to that tab only'; 'middle mousedown on a tab is
      default-prevented'; 'a clipped flashed tab flashes the chevron, not the tab' (stub rects).
- [ ] Run — expect FAIL. Implement.

#### Task 1.5: App wiring, explorer, styles (serial)

**Files:**
- Modify: `webview/app.tsx` (`openFile` :1438; `openCommitFile` :636 dispatch uses `mode: pin ?
  'permanent' : 'preview'` for now; `forceCloseDoc` :1342 `clearReveal`; status region next to
  `navLiveRef` :3123; `flashTabId={feedback.flashTabId}` on `<CenterPane`; `onOpenFile` at :2989 becomes
  `(p, mode) => openFile(p, undefined, mode)`)
- Modify: `webview/project-index.ts` (`clearReveal`)
- Modify: `webview/components/center-pane.tsx` (`onOpenFile` type :113; new prop `flashTabId?: string | null`, passed to `<DocTabs` at :199)
- Modify: `webview/components/right-pane.tsx` (explorer row :1547-1554 → `{...middleClickProps(node.kind === 'file' ? () => onOpenFile(node.path, 'background') : null)}`; remove the ad-hoc `onAuxClick` and its comment)
- Modify: `webview/styles.css` (`--tab-flash: color-mix(in srgb, var(--accent) 45%, transparent)` in
  `:root`; `.tab--flash` 600 ms outline-pulse keyframe; `@media (prefers-reduced-motion: reduce)` and
  `:root[data-reduce-motion="true"]` → `animation: none` + static `outline: 2px solid var(--tab-flash)`;
  `@media (forced-colors: active)` → `outline-color: Highlight`; same three for `.tabbar__overflow-btn--flash`)

**Interfaces:** Consumes: `backgroundOpenOutcome(state: DocsState, kind: DocKind, path: string,
targetSessionId: string): BackgroundOpenResult`; `useBackgroundOpenFeedback(): { flashTabId; statusRef;
report(r: { id; title; outcome; sessionName }) }`; `middleClickProps(onMiddle: (() => void) | null,
onMouseDown?): { onMouseDown; onAuxClick }`; DocTabs `flashTabId?: string | null`. Produces:
`openFile(rawPath, targetSessionId?, mode: OpenMode = 'preview')` background semantics,
`reportBackgroundOpen`, `stageRevealUnlessActive`, `clearReveal(path: string): void`.

**Call sites:** `openFile` — `app.tsx` :1506, :1520, :1531, :1560, :1607, :1616, :1660, :2163,
:2181, :2467, :2483, :2989, :3093; none pass `'background'` yet except via :2989/:3093 wrappers.
The explorer row calls `onOpenFile` only — never `onRowClick`, so no `onContextPath`/`setFocusPath`/selection change.

**Steps:**
- [ ] Failing e2e first: write `test/e2e/middle-click-fixture.mjs` and
      `test/e2e/middle-click-explorer.e2e.mjs` (see T1.6), `npm run build && node test/e2e/run-smoke.mjs
      middle-click-explorer` — expect FAIL at AC-1 (the new tab is active today).
- [ ] Implement `openFile` background branch per Contracts; `reportBackgroundOpen` before dispatch.
- [ ] Status region: `<div ref={feedback.statusRef} className="sr-only" role="status" aria-live="polite" />`.
- [ ] Re-run until the scenario passes.

#### Task 1.6: E2E scenario + mouse-nav update (serial, written first inside T1.5's red step)

**Files:**
- Create: `test/e2e/middle-click-fixture.mjs` — exports `writeFixtureRepo(opts: { files: Record<string,string>; commits?: Array<Record<string,string>>; dirty?: Record<string,string> }): string`,
  `snapshotUnchanged(page): Promise<{ activeTitle; activeEl; centerView; selection; scrollY; scrollTops }>`,
  `tabInfo(page): Promise<Array<{ title; active; preview; flash }>>`, `statusText(page): Promise<string>`,
  `watchStatus(page): Promise<void>` (installs a MutationObserver recording every textContent write into `window.__statusLog`).
- Create: `test/e2e/middle-click-explorer.e2e.mjs`
- Modify: `test/e2e/mouse-nav.e2e.mjs` (:98-109: assert c.txt is a non-preview tab AND the active tab is unchanged; the following close-by-middle-click step is unchanged)

**Scenario (≤120 s):** fixture repo with 60 files so the tree overflows; open `a.ts` pinned, focus
the editor. AC-1 middle `e.ts` → new non-italic tab, `snapshotUnchanged` equal. AC-2 single-click
`d.ts` (preview) then activate `a.ts`, middle `d.ts` → loses `tab--preview`, same index, same count.
AC-3 middle `e.ts` again → count same, `tab--flash` present then gone within 1 s, status reads
"e.ts is already open". AC-14 middle `e.ts` twice more → `__statusLog` has an empty write between the
two identical messages. AC-6 middle a folder → no tab, `aria-expanded` unchanged. AC-11
`page.mouse` down (middle) on `b.ts`, move 100 px, up on `c.ts` → no new tab, no `dragstart`
(listener counts). AC-15 `tab--flash` computed `animation-name` is `none` with
`document.documentElement.dataset.reduceMotion = 'true'`, and with `page.emulateMedia({ reducedMotion:
'reduce' })`; with `emulateMedia({ forcedColors: 'active' })` outline-style is not `none`. AC-9:
foreground-open `f.ts`, background-open three files, `Alt+Left` → active tab is `a.ts`.

**Steps:** covered by T1.5's red→green loop; the scenario must fail against today's build first.

### Slice 2: In-app surfaces S2–S12

**Check:** `npx vitest run test/unit/middle-click-surfaces.test.ts test/unit/middle-click-menus.test.ts
test/unit/middle-click-palette.test.ts test/unit/middle-click-commit-view.test.ts` passes; `npm run build &&
node test/e2e/run-smoke.mjs middle-click-surfaces middle-click-review` passes; `npm run verify` exits 0.

**Parallel groups:** G1: T2.1 · G2: T2.2 · G3: T2.3 · G4: T2.4 · G5: T2.5 · G6: T2.6 · G7: T2.7 · Serial: T2.8
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx` (`right-pane.tsx` is edited by T2.7 alone in this slice)

Every task below consumes: `middleClickProps<T>(onMiddle: (() => void) | null, onMouseDown?:
MouseEventHandler<T>): { onMouseDown; onAuxClick }` and `type OpenMode = 'preview' | 'permanent' |
'background'`. Each spreads the helper on the **item element** (never a container).

#### Task 2.1: Search pane (S3, S4)

**Files:** Modify `webview/components/search-pane.tsx` (props :81-82, :152; group head :91-95 →
`middleClickProps(nameOnly ? () => onOpenFile(result.abs, 'background') : null)`; match row :121-127 →
`() => onOpenMatch(result.abs, m.line, m.column, 'background')`; :396 wrapper → `(abs, mode) =>
onOpenMatch(abs, 1, 1, mode)`). Test: `test/unit/middle-click-surfaces.test.ts` (describe SearchPane).
**Steps:** failing test 'middle on a match calls onOpenMatch(abs, line, col, "background")'; 'middle
on a non-name-only head calls nothing and does not collapse' → run FAIL → implement.

#### Task 2.2: Review view (S5, S6, S7)

**Files:** Modify `webview/components/review-view.tsx` (props :312, :315, :2138, :2143; card open
:2344-2350 → `() => onJumpToHunk(abs, first, 'background')`; side-by-side :2352-2362 → `() =>
onOpenDiff(abs, 'background')`; hunk jump :2745-2754 → `() => onJumpToHunk(abs, hunk.startNewLine,
'background')` **without** `onSetCurrent`). Proof: `middle-click-review.e2e.mjs` (T2.8).
**Steps:** red is the e2e in T2.8; implement types + three spreads.

#### Task 2.3: Commit files (S8)

**Files:** Modify `webview/components/commit-view.tsx` (:49 `onOpenFile: (file: string, mode:
OpenMode) => void`; :152 click → `'preview'`, dblclick → `'permanent'`, middle → `'background'`),
`webview/components/git-history-view.tsx` (:243 type; :845 `(file, mode) => onOpenCommitFile?.(sha,
file, mode)`). Test: `test/unit/middle-click-commit-view.test.ts`.
**Call sites of the changed `(file, pin)` signature:** `commit-view.tsx:152` and its dblclick handler,
`git-history-view.tsx:845`; `app.tsx:636` updated in T2.8.
**Steps:** failing test 'click → preview, dblclick → permanent, middle → background' → FAIL → implement.

#### Task 2.4: Doc view chain (S9, S10)

**Files:** Modify `webview/components/doc-view.tsx` (:35, :107 types),
`webview/components/diff-viewer.tsx` (:24, :47 types; "Open file" :53-58 spreads the helper → `onOpenFile(doc.path,
'background')`), `webview/components/markdown-viewer.tsx` (:78, :538, :367, :383 types; :547
`openFileStable(path, mode?)`; `MarkdownLink` :87-128 — file target → `onOpenFile(path,
'background')` and **skip** the `#fragment` scroll (:106-112); `http(s)` → `openExternal(url)`
once; `#anchor`/unsupported → nothing). Test: `test/unit/middle-click-surfaces.test.ts` (describe
DiffViewer — oversize notice only). MarkdownViewer is proven by the e2e (AC-7).
**Steps:** failing test 'middle on oversize Open file calls onOpenFile(path, "background")' → FAIL → implement.

#### Task 2.5: Menus (S11)

**Files:** Modify `webview/components/context-menu.tsx` (`MenuItem.onMiddleClick?: () => void`; row
element spreads `middleClickProps(it.onMiddleClick ?? null)`; on a middle action the menu closes
through its existing `onClose` path, same as a click), `webview/components/breadcrumb-bar.tsx` (:30 type;
entries :118-128 set `onMiddleClick: () => onOpenFile(entryPath, 'background')` for files, none for dirs).
Test: `test/unit/middle-click-menus.test.ts`.
**Steps:** failing tests 'middle on a row with onMiddleClick calls it and closes'; 'middle on a row
without it does not call onClick' → FAIL → implement.

#### Task 2.6: Palette (S12)

**Files:** Modify `webview/components/command-palette.tsx` (`PaletteEntry.runBackground?: () =>
void`; row :161-172 spreads `middleClickProps(entry.runBackground ?? null)` — **no** `onClose()`; the
input keeps focus because mousedown is suppressed). Test: `test/unit/middle-click-palette.test.ts`.
**Steps:** failing test 'middle on a row calls runBackground, not run, and not onClose' → FAIL → implement.

#### Task 2.7: Changes row (S2)

**Files:** Modify `webview/components/right-pane.tsx` (ChangeRow :120 type; :128-131 row spreads
`middleClickProps(() => onOpenDiff(change.path, 'background'))`; :172, :1719 types). Proof:
`middle-click-surfaces.e2e.mjs`. Post-rebase: the call is `onOpenDiff(change.path,
diffScopeForChange(change), 'background')`.

#### Task 2.8: App openers + center-pane + scenarios (serial)

**Files:**
- Modify `webview/app.tsx`: `openDiff` :1469 `opts.mode`; `onOpenReviewDiff` :1488 `(path, mode?)`;
  `openMatch` :1516 and `jumpToHunk` :1527 take `mode?` and use `stageRevealUnlessActive`, skip
  `setCenterView` in background; `openCommitFile` :636 `(sha, file, mode)`, skips `setCenterView` in
  background, reports with kind `'commit-diff'` and path `` `${sha} ${file}` ``; palette `fileEntries`
  :2453-2470 and `recentItems` :2474-2485 gain `runBackground` calling the same opener with
  `'background'` (fileEntries keep `resolveOwningSession` for D2); RightPane `onOpenDiff` / ReviewView
  props pass mode through.
- Modify `webview/components/center-pane.tsx`: `onJumpToHunk`, `onOpenReviewDiff`, `onOpenCommitFile` types.
- Create `test/e2e/middle-click-surfaces.e2e.mjs` (≤120 s): fixture repo with a modified file (S2), a
  `README.md` with links to `b.ts`, `c.ts#x` and `http://127.0.0.1:<port>/` (S10, AC-7 via
  `spyMain(app,[{api:'openExternal'}])` — exactly one call, no tab), a >limit diff for the oversize notice
  (S9), search for a token present in `a.ts` (active; AC-5 cursor unchanged) and `b.ts` (S3), name-only
  search head (S4), breadcrumb dropdown file entry (S11), palette file row with the palette still open and
  `.palette__input` focused (AC-10), second session B owning `z.ts` → palette middle on `z.ts` from A →
  A unchanged, status ends " in ‹B name›", switch to B → tab present, pinned (AC-13). Every step
  asserts `snapshotUnchanged`.
- Create `test/e2e/middle-click-review.e2e.mjs` (≤120 s): fixture repo with two modified files and
  one commit; Review card open (S5), side-by-side (S6), hunk jump (S7, current hunk index unchanged),
  History → commit → file row (S8 pinned commit-diff); later activate the S7 tab → cursor at the hunk line (AC-4).

**Interfaces:** Consumes every prop type under "Component props" for the touched components; produces
the opener signatures listed in Contracts for `openDiff`, `onOpenReviewDiff`, `openMatch`,
`jumpToHunk`, `openCommitFile`.

**Steps:** write both scenarios → build → run → FAIL → implement the app side → PASS.

### Slice 3: Terminal links (S13)

**Check:** `npm run build && node test/e2e/run-smoke.mjs middle-click-terminal terminal-links
terminal-path-links terminal-osc8-link` passes; `npm run verify` exits 0.

**Parallel groups:** G1: T3.1 · Serial: T3.2
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`

#### Task 3.1: Terminal pane

**Files:** Modify `webview/middle-click.ts` (export `isMiddleButton`; add `TerminalLinkMiddleAction`,
`terminalLinkMiddleAction`), `test/unit/middle-click.test.ts` (AC-16 table: `(1,'Win32')→'background'`,
`(1,'MacIntel')→'background'`, `(1,'Linux x86_64')→'ignore'`, `(0,'Linux x86_64')→'foreground'`,
`(2,'Win32')→'ignore'` — written first, run FAIL, then implement). Modify `webview/components/terminal-pane.tsx` (:66 prop type gains trailing `mode?:
OpenMode`; URL links :405, OSC-8 `linkHandler.activate` :179-181, path links :459, commit links :495).

**Interfaces:** Consumes `terminalLinkMiddleAction(button: number, platform: string):
'foreground' | 'background' | 'ignore'`, `isMiddleButton(e: { button: number }): boolean`,
`MenuItem.onMiddleClick?: () => void`.

Rules in each `activate(event)`: `const a = terminalLinkMiddleAction(event.button, navigator.platform)`;
`'ignore'` → return. URL / OSC-8 / dir / commit → today's action regardless of `a`. Single file
candidate → `onOpenFileRef.current?.(abs, line, col, sessionId, a === 'background' ? 'background' :
undefined)`. Multiple candidates → open the path menu as today; its rows set `onMiddleClick` → same
open with `'background'`. Hover: each link object's `hover`/`leave` and `linkHandler.hover`/`leave`
set `linkHoveredRef.current = true/false`; one capture-phase `mousedown` listener on `term.element`
calls `preventDefault()` when `isMiddleButton(e) && linkHoveredRef.current`, removed on dispose.
Proof: `middle-click-terminal.e2e.mjs` (T3.2).

#### Task 3.2: App + center-pane + scenario (serial)

**Files:** Modify `webview/app.tsx` (`openTerminalFileLink` :1547 gains `mode?`; background: reveal
via `stageRevealUnlessActive`, no `setCenterView`, `openFile(path, owningId ?? undefined, 'background')`
— with D2: owning session other than active → no switch), `webview/components/center-pane.tsx`
(`onOpenFileAt` type :116, TerminalPane `onOpenFile` :270). Create `test/e2e/middle-click-terminal.e2e.mjs`
(≤120 s): `window.__termLinkProviders` path as `test/e2e/link-cwd.e2e.mjs` and `test/e2e/terminal-commit-link.e2e.mjs` use it; echo
`src/b.ts:12:3` and `https://127.0.0.1:<port>/` in the shell; `activate` with `new MouseEvent('mouseup',
{ button: 1 })` → b.ts pinned background tab, activating it lands on line 12 (AC-4); URL → one
`openExternal` spy call, no tab (AC-7b).
**Steps:** scenario → FAIL → implement → PASS.

### Slice 4: Web-view guest links (S14)

**Check:** `npx vitest run test/unit/webview-guard.test.ts` passes; `npm run build && node
test/e2e/run-smoke.mjs middle-click-web web-view html-viewer preview-transport` passes; `npm run verify` exits 0.

**Parallel groups:** Serial (first): T4.1 · G1: T4.2 · G2: T4.3 · Serial: T4.4
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/app.tsx`, `webview/components/center-pane.tsx`

#### Task 4.1: Message type (serial, first)

**Files:** Modify `src/protocol.ts` (HostToWebview, after `html:guestKey` :656: `| { type:
'web:openBackgroundTab'; guestId: number; url: string }` with a one-line why comment: routed to the
guest's own host window only).
**Interfaces:** Produces that union member. Proof: typecheck (`npm run typecheck`).

#### Task 4.2: Host routing function

**Files:** Modify `src/webview-guard.ts` (`WebGuestOpenRoute`, `webGuestOpenRoute(url, disposition)`),
Test: `test/unit/webview-guard.test.ts`.
**Steps:** failing table test — `('https://a/', 'background-tab') → 'in-app-background'`;
`('http://127.0.0.1:3/', 'background-tab') → 'in-app-background'`; `('https://a/', 'foreground-tab')
→ 'external'`; `('https://a/', 'new-window') → 'external'`; `('mailto:x@y', 'background-tab') →
'external'`; `('file:///C:/x', 'background-tab') → 'external'`; `('conduit-preview://t/x',
'background-tab') → 'external'` → FAIL → implement.

#### Task 4.3: WebView subscriber

**Files:** Modify `webview/components/web-view.tsx` (`onOpenInBackground?: (url: string) => void`
prop; `WebviewElement` gains `getWebContentsId(): number`; `did-attach` listener stores the id in
`guestIdRef`; `subscribe` effect as in Contracts; `normalizeUrl` before calling the prop).
**Interfaces:** Consumes `HostToWebview` member `{ type: 'web:openBackgroundTab'; guestId: number;
url: string }`, `subscribe(cb): () => void` from `webview/bridge.ts`, `normalizeUrl(input: string):
string | null` from `webview/web-url.ts`. Proof: T4.4 scenario.

#### Task 4.4: Host handler + app + scenario (serial)

**Files:**
- Modify `electron/main.ts` (:3748 handler: destructure `disposition`; non-preview branch per the S14
  host contract; preview branch untouched; import `webGuestOpenRoute` from `../src/webview-guard` beside `isHttpUrl` :167).
- Modify `webview/app.tsx` (`openWeb` :1494 → `(url, targetSessionId?, mode?)`; background: report with
  kind `'web'`, dispatch with `mode: 'background'` into `targetSessionId ?? activeIdRef.current`, no
  activation; `WebPromptModal onSubmit` :3172 and `reopenClosedTab` :1508 keep calling it with the url only;
  pass `onOpenWeb={openWeb}` to CenterPane).
- Modify `webview/components/center-pane.tsx` (`onOpenWeb` prop; :316 `onOpenInBackground`).
- Create `test/e2e/middle-click-web.e2e.mjs` (≤120 s): local http server serving `/` with
  `<a id="bg" href="/two" style="display:block;width:100vw;height:50vh">` and `<a id="blank"
  href="/three" target="_blank" style="display:block;width:100vw;height:50vh">`; open a web tab
  through the palette as `web-view.e2e.mjs` does; `spyMain(app, [{ api: 'openExternal' }])`; find the
  guest in the main process (`webContents.getAllWebContents().find(w => w.getType() === 'webview')`)
  and drive real input with `sendInputEvent({ type: 'mouseDown', button: 'middle', x: 40, y: 40,
  clickCount: 1 })` + `mouseUp` → a second web tab titled for `/two` exists, not active, first web
  tab still active, zero `openExternal` calls (AC-17); left `mouseDown`/`mouseUp` at `y` in the lower
  half → one `openExternal` call with `/three`, no new tab.
  If `sendInputEvent` does not produce `disposition: 'background-tab'` (log it from a temporary
  host-side `evaluate` probe, then remove the probe), **stop and report** — never fake it with a
  direct `web:openBackgroundTab` send.

**Steps:** scenario → FAIL (today: one `openExternal` call, no tab) → implement → PASS; re-run
`html-viewer` and `preview-transport` to prove the preview branch is untouched.

## Verification

- Per task: the task's own vitest file (`npx vitest run <file>`), exit code read directly.
- Per slice: the slice's **Check** line, then `npm run verify`.
- E2E: `npm run build` first; scenarios by filter, **serially**, on a quiet machine. A PTY-shaped
  failure in the terminal scenario is re-run alone before it is believed (CLAUDE.md).
- Pre-integration: `npm run verify` and the full `npm run test:smoke` once on the rebased branch.
- Never pipe `verify` output through `tail`/`head`.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality (for example the post-rebase `openFile` shape differs from the one written
here) — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second
copy, special case, widened type, fallback, or an override patched in place of its semantic
source. Report leads with the fix that keeps the locked decision.

## Decisions Needed

- [normal] Seven adapters (RightPane, ReviewView, MarkdownViewer, TerminalPane, CenterPane, DocView,
  WebView) are proven by e2e, not by per-adapter unit tests as the spec §3 asked — default taken:
  e2e, because they cannot render standalone in jsdom without Monaco/xterm/`<webview>`; the e2e
  assertion (tab not active) fails on a dropped mode.
- [normal] Ctrl+click inside a web-view guest also opens a background in-app tab (Chromium reports
  it as `background-tab`) — default taken: accept, it's browser convention and the same disposition.
- [normal] AC-12 "referentially unchanged" cannot hold for the commit-diff preview-slot re-key, which
  must repoint `activeBySession` — default taken: that one case asserts the repoint instead.
