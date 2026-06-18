---
status: draft
date: 2026-06-17
---

# Image viewer — zoom/pan + image diffs

**Tier:** FULL · **Type:** UI

Builds on the shipped image viewer (`archive/2026-06-16-rich-content-viewing.md`):
fit ⇄ 1:1 toggle, dimensions + size caption, checkerboard backdrop, 25 MB cap,
extension-detected, delivered as a base64 data URL via `FileContentDTO.image`.

Scope this round (user-chosen): **(A) zoom & pan polish** in the standalone viewer
and **(B) image diffs** in the Changes/review view. **Out:** video/audio, tree
thumbnails (deferred again).

## 1. Problem frame

**JTBD:** When I open an image or review a changed image in Conduit, I want to
inspect it properly — zoom into detail, pan, compare before/after — the way I can
in VS Code, so I don't have to leave the app for a separate image tool.

Two concrete gaps today:

1. **Inspection is crude.** `image-viewer.tsx` offers only fit ⇄ 1:1. No zoom
   levels, no pan when zoomed past the pane, no rotate. Pixel-level inspection
   (icons, screenshots, sprites) is impossible.
2. **Image changes are opaque.** A modified binary image in the Changes/review view
   renders *"Binary file — no diff preview."* (`diff-viewer.tsx:77`,
   `review-view.tsx:144`). You can't see *what* changed in an asset.

**Actors:** the single local user (a developer reviewing their own / agent-made
changes).

**Success outcomes:**

- Zoom 1–N×, pan, rotate, reset — pointer **and** keyboard.
- A changed image shows old vs new (side-by-side / swipe / onion), including added
  and deleted.

**Non-goals:** video/audio playback, file-tree thumbnails, image editing/annotation,
multi-image galleries, EXIF/metadata panel.

## 2. Behavior & states

### 2a. Image viewer (standalone open)

Controls overlay the stage (auto-hide, reveal on hover/focus) alongside the existing
footer caption.

State catalog:

- **Populated** — image at the current zoom/rotation; footer shows
  `W × H px · size · zoom%`.
- **Loading** — image bytes already arrive inline in `fileContent` (no separate
  fetch), so there is no async spinner; chrome renders immediately and decode is
  browser-fast (no skeleton needed — stated, not dropped).
- **Error (component)** — `<img onError>` → *"Could not render image."* (existing).
  Constructive next step: the file may be corrupt; reopen.
- **Too large** — over `MAX_IMAGE_BYTES` (25 MB) → existing *"Image too large to
  preview (N MB)"* notice; the zoom UI is hidden.
- **Not-found / deleted-after-open** — host read failed → `doc.error` notice
  (existing path).
- **No host (browser preview)** — the fake shell returns no `doc.image`; the viewer
  shows the existing notice. Guard `doc.image` undefined.
- **Empty / first-run / offline / permission / saving / limit** — N/A (read-only,
  local, single file). Named to satisfy the catalog, not padded.

Zoom/rotate state is **per open document**, reset on close; **not** persisted.

### 2b. Image diff (Changes / review)

Diff modes, user-switchable, default **side-by-side**:

- **Side-by-side** — old (HEAD) left, new (working) right, each with dimensions and a
  `−`/`+` colored **and labeled** badge.
- **Swipe** — both stacked; a draggable **divider** (an `<input type="range">`, so
  keyboard-operable) wipes between old/new.
- **Onion** — new over old with an opacity slider (also `<input type="range">`).

Per-file diff states:

- **Modified** (both blobs present, ≤ cap) — the full compare UI.
- **Added** — only the working side; "Added" badge; old side is an empty
  placeholder.
- **Deleted** — only the HEAD side; "Deleted" badge; new side is an empty
  placeholder.
- **Either side over cap / unreadable HEAD blob** — fall back to the current
  *"Binary file — no diff preview."* notice (degrade; never block the review).
- **Non-image binary** (e.g. `.pdf`, `.zip`) — unchanged: the existing "no diff
  preview" notice. Image-diff only triggers when `mediaKindForPath` says image.

## 3. Data / interface contract

**Reuse the existing base64-data-URL path — no new Electron protocol** (consistent
with the prior rich-content decision; both diff sides stay ≤ 25 MB, which the cap
already enforces).

- **Viewer:** no protocol change. `FileContentDTO.image` already carries
  `{ mime, dataUrl, bytes }`. Zoom/pan/rotate are renderer-only state.
