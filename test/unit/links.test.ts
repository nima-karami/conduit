import { describe, expect, it } from 'vitest';
import { classifyLink, shouldOpenExternally } from '../../webview/links';

describe('classifyLink', () => {
  it('classifies http/https as external', () => {
    expect(classifyLink('https://example.com')).toBe('external');
    expect(classifyLink('http://example.com/path?q=1#h')).toBe('external');
    expect(classifyLink('HTTPS://EXAMPLE.COM')).toBe('external');
  });

  it('classifies OS schemes as os', () => {
    expect(classifyLink('mailto:a@b.com')).toBe('os');
    expect(classifyLink('tel:+15551234')).toBe('os');
  });

  it('ignores empty, hash, relative, and malformed hrefs', () => {
    expect(classifyLink('')).toBe('ignore');
    expect(classifyLink('   ')).toBe('ignore');
    expect(classifyLink(null)).toBe('ignore');
    expect(classifyLink(undefined)).toBe('ignore');
    expect(classifyLink('#section')).toBe('ignore');
    expect(classifyLink('./relative/path.md')).toBe('ignore');
    expect(classifyLink('../up.md')).toBe('ignore');
    expect(classifyLink('not a url')).toBe('ignore');
  });

  it('ignores unsafe schemes (javascript, data, file)', () => {
    expect(classifyLink('javascript:alert(1)')).toBe('ignore');
    expect(classifyLink('data:text/html,<h1>x</h1>')).toBe('ignore');
    expect(classifyLink('file:///etc/passwd')).toBe('ignore');
  });
});

describe('shouldOpenExternally', () => {
  it('is true for external and os links only', () => {
    expect(shouldOpenExternally('https://x.com')).toBe(true);
    expect(shouldOpenExternally('mailto:a@b.com')).toBe(true);
    expect(shouldOpenExternally('#frag')).toBe(false);
    expect(shouldOpenExternally('javascript:void(0)')).toBe(false);
    expect(shouldOpenExternally('')).toBe(false);
  });
});
