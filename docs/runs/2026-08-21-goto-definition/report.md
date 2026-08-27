# Run report — 2026-08-21 goto-definition

User report: "Go to Definition sometimes does nothing" — especially through barrel
re-exports, into packages, and for files outside what Conduit scanned. Approach:
map the flows first (45 rows), make the map executable against the real app
*before* fixing anything, then drive it from 20 → 52 green rows across four serial
tasks with independent review on the two FULL ones.

**Merged to main (`8c8257a..e725775`), not yet released.** Spec:
`docs/specs/2026-08-21-goto-definition-flows.md`. Plans:
`docs/plans/2026-08-21-{nav-outcome,resolve-on-demand}.plan.md`.

## What the baseline taught us (before any fix)

The executable matrix (`test/e2e/goto-matrix-*.e2e.mjs` over a generated fixture
workspace, `test/e2e/fixtures/goto/build-fixture.mjs`) ran against the shipping
build: **20 pass / 28 fail / 1 inconclusive**. Three corrections to the code-read
predictions: failing rows did not show "No definition found" — TS binds an
unresolvable import to its own import clause, so the caret **silently jumped to
the import line** (the reported "nothing happens"); the only honest message the
old wrapper had ("still indexing") never fired because the caret had moved; and
opening a second project root broke the first root's path aliases for the rest of
the window.

## Shipped

| Task | Commits | What | Rows flipped |
|---|---|---|---|
| goto-fixture | `8c8257a` | fixture generator (monorepo + junction, every package shape, alias configs, `.storybook`, `c#`/space dirs, 2 MB file, above-root `../shared`) + 5 matrix scenarios + baseline table | — (baseline) |
| path-identity | `af07318` | one canonical `C:\…` path for tabs/models/worker (`pathForUri` registry); `Uri.file`-based keys; **worker-side raw↔escaped fileName aliasing** — TS joins raw specifiers onto escaped file names, so `c#/` and `with space/` modules could never resolve | 42, 43, 43b (44 made deterministic) |
| nav-outcome | `ef26bf4..cd5f309` | wrapper computes results itself, pure classifier (`navigated / peeked / resolving / none / unsupported / timed-out`), single hits via our opener, multi hits via `peekLocations` (no provider precondition), unresolved imports detected via TS 2307/7016, alternative-command hop mirrored, `moved` heuristic deleted, inline Conduit messages; review fixed a missing error boundary, a semicolon-dependent statement guard, and a lying `peeked` on single references | 12, 13, 37–40, 45 — and every unresolved-import row went from silent jump to honest message |
| index-hygiene | `3392caf` | dot-dir exclusion → explicit tool-state list; >2 MB files skipped + counted; cap/skip counts surfaced in messages; incremental top-up on `fsChanged`; found + fixed an index/top-up overlap race (`queueProjectIndex`) | 15, 17, 35 |
| resolve-on-demand | `02370bf..e725775` | host `resolveModule` (nearest-tsconfig discovery incl. package `extends` + `references`; Node/TS resolution: `types`/`exports` conditions/`typesVersions`/subpaths/`@types`/`main`, walk-up `node_modules`, realpath), bounded closure, LRU-capped cache with root-scoped invalidation, supplemental extraLib push + one retry, JS-file trigger, name-locate fallback with an honest `opened-entry` outcome; review fixed the closure walk excluding `dist/` (green matrix, broken headline), a fake `navigated` on fallback, and an unpointed-specifier trigger; also fixed monaco's `getScriptKind` parsing every `.mts`/`.cts` as JavaScript | 19, 19b, 22–36, 30b, 30c |

Final matrix: **52 / 52** (firstparty 23, feedback 5, packages 14, config 8, cap 2).
Host resolve 3–20 ms; end-to-end 0.8–5.5 s cold, 0.7 s cached.

Verify on merged main (`e725775`): exit 0 — 210 test files / 3064 unit tests, gitleaks
clean, fallow clean (`.autoloop/evidence/final-verify.txt`).

## Verification notes

- Every fix has a pre-fix red: the baseline table for the first four tasks, and
  `resolve-on-demand-red2.txt` for the review-round rows (30b/30c red at the barrel
  line 1 with only the D1 hunks reverted).
- Fixture markers were moved off line 1 after review so no row can pass via a
  line-1 fallback landing; package/config rows assert the marker line (line 3).
- Real Claude Code / real `npm` packages are modelled by the generated fixture;
  nothing in the suite touches the network.
- Reviews were adversarial and earned their keep twice: nav-outcome's missing
  `catch` (a rejected worker call — "TypeScript not registered!" in exactly the
  row-39 window — vanished into the host log) and the resolver's `dist/`
  exclusion, invisible to a fixture whose packages kept types at the root.

## Follow-ups (queued in `.autoloop/blockers.md`, not blocking)

1. **Lib-file navigation** (`Promise`, `Array.prototype.at`) reports "no
   definition" — pre-existing; default libs aren't in extraLibs. Needs the worker
   to hand back lib text. Recorded in the spec's out-of-scope list.
2. F1 command palette still reaches Monaco's own nav action (menu / F12 /
   Ctrl+click are all routed).
3. Hoisted `@types` unreachable when the package itself is nested (pnpm layouts).
4. `exports` edge cases: string/condition-only form applied to subpaths; `null`
   exclusions bypassed by the runtime-entry probe.
5. `references` breadth unbounded (depth capped at 1).
6. Deleted files stay in extraLibs until the window reopens (deliberate).
7. "Go to Source Definition" (`.d.ts` → `.ts` via `declarationMap`) — scoped out.

## Decisions made under autonomy

- Fixture built BEFORE any fix; baseline recorded as the run's ground truth.
- `peeked` uses `peekLocations` with our locations (no provider precondition).
- Fallback landing must never be labelled `navigated`; name-locate first, then an
  honest `opened-entry` message (0 occurrences across 52 rows — every fallback
  found its symbol).
- Junction targets presented at their realpath so the tab matches the tree.
- Worktrees relocated out of dot-directories (`goto-index` asserts landed paths
  contain no `/.x/` segment — a location artifact, not a product bug).
- Release awaits approval.