- **Image diff:** extend `FileDiffDTO` with an optional image branch rather than
  overloading `head`/`work` (which are utf8 text):

  ```ts
  image?: {
    head?: { dataUrl: string; bytes: number };   // absent ⇒ added
    work?: { dataUrl: string; bytes: number };   // absent ⇒ deleted
    status: 'modified' | 'added' | 'deleted';
    overCap?: boolean;                            // either side > cap ⇒ notice
  }
  ```

  - `readDiff` (`src/file-service.ts`): when `mediaKindForPath(path) === 'image'`,
    build `image` instead of the `head`/`work` text. Working side = read buffer →
    data URL (existing logic). HEAD side = **new binary-safe git read** (below).
    `binary` stays `true` so non-image consumers are unaffected.
  - **The HEAD blob must be read as a Buffer.** Add a buffer-returning git call
    (e.g. `gitShowBuffer`) — `execFile` with `encoding: 'buffer'` (or
    `git cat-file blob HEAD:<rel>`) — because the current `git()` (`main.ts:142`)
    utf8-decodes stdout and corrupts binary. Invariant: a missing HEAD path (new
    file) ⇒ `head` absent, `status:'added'`; a missing working file ⇒
    `status:'deleted'`.
  - Invariant: `status` is derived host-side from which sides exist; the renderer
    never re-derives it.

## 4. Edge cases & failure modes

- **Zoom math:** clamp to `[fit, MAX_ZOOM]` (MAX 8×, assumption A2). At ≤ fit, pan
  is disabled (nothing to pan). Wheel-zoom keeps the cursor point stable (zoom
  toward the pointer).
- **Rotate** by 90° steps; dimensions/pan recompute against the rotated bounds.
- **Tiny image** (e.g. 16×16 favicon): fit must not blur — use
  `image-rendering: pixelated` when the displayed scale exceeds 1× natural.
- **Huge dimensions, small bytes** (e.g. 20000×20000 PNG): bytes pass the cap but
  decode may be heavy — accepted; the browser handles it, pan/zoom operate on the
  rendered element.
- **Animated GIF/WEBP:** plays as a normal `<img>`; zoom/pan/rotate apply to the
  playing frame. No frame scrubbing (out of scope).
- **SVG:** zoom/pan apply; stays `<img src="data:…">` (no inline injection — the
  CSP/script-safety guarantee is preserved).
- **Diff with identical bytes on both sides** (mode-only/metadata change): still
  renders both — git flagged it changed; that's acceptable.
- **Concurrency:** opening a new image while one is zoomed → state keyed per doc; no
  leak. Switching diff files keeps the chosen mode sticky (A3).
- **Over-cap on one diff side only:** the whole diff falls back to the notice (don't
  show a misleading one-sided "diff").

## 5. Defaults vs. settings

| Decision | Default | Rationale |
|---|---|---|
| Open zoom | Fit-to-pane | Current behavior; the safe 80% path. |
| Diff mode | Side-by-side | Most legible default; matches the text-diff mental model. Sticky per session (not persisted) like `diffSideBySide`. |
| MAX_ZOOM | 8× | Enough for pixel inspection without unbounded memory. Constant, not a setting. |
| Zoom step | 10% wheel / 25% button | Convention. Constant. |
| Smoothing | `pixelated` above 1× | Pixel inspection is the point of zooming in. |

**No new user settings.** These are expected behaviors, not durable preferences.
(Reduced-motion is honored via a media query, not a setting.)

## 6. Scope slicing

- **MVP:** Viewer zoom (wheel + buttons + keyboard) · pan-drag when zoomed ·
  fit/1:1/reset · zoom% in the footer. Image diff **side-by-side** with
  added/deleted/over-cap states + the binary-safe HEAD read.
- **v1:** Rotate 90°. Diff **swipe** and **onion** modes + a mode toggle.
  Zoom-toward-pointer. `pixelated` smoothing.
- **Vision (out of this spec):** "fill" mode, fit-width/height presets,
  copy-image-to-clipboard, open-in-OS-viewer, thumbnails, video/audio.
- **Out of scope:** editing/annotation, EXIF panel, galleries, GIF frame scrubbing,
  persisting zoom across reopen.

## 7. UI module — interaction & a11y/i18n

### Interaction inventory

