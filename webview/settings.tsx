import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { AppSettings } from '../src/settings';
import { DEFAULT_SETTINGS, FONT_SIZE_SCALE } from '../src/settings';
import { decideHydrate, jsonEqual, makeGate, onLocalEdit, onPostFired } from '../src/settings-sync';
import { initialSettings, post } from './bridge';
import { coupleThemeDefaults } from './themes';

interface SettingsCtx {
  settings: AppSettings;
  /** Update one or more fields; applies immediately and persists (debounced). */
  update: (patch: Partial<AppSettings>) => void;
  /** Replace settings wholesale (used when the host pushes the persisted set). */
  hydrate: (s: AppSettings) => void;
  /** Reset all settings to defaults (persisted). */
  resetAll: () => void;
  /** Reset only the layout (panel order + widths) to defaults (persisted). */
  resetLayout: () => void;
  /** Post an edit still inside the persist debounce now. */
  flushPending: () => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

/** What settings put on <html>: `data-*` attributes (camelCase dataset keys) and `--` vars. */
function domValues(s: AppSettings): Record<string, string> {
  return {
    theme: s.theme,
    fontUi: s.fontUi,
    fontMono: s.fontMono,
    density: s.density,
    // Interface text only — multiplier composed with the density-derived base font size
    // (see styles.css body font-size); Monaco keeps its own fontSize.
    '--font-scale': String(FONT_SIZE_SCALE[s.fontSize]),
    background: s.background,
    reduceMotion: String(s.reduceMotion),
    '--left-w': `${s.leftWidth}px`,
    '--right-w': `${s.rightWidth}px`,
    '--bg-blur': `${s.bgBlur}px`,
    '--surface-alpha': String(s.surfaceOpacity),
    // One shared surface drives BOTH code block and terminal (wishlist I1 + R4.3b) so
    // they always match; --code-alpha (codeOpacity) drives both surfaces' translucency
    // (terminal's --term-surface is color-mix(--term-bg, --code-alpha) in CSS).
    '--code-bg': s.surfaceColor,
    '--code-alpha': String(s.codeOpacity),
    '--term-bg': s.surfaceColor,
  };
}

/**
 * Write only the values that changed since the last apply. Other code writes some of these
 * live — a panel resize drag owns `--left-w`/`--right-w` until it commits on release — so
 * re-writing an unchanged value would snap that drag back to the persisted width.
 */
function applyToDom(next: Record<string, string>, prev: Record<string, string> | null) {
  const el = document.documentElement;
  for (const [key, value] of Object.entries(next)) {
    if (prev?.[key] === value) continue;
    if (key.startsWith('--')) el.style.setProperty(key, value);
    else el.dataset[key] = value;
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  // Boot on the persisted settings, not the defaults: the host's `state` message is a round-trip
  // away, and mounting on DEFAULT_SETTINGS meant a launch on any non-default theme painted Aero
  // Dark first and snapped over once `state` landed.
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gate guarding hydration against stale host echoes that race a pending local edit.
  // See src/settings-sync.ts for the decision logic + the bug it prevents (K1).
  const gate = useRef(makeGate());
  // The value we last posted, and the epoch at which we posted it, so an incoming
  // hydrate can be recognised as OUR change confirming (vs a stale broadcast).
  const posted = useRef<{ value: AppSettings | null; epoch: number }>({ value: null, epoch: -1 });
  // Live mirror of `settings` so the unload flush reads the latest without a stale
  // closure (the flush listener is registered once).
  const latest = useRef(settings);
  latest.current = settings;

  // Layout, not passive: a passive effect runs AFTER the browser paints, so the first frame of
  // every launch showed the stylesheet's bare `:root` (Aero Dark) whatever the settings said.
  const applied = useRef<Record<string, string> | null>(null);
  useLayoutEffect(() => {
    const next = domValues(settings);
    applyToDom(next, applied.current);
    applied.current = next;
  }, [settings]);

  // Flush the pending debounced persist synchronously. Returns true if it posted.
  const flush = useCallback((): boolean => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!gate.current.dirty) return false;
    const epoch = onPostFired(gate.current);
    posted.current = { value: latest.current, epoch };
    post({ type: 'updateSettings', settings: latest.current });
    return true;
  }, []);

  // A debounced edit dropped on a reload or a non-quit teardown. A quit does NOT rely on this:
  // pagehide races the host's synchronous settings write — webview/quit-responder.ts flushes.
  useEffect(() => {
    const onUnload = () => {
      flush();
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [flush]);

  // Debounced persistence — only after a user-initiated change (not host hydrate).
  useEffect(() => {
    if (!gate.current.dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const epoch = onPostFired(gate.current);
      posted.current = { value: settings, epoch };
      post({ type: 'updateSettings', settings });
    }, 250);
  }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    onLocalEdit(gate.current);
    setSettings((prev) => ({ ...prev, ...coupleThemeDefaults(prev, patch) }));
  }, []);

  const hydrate = useCallback((s: AppSettings) => {
    const { apply } = decideHydrate(gate.current, {
      postedEpoch: posted.current.epoch,
      incomingMatchesPosted: jsonEqual(s, posted.current.value),
    });
    // The host echoes settings on every `state` broadcast; keeping the old object when nothing
    // changed spares every settings consumer a re-render per broadcast.
    if (apply) setSettings((prev) => (jsonEqual(prev, s) ? prev : s));
  }, []);

  const resetAll = useCallback(() => {
    onLocalEdit(gate.current);
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  const resetLayout = useCallback(() => {
    onLocalEdit(gate.current);
    setSettings((prev) => ({
      ...prev,
      layout: DEFAULT_SETTINGS.layout,
      leftWidth: DEFAULT_SETTINGS.leftWidth,
      rightWidth: DEFAULT_SETTINGS.rightWidth,
      historyDetailHeight: DEFAULT_SETTINGS.historyDetailHeight,
      editorSplitRatio: DEFAULT_SETTINGS.editorSplitRatio,
      sidebarCollapsed: DEFAULT_SETTINGS.sidebarCollapsed,
      explorerCollapsed: DEFAULT_SETTINGS.explorerCollapsed,
    }));
  }, []);

  return (
    <Ctx.Provider value={{ settings, update, hydrate, resetAll, resetLayout, flushPending: flush }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
