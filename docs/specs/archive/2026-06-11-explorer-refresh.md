# Spec — Refresh the Explorer file tree when files appear/disappear on disk (J5)

## Context

The Explorer's **Files** tab shows a lazy file tree. `FilesView`
(`webview/components/right-pane.tsx`) reads a directory by posting `readDir` to the
host (`electron/main.ts` → `src/file-service.ts#readDir`) and renders the
`dirEntries` reply. It reads:

- the **root** once on mount / when `projectPath` changes, and
- each **subdirectory** the first time the user expands it.

After that it never re-reads. So when an external actor writes or deletes a file
while the app is open — another agent, a terminal command, a build step — the tree
does **not** reflect it.

The only reason files ever appeared without a restart was an accidental side effect:
`RightPane` mounts `ChangesView` and `FilesView` from a ternary, so toggling
**Changes → Files** *unmounts and remounts* `FilesView`, which re-runs its mount
effect and re-reads the root. Users learned this as a manual "toggle the tabs to
refresh" workaround. That's the bug: the tree only re-reads on a tab remount.

## Root cause

`FilesView` had exactly two read triggers — mount/`projectPath` change, and a
first-time directory expand — and no trigger tied to "the data may have gone stale".
External filesystem changes have no path back into the renderer, so the tree stays
frozen until something forces a remount (the tab toggle).

## Fix level chosen — re-fetch on window focus / tab visibility (renderer-only)

The reported scenario is "switch away (an external tool writes a file) → switch back
→ the file isn't there until I toggle tabs". The precise, reliable trigger for that is
**the window regaining focus** (and the document becoming visible again). On that
event we re-read the root and every currently-expanded, already-loaded directory, and
reconcile the results into the existing tree.

Reconciliation is a **merge**, not a replace: a surviving directory keeps its
`expanded` flag and previously-loaded children, new entries are added in sorted
position, removed entries drop out. This means a refresh never collapses the tree or
discards deeper reads.

The pure logic lives in `webview/file-tree.ts` (`mergeEntries`, `applyEntries`,
`pathsToRefresh`) and is unit-tested in `test/unit/file-tree.test.ts`. The
`dirEntries` handler now routes through `applyEntries`, so even the normal
expand/first-load path preserves nested expansion state across a refresh (previously
a root re-read wholesale-replaced children and lost it).

### Why not a host `fs.watch` / chokidar watcher (yet)

A host-side watcher pushing a "workspace changed" event would make additions appear
*live* (no focus needed), but it adds real cost: watcher lifecycle per project,
debouncing, and well-known Windows `fs.watch` quirks (recursive watch caveats,
duplicate/rename events, missed events on network drives). The focus/visibility
re-fetch fixes the reported case reliably and cross-platform with no host changes, so
the watcher is left as a **follow-up** rather than shipped half-tested. If added later
it should reuse `pathsToRefresh` + `applyEntries` and feed the same debounced re-read.

## Acceptance

- New/removed files in the workspace appear in the Files tree after the window
  regains focus or the tab becomes visible again — **without** a Files↔Changes toggle.
- Expansion state and loaded children survive a refresh (no collapse, no flicker of
  re-reading unopened folders — only the root and expanded dirs are re-read).
- The Files↔Changes tab toggle still works unchanged.
- In the browser preview (no `window.agentDeck`) nothing crashes; the fake host
  simply replies with mock entries.
- Pure tree logic is unit-tested; `npm run verify` and `npm run build` are green.
