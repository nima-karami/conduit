/**
 * Security hardening for Electron `<webview>` guests. Enabling `webviewTag` lets the
 * renderer attach guest web contents that load untrusted remote pages; this locks each
 * guest down at attach time. Pure over a plain prefs object + src string so `main.ts`'s
 * `will-attach-webview` handler is unit-testable without Electron.
 *
 * Returns `{ allow }`: when false, the caller MUST `event.preventDefault()` so the guest
 * never attaches. Only http(s) and `conduit-preview:` may attach; everything else
 * (file:/data:/etc) is refused outright. See ADR 0005.
 */

import { isPreviewUrl } from './preview-url';

/** A loose view of Electron's webPreferences so this stays Electron-free for tests. */
export interface MutableWebPreferences {
  preload?: string;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  [key: string]: unknown;
}

export function isHttpUrl(src: string): boolean {
  try {
    const scheme = new URL(src).protocol.toLowerCase();
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

type WebGuestOpenRoute = 'in-app-background' | 'external';

/**
 * How long after a real middle-click the guest's window-open may still claim it. The open is
 * dispatched while the guest handles that same mouseup, within a frame; 300 ms absorbs a busy
 * renderer without letting a page bank a click for later use.
 */
const BACKGROUND_OPEN_GESTURE_MS = 300;

/** Real guest input (the host's `input-event`) that asks for a background tab: a middle-button
 *  release. Middle only — Ctrl/Cmd+click keeps going to the system browser (spec §5), and
 *  Electron reports no modifiers on a guest's mouse events anyway. */
export function isBackgroundOpenGesture(input: { type: string; button?: string }): boolean {
  return input.type === 'mouseUp' && input.button === 'middle';
}

/**
 * Where a NON-preview web guest's window-open goes. In-app only for a `background-tab` open of
 * an http(s) URL that follows a real middle-click (`gestureAt`, from the host's own input stream)
 * within the window above. `disposition` alone is page-influenced: once the page has any user
 * activation, script-dispatched Ctrl/middle clicks also yield `background-tab`, and each in-app
 * tab is persisted to docs.json. Everything else keeps going to the system browser (spec
 * 2026-09-22-middle-click-new-tab S14).
 */
export function webGuestOpenRoute(
  url: string,
  disposition: string,
  gestureAt: number | null,
  now: number,
): WebGuestOpenRoute {
  const recentGesture = gestureAt !== null && now - gestureAt <= BACKGROUND_OPEN_GESTURE_MS;
  return disposition === 'background-tab' && isHttpUrl(url) && recentGesture
    ? 'in-app-background'
    : 'external';
}

/**
 * Mutate `prefs` in place to the locked-down guest configuration and decide whether the
 * guest may attach at all (based on its `src` scheme).
 */
export function hardenWebviewPrefs(prefs: MutableWebPreferences, src: string): { allow: boolean } {
  // Never run Conduit's preload (or any preload) in an untrusted guest.
  delete prefs.preload;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  return { allow: isHttpUrl(src) || isPreviewUrl(src) };
}
