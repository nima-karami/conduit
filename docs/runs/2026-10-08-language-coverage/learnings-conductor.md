- [instruction-file] The Edit/Write tools turn a `﻿` escape typed in new_string into a literal BOM; spell
  invisible code points as `String.fromCharCode(...)`. source-bytes.test caught it only at the full gate. (S0)
- [build-and-verify] Harness worktree isolation refuses compound git commands and paths with `.github`; one plain
  git command per call. (S0)
- [code-review] A hand-written imitation of a library's engine is a mock of the subject: lane A's Monarch runner
  passed two grammar bugs Monaco's real tokenizer shows. Test grammars on the real monarchCompile/MonarchTokenizer.
- [docs/specs] An AC must name the trigger it guards against: AC-B4 ("save runs no cargo") assumed a didSave the
  client never sends, so its e2e could not fail.
- [build-and-verify] Three "nothing/replay happened" e2es in one run (AC-B4, AC-C5, AC-C3) passed against broken
  code. Every negative or replay assertion needs (a) proof its trigger fired and (b) a position/content change
  the stale path can't satisfy.
- [autonomous-build-loop] A behaviour change with app-wide reach (D7: unseen opens no longer launch servers) needs
  the --affected/coverage-map set, not a hand-picked scenario list per lane; two Go scenarios only failed at the
  integration-wide full run.
