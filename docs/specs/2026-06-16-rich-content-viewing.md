---
status: active
date: 2026-06-16
---

# Rich content viewing — images + mermaid

## Problem

Conduit can only render text. Two gaps:

1. **Images don't preview.** Opening an image shows *"Binary file — no preview."*
   (`webview/components/code-viewer.tsx:367`); `readFile` returns empty content for
   binaries (`src/file-service.ts:41`), so the bytes never reach the renderer. SVGs are
   worse — they read as text, so they open in Monaco as raw XML.
2. **Mermaid diagrams render as code.** The markdown rendered view (`react-markdown` in
   `webview/components/markdown-viewer.tsx`) shows a ```mermaid fenced block as a code
   block, not a diagram — common in `README`/design docs.

## Goal

One cohesive "rich content viewing" feature with two independent parts:

- **(A)** An **image viewer** in the file-open path (images delivered as base64 data
  URLs — user chose images-only, no new Electron protocol).
- **(B)** **Mermaid** rendering inside the markdown rendered view.

Touches `src/file-service.ts`, `src/protocol.ts`, `webview/components/code-viewer.tsx`,
`webview/components/markdown-viewer.tsx`, a new `Mermaid` component, small pure helpers,
and `package.json` (mermaid dep). One implementation plan.

## (A) Image viewer

### Detection — by extension, not the `binary` flag

A pure helper `mediaKindForPath(path): 'image' | null` (new module, unit-tested) matches
image extensions **case-insensitively**: `.png .jpg .jpeg .gif .webp .bmp .ico .avif
.svg`. SVG is included even though it reads as text — detection is by extension, never by
`isBinary`. A sibling `imageMime(ext)` maps extension → MIME (`image/png`, …,
`image/svg+xml`).

### Delivery — base64 data URL via the existing file-open path

- Extend `FileContentDTO` with an optional field:
  `image?: { mime: string; dataUrl: string; bytes: number }`.
- In `src/file-service.ts` `readFile`: when `mediaKindForPath` says image, **skip** the
  utf8/binary text read; instead read the buffer, and if it is within a size cap
  (`MAX_IMAGE_BYTES`, e.g. **25 MB**) return `{ …, binary: true, content: '', image: {
  mime, dataUrl: 'data:<mime>;base64,<…>', bytes } }`. Over the cap → return no `image`
  and an `error: 'Image too large to preview (<n> MB)'` so the renderer shows a notice
  rather than a huge payload.
- No new IPC message — reuses `readFile` → `fileContent`. The `image` field rides the
  existing channel.

### Renderer

`code-viewer.tsx` branches **before** the Monaco/binary path: if `doc.image` is present,
render a new read-only `ImageViewer` component:

- The image **fit-to-pane** (max-width/height 100%, `object-fit: contain`, no upscaling
  blur beyond natural size), centered.
- A **checkerboard backdrop** so transparency reads (CSS, reuse/add one token-based
  pattern; no new hex beyond the checker neutrals).
- A small caption: pixel **dimensions** (from the loaded `<img>` `naturalWidth/Height`)
  + **file size** (`image.bytes`).
- Optional **1:1 toggle** (natural size vs fit). No pan/zoom beyond that.
- SVG renders via `<img src="data:image/svg+xml;base64,…">` — an img-loaded SVG cannot
  execute scripts, so it is safe under the app CSP (no inline-SVG injection).
- Editor/dirty-state logic is bypassed for images (read-only; no Monaco model created).

CSP: the renderer must allow `img-src 'self' data:` (add `data:` to `img-src` if not
already present).

## (B) Mermaid in the markdown rendered view

### Rendering

- A custom `react-markdown` `code` component: a fenced block whose language is `mermaid`
  renders as a diagram; **all other** code blocks are unchanged (still `rehype-highlight`).
  A pure classifier `isMermaidCodeBlock(className)` (unit-tested) decides.
- A new `Mermaid` component renders the diagram: on mount / source change, call
  `mermaid.render(id, source)` (async) and inject the returned SVG. Initialize mermaid
  once with `securityLevel: 'strict'`, `startOnLoad: false`, and `theme: 'dark'` (or
  `themeVariables` derived from existing design tokens) to match the app palette.
- **Error handling:** if `mermaid.render` rejects (invalid diagram), render the error
  message **plus** the raw fenced source in a `<pre>` — never throw out of the markdown
  view. Each diagram failure is isolated (one bad block doesn't blank the doc).

### Bundling

- `mermaid` is added as a dependency and **statically bundled** into the single IIFE —
  there is no CDN under the app CSP (`script-src 'self'`), the same constraint that forced
  static-bundling Lucide. The bundle-size increase is an accepted cost. The `esbuild`
  build must stay green (and per the W1 spec, `node esbuild.mjs` should be in the verify
  gate).
- If lazy-loading is feasible without a separate chunk (esbuild IIFE has no code-splitting
  under CSP), prefer importing mermaid only from the markdown viewer module so it is not
  pulled into unrelated entry paths; otherwise accept the eager bundle.

### Scope

Mermaid only inside **markdown fenced blocks** — not standalone `.mmd` files (the
`Mermaid` component could be reused for that later).

## Edge cases & failure modes

- **SVG opened from the tree** → image preview (extension wins over its text-ness).
- **Image over the size cap** → "too large to preview" notice, no data URL sent.
- **Corrupt/zero-byte image** → `<img>` `onerror` shows a "couldn't render image" notice.
- **`readFile` on an image in the mock preview (no host)** → the fake shell returns no
  `image`; the viewer shows the existing notice (guard for `doc.image` undefined).
- **Mermaid in a non-rendered (raw editor) markdown view** → unchanged; mermaid only
  applies to the *rendered* view.
- **Very large mermaid diagram** → render in an effect (async) so it doesn't block; show
  the SVG in a scroll container.

## Defaults & settings

- Both features **on by default**, no settings. Image preview and mermaid rendering are
  the expected behavior, not a preference.
- Image size cap is a constant (`MAX_IMAGE_BYTES`), not user-configurable.

## Testing

- **Unit (vitest):** `mediaKindForPath` (all extensions, case-insensitive, non-matches);
  `imageMime`; the size-cap decision in `readFile` (mockable fs); `isMermaidCodeBlock`
  (mermaid vs other languages vs no-language).
- **Real-app smoke (W1 harness):** new scenario `rich-content.e2e.mjs` — (1) open a `.png`
  → an `<img>` with a `data:` URL renders (not the "no preview" notice) with a dimensions
  caption; (2) open an `.svg` → renders as an image, not Monaco XML; (3) open a markdown
  file containing a ```mermaid block → an `<svg>` diagram appears in the rendered view;
  (4) a broken mermaid block shows the error + raw source without blanking the doc.

