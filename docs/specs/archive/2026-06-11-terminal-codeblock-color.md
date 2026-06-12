# Spec — Unified code-block + terminal background colour (wishlist I1)

## Context

Round-1 C3 gave the **code block** a user-controllable background colour
(`codeBg`) plus its own opacity (`codeOpacity`). The **terminal had no colour
control at all** — xterm's `theme.background` was derived from the active theme's
`--bg` palette value, with the panel's `--surface-alpha` applied for translucency.

User requirement (I1): _"the color of the code block and the color of the terminal
should be the same thing — they should have the same color."_ So there must be
**one** colour setting that drives **both** the code-block background and the
terminal background; changing it updates both surfaces together so they always
match.

## The unified-colour design + migration

### One shared key (rename, not reuse)

The legacy `codeBg` field was **renamed** to `surfaceColor` — a single shared
"Code & terminal background" colour. This is the cleanest model: one concept, one
key, no chance of the two surfaces drifting. `codeOpacity` is unchanged.

`surfaceColor` flows to two CSS variables (set together in
`webview/settings.tsx → applyToDom`):

- `--code-bg` — the code-block surface (Monaco `editor.background` +
  `.markdown pre` via `--code-surface`), with `--code-alpha` (= `codeOpacity`).
- `--term-bg` — the terminal surface colour (new). Drives both the `.termwrap`
  container (`--term-surface`) **and** xterm's `theme.background`
  (`webview/xterm-theme.ts → buildXtermTheme`).

Because both vars are assigned from the same `surfaceColor` field in the same
effect, the surfaces can never disagree.

### Migration (existing users keep their colour)

`restoreSettings` (`src/settings.ts`) gained `surfaceColorFrom(raw)`:

1. A valid `surfaceColor` (`#rrggbb`) wins.
2. Else a valid **legacy `codeBg`** is carried over — so an existing user with a
   custom round-1 code-block colour keeps it as the shared colour (no reset to
   default).
3. Else the default `#0a0b0e`.

An invalid `surfaceColor` also falls back to the legacy `codeBg` before the
default. The settings-blob version is unchanged (still `1`); the migration is
purely key-level inside the merge, so old blobs load transparently. Covered by
`test/unit/settings.test.ts` ("migrates the legacy codeBg key…").

## Terminal-opacity decision

The **requirement is the shared colour, not shared opacity.** The code block keeps
its own opacity (`codeOpacity` / `--code-alpha`). The terminal keeps the **panel's
`--surface-alpha`** (its pre-existing behaviour) rather than adopting the
code-block opacity:

- A terminal painted at an arbitrary low code-block opacity over the animated
  backdrop becomes noisy and hard to read; the panel surface-alpha is already
  tuned for legibility and consistency with the other panels.
- So: terminal and code block share the **colour**; the terminal's translucency
  continues to follow `--surface-alpha`. When `data-background="none"` the
  terminal is fully opaque (alpha forced to 1), exactly as before.

This is applied in `buildXtermTheme` via the extracted pure helper
`terminalBackground(surfaceColor, alpha)` and in CSS via
`--term-surface = color-mix(--term-bg, transparent by --surface-alpha)`.

## How the terminal background actually gets the colour

- **xterm canvas:** `buildXtermTheme(surfaceColor?)` sets
  `theme.background = terminalBackground(termBg, alpha)` where `termBg` is the
  passed `surfaceColor` (live) or the `--term-bg` CSS var (fallback).
- **Live updates for existing terminals:** `terminal-pane.tsx` has a re-theme
  effect (already used for theme/font changes) that now also depends on
  `settings.surfaceColor`; on change it reassigns
  `term.options.theme = buildXtermTheme(settings.surfaceColor)` on the **live**
  Terminal (xterm requires reassigning `options.theme`, not mutating it). So
  existing terminals recolour in place — not only new ones. The creation effect
  reads the already-applied `--term-bg` var for the initial theme, so it needn't
  depend on `surfaceColor` (avoids tearing the terminal down on every colour
  change).
- **Container:** `.termwrap` uses `--term-bg` / `--term-surface` so the box flush
  behind xterm matches the canvas.

## What was drivable in preview (HTTP, fake shell)

Served `out/index.html` over HTTP on `127.0.0.1` and drove it with playwright-cli.
The fake shell has no `window.agentDeck`/PTY, so xterm doesn't fully mount, but:

- Opened Settings → Appearance → **"Code & terminal background"** and changed the
  colour to `#aa3322`.
- Measured live: `--code-bg` **and** `--term-bg` both became `#aa3322` together
  (before: both `#0a0b0e`). The single control drove both vars.
- `.termwrap` computed background became `srgb 0.667 0.2 0.133 / 0.7` =
  `#aa3322` at surface-alpha 0.7 — the terminal **container** recoloured live.
- The xterm **canvas** `theme.background` path is verified by the unit test on
  `terminalBackground` (`#aa3322` + 0.7 → `rgba(170,51,34,0.7)`) and by the
  `terminal-pane.tsx` re-theme code path. **Live xterm-canvas recolour needs the
  real Electron app to confirm visually** (a PTY-backed terminal).

## Acceptance

- [x] One setting ("Code & terminal background", `surfaceColor`) drives both the
      code-block and terminal background colour; they always match.
- [x] Setting lives in Settings → Appearance → **Editor & code**.
- [x] Migration: existing `codeBg` value carried into `surfaceColor`; defaults
      reproduce the prior look byte-for-byte (`#0a0b0e`, opacity 1).
- [x] Terminal opacity decision documented (keeps panel `--surface-alpha`; code
      block keeps `codeOpacity`).
- [x] xterm theme updates live for existing terminals on colour change.
- [x] Unit tests: migration + the pure colour→background mapping.
- [x] `npm run verify` and `npm run build` both exit 0.
- [x] Preview proof: code-block + terminal-container vars recolour live together;
      xterm canvas wiring verified by code path + unit test.
