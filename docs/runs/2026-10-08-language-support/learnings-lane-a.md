# Lane A learnings

- [instruction-file] The Edit tool wrote a `﻿` escape typed in a test as the literal U+FEFF
  character; only `source-bytes.test.ts` caught it. Spell invisible characters with
  `String.fromCharCode(...)` in sources, never as `\u` escapes in edit payloads.
- [instruction-file] PowerShell 5.1 `Set-Content -Encoding utf8` prepends a BOM to a source file;
  use the Edit tool (or `[IO.File]::WriteAllBytes`) for in-place rewrites on this machine.
- [docs/specs/2026-10-08-language-support.md] AC-A2's "first frame" cannot be read off the DOM in
  the hidden harness window: a MutationObserver saw the first view line as one untokenized span in
  every theme. Assert grammar registration before the editor exists (editor-first-paint's method)
  plus the settled colours; specs should name that method for any future first-paint AC.
