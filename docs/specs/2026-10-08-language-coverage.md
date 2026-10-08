---
status: active
date: 2026-10-08
---

# Feature Spec: language coverage — every common file colours, the top languages navigate

**Tier:** FULL   **Feature type:** mostly non-UI (language resolution, grammars, host LSP policy);
small UI surface (install toasts, trust prompt copy, status) reuses existing components.
**One-line request:** "Did you add support for all the famous programming languages or did you skip
this? Use the feature spec to fully support whatever needs to be supported. Also obviously, look at
the edge cases and performance issues."

Builds on the shipped [language-support](archive/2026-10-08-language-support.md) spec (structure,
golden/tail/read-only rules — all kept), ADR 0006 (host-side servers, code-defined registry,
Workspace Trust) and the [resource audit](../runs/2026-10-01-resource-audit/report.md).

## 1. Problem frame

- **Job:** open any file a working developer meets — source, build file, config, dotfile,
  extensionless script — and get correct colouring on the first frame; for the most-used languages
  also get F12 / Shift+F12 / hover / breadcrumbs — without the app getting heavier when those
  languages are idle.
- **Answer to the user's question:** v0.46.0 did **not** cover everything. Measured (§2.1): 38 of
  Monaco 0.55.1's 81 basic-language grammars are unused (43 imported), and `Makefile`, `CMakeLists.txt`, `Gemfile`,
  `.gitignore`, `.env`, `.json5`/`.jsonl`, `.pyi`, `.csproj`, `.patch`, `Dockerfile.dev` and every
  extensionless script all open as **plain text**; `.toml` is coloured with the INI grammar. Code
  navigation exists only for TS/JS (own worker), Go and C#.
- **Actors:** the user; agents writing files under them; several sessions/windows sharing roots.
- **Success outcomes (observable):** every row of the §2.2 table opens with its target language
  id and ≥ 1 coloured token on line 1; an extensionless `#!/usr/bin/env python3` script colours as
  Python and navigates; Python, Rust, C and C++ get Go-parity navigation when their server is
  installed and exactly one install toast when it is not; with five languages open the app never
  runs more than the §2.6 server budget; nothing new runs at launch.
- **Non-goals:** diagnostics, formatting, completion (the LSP client stays nav-only); servers for
  Java, Ruby, PHP, Kotlin, Swift, Lua, Bash, Zig, Haskell, Elixir, Dart, Scala (§2.5 says why each);
  grammars for Haskell, Zig, Nix, Erlang, LaTeX, Astro, CSV, Svelte/Vue template syntax (§2.3 cut
  line); Emacs/vim modelines; user-configurable file associations; a settings UI for any of this.

## 2. Behavior & states

### 2.1 Current behavior (measured unless marked)

| Claim | How measured | Status |
|---|---|---|
| `langFromPath` returns `plaintext` for Makefile, GNUmakefile, Makefile.am, CMakeLists.txt, *.cmake, Gemfile, Rakefile, *.rake, *.gemspec, Podfile, Vagrantfile, Jenkinsfile, Brewfile, build.gradle, *.groovy, .gitignore, .dockerignore, .gitattributes, .editorconfig, .env, .env.local, .babelrc, .eslintrc, .prettierrc, *.json5, *.jsonl, *.ndjson, *.pyi, *.pyw, *.cshtml, *.razor, *.m, *.mm, *.hxx, *.psd1, Dockerfile.dev, Cargo.lock, *.diff, *.patch, *.csproj, *.props, *.sln, *.xsd, *.config, *.hbs, *.twig, *.pug, *.coffee, *.liquid, *.bicep, *.wgsl, *.cljc, *.edn, *.sbt, *.v, *.sv, *.rst, *.mk, Pipfile, .profile, .zprofile, PKGBUILD, *.ksh, *.erb, *.scm, *.rkt, *.Rmd, *.qs; `.toml` → `ini`; `.vue`/`.svelte` → `html`; `X.TS`, `FOO.PY`, `x.d.ts`, `dev.Dockerfile`, `tsconfig.base.json`, `build.gradle.kts` resolve correctly | esbuild-bundled `src/lang.ts`, `langFromPath` over 130 names (node) | Measured |
| Every Monaco basic-language module is already in `out/webview.js` (28,716,758 B, unminified) — 74 distinct non-empty `tokenPostfix` values incl. objective-c, pug, coffee, bicep, wgsl, plus 5 empty-postfix grammars (razor, twig, handlebars, liquid among them — ASSUMED by elimination) | `grep -o 'tokenPostfix: "…"' out/webview.js \| sort -u` | Measured — **mapping a Monaco grammar costs 0 bytes** |
| A custom grammar is ~2–4 KB of bundle (unminified build) | `wc -c` gomod-grammar.ts 2,144 B, log-grammar.ts 4,047 B | Measured (source size ≈ bundle size, no minify in `esbuild.mjs`) |
| No Python/Rust/C/C++ server is installed on this machine (gopls, dotnet present; csharp-ls absent) — so no server RSS is measurable here; the §2.6 weights are from public figures | `Get-Command` over 27 binaries | Measured (absence); weights ASSUMED |
| On win32 `findBinary` accepts `.exe` only (Node refuses `.cmd` without a shell), so npm-installed servers (`pyright-langserver.cmd`, `bash-language-server.cmd`, `intelephense.cmd`) are invisible | `src/lsp-binary.ts:60-67` | ASSUMED (source) — drives the §2.5 install choices |
| LSP sync covers every open **file tab of every session** in the window, not just visible ones, so a hidden session's `.rs` tab keeps rust-analyzer alive | `webview/app.tsx:1653-1668`, `webview/docs.ts:54` | ASSUMED (source) — AC-C2 measures |
| A >2 MB served file's **head window** is synced to the server as if it were the whole file (no `truncated` guard in the sync path) | grep `truncated` in `app.tsx` sync effect / `lsp-sync.ts`: none | ASSUMED (source) — AC-B8 measures |
| Servers are keyed `languageId:realRoot`, one `LspManager` per app, shared across windows; a stopped record that still has docs relaunches on the next open/request with a didOpen replay of host-held text | `src/lsp-root.ts:52`, `electron/main.ts:4356`, `lsp-manager.ts` `touch` :458/:842, `stopRecord` | ASSUMED (source) — AC-C3 measures |
| `workspace/configuration` is answered `null` per item; `initialize` sends no `initializationOptions` | `electron/lsp-server.ts:92-118,174` | ASSUMED (source) |
| Each running server owns one recursive watch on its root; three languages in one root = three recursive watches | `electron/lsp-watcher.ts:91`, `lsp-manager.ts` `launch` | ASSUMED (source) |
| The global watch filter already drops `node_modules`, `.cache`, `build`, `dist`, `out` | `src/watch-filter.ts:8-19` | ASSUMED (source) |
| INI on TOML: `[[bin]]` paints as `[[bin]` + `]`; dotted/quoted/hyphenated/indented keys are not keys; a trailing `# x` after a value is not a comment; `"""` multi-line strings break per line | `monaco-editor/esm/vs/basic-languages/ini/ini.js` rules | ASSUMED (source) — AC-A3 measures the fixed grammar |
| JSON validation never runs (`getWorker` maps the `json` label to the plain editor worker), so `tsconfig.json` / `.json5` comments raise no markers | `webview/monaco-setup.ts:8-13` | ASSUMED (source) — no change needed; AC-A6 checks comments colour as `comment` |
| `didOpen.languageId` is the server spec's id, not the doc's (`DocEntry` has no language) | `lsp-manager.ts:518` | ASSUMED (source) |
| `findBinary` returns the realpath; a rustup proxy that is a symlink to `rustup` (distro packages) would then be spawned as `rustup` and argv0 dispatch fails | `src/lsp-binary.ts:64-69` | ASSUMED (source) |
| The trust prompt's tools line is one `string` joined with ` · ` | `lsp-manager.ts:327`, `lsp-protocol.ts:79`, `trust-prompt.tsx:40` | ASSUMED (source) |

