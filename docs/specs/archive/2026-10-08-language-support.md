---
status: shipped
date: 2026-10-08
---

# Feature Spec: language support — Markdown, YAML, golden, log, C#

**Tier:** FULL   **Feature type:** UI (editor rendering, banners, toasts) + host (file read, LSP)
**One-line request:** "I want support for a variety of different languages. The way the editor view
works, I want to be able to view: a Markdown file, a YAML file, a golden file, a log file, a C#
file. Everything should work essentially. Not sure if we need a language server for all of them or
just a formatter. Performance is important. Don't break things; address scalability. If something
is not active we can put it to sleep. Get this done quickly."

Run folder: `docs/runs/2026-10-08-language-support/`. Builds on the archived
[language-server-go](archive/2026-09-22-language-server-go.md) and
[go-files-basics](archive/2026-09-22-go-files-basics.md) specs and ADR 0006 (trust).

## 1. Problem frame

- **Job:** open any of five everyday file kinds and get correct colouring, folding and — where a
  real navigation story exists — Go-parity code navigation, without the app getting slower or
  rewriting bytes the user did not touch.
- **Actors:** the user reading/editing files; agents writing files under them (logs, goldens).
- **Success outcomes (observable):** `.log` files colour levels/timestamps on first paint; a
  `foo.json.golden` colours as JSON and saving it never changes a byte the user didn't edit; a huge
  log opens instantly showing its **end**; C# gets F12/Shift+F12/hover/breadcrumbs when
  `csharp-ls` is installed and a one-time install hint when it isn't; Markdown and YAML are
  confirmed working in the built app.
- **Non-goals:** a YAML (or Markdown/log) language server; formatters / format-on-save (none exist
  today, and none are added); diagnostics (the LSP client stays nav-only); live `tail -f`
  following; encoding selection (non-UTF-8 files stay read-only, see §2.4); Razor/`.cshtml`;
  F# / VB servers.

**Server-vs-formatter answer (the user's open question):** only C# warrants a server. The LSP
client is nav-only (definition / typeDefinition / implementation / references / hover / document
symbols; `publishDiagnostics` is dropped), and YAML, Markdown, golden and log files have nothing
to navigate. Monarch grammars + language configuration (folding, brackets) cover them at zero
runtime cost.

## 2. Behavior & states

### 2.1 Language resolution (`src/lang.ts` `langFromPath`, shared by host and renderer)

Order, first match wins:
1. Exact filename table (unchanged).
2. **Golden:** name ends in `.golden` (case-insensitive) → strip ONE `.golden` suffix and resolve
   the remainder through steps 1, 3, 4. `expected.json.golden` → `json`; `out.txt.golden` →
   `plaintext`; bare `x.golden` → `plaintext`; `a.golden.golden` → remainder `a.golden` resolves by
   extension (`golden` is not an extension) → `plaintext`.
3. **Rotated logs:** `<name>.log.<N>` (digits) or `<name>.log.<YYYY-MM-DD…>` (date prefix, any
   suffix without a further `.`, e.g. `app.log.2026-10-01`, `app.log.2026-10-01_13`) → `log`.
   Compressed rotations (`app.log.1.gz`) are binary and unaffected.
4. Extension table; `.log` → `log`.

`log` gets display name **"Log"** in `DISPLAY_NAMES`. Golden detection is also exported as
`isGoldenPath(p)` for §2.3.

### 2.2 Log grammar (new `webview/log-grammar.ts`, `gomod-grammar.ts` is the precedent)

Monarch, single `root` state, case-insensitive level words, rules in priority order:

| Token (emitted) | Matches | Theme rule |
|---|---|---|
| `log-error.log` | `FATAL`, `CRITICAL`, `CRIT`, `ERROR`, `ERR`, `EMERG`, `ALERT`, `PANIC`, `SEVERE`, bracketed `[E]`, logcat `E/Tag(pid):` (anchored at line start to the `^[VDIWEF]/\S+\(\s*\d+\):` shape, so `I/O error` is not a level) | `--syn-error` |
| `log-warn.log` | `WARNING`, `WARN`, `WRN`, `[W]`, logcat `W/…` (same anchor) | `--syn-warn` |
| `log-info.log` | `INFO`, `INF`, `NOTICE`, `[I]`, logcat `I/…` (same anchor) | existing `type` colour (`--syn-type`) |
| `comment.log` | `DEBUG`, `DBG`, `TRACE`, `TRC`, `VERBOSE`, `[D]`/`[T]`/`[V]`; stack-frame lines (`^\s+at\s`, `^\s+File ".*", line \d+`, `^\s+\.\.\. \d+ more`) | `--syn-comment` |
| `log-time.log` (timestamp) | ISO-8601 date/time with optional `T`, fraction, `Z`/offset; `HH:MM:SS(.fff)`; syslog `Mon dd HH:MM:SS` | `--syn-comment`, upright (muted so the level stands out — runtime QA found WARN and timestamps near-identical in colour) |
| `number.log` | GUIDs, IPv4 (+`:port`), `0x` hex, decimal numbers with optional unit (`12ms`, `3.4s`, `512KB`) | `--syn-number` |
| `string.log` | `"…"` and `'…'` (single line; unterminated = to EOL), URLs `scheme://…` | `--syn-string` |
| `log-error.log` | exception headlines: `^\S*(Exception|Error)(:|\b)` and `Traceback (most recent call last):` | `--syn-error` |

Level words match on word boundaries only (`errors=0` and `terror` are not levels), and only
UPPERCASE as a bare word; any case counts where a level stands — `[error]`, `level=error` /
`"level":"error"`, or `error:` at the line start or right after its timestamp — so prose such as
"I/O error count 0" stays plain (runtime QA decision). Language
configuration: no comments, brackets `[] () {}`, indentation folding (Monaco default) so a stack
trace under a line folds. The id `log` is registered at module load (`monaco.languages.register`,
as `gomod` is) so diff and peek models tokenize too.

### 2.3 Golden files

- Colour as the remainder's language (§2.1) in the editor, Review diff (`diff-viewer`, hljs path via
  `monacoLangToHljs`) and peek.
