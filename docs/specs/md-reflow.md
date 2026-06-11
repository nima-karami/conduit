# Spec — Markdown viewer doesn't reflow on sidebar collapse (wishlist A2)

**Tier:** LITE · **Feature type:** UI · **Slug:** `md-reflow`

## Problem frame

- **Job:** When the sidebar collapses and the center pane widens, the Markdown viewer
  should use the freed horizontal space — like the code editor already does.
- **Symptom:** Collapsing the sidebar (top-left button) correctly widens the **code
  editor**, but the **Markdown preview/viewer** keeps its original width, pinned to the
  left, leaving a dead band of panel background on its right.
- **Actor:** Anyone reading a Markdown file in the center pane.
- **Success:** The rendered Markdown fills the available width of its pane and tracks
  width changes (sidebar collapse/expand, window resize, panel docking) live.
- **Non-goals:** Editor padding (C1, already shipped), editor background/theme (C2),
  panel transparency (C3), the source-view (`View source`) toggle behavior, the
  `react-markdown` rendering pipeline, terminal styling.

## Root cause

`.markdown` in `webview/styles.css` carries `max-width: 860px` with **no horizontal
auto margins**. The `.markdown` element is the scroll container inside `.viewer`, which
is `display: flex; flex-direction: column` (default `align-items: stretch`). A
flex child with a `max-width` cap and no `margin: 0 auto` resolves its main-cross
position to the **start** edge — so the content stays 860px wide, pinned left, and does
**not** grow when `.viewer`/`.termwrap` widen on sidebar collapse. The code editor
(Monaco in `.viewer`) has no such cap and therefore reflows correctly.

## Behavior & states

- **Markdown open, sidebar expanded:** rendered Markdown fills the pane width.
- **Markdown open, sidebar collapsed:** the pane grows; the Markdown re-flows to the new
  wider width (no left-pinned 860px column, no dead band on the right).
- **Window resize / panel re-dock:** width tracks the container — pure CSS, so this is
  automatic with no JS resize handler.
- **`View source` mode:** unaffected — that path renders `CodeViewer` (Monaco), which
  already fills width.
- **Long content:** the `.markdown` container keeps `overflow: auto`, so vertical scroll
  is unchanged; horizontal scroll only appears inside `pre` blocks as today.

## Defaults vs. settings

- **Default (the ~80% path):** **full width**, matching the user's stated preference and
  the code editor's behavior. No readable-measure max-width is retained.
- **No setting exposed.** A width/centering toggle is a divergent preference not requested
  here; adding one would be over-production for a one-line CSS fix. Rationale: the user
  explicitly asked for full-width parity with the editor.

## Fix

In `webview/styles.css`, remove the `max-width: 860px` cap on `.markdown` so it stretches
to fill `.viewer` (and therefore `.termwrap`). The existing internal `padding: 22px 28px`
is kept as the content's breathing room. No JS change; the reflow is inherent to the flex
stretch once the cap is gone.

## Edge cases & failure modes

- **Very wide monitors:** lines can get long. Accepted — the user prefers full width over a
  readable measure, and `pre`/code blocks already manage their own overflow. (Flagged below
  as a reversible decision.)
- **Zero/short content:** container simply fills width; nothing to reflow.
- **Source toggle button** (`.viewer__toggle`, absolutely positioned top-right) still lands
  correctly since `.viewer` is unchanged.
- **Diff viewer / non-markdown:** different components, untouched.

## Acceptance criteria

- With a Markdown file open, `.markdown` `getComputedStyle().maxWidth === 'none'`.
- With the sidebar **expanded**, the `.markdown` rect width ≈ `.termwrap` content width.
- After **collapsing** the sidebar, `.termwrap` width grows **and** `.markdown` width grows
  by ~the same delta (it tracks the container) — not stuck at the prior ~860px.
- The `View source` → Monaco path is visually unchanged (still fills width).
- `npm run verify` and `npm run build` both pass.

## Scope

- **MVP = v1:** the one-line CSS change (drop `max-width: 860px` on `.markdown`).
- **Out of scope:** any width/centering preference setting; readable-measure typography;
  C1/C2/C3 editor theming items.

## Decisions Needed

- **[normal] Full-width vs. centered readable measure.** User stated preference is
  full-width parity with the editor; chose full-width (remove the cap). Reversible: if a
  readable measure is later wanted, re-add `max-width` **with** `margin-inline: auto` to
  center instead of left-pin. Defaulted to full-width per the explicit request — not a halt.
