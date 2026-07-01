---
status: active
date: 2026-07-01
slug: review-diff-syntax
tier: FULL
type: UI
---

# Review diff syntax highlighting

**Triage:** FULL · UI · Reason: touches the app's primary code-review surface, adds a
new highlighting seam shared with markdown, has real perf/windowing and theme-source
constraints, and changes an existing user-facing appearance (add/remove line coloring).

## Problem

Review Changes is Conduit's **primary surface for reading an agent's code changes**
(`webview/components/review-view.tsx`). Every added / removed / context line renders as
uncolored monospace text (`.rline__text` — solid green for adds, red for dels, dim for
context; see `webview/styles.css` ~6847). There is **zero syntax highlighting**, so a
diff of real code is a wall of same-colored text — far harder to scan than the Monaco
`DiffViewer` (`webview/components/diff-viewer.tsx`) or a GitHub PR. The review list
deliberately does **not** mount Monaco per file (a whole-tree review would spin up
hundreds of editors — see `src/review-hunks.ts` header comment and the
`2026-06-27-review-virtualization` spec), so it never inherited Monaco's colors.

**Job-to-be-done:** when reviewing a change, a reader wants each diff line colored by
language (keywords, strings, comments, types…) matching the editor, so code is scannable
at a glance — while the +/- add/remove affordance stays obvious and the list stays as
fast as it is today.

### Actors
- **Reviewer** (human) reading a working-tree / commit / range review — primary.
- **Markdown-viewer reader** (secondary) — impacted by D2: sharing one hljs palette shifts
  markdown code-block colors to the editor palette.