- **Always open in the code editor, never a rendered view:** `doc-view.tsx` `DocBody` routes
  `isGoldenPath` before the HTML/Markdown branches, and `docPage` is false for it. A golden is an
  expected-output fixture; its bytes are the point.
- **Byte-exact save** — see §2.4. A golden file adds one rule there: mixed line endings make it
  read-only.

### 2.4 Byte-exact round trip (all text files, measured)

| Claim about today's behavior | How measured | Status |
|---|---|---|
| Monaco's buffer rewrites mixed EOLs to the majority (`a\r\nb\r\nc\n` → `…c\r\n`) and lone `\r` to `\n` | Node script over `monaco-editor/esm/…/pieceTreeTextBufferBuilder.js` (`finish()` default `normalizeEOL=true`) on 7 inputs | Measured |
| Monaco strips a UTF-8 BOM from the buffer; `TextModel.getValue()` defaults `preserveBOM=false` | same script (`\uFEFFa\nb\n` → `a\nb\n`) + `textModel.js:520` | Measured |
| Pure-CRLF, pure-LF, no-final-newline and trailing-whitespace files survive unchanged | same script | Measured |
| Every save-store comparison and write uses `SaveModel.getValue()`, and `webview/file-saves.ts:14` binds the raw Monaco model as `SaveModel` (`file-save-controller.ts` write :148/168/170, onContent :222, save :238, attach :306-317, rename :354; `file-saves.ts:44-45` rename copy) | source read | ASSUMED (source) |
| A BOM file therefore opens **dirty**: `attach` compares BOM-less `model.getValue()` with BOM-carrying `diskContent`, so `setDirty`/`seed` see a difference with no edit, and auto-save can write it back without the BOM | source read (`file-save-controller.ts:306-317`) | ASSUMED — AC-A4b measures it |
| No formatOnSave / trimTrailingWhitespace / insertFinalNewline exists in the app | `grep` over `webview src electron` for those options | Measured (grep: none) |
| Host decodes with `buf.toString('utf8')`, so invalid UTF-8 becomes U+FFFD and a save writes EF BF BD | `node -e` on `[0x61,0xE9,0x62]` → `"a\uFFFDb"`; BOM kept as `\uFEFF` | Measured |

