import { describe, expect, it, vi } from 'vitest';
import {
  requestTerminalFocus,
  shouldFocusActiveTerminal,
  subscribeTerminalFocus,
} from '../../webview/terminal-focus-bus';

// Minimal Element stand-ins: shouldFocusActiveTerminal delegates to isTypingEntry, which only
// touches classList/tagName/isContentEditable/closest (no real DOM needed in the node env).
const el = (opts: {
  tag?: string;
  cls?: string;
  contentEditable?: boolean;
  inMonaco?: boolean;
}): Element =>
  ({
    tagName: opts.tag ?? 'DIV',
    classList: { contains: (c: string) => c === opts.cls },
    isContentEditable: opts.contentEditable ?? false,
    closest: (sel: string) => (opts.inMonaco && sel === '.monaco-editor' ? ({} as Element) : null),
  }) as unknown as Element;

describe('terminal-focus-bus', () => {
  describe('requestTerminalFocus fan-out', () => {
    it('notifies every subscriber with the requested session id', () => {
      const a = vi.fn();
      const b = vi.fn();
      const offA = subscribeTerminalFocus(a);
      const offB = subscribeTerminalFocus(b);
      requestTerminalFocus('s2');
      expect(a).toHaveBeenCalledWith('s2');
      expect(b).toHaveBeenCalledWith('s2');
      offA();
      offB();
    });

    it('stops notifying after unsubscribe', () => {
      const cb = vi.fn();
      const off = subscribeTerminalFocus(cb);
      off();
      requestTerminalFocus('s1');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('shouldFocusActiveTerminal', () => {
    it('focuses when the Terminal is the visible view and nothing is being typed in', () => {
      expect(shouldFocusActiveTerminal(null, null)).toBe(true);
    });

    it('does NOT focus when a doc/editor tab is the active view', () => {
      expect(shouldFocusActiveTerminal('file:/repo/a.ts', null)).toBe(false);
    });

    it('does NOT steal focus from a real form field the user is typing in', () => {
      expect(shouldFocusActiveTerminal(null, el({ tag: 'INPUT' }))).toBe(false);
      expect(shouldFocusActiveTerminal(null, el({ tag: 'TEXTAREA' }))).toBe(false);
      expect(shouldFocusActiveTerminal(null, el({ contentEditable: true }))).toBe(false);
      expect(shouldFocusActiveTerminal(null, el({ inMonaco: true }))).toBe(false);
    });

    it('still focuses when the terminal itself holds focus (xterm textarea is not a form field)', () => {
      expect(
        shouldFocusActiveTerminal(null, el({ tag: 'TEXTAREA', cls: 'xterm-helper-textarea' })),
      ).toBe(true);
    });
  });

  // The active-session focus effect (app.tsx) composes the predicate with the bus exactly as
  // below; assert that composition routes focus to the newly-active session only when the
  // terminal is its visible view, and not when a doc tab is showing.
  describe('effect wiring (predicate -> bus)', () => {
    const focusOnSwitch = (
      activeId: string,
      docActiveId: string | null,
      focusedEl: Element | null,
    ) => {
      if (shouldFocusActiveTerminal(docActiveId, focusedEl)) requestTerminalFocus(activeId);
    };

    it('requests focus for the newly-active session when its terminal is showing', () => {
      const cb = vi.fn();
      const off = subscribeTerminalFocus(cb);
      focusOnSwitch('s2', null, null);
      expect(cb).toHaveBeenCalledWith('s2');
      off();
    });

    it('does not request focus when the switched-to session has a doc tab active', () => {
      const cb = vi.fn();
      const off = subscribeTerminalFocus(cb);
      focusOnSwitch('s2', 'review:@review', null);
      expect(cb).not.toHaveBeenCalled();
      off();
    });
  });
});
