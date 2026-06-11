# Spec — Collapse/hide the Explorer; toggle panels via context menu + command (A3)

## Problem

The sidebar (Sessions panel) can already be collapsed from the top-bar button and a
keyboard shortcut, and its collapsed/expanded state widens or narrows the center pane.
The **Explorer** panel (the right-hand file-tree / changes panel) has **no** equivalent —
it cannot be hidden, so there is no way to reclaim its width for the center pane.

Once panels are hideable, the user needs ways to bring a hidden panel back. Today the
only affordances that toggle panel visibility are the top-bar sidebar button and the
`Toggle sidebar` command/shortcut. There is no discoverable, unified place to see what
is hidden and toggle it.

## Goal

1. Make the **Explorer** panel collapsible/hideable, mirroring the existing sidebar
   collapse: when hidden it is removed from the workbench and the **center pane reflows**
   into the freed space.
2. Add a **panel-toggle context menu** that opens on the panel background / panel header
   bar and the top bar, listing each hideable panel (Sessions, Explorer) with a **check**
   when visible; clicking an item toggles that panel's visibility.
3. Add **command-palette** entries — `Show Explorer` / `Hide Explorer` (one toggle command
   whose label reflects current state) and `Collapse Sidebar` / `Expand Sidebar`
   (the sidebar toggle, label reflects state) — wired to the same visibility state.

## Current behavior (baseline)

- `webview/app.tsx` holds `sidebarCollapsed` (local `useState(false)`). The top-bar
  button and the `toggleSidebar` shortcut/command flip it.
- `visibleOrder` = `parseLayout(settings.layout)` with `sessions` filtered out when
  `sidebarCollapsed`. The center column is flex; removing a side panel reflows the center
  automatically (this is how the sidebar collapse already widens the center).
- The Explorer is the `explorer` region, always rendered.
- Panel order + widths persist in `settings.layout` / `leftWidth` / `rightWidth`.
  `sidebarCollapsed` is **not** persisted (resets to expanded on reload).

## Desired behavior

### Explorer visibility

- Introduce `explorerCollapsed` analogous to `sidebarCollapsed`.
- `visibleOrder` filters out `explorer` when `explorerCollapsed`, exactly as it filters
  `sessions` when `sidebarCollapsed`. The center pane reflows to fill the space (no code
  beyond the filter is needed — center is already flex).
- **Persistence:** both `sidebarCollapsed` and `explorerCollapsed` are promoted to
  **persisted layout settings** (`AppSettings`), so a hidden panel stays hidden across
  reloads — panel visibility is layout state and belongs with `layout`/widths. Defaults:
  both `false` (everything visible). `resetLayout()` restores both to visible.

### Panel-toggle context menu

- A single shared builder produces the menu items from `{ sidebarCollapsed,
  explorerCollapsed }`: one item per hideable panel (`Sessions`, `Explorer`), each
  labelled `Hide <panel>` when visible and `Show <panel>` when hidden, with an
  `IconCheck` shown **only when the panel is visible** (the check = "this panel is on").
- Opens on **right-click of**:
  - the **panel background / header bar** of either side panel (the `panel__bar` and the
    panel body background), and
  - the **top bar** background.
- Must **not** hijack existing right-click menus on file-tree items, change rows, session
  cards, or editor tabs — those keep their own menus. The panel-toggle menu binds to the
  panel chrome (bar + empty body background) and the top bar, where no item menu exists.
- Left-button drag on `panel__bar` (B1 re-dock drag) is unaffected — `contextmenu`
  fires on right-click only.

### Command palette

- `Toggle Explorer` command: title `Hide Explorer` when visible, `Show Explorer` when
  hidden; runs the explorer toggle.
- `Toggle Sidebar` command: retitle the existing `Toggle sidebar` to reflect state —
  `Collapse Sidebar` when expanded, `Expand Sidebar` when collapsed; runs the sidebar
  toggle. (Keeps a single sidebar command; no duplicate.)

## Edge cases

- Both panels hidden → only the center pane shows, full width. Allowed.
- A hidden panel persists across reload; the context menu / palette / top-bar buttons are
  the way back. The Explorer has no dedicated top-bar button today; the context menu and
  the palette command are its primary re-show affordances (acceptable — matches the spec
  "right-click anywhere on the Explorer or the top menu" + command palette).
- Drag-to-reorder a panel that is hidden: not possible (it isn't rendered); ordering is
  preserved in `settings.layout` and reappears in place when re-shown.
- `window.agentDeck` absent (browser preview): visibility still works (it is renderer
  state persisted through the settings channel; the mock bridge ignores the persist post).

## Acceptance criteria

- [ ] Explorer can be hidden; when hidden it disappears and the center reflows wider.
- [ ] Explorer can be shown again, returning to its previous position/width.
- [ ] Right-clicking the Explorer/Sessions panel chrome or the top bar opens the
      app-styled `ContextMenu` with `Sessions` and `Explorer` toggles; a check marks each
      **visible** panel; clicking toggles it.
- [ ] Existing right-click menus on file-tree items, change rows, session cards, and
      editor tabs are unchanged.
- [ ] Command palette lists a sidebar toggle (label reflects state) and an Explorer
      toggle (label reflects state); both work.
- [ ] Visibility persists across reload (settings).
- [ ] `npm run verify` and `npm run build` both green; runtime verified via Playwright.
</content>
</invoke>
