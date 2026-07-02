import { DEFAULT_LAYOUT, parseLayout, serializeLayout } from './layout';
import type { LogLevel } from './logging';

const VERSION = 1;

export type Density = 'comfortable' | 'compact';
export type FontSize = 'small' | 'medium' | 'large' | 'xlarge';

/**
 * Interface font-size scale steps → multiplier applied to the density-derived base
 * font size (composes with density rather than replacing it). Discrete steps are
 * used over a freeform slider for predictability. `medium` (1.0) is the default and
 * is a no-op, so existing/migrated users see no change. Drives the `--font-scale`
 * root CSS var. Scope (v1): interface text only — Monaco reads its own fontSize
 * option and is intentionally left at its own sizing (see code-viewer); this
 * control does not resize the code editor.
 */
export const FONT_SIZE_SCALE: Record<FontSize, number> = {
  small: 0.9,
  medium: 1,
  large: 1.12,
  xlarge: 1.25,
};
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
export type Background = 'none' | 'aurora' | 'mesh' | 'grid' | 'flow' | 'shader';
export type BgIntensity = 'subtle' | 'balanced' | 'vivid';
export type SessionSort = 'manual' | 'name' | 'recent' | 'active' | 'status' | 'project';
/** Active top-level tab of the right (explorer) pane. */
export type RightPaneTab = 'changes' | 'files';

/** User-facing application settings, persisted to settings.json in userData. */
/** Explorer file-icon style: no icons, monochrome line icons, or per-type coloured icons. */
export type IconPack = 'none' | 'minimal' | 'colored';

