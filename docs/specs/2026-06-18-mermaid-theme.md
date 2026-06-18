---
status: active
date: 2026-06-18
tier: LITE
type: UI
---

# Mermaid diagrams follow the app theme

## Problem frame

**Job:** When a user reads a doc with a Mermaid diagram, the diagram should look
like part of Conduit — using the active theme's colors — not a generic gray
`mermaid` dark palette that clashes with the surrounding rendered Markdown.

Today `webview/components/mermaid-diagram.tsx` calls
`mermaid.initialize({ securityLevel:'strict', startOnLoad:false, theme:'dark' })`
once at module load. The palette is fixed regardless of which of the 6 app themes
(midnight/slate/nord/forest/paper/contrast) is active — including the light
`paper` theme, where a dark diagram looks broken.

**Actors:** anyone viewing a `.md` file containing ```` ```mermaid ```` blocks.

**Success:** diagram node fills, borders, edges, labels, and background derive from
the app's CSS design tokens (`--accent`, `--panel`, `--text`, `--border`, etc.);
switching the app theme re-renders open diagrams to match.

**Non-goals:** per-diagram color overrides; a Mermaid theme picker; changing diagram
*layout*; restyling the error/loading states beyond what already exists.

## Behavior & states

Unchanged state machine (loading → rendered SVG → or error). New behavior:

- On first render, Mermaid is configured with `theme:'base'` + `themeVariables`
  derived from the **current** computed CSS variables on `document.documentElement`.
- When the app theme changes (`settings.theme`, and also `surfaceColor` since it
  feeds `--code-surface`/panel translucency), each mounted diagram **re-renders**
  with freshly-read variables. Mirror the terminal's live re-theme seam
  (`terminal-pane.tsx` re-applies `buildXtermTheme` on `settings.theme` change,
  inside a `requestAnimationFrame` so `SettingsProvider` has applied the new
  `data-theme` attribute before CSS vars are read).
- Light themes (`paper`) must produce a legible light diagram — `theme:'base'`
  supports both; correct token mapping is what makes it work, not a darkMode flag.

## Data / interface contract

New module `webview/mermaid-theme.ts` (mirrors `xterm-theme.ts`):

- `buildMermaidThemeVariables(cs: CSSStyleDeclaration): Record<string,string>` —
  **pure** mapping from computed style to Mermaid `themeVariables`. Unit-testable
  with a fake `CSSStyleDeclaration` (a `getPropertyValue` stub). Maps at minimum:
  - `background` ← `--bg`
  - `primaryColor` (node fill) ← `--panel` (or `--raise`)
  - `primaryTextColor` / `secondaryTextColor` / `tertiaryTextColor` ← `--text`
  - `primaryBorderColor` ← `--border-2` (fallback `--border`)
  - `lineColor` (edges) ← `--text-dim`
  - `secondaryColor` ← `--raise`, `tertiaryColor` ← `--panel-2`
  - `fontFamily` ← `--font-ui`
  - sequence/label tokens: `actorBkg`/`actorBorder`/`labelBoxBkgColor`/`noteBkgColor`
    mapped to the same panel/accent tokens so sequence diagrams are themed too.
  - `mainBkg`, `clusterBkg`, `clusterBorder`, `nodeBorder`, `edgeLabelBackground`.
  Every lookup uses `cssVar(cs, name, fallback)` with a sane hardcoded fallback so a
  missing variable never yields an empty string (which Mermaid would choke on).
- `buildMermaidConfig(cs)` → `{ securityLevel:'strict', startOnLoad:false,
  theme:'base', themeVariables: buildMermaidThemeVariables(cs) }`.

`MermaidDiagram` calls `mermaid.initialize(buildMermaidConfig(getComputedStyle(
document.documentElement)))` immediately before each `mermaid.render(...)`, and adds
the current theme to its render effect's dependencies so a theme change re-runs it.

## Edge cases & failure modes

- **Missing/empty CSS var** → fallback hex used (no empty themeVariables).
- **Concurrent diagrams** → Mermaid config is global; all diagrams share one theme,
  so re-initializing before each render is consistent (no per-diagram divergence).
- **`securityLevel:'strict'` preserved** — the `dangerouslySetInnerHTML` of the SVG
  depends on it; the config helper must keep it. (Anti-regression.)
- **Theme switch while a diagram is mid-render** → the existing `cancelled` guard in
  the effect already prevents a stale SVG from being committed.
- **`getComputedStyle` returns stale vars if read before `data-theme` flips** →
  the rAF defer (as in terminal-pane) avoids this.

## Defaults vs. settings

No new setting. The diagram theme always tracks the app theme — that is the safe
80% behavior and the whole point. Rationale: a separate Mermaid theme control would
be divergent surface for no real demand.

## Scope slicing

- **MVP:** `theme:'base'` + token mapping for flowchart + sequence; re-render on
  `settings.theme` change. Verified in midnight (dark) and paper (light).
- **Out of scope:** gantt/pie/class-diagram-specific token tuning beyond the shared
  mapping; animated theme transitions.

## Acceptance criteria

- AC1: A flowchart in the preview harness under the default (midnight) theme renders
  with node fills/borders/edges in the app palette (accent/panel/text), **not** the
  Mermaid default gray. (playwright screenshot)
- AC2: `buildMermaidThemeVariables` returns a fully-populated object (no empty-string
  values) given a stub that returns '' for every var — i.e. fallbacks apply. (unit)
- AC3: `buildMermaidConfig` keeps `securityLevel:'strict'` and `theme:'base'`. (unit)
- AC4: Switching the harness `<html data-theme>` to `paper` and re-rendering yields a
  light-background diagram with dark text (legible). (playwright screenshot)
- AC5: `npm run verify` stays green; existing `mermaid-block.test.ts` still passes.

## Decisions Needed

none — all mappings are reversible taste defaults; chosen the conservative
"track app theme, no new setting" path.
