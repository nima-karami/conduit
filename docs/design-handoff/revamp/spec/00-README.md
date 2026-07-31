# Handoff: Conduit visual & UX revamp

## Overview

A full visual/UX revamp of **Conduit** — an Electron control tower for running several CLI coding
agents (Claude Code, Codex, aider) side by side, with a human-owns / agent-proposes review loop.

The revamp replaces the six existing themes with **three**, and introduces two axes the current
token system does not have: **shape** and **material**. It addresses the pain list in §7 of the
original brief: flat near-black shell (7.1), weak empty state (7.2), status too quiet (7.3),
review-as-diff-dump (7.4), buried Board/Canvas (7.8), and four stacked chrome bands (7.7).

## About the design files

The files in this bundle are **design references created in HTML** — prototypes showing intended
look and behaviour. They are **not production code to copy**. The task is to **recreate these
designs inside Conduit's existing renderer** (React + TypeScript, plain `styles.css` with CSS
custom properties, Monaco, xterm.js) using its established patterns.

Concretely: the designs use inline styles because that is how the prototyping environment works.
Conduit does **not**. Every value here must land as a **CSS custom property** in `styles.css`
under a `[data-theme]` / `[data-density]` selector — see `Conduit Token Contract`, which maps
every value to a variable and gives all three themes side by side.

## Fidelity

**High-fidelity.** Final colours, typography, spacing, radii and shadows. Recreate pixel-accurately.
Two caveats:

- Frames are drawn at **1320×820 at Comfortable density**. They are not a responsive spec; the
  density tokens are what generalise them.
- Contrast: three values sit below 4.5:1 (`--syn-comment` 3.58:1 on ink, white-on-`#d6922a`
  2.62:1, `--syn-keyword` 4.11:1). These are **deliberate and signed off**. Do not "fix" them.

## Themes

| id | label | ground | panel | accent | shape |
|---|---|---|---|---|---|
| `aero` | Aero | `#eceff4` | `rgba(255,255,255,.74)` | `#4a56c8` | round |
| `aero-dark` | Aero Dark | `#131419` | `#1b1d24` | `#8b95f0` | round |
| `neon` | Neon | `#07060d` | `#0a0812` | `#00f0ff` | sharp |

**Aero** — detached translucent panels on a two-radial tinted ground, 15–20px radii, one soft
shadow level. **Neon** — flush `#2a2145` hairlines, zero radius, a chamfered bottom-right corner
on every surface, a scanline wash and a slow vertical sweep.

The six existing themes (midnight, slate, nord, forest, paper, contrast) are **removed**. Stored
settings must be migrated — `_isKnownTheme()` validates against ids that will no longer exist.

## Shell geometry (identical in all themes)

Frame padding `12px` (Aero) / `0` (Neon) · panel gutters `11px` / `0`.

| Element | Value |
|---|---|
| Topbar height | `--density-topbar-h` — 40px Comfortable / 34px Compact |
| Centre tab row | `--density-tabbar-h` — 34px / 28px |
| Right-rail tabs | `--density-rtab-h` (**new token**) — 40px / 32px |
| Sessions panel | 266px fixed |
| Right rail | 340px fixed |
| Panel radius | `--r-panel` 20px / 0 |
| Card radius | `--r-card` 15px / 0 |
| Pill radius | `--r-pill` 13px / 0 |
| Chamfer inset | 14px (Neon only) |

**Theme must never change a height or a padding.** Spacing belongs to density; theme owns shape
and material only. Neon differs from Aero by material, not geometry.

### The chamfer needs its own border

`clip-path` cuts the border box, so a notched surface **loses its border along the diagonal**.
Every chamfered surface needs the diagonal drawn back in — a 2px absolutely-positioned span,
length `N × 1.414`, rotated −45°, in the element's own border colour (striped if the border is
dashed). This is the single most-missed detail in the whole design.

## Screens

Each is a separate HTML file, in both Aero and Neon.

| File | Screen | Notes |
|---|---|---|
| `Conduit Empty State` | 8a | §7.2. Per-panel empty states; three routes as a stacked list with shortcuts. `Reopen last` needs session history — drop it to two routes if unavailable. |
| `Conduit Code Editor` | 8b | Ink code panel (`#1b1e2b`) **in light Aero too**. Breadcrumb inside the panel, not as a fifth band. |
| `Conduit Changes Panel` | 8c | Staged / Changes groups; four status letters M A D U → `--warn --ok --bad --accent`. |
| `Conduit Settings Appearance` | 8d | All six sections from `appearance-sections.ts` (16 controls). Theme swatch is a window miniature, needs `ThemeDef.shape`. |
| `Conduit Feature Board` | 8e | §7.8. Agent-proposed flag; WIP counts on Planning/Building. |
| `Conduit Architecture Canvas` | 8f | §7.6. Node cards on a DOM budget; `48 / 500 nodes` chip is where the level-of-detail switch lives. |
| `Conduit Overlays` | 8g, 8h | New-session modal and the 12-item session context menu, shown over the real workspace. |
| `Conduit Design Language` | 5a–5e, 6a–6c | The source shell. **5b / 5e are the Review changes design** (§7.4) — not duplicated elsewhere. |

