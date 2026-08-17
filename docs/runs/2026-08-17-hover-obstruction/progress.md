# Progress ledger

## Phase 0 — grounding (met, no `solidify-repo` pass)

`npm run verify` green on `main` at v0.31.0; `node test/e2e/run-smoke.mjs <name>` drives the real
app; `test/unit/drag-region.test.ts` is the precedent for CSS invariants no e2e can catch.

## Investigation — the reported case

Driven in the real app, not read from source:

| Step | Finding |
|---|---|
| Ctrl+F in a code editor, hover the find widget's X | `document.elementFromPoint` at the button's centre returned `div.hover-contents`, **not** the button |
| Identify the overlay | Monaco's own tooltip for that button — text **"Close (Escape)"**, rect `[989,138,89,44]`, covering the button at `[1029,166,16,16]`, `pointer-events: auto` |
| Consequence | The label swallows the pointer for the control it labels, and sets up a flicker loop (pointer enters overlay → leaves button → overlay hides → button re-hovered → overlay returns). Almost certainly what the user felt as "blocks my cursor". |
| Container | `.monaco-hover.workbench-hover` › `.workbench-hover-container` › `.context-view` — Monaco's **hover-service tooltip**, structurally distinct from its interactive **content** hovers (plain `.monaco-hover`) |

**A false lead worth recording:** the first three probes reported the click failing and blamed the
breadcrumb bar. That was measurement error — the find widget *slides in*, so coordinates taken
before it settled pointed at the wrong element. Only after a 1500 ms settle did the real cause
resolve. Two of those runs would have supported a wrong fix.

## The class, as found by the audit

The audit found a **worse** variant than the reported one: overlays that are *invisible* yet still
hit-testable (`opacity: 0`, no `pointer-events` gating). Two were destructive.

| Selector | What was hittable with nothing drawn | Fixed |
|---|---|---|
| `.change__row-actions` | **discard** (`.change__action--danger`) — proven at 14px from a resting row's right edge | ✅ |
| `.session__relaunch` / `.session__kill` | **kill session** — proven at 18px from a resting card's right edge | ✅ |
| `.bcard__acts` | board-card actions | ✅ |
| `.imgstage__controls` | image pan/zoom controls over the drag surface | ✅ |
| `.markdown-heading-anchor` | invisible 1.5em anchor in every heading's gutter | ✅ |
| `.archport__rm` | invisible remove-port button | ✅ |
| `.tab--dirty:hover .tab__dirty` | dirty dot faded out under the close button but still clickable → a click beside the X silently *saved* | ✅ |
| `.monaco-hover.workbench-hover` | the reported tooltip | ✅ |

The codebase already had the correct idiom in three places (`.tab__close`, `.markdown-code-copy-btn`,
`.mermaid-diagram__expand`): `pointer-events: none` at rest, `auto` on the reveal. The fix applies
that same idiom to the eight that missed it — no new pattern invented.

## Evidence

`test/e2e/hover-obstruction.e2e.mjs` — **written before the fix and failed against it**, which is
what makes it a regression test rather than a description of current behaviour:

- pre-fix: `BUTTON.change__action change__action--danger` hit at effective opacity 0; `BUTTON.session__kill` likewise
- post-fix: **PASS** — nothing invisible is hittable at rest, *and* hovering still makes the actions reachable

**A near-miss in the test itself:** the first detector read the *button's* computed opacity, but these
overlays fade the **container** (`.change__row-actions`), so the button reports `1` and the row leg
false-passed. Fixed to multiply opacity up the ancestor chain — after which it immediately caught the
discard button. A test that agrees with the code for the wrong reason is worse than no test.

## Deliberately not asserted in e2e

Monaco raises its widget tooltip only when the OS window is genuinely focused, and the smoke suite
runs hidden on purpose (the user has asked that runs never pop up windows). The tooltip leg was
therefore removed from the scenario and its guarantee moved to `test/unit/hover-overlays.test.ts`.
The Monaco fix **was** verified for real once, in a visible run: tooltip up, `elementFromPoint`
returning the X, and the click closing the widget.
