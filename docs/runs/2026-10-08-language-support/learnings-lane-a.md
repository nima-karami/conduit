# Lane A learnings

- [instruction-file] The Edit tool turned a backslash-u-FEFF escape typed into a test string into
  the literal byte-order-mark character; only `source-bytes.test.ts` caught it. Spell invisible
  characters with `String.fromCharCode(...)` in sources, never as backslash-u escapes in an edit
  payload.
- [instruction-file] Never read-modify-write a source file through Windows PowerShell 5.1:
  `Get-Content -Raw` decodes UTF-8 as cp1252 and `Set-Content -Encoding utf8` re-encodes it (plus a
  BOM), which double-encoded every non-ASCII character in `src/file-service.ts` and no gate saw it.
  Use the Edit tool only.
- [docs/specs/archive/2026-10-08-language-support.md] AC-A2's "first frame" cannot be read off the DOM in
  the hidden harness window: a MutationObserver saw the first view line as one untokenized span in
  every theme. Assert grammar registration before the editor exists (editor-first-paint's method)
  plus the settled colours; specs should name that method for any future first-paint AC.
