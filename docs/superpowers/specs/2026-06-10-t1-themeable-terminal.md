# T1 — Themeable terminal

## Problem
`TerminalPane` hardcodes the xterm `THEME` object and `fontFamily: 'JetBrains
Mono'`. Changing the app theme or mono font does nothing to the terminal — the
centerpiece ignores theming.

## Fix
- Derive the xterm theme from the active CSS theme variables (read from
  `documentElement` via getComputedStyle): background `--bg`, foreground `--text`,
  cursor `--accent`, selection `--accent-soft`, ANSI from `--red/--green/--amber/
  --blue/--violet/--accent` (+ sensible fallbacks for cyan/white/black).
- Derive the font from `settings.fontMono` (resolve the stack via MONO_FONTS).
- On theme/font change, update **existing** terminal instances live
  (`term.options.theme = ...; term.options.fontFamily = ...`) and refit (font
  metrics change). Read CSS vars inside a `requestAnimationFrame` so the
  `data-theme` attribute (set by SettingsProvider) is applied first.

## Implementation
- `webview/xtermTheme.ts`: `buildXtermTheme(): ITheme` (reads CSS vars) and
  `monoStack(id): string` (from MONO_FONTS).
- `TerminalPane`: `useSettings()`; create terminal with built theme + mono stack;
  a `useEffect([settings.theme, settings.fontMono])` that rAF-updates `term.options`
  + refits the visible terminal.

## Acceptance criteria
1. Switching theme recolours the terminal (bg/fg/cursor/selection) live.
2. Switching mono font changes the terminal font live (and stays aligned/box chars connect).
3. New terminals open already themed.
4. typecheck + build green.
