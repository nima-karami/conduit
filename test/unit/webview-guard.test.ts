import { describe, expect, it } from 'vitest';
import {
  createGuestOpenGate,
  hardenWebviewPrefs,
  isHttpUrl,
  type MutableWebPreferences,
} from '../../src/webview-guard';

describe('hardenWebviewPrefs', () => {
  it('strips preload and forces an isolated, sandboxed, no-node guest', () => {
    const prefs: MutableWebPreferences = {
      preload: 'C:\\app\\preload.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    const { allow } = hardenWebviewPrefs(prefs, 'https://example.com');
    expect(allow).toBe(true);
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
  });

  it('refuses to attach a non-http(s) guest', () => {
    for (const src of [
      'file:///etc/passwd',
      'data:text/html,x',
      'javascript:1',
      'chrome://x',
      '',
    ]) {
      expect(hardenWebviewPrefs({}, src).allow).toBe(false);
    }
  });

  it('still hardens prefs even when attachment is refused', () => {
    const prefs: MutableWebPreferences = { preload: 'p.js', nodeIntegration: true };
    hardenWebviewPrefs(prefs, 'file:///x');
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('lets only an http(s) guest reach the window-open handler for target=_blank / window.open', () => {
    const web: MutableWebPreferences = { disablePopups: true };
    hardenWebviewPrefs(web, 'https://example.com');
    expect(web.disablePopups).toBe(false);
    for (const src of ['conduit-preview://ab12cd34/docs/report.html', 'file:///x']) {
      const prefs: MutableWebPreferences = { disablePopups: false };
      hardenWebviewPrefs(prefs, src);
      expect(prefs.disablePopups, src).toBe(true);
    }
  });
});

describe('the conduit-preview allowlist', () => {
  it('allows a conduit-preview src to attach', () => {
    expect(hardenWebviewPrefs({}, 'conduit-preview://ab12cd34/docs/report.html').allow).toBe(true);
  });

  it('still refuses file:, data: and javascript:', () => {
    for (const src of [
      'file:///etc/passwd',
      'data:text/html,x',
      'javascript:1',
      'conduit-preview://g/a/r.html',
    ]) {
      expect(hardenWebviewPrefs({}, src).allow, src).toBe(false);
    }
  });

  it('hardens a preview guest identically to an http one, popups aside', () => {
    const base = (): MutableWebPreferences => ({
      preload: 'preload.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    });
    const http = base();
    const preview = base();
    hardenWebviewPrefs(http, 'https://example.com');
    hardenWebviewPrefs(preview, 'conduit-preview://ab12cd34/docs/report.html');
    expect({ ...preview, disablePopups: false }).toEqual(http);
  });
});

describe('isHttpUrl', () => {
  it('accepts http/https only', () => {
    expect(isHttpUrl('http://x.dev')).toBe(true);
    expect(isHttpUrl('https://x.dev/a')).toBe(true);
    expect(isHttpUrl('file:///x')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

const MIDDLE_UP = { type: 'mouseUp', button: 'middle' };
const LEFT_UP = { type: 'mouseUp', button: 'left' };

function gateAfter(input: { type: string; button?: string; key?: string } | null, at = 10_000) {
  const gate = createGuestOpenGate();
  if (input) gate.noteInput(input, at);
  return gate;
}

describe('createGuestOpenGate', () => {
  it.each([
    [MIDDLE_UP, 'https://a/', 'background-tab', 'in-app-background'],
    [MIDDLE_UP, 'http://127.0.0.1:3/', 'background-tab', 'in-app-background'],
    [MIDDLE_UP, 'mailto:x@y', 'background-tab', 'deny'],
    [MIDDLE_UP, 'file:///C:/x', 'background-tab', 'deny'],
    [MIDDLE_UP, 'conduit-preview://t/x', 'background-tab', 'deny'],
    [MIDDLE_UP, 'https://a/', 'foreground-tab', 'deny'],
    [MIDDLE_UP, 'https://a/', 'new-window', 'deny'],
    [LEFT_UP, 'https://a/', 'foreground-tab', 'in-app-foreground'],
    [LEFT_UP, 'http://127.0.0.1:3/', 'foreground-tab', 'in-app-foreground'],
    [LEFT_UP, 'https://a/', 'new-window', 'in-app-foreground'],
    [LEFT_UP, 'https://a/', 'new-popup', 'in-app-foreground'],
    [LEFT_UP, 'mailto:x@y', 'foreground-tab', 'deny'],
    [LEFT_UP, 'about:blank', 'foreground-tab', 'deny'],
    [LEFT_UP, 'javascript:alert(1)', 'new-window', 'deny'],
    [LEFT_UP, 'file:///C:/x', 'foreground-tab', 'deny'],
    [LEFT_UP, 'conduit-preview://t/x', 'foreground-tab', 'deny'],
    [LEFT_UP, 'https://a/', 'other', 'deny'],
    [LEFT_UP, 'https://a/', 'default', 'deny'],
    [LEFT_UP, 'https://a/', 'save-to-disk', 'deny'],
    [LEFT_UP, 'https://a/', 'background-tab', 'external'],
    [LEFT_UP, 'mailto:x@y', 'background-tab', 'external'],
    [{ type: 'rawKeyDown', key: 'Enter' }, 'https://a/', 'foreground-tab', 'in-app-foreground'],
    [{ type: 'keyDown', key: 'Enter' }, 'https://a/', 'foreground-tab', 'in-app-foreground'],
    [{ type: 'rawKeyDown', key: 'a' }, 'https://a/', 'foreground-tab', 'deny'],
    [{ type: 'mouseDown', button: 'left' }, 'https://a/', 'foreground-tab', 'deny'],
    [{ type: 'mouseUp', button: 'right' }, 'https://a/', 'foreground-tab', 'deny'],
  ] as const)('%o then %s (%s) → %s', (input, url, disposition, want) => {
    expect(gateAfter(input).route(url, disposition, 10_050)).toBe(want);
  });

  it('without a real gesture denies every open, background-tab included', () => {
    for (const disposition of [
      'background-tab',
      'foreground-tab',
      'new-window',
      'new-popup',
      'other',
      'default',
    ]) {
      expect(gateAfter(null).route('https://a/', disposition, 10_000), disposition).toBe('deny');
    }
  });

  it('accepts a gesture up to 300 ms old and refuses an older one', () => {
    expect(gateAfter(MIDDLE_UP).route('https://a/', 'background-tab', 10_300)).toBe(
      'in-app-background',
    );
    expect(gateAfter(MIDDLE_UP).route('https://a/', 'background-tab', 10_301)).toBe('deny');
    expect(gateAfter(LEFT_UP).route('https://a/', 'background-tab', 10_300)).toBe('external');
    expect(gateAfter(LEFT_UP).route('https://a/', 'background-tab', 10_301)).toBe('deny');
    expect(gateAfter(LEFT_UP).route('https://a/', 'foreground-tab', 10_300)).toBe(
      'in-app-foreground',
    );
    expect(gateAfter(LEFT_UP).route('https://a/', 'foreground-tab', 10_301)).toBe('deny');
  });

  it('spends one gesture on at most one open', () => {
    const left = gateAfter(LEFT_UP);
    expect(left.route('https://a/', 'foreground-tab', 10_010)).toBe('in-app-foreground');
    expect(left.route('https://b/', 'foreground-tab', 10_020)).toBe('deny');

    const middle = gateAfter(MIDDLE_UP);
    expect(middle.route('https://a/', 'background-tab', 10_010)).toBe('in-app-background');
    expect(middle.route('https://b/', 'background-tab', 10_020)).toBe('deny');
    expect(middle.route('mailto:x@y', 'background-tab', 10_030)).toBe('deny');
  });

  it('lets one real Ctrl+click launch the system browser at most once', () => {
    const gate = gateAfter(LEFT_UP);
    expect(gate.route('https://a/', 'background-tab', 10_010)).toBe('external');
    expect(gate.route('tel:123', 'background-tab', 10_020)).toBe('deny');
    expect(gate.route('https://b/', 'foreground-tab', 10_030)).toBe('deny');
  });

  it('a denied open spends nothing', () => {
    const gate = gateAfter(LEFT_UP);
    expect(gate.route('mailto:x@y', 'foreground-tab', 10_010)).toBe('deny');
    expect(gate.route('https://a/', 'foreground-tab', 10_020)).toBe('in-app-foreground');
  });
});
