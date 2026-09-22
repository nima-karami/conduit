# Editor navigation history — implementation plan

**Spec:** `docs/specs/2026-09-22-editor-nav-history.md`  **Tier:** FULL

## Goal

Back/Forward walk editor locations (`{session, doc, line/col?}`) on the VS Code model: explicit
producers record, applying never records, session/Terminal activations are never entries.

## Architecture

Three layers, each with one owner:

1. **Pure stack** (`src/nav-history.ts`): generic over the entry type (D1): record with a "from"
   side, coalescing through injected ops, truncate, cap, skip-dead traversal with async apply,
   drop. No editor knowledge.
2. **Editor entry model** (`webview/editor-nav.ts`, pure): `NavEntry`/`DocRef`/`CursorPos`, the R4
   ops, the R3 predicate, clamping, the announcement string.
3. **Glue**: `webview/use-nav-history.ts` owns the state and a serial op queue (records and applies
   run one at a time). `webview/nav-editors.ts` is the registry that lets the app read a file's live
   cursor, reveal with a **tagged** `setPosition`, focus, and receive R3 jumps from `CodeViewer`.
   `webview/path-probe.ts` wraps the host `pathExists` round-trip. `app.tsx` is the producer site
   for R1 and implements `currentEntry` / `isLive` / `apply`.

Recording is imperative at the user-intent call sites. The state-watching effect in the current
`use-nav-history.ts` is deleted: it is the defect.

## Data flow

```
PRODUCERS                                   use-nav-history (serial queue)          src/nav-history
 app.tsx openFile/openDiff/openWeb/        ─ recordNav(to) ─▶ from = currentEntry()  ─▶ record(s, from, to, EDITOR_NAV_OPS)
   openReview*/openGitHistoryTab/                         (captured SYNC, before any setReveal)
   openCommitFile/activateDocByUser                                                   F1 absorb | F2 push | F3 none,
 project-index openDefinitionFile(abs,pos) → app opener → openFile(abs,…,{reveal})    then push(to) with R4 coalesce
   (monaco-opener, ts-nav ×3, breadcrumb)
 CodeViewer onDidChangeCursorPosition ─ emitCursorJump ─▶ app sink ─ recordJump(from,to) ─▶ record(…)
   (R3: untagged, not edited, |Δ|>10)

CONSUMER (Back/Forward: button, Alt+Arrows, X1/X2 DOM, Windows appCommand, palette)
 goBack() ─▶ queue ─▶ updateCurrent(s, currentEntry())            (§2.3 step 0)
                   ─▶ traverse(s, -1, isLive, apply)              skip sync-dead; apply(e):
                        app.apply(e): open doc? activate+setActiveId+center 'editor'
                                      same doc active → revealInNavEditor (tagged setPosition)
                                      other tab      → setReveal + requestNavFocus
                                      closed file    → await probePathExists (2 s) → openFile(…,{reveal, record:false})
                                      else           → 'dead' → drop, keep stepping
                        announce "Editor: <title>[, line n]" in navLiveRef
 CodeViewer reveal sites (mount + live subscribe) ─ revealInEditor(ed,pos) ─ setPosition(pos, NAV_REVEAL_SOURCE) → R3 ignores
```

State lives in the renderer only (per window, in memory). Nothing crosses the IPC boundary except
the existing read-only `pathExists` → `pathExistsResult`.

## Settled decisions — do not re-litigate

