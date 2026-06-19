import { describe, expect, it } from 'vitest';
import { displayTitleForUrl, normalizeUrl } from '../../webview/web-url';

describe('normalizeUrl', () => {
  it('prefixes a bare host with https://', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('example.com/a/b')).toBe('https://example.com/a/b');
  });

  it('defaults loopback hosts to http://', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app');
  });

  it('keeps an explicit http(s) URL', () => {
    expect(normalizeUrl('https://x.dev/a?q=1')).toBe('https://x.dev/a?q=1');
    expect(normalizeUrl('http://x.dev')).toBe('http://x.dev/');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('   example.com  ')).toBe('https://example.com/');
  });

  it('rejects non-http(s) schemes and junk', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,<h1>x</h1>')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('two words')).toBeNull();
  });
});

describe('displayTitleForUrl', () => {
  it('uses hostname, optionally with the first path segment', () => {
    expect(displayTitleForUrl('https://example.com/')).toBe('example.com');
    expect(displayTitleForUrl('https://example.com/docs/intro')).toBe('example.com/docs');
  });

  it('falls back to the raw string for an unparseable URL', () => {
    expect(displayTitleForUrl('not a url')).toBe('not a url');
  });
});
