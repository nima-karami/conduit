# Spec: Tab Strip Overflow (R7)

## Problem

With 10-20 tabs open the user cannot access overflow tabs. The horizontal scrollbar
is faint and hard to see. There is no way to jump directly to any open tab, and the
context menu lacks directional close commands.

## Solution

Four improvements, matching VS Code / Cursor conventions:

### 1. Wheel scroll

Vertical wheel events over `.tabbar` are translated to horizontal scroll (deltaY →
scrollLeft delta). Passive listener — no `preventDefault`.

### 2. Visible scrollbar

The webkit scrollbar on `.tabbar` is made thin (3 px) but clearly visible using the
theme variables already in scope. Track uses `var(--border)`, thumb uses
`var(--text-faint)` with a hover state of `var(--text-dim)`. No hardcoded colours.

### 3. Active tab into view

Whenever `activeDocId` changes, the matching tab DOM node is scrolled into view
(`scrollIntoView({ block: 'nearest', inline: 'nearest' })`). Implemented with a
`useEffect` in `DocTabs` keyed on `activeId`.

### 4. Open-editors dropdown

A fixed button at the right edge of the tab strip (not scrolled away — kept outside
the scroll area via flex layout). Uses a chevron-down icon. Clicking it opens the
portal `ContextMenu` listing every open doc plus the terminal tab. Current doc is
marked with a check. Dirty docs show the dirty dot. Tooltip on each item = full
path. The menu has a `max-height` + `overflow-y: auto` so long lists scroll.

The trigger uses the `menuToggleIntent` pattern (src/menu-toggle.ts) and a
`triggerRef` passed to `ContextMenu`.

### 5. Close direction commands

The tab right-click context menu gains two new items:

- Close to the Right — closes every doc to the right of the anchor
- Close to the Left — closes every doc to the left of the anchor

Selection logic lives in `webview/tab-close-selection.ts` (pure, no React):

```typescript
type CloseMode = 'right' | 'left' | 'others' | 'all';
closeTabSelection(paths, anchor, mode): string[]
```

Each dirty doc in the set goes through the existing `closeDoc` flow (Save/Discard/
Cancel dialog). Clean docs close immediately.

### Acceptance criteria

- Wheel over tab strip scrolls horizontally.
- Scrollbar is visible (3 px, themed) in all themes.
- Activating a tab (click, palette, file open) scrolls the active tab into view.
- Dropdown button is always visible at strip right edge; lists all open tabs; click
  activates and scrolls into view; dirty dot visible; tooltip = full path.
- Right-click context menu has: Close, Close Others, Close to the Right, Close to
  the Left, Close All.
- `closeTabSelection` is unit-tested for all modes and edge cases.

## Edge cases

- Single tab open: Close to the Right/Left yield empty set (no-op).
- Anchor is the first tab: Close to the Left = empty.
- Anchor is the last tab: Close to the Right = empty.
- Dirty docs in selection: sequential confirm dialogs (v1 acceptable).

## Files touched

- `webview/tab-close-selection.ts` — new pure module
- `webview/components/doc-tabs.tsx` — scroll, dropdown, wheel
- `webview/app.tsx` — extend `onTabContextMenu`
- `webview/styles.css` — scrollbar styling + dropdown button
- `webview/icons.tsx` — `IconChevronDown` (already has IconChevron)
- `test/unit/tab-close-selection.test.ts` — new test file
