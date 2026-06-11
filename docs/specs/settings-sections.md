# Spec — group Appearance settings into sections (wishlist H1)

**Tier:** LITE · **Feature type:** UI (pure reorganization)
**One-line:** In Settings → Appearance, regroup the flat list of one-control-per-row
sections under a few meaningful section headings (Background, Theme & color,
Typography, Editor & code, Session cards) — preserving every control, its label,
and its binding exactly as-is.

## Context

The Appearance tab (`webview/components/settings-modal.tsx`) rendered every control
as its own top-level `<Section>` — a flat run of ~13 rows with no grouping. Related
controls (background style + intensity + surface opacity + blur; the two code-block
controls; the font/density controls) sat next to unrelated ones, reading as cluttered
sprawl. The Shortcuts tab already groups its rows under uppercase headings
(`shortcuts__gtitle`); the Appearance tab did not.

This is a pure regroup/relabel: no control was added, removed, or rebound, and no
control's behavior changed. Only the visual grouping (a heading per section + a
bordered block of the related controls) was introduced, reusing the existing
heading treatment so it matches the app's visual system.

## The section taxonomy chosen

The taxonomy is data, not markup: `webview/appearance-sections.ts` exports
`APPEARANCE_SECTIONS`, an ordered list of `{ id, title, controls[] }`. The modal
iterates it, emitting one `SetGroup` (heading + bordered body) per section and
rendering each control by its id. This keeps the grouping unit-testable and makes
the "every control accounted for exactly once" guarantee checkable
(`test/unit/appearance-sections.test.ts`).

| Section heading   | Controls (in order)                                              | Settings binding(s)                         |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------- |
| **Theme & color** | Theme                                                           | `theme`                                     |
| **Typography**    | Interface font · Monospace font · Density                       | `fontUi`, `fontMono`, `density`             |
| **Background**    | Background · Background intensity · Surface opacity · Background blur · Custom shader | `background`, `bgIntensity`, `surfaceOpacity`, `bgBlur`, `customShader` |
| **Editor & code** | Word wrap · Code & terminal background · Code block opacity      | `wordWrap`, `surfaceColor`, `codeOpacity`   |
| **Session cards** | Session card (Title / Subtitle / Detail + live preview)         | `cardTitle`, `cardSubtitle`, `cardDetail`   |

Conditional visibility is preserved unchanged:

- Background intensity / Surface opacity / Background blur are hidden when
  `background === 'none'` (as before) — they still belong to the Background section
  so the layout stays stable when they reappear.
- Custom shader is shown only when `background === 'custom'` (as before) — it lives in
  the Background section.

### Why this grouping

- **Background** keeps all backdrop-related controls together — the natural home for
  the later **H2** live-preview boxes.
- **Editor & code** groups the code-block surface controls (and word-wrap) — the
  natural home for the later **I1** unified terminal/code-block colour control.
- **Theme & color** and **Typography** split the two "global look" concerns so each is
  scannable.
- **Session cards** isolates the one composite control (a select-trio + live preview)
  that does not fit the one-row pattern.

## Interface contract

- New pure module `webview/appearance-sections.ts`:
  - `AppearanceControlId` — union of the 13 control ids.
  - `AppearanceSectionId` — union of the 5 section ids.
  - `APPEARANCE_SECTIONS: readonly AppearanceSection[]` — the ordered taxonomy.
  - `appearanceControlIds(sections?)` — flattens all control ids in display order.
- `settings-modal.tsx`:
  - New presentational `SetGroup({ title, children })` → `<section class="setgroup">`
    with an `h3.setgroup__title` heading and a `div.setgroup__body` block.
  - `Appearance` now maps `APPEARANCE_SECTIONS` → a `SetGroup` per section and renders
    each control via a `renderControl(id)` switch. Each case is the **same JSX** as
    before (same label, same `desc`, same `update({...})` binding).
- `webview/styles.css`: `.setgroup`, `.setgroup__title` (reusing the uppercase-faint
  heading treatment from `.shortcuts__gtitle`), `.setgroup__body` (bordered block;
  last `.set` row drops its own divider since the block border owns the edge).

## Edge cases

- **Fake-shell / plain-browser preview:** unchanged — `useSettings` works without the
  host bridge; the grouped layout renders from static taxonomy data regardless.
- **Background === 'none':** the three background sliders render `null`; the Background
  section then shows only the Background segmented control (no empty block, heading
  still meaningful).
- **No control dropped:** `appearanceControlIds()` equals the full expected set, asserted
  in the unit test, so a future regroup cannot silently drop a control.

## Acceptance criteria (declarative)

1. Appearance tab shows controls under section headings (Theme & color, Typography,
   Background, Editor & code, Session cards) — not one-control-per-top-level-section.
2. Every previously-present control is still present with its exact label, description,
   and binding; no behavior changed.
3. Background-related controls (style, intensity, surface opacity, blur, custom shader)
   are grouped together; the two code-block controls are grouped together.
4. The heading treatment matches the existing Shortcuts-tab grouping style.
5. `appearanceControlIds()` accounts for every control exactly once (unit-tested).
6. `npm run verify` and `npm run build` both pass.
7. Runtime proof: open Settings → Appearance → controls appear under grouped headings,
   every expected control present and interactive.

## Self-audit

Template spine covered: context, taxonomy, interface contract, edge cases, acceptance.
Pure-reorganization scope respected — no binding/behavior changes. A later H2 (preview
boxes) and I1 (unified surface colour) have natural homes (Background, Editor & code).
No items left unaddressed.

## Decisions Needed

none
