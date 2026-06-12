# L7: diff-controls — DiffViewer Controls Bar

## Goal

Add a control header bar to the Monaco diff viewer with:
1. **Side-by-side / inline toggle** — persistent boolean setting
2. **Previous / next change navigation** — with wrapping

## Behavior

### Setting: `diffSideBySide`
- Type: `boolean`
- Default: `true`
- Stored in: `src/settings.ts` + `coerceSettings` validation
- Persisted to: Electron userData `settings.json` (via webview provider pattern)
- Applied live: `diffEditor.updateOptions({ renderSideBySide })` when changed

### Navigation: Next / Previous Change
- **Source**: `diffEditor.getLineChanges()` — core Monaco API, available in bundled 0.55.1
- **Logic**: Pure `nextChange(lines, current) → target` function in `webview/diff-nav.ts`
- **Edges**: Empty list, before first, after last, exactly on a change, wrapping
- **Apply**: `revealLineInCenter(line)` + set cursor in MODIFIED editor
- **Buttons**: Two buttons in the control bar (no keyboard shortcuts; small scope)

### UI

**Control Bar** (above the diff editor):
- Matches existing toolbar/panel styling (webview/styles.css: `.viewer` element)
- Small header container with:
  - Toggle button (icon: side-by-side ↔ inline)
  - Prev/next buttons (chevrons, disabled if no changes)
  - Semantic HTML (`<button>` elements, `.iconbtn` class from top-bar pattern)

## Testing

Unit tests for `webview/diff-nav.ts`:
- `nextChange([], 5) → 5` (empty, no-op)
- `nextChange([10, 20, 30], 5) → 10` (before first, wrap to first)
- `nextChange([10, 20, 30], 15) → 20` (on/after a change, next)
- `nextChange([10, 20, 30], 35) → 10` (after last, wrap to first)
- `nextChange([10, 20, 30], 20) → 30` (exactly on a change, advance)

## Files

### New
- `webview/diff-nav.ts` — pure navigation logic + unit tests in `.test.ts`
- `webview/components/diff-controls-bar.tsx` — control bar UI

### Modified
- `src/settings.ts` — add `diffSideBySide: boolean` to AppSettings
- `webview/components/diff-viewer.tsx` — wrap with controls bar, pass state + handlers
- `webview/styles.css` — control bar styling (minimal, reuse existing token classes)

## Width override fix (r3/diff-fit-fix)

**Problem:** Monaco 0.55.1 defaults `useInlineViewWhenSpaceIsLimited` to `true`, which
silently overrides `renderSideBySide` when the editor is narrower than
`renderSideBySideInlineBreakpoint` (default 900 px). The toggle button still showed
"side-by-side selected" while Monaco rendered inline — a silent mismatch.

**Fix:** Both `createDiffEditor` and the live `updateOptions` call now explicitly set
`useInlineViewWhenSpaceIsLimited: false`. This means the toggle is always authoritative —
narrow side-by-side is cramped but never surprising.

**Option verified in:** `node_modules/monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditorOptions.js`
and `node_modules/monaco-editor/esm/vs/editor/editor.api.d.ts` (line 4015, `IDiffEditorBaseOptions`).

## Gates

- `npm run verify` (format + lint + typecheck + test + fallow + audit + security) — must pass
- `npm run build` — must exit 0
- All tests must pass (baseline 617 tests on main + new unit tests for diff-nav)

## Preview

Serve `out/index.html` over HTTP (not file://). Open a changed file, confirm:
- Header renders with toggle and nav buttons
- Toggle flips layout (side-by-side ↔ inline)
- Prev/next navigate to changes
- Setting persists across close/reopen
