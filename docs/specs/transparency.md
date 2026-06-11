# Spec — Full-range panel transparency + granular code-block styling (C3)

**Tier:** FULL · **Type:** UI · **Slug:** `transparency`

## Problem frame

**Job-to-be-done:** As a Conduit user tuning the look, I want the panel/surface
transparency to span the *full* 0–100% range (today it stops at 40%), and I want to
style the code blocks (Markdown `pre` blocks and, ideally, the Monaco editor surface)
**independently of the panel** — pick a background colour and its own transparency —
so a code block can be solid black, or darker/lighter and more translucent than the
panel around it.

**Actors:** single local user via Settings → Appearance.

**Success outcomes:**
- The "Surface opacity" slider reaches 0% and a 0% value renders a fully transparent
  panel (only the animated backdrop shows).
- A new code-block control sets the code-block background **colour** and a separate
  **opacity** (0–100%), applied to `.markdown pre` (and the Monaco editor surface),
  independent of `surfaceOpacity`.
- Defaults reproduce the current look (no visible change until the user opts in).
- Settings persist and back-compat: blobs missing the new fields restore to defaults.

**Non-goals:**
- No per-language or per-block overrides (one global code-block style).
- No theme-aware automatic colour; the colour is a single user value with a default.
- Not redesigning the background/blur system.

## Behaviour & states

State lives in `AppSettings` (Electron main, mirrored to the renderer). Three relevant
fields:

| Field | Type | Range | Default | Drives |
|---|---|---|---|---|
| `surfaceOpacity` | number | **0..1** (was 0.4..1) | `0.7` | `--surface-alpha` |
| `codeBg` | string (hex `#rrggbb`) | — | `#0a0b0e` | `--code-bg` (base colour) |
| `codeOpacity` | number | 0..1 | `1` | `--code-alpha` |

Derived CSS variable `--code-surface = color-mix(--code-bg, transparent by --code-alpha)`,
applied to `.markdown pre` and `.codeblock`, replacing the hardcoded `#0a0b0e`.

**Transitions:** every settings change applies live (existing debounced-persist path in
`webview/settings.tsx`). No async/failure states — pure CSS-variable application.

**Editor surface (Monaco):** `webview/monaco-theme.ts` builds `editor.background` from
`--code-bg` + `--code-alpha` via the existing `withAlpha()` pattern (shared from
`xterm-theme.ts`). When alpha < 1, the editor canvas paints a translucent background;
the `.center` container behind the editor must therefore NOT paint an opaque surface for
the code-viewer case, or the translucency would composite over the panel instead of the
backdrop. See Decisions Needed (editor translucency constraint).

## Data / interface contract

`restoreSettings()` validation (`src/settings.ts`):
- `surfaceOpacity`: `clampNum(raw, 0, 1, default)` — **min changed 0.4 → 0**.
- `codeOpacity`: `clampNum(raw, 0, 1, default 1)`.
- `codeBg`: validated hex `#rrggbb` (case-insensitive); invalid/missing → default
  `#0a0b0e`. A small `hexColor(v, def)` helper.

Invariants: output is always a complete `AppSettings`; unknown keys dropped; version
gate unchanged (`VERSION = 1`, additive fields are forward/back compatible because
missing → default).

## Edge cases & failure modes

- **Missing new fields (old blob):** → defaults (back-compat). Covered by test.
- **Out-of-range opacity** (`-0.5`, `5`, `NaN`, string): clamped/defaulted.
- **Malformed colour** (`'red'`, `'#fff'`, `'#xyzxyz'`, number): → default `#0a0b0e`.
- **0% panel opacity:** legitimately fully transparent — honoured (the user asked for
  the full range). Text/legibility is the user's tradeoff; not clamped.
- **`data-background="none"`:** surfaces are opaque (`--surface: var(--bg)`); the
  code-block colour/alpha still applies to `.markdown pre` regardless of backdrop, so a
  translucent code-block over an opaque panel just shows the panel colour through it —
  acceptable and consistent.

