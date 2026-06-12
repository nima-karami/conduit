# File Browser + Code/Markdown Viewer — Design

Date: 2026-06-09
Status: Approved (pending spec review)
App: Agent Deck (standalone Electron app, `G:\awby\projects\terminal-ui`)

## Goal

Add the "read code" half of the original vision: browse the active project's files
in an interactive tree, open files in a syntax-highlighted viewer, render markdown,
and view git changes as diffs — all without leaving the app, alongside the running
agent terminal.

## Scope

**In (v1):**
- Interactive file tree for the active session's project (expand/collapse, lazy-loaded).
- Open a file → a tab in the center editor area, shown in **Monaco** (read-only, syntax-highlighted).
- `.md` files render as styled markdown (react-markdown + remark-gfm), with a "view source" toggle.
- Click a file in the Changes panel → a **diff** tab (Monaco diff editor: HEAD vs working tree).
- Dark Monaco theme matching the app's coral/dark palette.
- The terminal becomes the first tab in the center editor area.

**Deferred (designed-for, not built):**
- Editing + save (`readFile` is shaped to mirror a future `writeFile`).
- Project-wide go-to-definition (needs the TS language worker; we bundle only the editor worker).
- Fuzzy file search (Ctrl+P).
- Per-session document tabs (v1 keeps a single shared set of doc tabs).

## Layout

The center pane becomes a tabbed **editor area**:

```
[ Terminal ][ page.tsx ][ ▦ lib/x.ts (diff) ]×
┌───────────────────────────────────────────┐
│  active tab fills the center               │
│  (the session terminal, or a Monaco view)  │
└───────────────────────────────────────────┘
```

- **Tab 0 = Terminal**: renders the active session's terminal (kept mounted as today).
  Selecting a session in the sidebar switches this tab's content and focuses it.
- **Document tabs**: opening a file/diff appends a tab and activates it. Tabs are a
  single shared set (not per-session) in v1. Closable; closing all docs returns to
  the Terminal tab.
- **Right panel → Files**: interactive tree (replaces today's flat read-only list).
- **Right panel → Changes**: clicking a changed file opens a diff tab.

## Components (webview)

- `App` owns open-documents state: `{ id, kind: 'file' | 'diff', path, title }[]` + `activeDocId`,
  plus the existing active-session id. The Terminal "tab" is implicit (not in the docs list).
- `CenterPane` renders the tab bar (`DocTabs`) and the active content: the mounted
  terminals (active one shown) when the Terminal tab is active, else the active document.
- `DocTabs` — the center tab strip (Terminal + documents), with close buttons.
- `CodeViewer` — Monaco editor, read-only, language inferred from path.
- `MarkdownViewer` — react-markdown + remark-gfm; code fences highlighted; "view source"
  toggle switches to `CodeViewer` on the same file.
- `DiffViewer` — Monaco diff editor (original = HEAD content, modified = working content).
- `RightPane` Files view — interactive tree with lazy expansion; Changes view — click-to-diff.

A document-tabs reducer (pure) manages open/close/activate/dedupe-by-path; unit-tested.

## Data flow (IPC)

New `WebviewToHost` messages and `HostToWebview` responses:

- `readDir { path }` → `dirEntries { path, entries: { name: string; kind: 'dir' | 'file' }[] }`
  - Lazy tree expansion. Sorted dirs-first then name. Skips the same ignored set as `projectInfo`.
- `readFile { path }` → `fileContent { path, content: string; language: string; truncated: boolean; binary: boolean }`
  - Size cap ~2 MB; binary detected (NUL byte / non-UTF8 heuristic) → `binary: true`, empty content,
    viewer shows a "binary file" notice. `language` is inferred from the extension (Monaco language id).
- `readDiff { path }` → `fileDiff { path, head: string; work: string; binary: boolean }`
  - `head` from `git show HEAD:<relpath>` (empty string if the file is newly added / no HEAD);
    `work` is the working-tree file (empty if deleted). `path` is absolute; relpath computed against the repo root.

Host logic lives in a new `src/fileService.ts` (uses `fs` + `execFile` for `git show`), kept
pure where possible (size cap, binary detection, language inference, dir sort) for unit testing.
`readFile`'s shape anticipates a future `writeFile { path, content }`.

State message: the existing `state.repos`/`groups` are unchanged. The file tree root is the
**active session's `projectPath`** (the webview requests `readDir` for it on demand).

## Monaco integration

- Depend on `monaco-editor` and bundle it **locally** via esbuild (no CDN — offline + CSP).
- Read-only **colorization** runs on the main thread (Monarch tokenizers) — no language worker needed.
- Bundle Monaco's **editor worker** (`editor.worker`) as a separate esbuild entry and wire
  `self.MonacoEnvironment.getWorker` to it — required for the diff editor's diff computation.
- Skip the TS/JSON/CSS/HTML language workers (that capability is the deferred go-to-def/IntelliSense).
- Define a custom dark theme mapping Monaco token colors to the app palette (coral accent,
  `#0a0b0e` background to match the terminal).
- CSP: the renderer currently uses `script-src 'self'`. Workers load from `'self'` (bundled in
  `out/`); confirm `worker-src 'self'` (add if needed). No remote origins.

## Error / edge handling

- File too large → `truncated: true`, content capped, viewer shows a "truncated" banner.
- Binary file → notice instead of garbled text; diff shows "binary file, no preview".
- Missing/unreadable file or `git show` failure → empty content / graceful notice, never a crash
  (host wraps in try/catch and returns a well-formed response).
- Opening an already-open path focuses the existing tab (dedupe by path + kind).
- Switching the active session does not close document tabs.

## Testing

- Unit (`vitest`): `fileService` — binary detection, size cap/truncation, dir sort/ignore,
  language inference, diff assembly with/without HEAD. Open-documents reducer — open/dedupe/close/activate.
- Visual: browser preview (mock `readDir`/`readFile`/`readDiff` in the bridge) screenshotted via
  `playwright-cli`; real Monaco/diff verified in the running app via CDP.

## Out of scope (explicit)

Editing/save, go-to-definition across files, fuzzy file finder, search-in-files, multiple
editor groups/splits, per-session tab sets. Each is a clean follow-up on this foundation.
