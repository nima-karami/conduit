---
status: active
date: 2026-09-22
tier: LITE
type: UI
---

# Go files: module-file basics + honest nav message

**Tier:** LITE   **Feature type:** UI (editor colouring, Explorer/tab icons, one message)
**One-line request:** "golang support would be nice" (external user). Cheap half; real Go
navigation is `2026-09-22-language-server-go.md` (feat/go-lsp).

## 1. Problem frame
- **Job:** a Go repo looks first-class in tree and editor; when navigation can't help, the message
  names *this* file's language instead of lecturing about JS/TS.
- **Success:** `go.mod`/`go.work` coloured; `go.mod`, `go.sum`, `go.work`, `go.work.sum` wear a
  Go-blue icon in Explorer and tabs; the unsupported-nav message is language-generic.
- **Non-goals:** Go nav/hover/breadcrumbs (go-lsp); `go.sum` colouring; highlight.js `gomod` (Review
  rows stay plain, like any unmapped id); markdown-fence alias.

## 2. Current state
| Claim | How measured | Status |
|---|---|---|
| `a.go`→`go`; the four module files →`plaintext` | `node --experimental-strip-types` calling `langFromPath` | Measured |
| `a.go` icon `code`/`#00add8`; module files `generic`/`#8a8f98` | same, `fileIconKind`/`fileIconColor` | Measured |
| Monaco 0.55.1 ships no `gomod` grammar | `ls node_modules/monaco-editor/esm/vs/basic-languages` | Measured |
| Message today: "Code navigation is only available for JS/TS files." | `nav-outcome.ts:128`, asserted in `test/unit/nav-outcome.test.ts:231` | Source read |
| Non-TS: context-menu nav group shown **disabled**, Ctrl+click silent; message reachable by F12-family keys and via Monaco's command palette (menu → `editor.action.quickCommand`, nav actions are `addAction`s) | `editor-menu.ts:158,213`, `code-viewer.tsx:306,384` | Source read |

## 3. Target behavior
- `src/lang.ts` FILENAME: `go.mod`, `go.work` → new id **`gomod`**; `go.sum`, `go.work.sum` →
  `plaintext` explicitly.
- `webview/monaco-languages.ts`: `monaco.languages.register({ id: 'gomod' })` **once at module
  load** (Monaco rejects a tokenizer for an unknown id, and `diff-viewer.tsx:115` creates models
  without `ensureTokenizer`), plus a `gomod` entry in `GRAMMARS` so it paints on first frame.
- Grammar tokens: `//` comments (`// indirect` included); keywords `module go toolchain godebug
  require replace exclude retract use tool ignore`; `=>` operator; `( )` and `[ ]` brackets (retract
  ranges); quoted/back-quoted strings; versions (`v1.2.3`, pseudo-versions, `+incompatible`) as
  `number`; module paths and unquoted relative paths (`./svc`, `../x`) as `identifier`. Unknown
  directives are plain identifiers; malformed text never throws. Conf: `//` line comment, `()`/`[]`
  brackets with auto-close.
- `src/file-icon.ts`: FILENAME_KIND `go.mod`/`go.work` → `config`, `go.sum`/`go.work.sum` → `lock`;
  `fileIconColor` checks a by-filename colour table before the ext table; all four → `#00add8`.
- `unsupported` outcome gains `languageId`; message becomes **"Code navigation isn't available for
  {Name} files."**, `{Name}` from new pure `languageDisplayName(id)` in `src/lang.ts` covering every id
  `langFromPath` can return (`go`→Go, `gomod`→Go module, `python`→Python, `csharp`→C#, `bat`→Batch …).
  `plaintext`/unnamed → **"Code navigation isn't available for this file type."** Channel/variant
  unchanged (`toast`/`info`); when `unsupported` fires is unchanged. go-lsp adds its own Go-specific
  outcomes — this message never speaks for a language that has a server.

## 4. Edge cases
| Condition | Expected |
|---|---|
| `GO.MOD`, `sub\dir\go.work` | Same as lowercase (both maps lowercase the basename) |
| `foo.mod`, `vendor/modules.txt` | Unchanged — filename match only |
| Ids shared by several extensions (`.toml`→`ini`, `.vue`→`html`, `.svg`→`xml`) | Named by the id ("INI files") — that *is* how Conduit treats them; accepted |
| New language id without a name | Unit test fails: every `LANG`/`FILENAME` value must have a display name |

## 5. Defaults / settings
None. Separate id `gomod` (not `go`) so Go nav/LSP never runs on module files.

## 6. Acceptance criteria
- `langFromPath`: `gomod` for `go.mod`/`go.work` (any case, `\` or `/`); `plaintext` for `go.sum`,
  `go.work.sum`. Existing `nav-outcome.test.ts` assertion updated to the new sentence, not deleted.
- Real app, `go.mod` open (and a `go.mod` diff in Review): `module`, a version, and a module path
  carry three different `mtk*` classes on first frame (e2e reads classes, not pixels).
- Explorer row and editor tab for each module file render the `#00add8` icon (coloured pack).
- F12 in `main.py` → "…for Python files."; in a `.txt` → "…for this file type."; JS/TS goto e2es green.

## 7. UI module
- **States:** transient message, same surface/timing as today; icons static.
- **A11y:** message path unchanged; colour is never the only signal (filename text is always
  visible). Icon ARIA is whatever `FileIcon` does today — not changed here.
- **i18n:** English-only app; the whole sentence lives in `nav-outcome.ts`, `{Name}` interpolated
  once (no fragments assembled elsewhere); language names are untranslated proper nouns.
- **Tokens:** `#00add8` joins the existing per-language hue table; grammar uses standard Monarch
  token names — no new theme rules.

## 8. Assumptions
- `go.work` shares the `gomod` grammar (same syntax family). `go.sum` as `lock` mirrors
  `package-lock.json`.

## 9. Decisions Needed
- [normal] Wording drops "yet" (it would promise navigation for JSON/INI/Markdown). Default: no "yet".
- [normal] Enable the context-menu nav rows for non-TS so a mouse click yields the message? Default:
  no — they stay disabled; go-lsp enables them for Go.