| Component | Affordances | Pointer | Keyboard | ARIA |
|---|---|---|---|---|
| Zoom in/out/reset buttons | zoom controls | click | `Ctrl/Cmd +` / `-` / `0` (capture-phase, like the editor's `fontZoomTarget`) | icon buttons need `aria-label` |
| Stage | wheel-zoom, drag-pan | `Ctrl/Cmd+wheel` (or wheel) zooms; drag pans when zoomed | arrows pan when zoomed; `+`/`-` zoom; `0` reset; `R` rotate | `role="img"` with `aria-label` = filename |
| 1:1 / fit toggle | mode | click | Enter/Space | `aria-pressed` (exists) |
| Diff mode toggle | side-by-side / swipe / onion | click | Tab + Enter | `aria-pressed` group |
| Swipe divider / onion opacity | wipe / blend | drag | **`<input type="range">`** → arrows move it (the non-drag keyboard pathway for the drag, WCAG 2.5.7) | native slider role + `aria-label` |

### Accessibility

- Every drag (pan, swipe divider, onion blend) has a keyboard pathway (arrows /
  range input) — no drag-only action.
- Visible focus on all controls; survives forced-colors / high-contrast.
- Icon-only zoom/rotate buttons get `aria-label`.
- **Live region** (`aria-live="polite"`) announces zoom-level changes and diff-mode
  switches (otherwise sighted-only feedback).
- Added/deleted shown by **badge text + icon + color**, never color alone.
- **Reduced motion:** zoom/pan/rotate transitions are instant under
  `prefers-reduced-motion: reduce` (comprehension never depends on the animation).
- Focus stays on the viewer after zoom; closing the doc returns focus to the tab
  strip (existing behavior).

### Internationalization

The repo has **no i18n framework** — all strings are inline English by existing
convention (A4). So this feature adds inline strings written translation-ready
(`"Zoom in"`, `"Reset zoom"`, `"Original"`, `"Changed"`, `"Added"`, `"Deleted"`). No
new locale-formatted data: zoom % is digits + `%`; dimensions reuse the existing
`W × H px`. Pluralization N/A. **RTL:** the stage is symmetric and pan is *physical*
(arrow-right pans right) not logical, so it needs no mirroring; the side-by-side
order (old→new) is a reading-order convention that *would* mirror with the app — but
the app isn't RTL today, so deferred (flagged, not silently dropped).

## 8. Acceptance criteria

### EARS

- *Event:* When the user `Ctrl/Cmd+scroll`s over an image, the viewer shall zoom
  toward the pointer and update the footer zoom %.
- *State:* While zoom > fit, the viewer shall allow drag-pan and arrow-key pan,
  clamped to the image bounds.
- *Event:* When the user presses `Ctrl/Cmd+0`, the viewer shall reset to fit and
  announce it via the live region.
- *Event:* When a changed file is an image with both blobs ≤ cap, the review view
  shall render an old-vs-new image diff instead of the "no diff preview" notice.
- *Unwanted:* If either diff side exceeds the cap or the HEAD blob can't be read as
  binary, then the view shall fall back to the existing "no diff preview" notice
  (never a one-sided or garbled diff).
- *Unwanted:* If the working or HEAD file is absent, then the diff shall render the
  single available side with an "Added"/"Deleted" badge.
- *Ubiquitous:* The viewer shall expose every pointer action (zoom, pan, swipe,
  blend) via a keyboard equivalent.

### Gherkin (key flows)

```gherkin
Feature: Image viewer zoom & image diffs
  Scenario: Pixel-inspect an icon
    Given a 16×16 PNG is open in the viewer
    When I press Ctrl+= three times
    Then the image scales up with pixelated rendering
    And the footer shows the increased zoom percentage
    And arrow keys pan within the image bounds

  Scenario: Review a modified screenshot
    Given a committed screenshot has uncommitted changes
    When I open it from the Changes list
    Then I see the HEAD image and the working image side by side
    And each is labeled and sized
    When I switch to Swipe mode and drag the divider (or use arrow keys)
    Then the divider wipes between old and new

  Scenario: Newly added image
    Given an untracked image appears in Changes
    When I open its diff
    Then only the new image renders with an "Added" badge
```

### Declarative

- All zoom/pan/rotate actions work via keyboard alone.
- `readDiff` returns a binary-correct HEAD blob (round-trips byte-identical to
  `git show`).
- Over-cap or unreadable HEAD → graceful notice, no crash, no partial diff.
- `npm run verify` EXIT 0; new unit tests for the `status`/cap decision and the
  zoom-clamp math; a new `image-diff.e2e.mjs` smoke covering open-zoom and an
  added/modified image diff.

## Assumptions

- **A1** — Reuse base64 data URLs (no new `conduit-media://` protocol); both diff
  sides ≤ 25 MB cap. *Reversible; matches the prior decision.*
- **A2** — MAX_ZOOM 8×, wheel step 10%, button step 25%, `pixelated` above 1×.
  *Tunable constants.*
- **A3** — Diff mode is sticky per session (like `diffSideBySide`), not persisted to
  disk; viewer zoom resets on close. *Reversible.*
- **A4** — Strings stay inline English (no i18n layer exists); RTL diff-order
  mirroring deferred. *Matches repo convention.*
- **A5** — Image diff triggers only when `mediaKindForPath` says image; other
  binaries keep the current notice. *Conservative.*

## References

- `webview/components/image-viewer.tsx` — current fit/1:1 viewer (the zoom/pan/rotate
  surface).
- `src/file-service.ts` — `readFile` image branch + cap (`:40`–`:70`); `readDiff`
  (`:149`) gains the image branch.
- `src/protocol.ts` — `FileContentDTO.image` (`:61`); `FileDiffDTO` (`:66`) gains the
  `image?` field.
- `electron/main.ts` — `git()` (`:142`, utf8 — corrupts binary), `gitShow` (`:150`);
  add a buffer-returning sibling for the HEAD blob.
- `webview/components/diff-viewer.tsx` (`:77`) / `review-view.tsx` (`:144`) — the
  current "no diff preview" notices the image branch replaces.
- `webview/components/code-viewer.tsx` (`:330`) — the image branch that routes to
  `ImageViewer`; `fontZoomTarget` capture-phase keybinding precedent.
- Prior spec: `archive/2026-06-16-rich-content-viewing.md` (image viewer v1 + the
  deferred-media decision).