### 2.2 Language resolution (`src/lang.ts`, shared host + renderer)

Order, first match wins (golden stripping and rotated logs unchanged from the archived spec):
1. **Exact filename** (lowercased basename) — table below.
2. **Filename prefix rules, only when the extension is NOT in the extension table:**
   `dockerfile.*`, `containerfile.*` → `dockerfile`; `.env` and `.env.*` (`.env.local`,
   `.env.production`, `.env.example`) → `dotenv`; `.envrc` → `shell` (exact entry wins at step 1).
   So `Dockerfile.dev` → dockerfile but `Makefile.toml` (cargo-make) → toml and `.env.json` → json.
   `makefile.am` / `makefile.in` are exact entries, not a prefix rule.
3. Rotated logs (unchanged). 4. **Extension** (lowercased last segment).
5. **Shebang** (host only, content-based; §2.4) — only when steps 1–4 gave `plaintext` and the
   name has no exact-table entry (so `go.sum` stays plain).

| Target id | New extensions | New exact filenames |
|---|---|---|
| `python` | `pyi pyw` | — |
| `cpp` | `hxx ipp inl tpp cu cuh ino` | — |
| `objective-c` (Monaco; colour only, no server) | `mm` (`.m` stays plain: MATLAB/Octave share it) | — |
| `csharp` | `csx cake` | — |
| `razor` (Monaco) | `cshtml razor` | — |
| `fsharp` | `fsi fsscript` | — |
| `ocaml` → fsharp grammar alias | `ml mli` | — |
| `ruby` | `rake gemspec ru rbw` | `gemfile rakefile podfile vagrantfile brewfile guardfile fastfile appfile` |
| `powershell` | `psd1` | — |
| `php` | `phtml` | — |
| `html` | `xhtml shtml` | — |
| `xml` | `xsd xsl xslt csproj fsproj vbproj props targets config resx nuspec wxs` | — |
| `json` | `json5 jsonl ndjson` | `.babelrc .eslintrc .prettierrc .swcrc .jshintrc` |
| `clojure` | `cljc edn` | — |
| `scala` | `sbt` | — |
| `shell` | `ksh mksh` | `.profile .zprofile .zshenv .bash_aliases .bash_logout .envrc pkgbuild` |
| `ini` | — | `.gitconfig .editorconfig .npmrc .gitattributes tox.ini` (ext already) |
| `toml` (new grammar) | `toml` (was `ini`) | `cargo.lock poetry.lock uv.lock pipfile` |
| `makefile` (new grammar) | `mk mak` | `makefile gnumakefile makefile.am makefile.in` |
| `cmake` (new grammar) | `cmake` | `cmakelists.txt` |
| `diff` (new grammar) | `diff patch rej` | — |
| `ignore` (new grammar) | — | `.gitignore .dockerignore .npmignore .prettierignore .eslintignore .gcloudignore .vscodeignore` |
| `dotenv` → ini grammar alias | `env` | (prefix rule) |
| `groovy` → java grammar alias | `groovy gradle gvy` | `jenkinsfile` |
| Monaco grammars newly mapped | `coffee`→`coffeescript`, `hbs handlebars`→`handlebars`, `twig`, `pug jade`→`pug`, `liquid`, `bicep`, `wgsl`, `scm ss rkt`→`scheme`, `rst`→`restructuredtext`, `sv svh`→`systemverilog`, `v vh`→`verilog`, `tsp`→`typespec`, `cypher cyp`→`cypher`, `pq pqm`→`powerquery`, `qs`→`qsharp`, `rq`→`sparql`, `dart` (already) | — |