Required behavior:
1. **BOM preserved, every file — at the producer.** `file-saves.ts` `getModel` returns a
   `SaveModel` adapter whose `getValue()` is `model.getValue(EndOfLinePreference.TextDefined,
   true)`, so every comparison AND every write in `file-save-controller.ts` sees the BOM; the
   rename copy (`file-saves.ts:44-45`) uses the same read. No per-call-site patching. A BOM file
   opened untouched is clean and never written; edited and saved, it keeps `EF BB BF`.
2. **Invalid UTF-8 → read-only, every file.** Host `readFile` decodes with a fatal decoder (or
   re-encodes and compares) on the non-truncated path; on failure the DTO carries
   `readOnlyReason: 'invalid-utf8'`. The doc opens read-only with banner
   *"Not valid UTF-8 — read-only so saving can't change its bytes."*
3. **Mixed line endings → read-only, golden files only.** Host counts CRLF / bare LF / bare CR in
   the same pass; if more than one kind occurs, **or any bare CR occurs at all** (Monaco reads a
   lone CR as a line break and rewrites it to the model's EOL, so even a pure-CR golden would not
   round-trip — found in Lane A review), and `isGoldenPath`, `readOnlyReason: 'mixed-eol'`,
   banner *"Line endings the editor would rewrite — read-only so this golden file stays byte-exact."* Non-golden
   mixed-EOL files keep today's VS Code-parity normalisation (decision D3).
4. Read-only reasons reuse the truncated path's mechanics: `readOnly`, `writable:false` on
   `fileSaves.attach`, `silenceReadOnlyPopup`, the one-shot live-region announcement. Change
   markers stay ON for `invalid-utf8`/`mixed-eol` (the content is complete).

### 2.5 Large files — bounded read, tail for logs (measured)

| Claim | How measured | Status |
|---|---|---|
| `readFile` reads the WHOLE file into memory, then keeps the first 2 MB | esbuild-bundled `src/file-service.ts` `readFile` on a 640 MB `.log`: **479 ms, +645 MB RSS peak**, `truncated:true`, 2.0 MB content | Measured |

Required: the text branch of `readFile` reads at most `cap` bytes through a file handle
(`open` + `read` at an offset), never `fs.readFile`, for files over the cap. Window:
- **Head** (default, every language): bytes `[0, cap)` — today's content, minus the RSS spike.
- **Tail** when `language === 'log'`: bytes `[size − cap, size)`, then drop everything up to and
  including the first `\n` so the view starts on a whole line (and never on a split UTF-8
  sequence). DTO gets `window: 'tail'`; banner *"Large log — showing the last 2 MB, read-only."*
- Binary sniff (`isBinary`) runs on the window read. Files ≤ cap are unchanged (one read).
- Line numbers in a tail view count from the window's first line; the banner is the disclosure.
- **Line-addressed navigation into a tail window** (search hit, terminal `file:line` link, LSP
  location, blame) cannot be mapped — the window's starting line is unknown without an O(file)
  scan. Such a navigation opens the doc at its end and shows a toast *"This log is shown from its
  last 2 MB — line {N} may be outside it."* It never reveals a wrong line silently (decision D5).
- **Appends while open.** A tail doc that changes on disk re-reads at most once per second
  (trailing edge); if the viewport was at the bottom it stays at the bottom, otherwise its scroll
  position is kept. Selection is cleared (the content under it moved).

### 2.6 C# — `csharp-ls` through the existing registry

New `CSHARP_SERVER` in `src/lsp-registry.ts`, appended to `LANGUAGE_SERVERS`:

