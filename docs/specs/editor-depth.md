# editor-depth spec

Three features that deepen the code-editing experience: dirty-close confirmation,
revert-file, and save-all.

---

## 1. Dirty-close confirmation

### Problem

Closing a doc tab with unsaved edits silently discards the buffer.

### Solution

Intercept every close of a dirty doc and present a 3-way modal dialog:

| Button  | Action                                                                        |
|---------|-------------------------------------------------------------------------------|
| Cancel  | Dismiss the dialog; do nothing (tab stays open, buffer intact).               |
| Discard | Clear dirty state (no write), then close the tab.                             |
| Save    | Invoke the registered save for the path; close only on success. If the save   |
|         | fails (error toast is already raised by CodeViewer), do NOT close the tab.    |

### Scope — what counts as "closing a dirty doc"

- Click the × button on a doc tab.
- Right-click → Close.
- Right-click → Close others (check each tab individually for dirty state; prompt
  once per dirty tab, or use a single "close X dirty tabs?" prompt — see flow).
- Right-click → Close all (same approach as Close others).
- Command-palette "Close other tabs" command.

For Close-others / Close-all with multiple dirty docs, check each target doc for
dirtiness and collect all dirty ones into a single prompt (or handle sequentially).
The canonical approach chosen here: handle each tab individually (sequential checks)
so the user sees the title of the specific file in each dialog. This is familiar
from VS Code's behaviour.

### Pure decision module: webview/close-dirty.ts

Exports a pure function (no side effects, no React) that handles the decision tree:

```ts
type CloseDirtyResult = 'cancel' | 'discard' | 'save';

/** Pure query: given a path and the registry, what should happen on close? */
function resolveDirtyClose(path: string, isDirty: boolean): 'clean' | 'needs-prompt';
```

The function must be pure and have tests.

### ConfirmDialog extension (3rd optional button)

Extend `ConfirmState` with an optional `secondaryLabel` + `onSecondary` pair.
When present, a third button renders between Cancel and the primary button:

```
[Cancel]  [Discard]  [Save]
```

- `secondaryLabel` = label for the middle button (e.g. "Discard")
- `onSecondary` = callback for the middle button
- Existing 2-way call sites pass no `secondaryLabel` and keep working unchanged.

### Failure handling for Save path

`save()` is async (async writeFile + optional rejection). The dialog's Save button
must:
1. Invoke the registry's `save()` — which is `async () => void` on CodeViewer.
2. The dialog closes only if save succeeds. Since `save()` does not return a promise
   through the registry interface, the close-dirty flow uses a different mechanism:
   subscribe to `onFileSaved` for the path (a success signal) and to the toast-store
   for a save error for that path. Race with a short timeout (500 ms) so the dialog
   does not hang forever if the bridge is broken.
   
   Alternatively (simpler): extend `SaveEntry.save()` to return `Promise<boolean>`.
   The code-viewer's entry returns `true` on success and `false` on failure.
   This is the chosen approach.

### Edge cases

- **Revert-then-close**: if a dirty doc is reverted (see feature 2), its dirty flag
  is cleared. Subsequent close is clean → no dialog.
- **Close-all with mixed dirty/clean**: iterate over each doc; only dirty ones trigger
  the prompt.
- **No registry entry** (e.g., a diff tab that has no save registered): treat as
  clean (no prompt); close directly.

---

## 2. Revert File

### Problem

There is no way to throw away in-progress edits without closing and re-opening a
file.

### Solution

Add a `revert()` verb to `SaveEntry`:

```ts
interface SaveEntry {
  save(): Promise<boolean>;
  revert?(): void;   // optional: not all doc types support revert
}
```

CodeViewer implements `revert()`:
1. Push `baseline` content back into the Monaco model via `model.setValue(baseline)`.
2. The content-change handler (`syncDirty`) fires and marks the path as clean.

Expose as a command-palette command accessible only when a file doc is active and
dirty:

- **Title**: "Revert File"
- **Group**: "Commands"
- **Visible when**: there is an active doc AND the doc is dirty.
- **No-op path**: if the doc is clean, the command is not shown (simpler than
  showing a disabled entry).

### Edge cases

- Revert of a clean doc: command not visible.
- Revert after the registry entry has been unregistered (tab closed mid-flight):
  no-op — the command requires an active doc to exist.

---

## 3. Save All

### Problem

There is no way to save all dirty docs at once.

### Solution

A palette command "Save All" that iterates over every path in the dirty set,
invokes its registered save, and collects failures.

```
for each path in dirty set:
  if registry has entry for path:
    await entry.save()   → captures success/failure
collect failures
if any failures:
  single toast summarising: "Could not save N file(s): file1.ts, file2.ts"
  (individual error toasts are already raised by CodeViewer's fail() fn — no double toast)
if no failures: silent (silence = success)
```

### Expose in command palette

- **Title**: "Save All"
- **Group**: "Commands"
- **Always visible** (idempotent when nothing is dirty).

### Window beforeunload

`window.addEventListener('beforeunload', ...)` fires when the user navigates away
(e.g. hard-refresh in browser preview). In the Electron context the renderer
`beforeunload` is NOT a reliable intercept for the OS-level close button (Electron
fires `app.on('before-quit')` or `BrowserWindow.on('close')` instead; intercepting
those is out of scope for a renderer-only feature).

What we DO: add a `beforeunload` listener that attempts a best-effort `saveAll()`
when there are dirty docs. In the Electron host this rarely fires on app-quit (the
host closes windows directly), but it fires reliably on browser hard-refresh (the
preview) — providing a safety net in that scenario.

**Limitation**: The Electron host's window close does NOT reliably trigger
`beforeunload`. A proper Electron-level close interceptor (intercepting
`BrowserWindow.on('close')`, posting a message to the renderer, waiting for saves to
complete before calling `event.preventDefault()` / `win.destroy()`) is out of scope
for this task. Documenting the limitation here so it is not re-discovered later.

---

## Implementation notes

- **SaveEntry.save() return type**: changed to `Promise<boolean>` (true = success).
  All existing call sites that call `save()` without awaiting still work (they
  ignore the return value). CodeViewer's async `save()` already returns a boolean
  implicitly; we make it explicit.
- **ConfirmDialog**: backward-compatible extension — existing callers pass no
  `secondaryLabel` and observe identical rendering.
- **Tests**: pure-logic modules (`close-dirty.ts`, `save-all.ts`) are covered by
  unit tests. React component wiring is exercised through the existing integration
  path (command palette rendering is tested implicitly; explicit browser tests not
  in scope).
