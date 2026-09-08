# Overlay layers — implementation plan

**Spec:** `docs/specs/archive/2026-09-07-overlay-layers.md`  **Tier:** FULL

## Goal

Every modal and every anchored popup renders under `document.body` through two primitives that share
one overlay stack (Escape to the top entry only, modals above earlier modals, menus dismissed when a
modal mounts), the two bespoke dropdowns and Monaco's widgets escape their panes, the three native
selects become `SelectField`, and the Review header stays operable at the window's minimum width.

## Architecture

Renderer-only; no protocol change. (1) A pure ordering module `src/overlay-stack.ts` decides depth,
top entry and which popovers a new modal displaces — unit-tested in node. (2) A module-singleton
store `webview/overlay-store.ts` (the `review-nav-store.ts` publish/subscribe/get shape) holds the
live stack plus each entry's `onDismiss`, and owns the app's single Escape listener (window,
capture). (3) Two components consume it through one hook `webview/use-overlay-entry.ts`:
`webview/components/modal-layer.tsx` (portal + stacked z) and `webview/components/popover.tsx`
(portal + anchor/clamp + dismiss listeners). `ContextMenu` keeps its props and becomes a `Popover`
consumer — its portal, clamp and dismiss code **moves** into `Popover`; nothing is duplicated. (4)
`src/menu-position.ts` grows `anchorPopover` (start/end × below/above); `anchorMenuToRect` becomes
the end/below case of it, so the six existing callers are untouched.

## Data flow

```
dialog owner (app.tsx · review-view · right-pane · architecture-view · center-pane · mermaid-diagram)
  └─ <ModalLayer onDismiss backdropClass>
       ├─ useOverlayEntry('modal', onDismiss) ──register──► overlay-store ──► src/overlay-stack (pure)
       │      ◄── { depth } via useSyncExternalStore     │ 0→1 entries: add window keydown (capture)
       └─ createPortal(document.body)                            │ Escape → top.onDismiss(); stopPropagation
            <div class={backdropClass} style="z-index: calc(var(--layer-modal) + depth)">  │ push modal → dismiss every popover
                 {children — the dialog box, unchanged}                                    │ 1→0 entries: remove listener

trigger (ContextMenu callers · SelectField · RefCombobox input · TypeChip button)
  └─ <Popover at|anchor width align side onClose triggerRef className role …>
       ├─ useOverlayEntry('popover', onClose)
       ├─ useLayoutEffect: measure → anchorPopover / at → clampMenuPosition → {left, top}
       ├─ mousedown(capture, outside & not triggerRef) · scroll(capture, outside) · blur · resize → onClose
       └─ createPortal(document.body) <div class="popover {className}" style="left top min-width">{children}</div>

ContextMenu = <Popover at={{x,y}} | anchor …  className="ctxmenu" role="menu" aria-activedescendant> + items + arrow/Enter nav
Monaco: code-viewer / diff-viewer create(..., { overflowWidgetsDomNode: monacoOverflowHost(), fixedOverflowWidgets: true })
```

## Settled decisions — do not re-litigate

- Portal to `document.body` is the mechanism; no z-index escalation, no `!important`, no per-pane
  overflow overrides, the panel blur stays.
- One stack for modals **and** popovers; Escape goes to the top entry only, capture-phase, stopped.
- Pushing a modal dismisses every open popover (audit N7).
- Layer tokens `--layer-modal: 60` (band 60–79), `--layer-popover: 80`, `--layer-toast: 200`,
  `--layer-theatre: 300`; modal depth clamped to 19.
- Backdrop class is always applied by `ModalLayer` (`backdropClass`, default `modal__backdrop`);
  the palette passes `modal__backdrop palette__backdrop`, the mermaid viewer `mermaid-zoom__backdrop`.
- Popover frame always carries class `popover` (the `no-drag` hook) plus the caller's class.
- Scrim click that also closes a popover dismisses both (existing behaviour, kept).
- `fixedOverflowWidgets: true` **together with** a body-level `overflowWidgetsDomNode` (either alone
  is wrong here); built only if the baseline probe (T3.3 step 1) shows a clipped widget.
