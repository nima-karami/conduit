---
status: active
date: 2026-07-01
tier: FULL
type: UI
slug: theme-correctness
---

# Theme correctness — all six themes render the code + reading surfaces correctly

> **Conductor build note (2026-07-01):** DOWNSCOPED at build time. Verification found
> `--code-bg`/`--term-bg` are a single dark default, never theme-overridden — so the
> editor/terminal SURFACE is dark on every theme and Monaco's `vs-dark` is *correct*
> for it (a dark editor on a light app is an aesthetic island, not a legibility bug).
> **Shipped:** the genuine light-theme legibility fixes only — `.md-p/.md-ul strong`
> `#fff`→`var(--text)`, the phantom `--vscode-input-background,#2a2a2a` fallbacks
> (`.gh__reffilter`, `.session__edit`)→`var(--raise)`, and accent buttons `#fff`→
> `var(--on-accent)` for token consistency. **Deferred** (surfaced as a product
> decision in `docs/runs/2026-07-01-solidify-polish/report.md`): making the code/
> terminal surface *follow the theme* (a `surfaceColor:'auto'` sentinel + per-theme
> `--code-bg` + theme-aware Monaco + settings-picker UI) — a taste + settings-schema
> bet not auto-landed. The design below documents that deferred FULL approach.

## Problem

Conduit ships six themes (`midnight`, `slate`, `nord`, `forest`, `paper` [light],
`contrast` [high-contrast]) selectable in Appearance settings. Only the dark themes
actually render correctly. Two concrete defects:

1. **The Monaco code + diff editors are hardcoded to a dark theme.**
   `webview/monaco-theme.ts` `ensureTheme()` pins `base: 'vs-dark'` and hardcodes the
   foreground (`#d7dae1`), line-number, selection, cursor, five syntax-token colors,
   and the diff insert/remove tints. Nothing about them reacts to the selected theme,
   and nothing re-applies them when the theme changes. On Paper / high-contrast the
   editor is visually wrong (dark-optimized syntax colors, wrong base).

2. **Several hardcoded colors in `webview/styles.css` break contrast on light
   backgrounds.** e.g. markdown bold is forced `#fff` (invisible on Paper's
   `#f4f1ea` bg / `#ffffff` panel); two inputs fall back to a dark `#2a2a2a` behind
   dark theme text.

The job to be done: a user who picks Paper or High contrast gets a code viewer,
diff viewer, and markdown that are **legible and coherent with the theme**, and a
theme switch re-themes the open editors live (no reload).

