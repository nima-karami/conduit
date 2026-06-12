# Spec — Top-bar view switcher (replace stacked overlays) (wishlist A1)

**Tier:** FULL · **Feature type:** UI / state refactor · **Slug:** `view-switcher`

## Problem frame

- **Job:** Move between the code editor, the Feature Board (Kanban), and the
  Architecture Canvas in the center pane the way you'd switch tabs — one at a time,
  never piled on top of each other.
- **Symptom:** Today the board and the canvas each render as a `position: fixed`
  overlay (`z-index: 40`) that covers the workbench. Their visibility is two
  independent booleans, `boardOpen` and `archOpen`, in `webview/app.tsx`. Because
  they're independent, opening the canvas **and** the board renders **both** overlays
  stacked — and each carries its own X/close button, so returning to the editor means
  closing twice (two X clicks).
- **Actor:** Anyone using Conduit who opens the board or the canvas.
- **Success:** A row of three buttons at the top — **Editor · Feature Board ·
  Architecture Canvas**. Clicking one switches the center view to it, fully replacing
  whatever was there; that button stays highlighted. Returning to code is the **Editor**
  button. Exactly one of the three is ever visible; stacking is structurally impossible.
- **Non-goals:** Rewriting either view's internals (board ops, canvas/React-Flow logic
  stay as-is); the `.conduit/` persistence north-stars (F0/G0); collapsing the Explorer
  (A3, which builds on this layout model); Markdown reflow (A2); any editor theming.

## Root cause (why it stacks)

`webview/app.tsx` holds two booleans:

```
const [boardOpen, setBoardOpen] = useState(false);
const [archOpen, setArchOpen] = useState(false);
```

rendered independently at the end of the shell:

```
{boardOpen && <BoardView onClose={() => setBoardOpen(false)} />}
{archOpen && <ArchitectureView … onClose={() => setArchOpen(false)} />}
```

Two booleans → four combinations, including `boardOpen && archOpen` → both overlays
mount at once and stack. Each view owns an X button wired to its own setter.

## The new model

Replace the two booleans with **one** mutually-exclusive state:

```
type CenterView = 'editor' | 'board' | 'canvas';
const [centerView, setCenterView] = useState<CenterView>('editor');
```

One value → exactly one view is active. Stacking is impossible by construction.

- **Top-bar switcher:** three segmented buttons (Editor / Feature Board / Architecture
  Canvas) in the top bar. Each calls `setCenterView(<id>)`. The button whose id equals
  `centerView` gets the active/highlighted class. Built from existing design tokens to
  match the toolbar (reuses the `iconbtn` / `--on` highlight vocabulary; rendered as a
  small segmented control with icon + label).
- **Render:** the workbench renders the board/canvas **in place of** the center region's
  normal content when `centerView !== 'editor'`. The board and canvas keep their existing
  full-bleed fixed-overlay CSS (they already fill the area under the 44px top bar); since
  only one mounts at a time, "overlay" and "tab" are now visually identical — no stacking
  is possible because only one is ever rendered.
- **Editor preservation:** the editor (`CenterPane` with its doc tabs) is **kept
  mounted** when switching to board/canvas — it's visually hidden, not unmounted — so doc
  tab state, scroll, and the active session terminal survive a round-trip. (Today the
  overlay sits *on top of* a still-mounted center pane, so this matches current behavior:
  switching away and back does not destroy editor/tab state.)

## Behavior & states

- **Editor active (default):** code editor / doc tabs / terminal visible; Editor button
  highlighted; board and canvas not rendered.
- **Feature Board active:** the board fills the center; Editor and Canvas not visible;
  Feature Board button highlighted. The editor stays mounted underneath (hidden).
- **Architecture Canvas active:** the canvas fills the center; clicking it from the board
  **replaces** the board (board unmounts, its button de-highlights); Canvas button
  highlighted.
- **Switch Board → Canvas → Editor:** each click swaps the single visible view; you never
  see two; the active highlight follows.
- **Keyboard shortcuts:** `openBoard` (Mod+Shift+B) sets `centerView='board'`;
  `openArchitecture` (Mod+Shift+A) sets `centerView='canvas'`. (Re-pressing the board
  shortcut while already on the board is a no-op set — acceptable; an optional toggle-back
  to editor is a possible enhancement, not required.) Add no new default shortcut for
  "Editor" beyond the button (Escape on board/canvas previously closed the overlay — see
  below).
