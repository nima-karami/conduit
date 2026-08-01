// Registries for the Appearance settings pickers. The actual CSS values live in
// styles.css under [data-theme=...] / [data-font-ui=...] / [data-font-mono=...]
// selectors; here we only declare the ids, labels, and preview swatches.

import type { AppSettings } from '../src/settings';
import { THEME_DEFAULTS } from '../src/settings';

export interface ThemeDef {
  id: string;
  label: string;
  /** Swatches shown in the picker: [bg, panel, accent]. */
  swatch: [string, string, string];
  /** Corner treatment for the picker miniature; mirrors --r-* in styles.css. */
  shape: 'round' | 'sharp';
  /** Applied on theme switch unless the user has pinned that axis. */
  fontUi: string;
  fontMono: string;
}

export const THEMES: ThemeDef[] = [
  {
    id: 'aero',
    label: 'Aero',
    swatch: ['#eceff4', '#ffffff', '#4a56c8'],
    shape: 'round',
    fontUi: 'figtree',
    fontMono: 'plexmono',
  },
  {
    id: 'aero-dark',
    label: 'Aero Dark',
    swatch: ['#131419', '#1b1d24', '#8b95f0'],
    shape: 'round',
    fontUi: 'figtree',
    fontMono: 'plexmono',
  },
  {
    id: 'neon',
    label: 'Neon',
    swatch: ['#07060d', '#0a0812', '#00f0ff'],
    shape: 'sharp',
    fontUi: 'chakra',
    fontMono: 'jetbrains',
  },
];

export interface FontDef {
  id: string;
  label: string;
  stack: string;
}

export const UI_FONTS: FontDef[] = [
  { id: 'hanken', label: 'Hanken Grotesk', stack: "'Hanken Grotesk', system-ui, sans-serif" },
  { id: 'inter', label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
  { id: 'plexsans', label: 'IBM Plex Sans', stack: "'IBM Plex Sans', system-ui, sans-serif" },
  { id: 'system', label: 'System UI', stack: 'system-ui, -apple-system, sans-serif' },
  { id: 'figtree', label: 'Figtree', stack: "'Figtree', system-ui, sans-serif" },
  { id: 'chakra', label: 'Chakra Petch', stack: "'Chakra Petch', system-ui, sans-serif" },
];

export const MONO_FONTS: FontDef[] = [
  { id: 'jetbrains', label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  { id: 'firacode', label: 'Fira Code', stack: "'Fira Code', ui-monospace, monospace" },
  { id: 'plexmono', label: 'IBM Plex Mono', stack: "'IBM Plex Mono', ui-monospace, monospace" },
];

/**
 * The four theme-seeded axes: UI font, mono font, code surface and icon pack. Switching
 * theme applies that theme's values, but a value the user picked explicitly wins and
 * sticks. Without the pinned flags this is lossy in one direction or the other:
 * always-write destroys a chosen font on the next theme switch, never-write leaves Neon
 * in Hanken Grotesk with Aero's coloured file icons for every existing user (token
 * contract, "themes and fonts are coupled, and the picker still wins"; blockers Q1).
 *
 * Pure so the rule is testable without a DOM: takes the current settings and the patch a
 * control produced, and returns the patch to actually apply.
 */
export function coupleThemeDefaults(
  prev: AppSettings,
  patch: Partial<AppSettings>,
): Partial<AppSettings> {
  // Setting a value pins its axis — unless the patch names the flag itself, which is how
  // "reset to theme" hands back an axis (a new value AND pinned: false in one patch).
  const out = { ...patch };
  const pins = [
    ['fontUi', 'fontUiPinned'],
    ['fontMono', 'fontMonoPinned'],
    ['surfaceColor', 'surfaceColorPinned'],
    ['iconPack', 'iconPackPinned'],
  ] as const;
  for (const [axis, flag] of pins) {
    if (patch[axis] !== undefined && patch[flag] === undefined) out[flag] = true;
  }
  if (patch.theme !== undefined) {
    const theme = THEMES.find((t) => t.id === patch.theme);
    const defaults = THEME_DEFAULTS[patch.theme];
    if (theme && defaults) {
      if (!(out.fontUiPinned ?? prev.fontUiPinned)) out.fontUi = theme.fontUi;
      if (!(out.fontMonoPinned ?? prev.fontMonoPinned)) out.fontMono = theme.fontMono;
      if (!(out.surfaceColorPinned ?? prev.surfaceColorPinned)) {
        out.surfaceColor = defaults.surfaceColor;
      }
      if (!(out.iconPackPinned ?? prev.iconPackPinned)) out.iconPack = defaults.iconPack;
    }
  }
  return out;
}
