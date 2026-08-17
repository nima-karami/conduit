# Run report — hover overlays must never obstruct their own trigger

**Date:** 2026-08-17 **Branch:** `main` (direct; bugfix run) **Mode:** autonomous, no human available.

## The request

> …when I press Control F and a search box opens inside a code editor… There's an X button. When I
> hover over the X button, some sort of a popover pops up and blocks my cursor… Just make sure that
> that class of issues across the app doesn't exist anywhere else.

## What the reported bug actually was

Driven in the real app rather than read from source. Hovering the find widget's X pops Monaco's own
tooltip for that button — **"Close (Escape)"** — at a rect that **covers the button it labels**, with
`pointer-events: auto`. `document.elementFromPoint` at the button's centre returned the tooltip.

That also sets up a flicker loop: the pointer enters the tooltip → leaves the button → the tooltip
hides → the button is hovered again → the tooltip returns. That loop is almost certainly what was
experienced as "blocks my cursor".

Cause: the tooltip is placed *inside the editor container*, so with the find widget at the very top
there is no room above and it gets clamped down onto its own trigger.

## What the audit found — a worse variant of the same class

The sweep turned up a second, more dangerous shape: overlays kept mounted at `opacity: 0` and faded
in on hover, with **no `pointer-events` gating**. Invisible, but fully clickable. Two were
destructive, and both were **proven in the real app**, not inferred:

| Selector | Invisible but hittable | Proof |
|---|---|---|
| `.change__row-actions` | **discard** on a changed-file row | hit at 14px from a resting row's right edge |
| `.session__relaunch` / `.session__kill` | **kill session** | hit at 14–18px from a resting card's right edge |
| `.bcard__acts` | board-card actions | audit |
| `.imgstage__controls` | image controls over the pan surface | audit |
| `.markdown-heading-anchor` | 1.5em anchor in every heading's gutter | audit |
| `.archport__rm` | remove-port button | audit |
| `.change__stat` | faded diff-stat text | flagged by the new unit gate |
| `.tab--dirty:hover .tab__dirty` | dirty dot under the close button — a click beside the X silently **saved** | audit |

The codebase already had the right idiom in three places (`.tab__close`,
`.markdown-code-copy-btn`, `.mermaid-diagram__expand`): `pointer-events: none` at rest, `auto` on the
reveal. The fix applies that existing idiom to the nine that missed it. No new pattern invented.

Monaco's tooltip got its own scoped rule: `.monaco-hover.workbench-hover`, its container, and — via
`:has()` — the `.context-view` host. Deliberately **not** applied to bare `.monaco-hover`: those are
Monaco's *content* hovers, which are interactive (links, scrolling) and must keep their pointer
events. The unit gate asserts that scope in both directions.

## Evidence

`npm run verify`: **green — 198 files, 2774 tests** (was 2766, so +8).

| Gate | Result |
|---|---|
| `test/e2e/hover-obstruction.e2e.mjs` | **PASS (21.9s)** — written *before* the fix and failed against it |
| `test/unit/hover-overlays.test.ts` | **8 passed** — derives the rule from the stylesheet, no hardcoded selector list |

Both guards were proven non-vacuous by removing the fix and watching them fail:

- e2e → `BUTTON.session__kill … opacity 0 at 14px from its right edge`
- unit → `.session__relaunch, .session__kill (styles.css:3747) — fades to opacity: 0 without pointer-events: none`

The e2e asserts both halves: nothing invisible is hittable at rest, **and** hovering still makes the
action usable — a `pointer-events: none` with no matching `auto` would leave these buttons dead
forever, and the first half alone would not notice.

## Three near-misses worth recording

1. **The first three probes blamed the wrong element.** They reported the click failing and pointed
   at the breadcrumb bar. That was measurement error: the find widget *slides in*, so coordinates
   taken before it settled addressed the wrong pixels. Two of those runs would have supported a
   wrong fix. Only a 1500 ms settle produced the real cause.
2. **The first version of the e2e false-passed.** It read the *button's* computed opacity, but these
   overlays fade the **container**, so the button reports `1`. Fixed to multiply opacity up the
   ancestor chain — after which it immediately caught the discard button. A test that agrees with
   the code for the wrong reason is worse than no test.
3. **The first reachability leg was brittle for a real reason.** A session card **changes height**
   between rest and hover, so a fixed mid-line sweep sailed past the kill button and reported it
   unreachable. The at-rest sweep now probes three heights (it catches the seeded bug at `fy: 0.25`,
   which the mid-line alone missed), and reachability is asserted on computed style instead of
   geometry.

## Scope decisions taken without the user

| # | Decision | Why |
|---|---|---|
| 1 | **Zero allowlist entries.** The guard shipped with one exemption (`.change__stat` — text, not a control, and hits bubble to the row). Fixed the CSS instead and deleted the exemption mechanism. | An allowlist is where the next exception gets added. One line of CSS removes the need. |
| 2 | **No release.** Committed to `main`, **not pushed**. | The last two releases were each cut on an explicit "ship it". Publishing is outward-facing and nobody was here to approve it. |
| 3 | Monaco's `suggest` / `parameter-hints` / sticky-scroll / overlay-message widgets left alone. | They are genuinely interactive (you click suggestions, scroll hints). Gating them would break them. Only the tooltip family (`workbench-hover`) is a pure label. |

## Left open

| # | Item | Note |
|---|---|---|
| A | The tab's unsaved-changes dot advertises click-to-save (`role="button"`, `cursor: pointer`, a title saying so) but the close button replaces it on hover, so **the mouse can never reach it**. Keyboard works. | Now unambiguous rather than silently misfiring, but the affordance is still advertised and unreachable. Fixing it means either dropping the mouse affordance or re-laying-out the tab's right edge — a product call, not a bug fix, so it was not taken unattended. |
| B | `.archedge__label` / `.archedge__input` declare `pointer-events: all` and the code comment says they "occlude the wire". | Deliberate and documented; an always-on interactive label, not a hover overlay. Out of this class. |
| C | The find widget's tooltip still **visually** covers the X, it just no longer takes the pointer. | Monaco positions it inside the editor container; moving it would mean fighting Monaco's context-view placement. The interaction bug is gone; the cosmetic overlap remains. |