### Success outcomes
- `.ts`/`.tsx`/`.js`/`.py`/… diff rows show per-token colors matching the editor palette.
- Unknown/unsupported languages fall back to plain text (today's look) with no error.
- Windowing, per-card diff fetch/cache, row-cap, fold reveal, and scroll-anchoring are
  unchanged and un-regressed.
- Add/remove rows stay unmistakable (the background tint + colored +/- sign survive
  under token colors).

### Non-goals
- No Monaco editor per row (explicitly rejected by the conductor — kills virtualization).
- No new highlighting **dependency** (reuse `highlight.js`, already installed).
- No inline intra-line character-level diff (which chars within a line changed) — out.
- No re-tokenization on theme change (colors are CSS variables — pure CSS recolor).
- No settings toggle to turn highlighting off (default-on; see Defaults).

## Discovery findings (what the app already has)

- **Highlighting engine already in the app = `highlight.js`** (`package.json`
  `"highlight.js": "^11.11.1"`), used via `rehype-highlight` in the markdown viewer
  (`webview/components/markdown-viewer.tsx:4,54`). Markdown code blocks are tokenized to
  `.hljs-*` spans and colored by a **hardcoded** stylesheet import
  `import 'highlight.js/styles/github-dark.css'` (line 11). There is **no** shiki / prism /
  monaco.editor.colorize path. → **Reuse `highlight.js` directly.** No new dep.
- **`.codeblock__src`** (`styles.css` ~2995) is the *source-view* (View source) plain
  code column — `color:#c5cad3; white-space:pre` — not a highlighter. Not reused here.
- **Language detection already exists:** `src/lang.ts` `langFromPath(path)` returns a
  **Monaco** language id (`typescript`, `javascript`, `python`, `shell`, `bat`, `ini`,
  `csharp`, …, `plaintext`). highlight.js language ids differ for a few (`shell`→`bash`,
  `bat`→`dos`, `csharp` ok, `plaintext`→none). A small **monaco→hljs** map is required.
- **Two divergent color sources today** (the crux of Decision D2):
  1. markdown hljs tokens → `github-dark.css` (hardcoded upstream palette).
  2. Monaco editor tokens → `webview/monaco-theme.ts` hand-rolled palette tied to the app
     (comment `#585e6a` italic, keyword `#d9775c`, string `#6cc18a`, number `#d9a14b`,
     type `#5e9bd6`).
  These **do not match**. The conductor requires review colors to "match the editor" and
  come from a **single source, not a second hardcoded set** — this drives D2 below.
- **Rendering seam:** the pure `Line` component (`review-view.tsx` ~836) renders
  `<pre class="rline rline--{kind}"><span gutter><span sign><span text></pre>`. The text
  node is where token spans must go. Only **windowed cards** mount, and within a card only
  rows up to `MAX_CARD_ROWS` (40) render → highlighting only ever runs on visible rows.

## Scope

### In scope
- Tokenize each rendered diff line by language and render colored token spans in place of
  the plain text node, for **context, add, and del** rows (including revealed fold rows).
- A pure, unit-testable helper that turns `(text, hljsLang)` into an ordered list of
  `{ text, cls }` segments whose concatenation is byte-identical to the input text.
- monaco→hljs language mapping; language resolved **once per file/card**.
- A **single, theme-aware color source** for syntax tokens (CSS variables) matching the
  editor palette, applied to review token spans (and — per D2 — markdown code blocks too).
- Caching so scroll/re-mount does not re-tokenize the same line.
- Preserve add/remove background tints and colored +/- sign under token colors.

### Out of scope
- Monaco per-row; intra-line char diff; a "disable highlighting" setting; highlighting the
  Monaco `DiffViewer` (already highlighted); highlighting the View-source `.codeblock`;
  multi-line semantic context across diff rows (block comments / template strings spanning
  lines — see Edge cases); adding languages beyond what `langFromPath` + hljs already know.

## Highlight approach

### Engine
Reuse **`highlight.js`** directly (no `react-markdown`/`rehype` wrapper — that's for whole
documents). New pure module `webview/syntax-highlight.ts`:

```
// signature (illustrative, not final)
export type Seg = { text: string; cls: string | null };  // cls e.g. "hljs-keyword"
export function highlightLine(text: string, hljsLang: string | null): Seg[];
export function monacoLangToHljs(monacoId: string): string | null;  // null ⇒ plain
```

- `highlightLine` calls `hljs.highlight(text, { language, ignoreIllegal: true })` **only**
  when `hljsLang` is non-null and `hljs.getLanguage(hljsLang)` is registered; otherwise it
  returns `[{ text, cls: null }]` (the plain fallback). It walks hljs's emitted token tree
  (via the `_emitter`/`highlight` tree or by parsing hljs's HTML once) into a **flat
  segment list** — no nested spans needed for line-level rows. **Concatenating
  `segs.map(s=>s.text)` MUST equal the input `text`** (invariant, unit-tested) so copy and
  layout are unaffected.
- Segments are rendered as React children (`<span className={cls}>{text}</span>` for
  colored, bare string for `cls===null`) — **never `dangerouslySetInnerHTML`**, so there is
  no XSS surface even though hljs escapes its own output (see Edge cases: safety).
- Language registration: import the default `highlight.js` build (registers the common
  language set — same build markdown already pulls in), so no per-language wiring. If bundle
  size is a concern the implementer MAY switch to `highlight.js/lib/core` + explicit
  registrations, but that is an optimization, not required (note in code, not a blocker).

### Per-file language
- In `ReviewFileCard` (or `HunkList`), compute `hljsLang = monacoLangToHljs(langFromPath(change.path))`
  **once** and thread it down to each `Line` (through `FoldRow` and `Hunk`). Do **not**
  call `langFromPath` per row.

**Full `monacoLangToHljs` mapping (the data contract — enumerate every id `langFromPath`
can return; anything not here returns `null` ⇒ plain).** Most Monaco ids are already valid
hljs ids and map 1:1; the exceptions are called out. hljs must have the language registered
(guarded by `getLanguage`), so ids with no hljs grammar return `null`.

| Monaco id (from `lang.ts`) | hljs id | note |
|---|---|---|
| `typescript`, `javascript`, `json`, `python`, `rust`, `go`, `java`, `kotlin`, `scala`, `c`, `cpp`, `csharp`, `ruby`, `php`, `swift`, `dart`, `lua`, `perl`, `r`, `julia`, `clojure`, `elixir`, `sql`, `graphql`, `yaml`, `css`, `scss`, `less`, `xml`, `markdown`, `powershell`, `dockerfile` | same | 1:1 |
| `shell` | `bash` | hljs id differs |
| `bat` | `dos` | hljs id differs |
| `ini` | `ini` | (toml/cfg/conf/properties already fold to `ini` in `lang.ts`) |
| `html` | `xml` | hljs highlights HTML via the `xml` grammar |
| `fsharp` | `fsharp` | verify registered in the default build; else `null` |
| `vb` | `vbnet` | hljs id differs (verify) |
| `mdx` | `markdown` | approximate |
| `sol`, `tcl`, `pascal`, `proto`, `hcl` | check `getLanguage` at map time | not all ship in the default bundle → `null` if absent |
| `plaintext` | `null` | plain fallback |

The implementer MUST confirm each id against `hljs.getLanguage(id)` in the shipped build and
return `null` for any that are absent (the `getLanguage` guard in `highlightLine` is the
runtime backstop, but the map should not point at an unregistered id). A unit test asserts
every mapped id is either `null` or actually registered.

### Per-row application
- `Line` becomes: gutter + sign unchanged; the text span renders
  `highlightLine(line.text, hljsLang)` segments. Empty line keeps the existing `' '`
  (nbsp) behavior with no tokenization.

### Color source (Decision D2 — single, theme-aware palette)
- Introduce CSS custom properties for syntax token roles in `:root` (e.g. `--syn-keyword`,
  `--syn-string`, `--syn-number`, `--syn-comment`, `--syn-type`, `--syn-title`,
  `--syn-attr`, `--syn-literal`, `--syn-built_in`, `--syn-meta`, `--syn-default`), seeded
  from the **editor palette** in `monaco-theme.ts` (keyword `#d9775c`, string `#6cc18a`,
  number `#d9a14b`, comment `#585e6a` italic, type `#5e9bd6`, default `#d7dae1`).
- Ship an **app-owned hljs class→variable stylesheet** (`webview/hljs-theme.css`) that maps
  `.hljs-keyword`→`var(--syn-keyword)` etc. **Replace** the hardcoded
  `import 'highlight.js/styles/github-dark.css'` in `markdown-viewer.tsx` with this
  app-owned theme so **markdown code blocks and review rows share one palette that matches
  the editor** — this is the "single source, not a second hardcoded set" the conductor
  required, and the root-cause fix (avoids a `.rline .hljs-*` specificity war against a
  globally-imported upstream theme, which CLAUDE.md forbids). See **D2** for the flagged
  consequence (markdown code-block colors shift to the editor palette).
- **Add/remove interplay:** keep `.rline--add`/`.rline--del` **background tints** and the
  **green/red +/- sign + gutter**. Drop the blanket `color: var(--green/--red)` on
  `.rline__text` for highlighted rows so token colors show (GitHub-style: tint = add/remove,
  text = syntax). Plain-fallback rows (unknown lang) retain today's solid green/red/dim text
  (no regression). See **D3**.

### Perf & windowing safety
- Highlighting runs **only on rendered rows** (windowed cards × ≤`MAX_CARD_ROWS`, plus
  revealed fold lines) — never the whole file/tree. No change to `computeWindow`,
  `estimateCardHeight`, `planRowCap`, the per-card diff fetch, or the per-path caches.
- Tokens are inline `<span>`s inside the same `<pre>` with the same font/line-height → **no
  measured-height change**, so scroll-anchoring (`onMeasure`) and estimates are unaffected.
- **Cache:** module-level `Map` keyed by `` `${hljsLang} ${text}` `` → `Seg[]`, with a
  bounded size via **FIFO eviction** (chosen over LRU for simplicity — `Map` preserves
  insertion order, so eviction is `delete(firstKey)` on overflow; access-order LRU isn't
  worth the bookkeeping for a presentational cache) with a fixed cap
  (`SYNTAX_CACHE_MAX = 5000`). Eviction only drops a cached result; the next request
  re-tokenizes deterministically, so there is no mid-render correctness hazard. Scrolling a
  card out/in or re-rendering never re-tokenizes a still-cached line, and the map can't grow
  unbounded on a huge diff.
- **Long-line guard:** if `text.length` exceeds a cap (e.g. 2000 chars), skip hljs and
  return one plain segment (hljs regex cost is superlinear on pathological lines); the row
  still wraps as today.
- **Theme switch = pure CSS recolor:** because colors are CSS variables, changing the
  palette recolors instantly with **no re-tokenize and no cache invalidation**. (Font-scale
  changes already clear the height cache in `review-view.tsx`; tokens are unaffected.)

## Behavior & states

| State | Rendering |
|---|---|
| Known language, normal line | text as colored token segments; tinted bg for add/del |
| Unknown/plaintext language | single plain segment; today's solid green/red/dim text |
| Empty line (`text===''`) | nbsp placeholder, no tokenization (unchanged) |
| Line over long-line cap | single plain segment (no hljs), still wraps |
| Fold-revealed context line | tokenized same as inline context rows |
| Diff not yet loaded / binary / image | unchanged (no rows to highlight) |
| Theme/palette change | spans keep classes; CSS vars repaint colors, no JS |

## Edge cases & failure modes
- **Unknown extension / `plaintext`** → `monacoLangToHljs` returns `null` → plain fallback.
- **hljs language not registered** (`getLanguage` false) → plain fallback (defensive; some
  Monaco ids have no hljs analog).
- **hljs throws despite `ignoreIllegal: true`** (it can still throw on a missing embedded
  sub-language or a malformed grammar) → `highlightLine` MUST wrap the `hljs.highlight` call
  in `try/catch` and return the plain single-segment fallback on any throw (never let a
  highlight failure break a review row). hljs is fully synchronous, so there is no async
  race or partial-result state to reconcile.
- **Whitespace-only (non-empty) line** (e.g. an indented blank continuation) — hljs may
  return zero tokens for it. `highlightLine` MUST still return exactly one segment
  `[{ text, cls: null }]` (never an empty array) so the concat invariant holds and the row
  renders its whitespace. Unit-tested explicitly.
- **Multi-line constructs** (block comment `/* … */`, template literals, heredocs) are
  tokenized **per line** with no cross-line state, so a continuation line may color
  imperfectly. Accepted, documented tradeoff (windowing precludes whole-file state cheaply;
  matches most lightweight diff viewers). `ignoreIllegal: true` prevents throw-on-partial.
- **Very long lines / minified blobs** → long-line cap → plain.
- **Whitespace / indentation** must be preserved exactly — segment concat === input
  (invariant test); `white-space: pre-wrap` on `.rline__text` is retained.
- **Copy/selection**: token spans live inside the existing `<pre>`; selecting rows and
  copying must yield the original text with newlines. Segment concat === input guarantees
  per-line text; row-to-row newlines come from the `<pre>` block layout as today. Verify.
- **Safety/XSS**: segments render as React text children (no `innerHTML`), so hostile file
  content cannot inject markup regardless of hljs behavior.
- **Huge changeset** (thousands of files) → still windowed; only ~2 viewports of cards
  mount; highlight work bounded by the cache + row cap.
- **Cache growth** on a long session of large reviews → bounded eviction.

## Defaults vs. settings
- **Highlighting is ON by default, no setting.** Rationale: it's a strictly-better default
  for the primary review surface, is not a durable divergent preference, and adding a toggle
  is over-production. (If a user ever wants it off, that's a future setting — out of scope.)
- **Palette = the editor palette** (single source), not user-configurable here — it already
  follows the app theme via CSS vars.

## Scope slicing
- **MVP:** `syntax-highlight.ts` helper + monaco→hljs map + cache + long-line guard; `Line`
  renders segments; `--syn-*` vars + app-owned hljs theme applied to review rows; add/remove
  tint+sign preserved. Working / commit / range sources all benefit (same `Line`).
- **v1:** replace `github-dark.css` in markdown with the shared app-owned theme (D2) so both
  surfaces match the editor.
- **Vision (out):** per-language context carry-over for multi-line constructs; intra-line
  char-level diff coloring; user-selectable syntax themes.

## Acceptance criteria

Declarative (all tiers):
1. Opening Review on a repo with a modified `.ts`/`.tsx` file shows **multiple distinct
   token colors** on `+`, `-`, and context rows (keywords, strings, comments visibly
   differ), matching the editor palette values.
2. A modified file with an **unknown extension** (e.g. `.someext`) renders diff rows as
   plain text with **no console error** and no missing-color breakage.
3. `+` rows keep a green background tint and a green `+` sign; `-` rows keep a red tint and
   red `-` sign — **both remain visible** with token colors on the text.
4. A **large** modified file (e.g. 1000+ changed lines) still opens instantly and scrolls
   flat: `window.__conduitReviewPerf.mountedCardCount` stays bounded (windowing intact) and
   the card still shows the capped portion + "Show all".
5. Switching the theme/palette **recolors** tokens with no reflow and no re-fetch.
6. Selecting a highlighted diff row and copying yields the **original line text** unchanged.
7. **Contrast:** every `--syn-*` token color remains legible over BOTH the add tint
   (`rgba(108,193,138,0.1)`) and the del tint (`rgba(224,114,111,0.1)`) atop the code
   surface — no token (especially the dim comment `#585e6a`) drops to an unreadable
   contrast. The tints are only 10% alpha so the effective background barely shifts from the
   base surface, but the implementer MUST spot-check comment + type colors on a `+`/`-` line
   (the screenshot criterion covers this visually). If a token fails, darken the tint's
   alpha impact is NOT the fix — adjust the `--syn-*` value in the shared palette (single
   source), since the same variable also serves markdown/editor consistency.

EARS:
- **Ubiquitous:** The Review view SHALL render each visible diff line's text as
  language-tokenized colored segments.
- **Event-driven:** WHEN a diff line's file language is unknown or unsupported, the Review
  view SHALL render that line as a single plain (uncolored) text segment.
- **Unwanted:** IF a line exceeds the long-line cap, THEN the Review view SHALL render it
  plain without invoking the tokenizer.
- **State-driven:** WHILE a card is outside the render window, the Review view SHALL NOT
  tokenize its lines.

Gherkin:
```gherkin
Scenario: TypeScript diff rows are syntax-colored
  Given a working tree with a modified TypeScript file
  When I open Review changes
  Then the added and removed rows show more than one token color
  And the add rows keep a green tint and the del rows keep a red tint

Scenario: Unknown language falls back to plain
  Given a modified file whose extension maps to no language
  When I open Review changes
  Then its diff rows render as plain uncolored text with no error

Scenario: Large file stays windowed
  Given a modified file with over one thousand changed lines
  When I open Review changes and scroll
  Then the mounted card count stays bounded
  And the card shows a capped portion with a "Show all" control
```

Screenshot criterion (required, FULL): a captured screenshot of Review on a `.ts` change
shows **visibly multiple token colors** on `+`/`-` lines over the tinted backgrounds
(keyword vs string vs comment distinguishable), and a second screenshot of an unknown-lang
file shows plain rows — proving both the highlight path and the fallback.

## Test plan

There is **no React component-test infra** (no RTL/jsdom) — component behavior is verified
via e2e/screenshot; pure helpers via vitest.

**Unit (vitest, `test/unit/syntax-highlight.test.ts`):**
- `highlightLine('const x = 1', 'typescript')` yields ≥2 segments; concatenated text ===
  input.
- **Invariant across many inputs**: for assorted lines/langs, `segs.map(s=>s.text).join('')`
  === input (whitespace, unicode, empty, tabs).
- Unknown lang / `null` → exactly one `{text, cls:null}` segment.
- Long line over cap → single plain segment (tokenizer not invoked / cheap path).
- Whitespace-only non-empty line → exactly one segment (never empty array); concat === input.
- hljs-throws path: a stubbed/forced throw returns the plain single-segment fallback (no
  exception escapes).
- `monacoLangToHljs`: spot mappings (`typescript`→`typescript`, `shell`→`bash`, `bat`→`dos`,
  `html`→`xml`, `plaintext`→null, unknown→null) **and** the completeness check — for every
  Monaco id `langFromPath` can emit, `monacoLangToHljs(id)` is either `null` or a value for
  which `hljs.getLanguage(result)` is truthy in the shipped build (guards against pointing
  at an unregistered id).
- Cache: two calls with identical `(lang,text)` return equal results; and inserting
  `SYNTAX_CACHE_MAX + 1` distinct keys keeps the map size at `SYNTAX_CACHE_MAX` (FIFO bound).

**E2E / runtime (`test/e2e/review-diff-syntax.e2e.mjs`, on the shared harness):**
- Open Review on a seeded modified `.ts` file; assert `.rline__text` contains
  `span.hljs-keyword`/`.hljs-string` (or ≥2 distinct computed token colors) on add/del rows.
- Assert add row still has the tint background and green `+` sign; del row red.
- Seed a modified unknown-extension file; assert its rows have **no** `.hljs-*` spans and
  render text.
- Reuse the virtualization load fixture (`review-virtualize.e2e.mjs` pattern) to confirm a
  large file keeps `window.__conduitReviewPerf.mountedCardCount` bounded with highlighting on.
- Runs under the hidden `CONDUIT_E2E=1` harness (`test/e2e/harness.mjs`, per CLAUDE.md), like
  the other `review-*` scenarios; close via `closeApp` (not bare `app.close()` — quit-guard).
- **Screenshot criterion is asserted, not just captured:** the e2e reads
  `getComputedStyle().color` across the token spans in a `.ts` card and asserts **≥3 distinct
  colors** appear on `+`/`-`/context rows (proves multi-token highlighting) and that the
  add/del row's `background` is non-transparent (tint survives). Screenshots are saved to OS
  temp (workspace hygiene) for the conductor's taste pass; the numeric color-count is the
  machine pass/fail. The unknown-lang card asserts **0** `.hljs-*` spans.

## Decisions Needed

- **D1 — Per-line (not whole-file) tokenization.** Severity: `normal`. Line-scoped
  highlighting loses cross-line context (block comments, template literals). Chosen because
  the review list must not hold whole-file editor/highlighter state (windowing/perf mandate)
  and rows are already line-atomic (`ReviewLine`). Reversible later via a per-hunk
  continuation-state pass. **Default: per-line.**
- **D2 — Replace markdown's `github-dark.css` with a shared app-owned, variable-driven hljs
  theme matching the editor palette.** Severity: `normal`. This satisfies the conductor's
  "single source, matches the editor" directive and avoids a specificity war, but it
  **changes the color of existing markdown code blocks** (from GitHub-dark to the Conduit
  editor palette — an intended consistency improvement). Fallback if judged too broad:
  scope the `--syn-*` mapping to a review-only wrapper class and leave markdown on
  github-dark (accepts two palettes — weaker on the conductor's directive). **Default: shared
  app-owned theme (touch `markdown-viewer.tsx` import).**
- **D3 — Add/remove rows: text becomes syntax-colored; tint + colored sign convey add/del.**
  Severity: `normal`. Drops the blanket green/red text color on highlighted `.rline__text`
  (GitHub behavior). Plain-fallback rows keep today's solid green/red. Reversible via CSS.
  **Default: as described.**

## Self-audit
Core spine: Problem ✓ · Behavior/states ✓ · Data/interface (helper signature + invariant) ✓
· Edge cases/failure ✓ · Defaults vs settings ✓ · Scope slicing ✓ · Acceptance (declarative
+ EARS + Gherkin + screenshot) ✓. UI module: state catalog ✓ · interaction (copy/selection,
theme switch) ✓ · a11y — token spans are decorative color only; text remains real DOM text
so screen readers and copy are unaffected; no new focus/ARIA (rows are non-interactive
`<pre>`); color is not the *only* signal for add/del (sign `+`/`-` + gutter remain) ✓ ·
i18n — no user-facing strings added; token classes are language-code driven, not localized ✓
· design tokens — colors via `--syn-*` CSS variables from the editor palette, no raw hex in
review rows ✓. No open template items.

## Files the implementation will touch
- **NEW** `webview/syntax-highlight.ts` — `highlightLine`, `monacoLangToHljs`, bounded cache,
  long-line guard.
- `webview/components/review-view.tsx` — `Line` renders segments; thread `hljsLang` from
  `ReviewFileCard` → `HunkList` → `Hunk`/`FoldRow` → `Line`.
- `webview/styles.css` — **YES, touched**: add `--syn-*` variables; adjust
  `.rline--add/--del .rline__text` color rules so token colors show while tint+sign stay.
- **NEW** `webview/hljs-theme.css` — app-owned hljs class→`--syn-*` mapping (shared palette).
- `webview/components/markdown-viewer.tsx` — swap `github-dark.css` import for the app-owned
  theme (D2).
- **NEW** `test/unit/syntax-highlight.test.ts` — pure-helper unit tests.
- **NEW** `test/e2e/review-diff-syntax.e2e.mjs` — runtime/screenshot verification.
