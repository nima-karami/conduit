# Plan — collapse-explorer (A3)

## Visibility state model

Panel visibility is **layout state**, persisted in `AppSettings` alongside `layout` and
widths. Add two booleans:

- `sidebarCollapsed: boolean` (default `false`) — promote the existing in-memory
  `app.tsx` state into settings.
- `explorerCollapsed: boolean` (default `false`) — new.

Files:
- `src/settings.ts`: add both fields to `AppSettings`, `DEFAULT_SETTINGS`, and
  `restoreSettings` (via `bool(...)`). Add both to the `resetLayout()` field set in
  `webview/settings.tsx` so "Reset layout" restores everything visible.

## Pure, testable module: `webview/panel-visibility.ts`

No React/DOM dependency → unit-testable in node.

```ts
export type HideablePanel = 'sessions' | 'explorer';
export interface PanelVisibility { sidebarCollapsed: boolean; explorerCollapsed: boolean; }
export interface PanelToggleSpec {
  panel: HideablePanel;
  label: string;     // "Hide Explorer" | "Show Explorer" | "Collapse Sidebar" | ...
  visible: boolean;  // drives the IconCheck
}
```

- `HIDEABLE_PANELS: { panel; title }[]` — `Sessions`, `Explorer` (stable order).
- `isPanelVisible(v, panel)` — reads the right boolean.
- `buildPanelToggleItems(v): PanelToggleSpec[]` — context-menu specs (verb `Hide`/`Show`).
- `paletteCommandTitle(panel, visible)` — palette labels: Sidebar uses `Collapse`/`Expand`,
  Explorer uses `Hide`/`Show`.

The component (`app.tsx`) maps each spec to a `MenuItem` (binds the toggle setter + the
`IconCheck` when `visible`) and to a `PaletteEntry`.

## App wiring (`webview/app.tsx`)

- Drop `const [sidebarCollapsed, setSidebarCollapsed] = useState(false)`; read
  `settings.sidebarCollapsed` / `settings.explorerCollapsed`; toggles call `update({...})`.
- `toggleSidebar` / a new `toggleExplorer` helper flip the respective setting.
- `visibleOrder`: filter `sessions` when `sidebarCollapsed`, `explorer` when
  `explorerCollapsed`.
- Build `onPanelTogglesMenu(e)` → `setMenu({ x, y, items })` from `buildPanelToggleItems`.
- Wire right-click:
  - `PanelFrame`: add an optional `onBarContextMenu` (fires on the bar + body background,
    NOT on item rows — item menus call `stopPropagation`/`preventDefault` already and set
    their own menu, so a background handler on the panel root that ignores events already
    defaulted is the safe approach). Simplest: put `onContextMenu` on the `panel__bar`
    (chrome only) — file/change/session menus live in the body, never on the bar.
  - `TopBar`: add optional `onContextMenu` on the `<header>` background.
- Palette: replace the existing `cmd:toggleSidebar` title with the state-aware title;
  add `cmd:toggleExplorer`.
- Shortcut action map: keep `toggleSidebar`; add `toggleExplorer` (no default combo
  required — registered in the map so the palette/menu reuse one path).

## Center reflow

No new code: the center column is flex and already widens when a side region is filtered
out of `visibleOrder` (this is exactly how sidebar collapse reflows today). Hiding the
Explorer removes `explorer` from `visibleOrder` → center grows. Markdown reflow (A2) and
editor already fill the center.

## Tests (`test/unit/panel-visibility.test.ts`)

- `HIDEABLE_PANELS` = sessions, explorer, in order; each has a title.
- `isPanelVisible` reads the correct boolean for each panel and inverts the collapse flag.
- `buildPanelToggleItems`: two items; `visible` reflects state; label is `Hide` when
  visible / `Show` when hidden; order stable.
- `paletteCommandTitle`: Sidebar → Collapse/Expand; Explorer → Hide/Show, per state.

Extend `test/unit/settings.test.ts`: defaults for both flags are `false`; round-trip /
restore preserves a persisted `true`; malformed → default.

## Gates

`npm run verify` and `npm run build`, captured to
`.autoloop/evidence/collapse-explorer-verify.log` (verify) and the build tail.
Runtime: build webview, serve over HTTP, Playwright — hide/show Explorer, open the
panel-toggle menu (checks), toggle, palette commands, confirm file-item menus intact.
Evidence → `.autoloop/evidence/collapse-explorer-runtime.txt`.
</content>
