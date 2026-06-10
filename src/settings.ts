const VERSION = 1;

export type Density = 'comfortable' | 'compact';
export type SessionCard = 'comfortable' | 'compact' | 'detailed';
export type Background = 'none' | 'aurora' | 'mesh' | 'grid';

/** User-facing application settings, persisted to settings.json in userData. */
export interface AppSettings {
  theme: string;       // theme id (see webview/themes.ts)
  fontUi: string;      // ui font id
  fontMono: string;    // mono font id
  density: Density;
  sessionCard: SessionCard;
  background: Background;
  leftWidth: number;   // sidebar width, px
  rightWidth: number;  // right panel width, px
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'midnight',
  fontUi: 'hanken',
  fontMono: 'jetbrains',
  density: 'comfortable',
  sessionCard: 'comfortable',
  background: 'aurora',
  leftWidth: 264,
  rightWidth: 340,
};

const DENSITIES: Density[] = ['comfortable', 'compact'];
const CARDS: SessionCard[] = ['comfortable', 'compact', 'detailed'];
const BACKGROUNDS: Background[] = ['none', 'aurora', 'mesh', 'grid'];

const clampWidth = (n: unknown, def: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(640, Math.max(180, Math.round(n))) : def;

const str = (v: unknown, def: string): string => (typeof v === 'string' && v ? v : def);
const oneOf = <T extends string>(v: unknown, allowed: T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def;

export function serializeSettings(s: AppSettings): string {
  return JSON.stringify({ version: VERSION, settings: s });
}

/**
 * Restore settings from a blob, merging onto DEFAULT_SETTINGS so missing or
 * malformed fields fall back to defaults and unknown keys are dropped.
 */
export function restoreSettings(blob: string | undefined): AppSettings {
  const raw = parse(blob);
  return {
    theme: str(raw.theme, DEFAULT_SETTINGS.theme),
    fontUi: str(raw.fontUi, DEFAULT_SETTINGS.fontUi),
    fontMono: str(raw.fontMono, DEFAULT_SETTINGS.fontMono),
    density: oneOf(raw.density, DENSITIES, DEFAULT_SETTINGS.density),
    sessionCard: oneOf(raw.sessionCard, CARDS, DEFAULT_SETTINGS.sessionCard),
    background: oneOf(raw.background, BACKGROUNDS, DEFAULT_SETTINGS.background),
    leftWidth: clampWidth(raw.leftWidth, DEFAULT_SETTINGS.leftWidth),
    rightWidth: clampWidth(raw.rightWidth, DEFAULT_SETTINGS.rightWidth),
  };
}

function parse(blob: string | undefined): Partial<AppSettings> {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    if (parsed && parsed.version === VERSION && parsed.settings && typeof parsed.settings === 'object') {
      return parsed.settings as Partial<AppSettings>;
    }
  } catch {
    /* missing or malformed */
  }
  return {};
}
