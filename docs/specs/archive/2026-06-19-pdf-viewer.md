---
status: implemented
date: 2026-06-19
---

# In-app PDF viewer

## Problem

Conduit renders code (Monaco), markdown, and images, but opening a `.pdf` falls through to
the code viewer and shows a "binary" notice. Users want to **view PDFs in Conduit** with the
expected reading affordances. Approved v1 feature set: page navigation + continuous scroll,
zoom & fit-to-width, text selection/copy + in-document find, and an outline + thumbnails
sidebar.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Render engine | `pdfjs-dist` (Mozilla pdf.js), used via its low-level API | The standard, dependency-light, ESM-friendly PDF renderer; we already bundle other workers (Monaco). |
| Data channel | Reuse the host binary read → base64 data URL, in a new `pdf?` field of `FileContentDTO` | Exactly how images already reach the renderer; the renderer decodes to a `Uint8Array` for pdf.js. |
| Size cap | `MAX_PDF_BYTES` (50 MB) | Bounds the base64 IPC payload; over-cap returns the existing error-notice shape. |
| Rendering model | Continuous vertical scroll; render only pages near the viewport (windowed), each page to a `<canvas>` + a selectable text layer | Multi-page documents aren't the image pan/zoom model; canvas + text layer is the pdf.js norm. |
| Worker | Bundle `pdf.worker` as a separate esbuild entry (like `ts.worker`), set `GlobalWorkerOptions.workerSrc` | pdf.js requires its worker; mirrors the existing Monaco worker bundling (`webview/monaco-setup.ts`). |
| Find | Search extracted page text in-renderer, highlight + scroll to matches (next/prev) | The low-level API gives `getTextContent`; a small find controller avoids pulling in pdf.js's full viewer component. |

## Architecture

### §1 — Dependency + bundling

- Add `pdfjs-dist` to `dependencies`.
- `esbuild.mjs`: add a **separate worker bundle** entry for `pdfjs-dist/build/pdf.worker.min.mjs`
  → `out/pdf.worker.js` (alongside the existing `ts.worker` / monaco worker entries). A
  `webview/pdf-setup.ts` sets `pdfjsLib.GlobalWorkerOptions.workerSrc` to the bundled worker
  path (resolved the same way the Monaco workers are), imported once before first use.
- pdf.js CSS for the text layer (`pdfjs-dist/web/text_layer_builder` styles, or a minimal
  hand-rolled `.textLayer` rule) added to `styles.css` so selection geometry lines up.

### §2 — Host: detect + read (`src/media-kind.ts`, `src/file-service.ts`, `src/protocol.ts`)

- `media-kind.ts`: add a PDF check (`pdfKindForPath(path): boolean` on `.pdf`, case-insensitive),
  kept distinct from `IMAGE_EXTS` (different `FileContentDTO` field + viewer).
- `file-service.ts` `readFile`: when the path is a PDF, read the binary buffer (cap at
  `MAX_PDF_BYTES`), set `pdf: { dataUrl: 'data:application/pdf;base64,…', bytes }` and leave
  the text fields empty (same shape as the image branch). Over-cap → the existing error notice.
- `protocol.ts` `FileContentDTO`: add `pdf?: { dataUrl: string; bytes: number }`.

### §3 — Renderer: viewer selection (`webview/components/doc-view.tsx`)

One branch, before the markdown/code fallback: `if (file.pdf) return <PdfViewer doc={file} />`.
(Order: diff → image → pdf → markdown → code.) No other viewer changes.

### §4 — `webview/components/pdf-viewer.tsx` (+ small helpers)

Loads the document once (`getDocument({ data: base64ToUint8Array(doc.pdf.dataUrl) }).promise`),
then renders the UI. Decompose into focused units so no single file does too much:

- **`pdf-document.ts`** (pure-ish, no React): wraps a `PDFDocumentProxy` — `numPages`,
  `getPage`, `getOutline`, `getTextContent(page)`. The seam the component and find controller
  share; unit-testable against a tiny fixture PDF.
- **`PdfViewer`** (container): toolbar + optional sidebar + the scrolling page list. Owns
  zoom/scale, current page, fit mode, find state. Keyboard: PageUp/Down, Home/End, Ctrl+F
  (find), Ctrl+/- (zoom), Esc (close find).
- **`PdfPage`**: renders one page to a `<canvas>` at the current scale + a positioned text
  layer (`page.getTextContent()` → absolutely-positioned spans) for selection/copy and find
  highlights. Only mounted for pages near the viewport (windowed by an `IntersectionObserver`
  / scroll position); off-screen pages are lightweight placeholders sized to the page so the
  scrollbar is stable.
