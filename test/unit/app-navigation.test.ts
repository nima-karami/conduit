import { describe, expect, it } from 'vitest';
import { isAppIndexUrl } from '../../src/app-navigation';

const idx = 'file:///C:/app/out/index.html';

describe('isAppIndexUrl', () => {
  it('admits the shell with a hash or query', () => {
    expect(isAppIndexUrl('file:///C:/app/out/index.html#x', idx)).toBe(true);
    expect(isAppIndexUrl('file:///C:/app/out/index.html?a=1', idx)).toBe(true);
    expect(isAppIndexUrl(idx, idx)).toBe(true);
  });

  it('drive letter case-insensitive', () => {
    expect(isAppIndexUrl('file:///c:/app/out/index.html', idx)).toBe(true);
  });

  it('refuses any other file', () => {
    expect(isAppIndexUrl('file:///C:/Windows/win.ini', idx)).toBe(false);
  });

  it('refuses a sibling html', () => {
    expect(isAppIndexUrl('file:///C:/app/out/other.html', idx)).toBe(false);
  });

  it('refuses a different-case path segment beyond the drive letter', () => {
    expect(isAppIndexUrl('file:///C:/APP/out/index.html', idx)).toBe(false);
  });

  it('refuses http', () => {
    expect(isAppIndexUrl('http://C:/app/out/index.html', idx)).toBe(false);
    expect(isAppIndexUrl('https://example.com/index.html', idx)).toBe(false);
  });

  it('refuses a file url on another host', () => {
    expect(isAppIndexUrl('file://evil/C:/app/out/index.html', idx)).toBe(false);
  });

  it('posix index', () => {
    expect(
      isAppIndexUrl('file:///opt/app/out/index.html#/', 'file:///opt/app/out/index.html'),
    ).toBe(true);
    expect(isAppIndexUrl('file:///etc/passwd', 'file:///opt/app/out/index.html')).toBe(false);
  });

  it('garbage', () => {
    expect(isAppIndexUrl('::', idx)).toBe(false);
    expect(isAppIndexUrl(idx, '::')).toBe(false);
  });
});