Every new id is named in `DISPLAY_NAMES` (typecheck enforces it) and in `MONACO_TO_HLJS`
(`webview/syntax-highlight.ts`, Review's hljs path — the full hljs build has `makefile`, `cmake`,
`diff`, `ini` for TOML/dotenv, `groovy`, `ocaml`, `objectivec`, `coffeescript`, `handlebars`,
`twig`, `scheme`, `verilog`; ids hljs lacks map to `null`, incl. today's unmapped `gomod`/`log`).
`MONACO_TO_HLJS` becomes typed by `LanguageId` the same way so a new id fails typecheck until
mapped. **Every newly mapped Monaco grammar is statically imported into `GRAMMARS`** — otherwise
`ensureTokenizer` takes the async `colorize` warm-up and the first frame is unstyled. Aliases
(`dotenv`→ini, `groovy`→java, `ocaml`→fsharp) are `GRAMMARS` entries pointing at an existing module
(zero bytes) **and** are `monaco.languages.register`ed at load like `gomod`/`log` — the `c: cpp`
precedent only works because Monaco registers `c` itself. Colouring is approximate (A3/A4).
`plan-code-block.tsx:49` resolves fences as `block.<fence>`; it gains a fence-name table
(`makefile make cmake toml diff patch dotenv env gitignore groovy ocaml`) checked first, so
```` ```makefile ```` colours.

**Not mapped (Monaco grammar exists, extension is ambiguous or niche):** `apex` (`.cls` is also
LaTeX), `mips` (`.s` is every assembler), `objective-c` for `.m` (MATLAB), `freemarker2` (`.ftl`
is also Mozilla Fluent), `scala` for `.sc` (SuperCollider), `abap`, `azcli`, `cameligo`, `csp`, `ecl`, `flow9`,
`lexon`, `m3`, `msdax`, `pascaligo`, `pla`, `postiats`, `redis`, `sb`, `sophia`, `st`, and the
SQL dialect ids (`.sql` stays `sql`).

### 2.3 Custom grammars — ranking and cut line

Ranked by real-world frequency in the repos Conduit opens (GitHub top-language + build-file
prevalence; ASSUMED ranking). Above the line ships; below is a non-goal.

| # | Grammar | Today | Why it earns bytes |
|---|---|---|---|
| 1 | **TOML** | ini (wrong) | `Cargo.toml`, `pyproject.toml`, the tier-1 servers' own manifests |
| 2 | **diff/patch** | plaintext | agents emit patches; Conduit is an agent tool |
| 3 | **Makefile** | plaintext | C/C++ tier-1, every older repo |
| 4 | **CMake** | plaintext | C/C++ tier-1 (clangd) |
| 5 | **ignore files** | plaintext | in every repo; comments + negation + globs, tiny |
| — cut — | Haskell, Zig, Nix, Erlang, LaTeX, Astro, Svelte/Vue template blocks, CSV | plaintext / html | lower frequency; html for `.vue`/`.svelte` already colours their `<script>`/`<style>` |

Grammar rules (all five), from the `log-grammar` review discipline:
- **Linear time:** no nested quantifiers (`(a+)+`, `(a|ab)*`), no alternation with overlapping
  prefixes under `*`, every rule anchored or consuming ≥ 1 char; multi-line constructs (TOML `"""`,
  `'''`; CMake `[[ ]]`/`[=[ ]=]` bracket args and comments) are Monarch **states**, never a regex
  spanning lines.
- Tokens use only existing themed classes (`comment keyword string number type`, plus `log-error`
  reused for removed lines); no new `--syn-*` token, so no theme-block changes.
- Each grammar file exports a `Grammar` (gomod precedent), Monaco-free, unit-tested with the
  log-grammar rule runner; ids registered at module load like `gomod`/`log`.

| Grammar | Token rules (summary) |
|---|---|
| TOML | `#…` comment anywhere; `[table]`, `[[array.table]]` (incl. dotted/quoted parts) → `type`; bare/dotted/quoted/hyphenated keys before `=` (also indented) → `keyword`; basic/literal strings; `"""`/`'''` multi-line states; integers (`_`, `0x/0o/0b`), floats, `inf`/`nan`, booleans, RFC 3339 date-times → `number` |
| diff | `diff --git`, `index`, `---`/`+++` headers → `keyword`; `@@ … @@` → `type` (trailing context plain); `+…` → `string`; `-…` → `log-error`; `\ No newline at end of file` → `comment`; anything else plain. Whole-line, column-0 rules only |
| Makefile | `#` comments (with `\` continuation state); `target:` / `target::` → `type`; `VAR =`, `:=`, `?=`, `+=`, `!=` → `keyword`; `$(…)`/`${…}`/`$@ $< $^ $*` → `number` (`$(` opens a paren-counting state, never a recursive regex); directives (`include`, `ifeq`, `ifdef`, `define`, `.PHONY`, `export`) → `keyword`; recipe lines (leading TAB) are shell-ish: strings + `$(…)` only |
| CMake | `#` comment and `#[[…]]` bracket comment state; command name before `(` → `keyword` (case-insensitive); `${VAR}`, `$ENV{X}` → `number`; quoted and bracket arguments → `string`; `TRUE/FALSE/ON/OFF` → `number` |
| ignore | `#` comment at col 0; leading `!` → `keyword`; `*`, `**`, `?`, `[…]` → `type`; trailing `/` → `type`; rest plain |

Language configuration: comment chars and brackets per format; TOML/Makefile/CMake fold by
indentation; diff folds each `diff --git` file and each `@@` hunk via a `FoldingRangeProvider`
(markdown-folding precedent, emitting indentation folds is unnecessary for diff).

### 2.4 Shebang detection

- **Where:** host `readFile` (`src/file-service.ts`), which already holds the content and is the
  producer of `FileContentDTO.language`. New pure `langFromShebang(firstLine): LanguageId | null`
  in `src/lang.ts`; `readFile` calls it only when `langFromPath` returned `plaintext` and no exact
  filename matched, on at most the first 256 chars up to the first `\n`. Cost: O(256) per such
  open, zero for every other file.
- **Parse:** `^#!\s*(\S+)(.*)$`. If the command's basename is `env`, take the first argument that
  is not a flag (`-S`, `-i`, `-u NAME`, `--`) and not `NAME=value`. Strip a version suffix
  (`python3.12` → `python`, `pwsh-preview` → `pwsh`). Map: `python python2 python3 pypy pypy3 uv
  uvx` → `python`; `node nodejs bun` → `javascript`; `deno tsx ts-node` → `typescript`; `sh bash
  dash ash zsh ksh mksh fish` → `shell`; `ruby` → `ruby`; `perl` → `perl`; `pwsh powershell` →
  `powershell`; `php` → `php`; `lua luajit` → `lua`; `Rscript` → `r`; `julia`; `elixir` →
  `elixir`; `tclsh wish` → `tcl`; `make` → `makefile`. Unknown → null (stays plaintext). `uv run`
  / `uvx` scripts are Python (PEP 723).
- Runs **after** `isBinary` (binary → no sniff). A truncated head window is sniffed too (the
  shebang is on line 1), so a 3 MB extensionless script gets a language but is never synced
  (§3 sync invariant).
- **Consumers that recompute from the path** (producer/consumer pairs in §3): `lsp-sync`
  `syncLanguageFor` and the trust palette (`app.tsx:3983`) take the file's DTO language;
  `lsp-nav.ts:113` `modelForTarget` has host text, no DTO — it runs `langFromShebang` on that
  text's first line when the path gives `plaintext` (else a plaintext model gets cached under the
  URI and reused by code-viewer); the rename path `app.tsx:3175` keeps the old doc's language when
  the new path resolves to `plaintext`; `diff-viewer` sniffs its modified-side text; Review hljs
  (`review-view.tsx:2647`) sniffs only when the hunk starts at new-side line 1, else path-based.
- **Language changes while open** (an agent writes a shebang into an open extensionless file):
  the re-read DTO carries the new language; code-viewer already calls `setModelLanguage` on a
  mismatch, and the sync reconcile keys docs by path **and** language, so it closes and reopens
  the doc under the new id. Typing `#!…` into a buffer does not re-sniff until the next disk read.

### 2.5 Code navigation — server choices

Tier-1 (ships): **Python, Rust, C/C++.** Chosen by usage × install friction × what CI
can install on `windows-latest` in < 2 min, and each installable as a real `.exe` on Windows.

| Field | Python | Rust | C / C++ |
|---|---|---|---|
| Server | `basedpyright-langserver --stdio` (alt binary `pyright-langserver`) | `rust-analyzer` | `clangd` |
| Install hint | `pip install basedpyright` (or `uv tool install basedpyright`) | `rustup component add rust-analyzer` | install LLVM (`winget install LLVM.LLVM` / `brew install llvm` / `apt install clangd`) |
| Why this one | pip/uv ship an `.exe` console script; npm `pyright` is a `.cmd` (§2.1). basedpyright auto-uses a root `.venv` (ASSUMED). pylsp/jedi: weaker types for hover | the only Rust server | standard; works ad-hoc with fallback flags |
| `languageIds` (new) | `python` | `rust` | `c`, `cpp` |
| `rootMarkers` | ws `pyrightconfig.json`; module `pyproject.toml setup.py setup.cfg requirements.txt Pipfile` | ws `Cargo.lock`; module `Cargo.toml` | ws `compile_commands.json compile_flags.txt .clangd`; module `CMakeLists.txt meson.build Makefile` |
| `requiresMarker` | false (single scripts are common) | true (detached files give nothing) | false (clangd's fallback flags still navigate one TU) |
| `watchGlobs` | `**/*.py **/*.pyi **/pyproject.toml **/pyrightconfig.json **/setup.cfg` | `**/*.rs **/Cargo.toml **/Cargo.lock **/rust-toolchain.toml` | one `**/*.<ext>` per `c h cc cpp cxx hpp hh hxx ipp inl cu cuh` (braces are no supported glob shape), `**/compile_commands.json **/compile_flags.txt **/.clangd` |
| `watchIgnoreDirs` | `.venv venv __pycache__ .tox .mypy_cache .pytest_cache .ruff_cache` | `target` | `.cache` (already global), `CMakeFiles` |
| `settings` (new; answers `workspace/configuration` by section) / `initializationOptions` (new, explicit) | settings `basedpyright.analysis` and `python.analysis`: `{typeCheckingMode:'off', diagnosticMode:'openFilesOnly'}` — diagnostics are dropped, so type-checking is pure CPU | `initializationOptions` + settings `rust-analyzer`: `{checkOnSave:false}` — no `cargo check` on every save for diagnostics nobody sees | none |
| `args` | `['--stdio']` | `[]` | `['--background-index', '-j=2', '--header-insertion=never']` (D3) |
| `versionProbe` (new) | none | `['--version']` — the rustup proxy exists even when the component doesn't, exits non-zero → **absent**, not crashed | none |
| toolDir / env | none (inherits PATH; basedpyright runs the project's `python` itself) | `cargo` on PATH / `$CARGO_HOME/bin` / `~/.cargo/bin`, prepended; `RUSTUP_AUTO_INSTALL=0` unless the user set it — a repo's `rust-toolchain.toml` must not make opening a file download and run a toolchain (the `GOTOOLCHAIN=local` rule; ASSUMED env name, rustup ≥ 1.28) | none |
| `extraSearchDirs` | `~/.local/bin` (uv/pipx); win32 `%APPDATA%\Python\Python3*\Scripts` is versioned → not searched, PATH covers pip installs | `$CARGO_HOME/bin`, `~/.cargo/bin` | win32 `C:\Program Files\LLVM\bin`; darwin `/opt/homebrew/opt/llvm/bin`, `/usr/local/opt/llvm/bin`, `/Library/Developer/CommandLineTools/usr/bin` |
| `runsTools` (trust line) | `basedpyright, python (reads the interpreter's import paths)` | `rust-analyzer, cargo metadata, build scripts and proc-macros` | `clangd (reads compile_commands.json; writes .cache/clangd)` |
| `weight` (new, §2.6) | light | heavy | heavy |
| CI (e2e.yml) | `actions/setup-python` + `pip install basedpyright==<pin>` | runner's rustup + `rustup component add rust-analyzer` | runner's LLVM (`C:\Program Files\LLVM\bin`, ASSUMED present) else `choco install llvm` |

**Generic registry changes (no downstream language branch):**
1. `languageId` → `languageIds: readonly [string, ...string[]]`; the primary id `languageIds[0]`
   keys records (`serverKeyFor` in `lsp-root.ts`), `absentUntil`, the install toast (once per
   **server**, so `.h` + `.cpp` give one clangd toast), restart and statuses. `serverSpecFor(id)`
   matches **any** id in `languageIds`, so `lsp:open` / `lsp:trustRequest` / `lsp:restart` keep
   sending whatever id they have. `DocEntry` gains `languageId` from `msg.languageId`, and
   `didOpen.languageId` uses it (today `doc.spec.languageId`, `lsp-manager.ts:518`).
   `LspLanguageInfo` keeps `languageId` (primary) and gains `languageIds`; the renderer's served set
   is the union.
2. `altBinaries?: readonly string[]` searched (in order) when `binary` is not found; messages name
   `binary`.
3. `settings?: Readonly<Record<string, unknown>>` (section → value): `workspace/configuration`
   items answered by exact `section`, else `null` (today's behaviour). Python answers both
   `basedpyright.analysis` and `python.analysis` (the pyright alt binary reads the latter). A
   separate explicit `initializationOptions?: unknown` is sent in `initialize` when set
   (rust-analyzer: `{checkOnSave:false}`); it is not derived from `settings` (plan rev 2). A repo
   config (`pyrightconfig.json` strict mode) can still override — accepted (A10).
4. `versionProbe?: readonly string[]`: run at resolve, `cwd: ctx.tmpdir` (resolve precedes the
   trust check — nothing may run in the repo), 5 s timeout; non-zero/timeout → `absent` + install
   toast. A successful resolve is cached per server for the app session (cleared by palette restart
   and by an `absent` result), so wake/evict cycles don't re-probe.
5. `weight: 'light' | 'heavy'` (Go, Python light; C#, Rust, C/C++ heavy).
6. Trust prompt: protocol `runsTools: string` → `runsTools: string[]` (one per server,
   `lsp-protocol.ts:79`, `lsp-manager.ts:327`), rendered one line each in `trust-prompt.tsx`;
   headline still names the requesting language.
7. `findBinary` returns `{ path, realPath }`: spawn uses `path` (a rustup proxy symlinked to
   `rustup` dispatches on argv0); `resolveToolDir` keeps `realPath` (C#'s `DOTNET_ROOT` needs it).

**Deferred (non-goals, reasons):** Java/jdtls — needs JDK 21+, a per-root `-data` dir outside the
repo (args templated with a userData path), per-OS launcher/config, Gradle/Maven import executes
build scripts, ~1–2 GB RSS (ASSUMED); its own spec. Ruby/ruby-lsp — runs `bundle install` and
writes `.ruby-lsp/` into the repo. PHP/intelephense — npm `.cmd` on Windows and type/implementation
navigation is a paid tier. Kotlin — the community server is archived, JetBrains' is pre-release.
Swift/sourcekit-lsp — no reasonable Windows CI. Lua, Bash (npm `.cmd`), Zig — low usage in
Conduit's audience; each is a registry entry later once a `.cmd`-free install exists.

### 2.6 Server residency (host performance policy)

| Rule | Value |
|---|---|
| Live = state `starting / loading / ready / restarting` | `absent / restricted / crashed / stopped` never count |
| `HEAVY_LIVE_MAX` | 2 heavy servers |
| `LIVE_MAX` | 4 servers total |
| **Launch trigger (changed)** | `lsp:open` of a doc that is not visible **registers** the doc (record + text) but does not launch; a launch needs a visible doc or a request. Today every open launches (`touch` at `lsp-manager.ts:458`), so a hidden session's tabs start servers |
| Launch over budget | evict the **least-recently-used** live server that: has no in-flight request; is not `starting`/`loading`; has had no visible doc for ≥ `EVICT_MIN_HIDDEN_MS` = 60 s (hysteresis — tab-cycling `.rs`/`.cpp`/`.cs` must not cold-restart an indexer on every switch). Evict = `stopRecord` keeping the record (docs stay attached) |
| Eviction ordering | the new launch **awaits** the evictee's stop (shutdown ≤ 2 s, then tree kill) before spawning, so heavy processes never exceed the cap even transiently |
| Nothing evictable | launch anyway (soft cap) and log once — never refuse navigation the user asked for |
| Dormancy | a live server with no visible doc and no activity for `DORMANT_MS` = 10 min stops the same way |
| Wake | a doc becoming visible, or any request, `touch`es its record → relaunch + didOpen replay of the host-held text (unsaved edits included). Nav during the wake uses the existing wait-for-ready path (`NAV_LOADING_TIMEOUT_MS` 90 s, existing loading/timeout outcomes) |
| Activity (LRU clock) | `change`, `request`, `visible` (an invisible `open` is not activity) |
| `IDLE_GRACE_MS` (last tab closed) | unchanged 60 s |

**Visibility** is a new renderer→host message `lsp:visible { paths }` per client (the files shown
in either editor group of the active session), replaced on every change; the host takes the union
across clients (two windows on two monitors both count). A **minimized** window counts as `[]`:
the host learns it from `BrowserWindow` `minimize`/`restore`, beside the `gitDemand` suspend
precedent. It is not the renderer's `document.visibilityState`, which is `hidden` for every e2e
window (`show:false`) and for occluded windows (plan rev 2). A client's visible set is dropped in
the same places its doc refs are (`retireClient`, webContents gone: close, reload, crash), so a
dead window never pins a server.
Crash-restart budget, init deadline (90 s), absent TTL (30 s) and trust are unchanged and apply to
woken servers as to fresh ones.

**Shared watches — DEFERRED (follow-up, plan rev 2):** no measured force (no event-storm or
handle-count evidence that per-server recursive watches cost anything), and ref-counted shared
handles add a stale-handle bug class. Each server keeps its own watch. The design below is kept
for when a measurement justifies it. One recursive watch per **lexical root string** (exact, case-normalised on
win32), ref-counted across servers; each subscriber applies its own glob/ignore filter and gets its
own `onMarker`/`onGone` callbacks. Keying by lexical root keeps every event's path in the spelling
the server's didOpen URIs use (a real-root key would hand a junction-rooted server real-path URIs).
Only servers with the **same** root share — a Python module root in a subdirectory still has its
own watch.

**Startup / first-open costs:** nothing new at launch (custom ids `register` at module load as
today — a map insert); a grammar compiles on first open of its language (`ensureTokenizer`),
O(rules); a server starts only on first open of a served, trusted file.

## 3. Data / interface contract

- `src/lang.ts`: `LanguageId` gains the §2.2 ids; `langFromShebang(line: string): LanguageId |
  null` exported; `langFromPath` unchanged signature.
- `FileContentDTO.language` may now be shebang-derived; it is the authority for a file tab.
- `LanguageServerSpec`: `languageIds`, `altBinaries?`, `settings?`, `versionProbe?`, `weight`
  (§2.5). `LspLanguageInfo.languageIds`. `DocEntry.languageId`. Trust prompt `runsTools: string[]`.
  Protocol: `lsp:visible { paths: string[] }` (validated like `lsp:open`, ≤ 64 abs paths), no
  reply. Nav outcome reason `not-synced` with cause `too-large | encoding`, produced in the
  renderer (`lsp-nav` checks the tab's DTO before `lspRequest`, which would otherwise return a
  silent `empty` for an unsynced doc).
- Invariants: no registry entry is read from a workspace (ADR 0006); a golden, a `truncated`
  window and a `readOnlyReason: 'invalid-utf8'` doc are **never** synced; `stopRecord` on eviction
  never drops doc refs.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| language id for a path | `langFromPath` | host `readFile`, diff-viewer, Review hljs, lsp-sync, lsp-nav, rename, plan code block | yes |
| shebang language | host `readFile` / `langFromShebang` | code-viewer (DTO), lsp-sync, trust palette (`app.tsx:3983`), lsp-nav target models, rename, diff-viewer, Review hljs | yes (§2.4) |
| `not-synced` nav outcome | `lsp-nav` from DTO `truncated` / `readOnlyReason` | `nav-outcome` copy + live region | yes |
| trust tools list | registry `runsTools` per server | `trust-prompt.tsx` | yes |
| served language set | registry `languageIds` → `LspLanguageInfo` | `app.tsx` sync + hover registration + trust palette language, `lsp-status`, `nav-outcome` | yes |
| doc text to server | `app.tsx` sync effect (skips truncated / invalid-utf8 / golden) | `lsp-manager` didOpen/didChange | yes |
| visibility | `app.tsx` (`visibleFilePaths` of the active session) | `lsp-manager` residency | yes |
| server settings | registry `settings` | `lsp-server` initialize + `workspace/configuration` | yes |
| watch events | per-server root watch (unchanged; shared watch deferred) | each server's filter → `didChangeWatchedFiles` | n/a |
| Review/diff colouring | `MONACO_TO_HLJS` | `highlightLine` | yes |

## 4. Edge cases & failure modes

| Condition | Expected |
|---|---|
| No extension, no shebang (`LICENSE`, `bin/tool` with text) | `plaintext`, no sniff cost beyond 256 chars |
| Shebang with CRLF / BOM / `#! /usr/bin/env  python3` / `-S deno run -A` | parsed (BOM and `\r` stripped, flags skipped) |
| Shebang file that is also a golden (`run.golden`) | golden rule first; remainder `run` → plaintext → sniff applies |
| Uppercase (`MAKEFILE`, `X.TOML`, `CMakeLists.TXT`) | case-insensitive (names lowercased) |
| `Dockerfile.dev`, `dev.Dockerfile`, `Containerfile.prod` | `dockerfile` |
| `docker-compose.override.yml` | `yaml` (unchanged) |
| `.env.local` vs `.envrc` vs `x.env` | `dotenv`, `shell`, `dotenv` |
| `Makefile.am` vs `x.mk` vs `CMakeLists.txt` vs `x.cmake` vs `Makefile.toml` | makefile, makefile, cmake, cmake, toml |
| `x.m` (MATLAB or ObjC) | plaintext |
| `*.d.ts`, `foo.test.tsx` | `typescript` (unchanged) |
| `.h` in a C++ project | id `c` (colour identical — c shares cpp grammar); clangd decides C vs C++ from compile flags, not didOpen's id |
| `.v` that is Coq / V-lang | coloured as Verilog (A5) |
| `python` on PATH is the Windows Store alias stub (`…\WindowsApps\python.exe`; this machine has it — running it prints "Python was not found") | basedpyright's interpreter query fails; it navigates the project's own sources without third-party imports; no toast (server is present) |
| A `.py` outside any marker | ad-hoc server at the workspace root (requiresMarker false) |
| A `.rs` outside any `Cargo.toml` | no server; existing "not in a project" outcome |
| Nested Cargo workspaces with separate `Cargo.lock` | highest lock wins (registry root rule); an excluded nested crate may get no results — documented, not fixed |
| Server binary missing | one install toast per language per session; F12 falls back to existing "none" outcome |
| rustup proxy present, component missing | `versionProbe` fails → absent toast (not a crash toast) |
| Component present for the default toolchain, missing for the repo's pinned one | probe (tmpdir cwd) passes, server exits before initialize → `crashed`, stderr tail in the log; palette restart after `rustup component add`. Accepted |
| Repo `rust-toolchain.toml` names an uninstalled toolchain | `RUSTUP_AUTO_INSTALL=0` → no download; server exits → `crashed` as above |
| Server crashes on start / loops | existing budget: exit before initialize → `crashed`; after → 1/4/16 s then `crashed`; palette restart resets |
| Server hangs in initialize | 90 s deadline → crashed (unchanged) |
| Two languages in one untrusted folder | one prompt (per folder), tools line lists every server; Trust starts both |
| 5 languages open at once | ≤ 2 heavy and ≤ 4 total live unless no live one is evictable (soft cap, logged) |
| User cycles `.rs` / `.cpp` / `.cs` tabs every few seconds | hysteresis: nothing hidden < 60 s is evicted → soft cap exceeded briefly instead of re-indexing |
| Doc opened in a background session at launch | registered, no server until shown or requested |
| Hidden session holds `.rs` tabs | rust-analyzer sleeps after 10 min (dormancy); wakes when shown |
| Evicted while the user had unsaved edits | relaunch replays host-held text → nav answers against the edits |
| Eviction during a request | never: in-flight servers are not evictable |
| Junction/subst path to a root | unchanged lexical-root rule; shared watch keyed by lexical root (§2.6), so a junction and its target spelling get separate watches — correct URIs over dedup |
| 9 MB `sqlite3.c` (head window) | not synced; F12 shows `not-synced`/`too-large`: "File too large for code navigation" |
| Invalid-UTF-8 source | not synced; F12 shows `not-synced`/`encoding`: "Code navigation needs UTF-8 text" |
| `pip install` writing 10 000 `.py` into `.venv` | ignored dir → no event storm to the server |
| `build/compile_commands.json` regenerated | dropped by the global `build` filter; clangd re-reads the CDB itself on next file open (ASSUMED) |
| clangd's `.cache/clangd/index` | lands in the user's repo (D3); already in the global watch filter |
| A line > 20 000 chars | Monaco stops tokenizing it (`maxTokenizationLineLength`); grammars never see it |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Python server | basedpyright, alt pyright | no | `.exe` install on Windows; `.venv` aware |
| Server budget | 2 heavy / 4 total / 10 min dormancy | no (constants) | memory-bounded without user tuning; revisit with telemetry |
| Shebang sniff | on, plaintext-only | no | can't mis-colour a file the path already resolved |
| Aliased grammars (ocaml, groovy, dotenv) | on | no | better than plain; zero bytes |
| clangd background index | on, `-j=2` | no | cross-file references need it (D3) |
| rust-analyzer build scripts / proc-macros | on (r-a default) | no | macro-heavy crates navigate nothing without them; trust-gated (D4) |

## 6. Scope slicing

- **MVP:** §2.2 mapping + aliases + Monaco grammars; TOML, diff, Makefile grammars; shebang;
  Python, Rust and C/C++ servers + all seven generic changes; `not-synced` guard; residency cap
  (needs `weight`) + visibility + invisible-open-doesn't-launch; CI installs.
- **v1:** CMake + ignore grammars; dormancy.
- **Follow-up (deferred, plan rev 2):** shared root watch (§2.6), only once a measurement shows
  per-server watches cost something.
- **Vision:** Java (own spec), Lua/Bash/Zig entries, user file associations, diagnostics.
- **Out of scope:** §1 non-goals.

## 7. Acceptance criteria

All e2e run remotely (`npm run e2e:remote -- <names>`), added to the coverage map; installed-server
scenarios **fail, never skip** when the server is missing on CI (go-lsp precedent).

**Lane A — `language-coverage` e2e (new) + units**
- **AC-A1** For each §2.2 row a fixture file opens with that model language id and ≥ 1 non-default
  token class on its first non-blank line, on the first frame after open (Neon theme; theme tokens
  unchanged).
- **AC-A2** Shebang: `bin/py` (`#!/usr/bin/env python3`), `bin/d` (`#!/usr/bin/env -S deno run`),
  `bin/s` (`#!/bin/bash`, CRLF), `bin/none` (no shebang) → `python`, `typescript`, `shell`,
  `plaintext`; `LICENSE` → `plaintext`; `go.sum` → `plaintext`.
- **AC-A3** TOML fixture: `[[bin]]` is one `type` token; `a.b-c = 1 # x` paints key, number,
  comment; a 3-line `"""` string is `string` on all three lines.
- **AC-A4** `x.patch`: `+` lines `string`, `-` lines `log-error`, `@@` header `type`; each hunk
  folds.
- **AC-A5** Review of a changed `Makefile` and `Cargo.toml` shows hljs-coloured rows.
- **AC-A6** `tsconfig.json` / `.babelrc` `//` comment lines tokenize as `comment`; `.jsonl`
  lines colour keys and strings.
- **AC-A7** Unit `lang.test.ts`: every §2.2/§4 name; `langFromShebang` table incl. `env -S`,
  `python3.12`, `NAME=v env`, BOM, unknown → null; `Makefile.toml` → toml, `.env.json` → json, `x.m` →
  plaintext. `syntax-highlight.test.ts`: every `LanguageId` (incl. `gomod`, `log`) has an entry.
  `plan-code-block` fence table unit.
- **AC-A8** Unit `grammar-linear.test.ts`: for each custom grammar, the rule runner tokenizes three
  adversarial 20 000-char lines (repeated openers, unterminated strings, `$(` nesting) in < 50 ms
  each; a grammar regex with a nested quantifier fails a static check over `tokenizer` sources.
- **AC-A9** Bundle: `out/webview.js` grows ≤ 40 KB vs `main` (measured in the lane report).

**Lane B — `lsp-missing-servers` (new, always runs, add to `core-smoke.json`), `python-lsp`,
`rust-lsp`, `clangd-lsp` (new) + units**
- **AC-B1** With every server unreachable (PATH stripped; HOME/USERPROFILE/APPDATA/CARGO_HOME and
  `ProgramFiles` at an empty temp dir — go-lsp E5 mechanism; clangd's win32 fixed dir is derived
  from `%ProgramFiles%` rather than hard-coded, which is also right for non-`C:` installs, so the
  runner's own LLVM is hidden without a test hook), F12 in `.py`, `.rs`, `.cpp` each shows exactly one install
  toast naming `basedpyright` / `rust-analyzer` / `clangd` with §2.5's hint; no error toast; files
  editable.
- **AC-B2** Untrusted folder with `.py`+`.rs`+`.cpp` open: zero server descendants; one prompt
  listing all toolsets.
- **AC-B3 (installed)** Trusted: F12 lands across files, hover shows a signature, breadcrumbs show
  the enclosing symbol — Python (`main.py` → `lib/util.py`, and an extensionless `#!/usr/bin/env
  python3` script), Rust (`main.rs` → `lib.rs` in a 2-member workspace: one rust-analyzer, rooted
  at the workspace), C++ (`main.cpp` → `greet.hpp`/`greet.cpp` with `compile_commands.json`).
- **AC-B4** No `cargo check` is triggered by editing or saving: Conduit sends no
  `textDocument/didSave` and advertises none, so rust-analyzer's flycheck has no trigger;
  `checkOnSave:false` is defence in depth. Units: `lsp-server.test.ts` (no save capability
  advertised) and `lsp-manager.test.ts` (no lifecycle step sends a save). Not an e2e — a save
  that can't reach the server can't make one fail. (The startup build-script pass, D4, is
  unaffected.)
- **AC-B5** A `.py` with no marker gets an ad-hoc server; a `.rs` with no `Cargo.toml` gets the
  "not in a project" outcome.
- **AC-B6** Unit `lsp-registry.test.ts`: every new glob/marker compiles; `languageIds` unique
  across the registry; `serverSpecFor('c')` is clangd; `childEnv` never mutates base and sets
  `RUSTUP_AUTO_INSTALL=0` only when unset; `altBinaries` order; `versionProbe` runs in tmpdir and
  its failure → null resolve; spawn path is the non-realpath (`lsp-binary.test.ts`). `lsp-server.test.ts`: `initializationOptions` and
  `workspace/configuration` answers per section, `null` otherwise.
- **AC-B7** `.h` opened in the C++ fixture is served by the same clangd record as `.cpp`
  (one process); didOpen carries `c` for `.h`, `cpp` for `.cpp`.
- **AC-B8** A 3 MB `.py` opens truncated; no didOpen for it reaches the server (host log), F12
  shows "File too large for code navigation"; an invalid-UTF-8 `.py` shows the encoding copy.
- **AC-B9** With an extensionless Python script active, palette "Trust Current Folder" names
  Python; the trust prompt lists one line per server.
- **CI:** `.github/workflows/e2e.yml` steps gated on shard names like csharp-lsp's: setup-python +
  pinned basedpyright; `rustup component add rust-analyzer`; LLVM presence check then
  `choco install llvm` fallback.

**Lane C — `lsp-residency` e2e (new; shard installs rust-analyzer, clangd, csharp-ls) + units**
- **AC-C1** Open `.rs`, then `.cpp`, then `.cs` (`.rs` hidden > 60 s, `.cpp` hidden < 60 s): never
  more than 2 heavy server pids alive at any 250 ms sample. The launch awaits the evictee's process
  exit, bounded at 2 s, then proceeds and logs. The evicted one is the LRU (`.rs`). The one hidden
  < 60 s is kept (hysteresis).
- **AC-C2** Unit (`lsp-manager.test.ts`, fake clock + fake handles): over-budget launch evicts LRU;
  never evicts in-flight / starting / loading / visible / hidden < 60 s; soft cap launches when
  nothing is evictable; invisible open does not launch; dormancy after `DORMANT_MS`; `lsp:visible`
  union across two clients and dropped on client retire / webContents gone.
- **AC-C3** After eviction, an unsaved edit in the evicted `.rs` tab then F12 → server relaunches
  and lands on the edited target (replay carries the edit).
- **AC-C4 — DEFERRED with the shared watch (plan rev 2).** Unit `lsp-watcher`: two servers on one lexical root share one OS watch, each gets only
  its own filtered events and its own marker/gone callbacks; closing one keeps the other's events;
  closing both closes the watch; a junction spelling gets its own watch.
- **AC-C5** App launch with a session holding `.py`/`.rs` tabs but the Terminal tab active starts
  no server until a served file is shown.

```gherkin
Scenario: the third heavy language puts the least-recent one to sleep
  Given rust-analyzer and clangd are running for visible tabs
  And the user switches away from the Rust tab
  When the user opens a C# file
  Then rust-analyzer is stopped and csharp-ls starts
  And showing the Rust tab again restarts rust-analyzer with its unsaved text
```

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| Install toast | basedpyright / rust-analyzer / clangd absent | existing generic toast from `displayName`/`binary`/`installHint` | copy command |
| Trust prompt | multi-language folder | headline names the requesting language; tools as one line per server | Trust / Trust Parent / Don't Trust (existing) |
| Nav outcome | `not-synced` too-large / encoding | "File too large for code navigation" / "Code navigation needs UTF-8 text" (existing toast slot + live region) | none |
| Nav outcome | F12 while an evicted/dormant server wakes | existing loading outcome, then result; existing timeout copy after 90 s | retry F12 |
| Status | server asleep (evicted/dormant) | entry removed (existing `stopped` rule); reappears as starting on wake | none |

## 9. Interaction inventory (UI)

No new controls. Existing F12 / Ctrl+click / Shift+F12 / hover / breadcrumbs / palette restart
("Restart Python language server", "Restart C/C++ language server" — one per server, built from
`displayName`). Fold chevrons for diff hunks.

## 10. Accessibility & i18n (UI)

- New nav-outcome copy goes through the existing live-region announcement; toasts unchanged.
- Diff colouring is not colour-only: `+`/`-`/`@@` markers stay in the text.
- Trust prompt tools list wraps (no truncation of a security disclosure); covered by the text-fit
  sweep (`npm run text-fit`) at 5 servers.
- New strings live beside existing nav-outcome copy; language display names are proper nouns, not
  translated.

## 11. Design tokens (UI)

No new tokens: grammars emit existing classes (`comment keyword string number type log-error`),
themed in all three themes today.

## 12. Assumptions

- A1 Ranking in §2.3 / tier choice in §2.5 is from public usage data, not Conduit telemetry.
- A2 basedpyright honours `basedpyright.analysis.typeCheckingMode` and auto-detects a root `.venv`;
  rust-analyzer honours `checkOnSave:false` via `initializationOptions` (not measured: with no
  didSave sent it never matters — AC-B4).
- A3 OCaml through the F# grammar and Groovy/Gradle through Java are approximations users prefer
  over plain text.
- A4 dotenv through INI: `KEY=value`, `#` comments colour; `export KEY=` does not key-colour.
- A5 `.v` → Verilog (Monaco's own mapping).
- A6 `windows-latest` ships LLVM with clangd and rustup with a stable toolchain (CI step verifies,
  falls back to `choco install llvm`).
- A7 Server weights: rust-analyzer, clangd, csharp-ls heavy (hundreds of MB–GBs on real
  workspaces); gopls, basedpyright light — not measured here (none installed).
- A8 Visibility = files shown in either editor group of the active session per window.
- A9 basedpyright analyses a didOpen'd `file:` URI with no `.py` extension when `languageId` is
  `python` (AC-B3's extensionless case measures; if false, such scripts get colour only and that
  sub-case moves to a non-goal).
- A10 A repo's own pyright config may re-enable type checking; that CPU cost is the repo's choice.
- A11 Source-read claims in §2.1 hold as read (sync-all-tabs, no truncated guard, `.exe`-only
  binaries, `null` configuration answers, per-server recursive watch, realpath spawn, spec-id
  didOpen, single-string tools line) — the reviewer re-checked each against the source; the ACs
  named there measure them in the built app.
- A12 `RUSTUP_AUTO_INSTALL=0` stops rustup auto-installing a repo-pinned toolchain (rustup ≥ 1.28).

## 13. Decisions Needed

- **[high] D1 Tier-1 server set = Python, Rust, C/C++; Java, Ruby, PHP, Kotlin, Swift, Lua, Bash,
  Zig deferred.** Default: as stated (§2.5 reasons). Alternative: add Java now (+ a templated
  `-data` arg and JDK detection; biggest CI/RSS cost).
- **[high] D3 clangd background index on** — writes `.cache/clangd/` into the user's repo (shows
  in `git status` unless ignored). Default: on with `-j=2`. Alternative: `--background-index=false`
  (Shift+F12 only sees open files).
- **[normal] D2 Residency numbers** — 2 heavy / 4 total / 10 min dormancy. Alternative: memory-
  measured (sample RSS) eviction; more accurate, needs per-OS RSS sampling.
- **[normal] D4 rust-analyzer runs build scripts + proc-macros** (r-a default, trust-gated).
  Alternative: disable both via `settings` — safer, but macro-generated items don't navigate.
- **[normal] D5 Python server = basedpyright (alt pyright)**. Alternative: pyright only, or pylsp.
- **[normal] D6 Aliased grammars ship** (ocaml→fsharp, groovy→java, dotenv→ini). Alternative:
  leave those plain until real grammars exist.
- **[normal] D7 Dormancy + invisible-open-doesn't-launch** change Go/C# behaviour too (a hidden
  session's gopls no longer starts at launch and sleeps after 10 min). Alternative: cap-only
  eviction, today's launch-on-open.
- **[normal] D8 `.m` stays plain** (MATLAB vs Objective-C) and Objective-C gets colour only (no
  clangd). Alternative: content sniff (`@interface`/`#import` vs `function`/`%`) to pick.

Length: ~550 lines, over the ~400 FULL budget — three independent sub-features (recognition,
servers, residency) each needing its own measured current-behaviour rows and ACs; splitting into
three specs was weighed and rejected because lanes B and C share the registry/protocol contract.

## 14. Build lanes

**Superseded by the plan** ([docs/plans/2026-10-08-language-coverage.plan.md](../plans/2026-10-08-language-coverage.plan.md)):
- Slice 0 (`lang.ts` + `file-service.ts`) lands first.
- Lanes A and B then run in parallel; lane C (incl. `weight`) runs after B.
- The shared watch is deferred.
- B also amends ADR 0006 §Trust: spawn uses the found absolute path, not its realpath, and pre-trust execution is limited to version/tool probes in the temp dir.

The table below is the original proposal.

| Lane | Files | Serialization |
|---|---|---|
| **A — recognition + grammars** (renderer + shared resolver) | `src/lang.ts`, `src/file-service.ts` (shebang call only), `webview/monaco-languages.ts`, `webview/components/plan-code-block.tsx`, new `webview/{toml,diff,makefile,cmake,ignore}-grammar.ts`, `webview/diff-folding.ts`, `webview/syntax-highlight.ts`, `webview/components/diff-viewer.tsx`, `webview/components/review-view.tsx` (hljs line), tests `lang`, `*-grammar`, `grammar-linear`, `syntax-highlight`, `file-service`; `test/e2e/language-coverage.e2e.mjs` | **A's `src/lang.ts` lands first** (B's `lsp-nav`/`app.tsx` call `langFromShebang` and need it to test); the rest of A runs in parallel with B |
| **B — registry + servers + CI** | `src/lsp-registry.ts`, `src/lsp-binary.ts`, `src/lsp-protocol.ts`, `electron/lsp-server.ts`, `electron/lsp-manager.ts` (languageIds keying, didOpen id), `webview/lsp-sync.ts`, `webview/lsp-nav.ts`, `webview/nav-outcome.ts`, `webview/app.tsx` (served set, DTO language, sync guard, rename, trust palette `:3983`), `src/lsp-root.ts` (`serverKeyFor` primary id), `webview/components/trust-prompt.tsx`, `.github/workflows/e2e.yml` (all server install steps, incl. those C's shard reuses), `test/e2e/timings.seed.json`, e2e `lsp-missing-servers`, `python-lsp`, `rust-lsp`, `clangd-lsp` + fixtures, `test/e2e/core-smoke.json`, units `lsp-registry/binary/server/sync` | after A's `lang.ts`; owns `lsp-registry.ts` (`weight`, `languageIds`), `lsp-protocol.ts`, `lsp-manager.ts`, `app.tsx`, `e2e.yml` first |
| **C — residency + shared watch** | new `src/lsp-residency.ts` (pure policy), `electron/lsp-manager.ts` (hook-in), `electron/lsp-watcher.ts`, `src/lsp-protocol.ts` (`lsp:visible`), `webview/app.tsx` (send visible paths), `electron/main.ts` (watch deps), units `lsp-residency`, `lsp-manager`, `lsp-watcher`; e2e `lsp-residency`, its shard condition added to B's install steps in `e2e.yml`, its `timings.seed.json` entry | `lsp-residency.ts` + its units can start in parallel; everything else **rebases on B** — it consumes B's `weight`/`languageIds` registry fields and edits `lsp-manager.ts`, `lsp-protocol.ts`, `app.tsx`, `e2e.yml`, `timings.seed.json` after B |

`CHANGELOG.md` is the conductor's at release. Spec moves to `archive/` on ship (ADR 0003).

## Self-audit

Sections 1–14 filled; UI module (8–11) filled for the small UI surface; every current-behaviour
claim is measured or marked ASSUMED with the AC that measures it; every §3 flow names both sides;
non-goals and cut lines are explicit.
