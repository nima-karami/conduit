# Run learnings — 2026-09-18 html-viewer

## Slice 1 — pure foundations (2026-09-18)

- [feature-spec] A spec can be internally consistent and still specify an unsatisfiable
  invariant. Rev 1's INV-3 asserted byte-identical path round-tripping through a URL whose
  host the parser case-folds — a test that could never go green. The skill's self-audit
  checks coverage, not *satisfiability*: worth a check that every invariant has a passing
  test someone can imagine writing.

- [architecture-critic] Running the critic against the PLAN rather than the spec is what
  caught the volume-as-origin hole, because the hole only becomes visible once the URL shape
  is concrete. It also caught it while the executor was mid-flight — a slice earlier and it
  would have been free; a slice later and three modules would have been built on it. Dispatch
  the critic in parallel with the FIRST slice, not before it.

- [build-and-verify] The executor's own mutation harness produced a table of false REDs
  (spawned `npx.cmd` without `shell:true` on Windows, so every mutated run "failed" by not
  spawning). It caught this only because it ran a no-mutation control first. The skill tells
  executors to mutation-verify; it should also tell them to run an unmutated control, or the
  whole table can be fabricated by a broken harness.

- [docs/plans/2026-09-18-html-document-viewing.plan.md] Two findings the plan must answer in
  Slice 2, both surfaced by building Slice 1: a relative link like `page.html?v=2` decodes
  into a segment containing a literal `?` and will 404 (the guest forms those, so
  `buildPreviewUrl` cannot help); and `previewContentType` returns bare types with no
  `; charset=utf-8`, so a UTF-8 HTML file without a `<meta charset>` decodes as windows-1252.
  Both belong to the response layer, not the mapping table.

- [memory] Bash heredocs with backtick-dense markdown content fail in this harness
  ("unexpected EOF looking for matching `'`"). Write the file with the Write tool and `cat`
  it into place instead of fighting the quoting.

## Slices 2-4 (2026-09-18)

- [architecture-critic] Running it against the PLAN, in parallel with the first slice, is what
  caught the volume-as-origin hole — the flaw only became visible once the URL shape was concrete
  enough to attack. A slice earlier it would have been invisible; a slice later, three modules
  would have been built on it. This should be the skill's default placement, not an option.

- [build-and-verify] Mutation testing earned its place twice, in a way a passing suite cannot:
  M4 in the host slice SURVIVED, revealing that "both containment checks run" was untested in one
  direction, and the viewer's e2e found a race no unit test could reach. Both were claims that
  looked verified. The skill should say plainly that a surviving mutation is a FINDING, not a
  retry — the instinct is to tweak the mutation until it dies.

- [build-and-verify] "Run a no-mutation control first" needs to be explicit in the executor brief,
  not implied. One executor's harness spawned `npx.cmd` without `shell:true` on Windows, so every
  mutated run "failed" by failing to spawn, producing a full table of false REDs. It caught this
  only because it happened to run a control.

- [docs/specs/archive/2026-06-23-context-menu-consistency.md] Monaco ships `.minimap{z-index:5}`
  and Conduit's floating viewer chrome also used 5. On a tie DOM order decides and the editor is
  the later sibling, so Markdown's "View rendered" button has been unclickable in shipped builds.
  No e2e had ever clicked a source-view toggle. Any floating chrome layered over Monaco needs to
  clear the editor's OWN stacking values, not just the page's — worth a line wherever that rule
  is written down.

- [none] A third-party stacking value silently colliding with ours is invisible to every gate:
  lint, types and 3900 tests all pass over a dead button. Only a real click finds it.

- [memory] `.claude/worktrees/` holds orphaned run directories whose `node_modules` is a Windows
  JUNCTION to the real one. A bulk `rm -rf` there deletes the project's actual dependencies. This
  is already in memory as the worktree-junction hazard; it recurred, so the note is earning itself.

## Conductor errors and late findings (2026-09-18)

- [autonomous-build-loop] **I told an executor "you are the only executor; the tree is yours",
  then dispatched a second lane into the same checkout minutes later.** The lanes were genuinely
  file-disjoint, but the brief was false when it was written and the second lane briefly broke
  `npm run typecheck` mid-flight, which the first lane saw and had to reason about. Cost was
  small only because both reported it. The rule this teaches: a brief's concurrency statement is
  a promise about the FUTURE of the run, not a snapshot — either promise exclusivity and keep it,
  or say "other lanes may be active, here are their files". The skill should say that outright.

- [code-review] **A test wrapped in `if (subject) { assert… } else { log('NOTE: skipped') }`
  cannot fail.** `context-menu-order.e2e.mjs` had exactly that around its editor-tab block, in
  the one file whose entire purpose is pinning literal menu order — and it had never asserted
  literal order at all. This is the "tests that cannot fail" class the review skill hunts, and
  the `else`-branch-log shape is a specific, greppable tell worth naming there.

- [docs/plans] Planning "always listed, disabled with a reason" for palette rows assumed an
  affordance the palette does not have: `PaletteEntry` has no `disabled` field and the row
  renderer calls `run()` unconditionally. The executor correctly refused to ship an always-listed
  row that silently no-ops. A plan that specifies UI states should name the component that
  renders them, or it is specifying a capability rather than using one.
