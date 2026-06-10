# Overnight Features Plan (Agent Deck)

> Autonomous overnight build. Branch: `overnight-features`. Build sequentially,
> commit each phase after `npm run typecheck && npm run build && npm run test:unit`
> all pass. Keep on branch (do NOT merge to main / push). Verify visually via
> preview-server + playwright-cli screenshots when feasible.

## Status legend: [ ] todo  [~] in progress  [x] done

## Phase 0 — housekeeping  [x]
- [x] branch `overnight-features`
- [x] gitignore `designs/`
- [x] commit pending tab-restyle

## Phase 1 — Settings foundation  [x]
- `src/settings.ts`: `AppSettings` + `DEFAULT_SETTINGS` + `serializeSettings`/`restoreSettings` (merge w/ defaults).
  - Fields: `theme` (string id), `fontUi` (id), `fontMono` (id), `density` ('comfortable'|'compact'),
    `sessionCard` ('comfortable'|'compact'|'detailed'), `background` ('none'|'aurora'|'mesh'|'grid'),
    `leftWidth` (number px), `rightWidth` (number px).
- Host `electron/main.ts`: `settingsFile()`; load on boot; include `settings` in `state` msg;
  handle `updateSettings`; persist to `settings.json`.
- `src/protocol.ts`: add `settings: AppSettings` to `state` msg; add `{type:'updateSettings'; settings}` to WebviewToHost.
- Renderer `webview/settings.tsx`: `SettingsProvider` + `useSettings()`. Applies to
  `document.documentElement.dataset` (theme/fontUi/fontMono/density/background) and persists (debounced post).
- `webview/themes.ts`: theme + font registries (id → label) for the picker.
- CSS `webview/styles.css`: `:root[data-theme="..."]` var overrides; `[data-font-ui="..."]`,
  `[data-font-mono="..."]`; `[data-density="compact"]` overrides.
- Tests: `test/unit/settings.test.ts` (restore merges defaults, unknown keys dropped).

## Phase 2 — Settings modal + Appearance + wire entry  [x]
- `webview/components/SettingsModal.tsx`: tabs General | Appearance | Shortcuts.
  - Appearance: theme swatches, UI font select, mono font select, density toggle,
    session-card style (radio), animated background select.
- `Sidebar.tsx`: replace non-functional cust buttons — add a **Settings** (gear) button in a
  sidebar footer that opens modal. Make cust items non-actionable (display only) or open settings.
- `icons.tsx`: add `IconSettings` (gear), `IconCommand`, `IconExternal`, `IconCopy`, `IconDuplicate`.
- App.tsx: `settingsOpen` state + render modal.

## Phase 3 — Command palette  [x]
- Host: `searchFiles {path, query}` IPC → recursive walk (skip node_modules/.git/out/dist/.cursor),
  cap ~2000, return rel paths; `{type:'searchResults'; query; results}` msg. New `src/fileSearch.ts` (+test).
- `webview/components/CommandPalette.tsx`: overlay; modes — files (Ctrl+P, active session project),
  commands (Ctrl+Shift+P), sessions (`>`-less, type to filter sessions). Fuzzy filter `src/fuzzy.ts` (+test).
  Keyboard: arrows, enter, esc. Opens files into doc tabs; selecting session switches active.
- App.tsx: global keydown (Ctrl+P / Ctrl+Shift+P) → open palette in mode.

## Phase 4 — Context menus  [x]
- `webview/components/ContextMenu.tsx` + `useContextMenu` hook (position, dismiss on outside/esc).
- Session card: Reveal in Explorer, Duplicate, Copy path, Rename, Close.
- Doc tab: Close, Close others, Copy path, Reveal in Explorer.
- Host IPC: `revealInExplorer {path}` (shell.showItemInFolder), `duplicateSession {id}`.

## Phase 5 — Session card variants  [x]
- SessionItem renders per `settings.sessionCard`. CSS for each.

## Phase 6 — Shortcuts viewer  [x] (shipped in Phase 2)
- `src/shortcuts.ts` registry (id, keys, description). Settings → Shortcuts lists them. Read-only (rebind = stretch).

## Phase 7 — Animated background  [ ]
- `webview/components/AnimatedBg.tsx` (CSS-driven aurora/mesh/grid), gated by `settings.background`.
  Mount behind `.shell`. Respect prefers-reduced-motion.

## Phase 8 — Resizable panels  [ ]
- Shell grid columns from `--left-w`/`--right-w` CSS vars (seeded from settings). Drag handles
  on the two seams; persist widths (debounced). Docking/rearranging = STRETCH (defer if time).

## Notes / decisions
- Direct implementation in main thread (token-efficient vs subagents; user flagged token burn).
- Themes: ship ~5 (midnight default, slate, nord-ish, light-paper, high-contrast).
- Fonts UI: Hanken Grotesk (default), Inter-free alt, IBM Plex Sans; Mono: JetBrains Mono (default), Fira Code, IBM Plex Mono.