## Acceptance criteria

- Opening any listed image extension shows the image (fit-to-pane, checkerboard,
  dimensions + size caption); SVG previews as an image, not text.
- Images over `MAX_IMAGE_BYTES` show a "too large" notice; no oversized payload is sent.
- A ```mermaid block in the markdown rendered view renders as an SVG diagram; other code
  blocks still syntax-highlight; an invalid diagram shows error + source.
- `mediaKindForPath`, `imageMime`, the cap decision, and `isMermaidCodeBlock` are
  unit-tested.
- `npm run verify` EXIT 0 and `node esbuild.mjs` green (mermaid bundled).
- CSP allows `img-src data:`.

## Out of scope

- **Video and audio** (user chose images-only) — captured as a follow-up (needs a custom
  path-guarded Electron protocol, e.g. `conduit-media://`, because base64 can't stream).
- Pan/zoom beyond fit + 1:1; image editing; thumbnails in the file tree.
- Standalone `.mmd` files; mermaid live-editing.

## References

- `src/file-service.ts` — `readFile` (`:35`), binary detection (`:41`/`:121`).
- `src/protocol.ts` — `FileContentDTO` (`:54`, gains the `image?` field).
- `webview/components/code-viewer.tsx` — binary notice (`:367`), Monaco model path
  (`:72`); the image branch goes ahead of these.
- `webview/components/markdown-viewer.tsx` — `react-markdown` setup; the `code` component
  override for mermaid.
- Bundle-size precedent: the D3 Lucide static-bundle decision (single IIFE, CSP
  `script-src 'self'`, no CDN) in `docs/runs/2026-06-16-daily-driver/report.md`; the IIFE
  constraint is also noted in `CLAUDE.md`.
- W1 smoke harness: `docs/specs/2026-06-16-smoke-harness.md` (hosts `rich-content.e2e.mjs`).
