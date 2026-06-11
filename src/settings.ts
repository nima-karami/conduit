import { DEFAULT_LAYOUT, parseLayout, serializeLayout } from './layout';

const VERSION = 1;

export type Density = 'comfortable' | 'compact';
export type CardField =
  | 'name'
  | 'agent'
  | 'folder'
  | 'path'
  | 'worktree'
  | 'time'
  | 'active'
  | 'status'
  | 'none';
export type Background = 'none' | 'aurora' | 'mesh' | 'grid' | 'flow' | 'shader' | 'custom';
export type BgIntensity = 'subtle' | 'balanced' | 'vivid';
export type SessionSort = 'manual' | 'name' | 'recent' | 'active' | 'status' | 'project';

/** User-facing application settings, persisted to settings.json in userData. */
export interface AppSettings {
  theme: string; // theme id (see webview/themes.ts)
  fontUi: string; // ui font id
  fontMono: string; // mono font id
  density: Density;
  background: Background;
  bgIntensity: BgIntensity;
  bgBlur: number; // backdrop-filter blur on surfaces, px (0 = crisp backdrop)
  surfaceOpacity: number; // panel/terminal opacity 0..1 (lower = more backdrop shows)
  codeBg: string; // code-block background base colour (#rrggbb), independent of panel
  codeOpacity: number; // code-block background opacity 0..1 (lower = more shows through)
  customShader: string; // GLSL fragment source for the 'custom' background
  leftWidth: number; // sessions panel width, px
  rightWidth: number; // explorer panel width, px
  layout: string; // comma-joined region order (see src/layout.ts)
  sidebarCollapsed: boolean; // Sessions panel hidden (center reflows wider)
  explorerCollapsed: boolean; // Explorer panel hidden (center reflows wider)
  // session card roles (which field shows as title / subtitle / detail)
  cardTitle: CardField;
  cardSubtitle: CardField;
  cardDetail: CardField;
  // sessions pane
  sessionSort: SessionSort;
  sessionGroupByProject: boolean;
  // behaviour
  shortcuts: Record<string, string>; // actionId -> combo override (defaults used when absent)
  defaultAgentId: string; // '' = ask each time
  restoreSessions: boolean;
  autoSwitchSession: boolean;
  confirmCloseRunning: boolean;
  reduceMotion: boolean;
  wordWrap: boolean; // soft-wrap long lines in the code editor (Alt+Z toggles)
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'midnight',
  fontUi: 'hanken',
  fontMono: 'jetbrains',
  density: 'comfortable',
  background: 'aurora',
  bgIntensity: 'balanced',
  bgBlur: 6,
  surfaceOpacity: 0.7,
  codeBg: '#0a0b0e',
  codeOpacity: 1,
  customShader: '',
  leftWidth: 264,
  rightWidth: 340,
  layout: DEFAULT_LAYOUT,
  sidebarCollapsed: false,
  explorerCollapsed: false,
  cardTitle: 'name',
  cardSubtitle: 'agent',
  cardDetail: 'time',
  sessionSort: 'manual',
  sessionGroupByProject: true,
  shortcuts: {},
  defaultAgentId: '',
  restoreSessions: true,
  autoSwitchSession: true,
  confirmCloseRunning: true,
  reduceMotion: false,
  wordWrap: false,
};

const DENSITIES: Density[] = ['comfortable', 'compact'];
const CARD_FIELDS: CardField[] = [
  'name',
  'agent',
  'folder',
  'path',
  'worktree',
  'time',
  'active',
  'status',
  'none',
];
const BACKGROUNDS: Background[] = ['none', 'aurora', 'mesh', 'grid', 'flow', 'shader', 'custom'];
const INTENSITIES: BgIntensity[] = ['subtle', 'balanced', 'vivid'];
const SESSION_SORTS: SessionSort[] = ['manual', 'name', 'recent', 'active', 'status', 'project'];

const clampWidth = (n: unknown, def: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(640, Math.max(180, Math.round(n))) : def;

const clampNum = (n: unknown, min: number, max: number, def: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;

/** Validate a `#rrggbb` hex colour (case-insensitive); otherwise return `def`. */
const hexColor = (v: unknown, def: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : def;

const str = (v: unknown, def: string): string => (typeof v === 'string' && v ? v : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const strOr = (v: unknown, def: string): string => (typeof v === 'string' ? v : def); // allows ''
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
  }
  return out;
};
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
    bgIntensity: oneOf(raw.bgIntensity, INTENSITIES, DEFAULT_SETTINGS.bgIntensity),
    bgBlur: clampNum(raw.bgBlur, 0, 24, DEFAULT_SETTINGS.bgBlur),
    surfaceOpacity: clampNum(raw.surfaceOpacity, 0, 1, DEFAULT_SETTINGS.surfaceOpacity),
    codeBg: hexColor(raw.codeBg, DEFAULT_SETTINGS.codeBg),
    codeOpacity: clampNum(raw.codeOpacity, 0, 1, DEFAULT_SETTINGS.codeOpacity),
    customShader: strOr(raw.customShader, DEFAULT_SETTINGS.customShader),
    leftWidth: clampWidth(raw.leftWidth, DEFAULT_SETTINGS.leftWidth),
    rightWidth: clampWidth(raw.rightWidth, DEFAULT_SETTINGS.rightWidth),
    layout: serializeLayout(parseLayout(strOr(raw.layout, DEFAULT_SETTINGS.layout))),
    sidebarCollapsed: bool(raw.sidebarCollapsed, DEFAULT_SETTINGS.sidebarCollapsed),
    explorerCollapsed: bool(raw.explorerCollapsed, DEFAULT_SETTINGS.explorerCollapsed),
    cardTitle: oneOf(raw.cardTitle, CARD_FIELDS, DEFAULT_SETTINGS.cardTitle),
    cardSubtitle: oneOf(raw.cardSubtitle, CARD_FIELDS, DEFAULT_SETTINGS.cardSubtitle),
    cardDetail: oneOf(raw.cardDetail, CARD_FIELDS, DEFAULT_SETTINGS.cardDetail),
    sessionSort: oneOf(raw.sessionSort, SESSION_SORTS, DEFAULT_SETTINGS.sessionSort),
    sessionGroupByProject: bool(raw.sessionGroupByProject, DEFAULT_SETTINGS.sessionGroupByProject),
    shortcuts: strMap(raw.shortcuts),
    defaultAgentId: strOr(raw.defaultAgentId, DEFAULT_SETTINGS.defaultAgentId),
    restoreSessions: bool(raw.restoreSessions, DEFAULT_SETTINGS.restoreSessions),
    autoSwitchSession: bool(raw.autoSwitchSession, DEFAULT_SETTINGS.autoSwitchSession),
    confirmCloseRunning: bool(raw.confirmCloseRunning, DEFAULT_SETTINGS.confirmCloseRunning),
    reduceMotion: bool(raw.reduceMotion, DEFAULT_SETTINGS.reduceMotion),
    wordWrap: bool(raw.wordWrap, DEFAULT_SETTINGS.wordWrap),
  };
}

function parse(blob: string | undefined): Partial<AppSettings> {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    if (
      parsed &&
      parsed.version === VERSION &&
      parsed.settings &&
      typeof parsed.settings === 'object'
    ) {
      return parsed.settings as Partial<AppSettings>;
    }
  } catch {
    /* missing or malformed */
  }
  return {};
}
