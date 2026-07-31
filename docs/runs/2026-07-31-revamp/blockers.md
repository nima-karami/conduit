# Blockers & queued decisions

Quarantined work and design forks a lane hit that the conductor must resolve. Nothing here is
faked or stubbed — an item that cannot be built honestly is recorded with its reason.

## Queued by F0 (token foundation) — routed, not blocking

| # | What | Routed to |
|---|---|---|
| Q1 | `surfaceColor` is now theme-seeded, but switching theme at runtime does not re-derive it — it needs a third pinned flag alongside `fontUiPinned` / `fontMonoPinned`. | **F6** (owns the Appearance surface) |
| Q2 | Aero renders markdown and Review on the ink `.termwrap`, so F0 scoped the on-ink text tiers there. The contract implies a markdown *document* should sit on the light page with ink code chips only. | **F5** |
| Q3 | `.rcard` (Review file cards) is not in the chamfer selector list. | **F4** / **F5** |
| Q4 | `.ctxmenu` scrolls (`overflow-y:auto`), so on a long menu the chamfer diagonal parks at the bottom of the scroll content rather than the visible edge. | **F6** |
| Q5 | `electron/main.ts` still hardcodes `backgroundColor: '#0c0d10'`, so an Aero user gets a dark flash before first paint. | **F1** |
| Q6 | The notch is a flat 14px, which on a ~26px control eats proportionally more than the frames show (~9px). This is the handoff's own open item #1. | **F1** to resolve for the shell; whoever needs it first sets the rule |

_No blocked lanes._

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
