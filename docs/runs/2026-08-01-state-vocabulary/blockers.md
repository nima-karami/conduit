# Blockers and forks — 2026-08-01 state vocabulary + chrome polish

Design forks a lane hit but does not own. Each one names the call it would make.

## I-1 — Compare moved from Lucide to the chrome tier (shipped, wants ratification)

`IconCompare` was the one glyph in `icons.tsx` drawn by Lucide (`GitCompareArrows`, 24 grid,
hand-tuned `strokeWidth={1.7}`). Under Neon that made it the only chrome icon a theme could not
reshape: it kept round nodes and round caps while `IconBranch` and `IconHistory` — its immediate
neighbours in the git band — went to square pips. Screenshot before the change:
`crop-neon-gitband.png`, the fourth glyph.

There is no way to give a foreign 24-grid component a Neon variant without nesting one `<svg>`
inside another, so the fork is: leave one soft glyph in the git band, or redraw it on the 16 grid.

**Taken:** redrawn, as a faithful transcription of the Lucide path (two circles, two lanes,
opposed arrows) so Aero and Aero Dark look the same as they did. That also deleted the
`.icon--lucide` stroke-rescale rule and its magic factor.

**Recommendation:** keep. **Revert path:** restore the six-line `IconCompare` from
`git show bcf0d15:webview/icons.tsx` and drop the `compare` key from `NEON_GEOMETRY` — nothing
else depends on it.

## I-2 — The content tier stays round under Neon (not resolved; needs a lane if it matters)

The tier split is the conductor's: chrome (hand-authored, `icons.tsx`) is theme-coupled, content
(Lucide — file-type icons, session glyphs) is not, because `iconOverride` persists Lucide
kebab-case names to `sessions.json`. Holding that line has a visible cost now that chrome is
sharp: the Files rail is a column of round Lucide folder/file glyphs sitting beside a squared-off
explorer chrome, and a session card with a custom icon shows a round glyph on a chamfered card.

This is the biggest remaining softness in Neon and it is not something this lane can fix without
touching the persisted-name contract.

**Recommendation:** a separate lane, and NOT a family swap. The contract is about *names*, not
about rendering — a Neon-only CSS pass over the content tier (`stroke-linecap`/`linejoin`, plus
`rx` on the file-icon rects) would sharpen the ends and corners while every persisted name keeps
resolving to the same Lucide component. Curved bodies would stay curved, which is the honest
ceiling without redrawing a third-party set.
