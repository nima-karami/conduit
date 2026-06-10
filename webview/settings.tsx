import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/settings';
import { post } from './bridge';

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
}

const Ctx = createContext<SettingsCtx | null>(null);

/** Apply settings to <html> data-* attributes so CSS can react to them. */
function applyToDom(s: AppSettings) {
  const el = document.documentElement;
  el.dataset.theme = s.theme;
  el.dataset.fontUi = s.fontUi;
  el.dataset.fontMono = s.fontMono;
  el.dataset.density = s.density;
  el.dataset.background = s.background;
  el.dataset.reduceMotion = String(s.reduceMotion);
  el.style.setProperty('--left-w', `${s.leftWidth}px`);
  el.style.setProperty('--right-w', `${s.rightWidth}px`);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  // Apply on every change.
  useEffect(() => applyToDom(settings), [settings]);

  // Debounced persistence — only after a user-initiated change (not host hydrate).
  useEffect(() => {
    if (!dirty.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      post({ type: 'updateSettings', settings });
      dirty.current = false;
    }, 250);
  }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    dirty.current = true;
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const hydrate = useCallback((s: AppSettings) => {
    dirty.current = false;
    setSettings(s);
  }, []);

  const resetAll = useCallback(() => {
    dirty.current = true;
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  const resetLayout = useCallback(() => {
    dirty.current = true;
    setSettings((prev) => ({
      ...prev,
      layout: DEFAULT_SETTINGS.layout,
      leftWidth: DEFAULT_SETTINGS.leftWidth,
      rightWidth: DEFAULT_SETTINGS.rightWidth,
    }));
  }, []);

  return <Ctx.Provider value={{ settings, update, hydrate, resetAll, resetLayout }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
