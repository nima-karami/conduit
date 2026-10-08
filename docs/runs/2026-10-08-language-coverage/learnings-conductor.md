- [instruction-file] The Edit/Write tools turn a `﻿` escape typed in new_string into a literal BOM; spell
  invisible code points as `String.fromCharCode(...)`. source-bytes.test caught it only at the full gate. (S0)
- [build-and-verify] Harness worktree isolation refuses compound git commands and paths with `.github`; one plain
  git command per call. (S0)
