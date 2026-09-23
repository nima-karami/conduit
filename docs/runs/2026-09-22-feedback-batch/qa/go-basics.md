# Runtime QA · Go module files basics + language-generic nav message

**When:** 2026-09-22
**Tier:** FULL (theme-varied): three themes, editor + diff + Review surfaces, three nav triggers
**Artifact:** desktop app (Electron dev build `out/`, driven with Playwright-Electron through `test/e2e/harness.mjs`)
**Build under test:** conduit at `G:\awby\projects\conduit-wt-go-basics` `feat/go-basics` @ `28c83fd` (tree clean). Rebuilt with `npm run build` before driving.
**Build identity confirmed from the running artifact:** `app.getAppPath()` = `G:\awby\projects\conduit-wt-go-basics`, version 0.39.0. The running renderer registers the `gomod` language id, which does not exist before this commit.
**Environment:** launched hidden (`CONDUIT_E2E=1`), serialised through heavy.sh. Probe: `%TEMP%\claude-scratch\qa-go-basics\probe.mjs` (written for this pass, independent of `go-files.e2e.mjs`; deleted with the scratch dir afterwards).
**Isolation:** own user-data dir `%TEMP%\claude-scratch\qa-go-basics\udd`, own fixture git repo `...\qa-go-basics\repo`, no ports
**Configurations driven:** themes **aero**, **aero-dark**, **neon** (switched through the real palette command "Theme: X"). Icon pack: each theme's default (aero/aero-dark → colored, neon → minimal), plus neon with the colored pack pinned. All driven.
**Teardown:** each app was closed through harness `shutdownApp` (PID-scoped); scratch dir removed. Nothing was killed by name.

## Scope

Spec `docs/specs/2026-09-22-go-files-basics.md` §6, user-facing criteria: gomod colouring in the editor and in a diff; Go-blue icons on module files in the Explorer and in editor tabs; the unsupported-nav message. Also driven: the §4 edge cases, Review Changes (hljs), context-menu and Ctrl+click behaviour on non-TS files, the command-palette route, and a regression pass on TS navigation and `.go` highlighting.

## Verdict

**Works, with 1 issue.** The editor-tab half of AC3 isn't met: doc tabs don't render file-type icons at all.

## Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `go.mod`/`go.work` → `gomod` in any case; `go.sum`/`go.work.sum` → plaintext | observed pass: `go.mod`, `go.work`, `sub/GO.MOD` = gomod; `go.sum`, `go.work.sum`, `foo.mod` = plaintext (model language ids in the live editor) | probe log |
| 2a | `go.mod` open in the editor: `module`, a version and a module path carry 3 different `mtk*` classes | observed pass in all 3 themes: `module`=mtk14, `example.com/hello`=mtk1, `v0.9.1+incompatible`=mtk18, with 3 distinct computed colours per theme | `qa-go-basics-08/09/10-editor-gomod-*.png` |
| 2b | `go.mod` diff: same 3-class check | observed pass in the Changes → diff editor, opened BEFORE any editor had opened go.mod: `require`=mtk14, `rsc.io/quote`=mtk1, `v1.5.2`=mtk18; the diff model language is gomod. `go.work` diff also coloured (`use` vs `./extra`). `go.sum` diff has one class only (plain, as spec'd) | `qa-go-basics-01-diff-gomod-aero-dark.png`, `-02-diff-gowork.png` |
| 3a | Explorer row for each module file renders `#00add8` (colored pack) | observed pass: in aero, aero-dark and neon+colored, all four files have stroke `#00add8` (go.mod/go.work = settings glyph, go.sum/go.work.sum = file-lock glyph). Neon's default minimal pack renders `currentColor` for every file, as designed | `qa-go-basics-04..07-explorer-*.png` |
| 3b | **Editor tab** for each module file renders the `#00add8` icon | **observed fail**: file doc tabs have no file-type icon. The only svg in the tab is the close button (`stroke=currentColor`). Same in all three themes and for all five module-file tabs | `qa-go-basics-08..12` (tab strip) |
| 4a | F12 in `main.py` → "…for Python files." | observed pass: toast "Code navigation isn’t available for Python files." | `qa-go-basics-14-f12-toast-main-py.png` |
| 4b | F12 in a `.txt` → "…for this file type." | observed pass (`notes.txt`, and unknown ext `data.qqz`) | probe log |
| 4c | JS/TS goto still works | observed pass: `app.ts` → `lib.ts:1` (`export function targetFn`) via F12, the context-menu "Go to Definition" and Ctrl+click. No unsupported toast | `qa-go-basics-15-ts-f12-landed.png` |

## What happened

1. Launched the app, opened a session on the fixture repo (go.mod, go.work and go.sum modified against HEAD). Pass.
2. Changes tab → go.mod diff, before any editor tab existed: coloured with 3 classes (`01`). go.work diff coloured (`02`). go.sum diff plain.
3. Review Changes (git-indicator Review button): the go.mod card renders 5 rows with 0 `hljs-*` spans, i.e. plain, which matches spec §1's non-goal ("Review rows stay plain"). Rows render normally (`03`).
4. Explorer icons checked per theme: `04` aero, `05` aero-dark, `06` neon (minimal), `07` neon + colored pinned. Negative control: `foo.mod` stays `#8a8f98` generic and `main.py` stays `#4b8bbe` in every colored configuration.
5. Opened go.mod in each theme: 3 distinct classes and colours (`08`–`10`). `go.work`: `use`=keyword, `./svc`=identifier, back-quoted `` `./x` ``=string/mtk24 (`11`).
6. Grammar tokens straight from the running tokenizer: `//` comments (including `// indirect`) = comment; `=>` = operator; `[`/`]` = delimiter.square; `v1.0.0` and pseudo-versions = number; `../local`, `./svc` = identifier; quoted and back-quoted strings = string; the unknown directive `frobnicate` = identifier. Tokenizing malformed text (`"x`, unclosed brackets, `v1.2.3+`) didn't throw.
7. F12 on main.go / main.py / data.qqz / notes.txt / go.mod → "…for Go files." / "…for Python files." / "…this file type." ×2 / "…for Go module files.". None of them contains "JS/TS" (`13`, `14`).
8. Command palette (F1) → "Go to Definition" in main.py → the same Python toast.
9. TS regression: F12, the context menu and Ctrl+click all land on lib.ts (`15`). `main.go` still highlights: `package`=mtk14, `main`=mtk1, `1`=mtk18 (`16`).

**Negative scenarios:** on the 4 non-TS files, every context-menu nav row (Go to Definition / Type Definition / Implementations / References, Peek Definition, Find All References) is present and **disabled**, and Ctrl+click on a symbol is silent (no toast, no overlay). Both match spec §2 and the §9 default.
**Relaunch scenario:** relaunched on the same profile and repo and opened go.mod on a fresh process: it paints gomod with 3 distinct classes (`51-relaunch-gomod`). The feature persists no state, so nothing else was expected to survive.
**Negative controls:** the class and stroke checks do discriminate. `foo.mod` (plaintext, grey) and `main.py` (`#4b8bbe`) returned different values under the same selectors, and the `go.sum` diff returned a single class where go.mod returned three.

## Findings

### 1. Module-file editor tabs show no Go-blue icon (no file-type icon at all)

**Severity:** cosmetic (spec'd AC unmet)
**Affects:** all three themes and every file doc tab (the `main.py` and `app.ts` tabs have no type icon either). The Explorer is unaffected.
**Evidence:** `G:/awby/projects/conduit/.autoloop/evidence/qa-go-basics-08-editor-gomod-aero-dark.png` (tab strip: "go.mod" with only the ×), `-12-tabs-module-files.png`. Probe tab read returned only the close glyph per tab.

Repro: open any repo containing go.mod → click go.mod in Files. Expected (spec §1, §6 AC3): the tab shows the `#00add8` icon. Observed: the tab shows only the filename and ×.

**Cause:** `webview/components/doc-tabs.tsx` renders glyphs only for diff/commit-diff/review docs (`IconBranch`/`IconReview`, ~L252). `FileTypeIcon` is used only in `webview/components/right-pane.tsx`. The spec assumed tabs already carried file-type icons, but they don't, so the builder didn't add them.

## What worked

The gomod grammar (every §3 construct), first-frame colouring in the editor and in the Monaco diff, case-insensitive filename matching, `go.sum`/`foo.mod` staying plain, Explorer Go-blue icons in every colored configuration, the language-named message on F12 and the palette, disabled nav rows, silent Ctrl+click, and TS navigation over all three triggers.

## Not covered

- **Visual baseline against the pre-change build:** not captured. Colouring was judged from mtk classes and computed colours, not a side-by-side.
- **Clicks on the disabled context-menu rows:** only their disabled state was read. Clicking them wasn't attempted.
- **Multi-window and browser fake-shell preview:** not driven.
- **Aero light-theme contrast of the `#00add8` icons:** captured (`04`) but not measured.

## Decisions needed

- [normal] **AC3 tab icons.** Either (a) add `FileTypeIcon` to file doc tabs (applies to every file type; a UI change beyond Go), or (b) re-lock AC3 to Explorer-only. Unattended default: treat it as a spec-premise error and re-lock to Explorer-only, since tabs carry no type icons for any language. That is the user's call, not QA's.
- Observation, not a defect: `=>` (operator) renders in the same colour as identifiers in aero-dark (the theme defines no distinct operator colour). Spec says no new theme rules, so accepted.

## Artifacts

- `G:/awby/projects/conduit/.autoloop/evidence/qa-go-basics-01..16-*.png` and `-51-relaunch-gomod.png`: 17 captures in order
