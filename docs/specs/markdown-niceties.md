# Spec — Markdown rendered-view polish (L6 markdown-niceties)

**Tier:** LITE · **Feature type:** UI · **Slug:** `markdown-niceties`

## Problem frame

- **Job:** Improve the markdown viewer's interaction model with two small, high-utility
  affordances: a copy button on code blocks and anchor links on headings.
- **Actor:** Any user reading `.md` files in the preview pane or webview.
- **Success:** Code blocks show a subtle copy button on hover (keyboard-accessible via
  :focus-visible); headings get stable ids and a small '#' anchor link on hover to
  deep-link to that section.
- **Non-goals:** Monospace font size, code theme customization, heading hierarchy
  (h5/h6), syntax highlighting tuning.

## Behavior & states

### Copy button (code blocks)

- **Rendered code block:** `<pre>` element (from rehype-highlight), wrapped in a
  positioned container; a small copy button sits in the top-right corner.
- **Hover/focus:** button appears on mouse-over or :focus-visible (keyboard nav); on
  blur, button hides.
- **Click:** `navigator.clipboard.writeText()` copies the block's plain text; the button
  briefly shows a "Copied" state (text changes to "Copied", 1.5s duration); then
  reverts.
- **Unavailable (no clipboard API):** button is not rendered if `navigator.clipboard`
  is undefined.
- **Style:** subtle (dark on dark), top-right of block, no layout shift, respects
  existing code block background.

### Heading anchors

- **Headings (h1–h4):** Each gets a stable `id` derived from the heading's text via a
  small slugify utility: lowercase, trim, normalize spaces to `-`, strip
  non-alphanumerics except `-`, collapse consecutive `-` to single.
- **Slug collisions:** If multiple headings render with the same slug, suffix the
  duplicates `-1`, `-2`, etc. (counter tracked per render).
- **On hover:** a small '#' anchor link appears next to the heading text (or as a
  pseudo-element); clicking or keyboard enter on the link scrolls to `#slug`.
- **Scroll behavior:** `scroll-margin-top` on headings so they don't hide under sticky
  UI.
- **Style:** subtle, small, muted color, no underline by default (underline on hover).

## Implementation outline

### New files

1. **`webview/slugify.ts`** — Pure utility to generate stable heading slugs.
   - Export: `function slugify(text: string): string` — lowercase, trim, spaces → `-`,
     strip non-alphanumerics except `-`, collapse repeats.
   - Export: `class SlugFactory` — stateful counter; `.slug(text: string): string`
     returns a unique slug, suffixing `-1`, `-2` on collision.
   - Unit tests: `test/unit/slugify.test.ts` (casing, spaces, punctuation, unicode,
     duplicates).

2. **CSS additions to `webview/styles.css`**:
   - `.markdown pre` wrapper (positioned container, relative).
   - `.markdown-code-copy-btn` (button, positioned absolute top-right, subtle styling,
     hidden by default).
   - `.markdown-code-copy-btn:hover`, `:focus-visible` (visible, style on interaction).
   - `.markdown-code-copy-btn.copied` (state class: "Copied" text, 1.5s auto-revert).
   - `.markdown h1`, `.markdown h2`, `.markdown h3`, `.markdown h4` (scroll-margin-top,
     rel positioning for anchor link).
   - `.markdown-heading-anchor` (pseudo or small `<a>` element, muted color, hidden by
     default, visible on heading hover).

### Changes to `webview/components/markdown-viewer.tsx`

- Import `SlugFactory` from `slugify.ts`.
- Override `pre` component in `markdownComponents`:
  - Wrap rehype-produced `<pre>` in a `<div>` with `style={{position:'relative'}}`.
  - Render a copy button (guarded by `navigator.clipboard` availability).
  - On click, copy the block's text; on success, show "Copied" state for 1.5s.
- Override `h1`, `h2`, `h3`, `h4` components:
  - Create a `SlugFactory` instance per render (or memoize to persist across renders
    within the same markdown doc).
  - Assign stable `id` via `slugFactory.slug(text)`.
  - Render heading with the id and a small anchor link child (or adjacent).

## Scope slicing

- **MVP (this task):**
  1. `webview/slugify.ts` with `slugify()` and `SlugFactory`.
  2. Unit tests for slugify (casing, spaces, punctuation, unicode, duplicates).
  3. Override `pre` in markdown components: copy button, clipboard guard, 1.5s state.
  4. Override h1–h4 in markdown components: stable ids, anchor link on hover.
  5. CSS for button, anchor link, scroll margin.
- **Out of scope:** h5/h6, copy toast notifications (silent success), custom fonts,
  markdown extensions beyond GitHub-flavored.

## Acceptance criteria

- `npm run verify` passes (format, lint, typecheck both tsconfigs, tests).
- `npm run build` passes.
- Unit tests for slugify:
  - `slugify('Hello World')` → `'hello-world'`.
  - Punctuation, unicode, consecutive spaces handled correctly.
  - `SlugFactory` correctly suffixes duplicates `-1`, `-2`.
  - Test count: 581 baseline + new tests (expect 590+).
- Manual verification (serve webview over HTTP, screenshot):
  - Code block shows copy button on hover; clicking copies text without error.
  - Headings have ids and anchor links appear on hover; anchor href matches id.
  - Scroll-margin prevents headings from hiding under sticky UI.
  - Button has "Copied" state on success.
- Git status: only intended files staged (not `board.json`).
- One clean commit with trailer.

## Decisions Needed

none