export interface AppSettings {
  theme: string; // theme id (see webview/themes.ts)
  fontUi: string; // ui font id
  fontMono: string; // mono font id
  density: Density;
  fontSize: FontSize; // interface font-size scale step (composes with density)
  background: Background;
  bgIntensity: BgIntensity;
  bgBlur: number; // backdrop-filter blur on surfaces, px (0 = crisp backdrop)
  surfaceOpacity: number; // panel/terminal opacity 0..1 (lower = more backdrop shows)
  // Shared surface colour (#rrggbb) driving BOTH the code-block background and the
  // xterm terminal background, so the two surfaces always match (wishlist I1).
  // Migrated from the legacy `codeBg` key (round-1 C3).
  surfaceColor: string;
  codeOpacity: number; // code-block background opacity 0..1 (lower = more shows through)
  customShader: string; // GLSL fragment source for the 'shader' background (empty = built-in plasma)
  leftWidth: number; // sessions panel width, px
  rightWidth: number; // explorer panel width, px
  // History tab's commit-detail pane height, px. Persisted so a dragged size survives the
  // tab closing/reopening and restart; the runtime clamp (clampDetailH) enforces the true
  // per-render upper bound. See docs/specs/2026-06-29-commit-detail-resize-persistence.md.
  historyDetailHeight: number;
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
  collapsedProjects: string[];
  // behaviour
  shortcuts: Record<string, string>; // actionId -> combo override (defaults used when absent)
  defaultAgentId: string; // '' = ask each time
  restoreSessions: boolean;
  autoSwitchSession: boolean;
  confirmCloseRunning: boolean;
  reduceMotion: boolean;
  wordWrap: boolean; // soft-wrap long lines in the code editor (Alt+Z toggles)
  iconPack: IconPack; // explorer file-type icon style (none | minimal | colored)
  diffSideBySide: boolean; // render diff viewer side-by-side vs inline
  // Last-active right-pane tab, remembered globally so a relaunch reopens it. Default 'files'.
  rightPaneTab: RightPaneTab;
  // Review tab's file-navigator sub-column open/closed. Default OFF — the navigator is additive
  // and defaulting it open would change the current single-column Review layout unprompted (spec
  // 2026-07-02-review-changes-first-class §"UI — the file navigator").
  reviewFileListOpen: boolean;
  // Per-surface content font sizes (px), zoomed via Ctrl/Cmd +/-/0. Distinct from
  // `fontSize` (the interface chrome scale): these size the terminal (xterm) and code
  // editor (Monaco) CONTENT directly. Clamped 8..32; 13 is the default for both.
  terminalFontSize: number;
  editorFontSize: number;
  // Behaviour: raise OS-level attention (taskbar flash + system notification) when
  // a backgrounded session finishes while the window is not focused. Default ON.
  osAttention: boolean;
  // Behaviour: automatically relaunch sessions that were still running when the
  // app was last closed ("stale" after restore). Default OFF — re-running an
  // arbitrary command on startup can be destructive, so this must be opt-in.
  autoRelaunchStale: boolean;
  // Behaviour: track the terminal's live working directory (via OSC escape sequences)
  // and re-root the Files + Changes views to it. Default ON.
  trackCwd: boolean;
  // Behaviour: show the git branch/worktree indicator at the top of a terminal tab.
  // Default ON; a durable per-user preference (power users may want quieter chrome).
  showGitIndicator: boolean;
  // Behaviour: detect sub-repos under the opened folder and show a repo picker that scopes the
  // git surfaces to one active repo. Default ON (self-hides for single-repo projects). See
  // docs/specs/archive/2026-06-25-multi-repo-awareness.md.
  multiRepoPicker: boolean;
  // Behaviour: persist each terminal session's recent output (bounded ring) and replay
  // it into xterm on reopen/relaunch so prior history survives a restart. Default ON —
  // replaying past output is non-destructive (no process runs), unlike autoRelaunchStale.
  scrollbackPersistence: boolean;
  // Diagnostics: write a leveled, file-backed log to userData/logs (rotating). Default ON —
  // a modest always-on trail is what makes a first bug report useful. `off` (via logLevel)
  // silences the file sink entirely; this toggle is the user-facing master switch.
  logging: boolean;
  // Diagnostics verbosity. `off` silences everything; `info` (default) excludes the chatty
  // debug/trace. The host logger reads this live (no restart).
  logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'midnight',
  fontUi: 'hanken',
  fontMono: 'jetbrains',
  density: 'comfortable',
  fontSize: 'medium',
  background: 'aurora',
  bgIntensity: 'balanced',
  bgBlur: 6,
  surfaceOpacity: 0.7,
  surfaceColor: '#0a0b0e',
  codeOpacity: 1,
  customShader: '',
  leftWidth: 264,
  rightWidth: 340,
  historyDetailHeight: 300,
  layout: DEFAULT_LAYOUT,
  sidebarCollapsed: false,
  explorerCollapsed: false,
  cardTitle: 'name',
  cardSubtitle: 'agent',
  cardDetail: 'time',
  sessionSort: 'manual',
  sessionGroupByProject: true,
  collapsedProjects: [],
  shortcuts: {},
  defaultAgentId: '',
  restoreSessions: true,
  autoSwitchSession: true,
  confirmCloseRunning: true,
  reduceMotion: false,
  wordWrap: false,
  iconPack: 'minimal',
  diffSideBySide: true,
  rightPaneTab: 'files',
  reviewFileListOpen: false,
  terminalFontSize: 13,
  editorFontSize: 13,
  osAttention: true,
  autoRelaunchStale: false,
  trackCwd: true,
  showGitIndicator: true,
  multiRepoPicker: true,
  scrollbackPersistence: true,
  logging: true,
  logLevel: 'info',
};

const LOG_LEVELS: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace'];

const DENSITIES: Density[] = ['comfortable', 'compact'];
const FONT_SIZES: FontSize[] = ['small', 'medium', 'large', 'xlarge'];
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
const BACKGROUNDS: Background[] = ['none', 'aurora', 'mesh', 'grid', 'flow', 'shader'];

/**
 * Resolve the backdrop kind, migrating the legacy `'custom'` value (R4.9). The old
 * picker had a separate 'custom' option carrying a user GLSL source; 'shader' now IS
 * that custom-shader entry, so any persisted `background: 'custom'` maps to `'shader'`
 * (the source itself lives in `customShader` and is unchanged). Other values pass
 * through `oneOf` whitelisting; unknown values fall back to the default.
 */
