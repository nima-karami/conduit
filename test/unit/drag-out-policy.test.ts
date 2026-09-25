import { describe, expect, it } from 'vitest';
import { osFileClipboardSupported, platformFromNavigator } from '../../src/drag-out-policy';

describe('platformFromNavigator', () => {
  it('maps navigator.platform to a host platform', () => {
    expect(platformFromNavigator('Win32')).toBe('win32');
    expect(platformFromNavigator('MacIntel')).toBe('darwin');
    expect(platformFromNavigator('Linux x86_64')).toBe('linux');
    expect(platformFromNavigator('')).toBe('linux');
  });
});

describe('osFileClipboardSupported', () => {
  it('linux never writes the OS clipboard (D4)', () => {
    expect(osFileClipboardSupported('linux')).toBe(false);
  });

  it('darwin writes NSFilenamesPboardType', () => {
    expect(osFileClipboardSupported('darwin')).toBe(true);
  });
});