- **Toolbar**: page `N / total` + jump-to-page input, prev/next, zoom out/in + % , fit-width /
  fit-page, find toggle. Visual language matches the image viewer's `.imgstage__controls`
  (top-right grouping, themed tokens).
- **Sidebar** (collapsible): **Outline** (from `getOutline()`, nested, click → scroll to
  destination) and **Thumbnails** (small canvas render per page, click → scroll). Toggle in
  the toolbar; remembered per session is out of scope (always starts collapsed).
- **`pdf-find.ts`** (pure controller): given page text contents + a query, returns ordered
  matches (page index + range); the viewer scrolls to the active match and the page's text
  layer highlights it. Next/prev cycles matches. Case-insensitive; plain substring (no regex).

### §5 — Theming / tokens

Reuse existing CSS custom properties (no new palette): page background `--panel`/white sheet
with `--border` + a soft shadow; toolbar/sidebar use `--term-surface` / `--text` / `--text-dim`
/ `--panel-2` like the other viewers. Find-highlight uses `--amber` (the established attention
hue). Respect `prefers-reduced-motion` for scroll-to-match (instant when set).

## Edge cases

| Condition | Behaviour |
|---|---|
| Encrypted / password PDF | pdf.js throws `PasswordException` → show a clear "password-protected PDF (unsupported)" notice, not a crash. |
| Corrupt / invalid PDF | `getDocument` rejects → error notice with the file name. |
| Very large PDF (over cap) | Host returns the over-cap notice (no data URL); viewer shows "file too large to preview (NN MB)". |
| Huge page count | Windowed rendering + placeholder pages keep memory/CPU bounded; thumbnails render lazily on sidebar open. |
| No outline | Outline tab shows an empty-state ("No outline"); thumbnails still work. |
| Empty find result | Find box shows "0 results"; no scroll. |
| `agentDeck` bridge absent (preview) | `file.pdf` is never set, so the viewer never mounts — no host/worker calls (matches the image viewer's guard). |
| Reduced motion | Scroll-to-page/match is instant. |

## Testing

- **Unit:**
  - `pdfKindForPath` (`.pdf` true; others false; case-insensitive).
  - `base64ToUint8Array` round-trips a known data URL.
  - `pdf-find` match ordering/cycling over a fixed `getTextContent`-shaped input (next/prev,
    case-insensitivity, zero results) — pure, no pdf.js needed.
  - `file-service` PDF branch: a small fixture `.pdf` yields a `pdf` field with the right mime
    + byte count; an over-cap path returns the error notice.
- **Runtime observation (real app, e2e — this is the required proof for a UI feature):** a new
  `test/e2e/pdf-viewer.e2e.mjs` opens a seeded multi-page fixture PDF in the real app and
  asserts: the canvas pages render (page count shown), zoom changes the rendered scale, the
  text layer exists (selectable text present), find highlights a known term, and the outline
  sidebar lists entries for a PDF that has them. Capture a screenshot as evidence.
- **Regression:** existing image/markdown/code viewers unaffected (`doc-view` order unchanged
  except the added pdf branch).

## Files touched

| File | Change |
|------|--------|
| `package.json` | Add `pdfjs-dist` dependency |
| `esbuild.mjs` | Separate `pdf.worker` bundle entry |
| `webview/pdf-setup.ts` | **New.** Set `GlobalWorkerOptions.workerSrc` |
| `src/media-kind.ts` | `pdfKindForPath` |
| `src/file-service.ts` | PDF read branch → `pdf` data URL (cap) |
| `src/protocol.ts` | `FileContentDTO.pdf?` |
| `webview/components/doc-view.tsx` | `if (file.pdf) → <PdfViewer>` branch |
| `webview/components/pdf-viewer.tsx` | **New.** Container (toolbar, sidebar, scroll) |
| `webview/pdf-document.ts` | **New.** `PDFDocumentProxy` wrapper |
| `webview/pdf-find.ts` | **New.** Pure find controller |
| `webview/styles.css` | `.pdfview__*` + `.textLayer` rules (tokens only) |
| `test/unit/*` | `pdfKindForPath`, `base64ToUint8Array`, `pdf-find`, file-service PDF |
| `test/e2e/pdf-viewer.e2e.mjs` | **New.** Real-app render/zoom/find/outline proof |
| `CHANGELOG.md` | User-facing entry |

## Out of scope

- Editing / annotating / form filling / signing.
- Printing and "save a copy" (the OS/default PDF app covers these; a future "open externally").
- Password entry UI for encrypted PDFs (shown as unsupported for now).
- Linkified internal/external hyperlinks within the PDF (read-only render first).
- Remembering sidebar/zoom state across reopens.