function backgroundFrom(v: unknown): Background {
  if (v === 'custom') return 'shader';
  return oneOf(v, BACKGROUNDS, DEFAULT_SETTINGS.background);
}
const INTENSITIES: BgIntensity[] = ['subtle', 'balanced', 'vivid'];
const SESSION_SORTS: SessionSort[] = ['manual', 'name', 'recent', 'active', 'status', 'project'];
const ICON_PACKS: IconPack[] = ['none', 'minimal', 'colored'];
const RIGHT_PANE_TABS: RightPaneTab[] = ['changes', 'files'];

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
const strArr = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};
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

/**
 * Resolve the shared surface colour, migrating the legacy round-1 `codeBg` key.
 * Precedence: a valid `surfaceColor` wins; otherwise a valid legacy `codeBg` is
 * carried over (so existing users keep their custom code-block colour); otherwise
 * the default. Both are validated as `#rrggbb`.
 */
function surfaceColorFrom(raw: Record<string, unknown>): string {
  const legacy = raw.codeBg;
  if (typeof raw.surfaceColor === 'string') {
    return hexColor(raw.surfaceColor, hexColor(legacy, DEFAULT_SETTINGS.surfaceColor));
  }
  return hexColor(legacy, DEFAULT_SETTINGS.surfaceColor);
}

export function serializeSettings(s: AppSettings): string {
  return JSON.stringify({ version: VERSION, settings: s });
}

/**
 * Validate and coerce a raw (untrusted) settings payload from the renderer into
 * a fully-typed AppSettings. Unknown keys are dropped, wrong-typed values fall
 * back to DEFAULT_SETTINGS, numeric ranges are clamped, and enum-ish strings are
 * whitelisted. The legacy `codeBg` migration runs so existing persisted payloads
 * still carry their colour forward.
 *
 * Pure function — suitable for unit testing without any I/O.
 */
