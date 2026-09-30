# Dirty-editor quit guard — implementation plan

**Spec:** `docs/specs/2026-09-28-dirty-quit-guard.md`  **Tier:** FULL

## Goal

Quit, window close, update relaunch, session close and session move never drop a dirty buffer
unless the user picks **Don't Save**. Each window shows at most one dialog per attempt, and it
folds in the running-session warning.

## Architecture

The work splits into two halves, joined by a five-message protocol with a `requestId`.

1. **Host guard.** `src/close-guard.ts` exports `createCloseGuard(deps)`, a pure state machine
   injected with a clock, a window list, send, the native box and the proceed callbacks. It
   decides who is asked, in what order and for how long, and what proceed or cancel means.
   - It sits beside `createQuitGrant`, a one-shot grant with a 5 s TTL that lets exactly one
     `before-quit` through.
   - `electron/main.ts` only wires Electron events into the guard and runs today's teardown once,
     behind the grant.
2. **Renderer.** `webview/quit-responder.ts` exports `createQuitResponder(deps)`, pure with
   injected deps. It turns one `confirmQuit` into ack → flush → decide → dialog → settle → decision.
   - `webview/unsaved-files.ts` holds the pure rules: tags, saveability, what Save All writes and
     with which kind.
   - `webview/use-dirty-close.ts` owns the one dirty dialog as a promise-returning `ask()`. The
     quit responder and the session close/move gates both use it.
   - `src/quit-guard.ts` gains the copy function `dirtyCloseCopy`.
   - `webview/use-modal-slot.ts` is the **one modal slot**. Every confirm (all 12 `setConfirm`
     sites) and the dirty dialog open through it. **Opening a new entry settles the entry it
     displaces as Cancel**, through that entry's `onCancel`:
     - a displaced quit ask posts `quitDecision{proceed:false}`;
     - a displaced `closeDoc` confirm resolves `false`;
     - a displaced hunk confirm resolves `false`.
     This makes the "Terminal exited" auto-confirm, or any other confirm opened while a quit
     dialog is up, answer that ask instead of orphaning it (critic B1).
   - `webview/app.tsx` is glue only.
3. **Belt against a lost ask (B1b).** A repeat close/quit trigger while a window's ask is
   `shown` makes the host re-send that window's `confirmQuit` with the **same** `requestId`. The
   renderer re-focuses its live dialog for that id, or answers `proceed:false` if it has none.
4. **Durability (B2, B3).**
   - An unguarded `before-quit` runs `flushStateSync()` **before** `preventDefault()`. Teardown
     still runs it too; it is an idempotent atomic snapshot.
   - Each window's `session-end` also calls `flushStateSync()`.
   - The Electron `beforeunload` save-all **stays** as the backstop for every path where the
     guard gives up: no ACK, 12 s silence, and "Close anyway". It is skipped only when this
     window's responder recorded `discarded` (Don't Save).

Dirty state is **per path** (`webview/dirty-store.ts` `getDirtySnapshot()`, the
`webview/file-saves.ts` singleton). Nothing here is keyed by tab or group, so split-editor's
`layouts[s].groups[g]` restructure is orthogonal. Where a session's files are needed, the plan
uses `filePathsClosedWithSession(docs, sessionId)` from `webview/docs.ts`, which split-editor
keeps.

## Data flow

```
 trigger                               HOST (electron/main.ts → src/close-guard.ts)
 ─────────────────────────────────────────────────────────────────────────────────────
 ✕ last window ─ onWindowClose: preventDefault; app.quit() ─┐
 app.quit() / electron-updater ─────────────► before-quit ──┤ grant.consume()?
                                                            │   no  → flushStateSync(); preventDefault;
                                                            │         guard.requestAppQuit('quit')
                                                            │   yes → tornDown=true; isQuitting=true;
                                                            │         today's teardown (once)
 ✕ non-last window ─ onWindowClose: preventDefault ─────────┼► guard.requestWindowClose(id)
 updateRelaunch (IPC) ──────────────────────────────────────┴► guard.requestAppQuit('update', sender)

 guard: for each window in order → deps.ask(id,{requestId,reason,running,busy})
        main maps ask → send 'confirmQuit'
                        │                                   ▲ handle(): quitAck / quitDialogShown /
                        ▼                                   │ quitDecision → guard.onAck/onShown/onDecision
 RENDERER (quit-responder)                                  │
   same requestId as the live flow? → re-focus its dialog, or post proceed:false (belt, B1b)
   post quitAck ─────────────────────────────────────────── ┤
   (any dialog it opens goes through the modal slot → a displaced entry settles as Cancel)
   autoSave≠off → toasts off; race(flushAll, 5 s)           │
   paths = getDirtySnapshot()                               │
     ∅ & running=0 → proceed                                │
     ∅ & running>0 → session dialog (onShown → quitDialogShown)
     dirty → useDirtyClose.ask → DirtyCloseDialog (onShown → quitDialogShown)
                Save All → saveUnsaved(files) → all clean? proceed : re-render unsaved rows
   proceed → race(whenIdle, 5 s) → [quit|update: QuitScrim on] → post quitDecision ──┘

 guard, all windows proceed → proceedApp(reason) → main: grant.issue();
     'quit' → setImmediate(app.quit) | 'update' → quitAndInstall()
 grant not consumed in 5 s → onExpire → guard.unlockAnswered() → 'quitAborted' → scrim off
 any window Cancel → guard sends abort to the windows that already proceeded → 'quitAborted'
 guard times out on a window (3 s / 12 s) → abort(id) to it too (S2); renderer ends that flow, no lock
 Don't Save → responder.discarded=true → beforeunload skips the save-all; otherwise the save-all
   runs on unload as the backstop for every give-up path (B3)

 session close / move (renderer only): requestKill / closeSessions / exited-warn / move entries
   → guardSessionRemoval(ids, reason, then) → sessionDirtyPaths ≠ ∅ ? useDirtyClose.ask : then()
```

## Settled decisions — do not re-litigate

The spec's D1–D14 are locked at their defaults, with one conductor condition on D3.

- **D1.** Multi-window quit asks one window at a time, focused (or sender) first. Any Cancel
  aborts. Windows that already answered sit behind the "Quitting…" scrim until the quit ends.
- **D2, amended by the critic (B3).**
  - The `beforeunload` save-all **stays** under Electron as the backstop for every guard give-up
    path: no ACK in 3 s, 12 s silence, "Close anyway", and window destroyed.
  - It is skipped **only** when the responder's `discarded` flag is set. Don't Save sets it; a
    new ask or a `quitAborted` for that request clears it.
  - The browser preview is unchanged. The spec's D2 is amended to match.
- **D3, with the conductor condition.** Save All **force**-writes a path only when that path's
  **displayed row** is tagged `conflict`, whose copy is "changed on disk — Save All overwrites it".
  Every other saveable row gets a `manual` save.
  - A path that enters conflict after the dialog rendered is not tagged yet. Its `manual` save
    fails (C11), and the dialog re-renders with that row tagged `conflict`. Only a second Save All
    force-writes it.
- **D4.** Files that are dirty but were never edited are listed with the tag "not edited", and
  they are saveable.
- **D5.** A renderer that goes unresponsive while its dialog is shown gets a native
  **Wait** / **Close anyway** box, default Wait.
- **D6.** No hot exit.
- **D7.** Timeouts:

  | Timeout | Value |
  |---|---|
  | Flush | 5 s |
  | Post-ACK | 12 s |
  | Write-settle | 5 s |
  | Grant | 5 s |
  | ACK liveness | 3 s |

- **D8.** OS shutdown and logoff are not guarded.
- **D9.** In the dirty dialog, initial focus is on Save All. The session-only dialog keeps Cancel.
- **D10.** Protocol: `requestId` is added to `confirmQuit`, `quitDialogShown` and `quitDecision`.
  `quitAck` and `quitAborted` are added.
- **D11.** Gate only the renderer `kill` and `session:move`/`session:dragEnd` producers. Grounding
  measured that these are the only renderer-initiated removals. The host-side window close already
  goes through the guard.
- **D12.** Enter activates only the focused button.
- **D13.** Truncated paths and paths with no save entry cannot be saved from the guard. The only
  ways past them are Don't Save and Cancel.
- **D14.** Plan-comment and review-note drafts are not guarded.
- **Critic locks (conductor, 2026-09-28).** Each is also amended into the spec.

  | Lock | Decision |
  |---|---|
  | B1a | One modal slot for every confirm and the dirty dialog. Replacing an entry settles the displaced one as Cancel. |
  | B1b | A repeat trigger re-probes a `shown` ask with the same `requestId`. |
  | B2 | `flushStateSync()` runs before `preventDefault()` in the no-grant `before-quit`. A `session-end` flush is added. |
  | S1 | The drag-end "stayed inside" test uses the window rect inset by `DRAG_STAY_INSET_PX = 8`, so edge drops prompt. |
  | S2 | A window the host timed out on gets `quitAborted`. The responder ends that flow and never locks. |
  | S4 | Window closes queue like updates, rather than being focus-only. A queued close that finds itself the last window becomes an app quit. |
  | Nits | `AbortSignal` on the unresponsive box. A non-last window close whose sibling vanished mid-guard becomes an app quit, so its sessions are kept for restore. |

- **Slice 1 is a hard gate.** If spec assumption A1 measures false (Electron does not re-emit
  `before-quit` on a later `app.quit()` after `preventDefault`), stop the run and report. Every
  later slice depends on it.

## Spec staleness

Every C-claim that grounding could check against source held. Two findings add to the spec:

- **C6 extended.** A non-last window whose sessions are all exited closes today **without
  disposing** those sessions (`electron/main.ts` `onWindowClose`, early return on
  `!needsQuitConfirm(owned)`). Under this plan every closing window goes through the guard, and on
  proceed its owned sessions are disposed, exited ones included. That is intended; the plan does
  not preserve the leak.
- **C9 has a second half.** `ConfirmDialog`'s primary and secondary buttons both call `onClose`,
  and `app.tsx` wires `onClose` to the quit-cancel ref. Today's quit `onConfirm` clears that ref by
  hand to avoid a double reply. The plan replaces both side refs (`quitCancelRef` and
  `hunkConfirmRef`) with `ConfirmState.onCancel`, which only the cancel paths and a displacement
  call.
- **The spec's single-slot note undercounts.** The spec's §4 counts one displaced confirm. There
  are 12 `setConfirm(` openers in `webview/app.tsx`:
  - :477, :538, :649 (exit warn, automatic), :1634 (hunk), :1713 (closeDoc)
  - :2184, :2211, :2592, :2605, :2777, :2787, :2804

  Plus one `setConfirm(null)`. None of them settles what it overwrites. B1a routes all of them
  through the slot.
- **Measured true:** C9, C11, C12, D11's producer list, `quitDialogShown` being posted before
  `setConfirm` rather than after paint, and `FileSaves` having no in-flight query and no toast
  switch.
- **Still to measure:** A1 in Slice 1. A2 (the electron-updater install path) is covered by the
  unit-pinned ordering. In an unpackaged e2e `quitAndInstall` doesn't quit, and the grant-expiry
  unlock is the observable. A3 is pinned by a controller unit test in Task 2.2.

## Global constraints

- **Gate:** `node G:/awby/projects/conduit/.autoloop/heavy-lock.mjs <cwd> npm run verify`, run
  **once** at the end (Slice 6). Capture the exit code directly (`; echo EXIT=$?`), never through
  `| tail`.
- **While building:** run the related unit files (`npx vitest run test/unit/<file>.test.ts`) plus
  `npm run typecheck` after each task that touches types. Both tsconfigs are checked.
- **e2e:** run only the touched scenarios, alone and serially:
  `node test/e2e/run-smoke.mjs <substring>`, after `npm run build`. The app runs hidden
  (`CONDUIT_E2E=1`); never call `show()` in e2e code.
  - In host code, `show()` must stay gated on `process.env.CONDUIT_E2E !== '1'`, as
    `moveSessionToWindow` does.
  - Re-run a PTY-flavoured failure alone on a quiet machine before believing it (CLAUDE.md).
  - Never kill processes by name.
