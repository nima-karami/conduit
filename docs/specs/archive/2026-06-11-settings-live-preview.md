# Live preview "proof" boxes for the Background appearance controls (H2)

## Context

The session-card customizer in Settings → Appearance already ships a live
preview: a sample card that re-renders as you change the title / subtitle /
detail role pickers, so you can _see_ the result instead of guessing
(`SessionCardSection` in `webview/components/settings-modal.tsx`).

The four Background controls — **Background** (type), **Background intensity**,
**Surface opacity**, and **Background blur** — had no such feedback. They live
together in the **Background** section (grouped in H1,
`webview/appearance-sections.ts`) but you had to adjust them blind, save, and
look at the whole app to judge the effect. Surface opacity and blur in
particular are hard to picture: how much does 40% opacity reveal the backdrop?
How soft is 12px of blur?

H2 brings the session-card idea to the Background group: a small **live proof
box** that updates on every input — drag the blur slider and the box frosts;
drop surface opacity and the panel inside it goes see-through.

## Design

### Single shared preview (chosen) vs per-control mini previews

A **single shared Background preview** sits at the top of the Background
section, above the four controls. It renders a representative scene: a
backdrop layer with a **surface panel card** floating over it (a title + two
content lines), so all four effects are visible together and _composed_ —
which is how they actually combine in the app.

Per-control mini previews were rejected: the four settings are not independent
— surface opacity only matters _because_ there's a backdrop behind it, and blur
only reads against that same backdrop. Four separate boxes would each have to
re-create the other three settings to be honest, duplicating the scene four
times for no gain. One box that reflects all four together is both cleaner and
more truthful to the real surfaces, and it mirrors the single-card session
preview's visual language (uppercase label + a bordered sample).

### How it's driven (live, pre-persistence)

The box is bound to the **in-flight settings** from `useSettings()`, the same
source the controls write to via `update()`. `update()` applies immediately to
React state (persistence is debounced separately), so the preview re-renders on
the very same input event that moves the slider — no save required. This also
means it works in the browser preview where `window.agentDeck` is absent: the
proof box is fully drivable off local state.

The value→style mapping is a pure function, `bgPreviewStyle()` in
`webview/bg-preview.ts`, unit-tested without a DOM.

## What's a TRUE reflection vs an approximation

| Effect | Fidelity | How |
| --- | --- | --- |
| **Surface opacity** | **True reflection** | The panel card uses the _exact_ recipe of real surfaces — `color-mix(in srgb, var(--panel) calc(var(--surface-alpha) * 100%), transparent)` — with `--surface-alpha` set from the live value. Identical to `.sidebar` / `.termwrap` in `styles.css`. |
| **Background blur** | **True reflection** | The panel applies `backdrop-filter: blur(var(--bg-blur))`, the same property/variable the real surfaces use; `--bg-blur` is set from the live value. |
| **Background type** | **Faithful representation** | The real backdrop is a full-screen animated WebGL shader / CSS layer (`animated-bg.tsx`). Spinning up a second live shader instance for a thumbnail is heavy, so the box paints a small **static** but representative backdrop per type (aurora/flow/shader → drifting blobs frozen; mesh → multi-blob gradient; grid → line grid). It conveys the _character_ of each type, not a live animation. |
| **Background intensity** | **Faithful representation** | The backdrop's strength scales by the same intensity multiplier the real CSS layer uses (`subtle 0.6 / balanced 1 / vivid 1.6`, mirroring `MUL` in `animated-bg.tsx`), so "vivid" reads stronger than "subtle". The exact per-pixel output differs from the shader, but the relative strength is honest. |

The two effects users find hardest to judge blind — opacity and blur — are the
two that are pixel-exact. The shader animation is the only approximation, and
it's a static still rather than a fake.

The box is hidden when **Background = None** (no backdrop to preview), matching
the controls' own visibility rule.

## Acceptance

- A "Live preview" box appears at the top of Settings → Appearance → Background
  whenever a background is active, and is hidden when Background = None.
- Dragging **Background blur** changes the box's panel `backdrop-filter` live,
  before saving (verified: `blur(6px)` → `blur(24px)`).
- Dragging **Surface opacity** changes the box's panel background alpha live
  (verified: panel `rgba` alpha `0.7` → `0.15`).
- Changing **Background type** / **intensity** changes the rendered backdrop.
- The opacity/blur treatment is identical to the real surfaces (same CSS vars
  and `color-mix` / `backdrop-filter` recipe), not a lookalike.
- `bgPreviewStyle()` is pure and unit-tested (`test/unit/bg-preview.test.ts`).
- `npm run verify` and `npm run build` both pass.
