# Spec — editor-bg (wishlist C2)

**Tier:** LITE · **Feature type:** UI
**One-line:** Drive the Monaco code-editor background from the active theme's `--bg`
CSS variable instead of a hardcoded `#0a0b0e`, so the editor surface is consistent
with the Markdown preview / app surface and follows theme switches.

## Problem frame

- **Job:** When a user opens a code file, the Monaco editor paints itself opaque
  `#0a0b0e` (hardcoded in `webview/monaco-theme.ts`). The Markdown viewer instead
  renders on `.termwrap`'s `var(--surface)` (derived from the theme `--bg`). On every
  theme the editor is **darker** than `--bg`, and on the light `paper` theme it is a
  jarring near-black box. The two center-pane surfaces should look consistent.
- **Actors:** Anyone viewing code vs. Markdown in the center pane.
- **Success:** Opening a code file and a Markdown file shows two surfaces of the same
  base tone; switching themes (incl. `paper` light) recolors the editor with the rest
  of the app.
- **Non-goals (explicit):**
  - **No user-facing transparency / opacity controls** — that is wishlist **C3**.
  - No change to syntax-token colors, gutter line-number color, selection, or cursor.
  - No change to the Markdown `pre` code-block background (also C3 territory).
  - Not solving C1 (inner-padding leak) — separate item.

## Behavior & states

- **At editor mount / theme registration:** the Monaco theme `agentdeck` is defined
  with `editor.background` (and `editorGutter.background`) read from the live
  `--bg` value of the active theme on `<html>`, via `getComputedStyle`, mirroring the
  existing `webview/xterm-theme.ts` pattern (`v(cs, '--bg', fallback)`).
- **On theme switch:** the next time the theme is registered the new `--bg` is read.
  Because `monaco.editor.defineTheme` is global and idempotent today, `ensureTheme()`
  must **re-define** the theme on each call (cheap) so a freshly-mounted editor after
  a theme change picks up the new color. (Re-theming already-open editors live is out
  of scope for this LITE fix — consistent with how the diff/code viewers already only
  read the theme at mount.)
- **Fallback:** if `--bg` is empty/unreadable, fall back to the previous `#0a0b0e`
  so behavior never regresses to a broken (e.g. transparent) editor.

## Interface contract

- `ensureTheme()` in `webview/monaco-theme.ts` keeps its signature
  (`(): string` returning the theme id `'agentdeck'`). Internally it reads CSS vars at
  call time rather than capturing a literal.
- Opaque color only. Monaco's canvas `editor.background` does not honor CSS
  `color-mix` translucency the way `--surface` does; matching the **base `--bg`
  color** is the agreed consistency target. C3 will layer translucency on top.

## Edge cases

- **Light theme (`paper`, `--bg: #f4f1ea`):** editor must become light, not stay
  near-black. The `vs-dark` base still governs token colors; only the background
  color is overridden — acceptable for this LITE pass (token contrast on light bg is a
  known follow-up, not in C2 scope).
- **`data-background="none"`:** unaffected — we read `--bg` (the solid base), which is
  defined in all modes.
- **First paint before `data-theme` is applied:** `ensureTheme()` is called from the
  viewer mount effect, by which point `SettingsProvider` has already set
  `data-theme` on `<html>` (same ordering the terminal relies on).

## Defaults vs. settings

- No new setting. The editor background simply follows the existing theme `--bg`.
  Rationale: keeping it variable-driven (not hardcoded) is exactly the seam C3 needs
  to add transparency control later.

## Scope slicing

- **MVP (this task):** `editor.background` + `editorGutter.background` read from
  `--bg`; opaque; theme-aware via re-definition on each `ensureTheme()` call.
- **Out of scope:** C3 transparency range + granular code-block styling; live
  re-theming of open editors; light-theme token-contrast tuning; Markdown `pre` bg.

## Acceptance criteria (declarative)

1. `webview/monaco-theme.ts` no longer hardcodes `#0a0b0e` for `editor.background` /
   `editorGutter.background`; both are sourced from the active `--bg` (with a literal
   fallback only if the var is empty).
2. On the default `midnight` theme, the open code editor's background equals the
   theme `--bg` base tone — no longer visibly darker than the Markdown viewer.
3. On the `paper` light theme, the editor background is light (matches `--bg`), not
   near-black.
4. `npm run verify` and `npm run build` both pass.
5. Runtime proof: a code file and a Markdown file opened side-by-side show
   consistent (not dark-vs-light-mismatched) backgrounds.

## Self-audit

Template spine covered: problem frame, behavior/states, interface contract, edge
cases, defaults/settings, scope slicing, acceptance criteria. UI module: states &
theme-switch interaction covered; a11y — no new interactive control or focus path
added (background color only), so no new a11y surface; i18n — no user-facing copy
added. No items left unaddressed.

## Decisions Needed

none