- Spec D1: `src/nav-history.ts` is generic over the entry type. Editor semantics (R4, F1 "same
  target") are injected as `NavOps<E>`.
- Spec D2: Ctrl+Tab records every **doc** stop. The Terminal stop records nothing.
- Spec D3: a closed file reopens as a **preview** tab.
- Spec D4: the red-first e2e (Slice 1) is the measurement of the §2.6 runtime claims.
- Spec D5: history does not survive a renderer reload / crash-recover.
- Thresholds: R3 jump `> 10` lines, R4 coalesce `<= 10` lines, cap 50, probe timeout 2000 ms.
- One record per move is guaranteed by a **tag**, not timing: every reveal-driven `setPosition` passes
  `NAV_REVEAL_SOURCE` as Monaco's `source`, and R3 ignores events whose `event.source` equals it.
  Edits are detected by `model.getVersionId()` changing since the previous cursor event, or
  `event.reason` ∈ {ContentFlush, RecoverFromMarkers, Paste, Undo, Redo}.
- The "from" side is captured **synchronously when the producer is called, before it stages any
  reveal**. That is why `setReveal` moves inside `openFile` (after the record) and why
  `openDefinitionFile` now carries the position instead of each producer calling `setReveal` first.
  `setReveal` notifies a mounted viewer synchronously, so the old order moved the cursor before the
  "from" read.
- Same-file `openLocation` (`ts-nav.ts`) keeps its plain `setPosition` and is recorded by R3. A
  ≤10-line same-file jump would coalesce under R4 anyway, so the outcome is identical to an explicit
  R2 record. A same-file peek/references pick already works this way (spec R2).
- `DocRef` is `{ kind, path }` only. The spec's "doc id at record time as a fast-path hint" is
  dropped: lookup is `docs.find` over open tabs, and the id would be unread data (fallow gate).
- An open doc matching `DocRef` is landed on under **its current owner** (`doc.sessionId`). Ownership
  transfers on reopen (`webview/docs.ts:43-46`), and a doc only shows under its owner.
- `applyNav` keeps its name so the `test/unit/docs.test.ts:652-668` comment stays accurate, and keeps
  dispatching `activate` in the same tick as `setActiveId` (the ordering that test guards).
- The palette's Back/Forward keep calling `goBack`/`goForward` directly, not the modal-guarded
  `navBack`/`navForward` (the palette is itself the open modal).

## Spec staleness

- **§2.4 / §3.1 "`terminal-links.ts` also consumes `pathExistsResult`"**: measured false. There is no
  consumer of `pathExistsResult` anywhere under `webview/` (recursive grep). `webview/terminal-links.ts:139`
  only mentions it in a comment. `webview/path-probe.ts` becomes the sole consumer. Correlation by
  canonical path is kept, because the host echoes `path` verbatim (`electron/main.ts:3268-3284`).
- **§7 AC1 + AC11 are inconsistent with R3 as written.** A fresh `a.ts` has its cursor on line 1.
  Moving it to line 12 by click or `setPosition` is Δ11 > 10, so R3 records `a.ts:1`. AC11's "a second
  Back is disabled" would then fail on a correct build. The plan reaches `a.ts:12` through a real
  user route that records exactly one entry: a **Search-panel hit** (`openMatch` → `openFile` with
  `reveal`). AC1/AC7/AC11/AC13/AC15 all start that way.
- **§7 "The new scenario is `test/e2e/editor-nav-history.e2e.mjs`"**: one file cannot hold AC1–AC15.
  Several ACs need a fresh history (fresh app), and `test/e2e/run-smoke.mjs:93` kills a scenario at
  210 s. The plan uses three scenario files plus one shared helper module.
- **§3 invariant "No two adjacent entries coalesce"**: holds for every push. An F1 absorb or a
  departing-entry update rewrites `stack[index]` in place and can make it coalesce with
  `stack[index-1]`. The spec also forbids an apply from restructuring the stack, so the plan does not
  collapse such entries. The unit test asserts the invariant on the push path only. See Decisions Needed.
- **§2.6 row 3 "A same-file jump calls `setPosition` and records nothing"**: still true at
  `webview/ts-nav.ts:399-405`. Under this plan R3 records it. There is no code change at that site
  (see Settled decisions).

## Global constraints

- Gate: `npm run verify` (exit code captured directly, never piped). It must be green at the end of
  Slices 2 and 3. Never disable, narrow or skip one of its checks.
- Two tsconfigs: `npm run typecheck` runs host and webview. `src/` must not import from `webview/`.
- File names are kebab-case (Biome-enforced). Types are `PascalCase`, functions `camelCase`, constants
  `SCREAMING_SNAKE`.
- **Comments: WHY only.** No restating code, no section labels. When the why lives in the spec, write
  a one-line pointer (`// see docs/specs/2026-09-22-editor-nav-history.md §2.2`). This is a hard rule.
- Fix root causes. No `as any`, `@ts-ignore`, `!important`, timing windows (`setTimeout` suppression),
  or swallowed errors. The only timeout is the spec's 2 s probe deadline.
- Unit tests run under vitest in a `node` environment (`vitest.config.*`: `include: test/unit/**/*.test.ts`),
  and CI runs them on **ubuntu**. Never depend on win32 path behaviour. Build path strings explicitly.
- E2E: build first (`npm run build`), then `node test/e2e/run-smoke.mjs <filter>`. Runs are hidden
  and **serial**, one scenario at a time, on a quiet machine. Re-run a PTY-looking failure ALONE before
  believing it. Never kill processes by name.
- Renderer↔host bridge is `window.agentDeck`. Messages go through `post`/`subscribe` from `webview/bridge.ts`.
- Do not touch `CHANGELOG.md` (the conductor owns it).

## Out of scope

Webview-guest history, arch-canvas level history, persistence, history dropdown, last-edit location,
rename tracking, position tracking through edits (clamp only), cross-window sharing.

## Contracts

### `src/nav-history.ts` (rewritten, generic, pure)

```ts
export interface NavState<E> {
  readonly stack: readonly E[];
  readonly index: number; // -1 ≤ index < stack.length; stack.length ≤ NAV_STACK_CAP
}
export const EMPTY_NAV: NavState<never> = { stack: [], index: -1 };
export const NAV_STACK_CAP = 50;

export interface NavOps<E> {
  /** Same place ignoring position — F1 ("the active doc IS the current entry"). */
  sameTarget(a: E, b: E): boolean;
  /** R4: `next` folds into `current` instead of being pushed. */
  coalesces(current: E, next: E): boolean;
  /** The entry that stands for `into` after `next` is folded in. */
  absorb(into: E, next: E): E;
}

export type ApplyResult = 'applied' | 'dead';

/** F1/F2/F3 then push(to). `from === null` is F3. */
export function record<E>(s: NavState<E>, from: E | null, to: E, ops: NavOps<E>): NavState<E>;
/** §2.3 step 0: absorb `live` into stack[index] when sameTarget, else return `s` unchanged. Never pushes/truncates. */
export function updateCurrent<E>(s: NavState<E>, live: E, ops: NavOps<E>): NavState<E>;
/** Nearest index in `dir` whose entry passes `isLive`, or -1. */
export function nextLive<E>(s: NavState<E>, dir: -1 | 1, isLive: (e: E) => boolean): number;
/** Remove stack[i]; index shifts down by one when i < index; i === index is never passed by traverse. */
export function drop<E>(s: NavState<E>, i: number): NavState<E>;
/** Step with skip-dead: apply each candidate from nextLive; 'dead' → drop and continue; 'applied' → index = that entry.
 *  No live candidate → the state with only the drops made. A rejected `apply` rejects the returned promise. */
export function traverse<E>(
  s: NavState<E>,
  dir: -1 | 1,
  isLive: (e: E) => boolean,
  apply: (e: E) => Promise<ApplyResult>,
): Promise<NavState<E>>;
export function canBack<E>(s: NavState<E>, isLive: (e: E) => boolean): boolean;   // nextLive(s,-1,…) !== -1
export function canForward<E>(s: NavState<E>, isLive: (e: E) => boolean): boolean; // nextLive(s, 1,…) !== -1
```

`record` algorithm, fixed: let `st = s`. If `from` is not null: when `st.stack[st.index]` exists and
`ops.sameTarget(cur, from)`, replace `stack[index]` with `ops.absorb(cur, from)` (F1). Otherwise
`push(from)` (F2). Then `push(to)`. `push(e)`: when the current entry exists and `ops.coalesces(cur, e)`,
replace `stack[index]` with `ops.absorb(cur, e)`. No truncation. Otherwise truncate to `index + 1`,
append, and evict from the front past `NAV_STACK_CAP`, with the index adjusted. `push` is internal
(not exported). The old exports `NavLoc`, `IsAlive`, `current`, `back`, `forward` are deleted.

### `webview/editor-nav.ts` (new, pure: no React, no runtime monaco)

```ts
import type { NavOps } from '../src/nav-history';
import type { DocKind, OpenDoc } from './docs';

export interface CursorPos { line: number; column: number } // 1-based, Monaco convention
export interface DocRef { kind: DocKind; path: string }     // path canonical for 'file' (canonicalPath)
export interface NavEntry { sessionId: string; doc: DocRef; pos?: CursorPos }

export const COALESCE_LINES = 10; // R4: within this (inclusive) folds

export function navEntryFor(doc: Pick<OpenDoc, 'kind' | 'path' | 'sessionId'>, pos?: CursorPos): NavEntry;
export function sameDoc(a: NavEntry, b: NavEntry): boolean; // sessionId + kind + path
export function coalescesEntries(a: NavEntry, b: NavEntry): boolean; // sameDoc && (!a.pos || !b.pos || |Δline| ≤ COALESCE_LINES)
export function absorbEntry(into: NavEntry, next: NavEntry): NavEntry; // next.pos ? { ...into, pos: next.pos } : into
export const EDITOR_NAV_OPS: NavOps<NavEntry>; // { sameTarget: sameDoc, coalesces: coalescesEntries, absorb: absorbEntry }
export function findOpenDoc<D extends { kind: DocKind; path: string }>(docs: readonly D[], ref: DocRef): D | undefined;

// Slice 3 (T3.1) adds:
export const JUMP_LINES = 10; // R3: a move of MORE than this records
export interface CursorMove { fromLine: number; toLine: number; edited: boolean; tagged: boolean }
export function isSignificantJump(m: CursorMove): boolean; // !edited && !tagged && |to-from| > JUMP_LINES

export function clampPos(pos: CursorPos, lineCount: number, maxColumn: (line: number) => number): CursorPos;
// line ∈ [1, lineCount]; column ∈ [1, maxColumn(line)]

export function navAnnouncement(title: string, pos?: CursorPos): string;
// pos ? `Editor: ${title}, line ${pos.line}` : `Editor: ${title}`
```

### `webview/path-probe.ts` (new)

```ts
import type { HostToWebview, WebviewToHost } from '../src/protocol';
export const PROBE_TIMEOUT_MS = 2000;
export interface ProbeTransport {
  post(msg: WebviewToHost): void;
  subscribe(cb: (msg: HostToWebview) => void): () => void;
}
/** true only for {exists: true, isDir: false} whose `path` equals canonicalPath(path); false on isDir, !exists, or no reply by timeoutMs. */
export function probePathExists(path: string, transport?: ProbeTransport, timeoutMs?: number): Promise<boolean>;
```

The default `transport` is `{ post, subscribe }` from `./bridge`. It subscribes **before** posting,
unsubscribes and clears its timer on settle, and posts `{ type: 'pathExists', path: canonicalPath(path) }`.
`HostToWebview` (`src/protocol.ts:309`) and `WebviewToHost` (`:658`) are the real union names. The
transport shape mirrors `webview/bridge.ts:53-54`.

### `webview/nav-editors.ts` (new): the editor ↔ history registry

```ts
import type * as monaco from 'monaco-editor';
import type { CursorPos } from './editor-nav';

export const NAV_REVEAL_SOURCE = 'conduit.navReveal';
export type NavEditor = Pick<
  monaco.editor.ICodeEditor,
  'getPosition' | 'setPosition' | 'revealLineInCenter' | 'focus' | 'getModel'
>;

/** Keyed by canonicalPath(path). The teardown is identity-checked (selection-registry precedent). A pending focus request for `path` is honoured on register. */
export function registerNavEditor(path: string, editor: NavEditor): () => void;
export function liveCursor(path: string): CursorPos | undefined;
/** clampPos against the model, then setPosition(pos, NAV_REVEAL_SOURCE) + revealLineInCenter(line). No focus. */
export function revealInEditor(editor: NavEditor, pos: CursorPos): void;
/** Registered editor for path → revealInEditor + focus, return true; else false. */
export function revealInNavEditor(path: string, pos: CursorPos): boolean;
/** Focus now if registered, else remember and focus on the next registerNavEditor(path). */
export function requestNavFocus(path: string): void;
// Slice 3 adds:
export type CursorJumpSink = (path: string, from: CursorPos, to: CursorPos) => void;
export function setCursorJumpSink(sink: CursorJumpSink | null): void;
export function emitCursorJump(path: string, from: CursorPos, to: CursorPos): void;
```

### `webview/use-nav-history.ts` (rewritten)

```ts
import type { RefObject } from 'react';
import type { ApplyResult, NavState } from '../src/nav-history';
import type { NavEntry } from './editor-nav';

export interface NavHistoryDeps {
  /** The active view as an entry, with the live cursor for a file; null for a Terminal tab / no doc (F3). */
  currentEntry(): NavEntry | null;
  isLive(e: NavEntry): boolean;           // sync liveness, §2.4
  apply(e: NavEntry): Promise<ApplyResult>;
}
export interface NavHistory {
  state: NavState<NavEntry>;
  recordNav(to: NavEntry): void;                 // from = deps.current.currentEntry(), read synchronously at call time
  recordJump(from: NavEntry, to: NavEntry): void;
  goBack(): void;
  goForward(): void;
}
export function useNavHistory(deps: RefObject<NavHistoryDeps>): NavHistory;
```

Internals, fixed. `stateRef` is authoritative and `useState` mirrors it for render. Every op goes
through one serial queue. An op runs **synchronously when the queue is idle**. Otherwise it chains
after the in-flight op. `recordNav` / `recordJump` read their inputs synchronously and queue
`record(stateRef.current, from, to, EDITOR_NAV_OPS)`. `goBack` / `goForward` queue
`st = updateCurrent(stateRef.current, current, OPS)` (when `currentEntry()` is non-null), then
`await traverse(st, dir, deps.current.isLive, deps.current.apply)`, then commit. A rejected apply is
logged with `log.error('nav', 'apply failed', { error: String(err) })` from `webview/log.ts`. State is
left as it was before that op, and the queue continues. All four returned functions are
referentially stable (`useCallback` with `[]` deps, reading refs).

### `webview/project-index.ts` (signature change)

```ts
export function setDefinitionOpener(fn: (absPath: string, pos: CursorPos) => void): void;
export function openDefinitionFile(absPath: string, pos: CursorPos): void;
```

Callers no longer call `setReveal` before `openDefinitionFile`. The opener owns that.

### `webview/app.tsx` (changed internal seams)

```ts
interface FileOpenNav { reveal?: CursorPos; record?: boolean } // record defaults to true
const openFile: (rawPath: string, targetSessionId?: string, mode?: OpenMode, nav?: FileOpenNav) => void;
// body order: path = canonicalPath(raw); effectiveSessionId; if (nav.record !== false) navHistory.recordNav({ sessionId, doc: { kind: 'file', path }, pos: nav.reveal });
//             if (nav.reveal) setReveal(path, nav.reveal); then the existing body unchanged.
const activateDocByUser: (id: string | null, sessionId: string) => void;
// id !== null && id !== docStateRef.current.activeId → recordNav(navEntryFor(doc)); then dispatch 'activate' as today.
const applyNav: (e: NavEntry) => Promise<ApplyResult>;
```

### `webview/docs.ts` (exports only)

Export the existing `REVIEW_DOC_PATH` and `commitDiffPath` (today module-private at lines 67 and 85).
There is no behaviour change.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Doc-activation entries (R1) | `app.tsx` `openFile`, `openDiff`, `openWeb`, `openReviewScoped`, `openReviewForSession`, `openReviewForCommit`, `setReviewSource` (range branch), `openGitHistoryTab`, `openCommitFile`, `activateDocByUser` (tab click `onSelectDoc`, `cycleTab`, `navGoToTab`); `reopenClosedTab` / `openMatch` / `jumpToHunk` / `openTerminalFileLink` / OS open / palette / recent / tree / md-link all reach `openFile`/`openDiff`/`openWeb` | `useNavHistory` → `applyNav` | Both |
| Code-jump entries (R2) | `monaco-opener.ts:37-43`, `ts-nav.ts:149-150,170-171,412-413`, `breadcrumb-bar.tsx:185-187` → `openDefinitionFile(abs,pos)` → app opener → `openFile(…,{reveal})` | same | Both |
| Big cursor moves (R3) + the "from" cursor | `code-viewer.tsx` `onDidChangeCursorPosition` → `emitCursorJump`; `liveCursor` via `registerNavEditor` | app sink → `recordJump`; `currentEntry()` | Both |
| Reveal target (`setReveal`/`takeReveal`/`subscribeReveal`) | `openFile` (now the only app-side stager besides `applyNav`), `applyNav` | `code-viewer.tsx:281-288` and `:579-588` (now `revealInEditor`, tagged), `markdown-viewer.tsx:760,776,794` (unchanged, consumes as today) | Both. markdown-viewer is unaffected: the staged value and its consumption API are unchanged, only who stages it moved |
| Session activation ordering | `applyNav` | `docsReducer` `activate`/`switchSession`, `test/unit/docs.test.ts:657` | Both. Order kept |
| Nav inputs → goBack/goForward | TopBar buttons, Alt+Arrows (`actionMap.navBack/navForward`), X1/X2 DOM (`app.tsx` ~2396), `appCommand` (`electron/main.ts:987`), palette `cmd:back`/`cmd:forward` | `navBack`/`navForward` (modal-guarded), palette → `goBack`/`goForward` directly | Consumer side only rewired. Producers unchanged: the host `app-command` forwarder and the input bindings are untouched |
| Button enabled state | `canBack/canForward(navHistory.state, isLive)` computed in app render | `TopBar` `canBack`/`canForward` props | Both |
| `pathExists` round-trip | `probePathExists` (new consumer) | host handler `electron/main.ts:3268-3284` | Consumer only. Host is a pure `statSync` read that echoes `path`; no change needed |
| `src/nav-history.ts` exports | this plan | `use-nav-history.ts`, `editor-nav.ts` (type), `app.tsx` (`canBack`/`canForward`), unit test; arch-navigation-hierarchy B (planned, no code) | Both code sides. B is satisfied by the generic core (D1) |
| `openFile` signature | `app.tsx` | `app.tsx` lines ~1506, 1520, 1531, 1560, 1607, 1616, 1660, 2163, 2181, 2467, 2483, 2989 (`onOpenFile` prop, typed `(path: string) => void` in `center-pane.tsx:113`, still compatible), 3093 | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/nav-history.ts` | rewrite | Generic stack: record/F1-F3/R4 via ops, cap, traverse with skip-dead + async apply, drop |
| `webview/editor-nav.ts` | create | Editor entry model, R4 ops, R3 predicate, clamp, announcement, open-doc lookup |
| `webview/path-probe.ts` | create | `pathExists` round-trip with 2 s deadline, path-correlated |
| `webview/nav-editors.ts` | create | Registry of main CodeViewer editors: live cursor, tagged reveal, focus request, R3 sink |
| `webview/use-nav-history.ts` | rewrite | State + serial op queue; imperative record API; Back/Forward |
| `webview/components/code-viewer.tsx` | modify | Register editor; tagged reveals at both reveal sites; R3 listener |
| `webview/project-index.ts` | modify | `openDefinitionFile(abs, pos)` / `setDefinitionOpener` signature |
| `webview/monaco-opener.ts` | modify | Pass pos to `openDefinitionFile`, drop own `setReveal` |
| `webview/ts-nav.ts` | modify | Same, at three sites |
| `webview/components/breadcrumb-bar.tsx` | modify | Same, at the symbol-jump site |
| `webview/app.tsx` | modify | Producers, `openFile` signature, `currentEntry`/`isLive`/`applyNav`, opener + sink registration, button state |
| `webview/docs.ts` | modify | Export `REVIEW_DOC_PATH`, `commitDiffPath` |
| `test/unit/nav-history.test.ts` | rewrite | Generic core tests |
| `test/unit/editor-nav.test.ts` | create | Entry-model tests |
| `test/unit/path-probe.test.ts` | create | Probe tests with a fake transport + fake timers |
| `test/unit/nav-editors.test.ts` | create | Registry tests with fake editors |
| `test/e2e/nav-history-fixture.mjs` | create | Shared fixture writer + read helpers for the three scenarios |
| `test/e2e/editor-nav-history.e2e.mjs` | create | AC1, AC7, AC11, AC13, AC15 |
| `test/e2e/editor-nav-history-moves.e2e.mjs` | create | AC2, AC5, AC6, AC12 |
| `test/e2e/editor-nav-history-lifecycle.e2e.mjs` | create | AC3, AC4, AC8, AC9, AC10, AC14 |
| `test/e2e/mouse-nav.e2e.mjs` | modify | Comment at the "terminal → a → b" line only (model changed); assertions untouched (AC16) |

## Scripts

None. The only repeated routine is fixture generation, and that is a shared e2e helper module
(`test/e2e/nav-history-fixture.mjs`), not a script.

## Slices

### Slice 1: Red-first e2e (the §2.6 measurement)

**Check:** `npm run build`, then run each alone:
`node test/e2e/run-smoke.mjs editor-nav-history-lifecycle`, `… editor-nav-history-moves`,
`… editor-nav-history` (the filter is a substring match, `test/e2e/run-smoke.mjs:65-68`, so the bare
term runs all three files). **Expected: FAIL** on this base. Record the first failing assertion per file in the task
report. If the lifecycle file's AC3/AC4 or the main file's AC1 **pass**, stop and report (spec D4:
re-read that §2.6 claim).

**Parallel groups:** Serial: T1.1

#### Task 1.1: Fixture helper + three scenarios

**Files:**
- Create: `test/e2e/nav-history-fixture.mjs`, `test/e2e/editor-nav-history.e2e.mjs`,
  `test/e2e/editor-nav-history-moves.e2e.mjs`, `test/e2e/editor-nav-history-lifecycle.e2e.mjs`
- Modify: `test/e2e/mouse-nav.e2e.mjs` (the comment "building nav history terminal → a → b" becomes
  "a → b". Nothing else.)

**Interfaces:**
- Produces (`nav-history-fixture.mjs`):
  - `makeNavFixture(extraNames = []) → string` (abs root). Writes a `tsconfig.json`
    (`{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022"},"include":["*.ts"]}`)
    plus `a.ts`, `b.ts`, `c.ts`, `x.ts` and each extra name, all ≥ 130 lines. `b.ts` line 40 is
    `export function navTarget(): number {` (body + `}` on 41–43). `a.ts` line 1 is
    `import { navTarget } from './b';` and line 12 is `export const usesTarget = navTarget();`. Every
    other line is `export const f<N> = <N>;`, unique per file (prefix N with the file stem).
  - `cursorLine(page) → number|null`. The focused (else last) `window.monaco.editor.getEditors()`
    entry's `getPosition().lineNumber`.
  - `lineVisible(page, line) → boolean` via `getVisibleRanges()`.
  - `activeTab(page) → string|null`: `.tabbar [role="tab"].tab--active span` text.
  - `waitActive(page, title)`.
  - `isPreview(page, title) → boolean` (`.tab--preview`).
  - `navDisabled(page) → { back: boolean, forward: boolean }` from `button[title="Back"]` /
    `button[title="Forward"]` `disabled`.
  - `announcement(page) → string`: `[role="status"][aria-live="polite"]` text.
  - `openViaTree` / `placeCursor` / `waitForIndexReady` are re-exported from `./goto-matrix.mjs`.
  - `openAtLineViaSearch(page, query, fileTitle, line)`: clicks the right pane's Search tab, fills
    `input[placeholder="Search in files"]`, and clicks the `.searchmatch` whose `.searchmatch__line`
    text is `String(line)` inside the `.searchgroup` whose `.searchgroup__file` is `fileTitle`. Then
    it waits for `waitActive(fileTitle)` and `cursorLine === line`, and focuses that editor through
    `page.evaluate(() => ed.focus())` (no cursor move).
  - `freshApp()`: `launchApp()` + `tapBridge`, returning `{ app, page, cleanup }`. Callers end with
    `closeApp(app, page)`.
- Consumes: `runScenario`, `launchApp`, `tapBridge`, `openSession`, `closeApp`, `assert` from
  `./harness.mjs`.

**Steps (scenario content: every AC's key assertion):**
- [ ] `editor-nav-history.e2e.mjs` (one app, one session on the fixture root, `waitForIndexReady`):
  - **Launch.** `navDisabled` = both true (AC13 launch state).
  - **AC1.** `openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12)`. Press F12, then
    `waitActive('b.ts')` and `cursorLine == 40`. `navDisabled.back == false`,
    `navDisabled.forward == true` (AC13 after one nav / at tip). Alt+ArrowLeft gives `a.ts`,
    `cursorLine == 12`, and `lineVisible(12)`. `announcement == 'Editor: a.ts, line 12'` (AC15).
    Alt+ArrowRight gives `b.ts`, line 40.
  - **AC11.** Loop 5×: Alt+Left (wait `a.ts`), then Alt+Right (wait `b.ts`). `navDisabled.forward == true`.
    Alt+Left gives `a.ts`, and then `navDisabled.back == true`. Alt+Right back to `b.ts`.
  - **AC13.** Each of these performs the return `b.ts:40 → a.ts:12`, followed by Alt+Right back:
    click `button[title="Back"]`; palette (`Control+Shift+P` or the bound `openCommands` combo from
    settings defaults), type `Go back`, Enter; `app.evaluate(({BrowserWindow}) =>
    BrowserWindow.getAllWindows()[0].emit('app-command', { preventDefault() {} }, 'browser-backward'))`
    when `process.platform === 'win32'`; otherwise dispatch a button-3 `auxclick` on `document.body`.
  - **AC15 focus.** At `b.ts`, click the terminal tab button and focus the xterm textarea. Click
    `button[title="Back"]`. `document.activeElement.closest('.monaco-editor')` is non-null, and
    `announcement` reads `Editor: a.ts, line 12`.
  - **AC7.** Alt+Right to `b.ts`. Close the `a.ts` tab if present (middle-click its tab. If it was
    already replaced as a preview tab, it is absent. Assert absence either way). Alt+Left gives
    `a.ts` active, `isPreview('a.ts') == true`, `cursorLine == 12`.
- [ ] `editor-nav-history-moves.e2e.mjs` (one app, one session; per-case files from
  `makeNavFixture(['m2x.ts','m2a.ts','m5x.ts','m5a.ts','m6x.ts','m6a.ts','m12x.ts','m12a.ts','m12b.ts','m12c.ts'])`,
  so earlier cases' entries can't satisfy a later assertion):
  - **AC2.** Tree-open `m2x.ts`, then `m2a.ts`. Click line 5 (the `.view-line` at index 4 via its
    bounding box). Press Control+End (`cursorLine ≥ 120`). Alt+Left gives `m2a.ts`, line 5, visible.
    Alt+Left gives `m2x.ts`.
  - **AC5.** Tree-open `m5x.ts`, then `m5a.ts` (line 1). Real mouse clicks on lines 8, 14, 20.
    Alt+Left gives `m5x.ts`. Alt+Right gives `m5a.ts`, `cursorLine == 20`.
  - **AC6.** Tree-open `m6x.ts`, then `m6a.ts`. Press ArrowDown ×30. Alt+Left gives `m6x.ts`.
  - **AC12.** Tree-open `m12x`, `m12a`, `m12b`, `m12c` (`.ts`). Fire three Alt+Left presses with no
    awaits between them (`Promise.all` of three `page.keyboard.press` calls is still serialized by
    Playwright, so instead use one `page.evaluate` dispatching three `keydown` Alt+ArrowLeft events
    on `window`). `waitActive('m12x.ts')`. Alt+Right gives `m12a.ts`.
- [ ] `editor-nav-history-lifecycle.e2e.mjs`:
  - App 1 (the `runScenario` app). Open S1 and S2 on one fixture root
    (`makeNavFixture(['l4a.ts','l4b.ts','l8a.ts','l8b.ts','l8c.ts','l14a.ts','l14b.ts'])`).
    - **AC3.** `navDisabled.back` is true. Activate S1 (sidebar click). Tree-open `a.ts`. Activate
      S2, then S1, via the sidebar. `navDisabled.back` is still true. Tree-open `b.ts`. Alt+Left
      gives `a.ts`, and the active session is S1. `navDisabled.back` is true.
    - **AC4.** Tree-open `l4a.ts`. Click the Terminal tab. Tree-open `l4b.ts`. Alt+Left gives
      `l4a.ts` (the active tab is a doc, not the terminal).
    - **AC8.** Tree-open `l8a`, `l8b`, `l8c`. Close the `l8b.ts` tab and `fs.unlinkSync` it.
      Alt+Left gives `l8a.ts`. Alt+Right gives `l8c.ts`.
    - **AC14.** Tree-open `l14a.ts`, then `l14b.ts`. Open the Board (center view switch). Alt+Left
      shows the editor (the tabbar is visible) with `l14a.ts` active.
  - App 2 (`freshApp()`), S1 and S2:
    - **AC9.** In S1, tree-open `b.ts`, then `a.ts`. Activate S2. Tree-open `c.ts`. Alt+Left gives
      the active session S1 with `a.ts` active.
    - **AC10.** Alt+Right gives `c.ts` (S2). Post `{type:'kill', id: S1}` and wait until S1 is
      gone from `window.__sessions`. Then either `navDisabled.back == true`, or Alt+Left lands on an
      S2 doc. It never lands on `a.ts`/`b.ts`.
- [ ] Run the check. Expect FAIL (behavior absent). Commit nothing red to CI-gated paths: the e2e
  suite is outside `npm run verify`.

### Slice 2: The new model, doc-level recording, apply with cursor restore

**Check:** `npm run verify` green, then `npm run build` and, serially:
`node test/e2e/run-smoke.mjs editor-nav-history-lifecycle` (AC3, AC4, AC8, AC9, AC10, AC14 pass),
`node test/e2e/run-smoke.mjs editor-nav-history-moves` (AC5, AC6, AC12 pass. AC2 may still fail: R3
lands in Slice 3), `node test/e2e/run-smoke.mjs mouse-nav`, `node test/e2e/run-smoke.mjs shortcut-precedence`.

**Parallel groups:** G1: T2.1 · G2: T2.2 · G3: T2.3 · G4: T2.4 · Serial: T2.5 → T2.6 → T2.7
**Claims (serial lane):** `webview/app.tsx`, `webview/docs.ts`

The typecheck and fallow gate stay red from T2.1 until T2.7 lands (the old hook consumes the deleted
exports). Per-task checks in G1–G4 are their vitest files only.

#### Task 2.1: Generic stack

**Files:** Modify (rewrite) `src/nav-history.ts`; Test (rewrite) `test/unit/nav-history.test.ts`

**Interfaces:** Produces everything under Contracts → `src/nav-history.ts`. Tests use a local
`NavOps<{ id: string; n?: number }>` (sameTarget = id equal; coalesces = same id and
(`n` absent or |Δn| ≤ 2); absorb = `n` from next when present).

**Steps:**
- [ ] Failing tests, each named for its behavior:
  - 'record with a null from pushes only the target': `stack.length == 1`, `index == 0`.
  - 'F1 absorbs from into the current entry': the current `{id:'a',n:1}` with from `{id:'a',n:9}`
    gives `stack[0].n == 9`, then the target is pushed.
  - 'F2 pushes from when it is not the current entry'.
  - 'a coalescing target replaces the current entry and keeps forward history': the forward entries
    are still present and `index` is unchanged.
  - 'a non-coalescing target truncates forward history'.
  - 'push never leaves two adjacent coalescing entries'.
  - 'cap evicts the oldest': 60 records give `stack.length == NAV_STACK_CAP` and the first id is the 11th.
  - 'updateCurrent never pushes or truncates'.
  - 'nextLive skips dead entries in both directions'.
  - 'drop before the index shifts the index down'.
  - 'traverse drops dead entries and lands on the next applied one': with the apply returning 'dead'
    for one id, the result has that id removed and the index on the landed entry, in both directions.
  - 'traverse with nothing live returns the state with only drops'.
  - 'canBack/canForward respect isLive'.
- [ ] `npx vitest run test/unit/nav-history.test.ts`: FAIL (exports missing).
- [ ] Implement to the contract.

#### Task 2.2: Editor entry model

**Files:** Create `webview/editor-nav.ts`; Test `test/unit/editor-nav.test.ts`

**Interfaces:** Produces the Contracts → `webview/editor-nav.ts` block. Consumes
`NavOps<E>` (type) from `src/nav-history.ts`, `DocKind`/`OpenDoc` (types) from `webview/docs.ts`.

**Steps:**
- [ ] Failing tests:
  - 'coalesces within 10 lines': Δ10 true, Δ11 false.
  - 'a pos-less side always coalesces in the same doc'.
  - 'different session or kind or path never coalesces'.
  - 'absorbEntry keeps the old pos when the new entry has none'.
  - 'clampPos clamps past-EOF line and past-EOL column'.
  - 'navAnnouncement with and without a line'.
  - 'findOpenDoc matches a pinned commit-diff by kind+path'.
  - 'record with EDITOR_NAV_OPS: F1/F2/F3' end-to-end through `src/nav-history.ts#record` (AC17 F-rules).
- [ ] `npx vitest run test/unit/editor-nav.test.ts`: FAIL (module missing).
- [ ] Implement.

#### Task 2.3: Path probe

**Files:** Create `webview/path-probe.ts`; Test `test/unit/path-probe.test.ts`

**Interfaces:** Produces `probePathExists`, `PROBE_TIMEOUT_MS`, `ProbeTransport` (Contracts).
Consumes `canonicalPath` from `webview/project-index.ts`. That module imports `monaco-editor` at
runtime, so the test must `vi.mock('monaco-editor', …)` as `test/unit/nav-failure.test.ts:34` does.

**Steps:**
- [ ] Failing tests (fake transport, `vi.useFakeTimers()`):
  - 'resolves true for a matching file reply'.
  - 'resolves false for isDir'.
  - 'ignores a reply for another path'.
  - 'resolves false after PROBE_TIMEOUT_MS with no reply'.
  - 'unsubscribes after settling': the subscriber count is 0.
  - 'subscribes before posting': a transport that replies synchronously inside `post` still resolves true.
- [ ] `npx vitest run test/unit/path-probe.test.ts`: FAIL.
- [ ] Implement.

#### Task 2.4: Editor registry (reveal/focus/live cursor)

**Files:** Create `webview/nav-editors.ts` (everything in its Contracts block **except** the three
Slice-3 sink exports); Test `test/unit/nav-editors.test.ts`

**Interfaces:** Produces `NAV_REVEAL_SOURCE`, `NavEditor`, `registerNavEditor`, `liveCursor`,
`revealInEditor`, `revealInNavEditor`, `requestNavFocus`. Consumes `CursorPos`, `clampPos` from
`webview/editor-nav.ts`, and `canonicalPath` from `webview/project-index.ts` (mock `monaco-editor` in
the test as in T2.3).

**Steps:**
- [ ] Failing tests with a fake `NavEditor` recording calls:
  - 'revealInEditor tags setPosition with NAV_REVEAL_SOURCE': the second arg `=== NAV_REVEAL_SOURCE`.
  - 'revealInEditor clamps to the model': line 999 on a 50-line model gives 50.
  - 'liveCursor reads the registered editor'.
  - 'stale teardown does not unregister a newer editor'.
  - 'requestNavFocus before register focuses on register'.
  - 'revealInNavEditor returns false when nothing is registered'.
- [ ] `npx vitest run test/unit/nav-editors.test.ts`: FAIL.
- [ ] Implement.

#### Task 2.5: Hook rewrite

**Files:** Modify (rewrite) `webview/use-nav-history.ts`

**Interfaces:**
- Produces `NavHistoryDeps`, `NavHistory`, `useNavHistory(deps: RefObject<NavHistoryDeps>): NavHistory`
  (Contracts).
- Consumes from `src/nav-history.ts`: `EMPTY_NAV`, `record`, `updateCurrent`, `traverse`,
  `NavState<E>`, `ApplyResult`. From `webview/editor-nav.ts`: `EDITOR_NAV_OPS`, `NavEntry`. From
  `webview/log.ts`: `log`.

**Call sites:** `webview/app.tsx:2365` (the only caller; rewired in T2.7).

**Steps:**
- [ ] No unit harness exists for hooks (vitest `environment: 'node'`, no React renderer). The proof is
  AC11/AC12 in e2e plus T2.1's `traverse` tests. The queue semantics are fixed in Contracts.
- [ ] Implement.

#### Task 2.6: CodeViewer registers and tags its reveals

**Files:** Modify `webview/components/code-viewer.tsx` (mount effect ~lines 279-288 and teardown;
live-reveal effect ~577-589)

**Interfaces:** Consumes `registerNavEditor`, `revealInEditor` from `webview/nav-editors.ts`.

**Steps:**
- [ ] Replace the onMount reveal's `setPosition` + `revealLineInCenter` with `revealInEditor(editor, pos)`.
  Keep the saved-view-state `else` branch.
- [ ] Replace the live-subscribe reveal's `setPosition` + `revealLineInCenter` with
  `revealInEditor(ed, pos)`. Keep `ed.focus()`.
- [ ] `registerNavEditor(doc.path, editor)` in the mount effect, torn down with the editor's other
  disposables.
- [ ] Check: no unit suite imports `code-viewer.tsx` (grep of `test/unit`: none). The proof is
  `npm run typecheck` here and the Slice 2 e2e (AC5 departing cursor, AC7-style reveal on reopen).

#### Task 2.7: App wiring (serial lane; owns `webview/app.tsx`, `webview/docs.ts`)

**Files:** Modify `webview/app.tsx`, `webview/docs.ts` (export `REVIEW_DOC_PATH`, `commitDiffPath`)

**Interfaces:**
- Consumes: `useNavHistory`, `NavHistoryDeps`, `NavHistory` (T2.5); `canBack`, `canForward`,
  `ApplyResult` (T2.1); `NavEntry`, `CursorPos`, `navEntryFor`, `findOpenDoc`, `navAnnouncement`
  (T2.2); `probePathExists` (T2.3); `liveCursor`, `revealInNavEditor`, `requestNavFocus` (T2.4).
- Produces: `FileOpenNav`, the new `openFile` signature, `activateDocByUser`, `applyNav` (Contracts →
  app.tsx).

**Call sites** (`openFile`, by current line): 1506 reopen-closed (unchanged), 1520 `openMatch` and
1531 `jumpToHunk` (drop their `setReveal`, pass `{ reveal: { line, column } }`), 1560
`openTerminalFileLink` (drop `setReveal`, pass `reveal` only when `line !== undefined`), 1607 plan
toast (unchanged), 1616 definition opener (unchanged in this slice), 1660 OS open (unchanged,
records), 2163 `onFileRenamed` (pass `{ record: false }`: automatic, spec A6), 2181, 2467, 2483, 2989,
3093 (unchanged).

**Steps:**
- [ ] Create `navDepsRef = useRef<NavHistoryDeps>(…)` and call
  `const navHistory = useNavHistory(navDepsRef)` next to `navLiveRef` (~line 714), **before**
  `actionMap` and `openFile`, so every producer can reach `navHistory.recordNav`. Assign
  `navDepsRef.current = { currentEntry, isLive, apply: applyNav }` right after `applyNav` is declared
  (the `closeDocRef.current = closeDoc` precedent).
- [ ] `currentEntry()`: the doc with id `docStateRef.current.activeId`, else null. For a `file` doc,
  `navEntryFor(doc, liveCursor(doc.path))`. Otherwise `navEntryFor(doc)`.
- [ ] `isLive(e)`: `sessions.some(s => s.id === e.sessionId) && (e.doc.kind === 'file' || findOpenDoc(docState.docs, e.doc) !== undefined)`.
- [ ] `applyNav(e)` (`useCallback`, reads refs):
  - When `findOpenDoc(docStateRef.current.docs, e.doc)` gives `doc`: `wasActive = doc.id === docStateRef.current.activeId && doc.sessionId === activeIdRef.current`.
    Dispatch `activate {id: doc.id, sessionId: doc.sessionId}`. When
    `doc.sessionId !== activeIdRef.current`, call `setActiveId(doc.sessionId)`. Call `setCenterView('editor')`.
  - For `doc.kind === 'file'` with `e.pos`: when `wasActive`, `revealInNavEditor(doc.path, e.pos)`.
    Otherwise `setReveal(doc.path, e.pos)` and `requestNavFocus(doc.path)`.
  - For `doc.kind === 'file'` without `e.pos`: `requestNavFocus(doc.path)`.
  - Announce `navAnnouncement(doc.title, e.pos)` into `navLiveRef` and return `'applied'`.
  - With no open doc: a non-`file` kind returns `'dead'`. Otherwise
    `if (!(await probePathExists(e.doc.path))) return 'dead'`. Re-check that the session is still in
    `sessions` (via a ref, since `sessions` may have changed during the await) and return `'dead'`
    when it is gone. Then `setCenterView('editor')`,
    `openFile(e.doc.path, e.sessionId, 'preview', { reveal: e.pos, record: false })`,
    `requestNavFocus(e.doc.path)`, announce `navAnnouncement(baseName(e.doc.path), e.pos)`, and return `'applied'`.
- [ ] `openFile`: the new signature and body order from Contracts. Record **before** `setReveal`.
- [ ] Record at: `openDiff` (`{kind:'diff', path}` under `effectiveSessionId`), `openWeb`
  (`{kind:'web', path:url}`), `openReviewScoped`/`openReviewForSession`/`openReviewForCommit`/the
  `setReviewSource` range branch (`{kind:'review', path: REVIEW_DOC_PATH}` under the session each
  one opens in), `openGitHistoryTab` (`{kind:'git-history', path: GIT_HISTORY_DOC_PATH}`), and
  `openCommitFile` (`{kind:'commit-diff', path: commitDiffPath(sha, file)}`). Each records **before**
  its dispatch.
- [ ] `activateDocByUser(id, sessionId)` replaces the raw `activate` dispatch in: `actionMap`'s
  `activate` helper (used by `cycleTab`, ~line 789), `navGoToTab` (~947), and `onSelectDoc` (~2976).
  The Terminal (`id === null`) never records.
- [ ] Delete the old `isAlive`, the old `applyNav` body, and the `NavLoc` import. `navBack`/`navForward`
  wrap `navHistory.goBack`/`goForward` as today. The palette `cmd:back`/`cmd:forward` `run` stay on the
  unguarded `navHistory.goBack`/`goForward`. `TopBar` gets
  `canBack={canBack(navHistory.state, isLive)}` / `canForward={canForward(navHistory.state, isLive)}`.
- [ ] Run the slice check.

### Slice 3: Code jumps (R2 with position) and big cursor moves (R3)

**Check:** `npm run verify` green, then `npm run build` and, serially:
`node test/e2e/run-smoke.mjs editor-nav-history` (all three files green: AC1–AC15),
`node test/e2e/run-smoke.mjs goto-matrix-firstparty`, `… goto-index`, `… mouse-nav`,
`… shortcut-precedence`, `… find-widget`, `… markdown-search`.

**Parallel groups:** G1: T3.1 · G2: T3.2 · Serial: T3.3
**Claims (serial lane):** `webview/app.tsx`

#### Task 3.1: R3 detection (registry sink + CodeViewer listener)

**Files:** Modify `webview/editor-nav.ts` (add `JUMP_LINES`, `CursorMove`, `isSignificantJump`),
`webview/nav-editors.ts` (add the sink exports), and `webview/components/code-viewer.tsx` (mount
effect, beside the breadcrumb `cursorSub` ~line 391); Test `test/unit/editor-nav.test.ts` and
`test/unit/nav-editors.test.ts` (extend both)

**Interfaces:**
- Produces: `JUMP_LINES = 10`,
  `interface CursorMove { fromLine: number; toLine: number; edited: boolean; tagged: boolean }`, and
  `isSignificantJump(m: CursorMove): boolean` (`!edited && !tagged && |toLine - fromLine| > JUMP_LINES`)
  in `webview/editor-nav.ts`. Also `CursorJumpSink`,
  `setCursorJumpSink(sink: CursorJumpSink | null): void`, and
  `emitCursorJump(path: string, from: CursorPos, to: CursorPos): void` in `webview/nav-editors.ts`.
- Consumes: `CursorPos` (`webview/editor-nav.ts`); `NAV_REVEAL_SOURCE` (`webview/nav-editors.ts`).

**Steps:**
- [ ] Failing tests:
  - 'isSignificantJump': Δ11 true, Δ10 false, `edited` gives false, `tagged` gives false.
  - 'emitCursorJump reaches the registered sink and is a no-op with none'.
- [ ] `npx vitest run test/unit/editor-nav.test.ts test/unit/nav-editors.test.ts`: FAIL. Implement both.
- [ ] In the mount effect, **after** the reveal/restore block and after `registerNavEditor`, seed
  `last = { pos: editor.getPosition() → CursorPos, versionId: model.getVersionId() }`. Subscribe to
  `editor.onDidChangeCursorPosition(e)`:
  - `edited = model.getVersionId() !== last.versionId || EDIT_REASONS.has(e.reason)`, where
    `EDIT_REASONS` is the set of `monaco.editor.CursorChangeReason` `ContentFlush`,
    `RecoverFromMarkers`, `Paste`, `Undo`, `Redo`.
  - `tagged = e.source === NAV_REVEAL_SOURCE`.
  - When `isSignificantJump({ fromLine: last.pos.line, toLine: e.position.lineNumber, edited, tagged })`,
    call `emitCursorJump(doc.path, last.pos, next)`.
  - Always advance `last`.
  - Dispose it with the others.

#### Task 3.2: `openDefinitionFile` carries the position

**Files:** Modify `webview/project-index.ts` (`setDefinitionOpener`/`openDefinitionFile`),
`webview/monaco-opener.ts` (lines 37-43), `webview/ts-nav.ts` (149-150, 170-171, 412-413),
`webview/components/breadcrumb-bar.tsx` (185-187)

**Interfaces:**
- Produces: `setDefinitionOpener(fn: (absPath: string, pos: CursorPos) => void): void`,
  `openDefinitionFile(absPath: string, pos: CursorPos): void`.
- Consumes: `CursorPos` (type) from `webview/editor-nav.ts`.

**Call sites:** `openDefinitionFile` at `webview/monaco-opener.ts:42`, `webview/ts-nav.ts:150`, `:171`,
`:413`, `webview/components/breadcrumb-bar.tsx:187`. `setDefinitionOpener` at `webview/app.tsx:1616`
(T3.3) and `test/unit/nav-failure.test.ts:191` (a `(p) => …` callback, still assignable. Unchanged.
It must stay green).

**Steps:**
- [ ] At each call site, delete the preceding `setReveal(x, pos)` and pass `pos` as the second
  argument. Remove `setReveal` from each file's import when it becomes unused (fallow and Biome will
  flag it otherwise).
- [ ] `npx vitest run test/unit/nav-failure.test.ts`: green.

#### Task 3.3: App registers the opener and the R3 sink (serial lane)

**Files:** Modify `webview/app.tsx` (the effect at ~1615-1629)

**Interfaces:** Consumes `setCursorJumpSink` (T3.1); the new `setDefinitionOpener` (T3.2);
`openFile(…, { reveal })` and `navHistory.recordJump` (Slice 2); `navEntryFor`.

**Steps:**
- [ ] `setDefinitionOpener((abs, pos) => openFileRef.current(abs, undefined, 'preview', { reveal: pos }))`.
- [ ] `setCursorJumpSink((path, from, to) => { … })`. Find the open `file` doc for
  `canonicalPath(path)` in `docStateRef.current.docs`. When absent, return (a CodeViewer outside a tab
  is not an entry). Otherwise call
  `navHistory.recordJump(navEntryFor(doc, from), navEntryFor(doc, to))`. Clear it with
  `setCursorJumpSink(null)` in the effect cleanup.
- [ ] Run the slice check.

## Verification

- Per task: the task's own `npx vitest run <file>` (exit code read directly).
- Per slice: Slice 1 is the red e2e run. Slices 2 and 3 run `npm run verify` (must exit 0), then
  `npm run build` and the listed e2e scenarios **one at a time, hidden, serial**. Do not fan out.
- Before handoff (merged branch): `npm run verify`, then the full smoke suite once
  (`node test/e2e/run-smoke.mjs`) as the cross-feature regression check. Re-run any PTY-flavoured
  failure alone before treating it as real.
- `git status` must show only this plan's files before each commit.

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked signature
doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. Examples that trigger it here:

- Monaco not carrying `setPosition`'s `source` into `ICursorPositionChangedEvent.source` at runtime
  (the d.ts says it does: `editor.api.d.ts:2728`, `:3123`).
- A reveal consumer this plan didn't list.
- An `openFile` caller that must not record but isn't listed.

The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [normal] Invariant "no two adjacent entries coalesce" is guaranteed on push only. F1 absorb and the
  departing-entry update can make `stack[index]` coalesce with `stack[index-1]` (e.g. `[a:5, a:30]`,
  arrow back to line 12, then navigate). **Default taken:** leave them. Back steps to a nearby line
  once. Collapsing would restructure the stack during an apply, which the spec forbids.
- [normal] `currentEntry()` reads `docStateRef`, which updates on render. Two producer calls inside one
  frame (before React commits the first activation) read a stale "from" and can push a duplicate
  entry. **Default taken:** accept. Human input is frames apart, and every e2e step waits for its
  landing. The fix, if it shows up, is a synchronous docs mirror at `dispatchDocs`, not a timing window.
- [normal] Spec §5 "focus the doc viewer" for **doc entries** (diff, review, web, …): these viewers
  have no common focus target. **Default taken:** a doc entry moves no focus. Text entries focus the
  editor (AC15).
- [normal] An open doc that matches a `DocRef` but is now owned by another live session lands under
  its **current owner**, not the entry's recorded session. **Default taken:** as stated (a doc only
  shows under its owner).
- [normal] AC1/AC11 are reached via a Search-panel hit rather than "set the cursor to line 12", and
  the scenario is split into three files. See Spec staleness. **Default taken:** as planned.