## Defaults vs settings

- `surfaceOpacity` default unchanged (`0.7`); only the **min** widens to 0.
- `codeBg = #0a0b0e`, `codeOpacity = 1` → byte-identical to today's hardcoded look.
- New controls live under Appearance, grouped near Surface opacity (an "appearance"
  cluster), shown regardless of background mode (code-block styling is independent of
  the animated backdrop).

## Scope slicing

- **MVP:** panel min 0; `codeBg` + `codeOpacity` settings; CSS var on `.markdown pre`
  + `.codeblock`; Settings UI (colour input + opacity slider); persistence + tests.
- **v1:** wire the Monaco editor surface to the same `--code-bg`/`--code-alpha` so the
  editor can be translucent too (via `withAlpha` + transparent `.center` for the
  editor case).
- **Out of scope:** per-language styling, theme-derived auto colours, border/padding
  controls for code blocks.

## Acceptance criteria

**EARS:**
- The system SHALL allow `surfaceOpacity` to be set anywhere in 0–100% inclusive.
- WHEN `surfaceOpacity` is 0, the system SHALL render the panel surface fully
  transparent (only the backdrop visible).
- The system SHALL apply `codeBg` and `codeOpacity` to `.markdown pre` and `.codeblock`
  independent of `surfaceOpacity`.
- WHEN a settings blob omits `codeBg`/`codeOpacity`/uses old `surfaceOpacity`, the
  system SHALL restore defaults reproducing the prior look.
- IF `codeBg` is not a valid `#rrggbb` hex, the system SHALL fall back to `#0a0b0e`.

**Gherkin:**
```
Scenario: Full-range panel transparency
  Given the Settings → Appearance pane
  When I drag the Surface opacity slider to its minimum
  Then the value reads 0% and the panel becomes fully transparent

Scenario: Independent code-block styling
  Given a Markdown file with a fenced code block is open
  When I change the code-block background colour and opacity in Settings
  Then the rendered code block's background updates to that colour/opacity
  And the surrounding panel opacity is unchanged
```

## Accessibility & i18n

- Colour input: native `<input type="color">` (keyboard-operable, OS-native a11y) with
  an adjacent text label; opacity slider reuses the existing `Slider` (range input,
  already keyboard-accessible). New sections use the existing `Section` label/desc
  pattern, so they get the same heading semantics.
- i18n: app is English-only (no i18n framework present); strings inline, consistent
  with all existing settings copy. No new i18n surface introduced.
- Contrast: 0% opacity can hurt legibility — this is user-driven and explicitly
  requested; we do not auto-clamp. Defaults preserve current contrast.

## Design tokens

Reuse design variables: base colour default references the existing `#0a0b0e`
(replaced by a `--code-bg` variable). `--code-surface` derived via `color-mix`, same
mechanism as `--surface`/`--surface-panel`. No new raw hex introduced in CSS beyond the
default token value.

## Decisions Needed

- **[normal] Editor-canvas translucency wiring.** Monaco paints its background on a
  canvas; to make it translucent the `.center` container behind the code viewer must be
  transparent for the editor case so the backdrop shows. Chosen approach: drive
  `editor.background` from `--code-bg`+`--code-alpha` via `withAlpha`, and make the
  editor viewer surface transparent so its own (possibly translucent) background
  composites over the backdrop. If this causes Monaco rendering artifacts, fall back to
  keeping the editor opaque (`codeOpacity` still applies to `.markdown pre`) and note
  the constraint. Reversible (a CSS/theme tweak).
- **[normal] Code-block control visibility.** Shown always (not gated on background
  mode), since code styling is independent of the backdrop. Reversible.
- **[normal] Colour input type.** Native `<input type="color">` (returns `#rrggbb`),
  simplest a11y-correct picker; no custom colour UI. Reversible.

## Self-audit

All template sections addressed: problem frame, states, data contract, edge cases,
defaults, scope, acceptance (EARS+Gherkin), a11y/i18n, design tokens, decisions, audit.
Nothing outstanding.