- **Tests:** vitest with the node environment by default. React component tests use a
  `// @vitest-environment jsdom` header and `react-dom/client` `createRoot` + `act`, following
  `test/unit/modal-layer.test.ts`; there is no testing-library. Unit tests go in
  `test/unit/<module>.test.ts`.
- **Naming:** a pure factory is `create<Name>(deps)` in `src/` for host-side logic or `webview/`
  for renderer logic (precedents: `src/drag-download-gate.ts`, `src/session-ops.ts`,
  `webview/file-save-controller.ts`). Hooks are `webview/use-<name>.ts`. Components are
  `webview/components/<kebab>.tsx`.
- **Comments:** only *why* comments. Where the why lives in the spec, write a one-line pointer
  (`// see dirty-quit-guard spec §2.3`).
- **CSS:** new rules go in `webview/styles.css` next to `.confirm*` (around :8110).
  - Use existing tokens only, no raw hex: the tokens `.confirm__msg` / `.btn--danger` /
    `.modal__backdrop` already use.
  - Class names are `confirm__*` / `quit-scrim*`, with no bare generic class names
    (`test/unit/monaco-class-collision.test.ts`).
  - Any fixed overlay declares `-webkit-app-region: no-drag`. Reusing `.modal__backdrop` via
    `ModalLayer` satisfies this (`test/unit/drag-region.test.ts`).
- **Plurals** go through `countNoun(n, one, many)` from `src/menu-selection.ts`.
- **Split-editor lands first.** Plan against names:
  - `ConfirmState` / `ConfirmDialog`, `requestKill`, `closeSessions`, `moveMenuItems`,
    `cmd:moveSessionNewWindow`, `onSessionDragEnd`, the session-removal effect
    (`prevSessionIdsRef`), `releaseFileTab`, `filePathsClosedWithSession`.
  - Split-editor's `closeDoc(id): Promise<boolean>`.
  - Line numbers in this plan are from `main@de36575` and are hints only.

## Out of scope

- Hot exit and OS shutdown (D6, D8).
- Renderer reload losing buffers.
- Plan-comment and review-note drafts (D14).
- A per-file "Save" button in the list (spec v1).
- macOS semantics beyond one rule: on darwin, closing the last window takes the
  `requestWindowClose` path, so the window closes and the app stays.
- The pre-existing case where closing session A clears the dirty flag of a path that session B
  also has open (`releaseFileTab` is per path).

## Contracts

### Protocol — `src/protocol.ts`

```ts
// HostToWebview (replace the existing confirmQuit member; add quitAborted)
| { type: 'confirmQuit'; requestId: number; reason: 'quit' | 'windowClose' | 'update'; running: number; busy: number }
| { type: 'quitAborted'; requestId: number }
// WebviewToHost (replace quitDecision / quitDialogShown; add quitAck)
| { type: 'quitAck'; requestId: number }
| { type: 'quitDialogShown'; requestId: number }
| { type: 'quitDecision'; requestId: number; proceed: boolean }
```

There is no runtime validator for these messages, and preload forwards them as they are. The
`webview/bridge.ts` mock never receives `confirmQuit`, so it needs no change.

### Host guard — `src/close-guard.ts` (new, pure, no Electron import)

```ts
export type GuardReason = 'quit' | 'windowClose' | 'update';
export interface GuardAsk { requestId: number; reason: GuardReason; running: number; busy: number }
export const ACK_TIMEOUT_MS = 3000;
export const SHOWN_TIMEOUT_MS = 12_000;
export const GRANT_TTL_MS = 5000;

export interface CloseGuardDeps {
  windowIds(): number[];                          // live windows, focused first
  prepare(id: number): void;                      // restore if minimized; show unless E2E; focus
  focus(id: number): void;
  counts(id: number): { running: number; busy: number };
  ask(id: number, ask: GuardAsk): void;           // main → send confirmQuit
  abort(id: number, requestId: number): void;     // main → send quitAborted
  confirmUnresponsive(id: number, signal: AbortSignal): Promise<boolean>; // true = "Close anyway"; guard aborts the signal when a decision/gone wins
  proceedApp(reason: 'quit' | 'update'): void;
  proceedWindow(id: number): void;
  resumeWindowClose(id: number): void;            // a queued window close is due: main re-runs its close decision (last window → app.quit(), else requestWindowClose)
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(message: string): void;
}
export interface CloseGuard {
  requestAppQuit(reason: 'quit' | 'update', firstId?: number): void;
  requestWindowClose(id: number): void;
  onAck(id: number, requestId: number): void;
  onShown(id: number, requestId: number): void;
  onDecision(id: number, requestId: number, proceed: boolean): void;
  onWindowGone(id: number): void;        // 'closed' or 'render-process-gone'
  onUnresponsive(id: number): void;
  onWindowCreated(id: number): void;
  unlockAnswered(): void;                 // grant expired: abort() every window that proceeded in the last app attempt
  pending(): boolean;
}
export function createCloseGuard(deps: CloseGuardDeps): CloseGuard;

export interface QuitGrant { issue(): void; consume(): boolean }
export function createQuitGrant(deps: {
  ttlMs: number; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void; onExpire(): void;
}): QuitGrant;
```

**Guard semantics** (each is a unit test):

- **requestId.** Host-unique and monotonic, starting at 1. There is one requestId per window ask.
- **Ask order.** Take a snapshot of `windowIds()`, then move `firstId` to the front if it is
  present.
  - Before each ask, call `prepare(id)`.
  - A window gone before its turn is skipped.
  - `onWindowCreated` during an **app** guard appends that window to the queue.
- **Per-ask states:** `asked → acked → shown → decided`.

  | State | Event | Result |
  |---|---|---|
  | asked | No `onAck` within `ACK_TIMEOUT_MS` | `abort(id, requestId)` (S2), then proceed, plus `log` |
  | acked | No `onShown`/`onDecision` within `SHOWN_TIMEOUT_MS` | `abort(id, requestId)` (S2), then proceed, plus `log` |
  | shown | (no timer) | waits for a decision; B1b's re-probe is the recovery path |
  | any | `onWindowGone` | proceed |
  | shown | `onUnresponsive` | `confirmUnresponsive(id, signal)` → true = proceed. A decision or `onWindowGone` arriving first wins, aborts `signal`, and a later box result is ignored. |
  | any | wrong `requestId`, or a decision from a window not currently asked | ignored |

- **App guard outcome.**
  - If every window proceeds, call `proceedApp(finalReason)` and remember the ids that proceeded,
    for `unlockAnswered`.
  - If a window cancels, call `abort(id, itsRequestId)` for each window that already proceeded in
    this attempt (not the one that cancelled). Nothing else happens.
- **Window guard outcome.** Proceed → `proceedWindow(id)`. Cancel → nothing.
- **Re-entrancy (I2).**

  **Re-probe (B1b).** Whenever any trigger below arrives while the currently asked window is in
  `shown`, the guard also calls `ask(askedId, sameAsk)`, with the same `requestId`, reason and
  counts, and then `focus(askedId)`. In `asked`/`acked`, the running timer is the recovery path,
  so the guard only focuses.

  | Pending guard | New trigger | Result |
  |---|---|---|
  | app | `requestWindowClose(any)` | focus (+ re-probe); the app guard already covers every window |
  | app | `requestAppQuit('quit')` | focus (+ re-probe) |
  | app | `requestAppQuit('update')` | focus (+ re-probe), and upgrades the final reason to `'update'`; windows not yet asked get `reason:'update'` |
  | window W | `requestWindowClose(W)` | focus (+ re-probe) |
  | window W | `requestWindowClose(X ≠ W)` | **queued** (S4) as `{kind:'window', id:X}`, FIFO, deduplicated by id |
  | window | `requestAppQuit('quit')` | focus (+ re-probe) |
  | window | `requestAppQuit('update')` | **queued** as `{kind:'update', firstId}`; a later update replaces the queued update |

  - When a guard settles, the queue drains **one item at a time**. A window item whose window is
    gone is dropped. A live one calls `deps.resumeWindowClose(id)`, so main decides afresh whether
    it is now the last window. An update item calls `requestAppQuit('update', firstId)`.
  - When an **app** guard proceeds, the queue is cleared. When it is cancelled, the queue drains.

- **No windows.** An app quit with no live windows calls `proceedApp` straight away.
- **Grant.**
  - `issue()` arms the TTL.
  - `consume()` returns true once, if armed, and clears the timer.
  - If the TTL fires before `consume`, it calls `onExpire`.
  - `consume()` with nothing issued returns false.

### Copy — `src/quit-guard.ts` (modify)

```ts
export type QuitReason = 'quit' | 'windowClose' | 'update';      // quitConfirmCopy: 'windowClose' uses the 'quit' copy
export type DirtyCloseReason = QuitReason | 'sessionClose' | 'sessionMove';
export type DirtyTag = 'conflict' | 'failed' | 'notEdited' | 'noEntry' | 'partial' | 'saved' | null;
export interface DirtyFile { path: string; name: string; dir: string; tag: DirtyTag; error?: string; session?: string }
export interface DirtyCloseCopyInput {
  files: readonly DirtyFile[]; running: number; busy: number; reason: DirtyCloseReason;
  exitedSession?: string;        // "Terminal exited" path
  grouped?: boolean;             // bulk close of >1 session: rows carry their session as group
}
export interface DirtyCloseRow { path: string; name: string; dir: string; title: string; tag: string | null; danger: boolean; group?: string }
export interface DirtyCloseCopy {
  title: string; summary: string; lines: string[]; rows: DirtyCloseRow[]; overflow: number;
  labels: { save: string; discard: string; cancel: string; saving: string };
}
export const DIRTY_ROW_CAP = 10;
export function dirtyCloseCopy(input: DirtyCloseCopyInput): DirtyCloseCopy;
export function dirtySaveStatus(kind: 'saving' | 'failed', n: number): string;
```

**Copy, exactly.**

- **Title** counts the files whose tag is not `'saved'`:
  - one file: `Do you want to save the changes you made to ${name}?`
  - otherwise: `Do you want to save the changes you made to ${countNoun(n,'file','files')}?`
- **Summary:** `Your changes will be lost if you don't save them.`
- **`lines`, in this order:**
  1. The running line, when `running > 0` and the reason is not `sessionMove`. The verb depends on
     the reason:

     | Reason | Verb |
     |---|---|
     | `quit` / `update` | `Quitting` |
     | `windowClose` | `Closing this window` |
     | `sessionClose` | `Closing` |

     The line is ``${Verb} will also stop ${countNoun(running,'running agent','running agents')}``,
     plus ``(${busy} actively working)`` when `busy > 0`, then `.`
  2. For `update`: `Conduit will relaunch to install the update.`
  3. With `exitedSession`: `“${S}” has exited. Closing it closes its tabs.`
- **Row tags** (`danger` is true for `failed`, `noEntry` and `partial`):

  | Tag | Text |
  |---|---|
  | `conflict` | `changed on disk — Save All overwrites it` |
  | `failed` | `save failed: ${error}` |
  | `notEdited` | `not edited` |
  | `noEntry` | `can't be saved here` |
  | `partial` | `partly loaded, can't be saved` |
  | `saved` | `Saved` |
  | `null` | no tag |

- **Name.** `name` is middle-ellipsized to 40 chars by a private helper in this file: keep the
  head and the tail, including the extension, around `…`. `title` is the full path.
- **Overflow.** Rows are capped at `DIRTY_ROW_CAP`; `overflow` is the remainder.
- **Labels:** `Save All`, `Don't Save`, `Cancel`, `Saving…`.
- **`dirtySaveStatus`:** `Saving ${countNoun(n,'file','files')}` and
  ``${countNoun(n,'file','files')} couldn't be saved``.

### Save store — `webview/file-save-controller.ts` (modify `FileSaves`)

```ts
whenIdle(): Promise<void>;              // resolves once no entry has a chain or queued `next`; re-checks after each settle
setToastsSuppressed(on: boolean): void; // reportFailure, flushAll's batched toast and the preview toast skip pushing while on
isPartial(path: string): boolean;       // entry exists and was attached with autoEligible:false (truncated)
```

`FileSaveStatus` does not change shape.

### Renderer rules — `webview/unsaved-files.ts` (new, pure)

