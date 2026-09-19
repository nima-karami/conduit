# Decisions taken during autonomy — 2026-09-18 html-viewer

Unattended run: every would-be user approval is recorded here as an assumption with
its reasoning, so the user can course-correct cheaply.

## Palette rows: conditional listing, not "always listed, disabled" — 2026-09-18

**Spec §9 said:** the three HTML palette commands are *always listed* and `disabled` with a
reason when the active doc is not HTML, on the principle that discoverable beats hidden.

**Measured:** `PaletteEntry` (`webview/components/command-palette.tsx:7-26`) has **no `disabled`
field**. The row renderer has no disabled state, no disabled styling, and calls `entry.run()`
unconditionally on both click and Enter. So "disabled with a reason" is not a state the palette
can currently express — the spec specified a capability rather than using one.

**Decision: ship the conditional listing** (the rows appear for an HTML doc and not otherwise),
which is exactly the pre-existing pattern `cmd:openInBrowser` already used. The executor was
right to refuse the alternative — an always-listed row that silently no-ops is worse than an
absent one, because it teaches the user the command is broken rather than inapplicable.

**Deliberately NOT done as a drive-by:** giving the palette a real disabled row is ~15 lines
across `command-palette.tsx` and `styles.css`, and it is a palette-wide capability that would
change how every future command can present itself. That deserves its own slice and its own
before/after look, not a widening tucked inside an HTML-viewer change list.

**Reversible:** once the palette can render a disabled row, these three entries become
always-listed by deleting a conditional. Nothing here has to be unwound first.
