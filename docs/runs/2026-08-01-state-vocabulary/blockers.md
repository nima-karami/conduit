# Blockers and forks — 2026-08-01 state vocabulary + chrome polish

Design forks a lane hit but does not own. Each one names the call it would make.
Conductor rulings are recorded inline as they are made.

## I-1 — Compare moved from Lucide to the chrome tier (shipped, wants ratification)

`IconCompare` was the one glyph in `icons.tsx` drawn by Lucide (`GitCompareArrows`, 24 grid,
hand-tuned `strokeWidth={1.7}`). Under Neon that made it the only chrome icon a theme could not
reshape: it kept round nodes and round caps while `IconBranch` and `IconHistory` — its immediate
neighbours in the git band — went to square pips.

There is no way to give a foreign 24-grid component a Neon variant without nesting one `<svg>`
inside another, so the fork is: leave one soft glyph in the git band, or redraw it on the 16 grid.

**Taken:** redrawn, as a faithful transcription of the Lucide path (two circles, two lanes,
opposed arrows) so Aero and Aero Dark look the same as they did. That also deleted the
`.icon--lucide` stroke-rescale rule and its magic factor.

**Recommendation:** keep. **Revert path:** restore the six-line `IconCompare` from
`git show bcf0d15:webview/icons.tsx` and drop the `compare` key from `NEON_GEOMETRY` — nothing
else depends on it.

**RULING (conductor): keep.** The chrome tier's premise is hand-authored 16-grid glyphs; a
Lucide component inside it was the anomaly, not the fix. Deleting the magic stroke-rescale
factor is a further argument for it.

## I-2 — The content tier stays round under Neon

The tier split is the conductor's: chrome (hand-authored, `icons.tsx`) is theme-coupled, content
(Lucide — file-type icons, session glyphs) is not, because `iconOverride` persists Lucide
kebab-case names to `sessions.json`. Holding that line has a visible cost now that chrome is
sharp: the Files rail is a column of round Lucide folder/file glyphs sitting beside a squared-off
explorer chrome, and a session card with a custom icon shows a round glyph on a chamfered card.

**Recommendation:** a separate lane, and NOT a family swap. The contract is about *names*, not
about rendering — a Neon-only CSS pass over the content tier (`stroke-linecap`/`linejoin`, plus
`rx` on the file-icon rects) would sharpen the ends and corners while every persisted name keeps
resolving to the same Lucide component. Curved bodies would stay curved, which is the honest
ceiling without redrawing a third-party set.

**RULING (conductor): accepted, scheduled as lane C.** A family swap remains forbidden.

## V-1 — Neon's hover wash: neutral, or tinted toward the accent?

The spec's D1 says hover is a neutral wash **everywhere**; the lane brief allows Neon to
"tint its hover slightly toward accent" as the place the theme's personality lives. Those
two do not agree, and it is a taste call, not a correctness one.

Lane V shipped **neutral** in all three themes (`--state-hover-bg: rgba(var(--overlay),
0.09)` under Neon, one step hotter than the other two because its panels are near-black).
Reasoning: the user's own report was that hovering the git-band icons "goes neon", and an
accent-tinted hover is the same answer at lower volume. Neon's personality is carried by
the selected/on steps instead, which are cyan and already glow.

**Recommendation:** keep neutral.

**RULING (conductor): neutral, as shipped.** The spec's D1 governs; the lane brief's
looser wording was mine and is superseded. The reported defect was literally
neon-on-hover, and a quieter accent tint is the same answer at lower volume.

## V-2 — `.right__tabs` geometry moved (coordination note for lane B)

`.rtab` shipped with `padding: 0`, so it had no body for a hover fill to paint: the wash
came out as a hard rectangle cut to the width of the word. The fix moves the row's `gap`
onto the tabs (`.right__tabs` `gap: 18px → 0`, `padding: 0 14px → 0 5px`; `.rtab`
`padding: 0 → 0 9px`), which reproduces the shipped 14px lead and 18px spacing exactly
while giving each tab a box it owns.

**Recommendation:** integrate V first; lane B rebases onto it.

**RULING (conductor): done.** V merged first; B, P, R, G and C all branch from post-V main.

## V-3 — the vocabulary section's position is load-bearing (conductor note)

Not raised by a lane, but discovered by one and worth recording. `:where(…):hover` scores
exactly one class, which **ties** a component's own `.tab { background: transparent }`
rest rule — so the ladder only wins by being later in the sheet. Placed at the top it
loses silently and hover does nothing at all; unit tests and lint both stayed green when
that happened, and only a screenshot caught it.

Source-order reliance is a banned smell in `CLAUDE.md`, so this is a deliberate exception:
the alternative is raising the ladder to `:is()` (two classes), which then ties every
deviation rule (`.btn--danger:hover`) and starts the specificity arms race that CLAUDE.md
bans more strongly. Exclusions are named explicitly in `:not()` lists rather than left to
out-order the ladder, so the ordering dependence is confined to this single invariant, and
`test/unit/state-vocabulary.test.ts` pins it.
