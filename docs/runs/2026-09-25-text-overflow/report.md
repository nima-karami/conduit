# Run report — text overlap / overflow sweep (2026-09-25 → 2026-09-26)

Source: a user screenshot of the references peek (chevron on the file name, a long path running
into the match count) plus "hunt for this class of bugs across the UI, fix and provide before/after
screenshots". Branch `fix/text-overflow` off 84146f1; not merged to main pending the user's review of
the before/after page.

## How the hunt worked

`test/e2e/visual/text-fit.mjs` (detector) + `text-fit-sweep.mjs` (`npm run text-fit`) drive the real
app on a stress fixture (`text-fit-fixture.mjs`: long/deep/non-ASCII names, long branch, long
commits, two folders, long project/session/card names) across 41 shots × 7 passes (aero, aero-dark,
neon × 1320×820 / 1000×700 × default / minimum panels). The detector reports text-on-text overlap,
spill, clipped-without-ellipsis and squeezed-primary-text from text-node rects; every finding was
confirmed by eye and triaged by root cause. **934 findings → 85**; the 85 are secondary text yielding
with a tooltip, Monaco's own widget clipping, a spec-capped chip (below), and 6 detector false
positives.

## Shipped

| Item | Commits | What |
|---|---|---|
| peek | c2fb08a (released **v0.42.1** at the user's request, main f04511d) | global box-sizing reset scoped out of Monaco (`@scope … to (.monaco-editor)`); path gap before the count; `peek-tree-layout.e2e.mjs` |
| tools | 09af824, 894a626, 603ec15 | detector, sweep, fixture |
| batch A | eec578f bdf2770 f541e4e 6bea761 9570f38 a587d6d | top bar grid, sessions title, narrow session cards → dot, breadcrumbs (ellipsis + fold outer dirs), opaque toasts, quick-open name/dir split |
| batch B | 38ae9b9 3bcd2bc a72f6cd 10c42d5 865baf5 ef57044 db045ca bbee321 aa81fa5 | Monaco class collisions renamed (`.right` `.slider` `.stale` `.peek` `.center`) + guard test; peek title; Files bar; right pane at 180px; search headers; change rows; New session folders; quick-open highlights |
| batch C | e6bba7a ed23515 4f38c62 fc9e4b4 8a207b9 c49b4c7 5e0b835 4acd2d7 | Review header stats, Review repo headings, commit picker width, history ref chips, plan comments stack when narrow, board notes/markdown wrap, board ticket cap |
| review fixes | b0e9ac0 03f68ce 04e9379 360c617 2504f05 33d9393 0245634 20d81f7 | ticket cap stored with "…" (round-trip safe), guard sees nested rules, breadcrumb fold resets + "…" is a keyboard-reachable menu, navigator tooltip, PathTitle tests + UTF-16 highlight offset bug, CHANGELOG |

Gate: `npm run verify` exit 0 on the merged head (after main was merged in at e50b621). Review: round 1
REQUEST_CHANGES (1 blocker, 7 should-fix), round 2 APPROVE. e2e: 35 scenarios (batch B) + 16 (batch C)
+ find-widget / hover-obstruction / peek-tree-layout / middle-click-surfaces / go-lsp after the review
fixes, all passing.

## Blocked / left

- `monaco-widget-internal-clip` — Monaco's hover and peek rows scroll/clip by design.
- **Decision for the user:** reviewing a commit, the disabled Staged/Unstaged segment keeps 156px
  while the repo chip and commit source stop at their 170px spec cap (24 detector findings).
- `review-multi-repo.e2e.mjs` is flaky on the pre-run baseline too ("Execution context was
  destroyed" at `setBracketedPaste`, 2 of 6 runs) — not caused by this run; worth a separate look.

## Decisions taken (override any)

- Toasts take the menus' opaque `--raise` surface (Neon toasts lose their drop shadow, like Neon menus).
- Narrow session cards show state as a dot below 210px; narrow Files bars show secondary actions on
  hover/focus (VS Code); narrow heads drop the tag before the name.
- Breadcrumbs fold outer dirs into a "…" menu rather than shrinking every dir to a letter.
- Quick open keeps path order (dir dimmed, then name) so `.palette__title` text stays the rel path.
- Colliding classes were renamed rather than `@scope`d.
- Plan comments stack under the document below 620px.
- A cut board ticket is stored ending in "…" (spec §3.5 amended).

## Learnings

- [build-and-verify] A global reset leaking into a third-party widget's DOM is the first suspect when
  only that widget misrenders; measure rects before guessing.
- [instruction-file] Bare generic class names collided with Monaco's DOM five times — now a CLAUDE.md
  gotcha with a unit guard.
- [runtime-qa] An opacity fix surfaces findings the translucent surface hid; compare per scene.
- [code-review] An executor's "survives write-back" claim was false; the reviewer reproduced the round
  trip. Ask reviewers to reproduce persistence claims.

## Needs a human smoke

- macOS top bar (traffic-light clearance moved into the left grid column) — reasoned, not run.
