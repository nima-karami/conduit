# Blockers & queued decisions

Quarantined work and design forks a lane hit that the conductor must resolve. Nothing here is
faked or stubbed — an item that cannot be built honestly is recorded with its reason.

_None yet._

## Known open questions carried from the handoff (§"Still open")

These are the designer's own open items. Each lane that meets one records what it did here.

1. **Notch at Compact.** The chamfer is a fixed 14px inset, so on a shorter card it eats
   proportionally more. Scale with density, or cap on short surfaces.
2. **Sessions-panel header** is still theme-varying in the frames (Aero pads, Neon uses a 26px
   band). Must fold into the density treatment — theme may not set a height.
3. **Taller Settings modal.** Sixteen controls don't fit the current dialog; the design runs
   ~1060px. Confirm against the running app.
4. **Canvas level-of-detail past the node threshold** (drop ports → subtitles → title-only chips)
   is described but not drawn.
