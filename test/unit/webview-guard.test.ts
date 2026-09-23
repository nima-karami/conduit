import { describe, expect, it } from 'vitest';
import {
  hardenWebviewPrefs,
  isBackgroundOpenGesture,
  isHttpUrl,
  type MutableWebPreferences,
  webGuestOpenRoute,
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

  it('hardens a preview guest identically to an http one', () => {
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
    expect(preview).toEqual(http);
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

describe('webGuestOpenRoute', () => {
  it.each([
    ['https://a/', 'background-tab', 'in-app-background'],
    ['http://127.0.0.1:3/', 'background-tab', 'in-app-background'],
    ['https://a/', 'foreground-tab', 'external'],
    ['https://a/', 'new-window', 'external'],
    ['mailto:x@y', 'background-tab', 'external'],
    ['file:///C:/x', 'background-tab', 'external'],
    ['conduit-preview://t/x', 'background-tab', 'external'],
  ] as const)('%s with %s after a fresh gesture → %s', (url, disposition, want) => {
    expect(webGuestOpenRoute(url, disposition, 10_000, 10_050)).toBe(want);
  });

  it('goes external when no real gesture preceded the open (script-dispatched click)', () => {
    expect(webGuestOpenRoute('https://a/', 'background-tab', null, 10_000)).toBe('external');
  });

  it('accepts a gesture up to 1 s old and refuses an older one', () => {
    expect(webGuestOpenRoute('https://a/', 'background-tab', 10_000, 11_000)).toBe(
      'in-app-background',
    );
    expect(webGuestOpenRoute('https://a/', 'background-tab', 10_000, 11_001)).toBe('external');
  });
});

describe('isBackgroundOpenGesture', () => {
  it.each([
    [{ type: 'mouseUp', button: 'middle' }, true],
    [{ type: 'mouseUp', button: 'left', modifiers: ['control'] }, true],
    [{ type: 'mouseUp', button: 'left', modifiers: ['meta'] }, true],
    [{ type: 'mouseUp', button: 'left', modifiers: ['cmd', 'shift'] }, true],
    [{ type: 'mouseUp', button: 'left' }, false],
    [{ type: 'mouseUp', button: 'left', modifiers: ['shift'] }, false],
    [{ type: 'mouseUp', button: 'right', modifiers: ['control'] }, false],
    [{ type: 'mouseDown', button: 'middle' }, false],
    [{ type: 'keyUp' }, false],
  ] as const)('%o → %s', (input, want) => {
    expect(isBackgroundOpenGesture(input)).toBe(want);
  });
});