```ts
import type { DirtyFile } from '../src/quit-guard';
export interface SaveProbe {
  getStatus(path: string): FileSaveStatus | undefined;
  isPartial(path: string): boolean;
  save(path: string, kind: SaveKind): Promise<boolean>;
}
export function unsavedFiles(
  paths: readonly string[], probe: Pick<SaveProbe, 'getStatus' | 'isPartial'>,
  rootOf: (path: string) => string | undefined, sessionOf?: (path: string) => string | undefined,
): DirtyFile[];
export interface SaveOutcome { saved: string[]; unsaved: DirtyFile[] }   // unsaved rows re-tagged from post-save status
export function saveUnsaved(files: readonly DirtyFile[], probe: SaveProbe): Promise<SaveOutcome>;
export function sessionDirtyPaths(docs: readonly OpenDoc[], sessionIds: readonly string[], dirty: ReadonlySet<string>): string[];
```

- **Tag precedence:**
  1. `isPartial` → `partial`
  2. status `undefined` → `noEntry`
  3. `phase==='conflict'` → `conflict`
  4. `phase==='failed'` → `failed` (the error comes from `status.error`)
  5. `!edited` → `notEdited`
  6. otherwise `null`
- **Name and dir.** `name` is the basename. `dir` is the parent directory relative to
  `rootOf(path)`, `/`-joined, and `''` at the root. Without a root, `dir` is the absolute parent.
- **`saveUnsaved`.** Paths run sequentially.
  - `partial` / `noEntry` rows are never written and go to `unsaved` unchanged.
  - The kind is `'force'` **iff `file.tag === 'conflict'`** (D3 condition), otherwise `'manual'`.
  - A path counts as saved iff `save()` resolved true **and** `getStatus(path)?.phase === 'clean'`
    afterwards. Anything else is re-tagged by `unsavedFiles`' precedence and goes into `unsaved`.
- **`sessionDirtyPaths`.** The union of `filePathsClosedWithSession(docs, id)` over `sessionIds`,
  intersected with `dirty`, deduplicated, in first-seen order.

### Modal slot — `webview/use-modal-slot.ts` (new; critic B1a)

```ts
export type ModalEntry =
  | { kind: 'confirm'; key: number; state: ConfirmState }
  | { kind: 'dirty'; key: number; props: DirtyCloseDialogProps };
export interface ModalSlot {
  readonly current: ModalEntry | null;   // live (ref-backed) — safe to read synchronously
  open(entry: ModalEntry): void;         // displaces any current entry with another key: current := entry, THEN settle(displaced)
  update(entry: ModalEntry): void;       // replaces only when current.key === entry.key; never settles; otherwise no-op
  close(key: number): void;              // clears only when current.key === key; never settles
  dismiss(): void;                        // settle(current), then clear
}
export function nextModalKey(): number;   // module-level monotonic counter
export function useModalSlot(): ModalSlot;
export function focusOpenModal(): void;   // focuses the open modal's `[data-modal-default]` button, if any
```

- `settle(entry)` means: for `'confirm'`, `entry.state.onCancel?.()`; for `'dirty'`,
  `entry.props.onCancel()`.
- The slot updates `current` **before** settling, so a settle that calls `close(displacedKey)`
  is a no-op, and a settle that opens something new is legal.
- The hook keeps a ref for `current` and a `useState` mirror that drives the render. The `slot`
  object identity is stable across renders.
- `app.tsx` renders from `slot.current`:
  - `kind==='confirm'` → `<ConfirmDialog state onClose={() => slot.close(key)}/>`
  - `kind==='dirty'` → `<DirtyCloseDialog {...props}/>`
- Nothing else in the renderer holds a confirm.

### Dialog hook — `webview/use-dirty-close.ts` (new)

```ts
export interface DirtyAsk {
  reason: DirtyCloseReason; paths: readonly string[]; running: number; busy: number;
  exitedSession?: string; sessionOf?: (path: string) => string | undefined; grouped?: boolean;
  onShown?: () => void;
  signal?: AbortSignal;          // abort → close the entry WITHOUT settling and resolve 'cancel' (S2 end-of-flow)
}
export type DirtyAnswer = 'saved' | 'discarded' | 'cancel';
export function useDirtyClose(deps: {
  saves: SaveProbe & { subscribe(cb: () => void): () => void };   // FileSaves.subscribe
  rootOf: (path: string) => string | undefined; slot: ModalSlot;
}): { ask(req: DirtyAsk): Promise<DirtyAnswer> };
```

- **Opening.** `ask` opens `{kind:'dirty', key: nextModalKey(), props}` through `slot.open`. Any
  displaced entry is settled by the slot. When this entry is displaced, the slot calls its
  `props.onCancel`, which resolves `'cancel'`.
- **State** is held per ask in a ref: `{ files: DirtyFile[], phase: 'ready'|'saving', status: string|null }`.
  Every change re-publishes via `slot.update`.
- **Live tags.** While the entry is current, `saves.subscribe` recomputes `files`. A listed path that becomes clean shows tag
  `'saved'` and stays listed.
- **Save All.**
  1. Set `phase='saving'` and status `dirtySaveStatus('saving', n)`.
  2. Run `saveUnsaved` on the rows whose tag isn't `saved`.
  3. If `unsaved` is empty, `slot.close(key)` and resolve `'saved'`.
  4. Otherwise set `files = unsaved`, `phase='ready'` and status `dirtySaveStatus('failed', n)`.
- **Don't Save:** `slot.close(key)`, then resolve `'discarded'`.
- **Cancel, Esc, backdrop or displacement:** `slot.close(key)` (a no-op if already displaced),
  then resolve `'cancel'`. Cancel stays enabled while saving and resolves immediately; any
  in-flight write finishes on its own.
- An ask **settles exactly once**. Later settles are ignored.

### Components (new)

```ts
// webview/components/dirty-close-dialog.tsx
export interface DirtyCloseDialogProps {
  copy: DirtyCloseCopy; phase: 'ready' | 'saving'; status: string | null;
  onSaveAll(): void; onDiscard(): void; onCancel(): void; onShown?: () => void;
}
export function DirtyCloseDialog(props: DirtyCloseDialogProps): JSX.Element;
// webview/components/quit-scrim.tsx
export function QuitScrim(): JSX.Element;
// webview/use-focus-trap.ts
export function useFocusTrap(ref: RefObject<HTMLElement | null>): { restoreFocus(): void };
```

**`DirtyCloseDialog`:**

- Rendered in `ModalLayer`, with `onDismiss = onCancel`.
- `div.confirm.confirm--files` has `role="alertdialog"`, `aria-modal`, `aria-labelledby` (the
  title id) and `aria-describedby` (the summary id).
- Rows are a `ul.confirm__files` with `aria-label="Unsaved files"`. Each `li.confirm__file` has
  `title=row.title` and contains the name, `span.confirm__file-dir` and `span.confirm__file-tag`
  (plus `--danger` when needed). Tag text is in the DOM. When grouped, a
  `li.confirm__file-group` header comes before each group.
- `"and N more"` shows when `overflow > 0`.
- `div.confirm__status` has `aria-live="polite"`.
- Buttons, in order:
  - Cancel
  - Don't Save
  - Save All: `.btn--primary`, `autoFocus`, `data-modal-default`, and it shows
    `labels.saving` while saving.
  - In `saving`, Save All and Don't Save are `disabled`.
- `onShown` is called once, from a mount `useEffect`.
- Focus is trapped by `useFocusTrap`. Cancel calls `restoreFocus()`.

**`QuitScrim`:**

- `ModalLayer` with no `onDismiss`.
- `div.quit-scrim` has `aria-busy="true"`, `aria-label="Quitting"`, `tabIndex={-1}`, and is
  focused on mount.
- Text: `Quitting… waiting for another window`.
- While mounted, a window `keydown` capture listener calls `preventDefault` and
  `stopPropagation`.

**`useFocusTrap`:**

- It records `document.activeElement` on mount.
- Tab and Shift+Tab inside `ref` cycle through its enabled `button, [href], input, [tabindex]:not([tabindex="-1"])`.
- `restoreFocus()` focuses the recorded element if it is still connected.

### ConfirmDialog — `webview/components/confirm-dialog.tsx` (modify)

```ts
export interface ConfirmState { /* existing fields */ onCancel?: () => void; onShown?: () => void }
```

- **Delete the window `keydown` Enter handler** (D12). Native button activation handles
  Enter/Space on the focused button only.
- The Cancel button, Esc and the backdrop call `state.onCancel?.()`, then `restoreFocus()`, then
  `onClose()`.
- The primary and secondary buttons do **not** call `onCancel`.
- The button that gets `autoFocus` also carries `data-modal-default`: Cancel when `focusCancel`,
  otherwise the primary.
- It gains `aria-labelledby` and `aria-describedby` via `useId`, `useFocusTrap`, and `onShown`
  from a mount effect.
- **Invariant (B1a).** Every `ConfirmState` whose opener awaits an answer sets `onCancel`, so a
  displacement settles it:
  - the quit session dialog → resolve false;
  - the hunk confirm → resolve false (this replaces `hunkConfirmRef`);
  - split-editor's `closeDoc` confirm → resolve false.
  Fire-and-forget confirms (`onConfirm` just posts) need no `onCancel`.

### Quit responder — `webview/quit-responder.ts` (new, pure with deps)

```ts
export const FLUSH_BOUND_MS = 5000;
export const SETTLE_BOUND_MS = 5000;
type ConfirmQuitMsg = Extract<HostToWebview, { type: 'confirmQuit' }>;
export interface QuitResponderDeps {
  post(msg: WebviewToHost): void;
  autoSaveMode(): AutoSaveMode;
  saves: Pick<FileSaves, 'flushAll' | 'whenIdle' | 'setToastsSuppressed'>;
  dirtyPaths(): string[];
  askDirty(req: DirtyAsk): Promise<DirtyAnswer>;
  askSessions(req: { reason: QuitReason; running: number; busy: number; onShown(): void; signal: AbortSignal }): Promise<boolean>;
  focusDialog(): void;              // app: focusOpenModal()
  setLocked(on: boolean): void;
  wait(ms: number): Promise<void>;
  log(message: string): void;
}
export function createQuitResponder(deps: QuitResponderDeps): {
  onConfirmQuit(msg: ConfirmQuitMsg): Promise<void>;
  onQuitAborted(requestId: number): void;
  discarded(): boolean;             // read by the Electron beforeunload backstop (B3)
};
```

`askSessions` opens the session-only confirm through the slot. Its `onCancel` resolves `false`,
which covers displacement, and aborting `signal` closes the entry without settling it.

**Flow state:** `flow: { requestId, phase: 'flushing'|'asking'|'settling'|'done', abort: AbortController } | null`,
`lockedFor: number | null` and `discarded: boolean`.

**`onConfirmQuit(msg)` order** (each step is a unit test):

0. **Re-probe (B1b).** If `msg.requestId === flow?.requestId`:
   - phase `asking` → `focusDialog()` and return;
   - phase `flushing` or `settling` → return, because a decision is imminent;
   - phase `done` → post `quitDecision{requestId, proceed:false}` and return.

   Otherwise, a new request: abort any previous flow's controller (ending it silently), then set
   `discarded = false` and `flow = {requestId, phase:'flushing', abort: new AbortController()}`.
1. Post `quitAck{requestId}`.
2. If `autoSaveMode() !== 'off'`: `setToastsSuppressed(true)`, then
   `await Promise.race([flushAll('windowBlur'), wait(FLUSH_BOUND_MS)])`.
3. Set phase `asking`. `paths = dirtyPaths()`, then one of:
   - No paths and `running === 0`: proceed.
   - No paths: `askSessions({..., signal})` → proceed or cancel.
   - Otherwise `askDirty({reason, paths, running, busy, onShown, signal})`. `'saved'` means
     proceed; `'discarded'` sets `discarded = true` and proceeds; `'cancel'` means cancel.

   `onShown` posts `quitDialogShown{requestId}`.
4. **If `signal.aborted` at any await point, stop:** post nothing, never lock. This is the S2
   end-of-flow.
5. On proceed:
   - Set phase `settling`.
   - `await race(whenIdle(), wait(SETTLE_BOUND_MS))`, and `log` if the bound won.
   - Re-check `signal.aborted`.
   - `setLocked(true)` and `lockedFor = requestId`, when the reason is not `'windowClose'`.
   - Post `quitDecision{requestId, proceed:true}`.
