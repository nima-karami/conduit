# File-tree mutations (L2)

## Problem

The Explorer Files tab (`webview/components/right-pane.tsx` → `FilesView`) is
read-only navigation: it lists directories, expands folders, opens files. The
existing file context menu (`app.tsx` → `onFileContextMenu`) offers only
Open / Reveal / Copy path. There is no way to create, rename, or delete files
and folders from inside the app — the user has to drop to a terminal or the OS
file manager.

## Goal

Add **New file**, **New folder**, **Rename**, **Delete** to the Explorer file
tree, host-confined and with inline name editing in the tree itself. Reuse the
existing containment backbone (`src/path-guard.ts`), the IPC request/response
convention (writeFile / git-action), the `ConfirmDialog`, `ContextMenu`, and the
toast store.

## Host mutation layer — `src/fs-mutations.ts`

A small pure-validation + thin-execution module mirroring `git-actions.ts`:

- `planMutation(op, req, roots)` — PURE. Validates containment of every path
  against the workspace `roots` (same notion as `writeFile`: open session
  project folders + repo history). Returns a typed plan or a `reject`. No IO,
  unit-testable without Electron.
- Execution functions (`createFile`, `createDir`, `rename`, `remove`,
  `removePermanent`) — thin, run the validated plan against the real fs. `remove`
  takes an injected `trash` function (Electron `shell.trashItem`) so the module
  has no hard Electron dependency and the trash path stays testable.

### Operations and rules

| Op | Rule |
|----|------|
| `createFile(path)` | Validate containment. **Fail if the target already exists** (never clobber). `mkdir -p` the parent, then write an empty file. |
| `createDir(path)` | Validate containment. `mkdir` recursive (idempotent-ok). |
| `rename(from, to)` | Validate **both** `from` and `to`; reject if **either** escapes any root. Reject if `to` already exists (collision). Reject renaming a workspace root itself. `fs.rename`. |
| `remove(path)` (trash) | Validate containment. Reject removing a workspace root itself. Call injected `trash(path)` (recycle bin). **If trash fails, return the error** — never silently permanent-delete. |
| `removePermanent(path)` | Separate, explicit. Same containment + root-protection checks. `fs.rm` recursive+force. Only reached after the renderer's second confirm. |

Validation reuses `isInsideAnyRoot` / `realPathLeaf` from `path-guard.ts`
(case-insensitive on win32, symlink-resolved). Root-protection compares the
resolved target against each resolved root for exact equality.

### Result type

`MutationResult = { ok: true; path: string } | { ok: false; error: string }`.
Never throws; the IPC handler returns the typed result like `writeFile`.

## IPC

One handler `fs-mutate` (request/response via `ipcRenderer.invoke`), following
the `writeFile` / `git-action` pattern:

```
type FsMutationRequest =
  | { op: 'createFile' | 'createDir' | 'remove' | 'removePermanent'; path: string }
  | { op: 'rename'; from: string; to: string };
```

The handler in `electron/main.ts` supplies `writeRoots()` and injects
`shell.trashItem` for the `remove` op. Exposed on the preload bridge as
`fsMutate(req)`. Mocked in `webview/bridge.ts` with an in-memory behavior so the
inline-edit UX is drivable in the browser preview (create/rename/delete against
the mock dir listing, re-emitting `dirEntries`).

## Renderer

### Context menu (extends `onFileContextMenu`)

- On a **FILE**: New file (sibling), Rename, Delete (+ existing Open / Reveal /
  Copy path / Copy relative path).
- On a **DIR**: New file (inside), New folder (inside), Rename, Delete (+ Reveal
  / Copy path / Copy relative path).
- On tree **EMPTY SPACE / the Files header**: New file / New folder at the
  workspace root. (Right-clicking the empty area below the rows, or a "+" affordance
  in the Files tab strip.)

### Inline editing

The tree gains a transient **draft row**:

- **Create**: an editable input row appears in place at the target directory
  (sibling for a file op, inside for a dir op), pre-focused and empty. Enter
  commits; Escape cancels; **blur cancels** (consistent, documented — a click
  away abandons the draft, matching VS Code's create flow being abandoned on blur
  is acceptable here and avoids accidental empty-name commits).
- **Rename**: the row's label is replaced by an input pre-filled with the current
  name, text selected (sans extension is a nicety, not required). Enter commits;
  Escape cancels; **blur cancels**.

### UI-side validation (before hitting the host)

Inline error state (red border / message), never a host round-trip, when:

- name is empty / whitespace-only,
- name contains a path separator (`/` or `\`) or is `.` / `..`,
- name collides with a loaded sibling (case-insensitive on win32).

### After success

- Re-read the affected directory via the existing `readDir` → `dirEntries` →
  `applyEntries` machinery (so expansion state is preserved via `mergeEntries`).
- Ensure the affected directory is expanded and reveal the new/renamed item.
- Errors → toast (`pushToast`, variant `error`). Silence = success.

### Delete

`ConfirmDialog` "Move X to Recycle Bin?" (primary "Move to Recycle Bin"). On
confirm, call `remove`. If trash fails, a **second** confirm "Couldn't move to
Recycle Bin — delete X permanently? This cannot be undone." (danger) →
`removePermanent`.

### Open doc tabs

- A **renamed** file that is open in a doc tab: the cheapest correct behavior is
  to **close the tab** (the doc id is `kind:path`, and re-keying Monaco models /
  dirty-state across a path change is cross-cutting). Documented rule.
- A **deleted** file open in a tab: **close the tab**.
- **Dirty docs do not re-prompt** after the user has already confirmed the delete
  (the delete confirmation supersedes the unsaved-changes prompt). Documented
  rule. Implemented with a force-close that bypasses the dirty check.

## Tests

- `test/unit/fs-mutations.test.ts`:
  - Pure validation: containment both ends of rename, collision, root-protection
    (create/rename/remove of a root), name-derived escapes (`..`), createFile no-
    clobber.
  - Execution against a temp dir under `$env:TEMP` (`os.tmpdir()`): create file /
    dir, rename, remove with an injected fake-trash (assert trash called, file
    gone), trash-failure surfaces the error (no permanent delete), removePermanent.
- `test/unit/file-tree-edit.test.ts`: pure name-validation helper
  (`validateName`) used by the renderer — empty, separators, dot names,
  collision.

Baseline 531 tests; this raises it.

## Non-goals

- Drag-to-move / cut-paste in the tree.
- Multi-select delete.
- Undo beyond the OS recycle bin.
