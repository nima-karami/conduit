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
- `shouldReplaceContent(path, isDirty)` → `!isDirty` (see dirty-buffer rule).
- `shouldUpdateAfterSave(path)` → always `true`.

## Dirty-Buffer Rule

**A fresh disk read must NEVER replace the user's unsaved Monaco buffer.** This is
a hard invariant — re-seeding a dirty model from disk is silent data loss.

The danger is concrete: `CodeViewer`'s mount/seed effect is keyed on
`[doc.path, doc.content, doc.language, doc.binary]`. Models persist across mounts
(they are kept for cross-file go-to-definition), so when `doc.content` changes the
effect re-runs and, without protection, would re-seed the persisted model from the
new disk content — destroying the user's edits. Re-clicking an already-open dirty
file in the tree triggers exactly this (`openFile` always posts `readFile`).

### Protection (two coordinated guards)

1. **Files map is withheld for dirty paths (primary guard).** The `fileContent`
   handler in `app.tsx` consults the dirty store and calls
   `shouldReplaceContent(path, isDirty)`. For a **dirty** path it returns `false`,
   so the map entry is **not** replaced → `doc.content` is unchanged → the
   `CodeViewer` effect never re-runs → the buffer survives. For a **clean** path
   it returns `true`, so the fresh on-disk content flows through (the point of the
   branch).

2. **CodeViewer refuses to re-seed a dirty model (belt-and-suspenders).** When the
   effect reuses a persisted model, it re-seeds it from `doc.content` only when the
   path is **clean** (`!getDirtySnapshot().has(path)`). This both (a) makes a clean
   re-open actually refresh the reused model — which model-reuse alone would not do
   — and (b) guarantees that even if the effect re-runs for a dirty path for some
   other reason (a `doc.language`/`doc.binary` change), the dirty buffer is never
   overwritten.

### Why "withhold the map update" rather than "always update the map, protect only in CodeViewer"

Withholding keeps the system coherent end-to-end: a dirty doc's `doc.content`
stays at the value the user is editing against, so **every** consumer of the map —
the Monaco editor AND the markdown rendered view — shows content consistent with
the user's session, never a half-applied disk copy the user has not seen. The
markdown rendered view of a dirty doc therefore reflects the in-session baseline,
not a surprise disk revision. The pure rule lives in `shouldReplaceContent`.

For the **save → markdown rendered view** path: a successful save advances the
baseline and clears the dirty flag *before* `notifySaved` updates the map, so the
path is clean by the time the content propagates — the rendered view refreshes and
the re-seed is a no-op (the model value already equals the saved content).

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Save fails (host error) | `notifySaved` is NOT called; files map stays unchanged; dirty dot stays. |
| Save in browser preview | `canSave` is false; `writeFile` returns `{ok:false}`; `notifySaved` not called; failure toast shown. |
| `onFileSaved` fires for a path not in the files map | No-op: the early-return guard `if (!existing) return m` skips the update. |
| Dirty file, disk-read arrives (e.g. re-clicked in tree) | Files map NOT updated (`shouldReplaceContent` → false); `doc.content` unchanged; CodeViewer effect does not re-run; unsaved buffer + dirty dot survive. |
| Clean file, disk-read arrives (re-open / external change) | Files map updated with fresh disk content; CodeViewer re-seeds the reused model to the disk content; rendered view refreshes. |
| Multiple tabs open for same path | Not possible: `docsReducer` `open` returns early if the id already exists. |

## Files Touched

- `webview/file-freshness.ts` — pure decision functions; `shouldReplaceContent` now returns `!isDirty`
- `webview/save-registry.ts` — added `notifySaved` / `onFileSaved` channel
- `webview/components/code-viewer.tsx` — call `notifySaved` after successful save; re-seed a reused model from fresh content only when clean (never clobber a dirty buffer)
- `webview/app.tsx` — drop `!files.has` guard; subscribe to `onFileSaved`; gate the `fileContent` map update through `shouldReplaceContent` (dirty-buffer protection)
- `test/unit/file-freshness.test.ts` — new; unit tests for decision logic
- `test/unit/save-registry.test.ts` — extended with `notifySaved`/`onFileSaved` tests
- `docs/specs/fresh-file-content.md` — this file
- `.autoloop/evidence/fresh-file-content.md` — gate evidence
