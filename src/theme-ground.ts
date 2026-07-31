/**
 * A theme's window ground (`--bg`), as an opaque hex the main process can hand to
 * Electron's `backgroundColor` — the colour Chromium paints before the renderer's first
 * frame. It has to be duplicated out of styles.css because it is needed at window-create
 * time, before any stylesheet exists; the theme-token test keeps the two in step.
 */
const GROUND: Record<string, string> = {
  aero: '#eceff4',
  'aero-dark': '#131419',
  neon: '#07060d',
};

/**
 * The ground for a stored theme id. A missing, corrupt or unrecognised value falls back to
 * Aero Dark, which is `:root` in styles.css and so the theme the renderer will land on too.
 */
export function groundForTheme(theme: string | undefined): string {
  return (theme && GROUND[theme]) || GROUND['aero-dark'];
}
