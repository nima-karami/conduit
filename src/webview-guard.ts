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
 * Where a NON-preview web guest's window-open goes. In-app only for a middle/Ctrl-click
 * (Chromium's `background-tab` disposition) on an http(s) URL; everything else keeps going to
 * the system browser (spec 2026-09-22-middle-click-new-tab S14).
 */
export function webGuestOpenRoute(url: string, disposition: string): WebGuestOpenRoute {
  return disposition === 'background-tab' && isHttpUrl(url) ? 'in-app-background' : 'external';
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