**No-regression boundary:** the *editor* (code + diff) must look byte-for-byte
identical on the four dark themes — the new `--editor-*` defaults equal the old
hardcoded values. Two small, **intentional** cross-theme changes fall *outside* that
boundary (audit items 4–6): `.codeblock__src` adopts the editor-fg token
(near-identical, `#c5cad3` → `#d7dae1`), and the two accent-fill buttons switch
`#fff` → `var(--on-accent)`, which is a *dark* ink on the dark themes too (root
`#1a0f0b`; slate/forest inherit it) — a deliberate legibility improvement (white on
midnight's coral / nord's cyan / contrast's amber is low-contrast). Everything else
on the dark themes is unchanged.

**Actors:** any user changing the Appearance → Theme setting; downstream: anyone
reading code/markdown/diffs under a non-dark theme.

**Non-goals (see Scope/out):** a token-system rewrite, a color-picker UI, per-token
customization, tokenizing radius/shadow, or "auto/system" theme detection.

---

## Scope

### In scope
- Make Monaco (code viewer + diff viewer) theme-aware, driven entirely by per-theme
  CSS vars declared in `webview/styles.css` (the single source of theme truth).
- Re-apply the Monaco theme live on theme switch (and keep the existing live
  re-apply on surface-color / opacity change).
- Fix the specific hardcoded colors that genuinely break on a **light** or
  **high-contrast** background (audited list below). Correctness only.
- Make the shared code/terminal **surface** follow the theme by default so Paper's
  editor background is light out-of-box (see **D1** — this is the one place the fix
  reaches beyond the editor vars, and it is required for out-of-box Paper
  correctness).

### Out of scope (explicit)
- No 3-tier token hierarchy, no design-token rename/refactor.
- No color-picker / per-token theming UI.
- No tokenizing of `border-radius` / `box-shadow` / spacing.
- No new themes, no OS "auto" theme.
- No change to xterm theming logic beyond it inheriting the surface default (it
  already reads `--term-bg`; behavior identical when a user has an explicit color).
- Markdown re-theme needs **no JS**: `.md-*` already use CSS vars, so they re-theme
  via CSS the instant `data-theme` flips. Only the hardcoded `#fff` bold color is a
  bug (fixed below).

---

## Design — Monaco theme-aware via CSS vars

### 1. Per-theme editor CSS vars (single source: `webview/styles.css`)

Add editor vars to the existing `:root` block with the **current hardcoded dark
values as defaults**, so `midnight` / `slate` / `nord` / `forest` are byte-for-byte
unchanged (they inherit `:root`; do **not** add per-dark-theme overrides). Only
`paper` and `contrast` override.

`:root` (defaults reproduce today's look exactly):

```css
--editor-base: vs-dark;          /* monaco BuiltinTheme id, chosen explicitly */
--editor-fg: #d7dae1;
--editor-line-number: #3a3f49;
--editor-selection: #d9775c33;   /* 8-digit hex (alpha) */
--editor-cursor: #d9775c;
--editor-token-comment: #585e6a; /* rendered italic */
--editor-token-keyword: #d9775c;
--editor-token-string: #6cc18a;
--editor-token-number: #d9a14b;
--editor-token-type: #5e9bd6;
--editor-diff-insert: #6cc18a22;
--editor-diff-remove: #e0726f22;
```

`:root[data-theme="paper"]` adds (base = light; syntax tuned for a light surface):

```css
--editor-base: vs;
--editor-fg: #25201a;
--editor-line-number: #b3ab9b;
--editor-selection: #c2603f33;
--editor-cursor: #c2603f;
--editor-token-comment: #8a8375;
--editor-token-keyword: #a94e30;
--editor-token-string: #2f7d4f;
--editor-token-number: #9a6b1e;
--editor-token-type: #2f6aa8;
--editor-diff-insert: #2f7d4f22;
--editor-diff-remove: #b23a3622;
```

`:root[data-theme="contrast"]` adds (base dark, values pushed to max legibility on
`#000`):

```css
--editor-base: vs-dark;
--editor-fg: #ffffff;
--editor-line-number: #b0b0b0;
--editor-selection: #ffb00040;
--editor-cursor: #ffb000;
--editor-token-comment: #b8b8b8;   /* NOT dim-grey — must read on black */
--editor-token-keyword: #ffb000;
--editor-token-string: #5fe08a;
--editor-token-number: #ffc94d;
--editor-token-type: #7bc0ff;
--editor-diff-insert: #33ff8833;
--editor-diff-remove: #ff595933;
```

(Exact hex values are a starting point; the screenshot acceptance criterion is the
gate — the implementer may nudge for legibility, but every value stays a CSS var in
these blocks, never re-hardcoded in TS.)

### 2. `ensureTheme()` reads the vars

`webview/monaco-theme.ts` keeps its signature and the existing `--code-bg` /
`--code-alpha` read for the editor background (unchanged). It additionally reads the
new vars via the existing `cssVar` helper, with the dark values above as fallbacks
(so a stale/absent var never yields a broken theme). Notes:

- **Base:** `base = cssVar(cs, '--editor-base', 'vs-dark')` cast to
  `monaco.editor.BuiltinTheme`. Chosen from the var, **never** luminance-guessed.
- **Token `foreground` needs bare 6-hex (no `#`);** `colors{}` values keep `#`. Add
  a tiny `strip('#')` for the five token colors when building `rules`. Do **not**
  strip for `colors{}`.
- Selection / diff values are 8-digit hex (alpha baked in) and pass straight through.
- `editor.background` / `editorGutter.background` stay `withAlpha(codeBg, alpha)` as
  today (translucency preserved).

### 3. Re-apply on theme switch (the propagation fix)

Today the only Monaco re-apply is in `code-viewer.tsx`, an effect keyed on
`[settings.surfaceColor, settings.codeOpacity]` — it does **not** react to
`settings.theme`, and `diff-viewer.tsx` has **no** re-apply effect at all. So a
theme switch never re-themes an open editor.

Wiring (mirrors the xterm / mermaid re-theme pattern):

- **`code-viewer.tsx`:** extend the existing re-theme effect's deps to
  `[settings.theme, settings.surfaceColor, settings.codeOpacity]`.
- **`diff-viewer.tsx`:** add the same re-theme effect (it has none today).
- **Ordering gotcha (load-bearing):** `SettingsProvider.applyToDom` sets
  `data-theme` in a **parent** effect, which React runs *after* child effects. So a
  child re-theme effect that reads CSS synchronously on a `settings.theme` change
  reads the **previous** theme's `--editor-*` vars (the exact stale-read bug
  documented for mermaid-theme / xterm). Therefore the re-theme must defer one frame:
  `requestAnimationFrame(() => monaco.editor.setTheme(ensureTheme({ surfaceColor, codeOpacity })))`,
  cancelling the rAF in cleanup. Inside that frame `data-theme` is live, so
  `ensureTheme` reads the correct `--editor-*` vars. Surface color / opacity continue
  to be passed as args (no lag), the editor-* vars come from the now-fresh CSS.
- `monaco.editor.setTheme` is **global** (re-defines + applies `agentdeck` to every
  editor), so a single fire re-themes both viewers; each still owns an effect to
  cover the case where only one viewer is mounted.

### 4. Shared surface follows the theme (D1 — required for out-of-box Paper)

The editor background is `--code-bg` = `settings.surfaceColor`, a single global user
setting (default `#0a0b0e`), written inline by `applyToDom` and **theme-independent**.
With `--editor-base: vs` + a dark `--editor-fg` on a still-dark surface, Paper renders
**dark-on-dark out of the box** — worse than today. For the "editor legible under
Paper" acceptance criterion to hold without the user hand-editing surfaceColor, the
surface must be light on Paper.

Chosen resolution (see **Decisions Needed D1**, tagged `high`):
- Introduce a sentinel default `surfaceColor: 'auto'` meaning "follow the theme."
  `src/settings.ts` `DEFAULT_SETTINGS.surfaceColor` becomes `'auto'`;
  `surfaceColorFrom` accepts `'auto'` as valid (any explicit hex still wins and is
  preserved — existing users who set a color are unaffected). Watch the fallback
  chain: today `surfaceColorFrom` routes through `hexColor(...)` which would *reject*
  the sentinel, so `'auto'` must be short-circuited before the hex validator (and be
  the value the validator's own default resolves to), or it will silently fall back to
  a hex color and defeat the feature.
- `applyToDom` (`webview/settings.tsx`): when `surfaceColor === 'auto'`, do **not**
  set the inline `--code-bg` / `--term-bg` (let the per-theme CSS default apply);
  otherwise behave exactly as today.
- Add per-theme surface defaults in `styles.css`: `:root` keeps `--code-bg: #0a0b0e`
  (+ a matching `--term-bg`); `paper` sets `--code-bg`/`--term-bg` light (e.g.
  `#faf8f3`), `contrast` sets them to `#000000`. Dark themes inherit `:root`.
- `ensureTheme` / the re-theme effects must treat `'auto'` correctly: when
  surfaceColor is `'auto'`, read the background from the live `--code-bg` CSS var
  (the no-arg path already does this) rather than passing the literal `'auto'` string
  as a color. Simplest: the re-theme effects pass the resolved surface (or omit the
  arg so `ensureTheme` reads `--code-bg` from CSS) when `'auto'`.

This is the only part of the fix that touches settings/persistence. It is reversible
(a user can pick any explicit color to opt out) and is scoped to a default + a
sentinel — **not** a token-system rewrite. If the conductor prefers to keep the
editor a dark island on light themes, D1 can be dropped and the editor vars shipped
alone (then the Paper screenshot AC is relaxed to "legible when a light surface is
chosen"); this spec's default is to ship D1.

---

## Audited hardcoded-color fixes (correctness only)

Each candidate judged by: *does it actually break on a light (Paper: bg `#f4f1ea`,
panel `#ffffff`) or high-contrast background?* White text on a saturated accent/danger
fill is **correct** regardless of theme and is excluded.

| # | Location (approx line) | Current | Verdict | Fix |
|---|---|---|---|---|
| 1 | `styles.css` `.md-p strong, .md-ul strong` (~2928) | `color:#fff` | **BREAKS** — white bold on Paper's white/paper bg is invisible | `color: var(--text)` (bold = body color + heavier weight) |
| 2 | `styles.css` `.gh__reffilter` (~2159) | `background: var(--vscode-input-background, #2a2a2a)` | **BREAKS** — `--vscode-input-background` is never defined in this app, so the dark `#2a2a2a` is *always* used; dark input + `var(--text)` dark text on Paper = illegible | `background: var(--raise)` (drop the dead var) |
| 3 | `styles.css` `.session__edit` (~2866) | same as #2 | **BREAKS** — same reason | `background: var(--raise)` |
| 4 | `styles.css` `.codeblock__src` (~2996) | `color:#c5cad3` | **CONDITIONALLY BREAKS** — its bg is `--code-surface` (from `--code-bg`); once D1 makes the surface light on Paper, light-grey text on a light surface is illegible | `color: var(--editor-fg)` (tracks the code surface; default `#d7dae1` — a *near-identical* shift from `#c5cad3` on dark themes, not literally unchanged) |
| 5 | `styles.css` `.update-card__action` (~4481) | `background: var(--accent); color:#fff` | **BREAKS** — white on `--accent` fails on nord (pale cyan `#88c0d0`) and contrast (amber `#ffb000`); the palette already has `--on-accent` for exactly this. **Note:** `--on-accent` is a *dark* ink on the dark themes (root `#1a0f0b`; slate/forest inherit), so this **intentionally repaints** the dark-theme button text (white → near-black) — a legibility improvement, outside the editor no-regression boundary | `color: var(--on-accent)` |
| 6 | `styles.css` `.about__checkbtn--accent` (~6586) | `background: var(--accent); color:#fff` | **BREAKS** — same as #5, incl. the intentional dark-theme repaint | `color: var(--on-accent)` |
| 7 | `styles.css` `.webview__body` (~7859) | `background:#fff` | **LEAVE** — container behind the embedded-browser `<iframe>` (fills `inset:0`); white is a sane default for arbitrary web content and is fine on a light theme; on dark it's at most a brief load-flash — cosmetic, out of correctness scope |
| 8 | `styles.css` `.winctl__btn--close:hover` (~572) | `color:#fff` | **LEAVE** — white on `--red` (saturated coral in every theme, incl. paper/contrast which don't override `--red`); legible everywhere |
| 9 | `styles.css` `.btn--danger` (~5236) | `color:#fff` | **LEAVE** — white on `--red`; same as #8 |
| 10 | `architecture-view.tsx` `MINIMAP_FALLBACK_COLOR` (~220) | `'#8a8a8a'` | **LEAVE** — deliberate mid-grey chosen to be visible on any minimap bg (light or dark); not a contrast break; only used when a node kind has no color |

**Net edits:** items 1–6 (five `styles.css` selectors + the shared editor-fg token on
`.codeblock__src`). Items 7–10 left as-is with rationale.

---

## Edge cases & failure modes

- **Translucent editor bg × light base (D1 interaction).** With `--code-alpha < 1`
  the editor canvas is translucent and the animated backdrop shows through. On Paper
  (`--editor-base: vs`, light surface) a low opacity means the syntax colors must
  read against *both* the light surface and the backdrop bleeding through. Token
  colors above are chosen saturated/dark enough to survive moderate translucency;
  the screenshot AC is checked at the default opacity (1) and spot-checked at a
  reduced opacity.
- **Diff insert/remove on a light base.** The dark-theme tints (`#6cc18a22` /
  `#e0726f22`) are near-invisible on a light surface. Paper overrides them to
  darker-tinted green/red (`--editor-diff-insert` / `--editor-diff-remove`); verify
  added/removed lines are distinguishable in a side-by-side diff under Paper.
- **High-contrast legibility.** `contrast` must not reuse the dim comment grey
  (`#585e6a` is ~unreadable on `#000`); it overrides to `#b8b8b8` and pushes every
  token to a high-lightness value. Cursor/selection use the amber accent so they're
  findable.
- **Stale CSS var on theme switch** (the rAF ordering above). Without the deferred
  read, the first switch shows the previous theme's editor colors until the next
  unrelated re-render.
- **First mount while already on a non-dark theme** (a distinct path from the switch
  fix). Opening a code / diff file when the app is *already* on Paper or contrast has
  no theme-change event and needs no rAF — `data-theme` is already live, so the mount
  `ensureTheme()` call reads the correct `--editor-*` synchronously. Must be verified
  independently of the live-switch path (they exercise different code): the mount path
  is the existing `ensureTheme()` at editor create; the switch path is the new
  rAF-deferred effect.
- **User with an explicit surfaceColor + light theme.** They opted out of `'auto'`;
  the editor keeps their color (may be dark on Paper — their choice). `--editor-fg`
  etc. still apply; a dark surface + light-tuned Paper fg could be low-contrast, but
  this is a deliberate user override, not a default. Acceptable.
- **Persistence migration.** Old persisted `surfaceColor: '#0a0b0e'` stays a valid
  explicit color (dark editor everywhere, as today). Only new installs / resets get
  `'auto'`. No data loss; `surfaceColorFrom` validates the new sentinel.
- **Monaco define/apply is global + idempotent.** Firing the re-theme from two
  mounted viewers simultaneously is harmless (last write wins, same values).
- **Fallbacks.** Every `cssVar` read passes the dark default, so a missing var can
  never produce an all-black/blank editor.

---

## Accessibility / i18n / tokens (UI module)

- **Accessibility (central to this feature):** the whole point is contrast. Target
  WCAG AA (≥4.5:1) for editor foreground vs. editor background and for the fixed
  colors under every theme; ≥3:1 for the high-contrast token set (amber-on-black is
  ~10:1). No keyboard/focus/ARIA changes (purely color).
- **i18n:** N/A — no new copy; color values only.
- **Design tokens:** the fix *uses* the existing token system (`--text`,
  `--on-accent`, `--raise`, new `--editor-*`), all declared in the established
  `[data-theme=...]` blocks. No new token *tiers*, no picker.
- **Reduced motion:** untouched.

---

## Defaults vs. settings

- No new user-facing setting. The theme picker already exists; this makes it
  actually work across all six.
- The one default change: `surfaceColor` default `'#0a0b0e'` → `'auto'` (D1).
  Rationale: "the editor surface follows my theme" is the safe 80% behavior; power
  users who want a fixed editor color still set one and it's preserved.

---

## Acceptance criteria

Declarative:
- **AC1** Switching Appearance → Theme to Paper re-themes any open code viewer and
  diff viewer **live** (no reload): light `--editor-base: vs`, dark foreground on a
  light surface, syntax tokens legible.
- **AC2** Switching to High contrast yields white-on-black editor text with the
  high-contrast token set; comments are legible (not dim grey).
- **AC3** Switching back to a dark theme (midnight/slate/nord/forest) reproduces the
  **exact** pre-change *editor* appearance (defaults == old hardcoded values). The two
  accent-fill buttons (items 5–6) legitimately change on dark themes (white →
  `--on-accent`) and are excluded from this "exact" claim.
- **AC3b** Opening a code file *and* a diff *while already on* Paper (no theme-switch
  event) renders the correct light editor colors on first mount (the non-rAF path).
- **AC4** Under Paper: markdown bold text is visible (`var(--text)`), the History
  ref-filter and the session-rename input have a light background with legible text.
- **AC5** Accent buttons (`update-card__action`, `about__checkbtn--accent`) use
  `--on-accent`: black text on the amber accent under High contrast, not white.
- **AC6 (screenshot)** With a code file *and* a markdown file open, capture under
  **Paper** and under **midnight**: in both, editor syntax, line numbers, and
  markdown body/bold are legible and coherent with the theme. (This is the taste gate
  for the exact hex values.)
- **AC7** `npm run verify` is green.

EARS:
- WHEN the user changes the theme setting, the system SHALL re-define and re-apply
  the Monaco `agentdeck` theme from the new theme's `--editor-*` CSS vars within one
  animation frame, for every mounted code and diff editor.
- WHILE the selected theme is `paper`, the system SHALL render the editor with
  `base: 'vs'` and a light editor background.
- IF an `--editor-*` var is absent, THEN `ensureTheme` SHALL fall back to the
  dark default value (no broken/blank theme).

Gherkin (core):
```
Scenario: Live re-theme to Paper
  Given a code file is open in the code viewer under the midnight theme
  When I switch the theme to Paper
  Then the editor background becomes light within one frame
  And the syntax token colors change to the Paper set
  And no reload occurs

Scenario: Dark themes unchanged
  Given a code file is open under midnight
  When I inspect the editor colors
  Then they equal the previously hardcoded dark values
```

---

## Test plan

- **Unit (pure helpers only):**
  - `withAlpha` unchanged — keep existing coverage.
  - If a `strip('#')` / token-color helper is extracted as a pure function in
    `monaco-theme.ts`, unit-test it (bare-hex output for token rules; `#`-prefixed
    passthrough for `colors{}`). Extract only if it reads cleanly as pure — do not
    force it.
  - `src/settings.ts` `surfaceColorFrom`: add cases for `'auto'` accepted, explicit
    hex preserved, legacy `codeBg` still honored, invalid → default (`'auto'`).
- **Component-effect behavior is NOT unit-testable here** — there is no RTL/jsdom
  test infra in this repo, and the re-theme depends on real `getComputedStyle` +
  Monaco. Do not add a testing framework for this.
- **Runtime / e2e (manual or smoke harness):**
  - Launch the app, open a code file + a markdown file; cycle through all six themes;
    confirm the editor re-themes live each time and dark themes look identical to
    before. Capture the AC6 screenshots (Paper + midnight) to the OS temp dir.
  - Open a diff (Review or a commit diff) under Paper; confirm insert/remove tints are
    distinguishable.
  - Verify markdown bold + the two inputs under Paper (AC4).
  - If a host/IPC boundary is touched (it is not — this is renderer + CSS only), a
    `test/e2e/*.e2e.mjs` scenario would be added; here the check is visual/runtime.
- **Regression:** `npm run verify` (format/lint/dead-code/dup/typecheck/tests/
  security) must pass; both tsconfigs typecheck.

---

## Decisions Needed

- **D1 — `high` — Editor surface following the theme.** The editor background is the
  shared, theme-independent `--code-bg` (= `settings.surfaceColor`, default dark). The
  conductor's `--editor-base: vs` for Paper only renders correctly out-of-box if the
  surface is also light. **Chosen default (this spec):** make the surface
  theme-aware via a `surfaceColor: 'auto'` sentinel default + per-theme
  `--code-bg`/`--term-bg` defaults, with `applyToDom` skipping the inline override
  when `'auto'`. This touches `src/settings.ts` and `webview/settings.tsx` (beyond
  the conductor's stated editor-vars-only footprint) and lightly affects the terminal
  surface (it also goes light on Paper — desirable). Reversible (any explicit color
  opts out; old persisted colors preserved). **Alternative if the conductor wants to
  keep the footprint minimal:** ship the `--editor-*` vars alone, leave the editor a
  dark island on light themes, and relax AC6 to "legible when a light surface is
  chosen." Flagged high because it changes a persisted default and widens the file
  set.
- **D2 — `normal` — Exact hex values for the Paper/contrast token sets.** The values
  above are a considered starting point but the AC6 screenshot is the real gate; the
  implementer may nudge them for legibility. No blocker.

---

## Files the implementation will touch

- `webview/styles.css` — add `:root` + `paper` + `contrast` `--editor-*` vars; add
  per-theme `--code-bg`/`--term-bg` surface defaults (D1); fix audited items 1–6.
- `webview/monaco-theme.ts` — `ensureTheme` reads the new vars via `cssVar`, base
  from `--editor-base`, `#`-strip for token rules, `'auto'` surface handling.
- `webview/components/code-viewer.tsx` — add `settings.theme` to the re-theme effect
  deps; wrap `ensureTheme`+`setTheme` in a cancellable `requestAnimationFrame`.
- `webview/components/diff-viewer.tsx` — add the equivalent re-theme effect (none
  today).
- `src/settings.ts` — `surfaceColor` default `'auto'`; `surfaceColorFrom` accepts the
  sentinel (D1).
- `webview/settings.tsx` — `applyToDom` skips inline `--code-bg`/`--term-bg` when
  `surfaceColor === 'auto'` (D1).
- (Left unchanged, verdicts recorded: `architecture-view.tsx`
  `MINIMAP_FALLBACK_COLOR`; `.webview__body`, `.winctl__btn--close:hover`,
  `.btn--danger` in `styles.css`.)

> If the conductor drops D1, the last two source files (`src/settings.ts`,
> `webview/settings.tsx`) fall out of scope and the change is renderer-CSS + two
> viewer effects only.
