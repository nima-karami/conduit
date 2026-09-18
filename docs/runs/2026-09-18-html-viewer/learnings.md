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
