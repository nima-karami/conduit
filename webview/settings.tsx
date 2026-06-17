import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../src/settings';
import { DEFAULT_SETTINGS, FONT_SIZE_SCALE } from '../src/settings';
import { decideHydrate, makeGate, onLocalEdit, onPostFired } from '../src/settings-sync';
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
  // Interface text only — multiplier composed with the density-derived base font size
  // (see styles.css body font-size); Monaco keeps its own fontSize.
  el.style.setProperty('--font-scale', String(FONT_SIZE_SCALE[s.fontSize]));
  el.dataset.background = s.background;
  el.dataset.reduceMotion = String(s.reduceMotion);
  el.style.setProperty('--left-w', `${s.leftWidth}px`);
  el.style.setProperty('--right-w', `${s.rightWidth}px`);
  el.style.setProperty('--bg-blur', `${s.bgBlur}px`);
  el.style.setProperty('--surface-alpha', String(s.surfaceOpacity));
  // One shared surface drives BOTH code block and terminal (wishlist I1 + R4.3b) so
  // they always match; --code-alpha (codeOpacity) drives both surfaces' translucency
  // (terminal's --term-surface is color-mix(--term-bg, --code-alpha) in CSS).
  el.style.setProperty('--code-bg', s.surfaceColor);
  el.style.setProperty('--code-alpha', String(s.codeOpacity));
  el.style.setProperty('--term-bg', s.surfaceColor);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gate guarding hydration against stale host echoes that race a pending local edit.
  // See src/settings-sync.ts for the decision logic + the bug it prevents (K1).
  const gate = useRef(makeGate());
  // The value we last posted, and the epoch at which we posted it, so an incoming
  // hydrate can be recognised as OUR change confirming (vs a stale broadcast).
  const posted = useRef<{ json: string; epoch: number }>({ json: '', epoch: -1 });
  // Live mirror of `settings` so the unload flush reads the latest without a stale
  // closure (the flush listener is registered once).
  const latest = useRef(settings);
  latest.current = settings;

  useEffect(() => applyToDom(settings), [settings]);

  // Flush the pending debounced persist synchronously. Returns true if it posted.
  const flush = useCallback((): boolean => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!gate.current.dirty) return false;
    const epoch = onPostFired(gate.current);
    posted.current = { json: JSON.stringify(latest.current), epoch };
    post({ type: 'updateSettings', settings: latest.current });
    return true;
  }, []);

  // Persist a change-then-quick-quit: an in-flight debounce timer would otherwise be
  // dropped on teardown. pagehide covers BFCache/Electron teardown; beforeunload is
  // the belt-and-suspenders for reloads.
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
      posted.current = { json: JSON.stringify(settings), epoch };
      post({ type: 'updateSettings', settings });
    }, 250);
  }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    onLocalEdit(gate.current);
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const hydrate = useCallback((s: AppSettings) => {
    const { apply } = decideHydrate(gate.current, {
      postedEpoch: posted.current.epoch,
      incomingMatchesPosted: JSON.stringify(s) === posted.current.json,
    });
    if (apply) setSettings(s);
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
      sidebarCollapsed: DEFAULT_SETTINGS.sidebarCollapsed,
      explorerCollapsed: DEFAULT_SETTINGS.explorerCollapsed,
    }));
  }, []);

  return (
    <Ctx.Provider value={{ settings, update, hydrate, resetAll, resetLayout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
