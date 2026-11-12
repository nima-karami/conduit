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
  it('pastes on Ctrl/Cmd+V and Ctrl/Cmd+Shift+V', () => {
    expect(terminalClipboardAction(k({ ctrlKey: true, key: 'v' }), false, false)).toBe('paste');
    expect(terminalClipboardAction(k({ metaKey: true, key: 'v' }), false, true)).toBe('paste');
    expect(
      terminalClipboardAction(k({ ctrlKey: true, shiftKey: true, key: 'V' }), false, false),
    ).toBe('paste');
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
  const o = (over: Partial<Parameters<typeof pasteRoute>[0]>) => ({
    text: '',
    hasImage: false,
    isLinux: false,
    ...over,
  });

  it('pastes text on every platform', () => {
    expect(pasteRoute(o({ text: 'hi' }))).toBe('text');
    expect(pasteRoute(o({ text: 'hi', isLinux: true }))).toBe('text');
  });

  it('forwards a raw Ctrl+V only for an image-only clipboard on Linux', () => {
    expect(pasteRoute(o({ hasImage: true, isLinux: true }))).toBe('raw-ctrl-v');
  });

  it('does not forward Ctrl+V for an image on Windows or macOS', () => {
    expect(pasteRoute(o({ hasImage: true, isLinux: false }))).toBe('none');
  });

  it('prefers text over an image when both are present on Linux', () => {
    expect(pasteRoute(o({ text: 'hi', hasImage: true, isLinux: true }))).toBe('text');
  });

  it('does nothing without text or an image', () => {
    expect(pasteRoute(o({}))).toBe('none');
    expect(pasteRoute(o({ isLinux: true }))).toBe('none');
  });
});