### Review changes (§7.4) — read this before building it

5b / 5e propose things that **do not exist today**: a left file list, per-file reviewed tracking,
a progress meter, a narrative "what the agent did" summary, and an Accept all / Discard footer.
The shipped screen is a single scroll of per-file accordions with one gutter. Treat 5b/5e as the
target and the current screen as the baseline — but scope them as new features, not restyling.

## Status system

Five states, each with a glyph **and** a word (safe under colour-blindness, no separate a11y path):

- **Busy** — accent dot, pulsing progress meter. The only state that animates.
- **Needs you** — amber, floats to the top of the sort, quotes the agent's actual prompt, offers
  Go to / Snooze.
- **Review** — terminates in a diffstat and links into Review changes.
- **Idle** — hollow dot, no meter, no colour.
- **Stale** — dimmed to 72%, dashed dot.

The topbar carries an aggregate chip ("2 need you" / "2 ALERTS"), suppressed at zero.

## Theme ↔ font coupling

Themes carry default font pairs; switching theme applies them; a user override wins and sticks.

```ts
// ThemeDef gains: fontUi, fontMono (ids from UI_FONTS / MONO_FONTS)
// aero, aero-dark → { fontUi: 'figtree', fontMono: 'plexmono' }
// neon            → { fontUi: 'chakra',  fontMono: 'jetbrains' }

// AppSettings gains two flags, default false:
//   fontUiPinned, fontMonoPinned
// setTheme(id):  if (!fontUiPinned)   fontUi   = theme.fontUi;
//                if (!fontMonoPinned) fontMono = theme.fontMono;
// user picks a font → set the matching *Pinned flag
```

Without the flags this is lossy either way: always-write destroys a chosen font on the next theme
switch; never-write leaves Neon in Hanken Grotesk for every existing user.

## Registry edits — `webview/themes.ts`

Exact diffs, plus the two new `ThemeDef` fields, are in the token contract. Summary:
`THEMES` drops to three entries; `ThemeDef` gains `shape` and the two font ids; `UI_FONTS`
appends Figtree and Chakra Petch. **`MONO_FONTS` needs no change** — JetBrains Mono and IBM Plex
Mono are already registered. Figtree and Chakra Petch must be added to the Google Fonts
`@import` in `styles.css` or the pickers offer faces the app cannot render.

## Files to touch

- `webview/styles.css` — move `--syn-*` out of `:root`-only into per-theme overrides; add the
  shape/material tokens; add `--density-rtab-h`; retune the density sets.
- `webview/themes.ts` — registries (above).
- `webview/monaco-theme.ts` — read `--syn-*` via `cssVar()` instead of hardcoded hexes.
  All three themes resolve to base `vs-dark`; **there is no light Monaco variant**.
- `webview/hljs-theme.css` — inherits `--syn-*`; two dark palettes only.
- `webview/xterm-theme.ts` — needs the Neon variant (`cursor: #00f0ff`).
- `webview/settings.tsx` + `components/settings-modal.tsx` — font-pinning flags, theme presets.
- Add a contrast test over `--syn-*`, `--code-*`, `--diff-*` per theme. A 20-token × 3-theme
  matrix is exactly where a hand-checked palette rots — it rotted repeatedly while this was designed.

## Still open

1. **Notch at Compact.** The chamfer is a fixed 14px inset, so on a shorter card it eats
   proportionally more. Scale with density, or cap on short surfaces.
2. **Sessions-panel header** is still theme-varying (Aero pads, Neon uses a 26px band). Fold it
   into the density treatment.
3. **Taller Settings modal.** Sixteen controls do not fit the current dialog; the design runs
   ~980px. Confirm against the running app.
4. **Canvas at scale.** The designs show full-detail nodes at 48. The level-of-detail rules past
   the threshold (drop ports, then subtitles, then title-only chips) are described but not drawn.

## Assets

`assets/conduit-icon.png` — the real app icon, used as the window mark and at 34px in the empty
state. Already in the repo at `assets/icon.png`.

Fonts: Figtree, Chakra Petch, IBM Plex Mono, JetBrains Mono, Archivo (documentation chrome only).
