# Follow-ups backlog (Agent Deck)

> Autonomous, depth-first. Skill: `deep-feature-build`. Branch: `followups` (off
> audit-fixes). Per item: plan/design → full build → verify → commit. Keep
> typecheck/build/tests green. Don't merge (user reviews).

## Status: [ ] todo  [x] done

### U1 — Reset settings / layout  [x]
Give the user a way to reset. Best spot: Settings → General → a "Reset" section with
two actions: **Reset layout** (panel order + widths + sidebar) and **Reset all
settings** (everything to defaults). Inline confirm so it isn't a footgun.

### U2 — Cross-file go-to-definition  [ ]
Today go-to-def only resolves within the open file. Load the active project's TS/JS
source files into Monaco as background models so the TS service resolves across
files. Host: batched read of many files (capped). Renderer: index on first code-file
open; set TS compiler options (allowJs, jsx, moduleResolution). Verify a definition
in another file resolves.

### U3 — Custom shader background  [x]
Let the user drop in GLSL fragment code used as the (animated gradient) background.
New background mode `custom`; setting `customShader: string`. Settings → Appearance
shows a textarea (+ drag-drop a .glsl/.frag file) with the documented uniforms
(u_time, u_res, u_c1..c3, u_alpha) and a default template. ShaderBg compiles the
custom source; on error show the compile log and fall back. Reuse the T2 WebGL setup.

## Notes
- Each: `docs/superpowers/specs/2026-06-10-uN-<name>.md`.
- Builds on T1–T6 (audit-fixes). See [[feedback-deep-feature-build]].
