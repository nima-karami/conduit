# Spec — Editor tab strip containment (wishlist E3)

**Tier:** LITE · **Type:** UI (CSS/layout fix) · **Mode:** autonomous

## Problem frame

**Job:** When many file tabs are open in the code-editor pane, the editor tab strip
(`.tabbar`, rendered by `webview/components/doc-tabs.tsx`) must stay inside its pane.

**Actor:** A user with many open editor tabs.

**Today (bug):** `.tabbar` is `display: flex` with no `min-width: 0` and no `overflow`
handling. Its children (`.tab`, default `flex: 0 0 auto`) keep their intrinsic width,
so once their combined width exceeds the pane the strip overflows horizontally and the
overflowing tabs paint over the adjacent Explorer (`.right`) pane.

**Success:** The strip is clipped to the editor pane's width. Overflow is reachable via
horizontal scroll. No tab ever paints outside the editor pane / over the Explorer.

**Non-goals:** Overflow dropdown menu; tab grouping/pinning; changing tab visuals,
drag-reorder, or the panel re-dock grip; vertical wrapping of tabs.

## Behavior & states

- **Few tabs (fit):** unchanged — tabs sit left-to-right, no scrollbar.
- **Many tabs (overflow):** the strip scrolls horizontally within the pane; a thin
  horizontal scrollbar appears; tabs are clipped at the pane's right edge.
- **Active terminal tab + grip:** remain part of the scrollable strip (no special
  pinning required for this fix).

## Edge cases

- Very narrow editor pane (Explorer/Sessions wide): strip still contained; scrolls.
- Single very long tab title: already capped by `.tab { max-width: 220px }` + ellipsis.
- Re-dock grip present: grip scrolls with the strip; still draggable.

## Defaults vs settings

- **Default:** horizontal scroll within the contained strip. Rationale: standard
  code-editor behavior (VS Code), no extra UI affordance, preserves tab order/identity.
  No setting exposed — not a durable user preference.

## Scope

- **MVP (this):** CSS-only — contain `.tabbar`, enable horizontal overflow scroll,
  prevent tab shrink-to-nothing, style a thin scrollbar.
- **Out of scope:** overflow menu, wrap mode, pinned tabs.

## Acceptance criteria

- AC1: With enough tabs to overflow, `.tabbar` right edge ≤ editor pane (`.center`)
  right edge, and ≤ Explorer (`.right`) left edge — no overlap.
- AC2: Overflowing tabs are reachable by horizontal scrolling of the strip.
- AC3: Each tab keeps its width (does not collapse); tab order/identity unchanged.
- AC4: With few tabs, no scrollbar and no visual change from before.
- AC5: `npm run verify` and `npm run build` both pass.

## Decisions Needed

none
