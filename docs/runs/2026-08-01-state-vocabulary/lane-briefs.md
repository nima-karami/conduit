# Lane briefs — S, B, P, R, G

Written by the conductor before dispatch. The design calls here are settled; lanes
implement them. A lane that disagrees records the objection in `blockers.md` and
proceeds — it does not re-decide.

All five wait for **V** to land, then fan out. `webview/styles.css` is the shared
entry file, so merges are serialised.

---

## S — Remove the collapse-sidebar button (LITE)

**Why.** The button (`top-bar.tsx:120-127`) is incoherent: panels can be re-docked
to either side by dragging (`dock-reorder.ts`), so "collapse the left one" has no
stable referent; only Sessions has a button while Explorer has none; and it spends
topbar space on a control the user does not reach for.

**Do.** Delete the button and its `onToggleSidebar` prop threading. Keep every other
route — they already exist and cover both panels symmetrically:
- command palette: `app.tsx:2093-2108` (both panels)
- context menu: `app.tsx:1854-1866`, bound on the topbar and both panel frames
- keyboard: `Mod+B` / `Mod+Shift+E` (`shortcuts.ts:64-70`)

`IconSidebar` stays — the palette command still uses it. Confirm the dead-code gate
(`npm run fallow:check`) is green after removal; if it flags something, delete it
rather than suppressing it.

**Do not** add a replacement button for the Explorer. The point is removal.

---

## B — Band baseline alignment (LITE)

Two independent root causes; fix both at source. Magic offsets that cancel each
other are banned (`CLAUDE.md`).

**Cause 1 — the panel border participates in layout.** `.panel` has
`border: 1px solid var(--border)` (`styles.css:553`) while the centre column is
deliberately not a panel (`.center` `:1882`, `.termwrap` `:3256`, both borderless).
So `.sidebar__head` and `.right__tabs` begin at `Y+1` and `.tabbar-wrap` at `Y+0`.

**Fix:** make the hairline non-layout-participating — draw it as
`box-shadow: inset 0 0 0 1px var(--border)` composed with the existing
`var(--elev-1)`, and drop the `border`. An inset shadow respects `border-radius`
and consumes no content box, so all three columns start at the same Y with no
compensating offset anywhere. Check the Neon chamfer interaction (`.panel` is not
in the chamfer list, but verify) and that `overflow: hidden` still clips correctly.

**Cause 2 — a fractional origin at Compact.**
`--density-topbar-h: calc(var(--density-band-h) * 1.5)` (`:647`) with Compact's
`--density-band-h: 31px` (`:705`) is **46.5px**, so the whole workbench starts on a
half pixel and every hairline below it antialiases across two device rows.

**Fix:** `round()` the derived height to whole pixels. The 1.5 ratio is load-bearing
(the user asked for it and `test/unit/shell-tokens.test.ts` guards it), so keep the
ratio and snap the result. Verify Electron's Chromium honours CSS `round()`; if it
does not, say so and pick integral band heights instead — do not leave the fraction.

Update `shell-tokens.test.ts` to assert the *invariant* (topbar ≈1.5× band AND
integral at every density) rather than a literal calc string.

**Verify visually at both densities in all three themes.** This defect is ~1px; it
will not show up in a unit test. Screenshot and zoom.

---

## P — Session state affordance in omni-search (FULL)

**Why.** With the Sessions panel hidden, the palette is the only way to move between
sessions, and its rows carry no state at all: `app.tsx:1964-1971` hardcodes
`<IconTerminal size={14} />` for every session and `PaletteEntry`
(`command-palette.tsx:6-16`) has no field to carry state.

**Do.**
1. Use the real session icon — `resolveSessionIcon`, as the sidebar and centre do.
2. Show the session's state. `sessionIconState()` and `SESSION_STATE_WORD` already
   exist (`src/session-icon.ts:38-58`) — wire them, do not reimplement.
3. Mark the session the user is **already in**. `activeId` is already in the memo's
   dependency list (`app.tsx:1999`) and unused for sessions.

**Naming call — important.** `.palette__row--active` already means *keyboard
cursor*. Do not overload it. Use a distinct modifier for "this is the session you
are currently in".

**Scope.** Affordance only. Do **not** reorder results by state — that fights the
fuzzy-match ranking and is a separate decision.

Extend `PaletteEntry` with optional fields rather than special-casing sessions
inside the palette component; the palette should stay generic.

---

## R — Aero pill radii (LITE)

The user wants three surfaces fully rounded in Aero: the top search bar, the
view-switch buttons (Workspace/Board/Canvas), and the editor tabs.

**Use the token that already exists.** `--r-round: 999px` (`styles.css:66`) is
defined for exactly this and already squares to `0px` under Neon (`:264`), so Neon
needs no special-casing and gets the change for free. **Do not add a new token.**

Nesting maths is a non-issue with `--r-round`: a pill inside a pill reads correctly
at any height, which is why this is the right token rather than a computed
`outer − padding` value on `--r-ctl`.

Remember the focus-ring overrides — `styles.css:502-519` pins specific radii for
`.omnibar`, `.tab`, `.rtab`. Those must follow, or the focus ring will square off
around a pill.

Check the active view-switch chip: it currently takes `--r-badge` (9px) inside a
`--r-ctl` (13px) track with 2px padding — a mismatch that this change should
resolve rather than preserve.

---

## G — Neon branch picker (FULL)

Two complaints, both real.

**1. Hover fill covers the tab slab's border.** The branch chip is `height: 100%`
of the band and its hover fill is `--panel-2`, which in Neon is an **opaque**
`#0c0a16` (`:236`) rather than a wash — so it paints over
`[data-theme="neon"] .tabbar-wrap`'s 1px bottom border (`:375-378`).

Lane V replaces that fill with a translucent `--state-hover-bg`, which may resolve
it outright. **Verify first.** If it persists, fix the geometry — the chip must not
span the band's border row — not by nudging z-index.

**2. The dropdown is unlike every other menu in the app.** Root causes, all fixable:
- `.git-branch-menu__filter` hardcodes `border-radius: 5px` (`:2396`), ignoring the
  radius tokens entirely — so it stays rounded even in Neon, where everything else
  squares off. Tokenise it.
- Its focus rule is `:focus` (not `:focus-visible`) with a bare `border-color`,
  bypassing `--focus-ring` (`:2401`).
- **The current branch row is rendered `disabled`** (`branch-switcher-menu.tsx:193-195`),
  so `.ctxmenu__item:disabled` paints it `--text-faint` — the selected item is the
  dimmest row in the menu, an inversion of the whole vocabulary. Make it a
  *selected* row (non-actionable, visually current) instead of a disabled one.
- The trigger has no open-state despite setting `aria-expanded`
  (`git-indicator-bar.tsx:328-337`). Lane V adds an open-state to the field role
  driven by that attribute; confirm it lands here.

The reference the user named as correct is `.search__filterstoggle`
(`styles.css:4219-4237`): fill never changes, states are three steps of increasing
contrast on border + glyph, and the border is present at rest so nothing shifts.
That is the field role in the vocabulary — make the branch picker read as one.

The commit picker (`commit-picker-menu.tsx`) shares this shell (`:2420-2422`), so it
inherits the fix. Check it did.
