import { describe, expect, it } from 'vitest';
import { isComboAllowedWhileTyping, isTypingEntry } from '../../webview/typing-guard';

// Minimal structural shapes for DOM elements — no DOM dependency needed.
function el(tag: string, attrs: Record<string, string> = {}): Element {
  const classes = (attrs.class ?? '').split(/\s+/).filter(Boolean);
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (k: string) => attrs[k] ?? null,
    isContentEditable: attrs.contenteditable === 'true',
    classList: { contains: (c: string) => classes.includes(c) },
  } as unknown as Element;
}

describe('isTypingEntry', () => {
  it('returns true for input elements', () => {
    expect(isTypingEntry(el('input'))).toBe(true);
  });

  it('returns true for textarea elements', () => {
    expect(isTypingEntry(el('textarea'))).toBe(true);
  });

  it('returns true for contenteditable elements', () => {
    expect(isTypingEntry(el('div', { contenteditable: 'true' }))).toBe(true);
  });

  it('returns false for non-typing elements', () => {
    expect(isTypingEntry(el('div'))).toBe(false);
    expect(isTypingEntry(el('button'))).toBe(false);
    expect(isTypingEntry(el('span'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTypingEntry(null)).toBe(false);
  });

  it("treats xterm's helper textarea as NOT a typing-entry (global shortcuts pass through the terminal)", () => {
    expect(isTypingEntry(el('textarea', { class: 'xterm-helper-textarea' }))).toBe(false);
  });
});

describe('isComboAllowedWhileTyping', () => {
  it('allows Mod+S while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+S')).toBe(true);
  });

  it('allows Escape-based combos — none in current set, but Escape key combos are safe', () => {
    // Escape is handled by individual components; the global handler doesn't use it.
    // Still: any combo that starts with Escape is allowed.
    expect(isComboAllowedWhileTyping('Escape')).toBe(true);
  });

  it('blocks Mod+P while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+P')).toBe(false);
  });

  it('blocks Mod+B while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+B')).toBe(false);
  });

  it('blocks Mod+N while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+N')).toBe(false);
  });

  it('blocks Mod+Shift+P while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+Shift+P')).toBe(false);
  });

  it('blocks Mod+, while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+,')).toBe(false);
  });
});
