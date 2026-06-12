# Plan — Top-bar view switcher (wishlist A1)

Spec: `docs/specs/view-switcher.md`. Structural change: migrate two independent
overlay booleans → one mutually-exclusive `centerView` state, add a top-bar switcher,
remove per-view X buttons. Routing/shell refactor — view internals untouched.

## Design decisions (locked)

- **One state:** `type CenterView = 'editor' | 'board' | 'canvas'` in `app.tsx`,
  replacing `boardOpen` + `archOpen`.
- **Mounting strategy:** keep board/canvas rendered at the **shell level** (where they
  are today), but gate on `centerView === 'board' | 'canvas'` instead of two booleans.
  Because only one can be truthy, only one ever mounts — stacking impossible. The editor
  (`CenterPane`) stays mounted underneath the whole time, preserving doc-tab/terminal
  state. The board/canvas keep their existing `position: fixed` full-bleed CSS (they sit
  under the 44px top bar and cover the workbench). Minimal diff, max state preservation.
- **`onClose` repurposed:** both views still call `useEscapeKey(onClose)`; `onClose` now
  is `() => setCenterView('editor')`. The visible X button markup is deleted.

## Pure logic to extract + test

There is one small testable pure piece worth isolating: mapping a shortcut/command
action to the next `centerView`, and an `escapeCenterView` (always → 'editor'). Add a
tiny `webview/center-view.ts` exporting `CenterView`, the `CENTER_VIEWS` list (for the
switcher), and a `nextCenterViewForAction(actionId)` helper used by both the shortcut
map and palette. Unit-test the mapping + the escape-returns-to-editor invariant in
`test/unit/center-view.test.ts`. (The React state itself is trivial; test what's pure.)

## Steps

1. **`webview/center-view.ts` (new):** `export type CenterView`; `CENTER_VIEWS` =
   ordered `[{id,label}]` for editor/board/canvas; `centerViewForAction(id)` mapping
   `'openBoard'→'board'`, `'openArchitecture'→'canvas'`, `'openEditor'→'editor'`.
2. **`test/unit/center-view.test.ts` (new, TDD):** assert the action→view mapping and
   that the switcher list is exactly the three views in order. Run red→green.
3. **`webview/app.tsx`:**
   - Replace `boardOpen/archOpen` state with `const [centerView, setCenterView] =
     useState<CenterView>('editor')`.
   - `actionMap.openBoard = () => setCenterView('board')`,
     `openArchitecture = () => setCenterView('canvas')`.
   - Palette: `cmd:board`/`cmd:arch` run `setCenterView(...)`; add `cmd:editor`
     "Open editor" → `setCenterView('editor')`.
   - TopBar: pass `centerView` + `onSelectView={setCenterView}` (replace
     `onOpenBoard`/`onOpenArchitecture`).
   - Render: `{centerView === 'board' && <BoardView onClose={() =>
     setCenterView('editor')} />}` and likewise canvas. Editor stays in the workbench
     map, always mounted.
4. **`webview/components/top-bar.tsx`:** replace the two icon buttons in `topbar__right`
   with a segmented `.viewswitch` of three buttons (icon + label) driven by `centerView`;
   active one gets `--on`/active class. Props: `centerView: CenterView`, `onSelectView:
   (v: CenterView) => void`. Keep window controls (winctl) as-is.
5. **`board-view.tsx` / `architecture-view.tsx`:** delete the `IconClose` X button in the
   head; keep `useEscapeKey(onClose)`. Remove now-unused `IconClose` import if orphaned.
6. **`webview/styles.css`:** add `.viewswitch` segmented-control styles (tokens only).
7. **Gates:** `npm run verify` + `npm run build` → tee to
   `.autoloop/evidence/view-switcher-verify.log`.
8. **Runtime (Playwright over HTTP):** build webview, serve, click each switcher button;
   assert exactly one of editor/`.board`/`.arch` visible, active highlight follows, no
   `aria-label="Close board"/"Close architecture"` present, board→canvas replaces (not
   stacks). Screenshots → `%TEMP%\claude-scratch\`. Notes →
   `.autoloop/evidence/view-switcher-runtime.txt`.
9. **Review:** `superpowers:requesting-code-review`, address blocking, then
   `superpowers:verification-before-completion`.

## Risks / watch-outs

- **Orphaned imports/props** after deleting X and renaming TopBar props — typecheck (both
  tsconfigs) catches these; run `npm run verify`.
- **Don't unmount the editor** — keep `CenterPane` in the workbench map so tab/terminal
  state survives. Board/canvas mount alongside, not in place of it.
- **A3 follow-up (collapse Explorer)** builds on this layout/visibility model — keep the
  view state name (`centerView`) and switcher discoverable; note it in the report.
- Biome style: single quotes, semicolons, 2-space, width 100, kebab-case files.
