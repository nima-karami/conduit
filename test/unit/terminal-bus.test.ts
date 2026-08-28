// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  getTerminalBusVersion,
  hasLiveTerminal,
  notifyTerminalBus,
  pasteToTerminal,
  registerTerminal,
  requestTerminalFocus,
  shouldFocusActiveTerminal,
  subscribeTerminalBus,
} from '../../webview/terminal-bus';

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

describe('terminal registry', () => {
  it('reports no live terminal for an unknown session', () => {
    expect(hasLiveTerminal('nope')).toBe(false);
    expect(pasteToTerminal('nope', 'hi')).toBe(false);
  });

  it('routes focus and paste to the registered session only', () => {
    const a = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const b = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const offA = registerTerminal('s1', a);
    const offB = registerTerminal('s2', b);

    requestTerminalFocus('s2');
    expect(a.focus).not.toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalledTimes(1);

    expect(pasteToTerminal('s1', 'text')).toBe(true);
    expect(a.paste).toHaveBeenCalledWith('text');
    expect(b.paste).not.toHaveBeenCalled();

    offA();
    offB();
  });

  it('is no longer live after unmount, and a stale unregister cannot evict the remount', () => {
    const first = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const off = registerTerminal('s1', first);
    expect(hasLiveTerminal('s1')).toBe(true);

    // A remount registers BEFORE React runs the old instance's cleanup.
    const second = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const off2 = registerTerminal('s1', second);
    off(); // the stale cleanup
    expect(hasLiveTerminal('s1')).toBe(true);
    pasteToTerminal('s1', 'x');
    expect(second.paste).toHaveBeenCalledWith('x');
    expect(first.paste).not.toHaveBeenCalled();

    off2();
    expect(hasLiveTerminal('s1')).toBe(false);
  });

  it('focusing an unknown session is a silent no-op', () => {
    expect(() => requestTerminalFocus('gone')).not.toThrow();
  });

  it('bumps its version on register and on unregister, so a reader can re-render', () => {
    const seen: number[] = [];
    const off = subscribeTerminalBus(() => seen.push(getTerminalBusVersion()));
    const stop = registerTerminal('s1', {
      focus: vi.fn(),
      paste: vi.fn(),
      bracketedPaste: () => true,
    });
    stop();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    off();
  });

  it('does not bump for a stale unregister that evicts nothing', () => {
    const first = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const off = registerTerminal('s1', first);
    const off2 = registerTerminal('s1', {
      focus: vi.fn(),
      paste: vi.fn(),
      bracketedPaste: () => true,
    });
    const before = getTerminalBusVersion();
    off();
    expect(getTerminalBusVersion()).toBe(before);
    off2();
  });

  it('refuses a session whose program has NOT turned bracketed paste on', () => {
    // The hazard: xterm's paste() only wraps in [200~ when the foreground program set DECSET
    // 2004. At a bare shell prompt a multi-line handoff would be executed line by line, so such a
    // terminal must read as "not live" and the caller must fall back to the clipboard.
    const bare = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => false };
    const off = registerTerminal('s1', bare);
    expect(hasLiveTerminal('s1')).toBe(false);
    expect(pasteToTerminal('s1', ['one', 'two'].join('\n'))).toBe(false);
    expect(bare.paste).not.toHaveBeenCalled();
    off();
  });

  it('re-checks the mode at delivery, not only at render', () => {
    let bracketed = true;
    const api = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => bracketed };
    const off = registerTerminal('s1', api);
    expect(hasLiveTerminal('s1')).toBe(true);
    // The user drops out of the agent TUI between the button rendering and the click.
    bracketed = false;
    expect(pasteToTerminal('s1', ['one', 'two'].join('\n'))).toBe(false);
    expect(api.paste).not.toHaveBeenCalled();
    off();
  });

  it('does not record a refused attempt on the harness spy', () => {
    const spy: Array<{ sessionId: string; text: string }> = [];
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = spy;
    const off = registerTerminal('s1', {
      focus: vi.fn(),
      paste: vi.fn(),
      bracketedPaste: () => false,
    });
    pasteToTerminal('s1', 'payload');
    pasteToTerminal('unknown-session', 'payload');
    expect(spy).toEqual([]);
    off();
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = undefined;
  });

  it('notifies subscribers when a pane reports a mode flip', () => {
    let seen = 0;
    const off = subscribeTerminalBus(() => {
      seen++;
    });
    notifyTerminalBus();
    expect(seen).toBe(1);
    off();
  });

  it('records a paste on the harness spy when one exists', () => {
    const spy: Array<{ sessionId: string; text: string }> = [];
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = spy;
    const off = registerTerminal('s1', {
      focus: vi.fn(),
      paste: vi.fn(),
      bracketedPaste: () => true,
    });
    pasteToTerminal('s1', 'payload');
    expect(spy).toEqual([{ sessionId: 's1', text: 'payload' }]);
    off();
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = undefined;
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

// The active-session focus effect (app.tsx) composes the predicate with the bus exactly as below;
// assert that composition routes focus to the newly-active session only when the terminal is its
// visible view, and not when a doc tab is showing.
describe('effect wiring (predicate -> bus)', () => {
  const focusOnSwitch = (
    activeId: string,
    docActiveId: string | null,
    focusedEl: Element | null,
  ) => {
    if (shouldFocusActiveTerminal(docActiveId, focusedEl)) requestTerminalFocus(activeId);
  };

  it('requests focus for the newly-active session when its terminal is showing', () => {
    const api = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const off = registerTerminal('s2', api);
    focusOnSwitch('s2', null, null);
    expect(api.focus).toHaveBeenCalledTimes(1);
    off();
  });

  it('does not request focus when the switched-to session has a doc tab active', () => {
    const api = { focus: vi.fn(), paste: vi.fn(), bracketedPaste: () => true };
    const off = registerTerminal('s2', api);
    focusOnSwitch('s2', 'review:@review', null);
    expect(api.focus).not.toHaveBeenCalled();
    off();
  });
});
