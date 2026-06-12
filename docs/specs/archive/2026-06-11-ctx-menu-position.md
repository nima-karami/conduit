# Spec — Context menus open at the pointer / anchored to their trigger (J2)

**Tier:** LITE · **Feature type:** Bugfix · **Slug:** `ctx-menu-position`

One-line: the shared `.ctxmenu` rendered in the wrong place — the editor's
right-click menu was offset from the cursor, and the sessions three-dot overflow
menu opened in the middle of the sidebar instead of under its button. Fix the
coordinate space so menus open exactly where their `{x, y}` requests.

---

## 1. Context

`ContextMenu` (`webview/components/context-menu.tsx`) is the app's single floating
menu. Consumers pass `{x, y, items}` where `x, y` are **viewport** coordinates —
either a `contextmenu` event's `clientX/clientY` (editor right-click) or a trigger
button's `getBoundingClientRect()` (sessions three-dot). The menu is
`position: fixed` and its `style.left/top` are set to those coordinates; a pure,
unit-tested `clampMenuPosition` keeps it on-screen.

Two manifestations were reported (J2):

- **Code editor:** right-click opened the menu offset from the pointer, not under
  the cursor (`webview/components/code-viewer.tsx`, `editor.onContextMenu`).
- **Sessions panel:** the "Sort & filter sessions" three-dot menu opened roughly in
  the middle of the sidebar instead of anchored to the button
  (`webview/components/sidebar.tsx`, `openSortFilterMenu`).

## 2. Root cause(s)

**Single shared root cause — a CSS containing block, not a coordinate-math bug.**

A `position: fixed` element resolves its offsets against the viewport **only if no
ancestor establishes a containing block**. Per the CSS spec, any element with a
non-`none` `filter`, `backdrop-filter`, `transform`, `perspective`, or `will-change`
of those becomes the containing block for its fixed-position descendants.

The background-blur feature applies `backdrop-filter: blur(var(--bg-blur))` to the
app's panels whenever `data-background !== "none"` (the default is `aurora`):

```css
:root:not([data-background="none"]) .sidebar,
:root:not([data-background="none"]) .right,
:root:not([data-background="none"]) .termwrap,
… { backdrop-filter: blur(var(--bg-blur)); }
```

`ContextMenu` was rendered **inline** as a child of the consumer — i.e. inside
`.sidebar` (three-dot) or inside the editor's `.viewer`, which lives within the
backdrop-filtered center/right panels. So its `left/top` (viewport coordinates) were
applied relative to the **panel's** top-left, not the viewport:

- Editor: menu shifted by the editor container's origin → "offset from the cursor".
- Sidebar: viewport-ish coordinates measured against the sidebar's box landed deep
  inside the (~250px-wide) sidebar → "centered in the panel".

The per-call-site coordinate derivations (`clientX/clientY` for the editor;
`rect.right - MENU_W`, `rect.bottom + 4` for the three-dot) were already **correct**;
they were simply being interpreted in the wrong coordinate space.

Runtime confirmation (preview, `data-background="aurora"`): `.sidebar` computed
`backdrop-filter` was `blur(6px)`; a `position: fixed` probe at viewport `(400, 300)`
placed inside a backdrop-filtered panel offset by `(300, 120)` landed at `(700, 420)`
(offset by exactly the panel origin), while the same probe appended to `<body>`
landed at `(400, 300)`.

## 3. Fix

- **Portal the menu to `document.body`** (`createPortal`) in `ContextMenu`. This
  escapes every backdrop-filtered / transformed ancestor, so `position: fixed`
  resolves against the viewport again and `{x, y}` mean what consumers intend. One
  change fixes **all** call sites (file/tab/session/editor/board/canvas menus), not
  just the two reported. `ref`-based outside-click detection still works because
  portals keep refs to the real DOM node and `Node.contains` follows the rendered
  tree.
- **Extract `anchorMenuToRect(rect, menuWidth, gap)`** into the pure
  `src/menu-position.ts` and use it from the sidebar, so the three-dot anchor
  derivation is a tested function (right-aligned to the trigger, dropped below by a
  gap) rather than inline magic numbers. Clamping remains `clampMenuPosition`'s job.

No magic-number offsets were added; the fix corrects the coordinate space at the
source.

## 4. Acceptance

- Right-clicking in the code editor opens the menu at the pointer (its `clientX/Y`),
  then clamps on-screen. *(Component-level: the editor menu uses the same portaled
  `ContextMenu`; the offset mechanism is reproduced and shown fixed by the portal.)*
- The sessions three-dot menu opens directly below and right-aligned to its button,
  over the sidebar — never centered in the panel. Verified live: menu `parentElement
  === document.body`, rect `(54, 154)` for a button at `right=254, bottom=150`.
- `clampMenuPosition` and `anchorMenuToRect` are unit-tested (10 cases in
  `test/unit/menu-position.test.ts`), including anchor-tracks-trigger and
  anchor-then-clamp composition.
- `npm run verify` and `npm run build` both exit 0.

## 5. Notes / limitations

- The fake-shell preview has no host bridge, so no session/file loads and the Monaco
  editor never mounts — the editor right-click can't be driven end-to-end there. Its
  coordinate fix is proven via the shared component (portal), the reproduced
  containing-block offset, and unit tests. Worth a quick manual confirm in the real
  Electron app: right-click in an open file and confirm the menu sits under the
  cursor with `data-background` set to a blurred theme.
