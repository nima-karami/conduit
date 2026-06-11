// Registries for the Appearance settings pickers. The actual CSS values live in
// styles.css under [data-theme=...] / [data-font-ui=...] / [data-font-mono=...]
// selectors; here we only declare the ids, labels, and preview swatches.

export interface ThemeDef {
  id: string;
  label: string;
  /** Swatches shown in the picker: [bg, panel, accent]. */
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: 'midnight', label: 'Midnight', swatch: ['#0c0d10', '#14171c', '#d9775c'] },
  { id: 'slate', label: 'Slate', swatch: ['#0e1116', '#171c24', '#5e9bd6'] },
  { id: 'nord', label: 'Nord', swatch: ['#2e3440', '#3b4252', '#88c0d0'] },
  { id: 'forest', label: 'Forest', swatch: ['#0d1310', '#15201a', '#6cc18a'] },
  { id: 'paper', label: 'Paper (light)', swatch: ['#f4f1ea', '#ffffff', '#c2603f'] },
  { id: 'contrast', label: 'High contrast', swatch: ['#000000', '#0a0a0a', '#ffb000'] },
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
];

export const MONO_FONTS: FontDef[] = [
  { id: 'jetbrains', label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  { id: 'firacode', label: 'Fira Code', stack: "'Fira Code', ui-monospace, monospace" },
  { id: 'plexmono', label: 'IBM Plex Mono', stack: "'IBM Plex Mono', ui-monospace, monospace" },
];

const _isKnownTheme = (id: string) => THEMES.some((t) => t.id === id);
