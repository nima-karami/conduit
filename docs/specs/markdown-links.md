# Markdown link handling

**Status:** Implemented (R4)

## Problem

Clicking a link inside a rendered markdown document did nothing. The `MarkdownLink`
component only handled `external` links (http/https) via `openExternal`; relative
file links like `./other.md` or `../docs/guide.md` fell through without any action.

## Design

### `webview/md-links.ts` — link classification + resolution

A pure, browser-safe module (no `node:path` — the webview is bundled for platform
`browser`) that resolves an href + a document absolute path to one of five kinds:

| Kind | Example | Action |
|------|---------|--------|
| `anchor` | `#introduction` | scrollIntoView on the in-page element |
| `relative-file` | `./other.md`, `../guide.md`, `sibling.md` | open via `onOpenFile` |
| `absolute-file` | `C:\docs\guide.md`, `/home/user/notes.md` | open via `onOpenFile` |
| `external` | `https://example.com` | host bridge `openExternal`; falls back to `window.open` |
| `other` | `mailto:…`, `data:…`, `javascript:…` | inert anchor with tooltip |

Windows drive letters (`C:\`, `C:/`) are detected *before* URL scheme detection so
that `C:` is not mistaken for a two-character URL scheme. URL schemes with two or
more characters before the colon are classified after drive letters are ruled out.

Path resolution is implemented inline (`dirName`, `resolvePath`) handling both `\`
and `/` separators, `..` traversal, and `%XX`-encoded spaces.

### `MarkdownViewer` prop `onOpenFile`

`MarkdownViewer` now accepts an optional `onOpenFile: (path: string) => void` prop
threaded from `App.openFile` → `CenterPane` → `DocView` → `MarkdownViewer`.

`App.openFile` already routes by file type (markdown files open in the rendered
view; code files open in the editor), so no additional routing logic is needed in
the link handler.

### Missing target behaviour

When `onOpenFile` calls `post({ type: 'readFile', path })` for a path that doesn't
exist, the host returns an error `FileContentDTO` (with `file.error` set). `DocView`
renders `<div className="viewer__notice">{file.error}</div>` — already visible.

### External link safety

`openExternal` in `electron/main.ts` already validates that the URL has an
http/https scheme before calling `shell.openExternal`, so passing any other scheme
is a no-op. No additional allowlist is needed on the renderer side.

## Prop threading

```
App
  openFile (path: string) → post readFile + dispatch docs
    ↓ prop: onOpenFile
  CenterPane
    ↓ prop: onOpenFile
  DocView
    ↓ prop: onOpenFile
  MarkdownViewer
    → MarkdownLink (via makeMarkdownLink factory)
```

## Files touched

- `webview/md-links.ts` (new) — classification + resolution module
- `webview/components/markdown-viewer.tsx` — new `MarkdownLink` click handler
- `webview/components/doc-view.tsx` — pass `onOpenFile` to `MarkdownViewer`
- `webview/components/center-pane.tsx` — accept + pass `onOpenFile`
- `webview/app.tsx` — pass `openFile` as `onOpenFile` to `CenterPane`
- `webview/styles.css` — add `cursor: pointer; text-decoration: underline` to `.markdown a`
- `test/unit/md-links.test.ts` (new) — 31 unit tests

## Acceptance criteria

- Click a `./relative.md` link → target opens in rendered markdown view
- Click a `../parent/guide.md` link → target opens correctly after `../` traversal
- Click an `https://example.com` link → opens in the system browser
- Click a `#heading` link → page scrolls to that heading
- Click a `mailto:` link → nothing happens, tooltip reads "Unsupported link type"
- Links are styled with `cursor: pointer` and an underline
