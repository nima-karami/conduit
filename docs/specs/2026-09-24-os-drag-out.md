---
status: draft
date: 2026-09-24
---

# Feature Spec: os-drag-out — drag and copy files out of Conduit to the OS and other apps

**Tier:** FULL   **Feature type:** UI (Files tab rows, explorer Copy) plus a new host IPC boundary.
**One-line request:** "copy/pasting or dragging a file/folder from Conduit onto another folder where a
file upload or paste is possible should work that way. Mirror VSCODE functionalities there as well
obviously."

Autonomous mode. Built on `feat/multi-folder` at `1158688`. This spec covers behavior only. File
placement and structure belong to the plan.

## 0. What VS Code actually does (research, cited)

The sources are microsoft/vscode `main` and Electron `v43.3.0`, the version pinned in `package.json`.

| Capability | VS Code desktop | Source |
|---|---|---|
| Drag a **file** from the explorer to Explorer/Finder | Works, but only for the **first non-directory item**, via Chromium `DownloadURL` (`application/octet-stream:<name>:<file-uri>`) | `src/vs/workbench/browser/dnd.ts` `fillEditorsDragData` L244-255, whose comment reads "only a single file is supported"; `explorerViewer.ts` `onDragStart` |
| Drag a **folder** or a **multi-selection** out | **Not supported.** A folder arrives as a 1 KB `.fileloc` stub and extra items are dropped | issue #321497 (open); umbrella #164 "native file data transfer" (open, On Deck) |
| Other drag surfaces | Tabs, breadcrumbs, Open Editors, SCM rows and search results all go through `fillEditorsDragData`, so each gets `DownloadURL` for a single file | `editorTabsControl.ts:573`, `scmViewPane.ts:211`, `searchView.ts:985` |
| `webContents.startDrag` | **Never called** anywhere in the repo | code search |
| Explorer **Copy → paste in OS file manager** | **Not supported.** Copy writes a private `code/file-list` buffer | `services/clipboard/electron-browser/clipboardService.ts`; #156098 and #336084 closed as dups of #164 |
| Prior attempt at OS clipboard files | PR #320685 wrote `NSFilenamesPboardType` (mac: Finder paste **PASS**) and `FileNameW` (Windows: **FAIL**, #321404). It was reverted twice (#321516, #323490). Its own comment says CF_HDROP "requires a predefined format ID that Electron cannot write" | PR #320685, TPI #321354 |
| Electron `startDrag({file, files?, icon})` | Windows/Linux: `OSExchangeData::SetFilenames` (real CF_HDROP) with **`DRAG_COPY \| DRAG_LINK`**, so a target can never *move* our file. Mac: one `NSURL` per path. A missing icon throws. An empty icon **silently does nothing**. **It blocks the main process until drop on Windows/Linux** (electron #45197) and there is **no drag-end event** (#35852). The renderer must `preventDefault()` its `dragstart` (#36808) | `electron_api_web_contents.cc` L3876-3905, `drag_util_views.cc`, `docs/tutorial/native-file-drag-drop.md` |
| `clipboard.writeBuffer(fmt, …)` | Registers a *named custom* format and holds one format per call. `writeBuffer('CF_HDROP')` is **not** the predefined format 15 | `electron_api_clipboard.cc` L184-202 |

**Where this spec goes beyond parity (D1, D2):** the user explicitly says "file/**folder**" and "where a
file upload **or paste** is possible". VS Code supports neither folder/multi drag-out nor OS-clipboard
copy, so parity would not do what was asked. We use a real native drag (`startDrag`) for explorer rows,
and a real OS file clipboard for explorer Copy on Windows and macOS.

## 1. Problem frame

- **Job:** get project files into another place without leaving Conduit to find them in Explorer
  first. That place might be a folder in Windows Explorer or Finder, a browser upload drop zone, or a
  Slack, Teams or email compose box. The user either drags them there or copies and pastes them.
- **Actors:**
  - the user, with a mouse and keyboard;
  - the renderer, which only *asks*;
  - the host, which validates the paths and performs the OS drag or clipboard write;
  - external drop and paste targets.
- **Success outcomes (observable):**
  1. Dragging one file, one folder or a multi-selection from the Files tree onto an Explorer/Finder
     folder produces real copies there. The originals are untouched.
  2. The same drag onto a Chrome upload zone or a Slack/Teams compose box attaches the real file(s).
  3. On Windows and macOS, explorer **Copy** (Ctrl/Cmd+C or the menu) followed by **Paste** in
     Explorer/Finder pastes copies.
  4. Internal Files-tree drag (move by default, Ctrl for copy, spring-open, a single drop highlight,
     conflict prompts) and drags onto the terminal keep working.
  5. The host never starts a drag or writes a clipboard entry for a path outside the requesting
     session's present folders, either lexically or after resolving symlinks.
- **Non-goals:**
  - Pasting *into* Conduit from the OS clipboard (files copied in Explorer, then Ctrl+V in the tree).
  - Cut to the OS clipboard, meaning a move-paste in Explorer.
  - Linux OS clipboard files (D4).
  - Drag-out from quick open or breadcrumbs.
  - Dragging editor *content* as a file.
  - Changing how the terminal formats a path.

## 2. Behavior & states

### 2.1 Current behavior (source inspection at `1158688`, not runtime-measured; see D11)

| Claim | How established | Status |
|---|---|---|
| Explorer row `dragstart` sets `text/plain` (newline-joined top-level paths), `application/x-conduit-path` (the grabbed row only) and `effectAllowed='copyMove'`, then stores `draggedPaths` pane-wide | `files-view.tsx:444-448`, `folder-section.tsx:461-470` | ASSUMED (source) |
| An OS drag out delivers no file: only text reaches external targets | no `DownloadURL` and no `startDrag` anywhere (`grep` over `webview/ electron/ src/`) | ASSUMED (source) |
| Explorer Copy/Cut are in-app state only ("Not the OS clipboard"), and they announce synchronously | `files-view.tsx:159, 477-493` | ASSUMED (source) |
| Drop routing: `draggedPaths.length===0 && files>0` goes to the OS-import/attach flow. Otherwise it is an internal move/copy from `draggedPaths`, or from `text/plain` for a cross-window drop | `folder-section.tsx:510-523` | ASSUMED (source) |
| The terminal accepts `x-conduit-path` (one path) or `Files` (all paths) | `terminal-pane.tsx:775-805` | ASSUMED (source) |
| Tabs, Changes rows and search results carry no file data. Tabs drag only for reorder/dock | `doc-tabs.tsx:197-250`; no `draggable` in `changes-view.tsx` / `search-pane.tsx` | ASSUMED (source) |
| A `Files` drop on any region that doesn't `preventDefault` navigates the app window to the `file:` URL. `will-navigate` allows every `file://` and there is no global drop guard. This is already true for Explorer→Conduit drops today | `main.ts:1047-1051`; no document-level `dragover`/`drop` listener in `webview/` | ASSUMED (source) |
| Row `dragend` → `pane.endDrag` clears `draggedPaths`, and the spring re-collapse effect is keyed on that | `folder-section.tsx:446-455, 1000` | ASSUMED (source) |

### 2.2 Drag out of the Files tree (MVP)

1. The user presses and drags a row. The drag set follows today's rule: the whole selection if the
   grabbed row is part of a multi-selection, otherwise just the grabbed row, and it is reduced with
   `topLevelPaths`. The renderer records the set as the pane's **outgoing drag**, keeping today's
   `draggedPaths` plus a fresh `dragId`. It then calls `preventDefault()` on the HTML5 `dragstart` and
   sends `fs:startDrag {dragId, sessionId, paths}`.
2. The host validates the request (§3.1). If it passes, the host sends `fs:dragStarted {dragId}` and
   then calls `event.sender.startDrag({ file: paths[0], files: paths, icon })` with a bundled icon (D6).
   If it fails, the host starts no drag and replies `fs:dragRefused {dragId, …}`.
3. The OS drag now runs. External targets receive real paths (CF_HDROP / NSURL) with copy or link
   only.
4. **Back over Conduit's own window**, the tree sees an OS file drag (`types` includes `Files`) while
   the pane's outgoing drag is set. Dragover then runs today's *internal* logic: `dropIntent`, one
   highlight, spring-open. It sets `dropEffect='copy'`, because the source allows no move (D3).
5. **Drop in the tree:** `classifyDrop` (§3.2) resolves the dropped files' paths. If they equal the
   outgoing set, the drop is **internal**: move by default and copy with Ctrl, with today's conflict
   prompt, toast and announce. Otherwise it goes to today's OS-drop flow.
6. **Drop on the terminal:** every dragged path is inserted, formatted as today. This used to insert
   only the grabbed row (D8).
7. **Ending the drag.** Nothing in the old HTML5 drag ends it: `dragend` never fires once `dragstart`
   is `preventDefault`ed. So `pane.endDrag()` runs, which also drives the spring re-collapse, on the
   first of these triggers:
   - any in-window drop;
   - `fs:dragEnded {dragId}`. The host sends it when `startDrag` returns, on **Windows/Linux only**,
     where the call blocks until drop. On macOS the call returns at once, so the host never sends it
     there;
   - `fs:dragRefused {dragId}`;
   - a renderer `pointerdown` or `pointerup` seen **after** `fs:dragStarted` arrived. Those events
     reach the page only once the OS drag is over. `pointermove` is **not** a trigger: moves still
     arrive between the IPC and the OS drag starting, and would clear the set early.

   Every trigger that carries a `dragId` is ignored unless it matches the current one.
8. **Drops on regions that don't handle files** must not navigate the window. This spec makes that
   scenario much more likely, and it exists today for Explorer→Conduit drops too. It is fixed at the
   root:
   - `will-navigate` allows only the app's own `index.html` URL, not every `file://`;
   - a document-level `dragover`/`drop` listener calls `preventDefault` on `Files` drags that no
     handler claimed, which gives `dropEffect='none'` over dead space.

**States (the pane's outgoing drag):**
- `idle` → `requested` (IPC sent, `dragId`) → `active` (`fs:dragStarted`, OS drag running) → `idle`.
- `requested` → `refused` (toast) → `idle`.
- A new `dragstart` in any state replaces the set and the `dragId`.

### 2.3 Copy to the OS clipboard (MVP, Windows and macOS)

1. Explorer **Copy** (the menu, Ctrl/Cmd+C) keeps today's in-app clipboard, so Conduit's Paste is
   unchanged. It **also** sends `fs:copyToOsClipboard {sessionId, paths}` with the top-level paths.
2. The host validates the paths the same way as for a drag (§3.1), then writes a real file list:
   - **Windows:** spawn `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
     -NonInteractive -Command <fixed script>`. The paths go on **stdin** as base64 of UTF-8 JSON, which
     the script decodes. PowerShell 5.1 reads stdin in the OEM codepage and would mangle non-ASCII
     names. The script then runs `Set-Clipboard -LiteralPath`, which writes CF_HDROP. The spawn is `windowsHide:true` with a 10 s
     timeout (D2). This must be Windows PowerShell 5.1: PowerShell 7's `Set-Clipboard` has no
     `-LiteralPath`.
   - **macOS:** `clipboard.writeBuffer('NSFilenamesPboardType', <XML plist array of paths>)`, the format
     that passed Finder paste in VS Code's TPI.
   - **Linux:** no OS write. This is documented (D4).
3. **Result:**
   - the existing `Copied N items` announce stays **immediate** (the in-app copy happened) and does not
     wait on the host;
   - host failure or refusal: an error toast `Couldn't put <n> on the system clipboard. <reason>`
     (sentences in §10). The in-app copy still happened.
4. **Cut** does not touch the OS clipboard (D5). A later in-app Copy/Cut replaces the in-app clipboard
   as it does today. The OS clipboard keeps whatever was written last by anything.

### 2.4 Other surfaces (v1, gated on S0 finding F5)

This follows VS Code parity. **Editor tabs, Changes rows and search-result file rows** set
`DownloadURL` for their file, a single non-directory file, while keeping their existing drag (tab
reorder/dock). Changes and search rows become `draggable` and carry `x-conduit-path` so a drop on the
terminal inserts the path.

`DownloadURL` is a renderer-built `file:` URL. It passes the security bar **only if** the host sees
and gates the resulting download: `session.on('will-download')` rejects any item whose `file:` path
fails §3.1 validation. **If S0 shows `will-download` does not fire for a drag-download, §2.4 is
dropped (D7).** The fallback is not to route those surfaces through native `startDrag`, because that
would break tab reorder.

## 3. Data / interface contract

### 3.1 Host messages (renderer → host, on the `to-host` channel, sender = `event.sender`)

```ts
type FsStartDrag      = { type: 'fs:startDrag'; dragId: string; sessionId: string; paths: string[] };
type FsCopyToOsClip   = { type: 'fs:copyToOsClipboard'; requestId: string; sessionId: string; paths: string[] };
// host → sender
type FsDragStarted    = { type: 'fs:dragStarted'; dragId: string };
type FsDragRefused    = { type: 'fs:dragRefused'; dragId: string; reason: DragOutRefusal; path?: string };
type FsDragEnded      = { type: 'fs:dragEnded'; dragId: string };   // Windows/Linux only, when startDrag returns
type FsOsClipResult   = { type: 'fs:osClipboardResult'; requestId: string; ok: true } |
                        { type: 'fs:osClipboardResult'; requestId: string; ok: false; reason: DragOutRefusal | 'unsupported' | 'failed'; detail?: string };
type DragOutRefusal = 'bad-request' | 'unknown-session' | 'outside-folders' | 'folder-missing' | 'symlink-escape' | 'missing' | 'too-many';
```

**Validation** is one pure host function, `validateOutgoingPaths(paths, folders)`. It is unit-tested
and shared by both messages. It returns `{ok:true, paths}` or the first refusal, and it **refuses the
whole request, never a partial set**. It checks, in order:

1. `paths` is a non-empty array of strings, at most **500** entries (otherwise `too-many`), each
   absolute (otherwise `bad-request`).
2. `folders` = the session's `home` + `roots` **minus** `missingRoots` / a missing home. An unknown
   `sessionId`, or a session that `sessionOwner` does not map to the sender's window, is
   `unknown-session`. A path under a *missing* folder is `folder-missing`, not `outside-folders`. This is **not** `writeRoots()`: dragging out is a disclosure to
   another app, so it is scoped to the folders the user is looking at (D9).
3. Each path must pass `isInsideAnyRoot(p, folders)` (otherwise `outside-folders`) **and**
   `isInsideAnyRoot(realPathLeaf(p), folders.map(realPathLeaf))` (otherwise `symlink-escape`), which
   is the ADR 0005 posture. The roots are realpath'd too, so a home reached through a junction, `subst`
   or mapped drive doesn't refuse every drag. Only the dragged paths themselves are checked: a dragged
   folder is copied by the target with whatever links it contains (D13).
4. Each path must exist, checked with `fs.statSync` (otherwise `missing`). Duplicates are removed
   (case-insensitive on win32) and the result is reduced to top-level paths.

**Sender check:** the request must come from a Conduit app window's webContents
(`BrowserWindow.fromWebContents(e.sender)` is one of ours), never from a `<webview>` guest. Anything
else is dropped and logged. The guest case is unit-tested with a faked sender, since guests have no
preload and cannot reach `to-host`. Every refusal is logged with its reason and path via `log.warn('fs', …)`.

**E2E mode:** under `CONDUIT_E2E=1` the host validates the request but does **not** call
`startDrag`, which would block a hidden test window's main process. It pushes
`{paths, accepted, reason}` onto a main-process probe array, `globalThis.__conduitDragOutLog`, that a
test reads with `app.evaluate`, and still replies `fs:dragStarted`. The clipboard write is **not**
performed in e2e, because a background suite must not clobber the user's clipboard. The host pushes
the prepared payload (argv + decoded stdin paths, or the plist) onto `__conduitClipboardLog`. The
real write is covered by a unit test of the payload builder plus manual smoke.

### 3.2 Renderer

- `agentDeck.fs.startDrag(sessionId, paths)` and `agentDeck.fs.copyToOsClipboard(...)` go through the
  existing `to-host` send and request pattern. The bridge is absent in the browser preview (the fake
  shell), where the drag falls back to today's HTML5 drag and Copy stays in-app.
- `classifyDrop({ outgoing, droppedPaths, textPaths, platform }) → 'internal' | 'os' | 'none'` is a
  pure function in `src/`, unit-tested with explicit win32/posix normalisation:
  - **internal** if `outgoing` is non-empty and `droppedPaths` equals it as a set, or `droppedPaths`
    is empty and `textPaths` is non-empty (the legacy/cross-window/synthetic path);
  - **os** if `droppedPaths` is non-empty and not equal to `outgoing`;
  - **none** otherwise.

  A stale `outgoing` can therefore never capture a genuine OS drop of *different* files.

### 3.3 Invariants

- The renderer never calls `startDrag` or writes OS clipboard files. It only sends paths. The host
  decides, from its own session model.
- An external target can only copy or link; nothing Conduit starts can move a project file out.
  On Windows/Linux this is Electron's `DRAG_COPY|DRAG_LINK`. On macOS it is **unverified**, and
  native drag-out there is gated on S0 F6 (D15).
- The paths are never interpolated into a shell command line (stdin JSON only), and the PowerShell
  binary is an absolute path, so `PATH` cannot redirect it.

### 3.4 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Outgoing drag set | Files row `dragstart` | Tree dragover/drop (`classifyDrop`), terminal drop, clear triggers | yes |
| `fs:startDrag` | renderer | host validator → `startDrag` | yes |
| OS drag data (CF_HDROP/NSURL) | Electron `startDrag` | external apps **and every Conduit drop surface**: tree, terminal, settings image drop, other windows (D10), in-app web tabs (`<webview>` guests now receive real files, like any browser: D14), Monaco (its default text drop ignores `Files`), center-pane dock, board and sidebar (these key on their own drag state and ignore `Files`), and dead space (window navigation, fixed by §2.2 step 8) | yes |
| `fs:dragEnded` / `fs:dragRefused` | host | renderer outgoing-state machine | yes |
| OS file clipboard | host (PowerShell / writeBuffer) | Explorer/Finder/app paste | yes. We have no control over the consumer, so it is covered by manual smoke |
| In-app clipboard | Copy/Cut | Conduit Paste | unchanged |
| `DownloadURL` (v1) | tab/Changes/search `dragstart` | Chromium drag-download → `will-download` gate | yes, gated on F5 |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Drag set includes a path in a missing folder, or a file deleted since the tree last listed it | Whole drag refused (`missing` / `outside-folders`). Toast `Can't drag <name>: <reason>`, announced. No partial drag. |
| A symlink inside the tree points outside every folder | Refused (`symlink-escape`), matching preview confinement (D9). |
| File has unsaved edits in an editor tab | The on-disk bytes are delivered with no prompt. This is VS Code parity (D12). |
| Huge folder dragged out | The host passes only paths. The OS target does the copy and shows its own progress. There is no size cap. |
| More than 500 top-level items | Refused (`too-many`) with a toast. |
| Drag cancelled with Esc or dropped on nothing | No effect. The outgoing drag clears via `fs:dragEnded` or the next pointer event. |
| Main process blocked during a Windows/Linux drag (#45197) | PTY output, watchers and `conduit-preview:` requests pause until drop, then resume. S0 must measure whether an in-window internal drop and spring-open still work while the drag is live (F2). If they don't, D3's fallback applies. |
| Modifier keys on an in-window native drop | Ctrl selects copy as today, **if** Chromium reports `ctrlKey` on drop for an OS-source drag (F3). If it doesn't: fallback in D3. |
| Dropping onto the tree's *own* source folder, or into itself | Today's `dropIntent` refusal (no highlight, no-op). |
| Second drag or Copy while a clipboard write is in flight | Last request wins. The host serialises clipboard writes, and a superseded result is ignored by `requestId`. |
| PowerShell missing, blocked, or times out | `failed` result, error toast, logged. The in-app copy stands. |
| Paths containing Unicode, spaces, `'`, `;` or `$` | Delivered verbatim. Stdin JSON avoids quoting entirely. Covered by a unit/e2e fixture. |
| Browser preview (no bridge) | Today's HTML5 drag, with no OS delivery and no error. |
| Drag from Conduit window A to window B's tree | B sees a plain OS drop, so it gets today's attach/copy flow: **copy, not move** (D10). |
| Drop on a region with no file handler (Monaco gutter, viewer, board, dead space) | Nothing happens and the window stays put (§2.2 step 8). |
| Stale `fs:dragRefused`/`fs:dragEnded` from an earlier drag | Ignored, because its `dragId` doesn't match. |
| Session home under a junction or mapped drive | The roots are realpath'd, so drags are allowed. |
| Settings modal background-image drop receives a dragged file | Accepted like any OS file. This is intended. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Explorer drag mechanism | Native `startDrag` for every trusted row drag | no | It is the only way to deliver folders or multiple files (§0). One path avoids a split-brain drag. |
| Copy also writes OS clipboard files | on (Windows, macOS) | no | The user asked for it. It is additive, and in-app Paste is unchanged. |
| Drag icon | bundled generic file/folder/stack PNG, 32 px @1x/@2x | no | `startDrag` silently no-ops on an empty icon. `app.getFileIcon` is async at a moment that must be synchronous. |
| Refusal scope | the whole request | no | A partial drag silently loses files at the destination. |
| Max items | 500 top-level | no | Bounds the validation cost at dragstart. It is larger than any realistic selection. |

## 6. Scope slicing

- **S0 (spike; gates MVP; the builder measures, then either continues or applies the D3 fallback):**
  - **F1:** `startDrag({files})` with 3 files + 1 folder onto an Explorer folder copies all four.
  - **F2:** while a native drag is live on Windows, is an in-window `drop` delivered, and do
    spring-open (readDir IPC) and PTY output keep working?
  - **F3:** is `ctrlKey` reported on an in-window drop?
  - **F4:** does `Set-Clipboard -LiteralPath` via stdin script paste in Explorer, including a
    multi-file and folder set, and does Chrome/Slack paste accept it?
  - **F5:** does `will-download` fire for a `DownloadURL` drag?
  - **F6 (macOS):** does a Finder drop on the same volume **copy**, leaving the source in place? What
    is the source operation mask?

  Record the results in the run report.
- **MVP:** §2.2 native drag-out from the Files tree, including the step 8 navigation guard; §2.3 OS clipboard Copy (Windows and macOS), host
  validator and IPC, `classifyDrop`, e2e probe log, and a CHANGELOG entry.
- **v1:** §2.4 `DownloadURL` for tabs, Changes rows and search rows, if F5 holds.
- **Vision:**
  - Linux clipboard (`x-special/gnome-copied-files` / `text/uri-list`);
  - paste *from* the OS clipboard into the tree;
  - Cut → Explorer move-paste (`Preferred DropEffect`);
  - a count badge on the drag image.
- **Out of scope:** §1 non-goals.

## 7. Acceptance criteria

### 7.1 EARS

- **AC1** When the user drags a Files-tree row, the renderer shall cancel the HTML5 drag and send
  `fs:startDrag` with the effective drag set (selection rule, top-level paths).
- **AC2** When `fs:startDrag` passes validation, the host shall call `startDrag` on the sender with
  every validated path and a non-empty icon. If any path fails, the host shall start no drag and reply
  `fs:dragRefused` with the reason.
- **AC3** The host shall refuse any outgoing path that is outside the session's present folders,
  either lexically or after realpath, that does not exist, or whose request exceeds 500 items. It
  shall refuse requests from non-app webContents.
- **AC4** While the pane's outgoing drag is set and an OS file drag is over the tree, the tree shall
  show exactly one internal drop highlight per `dropIntent` and spring-open collapsed folders.
- **AC5** When the dropped files equal the outgoing set, the tree shall move them by default and copy
  them with Ctrl, with today's conflict prompt, toast and announcement. When they differ, it shall run
  the OS-drop flow.
- **AC6** When the outgoing drag is dropped on the terminal, the terminal shall paste every dragged
  path.
- **AC7** The outgoing drag shall clear, and the spring-opened dirs shall re-collapse, on:
  - an in-window drop;
  - a matching `fs:dragEnded` or `fs:dragRefused`;
  - a `pointerdown`/`pointerup` after `fs:dragStarted`.

  It shall **not** clear on `pointermove`, or on a message whose `dragId` doesn't match.
- **AC7b** If a file drag is dropped on a region that doesn't handle it, then the app window shall not
  navigate. `will-navigate` shall admit only the app's own `index.html`.
- **AC8** When the user runs explorer Copy on Windows or macOS, the host shall place the validated
  paths on the OS clipboard as a file list. If that fails, the renderer shall show an error toast and
  keep the in-app copy.
- **AC9** If the platform is Linux, then Copy shall stay in-app only, with no error.
- **AC10** Under `CONDUIT_E2E=1`, the host shall record each `fs:startDrag` decision in
  `__conduitDragOutLog` and each prepared clipboard payload in `__conduitClipboardLog`. It shall call
  neither `startDrag` nor the real clipboard write.
- **AC11** (v1) Where F5 holds, tab, Changes and search file drags shall carry `DownloadURL`, and the
  host shall cancel any drag-download whose path fails validation.

### 7.2 Gherkin

```gherkin
Feature: Drag and copy files out of Conduit
  Background:
    Given a session with home "app/" and attached folder "lib/"
    And "app/a.txt", "app/b.txt" and folder "app/docs/" exist

  # Scenarios 1, 2 and 4 are MANUAL SMOKE: no automation performs a real OS drag or reads Explorer.
  # Scenario 3 is e2e. AC4/AC5 native-branch routing is unit (classifyDrop + state machine).
  Scenario: Multi-selection drag to Windows Explorer copies real files
    Given "a.txt" and "docs" are selected
    When I drag "a.txt" onto a folder in Windows Explorer
    Then that folder contains "a.txt" and "docs" with their contents
    And "app/a.txt" and "app/docs/" still exist

  Scenario: Internal move still works under a native drag
    When I drag "b.txt" onto "lib/" in the tree
    Then "lib/b.txt" exists and "app/b.txt" does not
    And the live region announces the move

  Scenario: A path outside the session is never dragged
    When the renderer sends fs:startDrag with "C:/Windows/win.ini"
    Then no drag starts
    And the host logs an "outside-folders" refusal

  Scenario: Copy then paste in Explorer (Windows)
    When I select "a.txt" and press Ctrl+C in the tree
    And I paste into a Windows Explorer folder
    Then a copy of "a.txt" appears there
    And Paste into folder in Conduit still copies "a.txt"
```

### 7.3 Tests

- **Unit (pure, CI is Linux: normalise separators and case explicitly):**
  - `validateOutgoingPaths`: every refusal, the symlink escape via a temp symlink (skip if the OS
    forbids symlinks), missing-root exclusion, win32 casing dedupe, top-level reduction, the 500 cap;
  - `classifyDrop`: equal, different, subset, stale-outgoing, text-only;
  - the plist builder, including XML escaping of `&<>`;
  - the PowerShell stdin payload builder (paths never appear in argv);
  - the outgoing-drag state machine and its clear triggers;
  - the sender check (app window vs faked guest, session ownership);
  - realpath'd roots (junction-backed home allowed);
  - stale `dragId` ignored, and no clear on `pointermove`;
  - `will-navigate` URL predicate (only the app's `index.html`);
  - the document-level unclaimed-`Files` guard;
  - `drag-region.test.ts` untouched (no new overlay).
- **E2E `test/e2e/drag-out.e2e.mjs`** (hidden, serial):
  - a synthetic `dragstart` on a tree row leads to a `__conduitDragOutLog` entry with the validated
    paths (single, multi, folder);
  - a crafted `fs:startDrag` for an outside path, a missing path, and another window's session are
    each logged as refused;
  - Copy records the expected payload in `__conduitClipboardLog`, with a non-ASCII fixture name;
  - a synthetic `Files`-typed drop on the editor area leaves the window URL unchanged;
  - internal DnD e2es (`explorer-dnd-polish`, `dnd`, `terminal-drop`) stay green unchanged. They
    exercise the text/`draggedPaths` branch, so `classifyDrop`'s native branch is covered by unit only.
- **Runtime QA can observe:** the probe log; host `log.warn` refusals; the clipboard read-back; that
  the renderer's `dragstart` was `defaultPrevented`.
- **Manual smoke (no automation can perform a real OS drag out of the window):**
  - drag single, multi and folder onto an Explorer folder (copies, originals intact);
  - drag onto a Chrome upload zone and into Slack/Teams compose;
  - drag back into the tree (move, then Ctrl copy);
  - drag onto the terminal;
  - Copy → Explorer paste, including a non-ASCII name, and Copy → Slack paste;
  - a drop on dead space does not navigate;
  - on macOS, repeat against Finder.

## 8. State catalog

| Component | State | What the user sees | Action |
|---|---|---|---|
| Tree row | dragging (outgoing active) | the OS drag image (bundled icon); source row keeps its selection style | drop anywhere |
| Tree | internal drop target | today's single highlight | drop = move / Ctrl copy |
| Tree | foreign OS drop target | today's copy highlight and the attach/copy menu | unchanged |
| Toast | drag refused | per reason, §10 strings | dismiss |
| Toast | clipboard failed | `Couldn't put {count} on the system clipboard.` + the mapped reason (§10) | dismiss |
| Live region | copy ok | `Copied N items` (unchanged) | none |
| No bridge (preview) | fallback | today's behavior | none |

There are no loading or empty states, because the drag is instantaneous and the clipboard write
completes in the background.

## 9. Interaction inventory

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Tree row | drag out | press and drag | **Ctrl/Cmd+C then paste in the OS**. This is the non-drag pathway for WCAG 2.5.7 | `Copy` (label unchanged); `Copy path`, `Reveal in Explorer` unchanged | existing `treeitem`; refusals announced via the pane live region |
| Tab / Changes row / search row (v1) | drag out | press and drag | `Reveal in Explorer` / `Copy path` existing | unchanged | unchanged |

## 10. Accessibility & i18n

- The non-drag alternative is explorer Copy, which is now OS-deliverable, plus the existing Reveal.
  Every refusal and failure is announced through the existing `liveRef` as well as the toast. Focus
  does not move on a drag-out.
- There is no colour-only signal and no new focusable UI. Reduced motion does not apply.
- **Linux** has no OS-deliverable non-drag path for drag-out: Copy stays in-app (D4). The non-drag
  alternative there is `Reveal in Explorer` (opens the file manager at the item) plus `Copy path`.
- **i18n:** strings live as constants beside the component (repo convention, no framework). Each
  refusal reason maps to its own sentence, and the raw enum is never shown:
  - `outside-folders`: `Can't drag {name}: it's outside this session's folders.`
  - `folder-missing`: `Can't drag {name}: its folder can't be found.`
  - `missing`: `Can't drag {name}: it no longer exists.`
  - `symlink-escape`: `Can't drag {name}: it links outside this session's folders.`
  - `too-many`: `Too many items to drag (max 500).`
  - `bad-request` / `unknown-session`: `Couldn't start the drag.`
  - clipboard: `Couldn't put {count} on the system clipboard.` followed by a Copy-specific reason
    sentence. It never says "drag", and it never names PowerShell, because `failed` also covers a
    macOS write and a Windows host with no `SystemRoot` (amended 2026-09-24, code review S2):
    - `outside-folders`: `{name} is outside this session's folders.`
    - `folder-missing`: `The folder holding {name} can't be found.`
    - `missing`: `{name} no longer exists.`
    - `symlink-escape`: `{name} links outside this session's folders.`
    - `too-many`: `That's more than 500 items.`
    - `bad-request` / `unknown-session`: `Conduit couldn't send the request.`
    - `failed`: `The system clipboard didn't accept them.`
    - `unsupported`: no toast (AC9).

  `{count}` is `1 item` / `N items`, pluralised the same inline way as the existing `Copied N items`
  announce at `files-view.tsx:484`. Names render as text (`dir="auto"` where shown).

## 11. Design tokens

No new visual surface. The toasts use the existing `error` variant. The drag icon is a bundled PNG
drawn to read on light and dark desktops (neutral glyph with an outline), so no theme tokens are
needed.

## 12. Assumptions

| Assumption | Validated by |
|---|---|
| `startDrag({files})` delivers folders and multiple files on Windows 11 (the source reads so; runtime UNVERIFIED) | S0 F1 |
| An in-window drop fires for a native drag whose source allows only copy/link, when dragover sets `dropEffect='copy'` | S0 F2 |
| Chrome, Slack and Teams accept a CF_HDROP drag as `File`s (inferred) | manual smoke |
| Windows PowerShell 5.1 `Set-Clipboard -LiteralPath` writes CF_HDROP that Explorer pastes | S0 F4 |
| `webUtils.getPathForFile` returns the original path for our own native drag back into the window | S0 F2 |

## 13. Decisions Needed

- **D1 [high]** Beyond parity: explorer drag-out uses Electron `startDrag`, which delivers folders and
  multi-selections that VS Code cannot. Parity (`DownloadURL`, first file only) would not satisfy
  "file/folder". **Pick:** native for every explorer row drag.
- **D2 [high]** Beyond parity: explorer Copy writes real OS file clipboard data, which VS Code does not
  do (its own attempt was reverted). On Windows the write goes through **Windows PowerShell
  `Set-Clipboard -LiteralPath` with the paths on stdin**, because Electron cannot write CF_HDROP. That
  means spawning a ~0.3-1 s process per Copy. The alternative is a small N-API module or
  `electron-clipboard-ex` (unmaintained since 2021): a native dependency with ABI and pinning cost like
  `node-pty`. **Pick:** PowerShell, no new dependency. Swap in a native helper later behind the same
  host function if latency bites.
- **D3 [high]** Native drag replaces HTML5 for internal drags too. Consequences:
  - the cursor shows *copy* even for a move, because the source allows no move;
  - on Windows the main process blocks until drop.

  **Pick:** accept both, with dropEffect `copy` and move semantics decided by `classifyDrop` and
  modifiers. **Fallback if S0 F2 or F3 fails** (in-window drop not delivered, spring-open or PTY stall
  breaks internal drag, or no `ctrlKey`): the explorer keeps HTML5 for internal drags and adds
  `DownloadURL` for the first file only, which is VS Code parity. Folder/multi drag-out is then
  deferred and reported to the human.
- **D4 [normal]** Linux gets no OS clipboard files in MVP: GNOME and KDE disagree on the format and
  Electron holds one custom format per write. Drag-out still works on Linux.
- **D5 [normal]** Cut does not write the OS clipboard. An Explorer paste of a Conduit Cut would copy,
  not move, which surprises in both directions.
- **D6 [normal]** A bundled static drag icon (file / folder / several) rather than
  `app.getFileIcon`, which is async and would race the gesture.
- **D7 [normal]** Tabs, Changes and search drag-out (v1) use `DownloadURL` only if the host can gate
  it in `will-download`. Otherwise they are dropped, not shipped ungated, since a renderer-built
  `file:` URL would bypass host validation.
- **D8 [normal]** Terminal drop of a multi-selection now pastes every path (native drag carries all
  paths, no custom mime). Previously it pasted only the grabbed row.
- **D9 [high]** This is the disclosure boundary. Outgoing paths are validated against the
  **requesting session's present folders**, not `writeRoots()`. The session must be owned by the
  sender's window, and symlinks that resolve outside are refused, the same as preview confinement.
- **D10 [high]** This regresses shipped behaviour. A cross-window drag (tear-out window) becomes an OS drop in the other window, so
  it gets the attach/copy flow: copy, not move. Today's `text/plain` cross-window move is lost for
  real drags. VS Code's cross-window explorer drop also copies.
- **D11 [normal]** §2.1 claims come from source inspection, not runtime measurement. The builder
  re-confirms them with the listed e2es before changing anything.
- **D15 [high]** macOS move risk. The `DRAG_COPY|DRAG_LINK` mask is verified only on the Views
  (Windows/Linux) path. On macOS, "copy outside the app" is asserted, not measured, and Electron
  19.0.5 once shipped a move (#35264). **Pick:** native drag-out on macOS ships only if S0 F6 shows a
  same-volume Finder drop copies. Otherwise macOS keeps the D3 fallback (`DownloadURL`, first file
  only) and Windows proceeds.
- **D13 [normal]** Links *inside* a dragged folder are not inspected. The target copies the folder the
  way Explorer would, so a junction inside it can pull outside content along. Walking the tree at
  dragstart would be unbounded work at a moment that must be synchronous. This is recorded as a
  limitation.
- **D14 [normal]** In-app web tabs now receive real files when a tree item is dropped on a page's
  upload zone, the same as a drop from Explorer. That is intended, and it is the same disclosure the
  user makes by dropping onto Chrome.
- **D12 [normal]** Unsaved editor changes are not included in a drag-out or Copy. The on-disk file is
  delivered with no prompt, which is VS Code parity.
