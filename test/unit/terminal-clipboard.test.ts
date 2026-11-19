import { describe, expect, it } from 'vitest';
import { pasteRoute, terminalClipboardAction } from '../../webview/terminal-clipboard';

const k = (over: Partial<Parameters<typeof terminalClipboardAction>[0]>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: '',
  ...over,
});

describe('terminalClipboardAction', () => {
  it.each(['win32', 'darwin', 'linux'])('claims text paste keys on %s', (platform) => {
    const isMac = platform === 'darwin';
    for (const shiftKey of [false, true]) {
      const key = shiftKey ? 'V' : 'v';
      expect(terminalClipboardAction(k({ ctrlKey: true, shiftKey, key }), false, isMac)).toBe(
        'paste',
      );
      if (isMac) {
        expect(terminalClipboardAction(k({ metaKey: true, shiftKey, key }), false, isMac)).toBe(
          'paste',
        );
      }
    }
    expect(terminalClipboardAction(k({ altKey: true, key: 'v' }), false, isMac)).toBeNull();
  });

  it('leaves Ctrl+Alt+V to xterm', () => {
    expect(
      terminalClipboardAction(k({ ctrlKey: true, altKey: true, key: 'v' }), false, false),
    ).toBeNull();
  });

  it('copies on Ctrl/Cmd+Shift+C regardless of selection or platform', () => {
    expect(
      terminalClipboardAction(k({ ctrlKey: true, shiftKey: true, key: 'c' }), false, false),
    ).toBe('copy');
    expect(
      terminalClipboardAction(k({ metaKey: true, shiftKey: true, key: 'c' }), false, true),
    ).toBe('copy');
  });

  it('on Windows/Linux, Ctrl+C copies only when there is a selection (else SIGINT)', () => {
    expect(terminalClipboardAction(k({ ctrlKey: true, key: 'c' }), true, false)).toBe('copy');
    expect(terminalClipboardAction(k({ ctrlKey: true, key: 'c' }), false, false)).toBeNull();
  });

  it('on macOS, Cmd+C copies and Ctrl+C stays SIGINT', () => {
    expect(terminalClipboardAction(k({ metaKey: true, key: 'c' }), true, true)).toBe('copy');
    expect(terminalClipboardAction(k({ ctrlKey: true, key: 'c' }), true, true)).toBeNull();
  });

  it('returns null without a modifier, with Alt, or for unrelated keys', () => {
    expect(terminalClipboardAction(k({ key: 'c' }), true, false)).toBeNull();
    expect(
      terminalClipboardAction(k({ ctrlKey: true, altKey: true, key: 'c' }), true, false),
    ).toBeNull();
    expect(terminalClipboardAction(k({ ctrlKey: true, key: 'x' }), true, false)).toBeNull();
  });
});

describe('pasteRoute', () => {
  it.each([
    { clipboard: 'text', text: 'hi', hasData: true, route: 'text' },
    { clipboard: 'image', text: '', hasData: true, route: 'program' },
    { clipboard: 'empty', text: '', hasData: false, route: 'none' },
    { clipboard: 'text and image', text: 'hi', hasData: true, route: 'text' },
  ])('routes $clipboard the same on every platform', ({ text, hasData, route }) => {
    expect(pasteRoute({ text, hasData })).toBe(route);
  });
});