- Type picker gains outside-click dismiss (accepted behaviour change).
- Review header ≤ 480px: scope segment + `.review__stats` hidden, source label floor 72px, three
  checkable scope rows in the `…` menu as a **separator-delimited group** (no new `MenuItem`
  heading field — the spec's "Scope group" is expressed with the existing `separatorBefore`).
- `useEscapeKey` stays for the board's pane-local overlays, the git-history detail and the review
  find bar; no overlay on the stack uses it.

## Global constraints

- Gate: `npm run verify` (biome · typecheck both tsconfigs · build · vitest · fallow · audit · scans);
  exit code captured directly. Smoke: `node test/e2e/run-smoke.mjs <name>`, one scenario at a time.
- Pure logic in `src/`, renderer stores in `webview/<name>-store.ts`, hooks in `webview/use-<name>.ts`,
  components in `webview/components/<kebab>.tsx`, unit tests `test/unit/<name>.test.ts`
  (`// @vitest-environment jsdom` pragma per file that needs a DOM; `createRoot` + `act`, no
  testing-library), e2e `test/e2e/<name>.e2e.mjs` on `test/e2e/harness.mjs`.
- Comments say *why* only; link a spec/plan section instead of restating it. No `as any`, no
  `@ts-ignore`, no `!important`, no specificity escalation. Biome-clean; `useExhaustiveDependencies`
  suppressions carry a reason. fallow fails on unused exports and circular imports.
- Never kill processes by image name; never run the full gate under concurrent load; Playwright
  screenshots only to absolute scratch paths.
- React is **19** (`package.json`): `ref` is an ordinary prop, no `forwardRef`. StrictMode is off.
- `vitest.config.ts` includes `test/unit/**/*.test.ts` only: component tests are `.ts` files using
  `createElement`, as `test/unit/new-session-modal.test.ts` does.
- **Never append to the end of `webview/styles.css`**: `test/unit/state-vocabulary.test.ts` asserts the
  sheet ends with its vocabulary section (`:11451–11733`). Every insertion point named below is above it.
- e2e viewport changes use `page.setViewportSize({ width, height })` (`commit-detail-resize.e2e.mjs:75`).

## Out of scope

`BranchSwitcherMenu` / `CommitPickerMenu` / `RepoPickerMenu` internals (they stay on their own
portal), a focus trap in `ModalLayer`, any dialog's content or styling, the board's overlays, the
markdown TOC / find bars / review `?` help, i18n.

## Contracts

```ts
// src/overlay-stack.ts (pure, node-tested)
export type OverlayKind = 'modal' | 'popover';
export interface OverlayEntry { id: number; kind: OverlayKind }
export const MODAL_DEPTH_MAX = 19;
/** Appends; when `entry.kind === 'modal'` every popover already on the stack is returned in
 *  `dismissed` (and removed from the returned stack). */
export function pushOverlay(stack: readonly OverlayEntry[], entry: OverlayEntry): { stack: OverlayEntry[]; dismissed: number[] };
export function removeOverlay(stack: readonly OverlayEntry[], id: number): OverlayEntry[];
export function topOverlay(stack: readonly OverlayEntry[]): OverlayEntry | undefined;
/** Index among modal entries only, clamped to MODAL_DEPTH_MAX; -1 when absent. */
export function modalDepth(stack: readonly OverlayEntry[], id: number): number;

// src/menu-position.ts (additions; existing exports unchanged)
export type PopoverAlign = 'start' | 'end';   // which edges line up: start = left/left, end = right/right
export type PopoverSide = 'below' | 'above';
export function anchorPopover(rect: Rect, menu: Size, opts: { align: PopoverAlign; side: PopoverSide; gap: number }): Point;
// anchorMenuToRect(rect, menuWidth, gap = 4) === anchorPopover(rect, { width: menuWidth, height: 0 }, { align: 'end', side: 'below', gap })
// 'above' ⇒ y = rect.top - gap - menu.height

// webview/overlay-store.ts (singleton)
export function nextOverlayId(): number;                                             // monotonic; allocated in render (useState initialiser)
export function registerOverlay(id: number, kind: OverlayKind, onDismiss: () => void): void;  // installs the window listener on 0→1
export function unregisterOverlay(id: number): void;                                 // removes the listener on 1→0
export function subscribeOverlays(cb: () => void): () => void;
export function getOverlays(): readonly OverlayEntry[];                              // same array reference until the next change
// Escape handler: window 'keydown' capture; if e.key === 'Escape' && top exists → e.stopPropagation(); e.preventDefault(); dismissOf(top)()
// registerOverlay of a modal: commit the new stack FIRST, then snapshot the dismissed ids' callbacks and invoke
// each synchronously (a callback may register/unregister; a throwing one must not leave the push half-applied).
// Synchronous on purpose — deferring would paint the modal one frame under the menu (audit N7).

// webview/use-overlay-entry.ts
export function useOverlayEntry(kind: OverlayKind, onDismiss?: () => void): { depth: number };
// id = useState(nextOverlayId)[0]; registers in useLayoutEffect on mount, unregisters on unmount; the registered thunk
// reads the latest onDismiss from a ref; a missing onDismiss absorbs Escape. depth = modalDepth(useSyncExternalStore(
// subscribeOverlays, getOverlays), id) — getSnapshot returns the store array itself (a per-call object would loop).
// useSyncExternalStore subscribes in a passive effect, so the first paint can read -1 → the caller clamps to 0;
// portal DOM order already stacks correctly and the inline z catches up on the passive re-render.

// webview/components/modal-layer.tsx
export interface ModalLayerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  onDismiss?: () => void;          // scrim click (e.target === e.currentTarget) + Escape when top
  backdropClass?: string;          // default 'modal__backdrop'
  children: ReactNode;
}
export function ModalLayer(props: ModalLayerProps): ReactPortal;
// renders <div className={backdropClass} style={{ zIndex: `calc(var(--layer-modal) + ${Math.max(depth, 0)})` }} onClick … {...rest}>

// webview/components/popover.tsx
export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  at?: Point;                      // exactly one of at | anchor
  anchor?: Rect;
  width?: number;                  // anchor mode: alignment width; also applied as min-width (a caller wanting an exact width passes style={{ width }})
  align?: PopoverAlign;            // default 'end'
  side?: PopoverSide;              // default 'below' — a PREFERENCE, no flip: a box that does not fit is pinned to the viewport margin and may overlap its anchor
  gap?: number;                    // default 4
  onClose: () => void;             // idempotent; from outside-mousedown / outside-scroll / blur / resize / Escape (stack)
  triggerRef?: RefObject<Element | null>;
  ref?: Ref<HTMLDivElement>;       // React 19: ref is a prop; merged with the internal measuring ref via one callback ref
  children: ReactNode;
}
export function Popover(props: PopoverProps): ReactPortal;
// frame: <div ref={mergedRef} className={`popover${className ? ' ' + className : ''}`} style={{ left, top, minWidth: width, ...style }} {...rest}>
// position: useLayoutEffect with deps [at?.x, at?.y, anchor, width, align, side, gap] PLUS a ResizeObserver on the frame
//           (re-run when the content's size changes: loading → list, font swap). The effect reads the frame's WIDTH and
//           HEIGHT only — never its left/top — so setPos(prev => same x/y ? prev : next) converges.
//           requested = at ?? anchorPopover(anchor, {width: width ?? r.width, height: r.height}, {align, side, gap});
//           pos = clampMenuPosition(requested, {r.width, r.height}, {innerWidth, innerHeight}).
// Docstring notes that the board's pane-local `.queuepopover` is deliberately NOT a Popover.

// webview/components/context-menu.tsx (props unchanged; MenuState grows two optional fields)
export interface MenuState { x: number; y: number; items: MenuItem[]; keyboard?: boolean; anchor?: Rect; side?: PopoverSide }
// anchor present ⇒ <Popover anchor={anchor} width={minWidth ?? MENU_MIN_W} align="end" side={side}>; else <Popover at={{x, y}}>

// webview/monaco-overflow-host.ts  (created ONLY if T3.3's probe reproduces the clip — fallow fails on an unimported file)
export function monacoOverflowHost(): HTMLElement;  // lazily creates <div class="monaco-editor monaco-overflow-host"> appended to document.body, once.
// `monaco-editor` on the host is mandatory: Monaco emits its theme as `.monaco-editor { --vscode-*: … }` (re-emitted on every
// theme change, so no theme class is copied), and typing-guard.ts isEditorEntry keys shortcut routing on that class.

// webview/use-element-width.ts
export function useElementWidth(ref: RefObject<HTMLElement | null>): number;  // ResizeObserver, contentRect.width; Number.POSITIVE_INFINITY before the first observe
```

Invariants: a `Popover` is always above every `ModalLayer` (`--layer-popover` 80 > 60 + 19); the
store never holds an id twice; `getOverlays()` returns the same array reference until a change.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Overlay registration / depth / top | `ModalLayer`, `Popover` via `useOverlayEntry` | `overlay-store` → `src/overlay-stack` | both |
| Escape keydown | window | today: 9 dialog handlers + `ContextMenu`'s `useEscapeKey`; after: the store only | both — every migrated handler removed in its task |
| Popover displacement on modal mount | `pushOverlay` (`dismissed`) | each popover's `onClose` | both |
| Anchor rect | trigger element | `Popover` (`anchorPopover`) | both |
| Modal z-order | `ModalLayer` inline z from `modalDepth` | stylesheet `--layer-*` tokens | both |
| Combobox listbox membership | `.cmp-combo` wrapper `aria-owns` (while open) | AT | both |
| Review scope | segment (`review-source-control.tsx:30`) **and** new `…` rows in `review-view.tsx` → `onSetSource` | review source state (unchanged) | producer side only; the consumer is the existing `onSetSource` prop `ReviewView` already receives and passes to `ReviewSourceControl` — measured at `review-view.tsx:1695–1773` |
| Monaco overflow widgets | Monaco (both creates) | body-level host node | both |
| `.resizer` / `.shell > .sidebar/.center/.right` rules | none (dead; grep in the code map) | `test/unit/state-vocabulary.test.ts:88–91` lists `.resizer` | both — the two `.resizer` entries in that test are removed with the rules (dead selector, not a behaviour) |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/overlay-stack.ts` | create | pure stack ordering (`pushOverlay`, `removeOverlay`, `topOverlay`, `modalDepth`) |
| `src/menu-position.ts` | modify | add `anchorPopover`, `PopoverAlign`, `PopoverSide`; `anchorMenuToRect` delegates to it |
| `webview/overlay-store.ts` | create | live stack + dismiss callbacks + the single Escape listener |
| `webview/use-overlay-entry.ts` | create | hook registering a component on the stack |
| `webview/components/popover.tsx` | create | portaled anchored frame with clamp + dismiss listeners |
| `webview/components/modal-layer.tsx` | create | portaled backdrop with stacked z |
| `webview/components/context-menu.tsx` | modify | rebuild on `Popover`; `MenuState.anchor/side` |
| `webview/components/confirm-dialog.tsx` | modify | `ModalLayer`; Escape branch removed; `aria-modal` |
| `webview/components/conflict-dialog.tsx` | modify | `ModalLayer`; Escape listener removed |
| `webview/components/new-session-modal.tsx` | modify | `ModalLayer`; Escape listener removed |
| `webview/components/web-prompt-modal.tsx` | modify | `ModalLayer`; `useEscapeKey` removed |
| `webview/components/icon-picker-modal.tsx` | modify | same |
| `webview/components/settings-modal.tsx` | modify | same; the shortcut recorder registers as a `popover` entry while recording and drops its own Escape branch |
| `webview/components/command-palette.tsx` | modify | `ModalLayer backdropClass="modal__backdrop palette__backdrop"`; `useEscapeKey` and the `onKeyDown` Escape branch removed |
| `webview/components/compare-dialog.tsx` | modify | `ModalLayer`; root `onKeyDown` Escape branch removed; `RefCombobox` list on `Popover`; `aria-owns` |
| `webview/components/timed-message-dialog.tsx` | modify | `ModalLayer onDismiss={requestClose}`; root Escape branch removed; two `SelectField`s |
| `webview/components/mermaid-zoom-overlay.tsx` | modify | `ModalLayer backdropClass="mermaid-zoom__backdrop"`; Escape branch removed |
| `webview/components/architecture-view.tsx` | modify | `TypePicker` on `Popover` (anchor from the chip); Kind `SelectField`; the `.palette, .modal__backdrop, .ctxmenu` DOM-presence guard at `:1444` deleted |
| `webview/monaco-overflow-host.ts` | create (conditional on T3.3's probe) | lazy body-level host node for Monaco overflow widgets |
| `webview/components/code-viewer.tsx` | modify | pass `overflowWidgetsDomNode` + `fixedOverflowWidgets` |
| `webview/components/diff-viewer.tsx` | modify | same |
| `webview/use-element-width.ts` | create | ResizeObserver width hook |
| `webview/components/review-view.tsx` | modify | compact header state, scope rows in `…`, handoff label span, bar menu `anchor/side: 'above'`; the `if (confirmRef.current) return` guard at `:406` deleted (the stack owns Escape) |
| `webview/styles.css` | modify | `--layer-*` tokens; `.popover`; `.ctxmenu`/`.cmp-combo__menu`/`.typepicker` lose positioning; `.typechip__wrap` relative removed; `.mermaid-zoom__backdrop` z removed; `no-drag` list; `.monaco-overflow-host`; review container queries; dead `.shell > …` arms, `.resizer*`, `.modal__select` deleted |
| `test/unit/overlay-stack.test.ts` | create | pure ordering |
| `test/unit/menu-position.test.ts` | modify | `anchorPopover` cases |
| `test/unit/overlay-store.test.ts` | create | Escape routing, listener lifecycle, popover displacement (jsdom) |
| `test/unit/modal-layer.test.ts` | create | portal parent, stacked z strings, scrim click (jsdom) |
| `test/unit/popover.test.ts` | create | portal parent + class, dismiss listeners, triggerRef exemption (jsdom) |
| `test/unit/overlay-sites.test.ts` | create | static guard: no JSX `className="modal__backdrop`, no Escape handling, in the migrated files |
| `test/unit/drag-region.test.ts` | modify | `OVERLAY_ROOTS` gains `.popover` and `.monaco-overflow-host` and keeps `.ctxmenu` (the three wrapper menus carry that class without `.popover`) |
| `test/unit/new-session-modal.test.ts` | modify | queries move from the mount host to `document.body` — the dialog is portaled now |
| `test/e2e/review-compare.e2e.mjs` | modify | the `pick` helper selects the ref list at its portaled location instead of under the dialog |
| `test/unit/state-vocabulary.test.ts` | modify | drop the one `.resizer` `HOVER_FILL_ALLOW` key at `:90` (dead selector; `:88`, `:89`, `:91` stay) |
| `test/e2e/overlay-modals.e2e.mjs` | create | findings 1, 3, 5, 6, 7 + menu displacement |
| `test/e2e/overlay-popovers.e2e.mjs` | create | findings 2, 4 |
| `test/e2e/review-compact-header.e2e.mjs` | create | F1 + bar menu above |
| `CHANGELOG.md` | modify | `[Unreleased]` Fixed / Changed |
| `docs/specs/2026-09-07-overlay-layers.md` → `docs/specs/archive/` | move (`git mv`) | on ship; `docs/specs/INDEX.md` row moves to Archived |

## Scripts

None. The three new e2e scenarios are the repeated driving; run red at the base commit (that run is
the AC-0 baseline evidence, saved to the run's evidence dir) and green after.

## Slices

### Slice 1: Primitives

**Check:** `npx vitest run test/unit/overlay-stack.test.ts test/unit/menu-position.test.ts test/unit/overlay-store.test.ts test/unit/popover.test.ts test/unit/modal-layer.test.ts test/unit/drag-region.test.ts` green, then `node test/e2e/run-smoke.mjs context-menu-order` and `node test/e2e/run-smoke.mjs git-ref-dropdown` exit 0 (ContextMenu on `Popover` still opens, clamps, dismisses, and `SelectField` still works inside Settings).

**Parallel groups:** G1: T1.1 · G2: T1.2 · Serial: T1.3, T1.4, T1.5, T1.6
**Claims (serial lane):** `webview/styles.css`

#### Task 1.1: pure overlay stack

**Files:** Create `src/overlay-stack.ts`; Test `test/unit/overlay-stack.test.ts`
**Interfaces:** Produces the `src/overlay-stack.ts` contract above, byte for byte.
**Steps:**
- [ ] Failing tests: 'pushing a modal returns the ids of every popover below it and removes them' (`pushOverlay([{1,popover},{2,modal},{3,popover}], {4,modal})` → `dismissed == [1,3]`, stack kinds `[modal, modal]`); 'pushing a popover displaces nothing'; 'modalDepth counts modals only' (`[{1,modal},{2,popover},{3,modal}]` → `modalDepth(3) == 1`); 'modalDepth clamps at MODAL_DEPTH_MAX'; 'removeOverlay re-derives depth' (remove the first of three modals → the last's depth becomes 1); 'topOverlay is the last entry; undefined when empty'.
- [ ] Run `npx vitest run test/unit/overlay-stack.test.ts` — FAIL (module missing), then implement; re-run green.

#### Task 1.2: `anchorPopover`

**Files:** Modify `src/menu-position.ts`; Test `test/unit/menu-position.test.ts`
**Interfaces:** Produces `anchorPopover`, `PopoverAlign`, `PopoverSide`; `anchorMenuToRect` unchanged in signature and results.
**Call sites of `anchorMenuToRect` (must stay green):** `webview/components/review-navigator.tsx:60`, `review-view.tsx:1646`, `:1677`, `right-pane.tsx:222`, `select-field.tsx:50`, `sidebar.tsx:168`.
**Steps:**
- [ ] Failing tests: 'end/below equals anchorMenuToRect' (rect `{left:100,right:200,top:10,bottom:30}`, width 150 → `{x:50,y:34}`); 'start/below' → `{x:100,y:34}`; 'end/above with height 80, gap 4' → `{x:50,y:-74}`; 'start/above'.
- [ ] Run — FAIL (export missing); implement; `anchorMenuToRect` body becomes the delegation; existing tests stay green.

#### Task 1.3: overlay store + hook

**Files:** Create `webview/overlay-store.ts`, `webview/use-overlay-entry.ts`; Test `test/unit/overlay-store.test.ts` (jsdom)
**Interfaces:** Consumes `pushOverlay`, `removeOverlay`, `topOverlay`, `modalDepth` from `src/overlay-stack.ts`. Produces the store and hook contracts above.
**Steps:**
- [ ] Failing tests (store, no React): 'Escape invokes only the top entry's onDismiss' (register modal A, modal B; dispatch `new KeyboardEvent('keydown', {key:'Escape', bubbles:true})` on `window` → B called once, A not); 'an entry registered after a modal receives Escape first' (modal, then popover → popover's called, modal's not); 'Escape is stopped before bubble listeners' (a bubble-phase window listener does not fire while an entry exists; fires when the stack is empty); 'registering a modal dismisses open popovers' (popover P then modal M → P's onDismiss called once, `getOverlays()` no longer lists P); 'a dismissed popover's onDismiss that registers a new entry does not corrupt the stack' (stack afterwards = [M, new]); 'the keydown listener is removed when the last entry unregisters' (spy on `window.removeEventListener`); 'getOverlays returns the same reference between changes'.
- [ ] Run — FAIL; implement; green.
- [ ] Hook: `useOverlayEntry` per the contract (id from `useState(nextOverlayId)`, register in `useLayoutEffect`, `onDismiss` in a ref, `depth` from `useSyncExternalStore(subscribeOverlays, getOverlays)` + `modalDepth`). Covered by T1.4/T1.5 tests.

#### Task 1.4: `Popover`

**Files:** Create `webview/components/popover.tsx`; Modify `webview/styles.css` (add `.popover` rule beside `.ctxmenu` at ~6508; move `-webkit-app-region` list at ~1053 to `.modal__backdrop, .popover, .mermaid-zoom__backdrop, .queuebackdrop`); Modify `test/unit/drag-region.test.ts` (`OVERLAY_ROOTS`: replace `.ctxmenu` with `.popover`); Test `test/unit/popover.test.ts` (jsdom)
**Interfaces:** Consumes `useOverlayEntry`, `anchorPopover`, `clampMenuPosition`. Produces `Popover`, `PopoverProps`.
**Steps:**
- [ ] `.popover { position: fixed; z-index: var(--layer-popover); }` inserted directly ABOVE the `.ctxmenu` rule (~6508, never at the sheet's end) — `--layer-popover` is defined in T2.6; until then the rule resolves to `auto`, so ALSO add the four `--layer-*` declarations to the primary `:root` block (`webview/styles.css:7–257`, at its end) in this task; T2.6 then only swaps the literals in the four consumer rules.
- [ ] Failing tests: 'renders its frame as a child of document.body with class popover plus the caller class'; 'mousedown outside calls onClose once; inside does not'; 'mousedown inside triggerRef does not close'; 'capture-phase scroll outside closes, scroll inside the frame does not'; 'window blur and resize close'; 'anchor mode with align start places left = rect.left' (mock `getBoundingClientRect` on the frame to `{width:100,height:50}`, viewport 1000×800, rect `{left:100,right:200,top:10,bottom:30}` → style `left: 100px; top: 34px`); 'side above places top = rect.top - gap - height'; 'a forwarded ref receives the frame element'; 'hovering (re-rendering with new children) does not re-measure' (spy on `getBoundingClientRect`: call count unchanged across a children-only re-render; jsdom has no `ResizeObserver` — stub a minimal one on `globalThis` in the test and assert it was observed on the frame).
- [ ] Run — FAIL; implement (listeners are the ones currently in `context-menu.tsx:100–128`, moved verbatim, minus `useEscapeKey`); green; `drag-region` test green.

#### Task 1.5: `ModalLayer`

**Files:** Create `webview/components/modal-layer.tsx`; Test `test/unit/modal-layer.test.ts` (jsdom)
**Interfaces:** Consumes `useOverlayEntry`. Produces `ModalLayer`, `ModalLayerProps`.
**Steps:**
- [ ] Failing tests: 'backdrop is a child of document.body with the default class'; 'backdropClass replaces the default'; 'two layers get z-index strings calc(var(--layer-modal) + 0) and + 1, in mount order regardless of tree order' (render B before A in the tree but mount A first via a state flip; **flush passive effects with `await act(async () => {})` before asserting** — `useSyncExternalStore` subscribes post-paint); 'the later-mounted layer is later in document.body' (DOM order is the primary guarantee); 'closing the first re-derives the second to + 0'; 'click on the backdrop calls onDismiss; click on a child does not'.
- [ ] Run — FAIL; implement; green.

#### Task 1.6: `ContextMenu` on `Popover`

**Files:** Modify `webview/components/context-menu.tsx`; Modify `webview/styles.css` (`.ctxmenu` at ~6508: delete `position: fixed;` and `z-index: 80;`)
**Interfaces:** Consumes `Popover`. Produces `MenuState` with optional `anchor?: Rect; side?: PopoverSide` (no consumer yet passes them; T4.2 is the first — they are typed here because `ContextMenu` must map them, and T4.2 must not touch `context-menu.tsx` again).
**Call sites:** all 14 `<ContextMenu` uses listed in the code map keep working unchanged: `app.tsx:3036`, `architecture-view.tsx:2737`, `board-view.tsx:459`, `breadcrumb-bar.tsx:257`, `code-viewer.tsx:711`, `doc-tabs.tsx:335`, `git-history-view.tsx:1021`, `markdown-viewer.tsx:992`, `review-navigator.tsx:180`, `review-view.tsx:1775`, `:2005`, `right-pane.tsx:316`, `select-field.tsx:84`, `sidebar.tsx:512`, `terminal-pane.tsx:925`.
**Steps:**
- [ ] Port (existing suite is the proof): the `createPortal`, the clamp `useLayoutEffect` (`:87–98`), the dismiss `useEffect` (`:100–128`) and `useEscapeKey` (`:100`) leave `ContextMenu`; it renders `<Popover at={{x: menu.x, y: menu.y}} onClose={onClose} triggerRef={triggerRef} className="ctxmenu" role="menu" aria-activedescendant={activeId} style={{ minWidth }}>` (or `anchor`/`align="end"`/`side` when `menu.anchor` is set) around the existing `.ctxmenu__scroll` markup. Keyboard nav effect (`:131–165`) and the highlight reset stay.
- [ ] `npx vitest run` (whole unit suite) green; the two smoke scenarios in the slice check exit 0.

### Slice 2: Modals on `ModalLayer`

**Check:** `node test/e2e/run-smoke.mjs overlay-modals` exit 0 (written first, red at base — the run log is the AC-0 baseline for findings 1, 3, 5, 6, 7), then `quit-guard`, `timed-message-dialog-ui`, `review-compare`, `mermaid-export`, `explorer-dnd-polish`, `arch-node-graph`, `skill-install` (drives the Settings modal), `shortcut-precedence`, `new-session-browse-pinned` each exit 0, and `npx vitest run test/unit/overlay-sites.test.ts` green.

**Parallel groups:** G0: T2.0 · G1: T2.1 · G2: T2.2 · G3: T2.3 · Serial: T2.4, T2.5, T2.6
**Claims (serial lane):** `webview/styles.css`

#### Task 2.0: `overlay-modals` e2e, red first

**Files:** Create `test/e2e/overlay-modals.e2e.mjs`
**Interfaces:** none produced; drives selectors that already exist (`.tmdlg__trigger`, `.confirm`, `.modal__backdrop`, `.mermaid-diagram__expand`, `.mermaid-zoom__backdrop`, `.review__navrow`, `.arch`).
**Steps:**
- [ ] Steps, each logging the measured numbers: **(3)** open Timed messages the way `timed-message-dialog-ui.e2e.mjs:97` does, type a message, press Escape → assert two `.modal__backdrop` exist, both are direct children of `body`, `getComputedStyle(confirmBackdrop).zIndex` is numeric and greater than the dialog backdrop's, `document.elementFromPoint` at the confirm's Cancel button centre is that button; press Escape → the confirm is gone and the `.tmdlg` dialog remains. **(6)** open Review on a fixture with changes, trigger a hunk/file discard confirm (the navigator row `Discard` action) → the backdrop's rect equals the viewport and its parent is `body`; Escape closes it. **(5)** open a markdown fixture with a mermaid block (reuse the fixture path used at `viewer-robustness.e2e.mjs:474`), click `.mermaid-diagram__expand` → `.mermaid-zoom__backdrop` rect equals the viewport, parent `body`. **(1)** create `a/x.txt` and `b/x.txt` in the fixture, open Explorer; reuse the row-drag helper if `dnd.e2e.mjs` or `explorer-dnd-polish.e2e.mjs` drags tree rows with the mouse, otherwise select `b/x.txt`, `Mod+C`, select folder `a`, `Mod+V` (both paths reach `ConflictDialog`) → the `.confirm` box is centred on the window within 4px, all three buttons fully inside the viewport, parent `body`; click Cancel. **(7)** open the arch canvas, right-click a node so `.ctxmenu` is open, invoke Delete from it → assert `.ctxmenu` count is 0 while the confirm is visible and the confirm backdrop's parent is `body`. **(displacement)** right-click an explorer row (menu open), press `Mod+,` (`openSettings`, `webview/shortcuts.ts:105`) → `.ctxmenu` count 0, the settings modal visible (the selector `skill-install.e2e.mjs:51` waits on).
- [ ] Run at the base commit: expect FAIL at (3) z-order / (6) rect / (5) rect / (1) centring / (7) parent; save the log as `.autoloop/evidence/<run>/baseline-overlay-modals.log`.

#### Task 2.1: `ConfirmDialog`, `ConflictDialog`

**Files:** Modify `webview/components/confirm-dialog.tsx`, `webview/components/conflict-dialog.tsx`
**Interfaces:** Consumes `ModalLayer`. Public props of both unchanged.
**Call sites (unchanged):** `app.tsx:3038`, `review-view.tsx:2010`, `architecture-view.tsx:2747`, `right-pane.tsx:1597`.
**Steps:**
- [ ] `ConfirmDialog`: root becomes `<ModalLayer onDismiss={onClose}>`; the keydown effect keeps only the Enter branch (`:27` Escape branch deleted); the box gains `aria-modal`. `ConflictDialog`: root `<ModalLayer onDismiss={() => onResolve({ action: 'cancel', applyToAll })}>`; the keydown effect (`:41–50`) deleted; `keepBothRef` focus stays.
- [ ] `npx vitest run test/unit/delete-confirm.test.ts` (and any test importing these) green; `node test/e2e/run-smoke.mjs quit-guard` exit 0.

#### Task 2.2: palette, icon picker, settings, web prompt, new session

**Files:** Modify `webview/components/command-palette.tsx`, `icon-picker-modal.tsx`, `settings-modal.tsx`, `web-prompt-modal.tsx`, `new-session-modal.tsx`
**Interfaces:** Consumes `ModalLayer`.
**Steps:**
- [ ] Each backdrop `<div className="modal__backdrop" onClick={onClose}>` → `<ModalLayer onDismiss={onClose}>` (palette: `backdropClass="modal__backdrop palette__backdrop"`). Delete: `useEscapeKey(onClose)` at `command-palette.tsx:123`, `icon-picker-modal.tsx:114`, `settings-modal.tsx:88`, `web-prompt-modal.tsx:16`; the palette's `onKeyDown` Escape branch (`:139–142`); new-session's keydown effect (`:77–80`).
- [ ] Settings shortcut recorder (`settings-modal.tsx:1013–1022`, a capture-phase window listener that today beats the modal's bubble-phase Escape): the recording component calls `useOverlayEntry('popover', () => setRecording(null))` while `recording !== null` (mount a tiny inner component, or gate the hook's registration on the state — the hook registers only while mounted, so render a `<RecorderEscape onCancel=…/>` child that exists only while recording); delete its `'Escape'` branch. Check: `node test/e2e/run-smoke.mjs shortcut-precedence` exit 0, and a manual step in the slice check: start recording, press Escape → recording cancelled, Settings still open.
- [ ] `npx vitest run test/unit/new-session-modal.test.ts` green; `node test/e2e/run-smoke.mjs new-session-browse-pinned` exit 0.

#### Task 2.3: compare dialog and timed-message dialog backdrops

**Files:** Modify `webview/components/compare-dialog.tsx` (backdrop + `onRootKeyDown` only — the combobox is T3.1), `webview/components/timed-message-dialog.tsx` (backdrop + `onRootKeyDown` only — selects are T3.4)
**Interfaces:** Consumes `ModalLayer`.
**Steps:**
- [ ] Compare: `:471` → `<ModalLayer onDismiss={onCancel}>`; in `onRootKeyDown` (`:444–448`) delete the Escape branch (the combobox's own Escape-closes-list behaviour at `:245` stays until T3.1 replaces it with the popover being top). Timed: `:271` → `<ModalLayer onDismiss={requestClose}>`; delete the Escape branch at `:229–231`; Tab trap (`:255–268`) stays.
- [ ] `node test/e2e/run-smoke.mjs timed-message-dialog-ui` and `review-compare` exit 0.

#### Task 2.4: mermaid zoom overlay

**Files:** Modify `webview/components/mermaid-zoom-overlay.tsx`; Modify `webview/styles.css` (`.mermaid-zoom__backdrop` ~11028: delete `z-index: 200;`)
**Interfaces:** Consumes `ModalLayer`.
**Steps:**
- [ ] `:99` → `<ModalLayer backdropClass="mermaid-zoom__backdrop" onDismiss={onClose}>`; delete the Escape branch in `onKeyDown` (`:67–70`); stage focus (`:62–64`) and Tab trap stay.
- [ ] `node test/e2e/run-smoke.mjs mermaid-export` exit 0.

#### Task 2.5: static site guard

**Files:** Create `test/unit/overlay-sites.test.ts`
**Steps:**
- [ ] Test reads the nine dialog files + `mermaid-zoom-overlay.tsx` + `context-menu.tsx` + `popover.tsx`: 'no JSX className="modal__backdrop attribute outside modal-layer.tsx' (regex `className="modal__backdrop` over `webview/**/*.tsx` minus `modal-layer.tsx`); 'migrated overlays do not handle Escape themselves' (none of the listed files contains `useEscapeKey(` or `'Escape'` — satisfiable because T2.2 also removed the recorder's branch). Must be green after T2.1–T2.4 and red if either is reverted (mutation-verify once by reverting T2.1).

#### Task 2.6: layer tokens and dead CSS

**Files:** Modify `webview/styles.css` (`.modal__backdrop:1298` → `z-index: var(--layer-modal);`, `.ctxmenu` already handled, `.toasts:5604` → `var(--layer-toast)`, `.theatre:6630` → `var(--layer-theatre)`; delete `.shell > .sidebar, .shell > .center, .shell > .right` arms at ~6657–6663 keeping `.shell > .topbar`; delete `.resizer*` at ~6805–6833 and ~7022; delete `.modal__termlabel .modal__select` at ~1448/1452 after `grep -rn "modal__select" webview src` shows only CSS); Modify `test/unit/state-vocabulary.test.ts` (`:90` only: remove the `.resizer:hover::after, body.resizing .resizer::after` `HOVER_FILL_ALLOW` key; `:88` `.gh__resizer`, `:89` `.panel__resize`, `:91` stay)
**Steps:**
- [ ] `npx vitest run test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts` green; `npm run build` exit 0; the slice check.

### Slice 3: Popups on `Popover`, Monaco host, `SelectField`

**Check:** `node test/e2e/run-smoke.mjs overlay-popovers` exit 0 (written first, red at base — baseline for findings 2, 4), then `review-compare`, `arch-node-graph`, `timed-message-dialog-ui`, `editor-first-paint`, `split-diff-map` exit 0.

**Parallel groups:** Serial: T3.0, T3.1, T3.2, T3.4, T3.3 (every product task edits `webview/styles.css`)
**Claims (serial lane):** `webview/styles.css`

#### Task 3.0: `overlay-popovers` e2e, red first

**Files:** Create `test/e2e/overlay-popovers.e2e.mjs`
**Steps:**
- [ ] **(2)** theme Neon (seed `settings.json` as `shoot.mjs:387` does), open Compare via `review-compare.e2e.mjs:75–80`'s path, focus the base field → `[role=listbox]` is a child of `body`, its rect bottom ≤ `innerHeight`, `document.elementFromPoint` at the last visible option's centre is inside the listbox; type a query → list still attached; Escape → list closed, dialog still open; Escape → dialog closed. **(4)** open the arch canvas as `arch-node-graph.e2e.mjs:255` does, add enough ports (or scroll `.arch__inspector` to the bottom) so the last `.typechip` is near the inspector's bottom edge, click it → `.typepicker` parent is `body`, rect fully inside the viewport, `.typepicker__search` visible; mousedown on the canvas → picker closed.
- [ ] Run at base: FAIL at (2) parent/rect (Neon) and (4) parent/rect; save the log as `baseline-overlay-popovers.log`.

#### Task 3.1: `RefCombobox` list on `Popover`

**Files:** Modify `webview/components/compare-dialog.tsx` (`RefCombobox` `:179–343`); Modify `webview/styles.css` (`.cmp-combo__menu` ~2758–2771: delete `position: absolute`, `top`, `left: 0`, `right: 0`, `z-index: 1`; keep `max-height`, colours, radius)
**Interfaces:** Consumes `Popover` (`anchor`, `width`, `align: 'start'`, `triggerRef`, `ref`).
**Steps:**
- [ ] Add `comboRef` on the `.cmp-combo` wrapper div and `anchor` state (`Rect | null`), set from `ref.current.getBoundingClientRect()` (the input) wherever `setOpen(true)` is called (`onFocus`, `onChange`); `open && anchor` renders `<Popover ref={menuRef} anchor={anchor} width={anchor.right - anchor.left} style={{ width: anchor.right - anchor.left }} align="start" onClose={() => setOpen(false)} triggerRef={comboRef} className="cmp-combo__menu" id={listId} role="listbox">` with the existing rows — `triggerRef` is the WRAPPER so the Clear button (`:284–297`) is not an outside click (otherwise Clear closes and its `focus()` reopens the list). `.cmp-combo` wrapper gets `aria-owns={open ? listId : undefined}`. Delete the input's `onKeyDown` Escape branch (`:245`) — the popover is the top entry and the stack closes it; `onBlur → setOpen(false)` stays; row `onMouseDown preventDefault` stays. The dialog's Tab trap (`:449–467`) stops seeing the option rows (they are portaled) — intended; add to `overlay-popovers` (2): with the list open, Shift+Tab from the base input lands on the dialog's last control, not an option.
- [ ] `overlay-popovers` step (2) green; `review-compare` exit 0.

#### Task 3.2: `TypePicker` on `Popover`

**Files:** Modify `webview/components/architecture-view.tsx` (`TypePicker` `:706–840`, `TypeChip` `:844–887`); Modify `webview/styles.css` (`.typepicker` ~8874–8888: delete `position: absolute`, `top`, `z-index: 40`, keep `width: 236px`; `.typechip__wrap` ~8848–8851: delete `position: relative`)
**Interfaces:** Consumes `Popover`. `TypePicker` gains props `anchor: Rect; triggerRef: RefObject<HTMLButtonElement | null>`.
**Call sites:** `architecture-view.tsx:877` (the only render).
**Steps:**
- [ ] `TypeChip`: `useRef` on the chip button, `anchor` state set from its rect on open; `TypePicker`'s root `<div className="typepicker nodrag nopan" role="menu" onClick onKeyDown>` → `<Popover anchor={anchor} width={236} align="start" onClose={onClose} triggerRef={triggerRef} className="typepicker" role="menu" onClick={stop}>` (`nodrag nopan` dropped: both `TypeChip` call sites, `:980` and `:2784`, are outside the `<ReactFlow>` element, so the classes never did anything); delete the Escape branch of its `onKeyDown` (`:741–746`) — the stack stops Escape at window capture so the canvas never sees it. Delete the DOM-presence guard `if (document.querySelector('.palette, .modal__backdrop, .ctxmenu')) return;` at `:1444` — unreachable now (the store stops Escape first) and it never knew about popovers.
- [ ] `overlay-popovers` step (4) green; `arch-node-graph` exit 0.

#### Task 3.3: Monaco overflow host (conditional on the baseline probe)

**Files:** Create `webview/monaco-overflow-host.ts`; Modify `webview/components/code-viewer.tsx` (`:169` options), `webview/components/diff-viewer.tsx` (`:92` options); Modify `webview/styles.css` (`.monaco-overflow-host { width: 0; height: 0; }` beside `.viewer` ~4901)
**Steps:**
- [ ] Baseline probe (scratch script via the harness, one launch): window 1100×600, open a `.ts` fixture, hover an identifier on the last visible line, wait for `.monaco-hover` → record whether its rect exceeds `.termwrap`'s rect / is clipped (`elementFromPoint` on its bottom edge). Save the result as `baseline-monaco-hover.md`. If it is NOT clipped: stop this task, record "finding 8 did not reproduce" in the report, delete nothing.
- [ ] Otherwise: create `webview/monaco-overflow-host.ts` — `monacoOverflowHost()` lazily creates `<div class="monaco-editor monaco-overflow-host">` on `document.body` (the `monaco-editor` class is mandatory: Monaco's theme variables are emitted on `.monaco-editor` and re-emitted on every theme change, and `webview/typing-guard.ts` `isEditorEntry` keys shortcut routing on it); both creates add `overflowWidgetsDomNode: monacoOverflowHost(), fixedOverflowWidgets: true` (Monaco positions overflow widgets with viewport coordinates only when `fixedOverflowWidgets` is on — `contentWidgets.js` — so both options together are required). Re-run the probe: the hover's parent chain includes `.monaco-overflow-host`, its rect is inside the viewport, and it has a non-transparent background. If the background is transparent, that is a finding to report — do not copy a theme class onto the host (it would go stale on the next theme switch).
- [ ] `editor-first-paint`, `split-diff-map` exit 0.

#### Task 3.4: `SelectField` for the three native selects

**Files:** Modify `webview/components/timed-message-dialog.tsx` (`:353`, `:390`), `webview/components/architecture-view.tsx` (`:2851`); Modify `webview/styles.css` (`.tmdlg__unit` rules: keep only what still applies to a `.selectfield` trigger, delete select-only declarations)
**Interfaces:** Consumes `SelectField({ value, options, onChange, ariaLabel, disabled })` from `webview/components/select-field.tsx`.
**Steps:**
- [ ] `const UNIT_OPTIONS: SelectOption[] = [{ value: 'minutes', label: 'minutes' }, { value: 'hours', label: 'hours' }]`; both selects → `<SelectField value={…Unit} options={UNIT_OPTIONS} onChange={(v) => set…Unit(v as Unit)} ariaLabel="Delay unit" | "Interval unit" />`. Arch: `<SelectField value={kind} options={ARCH_KINDS.map((k) => ({ value: k.id, label: k.label }))} onChange={(v) => onChange({ kind: v as ArchKind })} ariaLabel="Kind" />`.
- [ ] `timed-message-dialog-ui` exit 0 — if that scenario picks a unit through `selectOption` on the `<select>`, change it to click the trigger `[aria-label="Delay unit"]` and choose `hours` from the menu (same assertion, new widget; the accessible names are the AC). Screenshot the timed dialog to the scratch dir and confirm the two unit fields sit on the input row (visual-fidelity step).

### Slice 4: Review compact header and bar menu above

**Check:** `node test/e2e/run-smoke.mjs review-compact-header` exit 0 (written first, red at base — F1 baseline), then `review-mode-pane`, `review-scope`, `band-alignment` exit 0.

**Parallel groups:** Serial: T4.0, T4.1, T4.2
**Claims (serial lane):** `webview/styles.css`, `webview/components/review-view.tsx`

#### Task 4.0: `review-compact-header` e2e, red first

**Files:** Create `test/e2e/review-compact-header.e2e.mjs`
**Steps:**
- [ ] Fixture with changes; `page.setViewportSize({ width: 900, height: 700 })` with default rail widths; open Review with the pane open → assert `.review__head` `scrollWidth <= clientWidth`, `.review__actionbar` likewise; `.review__more` centre `elementFromPoint` is the button; `.review__stageall` rect inside the bar rect; `.review__source` width ≥ 72 and its label text non-empty and visible; `.review__scope` hidden; click `.review__more` → three `[role=menuitemcheckbox]` rows `All`/`Staged`/`Unstaged`, exactly one `aria-checked="true"`; click `Staged` → reopen: `Staged` checked. Then `page.setViewportSize({ width: 1440, height: 900 })` → `.review__scope` visible again and the menu has no scope rows. Bar menu: click `.review__barmore` → the `.ctxmenu` rect bottom ≤ the bar's top (assertion message states the measured menu height and the space above the bar — `side: 'above'` is a preference with no flip, so this only holds while the menu fits above).
- [ ] Run at base: FAIL (overflow, no scope rows, menu over the bar); save `baseline-review-compact.log`.

#### Task 4.1: compact header

**Files:** Create `webview/use-element-width.ts`; Modify `webview/components/review-view.tsx` (head ref + `useElementWidth`, `openMoreMenu` `:1640–1666`, handoff button `:1979–1989`); Modify `webview/styles.css` (`.review__source` ~9685: `min-width: 72px`; the source label element rule: `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` if absent; `@container (max-width: 480px) { .review__scope, .review__stats { display: none; } }` beside the existing blocks ~9420–9431; `.review__actionbar { container-type: inline-size }` + `@container (max-width: 480px) { .review__notes { display: none; } .review__sendlabel { … } }` — the `…` is the `.sr-only` recipe at `webview/styles.css:10371` copied verbatim: `position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;`)
**Interfaces:** Produces `useElementWidth`. Consumes `scopeOfSource`, `REVIEW_SCOPES`, `SCOPE_LABEL` from `webview/review-scope.ts`; `MenuItem.checked/disabled/separatorBefore`.
**Steps:**
- [ ] `useElementWidth` returns `Number.POSITIVE_INFINITY` until the observer's first callback, so nothing is treated as compact before a measurement; `const compact = useElementWidth(headRef) <= 480`; when compact, `openMoreMenu` prepends `REVIEW_SCOPES.map((s) => ({ label: SCOPE_LABEL[s], checked: scopeOfSource(source) === s, disabled: source.kind !== 'working', onClick: () => onSetSource({ kind: 'working', ...(s === 'all' ? {} : { scope: s }) }) }))` and sets `separatorBefore: true` on `Collapse all`. Wrap the handoff button's text in `<span className="review__sendlabel">`. Delete the `if (confirmRef.current) return` guard in the `useEscapeKey` callback at `:406` (the stack now stops Escape before this bubble listener whenever a confirm is open).
- [ ] `review-compact-header` steps up to the bar menu green.

#### Task 4.2: bar overflow menu opens above

**Files:** Modify `webview/components/review-view.tsx` (the bar `…` opener `:1677`)
**Interfaces:** Consumes `MenuState.anchor/side` (T1.6).
**Steps:**
- [ ] `setBarMenu({ ...anchor, anchor: rect, side: 'above', items })` where `rect = e.currentTarget.getBoundingClientRect()`.
- [ ] `review-compact-header` fully green; slice check.

### Slice 5: Ship docs

**Check:** `npm run verify` exit 0 on the branch; `git status` clean after commit.

**Parallel groups:** Serial: T5.1

#### Task 5.1: changelog, spec archive, index

**Files:** Modify `CHANGELOG.md` (`[Unreleased]` — Fixed: the nine surfaces in user words; Changed: Review header compacts below 480px, scope in the `…` menu, native selects replaced); `git mv docs/specs/2026-09-07-overlay-layers.md docs/specs/archive/`; Modify `docs/specs/INDEX.md` (row moves to Archived with `(FULL)`).

## Verification

Per task: the named vitest file(s) or the named smoke scenario, alone. Per slice: the slice check,
then `npm run verify` with nothing else running, exit code captured directly, one commit per slice.
Merged tree: `npm run verify`, the three new scenarios plus the review/arch/compare/timed/mermaid
scenarios named in the slice checks, and the full smoke once (failures re-run alone; `paste`,
`terminal-drop`, `markdown-viewer` are known environmental on this machine and must be attributed at
the base commit before being reported).

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. Report leads with the fix that keeps the locked decision.

## Decisions Needed

- [normal] Finding 8 (Monaco) is built only if T3.3's probe reproduces a clipped widget — default:
  probe first, skip and record otherwise.
- [normal] The spec's "Scope group" in the `…` menu is a separator-delimited run of three checkable
  rows; no group heading exists in `MenuItem` and none is added — default taken: no new field.
- [normal] `test/unit/state-vocabulary.test.ts` loses its one `.resizer` allow-list key (`:90`) with
  the dead CSS; the key is a `Map` entry consulted by `.has()`, so its removal changes no assertion —
  recorded so the gate-diff reviewer does not read it as narrowing.
- [normal] The mermaid fullscreen viewer moves from z 200 to the modal band (toasts now paint above
  it) — consistent with the spec's layer order; recorded as a visible change.
