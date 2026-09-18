import { describe, expect, it } from 'vitest';
import { hardenWebviewPrefs, isHttpUrl, type MutableWebPreferences } from '../../src/webview-guard';

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
