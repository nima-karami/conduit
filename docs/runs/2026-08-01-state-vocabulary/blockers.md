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

## G-1 — the band's chip triggers took a real border, reversing V's call (shipped)

V put `.git-indicator__branch--switchable` and `.repo-picker__trigger` in the **quiet**
role and drew "open" as an inset ring, reasoning that "adding a real border would move
them 2px in a fixed-height band". G's brief says the opposite — make the branch picker
read as `.search__filterstoggle`, i.e. a **field**. G took the brief, and V's objection
does not survive contact: `box-sizing: border-box` is global, so a border costs zero
height and 2px of width on a chip that is `flex: 0 1 auto` in a scrollable row. Nothing
moves. The reference the user named is a field, and the third trigger on that same band
(`.gitband__source`, which is `.gh__reffilter`) has always been a bordered field — so the
quiet chips were the odd two out, not the odd one.

Shipped: both chips carry `border: 1px solid var(--state-edge)` at rest and sit in the
field lists; the inset-ring special case is **deleted**, since "open" is now expressible
as a border colour like every other field in the app.

**Recommendation:** keep. **Revert path:** `git revert ca27bfc` restores V's ring
wholesale; there is no partial revert worth taking, because the ring exists only to
compensate for the missing border.

**Watch item for lane B.** The same root cause as B's Cause 1, one band down: Neon's
`.tabbar-wrap` border-bottom participates in layout, so every control sized from
`--density-tabbar-h` is a pixel taller than the row's content box and straddles the
divider. G fixed the trailing group (`.tabbar__trail` stretches; its children take
`calc(100% - 2 * var(--tab-inset))`) and `.tabbar__overflow-btn`. **`.tab` is deliberately
left alone** — it keeps an explicit height for a documented reason (the strip's overflow
scrollbar shaves the flex content box, `styles.css` ~2040), so unpicking it belongs with
B's band-alignment work, not here.

**RULING (conductor): taken by the conductor** as part of the B-1 fix below — the
tabbar geometry is settled now that B has landed.

## B-1 — Neon still stacks two hairlines above the side panels, and only the side panels

Fixing the band baseline (lane B) left one residue that is Neon-only and is a design call, not
a bug I own.

At Neon `--win-pad` and `--gutter` are both 0, so the top bar sits flush on the workbench. The
top bar draws its own bottom border and each side panel draws its own top hairline, one device
row apart — measured at 1320x820, Comfortable: y=56 `47,39,74` (top bar) and y=57 `48,40,75`
(panel ring). The centre column is deliberately not a panel, so it has no ring and reads a
single row there. Net effect: at Neon the side bands still carry a 2px edge where the centre
carries 1px — the same asymmetry the user reported, from a different cause. It predates the
lane (the pre-fix capture shows the identical two rows) and Aero / Aero Dark are unaffected,
because their gutter separates the two surfaces.

Two ways out, both of which change something a previous decision fixed deliberately:

1. Suppress the panels' TOP edge at Neon, letting the top bar's bottom border be the shared
   edge. Consistent, and it matches how `.tabbar-wrap` already gets a Neon-only bottom border
   for the same flush-layout reason — but it puts geometry in the "Neon shell" block, whose
   comment states outright that only colour and material live there.
2. Give the centre column a top edge at Neon so all three read 2px. Cheaper to describe, but
   it walks back "the centre column is NOT a panel", which frame 5a decided on purpose.

**Recommendation:** (1), written as a general flush-layout rule rather than a panel special
case — at zero gutter, the surface below a bordered band does not redraw that band's edge. If
the "colour and material only" line in the Neon shell block is to hold, the rule belongs in the
panel block guarded by the theme, not in the shell block.

**RULING (conductor): option 1, exactly as framed.** This is the user's reported defect
surviving at Neon from a second cause, so it ships in this run rather than becoming a
follow-up. Option 2 is rejected: "the centre column is not a panel" is a deliberate
structural decision and walking it back to equalise a border would be the tail wagging
the dog. The rule goes in the panel block guarded by the theme — putting geometry in the
Neon shell block would break that block's stated colour-and-material-only contract, which
is the sort of erosion this run exists to reverse. Conductor implements.