| Field | Value |
|---|---|
| `languageId` / `displayName` | `csharp` / `C#` |
| `binary` / `args` | `csharp-ls` / `[]` (it finds the `.sln`/`.csproj` from the root it is given) |
| `rootMarkers` | `workspace: ['*.sln', '*.slnx']`, `module: ['*.csproj']` |
| `watchGlobs` | `**/*.cs`, `**/*.csproj`, `**/*.sln`, `**/*.slnx`, `**/*.props`, `**/*.targets`, `**/global.json` (all shapes `compileWatchGlobs` already supports) |
| `installHint` | `dotnet tool install --global csharp-ls` |
| `runsTools` | `csharp-ls, dotnet / MSBuild (evaluates project files)` |
| `resolveToolDir` | `dotnet` on PATH, else fixed dirs: win32 `C:\Program Files\dotnet`; darwin `/usr/local/share/dotnet`, `/opt/homebrew/bin`; linux `/usr/share/dotnet`, `/usr/lib/dotnet`; then `<home>/.dotnet` |
| `extraSearchDirs` | `$DOTNET_CLI_HOME/.dotnet/tools` if set, else `<home>/.dotnet/tools` (absolute only, deduped) |
| `requiresMarker` (new generic field, Go `false`) | `true`: with no `*.sln`/`*.slnx`/`*.csproj` from the file up to the workspace root, no server starts — csharp-ls on an ad-hoc root scans the whole tree for projects (monorepo cost). The doc gets the existing "not in a project" outcome |
| `watchIgnoreDirs` (new generic field, Go `[]`) | `['bin', 'obj']`: restore/build regenerates `obj/**/*.props`, `*.targets`, `*.g.cs`, which would otherwise feed `didChangeWatchedFiles` → reload → regenerate loops. Applied inside `compileWatchGlobs` (any path segment equal to an ignored dir → no match) |
| `childEnv` | copy of base; toolDir prepended to PATH; `DOTNET_ROOT = realpath(toolDir)` (a PATH `dotnet` is often a symlink: `/usr/bin/dotnet`, Homebrew) unless the user set it (a global-tool shim needs it when `dotnet` isn't on PATH); `DOTNET_CLI_TELEMETRY_OPTOUT=1` unless set |

**Pattern root markers — the one generic change.** A marker is either an exact basename (today) or
`*.<ext>` (same shape rule as `EXT_GLOB`; anything else throws, and a registry test compiles every
marker). `RootProbe` gains `list(dir): Promise<string[]>` (host: `fs.promises.readdir`, `[]` on
error). `anyExists` lists a directory only when a pattern marker is present, at most once per
ancestor, so Go's resolution performs **zero** extra I/O. `isRootMarker` matches patterns the same
way, so the watcher re-resolves on a `.sln`/`.csproj` add/remove. Root rule unchanged: highest
workspace-marker dir, else nearest module-marker dir, else ad-hoc workspace root; realpath
containment unchanged. Pattern extension compare is case-insensitive (`App.SLN` matches) and
needs a non-empty stem (`.sln` alone does not); exact basenames stay case-sensitive as today. With
`requiresMarker` the ad-hoc note never shows for C#, so `languageInfo().moduleMarker` (`*.csproj`)
is never rendered for it.

**Trust prompt discloses every served toolset.** Trust is per folder (`lsp-manager` `raisePrompt`
keys and reuses a pending prompt by folder), so granting it lets every registry server start
there. The prompt payload's `runsTools` becomes the registry-wide list, joined
`gopls, go list · csharp-ls, dotnet / MSBuild (evaluates project files)`; the headline still names
the requesting language.

**Trust prompt language (fix found while reading).** `app.tsx` builds the palette's "Workspace
Trust: Trust Current Folder" from `lspLanguages[0]` — with two servers a C# folder's prompt would
read "Go navigation runs tools … (gopls, go list)". It must use the active file's language when
that language is served, else the first served language. ASSUMED from source (only one language
existed until now); AC-B6 measures it.

Everything else — lazy start on first open, Workspace Trust gate, 60 s idle stop
(`IDLE_GRACE_MS`), crash-restart budget, PID-scoped tree kill, install toast copy built from
`displayName`/`binary`/`installHint`, palette restart command — is generic today and must not gain
a `csharp` branch. Decompiled-metadata results (`csharp:/metadata/…` URIs) are dropped by
`lsp-uri` (non-`file:` → null), so F12 into the BCL yields the existing "no definition" outcome.

### 2.7 Markdown & YAML

Both already map, tokenize synchronously and render (Markdown has a rendered view with TOC). The
one gap found: Markdown **source** folds only on `<!-- #region -->` markers and indentation, not
by heading (Monaco's `markdown.js` `folding.markers`). v1 adds a `FoldingRangeProvider` for
`markdown` that folds each ATX heading (`#`…`######`, outside fenced code) to the line before the
next heading of the same or higher level. YAML folds by indentation (`offSide: true`) — no change.

### 2.8 Sleep / scalability audit

| Item | Evidence | Verdict |
|---|---|---|
| Language servers | `lsp-manager` starts a server only from `open` (didOpen of a served language, `lsp-manager.ts:413→609`) and stops it `IDLE_GRACE_MS`=60 s after its last doc closes (`:703`); go-lsp e2e asserts no gopls in an untrusted folder | Lazy + sleeps (source + existing e2e); AC-B4 re-asserts for C# |
| Grammars | `ensureTokenizer` registers per language on first open; Monarch tokenizes on the main thread incrementally, viewport-first | No idle cost; log grammar adds only bundle bytes |
| Workers | Only Monaco's editor/TS workers (`monaco-setup.ts`) and pdf.js (lazy); nothing per new language | No change |
| Watchers | One `watchServerRoot` per running server; gone with the server | No change |
| Large-file read | Whole-file read (§2.5) | **Fixed by §2.5** |

## 3. Data / interface contract

- `FileContentDTO` (`src/protocol.ts`) gains optional `window?: 'tail'` and
  `readOnlyReason?: 'invalid-utf8' | 'mixed-eol'`. `truncated` keeps its meaning (content is a
  window of the file); every existing `truncated` consumer stays correct for a tail window.
- `RootProbe.list(dir)`; marker grammar `basename | '*.' ext`.
- `langFromPath` adds the `log` id and golden/rotation rules; `isGoldenPath(p)` exported.
- Theme: two new code-palette tokens `--syn-error`, `--syn-warn`, defined in **every** block that
  defines `--syn-default` (`:root`, `[data-theme="aero"]`, `[data-theme="neon"]`); `ensureTheme`
  adds rules `log-error` → `--syn-error`, `log-warn` → `--syn-warn`, `log-info` → `--syn-type`.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| language id for a path | `langFromPath` | host `readFile`, `code-viewer`, `diff-viewer`, `doc-view`, Review hljs, `lsp-sync` routing | yes |
| text window + flags | host `readFile` | `code-viewer` (readOnly, banner, markers), `file-saves` attach, Review HEAD read (separate path, untouched) | yes |
| disk text on save | `file-saves` `SaveModel` adapter (`getValue`, BOM kept) | host `writeFile` (UTF-8) and its `compareOnDisk` (decodes disk with `toString('utf8')`, BOM kept — consistent; invalid-UTF-8 and window docs are never writable, so the fatal decode never reaches it) | yes |
| watch events | `lsp-watcher` via `compileWatchGlobs(globs, ignoreDirs)` | `lsp-manager` `didChangeWatchedFiles` | yes |
| root markers | registry | `lsp-root` resolve, `lsp-watcher` `isMarker`, nav-outcome ad-hoc note | yes |
| trust prompt language | `app.tsx` palette | host `requestTrust` → `trust-prompt.tsx` | yes |

## 4. Edge cases & failure modes

| Condition | Expected |
|---|---|
| Log appended while open (agent log) | Existing on-disk-change path; a re-read is O(cap) now, never O(file) |
| 0-byte / 1-line / no-newline log | Renders; a tail window with no `\n` at all shows the window as-is |
| Tail window starts mid-CRLF | First-`\n` cut removes it |
| Log with NUL bytes in the window | Binary notice (unchanged rule) |
| `.log` under the cap | Full file, editable (a log is not inherently read-only) |
| `UPPER.LOG`, `App.Log.1` | Case-insensitive match |
| `x.golden` that is binary | Binary notice (unchanged) |
| Golden saved after an edit, pure LF/CRLF | Bytes outside the edit identical |
| BOM + CRLF file | Both preserved |
| `.cs` file with no `.sln`/`.csproj` up to the workspace root | No server (`requiresMarker`); existing not-in-a-project outcome |
| `csharp-ls` installed but no .NET SDK | As the runtime-only row; the install hint presumes an SDK (`dotnet tool` needs one) |
| Directory with many entries on the root walk | One `readdir` per ancestor, only for C# docs |
| `csharp-ls` present but only a .NET runtime (no SDK) | Server starts, MSBuild load fails, requests return empty → existing "none" outcome; stderr tail in the log |
| `dotnet` absent but `csharp-ls` found | Starts; if it exits, the existing crash budget/toast applies |
| csharp-ls cold load (solution evaluation) | Requests queue (existing); status shows loading |
| Two `.sln` in one dir | Same root dir; csharp-ls picks — not Conduit's call |
| Untrusted folder | No csharp-ls / dotnet process at all |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Log tail vs head for >2 MB | tail | no | The newest lines are what a log is opened for |
| Large-file cap | 2 MB (unchanged) | no | Shared with Review's HEAD read |
| Mixed-EOL read-only | golden only | no | Goldens are byte contracts; elsewhere VS Code parity |
| C# server binary | `csharp-ls` | no (code-defined registry, ADR 0006) | Trust model forbids workspace-supplied servers |

## 6. Scope slicing

- **MVP (must):** §2.1, §2.2 + theme tokens, §2.3, §2.4, §2.5, §2.6 incl. pattern markers and the
  trust-language fix, e2e scenarios §7.
- **v1 (should):** Markdown heading folding (§2.7).
- **Vision:** live follow for logs; log-level filtering; encoding picker; Razor; C# diagnostics once
  the client consumes `publishDiagnostics`.
- **Out of scope:** YAML server, formatters, a settings surface for any of the above.

## 7. Acceptance criteria

New e2e scenarios on the shared harness: **`language-files`** (lane A) and **`csharp-lsp`**
(lane B). Both run remotely (`npm run e2e:remote -- language-files csharp-lsp`); add both to the
coverage map so `--affected` selects them. Model language ids are read through the same Monaco
handle `go-files.e2e.mjs` uses for `gomod`.

**Lane A (`language-files`, fixture written to a temp dir):**
- **AC-A1** `README.md` opens rendered; `config.yaml` model language is `yaml` with ≥ 1 non-default
  token class on line 1 and folding available on a nested map.
- **AC-A2** `app.log`, `app.log.1`, `app.log.2026-10-01` → language `log`; a line
  `2026-10-08T12:00:00.123Z ERROR boom "x"` paints the level in `--syn-error`'s colour, the
  timestamp in `--syn-comment`'s, the string in `--syn-string`'s — checked on the FIRST frame after
  open, under all three themes.
- **AC-A3** `expected.json.golden` → `json`; `README.md.golden` opens in the **code editor**
  (language `markdown`, no rendered view); `plain.golden` → `plaintext`.
- **AC-A4** WHEN a pure-CRLF `out.txt.golden` and a BOM+LF `bom.txt` are edited (type one char,
  delete it, type `x` at end) and saved, THE file on disk SHALL equal the original bytes plus `x`.
- **AC-A5** A mixed-EOL `mixed.txt.golden` and an invalid-UTF-8 `latin1.txt` open read-only with
  their banners; typing changes nothing; disk bytes unchanged after Ctrl+S.
- **AC-A6** A 40 MB `big.log` opens showing its LAST line at the end of the model, first model
  line is a whole line, banner reads the tail copy; a 40 MB `big.txt` shows its first line (head).
- **AC-A4b** A BOM file opened and closed without typing is not marked dirty and its mtime is
  unchanged (auto-save `afterDelay` on).
- **AC-A6b** Opening `big.log` through a search hit at line 5 shows the tail toast and the doc at
  its end; appending 100 lines while scrolled to the bottom keeps the last line in view.
- **AC-A7** Unit (`file-service.test.ts`): for a file over the cap, `readFile` never calls
  `fs.promises.readFile` and returns exactly the head/tail window; ≤ cap unchanged.
- **AC-A8** Unit (`lang.test.ts`): every §2.1 example; (`log-grammar.test.ts`, gomod-test style)
  each token row of §2.2 incl. the word-boundary negatives; (`theme-tokens.test.ts`) `--syn-error`
  and `--syn-warn` defined in all three theme blocks with ≥ 4.5:1 contrast on that theme's
  `--code-base`.
- **AC-A9 (v1)** Markdown source: a `## B` section folds to just before the next `##`/`#`; a `#`
  inside a fenced block is not a fold start; `<!-- #region -->`/`#endregion` pairs and fenced code
  blocks still fold — a registered provider REPLACES Monaco's indentation/marker folding, so it
  emits those itself (unit + one e2e assertion).

**Lane B (`csharp-lsp`, fixture: `App.sln`, `src/App/App.csproj`, `Program.cs` calling a method in
`Greeter.cs`):**
- **AC-B1 (always runs)** With `csharp-ls` unreachable (PATH stripped of `.dotnet/tools`, HOME /
  USERPROFILE / DOTNET_CLI_HOME at an empty temp dir — the go-lsp E5 mechanism), F12 in
  `Program.cs` shows exactly one toast "C# navigation needs csharp-ls — install with
  `dotnet tool install --global csharp-ls`", no error toast, file still editable.
- **AC-B2** Untrusted folder: opening `Program.cs` spawns no `csharp-ls`/`dotnet` descendant.
- **AC-B3 (installed)** Trusted: F12 on the call lands in `Greeter.cs` at the method; hover shows
  its signature; breadcrumbs show the class. Server reaches `ready` within 180 s.
- **AC-B4** After the last `.cs` tab closes, the server stops within `IDLE_GRACE_MS` + 10 s; no
  csharp-ls descendant survives app quit.
- **AC-B5** Unit (`lsp-root.test.ts`): `.sln` two levels up beats a nearer `.csproj`; `.csproj`
  alone roots at its dir; a Go spec resolution makes zero `list` calls; `isRootMarker` matches
  `Foo.sln`, not `Foo.sln.bak`; (`lsp-registry.test.ts`) every marker and glob compiles, an
  unsupported marker shape throws, `childEnv` sets `DOTNET_ROOT` (realpath'd) only when unset and
  never mutates base; `requiresMarker` with no marker resolves to no server (Go unchanged:
  ad-hoc); `compileWatchGlobs` with `['bin','obj']` rejects `src/App/obj/x.props` and accepts
  `src/App/Program.cs`.
- **AC-B6** With a `.cs` file active, palette "Trust Current Folder" raises a prompt naming
  **C#**; with a `.go` file active it names Go; either way the tools line lists both toolsets.
- **CI:** `.github/workflows/e2e.yml` installs a pinned `csharp-ls` (`dotnet tool install
  --global csharp-ls --version <pin>`, `~/.dotnet/tools` appended to `GITHUB_PATH`) when the
  shard runs `csharp-lsp`, mirroring the gopls step. AC-B3/B4 assert installation like go-lsp
  does (a missing server fails, never skips).

```gherkin
Scenario: a huge log opens at its end without loading the file
  Given a 640 MB app.log in the open project
  When the user opens it
  Then the editor shows the file's last line and the tail banner
  And readFile reads only the last 2 MB (AC-A7 is the measurable check)
```

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| Editor banner | truncated head | "Large file — showing the first 2 MB, read-only." (unchanged) | none |
| Editor banner | truncated tail (log) | "Large log — showing the last 2 MB, read-only." | none |
| Editor banner | invalid-utf8 | "Not valid UTF-8 — read-only so saving can't change its bytes." | none |
| Editor banner | mixed-eol golden | "Line endings the editor would rewrite — read-only so this golden file stays byte-exact." | none |
| Toast | csharp-ls missing | generic install toast (once per session, existing rule) | copy command text |
| Trust prompt | C# folder | "C# navigation runs tools from this project (csharp-ls, dotnet / MSBuild …)" | Trust / Not now (existing) |
| Status/loading | csharp-ls loading | existing LSP loading status | none |

## 9. Interaction inventory (UI)

No new controls. Existing: F12 / Ctrl+click / Shift+F12 / hover / breadcrumbs for C#; fold
chevrons and `Ctrl+Shift+[`/`]` for Markdown headings and log stack traces; palette restart
command "Restart C# language server" (generic). Read-only docs: typing is a no-op and announces the
banner once through the existing live region.

## 10. Accessibility & i18n (UI)

- Banners reuse the truncated banner's element/role; the one-shot announcement carries each
  reason's copy.
- Log severity is never colour-only: the level word itself is the text; colour is reinforcement.
  `--syn-error`/`--syn-warn` ≥ 4.5:1 on `--code-base` in all themes (AC-A8); level words keep their
  weight (no italics), so they stay legible in high-contrast OS modes.
- New copy lives in `auto-save-copy.ts` beside `partialBanner` (one place, as today). Level-word
  matching is English-token by nature (log formats are), not UI text.

## 11. Design tokens (UI)

`--syn-error`, `--syn-warn` (new, per theme, code palette — the code panel is ink in every theme,
so they are tuned against `--code-base`, NOT the app's `--danger`/`--warn`, which are tuned for app
surfaces and fail on ink under Aero). Info/debug/timestamps/strings reuse `--syn-type`,
`--syn-comment`, `--syn-number`, `--syn-string`. No raw hex in rules; `ensureTheme` reads vars.

## 12. Assumptions

- A1 Rotated-log patterns limited to `.log.<digits>` and `.log.<date…>`; `.out`/`.err` stay plain.
- A2 Golden strips exactly one `.golden`; `.snap`/`.approved.*` not included.
- A3 Goldens always open in source view (never rendered Markdown/HTML).
- A4 Tail windows are read-only like head windows (saving would drop the head).
- A5 `csharp-ls` (not OmniSharp / Roslyn LS): single self-contained dotnet tool, plain stdio LSP,
  matches the "optional binary + install hint" model.
- A6 windows-latest images ship a .NET SDK able to run the pinned csharp-ls (ASSUMED, unmeasured;
  locally `dotnet --version` fails — no SDK — so only AC-B1/B2/B5/B6 are runnable on this machine).
- A7 The `file-saves.ts` `SaveModel` binding and its rename copy are the only model→disk text
  paths (ASSUMED from grep of `getValue()` in save code).
- A8 Rendered Markdown/HTML views show no `readOnlyReason` banner (as with `truncated` today);
  it appears once switched to source.

## 13. Decisions Needed

- **[normal] D1 csharp-ls pin & CI install.** Default: pin the latest csharp-ls release whose
  target framework the windows-latest SDK runs; install only on shards running `csharp-lsp`. If the
  runner's SDK can't run it, AC-B3/B4 move to `remote-exclusions.json` with a reason, and AC-B1/B2
  still gate.
- **[normal] D2 Invalid UTF-8 read-only for ALL files** (not just goldens). Default: all files —
  saving would irreversibly replace bytes with U+FFFD. Alternative: golden-only, matching D3.
- **[normal] D3 Mixed EOL read-only for goldens only.** Default: goldens only; other files keep
  Monaco/VS Code normalisation on save. Alternative: all files read-only (safer, but blocks editing
  common mixed-EOL sources).
- **[normal] D5 Line navigation into a tail window** toasts instead of mapping. Default: toast.
  Alternative (larger): a streaming O(file)-I/O, O(1)-memory newline count yields the window's
  first line → real line numbers (`lineNumbers` offset) and exact reveals.
- **[normal] D6 C# requires a project marker** (`requiresMarker`). Default: no server without
  `.sln`/`.csproj`. Alternative: ad-hoc workspace root like Go, at monorepo scan cost.
- **[normal] D4 Log tail for oversized logs** changes what a >2 MB `.log` shows (end instead of
  start). Default: tail. No setting.

## Self-audit

Sections 1–13 filled; UI module (8–11) filled; every current-behavior claim is measured or marked
ASSUMED and mirrored (A6, A7, trust-language in §2.6/AC-B6); every §3 flow names both sides.
