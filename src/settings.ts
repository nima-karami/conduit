const VERSION = 1;

export type Density = 'comfortable' | 'compact';
export type Background = 'none' | 'aurora' | 'mesh' | 'grid';

/** User-facing application settings, persisted to settings.json in userData. */
export interface AppSettings {
  theme: string;       // theme id (see webview/themes.ts)
  fontUi: string;      // ui font id
  fontMono: string;    // mono font id
  density: Density;
  background: Background;
  leftWidth: number;   // sidebar width, px
  rightWidth: number;  // right panel width, px
  // session card fields (what each card shows)
  cardAgent: boolean;
  cardTime: boolean;
  cardStatusText: boolean;
  cardPath: boolean;
  cardWorktree: boolean;
  // behaviour
  defaultAgentId: string;       // '' = ask each time
  restoreSessions: boolean;
  autoSwitchSession: boolean;
  confirmCloseRunning: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'midnight',
  fontUi: 'hanken',
  fontMono: 'jetbrains',
  density: 'comfortable',
  background: 'aurora',
  leftWidth: 264,
  rightWidth: 340,
  cardAgent: true,
  cardTime: true,
  cardStatusText: false,
  cardPath: false,
  cardWorktree: true,
  defaultAgentId: '',
  restoreSessions: true,
  autoSwitchSession: true,
  confirmCloseRunning: true,
  reduceMotion: false,
};

const DENSITIES: Density[] = ['comfortable', 'compact'];
const BACKGROUNDS: Background[] = ['none', 'aurora', 'mesh', 'grid'];

const clampWidth = (n: unknown, def: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(640, Math.max(180, Math.round(n))) : def;

const str = (v: unknown, def: string): string => (typeof v === 'string' && v ? v : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const strOr = (v: unknown, def: string): string => (typeof v === 'string' ? v : def); // allows ''
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
    background: oneOf(raw.background, BACKGROUNDS, DEFAULT_SETTINGS.background),
    leftWidth: clampWidth(raw.leftWidth, DEFAULT_SETTINGS.leftWidth),
    rightWidth: clampWidth(raw.rightWidth, DEFAULT_SETTINGS.rightWidth),
    cardAgent: bool(raw.cardAgent, DEFAULT_SETTINGS.cardAgent),
    cardTime: bool(raw.cardTime, DEFAULT_SETTINGS.cardTime),
    cardStatusText: bool(raw.cardStatusText, DEFAULT_SETTINGS.cardStatusText),
    cardPath: bool(raw.cardPath, DEFAULT_SETTINGS.cardPath),
    cardWorktree: bool(raw.cardWorktree, DEFAULT_SETTINGS.cardWorktree),
    defaultAgentId: strOr(raw.defaultAgentId, DEFAULT_SETTINGS.defaultAgentId),
    restoreSessions: bool(raw.restoreSessions, DEFAULT_SETTINGS.restoreSessions),
    autoSwitchSession: bool(raw.autoSwitchSession, DEFAULT_SETTINGS.autoSwitchSession),
    confirmCloseRunning: bool(raw.confirmCloseRunning, DEFAULT_SETTINGS.confirmCloseRunning),
    reduceMotion: bool(raw.reduceMotion, DEFAULT_SETTINGS.reduceMotion),
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