- **Command palette:** "Open feature board" / "Open architecture canvas" set the view
  instead of flipping a boolean. Add an "Open editor" command for symmetry.
- **Escape:** previously, `useEscapeKey(onClose)` inside board/canvas returned to the
  editor by closing the overlay. Preserve that affordance: Escape on the board/canvas
  returns to the editor (`setCenterView('editor')`). This is a *navigation* side-effect,
  not cleanup — keep it.

## What happens to the X buttons

- **Remove the per-view X/close buttons** from `board-view.tsx` and `architecture-view.tsx`
  (the `IconClose` button in each head). Returning to the editor is now the Editor button
  (and Escape).
- **Side-effect audit of the old `onClose`:** the close handlers did nothing but flip the
  owning boolean (`setBoardOpen(false)` / `setArchOpen(false)`) — no save, no teardown.
  The board debounce-saves on every edit (`updateBoard`) and the canvas debounce-saves via
  `scheduleSave`; neither flushes on close, so dropping the X loses nothing. The only
  behavior to preserve is **"return to editor,"** which the Editor button + Escape provide.
  So `onClose` is repurposed to `setCenterView('editor')` and the X UI is deleted; Escape
  keeps calling it.

## Implementation outline

1. `webview/app.tsx`: drop `boardOpen`/`archOpen`; add `centerView` + `setCenterView`.
   Wire `actionMap.openBoard/openArchitecture`, palette commands, and TopBar props to set
   the view. Render board/canvas based on `centerView` (pass `onClose={() =>
   setCenterView('editor')}` so Escape still returns to editor).
2. `webview/components/top-bar.tsx`: replace the two single icon buttons in `topbar__right`
   with a 3-button segmented switcher (Editor/Board/Canvas) driven by `centerView` +
   `onSelectView`. Active button highlighted.
3. `webview/components/board-view.tsx` & `architecture-view.tsx`: delete the X close
   button markup (keep `useEscapeKey(onClose)` — it now returns to editor). Drop the now
   unused `IconClose` import if nothing else uses it.
4. `webview/styles.css`: add the segmented-switcher styles using existing tokens.
5. Pure logic, if any (e.g. a `nextCenterView` helper / shortcut→view mapping) → unit test
   in `test/unit/`.

## Edge cases & failure modes

- **`window.agentDeck` undefined (preview/browser):** the switcher is pure local state — no
  host call — so it works in preview. Board/canvas already guard their host posts via
  `bridge` (fake shell fallback); unaffected.
- **No active project / session:** Canvas takes `projectPath?`; board is project-agnostic.
  Switching to either with no session is allowed (matches today, where the overlay opened
  regardless). Seeded/empty states already handled by each view.
- **Re-press shortcut on the same view:** idempotent set; no flicker.
- **Layout docking (B1) / sidebar collapse:** the switcher is in the top bar, independent
  of dock order; unaffected.

## Acceptance criteria

- Single `centerView: 'editor' | 'board' | 'canvas'` state replaces `boardOpen`/`archOpen`;
  the two booleans no longer exist.
- Top bar shows three buttons; the active one is highlighted; clicking sets the view.
- At most one of editor/board/canvas is in the DOM-visible center at any time — never two
  stacked (verified at runtime by asserting `.board` and `.arch` are not both present).
- No `aria-label="Close board"` / `"Close architecture"` X button remains.
- Escape on board/canvas returns to the editor; editor doc-tab state survives a round trip.
- Command palette + shortcuts set the view (not a boolean overlay).
- `npm run verify` and `npm run build` both pass.

## Scope

- **MVP = v1:** the state migration + top-bar switcher + X removal + shortcut/palette/Escape
  wiring + switcher CSS.
- **Out of scope:** A3 (collapse Explorer), persistence north-stars, any view-internal
  redesign, a dedicated "Editor" keyboard shortcut, toggle-back-on-repeat behavior.

## Decisions Needed

- **[normal] Keep editor mounted vs. unmount when on board/canvas.** Chose **keep mounted**
  (hidden) to preserve doc-tab/terminal state across switches, matching today's overlay
  behavior. Reversible. Not a halt.
- **[low] Escape behavior.** Kept Escape = return to editor (was: close overlay). Natural
  carry-over; not a halt.
