---
status: active
date: 2026-06-17
---

# D11 — Clickable file/folder paths in terminal output

When an agent prints a file or folder path in terminal output, it is now
clickable: files open in the embedded Monaco editor, folders reveal in the OS
file manager (via `revealInExplorer`). The feature introduces a custom xterm
link-provider backed by a pure, unit-tested path-detection module.

## Scope

- Custom xterm `ILinkProvider` registered on the terminal in
  `webview/components/terminal-pane.tsx`.
- Pure detection module `webview/terminal-links.ts`: given a line of text and an
  `activeCwd` string, returns matched path tokens with `{ path, line?, col?,
  start, end }` spans.
- A new `pathExists` host message round-trip to validate that a matched token
  points at a real, in-bounds path before underlining it. The IPC call is
  `{ type: 'pathExists', path: string }` (renderer → host) and
  `{ type: 'pathExistsResult', path: string, exists: boolean, isDir: boolean }`
  (host → renderer).

## Path-token detection rules

Matches:
- POSIX absolute: `/foo/bar.ts`, `/home/user/project`
- Windows absolute: `C:\Users\foo\bar.ts`, `D:/work/project/index.js`
- Relative paths starting with `./` or `../`
- Optional `:line` and `:line:col` suffixes, e.g. `src/app.ts:42` or
  `src/main.ts:42:7`

Does NOT match:
- Bare word tokens with no separator or drive letter (avoids prose false-positives)
- Trailing punctuation: `.` `,` `)` `]` `'` `"` are stripped from the tail so
  a sentence-ending path is not over-captured

Relative paths are resolved against the session's `cwd` prop (which tracks
`activeCwd` from E2 — the live working directory of the terminal process). When
`cwd` is absent, relative paths are not offered as links.

## Existence validation seam

The renderer cannot `stat` files. Two options were considered:

1. **Eager: new lightweight `pathExists` IPC pair** — link-provider calls the
   host, result returns asynchronously, links are shown only for real paths.
   Chosen because it avoids underlining every typo/prose token that happens to
   look like a path.
2. **Lazy: provisional link, validate on click** — link is always shown, 404 on
   click. Rejected: misleading UI (underlined text that does nothing).

The new IPC pair is typed in `src/protocol.ts`. The host does a cheap synchronous
`fs.statSync` with **no workspace-containment guard** — deliberately: it is
read-only (returns only `exists` + `isDir`, never content) and is strictly less
capable than `readFile`, which is itself unguarded by workspace roots. See the
Decisions section.

## Click behaviour

- **File** → `readFile` → `fileContent` → opens in the per-session Monaco
  editor. Route through `openFile(path, owningSessionId)` so the editor
  switches to the path's owning session (same as content-search hits). If a
  `:line` suffix was present, `setReveal(path, { line, column })` is called
  first so CodeViewer jumps there on mount.
- **Directory** → `post({ type: 'revealInExplorer', path })` — this opens the
  OS file manager at that folder, consistent with the rest of the UI.

## Styling

Links are decorated with the `.term-path-link` CSS class: underline on hover.
No permanent underline (avoids cluttering dense terminal output). The xterm
link provider uses `decorations` with `activeDecorations` for the hover state.

## Guard for mock preview

The link provider's click callback and the `pathExists` IPC call both guard
`window.agentDeck` being absent (browser preview without a real host). In
preview mode no links are registered.

## Decisions

- **Folder action = OS reveal, not in-app Files tree reveal.** The in-app tree
  reveal requires the folder to already be loaded in the tree (a known
  `projectPath` root or child thereof). An arbitrary terminal-printed path may
  be outside any open project. The OS file manager can open any folder, so it
  is the safer, more general action. Consistent with the existing
  `revealInExplorer` usage everywhere in the codebase.
- **Relative path resolve from `cwd` only.** The session's `activeCwd` is the
  authoritative live directory; using `projectPath` as a fallback would produce
  stale / misleading links after `cd`.
- **`pathExists` host message is path-guarded** only in the sense that the host
  checks `fs.existsSync` without validating workspace containment. This is a
  read-only operation (no write surface is exposed) and mirrors what a user
  could verify by running `ls` in the terminal. The response carries only
  `exists` and `isDir` — no file content leaks.

## Acceptance criteria

- [ ] Absolute paths (`C:\...`, `/...`) and relative (`./...`, `../...`) printed
  in the terminal are underlined on hover and clickable.
- [ ] `:line` and `:line:col` suffixes open the file at that position.
- [ ] Non-existent paths are not underlined.
- [ ] Trailing `.`, `,`, `)` are not swallowed into the link text.
- [ ] Folder links open the OS file manager at that folder.
- [ ] Guard: in the browser preview (`window.agentDeck` absent) no link
  provider is registered.
- [ ] Unit tests pass for the pure detection module.
- [ ] `npm run verify` exits 0.
