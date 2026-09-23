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

type WebGuestOpenRoute = 'in-app-background' | 'in-app-foreground' | 'external' | 'deny';

/**
 * How long after a real gesture the guest's window-open may still claim it. The open is
 * dispatched while the guest handles that same input, within a frame; 300 ms absorbs a busy
 * renderer without letting a page bank a click for later use.
 */
const OPEN_GESTURE_MS = 300;

/** The part of Electron's guest `input-event` payload the gate reads. Its mouse events carry no
 *  modifiers even when the page saw them (spec 2026-09-23-web-blank-link M12). */
interface GuestInput {
  type: string;
  button?: string;
  key?: string;
  isAutoRepeat?: boolean;
}

/**
 * Where a NON-preview web guest's window-opens go, decided from the host's own record of the
 * guest's real input: a page can't write it, and one gesture buys at most one open.
 * `disposition` alone is page-influenced (M3/M6/M8 share `HandlerDetails`), and each in-app tab
 * is persisted to docs.json. Route table: spec 2026-09-23-web-blank-link §3.
 */
export function createGuestOpenGate(): {
  noteInput(input: GuestInput, now: number): void;
  route(url: string, disposition: string, now: number): WebGuestOpenRoute;
} {
  let middleAt: number | null = null;
  let activationAt: number | null = null;
  const fresh = (at: number | null, now: number) => at !== null && now - at <= OPEN_GESTURE_MS;
  const decide = (url: string, disposition: string, now: number): WebGuestOpenRoute => {
    if (disposition === 'background-tab') {
      if (isHttpUrl(url) && fresh(middleAt, now)) return 'in-app-background';
      // A real Ctrl+click reaches the host as a plain left mouseUp (modifiers are dropped, M12).
      return fresh(activationAt, now) ? 'external' : 'deny';
    }
    if (!NEW_TAB_DISPOSITIONS.has(disposition)) return 'deny';
    return isHttpUrl(url) && fresh(activationAt, now) ? 'in-app-foreground' : 'deny';
  };
  return {
    noteInput(input, now) {
      if (input.type === 'mouseUp' && input.button === 'middle') middleAt = now;
      else if (isActivation(input)) activationAt = now;
    },
    route(url, disposition, now) {
      const route = decide(url, disposition, now);
      if (route !== 'deny') {
        middleAt = null;
        activationAt = null;
      }
      return route;
    },
  };
}

const NEW_TAB_DISPOSITIONS = new Set(['foreground-tab', 'new-window', 'new-popup']);

function isActivation(input: GuestInput): boolean {
  if (input.type === 'mouseUp') return input.button === 'left';
  // A held Enter would otherwise re-arm the gate every repeat, one open per repeat.
  if (input.isAutoRepeat) return false;
  return (input.type === 'rawKeyDown' || input.type === 'keyDown') && input.key === 'Enter';
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
  // Overrides the element's `allowpopups`: only a web guest's opens may reach the host's gate.
  prefs.disablePopups = !isHttpUrl(src);
  return { allow: isHttpUrl(src) || isPreviewUrl(src) };
}