6. On cancel: post `quitDecision{requestId, proceed:false}`, and set `discarded = false`.
7. `finally`: set phase `done` (if this is still the current flow), then
   `setToastsSuppressed(false)`.

**`onQuitAborted(requestId)`:**
- If it matches `flow.requestId`, abort the flow's controller. Its dialog closes unsettled and it
  posts nothing.
- If it matches `lockedFor`, call `setLocked(false)`.
- In both cases set `discarded = false`.
- Otherwise, ignore it.

### Drag-end stay test — `src/window-registry.ts` (modify; critic S1)

```ts
export const DRAG_STAY_INSET_PX = 8;
export function pointWellInside(r: Rect, p: ScreenPoint, inset: number): boolean; // rectContains on r shrunk by `inset` on every side
```

The existing private `rectContains` is unchanged. A drop within `DRAG_STAY_INSET_PX` of the
window's edge, or outside it, counts as leaving, so the renderer gates it. Only a drop well
inside the source window skips the prompt; the host no-ops that drop anyway.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `confirmQuit` (now carries `requestId`, `'windowClose'`) | `electron/main.ts` via guard `ask` | `webview/app.tsx` subscribe → responder; `test/e2e/harness.mjs` `closeApp`; `quit-guard.e2e.mjs`; `renderer-crash-recover.e2e.mjs` | both, plus all three test consumers |
| `quitAck` / `quitDialogShown` / `quitDecision` | responder; harness and e2e senders | `electron/main.ts` `handle()` → guard | both |
| `quitAborted` | guard `abort` (cancel elsewhere, S2 timeout) / `unlockAnswered` | responder `onQuitAborted` → end flow / scrim off / clear `discarded` | both |
| Re-probe `confirmQuit` (same `requestId`, B1b) | guard on a repeat trigger while `shown` | responder step 0 | both |
| `before-quit` → teardown | `app.quit()` from window-all-closed, last-window close, guard `proceedApp`, electron-updater | main: `flushStateSync()` on every unguarded pass (B2), teardown behind the grant | both (electron-updater is a black-box producer, A2) |
| State snapshot (`flushStateSync`) | before-quit (both branches), window `session-end` (new) | disk (`sessions.json` etc.) | both |
| Window close disposing sessions | guard `proceedWindow` | `disposeSession` | both |
| Dirty set (`dirty-store`) | CodeViewer / `fileSaves` (unchanged) | responder, `guardSessionRemoval`, `useDirtyClose` (new readers) | consumer side only; the producer is unchanged and read-only here |
| Save status / write chains | `file-save-controller` | `unsavedFiles`, `saveUnsaved`, `whenIdle` | both (controller gains 3 methods) |
| Failure toasts | `file-save-controller` `reportFailure` / `flushAll` | `webview/toast-store.ts` | producer gains the suppression switch; the consumer is unchanged |
| Session removal → docs `closeSession` + `releaseFileTab` | renderer `kill` / `session:move` / `session:dragEnd` posts | session-removal effect in app.tsx | producers gated; consumer unchanged, because a proceed after Save All or Don't Save *means* discard |
| `beforeunload` save-all | app.tsx | host `writeFile` | producer kept, and skipped only when `responder.discarded()` (B3) |
| Modal slot displacement → `onCancel` (replaces `quitCancelRef`, `hunkConfirmRef` and bare `setConfirm`) | all 12 confirm openers in app.tsx, `useDirtyClose`, responder `askSessions` | `ModalSlot.open` settle; `ConfirmDialog` cancel paths | both |

The other-side claims were measured, not assumed:

- `mgr.remove` and `removeOwner` are reached only through `disposeSession`, from `case 'kill'`
  and `onWindowClose`. PTY exit only sets `exited`.
- `hunk-actions.ts` is the only other `ConfirmState` importer. Its fields are unchanged, and the
  new fields are optional.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/close-guard.ts` | create | Host guard state machine and quit grant (pure) |
| `test/unit/close-guard.test.ts` | create | Guard and grant semantics |
| `src/quit-guard.ts` | modify | `QuitReason += 'windowClose'`; `dirtyCloseCopy`, `dirtySaveStatus`; delete `needsQuitConfirm` once main no longer calls it |
| `test/unit/quit-guard.test.ts` | modify | Copy tests; drop the `needsQuitConfirm` describe |
| `src/protocol.ts` | modify | The five message members (claim) |
| `src/window-registry.ts` | modify | `DRAG_STAY_INSET_PX`, `pointWellInside` (S1) |
| `test/unit/window-registry.test.ts` | modify (create if absent) | `pointWellInside` edge cases |
| `electron/main.ts` | modify | Wire the guard and grant; `before-quit` gate (`flushStateSync` before `preventDefault`) plus `tornDown`; `onWindowClose` / `resumeWindowClose`; `proceedWindow` last-window fallback; `updateRelaunch`; `handle()` cases; `unresponsive`, `render-process-gone`, `closed` and `session-end` hooks; delete `confirmWithRenderer` and the `windowConfirmed` marking in `updateRelaunch` (claim) |
| `webview/file-save-controller.ts` | modify | `whenIdle`, `setToastsSuppressed`, `isPartial` |
| `test/unit/file-save-controller.test.ts` | modify | Tests for the three methods, plus A3 (`off` mode tracks `edited`, `conflict`, `failed`) |
| `webview/unsaved-files.ts` | create | Tags, Save All kinds and outcome, session dirty paths |
| `test/unit/unsaved-files.test.ts` | create | Its rules |
| `webview/use-focus-trap.ts` | create | Tab trap and focus restore |
| `webview/components/confirm-dialog.tsx` | modify | D12 Enter fix; `onCancel`/`onShown`; ARIA; focus trap |
| `test/unit/confirm-dialog.test.ts` | create | Enter, cancel paths, trap (jsdom) |
| `webview/components/dirty-close-dialog.tsx` | create | The dirty dialog view |
| `webview/components/quit-scrim.tsx` | create | "Quitting…" lock |
| `test/unit/dirty-close-dialog.test.ts` | create | Render states, focus, `onShown` (jsdom) |
| `webview/use-modal-slot.ts` | create | The one modal slot; displacement settles as Cancel (B1a) |
| `test/unit/modal-slot.test.ts` | create | Slot semantics, plus exit-warn displacing a quit ask (jsdom) |
| `webview/use-dirty-close.ts` | create | Promise-based dirty ask on the slot |
| `webview/quit-responder.ts` | create | Renderer handling of one `confirmQuit` |
| `test/unit/quit-responder.test.ts` | create | Order, bounds, lock, abort |
| `webview/app.tsx` | modify | Glue: `useModalSlot` replaces the `confirm` state and all 12 `setConfirm` openers; responder; `useDirtyClose`; `guardSessionRemoval` and its callers; scrim; the `beforeunload` `discarded` check; delete the inline `confirmQuit` branch, `quitCancelRef` and `hunkConfirmRef` (claim) |
| `webview/styles.css` | modify | `confirm--files`, `confirm__files`, `confirm__file*`, `confirm__file-group`, `confirm__status`, `quit-scrim`, wrap on `.confirm__actions`, forced-colors focus ring (claim) |
| `test/e2e/harness.mjs` | modify | New `answerQuitAsks(app, {proceed})`; `closeApp` uses it and asserts one ask per window that had running sessions (claim) |
| `test/e2e/multi-window.e2e.mjs` | modify | Its window closes (`fromId(id).close()`) answer asks through `answerQuitAsks` (S3) |
| `test/e2e/multi-window-restore.e2e.mjs` | modify | Its `app.quit()` answers every window's ask through `answerQuitAsks`, so launch 1 really quits and persists (S3, B2) |
| `test/e2e/quit-guard.e2e.mjs` | modify | Echo `requestId`; Part 5 now expects an ask that auto-proceeds without a dialog |
| `test/e2e/renderer-crash-recover.e2e.mjs` | modify | Echo `requestId` in its `quitDecision` subscriber |
| `test/e2e/dirty-quit-helpers.mjs` | create | Shared helpers for the dirty-quit scenarios |
| `test/e2e/dirty-quit.e2e.mjs` | create | Save All / Don't Save / Cancel on quit |
| `test/e2e/dirty-quit-saves.e2e.mjs` | create | Auto-save clears the way / save failure / conflict |
| `test/e2e/dirty-session-close.e2e.mjs` | create | Session close and move gating |
| `test/e2e/dirty-quit-windows.e2e.mjs` | create | Non-last dirty window; two windows, second cancels; update relaunch |
| `CHANGELOG.md` | modify | User-facing entry (claim) |
| `docs/specs/INDEX.md` | modify at end | Spec status row, per ADR 0003 (spec moves to the archive after ship; not this plan) |

## Scripts

- **One-off probe:** `%TEMP%\claude-scratch\before-quit-probe.mjs` (Slice 1). It imports
  `launchApp` / `shutdownApp` from `G:/awby/projects/conduit/test/e2e/harness.mjs` by absolute
  path and takes no arguments. Delete it after Slice 1.
- Nothing else repeats enough to script. The e2e shared shapes go in
  `test/e2e/dirty-quit-helpers.mjs`, which is a test module, not a script.

## Slices

### Slice 1: Probe A1 — `before-quit` re-fires after `preventDefault`

**Check:** the probe prints `A1=true`, meaning a second `app.quit()` fired `before-quit` again
and the app then exited. `A1=false`, or an app that never exits within 15 s, **stops the run**:
report and build nothing further.

#### Task 1.1: Build and probe

**Files:** scratch only (`%TEMP%\claude-scratch\before-quit-probe.mjs`). No repo file changes.

**Steps:**
- [ ] `npm run build`.
- [ ] Probe:
  1. `launchApp()` (hidden).
  2. `app.evaluate` registers a **prepended** listener,
     `app.prependListener('before-quit', e => { global.__bq=(global.__bq||0)+1; if (global.__bq===1) e.preventDefault(); })`,
     so it runs before main's teardown listener.
  3. `app.evaluate(({app}) => app.quit())`. Wait 1 s, then assert a window is still alive and
     `__bq===1`.
  4. Call `app.quit()` again and wait for exit, up to 15 s. Before it exits, read `__bq` through
     an `app.evaluate` race, or record it to a temp file inside the listener if the evaluate can't
     beat the exit.
  5. Print `A1=${bq===2 && exited}`.
- [ ] Note: the first `preventDefault` stops Electron's quit, but main's own teardown listener
  still ran, so PTYs die. That is expected for the probe.
- [ ] Delete the scratch file. Record the verdict in the plan's run notes (append a
  `## Run notes` section).

### Slice 2: Pure foundations (no wiring)

**Check:**
`npx vitest run test/unit/close-guard.test.ts test/unit/quit-guard.test.ts test/unit/file-save-controller.test.ts test/unit/unsaved-files.test.ts test/unit/confirm-dialog.test.ts`
is green, and `npm run typecheck` is green (nothing consumes the new exports yet, and all
existing callers compile).

**Parallel groups:** G1: T2.1 · G2: T2.2 · G3: T2.3 · G4: T2.4 · G5: T2.5 · Serial: none

#### Task 2.1: Host guard and grant

**Files:** Create `src/close-guard.ts` and `test/unit/close-guard.test.ts`.

**Interfaces:** Produces `createCloseGuard`, `createQuitGrant`, `GuardReason`, `GuardAsk`,
`CloseGuardDeps`, `CloseGuard`, `QuitGrant`, `ACK_TIMEOUT_MS`, `SHOWN_TIMEOUT_MS` and
`GRANT_TTL_MS`, exactly as in Contracts. Consumes nothing.

