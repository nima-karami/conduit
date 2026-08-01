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
| Q5 | `electron/main.ts` still hardcodes `backgroundColor: '#0c0d10'`, so an Aero user gets a dark flash before first paint. | **F1** — **resolved**, see below |
| Q6 | The notch is a flat 14px, which on a ~26px control eats proportionally more than the frames show (~9px). This is the handoff's own open item #1. | **F1** — **ruled**, see below |

### Q5 resolved (F1)

`createWindow()` now reads the persisted theme and paints that theme's ground:
`backgroundColor: groundForTheme(restoreSettings(readBlob(settingsFile())).theme)`. The map
lives in `src/theme-ground.ts` — the value is needed before any stylesheet exists, so it cannot
be read from `styles.css`; `test/unit/shell-tokens.test.ts` asserts it against each theme's
registry swatch so the two cannot drift. A missing, unreadable or unrecognised setting falls
back to Aero Dark, which is what `:root` resolves to anyway.

### Q6 ruling (F1) — cap by surface height, do not scale with density

`--notch-sm: min(var(--notch), 9px)`, declared beside `--notch` in `:root`.

**A short surface re-points `--notch` at `--notch-sm`**; every chamfer rule already reads
`var(--notch)` off the element, so the cap needs no parallel selector list:

```css
[data-theme="neon"] :is(.btn, .chamfer--sm) { --notch: var(--notch-sm); }
```

Short means **a surface whose height is around 3× the notch or less** — buttons, badges,
chips, pills, tab and topbar controls. Panels, cards, modals and menus keep the full 14px.
`.chamfer--sm` is the utility for anything not in the selector list (it is `.chamfer` with
the cap, and is already wired into the clip-path + diagonal rules).

**Why not density.** Density would tie the cut to a mode rather than to the thing being cut,
and it fixes the wrong half of the problem: a 26px button eats a third of its own height at
*Comfortable* too. `--notch` is also theme-declared, so a `[data-density="compact"]` block
setting it would leak a notch into Aero, where it must stay 0. Height is the real variable —
so height is what caps it. 9px is the handoff's own quoted figure for the same case.

_(F1 also changed the two zero-valued shape tokens from `0` to `0px`. `--win-pad` and
`--gutter` are read inside `calc()` by the fixed board/canvas overlays, and a unitless zero
there invalidates the whole declaration — which silently dropped the Neon board to its static
position. Any lane adding a zero-valued length token: give it a unit.)_

### Q3 ruling (F4) — the code/doc surface takes NO notch; `.rcard` still F5's call

**The doc panel (`.termwrap` and everything inside it) stays square in Neon.** Not an omission
from F0's selector list — the frames show it square. 8b's code panel and 5d's terminal both run
flush into the window's bottom-right corner with only the `#2a2145` hairline; a probe of
`code-editor-02.png` at (930–990, 770–820) finds no diagonal.

**Why it is right, not just what was drawn.** At Neon `--win-pad` and `--gutter` are `0`, so the
doc panel *is* the ground plane in its corner — there is nothing behind it for a cut to reveal.
The notch is a corner treatment for a surface sitting ON something; cutting the bottom-right here
would carve a wedge out of the window itself and leave the diagonal drawn against the desktop.
The design language says as much: "the notch only cuts filled surfaces… bordered chrome stays
square."

`.rcard` is left to **F5** (F4 must not touch the Review surface this wave). The language's own
sentence — "14px corner notch on filled surfaces **and on cards**" — points at notching it; the
cards are short enough that F1's Q6 cap likely applies, i.e. `.chamfer--sm`.

_No blocked lanes._

## Operational hazard hit during the run — read before touching worktrees

Lane worktrees live at `G:\awby\conduit-wt\<lane>` with `node_modules` as a **Windows directory
junction** into the main checkout, so three lanes share one install instead of three.

**`git worktree remove --force` followed those junctions and deleted the contents of the shared
`node_modules`** — the main checkout was left with an empty `node_modules` mid-run. Source was
untouched (git), and `npm ci` restored it, but it cost a full reinstall.

**Teardown order, always:** delete the junction first (`cmd /c rmdir "<wt>\node_modules"` — removes
the link, never the target), *then* remove the worktree. Never let a recursive delete near a live
junction.

## Known open questions carried from the handoff (§"Still open")

These are the designer's own open items. Each lane that meets one records what it did here.

1. **Notch at Compact.** The chamfer is a fixed 14px inset, so on a shorter card it eats
   proportionally more. Scale with density, or cap on short surfaces.
   → **F1: capped on short surfaces** (`--notch-sm`, 9px). Full ruling under Q6 above.
2. **Sessions-panel header** is still theme-varying in the frames (Aero pads, Neon uses a 26px
   band). Must fold into the density treatment — theme may not set a height.
   → **F2: one density-owned band; theme changes only the label's case.** `.sidebar__head`
   keeps the height F1 gave it — `var(--density-tabbar-h)` (40/34 Comfortable, 28 Compact) —
   so the sessions header sits between the same two dividers as the centre tab row in all
   three themes, and no `[data-theme]` block sets a height, padding or gap on it. The whole
   Aero-vs-Neon difference the frames show is now type: `.panel-title` reads
   `--label-case` / `--label-track` / `--label-weight` instead of a hardcoded
   `text-transform: uppercase`, so Aero renders "Sessions" and Neon "S E S S I O N S" from
   one string (D14). The `2 live` count rides inside the same band as a sibling. Neon's 26px
   is not reproducible without theme owning height, and it was the thing the contract
   forbids — dropped deliberately, not missed.
3. **Taller Settings modal.** Sixteen controls don't fit the current dialog; the design runs
   ~1060px. Confirm against the running app.
4. **Canvas level-of-detail past the node threshold** (drop ports → subtitles → title-only chips)
   is described but not drawn.
