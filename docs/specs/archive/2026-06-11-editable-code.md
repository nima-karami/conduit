# I2 — Editable code editor with save-to-disk

## Context

The Monaco code editor (`webview/components/code-viewer.tsx`) was **read-only**: a
file could be opened and navigated but not changed. I2 makes it editable and wires
**Save** so edits persist back to the exact file on disk through a new, security-
hardened host write IPC. All app state lives in the Electron main process; the
renderer is untrusted, so the write path is treated as a trust boundary.

## Editable + save design

- **Editable.** `readOnly: false` in the editor options. Binary files still render
  the "Binary file — no preview" notice, so a writable buffer is never exposed for a
  non-text file.
- **Per-model dirty tracking.** The on-disk content (`doc.content`, what the read IPC
  loaded) is the **baseline**, held in a ref. On every `model.onDidChangeContent` the
  viewer recomputes `buffer !== baseline` and reports it to a small shared store
  (`webview/dirty-store.ts`, pure core in `webview/dirty-state.ts`), keyed by file
  path. Undoing an edit back to the baseline clears the flag (the pure logic returns
  the *same* set reference when membership is unchanged, so no spurious re-renders).
- **Save (Ctrl/Cmd+S).** Bound via Monaco `addCommand(CtrlCmd | KeyS, …)` plus a
  matching `agentdeck.saveFile` action (so it also appears in the command palette).
  Save reads the buffer, no-ops if already clean, then calls `bridge.writeFile(path,
  buffer)`. **On success** it advances the baseline (clearing the dirty dot). **On a
  rejection/error** it keeps the buffer dirty and shows a `Could not save: …` banner —
  a failed write must never look saved. The whole command is wrapped so it never
  throws.
- **Dirty dot UI.** `webview/components/doc-tabs.tsx` subscribes to the dirty store via
  `useSyncExternalStore` and renders a filled accent dot in the tab's close-button
  slot (`.tab__dirty`); the close ✕ reveals on hover. Closing a tab drops its dirty
  entry (`closeDoc` in `app.tsx`).

## The write-IPC security model

The renderer can request *any* path, so the **host** is the sole authority on what may
be written. Confinement lives in a pure, unit-tested module
(`src/path-guard.ts`) — not inline in the handler — because it is the backbone of the
security claim.

**Workspace roots.** The legitimate write set is computed host-side in `electron/
main.ts` (`writeRoots()`): every open session's `projectPath` plus the recently-opened
repo history. These are exactly the folders the explorer/editor opened files from.

**`validateWrite(target, roots)` — two-stage containment:**

1. **Reject if no roots are open** (nothing is writable).
2. **Lexical containment** (`isInsideRoot`): resolve the target and require it to sit
   under a root, compared with a **trailing-separator guard** so `/work` does not match
   a sibling `/work-evil`. Case-insensitive on win32 (matching the filesystem), exact
   elsewhere. This rejects `..` traversal and absolute-outside paths.
3. **Real-path containment** (`realPathLeaf` → `fs.realpathSync.native`): resolve the
   symlink-followed real path (walking up to the nearest existing ancestor for a
   not-yet-existing target, so a symlinked **parent** dir is caught too) and re-check
   containment. This closes the **symlink-traversal** hole even for paths that look
   contained lexically.
4. **Never clobber a directory** — reject if the resolved target is an existing dir.

Every rejection returns `{ ok: false, error }` with a human-readable reason, surfaced
to the renderer; nothing is silently written or silently swallowed.

**Robust write** (`file-service.writeFile`): on a passing verdict, content is written
to a temp file in the **same directory** and then `rename`d over the target — an
**atomic** swap. A mid-write failure (permission denied, disk full) leaves the original
intact, best-effort-cleans the temp file, and returns `{ ok: false, error }` so the
renderer keeps the buffer dirty.

**IPC wiring.** `ipcMain.handle('writeFile', …)` (request/response via `invoke`, like
`win:isMaximized`) → `preload.ts` exposes `agentDeck.writeFile(path, content):
Promise<WriteResult>` → `bridge.writeFile` calls it. Channel naming and the
`window.agentDeck` surface match existing IPC.

### Rejection cases proven by tests

`test/unit/path-guard.test.ts` (the security backbone):

- in-root file → **accepted**
- `..` escape → **rejected**
- absolute path outside every root → **rejected**
- sibling root not in the allow-list → **rejected**
- no roots open → **rejected**
- writing over a directory → **rejected**
- symlinked **file** whose real path escapes the root → **rejected** (lexical passes,
  real-path catches it)
- file under a symlinked **parent** dir pointing outside the root → **rejected**
- `isInsideRoot` sibling-prefix bug (`/work-evil` vs `/work`) → **rejected**

`test/unit/file-service.test.ts` (host write path, real temp dirs under the OS temp):

- in-root path actually writes the new bytes
- `..`-escape into a sibling dir leaves the victim file byte-for-byte unchanged
- no `.tmp` leftover after a successful write

`test/unit/dirty-state.test.ts`: buffer===disk → clean; differs → dirty; post-save and
undo-to-baseline → clean; same-reference no-op; other paths untouched.

## Preview degradation (no host)

In the browser preview `window.agentDeck` is absent (there is no filesystem). The
bridge's `writeFile` is a **guarded no-op**: it resolves to `{ ok: false, error: 'No
host: cannot save in the browser preview.' }` and never throws. The editor also checks
`canSave` (`= isHosted`) and shows "Saving is unavailable in the browser preview."
keeping the tab dirty. Editing still works fully in-buffer; only persistence is
unavailable — exactly as required.

## Drivable vs unit-verified

- **Drivable in preview (proven via Playwright over HTTP on 127.0.0.1):** the editor is
  editable (typed text landed in the buffer), the **dirty dot appears** on edit (tab
  a11y label became "package.json Unsaved changes Close tab"), and **Ctrl+S is a safe
  no-op** — it surfaced the preview banner, **kept the tab dirty**, and produced **no
  console error / no throw**.
- **Unit-verified (cannot write real files from the browser preview):** the real
  atomic write and the full path-confinement / rejection matrix, via the vitest suites
  above against real temp directories.

## Acceptance

- Monaco editable; user can type into the open file. ✓
- Ctrl/Cmd+S writes the buffer back to the exact opened file via the host writeFile
  IPC. ✓ (unit-verified write; preview no-op proven)
- Dirty dot appears when buffer ≠ disk, clears on successful save. ✓
- Host validates every write to stay inside the workspace roots; `..`, absolute-
  outside, sibling-root, and symlink escapes are rejected with a surfaced error; a
  failed write keeps the buffer dirty. ✓
- Degrades safely with no host: in-buffer editing works, Save is a guarded no-op that
  never throws. ✓
- `npm run verify` and `npm run build` both exit 0. ✓