**Steps:**
- [ ] Failing tests use a fake timer (`vi.useFakeTimers`) and a recording deps object. Test name
  and key assertion for each:

  | Test | Key assertion |
  |---|---|
  | 'asks focused-first, one at a time' | `ask` calls are `[1,2]` only after window 1 decides |
  | 'prepares each window before asking' | `prepare(id)` is called before `ask(id)` |
  | 'firstId moves to the front' | `requestAppQuit('update', 2)` asks 2 first |
  | 'all proceed → proceedApp once' | `proceedApp` called once, with `'quit'` |
  | 'cancel in window 2 aborts window 1 only' | `abort` calls are `[[1, reqIdOf1]]`, and `proceedApp` is not called |
  | 'no ACK in 3000 ms → abort to it, then proceed + log' | `abort(id, requestId)` then treated as proceed; `log` called (S2) |
  | 'ACK then silence 12 000 ms → abort to it, then proceed' | as named (S2) |
  | 'shown waits forever' | 60 s later, still no decision |
  | 'unresponsive when shown → native box; true proceeds' | window proceeds |
  | 'decision beats a pending box and aborts its signal' | the later box result is ignored; `signal.aborted === true` |
  | 're-trigger re-probes a shown ask' (B1b) | with window 1 `shown`, `requestAppQuit('quit')`, `requestWindowClose(1)` and `requestAppQuit('update')` each cause `ask(1, {same requestId})` plus `focus(1)`; no new `requestId` is minted |
  | 're-trigger while asked/acked only focuses' | no second `ask` |
  | 'stale requestId and a foreign window's decision are ignored' | outcome unchanged |
  | 'window gone mid-ask → proceed; gone before its turn → skipped' | `ask` never called for it |
  | 'window created mid app guard is appended' | it is asked before the guard finishes |
  | 'window close of X during window guard for W is queued (S4)' | after W settles, `resumeWindowClose(X)` is called once; a duplicate X is queued once; a gone X is dropped |
  | 'queue drains one item at a time' | the second item starts only after the first settles |
  | 'app guard proceed clears the queue; cancel drains it' | as named |
  | 'update during window guard is queued then run' | its asks start after `proceedWindow` or a cancel |
  | 'update during app guard upgrades the reason' | later asks carry `reason:'update'`; `proceedApp('update')` |
  | 'window guard proceed → proceedWindow; cancel → nothing' | as named |
  | 'no windows → proceedApp immediately' | as named |
  | 'unlockAnswered aborts the last app attempt's proceeders' | as named |
  | 'grant: consume true once; false when not issued; expiry calls onExpire and consume is false after' | as named |

- [ ] Run `npx vitest run test/unit/close-guard.test.ts`. Expect FAIL (the module is missing).
- [ ] Implement. There is no Electron import; the module reads no `process.env`.

#### Task 2.2: Save store additions

**Files:** Modify `webview/file-save-controller.ts` (`FileSaves` interface and `createFileSaves`)
and `test/unit/file-save-controller.test.ts`.

**Interfaces:** Produces the `FileSaves` members `whenIdle(): Promise<void>`,
`setToastsSuppressed(on: boolean): void` and `isPartial(path: string): boolean`.

**Call sites:** `FileSaves` is implemented only by `createFileSaves`. Grep `test/unit` for
hand-built `FileSaves` fakes: an object typed `FileSaves` must gain the three members.

**Steps:**
- [ ] Failing tests:

  | Test | Key assertion |
  |---|---|
  | 'whenIdle waits for the chain and a queued trailing save' | resolves only after both writes' promises resolve |
  | 'whenIdle resolves immediately with no chains' | as named |
  | 'toasts suppressed while on' | a failed write with suppression on → `toast` not called; after `setToastsSuppressed(false)`, a new failure toasts |
  | 'isPartial reflects autoEligible:false attach' | as named |
  | 'off mode still tracks edited/conflict/failed' | spec A3: in `mode:'off'`, an edit gives `edited:true`; a manual save hitting a conflict gives `phase:'conflict'`; a write `{ok:false}` gives `phase:'failed'` |

- [ ] Run. Expect FAIL.
- [ ] Implement. If the A3 test fails on current code, that is a Deviation (fix the controller so
  `off` tracks status), not a test edit.

#### Task 2.3: Copy

**Files:** Modify `src/quit-guard.ts` and `test/unit/quit-guard.test.ts`.

**Interfaces:** Produces `QuitReason` (with `'windowClose'`), `DirtyCloseReason`, `DirtyTag`,
`DirtyFile`, `DirtyCloseCopyInput`, `DirtyCloseRow`, `DirtyCloseCopy`, `DIRTY_ROW_CAP`,
`dirtyCloseCopy` and `dirtySaveStatus`, exactly as in Contracts. `quitConfirmCopy` gives
`'windowClose'` the `'quit'` copy. Keep `needsQuitConfirm` for now; Task 3.2 deletes it.

**Steps:**
- [ ] Failing tests:

  | Test | Key assertion |
  |---|---|
  | '1 file title names it' | `…made to a.ts?` |
  | '3 files' | `…made to 3 files?` |
  | 'saved rows don't count toward the title' | as named |
  | '12 files → 10 rows, overflow 2' | as named |
  | 'each tag's exact text and danger flag' | the conflict text is exactly `changed on disk — Save All overwrites it` |
  | 'running line per reason, with busy suffix and plurals' | as named |
  | 'no running line for sessionMove' | as named |
  | 'update line' | as named |
  | 'exited subline' | as named |
  | 'grouped rows carry session' | as named |
  | 'long name middle-ellipsized, extension kept, title is full path' | as named |
  | 'dirtySaveStatus plurals' | as named |
  | 'quitConfirmCopy windowClose == quit copy' | as named |

- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 2.4: Renderer save rules

**Files:** Create `webview/unsaved-files.ts` and `test/unit/unsaved-files.test.ts`.

**Interfaces:**
- Produces `SaveProbe`, `unsavedFiles`, `SaveOutcome`, `saveUnsaved` and `sessionDirtyPaths`,
  exactly as in Contracts.
- Consumes:
  - `DirtyFile`, `DirtyTag` from `src/quit-guard.ts`. Task 2.3 produces them; if it runs in
    parallel, import the type names as written in Contracts.
  - `FileSaveStatus`, `SaveKind`, `OpenDoc`, `filePathsClosedWithSession` from existing modules.

**Steps:**
- [ ] Failing tests:

  | Test | Key assertion |
  |---|---|
  | 'tag precedence' | partial beats a missing status; conflict beats failed |
  | 'dir is root-relative with / and empty at root' | as named |
  | 'conflict row saved with force, others manual' | recorded kinds `['force','manual']` |
  | 'a path that entered conflict after listing (tag null) is saved manual and comes back tagged conflict in unsaved' | as named |
  | 'noEntry/partial never written, reported unsaved' | as named |
  | 'save() true but phase not clean → unsaved' | as named |
  | 'sessionDirtyPaths unions sessions, dedupes, intersects dirty' | as named |

- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 2.5: ConfirmDialog fixes and the focus trap

**Files:** Create `webview/use-focus-trap.ts` and `test/unit/confirm-dialog.test.ts`. Modify
`webview/components/confirm-dialog.tsx`.

**Interfaces:**
- Produces `useFocusTrap(ref): { restoreFocus(): void }`.
- Produces the new optional `ConfirmState` fields `onCancel?: () => void` and
  `onShown?: () => void`.

**Call sites:** `ConfirmState` literals live in `webview/app.tsx` and `webview/hunk-actions.ts`.
They are unchanged, because the fields are optional. `ConfirmDialog` is rendered once, in
`webview/app.tsx`. `test/unit/overlay-sites.test.ts` and `test/unit/sidebar-project-menus.test.ts`
reference it; re-run both.

**Steps:**
- [ ] Failing jsdom tests:

  | Test | Key assertion |
  |---|---|
  | 'Enter with secondary focused does not run onConfirm' | dispatching `keydown` Enter on `window` with the middle button focused leaves `onConfirm` uncalled |
  | 'Cancel click calls onCancel then onClose' | as named |
  | 'primary click does not call onCancel' | as named |
  | 'Tab from last button wraps to first' | as named |
  | 'Cancel restores focus to the previously focused element' | as named |
  | 'aria-labelledby/aria-describedby point at title/message ids' | as named |
  | 'onShown called once on mount' | as named |
  | 'the autofocused button carries data-modal-default' | Cancel when `focusCancel`, else the primary |

- [ ] Run. Expect FAIL.
- [ ] Implement. Re-run the two referencing tests.

### Slice 3: Host guard wired and protocol v2 (renderer keeps today's dialog)

**Check:** `npm run typecheck` and `npx vitest run test/unit` are green. After `npm run build`,
each of these passes, run alone and serially:
- `node test/e2e/run-smoke.mjs quit-guard`
- `node test/e2e/run-smoke.mjs exit-closes-session`
- `node test/e2e/run-smoke.mjs renderer-crash`
- `node test/e2e/run-smoke.mjs multi-window-restore` (B2: launch 1's windows and sessions are
  restored by launch 2)
- `node test/e2e/run-smoke.mjs multi-window.e2e`. The runner filters by substring, and this
  term matches only `multi-window.e2e.mjs` (S3).

