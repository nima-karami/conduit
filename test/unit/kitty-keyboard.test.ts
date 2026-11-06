import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  encodeKey,
  KittyKeyboardState,
  registerKittyKeyboardHandlers,
} from '../../webview/kitty-keyboard';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

function key(partial: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  keyCode?: number;
}) {
  return {
    key: partial.key,
    ctrlKey: partial.ctrlKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
    metaKey: partial.metaKey ?? false,
    keyCode: partial.keyCode,
  };
}

describe('KittyKeyboardState via CSI handlers', () => {
  it('push/pop/set semantics on the main screen', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = new KittyKeyboardState();
    registerKittyKeyboardHandlers(term, state);

    await write(term, '\x1b[>3u');
    expect(state.currentFlags(false)).toBe(3);
    await write(term, '\x1b[=2;2u');
    expect(state.currentFlags(false)).toBe(3);
    await write(term, '\x1b[=1;3u');
    expect(state.currentFlags(false)).toBe(2);
    await write(term, '\x1b[>5u');
    expect(state.currentFlags(false)).toBe(5);
    await write(term, '\x1b[<u');
    expect(state.currentFlags(false)).toBe(2);
    await write(term, '\x1b[<2u');
    expect(state.currentFlags(false)).toBe(0);

    term.dispose();
  });

  it('keeps separate stacks for main and alternate screens', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = new KittyKeyboardState();
    registerKittyKeyboardHandlers(term, state);

    await write(term, '\x1b[>1u');
    expect(state.currentFlags(false)).toBe(1);
    expect(state.currentFlags(true)).toBe(0);

    await write(term, '\x1b[?1049h');
    await write(term, '\x1b[>2u');
    expect(state.currentFlags(true)).toBe(2);
    expect(state.currentFlags(false)).toBe(1);

    await write(term, '\x1b[?1049l');
    expect(state.currentFlags(false)).toBe(1);
    expect(state.currentFlags(true)).toBe(2);

    term.dispose();
  });

  it('clears both stacks on RIS', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const state = new KittyKeyboardState();
    registerKittyKeyboardHandlers(term, state);

    await write(term, '\x1b[>1u\x1b[?1049h\x1b[>2u');
    expect(state.currentFlags(false)).toBe(1);
    expect(state.currentFlags(true)).toBe(2);
    await write(term, '\x1bc');
    expect(state.currentFlags(false)).toBe(0);
    expect(state.currentFlags(true)).toBe(0);

    term.dispose();
  });
});

describe('encodeKey', () => {
  it('returns null when flags are zero', () => {
    expect(encodeKey(key({ key: 'Enter', ctrlKey: true }), 0)).toBeNull();
    expect(encodeKey(key({ key: 'Escape' }), 0)).toBeNull();
  });

  it('encodes modified Enter, Tab, Backspace and plain Escape at flag 1', () => {
    const f = 1;
    expect(encodeKey(key({ key: 'Enter', ctrlKey: true }), f)).toBe('\x1b[13;5u');
    expect(encodeKey(key({ key: 'Enter', shiftKey: true }), f)).toBe('\x1b[13;2u');
    expect(encodeKey(key({ key: 'Enter', altKey: true }), f)).toBe('\x1b[13;3u');
    expect(encodeKey(key({ key: 'Enter', ctrlKey: true, shiftKey: true }), f)).toBe('\x1b[13;6u');
    expect(encodeKey(key({ key: 'Escape' }), f)).toBe('\x1b[27u');
    expect(encodeKey(key({ key: 'Tab', ctrlKey: true }), f)).toBe('\x1b[9;5u');
    expect(encodeKey(key({ key: 'Tab', shiftKey: true }), f)).toBe('\x1b[9;2u');
  });

  it('leaves plain Enter, Tab and Backspace as legacy (null)', () => {
    const f = 1;
    expect(encodeKey(key({ key: 'Enter' }), f)).toBeNull();
    expect(encodeKey(key({ key: 'Tab' }), f)).toBeNull();
    expect(encodeKey(key({ key: 'Backspace' }), f)).toBeNull();
  });

  it('sends Ctrl and Alt letters as the letter with modifiers, never as the key they collide with', () => {
    const f = 1;
    expect(encodeKey(key({ key: 'm', ctrlKey: true }), f)).toBe('\x1b[109;5u');
    expect(encodeKey(key({ key: 'i', ctrlKey: true }), f)).toBe('\x1b[105;5u');
    expect(encodeKey(key({ key: 'h', ctrlKey: true }), f)).toBe('\x1b[104;5u');
    expect(encodeKey(key({ key: 'c', ctrlKey: true }), f)).toBe('\x1b[99;5u');
    expect(encodeKey(key({ key: 'X', ctrlKey: true, shiftKey: true }), f)).toBe('\x1b[120;6u');
    expect(encodeKey(key({ key: 'x', altKey: true }), f)).toBe('\x1b[120;3u');
    expect(encodeKey(key({ key: '[', ctrlKey: true }), f)).toBe('\x1b[91;5u');
  });

  it('uses 127 for Backspace with modifiers, and leaves shifted text as text', () => {
    const f = 1;
    expect(encodeKey(key({ key: 'Backspace', ctrlKey: true }), f)).toBe('\x1b[127;5u');
    expect(encodeKey(key({ key: 'A', shiftKey: true }), f)).toBeNull();
    expect(encodeKey(key({ key: 'a' }), f)).toBeNull();
    expect(encodeKey(key({ key: '@', ctrlKey: true, altKey: true }), f)).toBeNull();
  });

  it('treats higher flag bits like disambiguate (flag 1) encoding', () => {
    expect(encodeKey(key({ key: 'Enter', ctrlKey: true }), 2)).toBe('\x1b[13;5u');
  });
});