export function coerceSettings(payload: Record<string, unknown>): AppSettings {
  return {
    theme: str(payload.theme, DEFAULT_SETTINGS.theme),
    fontUi: str(payload.fontUi, DEFAULT_SETTINGS.fontUi),
    fontMono: str(payload.fontMono, DEFAULT_SETTINGS.fontMono),
    density: oneOf(payload.density, DENSITIES, DEFAULT_SETTINGS.density),
    fontSize: oneOf(payload.fontSize, FONT_SIZES, DEFAULT_SETTINGS.fontSize),
    background: backgroundFrom(payload.background),
    bgIntensity: oneOf(payload.bgIntensity, INTENSITIES, DEFAULT_SETTINGS.bgIntensity),
    bgBlur: clampNum(payload.bgBlur, 0, 24, DEFAULT_SETTINGS.bgBlur),
    surfaceOpacity: clampNum(payload.surfaceOpacity, 0, 1, DEFAULT_SETTINGS.surfaceOpacity),
    surfaceColor: surfaceColorFrom(payload),
    codeOpacity: clampNum(payload.codeOpacity, 0, 1, DEFAULT_SETTINGS.codeOpacity),
    customShader: strOr(payload.customShader, DEFAULT_SETTINGS.customShader),
    leftWidth: clampWidth(payload.leftWidth, DEFAULT_SETTINGS.leftWidth),
    rightWidth: clampWidth(payload.rightWidth, DEFAULT_SETTINGS.rightWidth),
    // min = DETAIL_MIN_H (140); ceiling = generous static sanity guard (real upper bound is
    // enforced at render by clampDetailH). See spec §3.
    historyDetailHeight: clampNum(
      payload.historyDetailHeight,
      140,
      2000,
      DEFAULT_SETTINGS.historyDetailHeight,
    ),
    layout: serializeLayout(parseLayout(strOr(payload.layout, DEFAULT_SETTINGS.layout))),
    sidebarCollapsed: bool(payload.sidebarCollapsed, DEFAULT_SETTINGS.sidebarCollapsed),
    explorerCollapsed: bool(payload.explorerCollapsed, DEFAULT_SETTINGS.explorerCollapsed),
    cardTitle: oneOf(payload.cardTitle, CARD_FIELDS, DEFAULT_SETTINGS.cardTitle),
    cardSubtitle: oneOf(payload.cardSubtitle, CARD_FIELDS, DEFAULT_SETTINGS.cardSubtitle),
    cardDetail: oneOf(payload.cardDetail, CARD_FIELDS, DEFAULT_SETTINGS.cardDetail),
    sessionSort: oneOf(payload.sessionSort, SESSION_SORTS, DEFAULT_SETTINGS.sessionSort),
    sessionGroupByProject: bool(
      payload.sessionGroupByProject,
      DEFAULT_SETTINGS.sessionGroupByProject,
    ),
    collapsedProjects: strArr(payload.collapsedProjects),
    shortcuts: strMap(payload.shortcuts),
    defaultAgentId: strOr(payload.defaultAgentId, DEFAULT_SETTINGS.defaultAgentId),
    restoreSessions: bool(payload.restoreSessions, DEFAULT_SETTINGS.restoreSessions),
    autoSwitchSession: bool(payload.autoSwitchSession, DEFAULT_SETTINGS.autoSwitchSession),
    confirmCloseRunning: bool(payload.confirmCloseRunning, DEFAULT_SETTINGS.confirmCloseRunning),
    reduceMotion: bool(payload.reduceMotion, DEFAULT_SETTINGS.reduceMotion),
    wordWrap: bool(payload.wordWrap, DEFAULT_SETTINGS.wordWrap),
    iconPack: oneOf(payload.iconPack, ICON_PACKS, DEFAULT_SETTINGS.iconPack),
    diffSideBySide: bool(payload.diffSideBySide, DEFAULT_SETTINGS.diffSideBySide),
    rightPaneTab: oneOf(payload.rightPaneTab, RIGHT_PANE_TABS, DEFAULT_SETTINGS.rightPaneTab),
    reviewFileListOpen: bool(payload.reviewFileListOpen, DEFAULT_SETTINGS.reviewFileListOpen),
    terminalFontSize: clampNum(payload.terminalFontSize, 8, 32, DEFAULT_SETTINGS.terminalFontSize),
    editorFontSize: clampNum(payload.editorFontSize, 8, 32, DEFAULT_SETTINGS.editorFontSize),
    osAttention: bool(payload.osAttention, DEFAULT_SETTINGS.osAttention),
    autoRelaunchStale: bool(payload.autoRelaunchStale, DEFAULT_SETTINGS.autoRelaunchStale),
    trackCwd: bool(payload.trackCwd, DEFAULT_SETTINGS.trackCwd),
    showGitIndicator: bool(payload.showGitIndicator, DEFAULT_SETTINGS.showGitIndicator),
    multiRepoPicker: bool(payload.multiRepoPicker, DEFAULT_SETTINGS.multiRepoPicker),
    scrollbackPersistence: bool(
      payload.scrollbackPersistence,
      DEFAULT_SETTINGS.scrollbackPersistence,
    ),
    logging: bool(payload.logging, DEFAULT_SETTINGS.logging),
    logLevel: oneOf(payload.logLevel, LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
  };
}

/**
 * Restore settings from a blob, merging onto DEFAULT_SETTINGS so missing or
 * malformed fields fall back to defaults and unknown keys are dropped.
 */
export function restoreSettings(blob: string | undefined): AppSettings {
  return coerceSettings(parse(blob));
}

function parse(blob: string | undefined): Record<string, unknown> {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    if (
      parsed &&
      parsed.version === VERSION &&
      parsed.settings &&
      typeof parsed.settings === 'object'
    ) {
      return parsed.settings as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed */
  }
  return {};
}