**Parallel groups:** none. **Serial:** T3.1 → T3.2 → T3.3.
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/app.tsx`,
`test/e2e/harness.mjs`.

#### Task 3.1: Protocol members

**Files:** Modify `src/protocol.ts` (the `confirmQuit` member in `HostToWebview`; the
`quitDecision` / `quitDialogShown` members in `WebviewToHost`; add `quitAborted` and `quitAck`).

**Interfaces:** Produces the five members exactly as in Contracts.

**Call sites** (these fail typecheck until T3.2 and T3.3 land, which is expected inside this
slice):
- `electron/main.ts` `confirmWithRenderer` sends `confirmQuit`.
- `webview/app.tsx` posts `quitDialogShown` and `quitDecision`.

**Steps:**
- [ ] Edit the types. Typecheck is expected red until T3.3; do not stub it green.

#### Task 3.2: Main wiring

**Files:** Modify `electron/main.ts`, `src/quit-guard.ts` (delete `needsQuitConfirm`) and
`test/unit/quit-guard.test.ts` (delete its describe).

**Interfaces:** Consumes `createCloseGuard`, `createQuitGrant`, `CloseGuardDeps`,
`ACK_TIMEOUT_MS`, `SHOWN_TIMEOUT_MS` and `GRANT_TTL_MS` from `src/close-guard.ts`, and
`runningSessions` / `busySessions` from `src/quit-guard.ts`.

**Call sites removed:**
- `confirmWithRenderer` (its callers are `updateRelaunch` and `onWindowClose`).
- `needsQuitConfirm` (its only callers are main.ts `updateRelaunch` and `onWindowClose`).

**Steps:**
- [ ] Build `closeGuard = createCloseGuard({...})` where `windowConfirmed` is declared today. The
  deps:
  - **`windowIds`:** `BrowserWindow.getFocusedWindow()` first, then the rest of the live windows.
  - **`prepare`:** `if (w.isMinimized()) w.restore(); if (process.env.CONDUIT_E2E !== '1') w.show(); w.focus()`.
  - **`counts`:** today's `activity.apply(sessionsOwnedBy(sessionOwner, id, mgr.list()))` through
    `runningSessions` / `busySessions`.
  - **`ask`:** send `{type:'confirmQuit', ...ask}` to that window's webContents.
  - **`abort`:** send `{type:'quitAborted', requestId}`.
  - **`confirmUnresponsive(id, signal)`:** `dialog.showMessageBox(w, {type:'warning', buttons:['Wait','Close anyway'], defaultId:0, cancelId:0, message:"Conduit isn't responding.", detail:"Unsaved changes in this window can't be saved.", signal}).then(r => r.response === 1)`.
    Electron's `signal` option closes the box when the guard aborts it.
  - **`proceedApp`:** `quitGrant.issue()`, then `'quit'` → `setImmediate(() => app.quit())`, and
    `'update'` → `quitAndInstall()`.
  - **`proceedWindow(id)`:**
    - If the window is gone, do nothing.
    - If it is now the **only** live window (its sibling vanished mid-guard) and the platform is
      not darwin, treat it as the last window: `quitGrant.issue()`, then
      `setImmediate(() => app.quit())`. Sessions are kept for restore, and the window already
      consented (critic nit).
    - Otherwise: `windowConfirmed.add(id)`, `disposeSession` for each owned session, then
      `w.close()`.
  - **`resumeWindowClose(id)`:** if the window is alive, run the same decision as
    `onWindowClose` without an event: last window and not darwin → `app.quit()`, else
    `closeGuard.requestWindowClose(id)` (S4). Factor that decision into one local function,
    `closeDecision(w)`, called from both places.
  - **`setTimer` / `clearTimer`:** `setTimeout` / `clearTimeout`.
  - **`log`:** `log.warn`.
- [ ] `quitGrant = createQuitGrant({ttlMs: GRANT_TTL_MS, ..., onExpire: () => closeGuard.unlockAnswered()})`.
- [ ] `before-quit` becomes
  `(ev) => { if (tornDown) return; if (!quitGrant.consume()) { flushStateSync(); ev.preventDefault(); closeGuard.requestAppQuit('quit'); return; } tornDown = true; <existing body unchanged, starting with isQuitting = true, and it still calls flushStateSync()> }`.
  The unguarded-pass flush is B2: if the process dies while the guard waits, the atomic snapshot
  is already on disk. It is idempotent.
- [ ] In `createWindow`, add `w.on('session-end', () => flushStateSync())`, through an
  `opts.onSessionEnd` callback if `flushStateSync` is declared later. This is a flush only; D8
  still means no guard at OS shutdown.
- [ ] `onWindowClose(w, ev)` becomes:
  - `if (isQuitting || windowConfirmed.has(w.id)) return; ev.preventDefault(); closeDecision(w);`
  - `closeDecision(w)` is
    `windows.size === 1 && process.platform !== 'darwin' ? app.quit() : closeGuard.requestWindowClose(w.id)`.
- [ ] `case 'updateRelaunch'` becomes `closeGuard.requestAppQuit('update', senderWin?.id)`. Remove
  the `windowConfirmed` loop.
- [ ] Add `handle()` cases that resolve the sender with `BrowserWindow.fromWebContents(e.sender)`:
  - `quitAck` → `closeGuard.onAck(id, m.requestId)`
  - `quitDialogShown` → `onShown`
  - `quitDecision` → `onDecision(id, m.requestId, m.proceed)`
- [ ] In `createWindow`:
  - `w.on('unresponsive', () => closeGuard.onUnresponsive(w.id))`
  - In `render-process-gone`, call `closeGuard.onWindowGone(w.id)` before crash recovery.
  - In `closed`, call `closeGuard.onWindowGone(id)`.
  - Wire these through `opts` callbacks if `createWindow` has no access to `closeGuard` (it is
    declared later). Name them `onUnresponsive` and `onGone` in the `opts` type, beside
    `onClose` / `onClosed`.
- [ ] In `spawnWindow`, call `closeGuard.onWindowCreated(w.id)` after creation.
- [ ] Delete `confirmWithRenderer` and `RENDERER_TIMEOUT_MS`.
- [ ] Leave the single-instance loser `app.quit()` untouched; it runs before the listener exists.

#### Task 3.3: The modal slot, renderer protocol v2 (minimal) and test senders

**Files:**
- Create `webview/use-modal-slot.ts` (with **only** the `'confirm'` variant of `ModalEntry` for
  now; Task 4.2 adds `'dirty'`) and `test/unit/modal-slot.test.ts`.
- Modify `webview/app.tsx`:
  - the `confirm` state and **all 12 `setConfirm(` openers**, plus the `setConfirm(null)` in the
    dialog's `onClose` (grep `setConfirm(`; the lines at `main@de36575` are :477, :538, :649,
    :1634, :1713, :2184, :2211, :2592, :2605, :2777, :2787, :2804 and :3898);
  - `quitCancelRef` and `hunkConfirmRef`;
  - the `confirmQuit` branch in the host `subscribe` effect;
  - the `ConfirmDialog` render site.
- Modify `test/e2e/harness.mjs` (new `answerQuitAsks`, and `closeApp`),
  `test/e2e/quit-guard.e2e.mjs`, `test/e2e/renderer-crash-recover.e2e.mjs` (its `quitDecision`
  subscriber), `test/e2e/multi-window.e2e.mjs` and `test/e2e/multi-window-restore.e2e.mjs`.

**Interfaces:**
- Produces `ModalEntry` (the confirm variant), `ModalSlot`, `nextModalKey`, `useModalSlot` and
  `focusOpenModal`, exactly as in Contracts.
- Produces the harness export
  `answerQuitAsks(app, opts: { proceed: boolean }): Promise<{ asks: () => Promise<Array<{windowId: number, requestId: number, reason: string}>> }>`.
- Consumes the Task 3.1 protocol members, and `ConfirmState.onCancel` / `onShown` plus the
  `data-modal-default` marking from Task 2.5.

**Call sites:** every `setConfirm(` in `webview/app.tsx`. `hunk-actions.ts` only builds
`ConfirmState` values and is unchanged.

**Steps:**
- [ ] Failing `modal-slot.test.ts` (jsdom; the hook runs through a tiny harness component):

  | Test | Key assertion |
  |---|---|
  | 'open displaces and settles the previous entry via onCancel' | as named |
  | 'current is updated before the displaced settle runs' | inside the displaced `onCancel`, `slot.current.key` is the new key |
  | 'update with a different key is a no-op' | as named |
  | 'close only clears its own key, never settles' | as named |
  | 'dismiss settles then clears' | as named |
  | **'exit-warn during a quit dialog settles the ask'** (conductor-mandated) | open the quit session confirm, with `onCancel` posting `quitDecision{requestId:7, proceed:false}` to a recorder, then open a "Terminal exited" confirm through the slot → the recorder holds exactly `[{type:'quitDecision', requestId:7, proceed:false}]` |
  | 'a displaced closeDoc-style confirm resolves false' | a promise whose `onCancel` resolves false settles to false |

- [ ] Run. Expect FAIL. Then implement `webview/use-modal-slot.ts`.
- [ ] In app.tsx:
  - Replace `useState<ConfirmState|null>` with `const slot = useModalSlot()` and a helper
    `showConfirm = useCallback((state: ConfirmState) => slot.open({kind:'confirm', key: nextModalKey(), state}), [slot])`.
  - Every `setConfirm(x)` becomes `showConfirm(x)`.
  - Render `slot.current?.kind === 'confirm'` → `<ConfirmDialog state={slot.current.state} onClose={() => slot.close(key)}/>`.
  - Delete `quitCancelRef` and `hunkConfirmRef`. The hunk confirm (around :1634) now resolves
    through its `ConfirmState.onCancel: () => resolve(false)`. Its old "resolve the previous hunk
    confirm false before opening" line is covered by slot displacement.
  - If split-editor's `closeDoc` resolves `false` on cancel through the old `onClose` wiring, move
    that into its `ConfirmState.onCancel`. Re-run split-editor's close unit tests (`test/unit`
    files matching `close`); Cancel and displacement must both resolve `false`.
- [ ] The minimal `confirmQuit` branch, which Slice 4 replaces with the responder. Keep a
  `quitAskRef: { requestId, key } | null`.
  - **Re-probe:** if `msg.requestId === quitAskRef.current?.requestId` and
    `slot.current?.key === quitAskRef.current.key`, call `focusOpenModal()` and stop. If the ids
    match but the entry is gone, post `quitDecision{requestId, proceed:false}` and stop.
  - Otherwise, post `quitAck{requestId}`.
    - `running === 0`: post `quitDecision{requestId, proceed:true}` with no dialog.
    - Else `showConfirm` today's session copy with:
      - `focusCancel: true`
      - `onShown: () => post({type:'quitDialogShown', requestId})`
      - `onCancel: () => post({type:'quitDecision', requestId, proceed:false})`
      - `onConfirm: () => post({... proceed:true})`
    - Record `quitAskRef` for it.
- [ ] `harness.mjs`:
  - `answerQuitAsks(app, {proceed})` installs, in **every current and future window**, a
    renderer-side `agentDeck.subscribe` hook (re-installed on each `app.on('window')` page). The
    hook records `confirmQuit` and answers `quitDecision{requestId: msg.requestId, proceed}`.
  - `closeApp` uses it. When more than one window was open at the start, it asserts that an ask
    arrived from every window that owned a running session (S3), then waits for zero windows as
    today.
- [ ] `multi-window.e2e.mjs`: before its `fromId(id).close()` steps, call
  `answerQuitAsks(app, {proceed:true})`. Its assertions on window counts stay unchanged.
- [ ] `multi-window-restore.e2e.mjs`: call `answerQuitAsks(app, {proceed:true})` before launch 1's
  `app.quit()`, so the guard proceeds. Launch 2's restore assertions stay unchanged.
- [ ] `quit-guard.e2e.mjs`:
  - Every posted `quitDecision` echoes the last captured `requestId`.
  - Part 5 ("no running sessions"): assert that `confirmQuit` **is** received, no
    `[role="alertdialog"]` appears, and the app closes within 10 s.
  - Part 4 keeps `reason==='update'`. Its Cancel leaves the app alive.
- [ ] `renderer-crash-recover.e2e.mjs`: echo `msg.requestId`.
- [ ] Run the slice check.

### Slice 4: Dirty dialog on quit and window close

**Check:** the new unit tests are green, typecheck is green, and after `npm run build`
`node test/e2e/run-smoke.mjs dirty-quit` runs **both** `dirty-quit.e2e.mjs` and
`dirty-quit-saves.e2e.mjs` green. The substring also matches `dirty-quit-windows`; that is fine
once it exists (Slice 6). While it doesn't, the filter matches the two files alone.

**Parallel groups:** G6: T4.1 · G7: T4.2 · Serial: T4.3 → T4.4
**Claims (serial lane):** `webview/styles.css`, `webview/app.tsx`

#### Task 4.1: Quit responder

**Files:** Create `webview/quit-responder.ts` and `test/unit/quit-responder.test.ts`.

**Interfaces:**
- Produces `createQuitResponder`, `QuitResponderDeps`, `FLUSH_BOUND_MS` and `SETTLE_BOUND_MS`, as
  in Contracts.
- Consumes:
  - `DirtyAsk` / `DirtyAnswer`, as declared in `webview/use-dirty-close.ts` by Task 4.2. Use
    `import type`; the names and shapes are fixed in Contracts.
  - `FileSaves['flushAll'|'whenIdle'|'setToastsSuppressed']`.
  - `AutoSaveMode` from `src/settings.ts`.
  - `QuitReason` from `src/quit-guard.ts`.

**Steps:**
- [ ] Failing tests (with fake deps):

  | Test | Key assertion |
  |---|---|
  | 'posts quitAck before anything else' | `posts[0]` is `quitAck` |
  | 're-probe while asking focuses, posts nothing' (B1b) | a second `confirmQuit` with the same id → `focusDialog` called; no new post |
  | 're-probe after done answers proceed:false' (B1b) | as named |
  | 're-probe while flushing/settling is ignored' | as named |
  | 'Don't Save sets discarded; Save All and Cancel don't' (B3) | `discarded()` is `true` only after `'discarded'` |
  | 'quitAborted or a new ask clears discarded' (B3) | as named |
  | 'quitAborted for the in-flight id ends the flow' (S2) | the ask's `signal` is aborted; no `quitDecision` is posted afterwards; `setLocked(true)` is never called, even if the aborted ask later resolves |
  | 'quitAborted for the locked id unlocks' | as named |
  | 'off mode: no flush, no suppression' | as named |
  | 'autoSave on: flush raced against 5 s' | a never-resolving `flushAll` still reaches the decision after `FLUSH_BOUND_MS` |
  | 'nothing dirty + running 0 → proceed, no ask' | as named |
  | 'nothing dirty + running → askSessions' | as named |
  | 'dirty → askDirty with running/busy/reason' | as named |
  | 'onShown posts quitDialogShown{requestId}' | as named |
  | 'proceed waits whenIdle bounded 5 s then posts' | as named |
  | 'windowClose proceed does not lock; quit/update proceed locks before posting' | as named |
  | 'cancel posts proceed:false' | as named |
  | 'suppression cleared in finally, even on throw' | as named |
  | 'onQuitAborted with an unknown id is ignored' | as named |

- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 4.2: Dirty dialog, scrim and hook

**Files:**
- Create `webview/components/dirty-close-dialog.tsx`, `webview/components/quit-scrim.tsx`,
  `webview/use-dirty-close.ts` and `test/unit/dirty-close-dialog.test.ts`.
- Modify `webview/use-modal-slot.ts`: add the `'dirty'` variant to `ModalEntry`, and its
  `props.onCancel()` settle.

**Interfaces:**
- Produces `DirtyCloseDialogProps`, `DirtyCloseDialog`, `QuitScrim`, `DirtyAsk`, `DirtyAnswer`
  (`'saved' | 'discarded' | 'cancel'`), `useDirtyClose` and the `ModalEntry` `'dirty'` variant,
  exactly as in Contracts.
- Consumes:
  - `dirtyCloseCopy`, `dirtySaveStatus`, `DirtyCloseCopy`, `DirtyCloseReason`, `DirtyFile` from
    `src/quit-guard.ts`.
  - `unsavedFiles`, `saveUnsaved`, `SaveProbe` from `webview/unsaved-files.ts`.
  - `useFocusTrap` from `webview/use-focus-trap.ts`.
  - `ModalSlot`, `nextModalKey` from `webview/use-modal-slot.ts` (Task 3.3).
  - `ModalLayer` from `webview/components/modal-layer.tsx`.
- `useDirtyClose` must not import the `webview/file-saves.ts` singleton. It takes `saves`
  (including `subscribe`) and `slot` via deps.

**Steps:**
- [ ] Failing jsdom tests for `DirtyCloseDialog`:

  | Test | Key assertion |
  |---|---|
  | 'initial focus is Save All' | as named |
  | 'saving disables Save All and Don't Save, Cancel enabled' | as named |
  | 'Escape calls onCancel' | via ModalLayer |
  | 'rows show dir and tag text; danger class on failed' | as named |
  | 'overflow line' | as named |
  | 'onShown once' | as named |
  | 'ul aria-label Unsaved files; status aria-live polite' | as named |

- [ ] Failing tests for the hook, rendered through a tiny harness component in the same test file:

  | Test | Key assertion |
  |---|---|
  | 'Save All all-clean → saved, entry closed' | as named |
  | 'Save All partial failure → stays, files cut to unsaved, status "1 file couldn't be saved"' | as named |
  | 'Don't Save → discarded' | as named |
  | 'Cancel while saving → cancel' | as named |
  | 'displaced by a confirm opened through the slot → cancel' | as named |
  | 'second ask displaces the first → first resolves cancel' | as named |
  | 'aborting signal closes without settling → cancel, onCancel side effects not run twice' | as named |
  | 'settles exactly once' | as named |
  | 'a listed path turning clean re-tags "Saved" via saves.subscribe' | as named |

- [ ] Run. Expect FAIL.
- [ ] Implement.

#### Task 4.3: Styles

**Files:** Modify `webview/styles.css` (the `.confirm*` block, around :8110).

**Steps:**
- [ ] Add these rules, using existing tokens only:
  - `.confirm--files`: a wider `max-width` of `min(560px, calc(100vw - 32px))`.
  - `.confirm__files`: `max-height: 40vh`, `overflow: auto`, no list bullets.
  - `.confirm__file`: one line per row, `min-width: 0`, name with `overflow: hidden`.
  - `.confirm__file-dir`: the muted text token `.confirm__msg`-adjacent rules already use.
  - `.confirm__file-tag--danger`: the danger token `.btn--danger` uses.
  - `.confirm__file-group`, `.confirm__status`.
  - `.confirm__actions { flex-wrap: wrap }`.
  - `.quit-scrim`: centered text over the existing backdrop.
  - `@media (forced-colors: active) { .confirm .btn:focus-visible { outline: 2px solid Highlight } }`.
- [ ] Run `npx vitest run test/unit/monaco-class-collision.test.ts test/unit/drag-region.test.ts`.

#### Task 4.4: App glue for quit, and the e2e

**Files:**
- Modify `webview/app.tsx`: the `confirmQuit` branch and `quitAskRef` from T3.3, the
  `beforeunload` effect and the slot render site.
- Create `test/e2e/dirty-quit-helpers.mjs`, `test/e2e/dirty-quit.e2e.mjs` and
  `test/e2e/dirty-quit-saves.e2e.mjs`.

**Interfaces:**
- Consumes:
  - `createQuitResponder(deps)`, which returns `{onConfirmQuit, onQuitAborted, discarded}`.
  - `useDirtyClose({saves, rootOf, slot})`, which returns `{ask}`.
  - `DirtyCloseDialog`, `QuitScrim`, `focusOpenModal`, `isHosted` from `webview/bridge.ts`, and
    `fileSaves` from `webview/file-saves.ts`.
- `fileSaves` now has `whenIdle`, `setToastsSuppressed`, `isPartial`, and the existing
  `subscribe`.

**Steps:**
- [ ] In app.tsx:
  - Create `dirtyClose = useDirtyClose({ saves: fileSaves, rootOf, slot })`. `rootOf(path)`
    returns the longest root in the owning session's `roots` / `home` that prefixes `path` after
    `canonicalPath` on both sides.
  - Add `const [quitLocked, setQuitLocked] = useState(false)`.
  - Create `responder = useMemo(() => createQuitResponder({...}), [])`, reading live values
    through refs:
    - `autoSaveMode`: a settings ref.
    - `dirtyPaths`: `() => [...getDirtySnapshot()]`.
    - `askDirty`: `dirtyClose.ask`.
    - `askSessions`: `showConfirm` with `quitConfirmCopy`, `focusCancel:true`, `onShown`, and
      `onCancel`/`onConfirm` resolving false/true. When `signal` aborts, it calls
      `slot.close(key)` without settling.
    - `focusDialog`: `focusOpenModal`.
    - `setLocked`: `setQuitLocked`.
    - `wait`: a `setTimeout` promise.
    - `log`: the bridge log.
  - Replace the T3.3 `confirmQuit` branch (and `quitAskRef`) with
    `void responder.onConfirmQuit(msg)`. Add a `quitAborted` branch →
    `responder.onQuitAborted(msg.requestId)`.
  - Render `slot.current?.kind === 'dirty'` → `<DirtyCloseDialog {...slot.current.props}/>` beside
    the confirm branch, and `{quitLocked && <QuitScrim/>}`.
  - **`beforeunload` (B3):** keep the save-all under Electron. The effect body becomes
    `if (isHosted && responder.discarded()) return;` followed by today's
    `const dirty = getDirtySnapshot(); if (dirty.size > 0) void saveAllDirtyDocs(dirty);`.
    It is the backstop for every guard give-up path.
- [ ] `dirty-quit-helpers.mjs` exports:
  - `launchDirty({ autoSave?: AutoSaveMode, files?: Record<string,string> })`. It launches hidden,
    opens a `shell:cmd` session on a temp root holding `a.ts`, opens `a.ts` and types `EDIT` at
    the start. It returns `{app, page, root}` and reuses `auto-save-helpers.mjs` `openFile` /
    `typeAtStart` / `setMode` / `isDirty` / `disk`.
  - `dirtyDialog(page)`: waits for `.confirm--files`.
  - `clickDialog(page, label)`.
  - `waitExit(app, ms)`.
  - `sessionStatus(page)`.
- [ ] `dirty-quit.e2e.mjs`: phases selectable by the `ONLY` env var, each in its own app.
  - **`saveAll`:**
    1. Close the last window with `BrowserWindow.getAllWindows()[0].close()`.
    2. The dialog title is `Do you want to save the changes you made to a.ts?` and the list has
       `a.ts`.
    3. A running line is present, and the session status is still `running` (A1).
    4. Click `Save All`. The app exits and `a.ts` on disk starts with `EDIT`.
  - **`dontSave`:** the same close, then `Don't Save`. The app exits and disk equals the original
    (A3). This also proves the `discarded` skip of the `beforeunload` backstop.
  - **`cancel`:**
    1. `app.evaluate(({app}) => app.quit())`, then the dialog, then `Cancel`.
    2. The window is open, the session is `running`, and `a.ts` is still dirty.
    3. No `[role="alertdialog"]` containing `Terminal exited` is present (C3 gone).
    4. Open a second session. Within 5 s, `sessions.json` in userData lists 2 sessions (A4/I1).
- [ ] `dirty-quit-saves.e2e.mjs`, also `ONLY`-selectable phases:
  - **`autoSave`** (A6): `afterDelay` at 1000 ms, with `EDIT` typed immediately before closing.
    Only the session dialog appears (`[role="alertdialog"]` without `.confirm--files`). Click
    Quit; disk has `EDIT`.
  - **`failure`** (A7):
    1. Replace the `writeFile` invoke handler with one returning `{ok:false, error:'EACCES'}`,
       using the same `ipcMain._invokeHandlers` technique as `auto-save-helpers.mjs` `spyWrites`.
    2. Quit, then `Save All`.
    3. The dialog stays, the row text contains `save failed`, and the app is alive after 3 s.
    4. Clean up with `Don't Save`.
  - **`conflict`:**
    1. `afterDelay`. Type `EDIT`, and before the delay fires, write different content to `a.ts`
       with Node `fs`, so the auto-save lands in conflict.
    2. Quit. The row shows `changed on disk — Save All overwrites it`.
    3. `Save All`: the app exits, and the disk holds the buffer (starts with `EDIT`).
- [ ] Run the slice check.

### Slice 5: Session close and move gating

**Check:** related units and typecheck are green, and after `npm run build`,
`node test/e2e/run-smoke.mjs dirty-session-close` and
`node test/e2e/run-smoke.mjs exit-closes-session` pass alone.

**Parallel groups:** none. **Serial:** T5.1.
**Claims (serial lane):** `webview/app.tsx`

#### Task 5.1: `guardSessionRemoval` and its callers

**Files:**
- Modify `webview/app.tsx` (`requestKill`, `closeSessions`, the exited-shell warn branch of the
  status effect, `moveMenuItems`, `cmd:moveSessionNewWindow`, the `onSessionDragEnd` prop).
- Modify `src/window-registry.ts` (add `DRAG_STAY_INSET_PX` and `pointWellInside`) and
  `test/unit/window-registry.test.ts` (create it if absent).
- Create `test/e2e/dirty-session-close.e2e.mjs`.

**Interfaces:**
- Consumes:
  - `sessionDirtyPaths(docs, sessionIds, dirty)` from `webview/unsaved-files.ts`.
  - `dirtyClose.ask(req: DirtyAsk): Promise<'saved'|'discarded'|'cancel'>`.
- Produces `DRAG_STAY_INSET_PX = 8` and
  `pointWellInside(r: Rect, p: ScreenPoint, inset: number): boolean`.
- Produces, app-internal:
  `guardSessionRemoval(ids: string[], reason: 'sessionClose' | 'sessionMove', proceed: () => void, opts?: { exitedSession?: string }): void`.

**Steps:**
- [ ] `guardSessionRemoval`:
  - `paths = sessionDirtyPaths(docsRef.current, ids, getDirtySnapshot())`. If empty, call
    `proceed()`.
  - Otherwise `ask({reason, paths, running, busy, exitedSession, grouped: ids.length > 1, sessionOf})`:
    - `running` and `busy` count `ids` sessions with `status==='running'` (and `busy`).
      `running` is 0 for `sessionMove`.
    - `sessionOf` maps a path to the title of the first of `ids` whose docs contain it.
    - `'saved'` or `'discarded'` → `proceed()`. `'cancel'` → nothing.
- [ ] `requestKill(id)`: first `if (sessionDirtyPaths(...).length) return guardSessionRemoval([id], 'sessionClose', () => post({type:'kill', id}))`.
  This runs regardless of `confirmCloseRunning` (A9). Otherwise, today's path.
- [ ] `closeSessions(ids, …)`: the same guard at the top, with `killAll` as `proceed`.
- [ ] Exited-shell `'warn'`: if the session has dirty paths,
  `guardSessionRemoval([s.id], 'sessionClose', () => post({type:'kill', id: s.id}), {exitedSession: s.title})`.
  Otherwise, today's "Terminal exited" confirm.
- [ ] Moves:
  - `moveMenuItems` items and `cmd:moveSessionNewWindow` wrap their `post({type:'session:move', …})`
    in `guardSessionRemoval([sessionId], 'sessionMove', post…)`.
  - `onSessionDragEnd(sessionId, x, y)`: if
    `pointWellInside({x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight}, {x, y}, DRAG_STAY_INSET_PX)`,
    post as today; the drop stayed well inside this window and the host no-ops. Otherwise, guard
    then post. This fails safe: edge and frame drops prompt (S1).
  - Check that `Rect` / `ScreenPoint` field names match `src/window-registry.ts`, and use them as
    declared.
- [ ] `window-registry.test.ts`, failing first:

  | Test | Key assertion |
  |---|---|
  | 'center point is well inside' | `true` |
  | 'a point 4px from the edge is not' | `false` |
  | 'a point outside is not' | `false` |
  | 'an inset larger than half the rect → never inside' | `false` |
- [ ] `dirty-session-close.e2e.mjs`, with `confirmCloseRunning:false` set via `updateSettings`:
  - **`close`:**
    1. Dirty `a.ts` in session S. Close S from the rail (the session's close control).
    2. The dirty dialog appears. `Cancel` → S still listed and the `a.ts` tab still dirty.
    3. Close again, then `Don't Save`. S is gone and the disk is unchanged.
  - **`move`:**
    1. Dirty `a.ts`, then the context menu "Move to new window".
    2. The dirty dialog appears. `Cancel` → one window, S still owned, `a.ts` still dirty.
    3. Again, then `Save All`. The disk has `EDIT` and two windows exist.
- [ ] Run the slice check.

### Slice 6: Multi-window and update scenarios, changelog, gate

**Check:** `node test/e2e/run-smoke.mjs dirty-quit-windows` passes alone. Then
`node G:/awby/projects/conduit/.autoloop/heavy-lock.mjs <cwd> npm run verify; echo EXIT=$?`
prints `EXIT=0`. Then the touched scenarios run alone and serially: `quit-guard`,
`exit-closes-session`, `renderer-crash`, `multi-window-restore`, `multi-window.e2e`, `dirty-quit`
(which covers all three dirty-quit files) and `dirty-session-close` (S3).

**Parallel groups:** none. **Serial:** T6.1 → T6.2.
**Claims (serial lane):** `CHANGELOG.md`

#### Task 6.1: Multi-window and update e2e

**Files:** Create `test/e2e/dirty-quit-windows.e2e.mjs`.

**Steps:**
- [ ] Phase **`nonLast`**:
  1. Seed `agents.json` in a fresh userData with an agent whose command exits immediately
     (`cmd.exe /c exit 0`). `sessionExitAction` keeps agent sessions (`'ignore'`), so the session
     stays `exited`.
  2. Open window 2 (`post({type:'win:new'})`), start that agent there, and open and dirty `a.ts`
     in window 2.
  3. Close window 2. The dirty dialog appears in window 2, and window 1 shows no dialog. Click
     `Cancel`: window 2 stays.
  4. Close it again and click `Don't Save`. One window remains.
- [ ] Phase **`twoWindows`**:
  1. Both windows have a dirty file, then `app.quit()`.
  2. Window 1 gets the dialog and answers `Save All`. It then shows `.quit-scrim`.
  3. Window 2 gets the dialog and answers `Cancel`.
  4. Both windows are open, and `.quit-scrim` is gone from window 1. Window 1's file is on disk;
     window 2's is still dirty.
- [ ] Phase **`closeAll`** (S4):
  1. Two windows, each with a running shell session.
  2. Call `close()` on both windows back to back, in one `app.evaluate`.
  3. Answer each ask `proceed:true` through `answerQuitAsks`, as it arrives.
  4. Assert: exactly one ask is live at a time; the second window's ask arrives after the first
     settles, with no second close needed; and the app exits within 15 s. The second close found
     itself the last window and became an app quit.
- [ ] Phase **`update`**:
  1. Dirty `a.ts`, then `post({type:'updateRelaunch'})`.
  2. The dialog includes `Conduit will relaunch to install the update.`. `Cancel`: no scrim, and
     the app is alive.
  3. Again, then `Save All`. The disk has `EDIT` and `.quit-scrim` shows.
  4. Within 8 s the scrim is gone and the app is alive. Unpackaged, `quitAndInstall` doesn't
     quit, so the 5 s grant expires; that proves the grant path (A2 by ordering, unit-pinned).
- [ ] Run `node test/e2e/run-smoke.mjs dirty-quit-windows`.

#### Task 6.2: Changelog, spec index, gate

**Files:** Modify `CHANGELOG.md` and `docs/specs/INDEX.md` (status of the dirty-quit-guard row).

**Steps:**
- [ ] Add a CHANGELOG entry under Unreleased with these user-facing lines:
  - Quitting, closing a window, relaunching for an update, and closing or moving a session now
    ask to save unsaved files.
  - One dialog replaces the stacked prompts.
  - Enter in confirm dialogs activates only the focused button.
- [ ] Run the gate with the exit code captured. Red means fix the code; never touch a check.
- [ ] Run the touched e2e alone and serially, as in the slice check.
- [ ] Make sure `git status` shows only intended files, and delete any scratch.

## Verification

- **Per task:** the task's own vitest file(s), plus `npm run typecheck` when types change.
- **Per slice:** the slice's **Check** line. e2e always runs after `npm run build`, one scenario
  at a time, hidden.
- **Once, at the end (Slice 6):** `node G:/awby/projects/conduit/.autoloop/heavy-lock.mjs <cwd> npm run verify; echo EXIT=$?`.
  If `.autoloop/heavy.lock` is held, the wrapper waits. Don't delete the lock unless its
  `owner.txt` is older than 45 min.
- **Hand checks no e2e can make:**
  - The native **Wait / Close anyway** box (Playwright can't drive native dialogs). This is
    covered by the `close-guard` unit tests only; mark it `needs-human-smoke`.
  - Real window-blur flush (hidden windows emit no `blur`).

## Deviation rule

If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece
becomes the work. Examples:
- A1 is false.
- `fileSaves.save` can't report a clean phase.
- Split-editor renamed `filePathsClosedWithSession` or `closeDoc`'s cancel settles elsewhere.
- `createWindow` can't reach the guard.

Never a shim, second copy, special case, widened type (for example, making `requestId` optional),
fallback, or a timeout raised to paper over ordering. The report leads with the fix that keeps
the locked decision.

## Decisions Needed

- [normal] **What an update request does to windows already asked.** An update request that
  joins a pending quit guard upgrades the reason only for windows not yet asked. Windows already
  asked saw "quit" copy. *Default taken:* no re-ask; the app relaunches anyway.
- [normal] **Drag-end gating (S1, locked).** Drag-end is gated unless the drop point is
  `DRAG_STAY_INSET_PX` (8 px) inside the source window. A drop on the source's own sidebar never
  prompts. *Default taken:* 8 px.
- [normal] **A displaced quit dialog cancels the quit (B1a, locked).** Any confirm opened while a
  quit or close dialog is up, including the automatic "Terminal exited", cancels that attempt. The
  user re-triggers the quit. *Default taken:* as locked. The alternative, queueing the newcomer
  behind the quit dialog, was not chosen by the critic.
- [normal] **Partly-loaded paths.** `isPartial` paths are unsaveable in the guard (D13) but stay
  saveable from the palette's Save All, as today. *Default taken:* guard-only rule; the palette
  is not changed (C12 is out of scope beyond the guard).
- [normal] **Last-window close on darwin.** On darwin, closing the last window uses the window
  guard, so the app stays open. *Default taken:* keeps darwin's "app outlives windows" behaviour.

## Run notes

- **Slice 1 (2026-09-29): A1 = true.** Probe on a hidden build of `feat/dirty-quit-guard@8466702`
  (evidence `.autoloop/evidence/dirty-quit-guard/a1-probe-final.log`, control in
  `a1-control4.log`). A prepended `before-quit` listener that `preventDefault`s the first pass
  left the window alive (`bq=1, windows=1` after 1 s); a second `app.quit()` fired `before-quit`
  again (#2) and the process exited with code 0 after ~260 ms.
  - Measurement gotcha: a fresh profile starts with a running session, so today's
    `onWindowClose` guard sends `confirmQuit` and blocks the close until a `quitDecision` arrives.
    The first probe run left that unanswered and read as `A1=false` (no exit in 15 s); the
    control (a single `app.quit()` with no `preventDefault`) timed out the same way. With the
    renderer auto-answering `quitDecision{proceed:true}`, both control and probe exit.
  - Also observed: `window-all-closed` → `app.quit()` fires `before-quit` a further time
    (#3) inside the same quit, so the Slice 3 `tornDown` guard is load-bearing.
- **Slice 2 (2026-09-29): done** — T2.1 `b9f35cf`, T2.2 `8ec5b83`, T2.3 `086b188`, T2.4 `4cdcf84`,
  T2.5 `26bd765`. Slice check: 5 files / 138 tests green, typecheck green.
  - T2.2: A3 held on current code (no controller fix). The contract's `autoEligible:false` is the
    code's `AttachOpts.writable === false` (renamed since the auto-save plan); `isPartial` reads it.
    Preview-toast suppression also silences the partial-file refusal toast (same branch).
  - T2.1 interpretations (no API change): the unresponsive box opens only in `shown`; only windows
    that *answered* proceed are aborted on cancel/expiry (timed-out ones already got S2's abort);
    a re-probe re-sends the original ask even after a reason upgrade; `confirmUnresponsive` must
    not reject (Slice 3's main implementation).
  - Not built here: `pointWellInside` / `DRAG_STAY_INSET_PX` belong to Slice 5 (T5.x), not Slice 2.
  - Slices 3+ held until split-editor merges (they touch app.tsx / docs.ts / center-pane).
- **Merge of main (2026-09-29, `60d1720`):** split-editor + Electron 43.7.6 landed; one conflict
  (`test/unit/file-save-controller.test.ts`, both sides kept). Dirty state stayed per path; session
  gating reads `filePathsClosedWithSession` through `sessionDirtyPaths` as planned.
- **Slice 3 (2026-09-29): done** — T3.1 `2adc532`, T3.2 `a3ca900`, T3.3 `41604c0`. Units 427 files
  green; e2e quit-guard, exit-closes-session, renderer-crash, multi-window(-restore) green.
  - The runner's filter strips `.e2e.mjs`, so `multi-window.e2e` matches nothing; `multi-window`
    runs both multi-window scenarios (serially).
  - `closeApp` now quits with `app.quit()` (not a close of window 0) so a multi-window app exits and
    every window's ask can be asserted (S3). `answerQuitAsks` reports asks over the page console so
    they survive the window closing.
  - The closeDoc prompt's `closePromptRef` went the same way as `quitCancelRef`/`hunkConfirmRef`:
    its answer is now `ConfirmState.onCancel`, and displacement covers the "settle the previous
    prompt" line.
- **Slice 4 (2026-09-29): done** — T4.1 `2862999`, T4.2 `c4be689`, T4.3 `d1d6238`, T4.4 `b67ed08`.
  - `quitConfirmCopy` now takes a `running` count instead of `Session[]`; the renderer only ever
    had counts and used to fake sessions to call it.
  - Responder: a superseded flow's `finally` leaves toast suppression to the flow that replaced it;
    a throwing ask posts no decision (the host's timeouts cover it).
- **Slice 5 (2026-09-29): done** — T5.1 `72ee199`. The exited-shell warn uses the session's
  `name` (the plan said `title`; `Session` has no `title`).
- **Slice 6 (2026-09-29): built, gate NOT green** — T6.1 `a5ceafe` (+ style fix `e717000`).
  - Found by `closeAll`: a queued window close resumed before the proceeded window's `'closed'`
    event, so `closeDecision` still counted it and asked with window-close copy. Fixed in main
    (`openWindowCount` skips `windowConfirmed`); the phase now asserts the second ask is a `quit`.
  - The planned forced-colors rule was dropped: `state-vocabulary.test.ts` forbids a solid outline
    on `:focus`, and the global ring already switches to `Highlight` under forced colors.
  - Gate: `verify-s6b.log` EXIT=1 on fallow dead-code "Duplicate exports": `webview/app.tsx` now
    imports both `src/layout.ts` and `src/window-registry.ts`, which each export `parseLayout` /
    `serializeLayout` (base 60d1720 is clean). Proposed fix: rename window-registry's pair to
    `parseWindowLayout` / `serializeWindowLayout` (callers: electron/main.ts, its test).
  - **Incident:** a base-commit worktree removed with `git worktree remove --force` followed the
    node_modules junction chain and emptied `G:\awby\projects\conduit\node_modules`. Needs
    `npm ci` in the main checkout before anything can run again.
