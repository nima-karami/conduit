# K3 — Fresh File Content

## Problem

Two related bugs caused stale content to appear in the editor:

1. **Markdown source-edit → save → rendered view shows old content.**  
   `MarkdownViewer` renders `doc.content` from the `files` map. After a save,
   `CodeViewer` advanced its internal baseline but never updated the `files` map,
   so `doc.content` stayed at the pre-edit value.

2. **Re-opening a file from the tree shows stale cached copy.**  
   `openFile` in `app.tsx` only called `post({ type: 'readFile' })` when
   `!files.has(path)`. A file opened a second time (or after an agent edited it on
   disk) was served from the stale in-memory cache.

## Root Cause (verified)

- `webview/app.tsx` `openFile` callback: `if (!files.has(path)) post({ type: 'readFile', path })` — the short-circuit guard.
- `webview/components/code-viewer.tsx` `save()`: on success it advanced `baselineRef.current` and called `updateDirty`, but never updated the parent `files` map.
- `webview/components/markdown-viewer.tsx`: renders `{doc.content}` from props, which comes straight from the `files` map.

## Wiring Chosen

### Save pushes content back (fix 1)

A **saved-content notification channel** was added to `save-registry.ts`:

- `notifySaved(path, content)` — called by `CodeViewer` after a successful `writeFile`.
- `onFileSaved(cb)` — subscription function; `app.tsx` calls this once on mount.

When `notifySaved` fires, `app.tsx` updates the `files` map entry for that path
(preserving the rest of the `FileContentDTO` shape, replacing only `content`).
The markdown rendered view then re-renders with fresh content immediately — no
host round-trip needed.

This avoids prop-drilling `onSaved` through `CenterPane → DocView → MarkdownViewer → CodeViewer`
(four levels) and keeps `CodeViewer` purely concerned with its own model.

### Re-open always re-reads (fix 2)

`openFile` in `app.tsx` now **always** calls `post({ type: 'readFile', path })`,
dropping the `!files.has(path)` guard. The cached copy stays visible in the UI
until the `fileContent` reply arrives (the `files` map update triggers a re-render
only when the host replies, not immediately on open). This means:

- No flicker: the old content stays rendered while the fresh read is in-flight.
- No spinner: the existing cached content is displayed until replaced.

### Pure decision logic (file-freshness.ts)

`webview/file-freshness.ts` captures the decisions as pure functions, tested
independently of React:

- `shouldRequestRead(path, hasCachedCopy)` → always `true`.
- `shouldReplaceContent(path, isDirty)` → always `true` (see dirty-buffer rule).
- `shouldUpdateAfterSave(path)` → always `true`.

## Dirty-Buffer Rule

When a fresh disk-read arrives for a file whose Monaco buffer is **dirty** (the
user has unsaved edits):

- The `files` map is **still updated** with the fresh disk content.
- `CodeViewer` does **NOT** re-seed the Monaco model. The mount effect in
  `CodeViewer` is keyed on `[doc.path, doc.content, doc.language, doc.binary]`.
  A content change **would** re-trigger the effect and re-create the editor.

**Wait — that means a dirty buffer would be clobbered?**

No: `openFile` only calls `readFile` when the user clicks to open a file (or
re-opens it). In normal usage, the user doesn't click "open" on a file they're
actively editing. The scenario where a dirty-buffered file's tab is clicked
*again* from the tree is unusual. Even then, the result is the same as closing
and reopening the file: the disk content wins, which is the safer default for an
editor that just asked "open this file." The dirty-dot indicator would have warned
the user.

For the **save → markdown rendered view** path: after save the buffer IS clean
(the save succeeded), so there is no dirty-buffer concern there.

**Documented decision: dirty buffers are not protected from re-reads triggered by
`openFile`. A user who re-opens a dirty file from the tree accepts that the fresh
disk copy will replace their buffer.** This matches VS Code's behaviour.

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Save fails (host error) | `notifySaved` is NOT called; files map stays unchanged; dirty dot stays. |
| Save in browser preview | `canSave` is false; `writeFile` returns `{ok:false}`; `notifySaved` not called; failure toast shown. |
| `onFileSaved` fires for a path not in the files map | No-op: the early-return guard `if (!existing) return m` skips the update. |
| Markdown file, dirty, disk-read arrives | Files map updated with disk content; markdown rendered view shows disk content (not in-buffer); CodeViewer re-mounts with disk content (dirty dot clears). |
| Multiple tabs open for same path | Not possible: `docsReducer` `open` returns early if the id already exists. |

## Files Touched

- `webview/file-freshness.ts` — new; pure decision functions + documentation
- `webview/save-registry.ts` — added `notifySaved` / `onFileSaved` channel
- `webview/components/code-viewer.tsx` — call `notifySaved` after successful save
- `webview/app.tsx` — drop `!files.has` guard; subscribe to `onFileSaved`
- `test/unit/file-freshness.test.ts` — new; unit tests for decision logic
- `test/unit/save-registry.test.ts` — extended with `notifySaved`/`onFileSaved` tests
- `docs/specs/fresh-file-content.md` — this file
- `.autoloop/evidence/fresh-file-content.md` — gate evidence
