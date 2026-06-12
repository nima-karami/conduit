# Spec — Icon-only top-bar view switcher (wishlist J1)

**Tier:** LITE · **Feature type:** UI · **Slug:** `switcher-icons-only`

## Context

- **Job:** The top-bar view switcher (Editor / Feature Board / Architecture Canvas) lets
  the user swap the center pane between exactly one of three views.
- **Before:** Each switcher button rendered its icon **plus** a visible inline text label
  (`<span className="viewswitch__label">{v.label}</span>`), making the segmented control
  wide and text-heavy.
- **Actor:** Anyone using the center pane.
- **Success:** Compact, ICON-ONLY buttons. The icons remain identifiable (tooltip on hover
  + accessible name for screen readers), the active view stays visually highlighted, and
  clicking still switches views.
- **Non-goals:** Changing which views exist, the icons themselves, keyboard shortcuts, the
  command palette, or any other top-bar control.

## Change

`webview/components/top-bar.tsx`
- Remove the `<span className="viewswitch__label">{v.label}</span>` from each switcher
  button — the button now contains only its icon.
- Keep `title={v.label}` (hover tooltip) and add `aria-label={v.label}` so each icon button
  retains an accessible name. The `CenterViewDef.label` strings (`center-view.ts`) are
  unchanged and now feed only the tooltip/aria-label, not visible text.

`webview/styles.css`
- `.viewswitch__btn`: drop the text-oriented `gap`/horizontal `padding`, give it a fixed
  `width: 28px` and `justify-content: center` so the icon sits centered in a square-ish
  hit target. The active (`--on`) and hover styles are untouched.
- Remove the now-unused `.viewswitch__label` rule.

## Behavior & states

- **Active view:** the matching button keeps `.viewswitch__btn--on` (accent background +
  accent icon color) and `aria-selected={true}` / `role="tab"` `[selected]`.
- **Hover:** icon brightens (`.viewswitch__btn:hover`), tooltip shows the view name.
- **Click:** `onSelectView(v.id)` fires exactly as before — switching is unchanged.
- **Browser preview (fake shell):** pure-UI change; renders identically with no host APIs.

## Acceptance criteria

- Each switcher button renders only an `<svg>` icon — no visible text node.
- Every button exposes an accessible name (`aria-label` = view label) and a `title` tooltip.
- Exactly one button carries `--on` / `aria-selected` at a time; clicking another moves it.
- `npm run verify` and `npm run build` both pass.

## Tests

Purely presentational — no extracted logic to unit-test. `CENTER_VIEWS` and
`centerViewForAction` are unchanged, so existing coverage still applies. Verified at runtime
via Playwright against the served webview preview (icon-only accessibility tree confirmed;
Editor↔Board↔Canvas switching and the single-active highlight observed).

## Scope

- **MVP = v1:** the label removal + CSS tightening above.
- **Out of scope:** icon set, shortcuts, palette, other top-bar controls.

## Decisions Needed

none
