import { describe, expect, it } from 'vitest';
import {
  buildPreviewUrl,
  isPreviewUrl,
  isValidRootToken,
  PREVIEW_SCHEME,
  parsePreviewUrl,
  previewContentType,
} from '../../src/preview-url';

const TOKEN = 'ab12cd34';

describe('preview-url', () => {
  it('builds a URL from a token and segments', () => {
    expect(buildPreviewUrl(TOKEN, ['docs', 'report.html'])).toBe(
      `${PREVIEW_SCHEME}://${TOKEN}/docs/report.html`,
    );
    expect(parsePreviewUrl(buildPreviewUrl(TOKEN, ['docs', 'report.html']))).toEqual({
      token: TOKEN,
      segments: ['docs', 'report.html'],
    });
  });

  it('round-trips segments containing spaces, #, ? and non-ASCII', () => {
    const segments = ['a b', 'ré#1?.html', '100%'];
    const url = buildPreviewUrl(TOKEN, segments);
    expect(url).toContain('%20');
    expect(url).toContain('%23');
    expect(url).toContain('%3F');
    expect(url).toContain('%C3%A9');
    expect(url).not.toContain('#');
    expect(url).not.toContain('?');
    expect(parsePreviewUrl(url)?.segments).toEqual(segments);
  });

  it('refuses a foreign scheme', () => {
    expect(parsePreviewUrl('file:///a')).toBeNull();
    expect(isPreviewUrl('https://x/y')).toBe(false);
    expect(isPreviewUrl(`conduit-preview://${TOKEN}/a`)).toBe(true);
  });

  it('refuses a traversal segment', () => {
    expect(parsePreviewUrl(`conduit-preview://${TOKEN}/a/../b`)).toBeNull();
    expect(parsePreviewUrl(`conduit-preview://${TOKEN}/a/%2e%2e/b`)).toBeNull();
    expect(parsePreviewUrl(`conduit-preview://${TOKEN}/a/./b`)).toBeNull();
  });

  it('refuses an invalid or empty root token', () => {
    expect(parsePreviewUrl('conduit-preview:///a')).toBeNull();
    expect(parsePreviewUrl('conduit-preview://AB12CD34/a')).toBeNull();
    expect(parsePreviewUrl('conduit-preview://ab12-cd34/a')).toBeNull();
    expect(parsePreviewUrl(`conduit-preview://${TOKEN}`)).toBeNull();
    expect(parsePreviewUrl(`conduit-preview://${TOKEN}/`)).toBeNull();
  });

  it('validates token shape', () => {
    expect(isValidRootToken(TOKEN)).toBe(true);
    expect(isValidRootToken('a'.repeat(32))).toBe(true);
    expect(isValidRootToken('ab12cd3')).toBe(false);
    expect(isValidRootToken('a'.repeat(33))).toBe(false);
    expect(isValidRootToken('AB12CD34')).toBe(false);
    expect(isValidRootToken('')).toBe(false);
  });

  it('content types cover html, css, js, mjs, json, svg, png, woff2 and fall back', () => {
    expect(previewContentType('a.html')).toBe('text/html');
    expect(previewContentType('a.htm')).toBe('text/html');
    expect(previewContentType('a.css')).toBe('text/css');
    expect(previewContentType('a.js')).toBe('text/javascript');
    expect(previewContentType('a.mjs')).toBe('text/javascript');
    expect(previewContentType('a.json')).toBe('application/json');
    expect(previewContentType('a.svg')).toBe('image/svg+xml');
    expect(previewContentType('a.png')).toBe('image/png');
    expect(previewContentType('a.woff2')).toBe('font/woff2');
    expect(previewContentType('.CSS')).toBe('text/css');
    expect(previewContentType('a.zzz')).toBe('application/octet-stream');
    expect(previewContentType('Makefile')).toBe('application/octet-stream');
  });
});
