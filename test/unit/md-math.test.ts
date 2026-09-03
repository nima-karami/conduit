// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { afterEach, describe, expect, it } from 'vitest';
import { remarkMathPlugin } from '../../webview/md-math';

/**
 * Currency is not LaTeX. With remark-math's default single-dollar text math, a pair of `$`
 * anywhere in a paragraph is consumed as delimiters and everything between them is re-rendered
 * in KaTeX's math italic — so "$170,000 to $250,000" silently became "170,000to250,000" in a
 * serif italic. Reported from a real doc. These run the viewer's OWN plugin list, so a future
 * edit that re-enables single-dollar math (or a remark-math upgrade that renames the option)
 * fails here rather than in someone's document.
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(markdown: string): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkMathPlugin], rehypePlugins: [rehypeKatex] },
        markdown,
      ),
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('markdown math delimiters', () => {
  it('leaves currency amounts alone instead of eating the dollars as math', () => {
    const el = render('Published CA$170,000 to $250,000; he quoted "$170 to $200K base pay".');
    const text = el.textContent ?? '';
    expect(el.querySelector('.katex')).toBeNull();
    expect(text).toContain('$170,000');
    expect(text).toContain('$250,000');
    expect(text).toContain('$170');
    expect(text).toContain('$200K');
    // The exact corruption from the report: dollars gone, the words welded together.
    expect(text).not.toContain('170,000to250,000');
  });

  it('leaves a pair of shell variables alone', () => {
    const el = render('Set $PATH and $HOME before running it.');
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toContain('$PATH');
    expect(el.textContent).toContain('$HOME');
  });

  it('still renders real math written with two dollars', () => {
    const el = render('The identity $$E = mc^2$$ holds.');
    expect(el.querySelector('.katex')).not.toBeNull();
  });
});
