# Blockers & open calls — 2026-08-01 state vocabulary

Items a lane deliberately did not resolve on its own. Each carries a recommendation.

## V-1 — Neon's hover wash: neutral, or tinted toward the accent?

The spec's D1 says hover is a neutral wash **everywhere**; the lane brief allows Neon to
"tint its hover slightly toward accent" as the place the theme's personality lives. Those
two do not agree, and it is a taste call, not a correctness one.

Lane V shipped **neutral** in all three themes (`--state-hover-bg: rgba(var(--overlay),
0.09)` under Neon, one step hotter than the other two because its panels are near-black).
Reasoning: the user's own report was that hovering the git-band icons "goes neon", and an
accent-tinted hover is the same answer at lower volume. Neon's personality is carried by
the selected/on steps instead, which are cyan and already glow.

**Recommendation:** keep neutral. If the conductor disagrees it is a one-line change —
`[data-theme="neon"] { --state-hover-bg: color-mix(in srgb, var(--accent) 7%, transparent); }`
— and nothing else in the sheet has to move.

## V-2 — `.right__tabs` geometry moved (coordination note for lane B)

`.rtab` shipped with `padding: 0`, so it had no body for a hover fill to paint: the wash
came out as a hard rectangle cut to the width of the word. The fix moves the row's `gap`
onto the tabs (`.right__tabs` `gap: 18px → 0`, `padding: 0 14px → 0 5px`; `.rtab`
`padding: 0 → 0 9px`), which reproduces the shipped 14px lead and 18px spacing exactly
while giving each tab a box it owns.

This touches the band lane B is also working in. No conflict is expected — the change is
horizontal only and leaves `--density-rtab-h` and the bottom hairline untouched — but the
two diffs land in the same rule.

**Recommendation:** integrate V first; lane B rebases onto it.
