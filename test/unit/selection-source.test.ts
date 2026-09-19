import { describe, expect, it } from 'vitest';
import { selectionSourceFor } from '../../webview/selection-source';

// Structural DOM stand-ins, same approach as typing-guard.test.ts (the unit env is `node`,
// not jsdom). `insideClass` fakes an ancestor for closest().
function el(attrs: Record<string, string> = {}, insideClass?: string): Element {
  const classes = (attrs.class ?? '').split(/\s+/).filter(Boolean);
  return {
    tagName: (attrs.tag ?? 'div').toUpperCase(),
    isContentEditable: false,
    classList: { contains: (c: string) => classes.includes(c) },
    closest: (selector: string) =>
      insideClass && selector === `.${insideClass}` ? ({} as Element) : null,
  } as unknown as Element;
}

const terminalEl = el({ tag: 'textarea', class: 'xterm-helper-textarea' });
const editorEl = el({ tag: 'div', class: 'native-edit-context' }, 'monaco-editor');
const bodyEl = el({ tag: 'body' });
const textNode = {} as Node;

describe('selectionSourceFor — precedence mirrors the shortcut dispatcher', () => {
  it('classifies a focused terminal as terminal, even with a live DOM anchor', () => {
    expect(
      selectionSourceFor({ activeEl: terminalEl, domAnchor: textNode, explorerHasFocus: false }),
    ).toBe('terminal');
  });

  it('classifies a focused Monaco editor as editor, even with a live DOM anchor', () => {
    expect(
      selectionSourceFor({ activeEl: editorEl, domAnchor: textNode, explorerHasFocus: false }),
    ).toBe('editor');
  });

  it('terminal wins over the editor when both could match', () => {
    const both = el({ tag: 'textarea', class: 'xterm-helper-textarea' }, 'monaco-editor');
    expect(selectionSourceFor({ activeEl: both, domAnchor: null, explorerHasFocus: false })).toBe(
      'terminal',
    );
  });

  it('classifies a live anchor with no focused surface as dom', () => {
    expect(
      selectionSourceFor({ activeEl: null, domAnchor: textNode, explorerHasFocus: false }),
    ).toBe('dom');
  });

  // The case activeElement alone cannot see: selecting text in rendered Markdown or in
  // Review leaves document.activeElement on <body>.
  it('classifies a selection made with activeElement on <body> as dom', () => {
    expect(
      selectionSourceFor({ activeEl: bodyEl, domAnchor: textNode, explorerHasFocus: false }),
    ).toBe('dom');
  });

  it('returns none for the Explorer, even when a stray text selection is live there', () => {
    expect(
      selectionSourceFor({ activeEl: bodyEl, domAnchor: textNode, explorerHasFocus: true }),
    ).toBe('none');
  });

  it('lets the editor win over the Explorer flag', () => {
    expect(
      selectionSourceFor({ activeEl: editorEl, domAnchor: textNode, explorerHasFocus: true }),
    ).toBe('editor');
  });

  it('returns none when nothing is focused and there is no anchor', () => {
    expect(selectionSourceFor({ activeEl: null, domAnchor: null, explorerHasFocus: false })).toBe(
      'none',
    );
  });

  it('returns none for an unremarkable focused element with no anchor', () => {
    expect(selectionSourceFor({ activeEl: bodyEl, domAnchor: null, explorerHasFocus: false })).toBe(
      'none',
    );
  });
});
