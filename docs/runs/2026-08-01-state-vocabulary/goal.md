# Run goal — 2026-08-01 state vocabulary + chrome polish

Conductor: Opus 5 (1M) — fixed for the run. Subagents: Opus, same tier or lower,
never higher. Execution: in-session, autonomous.

## Source

User punch list delivered 2026-08-01 via `/autonomous-build-loop`, plus the icon
architecture agreed at the tail of the v0.25.1 release.

## Lanes

| ID | Title | Tier | Notes |
|---|---|---|---|
| V | Interaction state vocabulary | FULL | Foundational. Runs alone, first. Spec: `docs/specs/2026-08-01-interaction-state-vocabulary.md` |
| I | Theme-coupled chrome icons | FULL | Disjoint file (`webview/icons.tsx`); runs parallel to V |
| S | Remove the collapse-sidebar button | LITE | Keeps palette + context menu + Mod+B |
| B | Band baseline alignment (the "thick top border") | LITE | Two real root causes, see ledger |
| P | Session state affordance in omni-search | FULL | Wire `sessionIconState` into palette rows |
| R | Aero pill radii | LITE | Reuse existing `--r-round`; Neon squares to 0 for free |
| G | Neon branch picker: hover bleed + dropdown consistency | FULL | Depends on V's field role |

## Ordering

`V` and `I` start together (disjoint files). Everything else waits for `V` to land,
then fans out with disjoint CSS namespaces, merging serially — `styles.css` is the
shared entry file and the near-universal collision point.

## Standing constraints

- Root-cause fixes only. The user has twice insisted: "addressed at the root level,
  not a patch."
- No gate weakened, narrowed, or deferred. `npm run verify` is the floor;
  `npm run test:smoke` and `npm run shots` before release.
- Architecture and taste calls stay with the conductor. A subagent hitting a design
  fork records it in `blockers.md` and does not resolve it.
